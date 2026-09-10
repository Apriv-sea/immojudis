import pytest

from src.normalize import normalize_sale, parse_french_datetime
from src.pdf_enrichment import enrich_sale_from_pdf_text


@pytest.mark.parametrize("text, expected", [
    ("15 septembre 2026 à 11h00", "2026-09-15T09:00:00+00:00"),
    ("12 décembre 2024 à 14h30", "2024-12-12T13:30:00+00:00"),
    ("12 décembre 2024 à 14 h 30", "2024-12-12T13:30:00+00:00"),
    ("12 décembre 2024 à 14 heures", "2024-12-12T13:00:00+00:00"),
    ("2026-09-15T11:00:00", "2026-09-15T09:00:00+00:00"),
    ("2026-09-15T11:00:00+02:00", "2026-09-15T09:00:00+00:00"),
    ("2026-09-15T11:00:00Z", "2026-09-15T11:00:00+00:00"),
    ("2026-09-15", "2026-09-15T00:00:00+00:00"),
    ("15 septembre 2026", "2026-09-15T00:00:00+00:00"),
])
def test_civil_time_and_date_only_conventions(text: str, expected: str) -> None:
    value = parse_french_datetime(text)
    assert value is not None
    assert value.isoformat() == expected


@pytest.mark.parametrize("text", ["2026-03-29T02:30:00", "2026-10-25T02:30:00"])
def test_dst_gap_and_repeated_hour_require_an_explicit_offset(text: str) -> None:
    assert parse_french_datetime(text) is None


def test_explicit_offset_resolves_repeated_hour() -> None:
    first = parse_french_datetime("2026-10-25T02:30:00+02:00")
    second = parse_french_datetime("2026-10-25T02:30:00+01:00")
    assert first is not None and second is not None
    assert (second - first).total_seconds() == 3600


def test_explicit_source_timezone_overrides_metropolitan_default() -> None:
    value = parse_french_datetime("15 septembre 2026 à 11h00", local_timezone="America/Martinique")
    assert value is not None
    assert value.isoformat() == "2026-09-15T15:00:00+00:00"
    assert parse_french_datetime("15 septembre 2026 à 11h00", local_timezone="unknown/zone") is None


def test_normalization_uses_the_declared_sale_timezone_not_the_property_department() -> None:
    sale = normalize_sale({
        "source_name": "unit", "source_url": "https://example.test/sale",
        "department": "06", "sale_date": "15 septembre 2026 à 11h00",
        "source_blocks": {"audience_timezone": "America/Martinique"},
    })
    assert sale.sale_date is not None
    assert sale.sale_date.isoformat() == "2026-09-15T15:00:00+00:00"


def test_pdf_extraction_uses_the_same_explicit_source_timezone() -> None:
    sale = normalize_sale({
        "source_name": "unit", "source_url": "https://example.test/sale",
        "sale_timezone": "America/Martinique",
    })
    enrich_sale_from_pdf_text(sale, [
        "Audience d'adjudication le jeudi 15 octobre 2026 à 15h00 au tribunal de Fort-de-France.",
    ])
    assert sale.sale_date is not None
    assert sale.sale_date.isoformat() == "2026-10-15T19:00:00+00:00"
