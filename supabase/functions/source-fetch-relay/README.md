# Source fetch relay

Fetch-only transport for public Petites Affiches and Cessions Etat pages. The existing Python collectors retain robots handling, request pacing, redirect origin validation, pagination, parsing, quality validation and database publication.

## Authentication and activation

The endpoint uses a dedicated 384-bit random bearer token, not a Supabase database key. Only its SHA-256 digest is stored in `auth.ts`; the plaintext belongs in the GitHub repository secret `SOURCE_FETCH_RELAY_TOKEN`. Configure the GitHub variable `SOURCE_FETCH_RELAY_URL` to the deployed function URL. Both values must be absent to use direct transport, or both present to enable the relay for the two exact source hosts.

`verify_jwt = false` delegates authentication to `handler`, which rejects missing or invalid tokens before fetching. This token does not grant database access. No authorization header or cookie from the collector is forwarded to the sources. Source redirects are returned to Python, where every destination is checked again before following it. POST is restricted to the Petites Affiches public listing filter (`historique=0`, optional department).

Rotate the token by generating a new random value, replacing its SHA-256 digest, deploying the function, and replacing the GitHub secret together. Do not print or commit the plaintext. This initial activation is awaiting explicit approval after automatic review rejected the secret transfer and persistent deployment.

## Limits

- 25-second upstream deadline; source body capped at 2 MiB.
- No automatic server-side redirects; no generic proxy and no database writes.
- Source 403/429 responses remain errors, never an empty successful catalogue.
- No cookie/session persistence. Encheres Publiques is not supported by this relay.
- Cessions TLS includes the verified Sectigo OV R36 intermediate while retaining certificate verification. Its upstream certificate chain must be maintained when the publisher rotates it.
- Request pacing is provided by existing collectors. Do not share the token with public clients or run overlapping collection jobs.

## Tests

From repository root: `deno test --allow-net supabase/functions/source-fetch-relay/index_test.ts`.
From `services/data-pipeline`: `python -m pytest tests/test_cloud_transport.py tests/test_sources_common.py`.

Production activation must be followed by a read-only inventory audit from GitHub before any complete collection or historical queue processing.
