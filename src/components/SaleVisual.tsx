import { useCallback, useEffect, useRef, useState } from "react";
import ImageOff from "lucide-react/dist/esm/icons/image-off.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import type { AuctionSale } from "@/lib/types";
import { cn } from "@/lib/utils";
import { mapboxSatelliteImageUrl, mapboxStaticImageUrl } from "@/lib/mapbox";
import { propertyImages, shouldRejectRenderedPropertyImage } from "@/lib/sale-media";

type SaleVisualProps = {
  sale: AuctionSale;
  title: string;
  locked?: boolean;
  className?: string;
  eager?: boolean;
  mapWidth?: number;
  mapHeight?: number;
  preferPhoto?: boolean;
};

type VisualCandidate = {
  kind: "map" | "photo" | "satellite";
  url: string;
  label: string;
};

type VisualSelection = {
  saleId: string;
  index: number;
  exhausted: boolean;
  loadedUrl: string | null;
};

export function SaleVisual({
  sale,
  title,
  locked = false,
  className = "",
  eager = false,
  mapWidth = 896,
  mapHeight = 672,
  preferPhoto = false,
}: SaleVisualProps) {
  const photos = locked ? [] : propertyImages(sale.media);
  const hasCoordinates = sale.latitude != null && sale.longitude != null;
  const hasPreciseAddress = Boolean(sale.address?.trim());
  const satelliteUrl =
    !locked && hasCoordinates && hasPreciseAddress
      ? mapboxSatelliteImageUrl({
          lat: sale.latitude as number,
          lng: sale.longitude as number,
          zoom: 17,
          width: mapWidth,
          height: mapHeight,
        })
      : "";
  const sectorMapUrl =
    !locked && hasCoordinates && !hasPreciseAddress
      ? mapboxStaticImageUrl({
          lat: sale.latitude as number,
          lng: sale.longitude as number,
          zoom: 12,
          width: mapWidth,
          height: mapHeight,
        })
      : "";
  const photoCandidates: VisualCandidate[] = photos.map((photo) => ({
    kind: "photo",
    url: photo.url,
    label: "Photo du bien",
  }));
  const candidates: VisualCandidate[] = [
    ...(preferPhoto ? photoCandidates : []),
    ...(satelliteUrl
      ? [{ kind: "satellite" as const, url: satelliteUrl, label: "Vue aérienne Mapbox" }]
      : []),
    ...(sectorMapUrl
      ? [{ kind: "map" as const, url: sectorMapUrl, label: "Carte du secteur Mapbox" }]
      : []),
    ...(preferPhoto ? [] : photoCandidates),
  ];
  const imageRef = useRef<HTMLImageElement>(null);
  const [selection, setSelection] = useState<VisualSelection>({
    saleId: sale.id,
    index: 0,
    exhausted: false,
    loadedUrl: null,
  });
  const activeSelection =
    selection.saleId === sale.id
      ? selection
      : { saleId: sale.id, index: 0, exhausted: false, loadedUrl: null };
  const candidate = activeSelection.exhausted ? null : (candidates[activeSelection.index] ?? null);
  const candidateCount = candidates.length;
  const candidateUrl = candidate?.url ?? "";
  const candidateKind = candidate?.kind ?? null;
  const candidateIsReady = Boolean(candidate && activeSelection.loadedUrl === candidate.url);

  const rejectCandidate = useCallback(() => {
    setSelection((current) => {
      const index = current.saleId === sale.id ? current.index : 0;
      const nextIndex = index + 1;
      return {
        saleId: sale.id,
        index: nextIndex,
        exhausted: nextIndex >= candidateCount,
        loadedUrl: null,
      };
    });
  }, [candidateCount, sale.id]);

  const markCandidateReady = useCallback(() => {
    if (!candidateUrl) return;

    setSelection((current) => {
      const index = current.saleId === sale.id ? current.index : 0;
      if (current.saleId === sale.id && current.loadedUrl === candidateUrl) return current;

      return {
        saleId: sale.id,
        index,
        exhausted: false,
        loadedUrl: candidateUrl,
      };
    });
  }, [candidateUrl, sale.id]);

  useEffect(() => {
    const image = imageRef.current;
    if (!candidateUrl || !image?.complete) return;

    // An external image can fail before React hydration attaches onError.
    // Re-check the browser's settled image state so the fallback still advances.
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      (candidateKind === "photo" && shouldRejectRenderedPropertyImage(image))
    ) {
      rejectCandidate();
      return;
    }

    markCandidateReady();
  }, [candidateKind, candidateUrl, markCandidateReady, rejectCandidate]);

  if (!candidate) {
    return (
      <div
        className={cn(
          "relative flex h-full w-full items-center justify-center overflow-hidden bg-[linear-gradient(145deg,#e5f1fb,#fffaf2)]",
          className,
        )}
      >
        <div className="absolute inset-0 opacity-35 [background-image:radial-gradient(circle_at_22%_18%,rgba(15,118,110,0.22),transparent_28%),linear-gradient(135deg,transparent_45%,rgba(201,141,69,0.16)_46%,transparent_47%)]" />
        <div className="relative px-4 text-center text-brand-navy/75">
          {locked ? (
            <LockKeyhole className="mx-auto h-7 w-7" aria-hidden />
          ) : (
            <ImageOff className="mx-auto h-7 w-7" aria-hidden />
          )}
          <span className="mt-2 block text-xs font-semibold">
            {locked ? "Visuel réservé" : "Aucun visuel fiable"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("relative h-full w-full overflow-hidden bg-muted", className)}
      aria-busy={!candidateIsReady}
    >
      {!candidateIsReady ? (
        <div
          className="absolute inset-0 animate-pulse bg-[linear-gradient(110deg,#e8f1f6_25%,#f7fafc_45%,#e8f1f6_65%)] bg-[length:220%_100%]"
          aria-hidden
        />
      ) : null}
      <img
        ref={imageRef}
        key={candidate.url}
        src={candidate.url}
        alt={
          candidate.kind === "photo"
            ? title
            : candidate.kind === "satellite"
              ? `Vue aérienne de ${title}`
              : `Carte du secteur de ${title}`
        }
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "auto"}
        decoding="async"
        referrerPolicy="strict-origin-when-cross-origin"
        onError={rejectCandidate}
        onLoad={(event) => {
          if (
            candidate.kind === "photo" &&
            shouldRejectRenderedPropertyImage(event.currentTarget)
          ) {
            rejectCandidate();
            return;
          }
          markCandidateReady();
        }}
        className={`h-full w-full object-cover text-transparent transition duration-500 group-hover:scale-[1.025] ${
          candidateIsReady ? "opacity-100" : "opacity-0"
        }`}
      />
      {candidateIsReady ? (
        <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/65 bg-[#07111f]/78 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.08em] text-white shadow-sm backdrop-blur">
          {candidate.label}
        </span>
      ) : null}
    </div>
  );
}
