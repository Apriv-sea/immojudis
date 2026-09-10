# AGRASC intermediate certificate

AGRASC omits its Sectigo Qualified Website Authentication CA R39 intermediate.
The Python client loads this public intermediate only for AGRASC, together with
the existing certifi root store. Hostname verification and CERT_REQUIRED remain
enabled; VERIFY_X509_PARTIAL_CHAIN is explicitly disabled. No leaf certificate
or new root is trusted. Other collectors keep their default TLS configuration.

Retrieved 2026-09-09 from https://crt.sh/?d=14599514169, referenced by Sectigo's
https://www.sectigo.com/uploads/files/eIDAS/Qualified_certificate_profiles_v2.7.pdf.
DER SHA256: ac8c7ef96eb4b535fbfb4e7521f130536198a60dff716312b22d4acc4afe9a7d.
Issuer: Sectigo Public Server Authentication Root R46.
Live verified request: HTTP 200 with the intermediate; certificate verification
failure without it. Remove this workaround when the origin serves a full chain.
Do not add a root or enable partial-chain trust to accommodate future failures.
