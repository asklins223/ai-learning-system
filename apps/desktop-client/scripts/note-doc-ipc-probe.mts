import { chromium } from "playwright-core";

/**
 * 一个真窗口，从头开到编辑态，然后把"本机 ↔ 主进程"那一段量出来。
 *
 * 为什么必须这样量：jsdom 用例是把 `window.ailearn` 整个换掉跑的，IPC 的 zod 校验、
 * preload 通道白名单、主进程那条 HTTP/WS 分流**一样都不在**。真实窗口里那句
 * "标签永远停在草稿、服务端一个字节都没收到"就是这一类失败，只在真窗口看得见。
 *
 * 这一份刻意**不**用 HTTP 另开会话（`clobber-check` 开头那两步会新建 session）：
 * 判据要干净，屏上这一条路的 session 就是从应用自己登录来的。服务端那边读库由
 * 外部命令做（见计划文档里那条 psql），不在这里绕 API。
 *
 * 跑法：
 *   npm run build
 *   python3 scripts/note-collab-two-windows.py          # 或只起一个窗口
 *   PORT=9321 node --experimental-strip-types scripts/note-doc-ipc-probe.mts
 */
const port = Number(process.env.PORT ?? 9321);
const SPACE_HINT = process.env.SPACE_HINT ?? "验收空间 acc0921";
const NOTE_HINT = process.env.NOTE_HINT ?? "这段全空间都读得到";
const EMAIL = "owner@ailearn.local";
const PASSWORD = "ailearn_owner";
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const MARK = `｜单窗探针${stamp}`;

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0]!.pages().find((entry) => !entry.url().startsWith("devtools"))!;

// 先挂上拦截：起点那次 `state` 也要被记到（"取了几次起点"本身就是判据之一）。
await page.evaluate(() => {
  const w = window as unknown as { ailearn?: any; __ipc?: unknown[] };
  w.__ipc = [];
  const doc = w.ailearn?.note?.doc;
  if (!doc) return;
  for (const method of ["state", "syncUpdate", "syncTitle", "presence"] as const) {
    const original = doc[method];
    if (typeof original !== "function") {
      w.__ipc.push({ method, missing: true });
      continue;
    }
    doc[method] = async (input: any) => {
      const response = await original(input);
      w.__ipc!.push({
        method,
        ok: response?.ok,
        error: response?.error?.code ?? response?.error ?? null,
        data: response?.data ?? null,
        argKeys: Object.keys(input ?? {}),
        updateLen: input?.update?.length ?? null,
      });
      return response;
    };
  }
});

/** 自证：这个拦截真的挂得上（挂不上的话，下面的空读数什么都证明不了）。 */
const selfTest = await page.evaluate(async () => {
  const w = window as unknown as { ailearn?: any; __ipc?: unknown[] };
  const doc = w.ailearn?.note?.doc;
  if (!doc) return { hookable: false, reason: "note.doc 不在" };
  let writable = true;
  try {
    const original = doc.presence;
    doc.presence = async (input: any) => original(input);
    writable = doc.presence !== original;
    doc.presence = original;
  } catch (error) {
    return { hookable: false, reason: String(error) };
  }
  await doc.state({ meta: {}, noteId: "00000000-0000-0000-0000-000000000000" }).catch(() => null);
  return { hookable: writable, recorded: (w.__ipc ?? []).length };
});
console.log("拦截自证:", JSON.stringify(selfTest));

async function screen(): Promise<Record<string, unknown>> {
  return page.evaluate(() => ({
    gate: (document.body?.innerText ?? "").includes("为保护已有学习记录"),
    login: (document.body?.innerText ?? "").includes("欢迎回来"),
    chip: document.querySelector(".editor-head .tag")?.textContent?.trim() ?? null,
    saveLine: document.querySelector(".editor-head")?.innerText?.replace(/\n/g, " ")?.slice(0, 160) ?? null,
    editor: Boolean(document.querySelector(".ProseMirror")),
    title: (document.getElementById("notebook-surface-title") as HTMLInputElement | null)?.value ?? null,
  }));
}

async function clickText(prefix: string): Promise<boolean> {
  return page.evaluate((text) => {
    const hit = [...document.querySelectorAll("button,a,li")].find((n) => (n.textContent || "").trim().startsWith(text));
    if (!hit) return false;
    (hit as HTMLElement).click();
    return true;
  }, prefix);
}

if ((await screen()).login) {
  await page.evaluate(({ email, password }) => {
    const set = (el: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set(document.querySelector('input[type="email"]') as HTMLInputElement, email);
    set(document.querySelector('input[type="password"]') as HTMLInputElement, password);
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "登录")!.click();
  }, { email: EMAIL, password: PASSWORD });
  await page.waitForTimeout(7000);
}
console.log("登录后:", JSON.stringify(await screen()));

// 空间胶囊：不在验收空间就点开换过去。
if (!(await page.evaluate((hint) => (document.querySelector(".room-control-space")?.textContent ?? "").includes(hint), SPACE_HINT))) {
  await page.evaluate(() => document.querySelector("button.room-control-space")?.click());
  await page.waitForTimeout(900);
  await page.evaluate((hint) => [...document.querySelectorAll("button")].find((n) => (n.textContent || "").includes(hint))?.click(), SPACE_HINT);
  await page.waitForTimeout(5000);
}
await clickText("全部笔记");
await page.waitForTimeout(2200);
await clickText(NOTE_HINT);
await page.waitForTimeout(4000);
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
await page.waitForSelector(".ProseMirror", { timeout: 15000 }).catch(() => {});
console.log("进编辑态后:", JSON.stringify(await screen()));

await page.evaluate((mark) => {
  const editor = document.querySelector(".ProseMirror") as HTMLElement | null;
  if (!editor) return;
  editor.focus();
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand("insertText", false, mark);
}, MARK);
// 自动保存的 debounce 是 1.2 秒；给到 6 秒，够两三个来回。
await page.waitForTimeout(6000);

const reads = await page.evaluate(() => (window as unknown as { __ipc: unknown[] }).__ipc);
console.log("屏上（打字 6 秒后）:", JSON.stringify(await screen()));
console.log("窗口 " + port + " 的 IPC 读数（探针号 " + stamp + "，打进去的字：" + MARK + "）:");
console.log(JSON.stringify(reads, null, 1));
await browser.close();
