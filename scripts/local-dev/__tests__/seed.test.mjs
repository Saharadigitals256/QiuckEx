import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { extractInserts, extractSchema, runCheck, REPO_ROOT } from '../check-seed.mjs';

// ── The repository must pass ─────────────────────────────────────────────────

test('the seed passes every check', () => {
  const report = runCheck(REPO_ROOT);
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
});

test('the seed inserts into tables that migrations create, with real columns', () => {
  const report = runCheck(REPO_ROOT);
  const { tables, columns } = report.checks.schema.summary;
  assert.ok(tables >= 4, `expected several seeded tables, got ${tables}`);
  assert.ok(columns >= 10, `expected several seeded columns, got ${columns}`);
  assert.ok(report.checks.publicKeys.summary.keys > 0, 'fixtures must reference keys');
});

// ── Schema extraction ───────────────────────────────────────────────────────

const MIGRATIONS = [
  {
    name: '20250101000000_create_widgets.sql',
    sql: `CREATE TABLE IF NOT EXISTS widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS widgets_label ON widgets (label);
`,
  },
  {
    name: '20250102000000_add_widget_note.sql',
    sql: `ALTER TABLE widgets ADD COLUMN IF NOT EXISTS note TEXT;
`,
  },
];

test('schema extraction reads columns and folds in later ALTER TABLE additions', () => {
  const schema = extractSchema(MIGRATIONS);
  assert.ok(schema.has('widgets'));
  assert.ok(schema.get('widgets').has('id'));
  assert.ok(schema.get('widgets').has('label'));
  // A column added by a follow-up migration must still be visible.
  assert.ok(schema.get('widgets').has('note'));
  // A table-level constraint clause is not a column.
  assert.equal(schema.get('widgets').has('CONSTRAINT'), false);
});

test('schema extraction handles schema-qualified table names', () => {
  const schema = extractSchema([
    {
      name: 'x.sql',
      sql: `CREATE TABLE IF NOT EXISTS public.gadgets (
  id UUID PRIMARY KEY,
  name TEXT
);
`,
    },
  ]);
  assert.ok(schema.has('gadgets'));
  assert.ok(schema.get('gadgets').has('name'));
});

test('insert extraction reads the table, column list, and statement body', () => {
  const inserts = extractInserts(`INSERT INTO widgets (label, count)
VALUES ('a', 1), ('b', 2)
ON CONFLICT DO NOTHING;

INSERT INTO other (id) VALUES (1) ON CONFLICT DO NOTHING;
`);
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].table, 'widgets');
  assert.deepEqual(inserts[0].columns, ['label', 'count']);
  assert.match(inserts[0].body, /ON CONFLICT/);
  assert.equal(inserts[1].table, 'other');
});

// ── Failure modes ───────────────────────────────────────────────────────────

/**
 * Each check is exercised by mutating the real seed, so the gate is proven to
 * reject exactly the states it claims to reject. A passing-only suite would
 * still pass if a rule were silently deleted.
 */
const SEED_FILE = `${REPO_ROOT}/scripts/local-dev/seed.sql`;

function withSeed(replacement, assertion) {
  const original = readFileSync(SEED_FILE, 'utf8');
  try {
    writeFileSync(SEED_FILE, replacement(original), 'utf8');
    assertion(runCheck(REPO_ROOT));
  } finally {
    // Always restore, so one failing assertion cannot poison later tests.
    writeFileSync(SEED_FILE, original, 'utf8');
  }
}

test('a column that no migration creates is rejected', () => {
  withSeed(
    (seed) => `${seed}\nINSERT INTO usernames (username, public_key, not_a_column)\nVALUES ('x', 'GA', 1) ON CONFLICT DO NOTHING;\n`,
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('has no column "not_a_column"')));
    },
  );
});

test('a table that no migration creates is rejected', () => {
  withSeed(
    (seed) => `${seed}\nINSERT INTO not_a_table (id) VALUES (1) ON CONFLICT DO NOTHING;\n`,
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('which no migration creates')));
    },
  );
});

test('a non-idempotent insert is rejected', () => {
  withSeed(
    (seed) => `${seed}\nINSERT INTO usernames (username, public_key) VALUES ('x', 'GA');\n`,
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('no ON CONFLICT clause')));
    },
  );
});

test('a Stellar secret key in a fixture is rejected', () => {
  // The custody invariant: a fixture must never carry signing material.
  withSeed(
    (seed) => `${seed}\n-- S${'A'.repeat(55)}\n`,
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('Stellar secret key')));
      assert.ok(report.errors.some((m) => m.includes('self-custody')));
    },
  );
});

test('a 64-hex-character private key in a fixture is rejected', () => {
  withSeed(
    (seed) => `${seed}\n-- ${'ab'.repeat(32)}\n`,
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('64-hex-char private key')));
    },
  );
});

test('a PEM private key block in a fixture is rejected', () => {
  withSeed(
    (seed) => `${seed}\n-----BEGIN RSA PRIVATE KEY-----\n`,
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('private key block')));
    },
  );
});

test('a JWT in a fixture is rejected', () => {
  withSeed(
    (seed) => `${seed}\n-- eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk\n`,
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('JWT')));
    },
  );
});

test('a malformed Stellar public key is rejected', () => {
  // Truncated to 56 characters total, so the G + 55 base32 shape is violated.
  withSeed(
    (seed) => seed.replace(/'G[A-Z]*WHF'/, "'GTOOSHORT'"),
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('not a valid Stellar public key')));
    },
  );
});

test('a seed without the local-database guard is rejected', () => {
  withSeed(
    (seed) => seed.replace(/RAISE EXCEPTION[\s\S]*?END;\s*\$\$;/, ''),
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('RAISE EXCEPTION guard')));
    },
  );
});

test('a seed outside an explicit transaction is rejected', () => {
  withSeed(
    (seed) => seed.replace(/^COMMIT;$/m, ''),
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('explicit transaction')));
    },
  );
});

test('the guard is checked outside comments, so documenting it is not enough', () => {
  // A seed that only *mentions* the guard in prose must still fail.
  withSeed(
    (seed) =>
      seed.replace(/RAISE EXCEPTION[\s\S]*?END;\s*\$\$;/, '-- RAISE EXCEPTION would go here') +
      '\n-- current_database()\n',
    (report) => {
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((m) => m.includes('RAISE EXCEPTION guard')));
    },
  );
});
