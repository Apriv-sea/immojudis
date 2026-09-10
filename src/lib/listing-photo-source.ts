// Public property photos from the provider measured as the listing's LCP bottleneck.
// Keep the server allowlist narrow: no signed URLs or arbitrary remote image proxying.
export const listingPhotoRemotePatterns = [
  {
    protocol: "https" as const,
    hostname: "avoventes.fr",
    port: "",
    pathname: "/public/uploads/cabinet/*/images/**",
    search: "",
  },
];

export function canOptimizeListingPhoto(source: string): boolean {
  try {
    const url = new URL(source);
    return (
      url.protocol === "https:" &&
      url.hostname === "avoventes.fr" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/public\/uploads\/cabinet\/\d+\/images\/[^/]+\.(?:png|jpe?g|webp|avif)$/i.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}
