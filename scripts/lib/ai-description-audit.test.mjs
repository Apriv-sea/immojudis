import { test } from "vitest";
import assert from "node:assert/strict";
import { displayAuditIssues, DISPLAY_QUALITY_VERSION } from "./ai-description-audit.mjs";
const valid = {
  llm_display_description:
    "Description factuelle du bien et des modalités de vente suffisamment détaillée pour être contrôlée.",
  llm_display_status: "accepted",
  llm_display_quality_version: DISPLAY_QUALITY_VERSION,
};
test("a long rejected or stale text is not a validated summary", () => {
  assert.deepEqual(displayAuditIssues({ ...valid, llm_display_status: "rejected" }), [
    "unvalidated_display_status",
  ]);
  assert.deepEqual(displayAuditIssues({ ...valid, llm_display_quality_version: "old" }), [
    "stale_display_quality",
  ]);
});
test("recorded source constraints must actually appear", () => {
  assert.deepEqual(
    displayAuditIssues({
      ...valid,
      llm_display_source_constraints: ["Terrain non constructible."],
    }),
    ["missing_source_constraint"],
  );
  assert.deepEqual(displayAuditIssues(valid), []);
});
