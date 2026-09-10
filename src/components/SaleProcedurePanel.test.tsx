// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SaleProcedureBadge, SaleProcedureSummary } from "./SaleProcedurePanel";
import type { AuctionSale } from "@/lib/types";

describe("sale procedure identity", () => {
  afterEach(cleanup);

  it("shows the public family without disclosing contacts or participation rules", () => {
    const { container } = render(
      <SaleProcedureBadge
        sale={
          {
            sale_venue_type: "notary",
            sale_verification_status: "pending",
            lawyer_contact: "confidential@example.test",
          } as AuctionSale
        }
      />,
    );
    expect(screen.getByText("Vente notariale").title).toContain("En cours de vérification");
    expect(container.innerHTML).not.toContain("confidential");
    expect(container.innerHTML).not.toContain("Avocat obligatoire");
  });

  it("does not assume a notarial sale is voluntary or require a lawyer", () => {
    render(
      <SaleProcedureSummary
        sale={
          {
            sale_venue_type: "notary",
            sale_legal_framework: "judicial_partition",
            sale_verification_status: "verified",
          } as AuctionSale
        }
      />,
    );
    expect(screen.getByText("Licitation ou partage judiciaire")).toBeTruthy();
    expect(screen.getByText("Représentation à confirmer")).toBeTruthy();
    expect(screen.queryByText("Avocat obligatoire pour enchérir")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Voir les démarches et conditions de cette vente" })
        .getAttribute("href"),
    ).toBe("#participation");
  });

  it("keeps an unknown family explicit", () => {
    render(
      <SaleProcedureSummary
        sale={{ sale_venue_type: "unknown", sale_verification_status: "pending" } as AuctionSale}
      />,
    );
    expect(screen.getByText("Type de vente à confirmer")).toBeTruthy();
    expect(screen.getByText("Cadre juridique à confirmer")).toBeTruthy();
  });
});
