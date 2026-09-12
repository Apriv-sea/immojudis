from __future__ import annotations

import re
import unicodedata
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dateutil import parser

from src.models import AuctionSale

FRENCH_MONTHS = {
    "janvier": "January",
    "février": "February",
    "fevrier": "February",
    "mars": "March",
    "avril": "April",
    "mai": "May",
    "juin": "June",
    "juillet": "July",
    "août": "August",
    "aout": "August",
    "septembre": "September",
    "octobre": "October",
    "novembre": "November",
    "décembre": "December",
    "decembre": "December",
}

FRENCH_WEEKDAYS = (
    "lundi",
    "mardi",
    "mercredi",
    "jeudi",
    "vendredi",
    "samedi",
    "dimanche",
)

PROPERTY_TYPE_MAP = {
    "apartment": "apartment",
    "appartement": "apartment",
    "studio": "apartment",
    "house": "house",
    "maison": "house",
    "villa": "house",
    "building": "building",
    "batiment": "building",
    "immeuble": "building",
    "land": "land",
    "terrain": "land",
    "commercial": "commercial",
    "magasin": "commercial",
    "local": "commercial",
    "commerce": "commercial",
    "parking": "parking",
    "stationnement": "parking",
    "propriete agricole": "mixed",
    "propriete": "mixed",
    "ensemble immobilier": "mixed",
    "mixed": "mixed",
    "autres": "other",
    "autre": "other",
    "other": "other",
    "unknown": "unknown",
}

PROPERTY_TYPE_CODE_MAP = {
    "app": "apartment",
    "mai": "house",
    "ter": "land",
    "imb": "building",
    "loc": "commercial",
    "com": "commercial",
    "gar": "parking",
    "pkg": "parking",
}

VALID_STATUSES = {"upcoming", "past", "adjudicated", "unknown", "postponed", "cancelled", "withdrawn"}
SURFACE_VALUE_PATTERN = r"([0-9]+(?:[\s.][0-9]{3})*(?:[,.]\s*[0-9]+)?|[0-9]+(?:[,.]\s*[0-9]+)?)"
LATIN_LETTERS_PATTERN = r"A-Za-zÀ-ÖØ-öø-ÿŒœŸ"


def make_sale_signature(sale_date: object, price: object) -> str:
    """Stable change-signature for a listing: date (YYYY-MM-DD) + rounded price.
    Used identically on the DB side and the scrape side to decide whether a
    known listing is unchanged (so its detail page can be skipped)."""
    date_part = str(sale_date)[:10] if sale_date else ""
    try:
        price_part = str(int(round(float(price)))) if price not in (None, "") else ""
    except (TypeError, ValueError):
        price_part = ""
    return f"{date_part}|{price_part}"


def strip_accents(value: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFKD", value) if not unicodedata.combining(char)
    )


def clean_text(value: object | None) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value).replace("\xa0", " ")).strip()
    return text or None


def parse_price(value: object | None) -> Decimal | None:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"([0-9][0-9\s.,]*)", text)
    if not match:
        return None
    number = _normalize_numeric_token(match.group(1))
    try:
        return Decimal(number)
    except InvalidOperation:
        return None


def extract_starting_price(raw_sale: dict[str, object]) -> Decimal | None:
    explicit = parse_price(
        _field_or_source_block(
            raw_sale,
            "starting_price_eur",
            "mise_a_prix",
            "detail_mise_a_prix",
            "mise_a_prix_initiale",
            "prix_plancher",
            "premiere_offre_possible",
        )
    )
    text = " ".join(
        filter(
            None,
            (
                clean_text(raw_sale.get("raw_text")),
                clean_text(raw_sale.get("description")),
                clean_text(raw_sale.get("title")),
                _source_blocks_text(raw_sale),
            ),
        )
    )
    text_price = None
    for pattern in (
        r"(?P<label>mise\s+[àa]\s+prix(?:\s+initiale)?)\s*:?\s*(?P<price>[0-9][0-9\s.,]*)\s*(?:€|euros?)?",
        r"(?P<label>prix\s+de\s+vente)\s*:\s*(?P<price>[0-9][0-9\s.,]*)\s*(?:€|euros?)?",
        r"(?P<label>prix\s+plancher)\s*:?\s*(?P<price>[0-9][0-9\s.,]*)\s*(?:€|euros?)?",
        r"(?P<label>premi[èe]re\s+offre\s+(?:possible\s+)?(?:à\s+partir\s+de\s+)?)"
        r"(?P<price>[0-9][0-9\s.,]*)\s*(?:€|euros?)?",
    ):
        match = re.search(pattern, text, re.I)
        if match:
            if _is_dvf_comparable_price_context(text, match.start(), match.end(), match.group("label")):
                continue
            text_price = parse_price(match.group("price"))
            break
    if explicit is not None and text_price is not None:
        if explicit == text_price * Decimal("10"):
            return text_price
        if explicit > Decimal("1000000") and text_price < explicit:
            return text_price
    return explicit or text_price


def _is_dvf_comparable_price_context(text: str, start: int, end: int, label: str) -> bool:
    if strip_accents(label).lower() != "prix de vente":
        return False
    before = text[max(0, start - 220) : start]
    after = text[end : min(len(text), end + 80)]
    context = strip_accents(f"{before} {after}").lower()
    if re.search(r"\bdonnees?\s+des\s+valeurs\s+foncieres\b", context):
        return True
    dvf_headers = (
        r"\btype\s+de\s+bien\b",
        r"\bdate\s+de\s+vente\b",
        r"\bnb\s+de\s+pieces\b",
    )
    return sum(bool(re.search(pattern, context)) for pattern in dvf_headers) >= 2


def extract_adjudication_price(raw_sale: dict[str, object]) -> Decimal | None:
    explicit = parse_price(
        _field_or_source_block(
            raw_sale,
            "adjudication_price_eur",
            "prix_adjudication",
            "prix_adjuge",
            "prix_adjude",
        )
    )
    if explicit is not None:
        return explicit
    # A fee clause ending in “prix d’adjudication” must not consume a
    # separate block containing the starting price.
    texts = [raw_sale.get("raw_text"), raw_sale.get("description")]
    texts.extend(value for _, value in _walk_source_blocks(raw_sale.get("source_blocks"))
                 if not isinstance(value, (dict, list)))
    for pattern in (
        r"\badjug[ée]\s*:?\s*([0-9][0-9\s.,]*)\s*(?:€|euros?)?",
        r"\bprix\s+d['’]adjudication\s*:?\s*([0-9][0-9\s.,]*)\s*(?:€|euros?)?",
        r"\badjudication\s*:?\s*([0-9][0-9\s.,]*)\s*(?:€|euros?\b)",
    ):
        for value in texts:
            text = clean_text(value)
            if not text:
                continue
            match = re.search(pattern, text, re.I)
            if match:
                return parse_price(match.group(1))
    return None


def parse_surface(value: object | None) -> Decimal | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"([0-9][0-9\s.,]*)", text)
    if not match:
        return None
    number = _normalize_numeric_token(match.group(1))
    try:
        return Decimal(number)
    except InvalidOperation:
        return None


def _normalize_numeric_token(value: str) -> str:
    number = value.replace(" ", "")
    if "," in number:
        return number.replace(".", "").replace(",", ".")
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", number):
        return number.replace(".", "")
    return number


def parse_decimal(value: object | None) -> Decimal | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        return Decimal(text.replace(",", "."))
    except InvalidOperation:
        return None


def parse_confidence(value: object | None) -> Decimal | None:
    confidence = parse_decimal(value)
    if confidence is None:
        return None
    if confidence > 1 and confidence <= 100:
        return confidence / Decimal("100")
    if confidence < 0:
        return Decimal("0")
    if confidence > 1:
        return Decimal("1")
    return confidence


def source_sale_timezone(raw_sale: dict[str, object]) -> str:
    # Use an explicit source timezone when provided; never infer it from the property's address.
    return clean_text(_field_or_source_block(raw_sale, "sale_timezone", "sale_timezone", "audience_timezone")) or "Europe/Paris"


def _civil_time_to_utc(parsed: datetime, *, has_time: bool, local_timezone: str) -> datetime | None:
    if not has_time:
        return parsed.replace(tzinfo=UTC)
    try:
        zone = ZoneInfo(local_timezone)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return None
    local = parsed.replace(tzinfo=zone)
    # Neither choose a repeated DST hour nor silently move a nonexistent hour.
    if local.utcoffset() != local.replace(fold=1).utcoffset():
        return None
    result = local.astimezone(UTC)
    if result.astimezone(zone).replace(tzinfo=None) != parsed:
        return None
    return result


def parse_french_datetime(value: object | None, *, local_timezone: str = "Europe/Paris") -> datetime | None:
    """Parse metropolitan French civil times; keep explicit offsets and date-only storage."""
    text = clean_text(value)
    if not text:
        return None
    iso_match = re.search(
        r"\b(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?)\b",
        text,
    )
    if iso_match:
        try:
            parsed = parser.isoparse(iso_match.group(1).replace(" ", "T"))
        except (ValueError, TypeError, OverflowError):
            parsed = None
        if parsed is not None:
            if parsed.tzinfo is None:
                # Published French sale times are local civil times. Preserve the
                # existing date-only convention until dates have their own field.
                return _civil_time_to_utc(
                    parsed, has_time=bool(re.search(r"[T\s]\d{2}:\d{2}", iso_match.group(1))),
                    local_timezone=local_timezone,
                )
            return parsed.astimezone(UTC)
    lowered = text.lower()
    for weekday in FRENCH_WEEKDAYS:
        lowered = re.sub(rf"\b{weekday}\b", "", lowered)
    lowered = lowered.replace(" à ", " ")
    lowered = re.sub(
        r"\b([0-2]?\d)\s*(?:heures?|h)\s*([0-5]\d)?\b",
        lambda m: f"{m.group(1)}:{m.group(2) or '00'}", lowered,
    )
    for fr, en in FRENCH_MONTHS.items():
        lowered = lowered.replace(fr, en)
    # Keep venue names (including hyphens) out of dateutil's date grammar.
    months = "|".join(sorted(set(FRENCH_MONTHS.values())))
    dated = list(re.finditer(
        rf"\b\d{{1,2}}\s+(?:{months})\s+\d{{4}}"
        r"(?:\s*,?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})?)?",
        lowered, re.I,
    ))
    if len(dated) == 1:
        candidate = dated[0].group(0).strip()
        if not re.search(r"\d{1,2}:\d{2}", lowered) or re.search(r"\d{1,2}:\d{2}", candidate):
            lowered = candidate
    try:
        parsed = parser.parse(lowered, dayfirst=True, fuzzy=True)
    except (ValueError, TypeError, OverflowError):
        return None
    if parsed.tzinfo is None:
        return _civil_time_to_utc(
            parsed, has_time=bool(re.search(r"\d{1,2}:\d{2}", lowered)), local_timezone=local_timezone,
        )
    return parsed.astimezone(UTC)


def normalize_property_type(value: object | None) -> str:
    text = strip_accents(clean_text(value) or "").lower()
    if text in PROPERTY_TYPE_CODE_MAP:
        return PROPERTY_TYPE_CODE_MAP[text]
    if re.search(r"\b(?:batiments?|hangars?|exploitation|stabulation|locaux?)\b", text) and re.search(
        r"\b(?:terrains?|parcelles?|pres?)\b", text
    ):
        return "mixed"
    if re.search(r"\b(?:exploitation\s+agricole|batiments?\s+agricoles?|hangars?|stabulation|salle\s+de\s+traite)\b", text):
        return "commercial"
    if re.search(r"\b(?:terrains?|parcelles?|pres?)\b", text) and not re.search(
        r"\b(?:appartement|maison|villa|studio|immeuble|commerce|commercial|local)\b", text
    ):
        return "land"
    for needle, normalized in PROPERTY_TYPE_MAP.items():
        if needle in text:
            return normalized
    return "other"


def normalize_sale_property_type(raw_sale: dict[str, object]) -> str:
    property_type = normalize_property_type(
        _field_or_source_block(
            raw_sale,
            "property_type",
            "nature_du_bien",
            "detail_nature_du_bien",
            "type_bien",
            "sous_categorie",
        )
    )
    # Some source pages classify an apartment under "Terrain" while their
    # specific listing title identifies the dwelling. Do not value the shared
    # cadastral parcel as the surface of the apartment.
    detail_title = clean_text(_source_block_lookup(raw_sale, "titre_detail", "detail_titre", "asset_title"))
    if property_type == "land" and detail_title and re.match(
        r"^(?:un[e]?\s+)?(?:appartement|studio|maison|villa)\b", detail_title, re.I
    ):
        return normalize_property_type(detail_title)
    if property_type not in {"other", "unknown"}:
        return property_type

    fallback_text = " ".join(
        filter(
            None,
            (
                clean_text(raw_sale.get("title")),
                clean_text(raw_sale.get("description")),
                clean_text(raw_sale.get("raw_text")),
                _source_blocks_text(raw_sale),
            ),
        )
    )
    fallback_type = normalize_property_type(fallback_text)
    if fallback_type not in {"other", "unknown"}:
        return fallback_type
    return property_type


def normalize_occupancy_status(value: object | None) -> str | None:
    """Map free-text occupancy (FR/EN) to the auction_sales enum.

    The DB CHECK constraint only accepts vacant/occupied/rented/owner_occupied/
    squatted/unknown (or NULL). Unrecognised values return None (NULL) rather
    than letting raw text reach the insert and fail the constraint.
    """
    text = strip_accents(clean_text(value) or "").lower()
    if not text:
        return None
    # Order matters: check the most specific labels before the generic "occup".
    if "squat" in text:
        return "squatted"
    if "proprietaire" in text or "owner" in text:
        return "owner_occupied"
    if has_rented_occupancy_signal(text):
        return "rented"
    if re.search(
        r"\b(?:unknown|inconnu(?:e|s|es)?|a\s+(?:verifier|confirmer|determiner)|"
        r"non\s+(?:renseigne|precise)(?:e|s|es)?|indetermine(?:e|s|es)?)\b",
        text,
    ):
        return "unknown"
    if any(token in text for token in ("libre", "vacant", "inoccup", "free", "vide", "disponible")):
        return "vacant"
    if no_lease_status := no_lease_occupancy_status(text):
        return no_lease_status
    if "occup" in text:
        return "occupied"
    return None


def has_rented_occupancy_signal(text: str) -> bool:
    text = strip_accents(text).lower()
    if re.search(r"\b(?:locataire|rented|leased|tenant|loyer)\b", text):
        return True
    if re.search(r"\bloue(?:e|s|es)?\b", text):
        return True
    return bool(re.search(r"\bbail\b", text) and not has_no_lease_signal(text))


def no_lease_occupancy_status(text: str) -> str | None:
    text = strip_accents(text).lower()
    if not has_no_lease_signal(text):
        return None
    if re.search(r"\b(?:occup|exploit|habit|utilis)\w*\b", text):
        return "occupied"
    return "unknown"


def has_no_lease_signal(text: str) -> bool:
    text = strip_accents(text).lower()
    return bool(
        re.search(
            r"\b(?:sans|absence\s+de|aucun(?:e)?|pas\s+de|non\s+soumis\s+a\s+un)\s+"
            r"(?:bail|contrat\s+de\s+location)\b",
            text,
        )
    )


def normalize_status(value: object | None, sale_date: datetime | None = None) -> str:
    text = strip_accents(clean_text(value) or "").lower()
    if re.search(r"\b(reportee?s?|postponed|reported)\b", text):
        return "postponed"
    if re.search(r"\b(annulee?s?|cancelled|canceled)\b", text):
        return "cancelled"
    if re.search(r"\b(retiree?s?|withdrawn)\b", text):
        return "withdrawn"
    if re.search(r"\badjuge(?:e|es|s)?\b|\badjudicated\b", text):
        return "adjudicated"
    if "passee" in text or "passe" in text:
        return "past"
    if "venir" in text or "upcoming" in text:
        return "upcoming"
    if text in VALID_STATUSES and text != "unknown":
        return text
    if sale_date:
        return "past" if sale_date < datetime.now(UTC) else "upcoming"
    return "unknown"


def extract_postal_code(*values: object | None) -> str | None:
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        match = re.search(r"\b(\d{5})\b", text)
        if match:
            return match.group(1)
    return None


def extract_department(postal_code: str | None) -> str | None:
    if not postal_code or len(postal_code) < 2:
        return None
    if re.match(r"^(?:97[1-8]|98[6-8])\d{2}$", postal_code):
        return postal_code[:3]
    return postal_code[:2]


def extract_city(address: str | None, postal_code: str | None) -> str | None:
    if not address or not postal_code:
        return None
    match = re.search(rf"\b{re.escape(postal_code)}\s+([^,\n]+)", address)
    if not match:
        return None
    return clean_text(match.group(1).replace("France", "").strip(" ,"))


def parse_rooms_count(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        rooms = int(value)
        return rooms if rooms > 0 else None
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"[1-9][0-9]?", text)
    return int(match.group(0)) if match else None


def parse_bedrooms_count(value: object) -> int | None:
    return parse_rooms_count(value)


def extract_rooms_count_from_text(*values: object) -> int | None:
    text = clean_text(" ".join(str(value) for value in values if value))
    if not text:
        return None

    for match in re.finditer(r"\bstudio\b", text, re.I):
        if not _is_rooms_count_false_positive(text, match.start(), match.end()):
            return 1

    patterns = (
        r"\b(?:appartement|maison|villa)\b.{0,80}?\blots?\s+\d+\s*,\s*"
        r"([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\s+[1-9][0-9]?\s*chambres?\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\s+"
        r"[0-9]+(?:[,.][0-9]+)?\s*m(?:2|²)\s+(?:superficie|surface)\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\s+(?:à\s+propos\s+du\s+bien|a\s+propos\s+du\s+bien)\b",
        r"\b(?:appartement|maison|villa|immeuble)\s+(?:de\s+)?([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\b",
        r"\b(?:appartement|maison|villa)\s+de\s+[0-9]+(?:[,.][0-9]+)?\s*m(?:2|²)\s*,?\s+de\s+([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\b",
        r"\b(?:nombre\s+de\s+)?pi[eèé]ces?\s*(?:principales?)?\s*:?\s*([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\bappartement\s+(?:de\s+)?type\s*([1-9]|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\btype\s+([1-9]|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\b(?:type\s+)?[TF]\s*([1-9])\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            if _is_rooms_count_false_positive(text, match.start(1), match.end(1)):
                continue
            return _parse_count_token(match.group(1))

    if re.search(r"\b(?:(?:une|1)\s+)?pi[eèé]ce\s+principale\b", text, re.I):
        return 1
    return None


def extract_bedrooms_count_from_text(*values: object) -> int | None:
    text = clean_text(" ".join(str(value) for value in values if value))
    if not text:
        return None

    numbered = _count_numbered_bedrooms(text)
    if numbered is not None:
        return numbered

    patterns = (
        r"\b[1-9][0-9]?\s*pi[eèé]ces?\s+([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*chambres?\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*chambres?\b",
        r"\bchambres?\s*:?\s*([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            if _is_rooms_count_false_positive(text, match.start(), match.end()):
                continue
            return _parse_count_token(match.group(1))
    return None


def _parse_count_token(value: str) -> int | None:
    value = value.lower().strip()
    if value.isdigit():
        rooms = int(value)
        return rooms if rooms > 0 else None
    mapping = {
        "un": 1,
        "une": 1,
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
    return mapping.get(value)


def _count_numbered_bedrooms(text: str) -> int | None:
    matches = re.findall(r"\bchambre\s*(?:n[°o]\s*)?([1-9][0-9]?)\b", text, re.I)
    if not matches:
        return None
    numbers = {int(match) for match in matches}
    if len(numbers) >= 2 and numbers == set(range(1, max(numbers) + 1)):
        return max(numbers)
    return None


def _is_rooms_count_false_positive(text: str, start: int, end: int) -> bool:
    after_number = text[end : min(len(text), end + 20)]
    if re.match(r"\s*[,.]\d+\s*m(?:2|²)\b", after_number, re.I):
        return True
    nearby = text[max(0, start - 40) : min(len(text), end + 80)]
    if re.search(r"\b(?:d[ée]pendance|annexe|remise)\b", nearby, re.I):
        return True
    before = text[max(0, start - 180) : start]
    after = text[end : min(len(text), end + 160)]
    context = before + after
    return bool(
        re.search(
            r"donnn?[ée]es?\s+des\s+valeurs\s+fonci[èe]res|prix\s+de\s+vente|date\s+de\s+vente|nb\s+de\s+pi[eèé]ces|article|page|"
            r"tous\s+les\s+biens|villa\s+maison\s+appartement\s+studio\s+terrain",
            context,
            re.I,
        )
    )


def normalize_sale(raw_sale: dict[str, object]) -> AuctionSale:
    source_url = clean_text(raw_sale.get("source_url"))
    if not source_url:
        raise ValueError("raw sale is missing source_url")

    source_text = _normalization_text(raw_sale)
    if re.search(r'vente.{0,40}\ben\s+[2-9][0-9]*\s+lots|premier\s+lot\s+de\s+vente.*second\s+lot\s+de\s+vente', source_text, re.I | re.S):
        raw_sale = dict(raw_sale)
        raw_sale['quality_flags'] = [*(raw_sale.get('quality_flags') or []), 'multi_lot_sale']
    title = clean_text(raw_sale.get("title"))
    detail_title = clean_text(_source_block_lookup(raw_sale, "titre_detail", "detail_titre", "asset_title"))
    if _is_generic_listing_title(title) and detail_title:
        title = detail_title
    if _is_generic_listing_title(title):
        title = _extract_asset_title_from_text(source_text) or title
    if title is None:
        title = clean_text(_source_block_lookup(raw_sale, "titre", "title"))
    property_type = normalize_sale_property_type(raw_sale)
    if detail_title and property_type in {"apartment", "house"} and normalize_property_type(title) == "land":
        title = detail_title
    description = clean_text(_field_or_source_block(raw_sale, "description", "description", "detail_description"))
    if description and re.fullmatch(r"\$[a-z0-9][a-z0-9_]*", description, re.I):
        description = None
    address = clean_text(
        _field_or_source_block(raw_sale, "address", "adresse", "detail_adresse", "address", "localisation")
    )
    if address and re.fullmatch(r'[\d\s.,]+\s*(?:€|euros?|EUR)', address, re.I):
        raw_sale = dict(raw_sale)
        raw_sale['invalid_address_evidence'] = {'value': address, 'reason': 'monetary_value_is_not_address'}
        raw_sale['quality_flags'] = [*(raw_sale.get('quality_flags') or []), 'address_unverified']
        raw_sale['latitude'] = raw_sale['longitude'] = None
        address = None
    postal_code = clean_text(
        _field_or_source_block(raw_sale, "postal_code", "code_postal", "codePostal", "postal_code")
    ) or extract_postal_code(address)
    if postal_code is None and not _skip_contextless_postal_code_fallback(raw_sale, address):
        postal_code = extract_postal_code(raw_sale.get("raw_text"), source_text)
    city = clean_text(_field_or_source_block(raw_sale, "city", "ville", "commune", "city")) or extract_city(
        address, postal_code
    )
    sale_date = parse_french_datetime(
        _field_or_source_block(
            raw_sale,
            "sale_date",
            "sale_date",
            "date_vente",
            "vente_le",
            "detail_vente_le",
            "audience",
            "date_de_l_audience",
            "seance_date",
        ),
        local_timezone=source_sale_timezone(raw_sale),
    )
    adjudication_price = extract_adjudication_price(raw_sale)
    status = normalize_status(_field_or_source_block(raw_sale, "status", "status", "statut"), sale_date)
    if adjudication_price is not None:
        if sale_date is not None and sale_date > datetime.now(UTC):
            raw_sale = {**raw_sale, "unverified_adjudication_candidate": str(adjudication_price),
                        "quality_flags": list(raw_sale.get("quality_flags") or []) + ["sale_procedure_conflict"]}
            adjudication_price = None
            status = "quarantined"
        else:
            status = "adjudicated"
    rooms_count = parse_rooms_count(
        _field_or_source_block(
            raw_sale,
            "rooms_count",
            "nb_pieces",
            "nombre_pieces",
            "nombre_de_pieces",
            "critere_nombre_de_pieces",
        )
    ) or extract_rooms_count_from_text(
        title,
        description,
        raw_sale.get("raw_text"),
        source_text,
    )
    bedrooms_count = parse_bedrooms_count(
        _field_or_source_block(
            raw_sale,
            "bedrooms_count",
            "nb_chambres",
            "nombre_chambres",
            "nombre_de_chambres",
            "critere_nombre_de_chambres",
        )
    ) or extract_bedrooms_count_from_text(
        title,
        description,
        raw_sale.get("raw_text"),
        source_text,
    )
    surface_m2 = parse_surface(
        _field_or_source_block(raw_sale, "surface_m2", "surface_m2", "surface", "detail_surface")
    ) or _extract_built_surface_from_text(source_text)
    habitable_surface_m2 = parse_surface(
        _field_or_source_block(
            raw_sale,
            "habitable_surface_m2",
            "surface_habitable",
            "habitable_surface_m2",
            "critere_surface_habitable",
        )
    ) or _extract_habitable_surface_from_text(source_text)
    carrez_surface_m2 = parse_surface(
        _field_or_source_block(raw_sale, "carrez_surface_m2", "surface_carrez", "carrez_surface_m2")
    ) or _extract_carrez_surface_from_text(source_text)
    land_surface_m2 = parse_surface(
        _field_or_source_block(
            raw_sale,
            "land_surface_m2",
            "surface_terrain",
            "land_surface_m2",
            "surface_parcelle",
            "contenance",
        )
    ) or _extract_land_surface_from_text(source_text)
    bathrooms_count = parse_rooms_count(
        _field_or_source_block(
            raw_sale,
            "bathrooms_count",
            "nb_salles_de_bain",
            "nombre_salles_de_bain",
            "critere_nombre_de_salles_de_bain",
        )
    ) or _extract_bathrooms_count_from_text(source_text)
    parking_count = parse_rooms_count(
        _field_or_source_block(
            raw_sale,
            "parking_count",
            "nb_stationnements",
            "nombre_de_parkings",
            "critere_nombre_de_parkings",
        )
    ) or _extract_parking_count_from_text(source_text)
    occupancy_status = normalize_occupancy_status(
        _field_or_source_block(
            raw_sale,
            "occupancy_status",
            "occupation",
            "critere_occupation_du_bien",
            "situation_locative",
            "situationLocative",
        )
    ) or _extract_occupancy_status_from_text(source_text)
    source_energy_diagnostics = _source_energy_diagnostics(raw_sale)
    if source_energy_diagnostics:
        raw_sale["source_energy_diagnostics"] = source_energy_diagnostics
    risk_notes = _merge_risk_notes(
        clean_text(raw_sale.get("risk_notes")),
        _energy_diagnostic_risk_note(source_energy_diagnostics),
    )
    surface_source = clean_text(raw_sale.get("surface_source"))
    surface_evidence = clean_text(raw_sale.get("surface_evidence"))
    if surface_evidence is None:
        surface_evidence = _surface_evidence_for_value(
            source_text,
            surface_m2 or habitable_surface_m2 or carrez_surface_m2 or land_surface_m2,
        )
    if surface_source is None and surface_evidence is not None:
        surface_source = "source_text"
    app_surface_m2 = parse_surface(raw_sale.get("app_surface_m2"))
    app_surface_kind = clean_text(raw_sale.get("app_surface_kind"))
    surface_scope = clean_text(raw_sale.get("surface_scope"))
    if app_surface_kind == "land" and property_type in {"apartment", "house"}:
        # A corrected dwelling classification invalidates an earlier parcel-based
        # application surface. Preserve land_surface_m2 as a separate source fact.
        app_surface_m2 = None
        app_surface_kind = None
        if surface_scope == "land":
            surface_scope = None
    if app_surface_m2 is None:
        app_surface_m2, app_surface_kind, surface_scope = _derive_initial_app_surface(
            property_type=property_type,
            surface_m2=surface_m2,
            habitable_surface_m2=habitable_surface_m2,
            carrez_surface_m2=carrez_surface_m2,
            land_surface_m2=land_surface_m2,
            surface_scope=surface_scope,
        )
    documents = normalize_documents(raw_sale.get("documents"), source_url=source_url)
    raw_sale["documents"] = documents
    # Note: an impossible rooms < bedrooms pair is resolved downstream by
    # normalize_asset_features() (clears rooms_count to NULL and flags a
    # room_count_conflict), so we deliberately do not coerce it here.

    return AuctionSale(
        source_name=clean_text(raw_sale.get("source_name")) or "avoventes",
        source_url=source_url,
        primary_source=clean_text(raw_sale.get("source_name")) or "avoventes",
        source_urls=normalize_source_urls(raw_sale.get("source_urls"), source_url),
        dedupe_confidence=clean_text(raw_sale.get("dedupe_confidence")),
        external_id=clean_text(raw_sale.get("external_id")),
        tribunal=clean_text(
            _field_or_source_block(
                raw_sale,
                "tribunal",
                "tribunal",
                "detail_au_tribunal_judiciaire_de",
                "au_tribunal_judiciaire_de",
            )
        ),
        tribunal_code=clean_text(raw_sale.get("tribunal_code")),
        department=clean_text(_field_or_source_block(raw_sale, "department", "departement", "department"))
        or extract_department(postal_code),
        city=city,
        address=address,
        postal_code=postal_code,
        property_type=property_type,
        title=title,
        description=description,
        surface_m2=surface_m2,
        habitable_surface_m2=habitable_surface_m2,
        land_surface_m2=land_surface_m2,
        carrez_surface_m2=carrez_surface_m2,
        app_surface_m2=app_surface_m2,
        app_surface_kind=app_surface_kind,
        surface_scope=surface_scope,
        surface_source=surface_source,
        surface_confidence=parse_confidence(raw_sale.get("surface_confidence")),
        surface_evidence=surface_evidence,
        rooms_count=rooms_count,
        bedrooms_count=bedrooms_count,
        bathrooms_count=bathrooms_count,
        parking_count=parking_count,
        has_garden=_feature_bool(raw_sale.get("has_garden"), source_text, r"\bjardin\b"),
        has_terrace=_feature_bool(raw_sale.get("has_terrace"), source_text, r"\bterrasse\b"),
        has_garage=_feature_bool(raw_sale.get("has_garage"), source_text, r"\bgarage\b"),
        has_pool=_feature_bool(raw_sale.get("has_pool"), source_text, r"\bpiscine\b"),
        has_air_conditioning=_feature_bool(
            raw_sale.get("has_air_conditioning"), source_text, r"\bclimatisation\b", r"\bair\s+condition"
        ),
        has_double_glazing=_feature_bool(
            raw_sale.get("has_double_glazing"), source_text, r"\bdouble\s+vitrage\b"
        ),
        starting_price_eur=extract_starting_price(raw_sale),
        sale_date=sale_date,
        visit_dates=_normalize_visit_dates(
            _field_or_source_block(
                raw_sale,
                "visit_dates",
                "visites",
                "date_de_visite",
                "detail_date_de_visite",
                "visite",
                "visite_libre",
            )
        ),
        lawyer_name=clean_text(
            _field_or_source_block(raw_sale, "lawyer_name", "avocat", "notary_name", "notaire", "contact_nom")
        ),
        lawyer_contact=clean_text(
            _field_or_source_block(
                raw_sale,
                "lawyer_contact",
                "contact_avocat",
                "lawyer_contact",
                "contact",
                "telephone",
                "tel",
                "email",
                "mail",
            )
        ),
        status=status,
        adjudication_price_eur=adjudication_price,
        documents=documents,
        latitude=parse_decimal(raw_sale.get("latitude")),
        longitude=parse_decimal(raw_sale.get("longitude")),
        occupancy_status=occupancy_status,
        risk_notes=risk_notes,
        investment_score=parse_price(raw_sale.get("investment_score")),
        investment_summary=clean_text(raw_sale.get("investment_summary")),
        score_version=clean_text(raw_sale.get("score_version")),
        score_confidence=parse_confidence(raw_sale.get("score_confidence")),
        score_factors=raw_sale.get("score_factors") if isinstance(raw_sale.get("score_factors"), list) else [],
        quality_flags=raw_sale.get("quality_flags") if isinstance(raw_sale.get("quality_flags"), list) else [],
        raw_text=clean_text(raw_sale.get("raw_text")),
        raw_payload=raw_sale,
        observations=raw_sale.get("observations") if isinstance(raw_sale.get("observations"), list) else [],
    )


def normalize_documents(value: object | None, *, source_url: str | None = None) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []

    normalized: dict[str, dict[str, str]] = {}
    for item in value:
        if not isinstance(item, dict):
            continue
        url = clean_text(item.get("url"))
        if not url or _is_non_document_url(url, source_url=source_url):
            continue
        document = {
            key: cleaned
            for key, field_value in item.items()
            if isinstance(key, str) and (cleaned := clean_text(field_value)) is not None
        }
        document["url"] = url
        normalized[url] = document
    return list(normalized.values())


def _is_non_document_url(url: str, *, source_url: str | None) -> bool:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.rstrip("/")
    if parsed.scheme not in {"http", "https"} or not host:
        return True
    if host in {"itunes.apple.com", "apps.apple.com", "play.google.com"}:
        return True
    if host == "app-pro.la-loupe.immo" and path.startswith("/ext-partenaire/licitor/"):
        return True

    return not path and not parsed.query and not parsed.fragment


def normalize_source_urls(value: object | None, source_url: str) -> list[str]:
    urls: list[str] = []
    if isinstance(value, list):
        urls.extend(cleaned for item in value if (cleaned := clean_text(item)))
    elif isinstance(value, dict):
        urls.extend(cleaned for item in value.values() if (cleaned := clean_text(item)))
    elif value:
        cleaned = clean_text(value)
        if cleaned:
            urls.append(cleaned)
    if source_url:
        urls = [source_url, *[url for url in urls if url != source_url]]
    seen: set[str] = set()
    unique: list[str] = []
    for url in urls:
        if url in seen:
            continue
        seen.add(url)
        unique.append(url)
    return unique


def _derive_initial_app_surface(
    *,
    property_type: str,
    surface_m2: Decimal | None,
    habitable_surface_m2: Decimal | None,
    carrez_surface_m2: Decimal | None,
    land_surface_m2: Decimal | None,
    surface_scope: str | None,
) -> tuple[Decimal | None, str | None, str | None]:
    if surface_scope in {"partial", "room_or_annex", "unknown"}:
        return None, None, surface_scope
    if property_type == "apartment":
        value = carrez_surface_m2 or habitable_surface_m2 or surface_m2
        kind = "carrez" if carrez_surface_m2 is not None else "habitable" if habitable_surface_m2 is not None else "built" if value is not None else None
        return value, kind, "total" if value is not None else surface_scope
    if property_type == "house":
        value = habitable_surface_m2 or surface_m2
        kind = "habitable" if habitable_surface_m2 is not None else "built" if value is not None else None
        return value, kind, "total" if value is not None else surface_scope
    if property_type == "building":
        value = surface_m2 or habitable_surface_m2 or carrez_surface_m2
        return value, "built" if value is not None else None, "total" if value is not None else surface_scope
    if property_type == "land":
        value = land_surface_m2
        return value, "land" if value is not None else None, "land" if value is not None else surface_scope
    if property_type in {"commercial", "mixed"}:
        value = surface_m2 or habitable_surface_m2 or carrez_surface_m2 or land_surface_m2
        if value is None:
            return None, None, surface_scope
        only_land = (
            surface_m2 is None
            and habitable_surface_m2 is None
            and carrez_surface_m2 is None
            and land_surface_m2 is not None
        )
        return value, "land" if only_land else "built", "land" if only_land else "total"
    return None, None, surface_scope


def _field_or_source_block(raw_sale: dict[str, object], field: str, *source_block_keys: str) -> object | None:
    value = raw_sale.get(field)
    if _has_value(value):
        return value
    return _source_block_lookup(raw_sale, *source_block_keys)


def _source_block_lookup(raw_sale: dict[str, object], *keys: str) -> object | None:
    targets = {_normalize_source_key(key) for key in keys if key}
    if not targets:
        return None
    blocks = raw_sale.get("source_blocks")
    if not isinstance(blocks, dict):
        return None
    for key, value in _walk_source_blocks(blocks):
        if _normalize_source_key(key) in targets and _has_value(value):
            return value
    return None


def _source_blocks_text(raw_sale: dict[str, object]) -> str | None:
    blocks = raw_sale.get("source_blocks")
    if not isinstance(blocks, dict):
        return None
    values = [
        text
        for _, value in _walk_source_blocks(blocks)
        if not isinstance(value, (dict, list)) and (text := clean_text(value))
    ]
    return "\n".join(values) or None


def _source_energy_diagnostics(raw_sale: dict[str, object]) -> dict[str, object] | None:
    existing = raw_sale.get("source_energy_diagnostics")
    if isinstance(existing, dict) and any(
        clean_text(existing.get(key)) for key in ("dpe_class", "ges_class", "diagnostic_date")
    ):
        return existing
    dpe_class = _normalize_energy_class(
        _field_or_source_block(
            raw_sale,
            "dpe_class",
            "dpe",
            "diagnostic_dpe",
            "critere_consommation_energetique",
            "consommation_energetique",
        )
    )
    ges_class = _normalize_energy_class(
        _field_or_source_block(
            raw_sale,
            "ges_class",
            "ges",
            "diagnostic_ges",
            "critere_emissions_de_gaz",
            "emissions_de_gaz",
        )
    )
    diagnostic_date = clean_text(
        _field_or_source_block(
            raw_sale,
            "diagnostic_date",
            "diagnostic_date",
            "dpe_date",
            "date_diagnostic",
            "critere_diagnostic_date",
        )
    )
    if not any((dpe_class, ges_class, diagnostic_date)):
        return None
    evidence = ", ".join(
        part
        for part in (
            f"DPE {dpe_class}" if dpe_class else None,
            f"GES {ges_class}" if ges_class else None,
            f"diagnostic du {diagnostic_date}" if diagnostic_date else None,
        )
        if part
    )
    return {
        "source": "source_blocks",
        "dpe_class": dpe_class,
        "ges_class": ges_class,
        "diagnostic_date": diagnostic_date,
        "evidence": evidence,
    }


def _normalize_energy_class(value: object) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"\b(?:classe\s*)?([A-G])\b", strip_accents(text).upper())
    return match.group(1) if match else None


def _energy_diagnostic_risk_note(diagnostics: dict[str, object] | None) -> str | None:
    if not diagnostics:
        return None
    dpe_class = clean_text(diagnostics.get("dpe_class"))
    if dpe_class in {"F", "G"}:
        return f"DPE {dpe_class}"
    return None


def _merge_risk_notes(*values: str | None) -> str | None:
    seen: set[str] = set()
    notes: list[str] = []
    for value in values:
        for item in (clean_text(part) for part in re.split(r"\s*[|,]\s*", str(value or ""))):
            if item and item not in seen:
                seen.add(item)
                notes.append(item)
    return " | ".join(notes) if notes else None


def _normalization_text(raw_sale: dict[str, object]) -> str:
    return "\n".join(
        part
        for part in (
            clean_text(raw_sale.get("title")),
            clean_text(raw_sale.get("description")),
            clean_text(raw_sale.get("raw_text")),
            _source_blocks_text(raw_sale),
        )
        if part
    )


def _walk_source_blocks(value: object, prefix: str = "") -> list[tuple[str, object]]:
    rows: list[tuple[str, object]] = []
    if isinstance(value, dict):
        for key, nested in value.items():
            key_text = str(key)
            nested_key = f"{prefix}_{key_text}" if prefix else key_text
            rows.append((nested_key, nested))
            rows.extend(_walk_source_blocks(nested, nested_key))
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            nested_key = f"{prefix}_{index}" if prefix else str(index)
            rows.extend(_walk_source_blocks(nested, nested_key))
    return rows


def _normalize_source_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", strip_accents(value).lower()).strip("_")


def _has_value(value: object | None) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(clean_text(value))
    if isinstance(value, (list, dict, tuple, set)):
        return bool(value)
    return True


def _is_generic_listing_title(value: str | None) -> bool:
    text = strip_accents(clean_text(value) or "").lower()
    return text in {"", "autre", "autres", "bien", "vente aux encheres"}


def _skip_contextless_postal_code_fallback(raw_sale: dict[str, object], address: str | None) -> bool:
    source_name = strip_accents(clean_text(raw_sale.get("source_name")) or "").lower()
    if source_name in {"cessions_etat", "encheres_publiques", "petites_affiches"}:
        return True
    return bool(address and source_name == "licitor")


def _extract_asset_title_from_text(text: str) -> str | None:
    for pattern in (
        r"\bVente\s+aux\s+ench[èe]res\s+(?:Autres?|Other)\s+(.+?)(?:\b\d{5}\b|Mise\s+[àa]\s+prix|Date\s+de\s+la\s+vente)",
        r"\bAvoventes\.fr\s+(.+?)\s+-\s+[0-9][0-9\s.,]*\s*(?:€|euros?)",
    ):
        for match in re.finditer(pattern, text, re.I | re.S):
            title = clean_text(match.group(1).strip(" -"))
            if _looks_like_asset_title(title):
                return title
    return None


def _looks_like_asset_title(value: str | None) -> bool:
    title = clean_text(value)
    if not title or _is_generic_listing_title(title):
        return False
    lowered = strip_accents(title).lower()
    if re.match(r"^(?:mise\s+a\s+prix|date\s+de\s+la\s+vente|frais|adjudication|surenchere)\b", lowered):
        return False
    if re.search(r"\b(?:mise\s+a\s+prix|frais\s+prealables?|adjudication|surenchere)\b", lowered):
        return False
    if re.search(
        r"\b(?:appartement|maison|immeuble|terrain|parcelles?|b[âa]timent|local|commerce|garage|agricole)\b",
        title,
        re.I,
    ):
        return True
    return False


def _normalize_visit_dates(value: object | None) -> list[str]:
    if isinstance(value, list):
        return [text for item in value if (text := clean_text(item))]
    text = clean_text(value)
    return [text] if text else []


def _extract_habitable_surface_from_text(*values: object) -> Decimal | None:
    text = _joined_text(*values)
    patterns = (
        rf"\b(?:surface|superficie)\s+habitable\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
        rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+habitables?\b",
    )
    return _extract_contextual_surface(text, patterns, exclude_secondary=False)


def _extract_carrez_surface_from_text(*values: object) -> Decimal | None:
    text = _joined_text(*values)
    patterns = (
        rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+(?:loi\s+)?carrez\b",
        rf"\b(?:surface\s+)?(?:loi\s+)?carrez\s*(?:totale\s*)?:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
    )
    return _extract_contextual_surface(text, patterns, exclude_secondary=False)


def _extract_land_surface_from_text(*values: object) -> Decimal | None:
    text = _joined_text(*values)
    matches = list(re.finditer(
        r"\b(?:([0-9]+)\s*ha\s*)?([0-9]+)\s*a\s*([0-9]+)\s*ca\b",
        text,
        re.I,
    ))
    if len(matches) > 1:
        # Several cadastral parcels require scoped measurements, not the first value.
        return None
    if matches:
        match = matches[0]
        return Decimal(match.group(1) or 0) * Decimal('10000') + Decimal(match.group(2)) * Decimal('100') + Decimal(match.group(3))
    patterns = (
        rf"\b(?:terrain|parcelle|jardin)\s+(?:de\s+|d['’]une\s+surface\s+de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
        rf"\bcadastr[ée]e?.{{0,120}}?\bpour\s+un\s+total\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
    )
    return _extract_contextual_surface(text, patterns, exclude_secondary=False)


def _extract_built_surface_from_text(*values: object) -> Decimal | None:
    text = _joined_text(*values)
    habitable = _extract_habitable_surface_from_text(text)
    if habitable is not None:
        return habitable
    patterns = (
        rf"\b(?:surface|superficie)\s+(?:des\s+)?lots?\b[^:\n]{{0,80}}:\s*{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
        rf"\bsurface\s+totale\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b",
        rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+superficie\b",
        (
            r"\b(?:un|une|l['’]|le|la)?\s*"
            r"(?:appartement|maison|immeuble|bâtiment|batiment|local|commerce|villa|studio|bien\s+immobilier|ensemble\s+immobilier)\b"
            r".{0,140}?\b(?:de|d['’]une\s+surface\s+de|d['’]une\s+superficie(?:\s+au\s+sol)?\s+de)\s+"
            rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\b"
        ),
        rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+(?:de\s+)?(?:surface\s+)?(?:bâtie|batie)\b",
    )
    built = _extract_contextual_surface(text, patterns)
    if built is not None:
        return built
    return _extract_carrez_surface_from_text(text)


def _extract_contextual_surface(
    text: str,
    patterns: tuple[str, ...],
    *,
    exclude_secondary: bool = True,
) -> Decimal | None:
    if not text:
        return None
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            if exclude_secondary and _is_secondary_surface_context(text, match.start(), match.end()):
                continue
            return parse_surface(match.group(1))
    return None


def _is_secondary_surface_context(text: str, start: int, end: int) -> bool:
    matched_text = text[start:end]
    context = text[max(0, start - 80) : min(len(text), end + 40)]
    if re.search(r"\b(?:surface|superficie)\s+(?:des\s+)?lots?\b", context, re.I):
        return False
    if re.search(r"\bsurface\s+totale\b", context, re.I) and re.search(
        r"\b(?:b[âa]timent|stabulation|hangar|salle\s+de\s+traite|stockage)\b",
        context,
        re.I,
    ):
        return False
    if re.search(
        r"\b(?:cadastr\w*|section\s+[A-Z]{1,4}\b|contenance)\b",
        matched_text,
        re.I,
    ) and not re.search(
        rf"\b(?:appartement|maison|villa|immeuble|b[âa]timent|local|hangar)\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        matched_text,
        re.I | re.S,
    ):
        return True
    if re.search(
        rf"\b(?:appartement|maison|villa|immeuble|b[âa]timent|local|hangar)\b.{{0,60}}?"
        rf"\b(?:de|d['’]une\s+surface\s+de|d['’]une\s+superficie\s+de)\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        context,
        re.I | re.S,
    ):
        return False
    if re.search(r"\b(?:terrain|parcelle|cadastr\w*|jardin|terrasse|balcon)\b", context, re.I):
        return True
    if re.search(r"\b(?:sous-sol|cave|cellier|garage|d[ée]pendance|annexe|r[ée]serve)\b", context, re.I):
        return not re.search(r"\b(?:surface|superficie)\s+habitable\b", context, re.I)
    return False


def _extract_bathrooms_count_from_text(*values: object) -> int | None:
    text = _joined_text(*values)
    patterns = (
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq)\s+salles?\s+d(?:e\s+bains?|['’]eau)\b",
        r"\bsalles?\s+d(?:e\s+bains?|['’]eau)\s*:?\s*([1-9][0-9]?|une?|deux|trois|quatre|cinq)\b",
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            return _parse_count_token(match.group(1))
    if re.search(r"\bsalle\s+d(?:e\s+bains?|['’]eau)\b|\bsdb\b", text, re.I):
        return 1
    return None


def _extract_parking_count_from_text(*values: object) -> int | None:
    text = _joined_text(*values)
    patterns = (
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq)\s+(?:places?\s+de\s+)?(?:parking|stationnement)\b",
        r"\b(?:parking|stationnement)\s*:?\s*([1-9][0-9]?|une?|deux|trois|quatre|cinq)\b",
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            return _parse_count_token(match.group(1))
    if re.search(r"\b(?:place\s+de\s+parking|stationnement|garage)\b", text, re.I):
        return 1
    return None


def _extract_occupancy_status_from_text(*values: object) -> str | None:
    text = strip_accents(_joined_text(*values)).lower()
    if not text:
        return None
    if re.search(r"sans\s+droit\s+ni\s+titre|squat", text):
        return "squatted"
    if re.search(r"proprietaire\s+occupant|occupe(?:e?s?)?\s+par\s+le\s+proprietaire", text):
        return "owner_occupied"
    if has_rented_occupancy_signal(text):
        return "rented"
    if re.search(
        r"libre\s+(?:de\s+toute\s+occupation|d['’]occupation)|"
        r"bien\s+libre|"
        r"\b(?:appartement|maison|immeuble|local|logement)\s+libre\b|"
        r"inoccupe(?:e?s?)?|vacant",
        text,
    ):
        return "vacant"
    if no_lease_status := no_lease_occupancy_status(text):
        return no_lease_status
    if re.search(r"\boccupe(?:e?s?)?\b", text):
        return "occupied"
    return None


def _surface_evidence_for_value(text: str, value: Decimal | None) -> str | None:
    if not text or value is None:
        return None
    normalized = format(value, "f").rstrip("0").rstrip(".")
    if not normalized:
        return None
    whole, dot, fraction = normalized.partition(".")
    whole_pattern = _integer_with_optional_thousand_separators_pattern(whole)
    if dot:
        number_pattern = rf"{whole_pattern}[,.]{re.escape(fraction)}0*"
    else:
        number_pattern = rf"{whole_pattern}(?:[,.]0+)?"
    match = re.search(rf"([^\n.;]{{0,180}}{number_pattern}\s*m(?:2|²)\b[^\n.;]{{0,180}})", text, re.I)
    return clean_text(match.group(1)) if match else None


def _integer_with_optional_thousand_separators_pattern(value: str) -> str:
    if len(value) <= 3:
        return re.escape(value)
    first_group_length = len(value) % 3 or 3
    groups = [value[:first_group_length]]
    groups.extend(value[index : index + 3] for index in range(first_group_length, len(value), 3))
    return r"[\s.]?".join(re.escape(group) for group in groups)


def _feature_bool(value: object | None, text: str, *patterns: str) -> bool | None:
    explicit = _parse_bool(value)
    if explicit is not None:
        return explicit
    return True if any(re.search(pattern, text, re.I) for pattern in patterns) else None


def _joined_text(*values: object) -> str:
    return " ".join(text for value in values if (text := clean_text(value)))


def _parse_bool(value: object | None) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = clean_text(value)
    if not text:
        return None
    lowered = text.lower()
    if lowered in {"1", "true", "yes", "oui", "vrai"}:
        return True
    if lowered in {"0", "false", "no", "non", "faux"}:
        return False
    return None
