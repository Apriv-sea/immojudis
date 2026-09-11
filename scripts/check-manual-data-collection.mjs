import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collectionWorkflows = [
  ".github/workflows/data-pipeline.yml",
  ".github/workflows/dvf-import.yml",
  ".github/workflows/outcome-dvf-adjudications.yml",
  ".github/workflows/outcome-judilibre.yml",
  ".github/workflows/recompute-existing-sales.yml",
  ".github/workflows/valuation-model-training.yml",
];
const allowedWorkflowTriggers = new Set(["workflow_dispatch"]);
const allowedVercelCronPaths = new Set([
  "/api/cron/smart-alerts",
  "/api/cron/alert-notifications",
  "/api/cron/sale-change-monitor",
  "/api/cron/data-retention",
  "/api/cron/sale-retention",
  "/api/cron/operational-health",
]);
const allowedDatabaseCronJobs = new Set([
  "immojudis-operational-health",
  "immojudis-operational-history-retention",
]);
// Keep immutable migration history, but forbid reintroducing these schedules.
// The terminal migration disables both; pgTAP checks the resulting database state.
const historicalCollectionSchedules = new Map([
  [
    "immojudis-market-valuations",
    "supabase/migrations/20260819164516_harden_market_valuation_pipeline.sql",
  ],
  ["immojudis-licitor-resume", "supabase/migrations/20260828095847_licitor_cloud_collector.sql"],
]);
const failures = [];

for (const relativePath of collectionWorkflows) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const triggers = topLevelWorkflowTriggers(source);
  if (!triggers.has("workflow_dispatch")) {
    failures.push(`${relativePath}: workflow_dispatch is required`);
  }
  for (const trigger of triggers) {
    if (!allowedWorkflowTriggers.has(trigger)) {
      failures.push(`${relativePath}: trigger '${trigger}' is not manual`);
    }
  }
}

const vercelConfig = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
for (const cron of vercelConfig.crons ?? []) {
  if (!allowedVercelCronPaths.has(cron.path)) {
    failures.push(`vercel.json: cron '${cron.path}' is not in the non-collection allow-list`);
  }
}

const collectorPath = "services/licitor-collector/vercel.json";
const collector = JSON.parse(await readFile(path.join(root, collectorPath), "utf8"));
if (collector.crons?.length) {
  failures.push(`${collectorPath}: collection must be initiated manually`);
}

const migrationDirectory = path.join(root, "supabase/migrations");
for (const entry of await readdir(migrationDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
  const relativePath = `supabase/migrations/${entry.name}`;
  const source = await readFile(path.join(migrationDirectory, entry.name), "utf8");
  const invocations = source.match(/cron\.schedule\s*\(/gi) ?? [];
  const jobNames = [...source.matchAll(/cron\.schedule\s*\(\s*'([^']+)'/gi)].map(
    (match) => match[1],
  );
  if (jobNames.length !== invocations.length) {
    failures.push(
      `${relativePath}: every cron.schedule call must expose a literal audited job name`,
    );
  }
  for (const jobName of jobNames) {
    if (
      !allowedDatabaseCronJobs.has(jobName) &&
      historicalCollectionSchedules.get(jobName) !== relativePath
    ) {
      failures.push(`${relativePath}: database cron '${jobName}' is not operational-only`);
    }
  }
}

if (failures.length) {
  console.error("Automatic data collection is not allowed:\n- " + failures.join("\n- "));
  process.exitCode = 1;
} else {
  console.log(
    `Manual collection and enrichment verified for ${collectionWorkflows.length} workflows and Vercel crons.`,
  );
}

function topLevelWorkflowTriggers(source) {
  const lines = source.split(/\r?\n/);
  const onIndex = lines.findIndex((line) => line === "on:");
  if (onIndex < 0) return new Set();

  const triggers = new Set();
  for (const line of lines.slice(onIndex + 1)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    const match = /^  ([A-Za-z0-9_-]+):(?:\s.*)?$/.exec(line);
    if (match) triggers.add(match[1]);
  }
  return triggers;
}
