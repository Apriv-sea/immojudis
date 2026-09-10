"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Gavel from "lucide-react/dist/esm/icons/gavel.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import Wallet from "lucide-react/dist/esm/icons/wallet.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Equal from "lucide-react/dist/esm/icons/equal.js";
import { BrandMark } from "@/components/BrandLogo";
import styles from "./HomeDiscovery.module.css";

const chapters = [
  {
    title: "Le bien",
    description:
      "Description, état, occupation, diagnostics : repérez les informations disponibles.",
    highlight: "Occupation",
    detail: "À vérifier dans le dossier",
    rows: [
      ["Description", "À confronter à la visite"],
      ["Diagnostics", "À consulter s’ils sont disponibles"],
      ["Copropriété", "Pièces et charges à examiner"],
    ],
  },
  {
    title: "Le prix de départ",
    description: "Un prix d’ouverture, qui ne préjuge pas du montant final de la vente.",
    highlight: "Mise à prix",
    detail: "Le point de départ des enchères",
    rows: [
      ["Prix final", "Dépend du déroulement de la vente"],
      ["Frais", "À ajouter au prix d’achat"],
      ["Votre limite", "À préparer avant de participer"],
    ],
  },
  {
    title: "Les points à vérifier",
    description: "Urbanisme, occupation, servitudes : identifiez ce qui mérite d’être approfondi.",
    highlight: "Avant de vous engager",
    detail: "Recouper les informations du dossier",
    rows: [
      ["Occupation", "Situation et conditions à préciser"],
      ["Travaux", "État du bien et devis à examiner"],
      ["Documents", "Sources et dates à vérifier"],
    ],
  },
] as const;
const costs = [
  { icon: Gavel, title: "Prix d’adjudication", text: "Le montant final de l’enchère." },
  {
    icon: FileText,
    title: "Frais",
    text: "Frais de procédure, droits et honoraires selon la vente.",
  },
  { icon: Wrench, title: "Travaux", text: "Rénovation, remise en état, aménagement." },
  { icon: Wallet, title: "Budget à préparer", text: "Une vue d’ensemble de votre projet." },
];

export function HomeDiscovery() {
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const chapter = chapters[active];
  useEffect(() => {
    if (
      !root.current ||
      !("IntersectionObserver" in window) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.visible = "true";
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08 },
    );
    root.current.querySelectorAll<HTMLElement>("[data-reveal]").forEach((section) => {
      section.dataset.visible = "false";
      observer.observe(section);
    });
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={root} className={styles.root}>
      <section className={styles.dossier} aria-labelledby="dossier-title" data-reveal>
        <div className={styles.headingRow}>
          <div>
            <p className={styles.eyebrow}>Le dossier à livre ouvert</p>
            <h2 id="dossier-title">
              Un bien vous attire.
              <br />
              Son dossier fait la différence.
            </h2>
            <p className={styles.lead}>
              Au-delà des photos, découvrez les informations disponibles pour comprendre le bien et
              préparer votre projet.
            </p>
          </div>
          <a href="/annonce-exemple" className={styles.textLink}>
            Explorer une annonce exemple <ArrowRight aria-hidden size={19} />
          </a>
        </div>
        <div className={styles.dossierGrid}>
          <div className={styles.dossierPhoto}>
            <Image
              src="/media/landing/dossier-apartment.webp"
              alt="Appartement lumineux avec moulures et parquet, illustration"
              fill
              sizes="(max-width: 760px) 100vw, 66vw"
            />
            <div
              className={styles.excerpt}
              id="dossier-excerpt"
              aria-live="polite"
              aria-atomic="true"
            >
              <p className={styles.excerptLabel}>
                <FileText size={23} aria-hidden /> Extrait du dossier
              </p>
              <div key={active} className={styles.excerptBody}>
                <p>
                  <strong>{chapter.highlight}</strong>
                  <br />
                  {chapter.detail}
                </p>
                <dl>
                  {chapter.rows.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
            <p className={styles.photoCaption}>
              <strong>Exemple illustratif</strong>
              <span>Les informations varient selon chaque vente.</span>
            </p>
          </div>
          <div
            className={styles.chapters}
            role="group"
            aria-label="Explorer les informations du dossier"
          >
            {chapters.map((item, index) => (
              <button
                key={item.title}
                type="button"
                aria-pressed={active === index}
                aria-controls="dossier-excerpt"
                className={styles.chapter}
                onClick={() => setActive(index)}
              >
                <span className={styles.number}>{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className={styles.budget} aria-labelledby="budget-title" data-reveal>
        <div className={styles.budgetInner}>
          <p className={styles.eyebrow}>Un budget à envisager sereinement</p>
          <div className={styles.budgetHeading}>
            <h2 id="budget-title">Le prix affiché n’est que le début.</h2>
            <a href="/ventes-immobilieres-judiciaires#frais" className={styles.textLink}>
              Comprendre les frais <ArrowRight aria-hidden size={19} />
            </a>
          </div>
          <p className={styles.budgetLead}>
            La mise à prix est un point de départ. Anticipez le prix final et les dépenses de votre
            projet.
          </p>
          <div className={styles.equation}>
            {costs.map(({ icon: Icon, title, text }, index) => (
              <div className={styles.cost} key={title}>
                {index > 0 &&
                  (index === 3 ? (
                    <Equal className={styles.operator} aria-hidden />
                  ) : (
                    <Plus className={styles.operator} aria-hidden />
                  ))}
                <Icon className={styles.costIcon} strokeWidth={1.3} size={40} aria-hidden />
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </div>
            ))}
          </div>
          <p className={styles.budgetNote}>
            Schéma simplifié : financement, fiscalité et imprévus sont aussi à intégrer selon votre
            situation.
          </p>
        </div>
      </section>
      <section className={styles.gallery} aria-labelledby="gallery-title" data-reveal>
        <div className={styles.galleryHeading}>
          <div>
            <p className={styles.eyebrow}>Des lieux, des opportunités</p>
            <h2 id="gallery-title">Quel lieu pour votre prochain projet ?</h2>
          </div>
          <p>
            Des biens à habiter, à investir ou des terrains à imaginer. Explorez les ventes selon
            votre projet.
          </p>
        </div>
        <div className={styles.galleryGrid}>
          {[
            {
              title: "Habiter",
              src: "dossier-apartment",
              href: "/sales?homeTypes=apartment,house",
              alt: "Intérieur d’un appartement de caractère",
            },
            {
              title: "Investir",
              src: "gallery-townhouse",
              href: "/sales?homeTypes=building,commercial,house",
              alt: "Maison en pierre bordée d’arbres",
            },
            {
              title: "Imaginer",
              src: "gallery-land",
              href: "/sales?homeTypes=land",
              alt: "Terrain verdoyant à proximité d’un village",
            },
          ].map((item) => (
            <a
              key={item.title}
              href={item.href}
              className={styles.galleryTile}
              aria-label={`${item.title} — explorer les biens`}
            >
              <Image
                src={`/media/landing/${item.src}.webp`}
                alt={item.alt}
                fill
                sizes="(max-width: 760px) 100vw, 55vw"
              />
              <span className={styles.tileCaption}>
                <strong>{item.title}</strong>
                <span>
                  Explorer les biens <ArrowRight aria-hidden size={17} />
                </span>
              </span>
            </a>
          ))}
        </div>
        <p className={styles.illustration}>Visuels d’illustration</p>
      </section>
      <section className={styles.saved} aria-labelledby="saved-title" data-reveal>
        <div className={styles.savedPhoto}>
          <Image
            src="/media/landing/home-favorites.webp"
            alt="Illustration d’un espace de travail et d’une sélection de biens enregistrés"
            fill
            sizes="(max-width: 760px) 100vw, 55vw"
          />
        </div>
        <div className={styles.savedCopy}>
          <p className={styles.eyebrow}>Votre espace personnel</p>
          <h2 id="saved-title">
            Gardez vos recherches
            <br />à portée de main.
          </h2>
          <p>
            Retrouvez vos favoris et les ventes qui vous intéressent. Créez votre compte
            gratuitement pour poursuivre votre projet.
          </p>
          <a href="/login?mode=investor" className={styles.primaryLink}>
            Créer mon compte gratuit <ArrowRight aria-hidden size={19} />
          </a>
          <a href="/sales" className={styles.textLink}>
            Explorer les ventes <ArrowRight aria-hidden size={19} />
          </a>
        </div>
      </section>
      <footer className={styles.footer}>
        <div className={styles.footerTop}>
          <a href="/" className={styles.brand} aria-label="ImmoJudis — accueil">
            <BrandMark variant="transparent" className={styles.brandMark} />
            <span>
              Immo<span>Judis</span>
              <small>Les ventes immobilières en toute clarté.</small>
            </span>
          </a>
          <nav aria-label="Navigation pied de page">
            <a href="/comment-ca-marche">Comment ça marche</a>
            <a href="/sales">Les ventes</a>
            <a href="/ressources">Ressources</a>
            <a href="/accompagnement">Offres</a>
            <a href="/contact">Contact</a>
          </nav>
        </div>
        <div className={styles.footerBottom}>
          <span>© 2026 ImmoJudis</span>
          <nav aria-label="Informations légales">
            <a href="/legal">Mentions légales</a>
            <a href="/conditions-generales">Conditions générales</a>
            <a href="/privacy">Confidentialité</a>
            <a href="/mes-droits">Mes droits</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
