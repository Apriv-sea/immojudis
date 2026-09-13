from __future__ import annotations

from decimal import Decimal

import pytest

from src import publication_identity
from src.normalize import normalize_sale
from src.reviewed_aliases import (
    ReviewedAliasRegistryError,
    registry_from_rows,
)


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _Connection:
    def __init__(self, sale_rows, alias_rows):
        self.sale_rows = sale_rows
        self.alias_rows = alias_rows
        self.statements: list[str] = []

    def execute(self, statement, params=None):
        self.statements.append(statement)
        if "list_reviewed_publication_aliases" in statement:
            return _Result(self.alias_rows)
        if "select to_jsonb(s)" in statement:
            return _Result([(row,) for row in self.sale_rows])
        raise AssertionError(f"unexpected SQL in resolver test: {statement}")


def _sale(sale_id: str, source_name: str, source_url: str, *, status: str = "upcoming"):
    result = normalize_sale(
        {
            "source_name": source_name,
            "source_url": source_url,
            "address": "Chemin des Dunes",
            "city": "Agde",
            "department": "34",
            "surface_m2": 1178,
            "starting_price_eur": 252000,
            "sale_date": "2026-11-05T13:30:00+00:00",
        }
    )
    result.id = sale_id
    result.status = status
    result.source_urls = [source_url]
    result.observations = [{"source_url": source_url, "raw_payload": result.raw_payload}]
    return result


def _alias_row(alias_id: str, canonical_id: str, alias_url: str, canonical_url: str, key: str):
    return (
        alias_id,
        canonical_id,
        alias_url,
        canonical_url,
        key,
        {"audit": "docs/audits/agde-identity-review-20260913.json"},
        "2026-09-13T10:00:00+00:00",
        "review-test",
    )


def test_two_reviewed_aliases_in_one_batch_share_one_locked_canonical_and_survive_rerun():
    canonical_id = "00000000-0000-0000-0000-000000000001"
    alias_ids = (
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000003",
    )
    canonical_url = "https://notaires.test/canonical"
    alias_urls = ("https://cessions.test/one", "https://cessions.test/two")
    canonical = _sale(canonical_id, "notaires", canonical_url)
    aliases = [
        _sale(alias_id, "cessions_etat", alias_url, status="quarantined")
        for alias_id, alias_url in zip(alias_ids, alias_urls, strict=True)
    ]
    for alias in aliases:
        alias.quality_flags = ["sale_procedure_conflict"]
        alias.sale_verification_status = "conflict"
    rows = [canonical.model_dump(), *(alias.model_dump() for alias in aliases)]
    registry_rows = [
        _alias_row(alias_id, canonical_id, alias_url, canonical_url, f"review-{index}")
        for index, (alias_id, alias_url) in enumerate(zip(alias_ids, alias_urls, strict=True))
    ]
    connection = _Connection(rows, registry_rows)

    result = publication_identity.resolve_publication_identities(
        connection,
        [aliases[0].model_copy(deep=True), aliases[1].model_copy(deep=True)],
    )

    assert len(result) == 1
    assert result[0].id == canonical_id
    assert result[0].status == "upcoming"
    assert "sale_procedure_conflict" not in result[0].quality_flags
    assert set(result[0].source_urls) == {canonical_url, *alias_urls}

    # A subsequent scan sees the canonical's URL union and the secondary rows;
    # the reviewed rows are removed from resolver candidates before matching.
    connection.sale_rows[0] = result[0].model_dump()
    rerun = publication_identity.resolve_publication_identities(
        connection,
        [aliases[0].model_copy(deep=True), aliases[1].model_copy(deep=True)],
    )
    assert len(rerun) == 1
    assert rerun[0].id == canonical_id
    assert rerun[0].status == "upcoming"


def test_reviewed_alias_with_identity_variation_is_refused(monkeypatch):
    canonical_id = "00000000-0000-0000-0000-000000000011"
    alias_id = "00000000-0000-0000-0000-000000000012"
    canonical_url = "https://notaires.test/canonical"
    alias_url = "https://cessions.test/alias"
    canonical = _sale(canonical_id, "notaires", canonical_url)
    alias = _sale(alias_id, "cessions_etat", alias_url, status="quarantined")
    canonical.raw_payload["lot_number"] = "1"
    alias.raw_payload["lot_number"] = "2"
    connection = _Connection(
        [canonical.model_dump(), alias.model_dump()],
        [_alias_row(alias_id, canonical_id, alias_url, canonical_url, "review")],
    )
    held: list[str] = []
    monkeypatch.setattr(
        publication_identity,
        "hold_identity",
        lambda _connection, incoming, _matches, reason: held.append(reason) or setattr(incoming, "status", "quarantined"),
    )

    result = publication_identity.resolve_publication_identities(connection, [alias])

    assert result == []
    assert held == ["reviewed_alias_identity_conflict"]
    assert alias.status == "quarantined"


def test_reviewed_alias_clears_only_resolved_procedure_flag(monkeypatch):
    canonical_id = "00000000-0000-0000-0000-000000000015"
    alias_id = "00000000-0000-0000-0000-000000000016"
    canonical_url = "https://notaires.test/canonical-facts"
    alias_url = "https://cessions.test/alias-facts"
    canonical = _sale(canonical_id, "notaires", canonical_url)
    alias = _sale(alias_id, "cessions_etat", alias_url, status="quarantined")
    alias.quality_flags = [
        "sale_procedure_conflict",
        "occupation_conflict",
        "surface_contradiction",
        "source_detail_unverified",
    ]
    connection = _Connection(
        [canonical.model_dump(), alias.model_dump()],
        [_alias_row(alias_id, canonical_id, alias_url, canonical_url, "review-facts")],
    )

    result = publication_identity.resolve_publication_identities(connection, [alias])

    assert len(result) == 1
    assert set(result[0].quality_flags) >= {
        "occupation_conflict",
        "surface_contradiction",
        "source_detail_unverified",
    }
    assert "sale_procedure_conflict" not in result[0].quality_flags


def test_reviewed_alias_date_and_price_variations_merge_as_normal_revision():
    canonical_id = "00000000-0000-0000-0000-000000000017"
    alias_id = "00000000-0000-0000-0000-000000000018"
    canonical_url = "https://notaires.test/canonical-revision"
    alias_url = "https://cessions.test/alias-revision"
    canonical = _sale(canonical_id, "notaires", canonical_url)
    alias = _sale(alias_id, "cessions_etat", alias_url, status="quarantined")
    alias.starting_price_eur = Decimal("300000")
    alias.sale_date = alias.sale_date.replace(hour=14)
    connection = _Connection(
        [canonical.model_dump(), alias.model_dump()],
        [_alias_row(alias_id, canonical_id, alias_url, canonical_url, "review-revision")],
    )

    result = publication_identity.resolve_publication_identities(connection, [alias])

    assert len(result) == 1
    assert result[0].id == canonical_id
    assert result[0].status == "upcoming"
    conflict_fields = {
        conflict["field"] for conflict in result[0].raw_payload.get("source_conflicts", [])
    }
    assert {"starting_price_eur", "sale_date"} <= conflict_fields


def test_missing_registry_fails_closed():
    class MissingRegistry:
        def execute(self, *_args, **_kwargs):
            raise RuntimeError("relation does not exist")

    sale = _sale(
        "00000000-0000-0000-0000-000000000021",
        "notaires",
        "https://notaires.test/sale",
    )
    with pytest.raises(ReviewedAliasRegistryError):
        publication_identity.resolve_publication_identities(MissingRegistry(), [sale])


def test_alias_relation_without_locked_canonical_fails_closed():
    alias_id = "00000000-0000-0000-0000-000000000031"
    canonical_id = "00000000-0000-0000-0000-000000000032"
    alias_url = "https://cessions.test/alias"
    canonical_url = "https://notaires.test/canonical"
    alias = _sale(alias_id, "cessions_etat", alias_url, status="quarantined")
    connection = _Connection(
        [alias.model_dump()],
        [_alias_row(alias_id, canonical_id, alias_url, canonical_url, "review")],
    )
    with pytest.raises(ReviewedAliasRegistryError, match="no locked parent rows"):
        publication_identity.resolve_publication_identities(connection, [alias])


def test_cleanup_protects_both_reviewed_parent_ids_and_urls():
    alias_id = "00000000-0000-0000-0000-000000000041"
    canonical_id = "00000000-0000-0000-0000-000000000042"
    registry = registry_from_rows(
        [_alias_row(alias_id, canonical_id, "https://cessions.test/alias", "https://notaires.test/canonical", "review")]
    )

    assert registry.cleanup_sale_ids([alias_id, canonical_id, "other"]) == ("other",)
    assert registry.protected_source_urls() == {
        "https://cessions.test/alias",
        "https://notaires.test/canonical",
    }


def test_cleanup_contract_keeps_children_for_both_reviewed_parents():
    alias_id = "00000000-0000-0000-0000-000000000051"
    canonical_id = "00000000-0000-0000-0000-000000000052"
    registry = registry_from_rows(
        [_alias_row(alias_id, canonical_id, "https://cessions.test/child-alias", "https://notaires.test/child-canonical", "review")]
    )
    children = [
        {"sale_id": alias_id, "source_url": "https://cessions.test/child-alias"},
        {"sale_id": canonical_id, "source_url": "https://notaires.test/child-canonical"},
        {"sale_id": "00000000-0000-0000-0000-000000000053", "source_url": "https://other.test/sale"},
    ]

    deletable = [
        child for child in children
        if child["sale_id"] not in registry.protected_sale_ids()
        and child["source_url"] not in registry.protected_source_urls()
    ]

    assert deletable == [children[-1]]


@pytest.mark.parametrize(
    "rows, message",
    [
        (
            [
                _alias_row(
                    "00000000-0000-0000-0000-000000000061",
                    "00000000-0000-0000-0000-000000000062",
                    "https://cessions.test/chain-a",
                    "https://notaires.test/canonical-a",
                    "review-a",
                ),
                _alias_row(
                    "00000000-0000-0000-0000-000000000062",
                    "00000000-0000-0000-0000-000000000063",
                    "https://cessions.test/chain-b",
                    "https://notaires.test/canonical-b",
                    "review-b",
                ),
            ],
            "canonical chain",
        ),
        (
            [
                _alias_row(
                    "00000000-0000-0000-0000-000000000071",
                    "00000000-0000-0000-0000-000000000072",
                    "https://cessions.test/url-a",
                    "https://notaires.test/shared",
                    "review-a",
                ),
                _alias_row(
                    "00000000-0000-0000-0000-000000000073",
                    "00000000-0000-0000-0000-000000000074",
                    "https://cessions.test/url-b",
                    "https://notaires.test/shared",
                    "review-b",
                ),
            ],
            "multiple sale IDs",
        ),
        (
            [
                _alias_row(
                    "00000000-0000-0000-0000-000000000075",
                    "00000000-0000-0000-0000-000000000076",
                    "https://cessions.test/url-c",
                    "https://notaires.test/canonical-c",
                    "review-c",
                ),
                _alias_row(
                    "00000000-0000-0000-0000-000000000077",
                    "00000000-0000-0000-0000-000000000076",
                    "https://cessions.test/url-d",
                    "https://notaires.test/canonical-d",
                    "review-d",
                ),
            ],
            "source URL changed",
        ),
    ],
)
def test_registry_rejects_chains_and_canonical_url_conflicts(rows, message):
    with pytest.raises(ReviewedAliasRegistryError, match=message):
        registry_from_rows(rows)
