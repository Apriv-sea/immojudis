import { useEffect, useState } from "react";
import { formatPrice, formatPricePerM2, formatSurface } from "@/lib/format";
import { MARKET_CEILING_SCENARIOS, type MarketCeilingResult } from "@/lib/profitability";
import {
  bidStorageKey,
  canSaveBidSimulation,
  MAX_SAVED_SIMULATIONS,
  parseBidHistory,
  serializeBidHistory,
  type BidAssistantState,
  type BidSimulationSnapshot,
} from "@/lib/bid-simulation-history";

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "medium" });

export function BidSimulationHistory({
  ownerId,
  saleId,
  inputs,
  result,
  onRestore,
}: {
  ownerId: string;
  saleId: string;
  inputs: BidAssistantState;
  result: MarketCeilingResult;
  onRestore: (snapshot: BidSimulationSnapshot) => void;
}) {
  const key = bidStorageKey("history", ownerId, saleId);
  const [entries, setEntries] = useState<BidSimulationSnapshot[]>([]);
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    function refresh() {
      try {
        setEntries(parseBidHistory(window.localStorage.getItem(key)));
      } catch {
        setError(
          "Le stockage local est indisponible. Vos simulations ne peuvent pas être conservées sur cet appareil.",
        );
      }
    }
    refresh();
    function onStorage(event: StorageEvent) {
      if (event.key === key || event.key === null) refresh();
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);

  function updateEntries(
    update: (previous: BidSimulationSnapshot[]) => BidSimulationSnapshot[],
    success: string,
  ) {
    try {
      const next = update(parseBidHistory(window.localStorage.getItem(key))).slice(
        0,
        MAX_SAVED_SIMULATIONS,
      );
      window.localStorage.setItem(key, serializeBidHistory(next));
      setEntries(next);
      setError("");
      setMessage(success);
      return true;
    } catch {
      setMessage("");
      setError(
        "Enregistrement impossible : le stockage de cet appareil est plein ou bloqué. Aucune sauvegarde n’a été confirmée.",
      );
      return false;
    }
  }

  const canSave = canSaveBidSimulation(inputs, result);

  function save() {
    if (!canSave) return;
    const savedAt = new Date().toISOString();
    const profile =
      inputs.scenario === "custom"
        ? "Personnalisé"
        : MARKET_CEILING_SCENARIOS.find((scenario) => scenario.key === inputs.scenario)?.label;
    const snapshot: BidSimulationSnapshot = {
      id: crypto.randomUUID(),
      label: label.trim().slice(0, 60) || `${profile} · ${dateFormat.format(new Date(savedAt))}`,
      savedAt,
      inputs: { ...inputs },
      result: {
        maxBid: result.maxBid,
        surface: result.surface,
        marketReferencePricePerM2: result.marketReferencePricePerM2,
        safetyDiscountPct: result.safetyDiscountPct,
      },
    };
    if (
      updateEntries(
        (previous) => [snapshot, ...previous],
        "Simulation enregistrée sur cet appareil.",
      )
    )
      setLabel("");
  }

  return (
    <section
      aria-label="Historique des simulations"
      className="mt-6 rounded-lg border border-border bg-background/60 p-4 sm:p-5"
    >
      <h3 className="text-base font-semibold text-foreground">Mes simulations de ce bien</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Sur cet appareil uniquement, non synchronisées. Les {MAX_SAVED_SIMULATIONS} dernières
        simulations de ce compte sont conservées dans ce navigateur. Effacer ses données les
        supprime.
      </p>
      <div className="mt-4 flex flex-col items-stretch gap-3 sm:flex-row sm:items-end">
        <label className="grid flex-1 gap-1.5 text-xs font-medium">
          Nom de la simulation (facultatif)
          <input
            value={label}
            maxLength={60}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Ex. Travaux limités"
            className="min-w-0 rounded-lg border border-border bg-white px-3 py-2.5 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={!canSave}
          onClick={save}
          className="rounded-lg bg-gold px-4 py-2.5 text-sm font-semibold text-brand-navy disabled:cursor-not-allowed disabled:opacity-50"
        >
          Enregistrer cette simulation
        </button>
      </div>
      {!canSave && (
        <p className="mt-2 text-xs text-muted-foreground">
          Complétez les hypothèses pour obtenir un plafond avant de l’enregistrer.
        </p>
      )}
      <p role="status" className="mt-2 text-xs text-muted-foreground">
        {message}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Aucune simulation enregistrée pour ce bien.
        </p>
      ) : (
        <>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Les plafonds ci-dessous restent ceux du jour de la sauvegarde. Reprendre une simulation
            recharge ses hypothèses ; le calcul utilise les données du bien et du marché
            actuellement disponibles.
          </p>
          <div className="mt-3 min-w-0">
            <table role="table" className="block w-full text-left text-xs sm:table">
              <caption className="sr-only">Comparaison de vos simulations sauvegardées</caption>
              <thead
                role="rowgroup"
                className="sr-only text-muted-foreground sm:not-sr-only sm:table-header-group"
              >
                <tr>
                  <th scope="col" className="py-2 pr-4">
                    Simulation
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Hypothèses sauvegardées
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Plafond sauvegardé
                  </th>
                  <th scope="col" className="py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup" className="block sm:table-row-group">
                {entries.map((entry) => (
                  <tr
                    role="row"
                    key={entry.id}
                    className="mt-3 block rounded-lg border border-border p-3 align-top sm:mt-0 sm:table-row sm:rounded-none sm:border-x-0 sm:border-b-0 sm:p-0"
                  >
                    <th
                      role="rowheader"
                      scope="row"
                      className="block break-words pb-2 font-medium sm:table-cell sm:py-3 sm:pr-4"
                    >
                      {entry.label}
                      <time
                        dateTime={entry.savedAt}
                        className="mt-1 block font-normal text-muted-foreground"
                      >
                        {dateFormat.format(new Date(entry.savedAt))}
                      </time>
                    </th>
                    <td
                      role="cell"
                      className="block space-y-1 py-2 text-muted-foreground sm:table-cell sm:py-3 sm:pr-4"
                    >
                      <span className="block">
                        Mise simulée : {formatPrice(entry.inputs.price)}
                      </span>
                      <span className="block">
                        Travaux : {formatPrice(entry.inputs.works)} · FPT :{" "}
                        {formatPrice(entry.inputs.fpt)}
                      </span>
                      <span className="block">
                        {formatSurface(entry.result.surface)} · marché :{" "}
                        {formatPricePerM2(entry.result.marketReferencePricePerM2)}
                      </span>
                      <span className="block">
                        {entry.inputs.scenario === "custom"
                          ? "Personnalisé"
                          : entry.inputs.scenario === "prudent"
                            ? "Prudent"
                            : "Offensif"}{" "}
                        · marge : {entry.result.safetyDiscountPct} %
                      </span>
                    </td>
                    <td
                      role="cell"
                      className="block py-2 font-semibold tabular-nums sm:table-cell sm:py-3 sm:pr-4"
                    >
                      <span className="sm:hidden">Plafond sauvegardé : </span>
                      {formatPrice(Math.round(entry.result.maxBid))}
                    </td>
                    <td role="cell" className="flex flex-wrap gap-x-5 pt-1 sm:table-cell sm:py-3">
                      <button
                        type="button"
                        aria-label={`Reprendre ${entry.label}`}
                        onClick={() => {
                          onRestore(entry);
                          setMessage(
                            `Hypothèses « ${entry.label} » rechargées. Le plafond est recalculé avec les données actuelles.`,
                          );
                        }}
                        className="block py-2.5 font-medium text-gold-soft underline underline-offset-2"
                      >
                        Reprendre
                      </button>
                      <button
                        type="button"
                        aria-label={`Supprimer ${entry.label}`}
                        onClick={() =>
                          updateEntries(
                            (previous) => previous.filter((item) => item.id !== entry.id),
                            "Simulation supprimée de cet appareil.",
                          )
                        }
                        className="block py-2.5 text-muted-foreground underline underline-offset-2"
                      >
                        Supprimer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
