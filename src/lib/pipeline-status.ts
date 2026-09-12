export type PipelineSourceState = {
  source_name: string;
  enabled: boolean;
  availability: string;
  last_inventory_complete_at: string | null;
  last_publication_complete_at: string | null;
  next_inventory_at: string;
  suspended_until: string | null;
  suspension_reason: string | null;
  last_error: string | null;
};
export type PipelineStatus = {
  usage: {
    ai_requests: number;
    ai_estimated_usd: number;
    ai_unpriced_requests: number;
    daily_ai_budget_usd: number;
    runner_seconds: number;
  };
  sources: PipelineSourceState[];
  control: { enabled: boolean; observation_started_at: string | null };
  observations: Array<{
    source_name: string;
    observed_at: string;
    metrics: Record<string, unknown>;
  }>;
  alerts: Array<{
    alert_key: string;
    status: string;
    notification_status: string;
    notification_event: string;
  }>;
};
