/**
 * 任务 14 接线：确定性 silent Scene 生成器单测（silent-scene-author）。
 *
 * 锁定：
 * - 从 claim 拆出 ≥2 语义片段 → ordering items + repair 变式（真实可达，
 *   不再 fail-closed 挡着）；
 * - 确定性：同输入同输出（shuffleStrategy / ids / 操作白名单稳定）；
 * - claim 不足（<2 片段）→ null（调用方回退 text，不伪造场景）；
 * - 片段数量上限（防超长 claim 生成超大场景）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSilentSceneData,
  splitClaimIntoFragments,
} from "./silent-scene-author.ts";

describe("splitClaimIntoFragments：claim → 语义片段", () => {
  it("按句号/分号拆句，过滤空段", () => {
    const parts = splitClaimIntoFragments("第一步做 A。第二步做 B；第三步做 C。");
    assert.deepEqual(parts, ["第一步做 A", "第二步做 B", "第三步做 C"]);
  });

  it("空/过短片段被过滤", () => {
    const parts = splitClaimIntoFragments("。A；很短的片段不达标。");
    assert.deepEqual(parts, ["很短的片段不达标"]);
  });

  it("超过上限时截断（防超长 claim）", () => {
    const parts = splitClaimIntoFragments(
      Array.from({ length: 12 }, (_, i) => `步骤 ${i + 1} 的内容片段`).join("。"),
    );
    assert.ok(parts.length <= 6);
  });
});

describe("buildSilentSceneData：ordering + repair 确定性生成", () => {
  it("≥2 片段 → 生成 ordering（items/emptySlots/dragProtocol）", () => {
    const scene = buildSilentSceneData(
      "kp-1",
      "先收集材料。再整理结构。最后检查结果。",
      "fingerprint-a",
    );
    assert.ok(scene !== null);
    assert.equal(scene.ordering.items.length, 3);
    assert.equal(scene.ordering.emptySlots, 3);
    assert.equal(scene.ordering.dragProtocol, "tap-select-place");
    assert.equal(scene.ordering.shuffleStrategy, "deterministic-fragment-order");
    assert.ok(scene.ordering.items.every((item) => item.id.startsWith("step-")));
  });

  it("repair 变式：brokenTokens = 非首片段子集，操作白名单稳定", () => {
    const scene = buildSilentSceneData(
      "kp-1",
      "先收集材料。再整理结构。最后检查结果。补充校验。",
      "fingerprint-a",
    );
    assert.ok(scene !== null);
    assert.equal(scene.repair.brokenTokens.length, 3);
    assert.deepEqual(scene.repair.allowedOperations, ["delete", "replace", "move"]);
    assert.equal(scene.repair.operationProtocol, "tap-select-place");
  });

  it("确定性：同输入两次生成结果一致", () => {
    const a = buildSilentSceneData("kp-1", "第一步 A。第二步 B。第三步 C。", "fp");
    const b = buildSilentSceneData("kp-1", "第一步 A。第二步 B。第三步 C。", "fp");
    assert.deepEqual(a, b);
  });

  it("claim 不足 2 片段 → null（调用方回退 text，不伪造场景）", () => {
    const scene = buildSilentSceneData("kp-1", "只有一个片段。", "fp");
    assert.equal(scene, null);
  });
});
