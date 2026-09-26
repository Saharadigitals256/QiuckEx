/**
 * Documentation vs. source drift - issue #295.
 *
 * The OpenAPI document and the contract map are only useful if they describe
 * the API that actually exists. This module reads the backend's route
 * definitions as text and compares them with what the documentation claims,
 * so a controller nobody documented fails CI instead of surfacing as a 404.
 *
 * It never imports or runs the backend, so it works on a fresh clone.
 */
import { PATHS, fileExists, listControllerFiles, readText, unique } from "./shared.mjs";

/** Controller prefixes, as declared in @Controller('...'). */
export function extractControllerPrefixes(sources) {
  const prefixes = [];
  for (const { file, content } of sources) {
    // A quoted argument is a path prefix; a bare `@Controller()` is the root
    // controller, which has no prefix to document and must not be skipped
    // silently by the pattern.
    for (const match of content.matchAll(/@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)) {
      prefixes.push({ file, prefix: match[1] ?? "" });
    }
  }
  return prefixes;
}

/** The distinct first path segments of a documented route set, as a Set. */
export function documentedPathSegments(paths) {
  return new Set(
    unique(paths.map((path) => path.replace(/^\//, "").split("/")[0]).filter(Boolean)),
  );
}

/**
 * A prefix counts as documented when any of its segments appears among the
 * documented path segments. Matching on segments rather than whole prefixes is
 * deliberate: the goal is to catch an entirely undocumented module, not to
 * police how the docs group routes.
 */
export function isPrefixDocumented(prefix, segments) {
  if (prefix === "" || prefix === "/") return true;
  return prefix
    .split("/")
    .filter(Boolean)
    .some((segment) => segments.has(segment));
}

/** Route prefixes the backend mounts, read from @Controller(...). */
export function collectBackendRoutes(root) {
  const sources = listControllerFiles(root).map((file) => ({
    file,
    content: readText(root, file),
  }));
  const owners = extractControllerPrefixes(sources);
  return {
    files: sources.length,
    prefixes: unique(owners.map((entry) => entry.prefix)),
    owners,
  };
}

export function checkContractDrift(root) {
  const errors = [];
  const warnings = [];
  const summary = { controllers: 0, documented: 0, undocumented: 0 };

  if (!fileExists(root, PATHS.openapi)) {
    return { errors: [`${PATHS.openapi} is missing`], warnings, summary };
  }

  let document;
  try {
    document = JSON.parse(readText(root, PATHS.openapi));
  } catch (error) {
    return { errors: [`${PATHS.openapi} is not valid JSON: ${error.message}`], warnings, summary };
  }

  const backend = collectBackendRoutes(root);
  summary.controllers = backend.prefixes.length;

  const segments = documentedPathSegments(Object.keys(document.paths ?? {}));
  // Contract prose counts as documentation too: a route described in the
  // contract map is not undocumented even if the generated document lags.
  const prose = fileExists(root, PATHS.contractMap) ? readText(root, PATHS.contractMap) : "";

  const undocumented = [];
  for (const prefix of backend.prefixes) {
    if (prefix === "" || prefix === "/") continue;
    if (isPrefixDocumented(prefix, segments)) {
      summary.documented += 1;
      continue;
    }
    const owner = backend.owners.find((entry) => entry.prefix === prefix)?.file;
    if (prose.includes(`/${prefix.split("/")[0]}`)) {
      warnings.push(
        `${owner}: controller "${prefix}" is absent from ${PATHS.openapi} but is described in ${PATHS.contractMap}`,
      );
      continue;
    }
    undocumented.push({ prefix, owner });
  }

  summary.undocumented = undocumented.length;
  for (const { prefix, owner } of undocumented) {
    errors.push(
      `${owner}: controller "${prefix}" is documented in neither ${PATHS.openapi} nor ${PATHS.contractMap}. An undocumented route is a 404 waiting to happen - add it to both.`,
    );
  }

  return { errors, warnings, summary };
}

/**
 * The backend registers no global route prefix. This is a documented contract
 * the contract map calls out explicitly, because a client that prepends /api
 * would break every route at once.
 */
export function checkGlobalPrefixInvariant(root) {
  const errors = [];
  if (!fileExists(root, PATHS.mainEntry)) {
    return { errors: [`${PATHS.mainEntry} is missing`], warnings: [], summary: {} };
  }
  const main = readText(root, PATHS.mainEntry);
  const usesGlobalPrefix = /setGlobalPrefix\s*\(/.test(main);
  if (usesGlobalPrefix) {
    const map = fileExists(root, PATHS.contractMap) ? readText(root, PATHS.contractMap) : "";
    // Agreement requires the map to actually document a prefix. A map that
    // still *denies* one is the exact drift this check exists to catch, so a
    // mention of "no global route prefix" is a contradiction, not agreement.
    const documentsAPrefix = map.includes("setGlobalPrefix");
    const deniesAPrefix = /no global route prefix|registers no global/i.test(map);
    if (!documentsAPrefix || deniesAPrefix) {
      errors.push(
        `${PATHS.mainEntry} calls setGlobalPrefix, but ${PATHS.contractMap} ${deniesAPrefix ? "states the backend registers no global prefix" : "does not document the prefix"}. Update the contract map or remove the prefix.`,
      );
    }
  }
  return { errors, warnings: [], summary: { globalPrefix: usesGlobalPrefix } };
}
