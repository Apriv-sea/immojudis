// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyReportActions } from "./PropertyReportActions";

const mocks = vi.hoisted(() => ({
  user: { id: "investor" } as { id: string } | null,
  loading: false,
  navigate: vi.fn(),
  fetchReports: vi.fn(),
  save: vi.fn(),
  exportPdf: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  createUrl: vi.fn(),
  revokeUrl: vi.fn(),
  share: vi.fn(),
  unshare: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user, loading: mocks.loading }),
}));
vi.mock("@/lib/router-compat", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/lib/client-api", () => ({
  fetchPropertyReports: mocks.fetchReports,
  savePropertyReport: mocks.save,
  exportPropertyReportPdf: mocks.exportPdf,
  updatePropertyReport: vi.fn(),
  enablePropertyReportShare: mocks.share,
  disablePropertyReportShare: mocks.unshare,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: "investor" };
  mocks.loading = false;
  mocks.fetchReports.mockResolvedValue({ reports: [], plan: null });
  mocks.save.mockResolvedValue({ report: { id: "report-new" }, plan: null });
  mocks.exportPdf.mockResolvedValue({ blob: new Blob(["%PDF-1.4"]), filename: "analyse.pdf" });
  mocks.createUrl.mockReturnValue("blob:test-report");
  vi.stubGlobal("URL", { createObjectURL: mocks.createUrl, revokeObjectURL: mocks.revokeUrl });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderActions(props: Partial<React.ComponentProps<typeof PropertyReportActions>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = () => (
    <QueryClientProvider client={client}>
      <PropertyReportActions saleId="sale-1" compact {...props} />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return { ...rendered, update: () => rendered.rerender(view()) };
}

describe("report export from the listing", () => {
  it("shares the current simulation from the compact listing and revokes the link", async () => {
    const simulation = {
      price: 100000,
      works: 31000,
      fpt: 5000,
      scenario: "prudent" as const,
      manualMarketPricePerM2: null,
      expectedMaxBid: 90000,
    };
    mocks.share.mockResolvedValue({
      report: { id: "report-new", share_enabled: true },
      plan: null,
      share: { url: "https://example.test/reports/shared/test" },
    });
    mocks.unshare.mockResolvedValue({
      report: { id: "report-new", share_enabled: false },
      plan: null,
    });
    vi.stubGlobal("navigator", { clipboard: { writeText: mocks.copy } });
    renderActions({ simulation, requireSimulation: true });
    fireEvent.click(screen.getByRole("button", { name: "Partager le rapport" }));
    await waitFor(() => expect(mocks.share).toHaveBeenCalledWith({ reportId: "report-new" }));
    expect(mocks.save).toHaveBeenCalledWith({ data: expect.objectContaining({ simulation }) });
    await waitFor(() =>
      expect(mocks.copy).toHaveBeenCalledWith("https://example.test/reports/shared/test"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Désactiver le lien du rapport" }));
    await waitFor(() => expect(mocks.unshare).toHaveBeenCalledWith({ reportId: "report-new" }));
    await screen.findByRole("button", { name: "Partager le rapport" });
  });

  it("keeps actions disabled until session verification finishes", async () => {
    mocks.loading = true;
    const view = renderActions();
    expect(
      (screen.getByRole("button", { name: "Sauvegarder le rapport" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Export PDF" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    mocks.loading = false;
    view.update();
    fireEvent.click(screen.getByRole("button", { name: "Sauvegarder le rapport" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  });
  it("saves the current simulation before exporting even when a report already exists", async () => {
    const simulation = {
      price: 100000,
      works: 20000,
      fpt: 5000,
      scenario: "prudent" as const,
      manualMarketPricePerM2: null,
      expectedMaxBid: 90000,
    };
    mocks.fetchReports.mockResolvedValue({ reports: [{ id: "report-existing" }], plan: null });
    renderActions({ simulation, requireSimulation: true });
    await screen.findByRole("button", { name: "Rapport sauvegardé" });
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(mocks.exportPdf).toHaveBeenCalledWith({ reportId: "report-new" }));
    expect(mocks.save).toHaveBeenCalledWith({ data: expect.objectContaining({ simulation }) });
  });

  it("cannot silently export defaults while the current simulation is unavailable", () => {
    renderActions({ requireSimulation: true });
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.exportPdf).not.toHaveBeenCalled();
  });

  it("does not reuse another account's cached report on the same property", async () => {
    mocks.fetchReports.mockResolvedValue({ reports: [{ id: "report-account-a" }], plan: null });
    const view = renderActions();
    await screen.findByRole("button", { name: "Rapport sauvegardé" });
    mocks.user = { id: "account-b" };
    mocks.fetchReports.mockResolvedValue({ reports: [], plan: null });
    view.update();
    expect(screen.queryByRole("button", { name: "Rapport sauvegardé" })).toBeNull();
    await waitFor(() => expect(mocks.fetchReports).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(mocks.exportPdf).toHaveBeenCalledWith({ reportId: "report-new" }));
    expect(mocks.exportPdf).not.toHaveBeenCalledWith({ reportId: "report-account-a" });
  });
  it("saves a report, exports that report and starts the download", async () => {
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("PDF exporté."));
    expect(mocks.save).toHaveBeenCalledWith({
      data: { saleId: "sale-1", reportKind: "opportunity", title: undefined, userNotes: undefined },
    });
    expect(mocks.exportPdf).toHaveBeenCalledWith({ reportId: "report-new" });
    expect(mocks.createUrl).toHaveBeenCalledOnce();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(mocks.revokeUrl).toHaveBeenCalledWith("blob:test-report");
  });
  it("reuses an existing report", async () => {
    mocks.fetchReports.mockResolvedValue({ reports: [{ id: "report-existing" }], plan: null });
    renderActions();
    await screen.findByRole("button", { name: "Rapport sauvegardé" });
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    await waitFor(() =>
      expect(mocks.exportPdf).toHaveBeenCalledWith({ reportId: "report-existing" }),
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("does not download or announce success after a denied export", async () => {
    mocks.exportPdf.mockRejectedValue(new Error("Export PDF réservé au plan Analyse."));
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Export PDF réservé au plan Analyse."),
    );
    expect(mocks.createUrl).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalledWith("PDF exporté.");
  });
  it("requires authentication before any report write or export", () => {
    mocks.user = null;
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/login" }));
    expect(mocks.fetchReports).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.exportPdf).not.toHaveBeenCalled();
  });
});
