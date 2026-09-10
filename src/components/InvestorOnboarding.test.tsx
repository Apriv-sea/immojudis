// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { InvestorOnboarding } from "./InvestorOnboarding";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/router-compat", () => ({
  useNavigate: () => navigate,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("investor welcome flow", () => {
  it("keeps criteria when going back, then opens the filtered catalogue", () => {
    render(<InvestorOnboarding />);
    fireEvent.change(screen.getByLabelText("Ville, département ou région"), {
      target: { value: "Bordeaux" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    fireEvent.change(screen.getByLabelText("Type de bien"), { target: { value: "apartment" } });
    fireEvent.change(screen.getByLabelText("Mise à prix maximale (€)"), {
      target: { value: "150000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retour" }));
    expect((screen.getByLabelText("Ville, département ou région") as HTMLInputElement).value).toBe(
      "Bordeaux",
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    expect((screen.getByLabelText("Mise à prix maximale (€)") as HTMLInputElement).value).toBe(
      "150000",
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    expect(screen.getByRole("heading", { name: "Votre première recherche" })).toBe(
      document.activeElement,
    );
    expect(screen.getByText("Bordeaux")).toBeTruthy();
    expect(screen.getByRole("link", { name: /annonce exemple/ }).getAttribute("href")).toBe(
      "/annonce-exemple",
    );
    fireEvent.click(screen.getByRole("button", { name: "Voir les biens" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/sales",
      search: { query: "Bordeaux", maxPrice: 150000, homeTypes: "apartment" },
    });
  });
  it("allows all fields to be skipped without payment or a write request", () => {
    render(<InvestorOnboarding />);
    expect(
      screen.getByRole("link", { name: "Passer et explorer le catalogue" }).getAttribute("href"),
    ).toBe("/sales");
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    fireEvent.click(screen.getByRole("button", { name: "Voir les biens" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/sales",
      search: { query: undefined, maxPrice: undefined, homeTypes: undefined },
    });
  });
});
