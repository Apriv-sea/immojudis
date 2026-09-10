"""Append-only ingestion helpers for Outcome Graph evidence candidates."""

from src.outcome_ingestion.adapters import (
    SourceRecordAdapterError,
    dvf_adjudication_to_json_record,
    encheres_publiques_to_json_record,
    justice_open_data_to_json_record,
    licitor_historical_to_json_record,
)
from src.outcome_ingestion.dvf_adjudication import (
    AuctionLotMatchContext,
    DvfAdjudicationCandidate,
    DvfMatchCandidate,
    iter_dvf_adjudication_candidates,
    match_dvf_adjudication,
)

__all__ = [
    "AuctionLotMatchContext",
    "DvfAdjudicationCandidate",
    "DvfMatchCandidate",
    "SourceRecordAdapterError",
    "dvf_adjudication_to_json_record",
    "encheres_publiques_to_json_record",
    "iter_dvf_adjudication_candidates",
    "justice_open_data_to_json_record",
    "licitor_historical_to_json_record",
    "match_dvf_adjudication",
]
