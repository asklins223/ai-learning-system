/**
 * UI 审查截图脚本（临时）：登录 dev 实例，截取关键页面。
 * 用法：cd apps/web && node scripts/ui-audit-shot.mjs [route ...]
 * 输出：/tmp/ui-audit/*.png
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.WEB_BASE ?? "http://127.0.0.1:3000";
const EMAIL = "owner@ailearn.local";
const PASSWORD = "ailearn_owner";
const OUT_DIR = "/tmp/ui-audit";
mkdirSync(OUT_DIR, { recursive: true });

const routes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["/", "/cards", "/today", "/review", "/search", "/graph", "/notes", "/sources", "/companion/chat", "/companion/memory"];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`[console.error] ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
page.on("requestfailed", (req) =>
  errors.push(`[requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ""}`),
);
page.on("response", (res) => {
  if (res.status() >= 400) errors.push(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
});

// 登录（走 UI，保证 cookie 落在浏览器上下文）
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
console.log("logged in, landed on:", page.url());

for (const route of routes) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200); // 等动画/懒加载
  const name = route === "/" ? "home" : route.replaceAll("/", "_");
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: true });
  console.log("shot:", `${OUT_DIR}/${name}.png`);
}

if (errors.length) {
  console.log("\n=== captured issues ===");
  for (const e of [...new Set(errors)].slice(0, 30)) console.log(e);
}
await browser.close();
