from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from src.asset_normalization import (
    BUSINESS_RULE_VERSION,
    SURFACE_PATTERNS,
)
from src.asset_normalization_helpers import (
    _add_quality_flag,
    _evidence,
    _extract_built_surface,
    _extract_count,
    _flag_ambiguous_surface,
    _infer_rooms_count,
    _land_surface_false_positive,
    _living_surface_false_positive,
    _parse_surface_decimal,
    _set_app_surface,
    _set_surface_evidence,
    _surface_false_positive,
    _validate_app_surface_scope,
)
from src.models import AuctionSale
from src.normalize import clean_text, parse_surface


def _fill_surfaces(sale: AuctionSale, text: str) -> None:
    if sale.habitable_surface_m2 is None:
        sale.habitable_surface_m2 = _extract_surface_kind(text, "habitable_surface_m2", sale)
    text_carrez_surface = _extract_surface_kind(text, "carrez_surface_m2", sale)
    if sale.carrez_surface_m2 is None:
        sale.carrez_surface_m2 = text_carrez_surface
    elif not _carrez_surface_is_document_backed(sale) and _should_prefer_text_measured_surface(
        sale.carrez_surface_m2,
        text_carrez_surface,
    ):
        previous_carrez_surface = sale.carrez_surface_m2
        sale.carrez_surface_m2 = text_carrez_surface
        sale.raw_payload["carrez_surface_reconciliation"] = {
            "status": "resolved",
            "rejected_carrez_surface_m2": str(previous_carrez_surface),
            "resolved_carrez_surface_m2": str(text_carrez_surface),
            "basis": "explicit_decimal_carrez_text",
        }
        _add_quality_flag(sale, "surface_conflict_resolved")
    text_land_surface = _extract_surface_kind(text, "land_surface_m2", sale)
    if sale.land_surface_m2 is None:
        sale.land_surface_m2 = text_land_surface
    elif _should_prefer_text_land_surface(sale, text_land_surface):
        previous_land_surface = sale.land_surface_m2
        sale.land_surface_m2 = text_land_surface
        sale.raw_payload["land_surface_reconciliation"] = {
            "status": "resolved",
            "rejected_land_surface_m2": str(previous_land_surface),
            "resolved_land_surface_m2": str(text_land_surface),
            "basis": "explicit_land_text_over_stored_value",
        }
        _add_quality_flag(sale, "land_surface_conflict_resolved")
    elif text_land_surface is None and _should_clear_misclassified_land_surface(sale):
        rejected_land_surface = sale.land_surface_m2
        sale.land_surface_m2 = None
        sale.raw_payload["land_surface_reconciliation"] = {
            "status": "removed",
            "rejected_land_surface_m2": str(rejected_land_surface),
            "resolved_land_surface_m2": None,
            "basis": "duplicated_built_surface_without_land_evidence",
        }
        _add_quality_flag(sale, "land_surface_conflict_resolved")
    _discard_placeholder_built_surface(sale)
    text_built_surface = _extract_built_surface(text, sale)
    if sale.surface_m2 is None:
        sale.surface_m2 = text_built_surface
    elif _should_prefer_text_built_surface(sale, text_built_surface):
        previous_surface = sale.surface_m2
        sale.surface_m2 = text_built_surface
        # A corrected generic area does not establish its legal measurement kind.
        if sale.habitable_surface_m2 == previous_surface:
            sale.habitable_surface_m2 = _extract_surface_kind(text, "habitable_surface_m2", sale)
        if sale.carrez_surface_m2 == previous_surface:
            sale.carrez_surface_m2 = text_carrez_surface
        if _corroborated_text_built_surface(sale) == text_built_surface:
            _record_surface_conflict_resolution(sale, previous_surface, text_built_surface)
    explicit_app_surface = None
    min_app_surface = Decimal("20")
    if sale.property_type == "apartment":
        explicit_app_surface = sale.carrez_surface_m2 or sale.habitable_surface_m2
        min_app_surface = Decimal("9")
    elif sale.property_type == "house":
        explicit_app_surface = sale.habitable_surface_m2
    if explicit_app_surface is not None and explicit_app_surface >= min_app_surface:
        sale.surface_m2 = explicit_app_surface
    if sale.land_surface_m2 is not None and sale.property_type not in {
        "land",
        "house",
        "building",
        "commercial",
        "mixed",
    }:
        sale.land_surface_m2 = None
    _set_app_surface(sale)
    _validate_app_surface_scope(sale)
    _flag_ambiguous_surface(sale)
    if (
        sale.surface_scope is None
        and sale.app_surface_m2 is None
        and sale.land_surface_m2 is not None
        and sale.property_type in {"house", "building"}
    ):
        sale.surface_scope = "land"


def _discard_placeholder_built_surface(sale: AuctionSale) -> None:
    if sale.property_type not in {"house", "building"} or sale.land_surface_m2 is None:
        return
    discarded = False
    if sale.habitable_surface_m2 is not None and sale.habitable_surface_m2 < Decimal("9"):
        sale.habitable_surface_m2 = None
        discarded = True
    if sale.surface_m2 is not None and sale.surface_m2 < Decimal("9") and sale.habitable_surface_m2 is None:
        sale.surface_m2 = None
        discarded = True
    if discarded and sale.app_surface_m2 is not None and sale.app_surface_m2 < Decimal("9"):
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        sale.surface_scope = None


def _should_prefer_text_built_surface(sale: AuctionSale, candidate: Decimal | None) -> bool:
    if candidate is None or sale.surface_m2 is None or candidate == sale.surface_m2:
        return False
    if sale.property_type not in {"house", "apartment", "building"}:
        return False
    if _surface_is_document_backed(sale):
        return False
    if sale.surface_m2 < Decimal("9"):
        return True
    if candidate >= Decimal("20") and candidate > sale.surface_m2:
        return True
    return candidate >= Decimal("9") and _corroborated_text_built_surface(sale) == candidate


def _should_prefer_text_measured_surface(current: Decimal, candidate: Decimal | None) -> bool:
    if candidate is None or candidate == current or candidate < Decimal("9"):
        return False
    if current == current.to_integral_value() and candidate != candidate.to_integral_value():
        return abs(current - candidate) < Decimal("1")
    if min(current, candidate) <= 0:
        return False
    return max(current, candidate) / min(current, candidate) >= Decimal("1.5")


def _surface_is_document_backed(sale: AuctionSale) -> bool:
    extraction = sale.raw_payload.get("surface_extraction")
    if not isinstance(extraction, dict) or extraction.get("source") != "pdf":
        return sale.surface_source == "pdf"
    documented_value = parse_surface(extraction.get("value_m2"))
    return documented_value is not None and documented_value == sale.surface_m2


def _carrez_surface_is_document_backed(sale: AuctionSale) -> bool:
    extraction = sale.raw_payload.get("surface_extraction")
    if not isinstance(extraction, dict) or extraction.get("source") != "pdf":
        return sale.surface_source == "pdf"
    documented_value = parse_surface(extraction.get("value_m2"))
    return documented_value is not None and documented_value == sale.carrez_surface_m2


def _should_prefer_text_land_surface(sale: AuctionSale, candidate: Decimal | None) -> bool:
    current = sale.land_surface_m2
    if candidate is None or current is None or candidate == current:
        return False
    extraction = sale.raw_payload.get("land_surface_extraction")
    if isinstance(extraction, dict) and extraction.get("source") == "pdf":
        documented_value = parse_surface(extraction.get("value_m2"))
        if documented_value == current:
            return False
    built_values = _built_surface_values(sale)
    if current in built_values and candidate not in built_values:
        return True
    if candidate < current:
        return False
    current_digits = _surface_integer_digits(current)
    candidate_digits = _surface_integer_digits(candidate)
    if not current_digits or not candidate_digits:
        return False
    return candidate_digits.endswith(current_digits) or (
        candidate >= current * Decimal("9") and candidate <= current * Decimal("11")
    )


def _surface_integer_digits(value: Decimal) -> str | None:
    if value != value.to_integral_value():
        return None
    return str(int(value))


def _should_clear_misclassified_land_surface(sale: AuctionSale) -> bool:
    current = sale.land_surface_m2
    if current is None or sale.property_type not in {"house", "apartment", "building"}:
        return False
    extraction = sale.raw_payload.get("land_surface_extraction")
    if isinstance(extraction, dict) and extraction.get("source") == "pdf":
        return False
    return current in _built_surface_values(sale)


def _built_surface_values(sale: AuctionSale) -> set[Decimal]:
    return {
        value
        for value in (
            sale.surface_m2,
            sale.habitable_surface_m2,
            sale.carrez_surface_m2,
            sale.app_surface_m2,
        )
        if value is not None
    }


def _corroborated_text_built_surface(sale: AuctionSale) -> Decimal | None:
    title_surface = _extract_built_surface(clean_text(sale.title) or "")
    description_surface = _extract_built_surface(clean_text(sale.description) or "")
    if title_surface is None or title_surface != description_surface:
        return None
    return title_surface


def _record_surface_conflict_resolution(
    sale: AuctionSale,
    previous_surface: Decimal,
    resolved_surface: Decimal,
) -> None:
    evidence = clean_text(" ".join(filter(None, (sale.title, sale.description))))
    sale.surface_source = "corroborated_source_text"
    sale.surface_confidence = Decimal("0.92")
    sale.surface_evidence = evidence[:500] if evidence else None
    sale.raw_payload["surface_reconciliation"] = {
        "status": "resolved",
        "rejected_surface_m2": str(previous_surface),
        "resolved_built_surface_m2": str(resolved_surface),
        "basis": "matching_title_and_description",
    }
    _add_quality_flag(sale, "surface_conflict_resolved")


def _apply_document_consistency_corrections(sale: AuctionSale, text: str) -> None:
    lowered = text.lower()
    if sale.property_type in {"building", "other", "unknown", None} and _text_describes_single_apartment(lowered):
        evidence = _first_rule_evidence(
            text,
            (
                r"\bappartement\s+de\s+type\s+studio\b",
                r"\btype\s+d['’]habitat\s*:?\s*studio\b",
                r"\bstudio\b.{0,80}\b(?:rez-de-chauss[ée]e|copropri[ée]t[ée]|surface\s+habitable|bail)\b",
            ),
        )
        previous_value = sale.property_type
        sale.property_type = "apartment"
        _add_quality_flag(sale, "type_corrected_from_documents")
        _record_business_rule(
            sale,
            "property_type_from_specific_asset",
            factor_key="type",
            decision="Type retenu : appartement/studio, et non immeuble.",
            evidence=evidence,
            reasoning=(
                "Le mot immeuble peut désigner juridiquement le bâtiment ou la copropriété. "
                "Quand le dossier rattache l'actif vendu à un logement précis, un lot, un studio "
                "ou un appartement, le scoring doit qualifier l'actif analysé et non le support cadastral."
            ),
            impact=(
                f"La valeur structurée initiale ({previous_value or 'non renseignée'}) est corrigée "
                "pour éviter de survaloriser à tort un potentiel d'immeuble de rapport."
            ),
            confidence=0.78,
        )

    if sale.occupancy_status in {"vacant", "free"} and _has_unresolved_occupancy_conflict(lowered):
        evidence = _first_rule_evidence(
            text,
            (
                r"\b(?:actuellement\s+)?occup[ée]\b.{0,120}\b(?:bail|locataire|loyer)\b",
                r"\b(?:bail|locataire|loyer\s+mensuel)\b.{0,120}\b(?:occup[ée]|meubl[ée]|charges?\s+comprises)\b",
            ),
        )
        previous_value = sale.occupancy_status
        sale.occupancy_status = "unknown"
        _add_quality_flag(sale, "occupation_conflict")
        _record_business_rule(
            sale,
            "occupation_conflict_requires_confirmation",
            factor_key="occupation",
            decision="Occupation retenue : à confirmer.",
            evidence=evidence,
            reasoning=(
                "Une annonce peut indiquer libre, mais un PV, un bail ou une pièce d'occupation a une portée "
                "plus opérationnelle pour l'investisseur. Si ces documents signalent un locataire, un bail "
                "ou un loyer sans preuve de départ effectif, l'application ne doit pas conclure que le bien "
                "sera libre à l'adjudication."
            ),
            impact=(
                f"Le statut initial ({previous_value}) est neutralisé : le score retire le bonus de liquidité "
                "et demande une vérification avant de calculer un scénario locatif ou de revente."
            ),
            confidence=0.82,
        )


def _text_describes_single_apartment(text: str) -> bool:
    if re.search(
        r"\bimmeuble\s+(?:entier|comprenant|compos[ée]|[àa]\s+usage)|"
        r"\bplusieurs\s+appartements?\b|"
        r"\bensemble\s+immobilier\s+comprenant\b",
        text,
        re.I,
    ):
        return False
    return bool(
        re.search(
            r"\bappartement\s+de\s+type\s+studio\b|"
            r"\bappartement\b.{0,80}\bstudio\b|"
            r"\bstudio\b.{0,80}\b(?:rez-de-chauss[ée]e|copropri[ée]t[ée]|surface\s+habitable|bail)\b|"
            r"\btype\s+d['’]habitat\s*:?\s*studio\b|"
            r"\blogement\b.{0,80}\bstudio\b",
            text,
            re.I,
        )
    )


def _has_unresolved_occupancy_conflict(text: str) -> bool:
    occupied_signal = re.search(
        r"\b(?:actuellement\s+)?occup[ée]\b|"
        r"\bsuivant\s+un\s+bail\b|"
        r"\bbail\s+(?:meubl[ée]|d['’]habitation|en\s+cours)\b|"
        r"\blocataire\b|"
        r"\bloyer\s+mensuel\b",
        text,
        re.I,
    )
    if not occupied_signal:
        return False
    resolved_vacancy = re.search(
        r"\blibre\s+de\s+toute\s+occupation\b|"
        r"\ba\s+quitt[ée]\s+les\s+lieux\b|"
        r"\bd[ée]part\s+effectif\b|"
        r"\bconstat[ée]?\s+libre\b",
        text,
        re.I,
    )
    return not bool(resolved_vacancy)


def _first_rule_evidence(text: str, patterns: tuple[str, ...], *, window: int = 170) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.S)
        if not match:
            continue
        return _evidence(text, match.start(), match.end(), window=window)
    return None


def _record_business_rule(
    sale: AuctionSale,
    rule_id: str,
    *,
    factor_key: str,
    decision: str,
    evidence: str | None,
    reasoning: str,
    impact: str,
    confidence: float,
) -> None:
    rules = sale.raw_payload.setdefault("business_rules", [])
    if not isinstance(rules, list):
        rules = []
        sale.raw_payload["business_rules"] = rules
    rule = {
        "rule_id": rule_id,
        "version": BUSINESS_RULE_VERSION,
        "factor_key": factor_key,
        "decision": decision,
        "evidence": evidence,
        "reasoning": reasoning,
        "impact": impact,
        "confidence": confidence,
    }
    for index, item in enumerate(rules):
        if isinstance(item, dict) and item.get("rule_id") == rule_id:
            rules[index] = rule
            return
    rules.append(rule)


def _business_rule(sale: AuctionSale, rule_id: str) -> dict[str, Any] | None:
    rules = sale.raw_payload.get("business_rules")
    if not isinstance(rules, list):
        return None
    for item in rules:
        if isinstance(item, dict) and item.get("rule_id") == rule_id:
            return item
    return None


def _business_rule_refs(sale: AuctionSale, factor_key: str | None = None) -> list[dict[str, Any]]:
    rules = sale.raw_payload.get("business_rules")
    if not isinstance(rules, list):
        return []
    refs = []
    for item in rules:
        if not isinstance(item, dict):
            continue
        if factor_key is not None and item.get("factor_key") != factor_key:
            continue
        refs.append(_business_rule_to_ref(item))
    return refs


def _business_rule_to_ref(rule: dict[str, Any]) -> dict[str, Any]:
    return {
        "label": rule.get("decision") or rule.get("rule_id"),
        "excerpt": rule.get("evidence"),
        "document_type": "règle métier",
        "confidence": rule.get("confidence"),
        "reasoning": rule.get("reasoning"),
    }


def _extract_surface_kind(text: str, kind: str, sale: AuctionSale | None = None) -> Decimal | None:
    for pattern in SURFACE_PATTERNS[kind]:
        match = re.search(pattern, text, re.I | re.S)
        if not match:
            continue
        if len(match.groups()) == 2:
            return Decimal(match.group(1)) * Decimal("100") + Decimal(match.group(2))
        value = _parse_surface_decimal(match.group(1))
        if (
            value
            and not _surface_false_positive(text, match.start(), match.end())
            and not _land_surface_false_positive(text, match, kind)
            and not _living_surface_false_positive(text, match.start(), match.end(), kind)
        ):
            if sale is not None:
                _set_surface_evidence(sale, kind, _evidence(text, match.start(), match.end()))
            return value
    return None


def _fill_counts(sale: AuctionSale, text: str) -> None:
    if sale.rooms_count is None:
        sale.rooms_count = _infer_rooms_count(text, sale)
    if sale.bedrooms_count is None and re.search(r"\bstudio\b|\bT\s*1\b|\btype\s*1\b", text, re.I):
        sale.bedrooms_count = 0
    if sale.rooms_count is not None and sale.bedrooms_count is not None and sale.bedrooms_count > sale.rooms_count:
        sale.rooms_count = None
        _add_quality_flag(sale, "room_count_conflict")
    if sale.bathrooms_count is None:
        sale.bathrooms_count = _extract_count(
            text,
            (
                r"\b([1-9][0-9]?)\s+salles?\s+(?:de\s+)?bains?\b",
                r"\b([1-9][0-9]?)\s+salles?\s+d['’]eau\b",
                r"\bsalles?\s+(?:de\s+)?bains?\s*:?\s*([1-9][0-9]?)\b",
            ),
        )
    if sale.parking_count is None:
        sale.parking_count = _extract_count(
            text,
            (
                r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+(?:places?\s+de\s+)?parkings?\b",
                r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+places?\s+de\s+stationnement\b",
                r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+garages?\b",
            ),
        )
        if sale.parking_count is None and re.search(r"\bparking\b|\bgarage\b", text, re.I):
            sale.parking_count = 1


def _fill_booleans(sale: AuctionSale, text: str) -> None:
    checks = {
        "has_garden": r"\bjardin\b",
        "has_terrace": r"\bterrasse\b",
        "has_garage": r"\bgarage\b",
        "has_pool": r"\bpiscine\b",
        "has_air_conditioning": r"\bclimatisation\b|\bclimatis[ée]\b",
        "has_double_glazing": r"double\s+vitrage",
    }
    for flag_name, pattern in checks.items():
        if getattr(sale, flag_name) is None:
            setattr(sale, flag_name, bool(re.search(pattern, text, re.I)))
