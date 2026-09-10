import { Link } from "@/lib/router-compat";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import Calendar from "lucide-react/dist/esm/icons/calendar.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import { isNew } from "@/lib/dates";
import { dpeColor, extractDpe } from "@/lib/dpe";
import type { AuctionSale } from "@/lib/types";
import { formatPrice, formatDate, occupancyLabel, propertyTypeLabel } from "@/lib/format";
import { pricePerM2 } from "@/lib/geo";
import { saleDisplayTitle } from "@/lib/sale-title";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { SaleCountdown } from "./SaleCountdown";
import { SaleProcedureBadge } from "./SaleProcedurePanel";
import { SaleVisual } from "./SaleVisual";
import { useViewedSales } from "@/hooks/use-viewed-sales";

export function SaleCard({ sale, locked = false }: { sale: AuctionSale; locked?: boolean }) {
  const surfaceInfo = getSaleSurface(sale);
  const displaySurface = getDisplaySurface(sale);
  const surface = surfaceInfo.value;
  const riskCount = locked ? 0 : (sale.risks?.length ?? 0);
  const fresh = isNew(sale.created_at);
  const ppm = locked ? null : pricePerM2(sale.starting_price_eur, surface);
  const { isViewed } = useViewedSales();
  const viewed = !locked && isViewed(sale.id);
  const occLabel = locked ? "Accès membre" : occupancyLabel(sale.occupancy_status);
  const occChip =
    occLabel === "Libre"
      ? "chip-opportunity"
      : occLabel === "Occupé" || occLabel === "Loué"
        ? "chip-watch"
        : "chip-neutral";
  const propertyLabel = locked ? "Annonce réservée" : propertyTypeLabel(sale.property_type);
  const title = locked ? "Détail réservé aux membres" : saleDisplayTitle(sale, propertyLabel);
  const dpe = locked ? null : extractDpe(sale);
  const dpeTheme = dpeColor(dpe?.class);

  return (
    <Link
      to="/sales/$id"
      params={{ id: sale.id }}
      className={`group block h-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
        viewed ? "opacity-75" : ""
      }`}
    >
      <article className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-white shadow-sm transition duration-200 group-hover:-translate-y-0.5 group-hover:shadow-xl">
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
          <SaleVisual sale={sale} title={title} locked={locked} mapWidth={512} mapHeight={384} />
          <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/45 to-transparent" />
          <div className="absolute left-3 top-3 flex flex-wrap gap-2">
            {locked ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-white/40 bg-white/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground backdrop-blur">
                <LockKeyhole className="h-3 w-3" />
                Aperçu limité
              </span>
            ) : fresh ? (
              <span className="inline-flex items-center rounded-full border border-white/40 bg-white/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground backdrop-blur">
                Nouveau
              </span>
            ) : null}
            <SaleProcedureBadge sale={sale} />
            {locked ? null : <SaleCountdown date={sale.sale_date} />}
          </div>
          {viewed && (
            <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-white/40 bg-white/90 px-2.5 py-1 text-[10px] font-medium text-muted-foreground backdrop-blur">
              <Eye className="h-3 w-3" /> Vu
            </span>
          )}
          {dpe?.class ? (
            <span
              className="absolute bottom-3 left-3 inline-flex min-h-7 items-center rounded-md border px-2 text-[11px] font-extrabold shadow-sm"
              style={{
                backgroundColor: dpeTheme?.background,
                borderColor: dpeTheme?.border,
                color: dpeTheme?.foreground,
              }}
            >
              DPE {dpe.class}
            </span>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col gap-3 p-3.5">
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {propertyLabel}
              </span>
              <span className={`chip ${occChip}`}>
                <span aria-hidden className="chip-dot" />
                {occLabel}
              </span>
            </div>
            <h3 className="mt-2 line-clamp-2 min-h-[2.75rem] font-sans text-base font-semibold leading-snug text-foreground">
              {title}
            </h3>
            <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
              <MapPin className="h-3.5 w-3.5 text-gold-soft" />
              <span className="truncate">
                {locked
                  ? "Localisation réservée"
                  : `${sale.city ?? "—"}${sale.department ? ` (${sale.department})` : ""}`}
              </span>
            </div>
          </div>

          <div>
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              {formatPrice(sale.starting_price_eur)}
            </div>
            {ppm != null && (
              <div className="mt-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                {Math.round(ppm).toLocaleString("fr-FR")} €/m²
              </div>
            )}
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              <span>{locked ? "Date réservée" : formatDate(sale.sale_date)}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
            <CardMetric
              label={locked ? "Surface" : displaySurface.metricLabel}
              value={locked ? "Réservée" : displaySurface.value ? displaySurface.label : "—"}
            />
            <CardMetric
              label="Pièces"
              value={locked ? "Réservé" : sale.rooms_count != null ? String(sale.rooms_count) : "—"}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {locked ? (
              <span className="chip chip-watch">
                <span aria-hidden className="chip-dot" />
                Analyse réservée
              </span>
            ) : riskCount > 0 ? (
              <span className={`chip ${riskCount >= 3 ? "chip-risk" : "chip-watch"}`}>
                <span aria-hidden className="chip-dot" />
                {riskCount} point{riskCount > 1 ? "s" : ""} à vérifier
              </span>
            ) : (
              <span className="chip chip-verified">
                <span aria-hidden className="chip-dot" />
                Aucun point bloquant détecté
              </span>
            )}
          </div>

          <span className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-foreground transition-colors group-hover:text-gold-soft">
            {locked ? "Se connecter pour voir" : "Voir le détail"}
            <ArrowUpRight className="h-3.5 w-3.5" />
          </span>
        </div>
      </article>
    </Link>
  );
}

function CardMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}
