import json
from decimal import Decimal

import pytest

from src.enrichment import llm_client as llm_client_module
from src.enrichment.extract_structured import (
    LLMExtraction,
    build_reduced_pdf_context,
    enrich_sale_with_llm,
    extract_source_description,
    load_llm_context_for_sale,
    load_llm_fact_context_chunks_for_sale,
)
from src.enrichment.llm_client import (
    ReplicateClient,
    _retry_sleep_seconds,
    _stringify_output,
    _user_prompt_for_model,
    parse_json_response,
)
from src.normalize import normalize_sale
from src.pdf_enrichment import sale_storage_id


class FakeReplicateClient:
    calls = 0

    def is_available(self) -> bool:
        return True

    def generate_json(self, system_prompt: str, user_prompt: str):
        self.calls += 1
        return {
            "property_type": "house",
            "surface_m2": 91.4,
            "rooms_count": 4,
            "bedrooms_count": 3,
            "occupancy_status": "rented",
            "occupancy_details": "Bail mentionné dans le cahier.",
            "display_description": (
                "Maison de 91,4 m² décrite par la source, avec occupation locative et "
                "points techniques à vérifier avant l'audience."
            ),
            "legal_risks": ["servitude de passage"],
            "physical_risks": ["amiante"],
            "copropriete": False,
            "servitudes": ["passage"],
            "works_needed": "Rafraîchissement à prévoir",
            "summary": "Maison avec occupation locative et diagnostics mentionnant de l'amiante.",
            "investor_notes": "Vérifier le bail.",
            "confidence": {
                "property_type": 0.8,
                "surface_m2": 0.9,
                "rooms_count": 0.85,
                "bedrooms_count": 0.85,
                "occupancy_status": 0.8,
                "legal_risks": 0.7,
                "physical_risks": 0.7,
                "display_description": 0.9,
                "summary": 0.7,
            },
        }


class LowConfidenceClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["confidence"] = {
            "property_type": 0.69,
            "surface_m2": 0.69,
            "rooms_count": 0.69,
            "bedrooms_count": 0.69,
            "occupancy_status": 0.69,
        }
        return payload


class InconsistentBedroomsClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["rooms_count"] = 2
        payload["bedrooms_count"] = 4
        payload["confidence"]["rooms_count"] = 0.9
        payload["confidence"]["bedrooms_count"] = 0.9
        return payload


class CorroboratedLowConfidenceCountsClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["rooms_count"] = 4
        payload["bedrooms_count"] = 2
        payload["confidence"]["rooms_count"] = 0.62
        payload["confidence"]["bedrooms_count"] = 0.62
        return payload


class FailingReplicateClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        raise ValueError("Replicate returned invalid JSON after retry")


class LongDisplayDescriptionClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["display_description"] = "Synthèse : " + " ".join(
            f"information{i}" for i in range(140)
        )
        payload["confidence"]["display_description"] = 0.95
        return payload


class LowConfidenceDisplayDescriptionClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["confidence"]["display_description"] = 0.4
        return payload


class MissingDisplayDescriptionClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["display_description"] = None
        payload["confidence"].pop("display_description", None)
        return payload


class DisplayOnlyClient:
    calls = 0

    def __init__(self) -> None:
        self.system_prompt = ""
        self.user_prompt = ""

    def is_available(self) -> bool:
        return True

    def generate_json(self, system_prompt: str, user_prompt: str):
        self.calls += 1
        self.system_prompt = system_prompt
        self.user_prompt = user_prompt
        return {
            "display_description": (
                "Maison à Bordeaux décrite dans le contexte fourni, avec surface et occupation "
                "à vérifier selon les documents disponibles."
            ),
            "confidence": {"display_description": 0.86},
        }


class StructuredRoomSurfaceClient:
    calls = 0

    def is_available(self) -> bool:
        return True

    def generate_json(self, system_prompt: str, user_prompt: str):
        self.calls += 1
        if self.calls > 1:
            return {
                "display_description": (
                    "Maison dont la surface habitable de 57,74 m² est reconstituée à partir "
                    "des mesures de chaque pièce du procès-verbal."
                ),
                "confidence": {"display_description": 0.91},
            }
        measurements = [
            ("entrée", "circulation", "5.00", "Entrée 5,00 m²"),
            ("cuisine", "service", "8.00", "cuisine 8,00 m²"),
            ("séjour", "habitable", "19.56", "séjour 19,56 m²"),
            ("chambre 1", "habitable", "9.41", "chambre 9,41 m²"),
            ("chambre 2", "habitable", "11.40", "chambre 11,40 m²"),
            ("salle d'eau", "sanitary", "4.37", "salle d'eau 4,37 m²"),
        ]
        return {
            "property_type": "house",
            "assets": [
                {
                    "asset_id": "asset-main",
                    "property_type": "house",
                    "measurement_completeness": "complete",
                    "spaces": [
                        {
                            "space_label": label,
                            "category": category,
                            "value_m2": value,
                            "included_in_habitable_sum": True,
                            "confidence": 0.94,
                            "evidence": {"quote": quote, "document_label": "PV descriptif", "page_number": 4},
                        }
                        for label, category, value, quote in measurements
                    ],
                }
            ],
            "confidence": {"property_type": 0.95},
        }


def test_parse_json_response_handles_markdown_fence() -> None:
    parsed = parse_json_response('```json\n{"surface_m2": 80}\n```')
    assert parsed == {"surface_m2": 80}


def test_parse_json_response_reports_plain_text_excerpt() -> None:
    with pytest.raises(ValueError, match="response_excerpt='Je suis une réponse sans objet JSON'"):
        parse_json_response("Je suis une réponse sans objet JSON")


def test_parse_json_response_reports_invalid_json_excerpt() -> None:
    with pytest.raises(ValueError, match="response_excerpt='avant \\{\"surface_m2\": \\} après'"):
        parse_json_response('avant {"surface_m2": } après')


def test_parse_json_response_handles_escaped_json_object() -> None:
    parsed = parse_json_response(r'{\"display_description\": \"Terrain de 716 m² en centre-ville.\"}')
    assert parsed == {"display_description": "Terrain de 716 m² en centre-ville."}


def test_parse_json_response_handles_escaped_json_object_inside_text() -> None:
    parsed = parse_json_response(
        r'avant {\"display_description\": \"Maison avec jardin.\", \"confidence\": {\"display_description\": 0.7}} après'
    )
    assert parsed == {
        "display_description": "Maison avec jardin.",
        "confidence": {"display_description": 0.7},
    }


def test_replicate_client_formats_output_list_and_payload() -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="moonshotai/kimi-k2.5",
        max_tokens=123,
        temperature=0.6,
    )

    payload = client._input_payload("system\n\nuser")

    assert "system_prompt" not in payload
    assert payload["prompt"] == "system\n\nuser"
    assert payload["max_tokens"] == 123
    assert payload["temperature"] == 0.6
    assert payload["top_p"] == 1
    assert payload["presence_penalty"] == 0
    assert payload["frequency_penalty"] == 0
    assert parse_json_response(''.join(['{"surface_m2":', "80}"])) == {"surface_m2": 80}
    assert _stringify_output(["", "", "{", '"surface_m2"', ":80}"]) == '{"surface_m2":80}'


def test_replicate_client_accepts_plain_text_for_display_description_mode(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="moonshotai/kimi-k2.5",
        min_interval_seconds=0,
    )
    calls = 0

    def fake_create_prediction(prompt: str, system_prompt: str | None = None):
        nonlocal calls
        calls += 1
        return {"id": "prediction-test"}

    monkeypatch.setattr(client, "_create_prediction", fake_create_prediction)
    monkeypatch.setattr(
        client,
        "_wait_for_output",
        lambda prediction: (
            "Maison de ville comprenant plusieurs niveaux, jardin et garage, avec travaux "
            "à prévoir selon les informations disponibles dans l'annonce."
        ),
    )

    payload = client.generate_json("MODE SYNTHESE STRICTE. Réponds en JSON.", "Texte fourni")

    assert calls == 1
    assert payload == {
        "display_description": (
            "Maison de ville comprenant plusieurs niveaux, jardin et garage, avec travaux "
            "à prévoir selon les informations disponibles dans l'annonce."
        ),
        "confidence": {"display_description": 0.58},
    }


def test_replicate_client_accepts_jsonish_display_description(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="moonshotai/kimi-k2.5",
        min_interval_seconds=0,
    )

    monkeypatch.setattr(client, "_create_prediction", lambda prompt, system_prompt=None: {"id": "prediction-test"})
    monkeypatch.setattr(
        client,
        "_wait_for_output",
        lambda prediction: (
            r'{\"display_description\": \"Ce terrain à bâtir de 716 m² est situé en centre-ville '
            r'de Paimpol, rue de Goas Plat. Le bien est clos de murs'
        ),
    )

    payload = client.generate_json("MODE SYNTHESE STRICTE. Réponds en JSON.", "Texte fourni")

    assert payload == {
        "display_description": (
            "Ce terrain à bâtir de 716 m² est situé en centre-ville de Paimpol, "
            "rue de Goas Plat. Le bien est clos de murs"
        ),
        "confidence": {"display_description": 0.58},
    }


def test_replicate_client_does_not_retry_unrecoverable_display_description(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="moonshotai/kimi-k2.5",
        min_interval_seconds=0,
    )
    calls = 0

    def fake_create_prediction(prompt: str, system_prompt: str | None = None):
        nonlocal calls
        calls += 1
        return {"id": "prediction-test"}

    monkeypatch.setattr(client, "_create_prediction", fake_create_prediction)
    monkeypatch.setattr(client, "_wait_for_output", lambda prediction: "{")

    with pytest.raises(ValueError, match="Replicate returned invalid JSON without retry"):
        client.generate_json("MODE SYNTHESE STRICTE. Réponds en JSON.", "Texte fourni")

    assert calls == 1


def test_replicate_client_rejects_plain_text_for_full_extraction(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="moonshotai/kimi-k2.5",
        min_interval_seconds=0,
    )
    outputs = [
        "Maison de ville comprenant plusieurs niveaux et un jardin.",
        "Toujours pas un objet JSON valide.",
    ]

    monkeypatch.setattr(client, "_create_prediction", lambda prompt, system_prompt=None: {"id": "prediction-test"})
    monkeypatch.setattr(client, "_wait_for_output", lambda prediction: outputs.pop(0))

    with pytest.raises(ValueError, match="Replicate returned invalid JSON after retry"):
        client.generate_json("MODE EXTRACTION STRICTE.", "Texte fourni")


def test_replicate_client_formats_gemini_payload() -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="google/gemini-2.5-flash",
        max_tokens=8192,
        temperature=0,
        thinking_budget=0,
        dynamic_thinking=False,
    )

    payload = client._input_payload("user prompt", system_prompt="system prompt")

    assert payload["prompt"] == "user prompt"
    assert payload["system_instruction"] == "system prompt"
    assert payload["max_output_tokens"] == 8192
    assert payload["temperature"] == 0
    assert payload["thinking_budget"] == 0
    assert payload["dynamic_thinking"] is False
    assert "max_tokens" not in payload
    assert "presence_penalty" not in payload


def test_replicate_client_uses_gemini_3_thinking_level_without_legacy_fields() -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="google/gemini-3.5-flash",
        max_tokens=8192,
        temperature=0,
        thinking_level="low",
    )

    payload = client._input_payload("user prompt", system_prompt="system prompt")

    assert payload["max_output_tokens"] == 8192
    assert payload["thinking_level"] == "low"
    assert "thinking_budget" not in payload
    assert "dynamic_thinking" not in payload


def test_replicate_client_formats_qwen37_payload() -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="qwen/qwen3-7-plus",
        max_tokens=8192,
        temperature=0,
    )

    payload = client._input_payload("user prompt", system_prompt="system prompt")

    assert payload == {
        "prompt": "user prompt",
        "system_prompt": "system prompt",
        "max_tokens": 8192,
        "temperature": 0,
        "top_p": 0.8,
        "presence_penalty": 0,
        "frequency_penalty": 0,
    }


def test_qwen37_keeps_system_and_user_prompts_separate() -> None:
    prompt = _user_prompt_for_model(
        "qwen/qwen3-7-plus",
        "system prompt unique marker",
        "user prompt",
    )

    assert prompt.startswith("user prompt")
    assert "system prompt unique marker" not in prompt
    assert "objet JSON valide" in prompt


def test_replicate_client_formats_qwen2_7b_instruct_payload() -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model=(
            "zsxkib/qwen2-7b-instruct:"
            "5324178307f5ec0239326b429d6b64ae338cd6b51fbe234402a55537a9998ac4"
        ),
        max_tokens=512,
        temperature=0,
    )

    payload = client._input_payload("user prompt", system_prompt="system prompt")

    assert payload == {
        "prompt": "user prompt",
        "system_prompt": "system prompt",
        "model_type": "Qwen2-7B-Instruct",
        "max_new_tokens": 512,
        "temperature": 0.1,
        "top_k": 1,
        "top_p": 1,
        "repetition_penalty": 1,
    }


def test_replicate_client_uses_pinned_predictions_endpoint_for_qwen2_7b(monkeypatch) -> None:
    model = (
        "zsxkib/qwen2-7b-instruct:"
        "5324178307f5ec0239326b429d6b64ae338cd6b51fbe234402a55537a9998ac4"
    )
    client = ReplicateClient(
        api_token="replicate-token-test",
        model=model,
        min_interval_seconds=0,
    )
    captured: dict[str, object] = {}

    class FakeResponse:
        def json(self):
            return {"id": "prediction-test", "status": "starting"}

    def fake_post(endpoint, *, headers, payload):
        captured["endpoint"] = endpoint
        captured["headers"] = headers
        captured["payload"] = payload
        return FakeResponse()

    monkeypatch.setattr(client, "_post_with_retries", fake_post)

    prediction = client._create_prediction("user prompt", system_prompt="system prompt")

    assert prediction["id"] == "prediction-test"
    assert captured["endpoint"] == "https://api.replicate.com/v1/predictions"
    assert captured["payload"]["version"] == model
    assert captured["payload"]["input"]["model_type"] == "Qwen2-7B-Instruct"


def test_replicate_rate_limit_tracks_prediction_starts(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="google/gemini-2.5-flash",
        min_interval_seconds=10,
    )
    now = {"value": 100.0}
    sleeps: list[float] = []

    monkeypatch.setattr(llm_client_module, "_LAST_REPLICATE_REQUEST_AT", 0.0)
    monkeypatch.setattr(llm_client_module.time, "monotonic", lambda: now["value"])

    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now["value"] += seconds

    monkeypatch.setattr(llm_client_module.time, "sleep", fake_sleep)

    client._respect_min_interval()
    now["value"] += 5
    client._mark_request_finished()
    client._respect_min_interval()

    assert sleeps == [5]
    assert llm_client_module._LAST_REPLICATE_REQUEST_AT == 110.0


def test_replicate_retry_sleep_uses_retry_after_header() -> None:
    class Response:
        status_code = 503
        headers = {"Retry-After": "7"}

    assert _retry_sleep_seconds(3, Response(), backoff_seconds=20, max_sleep_seconds=180) == 7


def test_replicate_retry_sleep_keeps_429_backoff_conservative() -> None:
    class Response:
        status_code = 429
        headers = {"Retry-After": "1"}

    assert _retry_sleep_seconds(1, Response(), backoff_seconds=20, max_sleep_seconds=180) == 20


def test_replicate_retry_sleep_uses_capped_exponential_backoff() -> None:
    assert _retry_sleep_seconds(1, None, backoff_seconds=20, max_sleep_seconds=50) == 20
    assert _retry_sleep_seconds(3, None, backoff_seconds=20, max_sleep_seconds=50) == 50


def test_llm_extraction_validates_values_and_confidence() -> None:
    extraction = LLMExtraction.model_validate(
        {
            "property_type": "house",
            "rooms_count": "T3",
            "bedrooms_count": "2 chambres",
            "occupancy_status": "free",
            "legal_risks": [{"description": "Procédure en cours"}],
            "physical_risks": None,
            "servitudes": [{"description": "Passage commun"}],
            "works_needed": ["Radiateurs vétustes", "Rafraîchissement"],
            "copropriete": {"shares": "moitié indivise"},
            "confidence": {"surface_m2": 2},
        }
    )

    assert extraction.legal_risks == ["description: Procédure en cours"]
    assert extraction.servitudes == ["description: Passage commun"]
    assert extraction.works_needed == "Radiateurs vétustes; Rafraîchissement"
    assert extraction.occupancy_status == "vacant"
    assert extraction.copropriete is None
    assert extraction.rooms_count == 3
    assert extraction.bedrooms_count == 2
    assert extraction.confidence["surface_m2"] == 1.0


def test_extract_source_description_prefers_usable_source_blocks() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-source-description.html",
            "description": "Pour consulter l'intégralité des informations disponibles, vous devez être abonné.",
            "raw_text": "Texte de page trop générique.",
            "source_blocks": {
                "description": "Appartement de type trois avec balcon, cave et stationnement privatif.",
                "page_text": "Texte complet de page avec navigation et informations annexes.",
            },
        }
    )

    assert extract_source_description(sale) == (
        "Appartement de type trois avec balcon, cave et stationnement privatif."
    )


def test_enrich_sale_with_llm_uses_cached_pdf_text_and_preserves_reliable_fields(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm",
            "property_type": "Appartement",
            "source_blocks": {
                "description": "Maison de 91,4 m² avec occupation locative indiquée par la source."
            },
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    out_dir = tmp_path / "llm_extractions"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_PDF_MAX_CHARS", "5000")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Surface 91,4 m2. Bien loué. Amiante."}]),
        encoding="utf-8",
    )

    stats = enrich_sale_with_llm(sale, client=FakeReplicateClient(), output_dir=out_dir)

    assert stats.analyzed == 1
    assert stats.valid_json == 1
    assert sale.surface_m2 == Decimal("91.4")
    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 3
    assert sale.occupancy_status == "rented"
    assert sale.property_type == "apartment"
    assert sale.raw_payload["llm_display_description"].startswith("Maison de 91,4 m²")
    assert "llm_extraction" in sale.raw_payload
    assert (out_dir / f"{sale_storage_id(sale)}.json").exists()

    second_stats = enrich_sale_with_llm(sale, client=(stats_client := FakeReplicateClient()), output_dir=out_dir)
    assert second_stats.valid_json == 1
    assert stats_client.calls == 0


def test_enrich_sale_with_llm_writes_display_description_without_source_description(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-display-from-pdf",
            "title": "Maison à Bordeaux",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_PROMPT_VERSION", "auction_llm_v5_test")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps(
            [
                {
                    "label": "PV descriptif",
                    "document_type": "pv_descriptif",
                    "text": "Maison de 91,4 m2 comprenant séjour, cuisine et trois chambres. Bien loué.",
                }
            ]
        ),
        encoding="utf-8",
    )

    stats = enrich_sale_with_llm(sale, client=FakeReplicateClient(), output_dir=tmp_path / "out")

    assert stats.valid_json == 1
    assert "source_description" not in sale.raw_payload
    assert sale.raw_payload["llm_display_description"].startswith("Maison de 91,4 m²")
    assert sale.raw_payload["llm_prompt_version"] == "auction_llm_v5_test"


def test_enrich_sale_with_llm_can_use_display_description_mode(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-display-only",
            "title": "Maison à Bordeaux",
            "source_blocks": {"description": "Maison de 91,4 m2 indiquée comme louée."},
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_EXTRACTION_MODE", "display_description")
    monkeypatch.setenv("LLM_PROMPT_VERSION", "auction_llm_v6_display_test")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Maison de 91,4 m2. Bien loué."}]),
        encoding="utf-8",
    )
    client = DisplayOnlyClient()

    stats = enrich_sale_with_llm(sale, client=client, output_dir=tmp_path / "out")

    assert stats.valid_json == 1
    assert client.calls == 1
    assert "MODE SYNTHESE STRICTE" in client.system_prompt
    assert "investment_facts" not in client.user_prompt
    assert "display_description" in client.user_prompt
    assert sale.raw_payload["llm_display_description"].startswith("Maison à Bordeaux")
    assert sale.raw_payload["llm_prompt_version"] == "auction_llm_v6_display_test"


def test_enrich_sale_with_llm_normalizes_display_description_length(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-display-length",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Texte suffisant avec surface, occupation et composition."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=LongDisplayDescriptionClient(), output_dir=tmp_path / "out")

    display_description = sale.raw_payload["llm_display_description"]
    assert display_description.startswith("information0")
    assert len(display_description.split()) <= 115
    assert "\n" not in display_description
    assert display_description.endswith(".")


def test_enrich_sale_with_llm_builds_fallback_display_description(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-display-fallback",
            "city": "Bordeaux",
            "department": "33",
            "has_garden": True,
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_PROMPT_VERSION", "auction_llm_v5_test")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Maison de 91,4 m2 avec trois chambres. Bien loué."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=MissingDisplayDescriptionClient(), output_dir=tmp_path / "out")

    display_description = sale.raw_payload["llm_display_description"]
    assert display_description.startswith("Maison à Bordeaux (33).")
    assert "surface de 91,4 m²" in display_description
    assert "4 pièces" in display_description
    assert "3 chambres" in display_description
    assert "jardin" in display_description
    assert "loué" in display_description
    assert sale.raw_payload["llm_display_description_word_count"] == len(display_description.split())
    assert "llm_prompt_version" not in sale.raw_payload  # fallback is not a successful model synthesis


def test_enrich_sale_with_llm_falls_back_from_low_confidence_display_description(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-display-low-confidence",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Texte suffisant pour déclencher le LLM."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=LowConfidenceDisplayDescriptionClient(), output_dir=tmp_path / "out")

    display_description = sale.raw_payload["llm_display_description"]
    assert not display_description.startswith("Maison de 91,4 m² décrite par la source")
    assert display_description.startswith("Maison.")
    assert "surface de 91,4 m²" in display_description
    assert sale.raw_payload["llm_display_description_word_count"] == len(display_description.split())


def test_enrich_sale_with_llm_can_replace_unreliable_other_property_type(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-other",
            "property_type": "Autre",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Une maison avec surface."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=FakeReplicateClient(), output_dir=tmp_path / "out")

    assert sale.property_type == "house"


def test_enrich_sale_with_llm_rejects_low_confidence_structured_values(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-low-confidence",
            "property_type": "Autre",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Texte ambigu avec surface et occupation."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=LowConfidenceClient(), output_dir=tmp_path / "out")

    assert sale.surface_m2 is None
    assert sale.rooms_count is None
    assert sale.bedrooms_count is None
    assert sale.occupancy_status is None
    assert sale.property_type == "other"


def test_enrich_sale_with_llm_accepts_low_confidence_counts_when_text_corroborates(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-corroborated-counts",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Désignation : appartement de type 4 comprenant séjour et deux chambres."}]),
        encoding="utf-8",
    )

    stats = enrich_sale_with_llm(sale, client=CorroboratedLowConfidenceCountsClient(), output_dir=tmp_path / "out")

    assert stats.rooms_extracted == 1
    assert stats.bedrooms_extracted == 1
    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 2


def test_enrich_sale_with_llm_rejects_bedrooms_greater_than_rooms(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-inconsistent-counts",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Maison T2 avec quatre chambres selon sortie incohérente."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=InconsistentBedroomsClient(), output_dir=tmp_path / "out")

    assert sale.rooms_count == 2
    assert sale.bedrooms_count is None


def test_enrich_sale_with_llm_records_failure_context(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-failure",
            "title": "Maison avec documents",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Texte suffisant pour déclencher le LLM."}]),
        encoding="utf-8",
    )

    stats = enrich_sale_with_llm(sale, client=FailingReplicateClient(), output_dir=tmp_path / "out")

    assert stats.errors == 1
    assert stats.error_messages
    assert "https://avoventes.fr/enchere/llm-failure" in stats.error_messages[0]
    assert "invalid JSON" in stats.error_messages[0]


def test_build_reduced_pdf_context_keeps_priority_headers_and_keyword_windows() -> None:
    long_noise = "Texte sans intérêt. " * 300
    payload = [
        {
            "label": "Cahier des conditions de vente.pdf",
            "document_type": "cahier_conditions",
            "text": "PREMIERE PAGE CAHIER. " + long_noise,
        },
        {
            "label": "Diagnostics.pdf",
            "document_type": "diagnostics",
            "text": long_noise + " Le diagnostic mentionne amiante, plomb et DPE. " + long_noise,
        },
    ]

    context = build_reduced_pdf_context(payload, max_chars=4000, first_page_chars=500, window_chars=600)

    assert context is not None
    assert len(context) <= 4000
    assert "PREMIERE PAGE CAHIER" in context
    assert "amiante" in context
    assert "plomb" in context
    assert "DPE" in context


def test_build_reduced_pdf_context_keeps_composition_windows() -> None:
    long_noise = "Texte sans intérêt. " * 300
    payload = [
        {
            "label": "PV descriptif.pdf",
            "document_type": "pv_descriptif",
            "text": long_noise + " Composition : appartement type trois comprenant séjour, cuisine et deux chambres. " + long_noise,
        }
    ]

    context = build_reduced_pdf_context(payload, max_chars=2500, first_page_chars=200, window_chars=700)

    assert context is not None
    assert "Composition" in context
    assert "type trois" in context
    assert "deux chambres" in context


def test_load_llm_context_falls_back_to_raw_text_when_pdf_cache_missing(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/no-pdf-cache",
            "raw_text": "Annonce avec mise à prix et occupation mentionnée.",
        }
    )
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", tmp_path)

    context = load_llm_context_for_sale(sale, max_chars=200)

    assert context is not None
    assert context.startswith("[ANNONCE SOURCE]")
    assert "occupation" in context


def test_load_llm_context_keeps_source_page_when_pdf_cache_exists(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/example.html",
            "title": "Maison à Bordeaux",
            "raw_text": "Annonce source : maison libre avec jardin.",
            "source_blocks": {
                "description": "Description page source : maison de 120 m² libre de toute occupation.",
                "page_text": "Texte complet page source avec visite le mardi.",
            },
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV descriptif", "document_type": "pv_descriptif", "text": "PV : toiture à réviser."}]),
        encoding="utf-8",
    )

    context = load_llm_context_for_sale(sale, max_chars=3000)

    assert context is not None
    assert "[ANNONCE SOURCE]" in context
    assert "Description page source" in context
    assert "Texte complet page source" in context
    assert "PV : toiture à réviser" in context


def test_load_llm_context_includes_structured_extracted_fields(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/structured-context",
            "property_type": "Maison",
            "title": "Maison à Bordeaux",
        }
    )
    sale.surface_m2 = Decimal("91.4")
    sale.rooms_count = 4
    sale.bedrooms_count = 3
    sale.occupancy_status = "rented"
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", tmp_path)

    context = load_llm_context_for_sale(sale, max_chars=2500)

    assert context is not None
    assert "[DONNEES STRUCTUREES EXTRAITES]" in context
    assert "Surface principale: 91.4 m2" in context
    assert "Pièces: 4" in context
    assert "Chambres: 3" in context
    assert "Occupation extraite: rented" in context


def test_load_llm_context_includes_merged_source_pages(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/main",
            "raw_text": "Annonce Avoventes : appartement T3.",
        }
    )
    sale.raw_payload["merged_sources"] = [
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-1.html",
            "raw_payload": {
                "source_name": "vench",
                "source_url": "https://www.vench.fr/vente-1.html",
                "source_blocks": {
                    "titre": "Annonce Vench",
                    "page_text": "Texte Vench : garage et prochaine visite.",
                },
            },
        }
    ]
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", tmp_path)

    context = load_llm_context_for_sale(sale, max_chars=2500)

    assert context is not None
    assert "Annonce Avoventes" in context
    assert "Annonce Vench" in context
    assert "Texte Vench" in context


def test_structured_llm_measurements_are_validated_then_summed_server_side(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_immobilieres",
            "source_url": "https://example.test/room-surface",
            "property_type": "Maison",
            "raw_text": (
                "Le bien se compose des pièces suivantes : Entrée 5,00 m², cuisine 8,00 m², "
                "séjour 19,56 m², chambre 9,41 m², chambre 11,40 m² et salle d'eau 4,37 m²."
            ),
        }
    )
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "false")

    stats = enrich_sale_with_llm(
        sale,
        client=StructuredRoomSurfaceClient(),
        extraction_mode="structured_then_display",
        output_dir=tmp_path / "llm-extractions",
    )

    assert sale.surface_m2 == Decimal("57.74")
    assert sale.habitable_surface_m2 == Decimal("57.74")
    assert sale.surface_source == "llm_structured_verified"
    selected_id = sale.raw_payload["surface_analysis"]["selected_derivation_id"]
    assert selected_id
    selected = next(
        item
        for item in sale.raw_payload["surface_analysis"]["derivations"]
        if item["derivation_id"] == selected_id
    )
    assert selected["kind"] == "calculated_room_sum"
    assert selected["formula"].endswith("= 57.74 m²")
    assert len(selected["operand_measurement_ids"]) == 6
    assert stats.structured_surface_verified == 1
    assert stats.calculated_surface_verified == 1


def test_fact_context_chunks_cover_every_pdf_page_and_report_truncation(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/all-pdf-pages",
            "raw_text": "Annonce source principale.",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    pages = [
        {"page": page, "method": "pdftotext", "text": f"MARQUEUR_PAGE_{page} " + (str(page) * 2100)}
        for page in range(1, 4)
    ]
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps(
            [
                {
                    "label": "PV descriptif",
                    "document_type": "pv_descriptif",
                    "url": "https://example.test/pv-pages.pdf",
                    "pages": pages,
                }
            ]
        ),
        encoding="utf-8",
    )

    chunks = load_llm_fact_context_chunks_for_sale(sale, chunk_chars=3000, max_chunks=0)

    full_context = "\n".join(chunks)
    assert len(chunks) >= 3
    assert all(f"MARQUEUR_PAGE_{page}" in full_context for page in range(1, 4))
    assert sale.raw_payload["llm_fact_context_coverage"]["complete"] is True

    truncated = load_llm_fact_context_chunks_for_sale(sale, chunk_chars=3000, max_chunks=1)
    assert len(truncated) == 1
    assert sale.raw_payload["llm_fact_context_coverage"]["complete"] is False
