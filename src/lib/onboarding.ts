import type { LoginPageMode } from "@/lib/navigation";
import { HOME_TYPE_OPTIONS } from "@/lib/search/search-filters";
import type { SalesSearchUrlRecord } from "@/lib/search/search-url-state";

export function postAuthDestination({
  mode,
  redirect,
  professional,
}: {
  mode: LoginPageMode;
  redirect?: string;
  professional: boolean;
}): string {
  // Preserve a listing, checkout or filtered search that prompted registration.
  if (redirect && redirect !== "/sales") return redirect;
  if (mode === "investor" && !professional) return "/bienvenue";
  return redirect ?? (professional ? "/publish" : "/sales");
}

export type FirstSearch = {
  area: string;
  maxPrice: string;
  homeType: string;
};

export function firstSearchToUrl(search: FirstSearch): SalesSearchUrlRecord {
  const maxPrice = Number(search.maxPrice);
  return {
    query: search.area.trim().slice(0, 120) || undefined,
    maxPrice:
      Number.isFinite(maxPrice) && maxPrice > 0 && maxPrice <= 1_000_000_000 ? maxPrice : undefined,
    homeTypes: HOME_TYPE_OPTIONS.some((option) => option.value === search.homeType)
      ? search.homeType
      : undefined,
  };
}
