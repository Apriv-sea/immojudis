import type { UserAlert } from "@/lib/types";

/** Also enforced by the database; checked again for old alerts after downgrade. */
export function isDiscoveryAlertCompatible(alert: UserAlert): boolean {
  return (
    alert.min_investment_score == null &&
    alert.min_yield_pct == null &&
    alert.min_market_discount_pct == null &&
    alert.occupancy_status == null &&
    !alert.dpe_classes?.length &&
    !alert.require_house_with_land &&
    alert.alert_frequency === "daily" &&
    !alert.advanced_criteria?.query
  );
}
