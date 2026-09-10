from src.enrichment.extract_structured import extract_source_description
from src.normalize import normalize_sale

URL = "https://encheresimmobilieres.fr/ventes/9343-appartement"
WRONG = "Réf. annonce : 9367 Une maison occupée avec jardin et plusieurs annexes."
CORRECT = "Réf. annonce : 9343 Un appartement avec cave."


def sale_with(**values):
    return normalize_sale({"source_name": "encheres_immobilieres", "source_url": URL, **values})


def test_wrong_reference_is_not_used_as_source_or_fallback():
    sale = sale_with(description=WRONG, raw_text=WRONG, source_description=WRONG)
    assert extract_source_description(sale) is None


def test_correct_short_source_beats_longer_wrong_source():
    sale = sale_with(source_description=WRONG, source_blocks={"description": CORRECT})
    assert extract_source_description(sale) == CORRECT


def test_merged_publisher_reference_is_checked_against_its_own_url():
    sale = sale_with(merged_sources=[{"raw_payload": {
        "source_url": "https://encheresimmobilieres.fr/ventes/9367-maison",
        "source_description": WRONG,
    }}])
    assert extract_source_description(sale) == WRONG


def test_unreferenced_text_is_not_rejected():
    text = "Appartement avec balcon et cave, situation locative à confirmer."
    assert extract_source_description(sale_with(description=text)) == text


def test_other_publisher_reference_namespace_is_preserved():
    sale = normalize_sale({"source_name": "vench", "source_url": "https://www.vench.fr/9343", "description": WRONG})
    assert extract_source_description(sale) == WRONG


def test_finalization_removes_rejected_stale_source_description(monkeypatch):
    import src.main as main

    for name in ["fill_tribunal", "classify_sale_procedure", "normalize_asset_features"]:
        monkeypatch.setattr(main, name, lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "_surface_reasoning_context_for_sale", lambda sale: "")
    sale = sale_with(description=WRONG, raw_text=WRONG, source_description=WRONG)
    main._finalize_sale_for_app(sale, geocode=False)
    assert "source_description" not in sale.raw_payload
