from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from src.sources.common import is_allowed_origin_url

SOURCE_ORIGINS: dict[str, tuple[str, ...]] = {
    "avoventes": ("https://avoventes.fr", "https://www.avoventes.fr"),
    "licitor": ("https://www.licitor.com", "https://licitor.com"),
    "vench": ("https://www.vench.fr", "https://vench.fr"),
    "info_encheres": ("https://www.info-encheres.com", "https://info-encheres.com"),
    "encheres_publiques": ("https://www.encheres-publiques.com", "https://encheres-publiques.com"),
    "petites_affiches": ("https://www.petitesaffiches.fr", "https://petitesaffiches.fr"),
    "cessions_etat": ("https://cessions.immobilier-etat.gouv.fr",),
    # Official AGRASC cards link directly to these two auction operators.
    "agrasc": ("https://agrasc.gouv.fr", "https://www.agorastore-immo.fr", "https://www.immo-interactif.fr"),
    "encheres_immobilieres": ("https://encheresimmobilieres.fr", "https://www.encheresimmobilieres.fr"),
    "notaires": (
        "https://www.immobilier.notaires.fr",
        "https://immobilier.notaires.fr",
        "https://www.immo-interactif.fr",
        "https://immo-interactif.fr",
    ),
}


class RawAuctionSale(BaseModel):
    model_config = ConfigDict(extra="allow")

    source_name: str
    source_url: str
    external_id: str | None = None
    department: str | None = None
    city: str | None = None
    title: str | None = None
    description: str | None = None
    raw_text: str | None = None
    documents: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("source_name", "source_url", mode="before")
    @classmethod
    def require_non_empty_text(cls, value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValueError("required non-empty text")
        return text

    @field_validator("documents", mode="before")
    @classmethod
    def normalize_documents(cls, value: Any) -> list[dict[str, Any]]:
        return value if isinstance(value, list) else []

    @model_validator(mode="after")
    def require_content_signal(self) -> RawAuctionSale:
        if not any(_has_text(value) for value in (self.title, self.description, self.raw_text)):
            raise ValueError("missing title, description or raw_text")
        allowed_origins = SOURCE_ORIGINS.get(self.source_name)
        if allowed_origins and not is_allowed_origin_url(self.source_url, allowed_origins):
            raise ValueError(f"source_url does not belong to source {self.source_name}")
        return self


class RawAvoventesSale(RawAuctionSale):
    source_name: Literal["avoventes"]


class RawLicitorSale(RawAuctionSale):
    source_name: Literal["licitor"]


class RawVenchSale(RawAuctionSale):
    source_name: Literal["vench"]


class RawInfoEncheresSale(RawAuctionSale):
    source_name: Literal["info_encheres"]


class RawEncheresPubliquesSale(RawAuctionSale):
    source_name: Literal["encheres_publiques"]


class RawPetitesAffichesSale(RawAuctionSale):
    source_name: Literal["petites_affiches"]


class RawCessionsEtatSale(RawAuctionSale):
    source_name: Literal["cessions_etat"]


class RawAgrascSale(RawAuctionSale):
    source_name: Literal["agrasc"]


class RawEncheresImmobilieresSale(RawAuctionSale):
    source_name: Literal["encheres_immobilieres"]


class RawNotairesSale(RawAuctionSale):
    source_name: Literal["notaires"]


SOURCE_MODELS: dict[str, type[RawAuctionSale]] = {
    "avoventes": RawAvoventesSale,
    "licitor": RawLicitorSale,
    "vench": RawVenchSale,
    "info_encheres": RawInfoEncheresSale,
    "encheres_publiques": RawEncheresPubliquesSale,
    "petites_affiches": RawPetitesAffichesSale,
    "cessions_etat": RawCessionsEtatSale,
    "agrasc": RawAgrascSale,
    "encheres_immobilieres": RawEncheresImmobilieresSale,
    "notaires": RawNotairesSale,
}


def validate_raw_sales(
    source_name: str,
    raw_sales: list[dict[str, Any]],
    errors: list[str],
) -> list[dict[str, Any]]:
    model = SOURCE_MODELS[source_name]
    valid: list[dict[str, Any]] = []
    for sale in raw_sales:
        try:
            model.model_validate(sale)
        except ValidationError as exc:
            marker = sale.get("source_url") or sale.get("external_id") or "unknown"
            errors.append(f"validation {marker}: {_compact_validation_error(exc)}")
            continue
        valid.append(sale)
    return valid


def _compact_validation_error(exc: ValidationError) -> str:
    parts: list[str] = []
    for item in exc.errors():
        loc = ".".join(str(part) for part in item.get("loc", ())) or "root"
        parts.append(f"{loc}: {item.get('msg')}")
    return "; ".join(parts)


def _has_text(value: str | None) -> bool:
    return bool(value and value.strip())
