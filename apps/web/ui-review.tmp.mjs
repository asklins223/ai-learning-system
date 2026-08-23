/**
 * UI 实机审查截图脚本（临时）：登录后逐页截图，首页优先 + 桌面/移动双视口。
 * 用法：cd apps/web && node ui-review.tmp.mjs
 * 输出：../outputs/ui-review/*.png
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "..", "outputs", "ui-review");
mkdirSync(OUT, { recursive: true });

const EMAIL = process.env.E2E_DEV_EMAIL || "owner@ailearn.local";
const PASSWORD = process.env.E2E_DEV_PASSWORD || "ailearn_owner";
const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";

const browser = await chromium.launch({ headless: true });

async function shoot(page, name, path, { fullPage = false, settle = 2500 } = {}) {
  try {
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45_000 });
  } catch {
    await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  }
  await page.waitForTimeout(settle);
  const out = join(OUT, `${name}.png`);
  await page.screenshot({ path: out, fullPage });
  console.log(`[ok] ${name} -> ${page.url()}`);
}

// ── 桌面视口 ──
const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
desktop.on("console", (m) => {
  if (m.type() === "error") console.log(`[console.error] ${m.text().slice(0, 160)}`);
});

await shoot(desktop, "00-login", "/login");

// 登录
await desktop.locator("#email").fill(EMAIL, { timeout: 15_000 });
await desktop.locator("#password").fill(PASSWORD);
await desktop.getByRole("button", { name: /进入工作区|sign in|登录/i }).click();
await desktop.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30_000 });
console.log("[ok] logged in as", EMAIL);
await desktop.waitForTimeout(1500);

// 首页（重点）：桌面全页 + 视口各一张
await shoot(desktop, "01-home-desktop-viewport", "/");
await shoot(desktop, "02-home-desktop-fullpage", "/", { fullPage: true, settle: 3500 });

const routes = [
  ["03-today", "/today"],
  ["04-cards-library", "/cards"],
  ["05-graph", "/graph"],
  ["06-companion-daily", "/companion/daily"],
  ["07-companion-memory", "/companion/memory"],
  ["08-memory-star-map", "/companion/memory/star-map"],
  ["09-pet-profile", "/companion/pet-profile"],
  ["10-conversations", "/companion/conversations"],
  ["11-notes", "/notes"],
  ["12-settings", "/settings"],
];
for (const [name, p] of routes) {
  await shoot(desktop, name, p);
}

// ── 移动视口：首页 + 卡库 ──
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
try {
  await mobile.goto(BASE + "/", { waitUntil: "networkidle", timeout: 45_000 });
} catch {}
await mobile.waitForTimeout(3000);
await mobile.screenshot({ path: join(OUT, "13-home-mobile.png"), fullPage: false });
console.log("[ok] 13-home-mobile");
await mobile.close();

await browser.close();
console.log("DONE ->", OUT);
