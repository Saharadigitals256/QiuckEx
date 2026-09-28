import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyForbiddenPath,
  findFormattingIssues,
  isAllowlisted,
  isBinary,
  parseAllowlist,
  loadAllowlist,
  runCheck,
  shouldScanContents,
  REPO_ROOT,
} from '../check.mjs';

// ── Generated artifacts and secret-bearing paths ─────────────────────────────

test('forbidden paths are classified by what they are, not by extension alone', () => {
  for (const secret of [
    '.env',
    '.env.local',
    'app/backend/.env.production',
    '.netrc',
    '.pgpass',
    'deploy.pem',
    'server.key',
    'id_rsa',
    'certs/store.p12',
    'release.keystore',
  ]) {
    assert.ok(classifyForbiddenPath(secret), `${secret} must be rejected`);
  }
  for (const artifact of [
    'node_modules/foo/index.js',
    'app/backend/dist/main.js',
    '.turbo/cache/abc.tar.zst',
    'app/frontend/.next/build.json',
    'coverage/lcov.info',
    'app/backend/target/release/contract.wasm',
    'debug.log',
    'stryker-tmp/report.json',
  ]) {
    const hit = classifyForbiddenPath(artifact);
    assert.ok(hit, `${artifact} must be rejected`);
    assert.match(hit.reason, /build output|reproducible|regenerat|artifact|log|cache|temp/i);
  }
});

test('legitimate source paths are not rejected', () => {
  for (const ok of [
    'package.json',
    'app/backend/src/main.ts',
    'docs/GOVERNANCE.md',
    'app/backend/supabase/migrations/20250219000000_create_usernames_table.sql',
    '.github/workflows/ci.yml',
    'scripts/precommit/check.mjs',
    // `.env.example` is the documented, placeholder-only template.
    '.env.example',
    'app/frontend/.eslintrc.json',
  ]) {
    assert.equal(classifyForbiddenPath(ok), null, `${ok} must be allowed`);
  }
});

// ── Secret content ───────────────────────────────────────────────────────────

test('binary content is detected so it is never scanned as text', () => {
  assert.equal(isBinary(Buffer.from('#!/bin/sh\necho hi\n')), false);
  assert.equal(isBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), true);
});

// ── Formatting rules ─────────────────────────────────────────────────────────

test('formatting issues are reported per rule', () => {
  assert.deepEqual(findFormattingIssues('a.ts', Buffer.from('const a = 1;\n')), []);

  assert.match(
    findFormattingIssues('a.ts', Buffer.from('const a = 1;'))[0],
    /does not end with a newline/,
  );
  assert.match(
    findFormattingIssues('a.ts', Buffer.from('const a = 1;\n\n'))[0],
    /ends with a blank line/,
  );
  assert.match(
    findFormattingIssues('a.ts', Buffer.from('const a = 1;   \n'))[0],
    /trailing whitespace on line 1/,
  );
  assert.match(
    findFormattingIssues('a.ts', Buffer.from('const a = 1;\r\n'))[0],
    /CRLF line endings/,
  );
  // An empty file is not a formatting failure.
  assert.deepEqual(findFormattingIssues('a.ts', Buffer.from('')), []);
});

// ── Allowlist ────────────────────────────────────────────────────────────────

test('allowlist entries parse with a justification and skip comments', () => {
  const entries = parseAllowlist(`# a comment

.env.local | local secrets
docs/*.png | generated screenshots
  spaced/path.txt   |   trailing reason with | a pipe
bare-entry.txt
`);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].pattern, '.env.local');
  assert.equal(entries[0].reason, 'local secrets');
  assert.equal(entries[1].pattern, 'docs/*.png');
  // A second `|` is part of the reason, not a new field.
  assert.equal(entries[2].reason, 'trailing reason with | a pipe');
  // A missing justification is recorded rather than silently accepted.
  assert.equal(entries[3].reason, 'no justification given');
});

test('allowlist globs match exactly, and support a trailing wildcard', () => {
  const allowlist = parseAllowlist('exact/file.txt | x\ndocs/generated/*.png | y\n');
  assert.equal(isAllowlisted('exact/file.txt', allowlist), true);
  assert.equal(isAllowlisted('exact/other.txt', allowlist), false);
  assert.equal(isAllowlisted('docs/generated/a.png', allowlist), true);
  assert.equal(isAllowlisted('docs/generated/nested/a.png', allowlist), false);
});

// ── Content-scan exclusions ──────────────────────────────────────────────────

test('lockfiles, baselines and the rule files themselves are not scanned', () => {
  for (const excluded of [
    'pnpm-lock.yaml',
    'package-lock.json',
    '.secrets.baseline',
    'gitleaks.toml',
    'scripts/precommit/check.mjs',
  ]) {
    assert.equal(shouldScanContents(excluded), false, `${excluded} must be excluded`);
  }
  // Ordinary source is scanned.
  assert.equal(shouldScanContents('app/backend/src/main.ts'), true);
});

test('markdown is exempt from the trailing-whitespace rule', () => {
  // Two trailing spaces are a Markdown hard line break.
  assert.deepEqual(findFormattingIssues('a.md', Buffer.from('line  \nnext\n')), []);
  // But the newline rules still apply.
  assert.match(
    findFormattingIssues('a.md', Buffer.from('line'))[0],
    /does not end with a newline/,
  );
});

test('rules only apply to text we format, not to binaries or images', () => {
  assert.deepEqual(findFormattingIssues('a.png', Buffer.from('no trailing newline')), []);
  assert.deepEqual(findFormattingIssues('a.ts', Buffer.from([0x00, 0x01, 0x02])), []);
});

// ── The repository must pass ─────────────────────────────────────────────────

test('the whole tracked tree passes the pre-commit check', () => {
  const report = runCheck(REPO_ROOT, { files: null, ratchet: true });
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
});

test('the committed allowlist is fully justified', () => {
  // A bare entry with no reason is a silent suppression, which is exactly what
  // the allowlist exists to prevent.
  const content = readFileSync(`${REPO_ROOT}/scripts/precommit/allowlist.txt`, 'utf8');
  for (const entry of parseAllowlist(content)) {
    assert.notEqual(entry.reason, 'no justification given', `${entry.pattern} needs a reason`);
    assert.ok(entry.reason.length > 15, `${entry.pattern} needs a real justification`);
  }
});

// ── Failure modes, proven against real files ────────────────────────────────

/** Run `assertion` with a file's contents replaced, then always restore it. */
function withFile(path, transform, assertion) {
  const original = readFileSync(path);
  try {
    writeFileSync(path, transform(original.toString('utf8')), 'utf8');
    assertion();
  } finally {
    writeFileSync(path, original);
  }
}

test('a new violation fails even in a file that already had one', () => {
  // The ratchet waives findings that already existed in HEAD; it must not waive
  // a violation this change introduces.
  withFile(`${REPO_ROOT}/app/backend/src/app.module.ts`, (text) => `${text}\nconst added = 1;   \n`, () => {
    const report = runCheck(REPO_ROOT, { files: ['app/backend/src/app.module.ts'] });
    assert.equal(report.ok, false);
    assert.ok(
      report.errors.some((e) => e.rule === 'formatting' && /trailing whitespace/.test(e.message)),
      `expected a new trailing-whitespace finding, got: ${JSON.stringify(report.errors)}`,
    );
  });
});

test('a pre-existing violation is waived rather than blamed on this change', () => {
  const file = 'app/backend/src/app.module.ts';
  // That file has no final newline in HEAD, so the ratchet waives it...
  const waived = runCheck(REPO_ROOT, { files: [file] });
  assert.ok(!waived.errors.some((e) => /does not end with a newline/.test(e.message)));
  // ...but without the ratchet it is reported, so the backlog stays measurable.
  const strict = runCheck(REPO_ROOT, { files: [file], ratchet: false });
  assert.ok(strict.errors.some((e) => /does not end with a newline/.test(e.message)));
});

test('a generated artifact is rejected and an allowlisted one is suppressed', () => {
  const artifact = runCheck(REPO_ROOT, { files: ['app/backend/dist/main.js'] });
  assert.equal(artifact.ok, false);
  assert.ok(artifact.errors.some((e) => e.rule === 'generated-artifact'));

  // node.tar.xz is allowlisted with a justification, so it is suppressed...
  const suppressed = runCheck(REPO_ROOT, { files: ['node.tar.xz'] });
  assert.equal(suppressed.ok, true);
  assert.equal(suppressed.suppressed.length, 1);
  assert.match(suppressed.suppressed[0].reason, /toolchain/i);
  // ...but only for that exact path.
  assert.equal(isAllowlisted('other.tar.xz', loadAllowlist(REPO_ROOT)), false, 'the entry must not cover other files');
});

test('a secret-shaped value is rejected without echoing the value', () => {
  const secret = `S${'A'.repeat(55)}`;
  const root = mkdtempSync(join(tmpdir(), 'quickex-precommit-'));
  const file = 'config.ts';
  writeFileSync(join(root, file), `export const key = '${secret}';\n`, 'utf8');

  const report = runCheck(root, { files: [file], allowlist: [] });
  assert.equal(report.ok, false);
  const finding = report.errors.find((e) => e.rule === 'secret');
  assert.ok(finding, 'a Stellar secret key must be rejected');
  assert.match(finding.message, /Stellar secret key/);
  // The message must not carry the secret itself, or the log becomes the leak.
  assert.ok(!finding.message.includes(secret), 'the secret must never be echoed');
});
