// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { AuctionSale, SaleVenueType } from "@/lib/types";
import { publicSaleVenueCopy, SalePublicPreview } from "./SalePublicPreview";

vi.mock("@/lib/router-compat", () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
  }) => {
    const query = new URLSearchParams(
      Object.entries(search ?? {}).map(([key, value]) => [key, String(value)]),
    ).toString();
    return (
      <a href={`${to}${query ? `?${query}` : ""}`} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("@/components/SaleTribunalHistory", () => ({
  SaleTribunalHistory: ({ sale }: { sale: AuctionSale }) => (
    <section>Activité publique du tribunal pour {sale.id}</section>
  ),
}));

afterEach(cleanup);

describe("SalePublicPreview", () => {
  it("keeps the requested section and search return in the login destination", () => {
    render(
      <SalePublicPreview
        saleId="sale-1"
        preview={{ id: "sale-1" } as AuctionSale}
        returnTo="/sales?city=Toulouse"
        requestedHash="#information-agent"
      />,
    );
    const href = screen
      .getByRole("link", { name: /Voir gratuitement le dossier/ })
      .getAttribute("href")!;
    expect(new URL(href, "https://example.test").searchParams.get("redirect")).toBe(
      "/sales/sale-1?from=%2Fsales%3Fcity%3DToulouse#information-agent",
    );
  });

  it.each([
    ["tribunal", "Bien immobilier vendu au tribunal"],
    ["notary", "Bien immobilier vendu chez le notaire"],
    ["state", "Bien immobilier vendu par l’État"],
    ["online", "Bien immobilier vendu aux enchères"],
    ["unknown", "Bien immobilier vendu aux enchères"],
  ] satisfies Array<[SaleVenueType, string]>)(
    "explains the %s venue with a dedicated public title",
    (venueType, title) => {
      expect(publicSaleVenueCopy(venueType).title).toBe(title);
      expect(publicSaleVenueCopy(venueType).explanation.length).toBeGreaterThan(70);
    },
  );

  it("makes a notarial sale explicit without leaking protected listing data", () => {
    const { container } = renderPreview({
      sale_venue_type: "notary",
      sale_verification_status: "cross_checked",
      lawyer_contact: "confidential@example.test",
    });

    expect(
      screen.getByRole("heading", { name: "Bien immobilier vendu chez le notaire" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Vente notariale").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Représentation à confirmer")).toBeTruthy();
    expect(screen.getByText("Un seul catalogue, plusieurs procédures")).toBeTruthy();
    expect(container.textContent).toContain(
      "ventes immobilières au tribunal, chez le notaire et les ventes domaniales",
    );
    expect(container.textContent).not.toContain("confidential@example.test");
    expect(screen.queryByText(/Activité publique du tribunal/)).toBeNull();

    const cta = screen.getByRole("link", { name: /Voir gratuitement le dossier/ });
    expect(cta.getAttribute("href")).toContain("mode=investor");
    expect(cta.getAttribute("href")).toContain(encodeURIComponent("/sales/sale-1?from=%2Fsales"));
  });

  it("keeps court-specific guidance and public court activity on tribunal sales", async () => {
    renderPreview({ sale_venue_type: "tribunal", sale_verification_status: "verified" });

    expect(screen.getByText("Avocat obligatoire pour enchérir")).toBeTruthy();
    expect(screen.getByText(/audience d’adjudication/)).toBeTruthy();
    expect(await screen.findByText("Activité publique du tribunal pour sale-1")).toBeTruthy();
  });

  it("has no structural accessibility violations", async () => {
    const { container } = renderPreview({
      sale_venue_type: "state",
      sale_verification_status: "verified",
    });
    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });
});

function renderPreview(overrides: Partial<AuctionSale> = {}) {
  return render(
    <SalePublicPreview
      saleId="sale-1"
      returnTo="/sales"
      preview={
        {
          id: "sale-1",
          starting_price_eur: 59_000,
          sale_venue_type: "notary",
          sale_verification_status: "cross_checked",
          ...overrides,
        } as AuctionSale
      }
    />,
  );
}
