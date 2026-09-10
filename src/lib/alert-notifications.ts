import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { dispatchQueuedEmailAlertNotifications } from "@/lib/email-alerts";
import { emailAlertConsentEnabled } from "@/lib/notification-preferences";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { cleanSaleTitle } from "@/lib/sale-title";
import type { UserAlert } from "@/lib/types";

type NotificationRow = Database["public"]["Tables"]["user_alert_notifications"]["Row"];
type NotificationInsert = Database["public"]["Tables"]["user_alert_notifications"]["Insert"];
type NotificationUpdate = Database["public"]["Tables"]["user_alert_notifications"]["Update"];

export type AlertNotificationKind = NotificationRow["notification_kind"];
export type AlertNotificationDeliveryStatus = NotificationRow["delivery_status"];

export type AlertNotificationMatchInput = {
  id: string | null;
  alertId: string;
  alertName: string;
  saleId: string;
  saleTitle: string | null;
  city: string | null;
  department: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  reasons: string[];
  marketDiscountPct: number | null;
  matchedAt: string;
};

export type AlertNotificationSummary = {
  id: string;
  alertId: string;
  matchId: string;
  saleId: string;
  alertName: string;
  saleTitle: string | null;
  city: string | null;
  department: string | null;
  reasons: string[];
  marketDiscountPct: number | null;
  notificationKind: AlertNotificationKind;
  deliveryChannel: NotificationRow["delivery_channel"];
  deliveryStatus: AlertNotificationDeliveryStatus;
  scheduledFor: string;
  sentAt: string | null;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
};

export type AlertNotificationListResponse = {
  notifications: AlertNotificationSummary[];
};

export type AlertNotificationCreateResult = {
  notificationCount: number;
};

export type AlertNotificationDispatchResult = {
  ok: true;
  startedAt: string;
  finishedAt: string;
  candidateCount: number;
  dispatchedCount: number;
  notifications: AlertNotificationSummary[];
  emailCandidateCount: number;
  emailDispatchedCount: number;
  emailFailedCount: number;
  emailSkippedCount: number;
  emailProviderConfigured: boolean;
};

export type DispatchableAlertNotification = Pick<
  NotificationRow,
  "id" | "delivery_channel" | "delivery_status" | "scheduled_for"
>;

const DEFAULT_ALERT_NOTIFICATION_DISPATCH_LIMIT = 200;
const MAX_ALERT_NOTIFICATION_DISPATCH_LIMIT = 1_000;

export async function listAlertNotifications({
  auth,
  limit = 50,
  includeDismissed = false,
  includeQueued = false,
}: {
  auth: SupabaseAuthContext;
  limit?: number;
  includeDismissed?: boolean;
  includeQueued?: boolean;
}): Promise<AlertNotificationListResponse> {
  await assertFeatureEntitlement(
    auth,
    "alerts.advanced",
    "Notifications d'alertes réservées au plan Analyse.",
  );

  let query = auth.supabase
    .from("user_alert_notifications")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("delivery_channel", "in_app")
    .order("scheduled_for", { ascending: false })
    .limit(clampLimit(limit, 200));

  if (!includeDismissed) query = query.is("dismissed_at", null);
  if (!includeQueued) query = query.eq("delivery_status", "sent");

  const { data, error } = await query;
  if (error) throw error;

  return {
    notifications: (data ?? []).map(notificationRowToSummary),
  };
}

export async function createAlertNotificationsForMatches({
  auth,
  matches,
  alerts,
  now = new Date(),
  discovery = false,
}: {
  auth: SupabaseAuthContext;
  matches: AlertNotificationMatchInput[];
  alerts: Pick<UserAlert, "id" | "alert_frequency">[];
  now?: Date;
  discovery?: boolean;
}): Promise<AlertNotificationCreateResult> {
  const includeEmail = !discovery && (await emailAlertConsentEnabled(auth));
  const rows = buildAlertNotificationRows({
    userId: auth.userId,
    matches,
    alerts,
    now,
    includeEmail,
    discovery,
  });

  if (!rows.length) return { notificationCount: 0 };

  const { data, error } = await supabaseAdmin
    .from("user_alert_notifications")
    .upsert(rows, {
      onConflict: "user_id,match_id,notification_kind,delivery_channel",
      ignoreDuplicates: true,
    })
    .select("id");

  if (error) throw error;
  return { notificationCount: data?.length ?? 0 };
}

export async function updateAlertNotificationState({
  auth,
  notificationId,
  action,
}: {
  auth: SupabaseAuthContext;
  notificationId: string;
  action: "read" | "unread" | "dismiss" | "restore";
}): Promise<{ notification: AlertNotificationSummary }> {
  await assertFeatureEntitlement(
    auth,
    "alerts.advanced",
    "Notifications d'alertes réservées au plan Analyse.",
  );

  const now = new Date().toISOString();
  const patch =
    action === "read"
      ? { read_at: now }
      : action === "unread"
        ? { read_at: null }
        : action === "dismiss"
          ? { dismissed_at: now }
          : { dismissed_at: null };

  const { data, error } = await auth.supabase
    .from("user_alert_notifications")
    .update({
      ...patch,
      updated_at: now,
    })
    .eq("id", notificationId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;
  return { notification: notificationRowToSummary(data) };
}

export async function dispatchDueAlertNotifications({
  now = new Date(),
  limit = DEFAULT_ALERT_NOTIFICATION_DISPATCH_LIMIT,
}: {
  now?: Date;
  limit?: number;
} = {}): Promise<AlertNotificationDispatchResult> {
  const startedAt = new Date().toISOString();
  const dueAt = now.toISOString();
  const dispatchLimit = clampLimit(limit, MAX_ALERT_NOTIFICATION_DISPATCH_LIMIT);
  const { data: candidates, error: selectError } = await supabaseAdmin
    .from("user_alert_notifications")
    .select("*")
    .eq("delivery_status", "queued")
    .lte("scheduled_for", dueAt)
    .order("scheduled_for", { ascending: true })
    .limit(dispatchLimit);

  if (selectError) throw selectError;

  const candidateRows = candidates ?? [];
  const dueIds = selectDueAlertNotificationIds({
    notifications: candidateRows,
    now,
    limit: dispatchLimit,
  });
  const remainingEmailLimit = Math.max(0, dispatchLimit - dueIds.length);
  const emailCandidates = remainingEmailLimit
    ? selectDueEmailAlertNotifications({
        notifications: candidateRows,
        now,
        limit: remainingEmailLimit,
      })
    : [];

  let dispatchedRows: NotificationRow[] = [];
  if (dueIds.length) {
    const dispatchPatch = buildAlertNotificationDispatchPatch(now);
    const { data, error: updateError } = await supabaseAdmin
      .from("user_alert_notifications")
      .update(dispatchPatch)
      .in("id", dueIds)
      .eq("delivery_channel", "in_app")
      .eq("delivery_status", "queued")
      .lte("scheduled_for", dueAt)
      .select("*");

    if (updateError) throw updateError;
    dispatchedRows = data ?? [];
  }

  const emailDispatch = await dispatchQueuedEmailAlertNotifications({
    notifications: emailCandidates,
    now,
  });
  const notifications = (dispatchedRows ?? []).map(notificationRowToSummary);
  return {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidateCount: candidateRows.length,
    dispatchedCount: notifications.length,
    notifications,
    emailCandidateCount: emailDispatch.candidateCount,
    emailDispatchedCount: emailDispatch.sentCount,
    emailFailedCount: emailDispatch.failedCount,
    emailSkippedCount: emailDispatch.skippedCount,
    emailProviderConfigured: emailDispatch.configured,
  };
}

export function buildAlertNotificationRows({
  userId,
  matches,
  alerts,
  now = new Date(),
  includeEmail = false,
  discovery = false,
}: {
  userId: string;
  matches: AlertNotificationMatchInput[];
  alerts: Pick<UserAlert, "id" | "alert_frequency">[];
  now?: Date;
  includeEmail?: boolean;
  discovery?: boolean;
}): NotificationInsert[] {
  const frequencyByAlert = new Map(alerts.map((alert) => [alert.id, alert.alert_frequency]));

  return matches
    .filter((match) => match.id)
    .flatMap((match) => {
      const frequency = frequencyByAlert.get(match.alertId) ?? "daily";
      const notificationKind = notificationKindForFrequency(frequency);
      const scheduledFor = scheduledForFrequency(frequency, now);
      const isInstant = frequency === "instant";
      const snapshot = asJson({
        ...buildNotificationSnapshot({
          match: discovery
            ? {
                ...match,
                saleTitle: "Vente immobilière",
                marketDiscountPct: null,
                reasons: ["Critères publics correspondants"],
              }
            : match,
          frequency,
        }),
        audience: discovery ? "discovery" : "analyse",
      });
      const inAppRow: NotificationInsert = {
        user_id: userId,
        alert_id: match.alertId,
        match_id: match.id as string,
        sale_id: match.saleId,
        notification_kind: notificationKind,
        delivery_channel: "in_app",
        delivery_status: isInstant ? "sent" : "queued",
        scheduled_for: scheduledFor,
        sent_at: isInstant ? now.toISOString() : null,
        notification_snapshot: snapshot,
      };

      if (!includeEmail || discovery) return [inAppRow];

      return [
        inAppRow,
        {
          user_id: userId,
          alert_id: match.alertId,
          match_id: match.id as string,
          sale_id: match.saleId,
          notification_kind: notificationKind,
          delivery_channel: "email",
          delivery_status: "queued",
          scheduled_for: scheduledFor,
          sent_at: null,
          notification_snapshot: snapshot,
        },
      ];
    });
}

export function selectDueAlertNotificationIds({
  notifications,
  now = new Date(),
  limit = DEFAULT_ALERT_NOTIFICATION_DISPATCH_LIMIT,
}: {
  notifications: DispatchableAlertNotification[];
  now?: Date;
  limit?: number;
}): string[] {
  const dueAt = now.getTime();
  return notifications
    .filter((notification) => {
      const scheduledAt = Date.parse(notification.scheduled_for);
      return (
        notification.delivery_channel === "in_app" &&
        notification.delivery_status === "queued" &&
        Number.isFinite(scheduledAt) &&
        scheduledAt <= dueAt
      );
    })
    .sort((left, right) => Date.parse(left.scheduled_for) - Date.parse(right.scheduled_for))
    .slice(0, clampLimit(limit, MAX_ALERT_NOTIFICATION_DISPATCH_LIMIT))
    .map((notification) => notification.id);
}

export function selectDueEmailAlertNotifications({
  notifications,
  now = new Date(),
  limit = DEFAULT_ALERT_NOTIFICATION_DISPATCH_LIMIT,
}: {
  notifications: NotificationRow[];
  now?: Date;
  limit?: number;
}): NotificationRow[] {
  const dueAt = now.getTime();
  return notifications
    .filter((notification) => {
      const scheduledAt = Date.parse(notification.scheduled_for);
      return (
        notification.delivery_channel === "email" &&
        notification.delivery_status === "queued" &&
        Number.isFinite(scheduledAt) &&
        scheduledAt <= dueAt
      );
    })
    .sort((left, right) => Date.parse(left.scheduled_for) - Date.parse(right.scheduled_for))
    .slice(0, clampLimit(limit, MAX_ALERT_NOTIFICATION_DISPATCH_LIMIT));
}

export function buildAlertNotificationDispatchPatch(now = new Date()): NotificationUpdate {
  const sentAt = now.toISOString();
  return {
    delivery_status: "sent",
    sent_at: sentAt,
    updated_at: sentAt,
  };
}

export function notificationKindForFrequency(
  frequency: UserAlert["alert_frequency"],
): AlertNotificationKind {
  if (frequency === "instant") return "instant_match";
  if (frequency === "weekly") return "weekly_digest";
  return "daily_digest";
}

export function scheduledForFrequency(
  frequency: UserAlert["alert_frequency"],
  now = new Date(),
): string {
  if (frequency === "instant") return now.toISOString();

  const scheduled = new Date(now);
  if (frequency === "weekly") {
    const day = scheduled.getUTCDay();
    const daysUntilMonday = (8 - day) % 7 || 7;
    scheduled.setUTCDate(scheduled.getUTCDate() + daysUntilMonday);
  } else {
    scheduled.setUTCDate(scheduled.getUTCDate() + 1);
  }
  scheduled.setUTCHours(7, 0, 0, 0);
  return scheduled.toISOString();
}

function buildNotificationSnapshot({
  match,
  frequency,
}: {
  match: AlertNotificationMatchInput;
  frequency: UserAlert["alert_frequency"];
}) {
  return {
    alert: {
      id: match.alertId,
      name: match.alertName,
      frequency,
    },
    sale: {
      id: match.saleId,
      title: cleanSaleTitle(match.saleTitle),
      city: match.city,
      department: match.department,
      startingPriceEur: match.startingPriceEur,
      saleDate: match.saleDate,
    },
    match: {
      id: match.id,
      reasons: match.reasons,
      marketDiscountPct: match.marketDiscountPct,
      matchedAt: match.matchedAt,
    },
  };
}

function notificationRowToSummary(row: NotificationRow): AlertNotificationSummary {
  const snapshot = asRecord(row.notification_snapshot);
  const alert = asRecord(snapshot.alert);
  const sale = asRecord(snapshot.sale);
  const match = asRecord(snapshot.match);

  return {
    id: row.id,
    alertId: row.alert_id,
    matchId: row.match_id,
    saleId: row.sale_id,
    alertName: stringValue(alert.name) || "Alerte",
    saleTitle: cleanSaleTitle(stringValue(sale.title)),
    city: stringValue(sale.city),
    department: stringValue(sale.department),
    reasons: arrayOfStrings(match.reasons),
    marketDiscountPct: numberValue(match.marketDiscountPct),
    notificationKind: row.notification_kind,
    deliveryChannel: row.delivery_channel,
    deliveryStatus: row.delivery_status,
    scheduledFor: row.scheduled_for,
    sentAt: row.sent_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
    createdAt: row.created_at,
  };
}

function asJson(value: Record<string, unknown>): Json {
  return value as Json;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value || 1)));
}
