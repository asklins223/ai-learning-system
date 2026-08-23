import { chromium } from "playwright";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:3000/login", { waitUntil: "networkidle" });
await page.fill('input[type="email"]', "owner@ailearn.local");
await page.fill('input[type="password"]', "ailearn_owner");
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });

// 抓 dashboard API 响应，看 cardId 到底是什么
const [resp] = await Promise.all([
  page.waitForResponse((r) => r.url().includes("learning-dashboard"), { timeout: 15000 }),
  page.goto("http://127.0.0.1:3000/", { waitUntil: "networkidle" }),
]);
const data = await resp.json();
console.log("mode:", data.mode);
console.log("primaryFocus objectiveId:", data.primaryFocus?.objective?.objectiveId);
console.log("primaryFocus cardId:", data.primaryFocus?.objective?.content?.presentation?.cardId ?? JSON.stringify(data.primaryFocus?.objective?.content).slice(0, 300));
console.log("recent[0]:", JSON.stringify(data.recentObjectives?.[0], null, 2)?.slice(0, 800));
await browser.close();
