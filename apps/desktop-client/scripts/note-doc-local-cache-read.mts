import { readFileSync } from "node:fs";
import * as Y from "yjs";

/**
 * 读桌面端本机那份笔记文档缓存（主进程落盘的那一份），看"改动的字到底走到哪一跳"：
 * - 正文里有我刚打的那句、`pending` 是空 → 主进程收到并交出去了，问题在服务端那一段；
 * - 正文里有、`pending` 非空 → 渲染层交给了主进程，但上送没成功（离线/被拒），看 error 码；
 * - 正文里没有 → 渲染层根本没把改动交出来，问题在界面这一侧。
 *
 * 为什么读这个文件而不是改渲染层代码去打印：contextBridge 暴露给渲染层的那套 API 是
 * 冻结的，`window.ailearn.note.doc.syncUpdate = ...` 这种拦截**挂不上**（实测
 * `hookable:false`），拿它做的"有没有调用"看门狗读数永远是空，空读数会被当成结论。
 *
 * 跑法：node --experimental-strip-types scripts/note-doc-local-cache-read.mts [文件] [正文里要找的子串]
 */
const file = process.argv[2] ?? "/tmp/clob-a/note-doc-cache.json";
const needle = process.argv[3] ?? "";
const parsed = JSON.parse(readFileSync(file, "utf8")) as {
  entries: Array<{
    noteId: string;
    workspaceId: string;
    docState: string;
    pending: string[];
    revision: number;
    savedAt: string;
    shareScope: string;
    updatedAt: string;
  }>;
};
const unB64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

console.log(`${file}：${parsed.entries.length} 篇，找「${needle || "（不找）"}」`);
for (const entry of parsed.entries) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, unB64(entry.docState));
  } catch (error) {
    console.log(`- ${entry.noteId} 解不开：${String(error)}`);
    continue;
  }
  const text = doc.getXmlFragment("content").toString();
  const title = doc.getMap<unknown>("meta").get("title");
  console.log(
    JSON.stringify({
      noteId: entry.noteId,
      revision: entry.revision,
      shareScope: entry.shareScope,
      updatedAt: entry.updatedAt,
      pending: entry.pending.length,
      hit: needle ? text.includes(needle) : null,
      title: typeof title === "string" ? title.slice(0, 24) : null,
      tail: text.slice(-70),
    }),
  );
  doc.destroy();
}
