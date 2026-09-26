/**
 * Lockfile integrity and manifest/lockfile agreement — issue #294.
 *
 * Two properties are enforced:
 *
 *  1. **Integrity** — the lockfile must be present, be a version this gate
 *     understands, and carry a content hash for every resolved package. A
 *     missing lockfile or an unhashed tarball means the installed tree is not
 *     reproducible from what was reviewed.
 *  2. **Agreement** — every importer in the lockfile must correspond to a
 *     workspace `package.json`, and every direct dependency in a manifest must
 *     appear in the lockfile importer with the same specifier. Drift here is
 *     the signature of a manifest edited without regenerating the lockfile,
 *     which would make a later `--frozen-lockfile` install fail at deploy time
 *     rather than in review.
 */
import { existsSync } from "node:fs";
import {
  PATHS,
  fromRoot,
  readJson,
  readText,
} from "./shared.mjs";
import { auditLockfileIntegrity, parseLockfileImporters, readLockfileVersion } from "./lockfile.mjs";
import { listWorkspaceManifests } from "./provenance.mjs";

export const SUPPORTED_LOCKFILE_VERSIONS = ["9.0"];

const MANIFEST_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

/** Repo-relative manifest path -> the importer key pnpm records for it. */
function importerKeyFor(manifestPath) {
  return manifestPath === PATHS.rootManifest ? "." : manifestPath.replace(/\/package\.json$/, "");
}

export function checkLockfile(root) {
  const errors = [];
  const warnings = [];
  const summary = { total: 0, hashed: 0, importers: 0 };

  if (!existsSync(fromRoot(root, PATHS.lockfile))) {
    errors.push(
      `${PATHS.lockfile} is missing. Commit the lockfile so installs are reproducible and content-hashed.`,
    );
    return { errors, warnings, summary };
  }

  const text = readText(root, PATHS.lockfile);
  const version = readLockfileVersion(text);
  if (!version) {
    errors.push(`${PATHS.lockfile}: no \`lockfileVersion\` header; regenerate with pnpm 10`);
  } else if (!SUPPORTED_LOCKFILE_VERSIONS.includes(version)) {
    errors.push(
      `${PATHS.lockfile}: lockfileVersion ${version} is not supported (expected ${SUPPORTED_LOCKFILE_VERSIONS.join(", ")}); upgrade pnpm or update the gate.`,
    );
  }

  // ── Integrity ────────────────────────────────────────────────────────────
  let integrity;
  try {
    integrity = auditLockfileIntegrity(text);
  } catch (error) {
    errors.push(`${PATHS.lockfile}: ${error.message}`);
    return { errors, warnings, summary };
  }
  summary.total = integrity.total;
  summary.hashed = integrity.hashed;

  if (integrity.total === 0) {
    errors.push(`${PATHS.lockfile}: no resolved packages; the lockfile does not pin the tree`);
  }
  for (const entry of integrity.unhashed) {
    warnings.push(
      `${PATHS.lockfile}: "${entry}" has no content hash. Confirm it is an in-repo workspace link and not a fetched tarball.`,
    );
  }

  // ── Agreement ────────────────────────────────────────────────────────────
  let importers;
  try {
    importers = parseLockfileImporters(text);
  } catch (error) {
    errors.push(`${PATHS.lockfile}: ${error.message}`);
    return { errors, warnings, summary };
  }

  const manifests = listWorkspaceManifests(root);
  const manifestImporters = new Set(manifests.map(importerKeyFor));

  for (const importer of Object.keys(importers)) {
    summary.importers += 1;
    if (!manifestImporters.has(importer)) {
      errors.push(
        `${PATHS.lockfile}: importer "${importer}" has no matching package.json. Regenerate the lockfile with \`pnpm install\`.`,
      );
    }
  }
  for (const key of manifestImporters) {
    if (!(key in importers)) {
      errors.push(
        `${PATHS.lockfile}: no importer entry for "${key}". Run \`pnpm install\` and commit the updated lockfile.`,
      );
    }
  }

  for (const manifest of manifests) {
    const importer = importers[importerKeyFor(manifest)];
    if (!importer) continue;
    const parsed = readJson(root, manifest);

    for (const section of MANIFEST_SECTIONS) {
      for (const [name, specifier] of Object.entries(parsed[section] ?? {})) {
        const locked = importer[section]?.[name];
        if (locked === undefined) {
          // pnpm records optionalDependencies under their own section only
          // when they resolve; a missing entry is reported, not ignored.
          errors.push(
            `${manifest}: "${name}" is declared but absent from the ${PATHS.lockfile} importer "${importerKeyFor(manifest)}". Run \`pnpm install\`.`,
          );
        } else if (locked !== specifier) {
          errors.push(
            `${manifest}: "${name}" is ${JSON.stringify(specifier)} but the lockfile pins ${JSON.stringify(locked)}. Run \`pnpm install\` and commit the lockfile.`,
          );
        }
      }
    }
  }

  return { errors, warnings, summary };
}
