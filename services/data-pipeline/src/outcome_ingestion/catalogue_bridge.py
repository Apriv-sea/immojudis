from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from uuid import UUID

import httpx

BRIDGE_RPC_NAME = "bridge_auction_sales_to_outcome_graph_batch"
COURT_RECONCILIATION_RPC_NAME = "reconcile_catalogue_competent_courts_batch"
BRIDGE_TIMEOUT = httpx.Timeout(120.0, connect=20.0)


class OutcomeCatalogueBridgeError(RuntimeError):
    """The mutable catalogue could not be durably linked before cleanup."""


@dataclass(frozen=True, slots=True)
class OutcomeCatalogueBridgeResult:
    scanned_count: int
    created_count: int
    reused_count: int
    linked_count: int
    complete: bool

    @property
    def remaining_unlinked(self) -> int:
        return max(0, self.scanned_count - self.linked_count)

    def require_complete(self) -> OutcomeCatalogueBridgeResult:
        if not self.complete or self.remaining_unlinked != 0:
            raise OutcomeCatalogueBridgeError(
                "Outcome catalogue bridge is incomplete; destructive cleanup is disabled "
                f"({self.remaining_unlinked} of {self.scanned_count} rows remain unlinked)."
            )
        return self


PostCallable = Callable[..., httpx.Response]


def bridge_auction_sales_before_cleanup(
    settings: Mapping[str, object],
    *,
    post: PostCallable = httpx.post,
) -> OutcomeCatalogueBridgeResult:
    """Bridge the complete catalogue through bounded, idempotent service-role RPCs.

    The RPC copies PostgreSQL ``numeric`` values directly into Outcome Graph;
    Python never serializes monetary ``Decimal`` values through ``float``.
    Any missing credential, HTTP error, malformed response, or incomplete scan
    raises so callers cannot proceed to destructive catalogue cleanup.
    """

    supabase_url = _required_setting(settings, "supabase_url")
    service_role_key = _required_setting(settings, "supabase_service_role_key")
    cursor: str | None = None
    totals = [0, 0, 0, 0]
    for _ in range(2000):
        payload = _call_rpc(
            supabase_url, service_role_key, BRIDGE_RPC_NAME,
            post=post, operation_label="Outcome catalogue bridge",
            arguments={"p_after_id": cursor, "p_limit": 25},
        )
        row = _single_result_row(payload)
        part = OutcomeCatalogueBridgeResult(
            scanned_count=_non_negative_int(row, "scanned_count"),
            created_count=_non_negative_int(row, "created_count"),
            reused_count=_non_negative_int(row, "reused_count"),
            linked_count=_non_negative_int(row, "linked_count"),
            complete=_strict_bool(row, "complete"),
        )
        if part.created_count + part.reused_count != part.scanned_count:
            raise OutcomeCatalogueBridgeError(
                "Outcome catalogue bridge returned incoherent counters; destructive cleanup is disabled."
            )
        if part.linked_count > part.scanned_count:
            raise OutcomeCatalogueBridgeError(
                "Outcome catalogue bridge linked count exceeds its scan; destructive cleanup is disabled."
            )
        part.require_complete()

        if part.scanned_count > 25:
            raise OutcomeCatalogueBridgeError("Bridge batch exceeded its bound; cleanup is disabled.")
        more = _strict_bool(row, "has_more")
        if part.scanned_count:
            try:
                parsed = UUID(str(row.get("next_cursor")))
                if cursor is not None and parsed.int <= UUID(cursor).int:
                    raise ValueError("non-increasing cursor")
            except (ValueError, TypeError, AttributeError) as exc:
                raise OutcomeCatalogueBridgeError("Invalid bridge cursor; cleanup is disabled.") from exc
            cursor = str(parsed)
        elif more:
            raise OutcomeCatalogueBridgeError("Empty bridge page; cleanup is disabled.")
        for index, count in enumerate((part.scanned_count, part.created_count, part.reused_count, part.linked_count)):
            totals[index] += count
        if not more:
            break
    else:
        raise OutcomeCatalogueBridgeError("Bridge page bound exceeded; cleanup is disabled.")
    result = OutcomeCatalogueBridgeResult(*totals, complete=True)

    cursor: str | None = None
    scanned = 0
    # Fixed bound prevents a broken or changing catalogue from looping forever.
    for _ in range(2000):
        payload = _call_rpc(
            supabase_url,
            service_role_key,
            COURT_RECONCILIATION_RPC_NAME,
            post=post,
            operation_label="Competent-court reconciliation",
            arguments={"p_after_id": cursor, "p_limit": 25},
        )
        row = _single_result_row(payload)
        count = _non_negative_int(row, "scanned_count")
        corrected = _non_negative_int(row, "corrected_count")
        already_correct = _non_negative_int(row, "already_correct_count")
        blocked = _non_negative_int(row, "blocked_count")
        if not _strict_bool(row, "complete") or blocked or corrected + already_correct != count or count > 25:
            raise OutcomeCatalogueBridgeError(
                "Competent-court reconciliation is incomplete; destructive cleanup is disabled."
            )
        scanned += count
        if scanned > result.scanned_count:
            raise OutcomeCatalogueBridgeError(
                "Catalogue changed during reconciliation; destructive cleanup is disabled."
            )
        more = _strict_bool(row, "has_more")
        next_cursor = row.get("next_cursor")
        if count:
            try:
                parsed = UUID(str(next_cursor))
                if cursor is not None and parsed.int <= UUID(cursor).int:
                    raise ValueError("non-increasing cursor")
            except (ValueError, TypeError, AttributeError) as exc:
                raise OutcomeCatalogueBridgeError(
                    "Invalid reconciliation cursor; destructive cleanup is disabled."
                ) from exc
            cursor = str(parsed)
        elif more:
            raise OutcomeCatalogueBridgeError("Empty reconciliation page; destructive cleanup is disabled.")
        if not more:
            if scanned != result.scanned_count:
                raise OutcomeCatalogueBridgeError("Incomplete reconciliation scan; destructive cleanup is disabled.")
            break
    else:
        raise OutcomeCatalogueBridgeError("Reconciliation page bound exceeded; destructive cleanup is disabled.")
    return result


def _call_rpc(
    supabase_url: str,
    service_role_key: str,
    rpc_name: str,
    *,
    post: PostCallable,
    operation_label: str,
    arguments: Mapping[str, object] | None = None,
) -> object:
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/rpc/{rpc_name}"
    try:
        response = post(
            endpoint,
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            },
            json=dict(arguments or {}),
            timeout=BRIDGE_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        raise OutcomeCatalogueBridgeError(
            f"{operation_label} RPC could not be reached; destructive cleanup is disabled."
        ) from exc
    if response.is_error:
        raise OutcomeCatalogueBridgeError(
            f"{operation_label} RPC failed; destructive cleanup is disabled (HTTP {response.status_code})."
        )
    try:
        return response.json()
    except ValueError as exc:
        raise OutcomeCatalogueBridgeError(
            f"{operation_label} RPC returned invalid JSON; destructive cleanup is disabled."
        ) from exc


def _required_setting(settings: Mapping[str, object], key: str) -> str:
    value = settings.get(key)
    if not isinstance(value, str) or not value.strip():
        raise OutcomeCatalogueBridgeError(f"{key} is required to bridge the catalogue before destructive cleanup.")
    return value.strip()


def _single_result_row(payload: object) -> Mapping[str, object]:
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise OutcomeCatalogueBridgeError(
            "Outcome catalogue bridge RPC returned an unexpected result shape; destructive cleanup is disabled."
        )
    return payload[0]


def _non_negative_int(row: Mapping[str, object], key: str) -> int:
    value = row.get(key)
    if isinstance(value, bool):
        raise OutcomeCatalogueBridgeError(f"Outcome catalogue bridge field {key} is invalid.")
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and value.isdigit():
        parsed = int(value)
    else:
        raise OutcomeCatalogueBridgeError(f"Outcome catalogue bridge field {key} is invalid.")
    if parsed < 0:
        raise OutcomeCatalogueBridgeError(f"Outcome catalogue bridge field {key} is negative.")
    return parsed


def _strict_bool(row: Mapping[str, object], key: str) -> bool:
    value = row.get(key)
    if not isinstance(value, bool):
        raise OutcomeCatalogueBridgeError(f"Outcome catalogue bridge field {key} is invalid.")
    return value


def _main() -> int:
    from src.config import load_settings

    result = bridge_auction_sales_before_cleanup(load_settings())
    print(json.dumps(asdict(result), sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover - operator CLI.
    raise SystemExit(_main())
