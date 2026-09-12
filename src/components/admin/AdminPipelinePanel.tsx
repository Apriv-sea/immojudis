"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchPipelineStatus, setPipelineSourceEnabled } from "@/lib/client-api";

const labels: Record<string, string> = {
  available: "Disponible",
  unavailable: "Indisponible",
  access_denied: "Accès refusé",
  partial: "Collecte partielle",
  unknown: "Non vérifiée",
  unchecked: "Non vérifiée",
};
function date(value: string | null) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("fr-FR")
    : "Non établie";
}
export function AdminPipelinePanel() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-pipeline"],
    queryFn: fetchPipelineStatus,
    refetchInterval: 60_000,
  });
  const mutation = useMutation({
    mutationFn: ({ source, enabled }: { source: string; enabled: boolean }) =>
      setPipelineSourceEnabled(source, enabled),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin-pipeline"] }),
  });
  if (query.isPending) return <p role="status">Chargement de la supervision…</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  const data = query.data;
  return (
    <section
      className="mb-4 rounded-xl border bg-white p-5 space-y-4"
      aria-labelledby="pipeline-title"
    >
      <div>
        <h2 id="pipeline-title" className="text-lg font-semibold">
          Collecte automatique par source
        </h2>
        <p className="text-sm text-slate-600">
          {data.control.enabled ? "Planification active" : "Planification suspendue"} · Observation
          : {date(data.control.observation_started_at)}
        </p>
      </div>
      <p className="text-sm">
        Aujourd’hui (UTC) : {data.usage.ai_requests} appels IA, coût estimé{" "}
        {data.usage.ai_estimated_usd.toFixed(3)} $ / plafond {data.usage.daily_ai_budget_usd} $.{" "}
        {data.usage.ai_unpriced_requests} appels sans coût final connu. Exécution collecte et
        enrichissement : {Math.round(data.usage.runner_seconds / 60)} min.{" "}
        <a
          className="underline"
          href="https://replicate.com/pricing"
          target="_blank"
          rel="noreferrer"
        >
          Tarif utilisé
        </a>{" "}
        (L40S, vérifié le 12/09/2026).
      </p>
      {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-2">Source</th>
              <th className="p-2">État</th>
              <th className="p-2">Inventaire complet</th>
              <th className="p-2">Publication complète</th>
              <th className="p-2">Fiches vérifiées à temps</th>
              <th className="p-2">Planification</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((source) => {
              const metrics = data.observations.find(
                (item) => item.source_name === source.source_name,
              )?.metrics;
              const ratio = metrics?.freshness_ratio;
              return (
                <tr key={source.source_name} className="border-t align-top">
                  <th className="p-2 font-medium">{source.source_name}</th>
                  <td className="p-2">
                    {labels[source.availability] ?? source.availability}
                    {source.last_error ? (
                      <details>
                        <summary className="cursor-pointer text-red-700">Erreur</summary>
                        <p className="max-w-md break-words">{source.last_error}</p>
                      </details>
                    ) : null}
                  </td>
                  <td className="p-2">{date(source.last_inventory_complete_at)}</td>
                  <td className="p-2">
                    {date(source.last_publication_complete_at)}
                    {typeof metrics?.discovery_to_publication_p95_seconds === "number" ? (
                      <p>
                        Délai de publication, p95 :{" "}
                        {Math.round(metrics.discovery_to_publication_p95_seconds)} s
                      </p>
                    ) : null}
                    {metrics?.decisions && typeof metrics.decisions === "object" ? (
                      <details>
                        <summary>Répartition des décisions</summary>
                        <ul>
                          {Object.entries(metrics.decisions).map(([decision, count]) => (
                            <li key={decision}>
                              {decision} : {String(count)}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td className="p-2">
                    {typeof ratio === "number"
                      ? `${Math.round(ratio * 100)} % (${metrics?.fresh_listings}/${metrics?.active_listings})`
                      : "Non mesuré"}
                  </td>
                  <td className="p-2">
                    <button
                      className="rounded border px-3 py-1 disabled:opacity-50"
                      disabled={mutation.isPending}
                      onClick={() =>
                        mutation.mutate({ source: source.source_name, enabled: !source.enabled })
                      }
                    >
                      {source.enabled ? "Suspendre" : "Activer"} {source.source_name}
                    </button>
                    {source.suspended_until ? (
                      <p>Reprise au plus tôt : {date(source.suspended_until)}</p>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-slate-600">
        Une suspension empêche les prochains départs. Le lot déjà en cours peut se terminer. Les
        pourcentages mesurent la fraîcheur des fiches ; ils ne constituent pas une preuve de
        couverture de la source.
      </p>
      <ul className="text-sm">
        {data.alerts
          .filter((alert) => alert.status === "open")
          .map((alert) => (
            <li key={alert.alert_key}>
              {alert.alert_key} — notification : {alert.notification_status}
            </li>
          ))}
      </ul>
    </section>
  );
}
