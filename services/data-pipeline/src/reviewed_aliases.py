"""Load the small, reviewed publication-alias registry.

The registry is deliberately separate from ``auction_sales.source_urls``.  A
source URL may be an alias only after a human review has recorded the exact
canonical row and the supporting evidence.  Callers must treat a registry
lookup failure as a publication failure: silently treating an unavailable
registry as empty would make a reviewed secondary row look like a normal
duplicate and could trigger a destructive cleanup.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any


class ReviewedAliasRegistryError(RuntimeError):
    """The reviewed-alias registry could not be loaded or validated."""


@dataclass(frozen=True, slots=True)
class ReviewedAlias:
    """One active reviewed secondary row and its stable canonical row."""

    alias_sale_id: str
    canonical_sale_id: str
    alias_source_url: str
    canonical_source_url: str
    review_key: str
    evidence: dict[str, Any]
    reviewed_at: str | None = None
    reviewed_by: str | None = None


@dataclass(frozen=True, slots=True)
class ReviewedAliasRegistry:
    """Validated indexes used by one publication transaction."""

    by_alias_url: Mapping[str, ReviewedAlias]
    by_alias_id: Mapping[str, ReviewedAlias]
    by_canonical_id: Mapping[str, tuple[ReviewedAlias, ...]]

    def for_url(self, source_url: str) -> ReviewedAlias | None:
        return self.by_alias_url.get(source_url)

    def for_id(self, sale_id: str | None) -> ReviewedAlias | None:
        return self.by_alias_id.get(str(sale_id)) if sale_id else None

    def aliases_for_urls(self, source_urls: Iterable[str]) -> tuple[ReviewedAlias, ...]:
        """Return aliases whose source URL occurs in an incoming batch."""
        wanted = {str(url) for url in source_urls if url}
        return tuple(
            alias
            for source_url, alias in self.by_alias_url.items()
            if source_url in wanted
        )

    def protected_sale_ids(self) -> frozenset[str]:
        """IDs that cleanup must never select from a reviewed pair."""
        return frozenset(
            sale_id
            for alias in self.by_alias_url.values()
            for sale_id in (alias.alias_sale_id, alias.canonical_sale_id)
        )

    def protected_source_urls(self) -> frozenset[str]:
        """URLs whose observations/children remain evidence for a pair."""
        return frozenset(
            url
            for alias in self.by_alias_url.values()
            for url in (alias.alias_source_url, alias.canonical_source_url)
        )

    def cleanup_sale_ids(self, sale_ids: Iterable[str]) -> tuple[str, ...]:
        """Filter deletion candidates before any observation/parent delete."""
        protected = self.protected_sale_ids()
        return tuple(str(sale_id) for sale_id in sale_ids if str(sale_id) not in protected)


# The public RPC is service-role-only.  It returns the parent URLs by joining
# the private registry to auction_sales, which keeps source identity in one
# place and lets the loader detect an orphaned active registry row.
REVIEWED_ALIAS_RPC_SQL = """
select alias_sale_id::text,
       canonical_sale_id::text,
       alias_source_url,
       canonical_source_url,
       review_key,
       evidence,
       reviewed_at::text,
       reviewed_by
from public.list_reviewed_publication_aliases()
order by alias_sale_id
"""


def _row_value(row: Any, index: int, key: str) -> Any:
    if isinstance(row, Mapping):
        return row.get(key)
    try:
        return row[index]
    except (IndexError, KeyError, TypeError) as exc:  # pragma: no cover - defensive DB adapter guard
        raise ReviewedAliasRegistryError(f"Malformed reviewed-alias row; missing {key}") from exc


def _normalise_row(row: Any) -> ReviewedAlias:
    alias_sale_id = str(_row_value(row, 0, "alias_sale_id") or "").strip()
    canonical_sale_id = str(_row_value(row, 1, "canonical_sale_id") or "").strip()
    alias_source_url = str(_row_value(row, 2, "alias_source_url") or "").strip()
    canonical_source_url = str(_row_value(row, 3, "canonical_source_url") or "").strip()
    review_key = str(_row_value(row, 4, "review_key") or "").strip()
    evidence = _row_value(row, 5, "evidence")
    reviewed_at = _row_value(row, 6, "reviewed_at")
    reviewed_by = _row_value(row, 7, "reviewed_by")

    if not alias_sale_id or not canonical_sale_id or alias_sale_id == canonical_sale_id:
        raise ReviewedAliasRegistryError("Reviewed alias has invalid or identical parent IDs")
    if not alias_source_url or not canonical_source_url or alias_source_url == canonical_source_url:
        raise ReviewedAliasRegistryError("Reviewed alias has invalid or identical source URLs")
    if not review_key:
        raise ReviewedAliasRegistryError("Reviewed alias has no review key")
    if not isinstance(evidence, dict):
        raise ReviewedAliasRegistryError("Reviewed alias evidence must be a JSON object")

    return ReviewedAlias(
        alias_sale_id=alias_sale_id,
        canonical_sale_id=canonical_sale_id,
        alias_source_url=alias_source_url,
        canonical_source_url=canonical_source_url,
        review_key=review_key,
        evidence=dict(evidence),
        reviewed_at=str(reviewed_at) if reviewed_at is not None else None,
        reviewed_by=str(reviewed_by) if reviewed_by is not None else None,
    )


def registry_from_rows(rows: Iterable[Any]) -> ReviewedAliasRegistry:
    """Build and validate a registry from DB/RPC rows.

    Validation is intentionally strict.  A duplicate or malformed active
    relation must stop publication rather than fall back to ordinary dedupe.
    """
    by_alias_url: dict[str, ReviewedAlias] = {}
    by_alias_id: dict[str, ReviewedAlias] = {}
    by_canonical_id: dict[str, list[ReviewedAlias]] = {}
    for row in rows:
        alias = _normalise_row(row)
        if alias.alias_source_url in by_alias_url:
            raise ReviewedAliasRegistryError(
                f"Duplicate reviewed alias URL: {alias.alias_source_url}"
            )
        if alias.alias_sale_id in by_alias_id:
            raise ReviewedAliasRegistryError(
                f"Duplicate reviewed alias row: {alias.alias_sale_id}"
            )
        by_alias_url[alias.alias_source_url] = alias
        by_alias_id[alias.alias_sale_id] = alias
        by_canonical_id.setdefault(alias.canonical_sale_id, []).append(alias)

    canonical_urls: dict[str, str] = {}
    canonical_ids_by_url: dict[str, str] = {}
    for alias in by_alias_url.values():
        if alias.canonical_sale_id in by_alias_id:
            raise ReviewedAliasRegistryError(
                f"Reviewed alias relation forms a canonical chain at {alias.canonical_sale_id}"
            )
        previous_url = canonical_urls.setdefault(alias.canonical_sale_id, alias.canonical_source_url)
        if previous_url != alias.canonical_source_url:
            raise ReviewedAliasRegistryError(
                f"Canonical source URL changed for {alias.canonical_sale_id}"
            )
        previous_id = canonical_ids_by_url.setdefault(alias.canonical_source_url, alias.canonical_sale_id)
        if previous_id != alias.canonical_sale_id:
            raise ReviewedAliasRegistryError(
                f"Canonical source URL maps to multiple sale IDs: {alias.canonical_source_url}"
            )
        if alias.canonical_source_url in by_alias_url:
            raise ReviewedAliasRegistryError(
                f"Canonical source URL is also a reviewed alias: {alias.canonical_source_url}"
            )
    return ReviewedAliasRegistry(
        by_alias_url=by_alias_url,
        by_alias_id=by_alias_id,
        by_canonical_id={key: tuple(value) for key, value in by_canonical_id.items()},
    )


def load_reviewed_aliases(connection) -> ReviewedAliasRegistry:
    """Load the active registry exactly once for a publication transaction.

    Any SQL/RPC failure raises ``ReviewedAliasRegistryError``.  In particular,
    a missing migration is not interpreted as an empty registry.
    """
    try:
        rows = connection.execute(REVIEWED_ALIAS_RPC_SQL).fetchall()
    except Exception as exc:  # psycopg exposes several adapter-specific errors.
        raise ReviewedAliasRegistryError("Could not load reviewed publication aliases") from exc
    try:
        return registry_from_rows(rows)
    except ReviewedAliasRegistryError:
        raise
    except Exception as exc:  # pragma: no cover - defensive validation boundary
        raise ReviewedAliasRegistryError("Could not validate reviewed publication aliases") from exc
