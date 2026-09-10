import { useAuth } from "@/hooks/use-auth";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import { fetchAlertNotifications } from "@/lib/client-api";
import type { AlertNotificationSummary } from "@/lib/alert-notifications";
const AlertNotificationPanel = lazy(() => import("./AlertNotificationPanel"));

const EMPTY_NOTIFICATIONS: AlertNotificationSummary[] = [];

export function AlertNotificationCenter({ mobile = false }: { mobile?: boolean }) {
  const { user, loading } = useAuth();
  if (loading || !user) return null;
  return <AccountNotificationCenter key={user.id} userId={user.id} mobile={mobile} />;
}

function AccountNotificationCenter({ mobile, userId }: { mobile: boolean; userId: string }) {
  const NOTIFICATION_QUERY_KEY = ["alert-notifications", userId] as const;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const notificationsQuery = useQuery({
    queryKey: NOTIFICATION_QUERY_KEY,
    queryFn: () => fetchAlertNotifications({ limit: 12 }),
    refetchInterval: open ? 30_000 : 120_000,
  });
  const notifications = notificationsQuery.data?.notifications ?? EMPTY_NOTIFICATIONS;
  const unreadCount = notifications.filter((notification) => !notification.readAt).length;

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={panelRef} className={mobile ? "relative w-full" : "relative"}>
      <button
        type="button"
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={
          mobile
            ? "ij-login-button relative w-full justify-center gap-2"
            : "relative inline-grid h-10 w-10 place-items-center rounded-md border border-border bg-white text-foreground hover:border-gold/50 hover:text-gold-soft"
        }
      >
        <Bell className="h-4 w-4" />
        {mobile ? <span>Notifications</span> : null}
        {unreadCount ? (
          <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-gold px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <Suspense fallback={<div role="status">Chargement des notifications…</div>}>
          <AlertNotificationPanel
            mobile={mobile}
            userId={userId}
            notifications={notifications}
            isError={notificationsQuery.isError}
            isLoading={notificationsQuery.isLoading}
            isFetching={notificationsQuery.isFetching}
            onRefresh={() => notificationsQuery.refetch()}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
