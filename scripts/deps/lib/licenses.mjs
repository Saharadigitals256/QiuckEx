/**
 * License classification against the published policy — issue #294.
 *
 * The policy (docs/policies/data/dependency-license-policy.json) splits
 * licenses into allow / review / deny. Classification is by SPDX id, matched
 * case-insensitively and tolerating the `deprecatedLicenseId` spellings that
 * older packages still carry in their manifest.
 */
import { PATHS, readJson } from "./shared.mjs";

export const LICENSE_VOCABULARY = ["allow", "review", "deny"];

/**
 * Legacy SPDX ids mapped to their modern equivalents so a package published
 * before an id rename is judged on its current obligations, not a string
 * mismatch. `deprecatedLicenseId` in a manifest is not a licence change.
 */
export const LICENSE_ALIASES = {
  "agpl-3.0": "AGPL-3.0-only",
  gpl: "GPL-2.0",
  "gpl-2.0": "GPL-2.0",
  "gpl-2.0+": "GPL-2.0",
  "gpl-3.0": "GPL-3.0-only",
  "gpl-3.0+": "GPL-3.0-or-later",
  lgpl: "LGPL-2.1",
  "lgpl-2.1": "LGPL-2.1",
  "lgpl-2.1+": "LGPL-2.1-or-later",
  "lgpl-3.0": "LGPL-3.0-only",
  "lgpl-3.0+": "LGPL-3.0-or-later",
  wtfpl: "WTFPL",
  "apache2": "Apache-2.0",
  bsd: "BSD-3-Clause",
  mit: "MIT",
};

export function canonicalizeLicense(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();
  return LICENSE_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Every spelling that denotes the same licence: the id as written, its
 * canonical form, and any legacy ids that canonicalise to it.
 *
 * A policy may legitimately list either spelling, and a package may declare
 * the other, so both must resolve to the same verdict.
 */
const EQUIVALENCE_GROUPS = (() => {
  const groups = new Map();
  const add = (spelling) => {
    const canonical = canonicalizeLicense(spelling);
    if (!groups.has(canonical)) groups.set(canonical, new Set());
    groups.get(canonical).add(canonical);
    groups.get(canonical).add(spelling);
  };
  for (const legacy of Object.keys(LICENSE_ALIASES)) add(legacy);
  for (const legacy of Object.values(LICENSE_ALIASES)) add(legacy);
  return groups;
})();

export function licenseEquivalents(value) {
  const canonical = canonicalizeLicense(value);
  if (!canonical) return [];
  // The id exactly as declared is always included, so a policy may list either
  // the legacy or the modern spelling without the other being lost.
  const group = EQUIVALENCE_GROUPS.get(canonical);
  return group ? [...new Set([...group, value.trim(), canonical])] : [value.trim(), canonical];
}

/** SPDX identifiers are case-insensitive, so every policy match is too. */
function policyMentions(list, id) {
  if (typeof id !== "string") return false;
  const target = id.trim().toLowerCase();
  return target.length > 0 && list.some((entry) => String(entry).trim().toLowerCase() === target);
}

/**
 * Parse an SPDX licence expression into its individual licence ids.
 *
 * Manifests use several shapes beyond a bare id:
 *   `MIT`                          a single licence
 *   `MIT OR Apache-2.0`            dual-licensed; the consumer picks a branch
 *   `MIT AND Apache-2.0`           both obligations apply
 *   `(MIT, Apache-2.0)`            the pre-SPDX-expression comma form
 *   `(MIT OR Apache-2.0)`          a parenthesised expression
 *   `deprecatedLicenseId`          the legacy field, carrying the same terms
 *
 * Every id in the expression is returned, because an `AND` means the package
 * is subject to *all* of them and the strictest obligation governs. An
 * expression that cannot be parsed yields no ids, which the classifier then
 * reports as `unknown` rather than silently approving.
 */
export function parseLicenseExpression(field) {
  const raw =
    typeof field === "string"
      ? field
      : field && typeof field === "object" && typeof field.type === "string"
        ? field.type
        : Array.isArray(field)
          ? field.map((entry) => (typeof entry === "string" ? entry : entry?.type)).join(" OR ")
          : null;
  if (typeof raw !== "string" || raw.trim() === "") return [];

  const tokens = raw.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [];
  // `OR`, `AND`, and `WITH` are operators, not licence ids.
  const operators = new Set(["or", "and", "with"]);
  const ids = [];
  for (const token of tokens) {
    if (operators.has(token.toLowerCase())) continue;
    const canonical = canonicalizeLicense(token);
    if (canonical) ids.push(canonical);
  }
  return [...new Set(ids)];
}

/**
 * Normalise a raw manifest `license` field into the licence ids it denotes.
 *
 * A field may be a bare id, an SPDX expression, a legacy
 * `{ type, url }` object, an array, or a `licenses` array of such objects.
 */
export function normalizeLicenseField(field) {
  if (!field) return [];
  if (typeof field === "object" && !Array.isArray(field) && Array.isArray(field.licenses)) {
    return field.licenses.flatMap((entry) => normalizeLicenseField(entry));
  }
  if (typeof field === "object" && typeof field.deprecatedLicenseId === "string") {
    // A deprecated id names the same terms under an older identifier.
    return normalizeLicenseField(field.deprecatedLicenseId);
  }
  return parseLicenseExpression(field);
}

/**
 * Classify a package's license against the policy.
 *
 * Returns `{ verdict, licenses, reason }` where `verdict` is one of
 * `allow`, `review`, `deny` or `unknown`. `unknown` is a failure by default
 * (`unknownBehavior` in the policy) because an unstated licence cannot be
 * shown to be compatible.
 */
export function classifyLicense(field, policy, packageName = null) {
  const licenses = normalizeLicenseField(field);

  // An exception may be recorded against a licence id (`MPL-2.0`) or, for a
  // package that publishes no usable `license` field, against its name
  // (`busboy`). Both are matched case-insensitively.
  const exceptionFor = (id) => {
    const target = String(id).trim().toLowerCase();
    return (policy.exceptions ?? []).some(
      (entry) =>
        entry &&
        typeof entry.license === "string" &&
        entry.license.trim().toLowerCase() === target,
    );
  };

  if (licenses.length === 0) {
    if (packageName && exceptionFor(packageName)) {
      return {
        verdict: "allow",
        licenses: [],
        reason: null,
        excepted: packageName,
      };
    }
    // An unstated licence cannot be shown to be compatible, so `unknown` is
    // surfaced as a failure unless the policy explicitly tolerates it.
    const verdict =
      { allow: "allow", deny: "deny" }[policy.unknownBehavior] ?? "unknown";
    return {
      verdict,
      licenses: [],
      reason: "no SPDX license declared in the manifest",
    };
  }

  // Every equivalent spelling is matched, so a policy listing `GPL-3.0` and a
  // package declaring `GPL-3.0-or-later` resolve to the same verdict.
  const verdictFor = (id) => {
    const equivalents = licenseEquivalents(id);
    if (equivalents.some((candidate) => exceptionFor(candidate))) return "allow";
    for (const section of ["deny", "review", "allow"]) {
      if (equivalents.some((candidate) => policyMentions(policy[section], candidate))) {
        return section;
      }
    }
    return "unknown";
  };

  const verdicts = licenses.map(verdictFor);

  // `OR` in an SPDX expression means the consumer chooses a branch, so the most
  // permissive branch is the one actually in use. A dual-licensed package is
  // therefore judged on its best available option: `MIT OR GPL-3.0` is usable
  // under MIT, and `MIT OR BUSL-1.1` likewise.
  const precedence = ["allow", "review", "unknown", "deny"];
  const verdict =
    precedence.find((candidate) => verdicts.includes(candidate)) ?? "unknown";

  if (verdict === "allow") {
    return { verdict, licenses, reason: null };
  }
  if (verdict === "deny") {
    return {
      verdict,
      licenses,
      reason: `declares a denied license (${licenses.join(", ")})`,
    };
  }
  if (verdict === "review") {
    return {
      verdict,
      licenses,
      reason: `requires review (${licenses.join(", ")})`,
    };
  }
  return {
    verdict,
    licenses,
    reason: `license is not listed in the policy: ${licenses.join(", ")}`,
  };
}

/** Validate the policy document's own shape. */
export function validateLicensePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object") {
    return ["dependency-license-policy.json is not an object"];
  }
  for (const section of LICENSE_VOCABULARY) {
    if (!Array.isArray(policy[section])) {
      errors.push(`license policy is missing the "${section}" array`);
    }
  }
  if (!["allow", "review", "deny", "error"].includes(policy.unknownBehavior)) {
    errors.push(
      `license policy unknownBehavior must be allow|review|deny|error, got ${JSON.stringify(
        policy.unknownBehavior,
      )}`,
    );
  }
  for (const license of policy.deny ?? []) {
    if (policy.allow.includes(license)) {
      errors.push(`license "${license}" is both allowed and denied`);
    }
  }
  for (const entry of policy.exceptions ?? []) {
    if (!entry || typeof entry.license !== "string" || typeof entry.justification !== "string") {
      errors.push("each license exception needs a `license` and a `justification`");
    }
  }
  return errors;
}

export function loadLicensePolicy(root) {
  return readJson(root, PATHS.licensePolicy);
}

/**
 * The published policy document must describe every licence class it defines,
 * so a contributor reading the policy sees the same three buckets the gate
 * enforces.
 */
export function missingPolicyMentions(docContent, policy) {
  const missing = [];
  for (const license of policy.deny ?? []) {
    if (!docContent.includes(license)) {
      missing.push(`denied license "${license}" is not documented`);
    }
  }
  for (const mention of [
    "unknownBehavior",
    "exceptions",
    "denied",
    "review",
  ]) {
    if (!docContent.includes(mention)) {
      missing.push(`policy documentation does not mention "${mention}"`);
    }
  }
  return missing;
}
