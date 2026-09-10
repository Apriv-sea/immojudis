import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Check from "lucide-react/dist/esm/icons/check.js";
import Inbox from "lucide-react/dist/esm/icons/inbox.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import { toast } from "sonner";
import { Link } from "@/lib/router-compat";
import {
  fetchFeatureEntitlements,
  fetchNotificationPreferences,
  updateAlertNotification,
  updateNotificationPreferences,
} from "@/lib/client-api";
import { cleanSaleTitle } from "@/lib/sale-title";
import type { AlertNotificationSummary } from "@/lib/alert-notifications";

export default function AlertNotificationPanel({
  mobile,
  userId,
  notifications,
  isLoading,
  isFetching,
  isError,
  onRefresh,
  onClose,
}: {
  mobile: boolean;
  userId: string;
  notifications: AlertNotificationSummary[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  onRefresh: () => unknown;
  onClose: () => void;
}) {
  const NOTIFICATION_QUERY_KEY = ["alert-notifications", userId] as const;
  const queryClient = useQueryClient();
  const unreadCount = notifications.filter((notification) => !notification.readAt).length;
  const entitlements = useQuery({
    queryKey: ["feature-entitlements", userId],
    queryFn: fetchFeatureEntitlements,
  });
  const emailAvailable = entitlements.data?.plan.hasAnalysisAccess === true;
  const preferencesQuery = useQuery({
    queryKey: ["notification-preferences", userId],
    queryFn: fetchNotificationPreferences,
    staleTime: 60_000,
  });
  const emailEnabled = preferencesQuery.data?.preferences.alertEmailEnabled ?? false;

  const updateMutation = useMutation({
    mutationFn: updateAlertNotification,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATION_QUERY_KEY }),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Action impossible"),
  });
  const preferencesMutation = useMutation({
    mutationFn: updateNotificationPreferences,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification-preferences", userId] });
      toast.success("Préférences mises à jour");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Préférences impossibles"),
  });

  return (
    <div
      role="dialog"
      aria-label="Notifications d'alertes"
      className={
        mobile
          ? "mt-3 w-full overflow-hidden rounded-lg border border-border bg-white shadow-xl"
          : "absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-white shadow-xl"
      }
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-foreground">Alertes</div>
          <div className="text-xs text-muted-foreground">{unreadCount} non lue(s)</div>
        </div>
        <button
          type="button"
          aria-label="Rafraîchir"
          onClick={() => void onRefresh()}
          className="inline-grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground hover:border-gold/50 hover:text-gold-soft"
        >
          {isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>

      <label className="flex items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-3 text-sm">
        <span>
          <span className="block font-semibold text-foreground">Alertes email</span>
          <span className="block text-xs text-muted-foreground">
            {!emailAvailable
              ? "Emails réservés à Analyse ; notifications dans l’application en Découverte"
              : emailEnabled
                ? "Consentement actif"
                : "Notifications in-app uniquement"}
          </span>
        </span>
        <input
          type="checkbox"
          checked={emailAvailable && emailEnabled}
          disabled={!emailAvailable || preferencesQuery.isLoading || preferencesMutation.isPending}
          onChange={(event) =>
            preferencesMutation.mutate({
              alertEmailEnabled: event.target.checked,
              consentSource: "settings",
            })
          }
          className="h-4 w-4 accent-[var(--gold)]"
        />
      </label>

      <div className="max-h-[28rem] overflow-y-auto">
        {isError ? (
          <p role="alert" className="px-4 py-8 text-sm text-destructive">
            Notifications indisponibles. Utilisez « Rafraîchir » pour réessayer.
          </p>
        ) : isLoading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Chargement
          </div>
        ) : notifications.length ? (
          notifications.map((notification) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
              disabled={updateMutation.isPending}
              onOpen={() => onClose()}
              onRead={() =>
                updateMutation.mutate({
                  notificationId: notification.id,
                  action: notification.readAt ? "unread" : "read",
                })
              }
              onDismiss={() =>
                updateMutation.mutate({
                  notificationId: notification.id,
                  action: "dismiss",
                })
              }
            />
          ))
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            <Inbox className="mx-auto mb-2 h-5 w-5" />
            Aucune alerte
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationItem({
  notification,
  disabled,
  onOpen,
  onRead,
  onDismiss,
}: {
  notification: AlertNotificationSummary;
  disabled: boolean;
  onOpen: () => void;
  onRead: () => void;
  onDismiss: () => void;
}) {
  const unread = !notification.readAt;
  const title = cleanSaleTitle(notification.saleTitle) || "Vente judiciaire";
  const location = [notification.city, notification.department].filter(Boolean).join(" · ");

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3">
        <Link to={`/sales/${notification.saleId}`} onClick={onOpen} className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {unread ? <span className="h-2 w-2 rounded-full bg-gold" aria-hidden /> : null}
            <span className="truncate text-sm font-semibold text-foreground">{title}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {notification.alertName}
            {location ? ` · ${location}` : ""}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {notification.reasons.slice(0, 2).map((reason) => (
              <span
                key={reason}
                className="rounded-full bg-gold/10 px-2 py-0.5 text-[11px] font-semibold text-gold-soft"
              >
                {reason}
              </span>
            ))}
            {notification.marketDiscountPct != null ? (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                {Math.round(notification.marketDiscountPct)} % décote
              </span>
            ) : null}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            {formatNotificationDate(notification.scheduledFor)}
          </div>
        </Link>

        <div className="flex flex-col gap-1">
          <button
            type="button"
            aria-label={unread ? "Marquer comme lue" : "Marquer comme non lue"}
            disabled={disabled}
            onClick={onRead}
            className="inline-grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground hover:border-gold/50 hover:text-gold-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Masquer"
            disabled={disabled}
            onClick={onDismiss}
            className="inline-grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function formatNotificationDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
