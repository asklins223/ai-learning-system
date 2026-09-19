/**
 * 流式下发管线（2026-09-19）：稳定前缀 / 增量校验 / 信封守卫 / 终态一致化。
 *
 * 这里锁住的核心不变量：**流式期间下发的文本永远是最终 assistant 文本的前缀**。
 * 一旦破坏，客户端会看到内容回跳（先出现的字被后面的净化改掉）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  companionVisibleText,
  createCompanionStreamDelivery,
  projectCompanionVisible,
  reconcileStreamedText,
  stableVisibleCut,
} from "./companion-dialogue-stream.ts";
import { sanitizeCompanionVisibleText } from "./companion-dialogue-content.ts";
import type { ReadContext } from "./companion-dialogue-store.ts";

/** 只用到 runId/generation/conversationId 等字段；注入写入口后不碰数据库。 */
const READ_FIXTURE = {
  runId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
  conversationId: "22222222-2222-4222-8222-222222222222",
  accountEpoch: 0,
  userId: "33333333-3333-4333-8333-333333333333",
} as unknown as ReadContext;

function deliveryWithRecorder(options: { flushChars?: number; flushIntervalMs?: number } = {}) {
  const written: string[] = [];
  const delivery = createCompanionStreamDelivery({
    ctx: { workspaceId: "44444444-4444-4444-8444-444444444444" },
    read: READ_FIXTURE,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    notifyCompanionEvent: async () => undefined,
    flushChars: options.flushChars,
    flushIntervalMs: options.flushIntervalMs,
    writeVisible: async (text) => {
      written.push(text);
      return true;
    },
  });
  return { delivery, written };
}

describe("stableVisibleCut", () => {
  it("干净的行（无标记）整行可发", () => {
    const raw = "你好，今天想聊点什么？";
    assert.equal(stableVisibleCut(raw), raw.length);
  });

  it("行内出现标记时，当前行整体压住，只发到上一个换行", () => {
    const raw = "第一行在这里\n**第二行还没写完";
    assert.equal(stableVisibleCut(raw), "第一行在这里\n".length);
  });

  it("行首标记（列表/标题）同样压住当前行", () => {
    assert.equal(stableVisibleCut("- 待办还没写完"), 0);
    assert.equal(stableVisibleCut("### 标题"), 0);
  });

  it("行内连字符不算标记（\"3-5 天\" 不该钉住整行）", () => {
    const raw = "3-5 天后再复习一遍。";
    assert.equal(stableVisibleCut(raw), raw.length);
  });

  it("多行：已完成的行不受当前行影响", () => {
    const raw = "干净的第一行。\n干净的第二行。\n*含标记的第三行";
    assert.equal(stableVisibleCut(raw), "干净的第一行。\n干净的第二行。\n".length);
  });
});

describe("projectCompanionVisible", () => {
  it("净化后的稳定前缀：markdown 已剥离，且仍是最终文本的前缀", () => {
    const raw = "**你好**，慢慢来。\n";
    const projection = projectCompanionVisible(raw);
    assert.equal(projection.kind, "visible");
    if (projection.kind !== "visible") return;
    assert.equal(projection.text, "你好，慢慢来。");
    assert.ok(sanitizeCompanionVisibleText(raw.trim()).startsWith(projection.text));
  });

  it("长度超限 → rejected（增量校验先于任何对外写入）", () => {
    const projection = projectCompanionVisible("甲".repeat(20_001));
    assert.deepEqual(projection, { kind: "rejected", reason: "output_too_long" });
  });

  it("内部 token 泄露 → rejected", () => {
    const projection = projectCompanionVisible("我在用 companion-persona-v4 回答你");
    assert.deepEqual(projection, { kind: "rejected", reason: "internal_token_leak" });
  });

  it("JSON 信封开头 → envelope_guarded（不把信封语法流给用户）", () => {
    assert.deepEqual(projectCompanionVisible('{"reply": "你好"'), { kind: "envelope_guarded" });
    assert.deepEqual(projectCompanionVisible('[{"text": "你好"'), { kind: "envelope_guarded" });
  });

  it("前缀单调 + 始终是最终文本前缀（逐增量模拟）", () => {
    const pieces = ["你好，", "今天想聊点", "什么？\n", "**加粗**", "的内容\n", "最后一句收尾。"];
    let raw = "";
    let emitted = "";
    for (const piece of pieces) {
      raw += piece;
      const projection = projectCompanionVisible(raw);
      if (projection.kind !== "visible") continue;
      // 单调：新的可见前缀必须以上一次已下发的文本开头（否则客户端会回跳）。
      assert.ok(projection.text.startsWith(emitted), `回跳：${JSON.stringify(projection.text)} 不含 ${JSON.stringify(emitted)}`);
      emitted = projection.text;
    }
    // 结尾必须与全文净化结果一致（流式期间下发的就是它的前缀）。
    const finalText = sanitizeCompanionVisibleText(raw.trim());
    assert.ok(finalText.startsWith(emitted));
    assert.equal(emitted, finalText);
  });

  it("companionVisibleText 只做投影，不 Trim 行内空白（避免与终态错位）", () => {
    const raw = "你好 世界";
    assert.equal(companionVisibleText(raw), raw);
  });
});

describe("createCompanionStreamDelivery（节流 + 拼接，不重不漏）", () => {
  it("节流窗口内多次增量只落库一次，且拼接结果等于稳定前缀（回归：pending 必须计入切片基准）", async () => {
    // flushChars 很大 + 间隔很长 → 中途都不落库，只有 finish 强制落一次。
    const { delivery, written } = deliveryWithRecorder({ flushChars: 10_000, flushIntervalMs: 60_000 });
    for (const piece of ["心情", "是软乎乎的", "，像晒过太阳的旧书页。"]) {
      assert.equal(await delivery.onRawDelta(piece), true);
    }
    const finished = await delivery.finish();
    assert.deepEqual(finished, { ok: true, text: "心情是软乎乎的，像晒过太阳的旧书页。" });
    // 首拍立即落库（初值 lastFlushAt=0 让时间条件立刻成立），其后按节流窗口合并；
    // 关键不变量是**拼接结果逐字等于稳定前缀**（不重不漏）。
    assert.equal(written.join(""), "心情是软乎乎的，像晒过太阳的旧书页。");
  });

  it("多次落库（低节流阈值）：拼接结果与稳定前缀逐字一致", async () => {
    const { delivery, written } = deliveryWithRecorder({ flushChars: 6, flushIntervalMs: 0 });
    for (const piece of ["第一句。", "第二句。", "第三句。"]) {
      await delivery.onRawDelta(piece);
    }
    await delivery.finish();
    assert.equal(written.join(""), "第一句。第二句。第三句。");
    // 每次写入的起点必须紧接上一次（appendFrom 是累积下标）。
    assert.equal(delivery.deliveredChars(), "第一句。第二句。第三句。".length);
  });

  it("writeTail 把全文差值补齐（终态文本比稳定前缀长）", async () => {
    const { delivery, written } = deliveryWithRecorder({ flushChars: 10_000, flushIntervalMs: 60_000 });
    await delivery.onRawDelta("你好，我是伴星。");
    const finished = await delivery.finish();
    assert.equal(finished.ok, true);
    assert.ok(await delivery.writeTail("你好，我是伴星。很高兴见到你。"));
    assert.equal(written.join(""), "你好，我是伴星。很高兴见到你。");
  });

  it("校验失败即终止，且不再落库", async () => {
    const { delivery, written } = deliveryWithRecorder();
    assert.equal(await delivery.onRawDelta("正常开头，然后泄露 companion-persona-v4"), false);
    assert.equal(delivery.failureReason(), "internal_token_leak");
    const finished = await delivery.finish();
    assert.deepEqual(finished, { ok: false, reason: "internal_token_leak" });
    assert.deepEqual(written, []);
  });

  it("信封守卫：整段不流式，finish 返回空前缀交给全文兜底", async () => {
    const { delivery, written } = deliveryWithRecorder();
    assert.equal(await delivery.onRawDelta('{"reply": "你好"'), true);
    const finished = await delivery.finish();
    assert.deepEqual(finished, { ok: true, text: "" });
    assert.deepEqual(written, []);
    assert.equal(delivery.deliveredChars(), 0);
  });
});

describe("reconcileStreamedText", () => {
  it("终态文本以已下发内容开头 → 通过", () => {
    const result = reconcileStreamedText({
      delivered: "你好",
      validated: { ok: true, text: "你好，世界。" },
    });
    assert.deepEqual(result, { ok: true, text: "你好，世界。" });
  });

  it("两条路径漂移（终态文本不含已下发内容）→ 判失败，不给客户端不一致的回复", () => {
    const result = reconcileStreamedText({
      delivered: "**你好",
      validated: { ok: true, text: "你好" },
    });
    assert.deepEqual(result, { ok: false, reason: "stream_full_text_diverged" });
  });

  it("全文校验失败直接透传原因", () => {
    const result = reconcileStreamedText({
      delivered: "你好",
      validated: { ok: false, reason: "json_envelope_leak" },
    });
    assert.deepEqual(result, { ok: false, reason: "json_envelope_leak" });
  });
});
