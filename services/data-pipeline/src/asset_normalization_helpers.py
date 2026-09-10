from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from src.asset_normalization import (
    AXIS_DEFINITIONS,
    FACTOR_AXIS,
    ScoreComponent,
)
from src.models import AuctionSale
from src.normalize import SURFACE_VALUE_PATTERN, clean_text, parse_surface


def _set_app_surface(sale: AuctionSale) -> None:
    if sale.surface_scope == "partial":
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        return
    if sale.property_type == "apartment":
        sale.app_surface_m2 = sale.carrez_surface_m2 or sale.habitable_surface_m2
        if sale.app_surface_m2 is None:
            sale.app_surface_kind = None
        else:
            sale.app_surface_kind = "carrez" if sale.carrez_surface_m2 is not None else "habitable"
        sale.surface_scope = "total" if sale.app_surface_m2 is not None else sale.surface_scope
    elif sale.property_type == "land":
        sale.app_surface_m2 = sale.land_surface_m2
        sale.app_surface_kind = "land" if sale.land_surface_m2 is not None else None
        sale.surface_scope = "land" if sale.app_surface_m2 is not None else sale.surface_scope
    elif sale.property_type == "building":
        sale.app_surface_m2 = sale.surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2
        sale.app_surface_kind = "built" if sale.app_surface_m2 is not None else None
        sale.surface_scope = "total" if sale.app_surface_m2 is not None else sale.surface_scope
    elif sale.property_type in {"commercial", "mixed"}:
        sale.app_surface_m2 = (
            sale.surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2 or sale.land_surface_m2
        )
        sale.app_surface_kind = (
            "land"
            if (
                sale.app_surface_m2 is not None
                and sale.surface_m2 is None
                and sale.habitable_surface_m2 is None
                and sale.carrez_surface_m2 is None
                and sale.land_surface_m2 is not None
            )
            else "built"
            if sale.app_surface_m2 is not None
            else None
        )
        sale.surface_scope = (
            "land"
            if sale.app_surface_kind == "land"
            else "total"
            if sale.app_surface_m2 is not None
            else sale.surface_scope
        )
    else:
        sale.app_surface_m2 = sale.habitable_surface_m2
        sale.app_surface_kind = "habitable" if sale.habitable_surface_m2 is not None else None
        sale.surface_scope = "total" if sale.app_surface_m2 is not None else sale.surface_scope


def _validate_app_surface_scope(sale: AuctionSale) -> None:
    if sale.app_surface_m2 is None:
        return
    if sale.property_type in {"house", "building"} and sale.app_surface_m2 < Decimal("20"):
        sale.surface_scope = "room_or_annex"
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        _add_quality_flag(sale, "ambiguous_surface")
    elif (
        sale.property_type in {"commercial", "mixed", "other", "unknown"}
        and sale.app_surface_m2 > Decimal("1000")
        and not _large_non_residential_surface_is_supported(sale)
    ):
        sale.surface_scope = "unknown"
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        _add_quality_flag(sale, "ambiguous_surface")
    elif sale.property_type == "land":
        sale.surface_scope = "land"


def _large_non_residential_surface_is_supported(sale: AuctionSale) -> bool:
    context = clean_text(" ".join(filter(None, (sale.surface_evidence, sale.description, sale.raw_text)))) or ""
    if not context:
        return False
    if re.search(r"\b(?:cadastr|parcelle|terrain|contenance)\b", context, re.I) and not re.search(
        r"\b(?:surface\s+totale|b[âa]timent|stabulation|hangar|stockage|salle\s+de\s+traite|"
        r"local\s+(?:commercial|industriel)|entrep[oô]t|atelier)\b",
        context,
        re.I,
    ):
        return False
    return bool(
        re.search(
            r"\b(?:surface\s+totale|b[âa]timent|stabulation|hangar|stockage|salle\s+de\s+traite|"
            r"local\s+(?:commercial|industriel)|entrep[oô]t|atelier)\b",
            context,
            re.I,
        )
    )


def _flag_ambiguous_surface(sale: AuctionSale) -> None:
    surface_values = {
        value
        for value in (sale.habitable_surface_m2, sale.carrez_surface_m2, sale.land_surface_m2)
        if value is not None
    }
    if len(surface_values) > 1 and sale.property_type not in {"house", "building"}:
        _add_quality_flag(sale, "ambiguous_surface")
    if sale.app_surface_m2 is None and sale.surface_m2 is not None:
        _add_quality_flag(sale, "ambiguous_surface")


def _extract_count(text: str, patterns: tuple[str, ...]) -> int | None:
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            value = match.group(1)
            return int(value) if value.isdigit() else _number_word_to_int(value)
    return None


def _extract_built_surface(text: str, sale: AuctionSale | None = None) -> Decimal | None:
    patterns = (
        rf"superficie\s+au\s+sol\s+(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"d['’]une\s+superficie\s+au\s+sol\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\b(?:appartement|maison|villa|immeuble|b[âa]timent|local|hangar)\b.{{0,80}}?"
        rf"d['’]une\s+superficie\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\b(?:ensemble\s+immobilier|propri[ée]t[ée])"
        rf"(?:\s+de\s+[0-9]+\s+pi[eè]ces?)?\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"d['’]une\s+superficie\s+d['’]environ\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"surface\s+au\s+sol\s+(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\btotal\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m(?:2|²|\*)",
    )
    if sale is not None and sale.source_name == "licitor":
        patterns = (*patterns, rf"\bde\s+{SURFACE_VALUE_PATTERN}\s*²\b")
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.S)
        if not match:
            continue
        value = _parse_surface_decimal(match.group(1))
        if value and not _surface_false_positive(text, match.start(), match.end()):
            if sale is not None:
                _set_surface_evidence(sale, "built_surface_text", _evidence(text, match.start(), match.end()))
            return value

    short_pattern = (
        rf"\b(?:appartement|maison|villa|immeuble|b[âa]timent|local|hangar)\s+"
        rf"(?:d['’]environ\s+|de\s+){SURFACE_VALUE_PATTERN}\s*m(?:2|²)"
    )
    candidates: list[tuple[Decimal, re.Match[str]]] = []
    for match in re.finditer(short_pattern, text, re.I | re.S):
        value = _parse_surface_decimal(match.group(1))
        if value and not _surface_false_positive(text, match.start(), match.end()):
            candidates.append((value, match))
    if candidates and len({value for value, _ in candidates}) == 1:
        value, match = candidates[0]
        if sale is not None:
            _set_surface_evidence(sale, "built_surface_text", _evidence(text, match.start(), match.end()))
        return value
    return None


def _infer_rooms_count(text: str, sale: AuctionSale) -> int | None:
    if re.search(r"\bstudio\b|\bT\s*1\b|\btype\s*1\b", text, re.I):
        return 1
    if not sale.bedrooms_count or sale.property_type not in {"house", "apartment", "building"}:
        return None
    living_rooms = 0
    if re.search(r"\bs[ée]jour\b|\bsalon\b|\bpi[eè]ce\s+principale\b", text, re.I):
        living_rooms = 1
    if re.search(r"\bsalle\s+[àa]\s+manger\b", text, re.I):
        living_rooms += 1
    extra_rooms = 0
    match = re.search(
        r"\b(?:mezzanine|combles?|annexe)\s+(?:avec|comprenant)\s+((?:une|deux|trois|[1-9]))\s+pi[eè]ces?\b", text, re.I
    )
    if match:
        extra_rooms = _number_word_to_int(match.group(1)) or 0
    if living_rooms or extra_rooms:
        return sale.bedrooms_count + max(living_rooms, 1) + extra_rooms
    return None


def _number_word_to_int(value: str) -> int | None:
    lowered = value.lower()
    mapping = {
        "une": 1,
        "un": 1,
        "deux": 2,
        "trois": 3,
        "quatre": 4,
        "cinq": 5,
        "six": 6,
        "sept": 7,
        "huit": 8,
        "neuf": 9,
        "dix": 10,
    }
    if lowered in mapping:
        return mapping[lowered]
    if lowered.isdigit():
        return int(lowered)
    return None


def _sale_text(sale: AuctionSale) -> str:
    return clean_text(" ".join(filter(None, [sale.title, sale.description, sale.risk_notes, sale.raw_text]))) or ""


def _risk_source_text(sale: AuctionSale) -> str:
    return clean_text(" ".join(filter(None, [sale.title, sale.description, sale.raw_text]))) or ""


def _sale_type_context(sale: AuctionSale) -> dict[str, object]:
    text = _sale_text(sale)
    if not text:
        return {}
    non_judicial = re.search(
        r"\bvente\s+volontaire\b|\bvente\s+notariale\b|\bvente\s+notariale\s+interactive\b|"
        r"\bimmo[-\s]?interactif\b|\ben\s+ligne\s+sur\s+immo[-\s]?interactif\b|"
        r"\boffice\s+notarial\b|\bnotaire\b",
        text,
        re.I,
    )
    if non_judicial:
        return {
            "status": "non_judicial",
            "statement": "Type de vente : vente volontaire/notariale interactive, à ne pas assimiler à une adjudication judiciaire.",
            "evidence": _evidence(text, non_judicial.start(), non_judicial.end()),
            "confidence": 0.82,
        }
    explicit_judicial = re.search(
        r"\btribunal\s+judiciaire\b|\bTJ\s+[A-Za-zÀ-ÿ' -]+\b|"
        r"\badjudication\b|\bsaisie\s+immobili[èe]re\b|"
        r"\bcahier\s+des\s+conditions\s+de\s+vente\b",
        text,
        re.I,
    )
    if explicit_judicial:
        return {
            "status": "judicial",
            "statement": "Type de vente : contexte judiciaire ou adjudication identifié.",
            "evidence": _evidence(text, explicit_judicial.start(), explicit_judicial.end()),
            "confidence": 0.78,
        }
    return {}


def _text_has_works_signal(text: str) -> bool:
    return bool(
        re.search(
            r"\b(?:pr[ée]voir|prevoir)\s+(?:des\s+)?travaux\b|"
            r"\btravaux\s+(?:de\s+)?r[ée]novation\b|"
            r"\b[àa]\s+r[ée]nover\b|\ba\s+renover\b|"
            r"\br[ée]novation\s+[àa]\s+pr[ée]voir\b|"
            r"\bmauvais\s+[ée]tat\b|\bd[ée]grad[ée]s?\b|\bv[ée]tuste\b",
            text,
            re.I,
        )
    )


def _surface_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 20) : min(len(text), end + 30)]
    return bool(
        re.search(
            r"\bkwh(?:ep)?\b|kg\s*co2|m(?:2|²)\s*/\s*(?:an|year)",
            context,
            re.I,
        )
    )


def _land_surface_false_positive(text: str, match: re.Match[str], kind: str) -> bool:
    if kind != "land_surface_m2":
        return False
    matched_text = text[match.start() : match.end()]
    value_start = match.start(1)
    value_end = match.end(1)
    before_value = text[max(match.start(), value_start - 45) : value_start]
    after_value = text[value_end : min(len(text), value_end + 25)]
    return bool(
        re.search(r"\b(?:maison|villa|appartement|immeuble|b[âa]timent|local|hangar)\s+de\s*$", before_value, re.I)
        or re.search(
            rf"\b(?:maison|villa|appartement|immeuble|b[âa]timent|local|hangar)\b.{{0,60}}?"
            rf"\b(?:de|d['’]une\s+surface\s+de|d['’]une\s+superficie\s+de)\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
            matched_text,
            re.I | re.S,
        )
        or re.search(
            r"\b(?:surface|superficie)\s+(?:habitable|carrez)\b|\bloi\s+carrez\b",
            before_value,
            re.I,
        )
        or re.search(r"\bhabitables?\b", after_value, re.I)
    )


def _living_surface_false_positive(text: str, start: int, end: int, kind: str) -> bool:
    if kind == "land_surface_m2":
        return False
    context = text[max(0, start - 45) : start]
    return bool(
        re.search(r"\b(?:terrain|parcelle|jardin|garage|cave|parking|stationnement|d[ée]pendance)\b", context, re.I)
    )


def _parse_surface_decimal(value: str) -> Decimal | None:
    return parse_surface(value)


def _set_surface_evidence(sale: AuctionSale, source: str, evidence: str | None) -> None:
    if sale.surface_source is None:
        sale.surface_source = source
    if sale.surface_confidence is None:
        sale.surface_confidence = Decimal("0.8") if evidence else Decimal("0.55")
    if evidence and sale.surface_evidence is None:
        sale.surface_evidence = evidence


def _normalize_document_type(document_type: str | None, source_kind: str) -> str:
    raw = (clean_text(document_type) or "").lower().replace("-", "_").replace(" ", "_")
    if source_kind == "sale_text" and raw in {"", "none", "null"}:
        return "source_listing"
    aliases = {
        "pv_descriptif": "pv_huissier",
        "pvd": "pv_huissier",
        "pv": "proces_verbal",
        "constat": "pv_huissier",
        "diagnostics": "diagnostics_techniques",
        "diagnostic": "diagnostics_techniques",
        "avis_simplifie": "annonce_vente",
        "avis_simplifié": "annonce_vente",
        "insertion_legale": "annonce_vente",
        "insertion_légale": "annonce_vente",
        "cahier_conditions": "cahier_conditions_vente",
        "ccv": "cahier_conditions_vente",
    }
    return aliases.get(raw, raw or ("source_listing" if source_kind == "sale_text" else "pdf"))


def _risk_context_decision(
    label: str,
    context: str,
    *,
    source_kind: str,
    document_type: str,
) -> dict[str, object]:
    if not context:
        return {"accepted": False, "confidence": 0.0}
    if _is_generic_context(context, label, document_type):
        return {"accepted": False, "confidence": 0.0}

    if label == "DPE":
        accepted = _dpe_context_is_risky(context)
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.84"), source_kind, document_type, accepted),
            "severity": 2,
        }
    if label in {"amiante", "plomb", "termites"}:
        accepted = _hazard_context_is_positive(label, context)
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.86"), source_kind, document_type, accepted),
            "severity": 3,
        }
    if label == "travaux":
        severity = _works_severity(context)
        accepted = severity > 0
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.78"), source_kind, document_type, accepted),
            "severity": severity or 4,
        }
    if label == "servitude":
        accepted = _servitude_context_is_specific(context, document_type)
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.8"), source_kind, document_type, accepted),
            "severity": 2,
        }
    if label == "copropriété":
        accepted = _copro_context_is_specific(context, document_type)
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.72"), source_kind, document_type, accepted),
            "severity": 1,
        }
    if label == "occupation":
        accepted = _occupation_context_is_specific(context)
        return {
            "accepted": accepted,
            "confidence": _contextual_confidence(Decimal("0.82"), source_kind, document_type, accepted),
            "severity": 5,
        }
    return {"accepted": False, "confidence": 0.0}


def _contextual_confidence(base: Decimal, source_kind: str, document_type: str, accepted: bool) -> float:
    if not accepted:
        return 0.0
    confidence = base
    if source_kind == "pdf":
        confidence += Decimal("0.04")
    if document_type in {"pv_huissier", "diagnostics_techniques", "annonce_vente"}:
        confidence += Decimal("0.04")
    if document_type in {"cahier_conditions_vente", "conditions_vente", "pdf"}:
        confidence -= Decimal("0.05")
    return float(max(Decimal("0"), min(Decimal("0.96"), confidence)))


def _is_generic_context(context: str, label: str, document_type: str) -> bool:
    lowered = context.lower()
    if re.search(
        r"renseignements\s+ci-dessus.{0,80}servitudes?.{0,80}sans\s+aucune\s+garantie|"
        r"d[ée]signation\s+de\s+l['’]immeuble.{0,120}servitudes?.{0,120}proc[èe]s\s+verbal|"
        r"bon\s+ou\s+mauvais\s+[ée]tat\s+de\s+l['’]immeuble|"
        r"pour\s+les\s+parties\s+communes\s+des\s+immeubles\s+soumis",
        lowered,
        re.I,
    ):
        return True
    if label in {"amiante", "plomb", "termites"} and _diagnostic_context_is_only_inventory(lowered):
        return True
    if label in {"copropriété", "servitude", "travaux"} and re.search(
        r"\b(?:si|dans\s+le\s+cas\s+(?:o[uù]|on|\w{1,3}\s+\w?immeuble)|dans\s+l['’]hypoth[eè]se|le\s+cas\s+[ée]ch[ée]ant)\b"
        r".{0,120}\b(?:copropri[ée]t[ée]|servitudes?|travaux|lotissement)\b",
        lowered,
        re.I,
    ):
        return True
    generic_legal = bool(
        re.search(
            r"\b(?:article|chapitre|conditions?\s+pour\s+ench[ée]rir|r[èe]glement\s+int[ée]rieur|"
            r"l['’]adjudicataire|l['’]acqu[ée]reur|frais\s+de\s+vente|distribution\s+du\s+prix|"
            r"devra\s+notifier|sera\s+tenu|se\s+reporter|s['’]imposeront)\b",
            lowered,
            re.I,
        )
    )
    if not generic_legal:
        return False
    if document_type in {"pv_huissier", "diagnostics_techniques", "annonce_vente", "source_listing"}:
        return False
    return not _has_specific_property_assertion(lowered, label)


def _diagnostic_context_is_only_inventory(context: str) -> bool:
    return bool(
        re.search(
            r"(?:diagnostics?|annexes?|pi[eè]ces?).{0,140}"
            r"(?:amiante|plomb|termites).{0,140}"
            r"(?:diagnostics?|annexes?|constat|rep[ée]rage|exposition|performance\s+[ée]nerg[ée]tique)",
            context,
            re.I,
        )
    ) and not re.search(
        r"pr[ée]sence|positif|d[ée]tect[ée]|rep[ée]r[ée]|contient|contiennent|infestation", context, re.I
    )


def _has_specific_property_assertion(context: str, label: str) -> bool:
    if label == "copropriété":
        return bool(
            re.search(
                r"(?:soumis|d[ée]pend|d[ée]nomm[ée]|lot\s+(?:num[ée]ro|n[°o])|tanti[eè]mes).{0,90}"
                r"copropri[ée]t[ée]",
                context,
                re.I,
            )
        )
    if label == "servitude":
        return _servitude_context_is_specific(context, "cahier_conditions_vente")
    if label == "travaux":
        return _works_severity(context) > 0
    return False


def _risk_match_is_negated(text: str, start: int, end: int, label: str) -> bool:
    if label == "occupation":
        return False
    before = text[max(0, start - 90) : start].lower()
    context = text[max(0, start - 90) : min(len(text), end + 90)].lower()
    if label == "termites":
        # A negative finding in one room must not suppress another room's finding.
        boundaries = r"[.;\n]|\bmais\b|\ben\s+revanche\b"
        before = re.split(boundaries, before, flags=re.I)[-1]
        after = re.split(boundaries, text[end : end + 90], flags=re.I)[0]
        context = before + text[start:end].lower() + after.lower()
    negation_patterns = (
        r"aucun(?:e|es|s)?\s+\w{0,25}$",
        r"absence\s+(?:de|d['’])\s*\w{0,25}$",
        r"pas\s+de\s+\w{0,25}$",
        r"sans\s+\w{0,25}$",
        r"n['’]est\s+pas\s+soumis.{0,45}$",
    )
    if any(re.search(pattern, before, re.I) for pattern in negation_patterns):
        return True
    label_patterns = {
        "servitude": r"aucune\s+servitude|absence\s+de\s+servitude|servitude\s+non\s+mentionn[ée]e",
        "copropriété": r"pas\s+soumis\s+au\s+r[ée]gime\s+de\s+la\s+copropri[ée]t[ée]|non\s+soumis\s+.*copropri[ée]t[ée]",
        "amiante": r"absence\s+d['’]amiante|sans\s+amiante|amiante\s*:\s*non",
        "plomb": (
            r"absence\s+de\s+plomb|sans\s+plomb|plomb\s*:\s*non|crep\s*:\s*non|"
            r"ne\s+constate\s+pas.{0,120}rev[êe]tements?\s+d[ée]grad[ée]s?.{0,80}plomb|"
            r"pas\s+de\s+rev[êe]tements?\s+d[ée]grad[ée]s?.{0,80}plomb|"
            r"ne\s*d[ée]passe\s*pas.{0,80}(?:plafond|seuil)|"
            r"quantit[ée].{0,80}ne\s*d[ée]passe\s*pas.{0,80}(?:plafond|seuil)|"
            r"inf[ée]rieur(?:e)?\s+(?:au|aux)\s+(?:plafond|seuil)"
        ),
        "termites": r"absence\s+de\s+termites?|sans\s+termites?|termites?\s*:\s*non|non\s+termite",
        "travaux": r"aucun\s+travaux|pas\s+de\s+travaux|sans\s+travaux",
    }
    pattern = label_patterns.get(label)
    if pattern and re.search(pattern, context, re.I):
        return True
    if label in {"amiante", "plomb", "termites"} and re.search(
        r"(?:n['’]a\s+pas\s+[ée]t[ée]\s+(?:rep[ée]r[ée]|constat[ée]|d[ée]tect[ée])|"
        r"non\s+(?:d[ée]tect[ée]|rep[ée]r[ée]|concern[ée])|"
        r"il\s+n['’]a\s+pas\s+[ée]t[ée]\s+rep[ée]r[ée])",
        context,
        re.I,
    ):
        return True
    return False


def _hazard_context_is_positive(label: str, context: str) -> bool:
    if label == "termites":
        # The statutory report title describes its scope, not its conclusion.
        evidence = re.sub(
            r"[ée]tat\s+relatif\s+[àa]\s+la\s+pr[ée]sence\s+de\s+termites?",
            "état termites",
            context,
            flags=re.I,
        )
        for statement in re.split(r"[.;\n]|\bmais\b|\ben\s+revanche\b", evidence, flags=re.I):
            if re.search(
                r"\bsi\b.{0,60}termites?|"
                r"termites?.{0,60}ne\s+(?:peut|peuvent)\s+(?:pas\s+)?[êe]tre\s+exclu",
                statement,
                re.I,
            ):
                # Conditional instructions and inaccessible areas establish no positive finding.
                continue
            # A regulatory reminder is conditional, not a finding in this building.
            statement = re.sub(
                r"(?:dans\s+le\s+cas\s+de|en\s+cas\s+de)\s+"
                r"(?:la\s+)?(?:pr[ée]sence|infestation)\s+de\s+termites?[^,]*",
                "rappel conditionnel",
                statement,
                flags=re.I,
            )
            if re.search(
                r"(?:absence|aucun[es]*|pas)\s+(?:de\s+|d['’])?"
                r"(?:indices?\s+(?:de\s+|d['’]))?(?:infestation\s+de\s+)?termites?",
                statement,
                re.I,
            ) or _risk_match_is_negated(statement, 0, len(statement), label):
                continue
            if re.search(
                r"(?:pr[ée]sence|indices?|infestation|attaque).{0,100}termites?|"
                r"termites?.{0,100}(?:pr[ée]sents?|positif|d[ée]tect[ée]s?|rep[ée]r[ée]s?)",
                statement,
                re.I,
            ):
                return True
        return False
    if _risk_match_is_negated(context, 0, len(context), label):
        return False
    patterns = {
        "amiante": (
            r"(?:pr[ée]sence|positif|d[ée]tect[ée]|rep[ée]r[ée]|contient|contiennent).{0,100}amiante|"
            r"amiante.{0,100}(?:pr[ée]sent|positif|d[ée]tect[ée]|rep[ée]r[ée]|contient|contiennent)"
        ),
        "plomb": (
            r"(?:pr[ée]sence|positif|concentration|rev[êe]tements?).{0,100}plomb|"
            r"plomb.{0,100}(?:pr[ée]sent|positif|d[ée]tect[ée]|sup[ée]rieur|classe\s*[1-4])"
        ),
        "termites": (
            r"(?:pr[ée]sence|indices?|infestation|attaque).{0,100}termites?|"
            r"termites?.{0,100}(?:pr[ée]sence|indices?|infestation|attaque)"
        ),
    }
    return bool(re.search(patterns[label], context, re.I))


def _works_severity(context: str) -> int:
    if re.search(
        r"gros\s+travaux|travaux\s+(?:lourds|importants|structurels|de\s+remise\s+en\s+[ée]tat|"
        r"n[ée]cessaires?)|ruine|insalubre|hors\s+d['’]eau|effondr|"
        r"infiltrations?\s+d['’]eau|d[ée]g[aâ]t\s+des\s+eaux",
        context,
        re.I,
    ):
        return 5
    if re.search(
        r"(?:pr[ée]voir|prevoir)\s+(?:des\s+)?travaux|"
        r"travaux\s+(?:[àa]\s+pr[ée]voir|de\s+r[ée]novation)|"
        r"[àa]\s+r[ée]nover|a\s+renover|"
        r"r[ée]novation\s+(?:compl[eè]te|importante|[àa]\s+pr[ée]voir)",
        context,
        re.I,
    ):
        return 4
    if re.search(
        r"mauvais\s+[ée]tat|fortement\s+d[ée]grad[ée]|d[ée]gradations?|v[ée]tuste|"
        r"rouill[ée]|moisi|fissures?|hors\s+service|arrach[ée]|affaiss[ée]|"
        r"travaux\s+futurs|remise\s+en\s+[ée]tat",
        context,
        re.I,
    ):
        return 4
    if re.search(r"rafra[iî]chissement|r[ée]novation\s+[àa]\s+pr[ée]voir", context, re.I):
        return 3
    return 0


def _servitude_context_is_specific(context: str, document_type: str) -> bool:
    if _risk_match_is_negated(context, 0, len(context), "servitude"):
        return False
    if re.search(
        r"\bservitudes?\s+(?:de\s+passage|d['’]utilit[ée]\s+publique|conventionnelle|grevant|active|passive)\b",
        context,
        re.I,
    ):
        return True
    if re.search(r"\b(?:grev[ée]|b[ée]n[ée]ficie|affect[ée]|supporte).{0,90}\bservitudes?\b", context, re.I):
        return True
    if document_type in {"cahier_conditions_vente", "conditions_vente"} and re.search(
        r"\bservitudes?\s+(?:suivantes?|mentionn[ée]es?|existant|publi[ée]es?)\b",
        context,
        re.I,
    ):
        return True
    return False


def _copro_context_is_specific(context: str, document_type: str) -> bool:
    if _risk_match_is_negated(context, 0, len(context), "copropriété"):
        return False
    if re.search(r"charges?\s+de\s+copropri[ée]t[ée]\s+(?:impay[ée]es?|dues?|annuelles?)", context, re.I):
        return True
    if re.search(
        r"(?:soumis|d[ée]pend|fait\s+partie|d[ée]nomm[ée]|ensemble\s+immobilier).{0,100}"
        r"copropri[ée]t[ée]",
        context,
        re.I,
    ):
        return True
    if re.search(r"\blot\s+(?:num[ée]ro|n[°o])\b.{0,140}\b(?:tanti[eè]mes|parties\s+communes)\b", context, re.I):
        return True
    return document_type in {"annonce_vente", "source_listing", "pv_huissier"} and bool(
        re.search(r"\b(?:tanti[eè]mes|syndic|parties\s+communes)\b", context, re.I)
    )


def _occupation_context_is_specific(context: str) -> bool:
    return bool(
        re.search(
            r"occup[ée].{0,80}(?:sans\s+bail|sans\s+droit\s+ni\s+titre|par\s+les?\s+propri[ée]taires?|"
            r"locataire|preneur)|"
            r"(?:bail|locataire|preneur|loyer).{0,100}(?:en\s+cours|actuel|occup|sign[ée])|"
            r"squatt",
            context,
            re.I,
        )
    )


def _dpe_context_is_risky(context: str) -> bool:
    return bool(
        re.search(
            r"\b(?:classe\s*)?[FG]\b|dpe\s*[:=-]?\s*[FG]\b|passoire|d[ée]favorable|"
            r"consommation\s+(?:excessive|tr[èe]s\s+[ée]lev[ée]e)|[ée]nergivore",
            context,
            re.I,
        )
    )


def _risk_occurrence_rank(occurrence: dict[str, Any]) -> tuple[int, float, int]:
    evidence_json = occurrence.get("evidence_json") if isinstance(occurrence.get("evidence_json"), dict) else {}
    document_type = occurrence.get("document_type") or evidence_json.get("document_type")
    return (
        int(occurrence.get("severity") or 1),
        float(occurrence.get("confidence") or 0),
        _document_type_weight(str(document_type or "")),
    )


def _document_type_weight(document_type: str) -> int:
    return {
        "diagnostics_techniques": 6,
        "pv_huissier": 6,
        "pv_notaire": 5,
        "proces_verbal": 5,
        "annonce_vente": 4,
        "source_listing": 3,
        "cahier_conditions_vente": 3,
        "conditions_vente": 2,
        "pdf": 1,
    }.get(document_type, 0)


def _document_context_label(document_type: object | None) -> str:
    value = str(document_type or "")
    return {
        "source_listing": "page de l'annonce",
        "annonce_vente": "annonce ou insertion légale",
        "pv_huissier": "PV descriptif / commissaire de justice",
        "pv_notaire": "PV de notaire",
        "proces_verbal": "procès-verbal",
        "cahier_conditions_vente": "cahier des conditions de vente",
        "conditions_vente": "conditions de vente",
        "diagnostics_techniques": "diagnostics techniques",
        "bail": "bail ou document d'occupation",
        "procedure_saisie": "procédure de saisie",
        "cadastre": "cadastre ou plan",
        "pdf": "document PDF",
    }.get(value, "document source")


def _risk_reasoning(label: str, occurrence: dict[str, Any]) -> str:
    document_context = _document_context_label(occurrence.get("document_type"))
    matched_terms = occurrence.get("matched_terms") or []
    term = f" Terme déclencheur : {matched_terms[0]}." if isinstance(matched_terms, list) and matched_terms else ""
    specific = {
        "travaux": "La mention décrit un désordre, une dégradation ou une remise en état concernant le bien.",
        "amiante": "La mention indique une présence, un repérage positif ou un matériau contenant de l'amiante.",
        "plomb": "La mention indique une présence ou concentration de plomb, pas seulement l'existence d'un CREP.",
        "termites": "La mention indique une présence, des indices ou une infestation de termites.",
        "DPE": "La mention rattache le bien à une classe énergétique défavorable ou à une consommation excessive.",
        "servitude": "La mention décrit une servitude précise grevant ou concernant le bien.",
        "copropriété": "La mention rattache le lot à un régime de copropriété ou à des tantièmes/charges.",
        "occupation": "La mention décrit une occupation, un bail, un locataire ou une occupation sans droit.",
    }.get(label, "La mention est retenue parce qu'elle est suffisamment contextualisée.")
    return f"{specific} Source analysée : {document_context}.{term}"


def _risk_why_it_matters(label: str, severity: int) -> str:
    impact = {
        "travaux": "Peut créer un budget travaux, un délai de revente et une incertitude sur la marge.",
        "amiante": "Peut imposer diagnostics complémentaires, retrait ou précautions en cas de travaux.",
        "plomb": "Peut contraindre les travaux et la location, notamment dans les logements anciens.",
        "termites": "Peut signaler un risque structurel ou un coût de traitement.",
        "DPE": "Peut limiter la location, augmenter les travaux énergétiques et réduire la liquidité.",
        "servitude": "Peut limiter l'usage, l'accès, la constructibilité ou la revente.",
        "copropriété": "Impose de vérifier charges, règlement, travaux votés et situation du syndicat.",
        "occupation": "Peut retarder la jouissance, la revente ou la relocation.",
    }.get(label, "Peut modifier le coût, le délai ou la liquidité du projet.")
    return impact


def _risk_status(label: str, occurrence: dict[str, Any]) -> str:
    confidence = float(occurrence.get("confidence") or 0)
    document_type = str(occurrence.get("document_type") or "")
    if label in {"amiante", "plomb", "termites", "DPE"} and document_type == "diagnostics_techniques":
        return "confirmed" if confidence >= 0.78 else "probable"
    if label == "travaux":
        return "to_quantify" if confidence >= 0.7 else "probable"
    if label in {"occupation", "servitude"}:
        return "to_verify" if confidence < 0.88 else "confirmed"
    if document_type in {"cahier_conditions_vente", "conditions_vente"}:
        return "property_specific_clause"
    return "confirmed" if confidence >= 0.82 else "probable"


def _source_status(occurrence: dict[str, Any]) -> str:
    document_type = str(occurrence.get("document_type") or "")
    if document_type in {"diagnostics_techniques", "pv_huissier", "pv_notaire", "proces_verbal"}:
        return "source_probante"
    if document_type in {"cahier_conditions_vente", "conditions_vente"}:
        return "source_juridique_a_recontextualiser"
    if document_type in {"annonce_vente", "source_listing"}:
        return "source_de_presentation"
    return "source_a_identifier"


def _risk_decision_chain(label: str, occurrence: dict[str, Any]) -> list[dict[str, str]]:
    document_type = str(occurrence.get("document_type") or "")
    matched_terms = occurrence.get("matched_terms") if isinstance(occurrence.get("matched_terms"), list) else []
    trigger = str(matched_terms[0]) if matched_terms else label
    return [
        {
            "step": "document",
            "decision": _document_context_label(document_type),
        },
        {
            "step": "indice",
            "decision": f"Terme ou expression repéré : {trigger}.",
        },
        {
            "step": "contexte",
            "decision": _risk_reasoning(label, occurrence),
        },
        {
            "step": "impact",
            "decision": _risk_why_it_matters(label, int(occurrence.get("severity") or 1)),
        },
        {
            "step": "action",
            "decision": _risk_next_action(label),
        },
    ]


def _risk_verification_priority(label: str, severity: int) -> str:
    if severity >= 5 or label == "occupation":
        return "bloquant_avant_enchere"
    if label in {"travaux", "amiante", "plomb", "termites", "servitude"}:
        return "a_verifier_avant_prix_plafond"
    return "a_controler_dans_lecture_complete"


def _risk_next_action(label: str) -> str:
    return {
        "travaux": "Chiffrer les travaux avec une marge de sécurité avant de fixer le prix plafond.",
        "amiante": "Relire le repérage amiante et vérifier si un retrait ou des précautions travaux sont nécessaires.",
        "plomb": "Relire le CREP et vérifier si la présence de plomb crée une obligation ou un coût.",
        "termites": "Relire l'état termites et vérifier le périmètre exact de l'infestation ou des indices.",
        "DPE": "Vérifier la classe énergétique, les interdictions locatives éventuelles et le budget de rénovation.",
        "servitude": "Identifier la servitude exacte et son impact sur l'usage, l'accès ou la revente.",
        "copropriété": "Contrôler charges, règlement, travaux votés et situation du syndicat.",
        "occupation": "Confirmer le titre d'occupation, le bail, le loyer et le délai de libération.",
    }.get(label, "Relire la pièce source complète et valider l'impact avant enchère.")


def _risk_confidence(label: str, context: str, source_kind: str) -> float:
    confidence = Decimal("0.72")
    if source_kind == "pdf":
        confidence += Decimal("0.08")
    if label in {"amiante", "plomb", "termites"} and re.search(
        r"diagnostic|constat|rapport|rep[ée]rage", context, re.I
    ):
        confidence += Decimal("0.08")
    if label == "servitude" and re.search(r"servitude\s+(?:de\s+passage|publique|grev|liee|li[ée]e)", context, re.I):
        confidence += Decimal("0.08")
    if label == "travaux" and re.search(r"ruine|hors\s+d['’]eau|d[ée]g[aâ]ts?|r[ée]novation|v[ée]tuste", context, re.I):
        confidence += Decimal("0.08")
    return float(max(Decimal("0"), min(Decimal("0.96"), confidence)))


def _risk_severity(label: str) -> int:
    return {
        "occupation": 5,
        "amiante": 3,
        "plomb": 3,
        "termites": 3,
        "travaux": 4,
        "servitude": 2,
        "copropriété": 1,
        "DPE": 1,
    }.get(label, 1)


def _evidence(text: str, start: int, end: int, *, window: int = 120) -> str:
    return clean_text(text[max(0, start - 80) : min(len(text), end + window)]) or ""


def _factor_status(delta: Decimal) -> str:
    if delta > 0:
        return "favorable"
    if delta < 0:
        return "vigilance"
    return "neutre"


def _component_axis(name: str) -> str:
    normalized = name.lower()
    return FACTOR_AXIS.get(normalized, "analysis_confidence")


def _axis_label(axis: str) -> str:
    definition = AXIS_DEFINITIONS.get(axis)
    return str(definition.get("label")) if definition else "Analyse"


def _component_question(name: str) -> str:
    axis = _component_axis(name)
    definition = AXIS_DEFINITIONS.get(axis)
    if definition:
        return str(definition.get("question"))
    return "Que signifie ce facteur pour la décision d'enchérir ?"


def _component_decision(component: ScoreComponent, delta: Decimal) -> str:
    if delta > 0:
        prefix = "Signal favorable"
    elif delta < 0:
        prefix = "Point de vigilance"
    else:
        prefix = "Signal neutre"
    return f"{prefix} : {component.reason}."


def _component_facts(component: ScoreComponent) -> list[dict[str, Any]]:
    facts = []
    if component.raw_value is not None:
        facts.append(
            {
                "status": "retenu",
                "statement": _component_raw_fact_label(component),
                "confidence": float(component.confidence),
            }
        )
    if component.evidence:
        facts.append(
            {
                "status": "preuve",
                "statement": component.evidence,
                "confidence": float(component.confidence),
            }
        )
    for ref in component.evidence_refs[:2]:
        if not isinstance(ref, dict):
            continue
        facts.append(
            _compact_dict(
                {
                    "status": "preuve",
                    "statement": ref.get("excerpt") or ref.get("label"),
                    "document_label": ref.get("document_label"),
                    "document_type": ref.get("document_type"),
                    "page_number": ref.get("page_number"),
                    "confidence": ref.get("confidence"),
                }
            )
        )
    return [_compact_dict(_json_safe(item)) for item in facts]


def _proof_level(component: ScoreComponent) -> str:
    if component.evidence_refs:
        document_types = {
            str(ref.get("document_type") or "") for ref in component.evidence_refs if isinstance(ref, dict)
        }
        if document_types & {"diagnostics_techniques", "pv_huissier", "pv_notaire", "proces_verbal"}:
            return "preuve forte"
        return "preuve sourcée"
    if component.evidence:
        return "preuve textuelle"
    if component.raw_value is not None:
        return "donnée structurée"
    return "à confirmer"


def _axis_reading(
    axis: str,
    delta: Decimal,
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
    sale: AuctionSale,
) -> str:
    if axis == "financial_attractiveness":
        return (
            "La mise à prix semble créer une marge de sécurité."
            if delta > 0
            else "La lecture financière reste fragile sans surface ou prix/m² favorable."
        )
    if axis == "asset_quality":
        technical = [risk.get("risk_label") for risk in risks if risk.get("risk_type") == "physical"]
        if technical:
            return f"Qualité à vérifier : {', '.join(str(item) for item in technical[:4])}."
        if not sale.documents:
            return "Aucun risque technique sourcé, mais les pièces officielles manquent pour conclure."
        return "Aucun risque technique contextualisé majeur n'est retenu."
    if axis == "legal_security":
        legal = [risk.get("risk_label") for risk in risks if risk.get("risk_type") == "legal"]
        if legal:
            return f"Contraintes juridiques à clarifier : {', '.join(str(item) for item in legal[:4])}."
        if not sale.documents:
            return "Aucune contrainte juridique sourcée, mais le statut doit être confirmé dans les pièces."
        return "Pas de contrainte juridique forte détectée dans les faits structurés."
    if axis == "liquidity_resale":
        return "La sortie dépend surtout du type de bien et de la profondeur du marché local."
    if axis == "analysis_confidence":
        if contradictions:
            return "La confiance est abaissée par des incohérences à lever."
        return "La confiance dépend de la couverture documentaire et de la qualité OCR/extraction."
    return "Lecture synthétique de l'axe."


def _diagnostic_question_detail(sale: AuctionSale, risks: list[dict[str, Any]]) -> str:
    labels = [
        str(risk.get("risk_label"))
        for risk in risks
        if risk.get("risk_label") in {"amiante", "plomb", "termites", "DPE"}
    ]
    if labels:
        return "Diagnostics à relire : " + ", ".join(labels[:4]) + "."
    if not sale.documents:
        return "Diagnostics non disponibles dans les pièces structurées."
    return "Aucun diagnostic défavorable contextualisé n'est retenu à ce stade."


def _classify_document_label(label: str, url: str = "") -> str:
    text = f"{label} {url}".lower()
    if re.search(r"diagnostic|dpe|amiante|plomb|termites|crep", text):
        return "diagnostics_techniques"
    if re.search(r"cahier|conditions?.{0,20}vente|ccv", text):
        return "cahier_conditions_vente"
    if re.search(r"huissier|commissaire|descriptif|proc[eè]s[-\s]?verbal|pv", text):
        return "pv_huissier"
    if re.search(r"notaire|notarial", text):
        return "pv_notaire"
    if re.search(r"annonce|avis|insertion", text):
        return "annonce_vente"
    return "pdf"


def _risk_fact_status(confidence: float) -> str:
    if confidence >= 0.82:
        return "confirmé"
    if confidence >= 0.62:
        return "probable"
    return "à confirmer"


def _risk_question(label: str) -> str:
    return {
        "travaux": "La mention décrit-elle un coût réel à budgéter pour ce bien ?",
        "amiante": "Le diagnostic confirme-t-il une présence imposant précaution ou travaux ?",
        "plomb": "Le CREP confirme-t-il une présence de plomb ayant un impact d'usage ou de travaux ?",
        "termites": "Le diagnostic confirme-t-il une infestation ou des indices actifs ?",
        "DPE": "La performance énergétique limite-t-elle la location ou la revente ?",
        "servitude": "La servitude limite-t-elle l'accès, l'usage ou la valeur du bien ?",
        "copropriété": "La copropriété crée-t-elle charges, travaux votés ou contraintes à intégrer ?",
        "occupation": "L'occupation retarde-t-elle la jouissance ou la revente ?",
    }.get(label, "Ce signal modifie-t-il le coût, le délai ou la liquidité du projet ?")


def _default_factor_criterion(name: str) -> str:
    return {
        "occupation": "Statut d'occupation et facilité d'exploitation.",
        "état": "État matériel du bien et besoin probable de travaux.",
        "type": "Liquidité selon la nature du bien.",
        "localisation": "Profondeur du marché local.",
        "surface": "Présence d'une surface exploitable pour comparer le bien.",
        "prix_m2": "Mise à prix rapportée à la surface exploitable.",
        "atouts": "Équipements et caractéristiques positives détectées.",
        "risques": "Risques contextualisés dans les documents.",
        "qualité": "Fiabilité des données utilisées par le scoring.",
    }.get(name, "Facteur de scoring.")


def _confidence_note(confidence: Decimal) -> str:
    value = max(Decimal("0"), min(Decimal("1"), confidence))
    pct = int((value * Decimal("100")).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if value >= Decimal("0.8"):
        level = "forte"
    elif value >= Decimal("0.6"):
        level = "correcte"
    elif value >= Decimal("0.4"):
        level = "à confirmer"
    else:
        level = "faible"
    return f"Confiance {level} ({pct}%)."


def _component_raw_fact_label(component: ScoreComponent) -> str | None:
    value = component.raw_value
    if value is None:
        return None
    name = component.name.lower()
    raw = _raw_value_label(value)
    items = _list_value_labels(value)

    if name == "occupation":
        return f"Occupation retenue : {_occupancy_status_label(str(value) if value else None)}."
    if name == "type":
        return f"Type de bien retenu : {_property_type_label(str(value) if value else None)}."
    if name == "localisation" and raw:
        label = raw.replace("tj ", "TJ ", 1) if raw.lower().startswith("tj ") else raw
        return f"Localisation retenue : {label}."
    if name == "surface":
        surface = _decimal_value(value)
        if surface is not None:
            return f"Surface exploitable retenue : {_format_decimal(surface)} m2."
        return "Surface exploitable à confirmer."
    if name == "prix_m2":
        price = _decimal_value(value)
        if price is not None:
            return f"Mise à prix rapportée à la surface : environ {_format_eur(price)}/m2."
        return "Prix au m2 à confirmer."
    if name == "atouts":
        return (
            f"Atouts d'usage détectés : {', '.join(items)}."
            if items
            else "Aucun atout d'usage spécifique n'a été détecté."
        )
    if name == "risques":
        return (
            f"Risques contextualisés retenus : {', '.join(items)}."
            if items
            else "Aucun risque contextualisé n'a été retenu dans les éléments analysés."
        )
    if name in {"qualité", "qualite"}:
        return (
            f"Points à vérifier sur les données : {', '.join(items)}."
            if items
            else "Aucune pénalité qualité : les données structurantes sont exploitables."
        )
    if name in {"état", "etat"} and raw:
        return f"État du bien retenu : {raw}."
    return raw


def _list_value_labels(value: object | None) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _decimal_value(value: object | None) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float, str)):
        text = str(value).strip().replace(" ", "").replace(",", ".")
        if not text:
            return None
        try:
            return Decimal(text)
        except Exception:
            return None
    return None


def _raw_value_label(value: object | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, list):
        return ", ".join(str(item) for item in value) if value else "Aucune donnée détectée"
    if isinstance(value, float):
        return f"{value:.2f}".rstrip("0").rstrip(".")
    return str(value)


def _quality_flag_label(flag: str) -> str:
    return {
        "ambiguous_surface": "surface ambiguë",
        "low_confidence_extraction": "extraction à faible confiance",
        "missing_gps": "coordonnées GPS manquantes",
        "source_not_allowed": "source non autorisée",
        "type_corrected_from_documents": "type corrigé par les documents",
        "occupation_conflict": "occupation contradictoire à confirmer",
        "room_count_conflict": "pièces/chambres incohérentes",
        "surface_conflict_resolved": "contradiction de surface résolue",
        "land_surface_conflict_resolved": "contradiction de terrain résolue",
        "source_page_only": "analyse basée sur la page source uniquement",
        "non_judicial_sale_context": "vente volontaire ou notariale, tribunal non prouvé",
    }.get(flag, flag.replace("_", " "))


def _occupancy_status_label(value: str | None) -> str:
    return {
        "vacant": "libre",
        "unknown": "à confirmer",
        "rented": "loué",
        "occupied": "occupé",
        "owner_occupied": "occupé par le propriétaire",
        "squatted": "occupation sans droit ni titre",
    }.get(value or "", "non renseigné")


def _property_type_label(value: str | None) -> str:
    return {
        "apartment": "appartement",
        "house": "maison",
        "building": "immeuble",
        "mixed": "actif mixte",
        "commercial": "local commercial",
        "land": "terrain",
        "parking": "parking",
        "unknown": "type non qualifié",
        "other": "type non qualifié",
    }.get(value or "", "type non qualifié")


def _format_decimal(value: Decimal) -> str:
    formatted = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return f"{formatted.normalize():f}".replace(".", ",")


def _format_eur(value: Decimal | None) -> str:
    if value is None:
        return "prix absent"
    rounded = value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return f"{int(rounded):,} €".replace(",", " ")


def _surface_evidence_refs(sale: AuctionSale) -> list[dict[str, object]]:
    if not sale.surface_evidence:
        return []
    return [
        {
            "label": "Surface retenue",
            "document_type": "source_listing" if sale.surface_source == "source_listing" else None,
            "excerpt": sale.surface_evidence,
            "confidence": _float_or_none(sale.surface_confidence),
        }
    ]


def _risk_to_evidence_ref(risk: dict[str, Any]) -> dict[str, object]:
    evidence_json = risk.get("evidence_json") if isinstance(risk.get("evidence_json"), dict) else {}
    return {
        "label": risk.get("risk_label"),
        "document_label": evidence_json.get("document_label"),
        "document_type": evidence_json.get("document_type"),
        "page_number": evidence_json.get("page_number"),
        "excerpt": risk.get("evidence") or evidence_json.get("excerpt"),
        "confidence": risk.get("confidence"),
    }


def _factor_refs_from_risk_occurrences(occurrences: list[dict[str, object]]) -> list[dict[str, object]]:
    refs = []
    seen: set[tuple[object, object, object]] = set()
    ranked = sorted(
        occurrences,
        key=lambda item: (
            int(item.get("severity") or 1),
            float(item.get("confidence") or 0),
            _document_type_weight(str(item.get("document_type") or "")),
        ),
        reverse=True,
    )
    for occurrence in ranked:
        key = (
            occurrence.get("risk_label"),
            occurrence.get("document_url"),
            occurrence.get("page_number"),
        )
        if key in seen:
            continue
        seen.add(key)
        refs.append(
            _compact_dict(
                {
                    "label": occurrence.get("risk_label"),
                    "document_label": occurrence.get("document_label"),
                    "document_type": occurrence.get("document_type"),
                    "page_number": occurrence.get("page_number"),
                    "excerpt": occurrence.get("excerpt"),
                    "confidence": occurrence.get("confidence"),
                }
            )
        )
        if len(refs) >= 3:
            break
    return refs


def _risk_penalty_breakdown(risks: list[dict[str, Any]]) -> str:
    parts = []
    for risk in risks[:6]:
        label = risk.get("risk_label") or "risque"
        severity = Decimal(str(risk.get("severity") or 1))
        parts.append(f"{label} -{severity}")
    return ", ".join(parts) if parts else "aucun"


def _quality_penalty_breakdown(penalties: list[tuple[Decimal, str]]) -> str:
    return ", ".join(f"{reason} -{points}" for points, reason in penalties) if penalties else "aucune"


def _compact_dict(payload: dict[str, Any] | object | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return {key: value for key, value in payload.items() if value not in (None, "", [], {})}


def _json_safe(value: object | None) -> object | None:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    return value


def _float_or_none(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def _fill_quality_flags(sale: AuctionSale) -> None:
    if sale.source_name == "licitor" and any(
        (doc.get("url") or "").startswith("https://www.licitor.com/data/pub/") for doc in sale.documents
    ):
        _add_quality_flag(sale, "source_not_allowed")
    if sale.latitude is None or sale.longitude is None:
        _add_quality_flag(sale, "missing_gps")
    if not sale.documents:
        _add_quality_flag(sale, "source_page_only")
    if _sale_type_context(sale).get("status") == "non_judicial":
        _add_quality_flag(sale, "non_judicial_sale_context")
    llm_confidence = sale.raw_payload.get("llm_extraction", {}).get("confidence", {})
    if isinstance(llm_confidence, dict) and any(float(value or 0) < 0.55 for value in llm_confidence.values()):
        _add_quality_flag(sale, "low_confidence_extraction")


def _add_quality_flag(sale: AuctionSale, flag: str) -> None:
    if flag not in sale.quality_flags:
        sale.quality_flags.append(flag)
