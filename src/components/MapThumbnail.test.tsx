// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapThumbnail } from "./MapThumbnail";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
describe("listing map price marker", () => {
  it("keeps map attribution and removes the price marker if the map fails", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    render(<MapThumbnail lat={44.84} lng={-0.58} markerLabel="92 000 €" />);
    expect(screen.getByText("92 000 €")).toBeTruthy();
    expect(screen.getByRole("link")).toBeTruthy();
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByText("92 000 €")).toBeNull();
    expect(screen.getByText("Aperçu Mapbox indisponible")).toBeTruthy();
  });
  it("does not render a price marker when the map is unavailable", () => {
    render(<MapThumbnail lat={null} lng={null} markerLabel="92 000 €" />);
    expect(screen.queryByText("92 000 €")).toBeNull();
    expect(screen.getByText("Pas de localisation")).toBeTruthy();
  });
});
