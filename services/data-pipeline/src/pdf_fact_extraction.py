from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlparse

from src.config import PDF_TEXTS_DIR
from src.enrichment.surface_reasoning import (
    ExtractedAsset,
    apply_surface_reasoning_to_sale,
    extract_surface_facts_from_text,
)
from src.models import AuctionSale
from src.normalize import (
    SURFACE_VALUE_PATTERN,
    clean_text,
    extract_bedrooms_count_from_text,
    extract_rooms_count_from_text,
    has_rented_occupancy_signal,
    no_lease_occupancy_status,
    normalize_property_type,
    normalize_status,
    parse_french_datetime,
    parse_price,
    parse_surface,
    source_sale_timezone,
    strip_accents,
)
from src.pdf_enrichment import (
    DOCUMENT_FACTS_VERSION,
    _canonical_document_type,
    _normalize_document_classifier_text,
    _sale_storage_id,
)


def enrich_sale_from_pdf_text(sale: AuctionSale, pdf_texts: list[dict[str, object]] | list[str]) -> AuctionSale:
    texts = [str(item.get("text") or "") if isinstance(item, dict) else item for item in pdf_texts]
    combined = "\n\n".join(text for text in texts if text)
    if not combined:
        return sale

    if sale.land_surface_m2 is None:
        land_surface = _extract_land_surface_from_documents(pdf_texts) or _extract_land_surface_with_evidence(combined)
        if land_surface:
            _assign_pdf_land_surface(sale, land_surface)
    if sale.surface_m2 is None:
        surface = _extract_surface_from_documents(pdf_texts) or _extract_surface_with_evidence(combined)
        if surface:
            _assign_pdf_surface(sale, surface)
    if sale.rooms_count is None:
        sale.rooms_count = _extract_rooms_count(combined)
    if sale.bedrooms_count is None:
        sale.bedrooms_count = extract_bedrooms_count_from_text(combined)
    if not sale.occupancy_status:
        sale.occupancy_status = _extract_occupancy_status(combined)
    if sale.sale_date is None:
        timezone = source_sale_timezone(sale.raw_payload)
        sale_date = _extract_sale_date_from_documents(pdf_texts, local_timezone=timezone) or _extract_sale_date_with_evidence(
            combined, local_timezone=timezone,
        )
        if sale_date:
            _assign_pdf_sale_date(sale, sale_date)
    starting_price = _extract_starting_price_from_documents(pdf_texts)
    if starting_price:
        _reconcile_pdf_starting_price(sale, starting_price)
    if not sale.visit_dates:
        visit_dates = _extract_visit_dates_from_documents(pdf_texts) or _extract_visit_dates_with_evidence(combined)
        if visit_dates:
            sale.visit_dates = list(visit_dates["visit_dates"])
            sale.raw_payload["pdf_visit_dates_extraction"] = visit_dates
    if not sale.property_type or sale.property_type == "other":
        sale.property_type = _extract_property_type(combined) or sale.property_type
    if not sale.description:
        sale.description = _extract_description(combined)

    energy_diagnostics = _extract_energy_diagnostics_from_documents(
        pdf_texts
    ) or _extract_energy_diagnostics_with_evidence(combined)
    if energy_diagnostics:
        sale.raw_payload["pdf_energy_diagnostics"] = energy_diagnostics

    risk_notes = _extract_risk_notes(combined)
    if energy_diagnostics:
        risk_notes = _merge_pdf_risk_notes(risk_notes, _energy_diagnostic_risk_note(energy_diagnostics))
    if risk_notes:
        sale.risk_notes = clean_text(" | ".join(filter(None, [sale.risk_notes, risk_notes])))

    surface_assets = _extract_document_surface_assets(pdf_texts)
    if surface_assets:
        apply_surface_reasoning_to_sale(
            sale,
            surface_assets,
            context=combined,
            source="pdf",
        )

    enriched_marker = "\n\n--- PDF TEXT ENRICHMENT ---\n"
    current_raw = sale.raw_text or ""
    if enriched_marker.strip() in current_raw:
        current_raw = current_raw.split(enriched_marker.strip(), 1)[0]
    sale.raw_text = clean_text(f"{current_raw}{enriched_marker}{combined[:15000]}")
    sale.raw_payload["document_facts_version"] = DOCUMENT_FACTS_VERSION
    return sale


def _extract_document_surface_assets(
    pdf_texts: list[dict[str, object]] | list[str],
) -> list[ExtractedAsset]:
    """Preserve document and page provenance for deterministic surface facts."""
    assets: list[ExtractedAsset] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            asset = extract_surface_facts_from_text(str(item), source_kind="pdf")
            if asset is not None:
                assets.append(asset)
            continue
        label = clean_text(item.get("label"))
        document_url = clean_text(item.get("url"))
        pages = item.get("pages")
        if isinstance(pages, list) and pages:
            for page in pages:
                if not isinstance(page, dict):
                    continue
                asset = extract_surface_facts_from_text(
                    clean_text(page.get("text")),
                    document_url=document_url,
                    document_label=label,
                    page_number=page.get("page") if isinstance(page.get("page"), int) else None,
                    source_kind="pdf",
                )
                if asset is not None:
                    assets.append(asset)
            continue
        asset = extract_surface_facts_from_text(
            clean_text(item.get("text")),
            document_url=document_url,
            document_label=label,
            source_kind="pdf",
        )
        if asset is not None:
            assets.append(asset)
    return assets


def _extract_surface_from_documents(pdf_texts: list[dict[str, object]] | list[str]) -> dict[str, object] | None:
    document_surfaces: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        text = str(item.get("text") or "")
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        for surface in _document_surface_candidates(item, text):
            document_surfaces.append(
                {
                    "value": surface["value"],
                    "evidence": str(surface["evidence"]),
                    "label": label,
                    "url": clean_text(item.get("url")) or "",
                    "document_type": document_type,
                    "rank": _surface_document_rank(
                        document_type,
                        str(surface["evidence"]),
                        surface_scope=clean_text(surface.get("surface_scope")),
                    ),
                    "surface_scope": surface.get("surface_scope"),
                    "page_number": surface.get("page_number"),
                    "page_confidence": surface.get("page_confidence"),
                    "extraction_method": surface.get("extraction_method") or item.get("extraction_method"),
                }
            )
    if not document_surfaces:
        return None
    document_surfaces.sort(key=lambda item: int(item["rank"]), reverse=True)
    best = document_surfaces[0]
    evidence = str(best["evidence"])
    label = str(best.get("label") or "")
    if label and label not in evidence:
        evidence = f"{label}: {evidence}"
    return {
        "value": best["value"],
        "evidence": evidence,
        "document_type": str(best.get("document_type") or "pdf"),
        "document_label": label,
        "document_url": str(best.get("url") or ""),
        "page_number": best.get("page_number"),
        "page_confidence": best.get("page_confidence"),
        "extraction_method": best.get("extraction_method"),
        "surface_scope": best.get("surface_scope"),
    }


def _extract_land_surface_from_documents(pdf_texts: list[dict[str, object]] | list[str]) -> dict[str, object] | None:
    document_surfaces: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        text = str(item.get("text") or "")
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        for surface in _document_land_surface_candidates(item, text):
            document_surfaces.append(
                {
                    "value": surface["value"],
                    "evidence": str(surface["evidence"]),
                    "label": label,
                    "url": clean_text(item.get("url")) or "",
                    "document_type": document_type,
                    "rank": _land_surface_document_rank(document_type),
                    "page_number": surface.get("page_number"),
                    "page_confidence": surface.get("page_confidence"),
                    "extraction_method": surface.get("extraction_method") or item.get("extraction_method"),
                }
            )
    if not document_surfaces:
        return None
    document_surfaces.sort(key=lambda item: int(item["rank"]), reverse=True)
    best = document_surfaces[0]
    evidence = str(best["evidence"])
    label = str(best.get("label") or "")
    if label and label not in evidence:
        evidence = f"{label}: {evidence}"
    return {
        "value": best["value"],
        "evidence": evidence,
        "document_type": str(best.get("document_type") or "pdf"),
        "document_label": label,
        "document_url": str(best.get("url") or ""),
        "page_number": best.get("page_number"),
        "page_confidence": best.get("page_confidence"),
        "extraction_method": best.get("extraction_method"),
    }


def _extract_starting_price_from_documents(
    pdf_texts: list[dict[str, object]] | list[str],
) -> dict[str, object] | None:
    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        if document_type in {"diagnostics_techniques", "bail", "cadastre"}:
            continue

        item_candidate_count = len(candidates)
        pages = item.get("pages")
        if isinstance(pages, list):
            for page in pages:
                if not isinstance(page, dict):
                    continue
                extracted = _extract_starting_price_with_evidence(str(page.get("text") or ""))
                if not extracted:
                    continue
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": page.get("page"),
                        "page_confidence": page.get("confidence"),
                        "extraction_method": page.get("method") or item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
        if len(candidates) == item_candidate_count:
            extracted = _extract_starting_price_with_evidence(str(item.get("text") or ""))
            if extracted:
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
    if not candidates:
        return None
    candidates.sort(key=_starting_price_document_rank, reverse=True)
    return candidates[0]


def _starting_price_document_rank(item: dict[str, object]) -> tuple[int, float, int]:
    document_type = str(item.get("document_type") or "")
    document_score = {
        "cahier_conditions_vente": 100,
        "conditions_vente": 95,
        "annonce_vente": 70,
        "pv_huissier": 55,
        "pv_notaire": 55,
        "proces_verbal": 45,
        "pdf": 40,
    }.get(document_type, 30)
    page_confidence = float(item.get("page_confidence") or 0)
    page_number = int(item.get("page_number") or 0)
    return document_score, page_confidence, page_number


def _document_surface_candidates(item: dict[str, object], text: str) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    pages = item.get("pages")
    if isinstance(pages, list):
        for page in pages:
            if not isinstance(page, dict):
                continue
            page_text = str(page.get("text") or "")
            if not page_text:
                continue
            surface = _extract_surface_with_evidence(page_text)
            if surface:
                surface["surface_scope"] = _surface_measurement_scope(
                    f"{page_text}\n{text}",
                    str(surface["evidence"]),
                )
                surface["page_number"] = page.get("page")
                surface["page_confidence"] = page.get("confidence")
                surface["extraction_method"] = page.get("method")
                candidates.append(surface)
    if not candidates:
        surface = _extract_surface_with_evidence(text)
        if surface:
            surface["surface_scope"] = _surface_measurement_scope(text, str(surface["evidence"]))
            candidates.append(surface)
    return candidates


def _document_land_surface_candidates(item: dict[str, object], text: str) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    pages = item.get("pages")
    if isinstance(pages, list):
        for page in pages:
            if not isinstance(page, dict):
                continue
            page_text = str(page.get("text") or "")
            if not page_text:
                continue
            surface = _extract_land_surface_with_evidence(page_text)
            if surface:
                surface["page_number"] = page.get("page")
                surface["page_confidence"] = page.get("confidence")
                surface["extraction_method"] = page.get("method")
                candidates.append(surface)
    if not candidates:
        surface = _extract_land_surface_with_evidence(text)
        if surface:
            candidates.append(surface)
    return candidates


def _extract_energy_diagnostics_from_documents(
    pdf_texts: list[dict[str, object]] | list[str],
) -> dict[str, object] | None:
    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        pages = item.get("pages")
        if isinstance(pages, list):
            for page in pages:
                if not isinstance(page, dict):
                    continue
                page_text = str(page.get("text") or "")
                diagnostic = _extract_energy_diagnostics_with_evidence(page_text)
                if not diagnostic:
                    continue
                diagnostic.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": page.get("page"),
                        "page_confidence": page.get("confidence"),
                        "extraction_method": page.get("method") or item.get("extraction_method"),
                    }
                )
                candidates.append(diagnostic)
        if not candidates:
            diagnostic = _extract_energy_diagnostics_with_evidence(str(item.get("text") or ""))
            if diagnostic:
                diagnostic.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": item.get("extraction_method"),
                    }
                )
                candidates.append(diagnostic)
    if not candidates:
        return None
    candidates.sort(key=_energy_diagnostic_rank, reverse=True)
    return candidates[0]


def _extract_visit_dates_from_documents(pdf_texts: list[dict[str, object]] | list[str]) -> dict[str, object] | None:
    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        pages = item.get("pages")
        if isinstance(pages, list):
            for page in pages:
                if not isinstance(page, dict):
                    continue
                extracted = _extract_visit_dates_with_evidence(str(page.get("text") or ""))
                if not extracted:
                    continue
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": page.get("page"),
                        "page_confidence": page.get("confidence"),
                        "extraction_method": page.get("method") or item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
        if not candidates:
            extracted = _extract_visit_dates_with_evidence(str(item.get("text") or ""))
            if extracted:
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
    if not candidates:
        return None
    candidates.sort(key=lambda item: len(item.get("visit_dates") or []), reverse=True)
    return candidates[0]


def _extract_sale_date_from_documents(
    pdf_texts: list[dict[str, object]] | list[str], *, local_timezone: str = "Europe/Paris",
) -> dict[str, object] | None:
    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        item_candidate_count = len(candidates)
        pages = item.get("pages")
        if isinstance(pages, list):
            for page in pages:
                if not isinstance(page, dict):
                    continue
                extracted = _extract_sale_date_with_evidence(str(page.get("text") or ""), local_timezone=local_timezone)
                if not extracted:
                    continue
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": page.get("page"),
                        "page_confidence": page.get("confidence"),
                        "extraction_method": page.get("method") or item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
        if len(candidates) == item_candidate_count:
            extracted = _extract_sale_date_with_evidence(str(item.get("text") or ""), local_timezone=local_timezone)
            if extracted:
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
    if not candidates:
        return None
    candidates.sort(key=_sale_date_extraction_rank, reverse=True)
    return candidates[0]


def _energy_diagnostic_rank(item: dict[str, object]) -> tuple[int, int]:
    document_type = str(item.get("document_type") or "")
    document_score = {"diagnostics_techniques": 3, "pv_huissier": 2, "pv_notaire": 2, "pdf": 1}.get(document_type, 0)
    field_score = sum(
        1
        for key in ("dpe_class", "ges_class", "energy_consumption_kwh_m2_year", "emissions_kg_co2_m2_year")
        if item.get(key) is not None
    )
    return document_score, field_score


def _surface_document_rank(document_type: str, evidence: str, *, surface_scope: str | None = None) -> int:
    rank = {
        "diagnostics_techniques": 80,
        "pv_huissier": 75,
        "pv_notaire": 70,
        "annonce_vente": 60,
        "cahier_conditions_vente": 55,
        "conditions_vente": 50,
        "pdf": 40,
    }.get(document_type, 30)
    if re.search(r"carrez|surface\s*habitable|superficie\s+privative", evidence, re.I):
        rank += 15
    elif re.search(r"surface\s+de\s+r[ée]f[ée]rence", evidence, re.I):
        rank += 10
    if re.search(r"terrain|parcelle|contenance cadastrale|are|centiare", evidence, re.I):
        rank -= 25
    if surface_scope == "partial":
        rank -= 40
    return rank


def _land_surface_document_rank(document_type: str) -> int:
    return {
        "pv_huissier": 80,
        "pv_notaire": 75,
        "cahier_conditions_vente": 70,
        "conditions_vente": 65,
        "diagnostics_techniques": 60,
        "annonce_vente": 45,
        "pdf": 40,
    }.get(document_type, 30)


def _assign_pdf_surface(sale: AuctionSale, surface: dict[str, object]) -> None:
    value = surface["value"]
    evidence = str(surface.get("evidence") or "")
    lowered = evidence.lower()
    decimal_value = value if isinstance(value, Decimal) else Decimal(str(value))
    if _is_land_surface_evidence(evidence):
        _assign_pdf_land_surface(sale, surface)
        return
    if sale.habitable_surface_m2 is None and re.search(r"surface\s*habitable|m(?:2|²)\s+habitables?", lowered, re.I):
        sale.habitable_surface_m2 = decimal_value
    elif sale.carrez_surface_m2 is None and "carrez" in lowered:
        sale.carrez_surface_m2 = decimal_value
    elif sale.surface_m2 is None:
        sale.surface_m2 = decimal_value
    if sale.surface_m2 is None:
        sale.surface_m2 = decimal_value
    surface_scope = clean_text(surface.get("surface_scope"))
    if surface_scope == "partial":
        sale.surface_scope = "partial"
        if "partial_surface_measurement" not in sale.quality_flags:
            sale.quality_flags.append("partial_surface_measurement")
    sale.surface_source = sale.surface_source or "pdf"
    sale.surface_confidence = sale.surface_confidence or (
        Decimal("0.45") if surface_scope == "partial" else Decimal("0.75")
    )
    sale.surface_evidence = sale.surface_evidence or evidence
    sale.raw_payload["surface_extraction"] = {
        "source": "pdf",
        "value_m2": float(decimal_value),
        "document_label": clean_text(surface.get("document_label")),
        "document_url": clean_text(surface.get("document_url")),
        "document_type": clean_text(surface.get("document_type")),
        "page_number": surface.get("page_number"),
        "page_confidence": surface.get("page_confidence"),
        "extraction_method": clean_text(surface.get("extraction_method")),
        "surface_scope": surface_scope,
        "evidence": evidence,
    }


def _assign_pdf_land_surface(sale: AuctionSale, surface: dict[str, object]) -> None:
    value = surface["value"]
    evidence = str(surface.get("evidence") or "")
    decimal_value = value if isinstance(value, Decimal) else Decimal(str(value))
    if sale.land_surface_m2 is None:
        sale.land_surface_m2 = decimal_value
    if sale.property_type == "land" and sale.surface_m2 is None:
        sale.surface_m2 = decimal_value
    sale.surface_source = sale.surface_source or "pdf"
    sale.surface_evidence = sale.surface_evidence or evidence
    extraction = {
        "source": "pdf",
        "kind": "land_surface_m2",
        "value_m2": float(decimal_value),
        "document_label": clean_text(surface.get("document_label")),
        "document_url": clean_text(surface.get("document_url")),
        "document_type": clean_text(surface.get("document_type")),
        "page_number": surface.get("page_number"),
        "page_confidence": surface.get("page_confidence"),
        "extraction_method": clean_text(surface.get("extraction_method")),
        "evidence": evidence,
    }
    sale.raw_payload["land_surface_extraction"] = extraction
    if sale.property_type == "land":
        sale.raw_payload["surface_extraction"] = {**extraction, "kind": "surface_m2"}


def _reconcile_pdf_starting_price(sale: AuctionSale, extraction: dict[str, object]) -> None:
    value = extraction.get("value")
    if not isinstance(value, Decimal):
        value = parse_price(value)
    if value is None or value <= 0:
        return

    source_value = sale.starting_price_eur
    if source_value is None:
        sale.starting_price_eur = value
        status = "extracted"
    elif source_value == value:
        status = "corroborated"
    elif _should_replace_starting_price_with_document(source_value, value):
        sale.starting_price_eur = value
        status = "resolved"
        if "starting_price_conflict_resolved" not in sale.quality_flags:
            sale.quality_flags.append("starting_price_conflict_resolved")
    else:
        status = "conflict_unresolved"
        if "starting_price_conflict" not in sale.quality_flags:
            sale.quality_flags.append("starting_price_conflict")

    sale.raw_payload["starting_price_extraction"] = {
        "version": DOCUMENT_FACTS_VERSION,
        "source": "pdf",
        "status": status,
        "value_eur": float(value),
        "rejected_source_price_eur": (
            float(source_value) if status == "resolved" and source_value is not None else None
        ),
        "selected_value_eur": float(sale.starting_price_eur) if sale.starting_price_eur is not None else None,
        "document_label": clean_text(extraction.get("document_label")),
        "document_url": clean_text(extraction.get("document_url")),
        "document_type": clean_text(extraction.get("document_type")),
        "page_number": extraction.get("page_number"),
        "page_confidence": extraction.get("page_confidence"),
        "extraction_method": clean_text(extraction.get("extraction_method")),
        "evidence": clean_text(extraction.get("evidence")),
    }


def _should_replace_starting_price_with_document(current: Decimal, documented: Decimal) -> bool:
    if current <= 0:
        return True
    return current < Decimal("1000") and documented >= Decimal("3000") and documented / current >= Decimal("20")


def _assign_pdf_sale_date(sale: AuctionSale, sale_date: dict[str, object]) -> None:
    parsed = sale_date.get("value")
    if not isinstance(parsed, datetime):
        return
    sale.sale_date = parsed
    sale.raw_payload["pdf_sale_date_extraction"] = {key: value for key, value in sale_date.items() if key != "value"}
    if sale.status in {"", "unknown"}:
        sale.status = normalize_status(None, parsed)


def _write_pdf_text_cache(sale: AuctionSale, pdf_texts: list[dict[str, str]]) -> Path:
    PDF_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    path = PDF_TEXTS_DIR / f"{_sale_storage_id(sale)}.json"
    payload = [
        {
            "label": item["label"],
            "url": item["url"],
            "type": item["type"],
            "document_type": item["document_type"],
            "file_path": item["file_path"],
            "text": item["text"],
            "pages": item.get("pages", []),
            "cache_version": item.get("cache_version"),
            "sha256": item.get("sha256"),
            "page_count": item.get("page_count"),
            "text_chars": item.get("text_chars"),
            "page_text_chars": item.get("page_text_chars"),
            "ocr_pages": item.get("ocr_pages"),
            "empty_pages": item.get("empty_pages"),
            "extraction_method": item.get("extraction_method"),
            "confidence": item.get("confidence"),
        }
        for item in pdf_texts
    ]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _extract_starting_price_with_evidence(text: str) -> dict[str, object] | None:
    if not clean_text(text):
        return None
    value_pattern = r"(?P<price>[0-9][0-9\s.\u00a0]*(?:,[0-9]{1,2})?)"
    patterns = (
        rf"\bmise\s+[àa]\s+prix\s*[:\-]\s*{value_pattern}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
        rf"\bmise\s+[àa]\s+prix\b.{{0,260}}?"
        rf"(?:ci[\s-]*apr[eè]s\s+indiqu[eé]e?s?|adjudication\s+aura\s+lieu|en\s+un\s+seul\s+lot)"
        rf".{{0,140}}?{value_pattern}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
        rf"\badjudication\b.{{0,180}}?\bsur\s+la\s+mise\s+[àa]\s+prix\b"
        rf".{{0,180}}?{value_pattern}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            context = clean_text(text[max(0, match.start() - 180) : min(len(text), match.end() + 220)]) or ""
            normalized_context = strip_accents(context).lower()
            if re.search(
                r"\b(?:caution|cheque\s+de\s+banque|minimum\s+de)\b|"
                r"\b10\s*%\s+du\s+montant\s+de\s+la\s+mise\s+a\s+prix\b",
                normalized_context,
            ) and not re.search(
                r"\b(?:adjudication\s+aura\s+lieu|en\s+un\s+seul\s+lot|ci[\s-]*apres\s+indique)\b",
                normalized_context,
            ):
                continue
            value = parse_price(match.group("price"))
            if value is None or value <= 0:
                continue
            return {"value": value, "evidence": context}
    return None


def _extract_surface(text: str) -> Decimal | None:
    result = _extract_surface_with_evidence(text)
    return result["value"] if result else None


def _extract_surface_with_evidence(text: str) -> dict[str, Decimal | str] | None:
    patterns = (
        rf"(?:surface|superficie)\s+de\s+r[ée]f[ée]rence\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"surface\s+(?:privative\s+)?(?:loi\s+)?carrez(?:\s+totale)?\s*:?\s*(?:de\s+)?(?:environ\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"(?:surface\s*(?:habitable|privative|utile|totale|carrez|au\s+sol\s+totale)?|superficie(?:\s+(?:carrez|habitable|privative))?)\s*:?\s*(?:de\s+)?(?:environ\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"(?:surface\s+(?:habitable|privative|utile|totale|carrez)?|superficie(?:\s+carrez)?).{{0,80}}?\b(?:soit|est\s+de|de)\s+{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"(?:mesurage\s+(?:loi\s+)?carrez|loi\s+carrez|surface\s+(?:privative\s+)?(?:loi\s+)?carrez|superficie\s+(?:privative\s+)?(?:loi\s+)?carrez)\s*:?\s*(?:de\s+)?(?:environ\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"\b(?:d['’]\s*)?environ\s+{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²|\*)\s+(?:habitables?|de\s+surface|loi\s+carrez)",
        rf"\btotal\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²|\*)",
        rf"superficie\s*approximative\s*habitable\s*totale\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²|\?)",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            if _is_surface_false_positive(text, match.start(), match.end()):
                continue
            value = parse_surface(match.group(1))
            if value is None:
                continue
            evidence = clean_text(text[max(0, match.start() - 120) : min(len(text), match.end() + 160)]) or ""
            return {"value": value, "evidence": evidence}
    return None


def _extract_land_surface_with_evidence(text: str) -> dict[str, Decimal | str] | None:
    m2_patterns = (
        rf"\b(?:surface|superficie)\s+(?:du\s+|de\s+la\s+)?(?:terrain|parcelle|jardin|cadastrale)\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"\b(?:terrain|parcelles?|jardin)\b.{{0,140}}?\b(?:surface|superficie|contenance)\b.{{0,60}}?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"\bcontenance(?:\s+(?:totale|cadastrale))?\b.{{0,100}}?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"\b{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b.{{0,80}}\b(?:de\s+terrain|terrain|parcelles?|jardin)\b",
    )
    for pattern in m2_patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            if not _has_land_surface_context(text, match.start(), match.end()):
                continue
            if _land_surface_match_is_built(text, match):
                continue
            value = parse_surface(match.group(1))
            if value is None:
                continue
            evidence = clean_text(text[max(0, match.start() - 120) : min(len(text), match.end() + 160)]) or ""
            return {"value": value, "evidence": evidence}

    unit_patterns = (
        r"\b(?P<ha>\d{1,5})\s*(?:ha|hectares?)\s*(?:(?P<a>\d{1,5})\s*(?:a|ares?))?\s*(?:(?P<ca>\d{1,2})\s*(?:ca|centiares?))?\b",
        r"\b(?P<a>\d{1,5})\s*(?:a|ares?)\s*(?:(?P<ca>\d{1,2})\s*(?:ca|centiares?))?\b",
    )
    unit_candidates: list[dict[str, Decimal | str | int]] = []
    for pattern in unit_patterns:
        for match in re.finditer(pattern, text, re.I):
            if not _has_land_surface_context(text, match.start(), match.end()):
                continue
            value = _cadastral_units_to_square_meters(match)
            if value is None:
                continue
            evidence = clean_text(text[max(0, match.start() - 120) : min(len(text), match.end() + 160)]) or ""
            unit_candidates.append(
                {
                    "value": value,
                    "evidence": evidence,
                    "rank": _land_unit_candidate_rank(text, match.start(), match.end()),
                }
            )
    if unit_candidates:
        unit_candidates.sort(key=lambda item: int(item["rank"]), reverse=True)
        best = unit_candidates[0]
        if len(unit_candidates) == 1 or int(best["rank"]) >= 40:
            return {"value": best["value"], "evidence": best["evidence"]}
    return None


def _land_surface_match_is_built(text: str, match: re.Match[str]) -> bool:
    value_start = match.start(1)
    before_value = text[max(0, value_start - 100) : value_start]
    if not re.search(
        r"\b(?:habitable|carrez|privative|utile|b[âa]tie|surface\s+de\s+r[ée]f[ée]rence)\b",
        before_value,
        re.I,
    ):
        return False
    return not re.search(r"\b(?:terrain|parcelle|jardin|cadastrale)\b", before_value[-70:], re.I)


def _land_unit_candidate_rank(text: str, start: int, end: int) -> int:
    before = _normalize_document_classifier_text(text[max(0, start - 120) : start])
    after = _normalize_document_classifier_text(text[end : min(len(text), end + 100)])
    context = f"{before} {after}"
    rank = 0
    if re.search(r"\b(?:parcelle|terrain|jardin)\b", before[-90:]):
        rank += 60
    if re.search(r"\b(?:parcelle|terrain|jardin)\b", after[:70]):
        rank += 40
    if re.search(r"\b(?:contenance|total|totale)\b", context):
        rank += 45
    if re.search(r"\bjouissance\s+(?:exclusive|privative)\b", before):
        rank += 20
    if re.search(r"\b(?:section|cadastre|cadastree|tableau)\b", context):
        rank -= 15
    return rank


def _extract_energy_diagnostics_with_evidence(text: str) -> dict[str, object] | None:
    if not clean_text(text):
        return None
    if not re.search(
        r"\b(?:dpe|diagnostic\s+de\s+performance\s+energetique|diagnostic\s+de\s+performance\s+[ée]nerg[ée]tique|ges|gaz\s+a\s+effet\s+de\s+serre|gaz\s+à\s+effet\s+de\s+serre|kwh|co2)\b",
        text,
        re.I,
    ):
        return None
    dpe_match = _first_energy_class_match(
        text,
        (
            r"\b(?:dpe|classe\s+energie|classe\s+energetique|etiquette\s+energie|performance\s+energetique)\s*[:=-]?\s*(?:classe\s*)?([A-G])\b",
            r"\bdiagnostic\s+de\s+performance\s+[ée]nerg[ée]tique.{0,80}?\b(?:classe\s*)?([A-G])\b",
        ),
    )
    ges_match = _first_energy_class_match(
        text,
        (
            r"\b(?:ges|emissions?\s+de\s+gaz\s+a\s+effet\s+de\s+serre|emissions?\s+de\s+gaz\s+à\s+effet\s+de\s+serre|gaz\s+a\s+effet\s+de\s+serre|gaz\s+à\s+effet\s+de\s+serre)\s*[:=-]?\s*(?:classe\s*)?([A-G])\b",
        ),
    )
    consumption_match = re.search(
        r"\b(?:consommation\s+(?:energetique|énergétique)|conso(?:mmation)?\s*(?:5\s+usages)?|energie\s+primaire).{0,80}?([0-9]+(?:[,.][0-9]+)?)\s*kwh(?:ep)?\s*/?\s*m(?:2|²)\s*/?\s*(?:an|a|annee|année)?\b",
        text,
        re.I | re.S,
    )
    if consumption_match is None:
        consumption_match = re.search(
            r"\b([0-9]+(?:[,.][0-9]+)?)\s*kwh(?:ep)?\s*/?\s*m(?:2|²)\s*/?\s*(?:an|a|annee|année)?\b",
            text,
            re.I,
        )
    emissions_match = re.search(
        r"\b(?:emissions?\s+(?:de\s+)?(?:gaz\s+a\s+effet\s+de\s+serre|gaz\s+à\s+effet\s+de\s+serre|ges)|ges).{0,100}?([0-9]+(?:[,.][0-9]+)?)\s*kg\s*(?:co2|co₂)\s*/?\s*m(?:2|²)\s*/?\s*(?:an|a|annee|année)?\b",
        text,
        re.I | re.S,
    )
    if emissions_match is None:
        emissions_match = re.search(
            r"\b([0-9]+(?:[,.][0-9]+)?)\s*kg\s*(?:co2|co₂)\s*/?\s*m(?:2|²)\s*/?\s*(?:an|a|annee|année)?\b",
            text,
            re.I,
        )
    if not any((dpe_match, ges_match, consumption_match, emissions_match)):
        return None
    starts = [match.start() for match in (dpe_match, ges_match, consumption_match, emissions_match) if match]
    ends = [match.end() for match in (dpe_match, ges_match, consumption_match, emissions_match) if match]
    evidence = clean_text(text[max(0, min(starts) - 120) : min(len(text), max(ends) + 180)]) or ""
    return {
        "dpe_class": dpe_match.group(1).upper() if dpe_match else None,
        "ges_class": ges_match.group(1).upper() if ges_match else None,
        "energy_consumption_kwh_m2_year": _decimal_to_int_or_float(
            _parse_decimal_number(consumption_match.group(1)) if consumption_match else None
        ),
        "emissions_kg_co2_m2_year": _decimal_to_int_or_float(
            _parse_decimal_number(emissions_match.group(1)) if emissions_match else None
        ),
        "evidence": evidence,
    }


def _first_energy_class_match(text: str, patterns: tuple[str, ...]) -> re.Match[str] | None:
    for pattern in patterns:
        match = re.search(pattern, strip_accents(text), re.I | re.S)
        if match and match.group(1).upper() in {"A", "B", "C", "D", "E", "F", "G"}:
            return match
    return None


def _parse_decimal_number(value: str) -> Decimal | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        return Decimal(text.replace(",", "."))
    except Exception:
        return None


def _decimal_to_int_or_float(value: Decimal | None) -> int | float | None:
    if value is None:
        return None
    return int(value) if value == value.to_integral_value() else float(value)


def _extract_sale_date_with_evidence(text: str, *, local_timezone: str = "Europe/Paris") -> dict[str, object] | None:
    candidates: list[dict[str, object]] = []
    for chunk in _visit_candidate_chunks(text):
        for phrase in _sale_date_candidate_phrases(chunk):
            parsed = parse_french_datetime(phrase, local_timezone=local_timezone)
            if parsed is None:
                continue
            candidates.append(
                {
                    "value": parsed,
                    "sale_date": parsed.isoformat(),
                    "evidence": clean_text(phrase) or clean_text(chunk) or "",
                }
            )
    if not candidates:
        return None
    candidates.sort(key=_sale_date_extraction_rank, reverse=True)
    return candidates[0]


def _sale_date_candidate_phrases(text: str) -> list[str]:
    value = clean_text(text) or ""
    if not value:
        return []
    normalized = _normalize_document_classifier_text(value)
    if re.search(r"\b(?:visites?|rendez[-\s]?vous)\b", normalized) and not re.search(
        r"\b(?:audience|date\s+d['’ ]audience|date\s+de\s+la\s+vente|vente\s+aux\s+encheres)\b",
        normalized,
    ):
        return []

    patterns = (
        r"\b(?:audience\s+d['’]\s*adjudication|audience\s+des?\s+cri[eé]es?|"
        r"date\s+d['’]\s*audience|date\s+de\s+(?:la\s+)?vente|"
        r"vente\s+aux\s+ench[eè]res(?:\s+publiques?)?|adjudication)\b[^.;\n]{0,180}",
        r"\bvente\s+(?:fix[eé]e?\s*)?(?:au|aura\s+lieu\s+le|le|:)\s*[^.;\n]{0,160}",
        r"\bsera\s+(?:proc[eé]d[eé]\s+)?vendu[^.;\n]{0,160}",
    )
    phrases: list[str] = []
    for pattern in patterns:
        for match in re.finditer(pattern, value, flags=re.I):
            phrase = clean_text(match.group(0)) or ""
            if not phrase or not _has_sale_date_signal(phrase):
                continue
            phrase_normalized = _normalize_document_classifier_text(phrase)
            if re.search(r"\b(?:prix\s+d['’ ]adjudication|frais|mise\s+a\s+prix)\b", phrase_normalized):
                continue
            if phrase not in phrases:
                phrases.append(phrase)
    return phrases


def _has_sale_date_signal(text: str) -> bool:
    normalized = _normalize_document_classifier_text(text)
    month_pattern = r"janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre"
    return bool(
        re.search(rf"\b\d{{1,2}}\s+(?:{month_pattern})\s+\d{{4}}\b", normalized)
        or re.search(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b", normalized)
    )


def _sale_date_extraction_rank(item: dict[str, object]) -> tuple[int, int, int]:
    document_type = str(item.get("document_type") or "")
    document_score = {
        "annonce_vente": 90,
        "cahier_conditions_vente": 85,
        "conditions_vente": 80,
        "pv_huissier": 65,
        "pv_notaire": 65,
        "proces_verbal": 60,
        "pdf": 40,
        "diagnostics_techniques": 10,
    }.get(document_type, 30)
    evidence = _normalize_document_classifier_text(item.get("evidence"))
    label_score = 0
    if re.search(r"\b(?:audience\s+d['’ ]adjudication|date\s+de\s+la\s+vente|date\s+d['’ ]audience)\b", evidence):
        label_score += 25
    elif re.search(r"\b(?:vente\s+aux\s+encheres|adjudication)\b", evidence):
        label_score += 15
    if re.search(r"\b(?:visites?|rendez[-\s]?vous|diagnostic|dpe|ges)\b", evidence):
        label_score -= 20
    page_score = 1 if item.get("page_number") is not None else 0
    return document_score, label_score, page_score


def _extract_visit_dates_with_evidence(text: str) -> dict[str, object] | None:
    candidates: list[str] = []
    for chunk in _visit_candidate_chunks(text):
        visit = _normalize_visit_candidate(chunk)
        if visit and visit not in candidates:
            candidates.append(visit)
    if not candidates:
        return None
    first = candidates[0]
    normalized_text = _normalize_document_classifier_text(text)
    index = normalized_text.find(_normalize_document_classifier_text(first))
    start = max(0, index - 120) if index >= 0 else 0
    end = min(len(text), (index if index >= 0 else 0) + len(first) + 160)
    evidence = clean_text(text[start:end]) or first
    return {
        "visit_dates": candidates,
        "evidence": evidence,
    }


def _visit_candidate_chunks(text: str) -> list[str]:
    lines = [clean_text(line) for line in re.split(r"[\n\r]+", text) if clean_text(line)]
    if len(lines) <= 1:
        lines = [clean_text(part) for part in re.split(r"(?<=[.;])\s+", text) if clean_text(part)]
    chunks: list[str] = []
    for line in lines:
        if not line:
            continue
        if len(line) > 500:
            chunks.extend(part for part in (clean_text(item) for item in re.split(r"(?<=[.;])\s+", line)) if part)
        else:
            chunks.append(line)
    return chunks


def _normalize_visit_candidate(text: str) -> str | None:
    value = clean_text(text)
    if not value:
        return None
    normalized = _normalize_document_classifier_text(value)
    if "visite virtuelle" in normalized or "aucune visite virtuelle" in normalized:
        return None
    if not re.search(r"\b(?:visites?|rendez[-\s]?vous)\b", normalized):
        return None
    if not re.search(
        r"\b(?:visite\s+(?:sur\s+place|libre|groupee|obligatoire|prevue)|date\s+des\s+visites?|rendez[-\s]?vous|sur\s+rendez[-\s]?vous|"
        r"(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b)",
        normalized,
    ):
        return None
    value = re.sub(r"^(?:conditions?\s+de\s+)?visites?\s*:\s*", "", value, flags=re.I).strip()
    value = re.sub(r"^date\s+des\s+visites?\s*:\s*", "", value, flags=re.I).strip()
    return value.rstrip(" .;")


def _cadastral_units_to_square_meters(match: re.Match[str]) -> Decimal | None:
    groups = match.groupdict()
    hectares = int(groups.get("ha") or 0)
    ares = int(groups.get("a") or 0)
    centiares = int(groups.get("ca") or 0)
    total = hectares * 10000 + ares * 100 + centiares
    return Decimal(total) if total > 0 else None


def _has_land_surface_context(text: str, start: int, end: int) -> bool:
    context = _normalize_document_classifier_text(text[max(0, start - 180) : min(len(text), end + 180)])
    return bool(
        re.search(
            r"\b(?:terrain|parcelles?|cadastr(?:e|ee|al|ale)|contenance|surface\s+cadastrale|superficie\s+cadastrale|jardin)\b",
            context,
        )
    )


def _is_land_surface_evidence(evidence: str) -> bool:
    text = _normalize_document_classifier_text(evidence)
    if re.search(
        r"\b(?:habitable|habitables|carrez|loi\s+carrez|surface\s+privative|surface\s+de\s+reference|batie|bati)\b",
        text,
    ):
        return False
    return bool(
        re.search(
            r"\b(?:surface|superficie)\s+(?:du\s+|de\s+la\s+)?(?:terrain|parcelle|jardin|cadastrale)\b|"
            r"\b(?:terrain|parcelles?|jardin)\b.{0,100}\b(?:surface|superficie|contenance)\b|"
            r"\bcontenance(?:\s+(?:totale|cadastrale))?\b.{0,100}\b(?:m\s*(?:2|²)|ha|ares?|centiares?)\b",
            text,
        )
    )


def _is_surface_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 160) : min(len(text), end + 60)]
    matched = text[start:end]
    if re.search(r"\b(?:habitable|carrez|privative|surface\s+de\s+r[ée]f[ée]rence)\b", matched, re.I):
        return False
    if re.search(r"\b(?:surface|superficie)\s+de\s+r[ée]f[ée]rence\b", context, re.I):
        return False
    if re.search(r"\bkwh\b|kg\s*co2|\bges\b|performance\s+[ée]nerg[ée]tique", context, re.I):
        return True
    prefix = text[max(0, start - 120) : start]
    return bool(
        re.search(
            r"\b(?:mur|paroi|plafond|toiture|fa[çc]ade|isolant|isolation|plancher|baie|fen[eê]tre|porte|garage|cave|parking)\b",
            prefix,
            re.I,
        )
    )


def _surface_measurement_scope(text: str, evidence: str) -> str:
    context = _normalize_document_classifier_text(f"{evidence} {text}")
    if re.search(
        r"\b(?:mesurage|calcul\s+de\s+superficie).{0,80}\b(?:incomplet|partiel|pas\s+pu|n(?:'|’)ont\s+pu)\b|"
        r"\bn(?:'|’)ont\s+pu\s+[eê]tre\s+r[ée]alis[ée]s?\s+dans\s+leur\s+int[ée]gralit[ée]\b|"
        r"\bpi[eè]ces?\s+(?:non\s+)?(?:mesur[ée]es?|accessibles?)\b",
        context,
    ):
        return "partial"
    evidence_text = _normalize_document_classifier_text(evidence)
    if "carrez" in evidence_text and len(re.findall(r"\bencombrement\s+trop\s+important\b", context)) >= 2:
        return "partial"
    return "total"


def _extract_rooms_count(text: str) -> int | None:
    rooms = extract_rooms_count_from_text(text)
    if rooms is not None:
        return rooms
    patterns = (
        r"\bnombre\s+de\s+pi[eè]ces?\s*(?:principales?)?\s*:?\s*([1-9][0-9]?)\b",
        r"\b([1-9][0-9]?)\s*pi[eè]ces?\s*(?:principales?)?\b",
        r"\b(?:type\s+)?[TF]\s*([1-9])\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            if _is_rooms_false_positive(text, match.start(), match.end()):
                continue
            return int(match.group(1))
    if re.search(r"\bstudio\b", text, re.I):
        return 1
    return None


def _is_rooms_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 50) : min(len(text), end + 50)]
    return bool(re.search(r"\barticle\b|\bpage\b|\blot\s+n", context, re.I))


def _extract_occupancy_status(text: str) -> str | None:
    lowered = strip_accents(text).lower()
    no_lease_status = no_lease_occupancy_status(lowered)
    if re.search(r"sans\s+droit\s+ni\s+titre|squatt?\w*", lowered):
        return "squatted"
    if re.search(
        r"\b(?:actuellement\s+)?occupe(?:e?s?|s)?\b|"
        r"\bsuivant\s+un\s+bail\b|"
        r"\bbail\s+(?:meuble|d['’]habitation|en\s+cours)\b|"
        r"\blocataire\b|"
        r"\bloyer\s+mensuel\b",
        lowered,
    ) and not re.search(
        r"\blibre\s+de\s+toute\s+occupation\b|"
        r"\ba\s+quitte\s+les\s+lieux\b|"
        r"\bdepart\s+effectif\b|"
        r"\bconstate(?:e?s?|s)?\s+libre\b",
        lowered,
    ):
        if no_lease_status:
            return no_lease_status
        return "rented" if has_rented_occupancy_signal(lowered) else "occupied"
    if re.search(r"\b(libre|inoccupe(?:e?s?|s)?)\b", lowered):
        return "vacant"
    if no_lease_status:
        return no_lease_status
    if re.search(r"\boccupe(?:e?s?|s)?\b", lowered):
        return "occupied"
    if has_rented_occupancy_signal(lowered):
        return "rented"
    return None


def _extract_property_type(text: str) -> str | None:
    match = re.search(r"\b(appartement|maison|immeuble|terrain|local commercial|commerce|garage|studio)\b", text, re.I)
    if not match:
        return None
    return normalize_property_type(match.group(1))


def _extract_description(text: str) -> str | None:
    match = re.search(
        r"(?:description|désignation)\s*:?\s*(.{80,1200}?)(?:\n[A-ZÉÈÀÂÎÔÛÇ ]{5,}\s*:|\Z)", text, re.I | re.S
    )
    if match:
        return clean_text(match.group(1))
    return clean_text(text[:800])


def _extract_risk_notes(text: str) -> str | None:
    notes = []
    checks = {
        "amiante": r"\bamiante\b",
        "plomb": r"\bplomb\b",
        "termites": r"\btermites?\b",
        "risques naturels": r"risques?\s+(?:naturels?|miniers?|technologiques?)|ERP\b",
        "DPE": r"\bDPE\b|diagnostic de performance énergétique",
        "servitude": r"\bservitudes?\b",
    }
    for label, pattern in checks.items():
        if re.search(pattern, text, re.I):
            notes.append(label)
    return ", ".join(notes) if notes else None


def _energy_diagnostic_risk_note(diagnostics: dict[str, object]) -> str | None:
    dpe_class = clean_text(diagnostics.get("dpe_class"))
    if dpe_class in {"F", "G"}:
        return f"DPE {dpe_class}"
    return None


def _merge_pdf_risk_notes(*values: str | None) -> str | None:
    seen: set[str] = set()
    notes: list[str] = []
    for value in values:
        for item in (clean_text(part) for part in str(value or "").split(",")):
            if item and item not in seen:
                seen.add(item)
                notes.append(item)
    return ", ".join(notes) if notes else None


def _document_filename(document: dict[str, str]) -> str:
    url = document.get("url", "")
    label = document.get("label", "")
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix not in {".pdf", ".doc", ".docx"}:
        suffix = ".pdf"
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", Path(label or "document").stem).strip("-") or "document"
    return f"{digest}-{stem}{suffix}"
