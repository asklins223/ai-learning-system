/**
 * Liquid Orb — preset 表、主题色 ramp 与 WebGPU uniform 布局。
 *
 * WGSL struct 按 uniform 地址空间对齐规则（f32 4 字节、vec2 8 字节、
 * vec4 16 字节对齐）展开为 120 个 float：
 *
 *   [size(2), time(1), 19 个标量(19), padding(2), 颜色(4×13)]
 *
 * 标量区间（index 2..21）与模板 struct 字段一一对应（speed…contourDeform）；
 * `contourDeform` 之后有 8 字节 padding，颜色从 float 24 开始。写错一位
 * 颜色就会整段错位（模板源码里 canvasColor 会读到深色背景即同款坑）。
 */

export type LiquidOrbPresetV1 = "siri" | "spectrum" | "voice" | "drop" | "frost";
export type LiquidOrbToneV1 = "running" | "warning" | "action";

export interface LiquidOrbVisualV1 {
  preset: LiquidOrbPresetV1;
  tone: LiquidOrbToneV1;
  /** 0..1 运动幅度：0.5 左右 = 待命低幅，1 = 全幅。乘到 speed 上。 */
  intensity: number;
}

export interface OrbUniformSourceV1 {
  /** 尺寸（device px），由组件每帧写入。 */
  size: { width: number; height: number };
  /** shader style 索引（glsPresetFluid 分支）。 */
  style: number;
  /** 0..1 运动幅度，乘到 preset speed 上（待命低幅、全幅）。 */
  intensity?: number;
  /** 球体半径覆盖（相对画布短边，默认取 preset 表）。 */
  radius?: number;
  /** 主题 token 解析出的 RGBA（0..1）。 */
  colors: OrbThemeColorsV1;
  exposure?: number;
  zoom?: number;
  warp?: number;
  ridgeAmt?: number;
  sharp?: number;
  shade?: number;
  sheen?: number;
  gloss?: number;
  shellMidAlpha?: number;
  shellEdgeAlpha?: number;
  edgeSoftness?: number;
  edgeGlow?: number;
  glassEnabled?: number;
  glassOpacity?: number;
  contourDeform?: number;
  paletteCount?: number;
}

export interface OrbThemeColorsV1 {
  /** colorA：深色底 */
  deep: RGB01;
  /** colorB：主色 */
  base: RGB01;
  /** colorC：浅色 */
  light: RGB01;
  /** colorD：近白 */
  pale: RGB01;
  highlight: RGB01;
  shellInner: RGB01;
  shellMid: RGB01;
  shellEdge: RGB01;
  sheen: RGB01;
  spec: RGB01;
  canvas: RGB01;
  glow: RGB01;
  /** 自定义 palette 停靠点（paletteCount > 0 时启用；本项目恒为 0）。 */
  paletteStops: RGB01[];
}

export type RGB01 = readonly [number, number, number];

export const ORB_UNIFORM_FLOATS = 120 as const;

/** 语音视觉 preset 的 shader style 索引（见 liquid-orb-shader.ts 顶部注释）。 */
export const ORB_PRESET_STYLE: Record<LiquidOrbPresetV1, number> = {
  siri: 9,
  spectrum: 14,
  voice: 19,
  drop: 20,
  frost: 15,
};

interface PresetScalarsV1 {
  speed: number;
  radius: number;
  zoom: number;
  warp: number;
  ridgeAmt: number;
  sharp: number;
  shade: number;
  sheen: number;
  gloss: number;
  shellMidAlpha: number;
  shellEdgeAlpha: number;
  exposure: number;
  edgeSoftness: number;
  edgeGlow: number;
  glassOpacity: number;
}

const PRESET_SCALARS: Record<LiquidOrbPresetV1, PresetScalarsV1> = {
  siri: {
    speed: 1.21, radius: 0.82, zoom: 0.36, warp: 3.4, ridgeAmt: 0.45,
    sharp: 2.2, shade: 0.12, sheen: 0.76, gloss: 1.06,
    shellMidAlpha: 0.44, shellEdgeAlpha: 0.39, exposure: 2,
    edgeSoftness: 0.05, edgeGlow: 0.26, glassOpacity: 0.42,
  },
  spectrum: {
    speed: 1.0, radius: 0.82, zoom: 0.4, warp: 0.8, ridgeAmt: 0.5,
    sharp: 2.0, shade: 0.1, sheen: 0.7, gloss: 0.9,
    shellMidAlpha: 0.4, shellEdgeAlpha: 0.35, exposure: 1.8,
    edgeSoftness: 0.05, edgeGlow: 0.3, glassOpacity: 0.42,
  },
  voice: {
    speed: 1.0, radius: 0.82, zoom: 0.3, warp: 1.6, ridgeAmt: 0.4,
    sharp: 1.8, shade: 0.1, sheen: 0.7, gloss: 0.9,
    shellMidAlpha: 0.42, shellEdgeAlpha: 0.36, exposure: 1.8,
    edgeSoftness: 0.05, edgeGlow: 0.28, glassOpacity: 0.4,
  },
  drop: {
    speed: 0.7, radius: 0.8, zoom: 0.3, warp: 1.4, ridgeAmt: 0.45,
    sharp: 1.6, shade: 0.15, sheen: 0.8, gloss: 1.0,
    shellMidAlpha: 0.42, shellEdgeAlpha: 0.36, exposure: 1.9,
    edgeSoftness: 0.05, edgeGlow: 0.3, glassOpacity: 0.45,
  },
  frost: {
    speed: 0.6, radius: 0.8, zoom: 0.3, warp: 1.2, ridgeAmt: 0.4,
    sharp: 1.5, shade: 0.1, sheen: 0.6, gloss: 0.8,
    shellMidAlpha: 0.4, shellEdgeAlpha: 0.34, exposure: 1.7,
    edgeSoftness: 0.05, edgeGlow: 0.24, glassOpacity: 0.4,
  },
};

const TONE_TOKENS: Record<LiquidOrbToneV1, string> = {
  running: "--color-running",
  warning: "--color-warning",
  action: "--color-action",
};

/** 球体与面板融合的背景 token（fs_main 的 fit 边缘渐变落点）。 */
const CANVAS_TOKEN = "--color-surface-raised";

export const ORB_DEFAULT_THEME_COLORS: OrbThemeColorsV1 = {
  deep: [0.09, 0.55, 0.6],
  base: [0.09, 0.55, 0.6],
  light: [0.55, 0.82, 0.84],
  pale: [0.85, 0.95, 0.95],
  highlight: [1, 1, 1],
  shellInner: [0.93, 0.99, 0.99],
  shellMid: [1, 1, 1],
  shellEdge: [0.97, 1, 1],
  sheen: [0.8, 0.95, 0.96],
  spec: [0.93, 0.98, 0.99],
  canvas: [1, 0.99, 0.97],
  glow: [0.6, 0.88, 0.9],
  paletteStops: [],
};

// ── 纯函数：颜色工具 ────────────────────────────────────────────────────────

/** "#168C9A" / "#ABC" / "rgb(...)" 之外的任意字符串 → 回退色。 */
export function hexToRgb01(hex: string, fallback: RGB01 = [0.09, 0.55, 0.6]): RGB01 {
  const clean = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const [r, g, b] = clean.split("").map((c) => parseInt(c + c, 16) / 255);
    return [r, g, b];
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    const value = parseInt(clean, 16);
    return [
      ((value >> 16) & 0xff) / 255,
      ((value >> 8) & 0xff) / 255,
      (value & 0xff) / 255,
    ];
  }
  return fallback;
}

export function mixRgb01(a: RGB01, b: RGB01, t: number): RGB01 {
  const k = Math.min(1, Math.max(0, t));
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

const WHITE: RGB01 = [1, 1, 1];
const BLACK: RGB01 = [0, 0, 0];

/**
 * 从主题 token 主色构建四档 ramp 与玻璃壳颜色（模板默认盘面同构：
 * 深 → 主 → 浅 → 近白，高光白，壳近白，canvas 取面板色）。
 */
export function buildOrbThemeColors(base: RGB01, canvas: RGB01): OrbThemeColorsV1 {
  return {
    deep: mixRgb01(base, BLACK, 0.62),
    base: mixRgb01(base, BLACK, 0.18),
    light: mixRgb01(base, WHITE, 0.42),
    pale: mixRgb01(base, WHITE, 0.74),
    highlight: WHITE,
    shellInner: mixRgb01(base, WHITE, 0.86),
    shellMid: WHITE,
    shellEdge: mixRgb01(base, WHITE, 0.8),
    sheen: mixRgb01(base, WHITE, 0.7),
    spec: mixRgb01(base, WHITE, 0.88),
    canvas,
    glow: mixRgb01(base, WHITE, 0.35),
    paletteStops: [],
  };
}

// ── Uniform 构建 ────────────────────────────────────────────────────────────

function writeRgba(values: Float32Array, index: number, color: RGB01): void {
  values[index] = color[0];
  values[index + 1] = color[1];
  values[index + 2] = color[2];
  values[index + 3] = 1;
}

/**
 * 按 WGSL struct 顺序构建 120-float uniform 缓冲。
 * `intensity` 只缩放 speed（保持动画节奏，不改变颜色/结构）。
 */
export function buildOrbUniformValues(source: OrbUniformSourceV1): Float32Array {
  const values = new Float32Array(ORB_UNIFORM_FLOATS);
  const scalars = PRESET_SCALARS[styleForPreset(source.style)] ?? PRESET_SCALARS.siri;

  values[0] = source.size.width;
  values[1] = source.size.height;
  values[2] = 0; // time，每帧写入
  values[3] = scalars.speed * clamp01(source.intensity ?? 1);
  values[4] = source.radius ?? scalars.radius;
  values[5] = source.zoom ?? scalars.zoom;
  values[6] = source.warp ?? scalars.warp;
  values[7] = source.ridgeAmt ?? scalars.ridgeAmt;
  values[8] = source.sharp ?? scalars.sharp;
  values[9] = source.shade ?? scalars.shade;
  values[10] = source.sheen ?? scalars.sheen;
  values[11] = source.gloss ?? scalars.gloss;
  values[12] = source.shellMidAlpha ?? scalars.shellMidAlpha;
  values[13] = source.shellEdgeAlpha ?? scalars.shellEdgeAlpha;
  values[14] = source.exposure ?? scalars.exposure;
  values[15] = source.style;
  values[16] = source.edgeSoftness ?? scalars.edgeSoftness;
  values[17] = source.edgeGlow ?? scalars.edgeGlow;
  values[18] = source.paletteCount ?? 0;
  values[19] = source.glassEnabled ?? 1;
  values[20] = source.glassOpacity ?? scalars.glassOpacity;
  values[21] = source.contourDeform ?? 0;
  // 22–23：WGSL vec4 16 字节对齐 padding，保持为零。

  const c = source.colors;
  writeRgba(values, 24, c.deep);
  writeRgba(values, 28, c.base);
  writeRgba(values, 32, c.light);
  writeRgba(values, 36, c.pale);
  writeRgba(values, 40, c.highlight);
  writeRgba(values, 44, c.shellInner);
  writeRgba(values, 48, c.shellMid);
  writeRgba(values, 52, c.shellEdge);
  writeRgba(values, 56, c.sheen);
  writeRgba(values, 60, c.spec);
  writeRgba(values, 64, c.canvas);
  writeRgba(values, 68, c.glow);
  for (let i = 0; i < 12; i += 1) {
    writeRgba(values, 72 + i * 4, c.paletteStops[i] ?? WHITE);
  }
  return values;
}

function styleForPreset(style: number): LiquidOrbPresetV1 {
  const entry = (Object.keys(ORB_PRESET_STYLE) as LiquidOrbPresetV1[]).find(
    (preset) => ORB_PRESET_STYLE[preset] === style,
  );
  return entry ?? "siri";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// ── 主题 token 解析（client-only，组件内调用） ──────────────────────────────

const TOKEN_FALLBACKS: Record<string, string> = {
  "--color-running": "#168C9A",
  "--color-warning": "#E99A16",
  "--color-action": "#126B4F",
  "--color-surface-raised": "#FFFDF8",
};

/** 读取当前主题的 token；SSR/jsdom 无 getComputedStyle 时回退默认值。 */
export function resolveOrbThemeColors(
  tone: LiquidOrbToneV1 = "running",
): OrbThemeColorsV1 {
  const baseToken = TONE_TOKENS[tone];
  const baseHex = readCssToken(baseToken, TOKEN_FALLBACKS[baseToken] ?? "#168C9A");
  const canvasHex = readCssToken(CANVAS_TOKEN, TOKEN_FALLBACKS[CANVAS_TOKEN] ?? "#FFFDF8");
  return buildOrbThemeColors(hexToRgb01(baseHex), hexToRgb01(canvasHex));
}

function readCssToken(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// ── 语音视觉映射（桌宠语音岛 / 学习运行语音题共用） ───────────────────────

/**
 * 桌宠语音岛（PetVoiceVisualizer）分态映射：
 * 准备/聆听 → Siri 声纹（青色）；收声/识别 → 频谱（琥珀色）；
 * 播报 → 声膜（绿色）。与旧 CSS 三态（bars/ring/waves）一一对应。
 */
export const PET_VOICE_ORB_VISUALS: Record<
  "requesting_permission" | "listening" | "finalizing" | "transcribing" | "speaking",
  LiquidOrbVisualV1
> = {
  requesting_permission: { preset: "siri", tone: "running", intensity: 0.7 },
  listening: { preset: "siri", tone: "running", intensity: 1 },
  finalizing: { preset: "spectrum", tone: "warning", intensity: 1 },
  transcribing: { preset: "spectrum", tone: "warning", intensity: 1 },
  speaking: { preset: "voice", tone: "action", intensity: 1 },
};

/**
 * 学习运行语音题（VoiceTeachbackTask）分态映射：
 * 待命 → 慢速蓝滴（低幅）；录音 → Siri 声纹；请求/转写 → 频谱。
 */
export const TEACHBACK_ORB_VISUALS: Record<
  "idle" | "requesting" | "recording" | "transcribing",
  LiquidOrbVisualV1
> = {
  idle: { preset: "drop", tone: "running", intensity: 0.5 },
  requesting: { preset: "spectrum", tone: "warning", intensity: 0.9 },
  recording: { preset: "siri", tone: "running", intensity: 1 },
  transcribing: { preset: "spectrum", tone: "warning", intensity: 1 },
};
