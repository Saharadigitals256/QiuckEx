/**
 * OpenAPI document structure and internal consistency — issue #295.
 *
 * `docs/openapi.json` is the machine-readable contract clients generate
 * against, so a malformed or self-contradictory document is worse than no
 * document at all: it looks authoritative while being wrong.
 *
 * Every rule here is internal to the document (it never needs the server to be
 * running), which is what lets the gate run on a fresh clone in CI.
 */
import { PATHS, readJson, unique } from "./shared.mjs";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

/** Resolve a local JSON pointer (`#/components/schemas/Foo`) against a document. */
export function resolveRef(document, ref) {
  if (!ref.startsWith("#/")) return { found: true, external: true };
  let cursor = document;
  for (const segment of ref.slice(2).split("/")) {
    if (cursor === undefined || cursor === null) return { found: false };
    cursor = cursor[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return { found: cursor !== undefined };
}

/** Every operation in a document, as `{ method, path, operation }`. */
export function collectOperations(document) {
  const operations = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      operations.push({ method, path, operation });
    }
  }
  return operations;
}

/** Every `$ref` string appearing anywhere in a document. */
export function collectRefs(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const entry of node) collectRefs(entry, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.add(value);
      else collectRefs(value, found);
    }
  }
  return found;
}

export function checkOpenApiStructure(root) {
  const errors = [];
  const warnings = [];
  const summary = { paths: 0, operations: 0, schemas: 0, tags: 0 };

  let document;
  try {
    document = readJson(root, PATHS.openapi);
  } catch (error) {
    return {
      errors: [`${PATHS.openapi} is not valid JSON: ${error.message}`],
      warnings,
      summary,
    };
  }

  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.")) {
    errors.push(`${PATHS.openapi}: missing a 3.x \`openapi\` version`);
  }
  for (const field of ["info", "paths"]) {
    if (!document[field]) errors.push(`${PATHS.openapi}: missing the required \`${field}\` field`);
  }
  if (document.info) {
    for (const field of ["title", "version"]) {
      if (!document.info[field]) errors.push(`${PATHS.openapi}: \`info.${field}\` is required`);
    }
  }
  if (Object.keys(document.paths ?? {}).length === 0) {
    errors.push(`${PATHS.openapi}: \`paths\` is empty, so no route is documented`);
  }
  summary.paths = Object.keys(document.paths ?? {}).length;
  summary.schemas = Object.keys(document.components?.schemas ?? {}).length;
  summary.tags = (document.tags ?? []).length;

  const operations = collectOperations(document);
  summary.operations = operations.length;

  for (const { method, path, operation } of operations) {
    const where = `${method.toUpperCase()} ${path}`;
    if (!operation.responses || Object.keys(operation.responses).length === 0) {
      errors.push(`${PATHS.openapi}: ${where} declares no responses`);
    }
    if (!operation.tags || operation.tags.length === 0) {
      errors.push(`${PATHS.openapi}: ${where} has no tag, so it cannot be grouped in the docs UI`);
    }
    if (!operation.operationId) {
      warnings.push(`${PATHS.openapi}: ${where} has no \`operationId\`, which generators use for client method names`);
    }
    if (!operation.description && !operation.summary) {
      errors.push(`${PATHS.openapi}: ${where} has neither a summary nor a description`);
    }
    if (path.includes("//")) {
      errors.push(`${PATHS.openapi}: "${path}" contains an empty path segment`);
    }
  }

  const declaredTags = new Set((document.tags ?? []).map((tag) => tag.name));
  for (const name of unique(operations.flatMap(({ operation }) => operation.tags ?? []))) {
    if (!declaredTags.has(name)) {
      errors.push(`${PATHS.openapi}: operations use the tag "${name}", which is not declared in \`tags\``);
    }
  }

  const refs = collectRefs(document);
  for (const ref of refs) {
    if (!resolveRef(document, ref).found) {
      errors.push(`${PATHS.openapi}: \`${ref}\` does not resolve to anything in the document`);
    }
  }

  const schemaNames = new Set(Object.keys(document.components?.schemas ?? {}));
  const usedSchemas = new Set(
    [...refs]
      .filter((ref) => ref.startsWith("#/components/schemas/"))
      .map((ref) => ref.split("/").pop()),
  );
  for (const name of usedSchemas) {
    if (!schemaNames.has(name)) {
      errors.push(`${PATHS.openapi}: schema "${name}" is referenced but not declared`);
    }
  }
  for (const name of schemaNames) {
    if (!usedSchemas.has(name)) {
      warnings.push(`${PATHS.openapi}: schema "${name}" is declared but never referenced`);
    }
  }

  return { errors, warnings, summary };
}
