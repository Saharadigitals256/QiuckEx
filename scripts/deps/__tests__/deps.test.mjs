import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { REPO_ROOT, readText, PATHS } from '../lib/shared.mjs';
import { classifySpecifier } from '../lib/shared.mjs';
import { auditLockfileIntegrity, parseLockfileImporters, readLockfileVersion } from '../lib/lockfile.mjs';
import { collectSpecifiers, listWorkspaceManifests, checkProvenance } from '../lib/provenance.mjs';
import { checkLockfile } from '../lib/lockfile-check.mjs';
import {
  canonicalizeLicense,
  classifyLicense,
  normalizeLicenseField,
  parseLicenseExpression,
  validateLicensePolicy,
  missingPolicyMentions,
} from '../lib/licenses.mjs';
import { checkLicenses, directDependencies } from '../lib/license-check.mjs';
import { runCheck } from '../check.mjs';

const temporaryRoots = [];

/**
 * Materialise a throwaway repository so each rule can be exercised against a
 * known-bad tree. The gate reads only files under `root`, so a fixture is a
 * complete substitute for the real workspace.
 */
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'quickex-deps-'));
  temporaryRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

/** A minimal `package.json` with the given runtime dependencies. */
function manifest(dependencies) {
  return { name: 'fixture', version: '0.0.0', private: true, dependencies };
}

/** The workspace file that makes `app/*` a member of the fixture. */
const WORKSPACE = "packages:\n  - 'app/*'\n";

/**
 * The minimum the policy-document check requires: every denied license named,
 * plus the four configuration terms it looks for.
 */
const LICENSE_DOC_STUB = [
  'denied: BUSL-1.1, Elastic-2.0',
  'review: unknownBehavior, exceptions',
].join('\n');

const MINIMAL_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      left-pad:
        specifier: ^1.0.0
        version: 1.0.0

  app/thing:
    devDependencies:
      jest:
        specifier: 30.0.0
        version: 30.0.0

packages:

  jest@30.0.0:
    resolution: {integrity: sha512-abc==}
    engines: {node: '>=18'}

  left-pad@1.0.0:
    resolution: {integrity: sha512-def==}

snapshots:

  jest@30.0.0: {}
`;

// ── The repository must pass the gate ────────────────────────────────────────

test('the repository passes the full dependency gate', () => {
  const report = runCheck(REPO_ROOT);
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
});

test('each gate target passes independently', () => {
  for (const only of ['provenance', 'lockfile', 'license']) {
    const report = runCheck(REPO_ROOT, { only });
    assert.deepEqual(report.errors, [], `${only} should pass`);
  }
});

test('the gate reports every workspace manifest', () => {
  const manifests = listWorkspaceManifests(REPO_ROOT);
  for (const expected of [
    'package.json',
    'app/backend/package.json',
    'app/frontend/package.json',
    'app/mobile/package.json',
  ]) {
    assert.ok(manifests.includes(expected), `${expected} should be scanned`);
  }
});

// ── Provenance ───────────────────────────────────────────────────────────────

test('specifier classification separates registry, workspace, and unsafe sources', () => {
  assert.equal(classifySpecifier('^1.2.3').kind, 'registry');
  assert.equal(classifySpecifier('1.2.3').kind, 'registry');
  assert.equal(classifySpecifier('workspace:*').kind, 'workspace');
  assert.equal(classifySpecifier('workspace:^').kind, 'workspace');

  for (const bad of [
    'git+https://github.com/org/repo.git',
    'github:org/repo',
    'gitlab:org/repo',
    'bitbucket:org/repo',
    'file:../local-pkg',
    'link:../local-pkg',
    'http://example.com/pkg.tgz',
    'https://example.com/pkg.tgz',
  ]) {
    assert.equal(classifySpecifier(bad).kind, 'non-registry', `${bad} must be rejected`);
  }

  for (const tag of ['latest', 'next', 'beta', 'canary', 'nightly', 'alpha', 'dev']) {
    assert.equal(classifySpecifier(tag).kind, 'floating', `${tag} must be rejected`);
  }

  for (const wildcard of ['*', 'x', '1.x', '1.*']) {
    assert.equal(classifySpecifier(wildcard).kind, 'unpinned', `${wildcard} must be rejected`);
  }

  assert.equal(classifySpecifier('').kind, 'unpinned');
});

test('no committed manifest bypasses the registry or floats on a dist-tag', () => {
  const specifiers = collectSpecifiers(REPO_ROOT);
  assert.ok(specifiers.length > 50, 'the workspace should declare many dependencies');
  for (const entry of specifiers) {
    const { kind } = classifySpecifier(entry.specifier);
    assert.ok(
      kind === 'registry' || kind === 'workspace',
      `${entry.manifest}: ${entry.name} (${entry.specifier}) is "${kind}"`,
    );
  }
});

test('provenance check fails a git dependency and a dist-tag with distinct errors', () => {
  const root = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({ bad: 'git+ssh://git@github.com/org/repo.git#abc123' }),
    'app/thing/package.json': manifest({ floating: 'latest' }),
  });

  const { errors } = checkProvenance(root);
  assert.equal(errors.length, 2);
  assert.ok(
    errors.some((message) => message.includes('git+ssh') && message.includes('bypasses') === false && message.includes('protocol')),
    `expected a protocol error, got: ${errors.join(' | ')}`,
  );
  assert.ok(
    errors.some((message) => message.includes('dist-tag')),
    `expected a dist-tag error, got: ${errors.join(' | ')}`,
  );
});

test('provenance check fails wildcard ranges and accepts workspace links', () => {
  const failing = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({ anything: '*', alsoAnything: '1.x' }),
    'app/thing/package.json': manifest({ shared: 'workspace:*' }),
  });
  const { errors } = checkProvenance(failing);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((message) => message.includes('accepts any version')));

  const passing = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({ shared: 'workspace:*' }),
    'app/thing/package.json': manifest({ fine: '^1.0.0' }),
  });
  assert.deepEqual(checkProvenance(passing).errors, []);
});

test('provenance check flags a git specifier hidden in the lockfile', () => {
  // A manifest can look clean while the generated lockfile still smuggles in an
  // unhashed source, so the lockfile is scanned independently of the manifests.
  const root = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({ fine: '^1.0.0' }),
    'app/thing/package.json': manifest({ fine: '^1.0.0' }),
    [PATHS.lockfile]: `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      fine:
        specifier: ^1.0.0
        version: 1.0.0
      smuggled:
        specifier: github:someone/someone-fork
        version: github.com/someone/someone-fork/abc123

packages:

  fine@1.0.0:
    resolution: {integrity: sha512-abc==}
`,
  });

  const { errors } = checkProvenance(root);
  assert.equal(errors.length, 1, `expected one lockfile error, got: ${errors.join(' | ')}`);
  assert.match(errors[0], /bypasses the registry/);
});

// ── Lockfile integrity ───────────────────────────────────────────────────────

test('lockfile importers are parsed per workspace package and section', () => {
  const importers = parseLockfileImporters(MINIMAL_LOCKFILE);
  assert.deepEqual(Object.keys(importers), ['.', 'app/thing']);
  assert.equal(importers['.'].dependencies['left-pad'], '^1.0.0');
  assert.equal(importers['app/thing'].devDependencies.jest, '30.0.0');
  // Scoped names keep their quotes in the lockfile; the parser must strip them.
  assert.equal(importers['.']?.dependencies?.['@scope/pkg'], undefined);
});

test('lockfile importers parse a quoted scoped dependency', () => {
  const parsed = parseLockfileImporters(`lockfileVersion: '9.0'

importers:

  app/thing:
    dependencies:
      '@scope/pkg':
        specifier: ^2.0.0
        version: 2.0.0
      "other-pkg":
        specifier: ^3.0.0
        version: 3.0.0

packages:

  '@scope/pkg@2.0.0':
    resolution: {integrity: sha512-a==}

  other-pkg@3.0.0:
    resolution: {integrity: sha512-b==}
`);
  assert.equal(parsed['app/thing'].dependencies['@scope/pkg'], '^2.0.0');
  assert.equal(parsed['app/thing'].dependencies['other-pkg'], '^3.0.0');
});

test('a lockfile without an importers section is a hard failure', () => {
  assert.throws(
    () => parseLockfileImporters("lockfileVersion: '9.0'\n\npackages:\n"),
    /no top-level `importers:` section/,
  );
});

test('every resolved package is counted and hashed', () => {
  const integrity = auditLockfileIntegrity(MINIMAL_LOCKFILE);
  assert.equal(integrity.total, 2);
  assert.equal(integrity.hashed, 2);
  assert.deepEqual(integrity.unhashed, []);
  assert.equal(readLockfileVersion(MINIMAL_LOCKFILE), '9.0');
});

test('an entry resolved without a content hash is reported, not silently passed', () => {
  const integrity = auditLockfileIntegrity(`lockfileVersion: '9.0'

packages:

  hashed@1.0.0:
    resolution: {integrity: sha512-a==}

  untrusted@2.0.0:
    resolution: {tarball: https://example.com/untrusted.tgz}
`);
  assert.equal(integrity.total, 2);
  assert.equal(integrity.hashed, 1);
  assert.deepEqual(integrity.unhashed, ['untrusted@2.0.0']);
});

test('a matching lockfile passes the integrity and agreement checks', () => {
  const root = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({ 'left-pad': '^1.0.0' }),
    'app/thing/package.json': { name: 'thing', version: '0.0.0', private: true, devDependencies: { jest: '30.0.0' } },
    [PATHS.lockfile]: MINIMAL_LOCKFILE,
  });

  const { errors, summary } = checkLockfile(root);
  assert.deepEqual(errors, []);
  assert.equal(summary.hashed, 2);
  assert.equal(summary.importers, 2);
});

test('manifest drift from the lockfile fails with a runnable instruction', () => {
  // The realistic failure: someone adds a dependency and forgets `pnpm install`.
  const root = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({ 'left-pad': '^1.0.0', 'new-dep': '^4.0.0' }),
    'app/thing/package.json': { name: 'thing', version: '0.0.0', private: true, devDependencies: { jest: '30.0.0' } },
    [PATHS.lockfile]: MINIMAL_LOCKFILE,
  });

  const { errors } = checkLockfile(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"new-dep" is declared but absent/);
  assert.match(errors[0], /pnpm install/);
});

test('a changed specifier is caught even when the dependency is still present', () => {
  const root = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({ 'left-pad': '^2.0.0' }),
    'app/thing/package.json': { name: 'thing', version: '0.0.0', private: true, devDependencies: { jest: '30.0.0' } },
    [PATHS.lockfile]: MINIMAL_LOCKFILE,
  });

  const { errors } = checkLockfile(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /is "\^2\.0\.0" but the lockfile pins "\^1\.0\.0"/);
});

test('a missing lockfile and an unsupported version are both hard failures', () => {
  const noLockfile = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({}),
  });
  assert.match(checkLockfile(noLockfile).errors[0], /pnpm-lock\.yaml is missing/);

  const wrongVersion = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({}),
    [PATHS.lockfile]: MINIMAL_LOCKFILE.replace("lockfileVersion: '9.0'", "lockfileVersion: '5.4'"),
  });
  assert.match(checkLockfile(wrongVersion).errors[0], /lockfileVersion 5\.4 is not supported/);
});

test('an importer with no manifest, and a manifest with no importer, both fail', () => {
  const orphanImporter = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({}),
    [PATHS.lockfile]: MINIMAL_LOCKFILE,
  });
  const orphanErrors = checkLockfile(orphanImporter).errors;
  assert.ok(
    orphanErrors.some((message) => message.includes('app/thing') && message.includes('no matching package.json')),
    `expected an orphan-importer error, got: ${orphanErrors.join(' | ')}`,
  );

  const orphanManifest = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({}),
    'app/thing/package.json': { name: 'thing', version: '0.0.0', private: true },
    [PATHS.lockfile]: `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      fine:
        specifier: ^1.0.0
        version: 1.0.0

packages:

  fine@1.0.0:
    resolution: {integrity: sha512-a==}
`,
  });
  assert.ok(
    checkLockfile(orphanManifest).errors.some((message) => message.includes('no importer entry for "app/thing"')),
  );
});

// ── Licenses ─────────────────────────────────────────────────────────────────

const POLICY = {
  version: 1,
  allow: ['MIT', 'Apache-2.0', 'ISC'],
  review: ['GPL-3.0', 'AGPL-3.0', 'MPL-2.0'],
  deny: ['BUSL-1.1', 'Elastic-2.0'],
  unknownBehavior: 'review',
  exceptions: [{ license: 'busboy', justification: 'publishes no SPDX field; MIT in the LICENSE file' }],
};

test('legacy SPDX spellings are canonicalised before classification', () => {
  assert.equal(canonicalizeLicense('agpl-3.0'), 'AGPL-3.0-only');
  assert.equal(canonicalizeLicense('GPL-3.0+'), 'GPL-3.0-or-later');
  assert.equal(canonicalizeLicense('mit'), 'MIT');
  assert.equal(canonicalizeLicense('  Apache-2.0  '), 'Apache-2.0');
  assert.equal(canonicalizeLicense(''), null);
  assert.equal(canonicalizeLicense(undefined), null);
});

test('license fields are normalised from string, array, and object forms', () => {
  assert.deepEqual(normalizeLicenseField('MIT'), ['MIT']);
  assert.deepEqual(normalizeLicenseField(['MIT', 'ISC']), ['MIT', 'ISC']);
  assert.deepEqual(normalizeLicenseField({ type: 'MIT' }), ['MIT']);
  assert.deepEqual(normalizeLicenseField(null), []);
  // A dual-licence expression is judged on its most permissive branch.
  assert.deepEqual(normalizeLicenseField('MIT OR Apache-2.0').sort(), ['Apache-2.0', 'MIT']);
});

test('licenses are classified into allow, review, and deny', () => {
  assert.equal(classifyLicense('MIT', POLICY).verdict, 'allow');
  assert.equal(classifyLicense('GPL-3.0', POLICY).verdict, 'review');
  assert.equal(classifyLicense('BUSL-1.1', POLICY).verdict, 'deny');
  // `OR` means the consumer picks a branch, so a permissive branch is usable
  // even when the alternative branch is denied or requires review.
  assert.equal(classifyLicense('MIT OR BUSL-1.1', POLICY).verdict, 'allow');
  assert.equal(classifyLicense('MIT OR GPL-3.0', POLICY).verdict, 'allow');
  // A package with no permissive branch is still judged on its worst option.
  assert.equal(classifyLicense('GPL-3.0 OR BUSL-1.1', POLICY).verdict, 'review');
  // An unlisted branch does not become usable just because another branch is.
  assert.equal(classifyLicense('MIT OR WTFPL', { ...POLICY, allow: ['MIT'] }).verdict, 'allow');
});

test('an unstated license is unknown, and unknown is not silent approval', () => {
  const unknown = classifyLicense(undefined, POLICY);
  assert.equal(unknown.verdict, 'unknown');
  assert.match(unknown.reason, /no SPDX license/);

  assert.equal(classifyLicense('WTFPL', POLICY).verdict, 'unknown');
  // A `private` package with no licence is a finding; a recorded exception clears it.
  const withException = classifyLicense('WTFPL', { ...POLICY, exceptions: [{ license: 'WTFPL', justification: 'reviewed' }] });
  assert.equal(withException.verdict, 'allow');
});

test('unknownBehavior is configurable', () => {
  assert.equal(classifyLicense(undefined, { ...POLICY, unknownBehavior: 'allow' }).verdict, 'allow');
  assert.equal(classifyLicense(undefined, { ...POLICY, unknownBehavior: 'deny' }).verdict, 'deny');
});

test('policy shape is validated, including ambiguous and unjustified entries', () => {
  assert.deepEqual(validateLicensePolicy(POLICY), []);
  assert.ok(validateLicensePolicy(null).length > 0);
  assert.ok(validateLicensePolicy({ allow: [], deny: [], review: [], unknownBehavior: 'nope' })
    .some((message) => message.includes('unknownBehavior')));
  assert.ok(validateLicensePolicy({ allow: ['MIT'], deny: ['MIT'], review: [], unknownBehavior: 'review' })
    .some((message) => message.includes('both allowed and denied')));
  assert.ok(validateLicensePolicy({ allow: [], deny: [], review: [], unknownBehavior: 'review', exceptions: [{ license: 'MPL-2.0' }] })
    .some((message) => message.includes('justification')));
});

test('the policy document must describe every denied license', () => {
  const policy = validateLicensePolicy;
  assert.equal(typeof policy, 'function');
  const doc = readText(REPO_ROOT, PATHS.licenseDoc);
  const findings = missingPolicyMentions(doc, {
    deny: ['BUSL-1.1', 'Elastic-2.0', 'PolyForm-Noncommercial-1.0.0'],
    allow: [],
    review: [],
  });
  assert.deepEqual(findings, [], 'every denied license must appear in the policy doc');
});

test('SPDX expressions are parsed, not treated as single ids', () => {
  // Real manifests use every one of these forms; a naive split misreads them.
  assert.deepEqual(parseLicenseExpression('MIT'), ['MIT']);
  assert.deepEqual(parseLicenseExpression('MIT OR Apache-2.0').sort(), ['Apache-2.0', 'MIT']);
  assert.deepEqual(parseLicenseExpression('MIT AND Apache-2.0').sort(), ['Apache-2.0', 'MIT']);
  assert.deepEqual(parseLicenseExpression('(MIT, Apache-2.0)').sort(), ['Apache-2.0', 'MIT']);
  assert.deepEqual(parseLicenseExpression('(MIT OR Apache-2.0)').sort(), ['Apache-2.0', 'MIT']);
  assert.deepEqual(parseLicenseExpression('MIT AND ISC').sort(), ['ISC', 'MIT']);
  assert.deepEqual(parseLicenseExpression('Apache-2.0 WITH LLVM-exception'), ['Apache-2.0', 'LLVM-exception']);
  assert.deepEqual(parseLicenseExpression('BlueOak-1.0.0'), ['BlueOak-1.0.0']);
  assert.deepEqual(parseLicenseExpression(''), []);
  assert.deepEqual(parseLicenseExpression(undefined), []);
});

test('legacy and object license fields are normalised', () => {
  assert.deepEqual(normalizeLicenseField({ type: 'MIT' }), ['MIT']);
  assert.deepEqual(normalizeLicenseField({ type: 'MIT', url: 'https://example.com' }), ['MIT']);
  assert.deepEqual(normalizeLicenseField({ deprecatedLicenseId: 'GPL-2.0' }), ['GPL-2.0']);
  assert.deepEqual(normalizeLicenseField([{ type: 'MIT' }, { type: 'ISC' }]).sort(), ['ISC', 'MIT']);
  assert.deepEqual(normalizeLicenseField({ licenses: [{ type: 'MIT' }] }), ['MIT']);
  assert.deepEqual(normalizeLicenseField(null), []);
});

test('an exception may be recorded against a package that declares no license', () => {
  // busboy and streamsearch publish no SPDX field, so an id-based exception
  // can never match; the name is the only stable identifier available.
  const withException = classifyLicense(undefined, POLICY, 'busboy');
  assert.equal(withException.verdict, 'allow');
  assert.equal(withException.excepted, 'busboy');
  // A different package is not covered by that exception.
  assert.equal(classifyLicense(undefined, POLICY, 'some-other-pkg').verdict, 'unknown');
  // And the name match is case-insensitive.
  assert.equal(classifyLicense(undefined, POLICY, 'BusBoy').verdict, 'allow');
});

test('a license expression is judged on its branches, not as one unknown id', () => {
  assert.equal(classifyLicense('MIT AND ISC', POLICY).verdict, 'allow');
  assert.equal(classifyLicense('(MIT, Apache-2.0)', POLICY).verdict, 'allow');
  // A real review case from the tree: MPL-2.0 tooling that is not redistributed.
  assert.equal(classifyLicense('MPL-2.0', POLICY).verdict, 'review');
  assert.equal(
    classifyLicense('MPL-2.0', { ...POLICY, exceptions: [{ license: 'MPL-2.0', justification: 'tooling' }] }).verdict,
    'allow',
  );
});

test('the license check accepts the repository and reads its direct dependencies', () => {
  const { errors, summary } = checkLicenses(REPO_ROOT);
  assert.deepEqual(errors, []);
  assert.ok(summary.direct > 50, 'the direct dependency set should be substantial');
  assert.equal(directDependencies(REPO_ROOT).includes('@quickex/backend'), false);
});

test('the license check fails when the policy document is missing', () => {
  const root = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({}),
    [PATHS.lockfile]: MINIMAL_LOCKFILE,
    [PATHS.licensePolicy]: POLICY,
  });
  const { errors } = checkLicenses(root);
  assert.ok(
    errors.some((message) => message.includes(PATHS.licenseDoc) && message.includes('missing')),
    `expected a missing-policy-doc error, got: ${errors.join(' | ')}`,
  );
});

test('the license check degrades gracefully when no lockfile is present', () => {
  const root = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({}),
    [PATHS.licensePolicy]: POLICY,
    [PATHS.licenseDoc]: LICENSE_DOC_STUB,
  });
  const { errors, warnings } = checkLicenses(root);
  // An absent lockfile is a provenance/integrity concern, not a licence
  // verdict, so the license target warns rather than inventing a failure.
  assert.ok(warnings.some((message) => message.includes('pnpm install')));
  assert.deepEqual(errors, []);
});

test('the installed sweep warns instead of failing when node_modules is absent', () => {
  // Degraded mode: CI runs this after `pnpm install`, a fresh clone cannot.
  const root = makeRepo({
    [PATHS.workspace]: WORKSPACE,
    'package.json': manifest({}),
    [PATHS.lockfile]: MINIMAL_LOCKFILE,
    [PATHS.licensePolicy]: POLICY,
    [PATHS.licenseDoc]: LICENSE_DOC_STUB,
  });
  const { warnings } = checkLicenses(root, { installed: true });
  assert.ok(warnings.some((message) => message.includes('node_modules is absent')));
});
