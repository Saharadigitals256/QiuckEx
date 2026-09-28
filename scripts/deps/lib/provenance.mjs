/**
 * Dependency provenance: every specifier must come from the npm registry and
 * be version-pinned — issue #294.
 *
 * A `git+`, `github:`, `file:` or absolute-URL specifier is fetched over a
 * transport the lockfile does not hash, so a reviewed tree can be swapped
 * after review. A dist-tag or a wildcard specifier resolves to a version no
 * reviewer has seen. Both fail here; a `workspace:` link is fine because it
 * points at code already in this repository and is reviewable.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PATHS, classifySpecifier, fromRoot, readJson, readText, unique } from "./shared.mjs";

const MANIFEST_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

/** Workspace package globs declared in pnpm-workspace.yaml. */
function parseWorkspaceGlobs(root) {
  const workspacePath = fromRoot(root, PATHS.workspace);
  if (!existsSync(workspacePath)) return [];
  return [...readText(root, PATHS.workspace).matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map(
    (match) => match[1].trim(),
  );
}

/** Every workspace manifest, as repo-relative paths, from the declared globs. */
export function listWorkspaceManifests(root) {
  const manifests = [PATHS.rootManifest];
  for (const glob of parseWorkspaceGlobs(root)) {
    if (!glob.endsWith("/*") && !glob.endsWith("/*/*")) continue;
    const dir = fromRoot(root, glob.replace(/\/\*+$/, ""));
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const manifest = join(glob.replace(/\/?\*+$/, ""), entry.name, "package.json");
      if (existsSync(fromRoot(root, manifest))) manifests.push(manifest);
    }
  }
  return unique(manifests);
}

/**
 * Collect every dependency specifier in the workspace, as
 * `{ manifest, section, name, specifier }`.
 */
export function collectSpecifiers(root) {
  const found = [];
  for (const manifest of listWorkspaceManifests(root)) {
    const parsed = readJson(root, manifest);
    for (const section of MANIFEST_SECTIONS) {
      for (const [name, specifier] of Object.entries(parsed[section] ?? {})) {
        found.push({ manifest, section, name, specifier });
      }
    }
  }
  return found;
}

export function checkProvenance(root) {
  const errors = [];
  const warnings = [];
  const summary = { manifests: 0, registry: 0, workspace: 0 };

  for (const entry of collectSpecifiers(root)) {
    summary.manifests += 1;
    const { kind, reason } = classifySpecifier(entry.specifier);
    const where = `${entry.manifest}: ${entry.name} (${entry.specifier})`;

    if (kind === "non-registry") {
      errors.push(
        `${where}: ${reason}. Publish the package to the npm registry, or vendor the source into this repository so it is reviewed with the tree.`,
      );
    } else if (kind === "floating" || kind === "unpinned") {
      errors.push(`${where}: ${reason}. Pin an exact or caret range so a reviewer sees the resolved version.`);
    } else if (kind === "workspace") {
      summary.workspace += 1;
    } else {
      summary.registry += 1;
    }
  }

  // A floating tag in the lockfile itself is the same provenance risk arriving
  // through the generated file rather than the manifest.
  if (existsSync(fromRoot(root, PATHS.lockfile))) {
    const lockfileText = readText(root, PATHS.lockfile);
    for (const match of lockfileText.matchAll(/specifier:\s*(git\+|github:|gitlab:|bitbucket:|file:|link:|https?:\/\/)[^\n]*/g)) {
      errors.push(
        `${PATHS.lockfile}: importer specifier "${match[0].trim()}" bypasses the registry and is not content-hashed`,
      );
    }
  }

  if (summary.manifests === 0) {
    errors.push("no workspace package.json files were found; provenance could not be verified");
  }

  return { errors, warnings, summary };
}
