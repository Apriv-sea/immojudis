from src.sources import common


class _Response:
    def __init__(self, status_code: int, *, text: str = "", location: str | None = None) -> None:
        self.status_code = status_code
        self.text = text
        self.headers = {"location": location} if location else {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def test_polite_client_accepts_configured_canonical_robots_redirect(monkeypatch) -> None:
    requested: list[str] = []

    class Client:
        def __init__(self, **kwargs: object) -> None:
            del kwargs

        def get(self, url: str) -> _Response:
            requested.append(url)
            if url == "https://www.encheres-publiques.com/robots.txt":
                return _Response(301, location="https://encheres-publiques.com/robots.txt")
            return _Response(200, text="User-agent: *\nDisallow: /services")

    monkeypatch.setattr(common.httpx, "Client", Client)
    client = common.PoliteHttpClient(
        base_url="https://www.encheres-publiques.com",
        allowed_redirect_origins=("https://encheres-publiques.com",),
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    assert requested == [
        "https://www.encheres-publiques.com/robots.txt",
        "https://encheres-publiques.com/robots.txt",
    ]
    assert client._robots.can_fetch("https://encheres-publiques.com/encheres/immobilier/lot_1")
    assert not client._robots.can_fetch("https://encheres-publiques.com/services")


def test_polite_client_rejects_unconfigured_robots_redirect(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs: object) -> None:
            del kwargs

        def get(self, url: str) -> _Response:
            del url
            return _Response(301, location="https://evil.example/robots.txt")

    monkeypatch.setattr(common.httpx, "Client", Client)
    client = common.PoliteHttpClient(
        base_url="https://www.encheres-publiques.com",
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    assert client._robots == common.RobotsRules()


def test_agrasc_intermediate_does_not_disable_root_or_hostname_validation():
    import hashlib
    import ssl
    from pathlib import Path

    from src.sources import agrasc
    from src.sources.agrasc import agrasc_tls_context

    context = agrasc_tls_context()
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True
    assert not context.verify_flags & ssl.VERIFY_X509_PARTIAL_CHAIN
    certificate = Path(agrasc.__file__).with_name("certificates") / "sectigo-qualified-r39.pem"
    der = ssl.PEM_cert_to_DER_cert(certificate.read_text())
    assert hashlib.sha256(der).hexdigest() == "ac8c7ef96eb4b535fbfb4e7521f130536198a60dff716312b22d4acc4afe9a7d"
