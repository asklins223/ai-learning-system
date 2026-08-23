/**
 * 星图交互态验证（临时）：选中侧栏 / 夜间主题 / 移动端缩放。
 * 输出：/tmp/ui-audit-verify/*.png
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.WEB_BASE ?? "http://127.0.0.1:3000";
const EMAIL = "owner@ailearn.local";
const PASSWORD = "ailearn_owner";
const OUT_DIR = "/tmp/ui-audit-verify";
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const errors = [];

async function login(ctx) {
  const page = await ctx.newPage();
  page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  return page;
}

// 1) 桌面：点击一个学习目标节点 → 侧栏
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await login(ctx);
  await page.goto(`${BASE}/graph`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const node = page.locator(".graph-v3-node--objective").first();
  if (await node.count()) {
    await node.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT_DIR}/graph-selected.png` });
    console.log("shot: graph-selected.png");
  } else {
    console.log("no objective nodes to select");
  }
  // 2) 夜间主题
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "night"));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/graph-night.png` });
  console.log("shot: graph-night.png");
  await ctx.close();
}

// 3) 移动端初始缩放
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await login(ctx);
  await page.goto(`${BASE}/graph`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT_DIR}/graph-mobile2.png` });
  console.log("shot: graph-mobile2.png");
  await ctx.close();
}

console.log(errors.length ? "=== issues ===\n" + [...new Set(errors)].slice(0, 10).join("\n") : "no page errors");
await browser.close();
