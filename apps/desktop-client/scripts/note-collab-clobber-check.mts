/**
 * 两个"可写"窗口开同一篇笔记：一台机器那页停在旧正文时，它下一次敲字会不会把
 * 对端刚写的那段覆盖掉。这是本批（笔记真协同）的核心承诺，只能量，不能读代码相信。
 *
 * 跑法（要活体环境，不进 CI）：
 *   npm run build
 *   env $(那两个键来自仓库根 .env) electron . --user-data-dir=/tmp/clob-a --remote-debugging-port=9321
 *   同一条再起一个：--user-data-dir=/tmp/clob-b --remote-debugging-port=9322
 *   PORT_A=9321 PORT_B=9322 node --experimental-strip-types scripts/note-collab-clobber-check.mts
 *
 * 两个窗口都以 owner 登录（今天可写的只有 owner），都开同一篇**已共享**的笔记进编辑态：
 * A 敲一段 → 看 B 那一屏跟不跟得上 → B 再敲一段 → 看服务端两段是否都还在。
 * 改前量到的是"B 看不到、标签还写着「已同步」、B 一敲 A 那段就没了"（`d2d31209` 修掉）。
 * 空间/笔记 id 是 dev 库那套验收夹具，见计划 calm-valley-elk 批次 4.5 的验收状态。
 */
import { chromium } from "playwright-core";

const NOTE_HINT = "这段全空间都读得到";
const SPACE_HINT = "验收空间 acc0921";
const API = "http://127.0.0.1:4000";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function session(email: string, password: string) {
  const login = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }).then((r) => r.json());
  const switched = await fetch(`${API}/auth/switch-workspace`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${login.token}` }, body: JSON.stringify({ workspaceId: "de034109-e61f-4af1-a6c7-a80951487498" }) }).then((r) => r.json());
  const token = switched.token ?? login.token;
  const read = async () => {
    const body = await fetch(`${API}/v2/notes/2b6c1f01-8659-415f-bcc0-08ee38046cd5`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => null);
    return body?.currentVersion?.blocks?.[0]?.content ?? null;
  };
  return { token, read };
}

async function window(port: number, email: string, password: string) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools"));
  await page.waitForTimeout(1500);
  if ((await page.evaluate(() => document.body.innerText)).includes("欢迎回来")) {
    await page.evaluate(({ email, password }) => {
      const set = (el, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set(document.querySelector('input[type="email"]'), email);
      set(document.querySelector('input[type="password"]'), password);
      [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "登录").click();
    }, { email, password });
    await page.waitForTimeout(6000);
  }
  const pill = await page.evaluate(() => document.querySelector(".room-control-space")?.textContent ?? "");
  if (!pill.includes(SPACE_HINT)) {
    await page.evaluate(() => document.querySelector("button.room-control-space")?.click());
    await page.waitForTimeout(800);
    await page.evaluate((hint) => [...document.querySelectorAll("button")].find((n) => (n.textContent || "").includes(hint))?.click(), SPACE_HINT);
    await page.waitForTimeout(5000);
  }
  await page.evaluate(() => [...document.querySelectorAll("button")].find((n) => (n.textContent || "").trim().startsWith("全部笔记"))?.click());
  await page.waitForTimeout(2200);
  await page.evaluate((hint) => [...document.querySelectorAll("button,a,li")].find((n) => (n.textContent || "").includes(hint))?.click(), NOTE_HINT);
  await page.waitForTimeout(4000);
  const editState = await page.evaluate(() => {
    if (!document.querySelector(".ProseMirror")) {
      [...document.querySelectorAll("button")].find((n) => (n.textContent || "").includes("编辑这篇笔记"))?.click();
    }
    return Boolean(document.querySelector(".ProseMirror"));
  });
  await page.waitForTimeout(2500);
  const type = (text) => page.evaluate((mark) => {
    const editor = document.querySelector(".ProseMirror");
    if (!editor) return "没有编辑器";
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return `insertText=${document.execCommand("insertText", false, `｜${mark}`)}`;
  }, text);
  const chip = () => page.evaluate(() => document.querySelector(".editor-head .tag")?.textContent?.trim() ?? null);
  const bodyHas = (text) => page.evaluate((mark) => document.querySelector(".ProseMirror")?.textContent?.includes(mark) ?? false, text);
  return { page, editState, type, chip, bodyHas };
}

const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const MARK_A = `覆盖量测A${stamp}`;
const MARK_B = `覆盖量测B${stamp}`;
const owner = await session("owner@ailearn.local", "ailearn_owner");

const a = await window(Number(process.env.PORT_A ?? 9311), "owner@ailearn.local", "ailearn_owner");
const b = await window(Number(process.env.PORT_B ?? 9312), "owner@ailearn.local", "ailearn_owner");
console.log("两边都在编辑态:", a.editState, b.editState);

await a.type(MARK_A);
await wait(8000);
const afterA = await owner.read();
console.log(`A 写了 ${MARK_A} → 服务端有它:`, afterA?.includes(MARK_A));
console.log(`B 那屏看到 A 那段了吗:`, await b.bodyHas(MARK_A), "| B 的保存标签:", await b.chip());

await b.type(MARK_B);
await wait(8000);
const afterB = await owner.read();
console.log(`B 又写了 ${MARK_B} → 服务端:`, afterB);
console.log(">>> A 那段还在不在服务端:", afterB?.includes(MARK_A) ? "还在（没覆盖）" : "不见了（旧页把新内容盖掉了）");
console.log(">>> B 那段:", afterB?.includes(MARK_B) ? "在" : "不在");
process.exit(0);
