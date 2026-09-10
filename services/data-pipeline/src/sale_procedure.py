from __future__ import annotations

import re
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from src.models import AuctionSale
from src.normalize import clean_text

SALE_PROCEDURE_SCHEMA_VERSION = "sale_procedure_v1"
LEGAL_RULESET_VERSION = "fr_auction_participation_2026-08-20"

JUDICIAL_RULES_SOURCE_URL = "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000025024948/LEGISCTA000025939153/"
JUDICIAL_OVERBID_SOURCE_URL = (
    "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000025024948/LEGISCTA000025939177/"
)
NOTARIAL_RULES_SOURCE_URL = (
    "https://www.immobilier.notaires.fr/fr/articles/conseils-et-actualites/"
    "achat-vente/achat-maison-appartement-aux-encheres-achat-immobilier-encheres"
)

_EXPLICIT_TRIBUNAL_PATTERNS = (
    re.compile(r"\btribunal\s+judiciaire\b", re.I),
    re.compile(r"\bvente\s+(?:aux\s+ench[eè]res\s+)?(?:a|à)\s+la\s+barre\b", re.I),
    re.compile(r"\baudience\s+d['’]?adjudication\b", re.I),
    re.compile(r"\bavocat\s+inscrit\s+au\s+barreau\b", re.I),
)
_EXPLICIT_NOTARY_PATTERNS = (
    re.compile(r"\bvente\s+(?:aux\s+ench[eè]res\s+)?notariale\b", re.I),
    re.compile(r"\badjudication\s+(?:devant|par)\s+(?:un\s+)?notaire\b", re.I),
    re.compile(r"\bchambre\s+(?:interd[eé]partementale\s+|d[eé]partementale\s+)?des\s+notaires\b", re.I),
    re.compile(r"\bimmo[-\s]?interactif\b", re.I),
    re.compile(r"\borganisateur_categorie\s*:\s*notaire\b", re.I),
)
_STATE_PATTERNS = (
    re.compile(r"\bvente\s+domaniale\b", re.I),
    re.compile(r"\bcessions?\s+immobili[eè]res?\s+de\s+l['’][eé]tat\b", re.I),
    re.compile(r"\bdirection\s+de\s+l['’]immobilier\s+de\s+l['’][eé]tat\b", re.I),
)


def classify_sale_procedure(
    sale: AuctionSale,
    *,
    verified_at: str | None = None,
) -> AuctionSale:
    """Attach a conservative, evidence-carrying participation profile to a sale.

    The classifier distinguishes the venue/operator from the legal framework.
    It never upgrades an address-only court inference to a verified sale venue.
    """

    checked_at = verified_at or datetime.now(UTC).isoformat()
    corpus = _sale_corpus(sale)
    judicial_matches = _matched_signals(corpus, _EXPLICIT_TRIBUNAL_PATTERNS)
    notarial_matches = _matched_signals(corpus, _EXPLICIT_NOTARY_PATTERNS)
    state_matches = _matched_signals(corpus, _STATE_PATTERNS)

    if sale.source_name == "notaires":
        notarial_matches.append("Source officielle des Notaires de France")
    if sale.source_name == "cessions_etat":
        state_matches.append("Source officielle des cessions immobilières de l'État")

    venue_type, status, issues = _resolve_venue(
        sale,
        judicial_matches=judicial_matches,
        notarial_matches=notarial_matches,
        state_matches=state_matches,
    )
    rules_venue_type = venue_type if status in {"verified", "cross_checked"} else "unknown"
    legal_framework = _resolve_legal_framework(corpus, venue_type)
    participation_mode = _participation_mode(corpus, rules_venue_type)
    case_sources = _case_sources(sale)
    rules, regulatory_sources = _participation_rules(
        sale,
        venue_type=rules_venue_type,
        corpus=corpus,
        checked_at=checked_at,
    )
    facts = _verification_facts(
        sale,
        venue_type=venue_type,
        legal_framework=legal_framework,
        status=status,
        judicial_matches=judicial_matches,
        notarial_matches=notarial_matches,
        state_matches=state_matches,
    )

    procedure = {
        "schema_version": SALE_PROCEDURE_SCHEMA_VERSION,
        "ruleset_version": LEGAL_RULESET_VERSION,
        "venue_type": venue_type,
        "legal_framework": legal_framework,
        "venue_name": _venue_name(sale, venue_type),
        "venue_address": _venue_address(sale, venue_type=venue_type, status=status),
        "participation_mode": participation_mode,
        "organizer_name": _organizer_name(sale, venue_type),
        "organizer_type": _organizer_type(venue_type),
        "organizer_contact": clean_text(sale.lawyer_contact),
        "eligible_bar": _eligible_bar(sale, venue_type),
        "rules": rules,
        "verification": {
            "status": status,
            "verified_at": checked_at,
            "case_source_count": len(case_sources),
            "case_sources": case_sources,
            "regulatory_sources": regulatory_sources,
            "facts": facts,
            "issues": issues,
        },
    }

    # An audience's published start/end is not an online bidding interval.
    schedule = sale.raw_payload.get("source_sale_schedule")
    if isinstance(schedule, dict):
        try:
            start = datetime.fromisoformat(schedule["opens_at"])
            end = datetime.fromisoformat(schedule["closes_at"])
            if start.tzinfo is not None and end.tzinfo is not None and end > start:
                schedule_key = "sale_window" if venue_type == "notary" and participation_mode == "online" else "sale_session"
                procedure[schedule_key] = {
                    "opens_at": start.isoformat(),
                    "closes_at": end.isoformat(),
                    "source_url": sale.source_url,
                }
        except (KeyError, TypeError, ValueError):
            pass

    sale.sale_venue_type = venue_type
    sale.sale_legal_framework = legal_framework
    sale.sale_verification_status = status
    sale.sale_procedure = procedure
    sale.raw_payload["sale_procedure"] = procedure
    source_blocks = sale.raw_payload.setdefault("source_blocks", {})
    if isinstance(source_blocks, dict):
        source_blocks["sale_procedure"] = procedure
    _replace_quality_flag(sale, "sale_procedure_unverified", status == "pending")
    _replace_quality_flag(sale, "sale_procedure_conflict", status == "conflict")
    return sale


def _resolve_venue(
    sale: AuctionSale,
    *,
    judicial_matches: list[str],
    notarial_matches: list[str],
    state_matches: list[str],
) -> tuple[str, str, list[str]]:
    issues: list[str] = []
    explicit_families = sum(bool(value) for value in (judicial_matches, notarial_matches, state_matches))
    if explicit_families > 1:
        issues.append("Des indices contradictoires de lieu ou d'organisateur doivent être relus.")
        return "unknown", "conflict", issues

    if judicial_matches:
        has_official_mapping = _has_verified_court_assignment(sale)
        return "tribunal", "cross_checked" if has_official_mapping else "verified", issues
    if notarial_matches:
        return "notary", "cross_checked" if sale.source_name == "notaires" else "verified", issues
    if state_matches:
        return "state", "cross_checked" if sale.source_name == "cessions_etat" else "verified", issues

    if sale.tribunal or sale.tribunal_code:
        issues.append(
            "Le tribunal compétent est connu par l'adresse, mais le lieu de cette vente n'est pas encore confirmé par l'annonce."
        )
        return "tribunal", "pending", issues
    if sale.source_name == "notaires":
        issues.append("Le canal notarial est déduit de la source, sans mention de lieu suffisamment explicite.")
        return "notary", "pending", issues
    if sale.source_name == "cessions_etat":
        issues.append("Le canal domanial est déduit de la source, sans modalités particulières confirmées.")
        return "state", "pending", issues

    issues.append("Le lieu et le mode de participation ne sont pas encore confirmés.")
    return "unknown", "pending", issues


def _participation_rules(
    sale: AuctionSale,
    *,
    venue_type: str,
    corpus: str,
    checked_at: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if venue_type == "tribunal":
        guarantee = _judicial_guarantee(sale.starting_price_eur)
        return (
            {
                "lawyer_required": True,
                "lawyer_note": (
                    "Les enchères sont portées par un avocat inscrit au barreau du tribunal "
                    "judiciaire devant lequel la vente est poursuivie."
                ),
                "bid_method": "lawyer_mandate",
                "guarantee": {
                    "amount_eur": guarantee,
                    "rate_pct": 10,
                    "minimum_eur": 3000,
                    "status": "regulatory_verified",
                    "note": "Garantie légale minimale ; le bénéficiaire et les autres chèques sont précisés par le cahier des conditions de vente.",
                },
                "financing_condition": False,
                "cooling_off_period": False,
                "payment_deadline_days": 60,
                "overbid": {
                    "allowed": True,
                    "minimum_increase_pct": 10,
                    "window_days": 10,
                    "note": "La surenchère est formée par acte d'avocat.",
                },
            },
            [
                _regulatory_source(
                    "Code des procédures civiles d'exécution — enchères et garantie",
                    JUDICIAL_RULES_SOURCE_URL,
                    checked_at,
                ),
                _regulatory_source(
                    "Code des procédures civiles d'exécution — surenchère",
                    JUDICIAL_OVERBID_SOURCE_URL,
                    checked_at,
                ),
            ],
        )

    if venue_type == "notary":
        amount_eur, rate_pct = _extract_notarial_guarantee(sale, corpus)
        return (
            {
                "lawyer_required": False,
                "lawyer_note": (
                    "L'acquéreur peut en principe porter lui-même les enchères ; les modalités "
                    "particulières du cahier des charges restent prioritaires."
                ),
                "bid_method": "direct_or_sale_specific",
                "guarantee": {
                    "amount_eur": amount_eur,
                    "rate_pct": rate_pct,
                    "minimum_eur": None,
                    "status": "case_verified"
                    if amount_eur is not None or rate_pct is not None
                    else "pending_case_document",
                    "note": (
                        "Montant relevé dans les informations de la vente."
                        if amount_eur is not None or rate_pct is not None
                        else "Le montant exact doit être confirmé dans le cahier des charges."
                    ),
                },
                "financing_condition": False,
                "cooling_off_period": False,
                "payment_deadline_days": 45,
                "overbid": {
                    "allowed": None,
                    "minimum_increase_pct": None,
                    "window_days": None,
                    "note": "La faculté de surenchère dépend du cahier des charges de la vente.",
                },
            },
            [
                _regulatory_source(
                    "Guide des ventes aux enchères des Notaires de France",
                    NOTARIAL_RULES_SOURCE_URL,
                    checked_at,
                )
            ],
        )

    return (
        {
            "lawyer_required": None,
            "lawyer_note": "Les modalités particulières de cette vente restent à confirmer.",
            "bid_method": "sale_specific",
            "guarantee": {
                "amount_eur": None,
                "rate_pct": None,
                "minimum_eur": None,
                "status": "pending_case_document",
                "note": "Consignation à confirmer dans les conditions de vente.",
            },
            "financing_condition": None,
            "cooling_off_period": None,
            "payment_deadline_days": None,
            "overbid": {
                "allowed": None,
                "minimum_increase_pct": None,
                "window_days": None,
                "note": "Règle propre à la vente à confirmer.",
            },
        },
        [],
    )


def _verification_facts(
    sale: AuctionSale,
    *,
    venue_type: str,
    legal_framework: str,
    status: str,
    judicial_matches: list[str],
    notarial_matches: list[str],
    state_matches: list[str],
) -> list[dict[str, Any]]:
    matches = judicial_matches or notarial_matches or state_matches
    facts = [
        {
            "key": "venue_type",
            "value": venue_type,
            "status": status,
            "evidence": matches[:4],
            "source_url": sale.source_url,
        },
        {
            "key": "legal_framework",
            "value": legal_framework,
            "status": "verified" if legal_framework != "unknown" and matches else "pending",
            "evidence": _framework_signals(legal_framework),
            "source_url": sale.source_url,
        },
    ]
    if _has_verified_court_assignment(sale):
        assignment = sale.raw_payload["tribunal_assignment"]
        facts.append(
            {
                "key": "competent_court",
                "value": assignment.get("court_name"),
                "status": "verified",
                "evidence": [
                    f"Commune INSEE {assignment.get('insee_code')}",
                    str(assignment.get("mapping_method") or ""),
                ],
                "source_url": assignment.get("source_url"),
            }
        )
    return facts


def _sale_corpus(sale: AuctionSale) -> str:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    source_blocks = payload.get("source_blocks")
    # Derived procedure output must never become evidence for its next run.
    # Otherwise a pending address-only court assignment can promote itself to
    # verified by matching wording in its own generated participation guide.
    block_values = (
        [f"{key}: {value}" for key, value in source_blocks.items() if key != "sale_procedure"]
        if isinstance(source_blocks, dict)
        else []
    )
    document_values: list[object] = []
    for document in sale.documents:
        if not isinstance(document, dict):
            continue
        document_values.extend(document.get(key) for key in ("name", "label", "type", "document_type"))
    values: list[object] = [
        sale.title,
        sale.description,
        sale.raw_text,
        sale.source_name,
        sale.primary_source,
        payload.get("source_description"),
        *block_values,
        *document_values,
    ]
    return clean_text("\n".join(str(value) for value in values if value)) or ""


def _matched_signals(corpus: str, patterns: tuple[re.Pattern[str], ...]) -> list[str]:
    matches: list[str] = []
    for pattern in patterns:
        match = pattern.search(corpus)
        if match:
            value = clean_text(match.group(0))
            if value and value not in matches:
                matches.append(value)
    return matches


def _resolve_legal_framework(corpus: str, venue_type: str) -> str:
    patterns = (
        ("judicial_seizure", r"\bsaisie\s+immobili[eè]re\b"),
        ("insolvency", r"\bliquidation\s+judiciaire\b|\bproc[eé]dure\s+collective\b"),
        ("judicial_partition", r"\blicitation\b|\bpartage\s+judiciaire\b"),
        ("state_sale", r"\bvente\s+domaniale\b|\bcessions?\s+immobili[eè]res?\s+de\s+l['’][eé]tat\b"),
        ("voluntary_notarial", r"\bvente\s+volontaire\b|\bvente\s+notariale\b"),
    )
    for value, pattern in patterns:
        if re.search(pattern, corpus, re.I):
            return value
    if venue_type == "state":
        return "state_sale"
    return "unknown"


def _framework_signals(framework: str) -> list[str]:
    labels = {
        "judicial_seizure": "Mention de saisie immobilière",
        "insolvency": "Mention de liquidation ou procédure collective",
        "judicial_partition": "Mention de licitation ou partage judiciaire",
        "state_sale": "Mention de vente domaniale",
        "voluntary_notarial": "Mention de vente volontaire ou notariale",
    }
    return [labels[framework]] if framework in labels else []


def _case_sources(sale: AuctionSale) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = [
        {
            "kind": "listing",
            "label": clean_text(sale.primary_source) or clean_text(sale.source_name) or "Annonce",
            "source_name": clean_text(sale.source_name) or "Annonce",
            "url": sale.source_url,
        }
    ]
    seen = {sale.source_url}
    for document in sale.documents:
        if not isinstance(document, dict):
            continue
        url = clean_text(document.get("url") or document.get("document_url"))
        if not url or url in seen:
            continue
        seen.add(url)
        sources.append(
            {
                "kind": "document",
                "label": clean_text(document.get("name") or document.get("label")) or "Pièce du dossier",
                "source_name": clean_text(sale.source_name) or "Dossier de vente",
                "url": url,
                "document_type": clean_text(document.get("document_type") or document.get("type")),
            }
        )
        if len(sources) >= 6:
            break
    assignment = sale.raw_payload.get("tribunal_assignment")
    if _has_verified_court_assignment(sale) and isinstance(assignment, dict):
        url = clean_text(assignment.get("source_url"))
        if url and url not in seen:
            sources.append(
                {
                    "kind": "official_reference",
                    "label": "Référentiel officiel de compétence territoriale",
                    "source_name": "Ministère de la Justice",
                    "url": url,
                    "reference_sha256": assignment.get("reference_sha256"),
                }
            )
    return sources


def _has_verified_court_assignment(sale: AuctionSale) -> bool:
    assignment = sale.raw_payload.get("tribunal_assignment")
    return bool(
        isinstance(assignment, dict)
        and assignment.get("status") == "verified"
        and assignment.get("mapping_method") == "justice_competence_insee_exact"
        and assignment.get("court_code")
        and assignment.get("source_url")
    )


def _venue_name(sale: AuctionSale, venue_type: str) -> str | None:
    if venue_type == "tribunal":
        return clean_text(sale.tribunal) or clean_text(sale.tribunal_code)
    if venue_type == "notary":
        return _extract_notary_name(_sale_corpus(sale)) or clean_text(sale.lawyer_name)
    if venue_type == "state":
        return "Vente immobilière de l'État"
    return None


def _venue_address(sale: AuctionSale, *, venue_type: str, status: str) -> str | None:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    source_blocks = payload.get("source_blocks")
    if isinstance(source_blocks, dict):
        for key in ("sale_location", "auction_location", "venue", "lieu_vente"):
            value = clean_text(source_blocks.get(key))
            if value:
                return value
    assignment = payload.get("tribunal_assignment")
    if (
        venue_type == "tribunal"
        and status in {"verified", "cross_checked"}
        and isinstance(assignment, dict)
        and assignment.get("status") == "verified"
    ):
        return clean_text(assignment.get("court_address"))
    return None


def _organizer_name(sale: AuctionSale, venue_type: str) -> str | None:
    if venue_type in {"tribunal", "notary"}:
        return clean_text(sale.lawyer_name) or (
            _extract_notary_name(_sale_corpus(sale)) if venue_type == "notary" else None
        )
    if venue_type == "state":
        return "Direction de l'immobilier de l'État"
    return None


def _organizer_type(venue_type: str) -> str:
    return {
        "tribunal": "pursuing_lawyer",
        "notary": "notary",
        "state": "state_service",
    }.get(venue_type, "unknown")


def _eligible_bar(sale: AuctionSale, venue_type: str) -> str | None:
    if venue_type != "tribunal":
        return None
    city = clean_text(sale.raw_payload.get("tribunal_assignment", {}).get("court_city"))
    if not city:
        city = clean_text(sale.tribunal)
        city = re.sub(r"^TJ\s+", "", city or "", flags=re.I) or None
    return f"Barreau de {city}" if city else None


def _participation_mode(corpus: str, venue_type: str) -> str:
    online = bool(re.search(r"\ben\s+ligne\b|\bimmo[-\s]?interactif\b|\bvisioconf[eé]rence\b", corpus, re.I))
    in_person = bool(
        re.search(
            r"\ben\s+salle\b|\bau\s+tribunal\b|\bpalais\s+de\s+justice\b|\bchambre\s+des\s+notaires\b", corpus, re.I
        )
    )
    if online and in_person:
        return "hybrid"
    if online:
        return "online"
    if in_person or venue_type == "tribunal":
        return "in_person"
    return "unknown"


def _judicial_guarantee(starting_price: Decimal | None) -> float | None:
    if starting_price is None:
        return None
    return float(max(Decimal("3000"), starting_price * Decimal("0.10")))


def _extract_notarial_guarantee(
    sale: AuctionSale,
    corpus: str,
) -> tuple[float | None, float | None]:
    structured_amount, structured_rate = _structured_notarial_guarantee(sale)
    amount_match = re.search(
        r"\bconsignation\b.{0,100}?([0-9][0-9\s.]{2,})\s*(?:€|euros?)\b",
        corpus,
        re.I,
    )
    rate_match = re.search(r"\bconsignation\b.{0,80}?(\d{1,2}(?:[,.]\d+)?)\s*%", corpus, re.I)
    amount = structured_amount or (_parse_amount(amount_match.group(1)) if amount_match else None)
    rate = structured_rate or (float(rate_match.group(1).replace(",", ".")) if rate_match else None)
    return amount, rate


def _structured_notarial_guarantee(sale: AuctionSale) -> tuple[float | None, float | None]:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    source_blocks = payload.get("source_blocks")
    if not isinstance(source_blocks, dict):
        return None, None
    value = source_blocks.get("consignation")
    if isinstance(value, bool) or value in (None, ""):
        return None, None
    if isinstance(value, (int, float, Decimal)):
        amount = float(value)
        return (amount if amount > 0 else None), None

    text = clean_text(value) or ""
    rate_match = re.search(r"(\d{1,2}(?:[,.]\d+)?)\s*%", text)
    if rate_match:
        return None, float(rate_match.group(1).replace(",", "."))
    amount = _parse_amount(text)
    return amount, None


def _parse_amount(value: str) -> float | None:
    cleaned = re.sub(r"[^0-9]", "", value)
    return float(cleaned) if cleaned else None


def _extract_notary_name(corpus: str) -> str | None:
    match = re.search(
        r"\b(?:Ma[iî]tre|Me)\s+([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÿ'’ -]{2,60})",
        corpus,
    )
    return f"Me {clean_text(match.group(1))}" if match else None


def _regulatory_source(label: str, url: str, checked_at: str) -> dict[str, str]:
    return {
        "kind": "legal_basis",
        "label": label,
        "source_name": "Source officielle",
        "url": url,
        "checked_at": checked_at,
        "ruleset_version": LEGAL_RULESET_VERSION,
    }


def _replace_quality_flag(sale: AuctionSale, flag: str, enabled: bool) -> None:
    sale.quality_flags = [value for value in sale.quality_flags if value != flag]
    if enabled:
        sale.quality_flags.append(flag)
