import httpx
import pytest

from src.sources.cloud_transport import SourceRelayTransport, configured_transport


def test_relay_preserves_source_status_and_never_forwards_authorization():
    transport = SourceRelayTransport("https://example.supabase.co/functions/v1/source-fetch-relay", "fetch-only")
    calls = []

    def upstream(request):
        import json
        calls.append(json.loads(request.content))
        assert request.headers["authorization"] == "Bearer fetch-only"
        return httpx.Response(403, headers={"x-immojudis-source-relay": "1", "cf-mitigated": "challenge"}, text="blocked")

    transport.client.close()
    transport.client = httpx.Client(transport=httpx.MockTransport(upstream))
    with httpx.Client(transport=transport) as client:
        response = client.get("https://www.petitesaffiches.fr/encheres-immobilieres/",
                              headers={"authorization": "never-forward", "user-agent": "collector"})
    assert response.status_code == 403
    assert response.text == "blocked"
    assert "authorization" not in calls[0]["headers"]
    assert calls[0]["headers"]["user-agent"] == "collector"


def test_gateway_errors_are_not_catalogue_pages():
    transport = SourceRelayTransport("https://example.supabase.co/relay", "test")
    transport.client.close()
    transport.client = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(401, text="Unauthorized")))
    with httpx.Client(transport=transport) as client, pytest.raises(httpx.TransportError):
        client.get("https://cessions.immobilier-etat.gouv.fr/")


@pytest.mark.parametrize("url", ["https://evil.example/", "http://www.petitesaffiches.fr/",
                                 "https://www.petitesaffiches.fr:444/"])
def test_transport_rejects_other_origins(url):
    with httpx.Client(transport=SourceRelayTransport("https://example.supabase.co/relay", "test")) as client:
        with pytest.raises(ValueError):
            client.get(url)


def test_relay_configuration_is_opt_in_and_scoped(monkeypatch):
    monkeypatch.delenv("SOURCE_FETCH_RELAY_URL", raising=False)
    monkeypatch.delenv("SOURCE_FETCH_RELAY_TOKEN", raising=False)
    assert configured_transport("https://www.petitesaffiches.fr") is None
    monkeypatch.setenv("SOURCE_FETCH_RELAY_URL", "https://example.supabase.co/relay")
    assert configured_transport("https://www.licitor.com") is None
    with pytest.raises(ValueError):
        configured_transport("https://www.petitesaffiches.fr")


def test_relay_redirect_is_checked_by_source_guard(monkeypatch):
    from src.sources.common import PoliteHttpClient
    transport = SourceRelayTransport("https://example.supabase.co/relay", "test")
    transport.client.close()
    calls = []

    def upstream(request):
        calls.append(request)
        return httpx.Response(302, headers={"x-immojudis-source-relay": "1", "location": "https://evil.example/"})

    transport.client = httpx.Client(transport=httpx.MockTransport(upstream))
    monkeypatch.setattr("src.sources.common.configured_transport", lambda _: transport)
    client = PoliteHttpClient("https://www.petitesaffiches.fr", "test", 0, 5)
    with pytest.raises(RuntimeError, match="outside configured"):
        client.get("https://www.petitesaffiches.fr/encheres-immobilieres/")
    assert len(calls) == 2  # robots and listing; never fetch the external destination
    client._client.close()
