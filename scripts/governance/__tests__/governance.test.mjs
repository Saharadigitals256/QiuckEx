import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAdr, parseAdrIndex, validateAdrSet } from '../lib/adr.mjs';
import { applyDecision, evaluateAssetListing, parseSeedCodes, validateAssetListingPolicy } from '../lib/assets.mjs';
import { effectiveMethod, planSweep, validateRetentionSchedule } from '../lib/retention.mjs';
import { analyzeSurface, extractCatalogs, extractSwitcherLocales, validateI18n } from '../lib/i18n.mjs';
import { REPO_ROOT, readText, missingSections } from '../lib/shared.mjs';
import { GOVERNANCE_DOC_SECTIONS, runCheck } from '../check.mjs';

const ADR_TEMPLATE = `# ADR-0001: Example title

## Status

Accepted

## Context

ctx

## Decision

decision

## Consequences

cons

## Reversal Cost

HIGH

## Invariants Affected

- INV-01

## References

- none
`;

test('the repository passes the full governance gate', () => {
  const report = runCheck(REPO_ROOT);
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
});

test('governance hub declares the required sections', () => {
  const doc = readText(REPO_ROOT, 'docs/GOVERNANCE.md');
  assert.deepEqual(missingSections(doc, GOVERNANCE_DOC_SECTIONS), []);
});

test('ADR parsing accepts a well-formed record', () => {
  const adr = parseAdr('0001-example-title.md', ADR_TEMPLATE);
  assert.equal(adr.number, '0001');
  assert.equal(adr.status, 'Accepted');
  assert.equal(adr.supersededBy, null);
  assert.equal(adr.sections.length, 7);
});

test('ADR parsing rejects a missing section', () => {
  const broken = ADR_TEMPLATE.replace('## Reversal Cost\n\nHIGH\n\n', '');
  assert.throws(() => parseAdr('0001-example-title.md', broken), /missing required section/);
});

test('ADR parsing rejects an out-of-order section list', () => {
  const reordered = ADR_TEMPLATE.replace('## Decision\n\ndecision\n', '').replace('## Consequences\n\ncons\n', '## Decision\n\ndecision\n');
  assert.throws(() => parseAdr('0001-example-title.md', reordered), /out of order|missing required/);
});

test('ADR parsing rejects an invalid status', () => {
  const badStatus = ADR_TEMPLATE.replace('Accepted', 'In Progress');
  assert.throws(() => parseAdr('0001-example-title.md', badStatus), /invalid status/);
});

test('ADR set validation catches an index that disagrees with the document', () => {
  const adr = parseAdr('0001-example-title.md', ADR_TEMPLATE);
  const index = `| [ADR-0001](./0001-example-title.md) | Different title | Proposed |\n`;
  const result = validateAdrSet({ adrs: [adr], parseErrors: [], indexContent: index });
  assert.ok(result.errors.some((message) => message.includes('index title')));
  assert.ok(result.errors.some((message) => message.includes('index status')));
});

test('ADR set validation catches an index row with no file', () => {
  const index = `| [ADR-0007](./0007-ghost.md) | Ghost | Accepted |\n`;
  const result = validateAdrSet({ adrs: [], parseErrors: [], indexContent: index });
  assert.ok(result.errors.some((message) => message.includes('no matching file')));
});

test('index rows and ADR filenames follow the numbering convention', () => {
  const index = parseAdrIndex(readText(REPO_ROOT, 'docs/adr/README.md'));
  assert.ok(index.length >= 6, 'expected the six published ADRs in the index');
  for (const row of index) {
    assert.match(row.link, /^\.\/\d{4}-[a-z0-9-]+\.md$/);
    assert.equal(row.status, 'Accepted');
  }
});

test('asset seed migration and policy tier map stay aligned', () => {
  const migration = readText(
    REPO_ROOT,
    'app/backend/supabase/migrations/20260526000000_create_verified_assets.sql',
  );
  const codes = parseSeedCodes(migration);
  assert.deepEqual(codes, ['AQUA', 'USDC', 'XLM', 'yXLM']);
  const policy = JSON.parse(readText(REPO_ROOT, 'docs/policies/data/asset-listing-policy.json'));
  for (const code of codes) {
    assert.ok(policy.tiers[code], `seeded asset ${code} must declare a tier`);
  }
});

test('asset listing policy validation flags a seeded asset with no tier', () => {
  const policy = JSON.parse(readText(REPO_ROOT, 'docs/policies/data/asset-listing-policy.json'));
  const copy = structuredClone(policy);
  delete copy.tiers.USDC;
  const result = validateAssetListingPolicy(copy, { seedCodes: ['USDC'], docContent: '' });
  assert.ok(result.errors.some((message) => message.includes('"USDC" has no tier assignment')));
});

test('asset listing policy validation requires mainnet gating to be declared', () => {
  const policy = JSON.parse(readText(REPO_ROOT, 'docs/policies/data/asset-listing-policy.json'));
  const copy = structuredClone(policy);
  copy.featureFlags.defaultDisabledNetworks = [];
  const result = validateAssetListingPolicy(copy, { docContent: '' });
  assert.ok(result.errors.some((message) => message.includes('mainnet')));
});

test('asset evaluation degrades at the evidence expiry boundary', () => {
  const policy = JSON.parse(readText(REPO_ROOT, 'docs/policies/data/asset-listing-policy.json'));
  const now = Date.parse('2026-09-25T00:00:00.000Z');
  const record = {
    key: 'USDC:GA5',
    code: 'USDC',
    issuer: 'GA5',
    type: 'credit_alphanum4',
    status: 'listed',
  };
  const evidence = Object.keys(policy.evidence).map((kind) => ({
    kind,
    expiresAt: new Date(now).toISOString(),
  }));
  const evaluation = evaluateAssetListing({ policy, record, evidence, now });
  assert.equal(evaluation.status, 'suspended');
  assert.equal(evaluation.served, false);
});

test('asset decision engine enforces cooling-off before re-listing', () => {
  const policy = JSON.parse(readText(REPO_ROOT, 'docs/policies/data/asset-listing-policy.json'));
  const now = Date.parse('2026-09-25T00:00:00.000Z');
  const record = {
    key: 'USDC:GA5',
    code: 'USDC',
    issuer: 'GA5',
    type: 'credit_alphanum4',
    status: 'delisted',
    delistedAt: new Date(now - 86_400_000).toISOString(),
  };
  const early = applyDecision({ policy, record, action: 'list', now });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'ASSET_LISTING_COOLING_OFF_ACTIVE');

  const late = applyDecision({
    policy,
    record: { ...record, delistedAt: new Date(now - 31 * 86_400_000).toISOString() },
    action: 'list',
    evidence: [],
    now,
  });
  // Cooling-off has elapsed, but no evidence was supplied.
  assert.equal(late.ok, false);
  assert.equal(late.code, 'ASSET_LISTING_EVIDENCE_INCOMPLETE');
});

test('retention schedule validation passes on the published schedule', () => {
  const schedule = JSON.parse(readText(REPO_ROOT, 'docs/policies/data/retention-schedule.json'));
  const doc = readText(REPO_ROOT, 'docs/policies/DATA-RETENTION-PRIVACY-POLICY.md');
  const mirror = readText(REPO_ROOT, 'app/backend/src/privacy/retention/retention-schedule.ts');
  const result = validateRetentionSchedule(schedule, { docContent: doc, mirrorContent: mirror });
  assert.deepEqual(result.errors, []);
});

test('retention hold rules degrade hard_delete and block non-holdable categories', () => {
  const held = effectiveMethod('hard_delete', {
    holdable: true,
    activeHolds: ['legal_obligation'],
  });
  assert.equal(held.method, 'pseudonymize');
  const blocked = effectiveMethod('hard_delete', {
    holdable: false,
    activeHolds: ['legal_obligation'],
  });
  assert.equal(blocked.method, 'retain');
  const unchanged = effectiveMethod('hard_delete', { holdable: true, activeHolds: [] });
  assert.equal(unchanged.method, 'hard_delete');
});

test('sweep planning respects windows, holds, and the batch size', () => {
  const schedule = JSON.parse(readText(REPO_ROOT, 'docs/policies/data/retention-schedule.json'));
  const now = Date.parse('2026-09-25T00:00:00.000Z');
  const old = new Date(now - 400 * 86_400_000).toISOString();
  const fresh = new Date(now - 1000).toISOString();
  const plan = planSweep({
    schedule,
    now,
    batchSize: 2,
    records: {
      notifications: [
        { id: 'n1', windowStart: old },
        { id: 'n2', windowStart: old },
        { id: 'n3', windowStart: old },
        { id: 'n4', windowStart: fresh },
      ],
      contract_registry_history: [{ id: 'c1', windowStart: old }],
      onchain_escrow_state: [{ id: 'o1', windowStart: old }],
    },
  });

  const notifications = plan.plan.find((entry) => entry.category === 'notifications');
  assert.equal(notifications.due, 3);
  assert.equal(notifications.ids.length, 2, 'batch size must cap the plan');
  assert.ok(plan.skipped.some((entry) => entry.reason === 'indefinite_retention'));
  assert.equal(
    plan.skipped.filter((entry) => entry.reason === 'indefinite_retention').length,
    2,
    'contract registry history and on-chain state must never be swept',
  );
  assert.equal(plan.totals.due, 3, 'indefinite categories never become due');
});

test('i18n catalogs are extracted from both client surfaces', () => {
  const frontend = extractCatalogs(readText(REPO_ROOT, 'app/frontend/src/lib/i18n.ts'));
  const mobile = extractCatalogs(readText(REPO_ROOT, 'app/mobile/src/lib/i18n.ts'));
  assert.deepEqual(Object.keys(frontend).sort(), ['en', 'es', 'fr']);
  assert.deepEqual(Object.keys(mobile).sort(), ['en', 'es', 'fr']);
  assert.ok(frontend.en.length > 100, 'frontend en catalog should be substantial');
  assert.ok(mobile.en.length > 50, 'mobile en catalog should be substantial');

  const switcher = extractSwitcherLocales(
    readText(REPO_ROOT, 'app/frontend/src/components/LocaleSwitcher.tsx'),
  );
  assert.deepEqual(switcher, ['en', 'es', 'fr']);
});

test('i18n validation reports missing keys that are not baselined', () => {
  const synthetic = `
    resources: {
      en: { translation: { alpha: 'a', beta: 'b' } },
      fr: { translation: { alpha: 'a' } },
    }
  `;
  const switcher = `<option value="en">English</option><option value="fr">Français</option>`;
  const surface = analyzeSurface({
    name: 'synthetic',
    i18nSource: synthetic,
    switcherSource: switcher,
  });
  assert.deepEqual(surface.missingKeys.fr, ['beta']);
  assert.deepEqual(surface.declaredLocalesWithoutCatalog, []);

  // Against the committed baseline the real surfaces must produce no errors.
  const result = validateI18n(REPO_ROOT, {
    docContent: readText(REPO_ROOT, 'docs/policies/ACCESSIBILITY-LOCALIZATION-STANDARD.md'),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.length, 2, 'both surfaces are analysed');
});


