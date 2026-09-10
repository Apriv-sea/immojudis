import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Download from "lucide-react/dist/esm/icons/download.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Link2Off from "lucide-react/dist/esm/icons/link-2-off.js";
import Pencil from "lucide-react/dist/esm/icons/pencil.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import { toast } from "sonner";
import { useNavigate } from "@/lib/router-compat";
import {
  disablePropertyReportShare,
  enablePropertyReportShare,
  exportPropertyReportPdf,
  fetchPropertyReports,
  savePropertyReport,
  updatePropertyReport,
} from "@/lib/client-api";
import type { SavedPropertyReport } from "@/lib/property-reports";
import type { ReportSimulation } from "@/lib/report-simulation";
import { useAuth } from "@/hooks/use-auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function PropertyReportActions({
  saleId,
  compact = false,
  simulation,
  requireSimulation = false,
}: {
  saleId: string;
  compact?: boolean;
  simulation?: ReportSimulation;
  requireSimulation?: boolean;
}) {
  const { user, loading } = useAuth();
  return (
    <PropertyReportWorkspace
      key={`${user?.id ?? "anonymous"}:${saleId}`}
      saleId={saleId}
      compact={compact}
      user={user}
      loading={loading}
      simulation={simulation}
      requireSimulation={requireSimulation}
    />
  );
}

function PropertyReportWorkspace({
  saleId,
  compact,
  user,
  loading,
  simulation,
  requireSimulation,
}: {
  saleId: string;
  compact: boolean;
  user: ReturnType<typeof useAuth>["user"];
  loading: boolean;
  simulation?: ReportSimulation;
  requireSimulation: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const reportQueryKey = ["property-reports", user?.id ?? "anonymous", saleId] as const;

  const reportsQuery = useQuery({
    queryKey: reportQueryKey,
    queryFn: () => fetchPropertyReports({ saleId }),
    enabled: Boolean(user) && !loading,
    staleTime: 60_000,
  });

  const report = reportsQuery.data?.reports[0] ?? null;
  const plan = reportsQuery.data?.plan ?? report?.plan ?? null;

  useEffect(() => {
    setTitle(report?.title ?? "");
    setNotes(report?.user_notes ?? "");
  }, [report?.id, report?.title, report?.user_notes]);

  const saveMutation = useMutation({
    mutationFn: () =>
      savePropertyReport({
        data: {
          saleId,
          reportKind: "opportunity",
          title: title || undefined,
          userNotes: notes || undefined,
          ...(simulation ? { simulation } : {}),
        },
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(reportQueryKey, {
        reports: [response.report],
        plan: response.plan,
      });
      toast.success("Rapport sauvegardé.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Erreur"),
  });

  const updateMutation = useMutation({
    mutationFn: (current: SavedPropertyReport) =>
      updatePropertyReport({
        reportId: current.id,
        data: {
          title,
          userNotes: notes,
        },
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(reportQueryKey, {
        reports: [response.report],
        plan: response.plan,
      });
      setDialogOpen(false);
      toast.success("Rapport mis à jour.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Erreur"),
  });

  const shareMutation = useMutation({
    mutationFn: async () => {
      const currentReport =
        simulation || !report ? (await saveMutation.mutateAsync()).report : report;
      return enablePropertyReportShare({ reportId: currentReport.id });
    },
    onSuccess: async (response) => {
      queryClient.setQueryData(reportQueryKey, {
        reports: [response.report],
        plan: response.plan,
      });
      if (response.share.url) {
        await copyText(response.share.url);
        toast.success("Lien de partage copié.");
      } else {
        toast.success("Partage activé.");
      }
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Partage impossible"),
  });

  const unshareMutation = useMutation({
    mutationFn: (current: SavedPropertyReport) =>
      disablePropertyReportShare({ reportId: current.id }),
    onSuccess: (response) => {
      queryClient.setQueryData(reportQueryKey, {
        reports: [response.report],
        plan: response.plan,
      });
      toast.success("Lien de partage désactivé.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Désactivation impossible"),
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const currentReport =
        simulation || !report ? (await saveMutation.mutateAsync()).report : report;
      return exportPropertyReportPdf({ reportId: currentReport.id });
    },
    onSuccess: ({ blob, filename }) => {
      downloadBlob(blob, filename);
      void queryClient.invalidateQueries({ queryKey: reportQueryKey });
      toast.success("PDF exporté.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Export impossible"),
  });

  const requireUser = () => {
    if (loading) return false;
    if (user) return true;
    const redirect =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}`
        : "/sales";
    navigate({ to: "/login", search: { redirect } });
    return false;
  };

  const awaitingSimulation = requireSimulation && !simulation;
  const saving =
    loading || awaitingSimulation || saveMutation.isPending || updateMutation.isPending;
  const exporting =
    loading || awaitingSimulation || exportMutation.isPending || saveMutation.isPending;
  const sharing =
    loading || awaitingSimulation || shareMutation.isPending || saveMutation.isPending;
  const unsharing = loading || unshareMutation.isPending;
  const pdfLabel =
    plan?.limits.pdfExportsPerMonth == null
      ? "Export PDF"
      : `Export PDF (${plan.limits.pdfExportsPerMonth}/mois)`;

  if (compact) {
    return (
      <div className="mt-3 grid gap-2 border-t border-border pt-3">
        {awaitingSimulation && (
          <p role="status" className="text-xs text-muted-foreground">
            Complétez le simulateur pour obtenir un scénario exportable.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            if (requireUser()) saveMutation.mutate();
          }}
          disabled={saving}
          className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
          {report ? "Rapport sauvegardé" : "Sauvegarder le rapport"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (requireUser()) exportMutation.mutate();
          }}
          disabled={exporting}
          className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-foreground px-3 py-2 text-xs font-semibold text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {exportMutation.isPending ? "Export..." : "Export PDF"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (requireUser()) shareMutation.mutate();
          }}
          disabled={sharing}
          className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground disabled:opacity-50"
        >
          <Share2 className="h-3.5 w-3.5" aria-hidden />
          {sharing
            ? "Création du lien…"
            : report?.share_enabled
              ? "Copier le lien du rapport"
              : "Partager le rapport"}
        </button>
        {report?.share_enabled ? (
          <button
            type="button"
            onClick={() => unshareMutation.mutate(report)}
            disabled={unsharing}
            className="min-h-10 rounded-md px-3 py-2 text-xs font-medium text-muted-foreground underline underline-offset-4 disabled:opacity-50"
          >
            Désactiver le lien du rapport
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FileText className="h-4 w-4 text-gold-soft" />
            {report ? report.title : "Rapport d'opportunité"}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {report
              ? `Dernière sauvegarde ${new Date(report.updated_at).toLocaleDateString("fr-FR")}`
              : "Aucun rapport sauvegardé pour cette vente."}
          </p>
        </div>
        {plan && (
          <span className="rounded-md border border-border bg-muted/30 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
            {plan.label}
          </span>
        )}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => {
            if (requireUser()) saveMutation.mutate();
          }}
          disabled={saving}
          className={actionClassName("secondary")}
        >
          <Save className="h-4 w-4" />
          {report ? "Resauvegarder" : "Sauvegarder"}
        </button>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <button
              type="button"
              onClick={(event) => {
                if (!requireUser()) event.preventDefault();
              }}
              disabled={!report}
              className={actionClassName("secondary")}
            >
              <Pencil className="h-4 w-4" />
              Éditer
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Éditer le rapport</DialogTitle>
              <DialogDescription>Titre et notes internes du rapport.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Titre
                <Input value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Notes
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={6}
                  className="form-input min-h-32 w-full rounded-md text-sm"
                />
              </label>
              <button
                type="button"
                disabled={!report || saving}
                onClick={() => {
                  if (report) updateMutation.mutate(report);
                }}
                className={actionClassName("primary")}
              >
                <Save className="h-4 w-4" />
                Enregistrer
              </button>
            </div>
          </DialogContent>
        </Dialog>
        <button
          type="button"
          onClick={() => {
            if (requireUser()) exportMutation.mutate();
          }}
          disabled={exporting}
          className={actionClassName("primary")}
        >
          <Download className="h-4 w-4" />
          {exporting ? "Export..." : pdfLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            if (requireUser()) shareMutation.mutate();
          }}
          disabled={sharing}
          className={actionClassName("secondary")}
        >
          <Share2 className="h-4 w-4" />
          {sharing ? "Lien..." : report?.share_enabled ? "Copier le lien" : "Partager"}
        </button>
      </div>

      {report && (
        <dl className="mt-4 grid gap-2 border-t border-border pt-3 text-xs sm:grid-cols-4">
          <ReportMeta label="Exports" value={String(report.export_count)} />
          <ReportMeta
            label="Dernier export"
            value={
              report.last_exported_at
                ? new Date(report.last_exported_at).toLocaleDateString("fr-FR")
                : "Jamais"
            }
          />
          <ReportMeta label="Édition" value={plan?.limits.reportEditing ?? "limited"} />
          <div>
            <dt className="font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Partage
            </dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 font-medium text-foreground">
              {report.share_enabled ? "Actif" : "Inactif"}
              {report.share_enabled ? (
                <button
                  type="button"
                  onClick={() => unshareMutation.mutate(report)}
                  disabled={unsharing}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground transition hover:border-red-200 hover:text-red-700 disabled:opacity-50"
                >
                  <Link2Off className="h-3 w-3" />
                  Désactiver
                </button>
              ) : null}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function ReportMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium text-foreground">{value}</dd>
    </div>
  );
}

function actionClassName(variant: "primary" | "secondary") {
  return cn(
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50",
    variant === "primary"
      ? "bg-foreground text-background hover:bg-foreground/90"
      : "border border-border bg-white text-foreground hover:border-gold/50 hover:text-gold-soft",
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}
