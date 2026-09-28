/**
 * Shared helpers for the QuickEx dependency gate.
 *
 * Zero dependencies on purpose: the gate must run in CI and on a fresh clone
 * before `pnpm install`, and it must never execute repository or dependency code.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root (…/QiuckEx), derived from this file's location. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

export const PATHS = {
  lockfile: "pnpm-lock.yaml",
  workspace: "pnpm-workspace.yaml",
  rootManifest: "package.json",
  licensePolicy: "docs/policies/data/dependency-license-policy.json",
  licenseDoc: "docs/policies/DEPENDENCY-LICENSE-POLICY.md",
  contractManifest: "app/contract/Cargo.toml",
  cargoLock: "app/contract/Cargo.lock",
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
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .sort();
}

export function unique(values) {
  return [...new Set(values)];
}

/**
 * Dependency provenance, lockfile integrity and license classification —
 * issue #294.
 *
 * The gate reads the manifests and the lockfile as text. It never installs,
 * evaluates or imports dependency code, so it is safe to run on every pull
 * request and it produces the same verdict on an untrusted fork.
 */

/**
 * Dependency specifiers that bypass the registry. These are the provenance
 * risk: they are not covered by the lockfile integrity hashes and are fetched
 * over an arbitrary transport, so the tree is no longer reproducible from
 * `pnpm-lock.yaml` alone.
 */
export const NON_REGISTRY_PROTOCOLS = [
  "git+",
  "git:",
  "github:",
  "bitbucket:",
  "gitlab:",
  "file:",
  "link:",
  "http://",
  "https://",
];

/** Dist-tags that silently float to whatever the registry serves today. */
export const FLOATING_TAGS = ["latest", "next", "canary", "nightly", "beta", "alpha", "dev"];

/**
 * Classify a dependency specifier.
 *
 * Returns one of:
 *   `registry`     – resolved from the npm registry and hashed in the lockfile
 *   `workspace`    – a `workspace:` link to another package in this repo
 *   `non-registry` – git/VCS, file path, or absolute URL (provenance violation)
 *   `floating`     – a dist-tag rather than a semver range
 *   `unpinned`     – `*` or a partial version that accepts any release
 */
export function classifySpecifier(specifier) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    return { kind: "unpinned", reason: "empty specifier" };
  }
  const value = specifier.trim();
  if (value.startsWith("workspace:")) {
    return { kind: "workspace", reason: null };
  }
  const lower = value.toLowerCase();
  const protocol = NON_REGISTRY_PROTOCOLS.find((candidate) => lower.startsWith(candidate));
  if (protocol) {
    return { kind: "non-registry", reason: `uses the "${protocol}" protocol` };
  }
  if (FLOATING_TAGS.includes(lower)) {
    return { kind: "floating", reason: `floats on the "${lower}" dist-tag` };
  }
  if (value === "*" || value === "x" || value.endsWith(".*") || /^\d+\.x$/.test(value)) {
    return { kind: "unpinned", reason: `"${value}" accepts any version` };
  }
  return { kind: "registry", reason: null };
}
