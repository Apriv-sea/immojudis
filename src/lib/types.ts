export type AuctionSale = {
  source_checks?: Record<string, { checked_at?: string }> | null;
  source_conflicts?: Array<{
    field?: string;
    selected?: string;
    alternative?: string;
    selected_source?: string;
    alternative_source?: string;
  }> | null;
  analysis_status?: string | null;
  source_presence?: Record<
    string,
    { state?: string; availability?: string; checked_at?: string }
  > | null;
  id: string;
  title: string | null;
  description: string | null;
  source_description: string | null;
  llm_display_description: string | null;
  about_description: string | null;
  city: string | null;
  department: string | null;
  postal_code: string | null;
  address: string | null;
  tribunal: string | null;
  tribunal_code: string | null;
  tribunal_name: string | null;
  tribunal_city: string | null;
  sale_venue_type?: SaleVenueType | null;
  sale_legal_framework?: SaleLegalFramework | null;
  sale_verification_status?: SaleVerificationStatus | null;
  sale_procedure?: Record<string, unknown> | null;
  property_type: string | null;
  starting_price_eur: number | null;
  sale_date: string | null;
  visit_dates: unknown;
  lawyer_name: string | null;
  lawyer_contact: string | null;
  adjudication_price_eur: number | null;
  latitude: number | null;
  longitude: number | null;
  occupancy_status: string | null;
  habitable_surface_m2: number | null;
  carrez_surface_m2: number | null;
  land_surface_m2: number | null;
  app_surface_m2: number | null;
  app_surface_kind: string | null;
  surface_scope: string | null;
  surface_source: string | null;
  surface_confidence: number | null;
  surface_evidence: string | null;
  rooms_count: number | null;
  bedrooms_count: number | null;
  bathrooms_count: number | null;
  parking_count: number | null;
  has_garden: boolean | null;
  has_terrace: boolean | null;
  has_garage: boolean | null;
  has_pool: boolean | null;
  has_air_conditioning: boolean | null;
  has_double_glazing: boolean | null;
  investment_score: number | null;
  investment_summary: string | null;
  score_version: string | null;
  score_confidence: number | null;
  score_factors: SaleScoreFactor[] | null;
  risk_notes: string | null;
  source_name: string | null;
  source_url: string | null;
  primary_source: string | null;
  source_urls: unknown;
  source_blocks: Record<string, unknown> | null;
  source_blocks_by_source: Record<string, Record<string, unknown>> | null;
  dedupe_confidence: string | null;
  quality_flags: unknown;
  documents: unknown;
  documents_rich: SaleDocumentRich[] | null;
  media: SaleMedia[] | null;
  risks: SaleRisk[] | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SaleVenueType = "tribunal" | "notary" | "state" | "online" | "unknown";

export type SaleLegalFramework =
  | "judicial_seizure"
  | "judicial_partition"
  | "insolvency"
  | "voluntary_notarial"
  | "state_sale"
  | "unknown";

export type SaleVerificationStatus = "verified" | "cross_checked" | "pending" | "conflict";

export type SaleFilters = {
  min_sale_date?: string;
  max_sale_date?: string;
  sale_venue_type?: Exclude<SaleVenueType, "online">;
  department?: string;
  departments?: string[];
  city?: string;
  postal_code?: string;
  tribunal?: string;
  property_type?: string;
  property_types?: string[];
  min_price?: number;
  max_price?: number;
  min_surface?: number;
  max_surface?: number;
  min_bedrooms?: number;
  min_bathrooms?: number;
  occupancy_status?: string;
  min_score?: number;
  tribunal_code?: string;
  status_in?: string[];
  keywords?: string;
  viewport?: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  // Client-side advanced filters
  max_price_per_m2?: number;
  min_yield_pct?: number;
  around_address?: string;
  around_radius_km?: number;
  only_new?: boolean;
};

export const SORT_KEYS = [
  "date_asc",
  "date_desc",
  "price_asc",
  "price_desc",
  "score_desc",
  "surface_desc",
] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export function asSearchString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function asSortKey(value: unknown): SortKey | undefined {
  return typeof value === "string" && SORT_KEYS.includes(value as SortKey)
    ? (value as SortKey)
    : undefined;
}

export type UserAlert = {
  id: string;
  user_id: string;
  name: string;
  department: string | null;
  city: string | null;
  property_type: string | null;
  max_price_eur: number | null;
  min_surface_m2: number | null;
  occupancy_status: string | null;
  min_investment_score: number | null;
  max_price_per_m2: number | null;
  min_yield_pct: number | null;
  min_market_discount_pct: number | null;
  dpe_classes: string[];
  require_house_with_land: boolean;
  alert_frequency: "instant" | "daily" | "weekly";
  last_evaluated_at: string | null;
  last_match_count: number;
  advanced_criteria: Record<string, unknown>;
  is_active: boolean;
  watched_zone_id: string | null;
  created_at: string;
  updated_at: string;
};

export type UserWatchedZone = {
  id: string;
  user_id: string;
  name: string;
  zone_kind: "department" | "city" | "postal_code" | "radius" | "custom";
  department: string | null;
  city: string | null;
  postal_code_prefix: string | null;
  center_lat: number | null;
  center_lng: number | null;
  radius_km: number | null;
  alert_defaults: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type SaleDocument = {
  url: string;
  name?: string;
  type?: string;
};

export type SaleDocumentRich = {
  url: string;
  label: string | null;
  type: string | null;
  document_type?: string | null;
  extraction_status: string | null;
  download_status?: string | null;
  docling_status?: string | null;
  text_chars?: number | null;
};

export type SaleMedia = {
  type: "image";
  url: string;
  source?: string | null;
};

export type SaleScoreFactor = {
  factor_order?: number | null;
  factor_key: string;
  label: string | null;
  reason: string | null;
  delta: number | null;
  weight?: number | null;
  raw_value?: unknown;
  normalized_value?: ScoreFactorExplanation | unknown;
  confidence?: number | null;
  evidence?: string | null;
  evidence_refs?: SaleEvidenceRef[] | unknown;
};

export type ScoreFactorExplanation = {
  status?: string | null;
  axis?: string | null;
  axis_label?: string | null;
  question?: string | null;
  decision?: string | null;
  criterion?: string | null;
  reasoning?: string | null;
  calculation?: string | null;
  score_before?: number | null;
  score_after?: number | null;
  confidence_note?: string | null;
  limits?: string | null;
  raw_value_label?: string | null;
  facts?: SaleAnalysisFact[] | unknown;
  proof_level?: string | null;
};

export type SaleEvidenceRef = {
  label?: string | null;
  document_label?: string | null;
  document_type?: string | null;
  page_number?: number | null;
  excerpt?: string | null;
  confidence?: number | null;
};

export type SaleAnalysisFact = {
  status?: string | null;
  statement?: string | null;
  document_label?: string | null;
  document_type?: string | null;
  page_number?: number | null;
  confidence?: number | null;
};

export type SaleRiskOccurrence = {
  document_url: string | null;
  document_label: string | null;
  document_type: string | null;
  page_number: number | null;
  excerpt: string | null;
  confidence: number | null;
  detector?: string | null;
  detector_version?: string | null;
  matched_terms?: unknown;
  score_impact?: number | null;
  updated_at?: string | null;
};

export type SaleRisk = {
  risk_type: string;
  risk_label: string;
  severity: number | null;
  evidence: string | null;
  evidence_json?: RiskEvidenceJson | unknown;
  confidence?: number | null;
  detector?: string | null;
  detector_version?: string | null;
  score_impact?: number | null;
  occurrences?: SaleRiskOccurrence[] | null;
};

export type RiskEvidenceJson = SaleEvidenceRef & {
  source_kind?: string | null;
  matched_terms?: unknown;
  occurrence_count?: number | null;
  risk_status?: string | null;
  source_status?: string | null;
  decision_chain?: Array<{ step?: string | null; decision?: string | null }> | unknown;
  verification_priority?: string | null;
  reasoning?: string | null;
  why_it_matters?: string | null;
  next_action?: string | null;
  document_context?: string | null;
  document_weight?: number | null;
  fact?: string | null;
  status?: string | null;
  question?: string | null;
  decision?: string | null;
  confidence_note?: string | null;
};
