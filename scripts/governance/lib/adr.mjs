/**
 * ADR (Architecture Decision Record) validation — issue #309.
 *
 * The format contract lives in docs/adr/README.md and is enforced here so a
 * malformed or orphaned ADR fails CI instead of being discovered in review.
 */
import { join } from "node:path";
import { PATHS, duplicates, listFiles, readText } from "./shared.mjs";

export const ADR_REQUIRED_SECTIONS = [
  "Status",
  "Context",
  "Decision",
  "Consequences",
  "Reversal Cost",
  "Invariants Affected",
  "References",
];

export const ADR_STATUS_PATTERN =
  /^(Proposed|Accepted|Rejected|Deprecated|Superseded by ADR-\d{4})$/;

const ADR_FILE_PATTERN = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const ADR_TITLE_PATTERN = /^#\s+ADR-(\d{4}):\s+(.+?)\s*$/;

/**
 * Parse a single ADR document. Returns a descriptor or throws an Error
 * describing the first structural problem.
 */
export function parseAdr(fileName, content) {
  const fileMatch = fileName.match(ADR_FILE_PATTERN);
  if (!fileMatch) {
    throw new Error(`${fileName}: filename must match NNNN-kebab-case-title.md`);
  }
  const [, number] = fileMatch;

  const lines = content.split("\n");
  const firstContentLine = lines.find((line) => line.trim().length > 0) ?? "";
  const titleMatch = firstContentLine.match(ADR_TITLE_PATTERN);
  if (!titleMatch) {
    throw new Error(`${fileName}: first line must be "# ADR-${number}: <title>"`);
  }
  if (titleMatch[1] !== number) {
    throw new Error(
      `${fileName}: heading number ${titleMatch[1]} does not match filename ${number}`,
    );
  }

  const sections = lines
    .map((line) => line.match(/^##\s+(.*?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1].trim());

  const missing = ADR_REQUIRED_SECTIONS.filter(
    (section) => !sections.includes(section),
  );
  if (missing.length > 0) {
    throw new Error(
      `${fileName}: missing required section(s): ${missing.join(", ")}`,
    );
  }

  const actualOrder = sections.filter((section) =>
    ADR_REQUIRED_SECTIONS.includes(section),
  );
  if (actualOrder.join("|") !== ADR_REQUIRED_SECTIONS.join("|")) {
    throw new Error(
      `${fileName}: required sections are out of order (expected ${ADR_REQUIRED_SECTIONS.join(" → ")})`,
    );
  }

  const statusIndex = lines.findIndex((line) => line.trim() === "## Status");
  const statusLine = lines.slice(statusIndex + 1).find((line) => line.trim().length > 0);
  const status = (statusLine ?? "").trim();
  if (!ADR_STATUS_PATTERN.test(status)) {
    throw new Error(`${fileName}: invalid status "${status}"`);
  }

  return {
    fileName,
    path: `${PATHS.adrDir}/${fileName}`,
    number,
    title: titleMatch[2],
    status,
    supersededBy: status.startsWith("Superseded by ADR-")
      ? status.replace("Superseded by ", "")
      : null,
    sections,
    content,
  };
}

/** Parse every ADR in docs/adr, ignoring README.md and TEMPLATE.md. */
export function loadAdrs(root) {
  const files = listFiles(root, PATHS.adrDir).filter(
    (name) => name !== "README.md" && name !== "TEMPLATE.md",
  );
  const adrs = [];
  const errors = [];
  for (const fileName of files) {
    try {
      adrs.push(parseAdr(fileName, readText(root, join(PATHS.adrDir, fileName))));
    } catch (error) {
      errors.push(error.message);
    }
  }
  adrs.sort((left, right) => left.number.localeCompare(right.number));
  return { adrs, errors };
}

/**
 * Validate the whole ADR set against its index: `{errors, warnings, adrs, index}`.
 */
export function validateAdrSet({ adrs, parseErrors = [], indexContent }) {
  const errors = [...parseErrors];
  const warnings = [];

  for (const dupe of duplicates(adrs.map((adr) => adr.number))) {
    errors.push(`duplicate ADR number ${dupe}`);
  }

  const index = parseAdrIndex(indexContent);
  for (const dupe of duplicates(index.map((row) => row.number))) {
    errors.push(`duplicate index row for ADR-${dupe}`);
  }

  const byNumber = new Map(adrs.map((adr) => [adr.number, adr]));
  const byFileName = new Map(adrs.map((adr) => [adr.fileName, adr]));
  const indexByNumber = new Map(index.map((row) => [row.number, row]));

  for (const adr of adrs) {
    const row = indexByNumber.get(adr.number);
    if (!row) {
      errors.push(`ADR-${adr.number} is missing from the index in docs/adr/README.md`);
      continue;
    }
    if (row.title !== adr.title) {
      errors.push(
        `ADR-${adr.number} index title "${row.title}" does not match document title "${adr.title}"`,
      );
    }
    if (row.status !== adr.status) {
      errors.push(
        `ADR-${adr.number} index status "${row.status}" does not match document status "${adr.status}"`,
      );
    }
    const linkTarget = row.link.replace(/^\.\//, "");
    if (!byFileName.has(linkTarget)) {
      errors.push(`ADR-${adr.number} index links to missing file ${row.link}`);
    }
    if (adr.supersededBy) {
      const replacement = byNumber.get(adr.supersededBy.replace("ADR-", ""));
      if (!replacement) {
        errors.push(
          `ADR-${adr.number} claims "${adr.status}" but ${adr.supersededBy} does not exist`,
        );
      } else if (!adr.content.includes(replacement.fileName)) {
        errors.push(
          `ADR-${adr.number} must link its replacement (${replacement.fileName}) in the body`,
        );
      }
    }
  }

  for (const row of index) {
    if (!byNumber.has(row.number)) {
      errors.push(`index row ADR-${row.number} has no matching file`);
    }
  }

  if (adrs.length === 0) {
    errors.push("no ADR documents found under docs/adr");
  }
  if (!adrs.some((adr) => adr.status === "Accepted")) {
    warnings.push("no Accepted ADRs found");
  }
  if (!adrs.some((adr) => adr.content.includes("INV-"))) {
    warnings.push("no ADR references a financial invariant (INV-xx)");
  }

  return { errors, warnings, adrs, index };
}

/** Disk-backed convenience wrapper used by the CLI. */
export function checkAdrs(root) {
  const { adrs, errors: parseErrors } = loadAdrs(root);
  const indexContent = readText(root, `${PATHS.adrDir}/README.md`);
  return validateAdrSet({ adrs, parseErrors, indexContent });
}

export function parseAdrIndex(indexContent) {
  const rows = [];
  for (const line of indexContent.split("\n")) {
    const match = line.match(
      /^\|\s*\[ADR-(\d{4})\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/,
    );
    if (match) {
      rows.push({
        number: match[1],
        link: match[2],
        title: match[3].trim(),
        status: match[4].trim(),
      });
    }
  }
  return rows;
}
