import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { REPO_ROOT, PATHS, missingSections, headings } from '../lib/shared.mjs';
import { collectOperations, collectRefs, resolveRef, checkOpenApiStructure } from '../lib/openapi.mjs';
import {
  checkContractDrift,
  checkGlobalPrefixInvariant,
  collectBackendRoutes,
  documentedPathSegments,
  extractControllerPrefixes,
  isPrefixDocumented,
} from '../lib/contract.mjs';
import { checkMobileDocs } from '../lib/mobile.mjs';
import { runCheck } from '../check.mjs';

const roots = [];

/** A throwaway repository; the gate reads only files under `root`. */
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'quickex-docs-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return root;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A minimal but valid OpenAPI document with the given paths. */
function openapiWith(paths) {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 't', version: '1.0.0' },
    paths,
    tags: [{ name: 'things', description: 'd' }],
    components: { schemas: { Thing: { type: 'object' } } },
  });
}

const OK_PATHS = {
  '/things': {
    get: {
      operationId: 'listThings',
      summary: 'List things',
      tags: ['things'],
      responses: { '200': { description: 'ok' } },
    },
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

test('controller prefixes are extracted from source text', () => {
  const found = extractControllerPrefixes([
    { file: 'a.ts', content: "@Controller('admin/users')\nclass A {}" },
    { file: 'b.ts', content: '@Controller()\nclass B {}' },
    { file: 'c.ts', content: '@Controller("v1/demo")\nclass C {}' },
  ]);
  assert.deepEqual(found.map((entry) => entry.prefix), ['admin/users', '', 'v1/demo']);
  assert.equal(found[0].file, 'a.ts');
});

test('documented path segments are the distinct first segments', () => {
  const segments = documentedPathSegments(['/links/metadata', '/links/bulk', '/health']);
  assert.ok(segments.has('links'));
  assert.ok(segments.has('health'));
  assert.equal(segments.size, 2);
});

test('a prefix counts as documented when any segment matches', () => {
  const segments = new Set(['links', 'health']);
  assert.equal(isPrefixDocumented('links', segments), true);
  assert.equal(isPrefixDocumented('admin/links', segments), true);
  assert.equal(isPrefixDocumented('mystery', segments), false);
  // A root controller has no prefix to document.
  assert.equal(isPrefixDocumented('', segments), true);
});

test('JSON pointers resolve, and a missing one is reported', () => {
  const document = { components: { schemas: { A: { type: 'object' } } } };
  assert.equal(resolveRef(document, '#/components/schemas/A').found, true);
  assert.equal(resolveRef(document, '#/components/schemas/Missing').found, false);
  // An external ref is not the document's problem to resolve.
  assert.equal(resolveRef(document, 'https://example.com/x.json').found, true);
});

test('operations and refs are collected from anywhere in the document', () => {
  const document = {
    paths: { '/a': { get: { responses: {} }, parameters: [] } },
    components: { schemas: { A: { properties: { b: { $ref: '#/components/schemas/B' } } }, B: {} } },
  };
  const operations = collectOperations(document);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].method, 'get');
  // `parameters` is a path item, not an operation.
  assert.equal(operations[0].path, '/a');
  assert.deepEqual([...collectRefs(document)], ['#/components/schemas/B']);
});

test('markdown section helpers tolerate numbering styles', () => {
  const doc = '## 1. One\n## Two\n';
  assert.deepEqual(headings(doc), ['1. One', 'Two']);
  assert.deepEqual(missingSections(doc, ['1.', '2.']), ['2.']);
  assert.deepEqual(missingSections(doc, ['1.', 'Two']), []);
});

// ── OpenAPI structure: failure modes ────────────────────────────────────────

test('a valid document passes the structural check', () => {
  const root = makeRepo({ [PATHS.openapi]: openapiWith(OK_PATHS) });
  const { errors, summary } = checkOpenApiStructure(root);
  assert.deepEqual(errors, []);
  assert.equal(summary.operations, 1);
});

test('malformed JSON is reported without crashing the gate', () => {
  const root = makeRepo({ [PATHS.openapi]: '{ not json' });
  const { errors } = checkOpenApiStructure(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not valid JSON/);
});

test('a missing required field, version, and empty paths are all caught', () => {
  const noVersion = makeRepo({
    [PATHS.openapi]: JSON.stringify({ info: { title: 't' }, paths: OK_PATHS }),
  });
  assert.ok(checkOpenApiStructure(noVersion).errors.some((e) => /3\.x `openapi` version/.test(e)));

  const empty = makeRepo({
    [PATHS.openapi]: JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} }),
  });
  assert.ok(checkOpenApiStructure(empty).errors.some((e) => /`paths` is empty/.test(e)));
});

test('an operation with no responses, no tag, or no description fails', () => {
  const root = makeRepo({
    [PATHS.openapi]: openapiWith({ '/things': { get: { operationId: 'x' } } }),
  });
  const { errors } = checkOpenApiStructure(root);
  assert.ok(errors.some((e) => /declares no responses/.test(e)));
  assert.ok(errors.some((e) => /has no tag/.test(e)));
  assert.ok(errors.some((e) => /neither a summary nor a description/.test(e)));
});

test('an undeclared tag is an error, and an unused schema is a warning', () => {
  const untagged = makeRepo({
    [PATHS.openapi]: JSON.stringify({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      tags: [{ name: 'other' }],
      paths: { '/a': { get: { tags: ['things'], summary: 's', responses: { '200': {} } } } },
      components: { schemas: { Unused: {} } },
    }),
  });
  const result = checkOpenApiStructure(untagged);
  assert.ok(result.errors.some((e) => /tag "things", which is not declared/.test(e)));
  assert.ok(result.warnings.some((e) => /"Unused" is declared but never referenced/.test(e)));
});

test('a dangling $ref and an undeclared schema are both errors', () => {
  const root = makeRepo({
    [PATHS.openapi]: JSON.stringify({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      tags: [{ name: 'things' }],
      paths: {
        '/a': {
          get: {
            tags: ['things'],
            summary: 's',
            responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ghost' } } } } },
          },
        },
      },
      components: { schemas: { Thing: {} } },
    }),
  });
  const { errors } = checkOpenApiStructure(root);
  assert.ok(errors.some((e) => /#\/components\/schemas\/Ghost/.test(e)));
});

// ── Contract drift ──────────────────────────────────────────────────────────

test('a controller with no documentation fails, and the error names the file', () => {
  const root = makeRepo({
    [PATHS.openapi]: openapiWith(OK_PATHS),
    'app/backend/src/widgets/widgets.controller.ts': "@Controller('widgets')\nexport class W {}",
  });
  const { errors, summary } = checkContractDrift(root);
  assert.equal(summary.undocumented, 1);
  assert.match(errors[0], /widgets\.controller\.ts/);
  assert.match(errors[0], /controller "widgets"/);
});

test('a controller covered by a documented path segment passes', () => {
  const root = makeRepo({
    [PATHS.openapi]: openapiWith(OK_PATHS),
    'app/backend/src/things/things.controller.ts': "@Controller('things')\nexport class T {}",
  });
  const { errors, summary } = checkContractDrift(root);
  assert.deepEqual(errors, []);
  assert.equal(summary.documented, 1);
});

test('a controller described only in the contract map is a warning, not a failure', () => {
  const root = makeRepo({
    [PATHS.openapi]: openapiWith(OK_PATHS),
    'app/backend/src/legacy/legacy.controller.ts': "@Controller('legacy')\nexport class L {}",
    [PATHS.contractMap]: 'The /legacy routes are described in prose only.',
  });
  const { errors, warnings } = checkContractDrift(root);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /described in/.test(w)));
});

test('a missing OpenAPI document is a clear error, not a crash', () => {
  const root = makeRepo({ 'app/backend/src/a/a.controller.ts': "@Controller('a')" });
  assert.match(checkContractDrift(root).errors[0], /openapi\.json is missing/);
});

test('a global route prefix contradicts the contract map and is caught', () => {
  const contradicting = makeRepo({
    [PATHS.mainEntry]: 'app.setGlobalPrefix("api");',
    [PATHS.contractMap]: 'The backend registers no global route prefix.',
  });
  assert.ok(
    checkGlobalPrefixInvariant(contradicting).errors.some((e) => /setGlobalPrefix/.test(e)),
  );

  // Once the map documents it, the two agree and it passes.
  const updated = makeRepo({
    [PATHS.mainEntry]: 'app.setGlobalPrefix("api");',
    [PATHS.contractMap]: 'The backend calls setGlobalPrefix("api").',
  });
  assert.deepEqual(checkGlobalPrefixInvariant(updated).errors, []);

  // The real repository registers no prefix, which must stay consistent.
  assert.deepEqual(checkGlobalPrefixInvariant(REPO_ROOT).errors, []);
});

test('backend routes are collected from nested controller directories', () => {
  const root = makeRepo({
    'app/backend/src/a/a.controller.ts': "@Controller('a')",
    'app/backend/src/deep/nested/b.controller.ts': "@Controller('deep/b')",
    'app/backend/src/a/not-a-controller.ts': "@Controller('ignored')",
  });
  const backend = collectBackendRoutes(root);
  assert.deepEqual(backend.prefixes.sort(), ['a', 'deep/b']);
  assert.equal(backend.files, 2);
});

// ── Mobile documentation ────────────────────────────────────────────────────

test('an undocumented EXPO_PUBLIC variable is an error naming its reader', () => {
  const root = makeRepo({
    'app/mobile/app.config.ts': "process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000'",
    'app/mobile/services/api.ts': 'const url = process.env.EXPO_PUBLIC_API_URL;',
    'app/mobile/README.md': '# Mobile',
  });
  const { errors, summary } = checkMobileDocs(root);
  assert.equal(summary.variables, 1);
  assert.match(errors[0], /EXPO_PUBLIC_API_URL/);
  assert.match(errors[0], /services\/api\.ts/);
});

test('a documented variable passes', () => {
  const root = makeRepo({
    'app/mobile/app.config.ts': "process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000'",
    'app/mobile/README.md': '# Mobile\n\nSet EXPO_PUBLIC_API_URL to your backend.\n',
  });
  assert.deepEqual(checkMobileDocs(root).errors, []);
});

test('an undocumented API default is a warning that names the default', () => {
  const root = makeRepo({
    'app/mobile/app.config.ts': "process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:9999'",
    'app/mobile/README.md': '# Mobile\n\nEXPO_PUBLIC_API_URL is documented but its default is not.\n',
  });
  const { warnings } = checkMobileDocs(root);
  assert.ok(warnings.some((w) => /http:\/\/localhost:9999/.test(w)));
});

test('a missing mobile documentation source is reported', () => {
  const root = makeRepo({
    'app/mobile/app.config.ts': "process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000'",
  });
  assert.ok(checkMobileDocs(root).errors.some((e) => /no mobile documentation source/.test(e)));
});

// ── The repository itself ───────────────────────────────────────────────────

test('the OpenAPI document passes the structural check', () => {
  const { errors, summary } = checkOpenApiStructure(REPO_ROOT);
  assert.deepEqual(errors, []);
  assert.ok(summary.operations > 50, 'the document should describe the real API surface');
  assert.equal(summary.undocumented ?? summary.operations > 0, true);
});

test('the backend registers no global route prefix, as the contract map states', () => {
  const { errors, summary } = checkGlobalPrefixInvariant(REPO_ROOT);
  assert.deepEqual(errors, []);
  assert.equal(summary.globalPrefix, false);
});

test('the OpenAPI document declares no undocumented tags or dangling refs', () => {
  const { warnings, errors } = checkOpenApiStructure(REPO_ROOT);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    warnings.filter((w) => /not declared|never referenced/.test(w)),
    [],
  );
});

test('every target can be run independently', () => {
  for (const only of ['openapi', 'contract', 'mobile']) {
    const report = runCheck(REPO_ROOT, { only });
    assert.ok(report.checks[only], `the ${only} target should be present`);
    // Contract drift is expected until the undocumented controllers are
    // documented; the target must still run and report, not crash.
    assert.equal(typeof report.ok, 'boolean');
  }
});
