from __future__ import annotations

import json
from urllib.parse import parse_qs, urlparse

from src.sources import notaires


def _row(transaction_type: str, number: int, department: str = "33") -> dict:
    return {
        "annonceId": f"{transaction_type}-{number}",
        "typeTransaction": transaction_type,
        "urlDetailAnnonceFr": f"{notaires.BASE_URL}/fr/annonce-immo/{transaction_type.lower()}-{number}",
        "inseeDepartement": department,
        "communeNom": "Bordeaux",
        "codePostal": "33000",
        "typeBien": "APP",
        "descriptionFr": "Appartement à Bordeaux",
        "prixAffiche": 100000,
        "seanceDate": "2026-06-24",
    }


def _configure(monkeypatch, client_class, *, departments=("33",), max_pages=2) -> None:
    monkeypatch.setattr(notaires, "PoliteHttpClient", client_class)
    monkeypatch.setattr(notaires, "TARGET_DEPARTMENTS", departments)
    monkeypatch.setattr(notaires, "_department_filters", lambda: departments)
    monkeypatch.setattr(notaires, "_enrich_sale_from_detail", lambda *args, **kwargs: True)
    monkeypatch.setattr(
        notaires,
        "load_settings",
        lambda: {
            "user_agent": "immojudis-test",
            "request_delay_seconds": 0,
            "request_timeout_seconds": 1,
            "notaires_max_pages": max_pages,
        },
    )


def test_certificate_covers_each_api_partition_before_department_filter(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url: str) -> str:
            query = parse_qs(urlparse(url).query)
            transaction_type = query["typeTransactions"][0]
            page = int(query["page"][0])
            rows = [_row(transaction_type, page)]
            if page == 2:
                # This row proves that the certificate is based on API rows
                # before the configured output filter is applied.
                rows[0]["inseeDepartement"] = "75"
            return json.dumps({
                "nbTotalAnnonces": 2,
                "nbPages": 2,
                "annonceResumeDto": rows,
            })

    _configure(monkeypatch, Client)
    result = notaires.scrape_notaires_aquitaine_result(max_pages=2)

    certificate = result.coverage["certificate"]
    assert result.errors == []
    assert result.coverage["coverage_complete"] is True
    assert certificate["public_inventory_certified"] is True
    assert certificate["database_completeness_certified"] is False
    assert certificate["partitioning"] == ["transaction_type", "department"]
    assert len(certificate["public_parsed_urls"]) == 4
    assert len(certificate["returned_validated_urls"]) == 2
    assert all(item["reason"] == "department_out_of_scope" for item in certificate["excluded_urls"])
    assert all(item["department"] == "75" for item in certificate["exclusions"])
    assert certificate["unhandled_public_urls"] == []
    assert {partition["partition"] for partition in certificate["partitions"]} == {"VAE:33", "VNI:33"}
    assert all(partition["terminal_page_seen"] for partition in certificate["partitions"])
    assert all(partition["source_emitted_before_filters"] == 2 for partition in certificate["partitions"])
    assert certificate["all_discovered_announcements_emitted"] is True
    for partition in certificate["partitions"]:
        assert partition["api_scope"] == {
            "transaction_type": partition["transaction_type"],
            "department": "33",
        }
        assert partition["returned_scope"]["departments"] == ["33"]
        assert partition["public_parsed_urls"] == partition["public_urls_parsed"]
        assert len(partition["public_urls_parsed"]) == 2
        assert len(partition["returned_validated_urls"]) == 1
        assert len(partition["excluded_urls"]) == 1
        exclusion = partition["excluded_urls"][0]
        excluded_url = exclusion["url"]
        assert exclusion["reason"] == "department_out_of_scope"
        assert partition["exclusion_reasons"][excluded_url] == "department_out_of_scope"
        assert partition["exclusions"][0]["url"] == excluded_url
    assert result.coverage["source_emitted_before_filters"] == 4
    assert len(result.sales) == 2


def test_out_of_scope_row_does_not_change_later_api_department(monkeypatch) -> None:
    requested: list[tuple[str, int, str | None]] = []

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url: str) -> str:
            query = parse_qs(urlparse(url).query)
            transaction_type = query["typeTransactions"][0]
            page = int(query["page"][0])
            requested.append((transaction_type, page, query.get("departements", [None])[0]))
            return json.dumps({
                "nbTotalAnnonces": 3,
                "nbPages": 3,
                "annonceResumeDto": [
                    _row(transaction_type, page, "75" if page == 2 else "33")
                ],
            })

    _configure(monkeypatch, Client, max_pages=3)
    result = notaires.scrape_notaires_aquitaine_result(max_pages=3)

    assert requested == [
        (transaction_type, page, "33")
        for transaction_type in notaires.TRANSACTION_TYPES
        for page in range(1, 4)
    ]
    assert result.coverage["coverage_complete"] is True
    for partition in result.coverage["certificate"]["partitions"]:
        assert partition["public_inventory_certified"] is True
        assert partition["returned_validated_complete"] is True
        assert len(partition["public_parsed_urls"]) == 3
        assert len(partition["returned_validated_urls"]) == 2
        assert partition["excluded_urls"] == [
            {
                "url": f"{notaires.BASE_URL}/fr/annonce-immo/{partition['transaction_type'].lower()}-2",
                "reason": "department_out_of_scope",
            }
        ]


def test_missing_api_metadata_is_an_explicit_negative_certificate(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url: str) -> str:
            transaction_type = parse_qs(urlparse(url).query)["typeTransactions"][0]
            return json.dumps({"annonceResumeDto": [_row(transaction_type, 1)]})

    _configure(monkeypatch, Client, max_pages=1)
    result = notaires.scrape_notaires_aquitaine_result(max_pages=1)

    certificate = result.coverage["certificate"]
    partition = certificate["partitions"][0]
    assert certificate["public_inventory_certified"] is False
    assert result.coverage["coverage_complete"] is False
    assert partition["metadata_complete"] is False
    assert "advertised_total_missing" in partition["reasons"]
    assert "advertised_page_count_missing" in partition["reasons"]


def test_zero_total_with_zero_terminal_pages_is_valid_inventory(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url: str) -> str:
            return json.dumps({
                "nbTotalAnnonces": 0,
                "nbPages": 0,
                "annonceResumeDto": [],
            })

    _configure(monkeypatch, Client, max_pages=1)
    result = notaires.scrape_notaires_aquitaine_result(max_pages=1)

    assert result.errors == []
    assert result.coverage["coverage_complete"] is True
    assert result.coverage["certificate"]["public_inventory_certified"] is True


def test_changing_total_or_duplicate_urls_cannot_certify_partition(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url: str) -> str:
            query = parse_qs(urlparse(url).query)
            transaction_type = query["typeTransactions"][0]
            page = int(query["page"][0])
            first = _row(transaction_type, 1)
            second = _row(transaction_type, 2)
            if page == 1:
                rows, total = [first], 3
            else:
                # A mixed page is accepted by PaginationCoverage, so the
                # certificate must independently detect the repeated URL.
                rows, total = [first, second], 3
            return json.dumps({
                "nbTotalAnnonces": total,
                "nbPages": 2,
                "annonceResumeDto": rows,
            })

    _configure(monkeypatch, Client)
    result = notaires.scrape_notaires_aquitaine_result(max_pages=2)

    for partition in result.coverage["certificate"]["partitions"]:
        assert partition["public_inventory_certified"] is False
        assert partition["duplicate_source_urls"]
        assert "unique_source_url_count_mismatch" in partition["reasons"]


def test_validation_failure_cannot_be_counted_as_a_successful_exclusion(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url: str) -> str:
            query = parse_qs(urlparse(url).query)
            transaction_type = query["typeTransactions"][0]
            page = int(query["page"][0])
            return json.dumps({
                "nbTotalAnnonces": 2,
                "nbPages": 2,
                "annonceResumeDto": [_row(transaction_type, page)],
            })

    validation_calls = []
    failed_url = f"{notaires.BASE_URL}/fr/annonce-immo/vae-2"

    def validate_once(source_name, rows, errors):
        validation_calls.append((source_name, len(rows)))
        errors.append(f"validation {failed_url}: root: forced test failure")
        return [row for row in rows if row["source_url"] != failed_url]

    _configure(monkeypatch, Client)
    monkeypatch.setattr(notaires, "validate_raw_sales", validate_once)
    result = notaires.scrape_notaires_aquitaine_result(max_pages=2)

    assert validation_calls == [("notaires", 4)]
    assert result.coverage["certificate"]["public_inventory_certified"] is True
    assert result.coverage["certificate"]["all_discovered_announcements_emitted"] is False
    assert result.coverage["coverage_complete"] is False
    vae = next(
        partition
        for partition in result.coverage["certificate"]["partitions"]
        if partition["partition"] == "VAE:33"
    )
    assert failed_url in vae["public_urls_parsed"]
    assert failed_url not in vae["returned_validated_urls"]
    assert failed_url in vae["unhandled_urls"]
    assert vae["unhandled_reasons"][failed_url] == "validation_failed"
    assert all(item["url"] != failed_url for item in vae["excluded_urls"])
    assert failed_url not in vae["successful_excluded_urls"]
    assert all(item["url"] != failed_url for item in result.coverage["certificate"]["excluded_urls"])


def test_detail_department_does_not_hide_an_api_scoped_row(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url: str) -> str:
            transaction_type = parse_qs(urlparse(url).query)["typeTransactions"][0]
            return json.dumps({
                "nbTotalAnnonces": 1,
                "nbPages": 1,
                "annonceResumeDto": [_row(transaction_type, 1)],
            })

    def detail_without_department(_client, sale, _errors):
        sale["department"] = None
        return True

    _configure(monkeypatch, Client, max_pages=1)
    monkeypatch.setattr(notaires, "_enrich_sale_from_detail", detail_without_department)
    result = notaires.scrape_notaires_aquitaine_result(max_pages=1)

    assert result.coverage["certificate"]["all_discovered_announcements_emitted"] is True
    assert result.coverage["certificate"]["excluded_urls"] == []
    assert len(result.sales) == 2
