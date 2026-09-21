/** 一次性 DOM 采样：打印候选卡审核看板的真实结构（类名 + 文本）。 */
import { chromium } from "@playwright/test";
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

loadDotenv({ path: resolve(import.meta.dirname, "../../.env"), override: false });

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages()[0];

const gate = page.locator(".desktop-access-gate");
if (await gate.count()) {
  const pw = gate.locator('input[type="password"]');
  await pw.fill(process.env.OWNER_PASSWORD ?? "");
  await pw.press("Enter");
  await page.waitForTimeout(1500);
}
const firstSpace = page.locator(".first-space");
if (await firstSpace.count()) {
  await firstSpace.locator(".space-choice .button.primary").first().click();
  await page.waitForTimeout(1500);
}

await page.locator('.nav-chip[aria-label="笔记"]').click();
await page.waitForTimeout(1200);
const row = page.locator('.note-open:has-text("消防"), .note-row:has-text("消防")').first();
if (await row.count()) { await row.click(); }
else { await page.locator(".current-note__open:visible, .note-open:visible").first().click(); }
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /审核学习卡|查看生成进度|处理生成任务/ }).first().click();
await page.locator(".task-surface--card-generation").waitFor({ timeout: 8000 });
await page.waitForTimeout(2500);

const shape = await page.evaluate(() => {
  const root = document.querySelector(".task-surface--card-generation");
  if (!root) return { error: "no board" };
  const classes = new Set();
  root.querySelectorAll("*").forEach((el) => {
    el.classList.forEach((c) => classes.add(c));
  });
  return {
    text: root.innerText.replace(/\n{2,}/g, "\n").slice(0, 2600),
    classes: [...classes].sort(),
    buttons: [...root.querySelectorAll("button")].map((b) => b.innerText.replace(/\s+/g, " ").trim()).slice(0, 40),
  };
});
console.log(JSON.stringify(shape, null, 2));
await browser.close();
process.exit(0);
