from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from src.models import AuctionSale
from src.normalize import clean_text

SURFACE_REASONING_VERSION = "surface_reasoning_v1"
SURFACE_TOLERANCE_ABSOLUTE_M2 = Decimal("1")
SURFACE_TOLERANCE_RELATIVE = Decimal("0.02")

SurfaceCategory = Literal[
    "habitable",
    "circulation",
    "sanitary",
    "service",
    "annex",
    "exterior",
    "land",
    "unknown",
]
SurfaceKind = Literal[
    "explicit_carrez",
    "explicit_habitable",
    "explicit_total",
    "explicit_built",
    "calculated_room_sum",
    "calculated_sale_sum",
    "land",
    "annex",
    "unknown",
]
MeasurementCompleteness = Literal["complete", "likely_complete", "partial", "unknown"]


class SurfaceEvidence(BaseModel):
    model_config = ConfigDict(extra="ignore")

    quote: str | None = None
    document_url: str | None = None
    document_label: str | None = None
    page_number: int | None = None
    source_kind: str | None = None

    @field_validator("quote", "document_url", "document_label", "source_kind", mode="before")
    @classmethod
    def normalize_text(cls, value: Any) -> str | None:
        return clean_text(value)


class SurfaceMeasurement(BaseModel):
    model_config = ConfigDict(extra="ignore")

    measurement_id: str | None = None
    asset_id: str = "asset-main"
    lot_label: str | None = None
    level: str | None = None
    space_label: str
    category: SurfaceCategory = "unknown"
    value_m2: Decimal
    included_in_habitable_sum: bool | None = None
    confidence: float = 0.0
    evidence: SurfaceEvidence = Field(default_factory=SurfaceEvidence)
    extraction_method: str = "llm"

    @field_validator("value_m2", mode="before")
    @classmethod
    def normalize_decimal(cls, value: Any) -> Decimal:
        parsed = _decimal(value)
        if not _is_valid_positive_decimal(parsed, Decimal("10000")):
            raise ValueError("invalid surface measurement")
        return parsed.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    @field_validator("confidence", mode="before")
    @classmethod
    def clamp_confidence(cls, value: Any) -> float:
        try:
            return max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return 0.0

    @field_validator("asset_id", "space_label", "lot_label", "level", "extraction_method", mode="before")
    @classmethod
    def normalize_labels(cls, value: Any) -> str | None:
        return clean_text(value)


class SurfaceCandidate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    candidate_id: str | None = None
    asset_id: str = "asset-main"
    value_m2: Decimal
    kind: SurfaceKind = "unknown"
    scope: Literal["sale", "asset", "lot", "level", "partial", "unknown"] = "unknown"
    is_explicit: bool = True
    unit_as_written: str = "m2"
    confidence: float = 0.0
    evidence: SurfaceEvidence = Field(default_factory=SurfaceEvidence)

    @field_validator("value_m2", mode="before")
    @classmethod
    def normalize_decimal(cls, value: Any) -> Decimal:
        parsed = _decimal(value)
        if not _is_valid_positive_decimal(parsed, Decimal("1000000")):
            raise ValueError("invalid surface candidate")
        return parsed.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    @field_validator("confidence", mode="before")
    @classmethod
    def clamp_confidence(cls, value: Any) -> float:
        try:
            return max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return 0.0

    @field_validator("asset_id", "unit_as_written", mode="before")
    @classmethod
    def normalize_labels(cls, value: Any) -> str | None:
        return clean_text(value)


class ExtractedAsset(BaseModel):
    model_config = ConfigDict(extra="ignore")

    asset_id: str = "asset-main"
    lot_labels: list[str] = Field(default_factory=list)
    property_type: str | None = None
    measurement_completeness: MeasurementCompleteness = "unknown"
    spaces: list[SurfaceMeasurement] = Field(default_factory=list)
    explicit_surfaces: list[SurfaceCandidate] = Field(default_factory=list)

    @field_validator("asset_id", "property_type", mode="before")
    @classmethod
    def normalize_text(cls, value: Any) -> str | None:
        return clean_text(value)

    @field_validator("lot_labels", mode="before")
    @classmethod
    def normalize_lots(cls, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [text for item in value if (text := clean_text(item))]


class SurfaceDerivation(BaseModel):
    model_config = ConfigDict(extra="ignore")

    derivation_id: str
    asset_id: str
    kind: SurfaceKind
    value_m2: Decimal
    operand_measurement_ids: list[str] = Field(default_factory=list)
    formula: str
    validation_status: Literal["verified", "partial", "contradicted", "rejected"]
    confidence: float
    explicit_candidate_id: str | None = None
    difference_m2: Decimal | None = None
    warnings: list[str] = Field(default_factory=list)


class SurfaceReasoningResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: str = SURFACE_REASONING_VERSION
    measurements: list[SurfaceMeasurement] = Field(default_factory=list)
    candidates: list[SurfaceCandidate] = Field(default_factory=list)
    derivations: list[SurfaceDerivation] = Field(default_factory=list)
    selected_derivation_id: str | None = None
    contradictions: list[dict[str, Any]] = Field(default_factory=list)
    rejected_measurements: list[dict[str, Any]] = Field(default_factory=list)

    @property
    def selected(self) -> SurfaceDerivation | None:
        if not self.selected_derivation_id:
            return None
        return next(
            (item for item in self.derivations if item.derivation_id == self.selected_derivation_id),
            None,
        )


_UNIT_PATTERN = r"m\s*(?P<unit>2|²|3|³)\b"
_UNIT_TOKEN_PATTERN = r"m\s*(?:2|²|3|³)\b"
_VALUE_PATTERN = r"(?P<value>[0-9]{1,6}(?:[\s\u00a0][0-9]{3})*(?:[,.][0-9]{1,3})?)"
_VALUE_TOKEN_PATTERN = r"(?:[0-9]{1,6}(?:[\s\u00a0][0-9]{3})*(?:[,.][0-9]{1,3})?)"
_NUMBER_WITH_UNIT_RE = re.compile(rf"{_VALUE_PATTERN}\s*{_UNIT_PATTERN}", re.I)
_EXPLICIT_SURFACE_PATTERNS: tuple[tuple[SurfaceKind, re.Pattern[str]], ...] = (
    (
        "explicit_carrez",
        re.compile(
            rf"(?:surface|superficie)?[^.;:\n]{{0,45}}?(?:loi\s+carrez|carrez)[^.;:\n]{{0,45}}?{_VALUE_TOKEN_PATTERN}\s*{_UNIT_TOKEN_PATTERN}"
            rf"|{_VALUE_TOKEN_PATTERN}\s*{_UNIT_TOKEN_PATTERN}[^.;:\n]{{0,35}}?(?:loi\s+carrez|carrez)",
            re.I,
        ),
    ),
    (
        "explicit_habitable",
        re.compile(
            rf"(?:surface|superficie)\s+(?:approximative\s+)?habitable(?:\s+totale)?(?:\s+[^.;:\n]{{0,25}})?\s*[:=]?\s*"
            rf"{_VALUE_TOKEN_PATTERN}\s*{_UNIT_TOKEN_PATTERN}"
            rf"|{_VALUE_TOKEN_PATTERN}\s*{_UNIT_TOKEN_PATTERN}\s+habitables?",
            re.I,
        ),
    ),
    (
        "explicit_total",
        re.compile(
            rf"(?:surface|superficie)\s+(?:privative\s+|utile\s+|au\s+sol\s+)?totale(?:\s+[^.;:\n]{{0,25}})?\s*[:=]?\s*"
            rf"{_VALUE_TOKEN_PATTERN}\s*{_UNIT_TOKEN_PATTERN}"
            rf"|total\s+(?:mesur[ée]|surface)?[^.;:\n]{{0,25}}?{_VALUE_TOKEN_PATTERN}\s*{_UNIT_TOKEN_PATTERN}",
            re.I,
        ),
    ),
    (
        "explicit_built",
        re.compile(
            rf"(?:appartement|maison|villa|immeuble|b[âa]timent|local|logement)"
            rf"[^.;:\n]{{0,80}}?(?:surface|superficie|d['’]une\s+surface|de)\s+(?:d['’]environ\s+|environ\s+)?"
            rf"{_VALUE_TOKEN_PATTERN}\s*{_UNIT_TOKEN_PATTERN}",
            re.I,
        ),
    ),
)

_SPACE_KEYWORDS: tuple[tuple[str, SurfaceCategory], ...] = (
    (r"salle\s+d['’]eau", "sanitary"),
    (r"salle\s+de\s+bains?", "sanitary"),
    (r"salle\s+[àa]\s+manger", "habitable"),
    (r"pi[eè]ce\s+principale", "habitable"),
    (r"rez[- ]de[- ]chauss[ée]e", "unknown"),
    (r"entr[ée]e", "circulation"),
    (r"d[ée]gagement", "circulation"),
    (r"couloir", "circulation"),
    (r"palier", "circulation"),
    (r"s[ée]jour", "habitable"),
    (r"salon", "habitable"),
    (r"chambres?", "habitable"),
    (r"bureaux?", "habitable"),
    (r"cuisine", "service"),
    (r"cellier", "service"),
    (r"buanderie", "service"),
    (r"dressing", "service"),
    (r"mezzanine", "habitable"),
    (r"toilettes?", "sanitary"),
    (r"w\.?\s*c\.?,?", "sanitary"),
    (r"douche", "sanitary"),
    (r"garage", "annex"),
    (r"caves?", "annex"),
    (r"greniers?", "annex"),
    (r"combles?", "annex"),
    (r"d[ée]pendances?", "annex"),
    (r"box", "annex"),
    (r"parkings?", "annex"),
    (r"stationnements?", "annex"),
    (r"balcons?", "exterior"),
    (r"terrasses?", "exterior"),
    (r"jardins?", "exterior"),
    (r"terrains?", "land"),
    (r"parcelles?", "land"),
)
_SPACE_KEYWORD_RE = re.compile(
    "|".join(f"(?P<k{index}>{pattern})" for index, (pattern, _) in enumerate(_SPACE_KEYWORDS)),
    re.I,
)
_COMPOSITION_RE = re.compile(
    r"\b(?:se\s+compose|compos[ée]\s+de|comprenant|comprend|distribution|d[ée]signation)\b",
    re.I,
)


def extract_surface_facts_from_text(
    text: str | None,
    *,
    document_url: str | None = None,
    document_label: str | None = None,
    page_number: int | None = None,
    source_kind: str = "source_listing",
) -> ExtractedAsset | None:
    """Extract explicit totals and individual room measurements without guessing.

    This parser is intentionally conservative. It only keeps values carrying an
    area unit and a nearby surface/room label. Arithmetic happens later in
    :func:`reason_about_surfaces`.
    """

    raw_text = clean_text(text)
    if not raw_text:
        return None
    evidence_base = {
        "document_url": document_url,
        "document_label": document_label,
        "page_number": page_number,
        "source_kind": source_kind,
    }
    explicit: list[SurfaceCandidate] = []
    explicit_spans: list[tuple[int, int]] = []
    for kind, pattern in _EXPLICIT_SURFACE_PATTERNS:
        for match in pattern.finditer(raw_text):
            value = _match_value(match)
            if not _is_valid_positive_decimal(value, Decimal("1000000")) or _energy_false_positive(
                raw_text, match.start(), match.end()
            ):
                continue
            unit = _match_unit(match)
            quote = _quote(raw_text, match.start(), match.end(), radius=85)
            candidate = SurfaceCandidate(
                candidate_id=_stable_id("candidate", kind, str(value), quote),
                value_m2=value,
                kind=kind,
                scope="asset",
                is_explicit=True,
                unit_as_written=unit,
                confidence=0.96 if unit == "m2" else 0.72,
                evidence=SurfaceEvidence(quote=quote, **evidence_base),
            )
            if _candidate_key(candidate) not in {_candidate_key(item) for item in explicit}:
                explicit.append(candidate)
                explicit_spans.append((match.start(), match.end()))

    measurements: list[SurfaceMeasurement] = []
    occurrence_counts: dict[str, int] = defaultdict(int)
    for match in _NUMBER_WITH_UNIT_RE.finditer(raw_text):
        if any(start <= match.start() and match.end() <= end for start, end in explicit_spans):
            continue
        if _energy_false_positive(raw_text, match.start(), match.end()):
            continue
        value = _decimal(match.group("value"))
        if value is None or value <= 0 or value > Decimal("1000"):
            continue
        left = raw_text[max(0, match.start() - 110) : match.start()]
        keyword_match = _nearest_space_keyword(left)
        if keyword_match is None:
            continue
        label, category = keyword_match
        occurrence_counts[label] += 1
        occurrence = occurrence_counts[label]
        display_label = f"{label} {occurrence}" if occurrence > 1 or _is_plural_label(label) else label
        quote = _quote(raw_text, match.start(), match.end(), radius=75)
        included = category in {"habitable", "circulation", "sanitary", "service"}
        measurement = SurfaceMeasurement(
            measurement_id=_stable_id("measurement", display_label, str(value), str(match.start()), quote),
            asset_id="asset-main",
            space_label=display_label,
            category=category,
            value_m2=value,
            included_in_habitable_sum=included,
            confidence=0.93,
            evidence=SurfaceEvidence(quote=quote, **evidence_base),
            extraction_method="deterministic_regex",
        )
        measurements.append(measurement)

    if not explicit and not measurements:
        return None
    completeness: MeasurementCompleteness = "unknown"
    included_count = sum(item.included_in_habitable_sum is True for item in measurements)
    if included_count >= 3 and _COMPOSITION_RE.search(raw_text):
        completeness = "likely_complete"
    elif included_count >= 2:
        completeness = "partial"
    return ExtractedAsset(
        asset_id="asset-main",
        measurement_completeness=completeness,
        spaces=measurements,
        explicit_surfaces=explicit,
    )


def merge_extracted_assets(assets: list[ExtractedAsset]) -> list[ExtractedAsset]:
    grouped: dict[str, ExtractedAsset] = {}
    for asset in assets:
        target = grouped.get(asset.asset_id)
        if target is None:
            target = asset.model_copy(deep=True)
            grouped[asset.asset_id] = target
            continue
        target.lot_labels = _unique_strings([*target.lot_labels, *asset.lot_labels])
        if not target.property_type:
            target.property_type = asset.property_type
        target.measurement_completeness = _best_completeness(
            target.measurement_completeness,
            asset.measurement_completeness,
        )
        target.spaces = _dedupe_measurements([*target.spaces, *asset.spaces])
        target.explicit_surfaces = _dedupe_candidates([*target.explicit_surfaces, *asset.explicit_surfaces])
    return list(grouped.values())


def reason_about_surfaces(
    assets: list[ExtractedAsset],
    *,
    context: str = "",
    property_type: str | None = None,
) -> SurfaceReasoningResult:
    result = SurfaceReasoningResult()
    context_normalized = _normalized_for_evidence(context)
    validated_assets: list[ExtractedAsset] = []
    for asset in merge_extracted_assets(assets):
        valid_measurements: list[SurfaceMeasurement] = []
        for measurement in asset.spaces:
            measurement = _prepare_measurement(measurement, asset.asset_id)
            reason = _measurement_rejection_reason(measurement, context_normalized)
            if reason:
                result.rejected_measurements.append(
                    {"measurement": measurement.model_dump(mode="json"), "reason": reason}
                )
                continue
            valid_measurements.append(measurement)
        valid_candidates = []
        for candidate in asset.explicit_surfaces:
            candidate = _prepare_candidate(candidate, asset.asset_id)
            if _candidate_is_supported(candidate, context_normalized):
                valid_candidates.append(candidate)
        validated_assets.append(
            asset.model_copy(
                update={
                    "spaces": _dedupe_measurements(valid_measurements),
                    "explicit_surfaces": _dedupe_candidates(valid_candidates),
                }
            )
        )

    result.measurements = [measurement for asset in validated_assets for measurement in asset.spaces]
    result.candidates = [candidate for asset in validated_assets for candidate in asset.explicit_surfaces]

    asset_derivations: list[SurfaceDerivation] = []
    for asset in validated_assets:
        derivations, contradictions = _derive_asset_surface(asset, property_type=property_type)
        asset_derivations.extend(derivations)
        result.contradictions.extend(contradictions)
    result.derivations = asset_derivations

    selected = _select_best_derivation(asset_derivations, property_type=property_type)
    sale_total = _derive_sale_total(validated_assets, asset_derivations)
    if sale_total is not None:
        result.derivations.append(sale_total)
        selected = sale_total
    result.selected_derivation_id = selected.derivation_id if selected else None
    return result


def apply_surface_reasoning_to_sale(
    sale: AuctionSale,
    assets: list[ExtractedAsset],
    *,
    context: str,
    source: str,
) -> SurfaceReasoningResult:
    result = reason_about_surfaces(assets, context=context, property_type=sale.property_type)
    sale.raw_payload["surface_analysis"] = result.model_dump(mode="json")
    selected = result.selected
    if selected is None or selected.validation_status not in {"verified", "partial"}:
        return result

    explicit_candidate = next(
        (item for item in result.candidates if item.candidate_id == selected.explicit_candidate_id),
        None,
    )
    should_apply = _should_apply_selected_surface(sale, selected, explicit_candidate)
    if not should_apply:
        return result

    value = selected.value_m2.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if selected.kind == "explicit_carrez":
        sale.carrez_surface_m2 = value
        sale.surface_m2 = value
    elif selected.kind in {"explicit_habitable", "calculated_room_sum", "calculated_sale_sum"}:
        sale.habitable_surface_m2 = value
        sale.surface_m2 = value
    elif selected.kind in {"explicit_total", "explicit_built"}:
        sale.surface_m2 = value
        if sale.property_type == "house":
            sale.habitable_surface_m2 = value
    elif selected.kind == "land":
        sale.land_surface_m2 = value

    sale.surface_scope = "partial" if selected.validation_status == "partial" else "total"
    sale.surface_source = source
    sale.surface_confidence = Decimal(str(selected.confidence)).quantize(Decimal("0.01"))
    sale.surface_evidence = _surface_evidence_text(selected, result)
    if selected.kind.startswith("calculated_"):
        _add_quality_flag(sale, "surface_calculated_from_rooms")
    if selected.warnings:
        _add_quality_flag(sale, "surface_unit_or_consistency_warning")
    if result.contradictions:
        _add_quality_flag(sale, "surface_contradiction")
    return result


def extract_and_apply_deterministic_surface_reasoning(sale: AuctionSale, context: str) -> SurfaceReasoningResult | None:
    asset = extract_surface_facts_from_text(context)
    if asset is None:
        return None
    return apply_surface_reasoning_to_sale(
        sale,
        [asset],
        context=context,
        source="deterministic_surface_reasoning",
    )


def _derive_asset_surface(
    asset: ExtractedAsset,
    *,
    property_type: str | None,
) -> tuple[list[SurfaceDerivation], list[dict[str, Any]]]:
    derivations: list[SurfaceDerivation] = []
    contradictions: list[dict[str, Any]] = []
    room_measurements = _coherent_measurement_set(asset.spaces)
    included = [item for item in room_measurements if _measurement_is_included(item)]
    room_sum = sum((item.value_m2 for item in included), Decimal("0"))
    explicit = sorted(
        asset.explicit_surfaces,
        key=lambda item: _candidate_rank(item, property_type=property_type),
        reverse=True,
    )
    best_explicit = explicit[0] if explicit else None

    if best_explicit is not None:
        warnings: list[str] = []
        confidence = best_explicit.confidence
        difference: Decimal | None = None
        if room_sum > 0 and len(included) >= 2:
            difference = abs(best_explicit.value_m2 - room_sum)
            tolerance = max(SURFACE_TOLERANCE_ABSOLUTE_M2, best_explicit.value_m2 * SURFACE_TOLERANCE_RELATIVE)
            if difference <= tolerance:
                confidence = max(confidence, 0.97)
                if best_explicit.unit_as_written == "m3":
                    warnings.append("unit_m3_reconciled_as_area_from_room_sum")
            else:
                contradictions.append(
                    {
                        "asset_id": asset.asset_id,
                        "kind": "explicit_total_vs_room_sum",
                        "explicit_value_m2": str(best_explicit.value_m2),
                        "calculated_value_m2": str(room_sum.quantize(Decimal('0.01'))),
                        "difference_m2": str(difference.quantize(Decimal('0.01'))),
                    }
                )
                warnings.append("room_sum_does_not_match_explicit_total")
        status: Literal["verified", "partial", "contradicted", "rejected"] = (
            "contradicted" if contradictions and best_explicit.kind == "unknown" else "verified"
        )
        derivations.append(
            SurfaceDerivation(
                derivation_id=_stable_id("derivation", asset.asset_id, best_explicit.candidate_id or "explicit"),
                asset_id=asset.asset_id,
                kind=best_explicit.kind,
                value_m2=best_explicit.value_m2,
                operand_measurement_ids=[item.measurement_id or "" for item in included],
                formula="explicit surface stated in source",
                validation_status=status,
                confidence=confidence,
                explicit_candidate_id=best_explicit.candidate_id,
                difference_m2=difference,
                warnings=warnings,
            )
        )

    if len(included) >= 2 and room_sum >= Decimal("9"):
        status = "verified" if asset.measurement_completeness in {"complete", "likely_complete"} else "partial"
        confidence = 0.88 if status == "verified" else 0.68
        formula = " + ".join(str(item.value_m2.normalize()) for item in included)
        derivations.append(
            SurfaceDerivation(
                derivation_id=_stable_id("derivation", asset.asset_id, formula),
                asset_id=asset.asset_id,
                kind="calculated_room_sum",
                value_m2=room_sum.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
                operand_measurement_ids=[item.measurement_id or "" for item in included],
                formula=f"{formula} = {room_sum.quantize(Decimal('0.01'))} m²",
                validation_status=status,
                confidence=confidence,
                warnings=[] if status == "verified" else ["room_measurement_set_may_be_incomplete"],
            )
        )
    return derivations, contradictions


def _derive_sale_total(
    assets: list[ExtractedAsset],
    derivations: list[SurfaceDerivation],
) -> SurfaceDerivation | None:
    if len(assets) < 2:
        return None
    selected_by_asset: list[SurfaceDerivation] = []
    for asset in assets:
        candidate = _select_best_derivation(
            [item for item in derivations if item.asset_id == asset.asset_id],
            property_type=asset.property_type,
        )
        if candidate is None or candidate.validation_status != "verified":
            return None
        selected_by_asset.append(candidate)
    value = sum((item.value_m2 for item in selected_by_asset), Decimal("0"))
    if value <= 0:
        return None
    return SurfaceDerivation(
        derivation_id=_stable_id("sale-total", *(item.derivation_id for item in selected_by_asset)),
        asset_id="sale-total",
        kind="calculated_sale_sum",
        value_m2=value.quantize(Decimal("0.01")),
        operand_measurement_ids=[
            operand
            for item in selected_by_asset
            for operand in item.operand_measurement_ids
        ],
        formula=" + ".join(str(item.value_m2.normalize()) for item in selected_by_asset)
        + f" = {value.quantize(Decimal('0.01'))} m²",
        validation_status="verified",
        confidence=min(item.confidence for item in selected_by_asset) * 0.96,
        warnings=["aggregate_for_all_assets_in_auction_perimeter"],
    )


def _select_best_derivation(
    derivations: list[SurfaceDerivation],
    *,
    property_type: str | None,
) -> SurfaceDerivation | None:
    if not derivations:
        return None
    kind_rank = {
        "explicit_carrez": 110 if property_type == "apartment" else 95,
        "explicit_habitable": 110 if property_type == "house" else 100,
        "explicit_total": 92,
        "explicit_built": 88,
        "calculated_room_sum": 80,
        "calculated_sale_sum": 85,
        "land": 105 if property_type == "land" else 30,
        "annex": 10,
        "unknown": 0,
    }
    status_rank = {"verified": 30, "partial": 5, "contradicted": -20, "rejected": -100}
    return max(
        derivations,
        key=lambda item: (
            status_rank[item.validation_status] + kind_rank[item.kind],
            item.confidence,
            item.value_m2,
        ),
    )


def _should_apply_selected_surface(
    sale: AuctionSale,
    selected: SurfaceDerivation,
    candidate: SurfaceCandidate | None,
) -> bool:
    if selected.validation_status == "partial":
        return sale.surface_m2 is None and sale.habitable_surface_m2 is None and sale.carrez_surface_m2 is None
    current = sale.app_surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2 or sale.surface_m2
    if current is None:
        return True
    if current == selected.value_m2:
        # Keep the richer provenance already assigned by a source/PDF parser.
        # The structured analysis is still persisted, but an equal value must
        # not replace its document label, page or extraction source.
        return not bool(sale.surface_source and sale.surface_evidence)
    if sale.surface_scope in {"room", "annex", "room_or_annex", "partial", "unknown"}:
        return True
    if selected.kind in {"explicit_carrez", "explicit_habitable", "explicit_total"}:
        return True
    if current < Decimal("20") <= selected.value_m2:
        return True
    return bool(candidate and candidate.confidence >= 0.95 and (sale.surface_confidence or Decimal("0")) < Decimal("0.9"))


def _surface_evidence_text(selected: SurfaceDerivation, result: SurfaceReasoningResult) -> str:
    if selected.explicit_candidate_id:
        candidate = next(
            (item for item in result.candidates if item.candidate_id == selected.explicit_candidate_id),
            None,
        )
        if candidate and candidate.evidence.quote:
            return candidate.evidence.quote[:800]
    operands = {
        item.measurement_id: item
        for item in result.measurements
        if item.measurement_id in selected.operand_measurement_ids
    }
    labels = [f"{item.space_label}: {item.value_m2.normalize()} m²" for item in operands.values()]
    return ("Surface calculée: " + " + ".join(labels) + f" = {selected.value_m2.normalize()} m²")[:800]


def _measurement_rejection_reason(measurement: SurfaceMeasurement, context_normalized: str) -> str | None:
    quote = measurement.evidence.quote
    if not quote:
        return "missing_evidence_quote"
    if measurement.extraction_method != "deterministic_regex" and context_normalized:
        normalized_quote = _normalized_for_evidence(quote)
        if normalized_quote not in context_normalized:
            return "evidence_quote_not_found"
    if not _quote_contains_value(quote, measurement.value_m2):
        return "value_not_present_in_evidence"
    if measurement.category == "unknown" and measurement.included_in_habitable_sum:
        return "unknown_category_cannot_be_included"
    return None


def _candidate_is_supported(candidate: SurfaceCandidate, context_normalized: str) -> bool:
    quote = candidate.evidence.quote
    if not quote or not _quote_contains_value(quote, candidate.value_m2):
        return False
    if context_normalized and _normalized_for_evidence(quote) not in context_normalized:
        return False
    if candidate.unit_as_written == "m3" and candidate.kind not in {
        "explicit_carrez",
        "explicit_habitable",
        "explicit_total",
    }:
        return False
    return True


def _prepare_measurement(measurement: SurfaceMeasurement, asset_id: str) -> SurfaceMeasurement:
    if measurement.asset_id != asset_id:
        measurement = measurement.model_copy(update={"asset_id": asset_id})
    if measurement.measurement_id:
        return measurement
    return measurement.model_copy(
        update={
            "measurement_id": _stable_id(
                "measurement",
                asset_id,
                measurement.space_label,
                str(measurement.value_m2),
                measurement.evidence.quote or "",
            )
        }
    )


def _prepare_candidate(candidate: SurfaceCandidate, asset_id: str) -> SurfaceCandidate:
    updates: dict[str, Any] = {}
    if candidate.asset_id != asset_id:
        updates["asset_id"] = asset_id
    if not candidate.candidate_id:
        updates["candidate_id"] = _stable_id(
            "candidate",
            asset_id,
            candidate.kind,
            str(candidate.value_m2),
            candidate.evidence.quote or "",
        )
    return candidate.model_copy(update=updates) if updates else candidate


def _coherent_measurement_set(measurements: list[SurfaceMeasurement]) -> list[SurfaceMeasurement]:
    """Use one coherent document set instead of summing repeated rooms across PDFs."""
    if not measurements:
        return []
    groups: dict[str, list[SurfaceMeasurement]] = defaultdict(list)
    for item in measurements:
        evidence = item.evidence
        key = evidence.document_url or evidence.document_label or evidence.source_kind or "unknown"
        groups[key].append(item)
    return max(
        groups.values(),
        key=lambda group: (
            sum(_measurement_is_included(item) for item in group),
            sum((item.value_m2 for item in group if _measurement_is_included(item)), Decimal("0")),
        ),
    )


def _measurement_is_included(measurement: SurfaceMeasurement) -> bool:
    if measurement.included_in_habitable_sum is not None:
        return measurement.included_in_habitable_sum
    return measurement.category in {"habitable", "circulation", "sanitary", "service"}


def _candidate_rank(candidate: SurfaceCandidate, *, property_type: str | None) -> tuple[int, float]:
    rank = {
        "explicit_carrez": 100 if property_type == "apartment" else 85,
        "explicit_habitable": 100 if property_type == "house" else 92,
        "explicit_total": 82,
        "explicit_built": 78,
        "land": 100 if property_type == "land" else 20,
        "annex": 5,
        "calculated_room_sum": 0,
        "calculated_sale_sum": 0,
        "unknown": 0,
    }[candidate.kind]
    return rank, candidate.confidence


def _dedupe_measurements(measurements: list[SurfaceMeasurement]) -> list[SurfaceMeasurement]:
    unique: list[SurfaceMeasurement] = []
    seen_ids: set[str] = set()
    for item in measurements:
        prepared = _prepare_measurement(item, item.asset_id)
        key = prepared.measurement_id or ""
        if key in seen_ids:
            continue
        seen_ids.add(key)
        unique.append(prepared)
    return unique


def _dedupe_candidates(candidates: list[SurfaceCandidate]) -> list[SurfaceCandidate]:
    unique: list[SurfaceCandidate] = []
    seen: set[tuple[str, str, Decimal, str]] = set()
    for item in candidates:
        key = _candidate_key(item)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def _candidate_key(candidate: SurfaceCandidate) -> tuple[str, str, Decimal, str]:
    return (
        candidate.asset_id,
        candidate.kind,
        candidate.value_m2,
        _normalized_for_evidence(candidate.evidence.quote or "")[:160],
    )


def _nearest_space_keyword(left_context: str) -> tuple[str, SurfaceCategory] | None:
    matches = list(_SPACE_KEYWORD_RE.finditer(left_context))
    if not matches:
        return None
    match = matches[-1]
    group_name = next((name for name, value in match.groupdict().items() if value is not None), None)
    if group_name is None:
        return None
    index = int(group_name[1:])
    label = clean_text(match.group(0).lower()) or "pièce"
    return label, _SPACE_KEYWORDS[index][1]


def _match_value(match: re.Match[str]) -> Decimal | None:
    values = list(_NUMBER_WITH_UNIT_RE.finditer(match.group(0)))
    return _decimal(values[-1].group("value")) if values else None


def _match_unit(match: re.Match[str]) -> str:
    units = list(_NUMBER_WITH_UNIT_RE.finditer(match.group(0)))
    unit = units[-1].group("unit") if units else "2"
    return "m3" if unit in {"3", "³"} else "m2"


def _quote(text: str, start: int, end: int, *, radius: int) -> str:
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    return clean_text(text[left:right]) or text[start:end]


def _quote_contains_value(quote: str, value: Decimal) -> bool:
    plain = format(value, "f")
    compact = plain.rstrip("0").rstrip(".") if "." in plain else plain
    variants = {
        str(value),
        str(value.normalize()),
        plain,
        compact,
        str(value).replace(".", ","),
        str(value.normalize()).replace(".", ","),
        plain.replace(".", ","),
        compact.replace(".", ","),
    }
    normalized_quote = quote.replace("\u00a0", " ")
    return any(variant in normalized_quote for variant in variants)


def _normalized_for_evidence(value: str) -> str:
    text = unicodedata.normalize("NFKC", value).lower()
    return re.sub(r"\s+", " ", text).strip()


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    text = str(value).replace("\u00a0", " ").replace(" ", "").replace(",", ".")
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return None


def _is_valid_positive_decimal(value: Decimal | None, maximum: Decimal) -> bool:
    return value is not None and value.is_finite() and Decimal("0") < value <= maximum


def _energy_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 35) : min(len(text), end + 45)]
    return bool(re.search(r"kwh|kg\s*co2|m(?:2|²)\s*/\s*an|consommation", context, re.I))


def _stable_id(*parts: str) -> str:
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:24]
    return digest


def _is_plural_label(label: str) -> bool:
    return bool(re.search(r"(?:chambres|bureaux|toilettes)$", label, re.I))


def _best_completeness(left: MeasurementCompleteness, right: MeasurementCompleteness) -> MeasurementCompleteness:
    rank = {"unknown": 0, "partial": 1, "likely_complete": 2, "complete": 3}
    return left if rank[left] >= rank[right] else right


def _unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        normalized = clean_text(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(normalized)
    return unique


def _add_quality_flag(sale: AuctionSale, flag: str) -> None:
    if flag not in sale.quality_flags:
        sale.quality_flags.append(flag)
