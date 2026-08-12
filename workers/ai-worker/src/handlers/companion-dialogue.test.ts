import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPANION_PERSONA_V1,
  COMPANION_PERSONA_V1_PROMPT_ID,
  canonicalJsonV1,
} from "@ailearn/shared";
import {
  buildCompanionPersonaMessages,
  buildFinalCuePayload,
  chunkTextIntoDeltas,
  COMPANION_HARD_MAX_CHARS,
  ERROR_CUE_PAYLOAD_V1,
  THINKING_CUE_PAYLOAD_V1,
  validateCompanionOutput,
  textOfCompanionBlocks,
} from "./companion-dialogue.ts";

test("persona messages：system 固定 prompt + 结构化 user content", () => {
  const messages = buildCompanionPersonaMessages({
    userText: "你好",
    recentMessages: [{ role: "user", text: "昨天学了光合作用" }],
    pageContext: { pageKind: "today" },
    workspacePolicy: { sendToExternal: false, piiDetection: true },
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, COMPANION_PERSONA_V1);
  assert.equal(messages[1].role, "user");
  const parsed = JSON.parse(messages[1].content as string);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.currentMessage, "你好");
  assert.equal(parsed.workspacePolicy.sendToExternal, false);
  assert.equal(parsed.pageContext, canonicalJsonV1({ pageKind: "today" }));
  assert.equal(parsed.recentMessages.length, 1);
});

test("grounded tutor：只把受限证据放入 provider 输入", () => {
  const messages = buildCompanionPersonaMessages({
    userText: "这个结论为什么成立？",
    recentMessages: [],
    pageContext: { pageKind: "learning_session", sessionId: "internal-only" },
    workspacePolicy: { sendToExternal: false, piiDetection: true },
    groundedTutorContext: {
      claim: "光合作用把光能转成化学能。",
      evidence: ["叶绿体中的色素吸收光能。"],
    },
  });
  assert.match(String(messages[0].content), /Grounded Tutor/);
  const parsed = JSON.parse(messages[1].content as string);
  assert.equal(parsed.pageContext, null);
  assert.deepEqual(parsed.groundedTarget, {
    claim: "光合作用把光能转成化学能。",
    evidence: ["叶绿体中的色素吸收光能。"],
  });
});

test("persona 输入边界：recent ≤20 条、12k/2k/4k 截断", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    role: "user" as const,
    text: `m${i}`,
  }));
  const messages = buildCompanionPersonaMessages({
    userText: "x".repeat(5_000),
    recentMessages: many,
    pageContext: { big: "y".repeat(3_000) },
    workspacePolicy: null,
  });
  const parsed = JSON.parse(messages[1].content as string);
  assert.equal(parsed.recentMessages.length, 20);
  assert.equal(parsed.currentMessage.length, 4_000);
  assert.ok(parsed.pageContext.length <= 2_000);
  assert.equal(parsed.workspacePolicy.sendToExternal, false, "null policy 回退默认投影");
});

test("chunkTextIntoDeltas：每块 ≤2000、appendFrom 单调、拼接还原", () => {
  const text = "a".repeat(4_500);
  const deltas = chunkTextIntoDeltas(text);
  assert.equal(deltas.length, 3);
  for (const d of deltas) {
    assert.ok(d.textDelta.length >= 1 && d.textDelta.length <= 2_000);
  }
  assert.equal(deltas[0].appendFrom, 0);
  assert.equal(deltas[1].appendFrom, 2_000);
  assert.equal(deltas[2].appendFrom, 4_000);
  const joined = deltas.map((d) => d.textDelta).join("");
  assert.equal(joined, text);
});

test("chunkTextIntoDeltas：空文本 → 零 delta（final 直接 textLength=0）", () => {
  assert.deepEqual(chunkTextIntoDeltas(""), []);
});

test("validateCompanionOutput：正常通过 + trim", () => {
  const r = validateCompanionOutput("  好的，我们继续。  ");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "好的，我们继续。");
});

test("validateCompanionOutput：空/超长/内部 token 泄露拒绝", () => {
  assert.equal(validateCompanionOutput("   ").ok, false);
  assert.equal(validateCompanionOutput("x".repeat(COMPANION_HARD_MAX_CHARS + 1)).ok, false);
  assert.equal(validateCompanionOutput('{"cue": "wave"}').ok, false);
  assert.equal(validateCompanionOutput("reason id: xyz").ok, false);
  assert.equal(validateCompanionOutput("companion-persona-v1 泄露").ok, false);
});

test("textOfCompanionBlocks：只取 text block", () => {
  assert.equal(textOfCompanionBlocks([{ type: "text", text: "hi" }, { type: "image" }]), "hi");
  assert.equal(textOfCompanionBlocks("not-array"), "");
});

test("buildFinalCuePayload：happy 回复产出 explain/happy + clamp 强度", () => {
  const cue = buildFinalCuePayload("恭喜你！这次复习通过啦～");
  assert.equal(cue.intent, "explain");
  assert.equal(cue.emotion, "happy");
  assert.ok(cue.intensity > 0.3 && cue.intensity <= 0.9);
  assert.equal(cue.version, 1);
});

test("buildFinalCuePayload：中性回复回落 explain/neutral/0.30", () => {
  assert.deepEqual(
    buildFinalCuePayload("今天的安排就是这样。"),
    { version: 1, intent: "explain", emotion: "neutral", intensity: 0.3 },
  );
});

test("buildFinalCuePayload：确定性常量（thinking/error）不被误改", () => {
  assert.deepEqual(THINKING_CUE_PAYLOAD_V1, { version: 1, intent: "think", emotion: "curious", intensity: 0.35 });
  assert.deepEqual(ERROR_CUE_PAYLOAD_V1, { version: 1, intent: "uncertain", emotion: "concerned", intensity: 0.45 });
});

test("prompt id 常量与 shared 一致", () => {
  assert.equal(COMPANION_PERSONA_V1_PROMPT_ID, "companion-persona-v1");
});
