/**
 * Shared helpers for the QuickEx governance gate.
 *
 * Zero dependencies on purpose: the gate must run in CI and on a fresh clone
 * before `pnpm install`, and it must never execute repository code.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root (…/QiuckEx), derived from this file's location. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

export const PATHS = {
  adrDir: "docs/adr",
  governanceDoc: "docs/GOVERNANCE.md",
  assetListingDoc: "docs/policies/ASSET-LISTING-POLICY.md",
  assetListingPolicy: "docs/policies/data/asset-listing-policy.json",
  assetListingMirror: "app/backend/src/asset-listing/asset-listing.policy.ts",
  retentionDoc: "docs/policies/DATA-RETENTION-PRIVACY-POLICY.md",
  retentionSchedule: "docs/policies/data/retention-schedule.json",
  retentionMirror: "app/backend/src/privacy/retention/retention-schedule.ts",
  a11yDoc: "docs/policies/ACCESSIBILITY-LOCALIZATION-STANDARD.md",
  a11yBaseline: "docs/policies/data/a11y-i18n-baseline.json",
  verifiedAssetsMigration:
    "app/backend/supabase/migrations/20260526000000_create_verified_assets.sql",
  frontendI18n: "app/frontend/src/lib/i18n.ts",
  frontendSwitcher: "app/frontend/src/components/LocaleSwitcher.tsx",
  mobileI18n: "app/mobile/src/lib/i18n.ts",
  mobileSwitcher: "app/mobile/components/LocaleSwitcher.tsx",
};

export function fromRoot(root, relative) {
  return join(root, relative);
}

export function readText(root, relative) {
  return readFileSync(fromRoot(root, relative), "utf8");
}

export function readJson(root, relative) {
  return JSON.parse(readText(root, relative));
}

export function fileExists(root, relative) {
  return existsSync(fromRoot(root, relative));
}

export function listFiles(root, relativeDir) {
  const dir = fromRoot(root, relativeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
}

/** Extract every level-2 heading (`## X`) from markdown, normalised. */
export function headings(markdown) {
  return markdown
    .split("\n")
    .map((line) => line.match(/^##\s+(.*?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1].trim());
}

/**
 * Verify that a markdown document contains the given `##` sections (matched by
 * their leading identifier, e.g. "5." or the full heading text).
 */
export function missingSections(markdown, required) {
  const found = headings(markdown);
  return required.filter((required_) => {
    return !found.some(
      (heading) =>
        heading === required_ ||
        heading.startsWith(required_) ||
        heading.replace(/^[0-9]+\.\s*/, "") ===
          required_.replace(/^[0-9]+\.\s*/, ""),
    );
  });
}

/** Report tokens (literal strings) that a document fails to mention. */
export function missingMentions(markdown, tokens) {
  return tokens.filter((token) => !markdown.includes(token));
}

export function unique(values) {
  return [...new Set(values)];
}

/** Duplicate values in an array, order-preserving. */
export function duplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}
