"""Deterministic checks for explicit claims, not a general entailment model."""
from __future__ import annotations

import re
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

NUMBER = r"(?<![\w.,+])\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?"
QUANTITIES = {
    'area': re.compile(rf"(?P<value>{NUMBER})\s*(?:m[²2]|mètres? carrés?)\b", re.I),
    'money': re.compile(rf"(?P<value>{NUMBER})\s*(?:€|euros?\b)", re.I),
    'rooms': re.compile(r"(?P<value>\d+|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pièces?\b", re.I),
    'bedrooms': re.compile(r"(?P<value>\d+|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*chambres?\b", re.I),
}
PROMOTIONAL = re.compile(r"\b(?:exceptionnell?e?s?|id[ée]al(?:e)? pour investir|rentabilit[ée] garantie|sans aucun risque)\b", re.I)

MONTHS = {'janvier': 1, 'février': 2, 'mars': 3, 'avril': 4, 'mai': 5, 'juin': 6,
          'juillet': 7, 'août': 8, 'septembre': 9, 'octobre': 10, 'novembre': 11, 'décembre': 12}
DATES = re.compile(r"\b(?:(\d{1,2})/(\d{1,2})/(\d{4})|(\d{4})-(\d{2})-(\d{2})|"
                   r"(\d{1,2})\s+(" + '|'.join(MONTHS) + r")\s+(\d{4}))(?=\b|T)", re.I)


def _dates(text: str) -> list[tuple[str, str]]:
    result = []
    for m in DATES.finditer(text):
        try:
            if m[1]:
                value = date(int(m[3]), int(m[2]), int(m[1]))
            elif m[4]:
                value = date(int(m[4]), int(m[5]), int(m[6]))
            else:
                value = date(int(m[9]), MONTHS[m[8].lower()], int(m[7]))
            result.append((m.group(), value.isoformat()))
        except ValueError:
            result.append((m.group(), 'invalid'))
    return result


def _number(text: Any) -> Decimal | None:
    words = {'un': 1, 'une': 1, 'deux': 2, 'trois': 3, 'quatre': 4, 'cinq': 5,
             'six': 6, 'sept': 7, 'huit': 8, 'neuf': 9, 'dix': 10}
    if str(text).lower() in words:
        return Decimal(words[str(text).lower()])
    try:
        value = Decimal(re.sub(r"\s", "", str(text)).replace(',', '.'))
        return value if value.is_finite() else None
    except InvalidOperation:
        return None


def verify_display_claims(text: str, evidence: str, fields: dict[str, Any]) -> dict[str, Any]:
    """Match numbers with their units, and reject clear occupancy conflicts.

    A price never substantiates an area. Source mentions are traceable, but
    matching text alone is not proof that every semantic relationship is true.
    """
    evidence = evidence or ''
    issues: list[dict[str, str]] = []
    claims: list[dict[str, Any]] = []
    canonical = {
        'area': [fields.get(k) for k in ('surface_m2', 'app_surface_m2', 'habitable_surface_m2', 'carrez_surface_m2')],
        'money': [fields.get('starting_price_eur')],
        'rooms': [fields.get('rooms_count')], 'bedrooms': [fields.get('bedrooms_count')],
    }
    for kind, pattern in QUANTITIES.items():
        known = {_number(v) for v in canonical[kind] if v is not None}
        matches = list(pattern.finditer(evidence))
        land_units = list(re.finditer(r"(?:(\d+)\s*ha\s*)?(\d+)\s*a\s*(?:et\s*)?(?:(\d+)\s*ca)?\b", evidence, re.I)) if kind == 'area' else []
        for claim in pattern.finditer(text):
            value = _number(claim['value'])
            supporting = next((m for m in matches if _number(m['value']) == value), None)
            converted = next((m for m in land_units if Decimal(int(m[1] or 0)*10000 + int(m[2])*100 + int(m[3] or 0)) == value), None)
            supported = value in known or supporting is not None or converted is not None
            # Integer rounding of an explicit habitable area is allowed (117.31 -> 117).
            if kind == 'area' and value is not None and value == value.to_integral_value():
                supported = supported or any(v is not None and abs(v - value) < Decimal('0.5') for v in known)
            claims.append({'kind': kind, 'claim': claim.group(), 'supported': supported,
                           'evidence_quote': evidence[max(0, supporting.start()-60):supporting.end()+60] if supporting else None,
                           'canonical_field_match': value in known,
                           'exact_land_unit_conversion': converted.group() if converted else None})
            if not supported:
                issues.append({'code': 'unsupported_' + kind, 'claim': claim.group()})
    supported_dates = {iso for _, iso in _dates(evidence)}
    if fields.get('sale_date'):
        supported_dates.update(iso for _, iso in _dates(str(fields['sale_date'])))
    for claim, value in _dates(text):
        if value == 'invalid' or value not in supported_dates:
            issues.append({'code': 'unsupported_date', 'claim': claim})
    for match in re.finditer(r"\d+(?:[.,]\d+)?[eE][+-]\d+\s*m[²2]", text):
        issues.append({'code': 'scientific_surface_notation', 'claim': match.group()})
    occupancy = fields.get('occupancy_status')
    says_vacant = bool(re.search(r"\b(?:libre(?:s)?(?: de toute occupation)?|inoccup[ée]e?s?)\b", text, re.I))
    says_occupied = bool(re.search(r"\b(?:lou[ée]e?s?|occup[ée]e?s?|squatt[ée]e?s?)\b", text, re.I))
    # Explicit negation of an occupancy claim is not a positive assertion.
    if re.search(r"\b(?:non|pas)\s+(?:libre|inoccup[ée])", text, re.I):
        says_vacant = False
    if re.search(r"\b(?:non|pas)\s+(?:lou[ée]|occup[ée])", text, re.I):
        says_occupied = False
    if (occupancy in {'rented', 'occupied', 'owner_occupied', 'squatted'} and says_vacant
            or occupancy == 'vacant' and says_occupied):
        issues.append({'code': 'occupancy_conflict', 'claim': text})
    if re.search(r"\b(?:aucuns? travaux|sans travaux|aucune r[ée]novation)\b", text, re.I) and re.search(
        r"(?:gros|importants?|n[ée]cessite|pr[ée]voir).{0,45}travaux|travaux.{0,30}[àa] pr[ée]voir", evidence, re.I
    ):
        issues.append({'code': 'works_conflict', 'claim': text})
    for match in PROMOTIONAL.finditer(text):
        issues.append({'code': 'promotional_claim', 'claim': match.group()})
    return {'status': 'issues_detected' if issues else 'checks_passed',
            'scope': 'typed_numbers_dates_occupancy_works_and_promotional_language',
            'semantic_completeness_certified': False, 'claims': claims, 'issues': issues}
