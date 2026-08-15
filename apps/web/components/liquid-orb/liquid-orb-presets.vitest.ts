/**
 * Liquid Orb preset 纯逻辑测试（vitest）。
 * 覆盖：uniform 布局（含 WGSL vec4 对齐 padding）、主题色 ramp、
 * 语音分态映射、intensity 对 speed 的缩放。
 */
import { describe, it, expect } from "vitest";
import {
  buildOrbUniformValues,
  buildOrbThemeColors,
  hexToRgb01,
  mixRgb01,
  ORB_PRESET_STYLE,
  ORB_UNIFORM_FLOATS,
  PET_VOICE_ORB_VISUALS,
  TEACHBACK_ORB_VISUALS,
  type OrbThemeColorsV1,
} from "./liquid-orb-presets";

const TEST_COLORS: OrbThemeColorsV1 = {
  deep: [0.1, 0.2, 0.3],
  base: [0.4, 0.5, 0.6],
  light: [0.7, 0.8, 0.9],
  pale: [0.9, 0.95, 1],
  highlight: [1, 1, 1],
  shellInner: [0.95, 0.96, 0.97],
  shellMid: [1, 1, 1],
  shellEdge: [0.98, 0.99, 1],
  sheen: [0.85, 0.9, 0.95],
  spec: [0.95, 0.97, 0.99],
  canvas: [1, 0.99, 0.97],
  glow: [0.6, 0.7, 0.8],
  paletteStops: [],
};

/** Float32 存储有精度损失，逐元素 toBeCloseTo（actual 为 RGBA，只比较前 RGB）。 */
function expectFloats(actual: ArrayLike<number>, expected: readonly number[]): void {
  const values = Array.from(actual).slice(0, expected.length);
  expect(values.length).toBe(expected.length);
  expected.forEach((value, index) => {
    expect(values[index]).toBeCloseTo(value, 5);
  });
}

describe("hexToRgb01 / mixRgb01", () => {
  it("解析 6 位与 3 位 hex，非法值回退", () => {
    expect(hexToRgb01("#168C9A")).toEqual([0x16 / 255, 0x8c / 255, 0x9a / 255]);
    expect(hexToRgb01("#ABC")).toEqual([0xaa / 255, 0xbb / 255, 0xcc / 255]);
    expect(hexToRgb01("not-a-color", [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("mix 线性插值并夹在 0..1", () => {
    expect(mixRgb01([0, 0, 0], [1, 1, 1], 0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(mixRgb01([0, 0, 0], [1, 1, 1], 2)).toEqual([1, 1, 1]);
  });
});

describe("buildOrbThemeColors", () => {
  it("四档 ramp 由深到浅，canvas 独立传入", () => {
    const colors = buildOrbThemeColors([0.09, 0.55, 0.6], [1, 0.99, 0.97]);
    expect(colors.deep[0]).toBeLessThan(colors.base[0]);
    expect(colors.base[0]).toBeLessThan(colors.light[0]);
    expect(colors.light[0]).toBeLessThan(colors.pale[0]);
    expect(colors.highlight).toEqual([1, 1, 1]);
    expect(colors.canvas).toEqual([1, 0.99, 0.97]);
    expect(colors.paletteStops).toEqual([]);
  });
});

describe("buildOrbUniformValues（WGSL 布局）", () => {
  it("恒为 120 floats，标量/颜色落在预期偏移", () => {
    const values = buildOrbUniformValues({
      size: { width: 320, height: 240 },
      style: ORB_PRESET_STYLE.siri,
      intensity: 1,
      colors: TEST_COLORS,
    });
    expect(values.length).toBe(ORB_UNIFORM_FLOATS);

    // size / time / 标量
    expect(values[0]).toBe(320);
    expect(values[1]).toBe(240);
    expect(values[2]).toBe(0);
    expect(values[15]).toBe(9); // style == siri
    expect(values[19]).toBe(1); // glassEnabled

    // vec4 对齐 padding（22–23 必须为零，颜色从 24 开始）
    expect(values[22]).toBe(0);
    expect(values[23]).toBe(0);
    expectFloats(values.slice(24, 28), TEST_COLORS.deep);
    expectFloats(values.slice(28, 32), TEST_COLORS.base);
    expectFloats(values.slice(36, 40), TEST_COLORS.pale);
    expectFloats(values.slice(64, 68), TEST_COLORS.canvas);
    expectFloats(values.slice(68, 72), TEST_COLORS.glow);
    // 12 个 palette stop
    expectFloats(values.slice(72, 76), [1, 1, 1, 1]);
    expectFloats(values.slice(116, 120), [1, 1, 1, 1]);
  });

  it("intensity 只缩放 speed，radius 可覆盖", () => {
    const full = buildOrbUniformValues({
      size: { width: 10, height: 10 },
      style: ORB_PRESET_STYLE.siri,
      intensity: 1,
      colors: TEST_COLORS,
    });
    const calm = buildOrbUniformValues({
      size: { width: 10, height: 10 },
      style: ORB_PRESET_STYLE.siri,
      intensity: 0.5,
      radius: 0.6,
      colors: TEST_COLORS,
    });
    expect(calm[3]).toBeCloseTo(full[3] * 0.5, 5);
    expect(calm[4]).toBeCloseTo(0.6, 5);
    // 除 speed/radius 外其余字段一致
    expect(calm[15]).toBe(full[15]);
    expect(calm[19]).toBe(full[19]);
  });
});

describe("语音分态映射", () => {
  it("桌宠语音岛：聆听 Siri 青 / 处理频谱琥珀 / 播报声膜绿", () => {
    expect(PET_VOICE_ORB_VISUALS.listening).toEqual({ preset: "siri", tone: "running", intensity: 1 });
    expect(PET_VOICE_ORB_VISUALS.transcribing).toEqual({ preset: "spectrum", tone: "warning", intensity: 1 });
    expect(PET_VOICE_ORB_VISUALS.speaking).toEqual({ preset: "voice", tone: "action", intensity: 1 });
    expect(PET_VOICE_ORB_VISUALS.requesting_permission.intensity).toBeLessThan(1);
  });

  it("学习运行语音题：待命低幅蓝滴 / 录音 Siri / 转写频谱", () => {
    expect(TEACHBACK_ORB_VISUALS.idle).toEqual({ preset: "drop", tone: "running", intensity: 0.5 });
    expect(TEACHBACK_ORB_VISUALS.recording).toEqual({ preset: "siri", tone: "running", intensity: 1 });
    expect(TEACHBACK_ORB_VISUALS.transcribing).toEqual({ preset: "spectrum", tone: "warning", intensity: 1 });
  });

  it("所有 preset 都有对应 shader style", () => {
    expect(Object.values(ORB_PRESET_STYLE)).toEqual(expect.arrayContaining([9, 14, 19, 20, 15]));
  });
});
