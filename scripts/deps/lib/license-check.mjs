/**
 * License policy enforcement — issue #294.
 *
 * Reads the published policy, validates its own shape, and classifies the
 * licences that can be established without installing anything: the
 * workspace's own manifests and the direct dependency names pinned in the
 * lockfile.
 *
 * Transitive licences are only knowable after an install, so they are checked
 * by the optional `--installed` mode, which reads `node_modules` manifests.
 * That mode is additive: the default gate stays dependency-free and runnable
 * on a fresh clone, while CI runs the full sweep after `pnpm install`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS, fileExists, readText, unique } from "./shared.mjs";
import { parseLockfileImporters } from "./lockfile.mjs";
import {
  classifyLicense,
  loadLicensePolicy,
  missingPolicyMentions,
  validateLicensePolicy,
} from "./licenses.mjs";

/**
 * Direct dependency names from the lockfile importers. These are the packages
 * a contributor actually chose; the transitive closure is `--installed`'s job.
 * Workspace-internal and `@types` packages carry no runtime obligation.
 */
export function directDependencies(root) {
  if (!fileExists(root, PATHS.lockfile)) return [];
  const importers = parseLockfileImporters(readText(root, PATHS.lockfile));
  const found = new Set();
  for (const sections of Object.values(importers)) {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(sections[section] ?? {})) {
        if (name.startsWith("@quickex/") || name.startsWith("@types/")) continue;
        found.add(name);
      }
    }
  }
  return [...found].sort();
}

/** Manifest `license` values read from an installed `node_modules` tree. */
export function installedLicenses(root, maxDepth = 3) {
  const modulesDir = join(root, "node_modules");
  if (!existsSync(modulesDir)) return null;

  const results = new Map();
  const visit = (dir, depth) => {
    if (depth > maxDepth || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".bin" || (entry.name.startsWith(".") && entry.name !== ".pnpm")) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name.startsWith("@")) {
        visit(full, depth);
        continue;
      }
      const manifest = join(full, "package.json");
      if (existsSync(manifest)) {
        try {
          const parsed = JSON.parse(readFileSync(manifest, "utf8"));
          // The workspace's own packages are `private` and never distributed, so
          // their missing `license` field is not a third-party finding.
          if (parsed.private) continue;
          results.set(parsed.name ?? entry.name, parsed.license ?? null);
        } catch {
          // A malformed manifest under node_modules is an install problem, not
          // a policy decision; the install step already fails loudly on it.
        }
      }
      if (entry.isDirectory() && entry.name === ".pnpm") visit(full, depth + 1);
    }
  };

  visit(modulesDir, 0);
  return [...results].map(([name, license]) => ({ name, license }));
}

export function checkLicenses(root, { installed = false } = {}) {
  const errors = [];
  const warnings = [];
  const summary = { direct: 0, installed: 0, denied: 0, review: 0 };

  let policy;
  try {
    policy = loadLicensePolicy(root);
  } catch (error) {
    return {
      errors: [`${PATHS.licensePolicy} could not be read: ${error.message}`],
      warnings,
      summary,
    };
  }

  for (const message of validateLicensePolicy(policy)) {
    errors.push(`${PATHS.licensePolicy}: ${message}`);
  }
  // A malformed policy makes every classification below meaningless, so stop.
  if (errors.length > 0) return { errors, warnings, summary };

  if (!fileExists(root, PATHS.licenseDoc)) {
    errors.push(
      `${PATHS.licenseDoc} is missing; the policy needs a published, reviewable statement.`,
    );
  } else {
    for (const message of missingPolicyMentions(readText(root, PATHS.licenseDoc), policy)) {
      errors.push(`${PATHS.licenseDoc}: ${message}`);
    }
  }

  // The workspace's own licence is the compatibility anchor for everything it
  // links, so it is judged against the same allow-list. A `private` manifest is
  // never distributed, so a missing `license` there is expected, not a finding.
  if (fileExists(root, PATHS.rootManifest)) {
    const manifest = JSON.parse(readText(root, PATHS.rootManifest));
    if (!manifest.license && !manifest.private) {
      warnings.push(
        `${PATHS.rootManifest}: no \`license\` field; add one so consumers know the terms.`,
      );
    } else if (manifest.license && classifyLicense(manifest.license, policy).verdict === "deny") {
      errors.push(`${PATHS.rootManifest}: "${manifest.license}" is denied by ${PATHS.licensePolicy}.`);
    }
  }

  const packages = directDependencies(root);
  summary.direct = unique(packages).length;
  if (packages.length === 0) {
    warnings.push(
      `no direct dependencies could be read from ${PATHS.lockfile}; run this after \`pnpm install\``,
    );
  }

  if (installed) {
    const installedList = installedLicenses(root);
    if (installedList === null) {
      warnings.push(
        "node_modules is absent; run `pnpm install` to enable the transitive license sweep.",
      );
    } else {
      summary.installed = installedList.length;
      for (const { name, license } of installedList) {
        const result = classifyLicense(license, policy, name);
        if (result.verdict === "deny") {
          summary.denied += 1;
          errors.push(
            `${name}: ${result.reason}. Remove it, or record an exception in ${PATHS.licensePolicy}.`,
          );
        } else if (result.verdict === "unknown") {
          errors.push(
            `${name}: ${result.reason}. Record the licence or add an exception in ${PATHS.licensePolicy}.`,
          );
        } else if (result.verdict === "review") {
          summary.review += 1;
          warnings.push(
            `${name}: ${result.reason}. Record an exception in ${PATHS.licensePolicy} to acknowledge it.`,
          );
        }
      }
    }
  }

  return { errors, warnings, summary };
}

