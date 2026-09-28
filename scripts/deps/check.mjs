#!/usr/bin/env node
/**
 * QuickEx dependency gate: provenance, lockfile integrity, license policy.
 *
 * Issue #294. Validates that the dependency tree is (a) sourced only from the
 * npm registry, (b) fully content-hashed and in agreement with the committed
 * manifests, and (c) licensed under the published policy.
 *
 * Zero dependencies, no network access, and it never installs or imports
 * dependency code, so it runs on a fresh clone before `pnpm install` and gives
 * the same verdict on an untrusted fork.
 *
 * Usage:
 *   node scripts/deps/check.mjs                    # all checks
 *   node scripts/deps/check.mjs --only provenance  # provenance|lockfile|license
 *   node scripts/deps/check.mjs --json             # machine-readable report
 *
 * Exit codes: 0 = no errors, 1 = errors, 2 = usage error.
 */
import { REPO_ROOT, PATHS, fileExists, fromRoot } from "./lib/shared.mjs";
import { checkProvenance } from "./lib/provenance.mjs";
import { checkLockfile } from "./lib/lockfile-check.mjs";
import { checkLicenses } from "./lib/license-check.mjs";

export function runCheck(root = REPO_ROOT, { only = "all", installed = false } = {}) {
  const checks = {};

  if (only === "all" || only === "provenance") {
    checks.provenance = checkProvenance(root);
  }
  if (only === "all" || only === "lockfile") {
    checks.lockfile = checkLockfile(root);
  }
  if (only === "all" || only === "license") {
    checks.licenses = checkLicenses(root, { installed });
  }

  const errors = Object.entries(checks).flatMap(([name, result]) =>
    result.errors.map((message) => `[${name}] ${message}`),
  );
  const warnings = Object.entries(checks).flatMap(([name, result]) =>
    result.warnings.map((message) => `[${name}] ${message}`),
  );

  return { checks, errors, warnings, ok: errors.length === 0 };
}

const VALID_TARGETS = ["all", "provenance", "lockfile", "license"];

function parseArgs(argv) {
  const options = { only: "all", json: false, quiet: false, installed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--only") {
      options.only = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--installed") {
      options.installed = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      options.unknown = arg;
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(
      `usage: node scripts/deps/check.mjs [--only ${VALID_TARGETS.join("|")}] [--installed] [--json] [--quiet]\n`,
    );
    return 0;
  }
  if (options.unknown || !VALID_TARGETS.includes(options.only)) {
    process.stderr.write(`unknown argument or target: ${options.unknown ?? options.only}\n`);
    return 2;
  }

  const report = runCheck(REPO_ROOT, { only: options.only, installed: options.installed });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const [name, result] of Object.entries(report.checks)) {
      const state = result.errors.length === 0 ? "PASS" : "FAIL";
      process.stdout.write(
        `${state} ${name}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)\n`,
      );
      for (const message of result.errors) process.stdout.write(`  ✗ ${message}\n`);
      if (!options.quiet) {
        for (const message of result.warnings) process.stdout.write(`  ! ${message}\n`);
      }
    }
    process.stdout.write(
      report.ok
        ? "\ndependency gate: PASS\n"
        : `\ndependency gate: FAIL (${report.errors.length} error(s))\n`,
    );
  }

  return report.ok ? 0 : 1;
}

const isEntryPoint =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");

if (isEntryPoint) {
  process.exitCode = main();
}
