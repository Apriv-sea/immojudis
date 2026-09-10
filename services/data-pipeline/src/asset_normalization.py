from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from src.models import AuctionSale
from src.normalize import SURFACE_VALUE_PATTERN, clean_text, parse_surface


@dataclass
class ScoreComponent:
    name: str
    points: Decimal
    reason: str
    confidence: Decimal = Decimal("0.7")
    evidence: str | None = None
    raw_value: object | None = None
    criterion: str | None = None
    calculation: str | None = None
    interpretation: str | None = None
    limits: str | None = None
    evidence_refs: list[dict[str, Any]] = field(default_factory=list)
    axis: str | None = None
    question: str | None = None


RISK_DETECTOR_VERSION = "risk_context_v4"

BUSINESS_RULE_VERSION = "business_rules_v1"

PREMIUM_ANALYSIS_VERSION = "premium_due_diligence_v1"

MAX_NORMALIZATION_TEXT_CHARS = 1_000_000


class AssetNormalizationInputTooLarge(ValueError):
    """Raised when attacker-controlled source text exceeds the regex safety budget."""


AXIS_DEFINITIONS: dict[str, dict[str, object]] = {
    "financial_attractiveness": {
        "label": "Attractivité financière",
        "question": "Le prix de départ laisse-t-il une marge de sécurité exploitable ?",
        "factor_keys": ("prix_m2", "surface"),
    },
    "asset_quality": {
        "label": "Qualité du bien",
        "question": "L'état, les diagnostics et les caractéristiques rendent-ils le bien exploitable ?",
        "factor_keys": ("état", "atouts", "risques"),
    },
    "legal_security": {
        "label": "Sécurité juridique",
        "question": "L'occupation, les servitudes et les contraintes juridiques sont-elles maîtrisées ?",
        "factor_keys": ("occupation", "risques"),
    },
    "liquidity_resale": {
        "label": "Liquidité / revente",
        "question": "Le type de bien et sa localisation facilitent-ils la sortie ?",
        "factor_keys": ("type", "localisation"),
    },
    "analysis_confidence": {
        "label": "Confiance de l'analyse",
        "question": "Les données et preuves sont-elles suffisantes pour utiliser le score ?",
        "factor_keys": ("qualité",),
    },
}

FACTOR_AXIS = {
    "prix_m2": "financial_attractiveness",
    "surface": "financial_attractiveness",
    "état": "asset_quality",
    "etat": "asset_quality",
    "atouts": "asset_quality",
    "risques": "asset_quality",
    "occupation": "legal_security",
    "type": "liquidity_resale",
    "localisation": "liquidity_resale",
    "qualité": "analysis_confidence",
    "qualite": "analysis_confidence",
}

SURFACE_PATTERNS = {
    "habitable_surface_m2": (
        rf"surface\s*habitable\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"superficie\s+(?:de\s+|d['’]environ\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+superficie\b",
        rf"\bappartement\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
        rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+habitables?",
    ),
    "carrez_surface_m2": (
        rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²|\*)\s+(?:loi\s+)?carrez",
        rf"(?:surface\s+)?carrez.{{0,40}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"loi\s+carrez.{{0,40}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"superficie\s*approximative\s*habitable\s*totale\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m(?:2|²|\?)",
    ),
    "land_surface_m2": (
        rf"\bcadastr[ée]e?.{{0,140}}?\b(?:total|superficie|contenance)\b.{{0,30}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\bsection\s+[A-Z]{{1,4}}\s*(?:n[°o]\s*)?[0-9A-Z]+.{{0,100}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\b(?:surface\s+(?:du\s+)?terrain|terrain\s+d['’]environ)\s+(?:d['’]environ\s+|environ\s+|de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        r"\b(?:cadastr[ée]e?.{0,120}?\bpour\s+)?([0-9]+)\s*ares?\s+([0-9]+)\s*centiares?\b",
        rf"(?:terrain|parcelle|jardin).{{0,60}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        r"contenance\s+(?:totale\s+)?(?:de\s+)?([0-9]+)\s*a\s*([0-9]+)\s*ca",
        r"([0-9]+)\s*a\s*([0-9]+)\s*ca",
    ),
}

RISK_PATTERNS = {
    "legal": {
        "occupation": r"occup[ée]\s+sans\s+bail|sans\s+droit\s+ni\s+titre|squatt|\bbail\b|\blocataire\b|\bloyer\s+mensuel\b",
        "servitude": r"\bservitudes?\b",
        "copropriété": r"\bcopropri[ée]t[ée]\b|charges\s+de\s+copropri[ée]t[ée]",
    },
    "physical": {
        "amiante": r"\bamiante\b",
        "plomb": r"\bplomb\b",
        "termites": r"\btermites?\b",
        "DPE": r"\bDPE\b|diagnostic\s+de\s+performance\s+[ée]nerg[ée]tique",
        "travaux": (
            r"\btravaux\b|r[ée]novation|rafra[iî]chissement|v[ée]tuste|ruine|"
            r"mauvais\s+[ée]tat|d[ée]grad[ée]s?|d[ée]g[aâ]t\s+des\s+eaux|infiltration"
        ),
    },
}

RISK_DEFINITIONS = tuple(
    {
        "risk_type": risk_type,
        "risk_label": risk_label,
        "pattern": pattern,
        "severity": {
            "occupation": 5,
            "amiante": 3,
            "plomb": 3,
            "termites": 3,
            "travaux": 4,
            "servitude": 2,
            "copropriété": 1,
            "DPE": 1,
        }.get(risk_label, 1),
    }
    for risk_type, patterns in RISK_PATTERNS.items()
    for risk_label, pattern in patterns.items()
)

_PROPERTY_TYPE_LABELS = {
    "apartment": "Appartement",
    "house": "Maison",
    "building": "Immeuble",
    "land": "Terrain",
    "commercial": "Local commercial",
    "parking": "Parking",
    "mixed": "Bien mixte",
}


def _format_surface_m2(value: Decimal | float | None) -> str | None:
    if value is None:
        return None
    try:
        rounded = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    if rounded <= 0:
        return None
    return f"{rounded:,}".replace(",", " ") + " m²"


def build_display_title(sale: AuctionSale) -> str:
    """Generic, consistent title built from the extracted data: property type +
    surface (when available). Replaces heterogeneous scraped titles. The original
    title stays available in raw_payload/raw_text for context and the LLM."""
    source_title = _specific_source_title(sale)
    if sale.property_type in {"commercial", "mixed"} and source_title:
        return source_title
    label = _PROPERTY_TYPE_LABELS.get(sale.property_type or "", "Bien immobilier")
    if sale.property_type == "land":
        surface = _format_surface_m2(sale.land_surface_m2)
    elif sale.surface_scope in {"partial", "room_or_annex", "unknown"}:
        surface = None
    else:
        surface = _format_surface_m2(sale.app_surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2)
    return f"{label} {surface}" if surface else label


def _specific_source_title(sale: AuctionSale) -> str | None:
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    candidates: list[object | None] = [raw_payload.get("title")]
    source_blocks = raw_payload.get("source_blocks")
    if isinstance(source_blocks, dict):
        candidates.extend((source_blocks.get("titre"), source_blocks.get("title")))
    candidates.append(sale.title)

    for candidate in candidates:
        title = clean_text(candidate)
        if _is_specific_display_title(title):
            return title
    return None


def _is_specific_display_title(title: str | None) -> bool:
    if not title or len(title) < 12:
        return False
    lowered = title.lower()
    generic_labels = {label.lower() for label in _PROPERTY_TYPE_LABELS.values()}
    generic_labels.update({"autre", "autres", "bien immobilier"})
    if lowered in generic_labels:
        return False
    return not bool(
        re.fullmatch(
            r"(?:vente aux enchères\s+)?(?:autres?|local commercial|commerce|terrain|immeuble|maison|appartement|bien mixte)"
            r"(?:\s+[0-9]+(?:[,.][0-9]+)?\s*m(?:2|²))?",
            lowered,
        )
    )


def normalize_asset_features(sale: AuctionSale) -> AuctionSale:
    _assert_normalization_input_size(sale)
    _restore_partial_document_surface_scope(sale)
    text = _sale_text(sale)
    if not text:
        _fill_quality_flags(sale)
        _score_sale(sale, [])
        sale.title = build_display_title(sale)
        return sale

    _apply_document_consistency_corrections(sale, text)
    _fill_surfaces(sale, text)
    _fill_counts(sale, text)
    _fill_booleans(sale, text)
    risks = extract_risks(sale)
    _fill_quality_flags(sale)
    _score_sale(sale, risks)
    _write_asset_payload(sale, risks)
    sale.title = build_display_title(sale)
    return sale


def _assert_normalization_input_size(sale: AuctionSale) -> None:
    text_fields = (sale.title, sale.description, sale.risk_notes, sale.raw_text, sale.surface_evidence)
    total_chars = sum(len(value) for value in text_fields if isinstance(value, str))
    if total_chars > MAX_NORMALIZATION_TEXT_CHARS:
        raise AssetNormalizationInputTooLarge(
            f"Asset normalization input exceeds {MAX_NORMALIZATION_TEXT_CHARS} characters."
        )


def _restore_partial_document_surface_scope(sale: AuctionSale) -> None:
    extraction = sale.raw_payload.get("surface_extraction")
    if not isinstance(extraction, dict) or extraction.get("surface_scope") != "partial":
        return
    if extraction.get("source") != "pdf":
        return

    documented_value = parse_surface(extraction.get("value_m2"))
    measured_values = {
        value
        for value in (
            sale.surface_m2,
            sale.habitable_surface_m2,
            sale.carrez_surface_m2,
        )
        if value is not None
    }
    if documented_value is None or documented_value not in measured_values:
        return
    if sale.app_surface_m2 is not None and sale.app_surface_m2 != documented_value:
        return

    previous_scope = sale.surface_scope
    previous_app_surface = sale.app_surface_m2
    sale.surface_scope = "partial"
    sale.app_surface_m2 = None
    sale.app_surface_kind = None
    sale.raw_payload["surface_scope_reconciliation"] = {
        "status": "restored",
        "previous_scope": previous_scope,
        "rejected_app_surface_m2": str(previous_app_surface) if previous_app_surface is not None else None,
        "documented_partial_surface_m2": str(documented_value),
        "basis": "structured_pdf_extraction_scope",
    }
    _add_quality_flag(sale, "partial_surface_scope_restored")


def build_auction_features_row(sale: AuctionSale) -> dict[str, Any]:
    return {
        "source_url": sale.source_url,
        "bathrooms_count": sale.bathrooms_count,
        "parking_count": sale.parking_count,
        "has_garden": sale.has_garden,
        "has_terrace": sale.has_terrace,
        "has_garage": sale.has_garage,
        "has_pool": sale.has_pool,
        "has_air_conditioning": sale.has_air_conditioning,
        "has_double_glazing": sale.has_double_glazing,
        "investment_score": _float_or_none(sale.investment_score),
        "investment_summary": sale.investment_summary,
    }


def build_auction_surfaces_row(sale: AuctionSale) -> dict[str, Any]:
    return {
        "source_url": sale.source_url,
        "surface_m2": _float_or_none(sale.surface_m2),
        "habitable_surface_m2": _float_or_none(sale.habitable_surface_m2),
        "land_surface_m2": _float_or_none(sale.land_surface_m2),
        "carrez_surface_m2": _float_or_none(sale.carrez_surface_m2),
        "app_surface_m2": _float_or_none(sale.app_surface_m2),
        "app_surface_kind": sale.app_surface_kind,
        "surface_scope": sale.surface_scope,
        "surface_source": sale.surface_source,
        "surface_confidence": _float_or_none(sale.surface_confidence),
        "surface_evidence": sale.surface_evidence,
        "rooms_count": sale.rooms_count,
        "bedrooms_count": sale.bedrooms_count,
        "bathrooms_count": sale.bathrooms_count,
        "parking_count": sale.parking_count,
    }


def build_auction_risk_rows(sale: AuctionSale) -> list[dict[str, Any]]:
    return extract_risks(sale)


def extract_risks(sale: AuctionSale) -> list[dict[str, Any]]:
    occurrences = extract_risk_occurrences_from_text(
        _risk_source_text(sale),
        sale.source_url,
        source_kind="sale_text",
        document_type="source_listing",
    )
    return build_auction_risk_rows_from_occurrences(sale.source_url, occurrences)


def build_auction_risk_rows_from_occurrences(
    source_url: str,
    occurrences: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    occurrence_counts: dict[str, int] = {}
    for occurrence in occurrences:
        label = str(occurrence["risk_label"])
        occurrence_counts[label] = occurrence_counts.get(label, 0) + 1
        current = grouped.get(label)
        if current is None or _risk_occurrence_rank(occurrence) > _risk_occurrence_rank(current):
            grouped[label] = {
                "source_url": source_url,
                "risk_type": occurrence["risk_type"],
                "risk_label": label,
                "severity": occurrence["severity"],
                "evidence": occurrence["excerpt"],
                "confidence": occurrence["confidence"],
                "detector": occurrence["detector"],
                "detector_version": occurrence["detector_version"],
                "score_impact": -float(occurrence["severity"]),
                "evidence_json": {
                    "source_kind": occurrence.get("source_kind") or "pdf",
                    "document_url": occurrence.get("document_url"),
                    "document_label": occurrence.get("document_label"),
                    "document_type": occurrence.get("document_type"),
                    "page_number": occurrence.get("page_number"),
                    "excerpt": occurrence["excerpt"],
                    "matched_terms": occurrence.get("matched_terms", []),
                    "fact": f"{label} retenu",
                    "risk_status": _risk_status(label, occurrence),
                    "source_status": _source_status(occurrence),
                    "decision_chain": _risk_decision_chain(label, occurrence),
                    "verification_priority": _risk_verification_priority(
                        label,
                        int(occurrence.get("severity") or 1),
                    ),
                    "status": _risk_fact_status(float(occurrence.get("confidence") or 0)),
                    "reasoning": _risk_reasoning(label, occurrence),
                    "why_it_matters": _risk_why_it_matters(label, int(occurrence.get("severity") or 1)),
                    "next_action": _risk_next_action(label),
                    "document_context": _document_context_label(occurrence.get("document_type")),
                    "document_weight": _document_type_weight(str(occurrence.get("document_type") or "")),
                    "question": _risk_question(label),
                    "decision": "Retenu car le contexte rattache la mention au bien ou à un document probant.",
                    "confidence_note": _confidence_note(Decimal(str(occurrence.get("confidence") or "0"))),
                },
            }

    rows = []
    for label, row in grouped.items():
        row["evidence_json"]["occurrence_count"] = occurrence_counts.get(label, 1)
        rows.append(row)
    return rows


def build_auction_score_factor_rows(
    sale: AuctionSale,
    risk_occurrences: list[dict[str, object]] | None = None,
) -> list[dict[str, Any]]:
    factors = sale.score_factors or sale.raw_payload.get("score_factors") or []
    if not isinstance(factors, list):
        return []
    rows = []
    seen_factor_keys: set[str] = set()
    for index, factor in enumerate(factors):
        if not isinstance(factor, dict):
            continue
        factor_key = str(factor.get("factor_key") or factor.get("name") or f"factor_{index}")
        if factor_key in seen_factor_keys:
            continue
        seen_factor_keys.add(factor_key)
        evidence_refs = factor.get("evidence_refs") or []
        if not evidence_refs and factor_key in {"risques", "état", "etat"} and risk_occurrences:
            evidence_refs = _factor_refs_from_risk_occurrences(risk_occurrences)
        rows.append(
            {
                "source_url": sale.source_url,
                "factor_order": index,
                "factor_key": factor_key,
                "label": factor.get("label") or factor_key,
                "reason": factor.get("reason"),
                "delta": factor.get("delta"),
                "weight": factor.get("weight"),
                "raw_value": factor.get("raw_value"),
                "normalized_value": factor.get("normalized_value"),
                "confidence": factor.get("confidence"),
                "evidence": factor.get("evidence"),
                "evidence_refs": evidence_refs,
            }
        )
    return rows


def extract_risk_occurrences_from_text(
    text: str | None,
    source_url: str,
    *,
    source_kind: str,
    document_url: str | None = None,
    document_label: str | None = None,
    document_type: str | None = None,
    page_number: int | None = None,
) -> list[dict[str, Any]]:
    if not text:
        return []
    normalized_document_type = _normalize_document_type(document_type, source_kind)
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int | None]] = set()
    for definition in RISK_DEFINITIONS:
        label = str(definition["risk_label"])
        pattern = str(definition["pattern"])
        matches_for_label = 0
        for match in re.finditer(pattern, text, re.I):
            if _risk_match_is_negated(text, match.start(), match.end(), label):
                continue
            context = _evidence(text, match.start(), match.end())
            decision = _risk_context_decision(
                label,
                context,
                source_kind=source_kind,
                document_type=normalized_document_type,
            )
            if not decision["accepted"]:
                continue
            key = (label, clean_text(context)[:120], page_number)
            if key in seen:
                continue
            seen.add(key)
            matches_for_label += 1
            rows.append(
                {
                    "source_url": source_url,
                    "risk_type": definition["risk_type"],
                    "risk_label": label,
                    "severity": decision.get("severity") or definition["severity"],
                    "document_url": document_url,
                    "document_label": document_label,
                    "document_type": normalized_document_type,
                    "page_number": page_number,
                    "excerpt": context,
                    "confidence": decision["confidence"],
                    "detector": "contextual_rules",
                    "detector_version": RISK_DETECTOR_VERSION,
                    "matched_terms": [match.group(0)],
                    "is_negated": False,
                    "score_impact": -float(decision.get("severity") or definition["severity"]),
                    "source_kind": source_kind,
                    "context_reasoning": decision.get("reasoning"),
                    "risk_status": decision.get("risk_status") or "confirmed",
                }
            )
            if matches_for_label >= 3:
                break
    return rows


from src.asset_normalization_helpers import (  # noqa: E402,F401
    _add_quality_flag,
    _axis_label,
    _axis_reading,
    _classify_document_label,
    _compact_dict,
    _component_axis,
    _component_decision,
    _component_facts,
    _component_question,
    _component_raw_fact_label,
    _confidence_note,
    _contextual_confidence,
    _copro_context_is_specific,
    _decimal_value,
    _default_factor_criterion,
    _diagnostic_context_is_only_inventory,
    _diagnostic_question_detail,
    _document_context_label,
    _document_type_weight,
    _dpe_context_is_risky,
    _evidence,
    _extract_built_surface,
    _extract_count,
    _factor_refs_from_risk_occurrences,
    _factor_status,
    _fill_quality_flags,
    _flag_ambiguous_surface,
    _float_or_none,
    _format_decimal,
    _format_eur,
    _has_specific_property_assertion,
    _hazard_context_is_positive,
    _infer_rooms_count,
    _is_generic_context,
    _json_safe,
    _land_surface_false_positive,
    _large_non_residential_surface_is_supported,
    _list_value_labels,
    _living_surface_false_positive,
    _normalize_document_type,
    _number_word_to_int,
    _occupancy_status_label,
    _occupation_context_is_specific,
    _parse_surface_decimal,
    _proof_level,
    _property_type_label,
    _quality_flag_label,
    _quality_penalty_breakdown,
    _raw_value_label,
    _risk_confidence,
    _risk_context_decision,
    _risk_decision_chain,
    _risk_fact_status,
    _risk_match_is_negated,
    _risk_next_action,
    _risk_occurrence_rank,
    _risk_penalty_breakdown,
    _risk_question,
    _risk_reasoning,
    _risk_severity,
    _risk_source_text,
    _risk_status,
    _risk_to_evidence_ref,
    _risk_verification_priority,
    _risk_why_it_matters,
    _sale_text,
    _sale_type_context,
    _servitude_context_is_specific,
    _set_app_surface,
    _set_surface_evidence,
    _source_status,
    _surface_evidence_refs,
    _surface_false_positive,
    _text_has_works_signal,
    _validate_app_surface_scope,
    _works_severity,
)
from src.asset_premium_analysis import (  # noqa: E402,F401
    _analysis_contradictions,
    _axis_summaries,
    _build_premium_investment_analysis,
    _confidence_gates,
    _deal_memo_actions,
    _deal_memo_payload,
    _document_facts,
    _evidence_trace,
    _fact,
    _investment_facts,
    _investment_questions,
    _load_scoring_weights,
    _premium_headline,
    _question,
)
from src.asset_scoring import (  # noqa: E402,F401
    _price_bands_for_sale,
    _score_amenities,
    _score_condition,
    _score_confidence,
    _score_data_quality,
    _score_factor_payload,
    _score_location,
    _score_occupation,
    _score_price_per_m2,
    _score_property_type,
    _score_risks,
    _score_sale,
    _score_surface,
    _write_asset_payload,
)
from src.asset_surface_normalization import (  # noqa: E402,F401
    _apply_document_consistency_corrections,
    _built_surface_values,
    _business_rule,
    _business_rule_refs,
    _business_rule_to_ref,
    _carrez_surface_is_document_backed,
    _corroborated_text_built_surface,
    _discard_placeholder_built_surface,
    _extract_surface_kind,
    _fill_booleans,
    _fill_counts,
    _fill_surfaces,
    _first_rule_evidence,
    _has_unresolved_occupancy_conflict,
    _record_business_rule,
    _record_surface_conflict_resolution,
    _should_clear_misclassified_land_surface,
    _should_prefer_text_built_surface,
    _should_prefer_text_land_surface,
    _should_prefer_text_measured_surface,
    _surface_integer_digits,
    _surface_is_document_backed,
    _text_describes_single_apartment,
)
