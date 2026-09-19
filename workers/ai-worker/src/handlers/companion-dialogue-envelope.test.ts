/**
 * 流式 JSON 信封解码（2026-09-19）。
 *
 * 为什么重要：流式必须保持 json_object 模式（纯文本模式会让模型改成续写上一条
 * 助手消息，实机复现为"，我在呢。…"这种缺主语的回复），所以 JSON 语法必须在
 * 解码器里被剥干净——漏一个字符，用户就会在气泡里看到 `{"reply": "`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCompanionEnvelopeDecoder } from "./companion-dialogue-envelope.ts";

function decodeAll(deltas: readonly string[]): { text: string; completed: boolean; unrecognized: boolean } {
  const decoder = createCompanionEnvelopeDecoder();
  let text = "";
  let completed = false;
  let unrecognized = false;
  for (const delta of deltas) {
    for (const chunk of decoder.push(delta)) {
      if (chunk.kind === "text") text += chunk.text;
      if (chunk.kind === "completed") completed = true;
      if (chunk.kind === "unrecognized") unrecognized = true;
    }
  }
  return { text, completed, unrecognized };
}

describe("createCompanionEnvelopeDecoder", () => {
  it("整段一次到达：剥掉信封，只留正文", () => {
    assert.deepEqual(decodeAll(['{"reply": "嘿嘿，我在呢。"}']), {
      text: "嘿嘿，我在呢。",
      completed: true,
      unrecognized: false,
    });
  });

  it("在任意位置切开都还原同一份正文（逐字符切分穷举）", () => {
    const envelope = '{"reply": "嘿嘿，我在呢。看你这么开心，我也跟着乐了。"}';
    for (let split = 1; split < envelope.length; split += 1) {
      const result = decodeAll([envelope.slice(0, split), envelope.slice(split)]);
      assert.equal(result.text, "嘿嘿，我在呢。看你这么开心，我也跟着乐了。", `split=${split}`);
      assert.equal(result.completed, true, `split=${split} 未识别收尾`);
    }
  });

  it("转义按 JSON 语义还原（引号/换行/反斜杠）", () => {
    const raw = '{"reply": "他说：\\"走吧\\"，然后\\n笑了 \\\\o/"}';
    assert.equal(decodeAll([raw]).text, JSON.parse(raw).reply);
  });

  it("半截转义跨增量：落单反斜杠与半个 \\uXXXX 都不漏字", () => {
    assert.equal(decodeAll(['{"reply": "换行\\', 'n好了"}']).text, "换行\n好了");
    assert.equal(decodeAll(['{"reply": "字\\u4f', '60你好"}']).text, "字你你好");
    // 非法 \u 序列按字面量吐出，不能吞掉后续正文。
    assert.equal(decodeAll(['{"reply": "x\\u12zz尾"}']).text, "x\\u12zz尾");
  });

  it("收尾引号之后的内容一律忽略（信封可能还带别的字段）", () => {
    const result = decodeAll(['{"reply": "你好", "emotion": "happy"}']);
    assert.equal(result.text, "你好");
  });

  it("只在信封头匹配：别的字段在前 → 不流式（交给整段 unwrap 挑键）", () => {
    // 多字段信封里"第一个键"和 unwrap 的优先级挑键可能不是同一个，
    // 流式只在信封头明确时才认——否则宁可不流，也不冒分叉的风险。
    const result = decodeAll(['{"emotion":"happy","reply":"来了。"}']);
    assert.equal(result.text, "");
    assert.equal(result.completed, false);
  });

  it("信封头过久认不出 → unrecognized（这时才放弃流式）", () => {
    const result = decodeAll([`{"emotion":"happy","note":"${"x".repeat(600)}`]);
    assert.equal(result.unrecognized, true);
    assert.equal(result.text, "");
  });

  it("多行信封（pretty-print）同样能识别信封头", () => {
    const result = decodeAll(['{\n    "reply": "来了。"\n}']);
    assert.equal(result.text, "来了。");
    assert.equal(result.completed, true);
  });

  it("text() 给出完整解码正文（识别失败为空串）", () => {
    const decoder = createCompanionEnvelopeDecoder();
    decoder.push('{"reply": "你');
    decoder.push("好。\"}");
    assert.equal(decoder.text(), "你好。");
    const lost = createCompanionEnvelopeDecoder();
    lost.push('{"unexpected": "x"}');
    assert.equal(lost.text(), "");
  });

  it("形状不认识 → unrecognized（调用方退回整段兜底）", () => {
    const result = decodeAll([`{"blocks": [${"x".repeat(600)}`]);
    assert.equal(result.unrecognized, true);
    assert.equal(result.text, "");
  });

  it("识别完成后继续喂增量不再输出任何东西", () => {
    const decoder = createCompanionEnvelopeDecoder();
    assert.deepEqual(
      decoder.push('{"reply": "好。"}').map((chunk) => chunk.kind),
      ["text", "completed"],
    );
    assert.deepEqual(decoder.push("残留"), []);
  });
});
