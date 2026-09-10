// @vitest-environment jsdom
import { buildStructuredDescription } from "@/lib/sale-description";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import {
  ListingActions,
  ListingDescription,
  ListingLocation,
  ListingOverview,
  ListingPracticalDetails,
} from "./SaleListing";
import { ListingBudget } from "./ListingBudget";

vi.mock("@/components/FavoriteButton", () => ({
  FavoriteButton: () => <button>Suivre cette vente</button>,
}));
vi.mock("@/components/MapboxPreviewButton", () => ({
  MapboxPreviewButton: ({ label }: { label: string }) => <button>{label}</button>,
}));
vi.mock("@/components/MapThumbnail", () => ({ MapThumbnail: () => <div>Carte</div> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const item = (values: Partial<AuctionSale> = {}): AuctionSale => ({ ...EXAMPLE_SALE, ...values });
const notary = () =>
  item({
    sale_venue_type: "notary",
    sale_legal_framework: "judicial_partition",
    sale_procedure: null,
    source_blocks: null,
    sale_verification_status: "verified",
    tribunal_name: "Stale court data",
    lawyer_name: "Étude du Centre",
  });

describe("readable listing sections", () => {
  it("does not promote a stale generated description over current dossier facts", () => {
    render(
      <ListingDescription
        sale={item({
          llm_display_description: "Visites programmées le 3 août. Libre de toute occupation.",
          occupancy_status: "rented",
          source_description: "Le logement est loué avec bail en cours.",
        })}
      />,
    );
    const section = screen.getByRole("region", { name: "Description" });
    expect(section.textContent).not.toContain("Visites programmées le 3 août");
    expect(section.textContent).not.toContain("Libre de toute occupation");
    expect(section.textContent).toContain("Loué");
    expect(section.querySelector("details")?.textContent).toContain(
      "Le logement est loué avec bail en cours.",
    );
  });

  it.each(["cancelled", "canceled", "postponed"])(
    "does not present stored dates as confirmed appointments for %s",
    (status) => {
      render(
        <ListingPracticalDetails sale={item({ status, sale_date: "2099-01-01T12:00:00Z" })} />,
      );
      expect(
        screen.getByText(
          status === "postponed" ? "Vente reportée · nouvelle date à confirmer" : "Vente annulée",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          /Les dates conservées dans le dossier ne confirment pas un nouveau rendez-vous/,
        ),
      ).toBeTruthy();
    },
  );

  it("shows both boundaries of a multi-day bidding window in Paris time", () => {
    render(
      <ListingPracticalDetails
        sale={item({
          sale_procedure: {
            sale_window: {
              opens_at: "2026-09-16T13:00:00Z",
              closes_at: "2026-09-17T13:00:00Z",
            },
          },
        })}
      />,
    );
    expect(screen.getByText("Ouverture")).toBeTruthy();
    expect(screen.getByText("Clôture")).toBeTruthy();
    expect(screen.getByText(/16 septembre 2026/)).toBeTruthy();
    expect(screen.getByText(/17 septembre 2026/)).toBeTruthy();
  });
  it("keeps the visit slot visible and folds the full sale conditions", () => {
    const { container } = render(
      <ListingPracticalDetails
        sale={item({
          visit_dates: [
            "Visite le 4 septembre 2026 de 10 h à 11 h CONDITIONS DE LA VENTE Consulter le cahier auprès de l’avocat.",
          ],
        })}
      />,
    );
    expect(screen.getByText(/Visite le 4 septembre 2026 de 10 h à 11 h/)).toBeTruthy();
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Consulter le cahier auprès de l’avocat.");
    fireEvent.click(screen.getByText("Conditions de la source"));
    expect(details?.querySelector("p")?.textContent).toContain("CONDITIONS DE LA VENTE");
  });

  it("leads with the starting price and four labeled facts", () => {
    render(<ListingOverview sale={item()} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Bordeaux");
    expect(screen.getByText("42,6 m²")).toBeTruthy();
    expect(screen.getByText("Surface Carrez")).toBeTruthy();
    expect(screen.getAllByRole("term")).toHaveLength(4);
    expect(screen.getByText("Prix de départ, hors frais")).toBeTruthy();
    expect(screen.getByRole("link", { name: /rendez-vous/ }).getAttribute("href")).toBe(
      "#rendez-vous",
    );
  });
  it("does not show zero or invalid amounts as known property facts", () => {
    const { container } = render(
      <ListingOverview
        sale={item({
          app_surface_m2: null,
          carrez_surface_m2: null,
          habitable_surface_m2: null,
          starting_price_eur: 0,
          rooms_count: null,
          occupancy_status: null,
        })}
      />,
    );
    expect(screen.getAllByText("À confirmer").length).toBeGreaterThanOrEqual(4);
    expect(container.textContent).not.toContain("0 €");
    expect(container.textContent).not.toContain("NaN");
  });
  it("shows the actual visits and an actionable dossier contact", () => {
    render(<ListingPracticalDetails sale={item()} />);
    expect(screen.getByRole("heading").textContent).toBe("L’audience et les visites");
    expect(screen.getByText("2 octobre 2026 · 14:00")).toBeTruthy();
    expect(screen.getByText("7 octobre 2026 · 10:30")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "contact-demo@immojudis.fr" }).getAttribute("href"),
    ).toBe("mailto:contact-demo@immojudis.fr");
    expect(screen.getByText(/n’est pas automatiquement votre représentant/)).toBeTruthy();
  });
  it("does not call a notarial event a court hearing", () => {
    const { container } = render(<ListingPracticalDetails sale={notary()} />);
    expect(screen.getByRole("heading").textContent).toBe("La vente et les visites");
    expect(container.textContent).not.toContain("Stale court data");
    expect(container.textContent).not.toContain("Avocat poursuivant");
  });
  it("provides the source text in a native disclosure and escapes its content", () => {
    const { container } = render(
      <ListingDescription
        sale={item({
          source_description: "<script>alert(1)</script>",
          source_url: "javascript:alert(1)",
        })}
      />,
    );
    expect(screen.queryByText(/Synthèse rédigée par IA/)).toBeNull();
    const disclosure = container.querySelector("details");
    expect(disclosure).toBeTruthy();
    expect(disclosure?.open).toBe(false);
    fireEvent.click(screen.getByText("Afficher le texte de l’annonce source"));
    expect(disclosure?.open).toBe(true);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: /Consulter l’annonce source/ })).toBeNull();
  });
  it("does not repeat identical source and display descriptions", () => {
    const { container } = render(
      <ListingDescription
        sale={item({ source_description: buildStructuredDescription(item()) })}
      />,
    );
    expect(container.querySelector("details")).toBeNull();
  });
  it("does not invent a location or offer a broken map interaction", () => {
    render(<ListingLocation sale={item({ latitude: NaN })} />);
    expect(screen.queryByText("Carte")).toBeNull();
    expect(screen.queryByRole("button", { name: "Explorer le quartier" })).toBeNull();
    expect(screen.getByText(/lorsque les coordonnées/)).toBeTruthy();
  });
  it("uses the existing map when coordinates exist", () => {
    render(<ListingLocation sale={item()} />);
    expect(screen.getByText("Carte")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Explorer le quartier" })).toBeTruthy();
    expect(screen.getByText(/Localisation indicative/)).toBeTruthy();
  });
});

describe("budget preparation", () => {
  it("does not label incomplete inputs as a total or assume a flat fee percentage", () => {
    const { container } = render(<ListingBudget sale={item()} />);
    fireEvent.click(screen.getByText("Simuler mon budget"));
    expect(container.textContent).not.toContain("8–12");
    expect(screen.getByRole("status").textContent).toContain("budget incomplet");
    expect(screen.queryByText("Total de vos hypothèses")).toBeNull();
    fireEvent.change(screen.getByLabelText("Ensemble des frais d’acquisition (€)"), {
      target: { value: "8 000" },
    });
    expect(screen.getByRole("status").textContent).toContain("budget incomplet");
    fireEvent.change(screen.getByLabelText("Travaux et autres dépenses (€)"), {
      target: { value: "20 000" },
    });
    expect(screen.getByRole("status").textContent).toContain("Total de vos hypothèses");
    expect(screen.getByRole("status").textContent?.replace(/\s/g, "")).toContain("120000€");
    fireEvent.change(screen.getByLabelText("Ensemble des frais d’acquisition (€)"), {
      target: { value: "-8" },
    });
    expect(
      screen.getByLabelText("Ensemble des frais d’acquisition (€)").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("budget incomplet");
  });
  it("accepts an explicit zero works budget, never a zero purchase price", () => {
    render(<ListingBudget sale={item()} />);
    fireEvent.click(screen.getByText("Simuler mon budget"));
    fireEvent.change(screen.getByLabelText("Ensemble des frais d’acquisition (€)"), {
      target: { value: "8000" },
    });
    fireEvent.change(screen.getByLabelText("Travaux et autres dépenses (€)"), {
      target: { value: "0" },
    });
    expect(screen.getByText("Total de vos hypothèses")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Prix d’achat envisagé (€)"), {
      target: { value: "0" },
    });
    expect(screen.getByRole("status").textContent).toContain("Prix d’achat à renseigner");
  });
  it("adapts fee categories to notarial sales", () => {
    const { container } = render(<ListingBudget sale={notary()} />);
    expect(screen.getByText("Notaire")).toBeTruthy();
    expect(container.textContent).not.toContain("Avocat");
    expect(screen.getByRole("link", { name: /conditions de vente/ }).getAttribute("href")).toBe(
      "#participation",
    );
  });
  it("does not turn an absent starting price into zero", () => {
    render(<ListingBudget sale={item({ starting_price_eur: null })} />);
    fireEvent.click(screen.getByText("Simuler mon budget"));
    expect(screen.getByText("Budget à compléter")).toBeTruthy();
    expect(within(screen.getByRole("status")).getByText("Prix d’achat à renseigner")).toBeTruthy();
  });
});

describe("listing actions", () => {
  it("copies a clean URL without the return-search state", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ListingActions sale={item()} publicDemo />);
    fireEvent.click(screen.getByRole("button", { name: "Partager cette annonce" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).not.toContain("from=");
    expect(screen.queryByRole("button", { name: "Suivre cette vente" })).toBeNull();
  });
  it("only mounts favorites for a real persisted sale", () => {
    render(<ListingActions sale={item({ id: "11111111-1111-4111-8111-111111111111" })} />);
    expect(screen.getByRole("button", { name: "Suivre cette vente" })).toBeTruthy();
  });
});
