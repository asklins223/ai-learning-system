/**
 * UI 验证截图（临时）：桌面 1440 + 移动 375 双端。
 * 用法：cd apps/web && node scripts/ui-verify-shot.mjs
 * 输出：/tmp/ui-audit-verify/*.png
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.WEB_BASE ?? "http://127.0.0.1:3000";
const EMAIL = "owner@ailearn.local";
const PASSWORD = "ailearn_owner";
const OUT_DIR = "/tmp/ui-audit-verify";
mkdirSync(OUT_DIR, { recursive: true });

const SOURCE_ID = process.argv[2] ?? "";
const shots = [
  { route: "/graph", name: "graph-desktop", viewport: { width: 1440, height: 900 } },
  { route: "/graph", name: "graph-mobile", viewport: { width: 375, height: 812 } },
  { route: "/companion/memory/star-map", name: "memory-starmap-desktop", viewport: { width: 1440, height: 900 } },
  { route: "/today", name: "today-desktop", viewport: { width: 1440, height: 900 } },
  ...(SOURCE_ID ? [{ route: `/sources/${SOURCE_ID}`, name: "source-detail-desktop", viewport: { width: 1440, height: 900 } }] : []),
];

const browser = await chromium.launch();
const errors = [];
for (const shot of shots) {
  const ctx = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => errors.push(`[${shot.name}] [pageerror] ${err.message}`));
  page.on("response", (res) => {
    if (res.status() >= 500) errors.push(`[${shot.name}] [http ${res.status()}] ${res.url()}`);
  });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  await page.goto(`${BASE}${shot.route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT_DIR}/${shot.name}.png`, fullPage: true });
  console.log("shot:", `${OUT_DIR}/${shot.name}.png`);
  await ctx.close();
}
if (errors.length) {
  console.log("=== captured issues ===");
  for (const e of [...new Set(errors)].slice(0, 20)) console.log(e);
} else {
  console.log("no page errors");
}
await browser.close();
