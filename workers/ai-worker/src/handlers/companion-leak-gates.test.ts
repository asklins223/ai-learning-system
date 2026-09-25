/**
 * 闸身份表的两条自证（39d #28 第一步）：
 *  ① 每一道的 `judge` 必须是那个模块**真导出的函数**——这条当场抓到 39b §10.1 写的
 *     `looksLikeTruncatedReply` 在代码里其实叫 `looksTruncatedReply`（表与代码对不上号，
 *     正是这张表要防的那件事）；
 *  ② 版本必须由表派生：改名／翻处置／少一道闸都要动它，同表重算要稳定。
 *     "没人 bump 的版本比没有版本更坏"这条判据，只能这样证。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { COMPANION_LEAK_GATES_V1, COMPANION_LEAK_GATE_IDS_V1, companionLeakGateVersionV1 } from "@ailearn/shared/companion-leak-gates";

/** 代号 → worker 里的真文件。shared 那张表只写代号，路径住在这里。 */
const MODULE_FILES: Record<string, string> = {
  "companion-dialogue-content": "./companion-dialogue-content.ts",
  "companion-thought": "./companion-thought.ts",
};

test("每一道闸的判据都是那个模块真导出的函数", async () => {
  assert.equal(COMPANION_LEAK_GATES_V1.length, 11, "今天这份表是 11 道；加减一道要连着台子那份一起改");
  assert.equal(new Set(COMPANION_LEAK_GATE_IDS_V1).size, COMPANION_LEAK_GATE_IDS_V1.length, "号不许重复");
  const modules = new Map<string, Record<string, unknown>>();
  for (const gate of COMPANION_LEAK_GATES_V1) {
    const file = MODULE_FILES[gate.judgeModule];
    assert.ok(file, `${gate.id} 的模块代号 ${gate.judgeModule} 没有映射到真文件`);
    let mod = modules.get(file);
    if (!mod) {
      mod = (await import(file)) as Record<string, unknown>;
      modules.set(file, mod);
    }
    assert.equal(typeof mod[gate.judge], "function",
      `${gate.id} 的判据 ${gate.judge} 在 ${file} 里不是导出的函数`);
    assert.ok(gate.scope.length >= 4 && gate.because.length >= 4, `${gate.id} 要说清管什么、为什么是这个处置`);
    assert.ok(["keep", "delete", "conditional"].includes(gate.disposition), `${gate.id} 的处置不在枚举里`);
  }
});

test("版本由表派生：改任何一行都动它，同表重算稳定", () => {
  const base = companionLeakGateVersionV1();
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(companionLeakGateVersionV1(), base, "同一份表两次算出来必须一样（否则历史行没法归因）");
  const renamed = COMPANION_LEAK_GATES_V1.map((gate) =>
    gate.id === "G5" ? { ...gate, judge: "looksLikeTruncatedReply" } : gate);
  assert.notEqual(companionLeakGateVersionV1(renamed), base, "判据改名不动版本 ⇒ 这列就是假归因");
  const flipped = COMPANION_LEAK_GATES_V1.map((gate) =>
    gate.id === "G1" ? { ...gate, disposition: "keep" as const } : gate);
  assert.notEqual(companionLeakGateVersionV1(flipped), base, "处置翻了也不动版本 ⇒ 同上");
  assert.notEqual(companionLeakGateVersionV1(COMPANION_LEAK_GATES_V1.slice(0, 10)), base, "删一道闸必须反映到版本上");
});
