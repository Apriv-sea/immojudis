// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { EXAMPLE_SALE_RECORDS } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import type { MarketEstimate } from "@/lib/market.functions";
import { AnalysisSaleDetailView, FreeSaleDetailView } from "./SimplifiedSaleDetailView";

const mocks = vi.hoisted(() => ({ fetchMarket: vi.fn(), forecast: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("@/lib/client-api", () => ({ fetchPrecomputedMarketEstimate: mocks.fetchMarket }));
vi.mock("@/lib/router-compat", () => ({
  Link: ({ to, href, children, ...props }: { to?: string; href?: string; children: ReactNode }) => (
    <a href={href ?? to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/FavoriteButton", () => ({
  FavoriteButton: () => <button>Suivre cette vente</button>,
}));
vi.mock("@/components/MapboxPreviewButton", () => ({
  MapboxPreviewButton: ({ label }: { label: string }) => <button>{label}</button>,
}));
vi.mock("@/components/MapThumbnail", () => ({ MapThumbnail: () => <div>Carte</div> }));
vi.mock("@/components/SaleVisual", () => ({ SaleVisual: () => <div>Visuel indisponible</div> }));
vi.mock("@/components/BillingActions", () => ({
  BillingActions: () => <button>Découvrir l’offre Analyse</button>,
}));
vi.mock("@/components/DocumentsList", () => ({ DocumentsList: () => <p>Pièces du dossier</p> }));
vi.mock("@/components/InformationRequestAgent", () => ({
  InformationRequestAgent: () => <div id="information-agent">Enquête réservée à l’analyse</div>,
}));
vi.mock("@/components/LawyerReferralButton", () => ({
  LawyerReferralButton: () => <button>Contacter un avocat</button>,
}));
vi.mock("@/components/SaleTribunalHistory", () => ({
  SaleTribunalHistory: () => <section id="tribunal-history">Historique du tribunal</section>,
}));
vi.mock("@/hooks/use-outcome-graph-forecast", () => ({
  useOutcomeGraphForecast: (id: string, enabled: boolean) => {
    return mocks.forecast(id, enabled) ?? {};
  },
}));
vi.mock("next/dynamic", () => ({
  default: () =>
    function LazyDetail({
      images,
      onClose,
      saleId,
      sale,
      previewOnly,
      marketEstimateOverride,
      forecastQuery,
      premium,
    }: {
      images?: unknown[];
      onClose?: () => void;
      saleId?: string;
      sale?: AuctionSale;
      previewOnly?: boolean;
      marketEstimateOverride?: unknown;
      forecastQuery?: unknown;
      premium?: boolean;
    }) {
      if (forecastQuery) return <section>Prévision de l’audience chargée</section>;
      if (sale && previewOnly !== undefined) {
        return <div id="information-agent">Enquête réservée à l’analyse</div>;
      }
      if (sale && marketEstimateOverride === undefined) {
        return (
          <section id="tribunal-history" data-premium={premium ? "true" : "false"}>
            Historique du tribunal
          </section>
        );
      }
      if (saleId) return <button data-sale-id={saleId}>Export PDF</button>;
      return images ? (
        <div role="dialog" aria-label="Galerie photos">
          <button onClick={onClose}>Fermer les photos</button>
        </div>
      ) : (
        <div>Simulateur de mise plafond chargé</div>
      );
    },
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function renderDetail(
  access: "analysis" | "discovery",
  sale = EXAMPLE_SALE_RECORDS.bordeaux.sale,
  publicDemo = true,
  adjudicationStatisticsEnabled = false,
  marketEstimate: MarketEstimate = EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {access === "analysis" ? (
        <AnalysisSaleDetailView
          sale={sale}
          marketEstimateOverride={marketEstimate}
          publicDemo={publicDemo}
          adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
        />
      ) : (
        <FreeSaleDetailView sale={sale} />
      )}
    </QueryClientProvider>,
  );
}

describe("integrated listing", () => {
  it("distingue l’historique d’adresse des comparables proches", () => {
    const { container } = renderDetail("analysis", undefined, true, false, {
      ...EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate,
      comparableMode: "address_history",
      sampleSize: 0,
      recentTransactions: [],
    });
    const market = container.querySelector("#market")!;
    expect(market.textContent).toContain("1 vente à cette adresse");
    expect(market.textContent).toContain("Historique des ventes à cette adresse");
    expect(market.textContent).toContain("lots différents");
    expect(market.textContent).not.toContain("Rayon de recherche");
    expect(market.textContent).not.toContain("Ventes de référence à proximité");
    expect(market.querySelectorAll("li")).toHaveLength(1);
  });

  it("identifie le périmètre agrégé sans promettre des comparables locaux", () => {
    const { container } = renderDetail("analysis", undefined, true, false, {
      ...EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate,
      comparableMode: "geographic_aggregate",
      geographyLevel: "department",
      recentTransactions: [],
    });
    const market = container.querySelector("#market")!;
    expect(market.textContent).toContain("12 ventes de référence");
    expect(market.textContent).toContain("Échelle du département");
    expect(market.textContent).not.toContain("Rayon de recherche");
    expect(market.querySelector('[aria-label="Comparables de marché"]')).toBeNull();
  });

  it.each([6, 7])(
    "qualifie prudemment %s comparables malgré une qualité enregistrée forte",
    (sampleSize) => {
      const { container } = renderDetail("analysis", undefined, true, false, {
        ...EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate,
        sampleSize,
        qualityScore: 95,
        qualityLabel: "forte",
      });
      const market = container.querySelector("#market")!;
      expect(market.textContent).toContain("Échantillon DVF exploitable avec prudence");
      expect(market.textContent).not.toContain("forte");
      expect(market.textContent).not.toContain("Échantillon DVF solide");
    },
  );

  it("expose les limites de marché à côté de la qualité des données", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const estimate = {
      ...EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate,
      qualityWarnings: ["Échantillon incomplet pour la dernière année."],
    };
    const { container } = render(
      <QueryClientProvider client={client}>
        <AnalysisSaleDetailView
          sale={EXAMPLE_SALE_RECORDS.bordeaux.sale}
          marketEstimateOverride={estimate}
          publicDemo
        />
      </QueryClientProvider>,
    );
    const market = container.querySelector("#market")!;
    expect(market.textContent).toContain("Solidité des références");
    expect(market.textContent).toContain(`Source : ${estimate.source}`);
    expect(market.textContent).toContain(`Période de recherche : ${estimate.yearsBack} ans`);
    expect(market.textContent).toContain(`Rayon de recherche : ${estimate.radiusM} m`);
    expect(market.textContent).toContain("Échantillon incomplet pour la dernière année.");
    expect(market.textContent).toContain("Il ne garantit ni le prix de revente");
  });

  it("does not present a notarial venue as an identified organizer", () => {
    const { container } = renderDetail("analysis", {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      sale_procedure: {},
      sale_venue_type: "notary",
      lawyer_name: null,
      lawyer_contact: null,
      sale_date: "2099-09-10T12:00:00Z",
      status: "upcoming",
    });
    const contacts = container.querySelector("#lawyer")!;
    expect(contacts.textContent).toContain("Organisateur à confirmer");
    expect(contacts.textContent).toContain("Coordonnées non renseignées");
    expect(contacts.textContent).not.toContain("Interlocuteur indiqué dans le dossier");
    expect(contacts.querySelector('a[href="#information-agent"]')?.textContent).toContain(
      "Demander les coordonnées",
    );
  });

  it("links a named organizer to the actual contact details", () => {
    const { container } = renderDetail("analysis", {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      sale_procedure: {},
      sale_venue_type: "notary",
      lawyer_name: "Étude de test",
      lawyer_contact: "contact@example.invalid",
      sale_date: "2099-09-10T12:00:00Z",
      status: "upcoming",
    });
    const contacts = container.querySelector("#lawyer")!;
    expect(contacts.textContent).toContain("Étude de test");
    expect(contacts.querySelector('a[href="#rendez-vous"]')?.textContent).toContain(
      "Consulter les coordonnées du dossier",
    );
  });

  it("retains the mandate action for a confirmed upcoming judicial sale", () => {
    renderDetail("analysis", {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      id: "9b923d06-df18-403d-9c95-a4655f043825",
      status: "upcoming",
      sale_date: "2099-09-10T12:00:00Z",
    });
    expect(screen.getByText("Prêt à enchérir ? Mandatez l’avocat compétent.")).toBeTruthy();
    expect(screen.getByText("Contacter un avocat")).toBeTruthy();
  });

  it("uses the elapsed date even when the stored status still says upcoming", () => {
    renderDetail("analysis", {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      status: "upcoming",
      sale_date: "2020-09-03T12:00:00Z",
    });
    expect(screen.queryByText("Prêt à enchérir ? Mandatez l’avocat compétent.")).toBeNull();
    expect(screen.getByText(/Contactez l’organisateur pour confirmer le résultat/)).toBeTruthy();
  });

  it.each(["past", "cancelled", "postponed"])(
    "does not solicit a bidding mandate for a %s sale",
    (status) => {
      renderDetail("analysis", {
        ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
        id: "9b923d06-df18-403d-9c95-a4655f043825",
        status,
      });
      expect(screen.queryByText("Prêt à enchérir ? Mandatez l’avocat compétent.")).toBeNull();
      expect(screen.queryByText("Contacter un avocat")).toBeNull();
      expect(screen.queryByText("Voir les avocats disponibles")).toBeNull();
      expect(screen.getByText(/Contactez l’organisateur pour confirmer le résultat/)).toBeTruthy();
      expect(
        screen
          .getByRole("link", { name: "Consulter les coordonnées du dossier" })
          .getAttribute("href"),
      ).toBe("#rendez-vous");
      expect(document.getElementById("rendez-vous")).toBeTruthy();
    },
  );

  it("does not infer a commercial surface from its room count", () => {
    renderDetail("analysis", {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      title: "Local commercial",
      property_type: "commercial",
      rooms_count: 2,
      app_surface_m2: null,
      app_surface_kind: null,
      surface_scope: null,
      habitable_surface_m2: null,
      carrez_surface_m2: null,
      land_surface_m2: null,
    });
    expect(
      screen.queryByText(/surface provisoire de 56 m² estimée à partir de 2 pièces/),
    ).toBeNull();
    expect(screen.getByText("Travaux inclus : À chiffrer")).toBeTruthy();
    expect(screen.queryByText("0 vente comparable")).toBeNull();
  });
  it("links a free conflicting listing to an available contact section", () => {
    renderDetail("discovery", {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      property_type: "land",
      source_blocks: { titre_detail: "Appartement T5" },
    });
    const link = screen.getByRole("link", { name: "Consulter les coordonnées du dossier" });
    expect(link.getAttribute("href")).toBe("#rendez-vous");
    expect(document.getElementById("rendez-vous")).not.toBeNull();
    expect(document.getElementById("information-agent")).toBeNull();
  });
  it("withholds cached valuation, simulation, export and matching-type statistics on a source type conflict", () => {
    renderDetail(
      "analysis",
      {
        ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
        property_type: "land",
        app_surface_m2: 4434,
        carrez_surface_m2: 97.16,
        source_blocks: { titre_detail: "Appartement T5 avec terrasse et garage" },
      },
      false,
      true,
    );
    expect(screen.getByRole("alert").textContent).toContain("Estimation suspendue");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Type de bien à confirmer");
    expect(screen.queryByText("Simulateur de mise plafond chargé")).toBeNull();
    expect(screen.queryByText("Export PDF")).toBeNull();
    expect(screen.queryByText("Fourchette de valeur estimée", { exact: false })).toBeNull();
    expect(screen.getByText("Le type de bien doit être confirmé", { exact: false })).toBeTruthy();
  });
  it.each([[], {}, [{ url: "javascript:alert(1)" }]])(
    "does not announce documents when no usable link exists: %j",
    (documents) => {
      renderDetail("analysis", { ...EXAMPLE_SALE_RECORDS.bordeaux.sale, documents });
      expect(screen.getByText("Aucune pièce attachée")).toBeTruthy();
      expect(screen.queryByText(/pièce\(s\) consultable/)).toBeNull();
    },
  );

  it("does not claim that an available diagnostic is a conditions-of-sale document", () => {
    renderDetail("analysis", {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      documents: [{ url: "https://example.test/diagnostic.pdf", type: "dpe" }],
    });
    expect(screen.getByText("1 pièce(s) consultable(s)")).toBeTruthy();
    expect(screen.queryByText("Document disponible")).toBeNull();
  });

  it("does not load an outcome forecast from a disabled query cache on the public demo", () => {
    mocks.forecast.mockReturnValue({ data: { forecast: { status: "ready" } } });
    const demo = renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, true);
    expect(screen.queryByText("Prévision de l’audience chargée")).toBeNull();
    demo.unmount();
    renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, false);
    expect(screen.getByText("Prévision de l’audience chargée")).toBeTruthy();
  });
  it("exposes report export on a real analysis, not on discovery or public demonstrations", () => {
    const sale = EXAMPLE_SALE_RECORDS.bordeaux.sale;
    const view = renderDetail("analysis", sale, false);
    expect(screen.getByRole("button", { name: "Export PDF" }).getAttribute("data-sale-id")).toBe(
      sale.id,
    );
    expect(screen.getByText(/scénario courant du simulateur/)).toBeTruthy();
    view.unmount();
    const demo = renderDetail("analysis", sale, true);
    expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull();
    demo.unmount();
    renderDetail("discovery", sale);
    expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull();
  });
  it("puts practical information before the analysis and keeps the gallery functional", () => {
    const { container } = renderDetail("analysis");
    const text = container.textContent ?? "";
    expect(text.indexOf("L’audience et les visites")).toBeLessThan(
      text.indexOf("Votre analyse ImmoJudis"),
    );
    const sections = [
      "summary",
      "risks",
      "documents",
      "budget-analysis",
      "market",
      "description-ia",
      "participation",
    ];
    const nodes = sections.map((id) => {
      const node = container.querySelector(`#${id}`);
      expect(node, `Missing section ${id}`).not.toBeNull();
      return node!;
    });
    nodes.slice(1).forEach((node, index) => {
      expect(
        nodes[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir la photo 1 sur 4" }));
    expect(screen.getByRole("dialog", { name: "Galerie photos" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fermer les photos" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens the existing advanced simulator from its primary action", () => {
    const { container } = renderDetail("analysis");
    expect((container.querySelector("#calculation") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByRole("link", { name: "Ajuster mes hypothèses" }));
    expect((container.querySelector("#calculation") as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByText("Simulateur de mise plafond chargé")).toBeTruthy();
  });
  it("keeps discovery access free of protected market and risk analysis", () => {
    renderDetail("discovery");
    expect(screen.getByRole("heading", { name: "Préparer mon budget" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "L’audience et les visites" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Marché local" })).toBeNull();
    expect(screen.queryByText("Enquête réservée à l’analyse")).toBeNull();
    expect(mocks.fetchMarket).not.toHaveBeenCalled();
    expect(mocks.forecast).not.toHaveBeenCalled();
  });
  it("active les résultats d’adjudication uniquement dans la fiche Analyse", () => {
    const analysis = renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, false, true);
    expect(document.querySelector("#tribunal-history")?.getAttribute("data-premium")).toBe("true");
    analysis.unmount();

    renderDetail("discovery", EXAMPLE_SALE_RECORDS.bordeaux.sale);
    expect(document.querySelector("#tribunal-history")?.getAttribute("data-premium")).toBe("false");
  });
  it.each(["notary", "state", "unknown"] as const)(
    "does not apply court-specific calculations or predictions to %s",
    (venue) => {
      const sale = {
        ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
        sale_venue_type: venue,
        sale_procedure: null,
        source_blocks: null,
      } as AuctionSale;
      const { container } = renderDetail("analysis", sale, false);
      expect(screen.getByRole("heading", { name: "La vente et les visites" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Marché local" })).toBeTruthy();
      expect(screen.queryByText("Votre mise plafond recommandée")).toBeNull();
      expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull();
      expect(container.querySelector("#calculation")).toBeNull();
      expect(screen.queryByText("Historique du tribunal")).toBeNull();
      expect(mocks.forecast).toHaveBeenCalledWith(sale.id, false);
    },
  );
  it("preserves the no-photo and no-location states", () => {
    renderDetail("discovery", {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      media: [],
      latitude: null,
      longitude: null,
    });
    expect(screen.getByText("Visuel indisponible")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ouvrir la galerie photos" })).toBeNull();
    expect(screen.getByText(/lorsque les coordonnées/)).toBeTruthy();
  });
  it("labels market references as DVF transactions, not auction results", () => {
    renderDetail("analysis");
    expect(
      screen.getByText(
        /Transactions DVF · ces prix ne constituent pas des résultats d’adjudication/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("list", { name: "Comparables de marché" })).toBeTruthy();
  });
  it("has no structural accessibility violations in the rendered discovery page", async () => {
    const { container } = renderDetail("discovery");
    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(
      result.violations.map((violation) => ({ id: violation.id, help: violation.help })),
    ).toEqual([]);
  });
});
