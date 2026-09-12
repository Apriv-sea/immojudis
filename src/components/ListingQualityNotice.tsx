import type { AuctionSale } from "@/lib/types";
import { parseDocs } from "@/lib/documents";
import { safeExternalHttpUrl } from "@/lib/external-url";
const labels: Record<string, string> = {
  sale_date: "date de vente",
  starting_price_eur: "mise à prix",
  occupancy_status: "occupation",
  habitable_surface_m2: "surface habitable",
  carrez_surface_m2: "surface Carrez",
  land_surface_m2: "terrain",
  address: "adresse",
  postal_code: "code postal",
  city: "commune",
};
export function ListingQualityNotice({ sale }: { sale: AuctionSale }) {
  const checks = Object.values(sale.source_checks ?? {})
    .map((check) => Date.parse(check.checked_at ?? ""))
    .filter(Number.isFinite);
  const checked = checks.length ? new Date(Math.max(...checks)).toLocaleString("fr-FR") : null;
  const conflicts = (sale.source_conflicts ?? []).filter(
    (conflict) => conflict.field && labels[conflict.field],
  );
  const pending =
    (sale.analysis_status !== "complete" && !sale.llm_display_description) ||
    sale.analysis_status === "pending";
  const presence = Object.values(sale.source_presence ?? {});
  const absent = presence.some((item) => item.state === "absent");
  const unavailable = presence.some((item) =>
    ["unavailable", "access_denied"].includes(item.availability ?? ""),
  );
  const missing = parseDocs(sale.documents).length === 0;
  return (
    <aside
      className="my-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm"
      aria-label="Vérification et réserves"
    >
      <p>Dernière vérification de la source : {checked ?? "non établie"}.</p>
      {unavailable ? (
        <p>
          Source momentanément inaccessible. La disponibilité de cette annonce reste à confirmer.
        </p>
      ) : null}
      {absent ? (
        <p>
          Annonce absente lors du dernier inventaire complet. Cela ne confirme ni une vente ni une
          annulation.
        </p>
      ) : null}
      {sale.status === "postponed" ? (
        <p>Vente reportée. Confirmez la nouvelle date auprès de la source.</p>
      ) : null}
      {pending ? (
        <p>Analyse en cours. Les informations de la source sont déjà disponibles.</p>
      ) : null}
      {Array.isArray(sale.quality_flags) &&
      sale.quality_flags.includes("surface_type_unverified") ? (
        <p>Surface indiquée par la source ; sa nature habitable ou Carrez reste à confirmer.</p>
      ) : null}
      {Array.isArray(sale.quality_flags) && sale.quality_flags.includes("address_unverified") ? (
        <p>Adresse précise non vérifiée. Confirmez la localisation auprès de la source.</p>
      ) : null}
      {Array.isArray(sale.quality_flags) && sale.quality_flags.includes("multi_lot_sale") ? (
        <p>
          Plusieurs lots de vente sont décrits. Vérifiez le prix, les surfaces et l’occupation de
          chaque lot.
        </p>
      ) : null}
      {Array.isArray(sale.quality_flags) &&
      sale.quality_flags.includes("surface_scope_unverified") ? (
        <p>Les surfaces décrivent différentes parties du bien. Leur total reste à confirmer.</p>
      ) : null}
      {Array.isArray(sale.quality_flags) &&
      sale.quality_flags.includes("parcel_surface_scope_unverified") ? (
        <p>Plusieurs parcelles sont décrites. La surface totale du terrain reste à confirmer.</p>
      ) : null}
      {missing ? (
        <p>Documents non disponibles à ce stade. Vérifiez les pièces auprès de la source.</p>
      ) : null}
      {conflicts.length ? (
        <div className="mt-2 text-amber-900">
          <p>Informations contradictoires à confirmer avant toute décision :</p>
          <ul className="list-disc pl-5">
            {conflicts.map((conflict, index) => {
              const url = safeExternalHttpUrl(conflict.alternative_source);
              return (
                <li key={`${conflict.field}-${index}`}>
                  {labels[conflict.field!]} : {conflict.selected ?? "non précisée"} /{" "}
                  {conflict.alternative ?? "non précisée"}
                  {url ? (
                    <>
                      {" "}
                      —{" "}
                      <a className="underline" href={url} target="_blank" rel="noreferrer">
                        Source de la différence
                      </a>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}
