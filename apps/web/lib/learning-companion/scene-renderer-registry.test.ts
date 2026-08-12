/**
 * 任务 14 阶段 B：Scene renderer registry + SilentProofScene 单测
 * （14-...-multimodal-reconstruction §3.2 / 附录 A / §4 阶段 B）。
 *
 * 锁定：
 * - registry 按 scene.kind 分发；未注册 kind → null（fail closed，不伪装）；
 * - REGISTERED_SCENE_KINDS 覆盖三个 family 六个 Scene + voice_teachback；
 * - ordering/repair/relation_canvas → TapSelectPlaceLayer 适配结构正确
 *   （objects/actions/targets 映射、required 语义）；
 * - 非 tap-select 类（multi_step/counterexample/optional_text）→ fail closed
 *   占位渲染（不伪装成可验证），由后续纵切承接；
 * - 无中途反馈语义：组件不调用评估端点，只经 onComplete 提交。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SceneType } from "@ailearn/shared";
import {
  REGISTERED_SCENE_KINDS,
  isSceneKindRenderable,
  sceneRendererFor,
} from "@/components/learning-companion/scene-renderer-registry";
import {
  adaptOrderingToTapSelect,
  adaptRelationCanvasToTapSelect,
  adaptRepairToTapSelect,
} from "@/components/learning-companion/scenes/SilentProofScene";

describe("scene-renderer-registry：按 scene.kind 分发（§3.2）", () => {
  it("三个 family 六个 Scene + voice_teachback 全部注册", () => {
    for (const kind of [
      SceneType.ORDERING,
      SceneType.REPAIR,
      SceneType.RELATION_CANVAS,
      SceneType.MULTI_STEP_SCENARIO,
      SceneType.COUNTEREXAMPLE,
      SceneType.OPTIONAL_TEXT,
      SceneType.VOICE_TEACHBACK,
    ]) {
      assert.equal(isSceneKindRenderable(kind), true, `expected ${kind} registered`);
      assert.notEqual(sceneRendererFor(kind), null, `expected renderer for ${kind}`);
    }
  });

  it("未注册/未知 kind → null（fail closed，不把未支持组合伪装成可验证）", () => {
    assert.equal(isSceneKindRenderable("unknown_scene"), false);
    assert.equal(sceneRendererFor("unknown_scene"), null);
    assert.equal(sceneRendererFor(""), null);
    assert.equal(sceneRendererFor("game_minigame"), null);
  });

  it("REGISTERED_SCENE_KINDS 与注册 renderer 一一对应", () => {
    for (const kind of REGISTERED_SCENE_KINDS) {
      assert.notEqual(sceneRendererFor(kind), null);
    }
  });
});

describe("SilentProofScene：ordering 适配（procedure family）", () => {
  it("items → objects（place_to_slot 动作），emptySlots → targets", () => {
    const scene = adaptOrderingToTapSelect({
      items: [
        { id: "a", text: "第一步" },
        { id: "b", text: "第二步" },
        { id: "c", text: "第三步" },
      ],
      shuffleStrategy: "deterministic",
      emptySlots: 3,
      dragProtocol: "tap-select-place",
    });
    assert.equal(scene.objects.length, 3);
    assert.deepEqual(scene.objects.map((o) => o.id), ["a", "b", "c"]);
    assert.ok(scene.objects.every((o) => o.actions.includes("place_to_slot")));
    assert.equal(scene.actions.length, 1);
    assert.equal(scene.actions[0].id, "place_to_slot");
    assert.equal(scene.targets.length, 3);
    assert.deepEqual(scene.targets.map((t) => t.id), ["slot-1", "slot-2", "slot-3"]);
  });

  it("emptySlots 缺失时兜底 = items 数量（不产生空目标）", () => {
    const scene = adaptOrderingToTapSelect({
      items: [{ id: "a", text: "x" }, { id: "b", text: "y" }],
      shuffleStrategy: "deterministic",
      emptySlots: 0,
      dragProtocol: "tap-select-place",
    });
    assert.equal(scene.targets.length, 2);
  });
});

describe("SilentProofScene：repair 适配（procedure family）", () => {
  it("brokenTokens → objects，allowedOperations → actions", () => {
    const scene = adaptRepairToTapSelect({
      brokenTokens: [
        { id: "t1", text: "步骤 A" },
        { id: "t2", text: "步骤 B" },
      ],
      operationProtocol: "tap-select-place",
      allowedOperations: ["delete", "replace", "move"],
    });
    assert.equal(scene.objects.length, 2);
    assert.deepEqual(scene.actions.map((a) => a.id), ["delete", "replace", "move"]);
    assert.ok(scene.objects.every((o) => o.actions.length === 3));
    assert.equal(scene.targets.length, 2);
  });
});

describe("SilentProofScene：relation_canvas 适配（causal-boundary family）", () => {
  it("nodes → objects（edgeTypes 动作），目标 = 节点", () => {
    const scene = adaptRelationCanvasToTapSelect({
      nodes: [
        { id: "n1", text: "原因" },
        { id: "n2", text: "结果" },
      ],
      edgeTypes: ["导致", "前置"],
      canvasProtocol: "tap-select-place",
      maxEdges: 2,
    });
    assert.equal(scene.objects.length, 2);
    assert.deepEqual(scene.actions.map((a) => a.id), ["导致", "前置"]);
    assert.equal(scene.targets.length, 2);
    assert.deepEqual(scene.targets.map((t) => t.id), ["n1", "n2"]);
  });
});
