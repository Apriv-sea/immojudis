from __future__ import annotations

import hashlib
import importlib
import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlparse, urlsplit, urlunsplit
from xml.etree import ElementTree

import fitz
import httpcore
import httpx

from src.config import DOCLING_TEXTS_DIR, DOCUMENTS_DIR, PDF_DOCUMENT_TEXTS_DIR, load_settings
from src.freshness import invalidate_analysis, timestamp_is_fresh
from src.models import AuctionSale
from src.normalize import (
    clean_text,
    normalize_sale,
)

LOGGER = logging.getLogger(__name__)

DOCUMENT_REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}

MAX_DOCUMENT_REDIRECTS = 5

PDF_TEXT_CACHE_VERSION = "pdf_text_v3_surface_calibration"

DOCUMENT_FACTS_VERSION = "document_facts_v2_surface_reasoning"

DOCUMENT_TYPE_ALIASES = {
    "pv_descriptif": "pv_huissier",
    "proces_verbal_descriptif": "pv_huissier",
    "proces_verbal_de_description": "pv_huissier",
    "proces_verbal_de_constat": "pv_huissier",
    "pvd": "pv_huissier",
    "diagnostic": "diagnostics_techniques",
    "diagnostics": "diagnostics_techniques",
    "diagnostic_technique": "diagnostics_techniques",
    "cahier_conditions": "cahier_conditions_vente",
    "cahier_des_conditions": "cahier_conditions_vente",
    "cahier_des_conditions_de_vente": "cahier_conditions_vente",
    "ccv": "cahier_conditions_vente",
}

GENERIC_DOCUMENT_TYPES = {"document", "documents", "file", "fichier", "pdf", "piece_jointe", "pieces_jointes"}


@dataclass
class PdfEnrichmentStats:
    downloaded: int = 0
    errors: int = 0
    raw_text_enriched: int = 0
    document_cache_hits: int = 0
    document_cache_misses: int = 0
    documents_processed: int = 0


@dataclass(frozen=True)
class PublicDocumentTarget:
    url: str
    hostname: str
    port: int
    addresses: tuple[str, ...]


class _PinnedNetworkBackend(httpcore.NetworkBackend):
    """Dial only addresses approved for one document hostname."""

    def __init__(
        self,
        target: PublicDocumentTarget,
        backend: httpcore.NetworkBackend | None = None,
    ) -> None:
        self._target = target
        self._backend = backend or httpcore.SyncBackend()

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: object = None,
    ) -> httpcore.NetworkStream:
        requested_host = host.decode("ascii") if isinstance(host, bytes) else host
        if requested_host.rstrip(".").lower() != self._target.hostname or port != self._target.port:
            raise ValueError("pinned document transport received an unexpected destination")

        last_error: Exception | None = None
        for address in self._target.addresses:
            try:
                return self._backend.connect_tcp(
                    address,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except Exception as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise ValueError("pinned document transport has no approved address")

    def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: object = None,
    ) -> httpcore.NetworkStream:
        raise ValueError("document downloads cannot use Unix sockets")

    def sleep(self, seconds: float) -> None:
        self._backend.sleep(seconds)


class _PinnedHTTPTransport(httpx.HTTPTransport):
    def __init__(self, target: PublicDocumentTarget) -> None:
        super().__init__(verify=True, trust_env=False, retries=0)
        self._pool.close()
        self._pool = httpcore.ConnectionPool(
            ssl_context=ssl.create_default_context(),
            max_connections=1,
            max_keepalive_connections=0,
            http1=True,
            http2=False,
            retries=0,
            network_backend=_PinnedNetworkBackend(target),
        )


def enrich_sale_from_pdfs(sale: AuctionSale) -> PdfEnrichmentStats:
    stats = PdfEnrichmentStats()
    downloaded_documents = download_documents(sale, stats=stats)
    _invalidate_replaced_document_facts(sale, downloaded_documents)
    pdf_texts: list[dict[str, object]] = []

    for document in _select_documents_for_extraction(downloaded_documents, sale=sale):
        file_path = Path(document["file_path"])
        try:
            cached_payload = (
                _read_document_text_cache(document, file_path) if load_settings()["incremental_enrichment"] else None
            )
            if cached_payload:
                stats.document_cache_hits += 1
                pdf_texts.append(cached_payload)
                continue
            stats.document_cache_misses += 1
            payload = extract_attached_document(file_path, document=document)
        except Exception as exc:
            LOGGER.warning("PDF text extraction failed for %s: %s", file_path, exc)
            stats.errors += 1
            continue
        payload.update(
            {
                "label": document.get("label", ""),
                "url": document.get("url", ""),
                "type": document.get("type", "pdf"),
                "document_type": _canonical_document_type(
                    document.get("document_type") or document.get("type"),
                    label=document.get("label"),
                    url=document.get("url"),
                ),
                "file_path": str(file_path),
            }
        )
        _write_document_text_cache(document, file_path, payload)
        stats.documents_processed += 1
        pdf_texts.append(payload)

    if pdf_texts:
        _write_pdf_text_cache(sale, pdf_texts)
        before = sale.raw_text or ""
        enrich_sale_from_pdf_text(sale, pdf_texts)
        if len(sale.raw_text or "") > len(before):
            stats.raw_text_enriched += 1
    _store_document_analysis_status(sale, downloaded_documents, pdf_texts)

    return stats


def _invalidate_replaced_document_facts(sale: AuctionSale, documents: list[dict]) -> None:
    previous = sale.raw_payload.get("document_analysis") or {}
    hashes = {profile.get("url"): profile.get("sha256") for profile in previous.get("profiles", [])}
    changed = any(hashes.get(doc.get("url")) and doc.get("sha256")
                  and hashes[doc.get("url")] != doc["sha256"] for doc in documents)
    if not changed:
        return
    invalidate_analysis(sale.raw_payload, "document_bytes_changed")
    sale.raw_payload["superseded_document_analysis"] = previous
    snapshot = sale.raw_payload.get("source_factual_snapshot") or {
        "source_name": sale.source_name, "source_url": sale.source_url,
    }
    factual = normalize_sale(snapshot)
    built_pdf = sale.surface_source == "pdf" or (sale.raw_payload.get("surface_extraction") or {}).get("source") == "pdf"
    land_pdf = (sale.raw_payload.get("land_surface_extraction") or {}).get("source") == "pdf"
    fields = []
    if built_pdf:
        fields += ["surface_m2", "habitable_surface_m2", "carrez_surface_m2", "app_surface_m2",
                   "app_surface_kind", "surface_scope", "surface_source", "surface_confidence", "surface_evidence"]
    if land_pdf:
        fields += ["land_surface_m2"]
    if sale.raw_payload.get("starting_price_extraction"):
        fields += ["starting_price_eur"]
    for key in fields:
        setattr(sale, key, getattr(factual, key))
        sale.raw_payload.pop(key, None)
    for key in ("surface_extraction", "surface_analysis", "land_surface_extraction", "starting_price_extraction"):
        sale.raw_payload.pop(key, None)
    if snapshot.get("raw_text"):
        sale.raw_text = str(snapshot["raw_text"])


def download_documents(
    sale: AuctionSale,
    output_root: Path = DOCUMENTS_DIR,
    stats: PdfEnrichmentStats | None = None,
) -> list[dict[str, str]]:
    sale_id = _sale_storage_id(sale)
    sale_dir = output_root / sale_id
    sale_dir.mkdir(parents=True, exist_ok=True)

    settings = load_settings()
    headers = {
        "User-Agent": str(settings["user_agent"]),
        "Accept": "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6",
        "Referer": sale.source_url,
    }
    downloaded: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for document in _select_documents_for_extraction(sale.documents, sale=sale):
        url = document.get("url")
        document_type = _canonical_document_type(
            document.get("document_type") or document.get("type"),
            label=document.get("label"),
            url=url,
        )
        if not url or document_type == "other" or url in seen_urls:
            continue
        seen_urls.add(url)
        if _is_robots_disallowed_licitor_document(url):
            LOGGER.info("Skipping robots-disallowed Licitor document %s", url)
            continue

        filename = _document_filename(document)
        file_path = sale_dir / filename
        if (
            file_path.exists()
            and _document_file_format(
                file_path.read_bytes(),
                url=url,
                content_type=None,
            )
            is None
        ):
            LOGGER.info("Discarding unsupported document cache entry %s", file_path)
            file_path.unlink(missing_ok=True)
        metadata_path = file_path.with_suffix(file_path.suffix + ".http.json")
        try:
            metadata = json.loads(metadata_path.read_text())
        except (OSError, ValueError):
            metadata = {}
        request_headers = dict(headers)
        if file_path.exists():
            if metadata.get("etag"):
                request_headers["If-None-Match"] = metadata["etag"]
            if metadata.get("last_modified"):
                request_headers["If-Modified-Since"] = metadata["last_modified"]
        if not file_path.exists() or not timestamp_is_fresh(metadata.get("checked_at")):
            download_error: Exception | None = None
            try:
                for candidate_url in _document_url_variants(url):
                    try:
                        response = _download_document_response(
                            candidate_url,
                            headers=request_headers,
                            timeout_seconds=float(settings["request_timeout_seconds"]),
                        )
                        if getattr(response, "status_code", 200) == 304 and file_path.exists():
                            metadata["checked_at"] = datetime.now(UTC).isoformat()
                            metadata_path.write_text(json.dumps(metadata))
                            download_error = None
                            break
                        response.raise_for_status()
                        response_headers = getattr(response, "headers", {})
                        content_type = response_headers.get("content-type", "")
                        content = _bounded_document_content(
                            response,
                            max_bytes=int(settings["pdf_max_download_mb"]) * 1024 * 1024,
                        )
                        file_format = _document_file_format(
                            content,
                            url=candidate_url,
                            content_type=content_type,
                        )
                        if file_format is None:
                            raise ValueError(
                                f"response is not a supported document (content-type={content_type or 'unknown'})"
                            )
                    except Exception as exc:
                        download_error = exc
                        continue
                    if candidate_url != url:
                        LOGGER.info("PDF URL Unicode variant succeeded for %s", url)
                    if file_path.exists():
                        previous = file_path.read_bytes()
                        if previous != content:
                            invalidate_analysis(sale.raw_payload, "document_bytes_changed")
                            archive = sale_dir / "versions"
                            archive.mkdir(exist_ok=True)
                            (archive / (hashlib.sha256(previous).hexdigest() + file_path.suffix)).write_bytes(previous)
                    temporary = file_path.with_suffix(file_path.suffix + ".tmp")
                    temporary.write_bytes(content)
                    temporary.replace(file_path)
                    metadata_path.write_text(json.dumps({
                        "checked_at": datetime.now(UTC).isoformat(),
                        "etag": response_headers.get("etag"),
                        "last_modified": response_headers.get("last-modified"),
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }))
                    if stats:
                        stats.downloaded += 1
                    download_error = None
                    break
            except Exception as exc:
                download_error = exc
            if download_error is not None:
                LOGGER.warning("PDF download failed for %s: %s", url, download_error)
                if stats:
                    stats.errors += 1
                continue

        enriched_document = dict(document)
        file_format = (
            _document_file_format(
                file_path.read_bytes(),
                url=url,
                content_type=None,
            )
            or "unknown"
        )
        enriched_document["type"] = file_format
        enriched_document["file_format"] = file_format
        enriched_document["document_type"] = document_type
        enriched_document["file_path"] = str(file_path)
        enriched_document["sha256"] = hashlib.sha256(file_path.read_bytes()).hexdigest()
        downloaded.append(enriched_document)
    return downloaded


def _looks_like_pdf_bytes(content: bytes) -> bool:
    return b"%PDF-" in content[:1024]


def _bounded_document_content(response: object, *, max_bytes: int) -> bytes:
    headers = getattr(response, "headers", {}) or {}
    raw_length = headers.get("content-length") if hasattr(headers, "get") else None
    if raw_length:
        try:
            if int(raw_length) > max_bytes:
                raise ValueError(f"document exceeds the {max_bytes}-byte download limit")
        except ValueError as exc:
            if "exceeds" in str(exc):
                raise
    content = bytes(getattr(response, "content", b""))
    if len(content) > max_bytes:
        raise ValueError(f"document exceeds the {max_bytes}-byte download limit")
    return content


def _document_file_format(content: bytes, *, url: str, content_type: str | None) -> str | None:
    if _looks_like_pdf_bytes(content):
        return "pdf"
    suffix = Path(urlparse(url).path).suffix.lower()
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    if content.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") and (
        suffix == ".doc" or normalized_content_type == "application/msword"
    ):
        return "doc"
    if content.startswith(b"PK\x03\x04") and (
        suffix == ".docx"
        or normalized_content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ):
        return "docx"
    return None


def _document_url_variants(url: str) -> list[str]:
    variants = [url]
    for form in ("NFC", "NFD"):
        normalized = _normalize_document_url(url, form=form)
        if normalized not in variants:
            variants.append(normalized)
    return variants


def _normalize_document_url(url: str, *, form: str) -> str:
    parsed = urlsplit(url)
    safe_segment_chars = ":@-._~!$&'()*+,;="
    normalized_segments = [
        quote(unicodedata.normalize(form, unquote(segment)), safe=safe_segment_chars)
        for segment in parsed.path.split("/")
    ]
    normalized_query = unicodedata.normalize(form, parsed.query)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            "/".join(normalized_segments),
            normalized_query,
            parsed.fragment,
        )
    )


def _is_robots_disallowed_licitor_document(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {"www.licitor.com", "licitor.com"}:
        return False
    path = parsed.path
    return path.startswith("/data/pub/doc/") or path.startswith("/data/pub/media/")


def _download_document_response(
    url: str,
    *,
    headers: dict[str, str],
    timeout_seconds: float,
) -> httpx.Response:
    current_url = url
    for redirect_count in range(MAX_DOCUMENT_REDIRECTS + 1):
        response = _send_pinned_document_request(
            current_url,
            headers=headers,
            timeout_seconds=timeout_seconds,
        )
        status_code = int(getattr(response, "status_code", 200))
        if status_code not in DOCUMENT_REDIRECT_STATUS_CODES:
            return response
        if redirect_count >= MAX_DOCUMENT_REDIRECTS:
            raise ValueError(f"too many document redirects: {url}")
        location = response.headers.get("location")
        if not location:
            return response
        current_url = urljoin(current_url, location)
    raise ValueError(f"too many document redirects: {url}")


def _send_pinned_document_request(
    url: str,
    *,
    headers: dict[str, str],
    timeout_seconds: float,
) -> httpx.Response:
    target = _resolve_public_document_target(url)
    transport = _PinnedHTTPTransport(target)
    with httpx.Client(
        transport=transport,
        follow_redirects=False,
        timeout=timeout_seconds,
        trust_env=False,
    ) as client:
        with client.stream("GET", target.url, headers=headers) as response:
            content = _read_document_stream(response, int(load_settings()["pdf_max_download_mb"]) * 1024 * 1024)
            response_headers = dict(response.headers)
            response_headers.pop("content-encoding", None)
            response_headers["content-length"] = str(len(content))
            return httpx.Response(response.status_code, headers=response_headers, content=content, request=response.request)


def _read_document_stream(response: httpx.Response, max_bytes: int) -> bytes:
    parts = []
    size = 0
    for chunk in response.iter_bytes(chunk_size=64 * 1024):
        size += len(chunk)
        if size > max_bytes:
            raise ValueError(f"document exceeds the {max_bytes}-byte download limit")
        parts.append(chunk)
    return b"".join(parts)


def _resolve_public_document_target(
    url: str,
    *,
    resolver: object = socket.getaddrinfo,
) -> PublicDocumentTarget:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"unsafe document URL: {url}")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"unsafe document URL authority: {url}")

    hostname = parsed.hostname.rstrip(".").lower()
    if not hostname or "%" in hostname:
        raise ValueError(f"unsafe document hostname: {url}")
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
        raise ValueError(f"unsafe document hostname: {url}")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise ValueError(f"invalid document URL port: {url}") from exc

    try:
        answers = resolver(hostname, port, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as exc:
        raise ValueError(f"document hostname cannot be resolved: {hostname}") from exc

    addresses: set[str] = set()
    for answer in answers:
        raw_address = str(answer[4][0]).split("%", 1)[0]
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError as exc:
            raise ValueError(f"resolver returned an invalid document address: {raw_address}") from exc
        if not address.is_global:
            raise ValueError(f"document hostname resolves outside the public network: {hostname}")
        addresses.add(address.compressed)

    if not addresses:
        raise ValueError(f"document hostname has no usable address: {hostname}")
    return PublicDocumentTarget(
        url=url,
        hostname=hostname,
        port=port,
        addresses=tuple(sorted(addresses)),
    )


def _is_safe_public_document_url(url: str) -> bool:
    try:
        _resolve_public_document_target(url)
    except ValueError:
        return False
    return True


def extract_attached_document(
    file: str | Path,
    document: dict[str, str] | None = None,
) -> dict[str, object]:
    path = Path(file)
    file_format = str((document or {}).get("file_format") or path.suffix.lstrip(".")).lower()
    if file_format == "pdf":
        return extract_pdf_document(path, document=document)
    if file_format == "doc":
        return _extract_legacy_word_document(path)
    if file_format == "docx":
        return _extract_docx_document(path)
    raise ValueError(f"unsupported attached document format: {file_format or 'unknown'}")


def _extract_legacy_word_document(path: Path) -> dict[str, object]:
    commands: list[tuple[list[str], str]] = []
    if shutil.which("antiword"):
        commands.append((["antiword", str(path)], "antiword"))
    if shutil.which("textutil"):
        commands.append((["textutil", "-convert", "txt", "-stdout", str(path)], "textutil"))
    if not commands:
        raise RuntimeError("legacy Word extraction requires antiword or textutil")

    last_error = ""
    for command, method in commands:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
        text = clean_text(result.stdout) or ""
        if result.returncode == 0 and text:
            return _single_page_document_payload(path, text, extraction_method=method)
        last_error = clean_text(result.stderr) or f"exit code {result.returncode}"
    raise RuntimeError(f"legacy Word extraction failed: {last_error}")


def _extract_docx_document(path: Path) -> dict[str, object]:
    max_chars = int(load_settings()["document_max_extracted_text_chars"])
    with zipfile.ZipFile(path) as archive:
        info = archive.getinfo("word/document.xml")
        if info.file_size > max_chars * 4:
            raise ValueError("DOCX XML exceeds the extraction limit")
        xml = archive.read("word/document.xml")
    root = ElementTree.fromstring(xml)
    text = clean_text(" ".join(node.text or "" for node in root.iter() if node.tag.endswith("}t"))) or ""
    if not text:
        raise ValueError("DOCX document contains no extractable text")
    if len(text) > max_chars:
        raise ValueError("DOCX text exceeds the extraction limit")
    return _single_page_document_payload(path, text, extraction_method="docx_xml")


def _single_page_document_payload(
    path: Path,
    text: str,
    *,
    extraction_method: str,
) -> dict[str, object]:
    confidence = _page_text_confidence(text, method="pymupdf_text")
    return {
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "text": text,
        "pages": [
            {
                "page": 1,
                "text": text,
                "chars": len(text),
                "raw_text_chars": len(text),
                "method": extraction_method,
                "confidence": confidence,
            }
        ],
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "page_count": 1,
        "text_chars": len(text),
        "extraction_method": extraction_method,
        "confidence": confidence,
        "ocr_pages": 0,
    }


def extract_pdf_text(file: str | Path, document: dict[str, str] | None = None) -> str:
    return str(extract_pdf_document(file, document=document).get("text") or "")


def extract_pdf_document(file: str | Path, document: dict[str, str] | None = None) -> dict[str, object]:
    path = Path(file)
    settings = load_settings()
    max_bytes = int(settings["pdf_max_download_mb"]) * 1024 * 1024
    if path.stat().st_size > max_bytes:
        raise ValueError(f"document exceeds the {max_bytes}-byte extraction limit")
    pages = extract_pdf_pages(path)
    page_text = clean_text("\n".join(str(page["text"]) for page in pages if page.get("text"))) or ""
    text = page_text
    extraction_method = "pymupdf_pages"
    docling_text = ""
    if str(settings["pdf_extractor"]) == "docling":
        timeout = _adaptive_docling_timeout(path, document=document, settings=settings)
        docling_text = extract_pdf_text_with_docling(path, timeout_seconds=timeout)
        if docling_text:
            extraction_method = "docling"
            if len(docling_text) >= len(page_text):
                text = docling_text
        else:
            LOGGER.warning("Docling returned no text for %s; falling back to PyMuPDF/Tesseract", path)
    if (
        settings["pdf_docling_enabled"]
        and str(settings["pdf_extractor"]) == "auto"
        and len(text) < int(settings["pdf_docling_threshold_chars"])
    ):
        docling_text = extract_pdf_text_with_docling(path)
        if len(docling_text) > len(text):
            text = docling_text
            extraction_method = "docling_auto"

    sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
    page_confidences = [float(page.get("confidence") or 0) for page in pages if page.get("text")]
    confidence = round(sum(page_confidences) / len(page_confidences), 3) if page_confidences else 0.0
    return {
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "text": text,
        "pages": pages,
        "sha256": sha256,
        "page_count": len(pages),
        "text_chars": len(text),
        "page_text_chars": len(page_text),
        "ocr_pages": sum(1 for page in pages if str(page.get("method") or "").startswith("ocr_")),
        "empty_pages": sum(1 for page in pages if not clean_text(page.get("text"))),
        "extraction_method": extraction_method,
        "confidence": confidence,
    }


def extract_pdf_text_with_docling(file: str | Path, timeout_seconds: float | None = None) -> str:
    path = Path(file)
    cached = _read_docling_cache(path)
    if cached is not None:
        return cached
    settings = load_settings()
    timeout = float(timeout_seconds if timeout_seconds is not None else settings["pdf_docling_timeout_seconds"] or 0)
    if timeout > 0:
        text = _extract_pdf_text_with_docling_subprocess(path, timeout)
        if text:
            _write_docling_cache(path, text)
        return text
    text = _extract_pdf_text_with_docling_direct(path)
    if text:
        _write_docling_cache(path, text)
    return text


def _extract_pdf_text_with_docling_direct(path: Path) -> str:
    try:
        _ensure_docling_available()
    except Exception as exc:
        LOGGER.warning("Docling is unavailable: %s", exc)
        return ""
    try:
        settings = load_settings()
        profile = _profile_pdf_for_docling(path)
        do_ocr = _should_docling_ocr(path, settings, profile=profile)
        chunk_pages = _docling_chunk_pages(settings, do_ocr)
        if profile["page_count"] > chunk_pages:
            text = _extract_docling_pdf_in_chunks(path, do_ocr, profile, settings)
        else:
            converter = _build_docling_converter(do_ocr, settings)
            text = _convert_docling_pdf(converter, path)
    except Exception as exc:
        LOGGER.warning("Docling extraction failed for %s: %s", path, exc)
        return ""
    return text


def _ensure_docling_available() -> None:
    for module_name in (
        "docling.datamodel.base_models",
        "docling.datamodel.pipeline_options",
        "docling.document_converter",
    ):
        importlib.import_module(module_name)


def _build_docling_converter(do_ocr: bool, settings: dict[str, object]) -> object:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pipeline_options = PdfPipelineOptions(
        do_ocr=do_ocr,
        do_table_structure=False,
        document_timeout=float(settings["pdf_docling_timeout_seconds"] or 0) or None,
        force_backend_text=True,
        generate_page_images=False,
        generate_picture_images=False,
    )
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)})


def _convert_docling_pdf(converter: object, path: Path) -> str:
    result = converter.convert(str(path), raises_on_error=False)
    if not result.input.valid:
        LOGGER.warning("Docling rejected invalid PDF backend input for %s", path)
        return ""
    return clean_text(result.document.export_to_markdown()) or ""


def _extract_docling_pdf_in_chunks(
    path: Path,
    do_ocr: bool,
    profile: dict[str, float | int],
    settings: dict[str, object],
) -> str:
    chunk_pages = _docling_chunk_pages(settings, do_ocr)
    parts: list[str] = []
    converter = _build_docling_converter(do_ocr, settings)
    with tempfile.TemporaryDirectory(prefix="auction-docling-") as tmp_dir:
        tmp_root = Path(tmp_dir)
        for start in range(1, int(profile["page_count"]) + 1, chunk_pages):
            end = min(start + chunk_pages - 1, int(profile["page_count"]))
            chunk_path = _write_pdf_page_chunk(path, tmp_root, start, end)
            text = _convert_docling_pdf(converter, chunk_path)
            if text:
                parts.append(f"--- pages {start}-{end} ---\n{text}")
    return clean_text("\n\n".join(parts)) or ""


def _write_pdf_page_chunk(path: Path, output_dir: Path, start_page: int, end_page: int) -> Path:
    output_path = output_dir / f"{path.stem}-{start_page}-{end_page}.pdf"
    with fitz.open(path) as source, fitz.open() as chunk:
        chunk.insert_pdf(source, from_page=start_page - 1, to_page=end_page - 1)
        chunk.save(output_path, garbage=4, deflate=True, clean=True)
    return output_path


def _docling_chunk_pages(settings: dict[str, object], do_ocr: bool) -> int:
    key = "pdf_docling_ocr_chunk_pages" if do_ocr else "pdf_docling_chunk_pages"
    return max(1, int(settings[key]))


def _extract_pdf_text_with_docling_subprocess(path: Path, timeout: float) -> str:
    DOCLING_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    output_path = _docling_cache_path(path).with_suffix(".tmp.txt")
    command = [sys.executable, "-m", "src.pdf_enrichment", "--docling-extract", str(path), str(output_path)]
    try:
        result = subprocess.run(
            command,
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        LOGGER.warning("Docling extraction timed out after %.0fs for %s", timeout, path)
        return ""
    if result.returncode != 0:
        stderr = clean_text(result.stderr)[-1000:] if result.stderr else ""
        LOGGER.warning("Docling extraction subprocess failed for %s: %s", path, stderr)
        return ""
    if not output_path.exists():
        return ""
    text = clean_text(output_path.read_text(encoding="utf-8")) or ""
    output_path.unlink(missing_ok=True)
    return text


def extract_pdf_pages(file: str | Path) -> list[dict[str, object]]:
    pages: list[dict[str, object]] = []
    settings = load_settings()
    max_pages = int(settings["pdf_max_extract_pages"])
    hard_limit = int(settings.get("pdf_max_total_pages", 300))
    with fitz.open(file) as document:
        if document.page_count > hard_limit:
            raise ValueError(f"PDF exceeds the {hard_limit}-page safety limit")
        # Long text PDFs are inexpensive. Only OCR consumes the per-pass budget.
        cache_key = hashlib.sha256(Path(file).read_bytes() + str((settings["pdf_ocr_enabled"], settings["pdf_ocr_language"], PDF_TEXT_CACHE_VERSION)).encode()).hexdigest()
        cache_dir = PDF_DOCUMENT_TEXTS_DIR / "pages" / cache_key
        ocr_attempts = 0
        for index, page in enumerate(document, start=1):
            cache_path = cache_dir / f"{index}.json"
            if cache_path.exists():
                try:
                    cached = json.loads(cache_path.read_text(encoding="utf-8"))
                    if cached.get("page") == index and isinstance(cached.get("text"), str):
                        pages.append(cached)
                        continue
                except (OSError, ValueError, AttributeError):
                    pass
            raw_text = page.get_text("text") or ""
            method = "pymupdf_text"
            confidence = _page_text_confidence(raw_text, method=method)
            text = raw_text
            if _should_try_ocr(raw_text):
                if ocr_attempts >= max_pages:
                    raise ValueError(f"OCR pass budget reached; {index - 1}/{document.page_count} pages checkpointed; retry resumes")
                ocr_attempts += 1
                result = _extract_page_text_with_ocr_result(page, fallback=raw_text)
                text = str(result["text"])
                method = str(result["method"])
                confidence = float(result["confidence"])
            cleaned = clean_text(text) or ""
            pages.append(
                {
                    "page": index,
                    "text": cleaned,
                    "chars": len(cleaned),
                    "raw_text_chars": len(clean_text(raw_text) or ""),
                    "method": method,
                    "confidence": confidence,
                }
            )
            cache_dir.mkdir(parents=True, exist_ok=True)
            temporary = cache_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(pages[-1], ensure_ascii=False), encoding="utf-8")
            temporary.replace(cache_path)
    return pages


def _should_try_ocr(text: str) -> bool:
    settings = load_settings()
    if not settings["pdf_ocr_enabled"]:
        return False
    return len(clean_text(text) or "") < 80


def _extract_page_text_with_ocr(page: fitz.Page, fallback: str) -> str:
    return str(_extract_page_text_with_ocr_result(page, fallback=fallback)["text"])


def _extract_page_text_with_ocr_result(page: fitz.Page, fallback: str) -> dict[str, object]:
    settings = load_settings()
    tessdata = settings.get("pdf_ocr_tessdata")
    try:
        text_page = page.get_textpage_ocr(
            language=str(settings["pdf_ocr_language"]),
            full=True,
            tessdata=str(tessdata) if tessdata else None,
        )
        text = page.get_text("text", textpage=text_page)
        if clean_text(text):
            return {
                "text": text,
                "method": "ocr_pymupdf",
                "confidence": _page_text_confidence(text, method="ocr_pymupdf"),
            }
    except Exception as exc:
        LOGGER.debug("PDF OCR unavailable or failed: %s", exc)
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = Path(tmpdir) / "page.png"
            pixmap = page.get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
            pixmap.save(str(image_path))
            env = os.environ.copy()
            if tessdata:
                env["TESSDATA_PREFIX"] = str(tessdata)
            result = subprocess.run(
                ["tesseract", str(image_path), "stdout", "-l", str(settings["pdf_ocr_language"])],
                capture_output=True,
                text=True,
                timeout=60,
                env=env,
                check=False,
            )
            if result.returncode == 0 and clean_text(result.stdout):
                return {
                    "text": result.stdout,
                    "method": "ocr_tesseract",
                    "confidence": _page_text_confidence(result.stdout, method="ocr_tesseract"),
                }
            LOGGER.debug("Tesseract OCR returned %s: %s", result.returncode, result.stderr)
    except Exception as exc:
        LOGGER.debug("Tesseract OCR fallback failed: %s", exc)
    return {
        "text": fallback,
        "method": "fallback_text",
        "confidence": _page_text_confidence(fallback, method="fallback_text"),
    }


def _page_text_confidence(text: str | None, *, method: str) -> float:
    chars = len(clean_text(text) or "")
    if chars == 0:
        return 0.0
    if method == "pymupdf_text":
        base = Decimal("0.92")
    elif method == "ocr_pymupdf":
        base = Decimal("0.74")
    elif method == "ocr_tesseract":
        base = Decimal("0.70")
    else:
        base = Decimal("0.45")
    if chars < 120:
        base -= Decimal("0.18")
    elif chars < 500:
        base -= Decimal("0.08")
    return float(max(Decimal("0.1"), min(Decimal("0.98"), base)))


def classify_document_type(label: str | None, url: str | None = None) -> str:
    text = _normalize_document_classifier_text(f"{label or ''} {url or ''}")
    if any(pattern in text for pattern in ("diagnostic", "dpe", "erp", "amiante", "plomb", "termites", "crep")):
        return "diagnostics_techniques"
    if re.search(r"\bdiag(?:nostics?)?\b", text):
        return "diagnostics_techniques"
    if any(
        pattern in text
        for pattern in (
            "cahier",
            "cahier des conditions",
            "cahier_des_conditions",
            "cahier des charges",
            "cahier_des_charges",
            "ccv",
            "dossier de consultation",
            "dossier_de_consultation",
            "dossier de presentation",
            "dossier_de_presentation",
            "reglement de consultation",
        )
    ):
        return "cahier_conditions_vente"
    if "conditions de vente" in text or "conditions_de_vente" in text:
        return "conditions_vente"
    if any(pattern in text for pattern in ("pv notaire", "notaire", "notarié", "notarie")):
        return "pv_notaire"
    if any(
        pattern in text
        for pattern in (
            "pv descriptif",
            "pv description",
            "pvd",
            "descriptif",
            "proces-verbal de constat",
            "commissaire de justice",
            "huissier",
        )
    ):
        return "pv_huissier"
    if re.search(r"\bproces[-\s]+verbal\b.*\b(?:description|descriptif|constat)\b", text):
        return "pv_huissier"
    if re.search(r"\bpv\b", text):
        return "pv_huissier"
    if re.search(r"\bproces[-\s]+verbal\b", text):
        return "proces_verbal"
    if any(
        pattern in text
        for pattern in (
            "avis",
            "simplifie",
            "simplifié",
            "affiche",
            "insertion",
            "annonce",
            "placard",
            "publicite",
            "publicité",
        )
    ):
        return "annonce_vente"
    if "bail" in text or "location" in text:
        return "bail"
    if any(pattern in text for pattern in ("hypothecaire", "hypothécaire", "commandement")):
        return "procedure_saisie"
    if any(pattern in text for pattern in ("cadastre", "plan", "parcelle")):
        return "cadastre"
    if ".pdf" in text:
        return "pdf"
    return "other"


def _normalize_document_classifier_text(value: object | None) -> str:
    text = clean_text(value) or ""
    normalized = unicodedata.normalize("NFKD", text)
    without_accents = "".join(char for char in normalized if not unicodedata.combining(char))
    return without_accents.lower()


def _canonical_document_type(
    document_type: object | None,
    *,
    label: object | None = None,
    url: object | None = None,
) -> str:
    classified = classify_document_type(clean_text(label), clean_text(url))
    raw = clean_text(document_type)
    if raw:
        normalized = _normalize_document_classifier_text(raw).replace("-", "_").replace(" ", "_")
        normalized = re.sub(r"_+", "_", normalized).strip("_")
        alias = DOCUMENT_TYPE_ALIASES.get(normalized)
        if alias:
            return alias
        if normalized in GENERIC_DOCUMENT_TYPES and classified != "other":
            return classified
        if normalized not in {"other", "unknown"}:
            return normalized
    return classified


PDF_DESCRIPTION_GROUP = frozenset({"pv_huissier", "pv_notaire", "proces_verbal"})

PDF_DIAGNOSTICS_GROUP = frozenset({"diagnostics_techniques"})

PDF_CONDITIONS_GROUP = frozenset({"cahier_conditions_vente", "conditions_vente"})

PDF_ANNOUNCE_GROUP = frozenset({"annonce_vente"})

PDF_BAIL_GROUP = frozenset({"bail"})

PDF_CADASTRE_GROUP = frozenset({"cadastre"})

DEFAULT_DOCUMENT_GROUPS = (
    PDF_DESCRIPTION_GROUP,
    PDF_DIAGNOSTICS_GROUP,
    PDF_CONDITIONS_GROUP,
    PDF_ANNOUNCE_GROUP,
    PDF_BAIL_GROUP,
    PDF_CADASTRE_GROUP,
)


def _document_text_cache_path(document: dict[str, str], file_path: Path) -> Path:
    stat = file_path.stat()
    base = "|".join(
        [
            document.get("url", ""),
            str(stat.st_size),
            hashlib.sha256(file_path.read_bytes()).hexdigest(),
        ]
    )
    digest = hashlib.sha256(base.encode("utf-8")).hexdigest()[:24]
    return PDF_DOCUMENT_TEXTS_DIR / f"{digest}.json"


def _read_document_text_cache(document: dict[str, str], file_path: Path) -> dict[str, str] | None:
    try:
        path = _document_text_cache_path(document, file_path)
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not clean_text(payload.get("text")):
        return None
    if payload.get("cache_version") != PDF_TEXT_CACHE_VERSION:
        return None
    pages = payload.get("pages")
    if not isinstance(pages, list) or not pages:
        return None
    return payload


def _write_document_text_cache(document: dict[str, str], file_path: Path, payload: dict[str, object]) -> Path:
    PDF_DOCUMENT_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    path = _document_text_cache_path(document, file_path)
    payload["cache_version"] = PDF_TEXT_CACHE_VERSION
    if not isinstance(payload.get("pages"), list) and clean_text(payload.get("text")):
        text = clean_text(payload.get("text")) or ""
        payload["pages"] = [
            {
                "page": 1,
                "text": text,
                "chars": len(text),
                "raw_text_chars": len(text),
                "method": "legacy_text",
                "confidence": _page_text_confidence(text, method="fallback_text"),
            }
        ]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def sale_storage_id(sale: AuctionSale) -> str:
    base = sale.external_id or sale.source_url
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:16]


def _sale_storage_id(sale: AuctionSale) -> str:
    return sale_storage_id(sale)


def _docling_cache_path(file: Path) -> Path:
    try:
        digest = hashlib.sha256(file.read_bytes()).hexdigest()[:16]
    except OSError:
        digest = hashlib.sha256(str(file.resolve()).encode("utf-8")).hexdigest()[:16]
    return DOCLING_TEXTS_DIR / f"{digest}.txt"


def _read_docling_cache(file: Path) -> str | None:
    path = _docling_cache_path(file)
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def _write_docling_cache(file: Path, text: str) -> Path:
    DOCLING_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    path = _docling_cache_path(file)
    path.write_text(text, encoding="utf-8")
    return path


def _should_docling_ocr(
    path: Path,
    settings: dict[str, object],
    profile: dict[str, float | int] | None = None,
) -> bool:
    mode = str(settings.get("pdf_docling_ocr_mode") or "auto").lower()
    if mode in {"0", "false", "no", "off", "never"}:
        return False
    if mode in {"1", "true", "yes", "on", "always"}:
        return True

    profile = profile or _profile_pdf_for_docling(path)
    if profile["page_count"] > int(settings["pdf_docling_ocr_max_pages"]):
        LOGGER.info(
            "Skipping Docling OCR for %s: %s pages exceeds limit",
            path,
            profile["page_count"],
        )
        return False
    if profile["size_mb"] > float(settings["pdf_docling_ocr_max_size_mb"]):
        LOGGER.info(
            "Skipping Docling OCR for %s: %.1f MB exceeds limit",
            path,
            profile["size_mb"],
        )
        return False
    return profile["first_pages_text_chars"] < int(settings["pdf_docling_threshold_chars"])


def _profile_pdf_for_docling(path: Path) -> dict[str, float | int]:
    size_mb = path.stat().st_size / 1024 / 1024
    try:
        with fitz.open(path) as document:
            page_count = document.page_count
            first_pages_text_chars = sum(
                len(document[index].get_text("text") or "") for index in range(min(page_count, 5))
            )
    except Exception:
        return {"size_mb": size_mb, "page_count": 0, "first_pages_text_chars": 0}
    return {
        "size_mb": size_mb,
        "page_count": page_count,
        "first_pages_text_chars": first_pages_text_chars,
    }


def _run_docling_extract_cli(argv: list[str]) -> int:
    if len(argv) != 4 or argv[1] != "--docling-extract":
        return 2
    input_path = Path(argv[2])
    output_path = Path(argv[3])
    text = _extract_pdf_text_with_docling_direct(input_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(text, encoding="utf-8")
    return 0 if text else 1


if __name__ == "__main__":
    raise SystemExit(_run_docling_extract_cli(sys.argv))

from src.pdf_document_selection import (  # noqa: E402,F401
    _adaptive_docling_timeout,
    _available_document_group_count,
    _document_family,
    _document_group_order,
    _document_identity,
    _document_profile,
    _extracted_document_profile,
    _needs_energy_diagnostics,
    _required_document_groups_for_sale,
    _select_documents_for_extraction,
    _store_document_analysis_status,
    _unique_document_groups,
)
from src.pdf_fact_extraction import (  # noqa: E402,F401
    _assign_pdf_land_surface,
    _assign_pdf_sale_date,
    _assign_pdf_surface,
    _cadastral_units_to_square_meters,
    _decimal_to_int_or_float,
    _document_filename,
    _document_land_surface_candidates,
    _document_surface_candidates,
    _energy_diagnostic_rank,
    _energy_diagnostic_risk_note,
    _extract_description,
    _extract_energy_diagnostics_from_documents,
    _extract_energy_diagnostics_with_evidence,
    _extract_land_surface_from_documents,
    _extract_land_surface_with_evidence,
    _extract_occupancy_status,
    _extract_property_type,
    _extract_risk_notes,
    _extract_rooms_count,
    _extract_sale_date_from_documents,
    _extract_sale_date_with_evidence,
    _extract_starting_price_from_documents,
    _extract_starting_price_with_evidence,
    _extract_surface,
    _extract_surface_from_documents,
    _extract_surface_with_evidence,
    _extract_visit_dates_from_documents,
    _extract_visit_dates_with_evidence,
    _first_energy_class_match,
    _has_land_surface_context,
    _has_sale_date_signal,
    _is_land_surface_evidence,
    _is_rooms_false_positive,
    _is_surface_false_positive,
    _land_surface_document_rank,
    _land_surface_match_is_built,
    _land_unit_candidate_rank,
    _merge_pdf_risk_notes,
    _normalize_visit_candidate,
    _parse_decimal_number,
    _reconcile_pdf_starting_price,
    _sale_date_candidate_phrases,
    _sale_date_extraction_rank,
    _should_replace_starting_price_with_document,
    _starting_price_document_rank,
    _surface_document_rank,
    _surface_measurement_scope,
    _visit_candidate_chunks,
    _write_pdf_text_cache,
    enrich_sale_from_pdf_text,
)
