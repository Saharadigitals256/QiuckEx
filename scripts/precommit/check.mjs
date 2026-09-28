#!/usr/bin/env node
/**
 * QuickEx pre-commit validation: secrets, generated artifacts, formatting.
 *
 * Issue #297. Runs over the files a commit is about to add, so a problem is
 * caught before it lands in history — where removing it is far more expensive.
 *
 * It is dependency-free and offline so it can run as a `pre-commit` hook, in
 * CI, and in the devcontainer, with no install step. It reads files as text and
 * never executes repository or dependency code.
 *
 * Usage:
 *   node scripts/precommit/check.mjs                 # staged files (git diff --cached)
 *   node scripts/precommit/check.mjs --all           # every tracked file
 *   node scripts/precommit/check.mjs --files a.ts b.md
 *   node scripts/precommit/check.mjs --json          # machine-readable report
 *
 * Exit codes: 0 = clean, 1 = errors, 2 = usage error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const ALLOWLIST_PATH = "scripts/precommit/allowlist.txt";

/**
 * Files that must never be committed.
 *
 * `secrets` are values that grant access; `artifacts` are build output that
 * belongs in a cache, not in history. Both are checked by path pattern so the
 * rule holds regardless of what the file's contents look like.
 */
export const FORBIDDEN_PATHS = [
  // ── Secrets ──────────────────────────────────────────────────────────────
  { pattern: /(^|\/)\.env(\.(local|development|production|staging|test))?$/, reason: "a populated .env file — copy .env.example instead" },
  { pattern: /(^|\/)\.npmrc$/, reason: "an .npmrc may carry an auth token" },
  { pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, reason: "a private key" },
  { pattern: /(^|\/)[^/]+\.(pem|key|pkcs12|p12|jks|keystore|truststore)$/i, reason: "a private key or keystore" },
  { pattern: /(^|\/)\.netrc$/, reason: "stored network credentials" },
  { pattern: /(^|\/)\.pgpass$/, reason: "stored Postgres credentials" },
  { pattern: /(^|\/)\.aws\/credentials$/, reason: "AWS credentials" },
  { pattern: /(^|\/)service-account.*\.json$/, reason: "a GCP service-account key" },

  // ── Generated artifacts ──────────────────────────────────────────────────
  { pattern: /(^|\/)node_modules\//, reason: "installed dependencies — reproducible from the lockfile" },
  { pattern: /(^|\/)\.turbo\//, reason: "a Turbo build cache — regenerated on every build" },
  { pattern: /(^|\/)dist\//, reason: "build output — regenerate with the build script" },
  { pattern: /(^|\/)build\//, reason: "build output — regenerate with the build script" },
  { pattern: /(^|\/)coverage\//, reason: "a coverage report — a CI artifact, not source" },
  { pattern: /(^|\/)\.next\//, reason: "a Next.js build cache" },
  { pattern: /(^|\/)target\/debug\//, reason: "Rust debug build output" },
  { pattern: /(^|\/)target\/release\//, reason: "Rust release build output" },
  { pattern: /\.log(\.\d+)?$/, reason: "a log file" },
  { pattern: /(^|\/)stryker-tmp\//, reason: "a mutation-testing temp directory" },
  { pattern: /^\.turbo\/daemon\//, reason: "a Turbo daemon log" },
];

/**
 * Content patterns that indicate a committed secret.
 *
 * Deliberately high-signal rather than exhaustive: `detect-secrets` and
 * `gitleaks` already run in the pre-commit config and in CI. These catch the
 * shapes most likely to slip through — a Stellar secret key and a Supabase
 * service-role JWT — in *any* file type, including ones the other scanners
 * exclude.
 */
export const SECRET_CONTENT_PATTERNS = [
  { name: "Stellar secret key (S…)", pattern: /\bS[A-Z2-7]{55}\b/ },
  { name: "Supabase service-role JWT", pattern: /\beyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { name: "PEM private key block", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: "GitHub personal access token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

/** Paths whose contents are never scanned, to avoid meaningless false positives. */
export const SCAN_EXCLUDES = [
  /pnpm-lock\.yaml$/,
  /package-lock\.json$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.turbo\//,
  /(^|\/)\.git\//,
  /\.secrets\.baseline$/,
  /gitleaks\.toml$/,
  // The policy and the scanner configs name the patterns they look for, so
  // reading them as data would flag the rules themselves.
  /scripts\/precommit\//,
  /scripts\/local-dev\//,
];

/** Only these extensions are checked for whitespace hygiene. */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml",
  ".sql", ".sh", ".toml", ".rs", ".css", ".scss", ".html", ".env", ".txt", ".prisma",
]);

/**
 * Reviewed exceptions, one per line: `<glob> | <reason>`.
 *
 * The same discipline as `.secrets.baseline`: an allowlist entry is a decision
 * someone made and a reviewer can see, never a way to silence a finding quietly.
 * A bare path is treated as an exact match; a `*` enables simple globbing.
 */
export function parseAllowlist(content) {
  const entries = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [path, ...rest] = line.split("|");
    const reason = rest.join("|").trim();
    if (!path.trim()) continue;
    entries.push({ pattern: path.trim(), reason: reason || "no justification given" });
  }
  return entries;
}

function globToRegExp(glob) {
    // `*` matches within one path segment only, so `docs/*.png` does not silently
  // allow `docs/nested/a.png`. A `**` crosses segments.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function isAllowlisted(filePath, allowlist) {
  return allowlist.some((entry) => globToRegExp(entry.pattern).test(filePath));
}


export function isBinary(buffer) {
  // A NUL byte in the first block is the standard heuristic.
  return buffer.subarray(0, 8000).includes(0);
}


/** Which forbidden-path rule, if any, a file matches. */
export function classifyForbiddenPath(filePath) {
  const normalized = filePath.replace(/^\.\//, "");
  for (const { pattern, reason } of FORBIDDEN_PATHS) {
    if (pattern.test(normalized)) return { reason, pattern: String(pattern) };
  }
  return null;
}

export function shouldScanContents(filePath) {
  return !SCAN_EXCLUDES.some((pattern) => pattern.test(filePath));
}

function readIfPresent(root, filePath) {
  try {
    return readFileSync(join(root, filePath));
  } catch {
    // Deleted in the working tree, or unreadable; nothing to check.
    return null;
  }
}

function checkForbiddenPaths(root, files) {
  const errors = [];
  for (const file of files) {
    const hit = classifyForbiddenPath(file);
    if (hit) {
      errors.push({
        file,
        rule: "generated-artifact",
        message: `${file} must not be committed: it is ${hit.reason}.`,
      });
    }
  }
  return { errors, warnings: [], summary: { files: files.length } };
}

function checkSecrets(root, files) {
  const errors = [];
  let scanned = 0;
  for (const file of files) {
    if (!shouldScanContents(file)) continue;
    const buffer = readIfPresent(root, file);
    if (!buffer || isBinary(buffer)) continue;
    scanned += 1;
    const text = buffer.toString("utf8");
    for (const { name, pattern } of SECRET_CONTENT_PATTERNS) {
      // The match itself is never echoed: reporting the value would copy the
      // secret into CI logs, which is the exact leak this rule prevents.
      if (pattern.test(text)) {
        errors.push({
          file,
          rule: "secret",
          message: `${file} appears to contain a ${name}. Revoke it, then remove it from this commit.`,
        });
      }
    }
  }
  return { errors, warnings: [], summary: { scanned } };
}

/**
 * Formatting problems in one file's contents, as messages.
 *
 * Extracted so the same rules can be applied to the working tree and to the
 * committed version of a file, which is what the ratchet compares.
 */
export function findFormattingIssues(filePath, buffer) {
  if (isBinary(buffer)) return [];
  const dot = filePath.lastIndexOf(".");
  const extension = dot === -1 ? "" : filePath.slice(dot);
  // Whitespace rules apply to text we actually format; binaries and images
  // legitimately end without a newline.
  if (!TEXT_EXTENSIONS.has(extension) && !filePath.endsWith("Dockerfile")) return [];

  const text = buffer.toString("utf8");
  const issues = [];
  if (text.length === 0) return issues;

  if (!text.endsWith("\n")) issues.push(`${filePath} does not end with a newline.`);
  if (text.endsWith("\n\n")) issues.push(`${filePath} ends with a blank line.`);
  // CRLF line endings produce noisy diffs and break shell scripts on Linux.
  if (text.includes("\r\n")) issues.push(`${filePath} contains CRLF line endings; use LF.`);
  // Two trailing spaces are a Markdown line break, so markdown is exempt.
  if (!filePath.endsWith(".md")) {
    const index = text.split("\n").findIndex((line) => /[ \t]+$/.test(line));
    if (index !== -1) {
      issues.push(`${filePath} has trailing whitespace on line ${index + 1}.`);
    }
  }
  return issues;
}

function checkFormatting(root, files, waived = new Map()) {
  const errors = [];
  let checked = 0;
  for (const file of files) {
    const buffer = readIfPresent(root, file);
    if (!buffer) continue;
    const issues = findFormattingIssues(file, buffer);
    // An empty result means either "clean" or "not a text file we format"; the
    // two are told apart by asking whether the rules applied at all.
    if (issues.length > 0) checked += 1;
    const previous = waived.get(file) ?? new Set();
    for (const message of issues) {
      // A finding that already existed in HEAD is reported as waived, not as
      // this commit's problem.
      if (previous.has(message.replace(/line \d+/, "line N"))) continue;
      errors.push({ file, rule: "formatting", message });
    }
  }
  return { errors, warnings: [], summary: { checked } };
}

function checkLargeFiles(root, files, limitKb) {
  const errors = [];
  let oversized = 0;
  for (const file of files) {
    // Lockfiles and vendored inputs are legitimately large; the size rule
    // exists to stop a binary blob landing in history, not to police those.
    if (!shouldScanContents(file)) continue;
    let size;
    try {
      size = statSync(join(root, file)).size;
    } catch {
      continue;
    }
    if (size > limitKb * 1024) {
      oversized += 1;
      errors.push({
        file,
        rule: "large-file",
        message: `${file} is ${Math.round(size / 1024)} kB, over the ${limitKb} kB limit. Commit a source of truth instead.`,
      });
    }
  }
  return { errors, warnings: [], summary: { oversized, limitKb } };
}

/** Files staged for the next commit. */
export function stagedFiles(root = REPO_ROOT) {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
      { cwd: root, encoding: "utf8" },
    );
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Every file currently tracked by git. */
export function trackedFiles(root = REPO_ROOT) {
  try {
    const output = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function runCheck(
  root = REPO_ROOT,
  { files, limitKb = 500, allowlist, ratchet = true } = {},
) {
  const discovered = files ?? stagedFiles(root);
  const entries = allowlist ?? loadAllowlist(root);
  // An allowlisted path is dropped from the run entirely and reported as
  // suppressed, so a reviewer can see what was waived rather than trusting that
  // nothing was.
  let target = [];
  const suppressed = [];
  for (const file of discovered) {
    const entry = entries.find((candidate) => globToRegExp(candidate.pattern).test(file));
    if (entry) suppressed.push({ file, reason: entry.reason });
    else target.push(file);
  }

  // Ratchet: only *new* formatting violations fail. A file that was already
  // unclean in history keeps its existing findings, but a commit that adds a
  // new one is still caught. Comparing issue-by-issue rather than skipping whole
  // files matters: file-level skipping would let a fresh trailing-whitespace
  // line ride along in a file that already missed a final newline.
  const waived = new Map();
  if (ratchet) {
    const committed = committedVersions(root, target);
    for (const file of target) {
      const previous = committed.get(file);
      if (typeof previous !== "string") continue;
      const before = new Set(
        findFormattingIssues(file, Buffer.from(previous, "latin1")).map(
          // The line number moves as the file changes, so the comparison keys
          // on the kind of problem, not its position.
          (message) => message.replace(/line \d+/, "line N"),
        ),
      );
      waived.set(file, before);
    }
  }

  const checks = {
    artifacts: checkForbiddenPaths(root, target),
    secrets: checkSecrets(root, target),
    formatting: checkFormatting(root, target, waived),
    largeFiles: checkLargeFiles(root, target, limitKb),
  };

  // The remaining backlog is counted, not hidden, so it stays visible and
  // trends towards zero as files are touched.
  const debt = [...waived.values()].reduce((total, before) => total + before.size, 0);

  const errors = Object.entries(checks).flatMap(([name, result]) =>
    result.errors.map((error) => ({ ...error, check: name })),
  );
  const warnings = Object.entries(checks).flatMap(([name, result]) =>
    result.warnings.map((warning) => ({ ...warning, check: name })),
  );

  return {
    files: discovered.length,
    checked: target.length,
    suppressed,
    debt,
    checks,
    errors,
    warnings,
    ok: errors.length === 0,
  };
}

/**
 * Read the committed (`HEAD`) version of many files in one batched `git`
 * process, rather than spawning one per file.
 *
 * A whole-tree run touches thousands of files; one `git show` per file makes
 * the check take minutes. Returns a `Map<path, Buffer>` of the files that
 * exist in `HEAD`.
 */
export function committedVersions(root, filePaths) {
  const versions = new Map();
  if (filePaths.length === 0) return versions;

  // `encoding: "binary"` yields a latin1 string, which is byte-preserving: one
  // character per byte. Offsets are therefore byte offsets, and the payload is
  // sliced by length rather than split on newlines (it may contain them).
  let raw;
  try {
    // `-z` is required: object names are NUL-separated, and without it the
    // whole batch is parsed as a single (unresolvable) name.
    raw = execFileSync("git", ["cat-file", "--batch", "-z"], {
      cwd: root,
      input: `${filePaths.map((path) => `HEAD:${path}`).join("\0")}\0`,
      encoding: "binary",
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    return versions;
  }

  let cursor = 0;
  for (const path of filePaths) {
    const headerEnd = raw.indexOf("\n", cursor);
    if (headerEnd === -1) break;
    const header = raw.slice(cursor, headerEnd);
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) {
      // "<object> missing" — the file is not in HEAD.
      cursor = headerEnd + 1;
      continue;
    }
    const start = headerEnd + 1;
    versions.set(path, raw.slice(start, start + size));
    cursor = start + size + 1;
  }
  return versions;
}

export function loadAllowlist(root = REPO_ROOT) {
  try {
    return parseAllowlist(readFileSync(join(root, ALLOWLIST_PATH), "utf8"));
  } catch {
    // No allowlist is a valid state: every finding is then reported.
    return [];
  }
}

function parseArgs(argv) {
  const options = { all: false, json: false, files: null, limitKb: 500, ratchet: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") options.all = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-ratchet") options.ratchet = false;
    else if (arg === "--maxkb") {
      options.limitKb = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--files") {
      options.files = argv.slice(index + 1).filter((value) => !value.startsWith("--"));
      index = argv.length;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else options.unknown = arg;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(
      "usage: node scripts/precommit/check.mjs [--all] [--files <paths...>] [--maxkb <n>] [--json]\n",
    );
    return 0;
  }
  if (options.unknown) {
    process.stderr.write(`unknown argument: ${options.unknown}\n`);
    return 2;
  }
  if (!Number.isFinite(options.limitKb) || options.limitKb <= 0) {
    process.stderr.write("--maxkb must be a positive number\n");
    return 2;
  }

  const files = options.files ?? (options.all ? trackedFiles(REPO_ROOT) : undefined);
  const report = runCheck(REPO_ROOT, {
    files,
    limitKb: options.limitKb,
    ratchet: options.ratchet,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }

  if (report.files === 0) {
    process.stdout.write("no files to check; nothing staged.\n");
    return 0;
  }

  if (report.suppressed.length > 0) {
    process.stdout.write(`  · ${report.suppressed.length} allowlisted path(s) skipped\n`);
  }
  if (report.debt > 0) {
    process.stdout.write(
      `  · ${report.debt} file(s) skipped as pre-existing formatting debt (ratchet)\n`,
    );
  }
  for (const error of report.errors) {
    process.stdout.write(`  ✗ [${error.check}] ${error.message}\n`);
  }
  for (const warning of report.warnings) {
    process.stdout.write(`  ! [${warning.check}] ${warning.message}\n`);
  }
  process.stdout.write(
    report.ok
      ? `pre-commit check: PASS (${report.checked}/${report.files} file(s) checked)\n`
      : `\npre-commit check: FAIL (${report.errors.length} problem(s) in ${report.checked} file(s))\n`,
  );

  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  process.exitCode = main();
}

