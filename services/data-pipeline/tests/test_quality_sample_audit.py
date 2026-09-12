import json

from src.quality_sample_audit import SAMPLE, compare_fields


def test_sample_is_frozen_at_100_distinct_listings_across_ten_sources():
    rows = json.loads(SAMPLE.read_text())
    assert len(rows) == len({row['id'] for row in rows}) == 100
    assert len({row['source_name'] for row in rows}) == 10


def test_unknown_occupation_and_missing_surface_never_count_as_verified():
    checks = compare_fields({'occupancy_status': 'vacant', 'carrez_surface_m2': 80},
                            {'occupancy_status': 'unknown', 'habitable_surface_m2': 80})
    assert checks['occupancy_status']['state'] == 'unverified'
    assert checks['carrez_surface_m2']['state'] == 'unverified'
    assert checks['habitable_surface_m2']['state'] == 'unverified'


def test_equivalent_timezones_match_but_changed_price_requires_review():
    checks = compare_fields({'sale_date': '2026-09-30T14:00:00Z', 'starting_price_eur': 100000},
                            {'sale_date': '2026-09-30T16:00:00+02:00', 'starting_price_eur': 200000})
    assert checks['sale_date']['state'] == 'matched'
    assert checks['starting_price_eur']['state'] == 'difference'
