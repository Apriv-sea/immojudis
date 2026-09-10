import { describe, expect, it } from "vitest";
import {
  buildAlertNotificationDispatchPatch,
  buildAlertNotificationRows,
  notificationKindForFrequency,
  selectDueEmailAlertNotifications,
  scheduledForFrequency,
  selectDueAlertNotificationIds,
  type AlertNotificationMatchInput,
} from "@/lib/alert-notifications";
import type { Database } from "@/integrations/supabase/types";
import type { UserAlert } from "@/lib/types";

type NotificationRow = Database["public"]["Tables"]["user_alert_notifications"]["Row"];

function makeMatch(
  overrides: Partial<AlertNotificationMatchInput> = {},
): AlertNotificationMatchInput {
  return {
    id: "match-1",
    alertId: "alert-1",
    alertName: "Bordeaux décoté",
    saleId: "sale-1",
    saleTitle: "Maison judiciaire",
    city: "Bordeaux",
    department: "33",
    startingPriceEur: 100_000,
    saleDate: "2026-08-01T09:00:00.000Z",
    reasons: ["décote", "DPE C"],
    marketDiscountPct: 32,
    matchedAt: "2026-07-06T10:00:00.000Z",
    ...overrides,
  };
}

describe("alert notifications", () => {
  it("maps alert frequency to notification kind and schedule", () => {
    const now = new Date("2026-07-06T10:15:00.000Z");

    expect(notificationKindForFrequency("instant")).toBe("instant_match");
    expect(notificationKindForFrequency("daily")).toBe("daily_digest");
    expect(notificationKindForFrequency("weekly")).toBe("weekly_digest");
    expect(scheduledForFrequency("instant", now)).toBe("2026-07-06T10:15:00.000Z");
    expect(scheduledForFrequency("daily", now)).toBe("2026-07-07T07:00:00.000Z");
    expect(scheduledForFrequency("weekly", now)).toBe("2026-07-13T07:00:00.000Z");
  });

  it("builds idempotent notification insert rows from persisted matches", () => {
    const rows = buildAlertNotificationRows({
      userId: "user-1",
      matches: [makeMatch(), makeMatch({ id: null, saleId: "sale-2" })],
      alerts: [{ id: "alert-1", alert_frequency: "instant" as UserAlert["alert_frequency"] }],
      now: new Date("2026-07-06T10:15:00.000Z"),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "user-1",
      alert_id: "alert-1",
      match_id: "match-1",
      sale_id: "sale-1",
      notification_kind: "instant_match",
      delivery_channel: "in_app",
      delivery_status: "sent",
      scheduled_for: "2026-07-06T10:15:00.000Z",
      sent_at: "2026-07-06T10:15:00.000Z",
    });
  });

  it("adds queued email notification rows only when email consent is enabled", () => {
    const rows = buildAlertNotificationRows({
      userId: "user-1",
      matches: [makeMatch()],
      alerts: [{ id: "alert-1", alert_frequency: "instant" as UserAlert["alert_frequency"] }],
      now: new Date("2026-07-06T10:15:00.000Z"),
      includeEmail: true,
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.delivery_channel)).toEqual(["in_app", "email"]);
    expect(rows[1]).toMatchObject({
      delivery_channel: "email",
      delivery_status: "queued",
      sent_at: null,
      scheduled_for: "2026-07-06T10:15:00.000Z",
    });
  });

  it("selects only due in-app queued notifications in scheduled order", () => {
    const ids = selectDueAlertNotificationIds({
      now: new Date("2026-07-06T10:15:00.000Z"),
      limit: 2,
      notifications: [
        {
          id: "future",
          delivery_channel: "in_app",
          delivery_status: "queued",
          scheduled_for: "2026-07-06T10:16:00.000Z",
        },
        {
          id: "email",
          delivery_channel: "email",
          delivery_status: "queued",
          scheduled_for: "2026-07-06T09:00:00.000Z",
        },
        {
          id: "already-sent",
          delivery_channel: "in_app",
          delivery_status: "sent",
          scheduled_for: "2026-07-06T08:00:00.000Z",
        },
        {
          id: "second",
          delivery_channel: "in_app",
          delivery_status: "queued",
          scheduled_for: "2026-07-06T10:00:00.000Z",
        },
        {
          id: "first",
          delivery_channel: "in_app",
          delivery_status: "queued",
          scheduled_for: "2026-07-06T07:00:00.000Z",
        },
        {
          id: "third-after-limit",
          delivery_channel: "in_app",
          delivery_status: "queued",
          scheduled_for: "2026-07-06T10:10:00.000Z",
        },
      ],
    });

    expect(ids).toEqual(["first", "second"]);
  });

  it("selects only due email queued notifications in scheduled order", () => {
    const notifications: NotificationRow[] = [
      makeNotificationRow({
        id: "future",
        delivery_channel: "email",
        scheduled_for: "2026-07-06T10:16:00.000Z",
      }),
      makeNotificationRow({
        id: "in-app",
        delivery_channel: "in_app",
        scheduled_for: "2026-07-06T09:00:00.000Z",
      }),
      makeNotificationRow({
        id: "sent-email",
        delivery_channel: "email",
        delivery_status: "sent",
        scheduled_for: "2026-07-06T08:00:00.000Z",
      }),
      makeNotificationRow({
        id: "second",
        delivery_channel: "email",
        scheduled_for: "2026-07-06T10:00:00.000Z",
      }),
      makeNotificationRow({
        id: "first",
        delivery_channel: "email",
        scheduled_for: "2026-07-06T07:00:00.000Z",
      }),
    ];

    expect(
      selectDueEmailAlertNotifications({
        notifications,
        now: new Date("2026-07-06T10:15:00.000Z"),
        limit: 2,
      }).map((notification) => notification.id),
    ).toEqual(["first", "second"]);
  });

  it("builds the dispatch patch used by the cron worker", () => {
    expect(buildAlertNotificationDispatchPatch(new Date("2026-07-06T10:15:00.000Z"))).toEqual({
      delivery_status: "sent",
      sent_at: "2026-07-06T10:15:00.000Z",
      updated_at: "2026-07-06T10:15:00.000Z",
    });
  });
});

function makeNotificationRow(overrides: Partial<NotificationRow>): NotificationRow {
  return {
    id: "notification-1",
    user_id: "user-1",
    alert_id: "alert-1",
    match_id: "match-1",
    sale_id: "sale-1",
    notification_kind: "instant_match",
    delivery_channel: "in_app",
    delivery_status: "queued",
    scheduled_for: "2026-07-06T10:00:00.000Z",
    sent_at: null,
    read_at: null,
    dismissed_at: null,
    notification_snapshot: {},
    created_at: "2026-07-06T09:00:00.000Z",
    updated_at: "2026-07-06T09:00:00.000Z",
    ...overrides,
  };
}

describe("Discovery notifications", () => {
  it("never exposes premium content or queues email even when requested", () => {
    const rows = buildAlertNotificationRows({
      userId: "user-1",
      matches: [
        makeMatch({
          saleTitle: "Private title",
          marketDiscountPct: 45,
          reasons: ["Private analysis"],
        }),
      ],
      alerts: [{ id: "alert-1", alert_frequency: "daily" }],
      includeEmail: true,
      discovery: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery_channel).toBe("in_app");
    expect(rows[0].notification_snapshot).toMatchObject({
      audience: "discovery",
      sale: { title: "Vente immobilière" },
      match: { marketDiscountPct: null, reasons: ["Critères publics correspondants"] },
    });
    expect(JSON.stringify(rows)).not.toContain("Private");
  });
});
