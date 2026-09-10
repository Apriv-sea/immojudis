"use client";

import dynamic from "next/dynamic";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import LockKeyholeOpen from "lucide-react/dist/esm/icons/lock-keyhole-open.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { SaleProcedureBadge } from "@/components/SaleProcedurePanel";
import { formatPrice } from "@/lib/format";
import { saleDetailPath } from "@/lib/navigation";
import { Link } from "@/lib/router-compat";
import {
  getSaleProcedure,
  lawyerRequirementLabel,
  saleIsTribunalVenue,
  saleVerificationLabel,
  saleVenueLabel,
} from "@/lib/sale-procedure";
import type { AuctionSale, SaleVenueType } from "@/lib/types";
import styles from "./SalePublicPreview.module.css";

const SaleTribunalHistory = dynamic(
  () => import("@/components/SaleTribunalHistory").then((module) => module.SaleTribunalHistory),
  { loading: () => <p className="p-6">Chargement de l’historique du tribunal…</p> },
);

const VENUE_COPY: Record<SaleVenueType, { title: string; explanation: string }> = {
  tribunal: {
    title: "Bien immobilier vendu au tribunal",
    explanation:
      "La vente se tient lors d’une audience d’adjudication. Pour enchérir, un avocat du barreau compétent vous représente et porte votre mise.",
  },
  notary: {
    title: "Bien immobilier vendu chez le notaire",
    explanation:
      "La vente est organisée par un notaire, à l’étude ou en ligne selon le dossier. Les modalités d’inscription, de garantie et de dépôt des offres sont propres à chaque vente.",
  },
  state: {
    title: "Bien immobilier vendu par l’État",
    explanation:
      "La vente est organisée par l’État ou un organisme public. L’inscription et les enchères suivent les conditions indiquées par le service vendeur ou sa plateforme.",
  },
  online: {
    title: "Bien immobilier vendu aux enchères",
    explanation:
      "La vente est annoncée en ligne, mais son organisateur et ses règles doivent encore être confirmés dans le dossier officiel.",
  },
  unknown: {
    title: "Bien immobilier vendu aux enchères",
    explanation:
      "Le type de vente doit encore être confirmé. Le dossier officiel précisera l’organisateur, le mode de participation et les conditions pour enchérir.",
  },
};

export function publicSaleVenueCopy(venueType: SaleVenueType) {
  return VENUE_COPY[venueType];
}

export function SalePublicPreview({
  saleId,
  preview,
  returnTo,
  requestedHash = "",
}: {
  saleId: string;
  preview: AuctionSale;
  returnTo: string;
  requestedHash?: string;
}) {
  const procedure = getSaleProcedure(preview);
  const venueCopy = publicSaleVenueCopy(procedure.venueType);

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <Link to={returnTo} className={styles.back}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Retour aux ventes
        </Link>

        <div className={styles.hero}>
          <section className={styles.summary} aria-labelledby="public-sale-title">
            <SaleProcedureBadge sale={preview} />
            <h1 id="public-sale-title" className={styles.title}>
              {venueCopy.title}
            </h1>
            <p className={styles.intro}>
              Cet aperçu protège les informations détaillées du bien tout en vous indiquant
              clairement comment la vente est organisée.
            </p>

            <p className={styles.priceLabel}>Mise à prix</p>
            <p className={styles.price}>{formatPrice(preview.starting_price_eur)}</p>
            <p className={styles.priceNote}>Prix de départ, hors frais</p>

            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>Type de vente</dt>
                <dd>{saleVenueLabel(procedure.venueType)}</dd>
              </div>
              <div className={styles.fact}>
                <dt>Pour enchérir</dt>
                <dd>{lawyerRequirementLabel(procedure)}</dd>
              </div>
            </dl>
          </section>

          <aside className={styles.procedure} aria-labelledby="public-procedure-title">
            <h2 id="public-procedure-title" className={styles.sectionTitle}>
              Cette vente en clair
            </h2>
            <p className={styles.procedureText}>{venueCopy.explanation}</p>
            <div className={styles.verification}>
              <ShieldCheck aria-hidden />
              <p>
                <strong>{saleVerificationLabel(procedure.verificationStatus)}</strong>
                <br />
                La qualification affichée est rapprochée des sources disponibles par Immojudis.
              </p>
            </div>
            <p className={styles.catalogueNote}>
              <strong>Un seul catalogue, plusieurs procédures</strong>
              Immojudis référence les ventes immobilières au tribunal, chez le notaire et les ventes
              domaniales. Les règles affichées s’adaptent au type de chaque vente.
            </p>
          </aside>
        </div>

        <section className={styles.access} aria-labelledby="public-access-title">
          <div className={styles.accessHeader}>
            <div>
              <h2 id="public-access-title" className={styles.sectionTitle}>
                Consulter le dossier
              </h2>
              <p className={styles.accessIntro}>
                Le compte Découverte est gratuit. Il donne accès aux informations pratiques et au
                guide de participation de cette vente.
              </p>
            </div>
            <div className={styles.actions}>
              <Link
                to="/login"
                search={{
                  mode: "investor",
                  redirect: `${saleDetailPath(saleId, returnTo)}${requestedHash.startsWith("#") ? requestedHash : ""}`,
                }}
                className={styles.primary}
              >
                Voir gratuitement le dossier
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link to={returnTo} className={styles.secondary}>
                Continuer ma recherche
              </Link>
            </div>
          </div>

          <div className={styles.tiers}>
            <div className={styles.tier}>
              <h3 className={styles.tierTitle}>
                <Eye aria-hidden />
                Visible maintenant
              </h3>
              <p>Mise à prix, type de vente et niveau de vérification.</p>
            </div>
            <div className={`${styles.tier} ${styles.tierFree}`}>
              <h3 className={styles.tierTitle}>
                <LockKeyholeOpen aria-hidden />
                Découverte · gratuit
              </h3>
              <p>Date, visites, contact, pièces disponibles et étapes pour participer.</p>
            </div>
            <div className={`${styles.tier} ${styles.tierAnalysis}`}>
              <h3 className={styles.tierTitle}>
                <ChartNoAxesCombined aria-hidden />
                Offre Analyse
              </h3>
              <p>Marché local, risques du dossier et estimation de votre mise plafond.</p>
            </div>
          </div>
        </section>

        {saleIsTribunalVenue(preview) ? <SaleTribunalHistory sale={preview} /> : null}
      </div>
    </main>
  );
}
