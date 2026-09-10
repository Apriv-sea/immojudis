"use client";

import { useState } from "react";
import Calculator from "lucide-react/dist/esm/icons/calculator.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { formatPrice } from "@/lib/format";
import { parseBudgetAmount, positiveListingNumber } from "@/lib/sale-listing";
import { getSaleProcedure } from "@/lib/sale-procedure";
import type { AuctionSale } from "@/lib/types";
import styles from "./SaleListing.module.css";

export function ListingBudget({ sale }: { sale: AuctionSale }) {
  const procedure = getSaleProcedure(sale);
  const price = positiveListingNumber(sale.starting_price_eur);
  const tribunal = procedure.venueType === "tribunal";
  const notary = procedure.venueType === "notary";
  const items = [
    ["Prix de départ", price == null ? "À confirmer" : formatPrice(price)],
    ["Droits et taxes", "À confirmer"],
    [tribunal ? "Frais préalables" : "Frais de vente", "Selon le dossier"],
    [tribunal ? "Avocat" : notary ? "Notaire" : "Intervenants", "À chiffrer"],
    ["Travaux", "À chiffrer"],
  ];
  return (
    <section id="budget" className={styles.section} aria-labelledby="listing-budget-title">
      <h2 id="listing-budget-title" className={styles.heading}>
        Préparer mon budget
      </h2>
      <div className={styles.card}>
        <p className={styles.muted}>Sur la base de la mise à prix</p>
        <p className={styles.budgetPrice}>
          {price == null ? "Budget à compléter" : `${formatPrice(price)} + frais`}
        </p>
        <p className={styles.muted}>
          Le coût final dépend du prix d’achat et des conditions de cette vente.
        </p>
        <dl className={styles.budgetRows}>
          {items.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.notice}>
          La mise à prix n’est ni le prix final ni un budget tout compris. Demandez le détail des
          frais à l’interlocuteur du dossier.
        </p>
        <a
          href={tribunal ? "/ventes-immobilieres-judiciaires#frais" : "#participation"}
          className={`${styles.textLink} mt-2`}
        >
          {tribunal ? "Comprendre les frais" : "Vérifier les conditions de vente"}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </a>
        <BudgetCalculator key={sale.id} startingPrice={price} />
      </div>
    </section>
  );
}

function BudgetCalculator({ startingPrice }: { startingPrice: number | null }) {
  const [priceInput, setPriceInput] = useState(startingPrice == null ? "" : String(startingPrice));
  const [feesInput, setFeesInput] = useState("");
  const [worksInput, setWorksInput] = useState("");
  const price = parseBudgetAmount(priceInput);
  const fees = parseBudgetAmount(feesInput);
  const works = parseBudgetAmount(worksInput);
  const complete = price != null && price > 0 && fees != null && works != null;
  const validPrice = price != null && price > 0;
  const total = validPrice ? price + (fees ?? 0) + (works ?? 0) : null;
  const fields = [
    {
      id: "budget-purchase",
      label: "Prix d’achat envisagé (€)",
      value: priceInput,
      setValue: setPriceInput,
      invalid: !!priceInput.trim() && !validPrice,
    },
    {
      id: "budget-fees",
      label: "Ensemble des frais d’acquisition (€)",
      value: feesInput,
      setValue: setFeesInput,
      invalid: !!feesInput.trim() && fees == null,
    },
    {
      id: "budget-works",
      label: "Travaux et autres dépenses (€)",
      value: worksInput,
      setValue: setWorksInput,
      invalid: !!worksInput.trim() && works == null,
    },
  ];
  return (
    <details className={styles.calculator}>
      <summary className={styles.button}>
        <Calculator className="h-4 w-4" aria-hidden />
        Simuler mon budget
      </summary>
      <p className={`${styles.muted} mt-4`}>
        Renseignez vos propres hypothèses, à partir du dossier et des devis. Aucun taux de frais
        n’est appliqué automatiquement. Saisissez 0 uniquement si le poste est réellement nul.
      </p>
      <div className={styles.fields}>
        {fields.map(({ id, label, value, setValue, invalid }) => (
          <div key={id} className={styles.field}>
            <label htmlFor={id}>{label}</label>
            <input
              id={id}
              inputMode="decimal"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="À renseigner"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? `${id}-error` : undefined}
            />
            {invalid ? (
              <span id={`${id}-error`} className="text-xs font-normal text-red-700">
                Saisissez un montant valide
                {id === "budget-purchase" ? " supérieur à 0" : " positif ou nul"} (maximum 1
                milliard d’euros).
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div className={styles.total} role="status" aria-live="polite" aria-atomic="true">
        <span className={styles.muted}>
          {complete ? "Total de vos hypothèses" : "Sous-total · budget incomplet"}
        </span>
        <strong>{total == null ? "Prix d’achat à renseigner" : formatPrice(total)}</strong>
        <p className={`${styles.muted} mt-2`}>
          {complete
            ? "Simulation indicative, sans garantie sur le prix final ni sur l’exhaustivité des frais."
            : "Les postes non renseignés ne sont pas inclus. Ce montant n’est pas un coût total."}
        </p>
      </div>
    </details>
  );
}
