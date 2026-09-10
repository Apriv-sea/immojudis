"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createSaleAnalysisSet,
  deleteSaleAnalysisSet,
  disableSaleComparisonShare,
  enableSaleComparisonShare,
  fetchSaleAnalysisSets,
} from "@/lib/client-api";
import { formatDate } from "@/lib/format";
import { Link } from "@/lib/router-compat";
import type {
  SaleAnalysisSet,
  SaleAnalysisSetListResponse,
  SaleComparisonShareResponse,
} from "@/lib/sale-analysis-sets";
import {
  buildSaleComparisonSnapshot,
  readSaleComparisonSnapshot,
  type ComparedSale,
} from "@/lib/search/sale-comparison";

export function SavedSaleComparisons({
  items,
  returnTo,
  userId,
  onRestore,
}: {
  items: ComparedSale[];
  returnTo: string;
  userId: string | null;
  onRestore: (items: ComparedSale[]) => void;
}) {
  if (!userId) {
    return (
      <div className="rounded-lg border border-[#d6e3e8] bg-white p-3">
        <p className="font-bold text-[#132238]">Retrouver cette comparaison plus tard</p>
        <p className="mt-1 text-[#526170]">
          Créez un compte gratuit pour enregistrer une comparaison de trois biens et la partager.
        </p>
        <Link
          to="/login"
          search={{ redirect: localRedirect(returnTo) }}
          className="mt-2 inline-flex min-h-11 items-center rounded-md bg-[#0f766e] px-3 font-bold text-white"
        >
          Se connecter ou créer un compte
        </Link>
      </div>
    );
  }

  return (
    <AuthenticatedSavedSaleComparisons
      key={userId}
      items={items}
      userId={userId}
      onRestore={onRestore}
    />
  );
}

function AuthenticatedSavedSaleComparisons({
  items,
  userId,
  onRestore,
}: {
  items: ComparedSale[];
  userId: string;
  onRestore: (items: ComparedSale[]) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("Ma comparaison");
  const [shareLink, setShareLink] = useState<{ setId: string; url: string } | null>(null);
  const queryKey = ["sale-analysis-sets", userId] as const;
  const setsQuery = useQuery({
    queryKey,
    queryFn: () => fetchSaleAnalysisSets(),
    staleTime: 60_000,
  });
  const savedSets = setsQuery.data?.sets.filter((set) => set.analysis_kind === "comparison") ?? [];
  const isSingleSetPlan = setsQuery.data?.limit === 1;
  const existingSingleSet = isSingleSetPlan ? (savedSets[0] ?? null) : null;

  useEffect(() => {
    if (existingSingleSet?.name) setName(existingSingleSet.name);
  }, [existingSingleSet?.id, existingSingleSet?.name]);

  const saveMutation = useMutation({
    mutationFn: () =>
      createSaleAnalysisSet({
        data: {
          name: existingSingleSet?.name ?? name.trim(),
          analysisKind: "comparison",
          summarySnapshot: buildSaleComparisonSnapshot(items),
          items: items.map((item) => ({ saleId: item.id, decisionStatus: "watching" })),
        },
      }),
    onSuccess: (response) => {
      queryClient.setQueryData<SaleAnalysisSetListResponse>(queryKey, (current) => ({
        sets: [response.set, ...(current?.sets ?? []).filter((set) => set.id !== response.set.id)],
        limit: response.limit,
        itemLimit: response.itemLimit,
      }));
      setName(response.set.name);
      toast.success(existingSingleSet ? "Comparaison remplacée." : "Comparaison enregistrée.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Enregistrement impossible"),
  });

  const deleteMutation = useMutation({
    mutationFn: (setId: string) => deleteSaleAnalysisSet({ setId }),
    onSuccess: (_response, setId) => {
      setShareLink((current) => (current?.setId === setId ? null : current));
      queryClient.setQueryData<SaleAnalysisSetListResponse>(queryKey, (current) =>
        current ? { ...current, sets: current.sets.filter((set) => set.id !== setId) } : current,
      );
      setName("Ma comparaison");
      toast.success("Comparaison supprimée.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Suppression impossible"),
  });

  const shareMutation = useMutation({
    mutationFn: (setId: string) => enableSaleComparisonShare({ setId }),
    onSuccess: async (share, setId) => {
      updateSharing(queryClient, queryKey, setId, share);
      if (share.url) {
        setShareLink({ setId, url: share.url });
        try {
          await copyText(share.url);
          toast.success("Lien de comparaison copié. Il expire dans 30 jours.");
        } catch {
          toast.success("Lien créé. Copiez-le dans le champ ci-dessous.");
        }
      }
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Partage impossible"),
  });

  const unshareMutation = useMutation({
    mutationFn: (setId: string) => disableSaleComparisonShare({ setId }),
    onSuccess: (share, setId) => {
      setShareLink((current) => (current?.setId === setId ? null : current));
      updateSharing(queryClient, queryKey, setId, share);
      toast.success("Lien de partage désactivé.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Désactivation impossible"),
  });

  const saveName = existingSingleSet?.name ?? name.trim();
  const canSave = items.length > 0 && saveName.length >= 2;

  return (
    <div className="rounded-lg border border-[#d6e3e8] bg-white p-3 text-[#132238]">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[14rem] flex-1 text-xs font-bold">
          Nom de la comparaison
          <input
            value={name}
            onChange={(event) => setName(event.target.value.slice(0, 140))}
            disabled={Boolean(existingSingleSet)}
            maxLength={140}
            className="mt-1 min-h-11 w-full rounded-md border border-[#b8c9d1] bg-white px-3 font-normal outline-none focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/20 disabled:bg-[#f4f7f9]"
          />
        </label>
        <button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={!canSave || saveMutation.isPending || setsQuery.isLoading}
          className="min-h-11 rounded-md bg-[#0f766e] px-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saveMutation.isPending
            ? "Enregistrement…"
            : existingSingleSet
              ? "Remplacer la sauvegarde"
              : "Enregistrer"}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-[#526170]">
        {setsQuery.data?.limit == null
          ? "Comparaisons enregistrées sans limite fixe."
          : `${savedSets.length}/${setsQuery.data?.limit ?? 1} comparaison enregistrée · ${setsQuery.data?.itemLimit ?? 3} biens maximum.`}
      </p>

      {setsQuery.isError ? (
        <p role="alert" className="mt-2 text-xs font-semibold text-red-700">
          {setsQuery.error instanceof Error
            ? setsQuery.error.message
            : "Chargement des sauvegardes impossible."}
        </p>
      ) : null}

      {shareLink ? (
        <label className="mt-3 block text-xs font-bold">
          Lien de partage · valable 30 jours
          <input
            readOnly
            value={shareLink.url}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 min-h-11 w-full rounded-md border border-[#b8c9d1] px-3 font-normal"
          />
        </label>
      ) : null}

      {savedSets.length ? (
        <ul
          className="mt-3 max-h-36 space-y-2 overflow-y-auto pr-1"
          aria-label="Comparaisons enregistrées"
        >
          {savedSets.map((set) => (
            <SavedComparisonRow
              key={set.id}
              set={set}
              busy={
                deleteMutation.isPending || shareMutation.isPending || unshareMutation.isPending
              }
              onRestore={() => {
                const restored = readSaleComparisonSnapshot(set.summary_snapshot);
                if (restored.length > 3) {
                  toast.error(
                    "Cette analyse dépasse les trois biens du comparateur rapide. Son lien partagé affiche tous les biens.",
                  );
                  return;
                }
                if (!restored.length) {
                  toast.error(
                    "Cette ancienne sauvegarde ne contient plus de données restaurables.",
                  );
                  return;
                }
                onRestore(restored);
                toast.success("Comparaison restaurée.");
              }}
              onShare={() => shareMutation.mutate(set.id)}
              onUnshare={() => unshareMutation.mutate(set.id)}
              onDelete={() => deleteMutation.mutate(set.id)}
            />
          ))}
        </ul>
      ) : setsQuery.isLoading ? (
        <p className="mt-3 text-xs text-[#526170]">Chargement de vos comparaisons…</p>
      ) : null}
    </div>
  );
}

function SavedComparisonRow({
  set,
  busy,
  onRestore,
  onShare,
  onUnshare,
  onDelete,
}: {
  set: SaleAnalysisSet;
  busy: boolean;
  onRestore: () => void;
  onShare: () => void;
  onUnshare: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[#f4faf8] px-3 py-2">
      <div>
        <p className="font-bold">{set.name}</p>
        <p className="text-[11px] text-[#526170]">
          {readSaleComparisonSnapshot(set.summary_snapshot).length} bien(s) · mise à jour le{" "}
          {formatDate(set.updated_at)}
          {set.sharing.enabled ? ` · lien actif jusqu’au ${formatDate(set.sharing.expiresAt)}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <SmallButton disabled={busy} onClick={onRestore}>
          Restaurer
        </SmallButton>
        <SmallButton disabled={busy} onClick={onShare}>
          {set.sharing.enabled ? "Nouveau lien" : "Partager"}
        </SmallButton>
        {set.sharing.enabled ? (
          <SmallButton disabled={busy} onClick={onUnshare}>
            Désactiver le lien
          </SmallButton>
        ) : null}
        <SmallButton disabled={busy} onClick={onDelete} tone="danger">
          Supprimer
        </SmallButton>
      </div>
    </li>
  );
}

function SmallButton({
  children,
  disabled,
  onClick,
  tone = "default",
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`min-h-11 rounded-md px-2 text-xs font-bold disabled:opacity-50 ${tone === "danger" ? "text-red-700" : "text-[#0f766e]"}`}
    >
      {children}
    </button>
  );
}

function updateSharing(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly [string, string],
  setId: string,
  share: SaleComparisonShareResponse,
) {
  queryClient.setQueryData<SaleAnalysisSetListResponse>(queryKey, (current) =>
    current
      ? {
          ...current,
          sets: current.sets.map((set) =>
            set.id === setId
              ? {
                  ...set,
                  sharing: {
                    enabled: share.enabled,
                    sharedAt: share.enabled ? new Date().toISOString() : null,
                    expiresAt: share.expiresAt,
                  },
                }
              : set,
          ),
        }
      : current,
  );
}

async function copyText(value: string) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Copie automatique indisponible dans ce navigateur.");
  }
  await navigator.clipboard.writeText(value);
}

function localRedirect(value: string): string {
  try {
    const url = new URL(value, "https://www.immojudis.fr");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/sales";
  }
}
