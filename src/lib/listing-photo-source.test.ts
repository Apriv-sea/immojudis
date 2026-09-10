import { expect, it } from "vitest";
import { canOptimizeListingPhoto } from "./listing-photo-source";

it("allows the measured provider's public property photos", () => {
  expect(
    canOptimizeListingPhoto("https://avoventes.fr/public/uploads/cabinet/286/images/property.png"),
  ).toBe(true);
});
it.each([
  "https://other.example/public/uploads/cabinet/286/images/property.png",
  "https://avoventes.fr.evil.example/public/uploads/cabinet/286/images/property.png",
  "https://user:password@avoventes.fr/public/uploads/cabinet/286/images/property.png",
  "https://avoventes.fr/public/uploads/cabinet/286/images/property.png?token=private",
  "https://avoventes.fr/public/uploads/cabinet/286/documents/diagnostic.pdf",
  "http://127.0.0.1/image.png",
  "data:image/png;base64,AAA",
])("does not proxy unapproved or signed sources: %s", (source) => {
  expect(canOptimizeListingPhoto(source)).toBe(false);
});
