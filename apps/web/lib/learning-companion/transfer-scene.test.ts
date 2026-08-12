/**
 * 任务 14 阶段 C：TransferScene 单测（14 方案 §3.1 transfer 行 / §4 阶段 C / 06-6）。
 *
 * 锁定：
 * - 三种形态标签正确（情境应用/故障修复/边界变式）；
 * - repair 形态复用 TapSelectPlaceLayer 适配（allowedOperations 动作）；
 * - situated_application + multi_step_scenario → 多步决策渲染；
 * - 不支持的组合 → fail closed 占位（不伪装成可验证）；
 * - record_only 明示：UI 明确「本次未改变复习时间」；
 * - 无中途反馈、无计时评分（源码契约）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { transferFormLabel } from "@/components/learning-companion/scenes/TransferScene";
import { adaptRepairToTapSelect } from "@/components/learning-companion/scenes/SilentProofScene";

const source = readFileSync(
  new URL("../../components/learning-companion/scenes/TransferScene.tsx", import.meta.url),
  "utf8",
);

describe("TransferScene：三种形态标签（06-6）", () => {
  it("situated_application / repair / boundary_variant 标签正确", () => {
    assert.equal(transferFormLabel("situated_application"), "情境应用");
    assert.equal(transferFormLabel("repair"), "故障修复");
    assert.equal(transferFormLabel("boundary_variant"), "边界变式");
  });
});

describe("TransferScene：repair 形态复用 TapSelectPlaceLayer（06-6 故障修复）", () => {
  it("brokenTokens → objects，allowedOperations → actions", () => {
    const scene = adaptRepairToTapSelect({
      brokenTokens: [{ id: "t1", text: "错误步骤" }, { id: "t2", text: "正确步骤" }],
      operationProtocol: "tap-select-place",
      allowedOperations: ["delete", "replace", "move"],
    });
    assert.equal(scene.objects.length, 2);
    assert.deepEqual(scene.actions.map((a) => a.id), ["delete", "replace", "move"]);
    assert.equal(scene.targets.length, 2);
  });
});

describe("TransferScene：record_only 与 fail-closed 语义（06-6）", () => {
  it("UI 明示「本次未改变复习时间」（record_only 不消费 schedule）", () => {
    assert.match(source, /本次未改变复习时间（record_only）/);
  });

  it("不支持组合 → fail closed 占位（不伪装成可验证）", () => {
    assert.match(source, /data-testid="transfer-unavailable"/);
    assert.match(source, /这类情境题暂未开放，请换用文字或语音回答/);
  });

  it("无中途反馈：完成前不揭示对错", () => {
    assert.match(source, /完成前不揭示对错/);
  });

  it("无倒计时、无速度评分（不出现计时/评分机制）", () => {
    assert.doesNotMatch(source, /setInterval\(|setTimeout\(.*倒计时|speedScore|startTimer/);
  });

  it("多步决策逐步提交（无中途反馈），完成后经 onSubmit 交宿主", () => {
    assert.match(source, /const choose = \(optionId: string\) =>/);
    assert.match(source, /onSubmit\(nextChoices\)/);
    assert.doesNotMatch(source, /api\.submit|learningSessionClient/);
  });
});
