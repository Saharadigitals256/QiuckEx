/**
 * Accessibility / localization standard validation — issue #308.
 *
 * Parses the two inline i18next catalogs as text (never executes them) and
 * checks key parity, declared-locale coverage, and the a11y lint wiring state.
 * Known gaps live in docs/policies/data/a11y-i18n-baseline.json so the gate can
 * ratchet instead of failing on day one.
 */
import { PATHS, readText } from "./shared.mjs";

export const A11Y_DOC_SECTIONS = [
  "1. Conformance target",
  "2. Current state",
  "3. Web requirements",
  "4. Mobile requirements",
  "5. Localization requirements",
  "6. Testing requirements",
  "7. Tooling rollout",
  "8. Baseline, ratchet, and waivers",
  "9. Enforcement",
  "10. References",
];

export const DEFAULT_LOCALE = "en";

/** Replace string literal *contents* with spaces, preserving length/indices. */
export function maskStrings(source) {
  let out = "";
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        out += "  ";
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        out += char;
        continue;
      }
      out += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    out += char;
  }
  return out;
}

function matchClosingBrace(masked, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const KEY_PATTERN = /(?:^|[\n{,])[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*:/g;
const LOCALE_BLOCK_PATTERN = /([A-Za-z][A-Za-z0-9-]{1,10})[ \t]*:[ \t]*\{/g;

/** Extract `{ locale: [keys] }` from an i18next `resources` block. */
export function extractCatalogs(source) {
  const masked = maskStrings(source);
  const catalogs = {};
  const translationPattern = /translation[ \t]*:[ \t]*\{/g;
  let match;

  while ((match = translationPattern.exec(masked)) !== null) {
    const openIndex = masked.indexOf("{", match.index);
    const closeIndex = matchClosingBrace(masked, openIndex);
    if (closeIndex === -1) continue;

    const before = masked.slice(0, match.index);
    let locale = null;
    let candidate;
    const localePattern = new RegExp(LOCALE_BLOCK_PATTERN.source, "g");
    while ((candidate = localePattern.exec(before)) !== null) {
      locale = candidate[1];
    }
    if (!locale || locale === "resources") continue;

    const body = masked.slice(openIndex + 1, closeIndex);
    const keys = new Set();
    let keyMatch;
    const keyPattern = new RegExp(KEY_PATTERN.source, "g");
    while ((keyMatch = keyPattern.exec(body)) !== null) {
      keys.add(keyMatch[1]);
    }
    catalogs[locale] = [...keys].sort();
  }

  return catalogs;
}

/** Locales offered by a locale switcher component. */
export function extractSwitcherLocales(source) {
  const locales = new Set();
  for (const match of source.matchAll(/<option[^>]*value="([A-Za-z][A-Za-z0-9-]{1,10})"/g)) {
    locales.add(match[1]);
  }
  for (const match of source.matchAll(/<Picker\.Item[^>]*value="([A-Za-z][A-Za-z0-9-]{1,10})"/g)) {
    locales.add(match[1]);
  }
  return [...locales].sort();
}

/** Analyse one client surface (web or mobile). */
export function analyzeSurface({ name, i18nSource, switcherSource }) {
  const catalogs = extractCatalogs(i18nSource);
  const declaredLocales = extractSwitcherLocales(switcherSource);
  const defaultKeys = catalogs[DEFAULT_LOCALE] ?? [];

  const missingKeys = {};
  const orphanKeys = {};
  for (const [locale, keys] of Object.entries(catalogs)) {
    if (locale === DEFAULT_LOCALE) continue;
    missingKeys[locale] = defaultKeys.filter((key) => !keys.includes(key));
    const known = new Set(defaultKeys);
    orphanKeys[locale] = keys.filter((key) => !known.has(key));
  }

  return {
    name,
    catalogs,
    locales: Object.keys(catalogs).sort(),
    declaredLocales,
    defaultKeyCount: defaultKeys.length,
    missingKeys,
    orphanKeys,
    declaredLocalesWithoutCatalog: declaredLocales.filter((locale) => !(locale in catalogs)),
    stylesheetFormat: defaultKeys.length > 0 ? "inline-i18next-resources" : "unknown",
  };
}

export function readBaseline(root) {
  try {
    return JSON.parse(readText(root, PATHS.a11yBaseline));
  } catch {
    return null;
  }
}

/** Build the baseline document from the current repository state. */
export function buildBaseline(root, { owner = "docs/GOVERNANCE.md#owners" } = {}) {
  const surfaces = analyzeSurfaces(root);
  const eslintConfigWired = (() => {
    try {
      return readText(root, "app/frontend/eslint.config.mjs").includes("eslint.a11y.config.mjs");
    } catch {
      return false;
    }
  })();

  const surfaceEntries = {};
  for (const surface of surfaces) {
    surfaceEntries[surface.name] = {
      catalogs: surface.locales,
      declaredLocales: surface.declaredLocales,
      declaredLocalesWithoutCatalog: surface.declaredLocalesWithoutCatalog,
      missingKeys: Object.fromEntries(
        Object.entries(surface.missingKeys).filter(([, keys]) => keys.length > 0),
      ),
      orphanKeys: Object.fromEntries(
        Object.entries(surface.orphanKeys).filter(([, keys]) => keys.length > 0),
      ),
      defaultKeyCount: surface.defaultKeyCount,
    };
  }

  return {
    schemaVersion: 1,
    policyId: "quickex.a11y-i18n-baseline",
    owner,
    doc: PATHS.a11yDoc,
    generatedFrom: "node scripts/governance/check.mjs --only a11y --write-baseline",
    knownGaps: {
      frontendA11yLintWired: eslintConfigWired,
      mobileA11yLintWired: false,
      axeSmokeTests: false,
      perLocaleCatalogFiles: false,
    },
    acceptedGaps: [
      {
        id: "frontend.a11y-lint-not-wired",
        surface: "frontend",
        reason: "eslint-plugin-jsx-a11y is not installed; config exists at eslint.a11y.config.mjs",
        owner: "frontend maintainers",
        expires: "next release train",
      },
      {
        id: "mobile.a11y-lint-not-wired",
        surface: "mobile",
        reason: "eslint-plugin-react-native-a11y not added yet",
        owner: "mobile maintainers",
        expires: "next release train",
      },
      {
        id: "frontend+mobile.axe-smoke-tests-missing",
        surface: "frontend+mobile",
        reason: "no axe integration; vitest + Testing Library are already available",
        owner: "frontend maintainers",
        expires: "next release train",
      },
    ],
    surfaces: surfaceEntries,
  };
}

function acceptedGapIds(baseline) {
  return new Set((baseline?.acceptedGaps ?? []).map((gap) => gap.id));
}

function baselinedKeys(baseline, surfaceName, locale, kind) {
  return baseline?.surfaces?.[surfaceName]?.[kind]?.[locale] ?? [];
}

/** Analyse both surfaces from disk. */
export function analyzeSurfaces(root) {
  return [
    analyzeSurface({
      name: "frontend",
      i18nSource: readText(root, PATHS.frontendI18n),
      switcherSource: readText(root, PATHS.frontendSwitcher),
    }),
    analyzeSurface({
      name: "mobile",
      i18nSource: readText(root, PATHS.mobileI18n),
      switcherSource: readText(root, PATHS.mobileSwitcher),
    }),
  ];
}

/**
 * Validate both surfaces against the standard and the baseline.
 * Returns `{errors, warnings, summary, surfaces, baseline}`.
 */
export function validateI18n(root, { baseline = readBaseline(root), docContent } = {}) {
  const errors = [];
  const warnings = [];
  const surfaces = analyzeSurfaces(root);
  const gaps = acceptedGapIds(baseline);

  if (!docContent) {
    errors.push(`${PATHS.a11yDoc}: document is missing`);
  } else {
    for (const section of A11Y_DOC_SECTIONS) {
      if (!docContent.includes(`## ${section}`)) {
        errors.push(`${PATHS.a11yDoc}: missing required section "${section}"`);
      }
    }
  }

  for (const surface of surfaces) {
    if (surface.locales.length === 0) {
      errors.push(`${surface.name}: no i18n catalogs could be parsed`);
      continue;
    }
    if (!surface.locales.includes(DEFAULT_LOCALE)) {
      errors.push(`${surface.name}: missing the default "${DEFAULT_LOCALE}" catalog`);
    }
    for (const locale of surface.declaredLocalesWithoutCatalog) {
      if (gaps.has(`${surface.name}.switcher.${locale}-without-catalog`)) {
        warnings.push(
          `${surface.name}: locale "${locale}" is offered in the switcher without a catalog (baselined)`,
        );
      } else {
        errors.push(
          `${surface.name}: locale "${locale}" is offered in the switcher but has no catalog`,
        );
      }
    }
    const undiscoverable = surface.locales.filter(
      (locale) => !surface.declaredLocales.includes(locale),
    );
    if (undiscoverable.length > 0) {
      warnings.push(
        `${surface.name}: catalog(s) for ${undiscoverable.join(", ")} exist but no switcher entry offers them`,
      );
    }
    for (const [locale, keys] of Object.entries(surface.missingKeys)) {
      const known = new Set(baselinedKeys(baseline, surface.name, locale, "missingKeys"));
      const unbudgeted = keys.filter((key) => !known.has(key));
      if (unbudgeted.length > 0) {
        errors.push(
          `${surface.name}: locale "${locale}" is missing ${unbudgeted.length} key(s) from "${DEFAULT_LOCALE}", e.g. ${unbudgeted
            .slice(0, 5)
            .join(", ")}`,
        );
      } else if (keys.length > 0) {
        warnings.push(`${surface.name}: locale "${locale}" is missing ${keys.length} key(s) (baselined)`);
      }
    }
    for (const [locale, keys] of Object.entries(surface.orphanKeys)) {
      const known = new Set(baselinedKeys(baseline, surface.name, locale, "orphanKeys"));
      const unbudgeted = keys.filter((key) => !known.has(key));
      if (unbudgeted.length > 0) {
        warnings.push(
          `${surface.name}: locale "${locale}" has ${unbudgeted.length} orphan key(s) absent from "${DEFAULT_LOCALE}", e.g. ${unbudgeted
            .slice(0, 5)
            .join(", ")}`,
        );
      }
    }
  }

  const summary = surfaces.map((surface) => ({
    surface: surface.name,
    locales: surface.locales,
    declaredLocales: surface.declaredLocales,
    defaultKeyCount: surface.defaultKeyCount,
    missingKeys: Object.fromEntries(
      Object.entries(surface.missingKeys).map(([locale, keys]) => [locale, keys.length]),
    ),
    orphanKeys: Object.fromEntries(
      Object.entries(surface.orphanKeys).map(([locale, keys]) => [locale, keys.length]),
    ),
    declaredLocalesWithoutCatalog: surface.declaredLocalesWithoutCatalog,
  }));

  return { errors, warnings, summary, surfaces, baseline };
}

