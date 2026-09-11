"""Minimum collection admission shared by publication entry points."""
from decimal import Decimal, InvalidOperation

from src.models import AuctionSale


def has_price_or_surface(sale: AuctionSale) -> bool:
    for name in ("starting_price_eur", "surface_m2", "habitable_surface_m2",
                 "carrez_surface_m2", "land_surface_m2", "app_surface_m2"):
        value = getattr(sale, name, None)
        if value is None:
            continue
        try:
            number = Decimal(str(value))
            if number.is_finite() and number > 0:
                return True
        except (InvalidOperation, ValueError):
            continue
    return False


def retention_deadline(sale: AuctionSale):
    """Mirror the database retention deadline; uncertain schedules are retained."""
    import re
    from datetime import UTC, datetime, timedelta
    from zoneinfo import ZoneInfo

    if str(sale.status or '').lower() in {'postponed', 'reported', 'reportee', 'reporté', 'reportée'}:
        return None
    procedure = sale.sale_procedure or {}
    for schedule in (procedure.get('sale_window'), procedure.get('sale_session'), sale.raw_payload.get('source_sale_schedule')):
        if schedule is None:
            continue
        try:
            start = datetime.fromisoformat(schedule['opens_at'])
            end = datetime.fromisoformat(schedule['closes_at'])
            if start.tzinfo is None or end.tzinfo is None or end <= start:
                return None
            return end.astimezone(UTC) + timedelta(hours=24)
        except (KeyError, TypeError, ValueError):
            return None
    if sale.sale_date is None:
        return None
    date = sale.sale_date.replace(tzinfo=UTC) if sale.sale_date.tzinfo is None else sale.sale_date
    raw_date = str(sale.raw_payload.get('sale_date') or '')
    if raw_date and not re.search(r'[0-9]{1,2}\s*([hH]|:[0-9]{2})', raw_date):
        date = datetime.combine(date.astimezone(UTC).date(), datetime.min.time(), ZoneInfo('Europe/Paris'))
    return date.astimezone(UTC) + timedelta(hours=24)


def is_expired(sale: AuctionSale, now=None) -> bool:
    from datetime import UTC, datetime
    deadline = retention_deadline(sale)
    return deadline is not None and deadline <= (now or datetime.now(UTC))
