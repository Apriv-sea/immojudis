"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SaleComparisonTable } from "./SaleComparisonTable";
import { SavedSaleComparisons } from "./SavedSaleComparisons";
import type { ComparedSale } from "@/lib/search/sale-comparison";

export default function SaleComparisonDialog({
  open,
  items,
  returnTo,
  userId,
  onOpenChange,
  onRemove,
  onRestore,
  onRestoreFocus,
}: {
  open: boolean;
  items: ComparedSale[];
  returnTo: string;
  userId: string | null;
  onOpenChange: (open: boolean) => void;
  onRemove: (saleId: string) => void;
  onRestore: (items: ComparedSale[]) => void;
  onRestoreFocus: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid max-h-[90svh] w-[calc(100%-1.5rem)] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-xl p-0 text-[#132238]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader className="border-b border-[#d6e3e8] px-4 py-4 pr-12 text-left sm:px-6">
          <DialogTitle className="text-xl font-extrabold">Comparer les biens</DialogTitle>
          <DialogDescription>
            Les informations du catalogue, côte à côte. Gratuit, sans compte.
          </DialogDescription>
          <p className="text-xs text-[#526170]">
            {items.length < 2
              ? "Ajoutez un autre bien depuis la liste pour le comparer."
              : "Sur mobile, faites défiler le tableau horizontalement pour voir tous les biens."}
          </p>
        </DialogHeader>
        {items.length ? (
          <SaleComparisonTable items={items} returnTo={returnTo} onRemove={onRemove} />
        ) : (
          <div className="grid min-h-24 place-items-center px-4 text-center text-sm text-[#526170]">
            Restaurez une comparaison ci-dessous ou ajoutez des biens depuis le catalogue.
          </div>
        )}
        <div className="max-h-[42svh] space-y-3 overflow-y-auto border-t border-[#d6e3e8] bg-[#fbfdff] px-4 py-3 text-xs leading-relaxed text-[#526170] sm:px-6">
          <SavedSaleComparisons
            items={items}
            returnTo={returnTo}
            userId={userId}
            onRestore={onRestore}
          />
          <p>
            La mise à prix n’est ni le prix final ni le coût total. Les surfaces de nature
            différente ne sont pas directement comparables. Vérifiez les pièces officielles.
          </p>
          <p>
            Sans sauvegarde, la sélection s’efface en quittant ou en rechargeant le catalogue, ou en
            changeant de compte. Les données sont relevées à la sélection et ne s’actualisent pas
            automatiquement.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
