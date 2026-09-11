#!/usr/bin/env node

import { displayAuditIssues } from "./lib/ai-description-audit.mjs";
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
  ".env.vercel-production.local",
];
const PAGE_SIZE = 1_000;
const DEFAULT_PROMPT_VERSION = "auction_llm_v9_qwen2_7b_scan_display";
const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");
const noFail = args.has("--no-fail");
const activeOnly = args.has("--active-only");

loadEnvFiles();

const expectedPromptVersion =
  valueFromArg("--prompt-version") || process.env.LLM_PROMPT_VERSION || DEFAULT_PROMPT_VERSION;

const supabaseUrl = firstFilledEnv(
  process.env.SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.VITE_SUPABASE_URL,
);
const serviceRoleKey = firstFilledEnv(
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  process.env.SUPABASE_SECRET_KEY,
);

if (!supabaseUrl || !serviceRoleKey) {
  fail(
    "Missing Supabase service credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) before running the audit.",
  );
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const rows = await fetchAuctionSales();
const report = buildReport(rows);

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHumanReport(report);
}

if (!noFail && !report.ok) {
  process.exit(1);
}

async function fetchAuctionSales() {
  const allRows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    let query = supabase
      .from("auction_sales")
      .select("id,title,source_name,primary_source,status,source_url,updated_at,raw_payload")
      .order("updated_at", { ascending: false, nullsFirst: false })
      .range(from, to);

    if (activeOnly) {
      query = query.in("status", ["active", "upcoming"]);
    }

    const { data, error } = await query;
    if (error) {
      fail(`Supabase query failed: ${error.message || "unknown error"}`);
    }

    const page = data ?? [];
    allRows.push(...page);
    if (page.length < PAGE_SIZE) return allRows;
  }
}

function buildReport(rows) {
  const gaps = [];
  const bySource = new Map();

  for (const row of rows) {
    const payload = isRecord(row.raw_payload) ? row.raw_payload : {};
    const source = row.primary_source || row.source_name || "source inconnue";
    const sourceStats = bySource.get(source) ?? {
      source,
      total: 0,
      missingDescription: 0,
      promptVersionMismatch: 0,
      tooShort: 0,
      invalidDisplay: 0,
    };
    sourceStats.total += 1;

    const description = clean(payload.llm_display_description);
    const promptVersion = clean(payload.llm_prompt_version);
    const reasons = displayAuditIssues(payload);
    if (reasons.length) sourceStats.invalidDisplay += 1;
    if (!description) {
      sourceStats.missingDescription += 1;
    } else if (description.length < 80) {
      sourceStats.tooShort += 1;
    }
    if (promptVersion !== expectedPromptVersion) {
      sourceStats.promptVersionMismatch += 1;
      reasons.push(`prompt_version:${promptVersion || "missing"}`);
    }

    if (reasons.length) {
      gaps.push({
        id: row.id,
        title: row.title,
        source,
        status: row.status,
        updatedAt: row.updated_at,
        sourceUrl: row.source_url,
        reasons,
      });
    }

    bySource.set(source, sourceStats);
  }

  const missingDescription = [...bySource.values()].reduce(
    (sum, source) => sum + source.missingDescription,
    0,
  );
  const promptVersionMismatch = [...bySource.values()].reduce(
    (sum, source) => sum + source.promptVersionMismatch,
    0,
  );
  const tooShort = [...bySource.values()].reduce((sum, source) => sum + source.tooShort, 0);

  return {
    checkedAt: new Date().toISOString(),
    expectedPromptVersion,
    scope: activeOnly ? "active_or_upcoming" : "all",
    total: rows.length,
    ok: gaps.length === 0,
    invalidDisplay: [...bySource.values()].reduce((sum, source) => sum + source.invalidDisplay, 0),
    missingDescription,
    promptVersionMismatch,
    tooShort,
    bySource: [...bySource.values()].sort(
      (a, b) =>
        b.missingDescription - a.missingDescription ||
        b.promptVersionMismatch - a.promptVersionMismatch ||
        b.total - a.total ||
        a.source.localeCompare(b.source),
    ),
    sampleGaps: gaps.slice(0, 25),
  };
}

function printHumanReport(report) {
  console.log("AI description audit");
  console.log(`- checked_at: ${report.checkedAt}`);
  console.log(`- scope: ${report.scope}`);
  console.log(`- expected_prompt_version: ${report.expectedPromptVersion}`);
  console.log(`- total_sales: ${report.total}`);
  console.log(`- missing_llm_display_description: ${report.missingDescription}`);
  console.log(`- prompt_version_mismatch: ${report.promptVersionMismatch}`);
  console.log(`- invalid_display: ${report.invalidDisplay}`);
  console.log(`- short_llm_display_description: ${report.tooShort}`);

  if (report.bySource.length) {
    console.log("\nBy source");
    for (const source of report.bySource.slice(0, 12)) {
      console.log(
        `- ${source.source}: total=${source.total}, missing=${source.missingDescription}, prompt_mismatch=${source.promptVersionMismatch}, short=${source.tooShort}`,
      );
    }
  }

  if (report.sampleGaps.length) {
    console.log("\nFirst gaps");
    for (const gap of report.sampleGaps) {
      console.log(
        `- ${gap.id} | ${gap.source} | ${gap.status || "status?"} | ${gap.reasons.join(", ")} | ${gap.title || gap.sourceUrl || "sans titre"}`,
      );
    }
  }
}

function loadEnvFiles() {
  const initialEnv = new Set(
    Object.keys(process.env).filter((name) => !isMissing(process.env[name])),
  );
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (!match || initialEnv.has(match[1])) continue;
      const value = unquote(match[2].trim());
      if (!isMissing(value) || isMissing(process.env[match[1]])) {
        process.env[match[1]] = value;
      }
    }
  }
}

function valueFromArg(name) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : null;
}

function firstFilledEnv(...values) {
  return values.find((value) => !isMissing(value))?.trim() ?? null;
}

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

function isMissing(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized.startsWith("your-") ||
    ["changeme", "todo", "null", "undefined"].includes(normalized)
  );
}

function fail(message) {
  if (jsonOutput) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(`[audit:ai-descriptions] ${message}`);
  }
  process.exit(1);
}
