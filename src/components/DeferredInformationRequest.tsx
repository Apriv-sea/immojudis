"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { AuctionSale } from "@/lib/types";

const InformationRequestAgent = dynamic(
  () => import("./InformationRequestAgent").then((module) => module.InformationRequestAgent),
  {
    loading: () => (
      <section id="information-agent" className="min-h-48 scroll-mt-36">
        <p role="status">Chargement du formulaire…</p>
      </section>
    ),
  },
);

export function DeferredInformationRequest({
  sale,
  previewOnly,
}: {
  sale: AuctionSale;
  previewOnly: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const focusAnchor = () => {
      if (window.location.hash === "#information-agent") {
        container.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("hashchange", focusAnchor);
    focusAnchor();
    return () => window.removeEventListener("hashchange", focusAnchor);
  }, []);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setReady(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          if (container.current?.contains(document.activeElement)) {
            container.current.focus({ preventScroll: true });
          }
          setReady(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px" },
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={container} role="group" tabIndex={-1} aria-label="Demande d’informations">
      {ready ? (
        <InformationRequestAgent sale={sale} previewOnly={previewOnly} />
      ) : (
        <section id="information-agent" className="min-h-48 scroll-mt-36">
          <h2 className="font-display text-2xl">Demander des informations</h2>
          <button
            type="button"
            onClick={() => {
              container.current?.focus({ preventScroll: true });
              setReady(true);
            }}
            className="mt-4 rounded-lg bg-brand-navy px-4 py-3 font-semibold text-white"
          >
            Ouvrir le formulaire
          </button>
        </section>
      )}
    </div>
  );
}
