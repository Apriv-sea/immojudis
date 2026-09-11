import { allowedTarget, handler } from "./handler.ts";

Deno.test("restrict origins and POST forms", () => {
  const cases: [string, string, string, boolean][] = [
    ["https://www.petitesaffiches.fr/encheres-immobilieres/", "GET", "", true],
    ["https://cessions.immobilier-etat.gouv.fr/?page=1", "GET", "", true],
    ["https://www.petitesaffiches.fr/encheres-immobilieres/", "POST", "historique=0&select_dep=06", true],
    ["https://www.petitesaffiches.fr/encheres-immobilieres/", "POST", "historique=0&delete=1", false],
    ["https://www.petitesaffiches.fr/admin", "GET", "", false],
    ["https://evil.example/", "GET", "", false],
    ["https://www.petitesaffiches.fr.evil.example/", "GET", "", false],
    ["https://user:pass@www.petitesaffiches.fr/", "GET", "", false],
    ["https://cessions.immobilier-etat.gouv.fr/", "POST", "", false],
    ["http://cessions.immobilier-etat.gouv.fr/", "GET", "", false],
  ];
  for (const [url, method, body, expected] of cases)
    if (allowedTarget(url, method, body) !== expected) throw new Error(url);
});

Deno.test("unauthorized callers cannot fetch", async () => {
  const response = await handler(new Request("https://relay.invalid", {method: "POST",
    headers: {authorization: "Bearer invalid"}, body: JSON.stringify({url: "https://www.petitesaffiches.fr/"})}));
  if (response.status !== 401) throw new Error("Authentication failed open");
});
