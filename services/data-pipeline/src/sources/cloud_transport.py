"""Opt-in, source-scoped transport. Parsing and pagination remain in the collector."""
from __future__ import annotations

import os

import httpx

SOURCE_HOSTS = {"www.petitesaffiches.fr", "cessions.immobilier-etat.gouv.fr"}


def configured_transport(base_url: str) -> httpx.BaseTransport | None:
    if httpx.URL(base_url).host not in SOURCE_HOSTS:
        return None
    endpoint = os.environ.get("SOURCE_FETCH_RELAY_URL", "").strip()
    token = os.environ.get("SOURCE_FETCH_RELAY_TOKEN", "").strip()
    if not endpoint and not token:
        return None
    if not endpoint or not token or httpx.URL(endpoint).scheme != "https":
        raise ValueError("Source relay requires an HTTPS endpoint and a dedicated token")
    return SourceRelayTransport(endpoint, token)


class SourceRelayTransport(httpx.BaseTransport):
    def __init__(self, endpoint: str, token: str) -> None:
        self.endpoint = endpoint
        self.token = token
        self.client = httpx.Client(timeout=40, follow_redirects=False)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.scheme != "https" or request.url.host not in SOURCE_HOSTS or request.url.port not in (None, 443):
            raise ValueError("Source relay refuses an unconfigured origin")
        # Never transmit database credentials, authorization or arbitrary headers upstream.
        headers = {k: v for k, v in request.headers.items()
                   if k in {"user-agent", "accept", "accept-language", "content-type"}}
        response = self.client.post(
            self.endpoint,
            # Pin the proven Paris region. Automatic placement otherwise follows
            # the GitHub runner to a different egress network.
            headers={"Authorization": f"Bearer {self.token}", "x-region": "eu-west-3"},
            json={"url": str(request.url), "method": request.method,
                  "headers": headers, "body": request.read().decode("utf-8")},
        )
        if response.headers.get("x-immojudis-source-relay") != "1":
            raise httpx.TransportError("Source relay unavailable or authentication rejected")
        # httpx has already decompressed the relay response. Do not ask the
        # outer client to decompress those bytes a second time.
        headers = {k: v for k, v in response.headers.items()
                   if k not in {"content-encoding", "content-length", "transfer-encoding", "connection"}}
        return httpx.Response(response.status_code, headers=headers, content=response.content)

    def close(self) -> None:
        self.client.close()
