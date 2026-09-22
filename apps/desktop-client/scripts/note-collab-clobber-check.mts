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
  /** 整版块列表：并发那一段要数块数（旧形状量到的正是"3 块并发改两处收成 4 块"）。 */
  const readAll = async () => {
    const body = await fetch(`${API}/v2/notes/2b6c1f01-8659-415f-bcc0-08ee38046cd5`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => null);
    return body?.currentVersion?.blocks ?? null;
  };
  return { token, read, readAll };
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
  // 列表那一行的点击在实机上有几种落点（「打开笔记：…」那条入口、「继续写」那张卡）。
  // 一条会说谎的看门狗比没有更糟：这里挨个补点一次，最后仍没编辑器就把那一屏原样打出来，
  // 让"这一腿没量到"看得见，而不是被读成"产品没同步"。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.evaluate(() => {
      if (document.querySelector(".ProseMirror")) return;
      const entry = [...document.querySelectorAll("button,a,li")].find((n) => {
        const text = (n.textContent || "").trim();
        return text.startsWith("打开笔记：") || text.startsWith("继续写");
      });
      entry?.click();
    });
    await page.waitForTimeout(3500);
  }
  await page.evaluate(() => {
    if (!document.querySelector(".ProseMirror")) {
      [...document.querySelectorAll("button")].find((n) => (n.textContent || "").includes("编辑这篇笔记"))?.click();
    }
  });
  await page.waitForSelector(".ProseMirror", { timeout: 12_000 }).catch(() => {});
  const editState = await page.evaluate(() => Boolean(document.querySelector(".ProseMirror")));
  if (!editState) {
    const screen = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 240));
    console.log(`  窗口 ${port} 没进编辑态，那一屏是：${screen.replace(/\n/g, " / ")}`);
  }
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

// 同一对窗口顺手量在场那一排（批次 4.4 的 presence）：印章数 = 1 个自己 + 对端，
// 名字是对端自己广播的，不是查名册查出来的。
const presence = async (label: string, page: Awaited<ReturnType<typeof window>>) => {
  const seen = await page.page.evaluate(() => ({
    stamps: [...document.querySelectorAll(".notebook-presence__peer")].map((n) => `${n.textContent}‹${n.getAttribute("aria-label")}›`),
    count: [...document.querySelectorAll(".tag")].map((n) => n.textContent.trim()).find((t) => t.includes("人在看")) ?? null,
  }));
  console.log(`在场 ${label}:`, JSON.stringify(seen));
};
await presence("B 侧:", b);
await presence("A 侧:", a);

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

/**
 * 这一批真正要量的那件事：**同一个光标位置，两边各插一句，两句都得在，块数不能涨。**
 * 旧形状（`Y.Array<Y.Map{content: Y.Text}>` + 界面持一份字符串拷贝）做不到——批次 A 的对照
 * 用例量到"3 块并发改两处收成 4 块"；绑上 `y-prosemirror` 之后两边写的都是同一个 `YXmlText`，
 * 合并给的是同一块里的两处插入。判据读服务端那一份投影，不读任何一屏。
 */
const SIM_A = `同段并发A${stamp}`;
const SIM_B = `同段并发B${stamp}`;
const blocksBefore = await owner.readAll();
await Promise.all([a.type(SIM_A), b.type(SIM_B)]);
await wait(9000);
const afterSim = await owner.readAll();
const first = afterSim?.[0]?.content ?? "";
console.log(`同一光标位置两边各插一句 → 块数 ${(blocksBefore?.length ?? 0)}→${afterSim?.length ?? 0}`);
console.log(">>> 两句都在第一段里:", first.includes(SIM_A) && first.includes(SIM_B), "| 第一段:", first.slice(0, 120));
console.log(">>> 有没有多出一块:", (afterSim?.length ?? 0) > (blocksBefore?.length ?? 0) ? "多出来了（两份拷贝在并发插入）" : "没有");
process.exit(0);
