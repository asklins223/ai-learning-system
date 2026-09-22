import { chromium } from "playwright-core";

/**
 * 读一个真窗口的"本机 ↔ 主进程"那一段：把 `window.ailearn.note.doc` 的三个口包一层，
 * 记下界面这一侧真正拿到的回执，再打一次字，等自动保存的 debounce 过掉，把读数打出来。
 *
 * 为什么要在真窗口里量：jsdom 的用例是把 `window.ailearn` 整个换掉跑的，IPC 的
 * zod 校验、preload 的通道白名单、主进程那条 HTTP/WS 分流**一样都不在**——
 * 这一类的失败（`invalid_request` 被 `flush()` 读成"什么都没交"，界面只剩一个
 * 「草稿」标签）在单测里结构上看不见。
 *
 * 跑法（先用 scripts/note-collab-two-windows.py 起窗口，并且这一版是 `npm run build` 之后起的）：
 *   PORT=9321 node --experimental-strip-types scripts/note-doc-ipc-probe.mts
 * 前置：这一屏得停在编辑态（clobber-check 跑完就是那个状态）。
 */
const port = Number(process.env.PORT ?? 9321);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0]!.pages().find((entry) => !entry.url().startsWith("devtools"))!;
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");

await page.evaluate(() => {
  const w = window as unknown as { ailearn: any; __ipcReads?: unknown[] };
  w.__ipcReads = [];
  const doc = w.ailearn.note.doc;
  for (const method of ["state", "syncUpdate", "syncTitle", "presence"] as const) {
    const original = doc[method];
    if (typeof original !== "function") {
      w.__ipcReads.push({ method, missing: true });
      continue;
    }
    doc[method] = async (input: any) => {
      const response = await original(input);
      w.__ipcReads!.push({
        method,
        ok: response?.ok,
        error: response?.error?.code ?? response?.error ?? null,
        data: response?.data ?? null,
        argKeys: Object.keys(input ?? {}),
      });
      return response;
    };
  }
});

await page.evaluate(() => {
  const editor = document.querySelector(".ProseMirror") as HTMLElement | null;
  if (!editor) return;
  editor.focus();
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand("insertText", false, `｜IPC探针${Date.now()}`);
});
await page.waitForTimeout(5_000);

const reads = await page.evaluate(() => (window as unknown as { __ipcReads: unknown[] }).__ipcReads);
const screen = await page.evaluate(() => ({
  chip: document.querySelector(".editor-head .tag")?.textContent?.trim() ?? null,
  alerts: [...document.querySelectorAll("[role=alert], .notebook-note")].map((n) => (n.textContent ?? "").trim()),
}));
console.log(`窗口 ${port} 的 IPC 读数：`);
console.log(JSON.stringify(reads, null, 1));
console.log("屏上：", JSON.stringify(screen, null, 1), "（探针号 " + stamp + "）");
await browser.close();
