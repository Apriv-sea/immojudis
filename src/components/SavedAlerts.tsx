"use client";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { getAlerts, updateAlert, deleteAlert } from "@/lib/queries";
import { fetchWatchedZones, deleteWatchedZone, evaluateAlertMatches } from "@/lib/client-api";
import { toast } from "sonner";

export function SavedAlerts() {
  const { user, loading } = useAuth();
  if (loading || !user) return null;
  return <AccountAlerts key={user.id} userId={user.id} />;
}
function AccountAlerts({ userId }: { userId: string }) {
  const client = useQueryClient();
  const alertsKey = ["saved-alerts", userId];
  const zonesKey = ["watched-zones", userId];
  const alerts = useQuery({ queryKey: alertsKey, queryFn: () => getAlerts(userId) });
  const zones = useQuery({
    queryKey: zonesKey,
    queryFn: () => fetchWatchedZones({ includeInactive: true }),
  });
  const mutation = useMutation({
    mutationFn: async (action: { kind: "pause" | "resume" | "delete" | "zone"; id: string }) => {
      if (action.kind === "zone") return deleteWatchedZone({ zoneId: action.id });
      if (action.kind === "delete") return deleteAlert(userId, action.id);
      return updateAlert(userId, action.id, { is_active: action.kind === "resume" });
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: alertsKey }),
        client.invalidateQueries({ queryKey: zonesKey }),
      ]);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Modification impossible"),
  });
  const evaluation = useMutation({
    mutationFn: () => evaluateAlertMatches({ persist: true }),
    onSuccess: async (result) => {
      toast.success(
        `${result.matchCount} correspondance(s) trouvée(s). Notifications selon la fréquence de l'alerte.`,
      );
      await client.invalidateQueries({ queryKey: alertsKey });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Évaluation impossible"),
  });
  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 pb-16 pt-28">
      <h1 className="text-3xl font-bold">Mes alertes</h1>
      <p className="mt-3 text-muted-foreground">
        Découverte : une alerte et une zone actives, notifications quotidiennes dans l’application,
        sans email. Analyse : jusqu’à 25 alertes et zones, critères avancés.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Les évaluations sont bornées aux ventes chargées ; elles ne garantissent pas une couverture
        exhaustive. Une alerte conservant des critères premium après expiration d’Analyse ne sera
        plus évaluée.
      </p>
      <Link href="/sales" className="mt-4 inline-block underline">
        Créer une alerte depuis les filtres du catalogue
      </Link>
      {(alerts.isPending || zones.isPending) && (
        <p role="status" className="mt-6">
          Chargement…
        </p>
      )}
      {(alerts.isError || zones.isError) && (
        <div role="alert" className="mt-6">
          Chargement impossible.{" "}
          <button
            className="underline"
            onClick={() => {
              void alerts.refetch();
              void zones.refetch();
            }}
          >
            Réessayer
          </button>
        </div>
      )}
      {alerts.data && (
        <section className="mt-8" aria-label="Alertes enregistrées">
          <h2 className="text-xl font-semibold">Alertes enregistrées</h2>
          {alerts.data.length === 0 && <p className="mt-3">Aucune alerte enregistrée.</p>}
          {alerts.data.map((alert) => (
            <article key={alert.id} className="mt-3 rounded-lg border p-4">
              <h3 className="font-semibold">{alert.name}</h3>
              <p>
                {alert.is_active ? "Active" : "En pause"} ·{" "}
                {alert.alert_frequency === "daily"
                  ? "Quotidienne"
                  : alert.alert_frequency === "weekly"
                    ? "Hebdomadaire"
                    : "Immédiate"}
              </p>
              <div className="mt-3 flex flex-wrap gap-4">
                <button
                  disabled={mutation.isPending}
                  className="underline"
                  onClick={() =>
                    mutation.mutate({ kind: alert.is_active ? "pause" : "resume", id: alert.id })
                  }
                >
                  {alert.is_active ? "Mettre en pause" : "Réactiver"}
                </button>
                <button
                  disabled={mutation.isPending}
                  className="underline"
                  onClick={() => mutation.mutate({ kind: "delete", id: alert.id })}
                >
                  Supprimer l’alerte
                </button>
              </div>
            </article>
          ))}
          {alerts.data.some((a) => a.is_active) && (
            <button
              disabled={evaluation.isPending}
              className="mt-4 rounded border px-4 py-2"
              onClick={() => evaluation.mutate()}
            >
              {evaluation.isPending ? "Vérification…" : "Vérifier les correspondances"}
            </button>
          )}
        </section>
      )}
      {zones.data && (
        <section className="mt-8" aria-label="Zones surveillées">
          <h2 className="text-xl font-semibold">Zones surveillées</h2>
          {zones.data.zones.length === 0 && <p className="mt-3">Aucune zone enregistrée.</p>}
          {zones.data.zones.map((zone) => (
            <article className="mt-3 rounded-lg border p-4" key={zone.id}>
              <h3 className="font-semibold">{zone.name}</h3>
              <p className="text-sm">Supprimer la zone met ses alertes en pause.</p>
              <button
                disabled={mutation.isPending}
                className="mt-3 underline"
                onClick={() => mutation.mutate({ kind: "zone", id: zone.id })}
              >
                Supprimer la zone
              </button>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
