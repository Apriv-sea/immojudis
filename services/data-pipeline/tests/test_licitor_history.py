from __future__ import annotations

from datetime import date

import pytest

import src.sources.licitor_history as licitor_history
from src.sources.licitor_history import (
    LicitorHistoricalAuthorizationError,
    build_licitor_price_statistics,
    parse_licitor_historical_detail_html,
    parse_licitor_history_list_html,
    scrape_licitor_historical_result,
)

LIST_HTML = """
<article id="zone-list" class="Results Archives">
  <header><nav class="Pagination">
    <form class="PageField">
      <input name="total" value="16965">
      <span class="PageTotal">/ 3393</span>
    </form>
    <a class="Next PageNav" href="/ventes-aux-encheres-immobilieres/paris-et-ile-de-france/historique-des-adjudications.html?p=2"></a>
  </nav></header>
  <ul class="AdResults">
    <li><a class="Ad Archives First" href="/annonce/10/90/34/vente-aux-encheres/un-appartement/garches/hauts-de-seine/109034.html">
      <p class="Location"><span class="Number">92</span><span class="City">Garches</span></p>
      <p class="Description"><span class="Name">Un appartement</span><span class="Text">de 96,77 m²</span></p>
      <p class="Result">09-07-2026 : <span class="PriceNumber">376 000 €</span></p>
    </a></li>
  </ul>
</article>
"""


DETAIL_HTML = """
<article id="legalad-search"><h1>Annonce n°109034 : un appartement à Garches (Hauts-de-Seine), mise à prix : 500 000 €</h1></article>
<article class="LegalAd"><div class="AdContent" id="ad-109034">
  <p class="PublishingDate">Annonce publiée le <time datetime="2026-05-30T00:00:00+02:00">30 mai 2026</time></p>
  <p class="Court">Tribunal Judiciaire de Paris</p>
  <p class="Date"><time datetime="2026-07-09T14:00:00">9 juillet 2026</time></p>
  <section class="AddressBlock">
    <div class="Lot">
      <h1>1er lot de vente</h1>
      <div class="FirstSousLot SousLot"><h2>Un appartement</h2><p>de 96,77 m²</p></div>
      <h3>Adjudication : 376 000 €</h3><h4>(Mise à prix : 500 000 €)</h4>
    </div>
    <div class="Lot">
      <h1>3ème au 5ème lots de vente</h1>
      <div class="FirstSousLot SousLot"><h2>Un parking double</h2><p>n°25</p></div>
      <div class="SousLot"><h2>Un parking</h2><p>n°28</p></div>
      <div class="SousLot"><h2>Un parking</h2><p>n°36</p></div>
      <h3>3ème lot : 21 000 € - 4ème lot : 14 200 € - 5ème lot : 14 000 €</h3>
      <h4>(Mise à prix pour chaque lot : 5 000 €)</h4>
    </div>
    <div class="Lot">
      <h1>6ème lot de vente</h1>
      <div class="FirstSousLot SousLot"><h2>Une cave</h2><p>au sous-sol</p></div>
      <h3>Carence d'enchères</h3><h4>(Mise à prix : 4 000 €)</h4>
    </div>
    <div class="Location"><p class="City">Garches (Hauts-de-Seine)</p><p class="Street">1 rue Test</p></div>
  </section>
</div></article>
"""

DETAIL_WITH_GENERIC_UNKNOWN_RESULT = """
<article id="legalad-search"><h1>Annonce n°99238 : plusieurs lots à Carcassonne</h1></article>
<article class="LegalAd"><div class="AdContent" id="ad-99238">
  <p class="Court">Tribunal judiciaire de Carcassonne</p>
  <p class="Date"><time datetime="2025-01-15T14:00:00">15 janvier 2025</time></p>
  <section class="AddressBlock">
    <div class="Lot"><h3>Résultat d'adjudication inconnu</h3></div>
    <div class="Lot"><h1>1er lot d'enchères</h1><h3>Adjudication : 66 000 €</h3><h4>Mise à prix : 20 000 €</h4></div>
    <div class="Lot"><h1>2ème lot d'enchères</h1><h3>Adjudication : 82 000 €</h3><h4>Mise à prix : 30 000 €</h4></div>
    <div class="Location"><p class="City">Carcassonne (Aude)</p></div>
  </section>
</div></article>
"""


def test_history_index_parser_extracts_result_and_next_page() -> None:
    page = parse_licitor_history_list_html(LIST_HTML)

    assert page.declared_total == 16_965
    assert page.declared_pages == 3_393
    assert len(page.entries) == 1
    entry = page.entries[0]
    assert entry.department == "92"
    assert entry.city == "Garches"
    assert entry.result_date == date(2026, 7, 9)
    assert str(entry.hammer_price_eur) == "376000"
    assert page.next_urls == (
        "https://www.licitor.com/ventes-aux-encheres-immobilieres/"
        "paris-et-ile-de-france/historique-des-adjudications.html?p=2",
    )


def test_history_detail_parser_splits_multi_lot_prices_and_keeps_no_bid_candidate() -> None:
    records = parse_licitor_historical_detail_html(
        DETAIL_HTML,
        "https://www.licitor.com/annonce/10/90/34/vente-aux-encheres/un-appartement/garches/hauts-de-seine/109034.html",
    )

    assert len(records) == 5
    assert [record.get("adjudication_price_eur") for record in records] == [
        "376000.00",
        "21000.00",
        "14200.00",
        "14000.00",
        None,
    ]
    assert [record.get("starting_price_eur") for record in records] == [
        "500000.00",
        "5000.00",
        "5000.00",
        "5000.00",
        "4000.00",
    ]
    assert records[0]["source_url"].endswith("109034.html#lot-1")
    assert records[1]["source_url"].endswith("109034.html#lot-3")
    assert records[-1]["status"] == "past"
    assert "held_no_bid_candidate" in records[-1]["quality_flags"]
    assert all(record["training_eligible"] is False for record in records)


def test_history_detail_parser_skips_generic_unknown_block_before_priced_lots() -> None:
    records = parse_licitor_historical_detail_html(
        DETAIL_WITH_GENERIC_UNKNOWN_RESULT,
        "https://www.licitor.com/annonce/09/92/38/vente-aux-encheres/plusieurs-lots/carcassonne/aude/099238.html",
    )

    assert [record["external_id"] for record in records] == ["099238:lot:1", "099238:lot:2"]
    assert [record["adjudication_price_eur"] for record in records] == ["66000.00", "82000.00"]


def test_statistics_match_published_metric_definitions_and_group_by_tribunal() -> None:
    rows = []
    for index, (starting, hammer) in enumerate([(100_000, 200_000), (100_000, 150_000), (100_000, 90_000)] * 4):
        rows.append(
            {
                "sale_date": f"2026-0{5 + index % 3}-01",
                "starting_price_eur": starting,
                "adjudication_price_eur": hammer,
                "department": "75",
                "tribunal": "Tribunal judiciaire de Paris",
                "property_type": "apartment",
            }
        )

    result = build_licitor_price_statistics(
        rows,
        as_of=date(2026, 8, 26),
        minimum_sample=10,
    )

    full = result["periods"]["fullArchive"]
    assert full == {
        "status": "sample_threshold_met_not_reviewed",
        "sampleSize": 12,
        "medianHammerToStartingRatio": 1.5,
        "aboveStartingRate": 0.666667,
        "atLeastDoubleRate": 0.333333,
        "medianHammerPriceEur": 150000,
        "medianStartingPriceEur": 100000,
        "hammerPriceMiddle50Eur": {"p25": 90000, "p75": 200000},
        "ratioMiddle50": {"p25": 0.9, "p75": 2.0},
        "bidDistribution": [
            {"band": "below_starting", "count": 4, "share": 0.333333},
            {"band": "at_starting", "count": 0, "share": 0.0},
            {"band": "above_1_below_1_5", "count": 0, "share": 0.0},
            {"band": "from_1_5_below_2", "count": 4, "share": 0.333333},
            {"band": "at_least_2", "count": 4, "share": 0.333333},
        ],
    }
    recent = result["periods"]["last36Months"]
    assert recent["departments"][0]["scope"] == "75"
    assert recent["tribunals"][0]["scope"] == "Tribunal judiciaire de Paris"
    assert recent["propertyTypes"][0]["scope"] == "apartment"


def test_statistics_exclude_starting_prices_at_or_below_adjuge_floor() -> None:
    rows = [
        {
            "sale_date": "2026-01-01",
            "starting_price_eur": 1_000,
            "adjudication_price_eur": 2_000,
        },
        {
            "sale_date": "2026-01-01",
            "starting_price_eur": 1_001,
            "adjudication_price_eur": 2_002,
        },
    ]

    result = build_licitor_price_statistics(
        rows,
        as_of=date(2026, 8, 26),
        minimum_sample=1,
    )

    assert result["periods"]["fullArchive"]["sampleSize"] == 1


def test_statistics_exclude_rows_older_than_three_calendar_years() -> None:
    rows = [
        {"sale_date": "2023-08-25", "starting_price_eur": 100_000, "adjudication_price_eur": 150_000},
        {"sale_date": "2023-08-26", "starting_price_eur": 100_000, "adjudication_price_eur": 200_000},
    ]
    result = build_licitor_price_statistics(rows, as_of=date(2026, 8, 26), minimum_sample=1)
    assert result["schemaVersion"] == "licitor_price_statistics_v2"
    assert result["method"]["retentionWindowStart"] == "2023-08-26"
    assert result["periods"]["fullArchive"]["sampleSize"] == 1


def test_live_crawl_fails_closed_without_written_rights_confirmation() -> None:
    with pytest.raises(LicitorHistoricalAuthorizationError, match="source reuse authorization"):
        scrape_licitor_historical_result(max_pages_per_zone=1)


def test_live_crawl_requires_the_independent_environment_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        licitor_history,
        "load_settings",
        lambda: {"licitor_historical_authorized": False},
    )

    with pytest.raises(LicitorHistoricalAuthorizationError, match="LICITOR_HISTORICAL_AUTHORIZED"):
        scrape_licitor_historical_result(
            max_pages_per_zone=1,
            authorization_confirmed=True,
        )
