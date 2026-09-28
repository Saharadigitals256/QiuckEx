import { gzipSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const buildDir = path.resolve(process.cwd(), ".next");
const budgetPath = path.resolve(process.cwd(), "bundle-budgets.json");
const budgets = JSON.parse(readFileSync(budgetPath, "utf8"));
const manifests = ["build-manifest.json", "app-build-manifest.json"]
  .map((name) => path.join(buildDir, name))
  .filter(existsSync);

if (manifests.length === 0) {
  throw new Error("No Next.js build manifest found. Run `next build` before checking bundle budgets.");
}

function routeFromManifestKey(key) {
  if (key.includes("/api/") || /\/(layout|template|default|route)$/.test(key)) return null;
  const route = key.replace(/\/page$/, "");
  if (route === "/page" || route === "") return "/";
  if (!route.startsWith("/") || route.startsWith("/_")) return null;
  return route;
}

const routeAssets = new Map();
for (const manifestPath of manifests) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const pages = manifest.pages ?? {};
  const sharedAssets = new Set(pages["/_app"] ?? []);

  for (const [key, files] of Object.entries(pages)) {
    const route = routeFromManifestKey(key);
    if (!route || !Array.isArray(files)) continue;
    const assets = routeAssets.get(route) ?? new Set();
    for (const file of [...sharedAssets, ...files]) {
      if (typeof file === "string" && file.endsWith(".js") && file.startsWith("static/")) {
        assets.add(file);
      }
    }
    routeAssets.set(route, assets);
  }
}

if (routeAssets.size === 0) {
  throw new Error("No route JavaScript assets found in the Next.js build manifests.");
}

let failed = false;
for (const [route, assets] of [...routeAssets].sort(([left], [right]) => left.localeCompare(right))) {
  let compressedBytes = 0;
  for (const asset of assets) {
    const assetPath = path.resolve(buildDir, asset);
    if (!assetPath.startsWith(`${buildDir}${path.sep}`) || !existsSync(assetPath)) {
      throw new Error(`Invalid or missing build asset for ${route}: ${asset}`);
    }
    compressedBytes += gzipSync(readFileSync(assetPath), { level: 9 }).byteLength;
  }

  const actualKiB = compressedBytes / 1024;
  const budgetKiB = budgets.routes[route] ?? budgets.defaultGzipKiB;
  const passed = actualKiB <= budgetKiB;
  console.log(`${passed ? "PASS" : "FAIL"} ${route}: ${actualKiB.toFixed(1)} KiB / ${budgetKiB} KiB gzip (${assets.size} chunks)`);
  if (!passed) failed = true;
}

if (failed) process.exitCode = 1;