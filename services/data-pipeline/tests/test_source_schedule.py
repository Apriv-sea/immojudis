from datetime import UTC, datetime, timedelta

import pytest

from src.autonomous_runner import (
    INVENTORY_CADENCE,
    INVENTORY_DISPATCH_MARGIN,
    next_inventory_deadline,
)

NOW = datetime(2026, 9, 13, 12, 0, tzinfo=UTC)


def evidence_row(*, source_url='https://source.test/1', sale_date=None, status='upcoming', payload=None,
                 checkpoint_payload=None, observations=None):
    row = {
        'source_url': source_url,
        'sale_date': sale_date or NOW + timedelta(days=1),
        'status': status,
        'raw_payload': payload or {},
    }
    if checkpoint_payload is not None:
        row['checkpoint_payload'] = checkpoint_payload
    if observations is not None:
        row['observations'] = observations
    return row


def test_deadline_uses_oldest_reused_check_and_dispatch_margin():
    rows = [
        evidence_row(payload={'source_checks': {'https://source.test/1': {
            'source_name': 'licitor', 'checked_at': '2026-09-13T11:30:00Z',
        }}}),
        evidence_row(source_url='https://source.test/2', payload={'source_checks': {
            'https://source.test/2': {'source_name': 'licitor', 'checked_at': '2026-09-13T11:45:00Z'},
        }}),
    ]

    deadline = next_inventory_deadline(
        now=NOW,
        started_at='2026-09-13T11:00:00Z',
        source='licitor',
        evidence_rows=rows,
    )

    assert deadline == datetime(2026, 9, 13, 16, 45, tzinfo=UTC)
    assert INVENTORY_CADENCE - INVENTORY_DISPATCH_MARGIN == timedelta(hours=5, minutes=15)


def test_old_checkpoint_is_due_now_instead_of_claiming_six_more_hours():
    rows = [evidence_row(checkpoint_payload={'_checkpoint_checked_at': '2026-09-13T05:00:00Z'})]

    deadline = next_inventory_deadline(
        now=NOW,
        started_at='2026-09-13T11:00:00Z',
        source='licitor',
        evidence_rows=rows,
    )

    assert deadline == NOW


def test_old_alias_absent_from_run_does_not_pull_deadline_back():
    rows = [evidence_row(payload={'source_checks': {
        'https://source.test/1': {'source_name': 'licitor', 'checked_at': '2026-09-13T11:45:00Z'},
        # This stale alias is deliberately not emitted as a run evidence row.
    }})]

    deadline = next_inventory_deadline(
        now=NOW,
        started_at='2026-09-13T11:00:00Z',
        source='licitor',
        evidence_rows=rows,
    )

    assert deadline == datetime(2026, 9, 13, 17, 0, tzinfo=UTC)


def test_canonical_old_checkpoint_does_not_override_fresh_source_check():
    source_url = 'https://source.test/alias'
    rows = [evidence_row(source_url=source_url, payload={
        '_checkpoint_checked_at': '2026-09-13T05:00:00Z',
        'source_checks': {source_url: {
            'source_name': 'licitor', 'checked_at': '2026-09-13T11:45:00Z',
        }},
    })]

    deadline = next_inventory_deadline(
        now=NOW,
        started_at='2026-09-13T11:00:00Z',
        source='licitor',
        evidence_rows=rows,
    )

    assert deadline == datetime(2026, 9, 13, 17, 0, tzinfo=UTC)


def test_other_source_checkpoint_payload_is_ignored_when_current_url_is_fresh():
    source_url = 'https://source.test/current'
    rows = [evidence_row(source_url=source_url, payload={
        'source_checks': {source_url: {
            'source_name': 'licitor', 'checked_at': '2026-09-13T11:45:00Z',
        }},
    }, observations=[{
        'source_url': 'https://source.test/old-alias',
        'raw_payload': {'_checkpoint_checked_at': '2026-09-13T05:00:00Z'},
    }])]

    deadline = next_inventory_deadline(
        now=NOW,
        started_at='2026-09-13T11:00:00Z',
        source='licitor',
        evidence_rows=rows,
    )

    assert deadline == datetime(2026, 9, 13, 17, 0, tzinfo=UTC)


@pytest.mark.parametrize('checked_at', ['not-a-date', '2026-09-13T13:00:00Z'])
def test_invalid_or_future_check_uses_run_start_conservatively(checked_at):
    rows = [evidence_row(payload={'source_checks': {
        'https://source.test/1': {'source_name': 'licitor', 'checked_at': checked_at},
    }})]

    deadline = next_inventory_deadline(
        now=NOW,
        started_at='2026-09-13T11:00:00Z',
        source='licitor',
        evidence_rows=rows,
    )

    assert deadline == datetime(2026, 9, 13, 16, 15, tzinfo=UTC)


def test_without_a_close_listing_the_old_catalogue_check_is_ignored():
    rows = [evidence_row(
        sale_date=NOW + timedelta(days=8),
        payload={'source_checks': {
            'https://source.test/1': {'source_name': 'licitor', 'checked_at': '2026-09-10T00:00:00Z'},
        }},
    )]

    deadline = next_inventory_deadline(
        now=NOW,
        started_at='2026-09-13T11:00:00Z',
        source='licitor',
        evidence_rows=rows,
    )

    assert deadline == NOW + INVENTORY_CADENCE
