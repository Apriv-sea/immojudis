"use client";

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
