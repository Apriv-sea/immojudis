import json

import pytest

from src.normalize import normalize_sale
from src.sources.encheres_immobilieres import (
    parse_encheres_immobilieres_detail_html,
    parse_encheres_immobilieres_html,
)


@pytest.mark.parametrize("marker", ["$12f", "$1", "$d4", "$undefined"])
def test_detail_ignores_serialization_reference(marker: str) -> None:
    html = f"<h1>UNE MAISON</h1><p>Réf. annonce : 9999</p><p>{marker}</p><p>Avocat poursuivant</p>"
    detail = parse_encheres_immobilieres_detail_html(html, "https://encheresimmobilieres.fr/ventes/9999-maison")
    assert detail["description"] is None
    assert marker not in detail["raw_text"]


@pytest.mark.parametrize("description", [None, "$12f", "Local commercial occupé"])
def test_payload_uses_real_description_when_complement_is_reference(description: str | None) -> None:
    item = {
        "id": 9999,
        "url": "9999-local",
        "titre": "LOCAL COMMERCIAL",
        "description": description,
        "complement": "$12f",
        "lots": [],
    }
    escaped = json.dumps(item, ensure_ascii=False).replace('"', '\\"')
    sales = parse_encheres_immobilieres_html(f'<script>self.__next_f.push([1,"{escaped}"])</script>')
    expected = description if description == "Local commercial occupé" else None
    assert len(sales) == 1
    assert sales[0]["description"] == expected
    assert sales[0]["source_blocks"].get("description") == expected
    assert "$12f" not in sales[0]["raw_text"]


@pytest.mark.parametrize("marker", ["$12f", "$1", "$d4", "$undefined"])
def test_normalization_replay_cannot_reintroduce_serialization_reference(marker: str) -> None:
    sale = normalize_sale({
        "source_name": "encheres_immobilieres",
        "source_url": "https://encheresimmobilieres.fr/ventes/9999-local",
        "title": "LOCAL COMMERCIAL", "description": marker,
    })
    assert sale.description is None
