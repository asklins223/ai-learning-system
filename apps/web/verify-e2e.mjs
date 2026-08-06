import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/asklins/Documents/study/.env", "utf8");
const pw = (env.match(/OWNER_PASSWORD=(.*)/) || [])[1]?.trim() ?? "";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

const loginRes = await page.request.post("http://localhost:3000/api/auth/login", { data: { email: "owner@ailearn.local", password: pw } });
const csrf = (await ctx.cookies()).find(c => c.name === "ailearn_csrf")?.value ?? "";
const csrfHeaders = { "X-CSRF-Token": csrf };

// 建一篇新笔记（不同 idempotency → 新 run）
const noteRes = await page.request.post("http://localhost:3000/api/notes", {
  headers: csrfHeaders,
  data: {
    title: "设计稿验证",
    blocks: [
      { type: "heading", content: "什么是贝叶斯定理" },
      { type: "paragraph", content: "贝叶斯定理描述了基于先验概率和条件概率计算后验概率的方法。它是概率论中的一个基本定理。" },
      { type: "paragraph", content: "公式为 P(A|B) = P(B|A) * P(A) / P(B)，其中 P(A) 是先验概率，P(A|B) 是后验概率。" },
      { type: "paragraph", content: "贝叶斯推断在机器学习中广泛应用于分类任务，如朴素贝叶斯分类器。" },
      { type: "paragraph", content: "它在医学诊断、垃圾邮件过滤和推荐系统等领域都有实际应用。" },
    ],
  },
});
const noteBody = await noteRes.json();
const noteId = noteBody.note.id;
const versionId = noteBody.version.id;
console.log("笔记:", noteId, "version:", versionId);

const genRes = await page.request.post("http://localhost:3000/api/card-generation-runs", {
  headers: csrfHeaders,
  data: { noteVersionId: versionId, idempotencyKey: `verify-design-${Date.now()}` },
});
const genBody = await genRes.json();
console.log("生成:", genRes.status(), "runId:", genBody.runId, "status:", genBody.status);

await page.goto(`http://localhost:3000/notes/${noteId}`, { waitUntil: "networkidle", timeout: 20000 }).catch(()=>{});
await page.waitForTimeout(12000);

// 检查新设计结构
const dialog = await page.locator(".gen-progress-dialog").count();
const header = await page.locator(".gen-progress-title").textContent().catch(() => null);
const eyebrow = await page.locator(".gen-progress-eyebrow").textContent().catch(() => null);
const stepper = await page.locator(".gen-progress-step").count();
const events = await page.locator(".gen-timeline-event").count();
const sideStats = await page.locator(".gen-stat").count();
const footer = await page.locator(".gen-progress-footer").count();

console.log("dialog:", dialog, "| header:", header, "| eyebrow:", eyebrow?.trim());
console.log("stepper 步数:", stepper, "| 时间线事件:", events, "| 侧栏统计:", sideStats, "| footer:", footer);

if (dialog > 0) {
  await page.screenshot({ path: "/tmp/design-v3.png", fullPage: false });
  console.log("📸 截图 /tmp/design-v3.png");
  // 读取执行记录里的部分事件文案
  const texts = await page.locator(".gen-timeline-event-text").allTextContents().catch(() => []);
  console.log("事件文案(前6):", texts.slice(0, 6));
  const per = await page.locator(".gen-progress-percent").textContent().catch(() => null);
  const timing = await page.locator(".gen-progress-timing").innerText().catch(() => null);
  console.log("进度:", per, "| 时间:", timing?.replace(/\n/g, " "));
}
if (pageErrors.length) console.log("PAGE ERRORS:", pageErrors.slice(0, 3));
await browser.close();
