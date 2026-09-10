"use client";

import { useState } from "react";
import {
  listingOccupation,
  listingValuationConflict,
  listingSaleStatus,
  saleTimeConflict,
  visitHasPassed,
} from "@/lib/listing-evidence";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import DoorOpen from "lucide-react/dist/esm/icons/door-open.js";
import Euro from "lucide-react/dist/esm/icons/euro.js";
import Globe from "lucide-react/dist/esm/icons/globe.js";
import KeyRound from "lucide-react/dist/esm/icons/key-round.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import Mail from "lucide-react/dist/esm/icons/mail.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Phone from "lucide-react/dist/esm/icons/phone.js";
import Ruler from "lucide-react/dist/esm/icons/ruler.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import UserRound from "lucide-react/dist/esm/icons/user-round.js";
import { toast } from "sonner";
import { FavoriteButton } from "@/components/FavoriteButton";
import { MapThumbnail } from "@/components/MapThumbnail";
import { MapboxPreviewButton } from "@/components/MapboxPreviewButton";
import { SaleProcedureBadge } from "@/components/SaleProcedurePanel";
import { safeExternalHttpUrl } from "@/lib/external-url";
import { formatPrice, formatPricePerM2, propertyTypeLabel } from "@/lib/format";
import { buildStructuredDescription } from "@/lib/sale-description";
import {
  listingContactLinks,
  listingAddress,
  listingCoordinates,
  listingDate,
  listingSurface,
  listingVisits,
  positiveListingNumber,
} from "@/lib/sale-listing";
import { getSaleProcedure, saleIsTribunalVenue } from "@/lib/sale-procedure";
import { saleDisplayTitle } from "@/lib/sale-title";
import { saleSession, saleWindow } from "@/lib/sale-window";
import type { AuctionSale } from "@/lib/types";
import styles from "./SaleListing.module.css";

export function ListingActions({
  sale,
  publicDemo = false,
}: {
  sale: AuctionSale;
  publicDemo?: boolean;
}) {
  const [sharing, setSharing] = useState(false);
  const persistedSale = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    sale.id,
  );
  async function share() {
    setSharing(true);
    try {
      const url = new URL(window.location.href);
      url.hash = "";
      url.searchParams.delete("from");
      if (navigator.share) {
        await navigator.share({ title: saleDisplayTitle(sale), url: url.href });
      } else {
        await navigator.clipboard.writeText(url.href);
        toast.success("Lien de l’annonce copié");
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        toast.error("Partage indisponible. Vous pouvez copier l’adresse de cette page.");
      }
    } finally {
      setSharing(false);
    }
  }
  return (
    <div className={styles.actions}>
      {!publicDemo && persistedSale ? <FavoriteButton saleId={sale.id} compact /> : null}
      <button
        type="button"
        className={styles.share}
        aria-label="Partager cette annonce"
        title="Partager cette annonce"
        onClick={() => void share()}
        disabled={sharing}
      >
        <Share2 className="h-5 w-5" aria-hidden />
      </button>
    </div>
  );
}

export function ListingOverview({
  sale,
  publicDemo = false,
}: {
  sale: AuctionSale;
  publicDemo?: boolean;
}) {
  const surface = listingSurface(sale);
  const valuationConflict = listingValuationConflict(sale);
  const price = positiveListingNumber(sale.starting_price_eur);
  const rooms = positiveListingNumber(sale.rooms_count);
  const facts = [
    {
      label: valuationConflict ? "Surface enregistrée · à vérifier" : surface.label,
      value: surface.formatted,
      icon: Ruler,
    },
    {
      label: "Mise à prix au m²",
      value: surface.pricePerM2 == null ? "À confirmer" : formatPricePerM2(surface.pricePerM2),
      icon: Euro,
    },
    { label: "Pièces", value: rooms == null ? "À confirmer" : String(rooms), icon: DoorOpen },
    {
      label: "Occupation",
      value: listingOccupation(sale),
      icon: UserRound,
    },
  ];
  return (
    <div className={styles.overview}>
      <SaleProcedureBadge sale={sale} />
      {listingSaleStatus(sale) ? (
        <p
          role="status"
          className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950"
        >
          {listingSaleStatus(sale)}
        </p>
      ) : null}
      {publicDemo ? (
        <p className="mt-3 text-xs text-slate-500">Annonce exemple · données fictives</p>
      ) : null}
      <h1 className={styles.title}>
        {valuationConflict
          ? "Type de bien à confirmer"
          : saleDisplayTitle(sale, propertyTypeLabel(sale.property_type))}
      </h1>
      <p className={`${styles.muted} mt-2`}>
        {[sale.city, sale.postal_code].filter(Boolean).join(" · ") || "Localisation à confirmer"}
      </p>
      <p className={styles.priceLabel}>Mise à prix</p>
      <p className={styles.price}>{price == null ? "À confirmer" : formatPrice(price)}</p>
      <p className={styles.muted}>Prix de départ, hors frais</p>
      <dl className={styles.facts}>
        {facts.map(({ label, value, icon: Icon }) => (
          <div key={label} className={styles.fact}>
            <dt className={styles.factLabel}>
              <Icon className={styles.factIcon} aria-hidden />
              {label}
            </dt>
            <dd className={styles.factValue}>{value}</dd>
          </div>
        ))}
      </dl>
      {surface.estimated ? <p className={`${styles.muted} mt-3`}>{surface.helperText}</p> : null}
      <a href="#rendez-vous" className={`${styles.textLink} mt-4`}>
        Voir les rendez-vous et contacts <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
      </a>
    </div>
  );
}

export function ListingPracticalDetails({ sale }: { sale: AuctionSale }) {
  const status = listingSaleStatus(sale);
  const interrupted = ["cancelled", "canceled", "postponed"].includes(sale.status ?? "");
  const window = saleWindow(sale);
  const session = saleSession(sale);
  const schedule = window ?? session;
  const timeConflict = saleTimeConflict(sale);
  const procedure = getSaleProcedure(sale);
  const tribunal = saleIsTribunalVenue(sale);
  const visits = listingVisits(sale);
  const contacts = listingContactLinks(procedure.organizerContact);
  const role = procedure.procedure?.organizer_type;
  const roleLabel =
    role === "pursuing_lawyer" ? "Avocat poursuivant" : role === "notary" ? "Notaire" : null;
  return (
    <section id="rendez-vous" className={styles.section} aria-labelledby="listing-practical-title">
      <h2 id="listing-practical-title" className={styles.heading}>
        {tribunal ? "L’audience et les visites" : "La vente et les visites"}
      </h2>
      {status && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="font-semibold">{status}</p>
          {interrupted && (
            <p className="mt-2">
              Les dates conservées dans le dossier ne confirment pas un nouveau rendez-vous.
              Contactez l’organisateur avant tout déplacement.
            </p>
          )}
        </div>
      )}
      <div className={styles.card}>
        <dl className={styles.rows}>
          <div className={styles.row}>
            <dt>
              <CalendarDays aria-hidden />
              {window ? "Ouverture" : session ? "Début de séance" : "Date"}
            </dt>
            <dd>
              {listingDate(schedule?.opens_at ?? sale.sale_date)}
              {timeConflict ? (
                <p role="status" className="mt-2 text-sm font-medium text-amber-900">
                  {timeConflict}
                </p>
              ) : null}
            </dd>
          </div>
          {schedule ? (
            <div className={styles.row}>
              <dt>
                <CalendarDays aria-hidden />
                {window ? "Clôture" : "Fin de séance annoncée"}
              </dt>
              <dd>{listingDate(schedule.closes_at)}</dd>
            </div>
          ) : null}
          <div className={styles.row}>
            <dt>
              <Landmark aria-hidden />
              {tribunal ? "Tribunal" : "Lieu"}
            </dt>
            <dd>
              {procedure.venueName || "À confirmer"}
              {procedure.venueAddress ? (
                <p className={`${styles.muted} mt-1 font-normal`}>{procedure.venueAddress}</p>
              ) : null}
            </dd>
          </div>
          <div className={styles.row}>
            <dt>
              <KeyRound aria-hidden />
              Visites
            </dt>
            <dd>
              {visits.length
                ? visits.map((visit) => <ListingVisit key={visit} text={visit} />)
                : "Dates à confirmer auprès de l’organisateur"}
            </dd>
          </div>
        </dl>
        <div className={styles.contact}>
          <p className={styles.contactTitle}>Interlocuteur du dossier</p>
          <p className={styles.contactName}>{procedure.organizerName || "Contact à confirmer"}</p>
          {roleLabel ? <p className={styles.muted}>{roleLabel}</p> : null}
          {contacts.length ? (
            <div className={styles.contactLinks}>
              {contacts.map(({ href, label, kind }) => {
                const Icon = kind === "email" ? Mail : kind === "phone" ? Phone : Globe;
                return (
                  <a
                    key={href}
                    href={href}
                    className={styles.textLink}
                    {...(kind === "website"
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : {})}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    {label}
                  </a>
                );
              })}
            </div>
          ) : null}
          {procedure.organizerContact && procedure.organizerContact !== contacts[0]?.label ? (
            <p className={`${styles.muted} mt-2 break-words`}>{procedure.organizerContact}</p>
          ) : null}
          <p className={`${styles.muted} mt-3`}>
            {procedure.organizerContact
              ? "Contact mentionné dans le dossier. Confirmez les horaires et modalités avant de vous déplacer."
              : "Les coordonnées seront affichées lorsqu’elles seront renseignées dans le dossier."}
          </p>
          {role === "pursuing_lawyer" ? (
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              L’avocat poursuivant suit la vente ; il n’est pas automatiquement votre représentant
              pour enchérir.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ListingVisit({ text }: { text: string }) {
  const conditionsStart = text.search(/\bconditions\s+de\s+la\s+vente\b/i);
  const slot = conditionsStart < 0 ? text : text.slice(0, conditionsStart).trim();
  const conditions = conditionsStart < 0 ? null : text.slice(conditionsStart);
  return (
    <div>
      {slot ? (
        <p>
          {slot}
          {visitHasPassed(slot) ? (
            <span className="ml-2 text-sm font-semibold text-amber-900">Visite passée</span>
          ) : null}
        </p>
      ) : null}
      {conditions ? (
        <details className="mt-2 text-left text-sm font-normal">
          <summary className="cursor-pointer font-semibold">Conditions de la source</summary>
          <p className="mt-2 leading-relaxed">{conditions}</p>
        </details>
      ) : null}
    </div>
  );
}

export function ListingDescription({ sale }: { sale: AuctionSale }) {
  const description = buildStructuredDescription(sale);
  const original = sale.source_description?.trim() || sale.description?.trim();
  const originalDiffers =
    !!original && original.replace(/\s+/g, " ") !== description.replace(/\s+/g, " ");
  const sourceUrl = safeExternalHttpUrl(sale.source_url);
  return (
    <section
      id="description-ia"
      className={styles.section}
      aria-labelledby="listing-description-title"
    >
      <h2 id="listing-description-title" className={styles.heading}>
        Description
      </h2>
      <div className={styles.card}>
        <p className={styles.body}>{description}</p>
      </div>
      {originalDiffers ? (
        <details className={styles.original}>
          <summary>
            Afficher le texte de l’annonce source{" "}
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
          </summary>
          <div className={styles.card}>
            {sale.source_name ? (
              <p className={`${styles.muted} mb-3`}>Source : {sale.source_name}</p>
            ) : null}
            <p className={styles.body}>{original}</p>
            {sourceUrl ? (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${styles.textLink} mt-3`}
              >
                Consulter l’annonce source <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

export function ListingLocation({ sale }: { sale: AuctionSale }) {
  const coordinates = listingCoordinates(sale);
  const address = listingAddress(sale);
  const price = positiveListingNumber(sale.starting_price_eur);
  return (
    <section id="localisation" className={styles.section} aria-labelledby="listing-location-title">
      <h2 id="listing-location-title" className={styles.heading}>
        Localisation
      </h2>
      <div className={styles.card}>
        {coordinates ? (
          <div className={styles.map}>
            <MapThumbnail
              lat={coordinates.lat}
              lng={coordinates.lng}
              zoom={14}
              className="h-[230px] w-full sm:h-[300px]"
              alt={`Localisation indicative du bien${sale.city ? ` à ${sale.city}` : ""}`}
              markerLabel={price != null ? formatPrice(price) : undefined}
            />
          </div>
        ) : (
          <p className={`${styles.muted} mb-4`}>
            La carte sera disponible lorsque les coordonnées du bien seront renseignées.
          </p>
        )}
        <p className={styles.address}>
          <MapPin className="mt-1 h-4 w-4 shrink-0" aria-hidden />
          {address || "Adresse à confirmer"}
        </p>
        <p className={styles.muted}>
          Localisation indicative. À vérifier dans les pièces du dossier.
        </p>
        {coordinates ? (
          <MapboxPreviewButton
            mode="streetLevel"
            lat={coordinates.lat}
            lng={coordinates.lng}
            label="Explorer le quartier"
            title="Le quartier du bien"
            description={address || "Localisation indicative"}
            ariaLabel="Explorer le quartier sur la carte"
            icon={MapPin}
            className={`${styles.button} ${styles.outline}`}
          />
        ) : null}
      </div>
    </section>
  );
}
