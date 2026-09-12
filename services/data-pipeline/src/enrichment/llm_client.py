from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx

from src.config import load_settings
from src.pipeline_usage import record_prediction, reserve_prediction

LOGGER = logging.getLogger(__name__)
RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}
_LAST_REPLICATE_REQUEST_AT = 0.0
_REPLICATE_REQUEST_LOCK = threading.Lock()


class LLMClientUnavailable(RuntimeError):
    pass


@dataclass
class ReplicateClient:
    api_token: str | None = None
    model: str | None = None
    timeout_seconds: float | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    wait_seconds: int | None = None
    cancel_after: str | None = None
    max_retries: int | None = None
    retry_backoff_seconds: float | None = None
    retry_max_sleep_seconds: float | None = None
    min_interval_seconds: float | None = None
    thinking_budget: int | None = None
    dynamic_thinking: bool | None = None
    thinking_level: str | None = None

    def __post_init__(self) -> None:
        settings = load_settings()
        self.api_token = self.api_token or settings["replicate_api_token"]
        self.model = self.model or str(settings["replicate_model"])
        self.timeout_seconds = self.timeout_seconds or float(settings["replicate_timeout_seconds"])
        self.max_tokens = self.max_tokens or int(settings["replicate_max_tokens"])
        self.temperature = self.temperature if self.temperature is not None else float(settings["replicate_temperature"])
        self.wait_seconds = self.wait_seconds or int(settings["replicate_wait_seconds"])
        self.cancel_after = self.cancel_after or str(settings["replicate_cancel_after"])
        self.max_retries = self.max_retries if self.max_retries is not None else int(settings["replicate_max_retries"])
        self.retry_backoff_seconds = (
            self.retry_backoff_seconds
            if self.retry_backoff_seconds is not None
            else float(settings["replicate_retry_backoff_seconds"])
        )
        self.retry_max_sleep_seconds = (
            self.retry_max_sleep_seconds
            if self.retry_max_sleep_seconds is not None
            else float(settings["replicate_retry_max_sleep_seconds"])
        )
        self.min_interval_seconds = (
            self.min_interval_seconds
            if self.min_interval_seconds is not None
            else float(settings["replicate_min_interval_seconds"])
        )
        self.thinking_budget = self.thinking_budget if self.thinking_budget is not None else int(settings["replicate_thinking_budget"])
        self.dynamic_thinking = (
            self.dynamic_thinking
            if self.dynamic_thinking is not None
            else bool(settings["replicate_dynamic_thinking"])
        )
        self.thinking_level = self.thinking_level or str(settings.get("replicate_thinking_level") or "low")

    def is_available(self) -> bool:
        return bool(self.api_token and self.model)

    def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        if not self.api_token:
            raise LLMClientUnavailable("REPLICATE_API_TOKEN is missing")
        last_error: Exception | None = None
        prompt = _user_prompt_for_model(str(self.model), system_prompt, user_prompt)
        attempts = 1 if _is_display_description_prompt(system_prompt) else 2
        for attempt in range(attempts):
            prediction = self._create_prediction(prompt, system_prompt=system_prompt)
            output = self._wait_for_output(prediction)
            raw_response = _stringify_output(output)
            try:
                return parse_json_response(raw_response)
            except ValueError as exc:
                fallback = _display_description_payload_from_text(system_prompt, raw_response)
                if fallback is not None:
                    return fallback
                last_error = exc
                if attempt + 1 >= attempts:
                    break
                prompt = _user_prompt_for_model(
                    str(self.model),
                    system_prompt,
                    f"{user_prompt}\n\nTa réponse précédente n'était pas du JSON valide. "
                    "Réponds uniquement avec un objet JSON valide. Le premier caractère doit être { "
                    "et le dernier caractère doit être }. Aucun markdown, aucun commentaire.",
                )
        retry_label = "after retry" if attempts > 1 else "without retry"
        raise ValueError(f"Replicate returned invalid JSON {retry_label}: {last_error}")

    def _create_prediction(self, prompt: str, system_prompt: str | None = None) -> dict[str, Any]:
        owner, model_name = _split_replicate_model(str(self.model))
        model_reference = str(self.model)
        versioned_model = _replicate_model_version(model_reference)
        endpoint = (
            "https://api.replicate.com/v1/predictions"
            if versioned_model
            else f"https://api.replicate.com/v1/models/{owner}/{model_name}/predictions"
        )
        headers = {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
            "Prefer": f"wait={min(int(self.wait_seconds or 60), 60)}",
            "Cancel-After": str(self.cancel_after),
        }
        payload = {"input": self._input_payload(prompt, system_prompt=system_prompt)}
        if versioned_model:
            # Community models are called through the versioned predictions
            # endpoint. Pinning the version also protects the scan output from
            # an upstream model image changing without notice.
            payload["version"] = model_reference
        response = self._post_with_retries(endpoint, headers=headers, payload=payload)
        return response.json()

    def _post_with_retries(self, endpoint: str, headers: dict[str, str], payload: dict[str, Any]) -> httpx.Response:
        attempts = max(1, int(self.max_retries or 1))
        last_response: httpx.Response | None = None
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            self._respect_min_interval()
            reservation = reserve_prediction(str(self.model))
            try:
                response = httpx.post(
                    endpoint,
                    headers=headers,
                    json=payload,
                    timeout=float(self.timeout_seconds or 180),
                )
                self._mark_request_finished()
                if response.status_code not in RETRYABLE_STATUS_CODES:
                    response.raise_for_status()
                    record_prediction(response.json(), reservation=reservation)
                    return response
                last_response = response
                sleep_seconds = _retry_sleep_seconds(
                    attempt=attempt,
                    response=response,
                    backoff_seconds=float(self.retry_backoff_seconds or 20),
                    max_sleep_seconds=float(self.retry_max_sleep_seconds or 180),
                )
                LOGGER.warning(
                    "Replicate returned %s; retrying in %.1fs (%s/%s)",
                    response.status_code,
                    sleep_seconds,
                    attempt,
                    attempts,
                )
            except (httpx.ConnectError, httpx.ReadError, httpx.TimeoutException) as exc:
                self._mark_request_finished()
                last_error = exc
                sleep_seconds = _retry_sleep_seconds(
                    attempt=attempt,
                    response=None,
                    backoff_seconds=float(self.retry_backoff_seconds or 20),
                    max_sleep_seconds=float(self.retry_max_sleep_seconds or 180),
                )
                LOGGER.warning("Replicate request failed; retrying in %.1fs (%s/%s): %s", sleep_seconds, attempt, attempts, exc)
            if attempt < attempts:
                time.sleep(sleep_seconds)
        if last_response is not None:
            last_response.raise_for_status()
        if last_error is not None:
            raise last_error
        raise RuntimeError("Replicate request failed without response")

    def _respect_min_interval(self) -> None:
        global _LAST_REPLICATE_REQUEST_AT
        min_interval = float(self.min_interval_seconds or 0)
        if min_interval <= 0:
            return
        with _REPLICATE_REQUEST_LOCK:
            now = time.monotonic()
            wait_for = _LAST_REPLICATE_REQUEST_AT + min_interval - now
            if wait_for > 0:
                time.sleep(wait_for)
                now = time.monotonic()
            _LAST_REPLICATE_REQUEST_AT = now

    def _mark_request_finished(self) -> None:
        # The limiter spaces prediction starts, not completions. With Replicate's
        # synchronous wait header, updating the timestamp here would add model
        # latency on top of the configured interval for every backfill item.
        return

    def _input_payload(self, prompt: str, system_prompt: str | None = None) -> dict[str, Any]:
        if _is_gemini_model(str(self.model)):
            payload = {
                "prompt": prompt,
                "system_instruction": system_prompt or "",
                "temperature": float(self.temperature if self.temperature is not None else 0),
                "top_p": 1,
                "max_output_tokens": int(self.max_tokens or 8192),
            }
            if _is_gemini_3_model(str(self.model)):
                payload["thinking_level"] = (
                    self.thinking_level if self.thinking_level in {"none", "low", "high"} else "low"
                )
            else:
                payload["thinking_budget"] = int(self.thinking_budget or 0)
                payload["dynamic_thinking"] = bool(self.dynamic_thinking)
            return payload
        if _is_qwen2_7b_instruct_model(str(self.model)):
            return {
                "prompt": prompt,
                "system_prompt": system_prompt or "",
                "model_type": "Qwen2-7B-Instruct",
                "max_new_tokens": min(int(self.max_tokens or 512), 32768),
                # This Cog model validates temperature with a minimum of 0.1.
                "temperature": max(
                    0.1,
                    float(self.temperature if self.temperature is not None else 0.1),
                ),
                "top_k": 1,
                "top_p": 1,
                "repetition_penalty": 1,
            }
        if _is_qwen_model(str(self.model)):
            return {
                "prompt": prompt,
                "system_prompt": system_prompt or "",
                "max_tokens": int(self.max_tokens or 8192),
                "temperature": float(self.temperature if self.temperature is not None else 0),
                "top_p": 0.8,
                "presence_penalty": 0,
                "frequency_penalty": 0,
            }
        return {
            "prompt": prompt,
            "max_tokens": int(self.max_tokens or 4096),
            "temperature": float(self.temperature if self.temperature is not None else 0.1),
            "top_p": 1,
            "presence_penalty": 0,
            "frequency_penalty": 0,
        }

    def _wait_for_output(self, prediction: dict[str, Any]) -> Any:
        record_prediction(prediction)
        status = prediction.get("status")
        if status == "succeeded":
            return prediction.get("output")
        if status in {"failed", "canceled", "aborted"}:
            raise RuntimeError(f"Replicate prediction {status}: {prediction.get('error')}")

        get_url = prediction.get("urls", {}).get("get")
        if not get_url:
            raise RuntimeError("Replicate prediction did not include a polling URL")
        timeout_at = time.monotonic() + float(self.timeout_seconds or 180)
        with httpx.Client(timeout=20) as client:
            while status not in {"succeeded", "failed", "canceled", "aborted"}:
                if time.monotonic() > timeout_at:
                    raise TimeoutError("Replicate prediction timed out")
                time.sleep(2)
                response = client.get(get_url, headers={"Authorization": f"Bearer {self.api_token}"})
                response.raise_for_status()
                prediction = response.json()
                if prediction.get("status") in {"succeeded", "failed", "canceled", "aborted"}:
                    record_prediction(prediction)
                status = prediction.get("status")
            if status != "succeeded":
                raise RuntimeError(f"Replicate prediction {status}: {prediction.get('error')}")
            return prediction.get("output")


def create_llm_client() -> ReplicateClient:
    settings = load_settings()
    if settings["llm_provider"] != "replicate":
        raise LLMClientUnavailable("Only the Replicate LLM provider is currently configured")
    return ReplicateClient()


def _user_prompt_for_model(model: str, system_prompt: str, user_prompt: str) -> str:
    if _is_gemini_model(model) or _is_qwen_model(model):
        return (
            f"{user_prompt}\n\n"
            "RAPPEL FINAL: réponds uniquement par un objet JSON valide. "
            "Le premier caractère de ta réponse doit être { et le dernier doit être }."
        )
    return _combine_prompts(system_prompt, user_prompt)


def _is_gemini_3_model(model: str) -> bool:
    return bool(re.search(r"(?:^|/)gemini-3(?:[.-]|$)", model, re.I))


def _is_qwen_model(model: str) -> bool:
    model_path = model.split(":", 1)[0].lower()
    return bool(re.search(r"(?:^|/)qwen(?:[\d._-]|$)", model_path))


def _is_qwen2_7b_instruct_model(model: str) -> bool:
    model_path = model.split(":", 1)[0].lower()
    return model_path.endswith("/qwen2-7b-instruct")


def _combine_prompts(system_prompt: str, user_prompt: str) -> str:
    return (
        f"{system_prompt}\n\n"
        f"{user_prompt}\n\n"
        "RAPPEL FINAL: réponds uniquement par un objet JSON valide. "
        "Le premier caractère de ta réponse doit être {."
    )


def parse_json_response(raw_response: str) -> dict[str, Any]:
    text = raw_response.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text, flags=re.I).strip()
        text = re.sub(r"```$", "", text).strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        escaped_value = _parse_escaped_json_response(text)
        if escaped_value is not None:
            value = escaped_value
        else:
            value = _parse_json_object_from_response_text(text, exc)
    if not isinstance(value, dict):
        raise ValueError("LLM response must be a JSON object")
    return value


def _parse_json_object_from_response_text(text: str, original_exc: json.JSONDecodeError) -> dict[str, Any]:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(
            f"No JSON object found in LLM response; response_excerpt={_response_excerpt(text)!r}"
        ) from original_exc
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid JSON from LLM: {exc}; response_excerpt={_response_excerpt(text)!r}"
        ) from exc
    if not isinstance(value, dict):
        raise ValueError("LLM response must be a JSON object")
    return value


def _parse_escaped_json_response(text: str) -> dict[str, Any] | None:
    candidates: list[str] = []
    if text.startswith('"') and text.endswith('"'):
        try:
            decoded = json.loads(text)
        except json.JSONDecodeError:
            decoded = None
        if isinstance(decoded, str):
            candidates.append(decoded)
    if '\\"' in text:
        candidates.append(text.replace('\\"', '"'))

    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", candidate, re.S)
            if not match:
                continue
            try:
                value = json.loads(match.group(0))
            except json.JSONDecodeError:
                continue
        if isinstance(value, dict):
            return value
    return None


def _display_description_payload_from_text(system_prompt: str, raw_response: str) -> dict[str, Any] | None:
    if not _is_display_description_prompt(system_prompt):
        return None
    text = _display_description_text_from_jsonish(raw_response) or _plain_display_description_text(raw_response)
    if not text:
        return None
    return {
        "display_description": text,
        "confidence": {"display_description": 0.58},
    }


def _is_display_description_prompt(system_prompt: str) -> bool:
    return "MODE SYNTHESE STRICTE" in system_prompt.upper()


def _display_description_text_from_jsonish(raw_response: str) -> str | None:
    candidates = [raw_response.strip()]
    if candidates[0].startswith('"') and candidates[0].endswith('"'):
        try:
            decoded = json.loads(candidates[0])
        except json.JSONDecodeError:
            decoded = None
        if isinstance(decoded, str):
            candidates.append(decoded)
    if '\\"' in candidates[0]:
        candidates.append(candidates[0].replace('\\"', '"'))

    for candidate in candidates:
        match = re.search(
            r'"display_description"\s*:\s*"(?P<value>.*?)(?:"\s*(?:[,}]|$))',
            candidate,
            re.S,
        ) or re.search(r'"display_description"\s*:\s*"(?P<value>.+)', candidate, re.S)
        if not match:
            continue
        value = _decode_json_string_fragment(match.group("value"))
        text = _clean_display_description_candidate(value)
        if text:
            return text
    return None


def _decode_json_string_fragment(value: str) -> str:
    try:
        decoded = json.loads(f'"{value}"')
    except json.JSONDecodeError:
        return value.replace('\\"', '"')
    return decoded if isinstance(decoded, str) else value


def _plain_display_description_text(raw_response: str) -> str | None:
    text = raw_response.strip()
    if not text:
        return None
    if "{" in text or "}" in text:
        return None
    if text.startswith("```"):
        text = re.sub(r"^```(?:text|markdown)?", "", text, flags=re.I).strip()
        text = re.sub(r"```$", "", text).strip()
    return _clean_display_description_candidate(text)


def _clean_display_description_candidate(text: str) -> str | None:
    text = re.sub(r"^\s*(?:display_description|synth[eè]se|description)\s*:\s*", "", text, flags=re.I)
    text = re.sub(r"\s+", " ", text).strip(" \t\r\n\"'")
    lowered = text.lower()
    if any(marker in lowered for marker in ("objet json", "json valide", "je ne peux", "désolé", "desole")):
        return None
    if len(text.split()) < 8:
        return None
    return text


def _response_excerpt(text: str, max_chars: int = 180) -> str:
    excerpt = re.sub(r"\s+", " ", text).strip()
    if len(excerpt) <= max_chars:
        return excerpt
    return f"{excerpt[: max_chars - 1]}…"


def _split_replicate_model(model: str) -> tuple[str, str]:
    if "/" not in model:
        raise ValueError("REPLICATE_MODEL must be formatted as owner/model")
    model_path = model.split(":", 1)[0]
    owner, model_name = model_path.split("/", 1)
    return owner, model_name


def _replicate_model_version(model: str) -> str | None:
    if ":" not in model:
        return None
    _model_path, version = model.rsplit(":", 1)
    return version or None


def _is_gemini_model(model: str) -> bool:
    return model.lower().startswith("google/gemini")


def _retry_sleep_seconds(
    attempt: int,
    response: httpx.Response | None,
    backoff_seconds: float,
    max_sleep_seconds: float,
) -> float:
    exponential_sleep = min(backoff_seconds * (2 ** max(0, attempt - 1)), max_sleep_seconds)
    retry_after = response.headers.get("Retry-After") if response is not None else None
    if retry_after:
        try:
            parsed_retry_after = float(retry_after)
            if response is not None and response.status_code == 429:
                return min(max(parsed_retry_after, exponential_sleep), max_sleep_seconds)
            return min(parsed_retry_after, max_sleep_seconds)
        except ValueError:
            pass
    return exponential_sleep


def _stringify_output(output: Any) -> str:
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        return "".join(str(item) for item in output)
    if isinstance(output, dict):
        for key in ("text", "output", "response"):
            if key in output:
                return _stringify_output(output[key])
        return json.dumps(output, ensure_ascii=False)
    return str(output or "")
