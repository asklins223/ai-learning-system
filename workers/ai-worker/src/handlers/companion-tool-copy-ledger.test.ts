/**
 * 工具失败那句话会不会以内部词上屏（39d 抄写纪律的 worker 侧守卫）。
 *
 * 链路是量出来的，不是推测的：`companion-agent-runtime.ts:3615` 把 `CompanionToolError.message`
 * 截 240 字当 `safeSummary`，随 `agent.tool`（`failed`／`blocked`）事件下发，渲染层
 * `companion-agent-nodes.ts:181` 原样取用 ⇒ **那句英文内部词就是用户看到的失败说明**。
 *
 * 判据从**源码现读**，三种抛出形状都覆盖（这一版加的，前一版只看得见直接写死的字符串）：
 *  ① `CompanionToolError("…")` / `CompanionToolBlockedError("…")` 的字面量；
 *  ② 抛的是**具名常量**（`CompanionToolError(VISION_EGRESS_DENIED_MESSAGE)`）⇒ 顺到常量定义再看；
 *  ③ 抛的是**函数调用**（`missingImageMessage(assetId)`）⇒ 进函数体把它的返回字面量都取出来看。
 * 只数匹配到的条数不够，所以正控制要求三条路各读到一条已知样本。表**只许变短**。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * 扫哪些文件是**发现**出来的，不是手抄的：抄一份名单会有两种错——列了不含抛出的文件
 * （`companion-dialogue.ts` 与 `companion-daily-summary.ts` 今天一条都没有，纯占位），
 * 以及新加抛点的文件没进名单就静默漏判。
 */
function filesWithThrows(): string[] {
  const dir = import.meta.dirname;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => /CompanionTool(?:Blocked)?Error\(/.test(readFileSync(resolve(dir, name), "utf8")))
    .sort();
}

/**
 * 已知仍然写给工程读者的句子（按抛出点去重）。翻完一条删一条。
 *
 * 2026-09-25 清空。剩下这 5 条当时挂着"要先定口径"，量完之后判定**不需要新机制**：
 * 那几条括号里的参数指引在**工具自己的描述**里本来就写着（`companion-agent-registry.ts`
 * 的 143／144／156／162 行：先 recall 拿 memoryId、用 noteId 或 assetId 指定是哪张），
 * 而描述是**每一次请求都带过去的**，写在错误句里反而是第二个来源、还顺带上屏。
 * ⇒ 四条改写成给用户看的那一句，第五条（「那篇笔记里没有这张图…」）本来就是用户话，
 * 只是被我当成"参数提示族"的兄弟记进了表里——**它从不违规，记进来是我的账记错了**。
 * 通道保留：下一句要留欠账时记在这里，而不是放松判据。
 */
const PENDING_USER_LEGIBLE: readonly string[] = [];


/** 中文为主、且不夹带内部词汇，才算"给用户看的那一种"。 */
function looksInternal(message: string): boolean {
  if (!/[一-鿿]/.test(message)) return true;
  return /\b(workspace|executor|payload|revision|table|row)\b/i.test(message)
    || /\b[a-z]+Id\b/.test(message)
    || /\bcompanion_[a-z_]+\b/.test(message);
}

function literals(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

/** ②型：`const NAME = "…"`；③型：`function name(...) { return "…" }` 的所有返回字面量。 */
function resolvedFrom(source: string, token: string): string[] {
  const constMatch = new RegExp(`const ${token}\\s*=\\s*"([^"]+)"`).exec(source);
  if (constMatch) return [constMatch[1]];
  const start = source.indexOf(`function ${token}`);
  if (start < 0) return [];
  let depth = 0;
  let end = start;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) { end = index; break; }
  }
  return literals(source.slice(start, end), /"([^"\\]{6,})"/g);
}

function thrownMessages(): string[] {
  const out: string[] = [];
  for (const file of filesWithThrows()) {
    const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
    // ①：直接写死的字面量（两个错误类都算）。
    out.push(...literals(source, /(?:CompanionToolError|CompanionToolBlockedError)\(\s*"([^"]+)"/g));
    // ②③：抛的是标识符或函数调用，顺着定义看。
    for (const [, token] of source.matchAll(
      /(?:CompanionToolError|CompanionToolBlockedError)\(\s*([A-Za-z_][A-Za-z0-9_]*)(?:\(|\s*\))/g,
    )) out.push(...resolvedFrom(source, token));
  }
  return [...new Set(out)];
}

test("正控制：三种抛出形状都真读到了（读不到时「零违规」就是假绿）", () => {
  const files = filesWithThrows();
  assert.ok(files.includes("companion-agent-runtime.ts"), `没在 discovered 名单里找到主文件：${files.join(", ")}`);
  const messages = thrownMessages();
  assert.ok(messages.length >= 12, `只读到 ${messages.length} 条，抛出形状或文件名变了`);
  assert.ok(messages.some((message) => message.includes("这一步我这边还做不了")), "①字面量那条没读到");
  assert.ok(messages.some((message) => message.includes("「允许发送图片内容」")), "②具名常量那条没读到");
  assert.ok(messages.some((message) => message.includes("那篇笔记里没有这张图")), "③函数返回那条没读到");
});

test("新写的失败句必须是给用户看的那一种；已知的欠账要显式记账", () => {
  const offenders = thrownMessages()
    .filter(looksInternal)
    .filter((message) => !PENDING_USER_LEGIBLE.includes(message));
  assert.deepEqual(offenders, [],
    "这些句子会原样上屏（safeSummary）：翻成第一人称的中文，或记进 PENDING_USER_LEGIBLE 并写明为什么先留着");

  const stale = PENDING_USER_LEGIBLE.filter((message) => !thrownMessages().includes(message));
  assert.deepEqual(stale, [], "这些已经不在源码里抛了，条目该删");
});

test("会红自证：纯英文、中文夹内部词、中文夹字段名这三种形状都逮得住", () => {
  assert.equal(looksInternal("tool has no direct executor"), true, "纯英文该红");
  assert.equal(looksInternal("这一步我这边还做不了，先停住，没有改动任何东西"), false, "中文第一人称不该红");
  assert.equal(looksInternal("读取上限已经到了 revision 边界"), true, "中文里夹内部字段名该红");
  assert.equal(looksInternal("这张图在当前空间里找不到（assetId 只能来自别处）"), true, "中文里夹 assetId 该红");
  assert.equal(looksInternal("先 companion_recall_memory 一下"), true, "中文里夹工具名该红");
});
