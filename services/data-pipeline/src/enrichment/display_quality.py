"""Versioned display checks; source quotations are not an exhaustive legal analysis."""
from __future__ import annotations

import re
from typing import Any

DISPLAY_QUALITY_VERSION = "display_quality_20260911_v2"
# Keep the entire sentence, including negation and uncertainty. Never infer a risk
# from a keyword or from unrelated PDF boilerplate.
SOURCE_CONSTRAINT_RE = re.compile(
    r"\b(?:non[\s-]+constructibles?|inconstructibles?|emplacements?\s+r[ée]serv[ée]s?|"
    r"servitudes?|arr[êe]t[ée]\s+(?:de\s+)?(?:p[ée]ril|mise\s+en\s+s[ée]curit[ée])|"
    r"indivis(?:e|es)?|insalubrit[ée]|interdiction\s+d['’]habiter|squatt[ée]s?)\b", re.I,
)


def has_current_display(payload: Any, prompt_version: str | None = None) -> bool:
    if not isinstance(payload, dict):
        return False
    text = payload.get("llm_display_description")
    return bool(
        isinstance(text, str) and text.strip()
        and payload.get("llm_display_quality_version") == DISPLAY_QUALITY_VERSION
        and payload.get("llm_display_status") in {"accepted", "fallback"}
        and (not prompt_version or payload.get("llm_prompt_version") == prompt_version)
    )


def preserve_source_constraints(
    description: str | None, source_description: str | None, *, max_chars: int, max_words: int,
    extra_quotes: list[str] | None = None,
) -> tuple[str | None, list[str]]:
    """Fit verbatim source sentences first, then as much narrative as fits.

    If all quotations cannot fit, return no validated display. Full evidence is
    still retained separately, rather than silently dropping a constraint.
    """
    source = re.sub(r"\s+", " ", source_description or "").strip()
    sentences = re.split(r"(?<=[.!?])\s+|(?<=\.)\)\s+|(?=,\s+comprenant\s*:)|(?:-\s*){3,}", source)
    quotes = list(dict.fromkeys(s.strip() for s in sentences if SOURCE_CONSTRAINT_RE.search(s)))
    # Extra quotations must occur verbatim in the current source description.
    extra_quotes = extra_quotes if isinstance(extra_quotes, list) else []
    extra = [re.sub(r"\s+", " ", q).strip() for q in (extra_quotes or []) if isinstance(q, str)]
    quotes = list(dict.fromkeys([*quotes, *(q for q in extra if q and q in source)]))
    if not description or not quotes:
        return description, quotes
    suffix = "Source : " + " ".join(f"« {quote} »" for quote in quotes)
    if len(suffix) > max_chars or len(suffix.split()) > max_words:
        return None, quotes
    # Avoid claiming paraphrase equivalence: exact quotation preserves qualifiers.
    narrative = description
    while narrative and (len(narrative + " " + suffix) > max_chars
                         or len((narrative + " " + suffix).split()) > max_words):
        narrative = narrative.rsplit(" ", 1)[0] if " " in narrative else ""
    if narrative != description:
        # Never cut the narrative in the middle of a claim.
        ends = list(re.finditer(r"[.!?](?=\s|$)", narrative))
        narrative = narrative[:ends[-1].end()] if ends else ""
    return " ".join(filter(None, (narrative, suffix))), quotes
