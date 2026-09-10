import { useCallback, useEffect, useState } from "react";
import {
  MAX_COMPARED_SALES,
  toggleComparedSale,
  type ComparedSale,
} from "@/lib/search/sale-comparison";
import type { AuctionSale } from "@/lib/types";

const EMPTY_SELECTION: ComparedSale[] = [];

export function useSaleComparison(scope: string | null) {
  const [selection, setSelection] = useState<{ scope: string | null; items: ComparedSale[] }>({
    scope,
    items: [],
  });

  // Guard the render as well as clearing state: no previous account's selection
  // is shown during an authentication or entitlement transition.
  const items = scope != null && selection.scope === scope ? selection.items : EMPTY_SELECTION;
  useEffect(() => {
    setSelection((current) => (current.scope === scope ? current : { scope, items: [] }));
  }, [scope]);

  const toggle = useCallback(
    (sale: AuctionSale) => {
      if (scope == null) return;
      setSelection((current) => ({
        scope,
        items: toggleComparedSale(current.scope === scope ? current.items : [], sale),
      }));
    },
    [scope],
  );
  const remove = useCallback(
    (saleId: string) => {
      setSelection((current) => ({
        scope,
        items: current.scope === scope ? current.items.filter((item) => item.id !== saleId) : [],
      }));
    },
    [scope],
  );
  const clear = useCallback(() => setSelection({ scope, items: [] }), [scope]);
  const replace = useCallback(
    (items: ComparedSale[]) =>
      setSelection({
        scope,
        items: items.slice(0, MAX_COMPARED_SALES),
      }),
    [scope],
  );

  return { items, toggle, remove, clear, replace };
}
