// Read-only browser feasibility probe. No CAPTCHA interaction or stored sessions.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const context = await browser.newContext({ locale: "fr-FR" });
const page = await context.newPage();
const results = [];
try {
  for (const url of [
    "https://www.encheres-publiques.com/ventes/immobilier",
    "https://encheres-publiques.com/ventes/immobilier",
  ]) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page
        .waitForFunction(
          () => !/just a moment|un instant|attention required/i.test(document.title),
          null,
          { timeout: 15000 },
        )
        .catch(() => {});
      const result = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        chars: document.body.innerText.length,
        links: [...document.querySelectorAll("a[href]")]
          .map((a) => a.href)
          .filter((h) => h.includes("/ventes/")),
      }));
      results.push({ requestedUrl: url, status: response?.status(), ...result });
    } catch (error) {
      results.push({ requestedUrl: url, error: error.message });
    }
  }
} finally {
  await browser.close();
}
await mkdir("data/audits", { recursive: true });
await writeFile(
  "data/audits/browser-probe.json",
  JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
);
console.log(
  JSON.stringify(
    results.map(({ links, ...r }) => ({ ...r, links: links?.length })),
    null,
    2,
  ),
);
