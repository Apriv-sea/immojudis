from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable

from src.enrichment.extract_structured import LLMEnrichmentStats
from src.models import AuctionSale
from src.pdf_enrichment import PdfEnrichmentStats

SourceCheck = Callable[[AuctionSale], bool]

SOURCE_QUALITY_CHECKS: tuple[tuple[str, SourceCheck], ...] = (
    ("with_tribunal_pct", lambda sale: bool(sale.tribunal)),
    ("with_gps_pct", lambda sale: sale.latitude is not None and sale.longitude is not None),
    ("with_surface_pct", lambda sale: sale.surface_m2 is not None),
    ("with_app_surface_pct", lambda sale: sale.app_surface_m2 is not None),
    ("with_rooms_count_pct", lambda sale: sale.rooms_count is not None),
    ("with_bedrooms_count_pct", lambda sale: sale.bedrooms_count is not None),
    ("with_occupancy_status_pct", lambda sale: bool(sale.occupancy_status)),
    ("with_energy_diagnostics_pct", lambda sale: _has_energy_diagnostics(sale)),
    ("with_documents_pct", lambda sale: bool(sale.documents)),
    ("with_visit_dates_pct", lambda sale: bool(sale.visit_dates)),
    ("with_starting_price_pct", lambda sale: sale.starting_price_eur is not None),
    ("with_sale_date_pct", lambda sale: sale.sale_date is not None),
    ("with_lawyer_contact_pct", lambda sale: bool(sale.lawyer_contact)),
    ("with_source_blocks_pct", lambda sale: bool(sale.raw_payload.get("source_blocks"))),
)
CompletenessProfile = dict[str, tuple[str, ...]]

COMPLETENESS_FIELD_CHECKS: dict[str, SourceCheck] = {
    "source_url": lambda sale: bool(sale.source_url),
    "source_name": lambda sale: bool(sale.source_name),
    "title_or_description": lambda sale: bool(sale.title or sale.description),
    "property_type": lambda sale: bool(sale.property_type and sale.property_type != "other"),
    "location": lambda sale: bool((sale.city and sale.department) or sale.postal_code or sale.address),
    "surface": lambda sale: any(
        value is not None
        for value in (
            sale.surface_m2,
            sale.habitable_surface_m2,
            sale.carrez_surface_m2,
            sale.land_surface_m2,
            sale.app_surface_m2,
        )
    ),
    "starting_price": lambda sale: sale.starting_price_eur is not None,
    "sale_date": lambda sale: sale.sale_date is not None,
    "raw_text": lambda sale: bool(sale.raw_text),
    "source_blocks": lambda sale: bool(sale.raw_payload.get("source_blocks")),
    "tribunal": lambda sale: bool(sale.tribunal),
    "documents": lambda sale: bool(sale.documents),
    "visit_dates": lambda sale: bool(sale.visit_dates),
    "lawyer_contact": lambda sale: bool(sale.lawyer_name or sale.lawyer_contact),
    "gps": lambda sale: sale.latitude is not None and sale.longitude is not None,
    "occupancy_status": lambda sale: bool(sale.occupancy_status),
    "rooms_count": lambda sale: sale.rooms_count is not None,
    "images": lambda sale: bool(sale.raw_payload.get("raw_image_url") or sale.raw_payload.get("source_images")),
    "energy_diagnostics": lambda sale: _has_energy_diagnostics(sale),
}

DEFAULT_REQUIRED_COMPLETENESS_FIELDS = (
    "source_url",
    "source_name",
    "title_or_description",
    "property_type",
    "location",
    "surface",
    "starting_price",
    "sale_date",
    "raw_text",
    "source_blocks",
)
DEFAULT_RECOMMENDED_COMPLETENESS_FIELDS = (
    "tribunal",
    "documents",
    "visit_dates",
    "lawyer_contact",
    "gps",
    "occupancy_status",
    "rooms_count",
    "images",
)
SOURCE_COMPLETENESS_PROFILES: dict[str, CompletenessProfile] = {
    "avoventes": {
        "required": DEFAULT_REQUIRED_COMPLETENESS_FIELDS,
        "recommended": ("documents", "visit_dates", "lawyer_contact", "gps", "occupancy_status", "rooms_count", "images"),
    },
    "licitor": {
        "required": tuple(field for field in DEFAULT_REQUIRED_COMPLETENESS_FIELDS if field != "surface"),
        "recommended": ("surface", "tribunal", "visit_dates", "lawyer_contact", "gps", "occupancy_status", "rooms_count"),
    },
    "petites_affiches": {
        "required": tuple(field for field in DEFAULT_REQUIRED_COMPLETENESS_FIELDS if field != "surface"),
        "recommended": ("surface", "documents", "visit_dates", "gps", "rooms_count"),
    },
    "info_encheres": {
        "required": tuple(field for field in DEFAULT_REQUIRED_COMPLETENESS_FIELDS if field != "surface"),
        "recommended": ("surface", "documents", "visit_dates", "gps", "occupancy_status", "rooms_count", "images"),
    },
    "encheres_publiques": {
        "required": tuple(field for field in DEFAULT_REQUIRED_COMPLETENESS_FIELDS if field != "surface"),
        "recommended": ("surface", "visit_dates", "gps", "occupancy_status", "rooms_count"),
    },
    "vench": {
        "required": DEFAULT_REQUIRED_COMPLETENESS_FIELDS,
        "recommended": ("tribunal", "visit_dates", "gps", "occupancy_status", "rooms_count", "images"),
    },
    "agrasc": {
        "required": DEFAULT_REQUIRED_COMPLETENESS_FIELDS,
        "recommended": ("documents", "gps", "occupancy_status", "images"),
    },
    "cessions_etat": {
        "required": tuple(
            field
            for field in DEFAULT_REQUIRED_COMPLETENESS_FIELDS
            if field not in {"starting_price", "sale_date"}
        ),
        "recommended": ("starting_price", "sale_date", "documents", "visit_dates", "gps", "images"),
    },
    "notaires": {
        "required": DEFAULT_REQUIRED_COMPLETENESS_FIELDS,
        "recommended": ("visit_dates", "lawyer_contact", "gps", "occupancy_status", "rooms_count", "images"),
    },
    "encheres_immobilieres": {
        "required": DEFAULT_REQUIRED_COMPLETENESS_FIELDS,
        "recommended": ("visit_dates", "lawyer_contact", "gps", "occupancy_status", "rooms_count", "images"),
    },
}


def build_quality_report(
    sales: list[AuctionSale],
    pdf_stats: PdfEnrichmentStats | None = None,
    llm_stats: LLMEnrichmentStats | None = None,
) -> dict[str, float | int]:
    total = len(sales)
    pdf_stats = pdf_stats or PdfEnrichmentStats()
    llm_stats = llm_stats or LLMEnrichmentStats()
    return {
        "total": total,
        "with_tribunal_pct": _pct(sum(bool(sale.tribunal) for sale in sales), total),
        "with_gps_pct": _pct(
            sum(sale.latitude is not None and sale.longitude is not None for sale in sales),
            total,
        ),
        "with_surface_pct": _pct(sum(sale.surface_m2 is not None for sale in sales), total),
        "with_app_surface_pct": _pct(sum(sale.app_surface_m2 is not None for sale in sales), total),
        "with_rooms_count_pct": _pct(sum(sale.rooms_count is not None for sale in sales), total),
        "with_bedrooms_count_pct": _pct(sum(sale.bedrooms_count is not None for sale in sales), total),
        "with_occupancy_status_pct": _pct(sum(sale.occupancy_status not in (None, "", "unknown") for sale in sales), total),
        "with_energy_diagnostics_pct": _pct(sum(_has_energy_diagnostics(sale) for sale in sales), total),
        "with_raw_text_enriched_pct": _pct(
            sum("PDF TEXT ENRICHMENT" in (sale.raw_text or "") for sale in sales),
            total,
        ),
        "with_documents_pct": _pct(sum(bool(sale.documents) for sale in sales), total),
        "with_visit_dates_pct": _pct(sum(bool(sale.visit_dates) for sale in sales), total),
        "pdfs_downloaded": pdf_stats.downloaded,
        "pdf_errors": pdf_stats.errors,
        "pdf_document_cache_hits": pdf_stats.document_cache_hits,
        "pdf_document_cache_misses": pdf_stats.document_cache_misses,
        "pdf_documents_processed": pdf_stats.documents_processed,
        "llm_analyzed": llm_stats.analyzed,
        "llm_valid_json": llm_stats.valid_json,
        "llm_display_accepted": sum(s.raw_payload.get("llm_display_status") == "accepted" for s in sales),
        "llm_display_fallback": sum(s.raw_payload.get("llm_display_status") == "fallback" for s in sales),
        "llm_display_rejected": sum(s.raw_payload.get("llm_display_status") == "rejected" for s in sales),

        "llm_fact_chunks_analyzed": llm_stats.fact_chunks_analyzed,
        "llm_structured_surface_verified": llm_stats.structured_surface_verified,
        "llm_calculated_surface_verified": llm_stats.calculated_surface_verified,
        "with_explicit_surface_pct": _pct(
            sum(_surface_analysis_kind(sale).startswith("explicit_") for sale in sales),
            total,
        ),
        "with_calculated_surface_pct": _pct(
            sum(_surface_analysis_kind(sale).startswith("calculated_") for sale in sales),
            total,
        ),
        "with_surface_contradiction_pct": _pct(
            sum(bool(_surface_analysis(sale).get("contradictions")) for sale in sales),
            total,
        ),
        "llm_surface_detected_pct": _pct(llm_stats.surface_detected, llm_stats.valid_json),
        "llm_surface_extracted_pct": _pct(llm_stats.surface_extracted, llm_stats.valid_json),
        "llm_rooms_detected_pct": _pct(llm_stats.rooms_detected, llm_stats.valid_json),
        "llm_rooms_extracted_pct": _pct(llm_stats.rooms_extracted, llm_stats.valid_json),
        "llm_bedrooms_detected_pct": _pct(llm_stats.bedrooms_detected, llm_stats.valid_json),
        "llm_bedrooms_extracted_pct": _pct(llm_stats.bedrooms_extracted, llm_stats.valid_json),
        "llm_occupancy_detected_pct": _pct(llm_stats.occupancy_detected, llm_stats.valid_json),
        "llm_occupancy_extracted_pct": _pct(llm_stats.occupancy_extracted, llm_stats.valid_json),
        "llm_risks_detected_pct": _pct(llm_stats.risks_detected, llm_stats.valid_json),
        "llm_errors": llm_stats.errors,
        "llm_unavailable": int(llm_stats.unavailable),
    }


def _surface_analysis(sale: AuctionSale) -> dict[str, object]:
    payload = sale.raw_payload.get("surface_analysis") if isinstance(sale.raw_payload, dict) else None
    return payload if isinstance(payload, dict) else {}


def _surface_analysis_kind(sale: AuctionSale) -> str:
    analysis = _surface_analysis(sale)
    selected_id = analysis.get("selected_derivation_id")
    derivations = analysis.get("derivations")
    if not isinstance(derivations, list):
        return ""
    for derivation in derivations:
        if isinstance(derivation, dict) and derivation.get("derivation_id") == selected_id:
            return str(derivation.get("kind") or "")
    return ""


def build_source_quality_report(sales: list[AuctionSale]) -> dict[str, dict[str, float | int]]:
    grouped: dict[str, list[AuctionSale]] = defaultdict(list)
    for sale in sales:
        grouped[sale.source_name].append(sale)

    report: dict[str, dict[str, float | int]] = {}
    for source_name, source_sales in sorted(grouped.items()):
        total = len(source_sales)
        source_report: dict[str, float | int] = {"total": total}
        for key, check in SOURCE_QUALITY_CHECKS:
            source_report[key] = _pct(sum(check(sale) for sale in source_sales), total)
        report[source_name] = source_report
    return report


def sale_extraction_gaps(sale: AuctionSale) -> dict[str, object]:
    profile = SOURCE_COMPLETENESS_PROFILES.get(
        sale.source_name,
        {
            "required": DEFAULT_REQUIRED_COMPLETENESS_FIELDS,
            "recommended": DEFAULT_RECOMMENDED_COMPLETENESS_FIELDS,
        },
    )
    required_missing = _missing_completeness_fields(sale, _applicable_completeness_fields(sale, profile["required"]))
    recommended_missing = _missing_completeness_fields(
        sale,
        _applicable_completeness_fields(sale, profile["recommended"]),
    )
    return {
        "source_name": sale.source_name,
        "source_url": sale.source_url,
        "external_id": sale.external_id,
        "required_missing": required_missing,
        "recommended_missing": recommended_missing,
    }


def build_extraction_gap_report(sales: list[AuctionSale]) -> dict[str, object]:
    source_totals: dict[str, int] = defaultdict(int)
    source_required_gap_sales: dict[str, int] = defaultdict(int)
    source_recommended_gap_sales: dict[str, int] = defaultdict(int)
    source_required_missing: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    source_recommended_missing: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    sale_gaps: list[dict[str, object]] = []

    for sale in sales:
        source_name = sale.source_name
        source_totals[source_name] += 1
        gaps = sale_extraction_gaps(sale)
        required_missing = gaps["required_missing"]
        recommended_missing = gaps["recommended_missing"]
        if required_missing or recommended_missing:
            sale_gaps.append(gaps)
        if required_missing:
            source_required_gap_sales[source_name] += 1
            for field in required_missing:
                source_required_missing[source_name][field] += 1
        if recommended_missing:
            source_recommended_gap_sales[source_name] += 1
            for field in recommended_missing:
                source_recommended_missing[source_name][field] += 1

    sources: dict[str, dict[str, object]] = {}
    for source_name in sorted(source_totals):
        total = source_totals[source_name]
        sources[source_name] = {
            "total": total,
            "required_gap_sales": source_required_gap_sales[source_name],
            "required_gap_pct": _pct(source_required_gap_sales[source_name], total),
            "recommended_gap_sales": source_recommended_gap_sales[source_name],
            "recommended_gap_pct": _pct(source_recommended_gap_sales[source_name], total),
            "required_missing": dict(sorted(source_required_missing[source_name].items())),
            "recommended_missing": dict(sorted(source_recommended_missing[source_name].items())),
        }

    required_gap_sales = sum(1 for gap in sale_gaps if gap["required_missing"])
    recommended_gap_sales = sum(1 for gap in sale_gaps if gap["recommended_missing"])
    return {
        "total": len(sales),
        "required_gap_sales": required_gap_sales,
        "required_gap_pct": _pct(required_gap_sales, len(sales)),
        "recommended_gap_sales": recommended_gap_sales,
        "recommended_gap_pct": _pct(recommended_gap_sales, len(sales)),
        "sources": sources,
        "sale_gaps": sale_gaps,
    }


def format_extraction_gap_report(report: dict[str, object], max_sale_gaps: int = 8) -> list[str]:
    lines = [
        f"- extraction_gap_total: {report['total']}",
        f"- extraction_required_gap_sales: {report['required_gap_sales']} ({report['required_gap_pct']}%)",
        f"- extraction_recommended_gap_sales: {report['recommended_gap_sales']} ({report['recommended_gap_pct']}%)",
    ]
    sources = report.get("sources") if isinstance(report.get("sources"), dict) else {}
    for source_name, raw_source in sources.items():
        if not isinstance(raw_source, dict):
            continue
        lines.append(
            "- extraction_source_"
            f"{source_name}: required={raw_source['required_gap_sales']}/{raw_source['total']} "
            f"recommended={raw_source['recommended_gap_sales']}/{raw_source['total']}"
        )
        required_missing = _format_missing_counts(raw_source.get("required_missing"))
        recommended_missing = _format_missing_counts(raw_source.get("recommended_missing"))
        if required_missing:
            lines.append(f"- extraction_source_{source_name}_required_missing: {required_missing}")
        if recommended_missing:
            lines.append(f"- extraction_source_{source_name}_recommended_missing: {recommended_missing}")

    sale_gaps = report.get("sale_gaps") if isinstance(report.get("sale_gaps"), list) else []
    for gap in sale_gaps[:max_sale_gaps]:
        if not isinstance(gap, dict):
            continue
        missing = []
        if gap.get("required_missing"):
            missing.append(f"required={','.join(gap['required_missing'])}")
        if gap.get("recommended_missing"):
            missing.append(f"recommended={','.join(gap['recommended_missing'])}")
        lines.append(
            "- extraction_sale_gap: "
            f"{gap.get('source_name')} {gap.get('source_url')} {' '.join(missing)}"
        )
    return lines


def format_quality_report(report: dict[str, float | int]) -> list[str]:
    return [
        f"- quality_total: {report['total']}",
        f"- quality_with_tribunal: {report['with_tribunal_pct']}%",
        f"- quality_with_gps: {report['with_gps_pct']}%",
        f"- quality_with_surface: {report['with_surface_pct']}%",
        f"- quality_with_app_surface: {report['with_app_surface_pct']}%",
        f"- quality_with_rooms_count: {report['with_rooms_count_pct']}%",
        f"- quality_with_bedrooms_count: {report['with_bedrooms_count_pct']}%",
        f"- quality_with_occupancy_status: {report['with_occupancy_status_pct']}%",
        f"- quality_with_energy_diagnostics: {report['with_energy_diagnostics_pct']}%",
        f"- quality_with_raw_text_enriched: {report['with_raw_text_enriched_pct']}%",
        f"- quality_with_documents: {report['with_documents_pct']}%",
        f"- quality_with_visit_dates: {report['with_visit_dates_pct']}%",
        f"- quality_pdfs_downloaded: {report['pdfs_downloaded']}",
        f"- quality_pdf_errors: {report['pdf_errors']}",
        f"- quality_pdf_document_cache_hits: {report['pdf_document_cache_hits']}",
        f"- quality_pdf_document_cache_misses: {report['pdf_document_cache_misses']}",
        f"- quality_pdf_documents_processed: {report['pdf_documents_processed']}",
        f"- quality_llm_analyzed: {report['llm_analyzed']}",
        f"- quality_llm_valid_json: {report['llm_valid_json']}",
        f"- quality_llm_display_accepted: {report.get('llm_display_accepted', 0)}",
        f"- quality_llm_display_fallback: {report.get('llm_display_fallback', 0)}",
        f"- quality_llm_display_rejected: {report.get('llm_display_rejected', 0)}",
        f"- quality_llm_surface_detected: {report['llm_surface_detected_pct']}%",
        f"- quality_llm_surface_extracted: {report['llm_surface_extracted_pct']}%",
        f"- quality_llm_rooms_detected: {report['llm_rooms_detected_pct']}%",
        f"- quality_llm_rooms_extracted: {report['llm_rooms_extracted_pct']}%",
        f"- quality_llm_bedrooms_detected: {report['llm_bedrooms_detected_pct']}%",
        f"- quality_llm_bedrooms_extracted: {report['llm_bedrooms_extracted_pct']}%",
        f"- quality_llm_occupancy_detected: {report['llm_occupancy_detected_pct']}%",
        f"- quality_llm_occupancy_extracted: {report['llm_occupancy_extracted_pct']}%",
        f"- quality_llm_risks_detected: {report['llm_risks_detected_pct']}%",
        f"- quality_llm_errors: {report['llm_errors']}",
        f"- quality_llm_unavailable: {report['llm_unavailable']}",
    ]


def _pct(count: int, total: int) -> float:
    if total == 0:
        return 0.0
    return round(count * 100 / total, 1)


def _has_energy_diagnostics(sale: AuctionSale) -> bool:
    for key in ("source_energy_diagnostics", "pdf_energy_diagnostics"):
        diagnostics = sale.raw_payload.get(key)
        if isinstance(diagnostics, dict) and any(
            diagnostics.get(field)
            for field in (
                "dpe_class",
                "ges_class",
                "energy_consumption_kwh_m2_year",
                "emissions_kg_co2_m2_year",
            )
        ):
            return True
    return False


def _missing_completeness_fields(sale: AuctionSale, fields: tuple[str, ...]) -> list[str]:
    missing: list[str] = []
    for field in fields:
        check = COMPLETENESS_FIELD_CHECKS[field]
        if not check(sale):
            missing.append(field)
    return missing


def _applicable_completeness_fields(sale: AuctionSale, fields: tuple[str, ...]) -> tuple[str, ...]:
    if _is_non_residential_asset(sale):
        fields = tuple(field for field in fields if field != "rooms_count")
    return fields


def _is_non_residential_asset(sale: AuctionSale) -> bool:
    property_type = (sale.property_type or "").lower()
    return property_type in {"building", "land", "commercial", "parking", "mixed"}


def _format_missing_counts(value: object) -> str:
    if not isinstance(value, dict):
        return ""
    return ", ".join(f"{key}={count}" for key, count in value.items() if count)
