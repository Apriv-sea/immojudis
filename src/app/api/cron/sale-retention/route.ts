import { runMonitoredCron } from "@/lib/cron-jobs";
import { runSaleRetention } from "@/lib/sale-retention";

export const maxDuration = 300;
export async function GET(request: Request) {
  return runMonitoredCron(request, "sale-retention", () => runSaleRetention());
}
