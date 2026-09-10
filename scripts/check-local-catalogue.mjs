import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

// Only consume an explicit `supabase status --output json` file. Never load .env
// or fall back to the linked project: this test inserts disposable fixtures.
const statusPath = process.argv[2];
assert(statusPath, "Usage: node scripts/check-local-catalogue.mjs <local-status.json>");
const status = JSON.parse(await readFile(statusPath, "utf8"));
const apiUrl = localUrl(status.API_URL, "http:");
const databaseUrl = localUrl(status.DB_URL, "postgresql:");
assert(status.PUBLISHABLE_KEY, "The local publishable key is required.");

const db = postgres(databaseUrl.toString(), { max: 1, connect_timeout: 5 });
const source = `local-discovery-${randomUUID()}`;
const city = `Discovery-${randomUUID()}`;
const ids = Array.from({ length: 4 }, () => randomUUID());
const allowedFields = [
  "id",
  "starting_price_eur",
  "total_count",
  "sale_venue_type",
  "sale_verification_status",
  "city",
  "department",
  "property_type",
  "sale_date",
  "app_surface_m2",
  "app_surface_kind",
  "rooms_count",
  "bedrooms_count",
  "bathrooms_count",
  "latitude",
  "longitude",
  "thumbnail_url",
].sort();

try {
  await db.begin(async (sql) => {
    for (const [index, id] of ids.entries()) {
      await sql`
        insert into public.auction_sales (
          id, source_name, source_url, city, department, title, address,
          property_type, starting_price_eur, sale_date, status,
          app_surface_m2, app_surface_kind, latitude, longitude,
          sale_venue_type, sale_verification_status, lawyer_contact, raw_payload
        ) values (
          ${id}, ${source}, ${`https://example.test/${source}/${index}`}, ${city}, '33',
          'Private fixture title', 'Private fixture address', 'apartment', ${100000 + index * 10000},
          now() + interval '30 days', ${index === 3 ? "past" : "upcoming"},
          ${50 + index * 10}, 'habitable', ${index === 2 ? null : 44.837812}, -0.579234,
          ${index === 0 ? "tribunal" : "notary"}, 'pending', 'Private fixture contact',
          ${sql.json({ raw_image_url: "https://example.test/photo.jpg", private: "never-return" })}
        )
      `;
    }
  });

  const all = await rpc({ p_city: city, p_sort: "price_asc" });
  assert.equal(all.status, 200);
  assert.deepEqual(
    all.body.map((row) => row.id),
    ids.slice(0, 3),
  );
  for (const row of all.body) {
    assert.deepEqual(Object.keys(row).sort(), allowedFields);
    assert.equal(row.total_count, 3);
    assert.equal(typeof row.starting_price_eur, "number");
    assert.equal(typeof row.app_surface_m2, "number");
    assert.equal(row.city, city);
    assert.equal(row.thumbnail_url, "https://example.test/photo.jpg");
  }
  assert.equal(all.body[0].latitude, 44.84);
  assert.equal(all.body[0].longitude, -0.58);
  assert.equal(all.body[2].latitude, null);

  const page = await rpc({
    p_city: city,
    p_sale_venue_type: "notary",
    p_sort: "price_asc",
    p_limit: 1,
    p_offset: 1,
  });
  assert.equal(page.status, 200);
  assert.equal(page.body.length, 1);
  assert.equal(page.body[0].id, ids[2]);
  assert.equal(page.body[0].total_count, 2);

  for (const keyword of [
    "Private fixture address",
    "Private fixture title",
    "Private fixture contact",
  ]) {
    const response = await rpc({ p_city: city, p_keywords: [keyword] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);
  }
  for (const filter of [{ p_min_score: 70 }, { p_north: 45 }]) {
    const response = await rpc(filter);
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "42501");
  }
  const oversized = await rpc({ p_limit: 101 });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.body.code, "22023");

  const protectedTable = await request("auction_sales?select=lawyer_contact&limit=1");
  assert.equal(protectedTable.status, 401);
  assert.equal(protectedTable.body.code, "42501");
  const discoveryView = await request("v_auction_sales_discovery?select=*&limit=1");
  assert.equal(discoveryView.status, 401);
  assert.equal(discoveryView.body.code, "42501");
  const spatialReference = await request("spatial_ref_sys?select=*&limit=1");
  assert.equal(spatialReference.status, 401);
  assert.equal(spatialReference.body.code, "42501");
} finally {
  try {
    // The catalogue deliberately forbids deletion without Outcome Graph lineage.
    // Hide only this run's fixtures; discard the isolated stack after verification.
    await db`update public.auction_sales set status = 'past' where source_name = ${source}`;
  } finally {
    await db.end();
  }
}

console.log(JSON.stringify({ ok: true, target: "local", catalogue: "v3", fixturesArchived: true }));

function localUrl(value, protocol) {
  const url = new URL(value);
  assert.equal(url.protocol, protocol, "Unexpected local service protocol.");
  assert(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Refusing a non-local service.",
  );
  return url;
}

function rpc(args) {
  return request("rpc/search_auction_sales_preview_v3", args);
}

async function request(path, body) {
  const response = await fetch(new URL(`/rest/v1/${path}`, apiUrl), {
    method: body ? "POST" : "GET",
    headers: { apikey: status.PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}
