// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { DeferredInformationRequest } from "./DeferredInformationRequest";
vi.mock("next/dynamic", () => ({
  default: () =>
    function Form() {
      return <input aria-label="Destinataire" />;
    },
}));
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});
it("keeps keyboard navigation anchored to the stable form container", () => {
  render(<DeferredInformationRequest sale={{} as AuctionSale} previewOnly={false} />);
  window.history.replaceState(null, "", "/#information-agent");
  fireEvent(window, new HashChangeEvent("hashchange"));
  expect(document.activeElement).toBe(
    screen.getByRole("group", { name: "Demande d’informations" }),
  );
});
it("does not move focus for unrelated anchors", () => {
  render(
    <>
      <button>Autre action</button>
      <DeferredInformationRequest sale={{} as AuctionSale} previewOnly={false} />
    </>,
  );
  const button = screen.getByRole("button", { name: "Autre action" });
  button.focus();
  window.history.replaceState(null, "", "/#documents");
  fireEvent(window, new HashChangeEvent("hashchange"));
  expect(document.activeElement).toBe(button);
});
