import { supabase } from "@/integrations/supabase/client";
import type { AudienceTrackingResponse } from "@/lib/audience-tracking";
import type {
  AlertNotificationListResponse,
  AlertNotificationSummary,
} from "@/lib/alert-notifications";
import type {
  AdminDashboardData,
  AdminScrollMode,
  AdminScrollSource,
  StartScrollResult,
} from "@/lib/admin.functions";
import type { ApiKeyCreateInput, ApiKeyCreateResponse, ApiKeyListResponse } from "@/lib/api-keys";
import type {
  AdminReferencedLawyerInput,
  AdminReferencedLawyerListResponse,
  AdminReferencedLawyerSaveResponse,
} from "@/lib/admin-lawyers";
import type {
  AdminLawyerReferralListResponse,
  AdminLawyerReferralUpdateInput,
  AdminLawyerReferralUpdateResponse,
} from "@/lib/admin-lawyer-referrals";
import type {
  AdminSubscriptionGrantInput,
  AdminSubscriptionGrantResponse,
  AdminSubscriptionListResponse,
} from "@/lib/admin-subscriptions";
import type { AdminOperationalReadinessResponse } from "@/lib/admin-readiness";
import type { AlertEvaluationResponse, AlertMatchSummary } from "@/lib/alert-matches";
import type { BidCeilingAnalysisResponse, BidCeilingRequestInput } from "@/lib/bid-ceiling";
import type { EnvironmentalContextResponse } from "@/lib/environment.functions";
import type { FeaturedReferencedLawyerResponse } from "@/lib/featured-lawyers";
import type { LawyerDirectoryResponse } from "@/lib/lawyer-directory";
import type {
  LawyerPlacementEventInput,
  LawyerPlacementEventResponse,
} from "@/lib/lawyer-placement-events";
import type {
  FavoriteSaleDeleteResponse,
  FavoriteSaleInput,
  FavoriteSaleMutationResponse,
  FavoriteSalesResponse,
} from "@/lib/favorites";
import type {
  LawyerReferralListResponse,
  LawyerReferralRequestInput,
  LawyerReferralResponse,
} from "@/lib/lawyer-referrals";
import type { MarketAnalyticsResponse } from "@/lib/market-analytics";
import type { MarketContext } from "@/lib/market.functions";
import type { OutcomeGraphForecast } from "@/lib/outcome-graph";
import type {
  NotificationPreferencesResponse,
  NotificationPreferenceUpdateInput,
} from "@/lib/notification-preferences";
import type {
  PropertyReportListResponse,
  PropertyReportRequestInput,
  PropertyReportSaveResponse,
  PropertyReportShareResponse,
  PropertyReportUpdateInput,
  PlanEntitlements,
} from "@/lib/property-reports";
import type { BillingSessionResponse } from "@/lib/billing";
import type {
  DataRefreshListResponse,
  DataRefreshRequestInput,
  DataRefreshRequestResponse,
} from "@/lib/data-refresh";
import type { DataQualityReport } from "@/lib/data-quality-monitor";
import type { DvfComparablesResponse } from "@/lib/dvf-comparables";
import type { DpeExplorerResponse } from "@/lib/dpe-explorer";
import type { SaleHistoryResponse } from "@/lib/sale-history";
import type { ValuationBacktestResponse } from "@/lib/valuation-backtest";
import type { ValuationAdminResponse } from "@/lib/valuation-admin";
import type {
  SaleChangeEventListResponse,
  SaleChangeEventSummary,
  SaleChangeMonitorResponse,
} from "@/lib/sale-change-monitor";
import type { SalesStatisticsResponse } from "@/lib/sales-statistics";
import type {
  CollaboratorAcceptInput,
  CollaboratorInviteInput,
  CollaboratorRevokeInput,
  SaleWorkspaceCollaborationResponse,
  WorkspaceAnnotationCreateInput,
  WorkspaceAnnotationUpdateInput,
} from "@/lib/sale-workspace-collaboration";
import type { SaleWorkspaceInput, SaleWorkspaceResponse } from "@/lib/sale-workspaces";
import type {
  SaleAnalysisSetInput,
  SaleAnalysisSetListResponse,
  SaleAnalysisSetResponse,
  SaleAnalysisSetUpdateInput,
  SaleComparisonShareResponse,
} from "@/lib/sale-analysis-sets";
import { salesSearchToUrlRecord, type SalesSearchParams } from "@/lib/search/search-url-state";
import type { PlanUsageSummary } from "@/lib/usage";
import type { PlanCode } from "@/lib/plans";
import type {
  WatchedZoneInput,
  WatchedZoneResponse,
  WatchedZonesResponse,
  WatchedZoneUpdateInput,
} from "@/lib/watched-zones";
import type {
  PrivacyRequestAdminListResponse,
  PrivacyRequestAdminSummary,
  PrivacyRequestAdminUpdate,
  PrivacyRequestInput,
  PrivacyRequestListResponse,
  PrivacyRequestSummary,
} from "@/lib/privacy-requests";
import type {
  InformationAgentActionInput,
  InformationAgentCreateInput,
  InformationAgentListResponse,
  InformationAgentResponse,
} from "@/lib/information-agent";
import type {
  InformationAgentEmailTemplateContent,
  InformationAgentEmailTemplatePreview,
  InformationAgentEmailTemplateWorkspace,
} from "@/lib/information-agent-email-template";

async function authHeaders(): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Connexion requise.");
  }

  return {
    Authorization: `Bearer ${session.access_token}`,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }

  return payload as T;
}

export async function fetchInformationAgentMissions(args: {
  saleId: string;
}): Promise<InformationAgentListResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/information-agent?${search.toString()}`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<InformationAgentListResponse>(response);
}

export async function createInformationAgentDraftClient(args: {
  data: InformationAgentCreateInput;
}): Promise<InformationAgentResponse> {
  const response = await fetch("/api/information-agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(args.data),
  });
  return readJson<InformationAgentResponse>(response);
}

export async function runInformationAgentActionClient(args: {
  data: InformationAgentActionInput;
}): Promise<InformationAgentListResponse> {
  const response = await fetch("/api/information-agent", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(args.data),
  });
  return readJson<InformationAgentListResponse>(response);
}

export async function fetchPrecomputedMarketEstimate(args: {
  saleId: string;
}): Promise<MarketContext> {
  const response = await fetch("/api/market-estimate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ saleId: args.saleId }),
  });

  const payload = (await response.json().catch(() => null)) as MarketContext | null;
  if (response.status === 401 || response.status === 403 || !payload) {
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }
  return payload;
}

export async function fetchOutcomeGraphForecast(args: {
  saleId: string;
}): Promise<{ forecast: OutcomeGraphForecast }> {
  const response = await fetch(`/api/v1/sales/${encodeURIComponent(args.saleId)}/outcome-graph`, {
    headers: await authHeaders(),
    cache: "no-store",
  });

  return readJson<{ forecast: OutcomeGraphForecast }>(response);
}

export async function fetchValuationAdminOverview(): Promise<ValuationAdminResponse> {
  const response = await fetch("/api/admin/valuation-models", {
    headers: await authHeaders(),
  });
  return readJson<ValuationAdminResponse>(response);
}

export async function fetchEnvironmentalContext(args: {
  data: unknown;
}): Promise<EnvironmentalContextResponse> {
  const response = await fetch("/api/environment-context", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<EnvironmentalContextResponse>(response);
}

export async function calculateBidCeilingClient(args: {
  data: BidCeilingRequestInput;
}): Promise<BidCeilingAnalysisResponse> {
  const response = await fetch("/api/bid-ceiling", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<BidCeilingAnalysisResponse>(response);
}

export async function fetchFavoriteSales(): Promise<FavoriteSalesResponse> {
  const response = await fetch("/api/favorites", {
    headers: await authHeaders(),
  });

  return readJson<FavoriteSalesResponse>(response);
}

export async function addFavoriteSale(args: {
  data: FavoriteSaleInput;
}): Promise<FavoriteSaleMutationResponse> {
  const response = await fetch("/api/favorites", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<FavoriteSaleMutationResponse>(response);
}

export async function removeFavoriteSale(args: {
  saleId: string;
}): Promise<FavoriteSaleDeleteResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/favorites?${search.toString()}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<FavoriteSaleDeleteResponse>(response);
}

export async function requestLawyerReferral(args: {
  data: LawyerReferralRequestInput;
}): Promise<LawyerReferralResponse> {
  const response = await fetch("/api/lawyer-referrals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<LawyerReferralResponse>(response);
}

export async function fetchLawyerReferrals(
  args: {
    saleId?: string;
    limit?: number;
  } = {},
): Promise<LawyerReferralListResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  if (args.limit) search.set("limit", String(args.limit));
  const response = await fetch(
    `/api/lawyer-referrals${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<LawyerReferralListResponse>(response);
}

export async function fetchPropertyReports(
  args: {
    saleId?: string;
  } = {},
): Promise<PropertyReportListResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  const url = `/api/property-reports${search.size ? `?${search.toString()}` : ""}`;

  const response = await fetch(url, {
    headers: await authHeaders(),
  });

  return readJson<PropertyReportListResponse>(response);
}

export async function savePropertyReport(args: {
  data: PropertyReportRequestInput;
}): Promise<PropertyReportSaveResponse> {
  const response = await fetch("/api/property-reports", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<PropertyReportSaveResponse>(response);
}

export async function updatePropertyReport(args: {
  reportId: string;
  data: PropertyReportUpdateInput;
}): Promise<PropertyReportSaveResponse> {
  const response = await fetch(`/api/property-reports/${args.reportId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<PropertyReportSaveResponse>(response);
}

export async function exportPropertyReportPdf(args: {
  reportId: string;
}): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/property-reports/${args.reportId}/export`, {
    method: "POST",
    headers: await authHeaders(),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }

  const filename =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1]
      ?.trim() || "rapport-immojudis.pdf";

  return {
    blob: await response.blob(),
    filename,
  };
}

export async function enablePropertyReportShare(args: {
  reportId: string;
  expiresAt?: string | null;
}): Promise<PropertyReportShareResponse> {
  const response = await fetch(`/api/property-reports/${args.reportId}/share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ expiresAt: args.expiresAt ?? null }),
  });

  return readJson<PropertyReportShareResponse>(response);
}

export async function disablePropertyReportShare(args: {
  reportId: string;
}): Promise<PropertyReportShareResponse> {
  const response = await fetch(`/api/property-reports/${args.reportId}/share`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<PropertyReportShareResponse>(response);
}

export async function fetchAccessPlan(): Promise<{ plan: PlanEntitlements }> {
  const response = await fetch("/api/feature-entitlements?scope=plan", {
    headers: await authHeaders(),
  });
  return readJson<{ plan: PlanEntitlements }>(response);
}

export async function fetchFeatureEntitlements(): Promise<{
  plan: PlanEntitlements;
  usage: PlanUsageSummary;
}> {
  const response = await fetch("/api/feature-entitlements", {
    headers: await authHeaders(),
  });

  return readJson<{ plan: PlanEntitlements; usage: PlanUsageSummary }>(response);
}

export async function fetchAlertMatches(
  args: {
    limit?: number;
    includeDismissed?: boolean;
  } = {},
): Promise<{ matches: AlertMatchSummary[] }> {
  const search = new URLSearchParams();
  if (args.limit) search.set("limit", String(args.limit));
  if (args.includeDismissed) search.set("includeDismissed", "true");
  const response = await fetch(`/api/alerts/matches${search.size ? `?${search.toString()}` : ""}`, {
    headers: await authHeaders(),
  });

  return readJson<{ matches: AlertMatchSummary[] }>(response);
}

export async function evaluateAlertMatches(
  args: {
    saleLimit?: number;
    persist?: boolean;
  } = {},
): Promise<AlertEvaluationResponse> {
  const response = await fetch("/api/alerts/matches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args),
  });

  return readJson<AlertEvaluationResponse>(response);
}

export async function fetchAlertNotifications(
  args: {
    limit?: number;
    includeDismissed?: boolean;
    includeQueued?: boolean;
  } = {},
): Promise<AlertNotificationListResponse> {
  const search = new URLSearchParams();
  if (args.limit) search.set("limit", String(args.limit));
  if (args.includeDismissed) search.set("includeDismissed", "true");
  if (args.includeQueued) search.set("includeQueued", "true");

  const response = await fetch(
    `/api/alerts/notifications${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<AlertNotificationListResponse>(response);
}

export async function updateAlertNotification(args: {
  notificationId: string;
  action: "read" | "unread" | "dismiss" | "restore";
}): Promise<{ notification: AlertNotificationSummary }> {
  const response = await fetch("/api/alerts/notifications", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args),
  });

  return readJson<{ notification: AlertNotificationSummary }>(response);
}

export async function fetchSaleChangeEvents(
  args: {
    limit?: number;
    includeDismissed?: boolean;
  } = {},
): Promise<SaleChangeEventListResponse> {
  const search = new URLSearchParams();
  if (args.limit) search.set("limit", String(args.limit));
  if (args.includeDismissed) search.set("includeDismissed", "true");
  const response = await fetch(
    `/api/sale-change-events${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<SaleChangeEventListResponse>(response);
}

export async function monitorSaleChanges(): Promise<SaleChangeMonitorResponse> {
  const response = await fetch("/api/sale-change-events", {
    method: "POST",
    headers: await authHeaders(),
  });

  return readJson<SaleChangeMonitorResponse>(response);
}

export async function updateSaleChangeEvent(args: {
  eventId: string;
  action: "read" | "unread" | "dismiss" | "restore";
}): Promise<{ event: SaleChangeEventSummary }> {
  const response = await fetch("/api/sale-change-events", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args),
  });

  return readJson<{ event: SaleChangeEventSummary }>(response);
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferencesResponse> {
  const response = await fetch("/api/notification-preferences", {
    headers: await authHeaders(),
  });

  return readJson<NotificationPreferencesResponse>(response);
}

export async function updateNotificationPreferences(
  data: NotificationPreferenceUpdateInput,
): Promise<NotificationPreferencesResponse> {
  const response = await fetch("/api/notification-preferences", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(data),
  });

  return readJson<NotificationPreferencesResponse>(response);
}

export async function fetchSaleWorkspace(args: { saleId: string }): Promise<SaleWorkspaceResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/sale-workspace?${search.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<SaleWorkspaceResponse>(response);
}

export async function fetchAudienceTracking(
  args: {
    includeArchived?: boolean;
  } = {},
): Promise<AudienceTrackingResponse> {
  const search = new URLSearchParams();
  if (args.includeArchived) search.set("includeArchived", "true");
  const response = await fetch(
    `/api/audience-tracking${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<AudienceTrackingResponse>(response);
}

export async function saveSaleWorkspace(args: {
  data: SaleWorkspaceInput;
}): Promise<SaleWorkspaceResponse> {
  const response = await fetch("/api/sale-workspace", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<SaleWorkspaceResponse>(response);
}

export async function fetchSaleWorkspaceCollaboration(args: {
  saleId: string;
}): Promise<SaleWorkspaceCollaborationResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/sale-workspace/collaboration?${search.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<SaleWorkspaceCollaborationResponse>(response);
}

export async function inviteSaleWorkspaceCollaboratorClient(args: {
  data: CollaboratorInviteInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "invite", data: args.data }),
  });

  return readJson(response);
}

export async function acceptSaleWorkspaceInvitationClient(args: { data: CollaboratorAcceptInput }) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "accept", data: args.data }),
  });

  return readJson(response);
}

export async function createSaleWorkspaceAnnotationClient(args: {
  data: WorkspaceAnnotationCreateInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "annotate", data: args.data }),
  });

  return readJson(response);
}

export async function updateSaleWorkspaceAnnotationClient(args: {
  data: WorkspaceAnnotationUpdateInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "update_annotation", data: args.data }),
  });

  return readJson(response);
}

export async function revokeSaleWorkspaceCollaboratorClient(args: {
  data: CollaboratorRevokeInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "revoke", data: args.data }),
  });

  return readJson(response);
}

export async function fetchWatchedZones(
  args: {
    includeInactive?: boolean;
  } = {},
): Promise<WatchedZonesResponse> {
  const search = new URLSearchParams();
  if (args.includeInactive) search.set("includeInactive", "true");
  const response = await fetch(`/api/watched-zones${search.size ? `?${search.toString()}` : ""}`, {
    headers: await authHeaders(),
  });

  return readJson<WatchedZonesResponse>(response);
}

export async function createWatchedZone(args: {
  data: WatchedZoneInput;
}): Promise<WatchedZoneResponse> {
  const response = await fetch("/api/watched-zones", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<WatchedZoneResponse>(response);
}

export async function updateWatchedZone(args: {
  zoneId: string;
  data: WatchedZoneUpdateInput;
}): Promise<WatchedZoneResponse> {
  const response = await fetch(`/api/watched-zones/${args.zoneId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<WatchedZoneResponse>(response);
}

export async function deleteWatchedZone(args: { zoneId: string }): Promise<{ ok: true }> {
  const response = await fetch(`/api/watched-zones/${args.zoneId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<{ ok: true }>(response);
}

export async function fetchFeaturedReferencedLawyer(args: {
  saleId: string;
}): Promise<FeaturedReferencedLawyerResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/lawyers/featured?${search.toString()}`);

  return readJson<FeaturedReferencedLawyerResponse>(response);
}

export async function fetchLawyerDirectory(
  args: { saleId?: string; bar?: string; city?: string; department?: string } = {},
): Promise<LawyerDirectoryResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  if (args.bar) search.set("bar", args.bar);
  if (args.city) search.set("city", args.city);
  if (args.department) search.set("department", args.department);
  const suffix = search.size ? `?${search.toString()}` : "";
  const response = await fetch(`/api/lawyers/directory${suffix}`);
  return readJson<LawyerDirectoryResponse>(response);
}

export async function recordLawyerPlacementEvent(args: {
  data: LawyerPlacementEventInput;
}): Promise<LawyerPlacementEventResponse> {
  const response = await fetch("/api/lawyers/placement-events", {
    method: "POST",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<LawyerPlacementEventResponse>(response);
}

export async function fetchSaleAnalysisSets(
  args: {
    includeArchived?: boolean;
  } = {},
): Promise<SaleAnalysisSetListResponse> {
  const search = new URLSearchParams();
  if (args.includeArchived) search.set("includeArchived", "true");
  const response = await fetch(
    `/api/sale-analysis-sets${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<SaleAnalysisSetListResponse>(response);
}

export async function createSaleAnalysisSet(args: {
  data: SaleAnalysisSetInput;
}): Promise<SaleAnalysisSetResponse> {
  const response = await fetch("/api/sale-analysis-sets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<SaleAnalysisSetResponse>(response);
}

export async function updateSaleAnalysisSet(args: {
  setId: string;
  data: SaleAnalysisSetUpdateInput;
}): Promise<SaleAnalysisSetResponse> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<SaleAnalysisSetResponse>(response);
}

export async function deleteSaleAnalysisSet(args: { setId: string }): Promise<{ ok: true }> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<{ ok: true }>(response);
}

export async function enableSaleComparisonShare(args: {
  setId: string;
}): Promise<SaleComparisonShareResponse> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}/share`, {
    method: "POST",
    headers: await authHeaders(),
  });

  return readJson<SaleComparisonShareResponse>(response);
}

export async function disableSaleComparisonShare(args: {
  setId: string;
}): Promise<SaleComparisonShareResponse> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}/share`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<SaleComparisonShareResponse>(response);
}

export async function fetchSaleHistory(args: {
  saleId?: string;
  department?: string;
  city?: string;
  tribunalCode?: string;
  propertyType?: string;
  months?: number;
  limit?: number;
}): Promise<SaleHistoryResponse> {
  const params = new URLSearchParams();
  if (args.saleId) params.set("saleId", args.saleId);
  if (args.department) params.set("department", args.department);
  if (args.city) params.set("city", args.city);
  if (args.tribunalCode) params.set("tribunalCode", args.tribunalCode);
  if (args.propertyType) params.set("propertyType", args.propertyType);
  if (args.months) params.set("months", String(args.months));
  if (args.limit) params.set("limit", String(args.limit));

  const response = await fetch(`/api/sales/history?${params.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<SaleHistoryResponse>(response);
}

export async function fetchMarketAnalytics(args: {
  saleId?: string;
  department?: string;
  city?: string;
  tribunalCode?: string;
  propertyType?: string;
  months?: number;
  futureMonths?: number;
  limit?: number;
}): Promise<MarketAnalyticsResponse> {
  const params = new URLSearchParams();
  if (args.saleId) params.set("saleId", args.saleId);
  if (args.department) params.set("department", args.department);
  if (args.city) params.set("city", args.city);
  if (args.tribunalCode) params.set("tribunalCode", args.tribunalCode);
  if (args.propertyType) params.set("propertyType", args.propertyType);
  if (args.months) params.set("months", String(args.months));
  if (args.futureMonths != null) params.set("futureMonths", String(args.futureMonths));
  if (args.limit) params.set("limit", String(args.limit));

  const response = await fetch(`/api/market-analytics?${params.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<MarketAnalyticsResponse>(response);
}

export async function fetchDvfComparables(args: {
  saleId: string;
  radiusM?: number;
  months?: number;
  limit?: number;
}): Promise<DvfComparablesResponse> {
  const params = new URLSearchParams({ saleId: args.saleId });
  if (args.radiusM) params.set("radiusM", String(args.radiusM));
  if (args.months) params.set("months", String(args.months));
  if (args.limit) params.set("limit", String(args.limit));

  const response = await fetch(`/api/dvf-comparables?${params.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<DvfComparablesResponse>(response);
}

export async function fetchValuationBacktest(args: {
  saleId: string;
  radiusM?: number;
  months?: number;
  maxTests?: number;
}): Promise<ValuationBacktestResponse> {
  const params = new URLSearchParams({ saleId: args.saleId });
  if (args.radiusM) params.set("radiusM", String(args.radiusM));
  if (args.months) params.set("months", String(args.months));
  if (args.maxTests) params.set("maxTests", String(args.maxTests));

  const response = await fetch(`/api/valuation-backtest?${params.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<ValuationBacktestResponse>(response);
}

export async function fetchDpeExplorer(args: {
  department?: string;
  city?: string;
  propertyType?: string;
  dpeClasses?: string[];
  includeMap?: boolean;
  limit?: number;
}): Promise<DpeExplorerResponse> {
  const params = new URLSearchParams();
  if (args.department) params.set("department", args.department);
  if (args.city) params.set("city", args.city);
  if (args.propertyType) params.set("propertyType", args.propertyType);
  if (args.dpeClasses?.length) params.set("dpeClasses", args.dpeClasses.join(","));
  if (args.includeMap != null) params.set("includeMap", String(args.includeMap));
  if (args.limit) params.set("limit", String(args.limit));

  const response = await fetch(`/api/dpe/explorer?${params.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<DpeExplorerResponse>(response);
}

export async function requestDataRefresh(
  input: DataRefreshRequestInput,
): Promise<DataRefreshRequestResponse> {
  const response = await fetch("/api/data-refresh", {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return readJson<DataRefreshRequestResponse>(response);
}

export async function fetchDataRefreshRequests(
  args: {
    saleId?: string;
    status?: string;
  } = {},
): Promise<DataRefreshListResponse> {
  const params = new URLSearchParams();
  if (args.saleId) params.set("saleId", args.saleId);
  if (args.status) params.set("status", args.status);
  const response = await fetch(`/api/data-refresh${params.size ? `?${params.toString()}` : ""}`, {
    headers: await authHeaders(),
  });

  return readJson<DataRefreshListResponse>(response);
}

export async function fetchSalesStatistics(args: {
  search: SalesSearchParams;
}): Promise<SalesStatisticsResponse> {
  const params = new URLSearchParams();
  Object.entries(salesSearchToUrlRecord(args.search)).forEach(([key, value]) => {
    if (value != null && value !== "") params.set(key, String(value));
  });
  const response = await fetch(
    `/api/sales/statistics${params.size ? `?${params.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<SalesStatisticsResponse>(response);
}

export async function exportSalesCsv(args: {
  search: SalesSearchParams;
}): Promise<{ blob: Blob; filename: string }> {
  const params = new URLSearchParams();
  Object.entries(salesSearchToUrlRecord(args.search)).forEach(([key, value]) => {
    if (value != null && value !== "") params.set(key, String(value));
  });
  const url = `/api/sales/export${params.size ? `?${params.toString()}` : ""}`;
  const response = await fetch(url, {
    headers: await authHeaders(),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }

  const filename =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1]
      ?.trim() || "immojudis-ventes.csv";

  return {
    blob: await response.blob(),
    filename,
  };
}

export async function startAnalyseCheckout(args: {
  plan?: Exclude<PlanCode, "decouverte">;
  consent: {
    termsAccepted: true;
    termsVersion: string;
    privacyVersion: string;
    paymentObligationAcknowledged: true;
    immediatePerformanceRequested: true;
    withdrawalInformationAcknowledged: true;
  };
}): Promise<BillingSessionResponse> {
  const response = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ plan: args.plan ?? "analyse", consent: args.consent }),
  });

  return readJson<BillingSessionResponse>(response);
}

export async function fetchPrivacyRequests(): Promise<PrivacyRequestListResponse> {
  const response = await fetch("/api/privacy/requests", { headers: await authHeaders() });
  return readJson<PrivacyRequestListResponse>(response);
}

export async function createPrivacyRequestClient(
  data: PrivacyRequestInput,
): Promise<PrivacyRequestSummary> {
  const response = await fetch("/api/privacy/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<PrivacyRequestSummary>(response);
}

export async function fetchAdminPrivacyRequests(): Promise<PrivacyRequestAdminListResponse> {
  const response = await fetch("/api/admin/privacy-requests", { headers: await authHeaders() });
  return readJson<PrivacyRequestAdminListResponse>(response);
}

export async function updateAdminPrivacyRequest(
  data: PrivacyRequestAdminUpdate,
): Promise<PrivacyRequestAdminSummary> {
  const response = await fetch("/api/admin/privacy-requests", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<PrivacyRequestAdminSummary>(response);
}

export async function openBillingPortal(): Promise<BillingSessionResponse> {
  const response = await fetch("/api/billing/portal", {
    method: "POST",
    headers: await authHeaders(),
  });

  return readJson<BillingSessionResponse>(response);
}

export async function fetchAdminDashboard(): Promise<AdminDashboardData> {
  const response = await fetch("/api/admin/dashboard", {
    headers: await authHeaders(),
  });

  return readJson<AdminDashboardData>(response);
}

export async function fetchAdminInformationAgentEmailTemplate(): Promise<InformationAgentEmailTemplateWorkspace> {
  const response = await fetch("/api/admin/information-agent/template", {
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<InformationAgentEmailTemplateWorkspace>(response);
}

export async function previewAdminInformationAgentEmailTemplate(
  template: InformationAgentEmailTemplateContent,
): Promise<{ preview: InformationAgentEmailTemplatePreview }> {
  const response = await fetch("/api/admin/information-agent/template", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ action: "preview", template }),
  });
  return readJson<{ preview: InformationAgentEmailTemplatePreview }>(response);
}

export async function saveAdminInformationAgentEmailTemplateDraft(args: {
  draftId: string | null;
  template: InformationAgentEmailTemplateContent;
}): Promise<InformationAgentEmailTemplateWorkspace> {
  const response = await fetch("/api/admin/information-agent/template", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ action: "save_draft", ...args }),
  });
  return readJson<InformationAgentEmailTemplateWorkspace>(response);
}

export async function publishAdminInformationAgentEmailTemplateDraft(
  draftId: string,
): Promise<InformationAgentEmailTemplateWorkspace> {
  const response = await fetch("/api/admin/information-agent/template", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ action: "publish", draftId, publicationConfirmed: true }),
  });
  return readJson<InformationAgentEmailTemplateWorkspace>(response);
}

export async function fetchAdminDataQuality(): Promise<DataQualityReport> {
  const response = await fetch("/api/admin/data-quality", {
    headers: await authHeaders(),
  });

  return readJson<DataQualityReport>(response);
}

export async function startAdminScrollRequest(args: {
  data: { source: AdminScrollSource; mode?: AdminScrollMode; limit?: number };
}): Promise<StartScrollResult> {
  const response = await fetch("/api/admin/scroll", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<StartScrollResult>(response);
}

export async function fetchAdminReadiness(): Promise<AdminOperationalReadinessResponse> {
  const response = await fetch("/api/admin/readiness", {
    headers: await authHeaders(),
  });

  return readJson<AdminOperationalReadinessResponse>(response);
}

export async function fetchAdminReferencedLawyers(): Promise<AdminReferencedLawyerListResponse> {
  const response = await fetch("/api/admin/lawyers", {
    headers: await authHeaders(),
  });

  return readJson<AdminReferencedLawyerListResponse>(response);
}

export async function saveAdminReferencedLawyer(args: {
  data: AdminReferencedLawyerInput;
}): Promise<AdminReferencedLawyerSaveResponse> {
  const response = await fetch("/api/admin/lawyers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<AdminReferencedLawyerSaveResponse>(response);
}

export async function fetchAdminLawyerReferralRequests(): Promise<AdminLawyerReferralListResponse> {
  const response = await fetch("/api/admin/lawyer-referrals", {
    headers: await authHeaders(),
  });

  return readJson<AdminLawyerReferralListResponse>(response);
}

export async function updateAdminLawyerReferralRequest(args: {
  data: AdminLawyerReferralUpdateInput;
}): Promise<AdminLawyerReferralUpdateResponse> {
  const response = await fetch("/api/admin/lawyer-referrals", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<AdminLawyerReferralUpdateResponse>(response);
}

export async function fetchAdminSubscriptions(): Promise<AdminSubscriptionListResponse> {
  const response = await fetch("/api/admin/subscriptions", {
    headers: await authHeaders(),
  });

  return readJson<AdminSubscriptionListResponse>(response);
}

export async function grantAdminSubscription(args: {
  data: AdminSubscriptionGrantInput;
}): Promise<AdminSubscriptionGrantResponse> {
  const response = await fetch("/api/admin/subscriptions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<AdminSubscriptionGrantResponse>(response);
}

export async function fetchApiKeys(): Promise<ApiKeyListResponse> {
  const response = await fetch("/api/api-keys", {
    headers: await authHeaders(),
  });

  return readJson<ApiKeyListResponse>(response);
}

export async function createApiKey(args: {
  data: ApiKeyCreateInput;
}): Promise<ApiKeyCreateResponse> {
  const response = await fetch("/api/api-keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<ApiKeyCreateResponse>(response);
}

export async function revokeApiKey(args: { keyId: string }): Promise<void> {
  const response = await fetch(`/api/api-keys/${encodeURIComponent(args.keyId)}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  await readJson<{ key: unknown }>(response);
}
