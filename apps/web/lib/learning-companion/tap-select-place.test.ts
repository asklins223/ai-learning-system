/**
 * 任务 05-3：tap-select-place 状态机单测（§6.6 / §13.4）。
 * 覆盖：状态转移序列、非法转移拒绝、撤销、锁定、动作序列、键盘移动、
 * reduced-motion 友好（无计时/速度字段）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTapSelectPlaceState,
  isTapSelectPlaceComplete,
  tapSelectPlaceMoveFocus,
  tapSelectPlaceProgress,
  tapSelectPlaceReducer,
  tapSelectPlaceTargetCandidates,
  type TapSelectPlaceScene,
} from "./tap-select-place.ts";

function makeScene(): TapSelectPlaceScene {
  return {
    objects: [
      { id: "star", label: "恒星", x: 0, y: 0, w: 44, h: 44, actions: ["connect"] },
      { id: "planet", label: "行星", x: 220, y: 0, w: 44, h: 44, actions: ["connect"] },
    ],
    actions: [{ id: "connect", label: "连接" }],
    targets: [
      { id: "slot-1", label: "第一个位置", x: 0, y: 160, w: 44, h: 44 },
      { id: "slot-2", label: "第二个位置", x: 220, y: 160, w: 44, h: 44 },
    ],
  };
}

describe("状态转移序列（select object → choose action → select target）", () => {
  it("完整路径：begin → pick_object → pick_action → pick_target → done", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    assert.equal(s.phase, "select_object");
    assert.equal(s.focusId, "star");

    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    assert.equal(s.phase, "choose_action");
    assert.equal(s.selectedObjectId, "star");

    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    assert.equal(s.phase, "select_target");
    assert.equal(s.selectedActionId, "connect");

    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-1" }, scene);
    assert.equal(s.phase, "select_object"); // 还有 planet 未放置
    assert.equal(s.placements.length, 1);
    assert.deepEqual(s.placements[0], {
      objectId: "star",
      actionId: "connect",
      targetId: "slot-1",
    });

    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "planet" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-2" }, scene);
    assert.equal(s.phase, "done");
    assert.equal(s.placements.length, 2);
    assert.equal(isTapSelectPlaceComplete(s, scene), true);
  });

  it("非法转移 fail-closed：错误阶段操作被拒绝且状态不变", () => {
    const scene = makeScene();
    const s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    const rejected = tapSelectPlaceReducer(
      s,
      { type: "pick_action", actionId: "connect" },
      scene,
    );
    assert.equal(rejected.phase, "select_object");
    assert.ok(rejected.lastError !== null);
  });

  it("pick_object 拒绝已放置对象", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-1" }, scene);
    const rejected = tapSelectPlaceReducer(
      s,
      { type: "pick_object", objectId: "star" },
      scene,
    );
    assert.ok(rejected.lastError !== null);
    assert.equal(rejected.placements.length, 1);
  });

  it("pick_action 拒绝不属于对象的动作 / 不存在的对象", () => {
    const scene: TapSelectPlaceScene = {
      ...makeScene(),
      actions: [
        { id: "connect", label: "连接" },
        { id: "highlight", label: "高亮" },
      ],
    };
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    const rejected = tapSelectPlaceReducer(
      s,
      { type: "pick_action", actionId: "highlight" },
      scene,
    );
    assert.ok(rejected.lastError !== null);
    assert.equal(rejected.phase, "choose_action");

    const notFound = tapSelectPlaceReducer(
      s,
      { type: "pick_object", objectId: "ghost" },
      scene,
    );
    assert.ok(notFound.lastError !== null);
  });

  it("canPlace 返回 false 时 pick_target 被拒绝", () => {
    const scene: TapSelectPlaceScene = {
      ...makeScene(),
      canPlace: (objectId, _actionId, targetId) =>
        objectId !== "planet" || targetId !== "slot-1",
    };
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "planet" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    const rejected = tapSelectPlaceReducer(
      s,
      { type: "pick_target", targetId: "slot-1" },
      scene,
    );
    assert.ok(rejected.lastError !== null);
    assert.equal(rejected.placements.length, 0);
  });

  it("target 候选随 canPlace 过滤", () => {
    const scene: TapSelectPlaceScene = {
      ...makeScene(),
      canPlace: (_objectId, _actionId, targetId) => targetId === "slot-2",
    };
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    const candidates = tapSelectPlaceTargetCandidates(s, scene);
    assert.deepEqual(candidates.map((target) => target.id), ["slot-2"]);
  });
});

describe("撤销", () => {
  it("choose_action 阶段撤销回 select_object", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    assert.equal(s.phase, "choose_action");
    s = tapSelectPlaceReducer(s, { type: "undo" }, scene);
    assert.equal(s.phase, "select_object");
    assert.equal(s.selectedObjectId, null);
  });

  it("select_target 阶段撤销回 choose_action", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "undo" }, scene);
    assert.equal(s.phase, "choose_action");
    assert.equal(s.selectedObjectId, "star");
    assert.equal(s.selectedActionId, null);
  });

  it("完成后再撤销：移除最后一次放置并回到 select_target 重选目标", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-1" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "planet" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-2" }, scene);
    assert.equal(s.phase, "done");

    s = tapSelectPlaceReducer(s, { type: "undo" }, scene);
    assert.equal(s.phase, "select_target");
    assert.equal(s.selectedObjectId, "planet");
    assert.equal(s.selectedActionId, "connect");
    assert.equal(s.placements.length, 1);
    assert.equal(isTapSelectPlaceComplete(s, scene), false);
  });

  it("无可撤销操作时撤销报错", () => {
    const scene = makeScene();
    const s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    const rejected = tapSelectPlaceReducer(s, { type: "undo" }, scene);
    assert.ok(rejected.lastError !== null);
  });

  it("cancel 取消进行中的选择，保留已完成放置", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-1" }, scene);
    s = tapSelectPlaceReducer(s, { type: "cancel" }, scene);
    assert.equal(s.phase, "idle");
    assert.equal(s.placements.length, 1);
    assert.equal(s.selectedObjectId, null);
  });
});

describe("锁定", () => {
  it("未完成放置时 lock 被拒绝", () => {
    const scene = makeScene();
    const s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    const rejected = tapSelectPlaceReducer(s, { type: "lock" }, scene);
    assert.ok(rejected.lastError !== null);
    assert.equal(rejected.locked, false);
  });

  it("全部完成后 lock 成功，锁定后一切变更被拒绝", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-1" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "planet" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-2" }, scene);
    s = tapSelectPlaceReducer(s, { type: "lock" }, scene);
    assert.equal(s.locked, true);
    assert.equal(s.phase, "done");

    // 锁定后 pick / undo / begin / cancel / move_focus 全部拒绝
    for (const event of [
      { type: "pick_object" as const, objectId: "star" },
      { type: "undo" as const },
      { type: "begin" as const },
      { type: "cancel" as const },
      { type: "move_focus" as const, direction: "next" as const },
    ]) {
      const rejected = tapSelectPlaceReducer(s, event, scene);
      assert.ok(rejected.lastError !== null, `锁定后事件 ${event.type} 应被拒绝`);
      assert.equal(rejected.placements.length, 2);
    }
  });

  it("unlock 解锁后可继续操作", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-1" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "planet" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-2" }, scene);
    s = tapSelectPlaceReducer(s, { type: "lock" }, scene);
    assert.equal(s.locked, true);
    s = tapSelectPlaceReducer(s, { type: "unlock" }, scene);
    assert.equal(s.locked, false);
    s = tapSelectPlaceReducer(s, { type: "undo" }, scene);
    assert.equal(s.phase, "select_target");
  });

  it("场景无强制完成条件时允许随时锁定", () => {
    const scene: TapSelectPlaceScene = {
      ...makeScene(),
      requiredObjectIds: [],
    };
    const s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    const locked = tapSelectPlaceReducer(s, { type: "lock" }, scene);
    assert.equal(locked.locked, true);
  });
});

describe("动作序列与进度", () => {
  it("placements 保持放置顺序，进度正确", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    assert.deepEqual(tapSelectPlaceProgress(s, scene), { placedCount: 0, requiredCount: 2 });

    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "planet" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-2" }, scene);
    assert.deepEqual(tapSelectPlaceProgress(s, scene), { placedCount: 1, requiredCount: 2 });
    assert.deepEqual(s.placements.map((p) => p.objectId), ["planet"]);

    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-1" }, scene);
    assert.deepEqual(s.placements.map((p) => p.objectId), ["planet", "star"]);
    assert.deepEqual(tapSelectPlaceProgress(s, scene), { placedCount: 2, requiredCount: 2 });
  });
});

describe("键盘移动（§13.4 键盘等价路径）", () => {
  it("select_object 阶段 next/prev 循环移动", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    assert.equal(s.focusId, "star");
    s = tapSelectPlaceReducer(s, { type: "move_focus", direction: "next" }, scene);
    assert.equal(s.focusId, "planet");
    s = tapSelectPlaceReducer(s, { type: "move_focus", direction: "next" }, scene);
    assert.equal(s.focusId, "star"); // 循环
    s = tapSelectPlaceReducer(s, { type: "move_focus", direction: "prev" }, scene);
    assert.equal(s.focusId, "planet");
  });

  it("方向键按屏幕坐标找邻居（right 选择右侧对象）", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "move_focus", direction: "right" }, scene);
    assert.equal(s.focusId, "planet");
    s = tapSelectPlaceReducer(s, { type: "move_focus", direction: "left" }, scene);
    assert.equal(s.focusId, "star");
  });

  it("select_target 阶段在可放置目标间移动", () => {
    const scene = makeScene();
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    assert.equal(s.phase, "select_target");
    assert.equal(s.focusId, "slot-1");
    s = tapSelectPlaceReducer(s, { type: "move_focus", direction: "next" }, scene);
    assert.equal(s.focusId, "slot-2");
  });

  it("move_focus 无候选时返回 null / 拒绝", () => {
    const scene: TapSelectPlaceScene = {
      ...makeScene(),
      canPlace: () => false,
    };
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
    const id = tapSelectPlaceMoveFocus(s, scene, "next");
    assert.equal(id, null);
    const rejected = tapSelectPlaceReducer(s, { type: "move_focus", direction: "next" }, scene);
    assert.ok(rejected.lastError !== null);
  });

  it("无几何动作组按数组顺序循环", () => {
    const scene: TapSelectPlaceScene = {
      objects: [
        { id: "a", label: "A", x: 0, y: 0, w: 44, h: 44, actions: ["x", "y"] },
      ],
      actions: [
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
      ],
      targets: [{ id: "t", label: "T", x: 0, y: 100, w: 44, h: 44 }],
    };
    let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "a" }, scene);
    assert.equal(s.focusId, "x");
    s = tapSelectPlaceReducer(s, { type: "move_focus", direction: "down" }, scene);
    assert.equal(s.focusId, "y");
  });
});

describe("reduced-motion 友好（§13.4：无计时评分、无速度评分）", () => {
  it("状态机状态不含任何动画/计时/速度字段", () => {
    const scene = makeScene();
    const s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
    const keys = Object.keys(s);
    for (const forbidden of ["duration", "timer", "speed", "elapsed", "velocity", "animation"]) {
      assert.ok(
        !keys.some((key) => key.toLowerCase().includes(forbidden)),
        `状态不应包含 ${forbidden} 相关字段`,
      );
    }
  });

  it("同一输入序列永远产生相同结果（确定性，与运动无关）", () => {
    const scene = makeScene();
    const run = () => {
      let s = tapSelectPlaceReducer(createTapSelectPlaceState(), { type: "begin" }, scene);
      s = tapSelectPlaceReducer(s, { type: "pick_object", objectId: "star" }, scene);
      s = tapSelectPlaceReducer(s, { type: "pick_action", actionId: "connect" }, scene);
      return tapSelectPlaceReducer(s, { type: "pick_target", targetId: "slot-1" }, scene);
    };
    const first = run();
    const second = run();
    assert.deepEqual(first.placements, second.placements);
    assert.equal(first.phase, second.phase);
    assert.equal(first.lastError, second.lastError);
  });
});
