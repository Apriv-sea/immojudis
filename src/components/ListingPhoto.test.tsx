// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ImageConfigContext } from "next/dist/shared/lib/image-config-context.shared-runtime";
import { imageConfigDefault } from "next/dist/shared/lib/image-config";
import { listingPhotoRemotePatterns } from "@/lib/listing-photo-source";
import { ListingPhoto } from "./ListingPhoto";

afterEach(cleanup);

it("replaces a failed external photo with an accessible placeholder and retries a new source", () => {
  const view = render(<ListingPhoto src="https://example.test/first.jpg" alt="Salon" />);
  fireEvent.error(screen.getByRole("img", { name: "Salon" }));
  expect(screen.getByRole("img", { name: "Salon : indisponible" })).toBeTruthy();
  expect(screen.getByText("Photo indisponible")).toBeTruthy();
  view.rerender(<ListingPhoto src="https://example.test/second.jpg" alt="Cuisine" />);
  expect(screen.getByRole("img", { name: "Cuisine" }).getAttribute("src")).toBe(
    "https://example.test/second.jpg",
  );
  expect(screen.queryByText("Photo indisponible")).toBeNull();
});

it("serves responsive variants and falls back to the source if optimization fails", async () => {
  const source = "https://avoventes.fr/public/uploads/cabinet/286/images/property.png";
  render(
    <ImageConfigContext.Provider
      value={{ ...imageConfigDefault, remotePatterns: listingPhotoRemotePatterns }}
    >
      <ListingPhoto src={source} alt="Salon optimisé" fetchPriority="high" />
    </ImageConfigContext.Provider>,
  );
  const optimized = await screen.findByRole("img", { name: "Salon optimisé" });
  expect(optimized.getAttribute("src")).toContain("/_next/image?");
  expect(optimized.getAttribute("srcset")).toContain("640w");
  expect(optimized.getAttribute("loading")).toBe("eager");
  fireEvent.error(optimized);
  expect(screen.getByRole("img", { name: "Salon optimisé" }).getAttribute("src")).toBe(source);
  fireEvent.error(screen.getByRole("img", { name: "Salon optimisé" }));
  expect(screen.getByRole("img", { name: "Salon optimisé : indisponible" })).toBeTruthy();
});
