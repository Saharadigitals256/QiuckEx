#!/usr/bin/env node
/**
 * Validate the local development fixtures against the migrations — issue #296.
 *
 * The bootstrap seeds a real Postgres, but CI has no local stack, so the seed
 * file cannot simply be executed there. This gate performs the checks that
 * *can* be done statically, which is where fixtures actually rot:
 *
 *   1. Every table the seed inserts into is created by a migration.
 *   2. Every column the seed names exists on that table.
 *   3. Every insert is idempotent (`ON CONFLICT`), so re-running the bootstrap
 *      cannot duplicate rows or clobber local edits.
 *   4. No seed material contains private-key material, and every Stellar key
 *      that appears is a syntactically valid public key. This is the custody
 *      invariant: QuickEx never holds signing keys (ADR 0001), so a fixture
 *      that needed one would be a design error, not a missing convenience.
 *   5. The seed refuses to run against a non-local database.
 *
 * Zero dependencies and no network access.
 *
 * Usage:
 *   node scripts/local-dev/check-seed.mjs            # all checks
 *   node scripts/local-dev/check-seed.mjs --json     # machine-readable report
 *
 * Exit codes: 0 = no errors, 1 = errors, 2 = usage error.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
const MIGRATIONS_DIR = "app/backend/supabase/migrations";
const SEED_PATH = "scripts/local-dev/seed.sql";

/** A Stellar public key: `G` + 55 base32 characters. */
const PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

/**
 * Anything that looks like signing material. Matched case-insensitively against
 * the whole seed; the patterns are deliberately broad so a new secret format is
 * more likely to be caught than missed.
 */
const SECRET_PATTERNS = [
  { name: "Stellar secret key", pattern: /\bS[A-Z2-7]{55}\b/ },
  { name: "mnemonic/seed phrase", pattern: /\b\w{3,}\s+\w{3,}\s+\w{3,}\s+\w{3,}\s+\w{3,}\s+\w{3,}\s+\w{3,}\s+\w{3,}\s+\w{3,}\s+\w{3,}\s+\w{3,}\s+\w{3,}\b/ },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "64-hex-char private key", pattern: /\b[0-9a-f]{64}\b/i },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

function readSeed() {
  return readFileSync(join(REPO_ROOT, SEED_PATH), "utf8");
}

function readMigrations() {
  const dir = join(REPO_ROOT, MIGRATIONS_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && !name.endsWith(".test.sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/**
 * Collect every table and its columns from the migration set.
 *
 * `CREATE TABLE` bodies are parsed by indentation, and `ALTER TABLE … ADD COLUMN`
 * is folded in afterwards, since later migrations extend earlier tables. The
 * migrations are generated, well-formatted SQL, so the indentation is a stable
 * contract.
 */
export function extractSchema(migrations) {
  const tables = new Map();
  for (const { sql } of migrations) {
    for (const match of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?(\w+)["']?\s*\(([\s\S]*?)\n\);/gi,
    )) {
      const [, name, body] = match;
      const columns = new Set();
      for (const line of body.split("\n")) {
        const column = line.match(/^\s{2,}(["']?\w+["']?)\s+[A-Za-z]/);
        if (column) {
          // Skip table-level constraint clauses, which start with a keyword.
          const identifier = column[1].replace(/["']/g, "");
          if (!/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE)$/i.test(identifier)) {
            columns.add(identifier);
          }
        }
      }
      if (!tables.has(name)) tables.set(name, columns);
      else for (const column of columns) tables.get(name).add(column);
    }

    for (const match of sql.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?["']?(\w+)["']?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi,
    )) {
      const [, table, column] = match;
      if (tables.has(table)) tables.get(table).add(column);
    }
  }
  return tables;
}

/** Every `INSERT INTO <table> (<columns>)` statement in the seed. */
export function extractInserts(seed) {
  const inserts = [];
  for (const match of seed.matchAll(
    /INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)([\s\S]*?);/gi,
  )) {
    const [, table, columnList, body] = match;
    inserts.push({
      table,
      columns: columnList
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean),
      body,
    });
  }
  return inserts;
}


function checkSchemaAgreement(seed, migrations) {
  const errors = [];
  const warnings = [];
  const schema = extractSchema(migrations);
  const inserts = extractInserts(seed);

  if (inserts.length === 0) {
    errors.push(`${SEED_PATH}: no INSERT statements found; the seed would create nothing`);
    return { errors, warnings, summary: { tables: 0, columns: 0 } };
  }

  let columnCount = 0;
  for (const insert of inserts) {
    if (!schema.has(insert.table)) {
      errors.push(
        `${SEED_PATH}: inserts into "${insert.table}", which no migration creates. Check the table name, or add the migration.`,
      );
      continue;
    }
    const known = schema.get(insert.table);
    for (const column of insert.columns) {
      columnCount += 1;
      if (!known.has(column)) {
        errors.push(
          `${SEED_PATH}: "${insert.table}" has no column "${column}". Known columns: ${[...known].sort().join(", ")}`,
        );
      }
    }
  }

  return { errors, warnings, summary: { tables: inserts.length, columns: columnCount } };
}

function checkIdempotency(seed) {
  const errors = [];
  const inserts = extractInserts(seed);
  for (const insert of inserts) {
    if (!/ON\s+CONFLICT/i.test(insert.body)) {
      errors.push(
        `${SEED_PATH}: the insert into "${insert.table}" has no ON CONFLICT clause, so re-running the bootstrap would duplicate rows or fail. Every fixture insert must be idempotent.`,
      );
    }
  }
  return { errors, warnings: [], summary: { inserts: inserts.length } };
}

/**
 * The custody invariant: fixtures may reference public keys, never signing
 * material. QuickEx is self-custody (ADR 0001), so a fixture that needed a
 * private key would indicate a design error.
 */
function checkNoSecrets(seed) {
  const errors = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (seed.match(pattern)) {
      errors.push(
        `${SEED_PATH}: looks like it contains ${name}. Fixtures must never include signing material — QuickEx is self-custody (ADR 0001) and the backend holds no keys.`,
      );
    }
  }
  return { errors, warnings: [], summary: { patterns: SECRET_PATTERNS.length } };
}

/** Every Stellar key in the seed must be a syntactically valid public key. */
function checkPublicKeys(seed) {
  const errors = [];
  const withoutComments = seed
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  // A short threshold on purpose: a truncated or mistyped key is exactly the
  // case that must be caught, so anything starting with `G` and long enough to
  // be a key attempt is examined.
  const candidates = withoutComments.match(/\bG[A-Za-z0-9]{8,}\b/g) ?? [];
  for (const candidate of new Set(candidates)) {
    if (!PUBLIC_KEY_PATTERN.test(candidate)) {
      errors.push(
        `${SEED_PATH}: "${candidate.slice(0, 12)}…" is not a valid Stellar public key (expected G + 55 base32 characters).`,
      );
    }
  }
  if (candidates.length === 0) {
    errors.push(`${SEED_PATH}: no Stellar public key found; the fixtures look empty`);
  }
  return { errors, warnings: [], summary: { keys: new Set(candidates).size } };
}

/** The seed must refuse to write to anything that is not a local database. */
function checkLocalGuard(seed) {
  const errors = [];
  const stripped = seed.replace(/--.*$/gm, "");
  if (!/RAISE\s+EXCEPTION/i.test(stripped)) {
    errors.push(
      `${SEED_PATH}: no RAISE EXCEPTION guard. The seed must abort when the target database is not local.`,
    );
  }
  if (!/current_database\(\)/i.test(stripped)) {
    errors.push(`${SEED_PATH}: the guard does not inspect current_database()`);
  }
  if (!/BEGIN\s*;/i.test(stripped) || !/COMMIT\s*;/i.test(stripped)) {
    errors.push(
      `${SEED_PATH}: the seed must run inside an explicit transaction so a failure rolls back cleanly`,
    );
  }
  return { errors, warnings: [], summary: {} };
}

export function runCheck(root = REPO_ROOT) {
  const seed = readSeed();
  const migrations = readMigrations();
  const checks = {
    schema: checkSchemaAgreement(seed, migrations),
    idempotency: checkIdempotency(seed),
    secrets: checkNoSecrets(seed),
    publicKeys: checkPublicKeys(seed),
    localGuard: checkLocalGuard(seed),
  };

  const errors = Object.entries(checks).flatMap(([name, result]) =>
    result.errors.map((message) => `[${name}] ${message}`),
  );
  const warnings = Object.entries(checks).flatMap(([name, result]) =>
    result.warnings.map((message) => `[${name}] ${message}`),
  );

  return { checks, errors, warnings, ok: errors.length === 0 };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("usage: node scripts/local-dev/check-seed.mjs [--json]\n");
    return 0;
  }
  if (args.some((arg) => arg !== "--json")) {
    process.stderr.write(`unknown argument: ${args.find((arg) => arg !== "--json")}\n`);
    return 2;
  }

  const report = runCheck(REPO_ROOT);

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const [name, result] of Object.entries(report.checks)) {
      process.stdout.write(
        `${result.errors.length === 0 ? "PASS" : "FAIL"} ${name}: ${result.errors.length} error(s)\n`,
      );
      for (const message of result.errors) process.stdout.write(`  ✗ ${message}\n`);
    }
    process.stdout.write(
      report.ok ? "\nseed check: PASS\n" : `\nseed check: FAIL (${report.errors.length} error(s))\n`,
    );
  }

  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  process.exitCode = main();
}
