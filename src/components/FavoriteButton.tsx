import { useState } from "react";
import { useNavigate } from "@/lib/router-compat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import {
  addFavoriteSale as addFavoriteSaleRequest,
  removeFavoriteSale as removeFavoriteSaleRequest,
} from "@/lib/client-api";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export function FavoriteButton({
  saleId,
  className = "",
  compact = false,
}: {
  saleId: string;
  className?: string;
  compact?: boolean;
}) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const favoriteKey = ["favorite-status", user?.id ?? null, saleId];
  const favorite = useQuery({
    queryKey: favoriteKey,
    enabled: Boolean(user) && !loading,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_favorites")
        .select("sale_id")
        .eq("user_id", user!.id)
        .eq("sale_id", saleId)
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
  });
  const isFav = Boolean(user) && !loading && favorite.data === true;

  async function toggle() {
    if (loading || busy) return;
    if (!user) {
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "/sales";
      navigate({ to: "/login", search: { redirect } });
      return;
    }
    if (favorite.isPending || favorite.isError) {
      void favorite.refetch();
      return;
    }
    setBusy(true);
    try {
      if (isFav) {
        await removeFavoriteSaleRequest({ saleId });
        qc.setQueryData(favoriteKey, false);
      } else {
        await addFavoriteSaleRequest({ data: { saleId } });
        qc.setQueryData(favoriteKey, true);
      }
      qc.invalidateQueries({ queryKey: ["favorites", user.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggle();
      }}
      disabled={busy || loading || (Boolean(user) && favorite.isPending)}
      aria-pressed={isFav}
      aria-label={isFav ? "Ne plus suivre cette vente" : "Suivre cette vente"}
      title={isFav ? "Ne plus suivre cette vente" : "Suivre cette vente"}
      className={`${compact ? "inline-flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-brand-navy" : "liquid-panel-soft inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-foreground"} transition hover:border-gold hover:text-gold-soft disabled:opacity-50 ${className}`}
    >
      <Heart
        aria-hidden
        className={`${compact ? "h-5 w-5" : "h-3.5 w-3.5"} ${isFav ? "fill-red-500 text-red-500" : ""}`}
      />
      {!compact ? (isFav ? "Vente suivie" : "Suivre cette vente") : null}
    </button>
  );
}
