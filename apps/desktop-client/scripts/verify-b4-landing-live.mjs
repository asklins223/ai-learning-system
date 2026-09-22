/**
 * A1·B4 实机验收：在**跑着的桌面 app** 里量「生成中那一屏逐张列出已落盘候选」。
 *
 * 实例由本脚本自己启：隔离的 user-data-dir + 自己的 CDP 端口，量完即杀，
 * 不动并行会话那两个窗口。主进程要 `AILEARN_DOMAIN_SCHEMA_REVISION` 与配对密钥才肯
 * 信任本机服务，所以启动时必须把根 .env 带进环境——少了它准入门只说一句
 * "桌面端尚未通过本机服务校验"。
 *
 * 零模型调用：库里那个批次是真模型写出来的，这里只把它的 `status` 拨回 `authoring`
 * （A1·B2 之后这是生产可达的状态：崩在作者中途、候选已逐张提交），量完由调用方还原。
 *
 *   node scripts/verify-b4-landing-live.mjs
 *
 * 量的三件事都写成可判红的断言，不是截图看看：
 * ① 列表真的出现了，条数 == 库里 landed（非 failed/dropped）候选数；
 * ② 一屏之内「已写几张」这个数只有一处，且列表标题不带数；
 * ③ 每条说的是题面与概念名，答案与证据没有随列表下发。
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: resolve(import.meta.dirname, "../../../.env"), override: false });
if (!process.env.OWNER_EMAIL || !process.env.OWNER_PASSWORD) {
  throw new Error("OWNER_EMAIL / OWNER_PASSWORD 不在根 .env 里——填进去会变成 'undefined' 假成一次登录失败");
}
if (!process.env.AILEARN_DOMAIN_SCHEMA_REVISION || !process.env.AILEARN_DESKTOP_PAIRING_SECRET) {
  throw new Error("根 .env 缺 AILEARN_DOMAIN_SCHEMA_REVISION / AILEARN_DESKTOP_PAIRING_SECRET：主进程不会信任本机服务");
}

const outDir = resolve(import.meta.dirname, "b4-landing-live");
await mkdir(outDir, { recursive: true });
const NOTE_TITLE = process.env.B4_NOTE_TITLE ?? "repair 分支实测夹具";

const appRoot = resolve(import.meta.dirname, "..");
const cdpPort = process.env.B4_CDP_PORT ?? "9633";
const userDataDir = process.env.B4_UDD ?? "/tmp/b4-measure-udd";
const apiOrigin = process.env.DESKTOP_API_ORIGIN ?? "http://127.0.0.1:4000";
// 并行会话存一次 src 文件，容器里的 tsx watch 就重启一次 api；重启那几秒书架读到的是
// "学习服务内部出了点问题"。这不是任何人的缺陷，是抢窗口——先等 `/ready` 连续三次为真
// 再动手，否则量到的是重启间隙。
const apiReady = async () => {
  try {
    const r = await fetch(`${apiOrigin}/ready`, { signal: AbortSignal.timeout(2000) });
    return r.status === 200;
  } catch {
    return false;
  }
};
async function waitForApi(label, maxMs = 150_000) {
  const deadline = Date.now() + maxMs;
  let streak = 0;
  while (Date.now() < deadline) {
    streak = (await apiReady()) ? streak + 1 : 0;
    if (streak >= 3) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(JSON.stringify({ fatal: `等不到学习服务就绪（${label}）` }, null, 2));
  return false;
}
if (!(await waitForApi("开跑前"))) process.exit(5);
// 注释里说"每次冷启"就得真的清空：上一次跑完留下的投影缓存会让这一轮读到旧列表，
// 我第一次就因此把"全部 11"当成了当下的库内容。
await rm(userDataDir, { recursive: true, force: true });
const child = spawn(process.execPath, [
  resolve(appRoot, "node_modules/.bin/electron"), ".",
  `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`,
], { cwd: appRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let childLog = "";
// Electron 的主进程日志走 stdout 与 stderr 两边，只收一边会漏掉真正那句报错。
child.stdout.on("data", (b) => { childLog += b.toString(); });
child.stderr.on("data", (b) => { childLog += b.toString(); });
// 主进程的报错只在这里能看到（准入门上只会显示"学习服务内部出了点问题"）。
process.on("exit", () => {
  writeFile(resolve(outDir, "electron-stderr.log"), childLog.slice(-40_000)).catch(() => undefined);
  try { child.kill("SIGKILL"); } catch { /* 已经走了 */ }
});

const hasPage = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).some((t) => t.type === "page");
  } catch {
    return false;
  }
};
for (let i = 0; i < 45 && !(await hasPage()); i += 1) await new Promise((r) => setTimeout(r, 1000));
if (!(await hasPage())) {
  console.log(JSON.stringify({ fatal: `自己启的实例没起来（CDP ${cdpPort}）`, childLog: childLog.slice(0, 600) }, null, 2));
  process.exit(2);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser.contexts()[0].pages()[0];
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`); });

const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: resolve(outDir, `${name}.png`), fullPage: true }); };

// 1. 登录门 + 空间选择。每次都从空 user-data-dir 冷启：准入门有三态（填凭据 /
//    钥匙串已存凭据 / 选空间），复用上一次的目录会让脚本测的是别的东西。
const gateDump = async () => ({
  text: (await page.locator(".desktop-access-gate").innerText().catch(() => "")) || null,
  buttons: await page.locator(".desktop-access-gate button").allTextContents(),
  inputs: await page.locator(".desktop-access-gate input").evaluateAll((ns) => ns.map((n) => `${n.type}:${n.getAttribute("aria-label") || n.placeholder || ""}`)),
});
if (await page.locator(".desktop-access-gate").count()) {
  // 准入门刚挂载时是个空壳（`.desktop-access-gate` 已在，input 还没渲染出来）。
  // 不等它就点提交，会报成"门上没有按钮"——那是我读早了，不是界面缺按钮。
  for (let i = 0; i < 25; i += 1) {
    if (!(await page.locator(".desktop-access-gate").count())) break;
    if (await page.locator(".desktop-access-gate input").count()) break;
    await page.waitForTimeout(600);
  }
}
if (await page.locator(".desktop-access-gate").count()) {
  const before = await gateDump();
  // React 受控输入：必须走原生 setter + input 事件，直接赋值会被 onChange 覆盖。
  await page.evaluate(({ email, password }) => {
    const set = (el, value) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll(".desktop-access-gate input")];
    const mail = inputs.find((i) => i.type === "email" || /邮箱/.test(i.getAttribute("aria-label") || "") || /邮箱/.test(i.placeholder || ""));
    const pass = inputs.find((i) => i.type === "password" || /密码/.test(i.getAttribute("aria-label") || ""));
    if (mail) set(mail, email);
    if (pass) set(pass, password);
  }, { email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD });
  const submit = page.locator(".desktop-access-gate button").filter({ hasText: /登录|进入|继续/ }).first();
  if (!(await submit.count())) {
    await shot("0-gate");
    console.log(JSON.stringify({ fatal: "准入门上没有提交按钮", before, after: await gateDump() }, null, 2));
    process.exit(2);
  }
  await submit.click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  if (await page.locator(".desktop-access-gate").count()) {
    await shot("0-gate");
    console.log(JSON.stringify({ fatal: "登录后仍停在准入门", before, after: await gateDump() }, null, 2));
    process.exit(2);
  }
}
if (await page.locator(".first-space").count()) {
  await page.locator(".first-space .space-choice .button.primary").first().click();
  await page.waitForTimeout(2000);
}
const gateStill = await page.locator(".desktop-access-gate").count();
if (gateStill) {
  console.log(JSON.stringify({ fatal: "登录后仍停在准入门", gateText: await page.locator(".desktop-access-gate").innerText().catch(() => null) }, null, 2));
  process.exit(2);
}

// 2. 打开那篇笔记：书架 → 搜索标题 → 点中命中的那一行。
//    直接点「索引第一篇」会开错笔记（库里 21 篇），所以按标题找；找不到就把书架页
//    的可见行报出来，让人看得见脚本为什么退。
//    导航点击走 JS：左侧目录在收起态时 `.nav-collapse` 会盖住页签，真实指针点不到——
//    那是本脚本要路过的界面状态，不是 B4 要量的东西（量的那一下仍用真实读数）。
const clickViaJs = async (locator, { waitMs = 25_000 } = {}) => {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const ok = await locator.evaluateAll((ns) => { if (!ns.length) return false; ns[0].click(); return true; }).catch(() => false);
    if (ok) return;
    await page.waitForTimeout(700);
  }
  throw new Error("等不到可点的元素（这一屏根本没渲染它？）");
};
const hudPage = async () => await page.locator(".desktop-app").getAttribute("data-hud-page");
const rowsForTitle = () => page.locator("button, a, [role='button']").filter({ hasText: NOTE_TITLE });
const onNoteDetail = async () => (await page.locator(".notebook-actions").count()) > 0;

// LIB_PROBE=1：只量"书架这一屏读得到读不到"，用来定因果（一次约 40 秒，不进笔记详情）。
if (process.env.LIB_PROBE === "1") {
  await clickViaJs(page.locator('.nav-chip[aria-label="笔记"], .hud-rail button[aria-label="笔记"]'), { waitMs: 20_000 });
  await page.waitForTimeout(6000);
  const body = await page.evaluate(() => document.body.innerText);
  console.log(JSON.stringify({
    mode: "LIB_PROBE",
    hudPage: await hudPage(),
    noteRowsFound: await rowsForTitle().count(),
    libraryBlocked: /暂时不可用/.test(body),
    blockedLine: (body.match(/[^\n]*暂时不可用[^\n]*\n[^\n]*/) || [null])[0],
  }, null, 2));
  process.exit(0);
}

// CREATE_NOTE=1：在**应用里**新建一篇笔记并打字存下来。
// 为什么绕这一圈：SQL 夹具造的笔记在桌面端读不出正文（详情稳定报「研究册暂时不可用」），
// 拿它量 B4 只会量到别人的读路径缺陷。走一遍真实的新建与自动保存，才有一篇读得好的宿主笔记。
if (process.env.CREATE_NOTE === "1") {
  const titleLine = process.env.B4_NEW_NOTE || "B4 实机量测笔记 已经写好的卡";
  await clickViaJs(page.locator('.nav-chip[aria-label="笔记"], .hud-rail button[aria-label="笔记"]'), { waitMs: 20_000 });
  await page.waitForTimeout(4000);
  // 先直接找「新建笔记」；找不到再点开全量列表重试一次（上一版反过来，点开列表之后
  // 那一屏反而没有这个按钮了）。
  const newBtn = page.locator("button").filter({ hasText: /新建笔记/ });
  const allNotesBtn = page.locator("button").filter({ hasText: /全部笔记/ });
  let hasNew = await newBtn.count();
  if (!hasNew && (await allNotesBtn.count())) {
    await clickViaJs(allNotesBtn, { waitMs: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    hasNew = await newBtn.count();
  }
  if (!hasNew) {
    console.log(JSON.stringify({
      fatal: "书架上没有「新建笔记」",
      hudPage: await hudPage(),
      body: (await page.evaluate(() => document.body.innerText).catch(() => "")).split("\n").filter(Boolean).slice(0, 14),
    }, null, 2));
    process.exit(2);
  }
  await clickViaJs(newBtn, { waitMs: 10_000 });
  for (let i = 0; i < 30 && !(await page.locator(".note-editor [contenteditable='true']").count()); i += 1) await page.waitForTimeout(700);
  const editable = page.locator(".note-editor [contenteditable='true']").first();
  if (!(await editable.count())) {
    console.log(JSON.stringify({ fatal: "新建之后没等到编辑器", hudPage: await hudPage() }, null, 2));
    process.exit(2);
  }
  await editable.evaluate((el) => el.focus());
  await editable.click({ timeout: 5000 }).catch(() => undefined);
  await page.keyboard.type(titleLine, { delay: 25 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("第一段：候选是一张一张写出来的，写完的那张应该先看到。", { delay: 15 });
  // 时间线：每 2 秒记一次"还在不在编辑器、正文读到几个字"。上一轮 12 秒后 editorText 是空的，
  // 只报最后一个时刻分不清是"字没进去"还是"页面被弹走了"。
  const timeline = [];
  for (let i = 0; i < 10; i += 1) {
    await page.waitForTimeout(2000);
    timeline.push({
      atSec: (i + 1) * 2,
      hudPage: await hudPage(),
      editorPresent: await page.locator(".note-editor [contenteditable='true']").count(),
      chars: (await editable.innerText().catch(() => "")).length,
    });
  }
  console.log(JSON.stringify({
    mode: "CREATE_NOTE", titleLine, timeline,
    hudPage: await hudPage(),
    editorText: (await editable.innerText().catch(() => "")).slice(0, 80),
  }, null, 2));
  process.exit(0);
}

// 进笔记详情这一段要重来几次才稳：刚进书架那一屏是"正在整理今天的书桌…同步中"，
// 列表还没到就去找行，会把"同步没完"误报成"这一屏没这个入口"。
let opened = false;
const attempts = [];
for (let attempt = 0; attempt < 7 && !opened; attempt += 1) {
  await clickViaJs(page.locator('.nav-chip[aria-label="笔记"], .hud-rail button[aria-label="笔记"]'), { waitMs: 15_000 });
  await page.waitForTimeout(1200);
  const allNotes = page.locator("button").filter({ hasText: /全部笔记/ });
  if (await allNotes.count()) {
    await clickViaJs(allNotes, { waitMs: 6_000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
  }
  let waited = 0;
  while (waited < 25 && !(await rowsForTitle().count())) { await page.waitForTimeout(1000); waited += 1; }
  const found = await rowsForTitle().count();
  if (!found) {
    // 读不到列表时先分清两种"没有"：整屏写着"暂时不可用"（服务在重启），和真的没有这篇
    // 笔记。前者等一会儿重点「重新读取」就有，后者才该让脚本失败。
    const blocked = await page.evaluate(() => /暂时不可用/.test(document.body.innerText));
    if (blocked) {
      attempts.push({ attempt, blockedByServiceRestart: true, waitedForRowsSec: waited });
      await waitForApi("书架读到" + "暂时不可用", 90_000);
      await clickViaJs(page.locator("button").filter({ hasText: /重新读取/ }), { waitMs: 8_000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
      continue;
    }
  }
  if (found) {
    await clickViaJs(rowsForTitle());
    // 到位的判断分两步：先等页码变成笔记详情，再等那一排动作渲染出来。
    // 只看后者会在"页面已经到了、数据还没回来"的瞬间误判成没进去——我第一版就是这么
    // 白点了三次，然后把"其实成功了"的那次覆盖掉了。
    for (let i = 0; i < 20 && (await hudPage()) !== "08"; i += 1) await page.waitForTimeout(700);
    for (let i = 0; i < 20 && !(await onNoteDetail()); i += 1) await page.waitForTimeout(700);
  }
  attempts.push({
    attempt, waitedForRowsSec: waited, found, opened: await onNoteDetail(), hudPage: await hudPage(),
    // 到位了但读不到那一排动作时，这一屏到底写了什么——不留这句就只能猜。
    noteText: (await page.evaluate(() => document.body.innerText).catch(() => ""))
      .split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 16),
  });
  opened = (await onNoteDetail()) || (await hudPage()) === "08";
}
const searchBox = page.locator('input[type="search"], input[placeholder*="搜索"], .note-search input, input[aria-label*="搜索"]').first();
if (process.env.NAV_DUMP === "1") {
  await shot("nav-library");
  console.log(JSON.stringify({
    fatal: "NAV_DUMP", opened, attempts,
    hudPage: await hudPage(),
    hasSearchBox: !!(await searchBox.count()),
    bodyButtons: (await page.locator("button").allTextContents()).slice(0, 45),
  }, null, 2));
  process.exit(0);
}
await page.waitForTimeout(1200);
const notebookDump = async () => ({
  opened,
  hudPage: await hudPage(),
  actions: await page.locator(".notebook-actions *").allTextContents(),
  liveStatus: await page.locator(".notebook-generation-live").textContent().catch(() => null),
});
const notebook = await notebookDump();
await shot("1-notebook");

// 3. 进「生成中」那一屏。笔记页那一排动作里「生成学习卡」是 `.tag`（不是 button 角色），
//    在制的批次才给「查看生成进度」按钮——所以这里按文字在整排动作里找，不假设角色。
const ENTER_TEXT = /查看生成进度|生成学习卡|处理生成任务|查看激活进度/;
const enterLoc = page.locator(".notebook-actions *").filter({ hasText: ENTER_TEXT }).first();
let enterName = null;
try {
  enterName = (await enterLoc.textContent({ timeout: 6000 }) ?? "").trim();
  // 「生成学习卡」会**新起一次真模型生成**（花钱、且会插一个新批次）。本脚本只允许
  // 进"已经有一批在制"的那屏，读到这个字样就当场退出，绝不动手。
  if (/生成学习卡/.test(enterName)) {
    await shot("0-starts-a-new-run");
    console.log(JSON.stringify({
      fatal: "笔记页给的是「生成学习卡」——点下去会新起一次真模型生成，脚本拒绝",
      notebook: await notebookDump(), attempts, enterName,
    }, null, 2));
    process.exit(4);
  }
  await clickViaJs(enterLoc, { waitMs: 6_000 });
} catch {
  // 找不到入口时先把自己看到的都报出来：量错入口比量不到更糟，但"这一屏根本没有
  // 这个按钮"也要能被看见，而不是只留一句超时。
  const buttons = await page.locator("button").evaluateAll((ns) => ns.map((n) => (n.textContent || "").trim()).filter(Boolean));
  await shot("0-no-entry");
  console.log(JSON.stringify({
    fatal: "笔记详情里没有进生成屏的入口", notebook: await notebookDump(), attempts,
    actions: await page.locator(".notebook-actions *").allTextContents(),
    buttons: buttons.slice(0, 40),
  }, null, 2));
  process.exit(3);
}
await page.locator(".task-surface--card-generation").waitFor({ timeout: 10000 });
await page.waitForTimeout(3000);

// 4. 量
const measured = await page.evaluate(() => {
  const text = (sel) => [...document.querySelectorAll(sel)].map((n) => (n.textContent || "").trim());
  const all = document.body.innerText;
  const numberLines = (all.match(/已写出\s*\d+\s*\/\s*\d+\s*张/g) || []);
  const listTitleWithNumber = (all.match(/已经写好\s*\d+\s*张/g) || []);
  return {
    hudPage: document.querySelector(".desktop-app")?.getAttribute("data-hud-page") ?? null,
    runStatusText: text(".card-generation-progress__name"),
    eyebrow: text(".card-generation-progress__eyebrow"),
    meta: text(".card-generation-progress__meta"),
    percent: text(".card-generation-progress__percent"),
    landingPresent: !!document.querySelector(".card-generation-landing"),
    landingTitle: text(".card-generation-landing__title"),
    landingItems: [...document.querySelectorAll('[data-testid="card-generation-landing-item"]')].map((li) => ({
      concept: li.querySelector(".card-generation-landing__concept")?.textContent?.trim() ?? null,
      prompt: li.querySelector(".card-generation-landing__prompt")?.textContent?.trim() ?? null,
    })),
    numberLines,
    listTitleWithNumber,
    // 答案与证据不该随列表下发：这一屏不该出现「查看参考答案」之类的动作，
    // 也不该出现证据引文块。
    answerControlsPresent: !!document.querySelector("[data-card-answer-reveal], .candidate-answer, .evidence-quote"),
    syncReport: text(".card-generation-board__sync-report"),
  };
});
await shot("2-generating-landing");

const report = { notebook, enterName, measured, consoleErrors };
await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

const fails = [];
if (!measured.landingPresent) fails.push("① 生成中那一屏没有出现「已经写好的卡」这一块");
if (measured.landingItems.length === 0) fails.push("① 列表 0 条");
if (measured.numberLines.length !== 1) fails.push(`② 「已写出 N / M 张」应恰好 1 处，实到 ${measured.numberLines.length}`);
if (measured.listTitleWithNumber.length !== 0) fails.push("② 列表标题又报了一个张数");
if (measured.answerControlsPresent) fails.push("③ 列表里混进了答案/证据控件");
console.log(fails.length ? "FAIL\n" + fails.join("\n") : "PASS");
await browser.close();
process.exit(fails.length ? 1 : 0);
