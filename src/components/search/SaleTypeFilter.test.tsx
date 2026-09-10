// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaleTypeFilter as SaleTypeValue } from "@/lib/sale-types";
import {
  draftToSearch,
  searchToDraft,
  emptySearchDraft,
  buildAlertName,
} from "./search-page-state";

vi.mock("@/lib/router-compat", () => ({
  Link: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { SaleTypeFilter } from "./SaleTypeFilter";

function FilterHarness() {
  const [value, setValue] = useState<SaleTypeValue | "">("");
  return <SaleTypeFilter value={value} onChange={setValue} />;
}

describe("sale type search controls", () => {
  afterEach(cleanup);
  it("exposes an accessible selection and a working comparison anchor", () => {
    render(<FilterHarness />);
    expect(screen.getByRole("group", { name: "Type de vente" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chez le notaire" }));
    expect(
      screen.getByRole("button", { name: "Chez le notaire" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Toutes" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Toutes" }));
    expect(screen.getByRole("button", { name: "Toutes" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByRole("button", { name: "En ligne" })).toBeNull();
    expect(screen.getByRole("link", { name: "Quelle différence ?" }).getAttribute("href")).toBe(
      "/ventes-immobilieres-judiciaires#differences",
    );
  });
  it("preserves the family when editing other filters and includes it in the alert name", () => {
    const search = { saleType: "notary" as const, city: "Bordeaux", page: 3 };
    expect(draftToSearch(searchToDraft(search), search)).toMatchObject({
      saleType: "notary",
      city: "Bordeaux",
    });
    expect(draftToSearch(emptySearchDraft(), search).saleType).toBeUndefined();
    expect(buildAlertName(search)).toContain("Chez le notaire");
  });
});
