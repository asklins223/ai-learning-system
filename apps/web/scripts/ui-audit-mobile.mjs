import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const BASE = "http://127.0.0.1:3000";
mkdirSync("/tmp/ui-audit", { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[type="email"]', "owner@ailearn.local");
await page.fill('input[type="password"]', "ailearn_owner");
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
for (const route of ["/", "/cards", "/graph", "/companion/daily"]) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const name = route === "/" ? "home-mobile" : route.replaceAll("/", "_") + "-mobile";
  await page.screenshot({ path: `/tmp/ui-audit/${name}.png`, fullPage: true });
  console.log("shot:", name);
}
await browser.close();
