import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const MAX_CLIENT_CHUNK_BYTES = 1_850_000;
// The protected admin editor adds an isolated client route; keep a small global
// allowance for it while enforcing a dedicated initial-load budget below.
const MAX_TOTAL_CLIENT_JS_BYTES = 4_020_000;
const MAX_LANDING_IMAGE_BYTES = 350_000;
const MAX_PUBLIC_MEDIA_BYTES = 1_600_000;
const MAX_BUSINESS_MODULE_LINES = 1_500;

const businessModules = [
  "src/components/SaleDetailView.tsx",
  "src/components/sale-detail/decision-view.tsx",
  "src/components/sale-detail/detail-helpers.ts",
  "src/components/sale-detail/detail-primitives.tsx",
  "src/components/sale-detail/document-workspace.tsx",
  "src/components/search/SearchPage.tsx",
  "src/components/search/SearchFilters.tsx",
  "src/components/search/SearchHeader.tsx",
  "src/components/search/SearchResults.tsx",
  "src/components/search/search-page-state.ts",
  "src/lib/property-reports.ts",
  "src/lib/property-report/analysis.ts",
  "src/lib/property-report/entitlements.ts",
  "src/lib/property-report/pdf.ts",
  "src/lib/property-report/repository.ts",
  "src/lib/property-report/serialization.ts",
  "services/data-pipeline/src/asset_normalization.py",
  "services/data-pipeline/src/asset_normalization_helpers.py",
  "services/data-pipeline/src/asset_premium_analysis.py",
  "services/data-pipeline/src/asset_scoring.py",
  "services/data-pipeline/src/asset_surface_normalization.py",
  "services/data-pipeline/src/pdf_document_selection.py",
  "services/data-pipeline/src/pdf_enrichment.py",
  "services/data-pipeline/src/pdf_fact_extraction.py",
];

const routeBudgets = [
  {
    name: "home",
    manifest: ".next/server/app/page_client-reference-manifest.js",
    routeKey: "/page",
    entryKey: "[project]/src/app/page",
    maxBytes: 500_000,
  },
  {
    name: "sales",
    manifest: ".next/server/app/sales/page_client-reference-manifest.js",
    routeKey: "/sales/page",
    entryKey: "[project]/src/app/sales/page",
    maxBytes: 700_000,
  },
  {
    name: "sale-detail",
    manifest: ".next/server/app/sales/[id]/page_client-reference-manifest.js",
    routeKey: "/sales/[id]/page",
    entryKey: "[project]/src/app/sales/[id]/page",
    maxBytes: 660_000,
  },
  {
    name: "example",
    manifest: ".next/server/app/annonce-exemple/page_client-reference-manifest.js",
    routeKey: "/annonce-exemple/page",
    entryKey: "[project]/src/app/annonce-exemple/page",
    maxBytes: 650_000,
  },
  {
    name: "pricing",
    manifest: ".next/server/app/accompagnement/page_client-reference-manifest.js",
    routeKey: "/accompagnement/page",
    entryKey: "[project]/src/app/accompagnement/page",
    maxBytes: 500_000,
  },
  {
    name: "admin-agent",
    manifest: ".next/server/app/admin/agent-ia/page_client-reference-manifest.js",
    routeKey: "/admin/agent-ia/page",
    entryKey: "[project]/src/app/admin/agent-ia/page",
    maxBytes: 600_000,
  },
];

const requiredHtml = [
  [".next/server/app/index.html", "Les enchères immobilières"],
  [".next/server/app/sales.html", "Ventes immobilières aux enchères"],
  [".next/server/app/annonce-exemple.html", "Exemple de rapport"],
];

for (const [path, expectedText] of requiredHtml) {
  const html = await readFile(path, "utf8");
  if (!html.includes("<h1") || !html.includes(expectedText)) {
    throw new Error(`${path} ne contient pas le HTML SSR utile attendu (${expectedText}).`);
  }
}

const businessModuleLines = Object.fromEntries(
  await Promise.all(
    businessModules.map(async (path) => {
      const source = await readFile(path, "utf8");
      const lines = source.split(/\r?\n/u).length;
      if (lines > MAX_BUSINESS_MODULE_LINES) {
        throw new Error(
          `Module métier trop long: ${path} (${lines} lignes > ${MAX_BUSINESS_MODULE_LINES}).`,
        );
      }
      return [path, lines];
    }),
  ),
);

const chunks = await filesUnder(".next/static/chunks", (path) => path.endsWith(".js"));
const chunkSizes = await Promise.all(chunks.map(async (path) => [path, (await stat(path)).size]));
const totalClientBytes = chunkSizes.reduce((sum, [, size]) => sum + size, 0);
const [largestChunk, largestChunkBytes] = chunkSizes.sort(
  (left, right) => right[1] - left[1],
)[0] ?? ["none", 0];

if (largestChunkBytes > MAX_CLIENT_CHUNK_BYTES) {
  throw new Error(
    `Chunk client trop lourd: ${largestChunk} (${largestChunkBytes} octets > ${MAX_CLIENT_CHUNK_BYTES}).`,
  );
}
if (totalClientBytes > MAX_TOTAL_CLIENT_JS_BYTES) {
  throw new Error(
    `JavaScript client total trop lourd: ${totalClientBytes} octets > ${MAX_TOTAL_CLIENT_JS_BYTES}.`,
  );
}

const routeClientBytes = {};
for (const budget of routeBudgets) {
  const bytes = await clientJavaScriptBytesForRoute(budget);
  routeClientBytes[budget.name] = bytes;
  if (bytes > budget.maxBytes) {
    throw new Error(
      `JavaScript initial trop lourd pour ${budget.name}: ${bytes} octets > ${budget.maxBytes}.`,
    );
  }
}

const landingImages = await filesUnder("public/media/landing", (path) => path.endsWith(".webp"));
for (const path of landingImages) {
  const bytes = (await stat(path)).size;
  if (bytes > MAX_LANDING_IMAGE_BYTES) {
    throw new Error(`Image landing trop lourde: ${path} (${bytes} octets).`);
  }
}

const publicMedia = await filesUnder("public/media", () => true);
const publicMediaBytes = (
  await Promise.all(publicMedia.map(async (path) => (await stat(path)).size))
).reduce((sum, bytes) => sum + bytes, 0);
if (publicMediaBytes > MAX_PUBLIC_MEDIA_BYTES) {
  throw new Error(
    `Médias publics trop lourds: ${publicMediaBytes} octets > ${MAX_PUBLIC_MEDIA_BYTES}.`,
  );
}

const legacyMedia = publicMedia.filter((path) => /\.(?:jpe?g|png|mp4)$/i.test(path));
if (legacyMedia.length > 0) {
  throw new Error(`Médias sources non optimisés encore publiés: ${legacyMedia.join(", ")}.`);
}

console.info(
  JSON.stringify({
    largestChunk,
    largestChunkBytes,
    landingWebpCount: landingImages.length,
    largestBusinessModuleLines: Math.max(...Object.values(businessModuleLines)),
    publicMediaBytes,
    routeClientBytes,
    totalClientBytes,
  }),
);

async function clientJavaScriptBytesForRoute({ manifest, routeKey, entryKey }) {
  const source = await readFile(manifest, "utf8");
  const context = { globalThis: {} };
  runInNewContext(source, context);
  const routeManifest = context.globalThis.__RSC_MANIFEST?.[routeKey];
  const files = routeManifest?.entryJSFiles?.[entryKey];
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`Manifest client absent ou vide pour ${routeKey} (${manifest}).`);
  }
  const sizes = await Promise.all(
    [...new Set(files)].map(async (path) => (await stat(join(".next", path))).size),
  );
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}

async function filesUnder(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return filesUnder(path, predicate);
      return predicate(path) ? [path] : [];
    }),
  );
  return nested.flat();
}
