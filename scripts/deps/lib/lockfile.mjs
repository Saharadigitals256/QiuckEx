/**
 * pnpm lockfile integrity and manifest/lockfile agreement — issue #294.
 *
 * The lockfile is a generated artefact, so its indentation is a stable
 * contract. Only the structure the gate needs is parsed (importers, package
 * resolution hashes), which keeps the gate dependency-free.
 */

/** Strip the single or double quotes pnpm uses around scoped/keyed names. */
function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Extract the top-level `importers:` block of a pnpm v9 lockfile as
 * `importer -> section -> dependency -> specifier`.
 *
 * Throws when the block is absent, which is itself an integrity failure: a
 * lockfile without importers cannot pin a workspace tree.
 */
export function parseLockfileImporters(text) {
  const lines = text.split("\n");
  const importersStart = lines.findIndex((line) => line === "importers:");
  if (importersStart === -1) {
    throw new Error("pnpm-lock.yaml has no top-level `importers:` section");
  }

  const importers = {};
  let importer = null;
  let section = null;
  let dependency = null;

  for (const line of lines.slice(importersStart + 1)) {
    // A new top-level key ends the importers block.
    if (/^[a-zA-Z]/.test(line)) break;
    if (line.trim() === "") continue;

    const importerMatch = line.match(/^ {2}(\S.*):\s*$/);
    if (importerMatch) {
      importer = unquote(importerMatch[1]);
      importers[importer] = { dependencies: {}, devDependencies: {}, optionalDependencies: {} };
      section = null;
      dependency = null;
      continue;
    }

    const sectionMatch = line.match(
      /^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/,
    );
    if (sectionMatch) {
      section = sectionMatch[1];
      dependency = null;
      continue;
    }

    const dependencyMatch = line.match(/^ {6}(\S.*?):\s*$/);
    if (dependencyMatch) {
      dependency = unquote(dependencyMatch[1]);
      continue;
    }

    const specifierMatch = line.match(/^ {8}specifier:\s*(.*?)\s*$/);
    if (specifierMatch && importer && section && dependency) {
      importers[importer][section][dependency] = unquote(specifierMatch[1]);
      dependency = null;
    }
  }

  return importers;
}

/**
 * Count content hashes in the lockfile `packages:` block.
 *
 * Lockfile integrity means every resolved package carries a sha integrity
 * value, so a tampered or intercepted tarball cannot be substituted for the
 * reviewed one. Entries resolved from a directory or a git revision have no
 * tarball hash; those are legitimate only for `link:`/`injected` entries and
 * are reported so a reviewer can confirm each one.
 */
export function auditLockfileIntegrity(text) {
  const lines = text.split("\n");
  const packagesStart = lines.findIndex((line) => line === "packages:");
  if (packagesStart === -1) {
    throw new Error("pnpm-lock.yaml has no top-level `packages:` section");
  }

  let total = 0;
  let hashed = 0;
  const unhashed = [];
  let current = null;

  for (const line of lines.slice(packagesStart + 1)) {
    if (/^[a-zA-Z]/.test(line)) break;

    const entryMatch = line.match(/^ {2}(\S.*?):\s*$/);
    if (entryMatch) {
      current = unquote(entryMatch[1]);
      total += 1;
      continue;
    }

    if (/^ {4}resolution:/.test(line)) {
      if (/integrity:/.test(line)) {
        hashed += 1;
      } else if (current) {
        unhashed.push(current);
      }
    }
  }

  return { total, hashed, unhashed };
}

/** Read the `lockfileVersion` scalar, used to detect an unsupported format. */
export function readLockfileVersion(text) {
  const match = text.match(/^lockfileVersion:\s*'?([^'\n]+?)'?\s*$/m);
  return match ? match[1] : null;
}
