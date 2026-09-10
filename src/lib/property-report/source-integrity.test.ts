import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "../example-sale";
import { assertReportSourceCurrent, reportSourceFingerprint } from "./source-integrity";

describe("saved report source integrity", () => {
  const snapshot = () => ({ sourceFingerprint: reportSourceFingerprint(EXAMPLE_SALE) });

  it("accepts the unchanged source despite capture timestamps", () => {
    expect(() =>
      assertReportSourceCurrent(snapshot(), {
        ...EXAMPLE_SALE,
        updated_at: "2030-01-01T00:00:00Z",
      }),
    ).not.toThrow();
  });

  it.each([
    { investment_score: null },
    { carrez_surface_m2: 97.16, property_type: "apartment" },
    { occupancy_status: "occupied" },
    {
      risks: [
        { risk_type: "physical", risk_label: "Contrôle parasitaire incomplet", severity: null },
      ],
    },
  ])("rejects a report when its source facts were corrected: %j", (changes) => {
    expect(() =>
      assertReportSourceCurrent(snapshot(), {
        ...EXAMPLE_SALE,
        ...changes,
      } as typeof EXAMPLE_SALE),
    ).toThrow(/actualisées/);
  });

  it("requires refreshing legacy reports without a verifiable source fingerprint", () => {
    expect(() => assertReportSourceCurrent({}, EXAMPLE_SALE)).toThrow(/sauvegardez/);
  });
});
