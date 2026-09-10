"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import styles from "./CinematicHome.module.css";

export function CinematicHero() {
  return (
    <section className={styles.hero} aria-labelledby="home-title">
      <Image
        className={styles.poster}
        src="/media/landing/cinematic-bordeaux-lossless.webp"
        alt=""
        fill
        priority
        unoptimized
        sizes="100vw"
      />
      <div className={styles.shade} />
      <div className={styles.content}>
        <h1 id="home-title">
          Les enchères
          <br />
          immobilières,
          <br />
          en toute <em>clarté.</em>
        </h1>
        <p className={styles.lead}>Trouvez un bien. Comprenez les règles. Préparez votre achat.</p>
        <form action="/sales" className={styles.search} role="search">
          <Search size={23} aria-hidden="true" />
          <label className="sr-only" htmlFor="home-search">
            Ville, département ou code postal
          </label>
          <input
            id="home-search"
            name="q"
            type="search"
            placeholder="Ville, département ou code postal"
          />
          <button type="submit">
            Explorer les ventes <ArrowRight size={19} aria-hidden="true" />
          </button>
        </form>
        <nav className={styles.types} aria-label="Types de biens">
          {[
            ["Maisons", "house"],
            ["Appartements", "apartment"],
            ["Locaux professionnels", "commercial"],
            ["Terrains", "land"],
          ].map(([label, type]) => (
            <a key={type} href={`/sales?homeTypes=${encodeURIComponent(type)}`}>
              {label}
            </a>
          ))}
        </nav>
      </div>
    </section>
  );
}

export function CinematicIntro() {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const target = section.current;
    if (
      !target ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !("IntersectionObserver" in window)
    )
      return;
    target.dataset.reveal = "pending";
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          target.dataset.reveal = "visible";
          observer.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return (
    <section ref={section} className={styles.intro} aria-labelledby="cinematic-intro-title">
      <div>
        <p className={styles.eyebrow}>Des biens réels. Des informations claires.</p>
        <h2 id="cinematic-intro-title">Une opportunité commence par une lecture claire.</h2>
        <p className={styles.description}>
          Découvrez des biens mis aux enchères et les informations disponibles pour préparer votre
          projet.
        </p>
        <a className={styles.example} href="/annonce-exemple">
          Découvrir une annonce exemple <ArrowRight size={18} aria-hidden="true" />
        </a>
      </div>
      <a
        href="/annonce-exemple"
        className={styles.imageLink}
        aria-label="Découvrir une annonce exemple"
      >
        <Image
          src="/media/landing/cinematic-balcony-v2.webp"
          alt="Façades en pierre et balcon bordelais dans la lumière du soir"
          width={1400}
          height={700}
          sizes="(max-width: 760px) 100vw, 48vw"
        />
      </a>
    </section>
  );
}
