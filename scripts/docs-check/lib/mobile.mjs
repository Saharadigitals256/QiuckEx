/**
 * Mobile documentation coverage - issue #295.
 *
 * The mobile app reads its configuration from `EXPO_PUBLIC_*` variables at
 * runtime. A variable the app reads but the README does not mention is a
 * contributor guessing, and a wrong value fails only on a device - the most
 * expensive place to discover it.
 *
 * This module reads the app config and the services that consume those values
 * as text, so it needs no simulator and no install.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS, fileExists, fromRoot, readText, unique } from "./shared.mjs";

/** Files worth scanning for runtime configuration reads. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js"];

function walk(dir, root, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, root, found);
    else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(absolute);
    }
  }
  return found;
}

/**
 * `EXPO_PUBLIC_*` variables the app actually reads, with the file that reads
 * each one, so a finding can point at the source of the requirement.
 */
export function collectMobileEnvUsage(root) {
  const usage = new Map();
  const files = [
    ...walk(fromRoot(root, "app/mobile"), root),
    ...walk(fromRoot(root, "app/mobile/src"), root),
  ];
  for (const absolute of files) {
    let content;
    try {
      content = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    for (const match of content.matchAll(/\bEXPO_PUBLIC_[A-Z0-9_]+/g)) {
      const name = match[0];
      if (!usage.has(name)) usage.set(name, new Set());
      usage.get(name).add(absolute.replace(`${root}/`, ""));
    }
  }
  return usage;
}

export function checkMobileDocs(root) {
  const errors = [];
  const warnings = [];
  const summary = { variables: 0, documented: 0 };

  const usage = collectMobileEnvUsage(root);
  const names = unique([...usage.keys()]).sort();
  summary.variables = names.length;

  if (names.length === 0) {
    errors.push("no EXPO_PUBLIC_* variables were found in app/mobile; the scan path may be wrong");
    return { errors, warnings, summary };
  }

  // Documentation can live in the mobile README or the root .env.example;
  // a contributor setting up the app looks at both.
  const sources = [PATHS.mobileReadme, ".env.example"].filter((path) => fileExists(root, path));
  if (sources.length === 0) {
    errors.push("no mobile documentation source was found; expected app/mobile/README.md or .env.example");
  }
  const documented = sources.map((path) => ({ path, content: readText(root, path) }));

  for (const name of names) {
    const mentioned = documented.find((source) => source.content.includes(name));
    if (mentioned) {
      summary.documented += 1;
      continue;
    }
    const where = [...usage.get(name)];
    errors.push(
      `${name} is read by ${where.join(", ")} but is documented in none of: ${sources.join(", ")}. A contributor cannot configure the app without knowing this value exists.`,
    );
  }

  // The API base URL is the one value that must be right for anything to work.
  const config = fileExists(root, PATHS.mobileConfig) ? readText(root, PATHS.mobileConfig) : "";
  const apiDefault = config.match(/EXPO_PUBLIC_API_URL\s*\?\?\s*['"]([^'"]+)['"]/)?.[1];
  if (apiDefault) {
    const readme = fileExists(root, PATHS.mobileReadme) ? readText(root, PATHS.mobileReadme) : "";
    // Mentioning the variable is not enough: a contributor still needs to know
    // what it defaults to, or they hit a connection error against nothing.
    if (!readme.includes(apiDefault)) {
      warnings.push(
        `${PATHS.mobileConfig} defaults the API URL to ${apiDefault}, but ${PATHS.mobileReadme} does not mention it. Contributors will hit a connection error without knowing the default.`,
      );
    }
  }

  return { errors, warnings, summary };
}
