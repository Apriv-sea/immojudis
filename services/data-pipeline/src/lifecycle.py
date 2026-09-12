from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from src.admission import retention_deadline
from src.models import AuctionSale


@dataclass
class SaleLifecycleStats:
    marked_past: int = 0


def mark_past_sales(sales: list[AuctionSale], now: datetime | None = None) -> SaleLifecycleStats:
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)

    stats = SaleLifecycleStats()
    for sale in sales:
        if sale.sale_date is None or sale.status not in {"active", "upcoming", "unknown"}:
            continue
        deadline = retention_deadline(sale)
        if deadline is None:
            continue
        sale_date = deadline - timedelta(hours=24)
        if sale_date < now and sale.status != "past":
            sale.status = "past"
            stats.marked_past += 1
    return stats
