from src.raw_models import validate_raw_sales


def test_validate_raw_sales_keeps_valid_source_payload() -> None:
    errors: list[str] = []

    valid = validate_raw_sales(
        "licitor",
        [
            {
                "source_name": "licitor",
                "source_url": "https://www.licitor.com/annonce/test/123.html",
                "title": "Appartement",
                "raw_text": "Mise à prix : 100 000 €",
            }
        ],
        errors,
    )

    assert len(valid) == 1
    assert errors == []


def test_validate_raw_sales_reports_missing_source_url_at_source_boundary() -> None:
    errors: list[str] = []

    valid = validate_raw_sales(
        "vench",
        [{"source_name": "vench", "title": "Maison"}],
        errors,
    )

    assert valid == []
    assert "source_url" in errors[0]


def test_validate_raw_sales_rejects_cross_source_url() -> None:
    errors: list[str] = []

    valid = validate_raw_sales(
        "avoventes",
        [
            {
                "source_name": "avoventes",
                "source_url": "https://www.licitor.com/annonce/123.html",
                "title": "Tentative de remplacement",
            }
        ],
        errors,
    )

    assert valid == []
    assert "source_url does not belong to source avoventes" in errors[0]


def test_agrasc_accepts_linked_operators_but_not_lookalike_origins():
    for host, accepted in [
        ("www.agorastore-immo.fr", True),
        ("www.immo-interactif.fr", True),
        ("www.agorastore-immo.fr.evil.test", False),
    ]:
        errors = []
        rows = validate_raw_sales(
            "agrasc", [dict(source_name="agrasc", source_url=f"https://{host}/vente", title="Maison")], errors
        )
        assert bool(rows) is accepted
        assert bool(errors) is not accepted
