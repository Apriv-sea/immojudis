from __future__ import annotations

import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from src.config import load_settings
from src.freshness import document_fingerprint
from src.models import AuctionSale
from src.normalize import (
    clean_text,
)
from src.pdf_enrichment import (
    DEFAULT_DOCUMENT_GROUPS,
    DOCUMENT_FACTS_VERSION,
    PDF_ANNOUNCE_GROUP,
    PDF_BAIL_GROUP,
    PDF_CONDITIONS_GROUP,
    PDF_DESCRIPTION_GROUP,
    PDF_DIAGNOSTICS_GROUP,
    _canonical_document_type,
    _normalize_document_classifier_text,
    _profile_pdf_for_docling,
)


def _select_documents_for_extraction(
    documents: list[dict[str, str]],
    *,
    sale: AuctionSale | None = None,
) -> list[dict[str, str]]:
    settings = load_settings()
    configured_max_documents = max(1, int(settings["pdf_max_documents_per_sale"]))
    required_groups = _required_document_groups_for_sale(sale)
    max_documents = max(configured_max_documents, _available_document_group_count(documents, required_groups))
    priority = {
        "pv_huissier": 0,
        "pv_notaire": 1,
        "proces_verbal": 2,
        "diagnostics_techniques": 3,
        "cahier_conditions_vente": 4,
        "conditions_vente": 5,
        "annonce_vente": 6,
        "bail": 7,
        "pdf": 8,
        "other": 9,
    }
    groups = _document_group_order(required_groups)
    sorted_documents = sorted(
        documents,
        key=lambda item: (
            priority.get(
                _canonical_document_type(
                    item.get("document_type") or item.get("type"),
                    label=item.get("label"),
                    url=item.get("url"),
                ),
                9,
            ),
            str(item.get("label") or ""),
            str(item.get("url") or ""),
        ),
    )
    selected: list[dict[str, str]] = []
    selected_urls: set[str] = set()
    for group in groups:
        candidate = next(
            (
                item
                for item in sorted_documents
                if _canonical_document_type(
                    item.get("document_type") or item.get("type"),
                    label=item.get("label"),
                    url=item.get("url"),
                )
                in group
                and _document_identity(item) not in selected_urls
            ),
            None,
        )
        if candidate is not None:
            selected.append(candidate)
            selected_urls.add(_document_identity(candidate))
            if len(selected) >= max_documents:
                return selected
    for item in sorted_documents:
        identity = _document_identity(item)
        if identity in selected_urls:
            continue
        selected.append(item)
        selected_urls.add(identity)
        if len(selected) >= max_documents:
            break
    return selected


def _required_document_groups_for_sale(sale: AuctionSale | None) -> tuple[frozenset[str], ...]:
    if sale is None:
        return ()
    groups: list[frozenset[str]] = []
    has_surface = any(
        value is not None
        for value in (
            sale.surface_m2,
            sale.habitable_surface_m2,
            sale.carrez_surface_m2,
            sale.land_surface_m2,
            sale.app_surface_m2,
        )
    )
    if not has_surface:
        groups.extend((PDF_DESCRIPTION_GROUP, PDF_DIAGNOSTICS_GROUP, PDF_CONDITIONS_GROUP))
    if sale.property_type in {"house", "apartment", "building"} and sale.rooms_count is None:
        groups.extend((PDF_DESCRIPTION_GROUP, PDF_CONDITIONS_GROUP, PDF_ANNOUNCE_GROUP))
    if not sale.occupancy_status or sale.occupancy_status == "unknown":
        groups.extend((PDF_DESCRIPTION_GROUP, PDF_CONDITIONS_GROUP, PDF_BAIL_GROUP))
    if _needs_energy_diagnostics(sale):
        groups.append(PDF_DIAGNOSTICS_GROUP)
    if sale.raw_payload.get("document_facts_version") != DOCUMENT_FACTS_VERSION:
        groups.append(PDF_CONDITIONS_GROUP)
    return _unique_document_groups(groups)


def _needs_energy_diagnostics(sale: AuctionSale) -> bool:
    if sale.property_type in {"land", "parking"}:
        return False
    if sale.raw_payload.get("source_energy_diagnostics") or sale.raw_payload.get("pdf_energy_diagnostics"):
        return False
    risk_notes = _normalize_document_classifier_text(sale.risk_notes)
    if "dpe non soumis" in risk_notes:
        return False
    return sale.property_type in {"house", "apartment", "building", "commercial", "mixed"}


def _document_group_order(required_groups: tuple[frozenset[str], ...]) -> tuple[frozenset[str], ...]:
    return _unique_document_groups((*required_groups, *DEFAULT_DOCUMENT_GROUPS))


def _available_document_group_count(
    documents: list[dict[str, str]],
    groups: tuple[frozenset[str], ...],
) -> int:
    available_types = {
        _canonical_document_type(
            document.get("document_type") or document.get("type"),
            label=document.get("label"),
            url=document.get("url"),
        )
        for document in documents
    }
    return sum(1 for group in groups if available_types & group)


def _unique_document_groups(groups: tuple[frozenset[str], ...] | list[frozenset[str]]) -> tuple[frozenset[str], ...]:
    unique: list[frozenset[str]] = []
    seen: set[frozenset[str]] = set()
    for group in groups:
        if group in seen:
            continue
        seen.add(group)
        unique.append(group)
    return tuple(unique)


def _document_identity(document: dict[str, str]) -> str:
    return str(document.get("url") or document.get("file_path") or document.get("label") or id(document))


def _store_document_analysis_status(
    sale: AuctionSale,
    documents: list[dict[str, str]],
    pdf_texts: list[dict[str, object]],
) -> None:
    typed_documents = [_document_profile(document) for document in documents]
    extracted_profiles = [_extracted_document_profile(payload) for payload in pdf_texts]
    text_profiles = [profile for profile in extracted_profiles if profile["extraction_status"] == "extracted"]
    type_counts = Counter(profile["document_type"] for profile in typed_documents)
    extracted_type_counts = Counter(profile["document_type"] for profile in text_profiles)

    required_groups = {
        "pv_descriptif": {"pv_huissier", "pv_notaire", "proces_verbal"},
        "conditions_vente": {"cahier_conditions_vente", "conditions_vente"},
        "diagnostics": {"diagnostics_techniques"},
    }
    extracted_types = set(extracted_type_counts)
    available_types = set(type_counts)
    missing_core_documents = [
        group for group, aliases in required_groups.items() if not (aliases & extracted_types)
    ]

    if not documents and not sale.documents:
        coverage_status = "source_only"
        warning = "Aucun PDF officiel exploitable n'a été trouvé : l'analyse reste un pré-tri."
    elif not text_profiles:
        coverage_status = "documents_not_extracted"
        warning = "Des documents sont listés, mais aucun texte PDF n'a encore été extrait."
    elif missing_core_documents:
        coverage_status = "partial"
        warning = "Certaines pièces clés manquent ou n'ont pas été extraites."
    else:
        coverage_status = "rich"
        warning = "Les principales familles de documents sont disponibles pour l'analyse."

    failed_documents = max(0, len(_select_documents_for_extraction(sale.documents, sale=sale)) - len(text_profiles))
    checked_at = datetime.now(UTC).isoformat()
    previous = sale.raw_payload.get("document_analysis") or {}
    last_successful_check_at = checked_at if not failed_documents else previous.get("last_successful_check_at")
    sale.raw_payload["document_analysis"] = {
        "last_successful_check_at": last_successful_check_at,
        "checked_at": checked_at,
        "input_fingerprint": document_fingerprint(sale.documents),
        "failed_documents": failed_documents,
        "coverage_status": coverage_status,
        "warning": warning,
        "documents_listed": len(sale.documents or []),
        "documents_downloaded": len(documents),
        "documents_extracted": len(text_profiles),
        "document_types": dict(type_counts),
        "extracted_document_types": dict(extracted_type_counts),
        "missing_core_documents": missing_core_documents,
        "official_documents_found": bool(
            {
                "pv_huissier",
                "pv_notaire",
                "proces_verbal",
                "cahier_conditions_vente",
                "conditions_vente",
                "diagnostics_techniques",
            }
            & (available_types | extracted_types)
        ),
        "profiles": extracted_profiles or typed_documents,
    }


def _document_profile(document: dict[str, str]) -> dict[str, object]:
    label = str(document.get("label") or "")
    url = str(document.get("url") or "")
    document_type = _canonical_document_type(
        document.get("document_type") or document.get("type"), label=label, url=url
    )
    return {
        "label": label or None,
        "url": url or None,
        "document_type": document_type,
        "family": _document_family(document_type),
        "extraction_status": "pending",
    }


def _extracted_document_profile(payload: dict[str, object]) -> dict[str, object]:
    document_type = _canonical_document_type(
        payload.get("document_type") or payload.get("type"),
        label=payload.get("label"),
        url=payload.get("url"),
    )
    return {
        "label": payload.get("label") or None,
        "url": payload.get("url") or None,
        "document_type": document_type,
        "family": _document_family(document_type),
        "extraction_status": "extracted" if clean_text(payload.get("text")) else "empty",
        "sha256": payload.get("sha256"),
        "text_chars": int(payload.get("text_chars") or len(str(payload.get("text") or ""))),
        "page_count": int(payload.get("page_count") or 0),
        "ocr_pages": int(payload.get("ocr_pages") or 0),
        "confidence": float(payload.get("confidence") or 0),
        "method": payload.get("extraction_method") or None,
    }


def _document_family(document_type: str) -> str:
    if document_type in {"pv_huissier", "pv_notaire", "proces_verbal"}:
        return "constat_et_description"
    if document_type in {"cahier_conditions_vente", "conditions_vente"}:
        return "conditions_de_vente"
    if document_type == "diagnostics_techniques":
        return "diagnostics"
    if document_type == "bail":
        return "occupation"
    if document_type == "annonce_vente":
        return "annonce"
    if document_type in {"procedure_saisie", "cadastre"}:
        return "juridique_et_perimetre"
    return "autre"


def _adaptive_docling_timeout(
    path: Path,
    document: dict[str, str] | None,
    settings: dict[str, object],
) -> float:
    default_timeout = float(settings["pdf_docling_timeout_seconds"] or 0)
    fast_timeout = float(settings["pdf_docling_fast_timeout_seconds"] or default_timeout)
    if default_timeout <= 0:
        return default_timeout

    text = f"{document.get('label', '') if document else ''} {document.get('url', '') if document else ''}".lower()
    document_type = _canonical_document_type(
        (document.get("document_type") or document.get("type")) if document else None,
        label=document.get("label") if document else None,
        url=document.get("url") if document else None,
    )
    if re.search(r"sign|sign[ée]e?|anonymis|saisie-immobiliere|saisie\s+immobili[eè]re", text, re.I):
        return min(default_timeout, fast_timeout)
    profile = _profile_pdf_for_docling(path)
    if document_type in {"cahier_conditions", "cahier_conditions_vente", "conditions_vente"} and (
        profile["page_count"] >= 15 or profile["first_pages_text_chars"] < int(settings["pdf_docling_threshold_chars"])
    ):
        return min(default_timeout, fast_timeout)
    return default_timeout
