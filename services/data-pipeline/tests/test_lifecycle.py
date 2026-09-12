from datetime import UTC, datetime, timedelta

from src.lifecycle import mark_past_sales
from src.models import AuctionSale


def _sale(status: str, sale_date: datetime | None) -> AuctionSale:
    return AuctionSale(
        source_name="test",
        source_url=f"https://example.com/{status}/{sale_date}",
        status=status,
        sale_date=sale_date,
    )


def test_mark_past_sales_marks_expired_upcoming_sales() -> None:
    now = datetime(2026, 5, 19, tzinfo=UTC)
    sale = _sale("upcoming", now - timedelta(days=1))

    stats = mark_past_sales([sale], now=now)

    assert sale.status == "past"
    assert stats.marked_past == 1


def test_mark_past_sales_preserves_future_and_adjudicated_sales() -> None:
    now = datetime(2026, 5, 19, tzinfo=UTC)
    future = _sale("upcoming", now + timedelta(days=1))
    adjudicated = _sale("adjudicated", now - timedelta(days=1))

    stats = mark_past_sales([future, adjudicated], now=now)

    assert future.status == "upcoming"
    assert adjudicated.status == "adjudicated"
    assert stats.marked_past == 0


def test_report_and_cancellation_are_not_overwritten_by_the_clock():
    now = datetime(2026, 9, 12, tzinfo=UTC)
    for status in ('postponed', 'cancelled', 'withdrawn', 'adjudicated'):
        sale = _sale(status, now - timedelta(days=4))
        assert mark_past_sales([sale], now=now).marked_past == 0
        assert sale.status == status


def test_open_sale_window_is_not_marked_past_at_its_start():
    now = datetime(2026, 9, 12, tzinfo=UTC)
    sale = _sale('upcoming', now - timedelta(days=1))
    sale.sale_procedure = {'sale_window': {'opens_at': (now - timedelta(days=1)).isoformat(),
                                         'closes_at': (now + timedelta(days=1)).isoformat()}}
    assert mark_past_sales([sale], now=now).marked_past == 0
    assert sale.status == 'upcoming'
