from __future__ import annotations

from src.sources import agrasc, petites_affiches

PETITES_CARD = """
<div class="annonce_lot_1 col-md-6">
  <div class="annonceListe">
    <div class="imgList"><a href="/vente/shared.html"><img src="/image.jpg" /></a></div>
    <div class="titreVente"><a href="/vente/shared.html">Appartement à Bordeaux</a></div>
    <div class="miseAPrix"><strong>80 000</strong> €</div>
    <div class="dateVente"><strong>24/06/2026</strong></div>
  </div>
</div>
<a class="fr-pagination__link--last" href="/encheres-immobilieres/ventes-aux-encheres-immobilieres-p1.html">Dernière page</a>
"""


def _petites_settings() -> dict[str, object]:
    return {
        "browser_user_agent": "Mozilla/5.0",
        "request_delay_seconds": 0,
        "request_timeout_seconds": 1,
    }


def test_petites_affiches_certifies_each_post_partition_before_global_dedupe(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def post_form(self, url: str, data: dict[str, str]) -> str:
            calls.append((url, data.get("select_dep", "all")))
            return PETITES_CARD

        def coverage_metrics(self) -> dict[str, object]:
            return {}

    monkeypatch.setattr(petites_affiches, "TARGET_DEPARTMENTS", ("33", "75"))
    monkeypatch.setattr(petites_affiches, "PoliteHttpClient", Client)
    monkeypatch.setattr(petites_affiches, "load_settings", _petites_settings)
    monkeypatch.setattr(petites_affiches, "_enrich_sale_from_detail", lambda *args, **kwargs: None)

    result = petites_affiches.scrape_petites_affiches_aquitaine_result()

    assert [department for _url, department in calls] == ["33", "75"]
    assert len(result.sales) == 1
    assert result.coverage["coverage_complete"] is True
    assert result.coverage["certificate"]["public_discovery_certified"] is True
    assert {item["partition"] for item in result.coverage["certificate"]["partitions"]} == {
        "department:33",
        "department:75",
    }


def test_petites_affiches_incomplete_partition_cannot_be_certified(monkeypatch) -> None:
    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def post_form(self, url: str, data: dict[str, str]) -> str:
            return PETITES_CARD.replace(
                '<a class="fr-pagination__link--last" href="/encheres-immobilieres/ventes-aux-encheres-immobilieres-p1.html">Dernière page</a>',
                '<a href="/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html">Page suivante</a>',
            )

        def coverage_metrics(self) -> dict[str, object]:
            return {}

    monkeypatch.setattr(petites_affiches, "TARGET_DEPARTMENTS", ("33",))
    monkeypatch.setattr(petites_affiches, "PoliteHttpClient", Client)
    monkeypatch.setattr(petites_affiches, "load_settings", _petites_settings)
    monkeypatch.setattr(petites_affiches, "_enrich_sale_from_detail", lambda *args, **kwargs: None)

    result = petites_affiches.scrape_petites_affiches_aquitaine_result(max_pages=1)

    assert result.coverage["partitions"][0]["linked_pages_complete"] is False
    assert result.coverage["coverage_complete"] is False
    assert result.coverage["certificate"]["public_discovery_certified"] is False


def _agrasc_html(*, unknown_unlinked: bool = False) -> str:
    unlinked_class = "card-vente-immo" if unknown_unlinked else "card-vente-immo sold"
    return f"""
    <div class="view-liste-ventes-immobilieres">
      <div class="card-vente-immo">
        <h3 class="fr-card__title"><a href="/vente/house">Maison</a></h3>
        <p class="fr-card__detail">Agen (47)</p>
      </div>
      <div class="{unlinked_class}"><h3>Archive vendue sans lien</h3></div>
      <a class="fr-pagination__link--last" href="/ventes-aux-encheres?page=0">Dernière page</a>
    </div>
    """


def _patch_agrasc_client(monkeypatch, html: str) -> None:
    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def get(self, url: str) -> str:
            return html

        def coverage_metrics(self) -> dict[str, object]:
            return {}

    monkeypatch.setattr(agrasc, "TARGET_DEPARTMENTS", ("47",))
    monkeypatch.setattr(agrasc, "PoliteHttpClient", Client)
    monkeypatch.setattr(
        agrasc,
        "load_settings",
        lambda: {
            "user_agent": "Mozilla/5.0",
            "request_delay_seconds": 0,
            "request_timeout_seconds": 1,
        },
    )
    monkeypatch.setattr(agrasc, "enrich_agrasc_operator", lambda *args, **kwargs: None)
    monkeypatch.setattr("src.source_checkpoint.restore_detail", lambda sale: False)


def test_agrasc_sold_unlinked_cards_are_counted_as_addressable_only(monkeypatch) -> None:
    _patch_agrasc_client(monkeypatch, _agrasc_html())

    result = agrasc.scrape_agrasc_aquitaine_result()

    certificate = result.coverage["certificate"]
    assert certificate["public_discovery_certified"] is False
    assert certificate["addressable_public_inventory_certified"] is True
    assert len(certificate["partitions"][0]["unlinked_public_cards"]) == 1
    assert certificate["partitions"][0]["unlinked_public_cards"][0]["sold"] is True
    assert result.coverage["coverage_complete"] is False


def test_agrasc_unknown_unlinked_cards_never_certify_inventory(monkeypatch) -> None:
    _patch_agrasc_client(monkeypatch, _agrasc_html(unknown_unlinked=True))

    result = agrasc.scrape_agrasc_aquitaine_result()

    certificate = result.coverage["certificate"]
    assert certificate["public_discovery_certified"] is False
    assert certificate["addressable_public_inventory_certified"] is False
    assert certificate["partitions"][0]["unlinked_public_cards"][0]["sold"] is False
    assert result.coverage["coverage_complete"] is False
