"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRef, useState } from "react";
import { MAX_COMPARED_SALES, type ComparedSale } from "@/lib/search/sale-comparison";

const SaleComparisonDialog = dynamic(() => import("./SaleComparisonDialog"), {
  loading: () => (
    <p role="status" className="px-4 py-2 text-sm">
      Chargement du comparateur…
    </p>
  ),
});

export function SaleComparisonBar({
  items,
  returnTo,
  userId,
  onRemove,
  onClear,
  onRestore,
}: {
  items: ComparedSale[];
  returnTo: string;
  userId: string | null;
  onRemove: (saleId: string) => void;
  onClear: () => void;
  onRestore: (items: ComparedSale[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLElement>(null);

  return (
    <>
      <section
        ref={barRef}
        tabIndex={-1}
        aria-label="Sélection à comparer"
        className="sticky top-0 lg:top-[var(--sales-header-height)] z-20 border-y border-[#d6e3e8] bg-[#f4faf8] px-3 py-3 shadow-sm outline-none sm:px-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-extrabold text-[#132238]">Comparateur gratuit</h2>
            <p role="status" className="mt-0.5 text-xs text-[#526170]">
              {items.length === 0
                ? `Choisissez jusqu’à ${MAX_COMPARED_SALES} biens dans la liste.`
                : `${items.length}/${MAX_COMPARED_SALES} biens sélectionnés${items.length === MAX_COMPARED_SALES ? " · Retirez un bien pour en ajouter un autre." : "."}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {userId ? (
              <Link href="/favoris" className="px-2 py-3 text-sm font-bold underline">
                Mes favoris
              </Link>
            ) : null}
            {items.length > 0 ? (
              <button
                type="button"
                onClick={onClear}
                className="min-h-11 rounded-md px-2 text-xs font-bold text-[#526170] hover:bg-white focus-visible:outline-2 focus-visible:outline-[#0f766e]"
              >
                Effacer la sélection
              </button>
            ) : null}
            <button
              ref={triggerRef}
              type="button"
              disabled={items.length === 0 && !userId}
              onClick={() => {
                setHasOpened(true);
                setOpen(true);
              }}
              className="min-h-11 rounded-md bg-[#0f766e] px-3 text-sm font-bold text-white hover:bg-[#115e59] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0f766e] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {items.length === 0 && userId ? "Mes comparaisons" : `Comparer (${items.length})`}
            </button>
          </div>
        </div>
      </section>
      {hasOpened ? (
        <SaleComparisonDialog
          open={open}
          items={items}
          returnTo={returnTo}
          userId={userId}
          onOpenChange={setOpen}
          onRemove={(saleId) => {
            onRemove(saleId);
            if (items.length === 1) setOpen(false);
          }}
          onRestore={onRestore}
          onRestoreFocus={() => {
            if (triggerRef.current && !triggerRef.current.disabled) triggerRef.current.focus();
            else barRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
