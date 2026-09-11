from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator

from src.config import LLM_EXTRACTIONS_DIR, PDF_TEXTS_DIR, load_settings
from src.enrichment.llm_client import ReplicateClient, create_llm_client
from src.enrichment.prompts import (
    DISPLAY_DESCRIPTION_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    build_display_description_prompt,
    build_user_prompt,
)
from src.enrichment.surface_reasoning import (
    SURFACE_REASONING_VERSION,
    ExtractedAsset,
    apply_surface_reasoning_to_sale,
    extract_surface_facts_from_text,
    merge_extracted_assets,
)
from src.models import AuctionSale
from src.normalize import clean_text, extract_bedrooms_count_from_text, extract_rooms_count_from_text
from src.pdf_enrichment import sale_storage_id

LOGGER = logging.getLogger(__name__)
LLM_CONTEXT_KEYWORDS = (
    "surface",
    "superficie",
    "contenance",
    "occupation",
    "occupé",
    "occupe",
    "libre",
    "bail",
    "locataire",
    "copropriété",
    "copropriete",
    "servitude",
    "diagnostics",
    "diagnostic",
    "amiante",
    "plomb",
    "termites",
    "dpe",
    "travaux",
    "désignation",
    "designation",
    "lots",
    "mise à prix",
    "mise a prix",
    "pièce",
    "pièces",
    "piece",
    "pieces",
    "composition",
    "comprenant",
    "comprend",
    "composé",
    "compose",
    "se compose",
    "distribution",
    "désignation",
    "designation",
    "rez-de-chaussée",
    "rez de chaussée",
    "etage",
    "étage",
    "séjour",
    "sejour",
    "salon",
    "salle à manger",
    "salle a manger",
    "pièce principale",
    "piece principale",
    "type deux",
    "type trois",
    "type quatre",
    "type cinq",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "chambre",
    "chambres",
    "studio",
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
)
PRIORITY_DOCUMENT_TYPES = {
    "pv_descriptif",
    "pv_huissier",
    "pv_notaire",
    "proces_verbal",
    "diagnostics_techniques",
    "cahier_conditions",
    "cahier_conditions_vente",
    "conditions_vente",
    "annonce_vente",
}
PRIORITY_LABEL_PATTERNS = re.compile(
    r"pv|pvd|descriptif|cahier|conditions\s+de\s+vente|ccv",
    re.I,
)
PDF_TEXT_ENRICHMENT_MARKER = "--- PDF TEXT ENRICHMENT ---"
SOURCE_DESCRIPTION_KEYS = (
    "source_description",
    "description",
    "descriptif",
    "designation",
    "désignation",
    "renseignements_de_vente",
    "criteres_resume",
    "complement",
    "body",
)
SOURCE_DESCRIPTION_EXCLUDED_KEYS = {
    "documents",
    "page_text",
    "raw_text",
    "contact",
    "contact_avocat",
    "avocat",
    "lawyer",
    "source_images",
}
UNUSABLE_SOURCE_DESCRIPTION_RE = re.compile(
    r"abonn[ée]|connectez-vous|connexion|int[ée]gralit[ée]\s+des\s+informations|"
    r"pour\s+consulter\s+l['’]int[ée]gralit[ée]|vous\s+devez\s+[êe]tre\s+abonn[ée]",
    re.I,
)
DISPLAY_DESCRIPTION_MAX_WORDS = 115
DISPLAY_DESCRIPTION_MAX_CHARS = 850
DISPLAY_DESCRIPTION_MIN_CONFIDENCE = 0.55
PROPERTY_TYPE_DISPLAY_LABELS = {
    "apartment": "Appartement",
    "house": "Maison",
    "building": "Immeuble",
    "land": "Terrain",
    "commercial": "Local commercial",
    "parking": "Stationnement",
    "mixed": "Bien mixte",
    "other": "Bien immobilier",
    "unknown": "Bien immobilier",
}
OCCUPANCY_DISPLAY_LABELS = {
    "vacant": "libre",
    "occupied": "occupé",
    "rented": "loué",
    "owner_occupied": "occupé par le propriétaire",
    "squatted": "squatté",
    "unknown": "à vérifier",
}

PropertyType = Literal[
    "apartment",
    "house",
    "building",
    "land",
    "commercial",
    "parking",
    "mixed",
    "other",
    "unknown",
]
OccupancyStatus = Literal["vacant", "occupied", "rented", "owner_occupied", "squatted", "unknown"]


class LLMExtraction(BaseModel):
    model_config = ConfigDict(extra="ignore")

    property_type: PropertyType | None = None
    display_description: str | None = None
    surface_m2: float | None = None
    assets: list[ExtractedAsset] = Field(default_factory=list)
    rooms_count: int | None = None
    bedrooms_count: int | None = None
    occupancy_status: OccupancyStatus | None = None
    occupancy_details: str | None = None
    legal_risks: list[str] = Field(default_factory=list)
    physical_risks: list[str] = Field(default_factory=list)
    copropriete: bool | None = None
    servitudes: list[str] = Field(default_factory=list)
    works_needed: str | None = None
    summary: str | None = None
    investor_notes: str | None = None
    confidence: dict[str, float] = Field(default_factory=dict)
    evidence: dict[str, Any] = Field(default_factory=dict)
    investment_facts: list[dict[str, Any]] = Field(default_factory=list)
    contradictions: list[dict[str, Any]] = Field(default_factory=list)
    analysis_questions: list[dict[str, Any]] = Field(default_factory=list)
    scoring_guidance: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("property_type", mode="before")
    @classmethod
    def normalize_property_type(cls, value: Any) -> Any:
        if isinstance(value, str) and value.lower() in {"", "null", "none"}:
            return None
        return value

    @field_validator("occupancy_status", mode="before")
    @classmethod
    def normalize_occupancy_status(cls, value: Any) -> Any:
        if isinstance(value, str):
            lowered = value.lower().strip()
            if lowered in {"", "null", "none"}:
                return None
            aliases = {
                "free": "vacant",
                "libre": "vacant",
                "vacant": "vacant",
                "inoccupé": "vacant",
                "inoccupe": "vacant",
                "loué": "rented",
                "loue": "rented",
                "leased": "rented",
                "tenant": "rented",
                "locataire": "rented",
                "occupé": "occupied",
                "occupe": "occupied",
                "owner occupied": "owner_occupied",
                "propriétaire occupant": "owner_occupied",
                "proprietaire occupant": "owner_occupied",
            }
            return aliases.get(lowered, value)
        return value

    @field_validator("rooms_count", "bedrooms_count", mode="before")
    @classmethod
    def normalize_positive_count(cls, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, str):
            if value.lower() in {"", "null", "none", "unknown", "inconnu"}:
                return None
            match = re.search(r"[1-9][0-9]?", value)
            return int(match.group(0)) if match else None
        if isinstance(value, (int, float)):
            rooms = int(value)
            return rooms if rooms > 0 else None
        return None

    @field_validator("confidence")
    @classmethod
    def clamp_confidence(cls, value: dict[str, float] | None) -> dict[str, float]:
        if not value:
            return {}
        return {key: max(0.0, min(1.0, float(score))) for key, score in value.items()}

    @field_validator("evidence", mode="before")
    @classmethod
    def normalize_evidence(cls, value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else {}

    @field_validator("investment_facts", "contradictions", "analysis_questions", "scoring_guidance", mode="before")
    @classmethod
    def normalize_due_diligence_lists(cls, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, dict)]

    @field_validator("assets", mode="before")
    @classmethod
    def normalize_assets(cls, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, dict)]

    @field_validator("legal_risks", "physical_risks", "servitudes", mode="before")
    @classmethod
    def default_empty_lists(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, list):
            return [_stringify_llm_value(item) for item in value if _stringify_llm_value(item)]
        return [_stringify_llm_value(value)]

    @field_validator("display_description", "works_needed", "occupancy_details", "summary", "investor_notes", mode="before")
    @classmethod
    def stringify_text_fields(cls, value: Any) -> Any:
        return _stringify_llm_value(value)

    @field_validator("copropriete", mode="before")
    @classmethod
    def normalize_copropriete(cls, value: Any) -> Any:
        if isinstance(value, bool) or value is None:
            return value
        if isinstance(value, str):
            lowered = value.lower()
            if lowered in {"true", "oui", "yes"}:
                return True
            if lowered in {"false", "non", "no", "unknown", "inconnu", ""}:
                return False if lowered in {"false", "non", "no"} else None
        return None


@dataclass
class LLMEnrichmentStats:
    analyzed: int = 0
    valid_json: int = 0
    errors: int = 0
    surface_extracted: int = 0
    surface_detected: int = 0
    rooms_extracted: int = 0
    rooms_detected: int = 0
    bedrooms_extracted: int = 0
    bedrooms_detected: int = 0
    occupancy_extracted: int = 0
    occupancy_detected: int = 0
    risks_detected: int = 0
    fact_chunks_analyzed: int = 0
    structured_surface_verified: int = 0
    calculated_surface_verified: int = 0
    unavailable: bool = False
    error_messages: list[str] = field(default_factory=list)


def enrich_sale_with_llm(
    sale: AuctionSale,
    client: ReplicateClient | None = None,
    output_dir: Path = LLM_EXTRACTIONS_DIR,
    extraction_mode: str | None = None,
) -> LLMEnrichmentStats:
    stats = LLMEnrichmentStats()
    settings = load_settings()
    if not settings["llm_enabled"]:
        return stats

    source_description = extract_source_description(sale)
    if source_description:
        sale.raw_payload["source_description"] = source_description
    else:
        sale.raw_payload.pop("source_description", None)

    extraction_mode = extraction_mode or str(settings.get("llm_extraction_mode") or "display_description")
    if extraction_mode == "display_description":
        contexts = [load_llm_context_for_sale(sale, max_chars=int(settings["llm_pdf_max_chars"]))]
    else:
        contexts = load_llm_fact_context_chunks_for_sale(
            sale,
            chunk_chars=int(settings.get("llm_fact_chunk_chars") or 12000),
            max_chunks=int(settings.get("llm_fact_max_chunks") or 0),
        )
    fact_contexts = [context for context in contexts if context]
    if not fact_contexts:
        return stats
    context_complete = (sale.raw_payload.get("llm_fact_context_coverage") or {}).get("complete") is not False
    if extraction_mode != "display_description" and not context_complete:
        stats.errors += 1
        stats.error_messages.append("Fact context truncated by the configured chunk budget")
    full_evidence_context = "\n\n".join(fact_contexts)

    client = client or create_llm_client()
    if not client.is_available():
        stats.unavailable = True
        return stats

    stats.analyzed += 1
    model_name = str(getattr(client, "model", "") or "")
    prompt_version = str(settings["llm_prompt_version"])
    cache_key = _llm_cache_key(
        full_evidence_context,
        model_name,
        prompt_version=f"{prompt_version}:{extraction_mode}:{SURFACE_REASONING_VERSION}:complete_v2:{settings.get('llm_fact_prompt_version')}:{settings.get('llm_display_prompt_version')}",
    )
    cached = _load_cached_extraction(sale, cache_key, output_dir) if settings["incremental_enrichment"] and not stats.errors else None
    if cached is not None:
        extraction = cached
        stats.valid_json += 1
        if extraction_mode != "display_description":
            sale.raw_payload["llm_fact_coverage"] = {"total_chunks": len(fact_contexts), "successful_chunks": len(fact_contexts), "failed_chunks": 0, "complete": True}
        _apply_extraction_to_sale(sale, extraction, stats, full_evidence_context, prompt_version=prompt_version)
        sale.raw_payload["llm_extraction"] = extraction.model_dump(mode="json")
        if extraction.assets:
            sale.raw_payload["llm_fact_extraction"] = extraction.model_dump(mode="json")
        sale.raw_payload["llm_cache_hit"] = True
        return stats

    if extraction_mode == "display_description":
        try:
            raw = client.generate_json(
                DISPLAY_DESCRIPTION_SYSTEM_PROMPT,
                build_display_description_prompt(full_evidence_context),
            )
            extraction = LLMExtraction.model_validate(raw)
            if not _normalize_display_description(extraction.display_description):
                stats.errors += 1
                stats.error_messages.append("Model returned an empty display description; derived fallback only")
        except Exception as exc:
            LOGGER.warning("LLM display synthesis failed for %s: %s", sale.source_url, exc)
            stats.errors += 1
            stats.error_messages.append(_llm_error_message(sale, exc))
            return stats
    else:
        chunk_extractions: list[LLMExtraction] = []
        failed_chunks = 0
        for index, context in enumerate(fact_contexts, start=1):
            try:
                chunk_key = _llm_cache_key(context, model_name, f"facts_complete_v2:{settings.get('llm_fact_prompt_version')}:{SURFACE_REASONING_VERSION}")
                chunk_path = output_dir / "chunks" / f"{chunk_key}.json"
                chunk = _read_fact_chunk(chunk_path) if settings["incremental_enrichment"] else None
                if chunk is None:
                    raw = client.generate_json(SYSTEM_PROMPT, build_user_prompt(context))
                    chunk = LLMExtraction.model_validate(raw)
                    _atomic_json(chunk_path, chunk.model_dump(mode="json"))
                chunk_extractions.append(chunk)
                stats.fact_chunks_analyzed += 1
            except Exception as exc:
                failed_chunks += 1
                stats.errors += 1
                stats.error_messages.append(
                    f"{_llm_error_message(sale, exc)} [fact chunk {index}/{len(fact_contexts)}]"
                )
        if not chunk_extractions:
            return stats
        extraction = _merge_llm_extractions(chunk_extractions)
        if failed_chunks:
            extraction = _downgrade_extraction_completeness(extraction)
        sale.raw_payload["llm_fact_coverage"] = {
            "total_chunks": len(fact_contexts),
            "successful_chunks": len(chunk_extractions),
            "failed_chunks": failed_chunks,
            "complete": failed_chunks == 0 and context_complete,
        }
        sale.raw_payload["llm_fact_prompt_version"] = str(
            settings.get("llm_fact_prompt_version") or prompt_version
        )

        if extraction_mode in {"structured_then_display", "full"}:
            display_context = _build_validated_display_context(
                sale,
                extraction,
                fallback_context=load_llm_context_for_sale(
                    sale,
                    max_chars=int(settings.get("llm_display_context_chars") or 12000),
                ),
            )
            try:
                display_raw = client.generate_json(
                    DISPLAY_DESCRIPTION_SYSTEM_PROMPT,
                    build_display_description_prompt(display_context),
                )
                display_extraction = LLMExtraction.model_validate(display_raw)
                if not _normalize_display_description(display_extraction.display_description):
                    raise ValueError("Model returned an empty display description")
                extraction.display_description = display_extraction.display_description
                if "display_description" in display_extraction.confidence:
                    extraction.confidence["display_description"] = display_extraction.confidence[
                        "display_description"
                    ]
                sale.raw_payload["llm_display_prompt_version"] = str(
                    settings.get("llm_display_prompt_version") or prompt_version
                )
            except Exception as exc:
                LOGGER.warning("LLM display synthesis failed for %s: %s", sale.source_url, exc)
                stats.errors += 1
                stats.error_messages.append(_llm_error_message(sale, exc))

    stats.valid_json += 1
    if not stats.errors:
        _save_extraction(sale, extraction, output_dir, cache_key=cache_key, model=model_name, prompt_version=prompt_version)
    _apply_extraction_to_sale(sale, extraction, stats, full_evidence_context, prompt_version=prompt_version)
    sale.raw_payload["llm_extraction"] = extraction.model_dump(mode="json")
    if extraction_mode != "display_description":
        sale.raw_payload["llm_fact_extraction"] = extraction.model_dump(mode="json")
    sale.raw_payload["llm_cache_hit"] = False
    if stats.errors:
        sale.raw_payload.pop("llm_prompt_version", None)
    return stats


def apply_cached_llm_extraction_to_sale(sale: AuctionSale, *, prompt_version: str | None = None) -> bool:
    """Re-apply an LLM payload already stored in raw_payload.

    This is intentionally network-free. It lets a pipeline version that adds a
    new public display field populate it from a previously validated extraction
    without re-downloading PDFs or calling Replicate again.
    """
    if sale.raw_payload.get("source_content_changed") or (sale.raw_payload.get("llm_fact_coverage") or {}).get("complete") is False:
        return False
    payload = sale.raw_payload.get("llm_extraction") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(payload, dict):
        return False
    try:
        extraction = LLMExtraction.model_validate(payload)
    except Exception:
        return False

    before = clean_text(sale.raw_payload.get("llm_display_description"))
    stats = LLMEnrichmentStats()
    _apply_extraction_to_sale(sale, extraction, stats, context="", prompt_version=prompt_version)
    after = clean_text(sale.raw_payload.get("llm_display_description"))
    return bool(after and after != before)


def load_pdf_text_for_sale(sale: AuctionSale, max_chars: int = 12000) -> str | None:
    path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        return None
    return build_reduced_pdf_context(payload, max_chars=max_chars)


def load_llm_context_for_sale(sale: AuctionSale, max_chars: int = 12000) -> str | None:
    source_context = build_source_page_context(sale, max_chars=min(6000, max(1500, max_chars // 3)))
    pdf_budget = max(2000, max_chars - len(source_context or "") - 2)
    pdf_context = load_pdf_text_for_sale(sale, max_chars=pdf_budget)
    if source_context or pdf_context:
        return _join_unique_sections(
            [section for section in (source_context, pdf_context) if section],
            max_chars=max_chars,
        )

    raw_text = clean_text(sale.raw_text)
    if not raw_text:
        return None
    return f"[ANNONCE SOURCE]\n{raw_text[:max_chars]}"


def load_llm_fact_context_chunks_for_sale(
    sale: AuctionSale,
    *,
    chunk_chars: int = 12000,
    max_chunks: int = 0,
) -> list[str]:
    """Return page-aware chunks covering all text already collected by the tool.

    Unlike the display context, this fact-extraction context does not keep only
    the first pages or keyword windows. Every source block and every extracted
    PDF page is represented. ``max_chunks=0`` means no artificial coverage cap.
    """

    chunk_chars = max(3000, chunk_chars)
    sections = _all_source_fact_sections(sale)
    pdf_path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
    try:
        pdf_payload = json.loads(pdf_path.read_text(encoding="utf-8")) if pdf_path.exists() else []
    except (OSError, json.JSONDecodeError):
        pdf_payload = []
    if isinstance(pdf_payload, list):
        sections.extend(_all_pdf_fact_sections(pdf_payload))
    chunks = _pack_fact_sections(sections, chunk_chars=chunk_chars)
    total_chunks = len(chunks)
    if max_chunks > 0:
        chunks = chunks[:max_chunks]
    sale.raw_payload["llm_fact_context_coverage"] = {
        "total_chunks": total_chunks,
        "selected_chunks": len(chunks),
        "complete": len(chunks) == total_chunks,
        "chunk_chars": chunk_chars,
    }
    return chunks


def _all_source_fact_sections(sale: AuctionSale) -> list[str]:
    sections: list[str] = []
    payloads = _source_payloads_for_sale(sale)
    primary_raw_text = _source_raw_text_without_pdf(
        payloads[0].get("raw_text") if payloads else None
    ) or _source_raw_text_without_pdf(sale.raw_text)
    if primary_raw_text:
        sections.append(f"[ANNONCE SOURCE - URL {sale.source_url}]\n{primary_raw_text}")
    metadata = _source_metadata_section(sale)
    if metadata:
        sections.append(metadata)
    # Do not include fields produced by a previous enrichment pass here: doing
    # so would change the cache key after applying the extraction itself.
    for index, payload in enumerate(payloads):
        sections.extend(
            _source_payload_sections(
                payload,
                sale,
                include_raw_text=not (index == 0 and primary_raw_text),
            )
        )
    return _unique_fact_sections(sections)


def _all_pdf_fact_sections(pdf_payload: list[dict[str, Any]]) -> list[str]:
    sections: list[str] = []
    for item in pdf_payload:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or "document"
        document_type = clean_text(item.get("document_type")) or "pdf"
        document_url = clean_text(item.get("url")) or "URL inconnue"
        pages = item.get("pages")
        if isinstance(pages, list) and pages:
            for page in pages:
                if not isinstance(page, dict):
                    continue
                text = clean_text(page.get("text"))
                if not text:
                    continue
                page_number = page.get("page")
                method = clean_text(page.get("method")) or "extraction"
                sections.append(
                    f"[DOCUMENT: {label} | TYPE: {document_type} | URL: {document_url} | "
                    f"PAGE: {page_number} | METHODE: {method}]\n{text}"
                )
            continue
        text = clean_text(item.get("text"))
        if text:
            sections.append(
                f"[DOCUMENT: {label} | TYPE: {document_type} | URL: {document_url}]\n{text}"
            )
    return _unique_fact_sections(sections)


def _pack_fact_sections(sections: list[str], *, chunk_chars: int) -> list[str]:
    fragments: list[str] = []
    for section in sections:
        if len(section) <= chunk_chars:
            fragments.append(section)
            continue
        header, separator, body = section.partition("\n")
        prefix = f"{header}\n" if separator else ""
        available = max(1000, chunk_chars - len(prefix) - 40)
        # Keep a small overlap so a room label and its value cannot be split on
        # opposite sides of a model call boundary.
        step = max(500, available - 250)
        for index, start in enumerate(range(0, len(body), step), start=1):
            fragments.append(f"{prefix}[FRAGMENT {index}]\n{body[start:start + available]}")
            if start + available >= len(body):
                break

    chunks: list[str] = []
    current: list[str] = []
    current_size = 0
    for fragment in fragments:
        extra = len(fragment) + (2 if current else 0)
        if current and current_size + extra > chunk_chars:
            chunks.append("\n\n".join(current))
            current = []
            current_size = 0
        current.append(fragment)
        current_size += len(fragment) + (2 if current_size else 0)
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def _unique_fact_sections(sections: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for section in sections:
        normalized = clean_text(section)
        if not normalized:
            continue
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        unique.append(normalized)
    return unique


def build_source_page_context(sale: AuctionSale, max_chars: int = 5000) -> str | None:
    sections: list[str] = []
    payloads = _source_payloads_for_sale(sale)
    primary_raw_text = _source_raw_text_without_pdf(
        payloads[0].get("raw_text") if payloads else None
    ) or _source_raw_text_without_pdf(sale.raw_text)
    if primary_raw_text:
        sections.append(f"[ANNONCE SOURCE]\n{primary_raw_text}")

    metadata = _source_metadata_section(sale)
    if metadata:
        sections.append(metadata)

    structured_metadata = _structured_sale_context(sale)
    if structured_metadata:
        sections.append(structured_metadata)

    for index, payload in enumerate(payloads):
        sections.extend(_source_payload_sections(payload, sale, include_raw_text=not (index == 0 and primary_raw_text)))

    raw_text = _source_raw_text_without_pdf(sale.raw_text)
    if raw_text and not primary_raw_text:
        sections.append(f"[ANNONCE SOURCE - TEXTE COLLECTE]\n{raw_text}")

    return _join_unique_sections(sections, max_chars=max_chars)


def extract_source_description(sale: AuctionSale) -> str | None:
    source_block_candidates: list[str] = []
    for payload in _source_payloads_for_sale(sale):
        source_url = payload.get("source_url") or (sale.source_url if payload is sale.raw_payload else None)
        source_block_candidates.extend(
            text for text in _source_description_candidates_from_payload(payload)
            if _description_reference_matches(text, source_url)
        )
    best_source_block = _best_source_description(source_block_candidates)
    if best_source_block:
        return best_source_block
    return _best_source_description([
        value for value in (sale.description, sale.raw_text)
        if value and _description_reference_matches(value, sale.source_url)
    ])


def _description_reference_matches(text: str, source_url: Any) -> bool:
    """Reject explicit cross-listing references; other publishers use their own IDs."""
    if not isinstance(source_url, str):
        return True
    url = urlparse(source_url)
    if url.hostname != "encheresimmobilieres.fr":
        return True
    expected = re.match(r"/ventes/(\d+)(?:-|$)", url.path)
    actual = re.search(r"R[ée]f\.\s*annonce\s*:\s*(\d+)\b", text, re.I)
    return not expected or not actual or expected[1] == actual[1]


def _source_description_candidates_from_payload(payload: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    for key in SOURCE_DESCRIPTION_KEYS:
        text = clean_text(payload.get(key))
        if text:
            candidates.append(text)

    blocks = payload.get("source_blocks")
    if isinstance(blocks, dict):
        for key in SOURCE_DESCRIPTION_KEYS:
            text = clean_text(blocks.get(key))
            if text:
                candidates.append(text)
        for key, value in blocks.items():
            normalized_key = str(key).lower()
            if normalized_key in SOURCE_DESCRIPTION_EXCLUDED_KEYS:
                continue
            if "description" in normalized_key or "descriptif" in normalized_key:
                text = clean_text(value)
                if text:
                    candidates.append(text)
    return candidates


def _best_source_description(candidates: list[str]) -> str | None:
    seen: set[str] = set()
    usable: list[str] = []
    for candidate in candidates:
        text = _usable_source_description(candidate)
        if not text:
            continue
        fingerprint = text.lower()
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        usable.append(text)
    if not usable:
        return None
    return max(usable, key=len)


def _usable_source_description(value: str | None) -> str | None:
    text = clean_text(value)
    if not text or len(text) < 20:
        return None
    if UNUSABLE_SOURCE_DESCRIPTION_RE.search(text):
        return None
    return text[:2500]


def build_reduced_pdf_context(
    pdf_texts: list[dict[str, Any]],
    max_chars: int = 12000,
    first_page_chars: int = 2500,
    window_chars: int = 900,
) -> str | None:
    max_chars = max(2000, max_chars)
    sections: list[str] = []

    for item in _priority_documents(pdf_texts):
        sections.extend(_document_page_sections(item, first_page_chars=first_page_chars, priority=True))

    for item in pdf_texts:
        pages = item.get("pages") if isinstance(item, dict) else None
        if isinstance(pages, list) and pages:
            label = clean_text(item.get("label")) or "document"
            document_type = clean_text(item.get("document_type")) or "pdf"
            for page in pages:
                if not isinstance(page, dict):
                    continue
                text = clean_text(page.get("text"))
                if not text:
                    continue
                page_number = page.get("page")
                for window in _keyword_windows(text, window_chars=window_chars):
                    sections.append(f"[EXTRAIT - {label} - {document_type} - page {page_number}]\n{window}")
        else:
            text = clean_text(item.get("text"))
            if not text:
                continue
            label = clean_text(item.get("label")) or "document"
            document_type = clean_text(item.get("document_type")) or "pdf"
            for window in _keyword_windows(text, window_chars=window_chars):
                sections.append(f"[EXTRAIT - {label} - {document_type}]\n{window}")

    reduced = _join_unique_sections(sections, max_chars=max_chars)
    if reduced:
        return reduced

    fallback_sections = []
    for item in pdf_texts:
        text = clean_text(item.get("text"))
        if text:
            label = clean_text(item.get("label")) or "document"
            fallback_sections.append(f"[{label}]\n{text[:first_page_chars]}")
    return _join_unique_sections(fallback_sections, max_chars=max_chars)


def _source_metadata_section(sale: AuctionSale) -> str | None:
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    parts = [
        f"Source primaire: {sale.primary_source or sale.source_name}",
        f"URL: {sale.source_url}",
        _metadata_line("Titre", raw_payload.get("title") or sale.title),
        _metadata_line("Description source", raw_payload.get("source_description") or raw_payload.get("description")),
        _metadata_line("Adresse", raw_payload.get("address") or sale.address),
        _metadata_line("Ville", raw_payload.get("city") or sale.city),
        _metadata_line("Code postal", raw_payload.get("postal_code") or sale.postal_code),
        _metadata_line("Type", raw_payload.get("property_type")),
        _metadata_line("Mise a prix", raw_payload.get("starting_price_eur")),
        _metadata_line("Date de vente", raw_payload.get("sale_date")),
        _metadata_line("Visites", " | ".join(raw_payload.get("visit_dates") or []) if isinstance(raw_payload.get("visit_dates"), list) else None),
        _metadata_line("Occupation source", raw_payload.get("occupancy_status")),
    ]
    text = "\n".join(part for part in parts if part)
    return f"[ANNONCE SOURCE]\n{text}" if text else None


def _structured_sale_context(sale: AuctionSale) -> str | None:
    llm_payload = sale.raw_payload.get("llm_extraction") if isinstance(sale.raw_payload, dict) else None
    previous_llm = llm_payload if isinstance(llm_payload, dict) else {}
    surface_m2 = None if sale.surface_source == "llm" else sale.surface_m2
    rooms_count = None if _same_int(previous_llm.get("rooms_count"), sale.rooms_count) else sale.rooms_count
    bedrooms_count = None if _same_int(previous_llm.get("bedrooms_count"), sale.bedrooms_count) else sale.bedrooms_count
    occupancy_status = (
        None
        if clean_text(previous_llm.get("occupancy_status")) == clean_text(sale.occupancy_status)
        else sale.occupancy_status
    )
    parts = [
        _metadata_line("Type normalisé", sale.property_type),
        _metadata_line("Surface principale", _decimal_text(surface_m2, "m2")),
        _metadata_line("Surface habitable", _decimal_text(sale.habitable_surface_m2, "m2")),
        _metadata_line("Surface Carrez", _decimal_text(sale.carrez_surface_m2, "m2")),
        _metadata_line("Surface terrain", _decimal_text(sale.land_surface_m2, "m2")),
        _metadata_line("Surface applicative", _decimal_text(sale.app_surface_m2, "m2")),
        _metadata_line("Pièces", rooms_count),
        _metadata_line("Chambres", bedrooms_count),
        _metadata_line("Salles de bain", sale.bathrooms_count),
        _metadata_line("Stationnements", sale.parking_count),
        _metadata_line("Jardin", _bool_text(sale.has_garden)),
        _metadata_line("Terrasse", _bool_text(sale.has_terrace)),
        _metadata_line("Garage", _bool_text(sale.has_garage)),
        _metadata_line("Piscine", _bool_text(sale.has_pool)),
        _metadata_line("Occupation extraite", occupancy_status),
    ]
    text = "\n".join(part for part in parts if part)
    return f"[DONNEES STRUCTUREES EXTRAITES]\n{text}" if text else None


def _metadata_line(label: str, value: Any) -> str | None:
    text = clean_text(value)
    return f"{label}: {text}" if text else None


def _decimal_text(value: Decimal | None, suffix: str) -> str | None:
    if value is None:
        return None
    return f"{value} {suffix}"


def _bool_text(value: bool | None) -> str | None:
    if value is None:
        return None
    return "oui" if value else "non"


def _same_int(left: Any, right: int | None) -> bool:
    if right is None:
        return False
    try:
        return int(left) == right
    except (TypeError, ValueError):
        return False


def _source_payloads_for_sale(sale: AuctionSale) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_payload(payload: Any) -> None:
        if not isinstance(payload, dict):
            return
        marker = str(payload.get("source_url") or payload.get("external_id") or id(payload))
        if marker in seen:
            return
        seen.add(marker)
        payloads.append(payload)

    add_payload(sale.raw_payload)
    if isinstance(sale.raw_payload, dict):
        for item in sale.raw_payload.get("merged_sources") or []:
            if isinstance(item, dict):
                add_payload(item.get("raw_payload"))
    for observation in sale.observations:
        if isinstance(observation, dict):
            add_payload(observation.get("raw_payload"))
    return payloads


def _source_payload_sections(payload: dict[str, Any], sale: AuctionSale, *, include_raw_text: bool = True) -> list[str]:
    label = _source_payload_label(payload, sale)
    sections: list[str] = []
    blocks = payload.get("source_blocks")
    page_text: str | None = None
    if isinstance(blocks, dict):
        for key, value in blocks.items():
            text = clean_text(value)
            if not text:
                continue
            if key == "page_text":
                page_text = text
                continue
            sections.append(f"[ANNONCE SOURCE - {label} - {key}]\n{text}")

    raw_text = clean_text(payload.get("raw_text")) if include_raw_text else None
    if raw_text:
        sections.append(f"[ANNONCE SOURCE - {label} - raw_text]\n{_source_raw_text_without_pdf(raw_text)}")
    if page_text:
        sections.append(f"[ANNONCE SOURCE - {label} - page_text]\n{page_text}")
    return sections


def _source_payload_label(payload: dict[str, Any], sale: AuctionSale) -> str:
    parts = [
        clean_text(payload.get("source_name")) or sale.source_name,
        clean_text(payload.get("source_url")),
    ]
    return " - ".join(part for part in parts if part) or "source"


def _source_raw_text_without_pdf(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    if PDF_TEXT_ENRICHMENT_MARKER in text:
        text = text.split(PDF_TEXT_ENRICHMENT_MARKER, 1)[0]
    return clean_text(text)


def _save_extraction(
    sale: AuctionSale,
    extraction: LLMExtraction,
    output_dir: Path,
    cache_key: str | None = None,
    model: str | None = None,
    prompt_version: str | None = None,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{sale_storage_id(sale)}.json"
    payload = extraction.model_dump(mode="json")
    if cache_key or model or prompt_version:
        payload["_cache"] = {"key": cache_key, "model": model, "prompt_version": prompt_version}
    _atomic_json(path, payload)
    return path


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(payload, handle, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _read_fact_chunk(path: Path) -> LLMExtraction | None:
    try:
        return LLMExtraction.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def _load_cached_extraction(sale: AuctionSale, cache_key: str, output_dir: Path) -> LLMExtraction | None:
    path = output_dir / f"{sale_storage_id(sale)}.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    cache = payload.get("_cache")
    if not isinstance(cache, dict) or cache.get("key") != cache_key:
        return None
    payload = {key: value for key, value in payload.items() if key != "_cache"}
    try:
        return LLMExtraction.model_validate(payload)
    except Exception:
        return None


def _llm_cache_key(context: str, model: str, prompt_version: str = "auction_llm_v1") -> str:
    digest = hashlib.sha256()
    digest.update(model.encode("utf-8"))
    digest.update(b"\0")
    digest.update(prompt_version.encode("utf-8"))
    digest.update(b"\0")
    digest.update(context.encode("utf-8"))
    return digest.hexdigest()


def _llm_error_message(sale: AuctionSale, exc: Exception) -> str:
    source = sale.source_name or sale.primary_source or "unknown"
    title = clean_text(sale.title) or "annonce sans titre"
    detail = clean_text(str(exc)) or exc.__class__.__name__
    return f"LLM extraction failed [{source}] {sale.source_url} — {title}: {detail[:500]}"


def _merge_llm_extractions(extractions: list[LLMExtraction]) -> LLMExtraction:
    if not extractions:
        return LLMExtraction()
    merged = extractions[0].model_copy(deep=True)
    merged.assets = merge_extracted_assets([asset for item in extractions for asset in item.assets])
    scalar_fields = (
        "property_type",
        "surface_m2",
        "rooms_count",
        "bedrooms_count",
        "occupancy_status",
        "occupancy_details",
        "copropriete",
        "works_needed",
        "summary",
        "investor_notes",
    )
    list_fields = (
        "legal_risks",
        "physical_risks",
        "servitudes",
        "investment_facts",
        "contradictions",
        "analysis_questions",
        "scoring_guidance",
    )
    for extraction in extractions[1:]:
        for field_name in scalar_fields:
            current = getattr(merged, field_name)
            incoming = getattr(extraction, field_name)
            if current is None or current == "unknown":
                setattr(merged, field_name, incoming)
            elif incoming not in (None, "unknown") and incoming != current:
                merged.contradictions.append(
                    {
                        "field": field_name,
                        "statement": "Valeurs différentes relevées dans plusieurs fragments.",
                        "sources": [str(current), str(incoming)],
                        "confidence": 0.9,
                    }
                )
                if field_name in {"surface_m2", "rooms_count", "bedrooms_count", "occupancy_status"}:
                    setattr(merged, field_name, None if field_name != "occupancy_status" else "unknown")
        for field_name in list_fields:
            values = [*getattr(merged, field_name), *getattr(extraction, field_name)]
            setattr(merged, field_name, _dedupe_json_values(values))
        for field_name, score in extraction.confidence.items():
            merged.confidence[field_name] = max(merged.confidence.get(field_name, 0.0), score)
        for field_name, evidence in extraction.evidence.items():
            if field_name not in merged.evidence:
                merged.evidence[field_name] = evidence
    return merged


def _downgrade_extraction_completeness(extraction: LLMExtraction) -> LLMExtraction:
    assets = []
    for asset in extraction.assets:
        completeness = asset.measurement_completeness
        if completeness in {"complete", "likely_complete"}:
            completeness = "partial"
        assets.append(asset.model_copy(update={"measurement_completeness": completeness}))
    return extraction.model_copy(update={"assets": assets})


def _dedupe_json_values(values: list[Any]) -> list[Any]:
    unique: list[Any] = []
    seen: set[str] = set()
    for value in values:
        marker = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
        if marker in seen:
            continue
        seen.add(marker)
        unique.append(value)
    return unique


def _build_validated_display_context(
    sale: AuctionSale,
    extraction: LLMExtraction,
    *,
    fallback_context: str | None,
) -> str:
    facts = {
        "property_type": extraction.property_type or sale.property_type,
        "rooms_count": extraction.rooms_count or sale.rooms_count,
        "bedrooms_count": extraction.bedrooms_count or sale.bedrooms_count,
        "occupancy_status": extraction.occupancy_status or sale.occupancy_status,
        "occupancy_details": extraction.occupancy_details,
        "assets": [asset.model_dump(mode="json") for asset in extraction.assets],
        "legal_risks": extraction.legal_risks,
        "physical_risks": extraction.physical_risks,
        "servitudes": extraction.servitudes,
        "works_needed": extraction.works_needed,
        "contradictions": extraction.contradictions,
    }
    sections = ["[FAITS STRUCTURES A VALIDER POUR AFFICHAGE]\n" + json.dumps(facts, ensure_ascii=False)]
    if fallback_context:
        sections.append(fallback_context)
    return "\n\n".join(sections)


def _apply_extraction_to_sale(
    sale: AuctionSale,
    extraction: LLMExtraction,
    stats: LLMEnrichmentStats,
    context: str = "",
    prompt_version: str | None = None,
) -> None:
    confidence = extraction.confidence
    if prompt_version:
        sale.raw_payload["llm_prompt_version"] = prompt_version
    if extraction.surface_m2 is not None or extraction.assets:
        stats.surface_detected += 1
    if extraction.rooms_count is not None:
        stats.rooms_detected += 1
    if extraction.bedrooms_count is not None:
        stats.bedrooms_detected += 1
    if extraction.occupancy_status not in (None, "unknown"):
        stats.occupancy_detected += 1

    structured_assets = list(extraction.assets)
    if not structured_assets:
        deterministic_asset = extract_surface_facts_from_text(context)
        if deterministic_asset is not None:
            structured_assets = [deterministic_asset]
    selected_structured_surface = None
    if structured_assets:
        previous_surface = sale.surface_m2
        surface_result = apply_surface_reasoning_to_sale(
            sale,
            structured_assets,
            context=context,
            source="llm_structured_verified" if extraction.assets else "deterministic_surface_reasoning",
        )
        selected_structured_surface = surface_result.selected
        if selected_structured_surface is not None:
            stats.structured_surface_verified += 1
            if selected_structured_surface.kind.startswith("calculated_"):
                stats.calculated_surface_verified += 1
            if sale.surface_m2 is not None and sale.surface_m2 != previous_surface:
                stats.surface_extracted += 1

    if (
        selected_structured_surface is None
        and sale.surface_m2 is None
        and extraction.surface_m2 is not None
        and confidence.get("surface_m2", 0) >= 0.7
        and _scalar_surface_is_supported(context, extraction.surface_m2, extraction.evidence)
    ):
        try:
            sale.surface_m2 = Decimal(str(extraction.surface_m2))
            sale.surface_source = sale.surface_source or "llm_explicit_verified"
            sale.surface_confidence = sale.surface_confidence or Decimal(str(confidence.get("surface_m2", 0)))
            evidence_quote = _evidence_quote(extraction.evidence, "surface_m2")
            if evidence_quote and not sale.surface_evidence:
                sale.surface_evidence = evidence_quote
            stats.surface_extracted += 1
        except InvalidOperation:
            pass

    if sale.rooms_count is None and extraction.rooms_count is not None:
        if confidence.get("rooms_count", 0) >= 0.7 or _rooms_count_is_corroborated(
            context, extraction.rooms_count
        ):
            sale.rooms_count = extraction.rooms_count
            stats.rooms_extracted += 1

    if sale.bedrooms_count is None and extraction.bedrooms_count is not None:
        if confidence.get("bedrooms_count", 0) >= 0.7 or _bedrooms_count_is_corroborated(
            context, extraction.bedrooms_count
        ):
            sale.bedrooms_count = extraction.bedrooms_count
            stats.bedrooms_extracted += 1

    if sale.rooms_count is not None and sale.bedrooms_count is not None and sale.bedrooms_count > sale.rooms_count:
        sale.bedrooms_count = None

    if not sale.occupancy_status and extraction.occupancy_status not in (None, "unknown"):
        if confidence.get("occupancy_status", 0) >= 0.7:
            sale.occupancy_status = extraction.occupancy_status
            stats.occupancy_extracted += 1

    if sale.property_type in (None, "unknown", "other") and extraction.property_type not in (None, "unknown"):
        if confidence.get("property_type", 0) >= 0.7:
            sale.property_type = extraction.property_type

    display_description = _normalize_display_description(extraction.display_description)
    if display_description and confidence.get("display_description", 1.0) >= DISPLAY_DESCRIPTION_MIN_CONFIDENCE:
        sale.raw_payload["llm_display_description"] = display_description
        sale.raw_payload["llm_display_description_word_count"] = len(display_description.split())
    else:
        fallback_display_description = _fallback_display_description(sale, extraction)
        if fallback_display_description:
            sale.raw_payload["llm_display_description"] = fallback_display_description
            sale.raw_payload["llm_display_description_word_count"] = len(fallback_display_description.split())

    risk_notes = _format_risk_notes(extraction)
    if risk_notes:
        sale.risk_notes = clean_text(" | ".join(filter(None, [sale.risk_notes, risk_notes])))
        stats.risks_detected += 1

    if extraction.summary and _is_better_summary(sale.description, extraction.summary):
        sale.description = extraction.summary

    due_diligence = _due_diligence_payload(extraction)
    if due_diligence:
        sale.raw_payload["llm_due_diligence"] = due_diligence


def _scalar_surface_is_supported(context: str, value: float, evidence: dict[str, Any]) -> bool:
    quote = _evidence_quote(evidence, "surface_m2")
    variants = {
        str(value),
        str(value).replace(".", ","),
        str(Decimal(str(value)).normalize()),
        str(Decimal(str(value)).normalize()).replace(".", ","),
    }
    searchable = quote or context
    if not searchable or not any(variant in searchable for variant in variants):
        return False
    return bool(
        re.search(
            r"\b(?:surface|superficie|carrez|habitable|appartement|maison|immeuble|b[âa]timent|local)\b",
            searchable,
            re.I,
        )
    )


def _format_risk_notes(extraction: LLMExtraction) -> str | None:
    parts = []
    if extraction.legal_risks:
        parts.append("Risques juridiques: " + "; ".join(extraction.legal_risks))
    if extraction.physical_risks:
        parts.append("Risques physiques: " + "; ".join(extraction.physical_risks))
    if extraction.servitudes:
        parts.append("Servitudes: " + "; ".join(extraction.servitudes))
    if extraction.works_needed:
        parts.append("Travaux: " + extraction.works_needed)
    if extraction.investor_notes:
        parts.append("Notes investisseur: " + extraction.investor_notes)
    return " | ".join(parts) if parts else None


def _normalize_display_description(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    text = re.sub(r"^(?:description|synthèse|synthese)\s*:\s*", "", text, flags=re.I).strip()
    words = text.split()
    if len(words) > DISPLAY_DESCRIPTION_MAX_WORDS:
        text = " ".join(words[:DISPLAY_DESCRIPTION_MAX_WORDS]).rstrip(" ,;:")
        if not re.search(r"[.!?]$", text):
            text += "."
    if len(text) > DISPLAY_DESCRIPTION_MAX_CHARS:
        truncated = text[:DISPLAY_DESCRIPTION_MAX_CHARS].rsplit(" ", 1)[0].rstrip(" ,;:")
        text = truncated if truncated else text[:DISPLAY_DESCRIPTION_MAX_CHARS].rstrip(" ,;:")
        if not re.search(r"[.!?]$", text):
            text += "."
    return clean_text(text)


def _fallback_display_description(sale: AuctionSale, extraction: LLMExtraction) -> str | None:
    sentences: list[str] = []
    opening = _fallback_opening(sale, extraction)
    if opening:
        sentences.append(_ensure_sentence(opening))

    details = _fallback_asset_details(sale, extraction)
    if details:
        sentences.append(_ensure_sentence("Les éléments disponibles mentionnent " + ", ".join(details)))

    occupation = _fallback_occupation(sale, extraction)
    if occupation:
        sentences.append(_ensure_sentence(occupation))

    attention_points = _fallback_attention_points(extraction)
    if attention_points:
        sentences.append(_ensure_sentence("Points à vérifier : " + "; ".join(attention_points)))

    if len(" ".join(sentences).split()) < 18:
        source_description = extract_source_description(sale)
        if source_description:
            sentences.append(_ensure_sentence(source_description))

    return _normalize_display_description(" ".join(sentences))


def _fallback_opening(sale: AuctionSale, extraction: LLMExtraction) -> str | None:
    property_type = extraction.property_type or sale.property_type or "unknown"
    label = PROPERTY_TYPE_DISPLAY_LABELS.get(property_type, "Bien immobilier")
    location = _fallback_location(sale)
    if location:
        return f"{label} {location}"
    title = clean_text(sale.title)
    if title:
        return title
    return label


def _fallback_location(sale: AuctionSale) -> str | None:
    city = clean_text(sale.city)
    department = clean_text(sale.department)
    if city and department:
        return f"à {city} ({department})"
    if city:
        return f"à {city}"
    if department:
        return f"dans le département {department}"
    return None


def _fallback_asset_details(sale: AuctionSale, extraction: LLMExtraction) -> list[str]:
    details: list[str] = []
    surface = _fallback_surface(sale, extraction)
    if surface:
        details.append(f"une surface de {surface} m²")
    if extraction.rooms_count or sale.rooms_count:
        rooms = extraction.rooms_count or sale.rooms_count
        details.append(f"{rooms} pièce{'s' if rooms and rooms > 1 else ''}")
    if extraction.bedrooms_count or sale.bedrooms_count:
        bedrooms = extraction.bedrooms_count or sale.bedrooms_count
        details.append(f"{bedrooms} chambre{'s' if bedrooms and bedrooms > 1 else ''}")
    amenities = _fallback_amenities(sale)
    if amenities:
        details.append("des annexes ou équipements : " + ", ".join(amenities))
    return details


def _fallback_surface(sale: AuctionSale, extraction: LLMExtraction) -> str | None:
    value = extraction.surface_m2 or sale.app_surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2 or sale.surface_m2
    if value is None and (extraction.property_type or sale.property_type) == "land":
        value = sale.land_surface_m2
    return _format_surface_value(value)


def _format_surface_value(value: Any) -> str | None:
    if value is None:
        return None
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        return None
    normalized = number.quantize(Decimal("0.01")).normalize()
    return str(normalized).replace(".", ",")


def _fallback_amenities(sale: AuctionSale) -> list[str]:
    amenities = []
    if sale.has_garden:
        amenities.append("jardin")
    if sale.has_terrace:
        amenities.append("terrasse")
    if sale.has_garage:
        amenities.append("garage")
    if sale.has_pool:
        amenities.append("piscine")
    if sale.parking_count:
        amenities.append(f"{sale.parking_count} stationnement{'s' if sale.parking_count > 1 else ''}")
    return amenities


def _fallback_occupation(sale: AuctionSale, extraction: LLMExtraction) -> str | None:
    status = extraction.occupancy_status or sale.occupancy_status
    label = OCCUPANCY_DISPLAY_LABELS.get(status or "")
    details = clean_text(extraction.occupancy_details)
    if label and details:
        return f"L'occupation est indiquée comme {label}, avec la précision suivante : {details}"
    if label and status != "unknown":
        return f"L'occupation est indiquée comme {label}"
    return None


def _fallback_attention_points(extraction: LLMExtraction) -> list[str]:
    points: list[str] = []
    if extraction.works_needed:
        points.append(f"travaux ou état signalé ({extraction.works_needed})")
    if extraction.legal_risks:
        points.append("risques juridiques mentionnés")
    if extraction.physical_risks:
        points.append("risques techniques mentionnés")
    if extraction.servitudes:
        points.append("servitudes mentionnées")
    return points


def _ensure_sentence(value: str) -> str:
    text = clean_text(value) or ""
    if not text:
        return text
    return text if re.search(r"[.!?]$", text) else f"{text}."


def _due_diligence_payload(extraction: LLMExtraction) -> dict[str, Any]:
    payload = {
        "investment_facts": extraction.investment_facts,
        "contradictions": extraction.contradictions,
        "analysis_questions": extraction.analysis_questions,
        "scoring_guidance": extraction.scoring_guidance,
    }
    return {key: value for key, value in payload.items() if value}


def _is_better_summary(current: str | None, candidate: str) -> bool:
    candidate_text = clean_text(candidate)
    if not candidate_text:
        return False
    current_text = clean_text(current)
    if not current_text:
        return True
    return len(candidate_text) > len(current_text) and len(candidate_text) <= 1200


def _rooms_count_is_corroborated(context: str, rooms_count: int) -> bool:
    if rooms_count <= 0:
        return False
    return extract_rooms_count_from_text(context) == rooms_count


def _bedrooms_count_is_corroborated(context: str, bedrooms_count: int) -> bool:
    if bedrooms_count < 0:
        return False
    return extract_bedrooms_count_from_text(context) == bedrooms_count


def _stringify_llm_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, dict):
        parts = []
        for key, item in value.items():
            text = _stringify_llm_value(item)
            if text:
                parts.append(f"{key}: {text}")
        return clean_text("; ".join(parts))
    if isinstance(value, list):
        return clean_text("; ".join(filter(None, (_stringify_llm_value(item) for item in value))))
    return clean_text(str(value))


def _priority_documents(pdf_texts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    priority = []
    for item in pdf_texts:
        document_type = str(item.get("document_type") or "")
        label = str(item.get("label") or "")
        if document_type in PRIORITY_DOCUMENT_TYPES or PRIORITY_LABEL_PATTERNS.search(label):
            priority.append(item)
    return priority


def _document_page_sections(item: dict[str, Any], *, first_page_chars: int, priority: bool) -> list[str]:
    label = clean_text(item.get("label")) or "document"
    document_type = clean_text(item.get("document_type")) or "pdf"
    prefix = "PRIORITE" if priority else "DOCUMENT"
    pages = item.get("pages")
    sections: list[str] = []
    if isinstance(pages, list) and pages:
        for page in pages[:3]:
            if not isinstance(page, dict):
                continue
            text = clean_text(page.get("text"))
            if not text:
                continue
            page_number = page.get("page")
            method = clean_text(page.get("method")) or "extraction"
            sections.append(f"[{prefix} - {label} - {document_type} - page {page_number} - {method}]\n{text[:first_page_chars]}")
        return sections
    text = clean_text(item.get("text"))
    return [f"[{prefix} - {label} - {document_type}]\n{text[:first_page_chars]}"] if text else []


def _keyword_windows(text: str, window_chars: int) -> list[str]:
    lowered = text.lower()
    half = window_chars // 2

    # Collect a [left, right] span around each keyword hit.
    spans: list[tuple[int, int]] = []
    for keyword in LLM_CONTEXT_KEYWORDS:
        start = 0
        while True:
            index = lowered.find(keyword, start)
            if index == -1:
                break
            spans.append((max(0, index - half), min(len(text), index + half)))
            start = index + len(keyword)

    if not spans:
        return []

    # Merge overlapping/adjacent spans so the same characters are not emitted
    # several times (dense legal PDFs produce heavily overlapping windows). This
    # keeps exactly the union of the previous windows — no information dropped,
    # only duplicated overlap removed.
    spans.sort()
    merged: list[list[int]] = [list(spans[0])]
    for left, right in spans[1:]:
        if left <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], right)
        else:
            merged.append([left, right])

    return [text[left:right].strip() for left, right in merged]


def _join_unique_sections(sections: list[str], max_chars: int) -> str | None:
    unique: list[str] = []
    seen: set[str] = set()
    total = 0
    for section in sections:
        normalized = re.sub(r"\s+", " ", section).strip()
        fingerprint = normalized[:300]
        if not normalized or fingerprint in seen:
            continue
        if total + len(normalized) + 2 > max_chars:
            remaining = max_chars - total - 2
            if remaining > 120:
                unique.append(normalized[:remaining])
            break
        seen.add(fingerprint)
        unique.append(normalized)
        total += len(normalized) + 2
    return "\n\n".join(unique) if unique else None


def _evidence_quote(evidence: dict[str, Any], field: str) -> str | None:
    item = evidence.get(field)
    if not isinstance(item, dict):
        return None
    quote = clean_text(item.get("quote"))
    if not quote:
        return None
    label = clean_text(item.get("document_label"))
    page = item.get("page_number")
    prefix_parts = []
    if label:
        prefix_parts.append(label)
    if isinstance(page, int):
        prefix_parts.append(f"page {page}")
    prefix = " - ".join(prefix_parts)
    return f"{prefix}: {quote}" if prefix else quote
