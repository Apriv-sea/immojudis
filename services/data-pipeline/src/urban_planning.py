from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass

from src.models import AuctionSale

DETECTOR = "urban_planning_regex"
DETECTOR_VERSION = "urban_planning_v2"
MAX_SIGNALS_PER_SALE = 80
MAX_CANDIDATES_PER_DEFINITION = 8


@dataclass(frozen=True)
class UrbanPlanningDefinition:
    kind: str
    label: str
    priority: str
    patterns: tuple[str, ...]
    action: str
    default_confidence: float


@dataclass(frozen=True)
class TextCandidate:
    text: str
    source_name: str
    source_kind: str
    document_url: str | None = None
    document_label: str | None = None
    document_type: str | None = None
    page_number: int | None = None
    confidence: float | None = None


DEFINITIONS: tuple[UrbanPlanningDefinition, ...] = (
    UrbanPlanningDefinition(
        kind="zoning",
        label="Urbanisme / PLU",
        priority="medium",
        patterns=(
            r"\bplu\b",
            r"\burbanisme\b",
            r"\bzonage\b",
            r"\bzone\s+(urbaine|agricole|naturelle|inondable|constructible)\b",
            r"\bplan local d urbanisme\b",
            r"\bpreemption\b",
        ),
        action="Contrôler le zonage, les droits de préemption et les contraintes d'usage.",
        default_confidence=0.62,
    ),
    UrbanPlanningDefinition(
        kind="permit",
        label="Permis et autorisations",
        priority="medium",
        patterns=(
            r"\bpermis\b",
            r"\bdeclaration prealable\b",
            r"\bautorisation(s)? de travaux\b",
            r"\bconformite\b",
            r"\bregularisation\b",
        ),
        action="Vérifier les autorisations, déclarations préalables et conformité des travaux.",
        default_confidence=0.64,
    ),
    UrbanPlanningDefinition(
        kind="servitude",
        label="Servitudes et accès",
        priority="high",
        patterns=(
            r"\bservitude(s)?\b",
            r"\bdroit de passage\b",
            r"\bacces\b",
            r"\bmitoyennete\b",
            r"\bindivision\b",
            r"\benclave\b",
        ),
        action="Qualifier l'impact sur l'accès, l'usage, les travaux et la revente.",
        default_confidence=0.72,
    ),
    UrbanPlanningDefinition(
        kind="coownership",
        label="Copropriété",
        priority="medium",
        patterns=(
            r"\bcopropriete\b",
            r"\breglement de copro\b",
            r"\bcharges\b",
            r"\bsyndic\b",
            r"\btantieme(s)?\b",
            r"\bassemblee generale\b",
        ),
        action="Relire règlement, charges, travaux votés, tantièmes et impayés éventuels.",
        default_confidence=0.62,
    ),
    UrbanPlanningDefinition(
        kind="usage",
        label="Usage et destination",
        priority="medium",
        patterns=(
            r"\bdestination\b",
            r"\busage\b",
            r"\bhabitation\b",
            r"\bcommercial\b",
            r"\bprofessionnel\b",
            r"\bchangement d usage\b",
            r"\bchangement de destination\b",
        ),
        action="Confirmer que l'usage envisagé est compatible avec les pièces et règles locales.",
        default_confidence=0.58,
    ),
    UrbanPlanningDefinition(
        kind="public_record",
        label="Pièces publiques",
        priority="low",
        patterns=(
            r"\bcadastre\b",
            r"\bplan cadastral\b",
            r"\bgeoportail\b",
            r"\bregistre\b",
            r"\bpublic\b",
        ),
        action="Recouper les pièces publiques avec le cahier des conditions et le cadastre.",
        default_confidence=0.55,
    ),
)


def build_urban_planning_signal_rows(
    sale: AuctionSale,
    *,
    pdf_texts: list[dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    candidates = _collect_text_candidates(sale, pdf_texts or [])
    rows: list[dict[str, object]] = []
    seen: set[tuple[str, str, str | None, int | None]] = set()

    for definition in DEFINITIONS:
        matches_for_definition = 0
        for candidate in candidates:
            matched_terms = _matched_terms(definition, candidate.text)
            if not matched_terms:
                continue
            excerpt = _excerpt(candidate.text)
            dedupe_key = (
                definition.kind,
                _normalize_text(excerpt)[:220],
                candidate.document_url,
                candidate.page_number,
            )
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            matches_for_definition += 1
            rows.append(_row_for_match(sale, definition, candidate, excerpt, matched_terms))
            if matches_for_definition >= MAX_CANDIDATES_PER_DEFINITION:
                break

    rows.sort(key=_signal_sort_key)
    return rows[:MAX_SIGNALS_PER_SALE]


def _row_for_match(
    sale: AuctionSale,
    definition: UrbanPlanningDefinition,
    candidate: TextCandidate,
    excerpt: str,
    matched_terms: list[str],
) -> dict[str, object]:
    confidence = _clamp_confidence(candidate.confidence or definition.default_confidence)
    status = "documented" if candidate.source_kind in {"pdf", "document"} else "to_verify"
    if status == "documented" and confidence < 0.72:
        confidence = 0.72
    signal_key = _signal_key(
        sale.source_url,
        definition.kind,
        candidate.source_kind,
        candidate.source_name,
        candidate.document_url,
        candidate.page_number,
        excerpt,
    )
    return {
        "source_url": sale.source_url,
        "signal_key": signal_key,
        "signal_kind": definition.kind,
        "label": definition.label,
        "status": status,
        "priority": definition.priority,
        "source_name": candidate.source_name,
        "source_kind": candidate.source_kind,
        "document_url": candidate.document_url,
        "document_label": candidate.document_label,
        "document_type": candidate.document_type,
        "page_number": candidate.page_number,
        "excerpt": excerpt,
        "action": definition.action,
        "confidence": confidence,
        "detector": DETECTOR,
        "detector_version": DETECTOR_VERSION,
        "raw_payload": {
            "matched_terms": matched_terms,
            "source_kind": candidate.source_kind,
        },
    }


def _collect_text_candidates(
    sale: AuctionSale,
    pdf_texts: list[dict[str, object]],
) -> list[TextCandidate]:
    candidates: list[TextCandidate] = []
    _add_candidate(candidates, sale.title, "Titre annonce", "sale_text", confidence=0.5)
    _add_candidate(candidates, sale.description, "Description annonce", "sale_text", confidence=0.55)
    _add_candidate(candidates, sale.raw_text, "Texte source", "sale_text", confidence=0.55)
    _add_candidate(candidates, sale.risk_notes, "Notes de risques", "risk", confidence=0.64)

    for document in sale.documents:
        if not isinstance(document, dict):
            continue
        document_url = _clean_text(document.get("url"))
        document_label = _clean_text(document.get("label"))
        document_type = _clean_text(document.get("document_type") or document.get("type"))
        _add_candidate(
            candidates,
            " ".join(filter(None, [document_type, document_label])),
            "Pièces du dossier",
            "document",
            document_url=document_url,
            document_label=document_label,
            document_type=document_type,
            confidence=0.72,
        )

    for item in _primary_source_fields(sale.raw_payload):
        _add_candidate(
            candidates,
            _clean_text(item["value"]),
            "Données source",
            "source_payload",
            confidence=0.56,
        )

    for observation in sale.observations:
        if isinstance(observation, dict):
            for item in _primary_source_fields(observation):
                _add_candidate(
                    candidates,
                    _clean_text(item["value"]),
                    "Observation source",
                    "source_payload",
                    confidence=0.56,
                )

    for item in pdf_texts:
        _add_pdf_candidates(candidates, item)

    return [
        candidate
        for candidate in candidates
        if candidate.text and any(_matched_terms(definition, candidate.text) for definition in DEFINITIONS)
    ]


def _add_pdf_candidates(candidates: list[TextCandidate], item: dict[str, object]) -> None:
    document_url = _clean_text(item.get("url"))
    document_label = _clean_text(item.get("label")) or "PDF extrait"
    document_type = _clean_text(item.get("document_type"))
    pages = item.get("pages")
    if isinstance(pages, list) and any(isinstance(page, dict) and page.get("text") for page in pages):
        for page in pages:
            if not isinstance(page, dict):
                continue
            page_number = page.get("page") if isinstance(page.get("page"), int) else None
            confidence = page.get("confidence")
            _add_candidate(
                candidates,
                page.get("text"),
                document_label,
                "pdf",
                document_url=document_url,
                document_label=document_label,
                document_type=document_type,
                page_number=page_number,
                confidence=float(confidence) if isinstance(confidence, (int, float)) else 0.78,
            )
        return

    confidence = item.get("confidence")
    _add_candidate(
        candidates,
        item.get("text"),
        document_label,
        "pdf",
        document_url=document_url,
        document_label=document_label,
        document_type=document_type,
        confidence=float(confidence) if isinstance(confidence, (int, float)) else 0.76,
    )


def _add_candidate(
    candidates: list[TextCandidate],
    value: object,
    source_name: str,
    source_kind: str,
    *,
    document_url: str | None = None,
    document_label: str | None = None,
    document_type: str | None = None,
    page_number: int | None = None,
    confidence: float | None = None,
) -> None:
    text = _clean_text(value)
    if not text:
        return
    candidates.append(
        TextCandidate(
            text=text,
            source_name=source_name,
            source_kind=source_kind,
            document_url=document_url,
            document_label=document_label,
            document_type=document_type,
            page_number=page_number,
            confidence=confidence,
        )
    )


def _matched_terms(definition: UrbanPlanningDefinition, text: str) -> list[str]:
    normalized = _normalize_text(text)
    terms: list[str] = []
    for pattern in definition.patterns:
        if re.search(pattern, normalized, flags=re.IGNORECASE):
            terms.append(pattern)
    return terms


def _signal_key(
    source_url: str,
    kind: str,
    source_kind: str,
    source_name: str,
    document_url: str | None,
    page_number: int | None,
    excerpt: str,
) -> str:
    seed = "|".join(
        [
            source_url,
            kind,
            source_kind,
            source_name,
            document_url or "",
            str(page_number or ""),
            _normalize_text(excerpt)[:240],
        ]
    )
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:20]
    return f"{kind}_{digest}"


def _signal_sort_key(row: dict[str, object]) -> tuple[int, int, float, str]:
    priority_rank = {"high": 0, "medium": 1, "low": 2}.get(str(row.get("priority")), 3)
    status_rank = 0 if row.get("status") == "documented" else 1
    confidence = row.get("confidence")
    confidence_rank = -float(confidence) if isinstance(confidence, (int, float)) else 0.0
    return (priority_rank, status_rank, confidence_rank, str(row.get("signal_key") or ""))


def _primary_source_fields(value: object) -> list[dict[str, object]]:
    return [
        item for item in _flatten_key_values(value)
        if not re.search(
            r"(?:^|\.)(?:asset_normalization|score_factors|investment_summary|"
            r"llm_display_description|about_description|sale_procedure|"
            r"related|similar|autres_annonces)(?:$|\.|\[)",
            str(item["path"]),
            re.IGNORECASE,
        )
    ]


def _flatten_key_values(value: object, path: str = "") -> list[dict[str, object]]:
    if not isinstance(value, (dict, list)):
        return []
    if isinstance(value, list):
        rows: list[dict[str, object]] = []
        for index, item in enumerate(value[:80]):
            rows.extend(_flatten_primitive_or_object(item, f"{path}[{index}]"))
        return rows
    rows = []
    for key, item in list(value.items())[:160]:
        rows.extend(_flatten_primitive_or_object(item, f"{path}.{key}" if path else str(key)))
    return rows


def _flatten_primitive_or_object(value: object, path: str) -> list[dict[str, object]]:
    if isinstance(value, (dict, list)):
        return _flatten_key_values(value, path)
    return [{"path": path, "value": value}]


def _flatten_to_text(value: object) -> str | None:
    if isinstance(value, dict):
        parts = [_clean_text(item) for item in value.values()]
        return " ".join(part for part in parts if part) or None
    if isinstance(value, list):
        parts = [_clean_text(item) for item in value]
        return " ".join(part for part in parts if part) or None
    return _clean_text(value)


def _clean_text(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, (str, int, float)):
        text = re.sub(r"\s+", " ", str(value)).strip()
        return text[:5000] if text else None
    if isinstance(value, (dict, list)):
        return _flatten_to_text(value)
    return None


def _normalize_text(value: str) -> str:
    return (
        unicodedata.normalize("NFD", value)
        .encode("ascii", "ignore")
        .decode("ascii")
        .replace("'", " ")
        .replace("’", " ")
        .lower()
    )


def _excerpt(value: str, max_length: int = 320) -> str:
    text = re.sub(r"\s+", " ", value).strip()
    if len(text) <= max_length:
        return text
    return f"{text[: max_length - 3].strip()}..."


def _clamp_confidence(value: float) -> float:
    return round(min(1.0, max(0.0, value)), 3)
