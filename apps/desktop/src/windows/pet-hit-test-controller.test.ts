import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PetHitTestController,
  contentPointFromScreenPoint,
  pointHitsGeometry,
} from "./pet-hit-test-controller";
import type { PetHitGeometryV1 } from "@ailearn/shared";

const geometry: PetHitGeometryV1 = {
  version: 1,
  revision: 2,
  contentWidth: 560,
  contentHeight: 520,
  petScale: 1,
  regions: [
    { id: "bubble", kind: "rect", rect: { x: 16, y: 24, width: 280, height: 120 } },
    { id: "character", kind: "polygon", rect: { x: 300, y: 100, width: 200, height: 200 }, polygon: [
      { x: 300, y: 100 }, { x: 500, y: 100 }, { x: 400, y: 300 },
    ] },
  ],
};

test("screen coordinates are converted from DIP bounds without scale-factor math", () => {
  assert.deepEqual(contentPointFromScreenPoint({ x: 1200, y: 800 }, { x: 1000, y: 600, width: 560, height: 520 }), { x: 200, y: 200 });
  assert.equal(pointHitsGeometry({ x: 20, y: 30 }, geometry), true);
  assert.equal(pointHitsGeometry({ x: 310, y: 110 }, geometry), true);
  assert.equal(pointHitsGeometry({ x: 490, y: 290 }, geometry), false);
  assert.equal(pointHitsGeometry({ x: 0, y: 0 }, geometry), false);
});

test("alpha mask uses a bounded, hashed bitset", () => {
  const bits = Buffer.from([0b10000000]);
  const masked: PetHitGeometryV1 = {
    ...geometry,
    regions: [{
      id: "character",
      kind: "alpha_mask",
      rect: { x: 0, y: 0, width: 8, height: 1 },
      mask: { width: 8, height: 1, bitsBase64: bits.toString("base64"), sha256: createHash("sha256").update(bits).digest("hex") },
    }],
  };
  assert.equal(pointHitsGeometry({ x: 0.1, y: 0.5 }, masked), true);
  assert.equal(pointHitsGeometry({ x: 7.5, y: 0.5 }, masked), false);
});

test("controller switches click-through only when the cursor crosses a region", () => {
  const calls: Array<{ ignore: boolean; forward: boolean }> = [];
  const fakeWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    getContentBounds: () => ({ x: 1000, y: 600, width: 560, height: 520 }),
    setIgnoreMouseEvents: (ignore: boolean, options: { forward: boolean }) => calls.push({ ignore, forward: options.forward }),
  };
  let cursor = { x: 1001, y: 601 };
  const controller = new PetHitTestController(fakeWindow, () => cursor);
  controller.registerGeometry(geometry);
  controller.tick();
  cursor = { x: 1020, y: 630 };
  controller.tick();
  cursor = { x: 1400, y: 1000 };
  controller.tick();
  controller.setInteractionMode("text_input");
  assert.deepEqual(calls, [
    { ignore: true, forward: true },
    { ignore: false, forward: true },
    { ignore: true, forward: true },
    { ignore: false, forward: true },
  ]);
});

test("15a-D：passive 模式不强制立即翻转 setIgnoreMouseEvents（关闭输入面板不触发闪烁）", () => {
  const calls: Array<{ ignore: boolean; forward: boolean }> = [];
  const fakeWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    getContentBounds: () => ({ x: 1000, y: 600, width: 560, height: 520 }),
    setIgnoreMouseEvents: (ignore: boolean, options: { forward: boolean }) => calls.push({ ignore, forward: options.forward }),
  };
  let cursor = { x: 1020, y: 630 }; // 在 region 内 → ignore=false
  const controller = new PetHitTestController(fakeWindow, () => cursor);
  controller.registerGeometry(geometry);
  controller.tick();
  assert.deepEqual(calls, [{ ignore: false, forward: true }]);
  // 光标不动、切到 passive（模拟关闭输入面板）：旧实现会强制重算并在瞬间翻转
  // setIgnoreMouseEvents（窗口服务级路由重配 → transparent 窗口合成闪烁）。
  controller.setInteractionMode("passive");
  assert.equal(calls.length, 1, "passive 不强制重算，关闭面板瞬间不触发翻转");
  // 光标移到空白区：自然翻转仍发生（点击穿透功能不受影响）
  cursor = { x: 1400, y: 1000 };
  controller.tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { ignore: true, forward: true });
});

test("registerGeometry rejects regions outside content bounds (§9.1)", () => {
  const fakeWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    getContentBounds: () => ({ x: 0, y: 0, width: 560, height: 520 }),
    setIgnoreMouseEvents: () => undefined,
  };
  const controller = new PetHitTestController(fakeWindow, () => ({ x: 0, y: 0 }));

  // 合法的几何先注册成功
  controller.registerGeometry(geometry);
  assert.equal(controller.isClickThrough, false);

  // rect 越界（x+width > contentWidth）→ 整批拒绝，保留上一次有效几何
  const outOfBoundsRect: PetHitGeometryV1 = {
    ...geometry,
    revision: 3,
    regions: [{ id: "bubble", kind: "rect", rect: { x: 500, y: 0, width: 200, height: 100 } }],
  };
  controller.registerGeometry(outOfBoundsRect);
  // 被拒绝后几何仍是旧 revision（region 仍可命中）
  const current = (controller as unknown as { geometry: PetHitGeometryV1 | null }).geometry;
  assert.equal(current?.revision, 2, "越界几何被拒绝，保留上次有效几何");

  // polygon 顶点越界 → 同样拒绝
  const outOfBoundsPolygon: PetHitGeometryV1 = {
    ...geometry,
    revision: 4,
    regions: [{
      id: "character", kind: "polygon",
      rect: { x: 0, y: 0, width: 10, height: 10 },
      polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 0, y: 10 }],
    }],
  };
  controller.registerGeometry(outOfBoundsPolygon);
  assert.equal((controller as unknown as { geometry: PetHitGeometryV1 | null }).geometry?.revision, 2);
});
