import { TOKEN_SHA256 } from "./auth.ts";
import { SECTIGO_INTERMEDIATE } from "./certificate.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const hosts = new Set(["www.petitesaffiches.fr", "cessions.immobilier-etat.gouv.fr"]);
const cessionsClient = Deno.createHttpClient({ caCerts: [SECTIGO_INTERMEDIATE] });

export function allowedTarget(value: string, method: string, body: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.port || u.username || u.password || !hosts.has(u.hostname)) return false;
    if (method === "GET") return !body && (u.hostname === "cessions.immobilier-etat.gouv.fr" ||
      u.pathname === "/robots.txt" || u.pathname.startsWith("/encheres-immobilieres/"));
    if (method !== "POST" || u.hostname !== "www.petitesaffiches.fr" ||
        !u.pathname.startsWith("/encheres-immobilieres/")) return false;
    const form = new URLSearchParams(body);
    return form.get("historique") === "0" && [...form].every(([k, v]) =>
      (k === "historique" && v === "0") || (k === "select_dep" && /^(?:\d{2,3}|2A|2B)$/.test(v)));
  } catch { return false; }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", {status: 405});
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || auth.length > 256) return new Response("Unauthorized", {status: 401});
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.slice(7))))]
    .map(x => x.toString(16).padStart(2, "0")).join("");
  if (hash !== TOKEN_SHA256) return new Response("Unauthorized", {status: 401});
  try {
    const raw = await req.text();
    if (raw.length > 16384) return new Response("Request too large", {status: 413});
    const input = JSON.parse(raw);
    const {url, method = "GET", body = ""} = input;
    if (typeof url !== "string" || typeof body !== "string" || !allowedTarget(url, method, body))
      return new Response("Target not allowed", {status: 400});
    const headers = new Headers();
    for (const name of ["user-agent", "accept", "accept-language"])
      if (typeof input.headers?.[name] === "string") headers.set(name, input.headers[name]);
    if (method === "POST") headers.set("content-type", "application/x-www-form-urlencoded");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, {method, headers, body: method === "POST" ? body : undefined,
        redirect: "manual", signal: controller.signal,
        ...(new URL(url).hostname === "cessions.immobilier-etat.gouv.fr" ? {client: cessionsClient} : {})});
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { await reader.cancel(); return new Response("Source response too large", {status: 502}); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const out = new Headers({"x-immojudis-source-relay": "1", "cache-control": "no-store"});
      for (const name of ["content-type", "location", "retry-after", "cf-mitigated"])
        if (response.headers.has(name)) out.set(name, response.headers.get(name)!);
      const blocked = response.headers.get("cf-mitigated") === "challenge" ||
        /<title>\s*(?:Just a moment|Un instant|Access Denied)/i.test(new TextDecoder().decode(bytes));
      const status = blocked ? 403 : response.status;
      return new Response([204, 205, 304].includes(status) ? null : bytes, {status, headers: out});
    } finally { clearTimeout(timer); }
  } catch {
    return new Response("Source fetch failed", {status: 502});
  }
}
