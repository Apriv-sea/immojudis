import { expect, test } from "@playwright/test";

const userId = "76000000-0000-4000-8000-000000000001";
const email = "investor.e2e@example.test";
const accessToken = fakeJwt({ sub: userId, email, role: "authenticated" });
const user = {
  id: userId,
  aud: "authenticated",
  role: "authenticated",
  email,
  email_confirmed_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { account_type: "b2c", full_name: "Investisseur E2E" },
};
const session = {
  access_token: accessToken,
  refresh_token: "refresh-e2e",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user,
};

test("inscription → recherche → rapport → paiement → partage", async ({ page }) => {
  const journey: string[] = [];

  await page.route("https://ci.supabase.co/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/v1/signup") {
      journey.push("registration");
      await route.fulfill({ status: 200, json: session });
      return;
    }
    if (url.pathname === "/auth/v1/user") {
      await route.fulfill({ status: 200, json: { user } });
      return;
    }
    if (url.pathname === "/auth/v1/token") {
      await route.fulfill({ status: 200, json: session });
      return;
    }
    if (url.pathname === "/rest/v1/user_profiles") {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", "content-range": "0-0/1" },
        json: [
          {
            user_id: userId,
            email,
            full_name: "Investisseur E2E",
            account_type: "b2c",
            account_tier: "free",
            user_role: "user",
            professional_role: null,
            organization_name: null,
            professional_status: "not_applicable",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
      return;
    }
    if (
      url.pathname.includes("v_auction_sales_app") ||
      url.pathname.includes("v_auction_sales_discovery") ||
      url.pathname.includes("search_auction_sales_preview")
    ) {
      if (!journey.includes("search")) journey.push("search");
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", "content-range": "0-0/1" },
        json: [mockSale()],
      });
      return;
    }
    await route.fulfill({ status: 200, json: [] });
  });

  await page.route("**/api/property-reports", async (route) => {
    if (route.request().method() === "POST") {
      journey.push("report");
      await route.fulfill({ status: 201, json: { report: { id: "report-e2e" } } });
      return;
    }
    await route.fulfill({ status: 200, json: { reports: [], plan: null } });
  });
  await page.route("**/api/feature-entitlements", (route) =>
    route.fulfill({
      status: 200,
      json: {
        plan: { plan: "decouverte", currentPeriodEnd: null, limits: {}, features: {} },
        usage: {},
      },
    }),
  );
  await page.route("**/api/billing/checkout", async (route) => {
    journey.push("payment");
    await route.fulfill({ status: 200, json: { url: "/accompagnement?checkout=success" } });
  });
  await page.route("**/api/property-reports/report-e2e/share", async (route) => {
    journey.push("share");
    await route.fulfill({
      status: 200,
      json: { share: { url: "/rapports/partage/token-e2e" }, report: { id: "report-e2e" } },
    });
  });

  await page.goto("/login");
  await expect(async () => {
    await page.getByRole("button", { name: "Découverte", exact: true }).click();
    await expect(page).toHaveURL(/mode=investor/);
  }).toPass();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill("password-e2e");
  await page.getByRole("button", { name: "Créer mon compte gratuit" }).click();
  await expect(page).toHaveURL(/\/bienvenue/);
  await page.getByLabel("Ville, département ou région").fill("Bordeaux");
  await page.getByRole("button", { name: "Continuer", exact: true }).click();
  await page.getByLabel("Mise à prix maximale (€)").fill("150000");
  await page.getByRole("button", { name: "Continuer", exact: true }).click();
  await page.getByRole("button", { name: "Voir les biens" }).click();
  await expect(page).toHaveURL(/\/sales/);
  await expect(page).toHaveURL(/query=Bordeaux/);
  await expect(page).toHaveURL(/maxPrice=150000/);

  await expect(page.getByText(/120[\s\u202f]000/).first()).toBeVisible();

  const reportId = await page.evaluate(async () => {
    const response = await fetch("/api/property-reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ saleId: "77000000-0000-4000-8000-000000000001" }),
    });
    return ((await response.json()) as { report: { id: string } }).report.id;
  });
  expect(reportId).toBe("report-e2e");

  await page.goto("/accompagnement");
  await page.getByRole("button", { name: /Débloquer Analyse/ }).click();
  await expect(page.getByRole("heading", { name: "Récapitulatif avant paiement" })).toBeVisible();
  const consentCheckboxes = page.getByRole("checkbox");
  await expect(consentCheckboxes).toHaveCount(2);
  const orderButton = page.getByRole("button", {
    name: "Commander avec obligation de paiement",
  });
  await expect(orderButton).toBeDisabled();
  await consentCheckboxes.nth(0).check();
  await consentCheckboxes.nth(1).check();
  await expect(orderButton).toBeEnabled();
  await orderButton.click();
  await expect(page).toHaveURL(/checkout=success/);

  const shareUrl = await page.evaluate(async () => {
    const response = await fetch("/api/property-reports/report-e2e/share", { method: "POST" });
    return ((await response.json()) as { share: { url: string } }).share.url;
  });
  expect(shareUrl).toContain("token-e2e");
  expect(journey).toEqual(["registration", "search", "report", "payment", "share"]);
});

function fakeJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

function mockSale() {
  return {
    id: "77000000-0000-4000-8000-000000000001",
    source_url: "https://example.test/e2e-sale",
    title: "Appartement judiciaire E2E",
    city: "Bordeaux",
    department: "33",
    postal_code: "33000",
    address: "1 rue du Test",
    tribunal: "Tribunal judiciaire de Bordeaux",
    tribunal_code: "TJ-BDX",
    property_type: "apartment",
    starting_price_eur: 120000,
    sale_date: "2026-09-15T09:00:00.000Z",
    latitude: 44.8378,
    longitude: -0.5792,
    occupancy_status: "vacant",
    app_surface_m2: 65,
    investment_score: 74,
    status: "upcoming",
    documents_rich: [],
    documents: [],
    risks: [],
    score_factors: [],
    quality_flags: [],
    media: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
