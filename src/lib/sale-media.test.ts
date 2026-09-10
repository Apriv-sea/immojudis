import { describe, expect, it } from "vitest";
import {
  isLikelyPropertyImageUrl,
  propertyImageUrlScore,
  propertyImages,
  shouldRejectRenderedPropertyImage,
} from "@/lib/sale-media";

describe("sale media selection", () => {
  it.each([
    "home",
    "avocat",
    "facebook",
    "fiche_precedente",
    "fiche_suivante",
    "fiche",
    "geoloc",
    "google",
    "photo",
    "retour_selection",
    "telec",
    "twitter",
    "www",
  ])("excludes Info-enchères navigation asset %s without excluding property photos", (name) => {
    expect(isLikelyPropertyImageUrl(`https://www.info-encheres.com/pix/${name}.png`)).toBe(false);
    expect(isLikelyPropertyImageUrl("https://www.info-encheres.com/photos/109177/maison.jpg")).toBe(
      true,
    );
    expect(isLikelyPropertyImageUrl("https://example.test/pix/photo.png")).toBe(true);
  });
  it.each([
    "https://encheresimmobilieres.fr/images/departements/34.webp",
    "https://encheresimmobilieres.fr/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fnewsletter-vae.1a3106b2.webp&w=1920&q=75",
    "https://encheresimmobilieres.fr/_next/image?url=%2Fimg%2Fprochainesventes.webp&w=256&q=75",
    "https://encheresimmobilieres.fr/_next/image?url=https%3A%2F%2Falpha.tribuca.pro%2Fimg%2Fjournaux_vae%2Fle-tout-lyon-affiches.jpg&w=640&q=75",
    "https://example.test/_next/image?url=javascript%3Aalert(1)",
  ])("rejects editorial and invalid images including optimized sources: %s", (url) => {
    expect(isLikelyPropertyImageUrl(url)).toBe(false);
  });

  it("deduplicates the same real photograph through different optimizer sizes", () => {
    const urls = [
      "https://example.test/photo/bien.jpg",
      "https://example.test/_next/image?url=%2Fphoto%2Fbien.jpg&w=1200&q=75",
    ];
    expect(propertyImages(urls.map((url) => ({ type: "image", url })))).toHaveLength(1);
    expect(isLikelyPropertyImageUrl(urls[1])).toBe(true);
  });
  it("rejects obvious branding and banner assets", () => {
    expect(isLikelyPropertyImageUrl("https://example.test/assets/logos/cabinet.png")).toBe(false);
    expect(isLikelyPropertyImageUrl("https://example.test/media/banner-home.webp")).toBe(false);
    expect(isLikelyPropertyImageUrl("https://example.test/photos/maison.webp")).toBe(true);
  });

  it("ranks original property photos ahead of thumbnails while keeping stable order", () => {
    const media = [
      { type: "image" as const, url: "https://example.test/thumb/sale-small.jpg" },
      { type: "image" as const, url: "https://example.test/photo/original-maison.jpg?w=1200" },
      { type: "image" as const, url: "https://example.test/gallery/interieur.jpg" },
    ];

    expect(propertyImages(media).map((item) => item.url)).toEqual([
      "https://example.test/photo/original-maison.jpg?w=1200",
      "https://example.test/gallery/interieur.jpg",
      "https://example.test/thumb/sale-small.jpg",
    ]);
    expect(propertyImageUrlScore(media[1].url)).toBeGreaterThan(
      propertyImageUrlScore(media[0].url),
    );
  });

  it("rejects low-resolution and extreme-aspect rendered images", () => {
    expect(
      shouldRejectRenderedPropertyImage({
        naturalWidth: 320,
        naturalHeight: 180,
      } as HTMLImageElement),
    ).toBe(true);
    expect(
      shouldRejectRenderedPropertyImage({
        naturalWidth: 1200,
        naturalHeight: 240,
      } as HTMLImageElement),
    ).toBe(true);
    expect(
      shouldRejectRenderedPropertyImage({
        naturalWidth: 1200,
        naturalHeight: 800,
      } as HTMLImageElement),
    ).toBe(false);
  });
});
