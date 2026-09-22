/**
 * 人格预设 seed 的自检（§2.1.1）。
 *
 * 这份常量是纯数据，但它要过两道会静默失败的关卡：
 *   1. 桌面端 main 进程用 `companionPersonaV1Schema` 整体 parse 人格接口响应
 *      （strict + 逐字段上限），一套预设写超标 = 整个「人格」页签读不出来，不是少一张卡；
 *   2. 预设文案进 prompt 前走 `sanitizePersonaField`，尖括号会被剥掉、换行压成空格——
 *      在里面写 `<persona_data>` 或 emoji 等于被静默删掉一截（协议层本来就禁 emoji）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { companionPersonaPresetV1Schema } from "./companion-memory-desktop-contracts.ts";
import { getPresetById, PET_PERSONA_PRESETS } from "./pet-persona-presets.ts";

/** 一套预设里所有会原样进 prompt / 进接口的用户可见文字。 */
function visibleText(presetId: string): string {
  const preset = getPresetById(presetId)!;
  return [
    preset.name,
    ...preset.personalityTags,
    preset.speakingStyle,
    ...preset.examples.map((example) => example.text),
    preset.boundaries.catchphrase ?? "",
  ].join("\n");
}

test("每套预设都过得了桌面端人格接口的 schema", () => {
  for (const preset of PET_PERSONA_PRESETS) {
    const parsed = companionPersonaPresetV1Schema.safeParse(preset);
    assert.equal(parsed.success, true, `预设 ${preset.presetId} 超出人格接口上限`);
  }
});

test("presetId 唯一，且都能按 id 查回来", () => {
  const ids = PET_PERSONA_PRESETS.map((preset) => preset.presetId);
  assert.equal(new Set(ids).size, ids.length, "presetId 重复会让 getPresetById 永远只命中前一个");
  for (const id of ids) assert.equal(getPresetById(id)?.presetId, id);
  assert.equal(getPresetById("not-a-preset"), null);
  assert.equal(getPresetById(undefined), null);
});

test("预设文字过得了人格净化：无尖括号、无 emoji", () => {
  for (const preset of PET_PERSONA_PRESETS) {
    const text = visibleText(preset.presetId);
    assert.match(text, /\S/, `${preset.presetId} 不能有空字段`);
    assert.doesNotMatch(text, /[<>]/, `${preset.presetId} 的尖括号会被净化剥掉`);
    assert.doesNotMatch(text, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${preset.presetId} 带 emoji`);
  }
});

test("爱吃白饭的大肥鱼：话多，但不催学习", () => {
  const fish = getPresetById("hungry-fish");
  assert.equal(fish?.name, "爱吃白饭的大肥鱼");
  assert.equal(fish?.activeness, "active", "吃白饭要靠多说话体现，安静档会把这个人格抹平");
  assert.equal(fish?.boundaries.allowNudgeLearning, false, "摸鱼的人格不催进度");
  assert.equal(typeof fish?.boundaries.catchphrase, "string", "口头禅是「我去吃饭了」");
  const otherPresetIds = PET_PERSONA_PRESETS
    .filter((preset) => preset.presetId !== "hungry-fish")
    .filter((preset) => preset.activeness === "active" && preset.boundaries.allowNudgeLearning === false)
    .map((preset) => preset.presetId);
  assert.deepEqual(otherPresetIds, [], "这套组合是它与其他活泼预设唯一的区别，被撞了要重新配平");
  assert.match(visibleText("hungry-fish"), /吃|饭/, "人格锚在干饭上");
});
