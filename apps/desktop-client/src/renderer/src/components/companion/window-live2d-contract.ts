import type {
  CharacterCueIntentV1,
  CharacterPresentationStateV1,
} from "@ailearn/shared/companion-character-contracts";
import {
  LIVE2D_NEUTRAL_FACS_PARAMETERS,
  parameterRequestsForLive2DEmotion,
} from "./live2d-emotion-map";
import type { Live2DEmotionState } from "./live2d-emotion";
import {
  arbitrateLive2DParameters,
  type Live2DParameterRequest,
} from "./live2d-parameter-priority";

export type WindowLive2DMotionMode = "full" | "lite" | "off";

export type WindowLive2DPresentation = CharacterPresentationStateV1;

// 2026-09-16 裁决：orb 已移除，加载失败不再回退替身形象，因此第三态是"不可用"
// （隐藏形象 + 父组件给可关闭说明），而不是"fallback 到另一个 renderer"。
export type WindowLive2DStatus = "loading" | "ready" | "unavailable";

/**
 * How the driver frames the model inside its canvas.
 * `full` keeps the entire character visible (home-page resident);
 * `bust` zooms to the head-and-torso region and crops the legs (task pages).
 */
export type WindowLive2DFraming = "full" | "bust";

/**
 * Fraction of the character's own visible height that the bust framing fills
 * (head through hands). Measured against the model's real content box, not the
 * canvas, so transparent canvas padding cannot shrink the character.
 */
export const WINDOW_LIVE2D_BUST_HEIGHT_RATIO = 0.7;

export interface WindowLive2DMotionCue {
  readonly group: string;
  readonly index: number;
}

/** Amplitude of the idle body sway the `idle` layer keeps emitting, in degrees. */
const IDLE_BODY_ANGLE_SWAY_DEGREES = 2;

/**
 * 「看向手边」（方案 §5 第 9 项）：工具开始执行时先侧身看一眼工具再回正。
 * 幅度取负值 = 朝工具所在的一侧（右手边），持续时间足够被看见但不拖住动作。
 */
const TOOL_ATTENTION_BODY_ANGLE_DEGREES = -3;
export const WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS = 1_500;

/**
 * Offset added to the idle sway while a tool-attention impulse is live.
 * Returns `null` outside the impulse window so the `gaze` layer releases
 * `ParamBodyAngleX` back to the `idle` layer and the sway resumes untouched.
 * The offset eases to exactly 0 at the end of the window, which keeps the
 * handoff between the two layers continuous (no snap back to the sway).
 */
function toolAttentionBodyAngleOffset(atMs: number | undefined, nowMs: number): number | null {
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  const elapsed = nowMs - atMs;
  if (elapsed < 0 || elapsed >= WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS) return null;

  const progress = elapsed / WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS;
  return TOOL_ATTENTION_BODY_ANGLE_DEGREES * (1 - progress) ** 2;
}

/**
 * Renderer-local asset paths. They intentionally stay relative to
 * `document.baseURI`, so the same build works under Vite's dev origin and the
 * packaged `ailearn-app://bundle/` protocol without reaching outside the app.
 */
export const WINDOW_LIVE2D_ASSETS = {
  manifest: "assets/companion/live2d-v1/manifest.json",
  model: "assets/companion/live2d-v1/mao-pro/runtime/mao_pro.model3.json",
  vendorScripts: [
    "assets/companion/vendor/pixi.min.js",
    "assets/companion/vendor/live2dcubismcore.min.js",
    "assets/companion/vendor/cubism4.min.js",
  ],
} as const;

/** 伴星可选的 Live2D 形态。注册表是唯一真话，切换能力见 `WindowLive2DDriver.setModel`。 */
export type WindowLive2DModelId = "mao-pro" | "seethrough" | "whale";

/**
 * 每个模型的许可验收要求：manifest 必须逐字段匹配（fail closed）。
 * 新模型先在这里登记要求，再补资产与 manifest。
 */
interface WindowLive2DManifestExpectation {
  readonly modelId: string;
  readonly status: "production" | "development";
  readonly commercialReleaseAllowed: boolean;
}

/**
 * 按模型的呈现 → 动作 cue 映射。mao 的编排动作都在默认组（`""`）；
 * whale 只有 Idle 组，其余呈现回落到 FACS 参数层（写不中的参数是安全 no-op）。
 */
type PresentationMotionMap = Readonly<
  Record<WindowLive2DPresentation, WindowLive2DMotionCue | null>
>;

/** 语义情绪 → 模型自带表情（model3.json Expressions 的 Name）。空表 = 走 FACS 参数路径。 */
type EmotionExpressionMap = Readonly<Record<string, string>>;

/**
 * 表演池里的一条：一条动作，或一个表情。
 *
 * 条目本身不在这里手写——每个形态演什么由它自己的 model3.json / exp3 决定，
 * 见 `live2d-performance-catalog.ts`。手写表必然漏，漏掉的那些正好谁都看不见。
 */
export type WindowLive2DPerformanceCue =
  | { readonly kind: "motion"; readonly cue: WindowLive2DMotionCue }
  | { readonly kind: "expression"; readonly name: string }
  | { readonly kind: "prop"; readonly name: string; readonly prop: WindowLive2DPropKind };

/**
 * 一个表情挂在哪个道具槽上。
 *
 * `costume` 是穿上的东西（眼镜），一直挂在身上直到被换下或脱下；`overlay` 是冒一下
 * 的东西（问号、吐魂、爱心），演完自己收。两者都不是"脸"：只写装饰可见性参数，
 * 不碰眼睛眉毛嘴，所以由逐帧层直接写参数而不是占用模型那一个表情槽
 * （表情槽是互斥的，换表情会把上一张脸的参数全部收回，见 `live2d-performance-catalog.ts`）。
 */
export type WindowLive2DPropKind = "costume" | "overlay";

/**
 * 伴星会做反应的语义时刻（2026-09-20 接入）。取值只描述**真实发生过的事件**：
 * 每个都由一条 SSE 帧或气泡动作触发，不为了"多点动画"凭空演一遍。
 *
 * 之前这些时刻全都不动：`agent.tool` 只有 executing 有一次 3° 侧身，succeeded /
 * failed / 等确认 / 报错 / 主动提醒一律零反应（方案里叫"任务提示没有身体"）。
 */
export type WindowLive2DCharacterMoment =
  | "task_started"
  | "working"
  | "tool_succeeded"
  | "tool_failed"
  | "awaiting_confirmation"
  | "reply_completed"
  | "reminder"
  | "celebration"
  | "run_failed";

/** 一个时刻在某个形态上落成什么：一条动作、一个.overlay 道具、一次 costume 穿脱。 */
export interface WindowLive2DMomentCue {
  readonly motion?: WindowLive2DMotionCue;
  readonly overlay?: string;
  /** 演出这个时刻时该戴上（string）/ 该脱下（null）的 costume；缺省表示不动。 */
  readonly costume?: string | null;
  /** overlay 挂多久；缺省用 `WINDOW_LIVE2D_DEFAULT_OVERLAY_HOLD_MS`。 */
  readonly holdMs?: number;
}

/** overlay 默认停留时长：够看清一次"她刚才那个表情"，又不会挂到下一轮对话。 */
export const WINDOW_LIVE2D_DEFAULT_OVERLAY_HOLD_MS = 2_600;

/**
 * 表演池轮播（洗牌袋）：抽完整袋才重洗，且重洗后的第一条不等于上一条。
 *
 * 待机随机表演和点击轮播共用同一个袋子：有放回的随机抽样会让某些动作几个月都演不到
 * 一次，某些连着演三遍——正是用户说的"只看到那几个待机动作"。
 */
export class WindowLive2DPerformanceRotation {
  private bag: WindowLive2DPerformanceCue[] = [];
  private last: WindowLive2DPerformanceCue | null = null;

  constructor(private readonly pool: ReadonlyArray<WindowLive2DPerformanceCue>) {}

  next(): WindowLive2DPerformanceCue | null {
    if (this.pool.length === 0) return null;
    if (this.bag.length === 0) this.refill();
    const cue = this.bag.shift()!;
    this.last = cue;
    return cue;
  }

  /**
   * 抽出来了但这会儿不能演（比如正挂着情绪表情，随机表情会抢同一张脸）：
   * 塞回袋口，下一次接着抽，不丢条目。
   */
  restore(cue: WindowLive2DPerformanceCue): void {
    this.bag.unshift(cue);
  }

  private refill(): void {
    this.bag = this.pool.slice();
    for (let index = this.bag.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [this.bag[index], this.bag[swap]] = [this.bag[swap]!, this.bag[index]!];
    }
    // 连着两条一样会被读成"卡带"，把撞车的这条挪到袋子里别的位置。
    if (this.bag.length > 1 && this.last !== null && this.bag[0] === this.last) {
      const swap = 1 + Math.floor(Math.random() * (this.bag.length - 1));
      [this.bag[0], this.bag[swap]] = [this.bag[swap]!, this.bag[0]!];
    }
  }
}

/**
 * 待机随机表演的节奏：新模型上场 4s 后开演，之后每 7–15s 演一条。
 * 2026-09-20 用户反馈"待机时老是一个动作转圈、几乎看不到表演"——原来的
 * 8s 首发 + 14–30s 间隔在一段正常长度的陪伴里最多插两三出戏。
 */
export const WINDOW_LIVE2D_FIRST_PERFORMANCE_DELAY_MS = 4_000;
export const WINDOW_LIVE2D_PERFORMANCE_INTERVAL_MS = 7_000;
export const WINDOW_LIVE2D_PERFORMANCE_INTERVAL_SPAN_MS = 8_000;

/** 随机抽到的表情停留多久；表情是粘性的，到点复位回中性脸。 */
export const WINDOW_LIVE2D_PERFORMANCE_EXPRESSION_HOLD_MS = 5_000;

/**
 * 抽到的动作占用的时长：在这段时间里 `setPresentation` 不再改姿势。
 *
 * 点击伴星会把交互台打开，呈现状态机随之内敛到 invite/celebrate 等固定动作；
 * 不等一下就演完，用户看到的永远是那两条呈现动作，"点击轮播不同动作"根本不成立
 * （2026-09-20 实机：一次点击后 `Surprised|0 + Nod|0 + Think|0 + Nod|0`）。
 */
export const WINDOW_LIVE2D_PERFORMANCE_MOTION_HOLD_MS = 3_500;

export interface WindowLive2DModelDescriptor {
  readonly displayName: string;
  readonly manifest: string;
  readonly model: string;
  readonly manifestExpectation: WindowLive2DManifestExpectation;
  /** 语音振幅写入的口型参数（mao 用 ParamA，whale 用 ParamMouthOpenY）。 */
  readonly lipSyncParameter: string;
  readonly presentationMotion: PresentationMotionMap;
  readonly emotionMotion: Readonly<Record<string, WindowLive2DMotionCue>>;
  readonly emotionExpression: EmotionExpressionMap;
  /**
   * 哪些表情其实是「穿戴物 / 冒一下的贴纸」，以及它属于哪个槽。
   *
   * 名字必须是该形态 model3.json 里真有的表情（由
   * `live2d-performance-catalog.test.ts` 逐条核对，写了不存在的名字就是红灯）。
   */
  readonly propRoles: Readonly<Record<string, WindowLive2DPropKind>>;
  /** 语义时刻 → 这个形态具体演什么；没登记的形态这些时刻就没有身体反应。 */
  readonly momentCue: Readonly<Partial<Record<WindowLive2DCharacterMoment, WindowLive2DMomentCue>>>;
  /** 切换过渡时旧模型淡出 / 新模型淡入的时长（ms）。 */
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  /**
   * 半身取景按模型微调（缺省用全局 `WINDOW_LIVE2D_BUST_HEIGHT_RATIO`）。
   * `bustFitWidth`：半身缩放同时受容器宽约束——内容盒比容器宽的模型
   * （如 whale 的鲸尾把盒子撑宽）不再水平裁切；对窄模型是纯 no-op。
   * `bustSinkRatio`：底边对齐后再把内容盒底往下沉容器高的这个分数，
   * 让角色整体下移、头顶腾出空档；只在 `bustFitWidth` 生效时用。
   */
  readonly bustHeightRatio?: number;
  readonly bustFitWidth?: boolean;
  readonly bustSinkRatio?: number;
}

/** mao 的编排映射（2026-09-19 之前就是它），保持原样以不扰动现有行为。 */
const MAO_PRESENTATION_MOTION: PresentationMotionMap = {
  hidden: null,
  idle: { group: "Idle", index: 0 },
  invite: { group: "", index: 0 },
  listen: { group: "Idle", index: 0 },
  speak: { group: "Idle", index: 0 },
  think: { group: "", index: 2 },
  analyze: { group: "", index: 2 },
  navigate: { group: "", index: 0 },
  encourage: { group: "", index: 3 },
  celebrate: { group: "", index: 3 },
  uncertain: { group: "", index: 1 },
};

const MAO_EMOTION_MOTION: Readonly<Record<string, WindowLive2DMotionCue>> = {
  happy: { group: "", index: 3 },
  excited: { group: "", index: 3 },
  amazed: { group: "", index: 1 },
  mischievously: { group: "", index: 3 },
  curious: { group: "", index: 2 },
  empathetic: { group: "", index: 3 },
  encouraged: { group: "", index: 3 },
  celebrate: { group: "", index: 3 },
  analyze: { group: "", index: 2 },
  think: { group: "", index: 2 },
  surprised: { group: "", index: 1 },
  panicked: { group: "", index: 1 },
};

/**
 * whale 的动作只有自带那 5 组（Idle / Bubble 吹泡泡糖 / Spray 鲸鱼喷水 / Selfie 自拍 /
 * SelfieQuick 举手机），语义上都不对应"邀请/指路"，所以呈现层大多留在 Idle：
 * 她的表现力由 `momentCue`（任务时刻）和 `emotionExpression`（12 张脸）承担。
 * celebrate 用吹泡泡糖——唯一一个真的像"在庆祝"的动作，且 5s 只在呈现层循环位上，
 * 不占用情绪动作的互斥窗口。
 */
const WHALE_PRESENTATION_MOTION: PresentationMotionMap = {
  hidden: null,
  idle: { group: "Idle", index: 0 },
  invite: null,
  listen: { group: "Idle", index: 0 },
  speak: { group: "Idle", index: 0 },
  think: { group: "Idle", index: 0 },
  analyze: { group: "Idle", index: 0 },
  navigate: { group: "Idle", index: 0 },
  encourage: { group: "Bubble", index: 0 },
  celebrate: { group: "Bubble", index: 0 },
  uncertain: { group: "Spray", index: 0 },
};

/** seethrough 的 8 组动作是语义化的，呈现映射可以直接对号入座。 */
const SEETHROUGH_PRESENTATION_MOTION: PresentationMotionMap = {
  hidden: null,
  idle: { group: "Idle", index: 0 },
  invite: { group: "Nod", index: 0 },
  listen: { group: "Idle", index: 0 },
  speak: { group: "Idle", index: 0 },
  think: { group: "Think", index: 0 },
  analyze: { group: "Think", index: 0 },
  navigate: { group: "Idle", index: 0 },
  encourage: { group: "Happy", index: 0 },
  celebrate: { group: "Happy", index: 0 },
  uncertain: { group: "Shake", index: 0 },
};

const SEETHROUGH_EMOTION_MOTION: Readonly<Record<string, WindowLive2DMotionCue>> = {
  happy: { group: "Happy", index: 0 },
  excited: { group: "Happy", index: 0 },
  celebrate: { group: "Happy", index: 0 },
  encouraged: { group: "Happy", index: 0 },
  surprised: { group: "Surprised", index: 0 },
  amazed: { group: "Surprised", index: 0 },
  panicked: { group: "Surprised", index: 0 },
  think: { group: "Think", index: 0 },
  analyze: { group: "Think", index: 0 },
  curious: { group: "Think", index: 0 },
  uncertain: { group: "Sleepy", index: 0 },
  sad: { group: "Sleepy", index: 0 },
};

const WHALE_EMOTION_EXPRESSION: EmotionExpressionMap = {
  happy: "happy",
  excited: "starstruck",
  amazed: "surprised",
  surprised: "surprised",
  panicked: "cry",
  mischievously: "mischievous",
  curious: "question",
  think: "question",
  analyze: "question",
  empathetic: "blush",
  encouraged: "heart-eyes",
  celebrate: "starstruck",
  uncertain: "dizzy",
  angry: "angry",
  sad: "sad",
};

/**
 * mao 的语义情绪 → 自带 exp3。FACS 参数层继续写（眉毛/嘴的幅度和表情同向），
 * 表情补上 FACS 够不到的通道：眉角、嘴下、眼球形状、星星眼特效。
 */
const MAO_EMOTION_EXPRESSION: EmotionExpressionMap = {
  happy: "exp_02",
  encouraged: "exp_02",
  excited: "exp_04",
  celebrate: "exp_04",
  amazed: "exp_04",
  empathetic: "exp_06",
  surprised: "exp_07",
  panicked: "exp_07",
  sad: "exp_05",
  crying: "exp_05",
  concerned: "exp_05",
  uncertain: "exp_05",
  angry: "exp_08",
  mischievously: "exp_08",
  scornful: "exp_08",
};

/** 大肥鱼唯一能对上"受惊"语义的动作：头顶那条鲸喷一下水（0.47s，短促）。 */
const WHALE_EMOTION_MOTION: Readonly<Record<string, WindowLive2DMotionCue>> = {
  surprised: { group: "Spray", index: 0 },
  panicked: { group: "Spray", index: 0 },
};

/**
 * 大肥鱼的「服装配件」登记表（作者原包的贴纸 / 眼镜 / 小道具类 exp3）。
 *
 * 全部是只写装饰可见性参数的单参数表情，所以能逐帧叠加、能脱下来；
 * 发型类（头箍=摘掉发箍、单边马尾）会永久改形象、桌面道具类（蛋包饭 / 魔爪 / 桌布）
 * 需要一张伴星没有的桌子，两类都没登记（取舍记录见资产目录 README）。
 */
const WHALE_PROP_ROLES: Readonly<Record<string, WindowLive2DPropKind>> = {
  "glasses-round": "costume",
  "glasses-square": "costume",
  "glasses-oval": "costume",
  sunglasses: "costume",
  "cat-sticker": "overlay",
  "rabbit-sticker": "overlay",
  "bow-sticker": "overlay",
  flowers: "overlay",
  heartbeat: "overlay",
  soul: "overlay",
  hearts: "overlay",
  "cat-paw": "overlay",
  peace: "overlay",
  "whale-on-head": "overlay",
  question: "overlay",
  surprised: "overlay",
};

/**
 * 大肥鱼的任务时刻表演（2026-09-20 接入）。
 *
 * 道具名全部来自 `WHALE_PROP_ROLES`，动作名全部来自它自己的 model3.json；
 * `costume: null` 表示这个时刻把眼镜摘下来——干活时戴、干完摘，不然一副圆脸眼镜
 * 挂在身上到下一次切换形态。
 */
const WHALE_MOMENT_CUE: Readonly<Partial<Record<WindowLive2DCharacterMoment, WindowLive2DMomentCue>>> = {
  task_started: { motion: { group: "Spray", index: 0 } },
  working: { costume: "glasses-round" },
  tool_succeeded: { motion: { group: "Bubble", index: 0 }, overlay: "peace", costume: null, holdMs: 3_000 },
  tool_failed: { overlay: "soul", costume: null, holdMs: 3_200 },
  awaiting_confirmation: { overlay: "question", holdMs: 6_000 },
  reply_completed: { costume: null },
  reminder: { overlay: "surprised", holdMs: 3_000 },
  celebration: { overlay: "hearts", costume: null, holdMs: 3_000 },
  run_failed: { overlay: "soul", costume: null, holdMs: 3_200 },
};

/** mao 没有配件类表情，时刻表演只用它自带的 6 条编排动作。 */
const MAO_MOMENT_CUE: Readonly<Partial<Record<WindowLive2DCharacterMoment, WindowLive2DMomentCue>>> = {
  task_started: { motion: { group: "", index: 2 } },
  working: { motion: { group: "", index: 2 } },
  tool_succeeded: { motion: { group: "", index: 3 } },
  tool_failed: { motion: { group: "", index: 1 } },
  awaiting_confirmation: { motion: { group: "", index: 0 } },
  reminder: { motion: { group: "", index: 0 } },
  celebration: { motion: { group: "", index: 3 } },
  run_failed: { motion: { group: "", index: 1 } },
};

const SEETHROUGH_MOMENT_CUE: Readonly<Partial<Record<WindowLive2DCharacterMoment, WindowLive2DMomentCue>>> = {
  task_started: { motion: { group: "Think", index: 0 } },
  working: { motion: { group: "Think", index: 0 } },
  tool_succeeded: { motion: { group: "Happy", index: 0 } },
  tool_failed: { motion: { group: "Shake", index: 0 } },
  awaiting_confirmation: { motion: { group: "Nod", index: 0 } },
  reminder: { motion: { group: "Nod", index: 0 } },
  celebration: { motion: { group: "Happy", index: 0 } },
  run_failed: { motion: { group: "Shake", index: 0 } },
};

export const WINDOW_LIVE2D_MODEL_REGISTRY: Readonly<
  Record<WindowLive2DModelId, WindowLive2DModelDescriptor>
> = {
  "mao-pro": {
    displayName: "Mao",
    manifest: WINDOW_LIVE2D_ASSETS.manifest,
    model: WINDOW_LIVE2D_ASSETS.model,
    manifestExpectation: {
      modelId: "companion-live2d-mao-pro-v1",
      status: "production",
      commercialReleaseAllowed: true,
    },
    lipSyncParameter: "ParamA",
    presentationMotion: MAO_PRESENTATION_MOTION,
    emotionMotion: MAO_EMOTION_MOTION,
    emotionExpression: MAO_EMOTION_EXPRESSION,
    propRoles: {},
    momentCue: MAO_MOMENT_CUE,
    fadeInMs: 240,
    fadeOutMs: 200,
  },
  whale: {
    displayName: "大肥鱼",
    manifest: "assets/companion/live2d-v3/whale/manifest.json",
    model: "assets/companion/live2d-v3/whale/c_0120.model3.json",
    manifestExpectation: {
      modelId: "companion-live2d-whale-v3",
      status: "production",
      commercialReleaseAllowed: true,
    },
    lipSyncParameter: "ParamMouthOpenY",
    presentationMotion: WHALE_PRESENTATION_MOTION,
    emotionMotion: WHALE_EMOTION_MOTION,
    emotionExpression: WHALE_EMOTION_EXPRESSION,
    propRoles: WHALE_PROP_ROLES,
    momentCue: WHALE_MOMENT_CUE,
    fadeInMs: 240,
    fadeOutMs: 200,
    // 鲸尾把内容盒撑得比半身容器宽：不约束宽度时头部以高度定标会把
    // 身体两侧裁掉（2026-09-20 用户截图）。仅此模型开启，窄模型不受影响。
    bustFitWidth: true,
    // 整幅海景背景把内容盒撑得很高，角色只占中间一段：底边对齐时她的头
    // 正好顶在控制列上（2026-09-20 用户标注「模型往下、按钮往旁边」）。
    // 再往下沉一档，把头顶让给天空，控制列也就能挪到盒子外侧不压到人。
    bustSinkRatio: 0.14,
  },
  seethrough: {
    displayName: "小彩",
    manifest: "assets/companion/live2d-v2/seethrough/manifest.json",
    model: "assets/companion/live2d-v2/seethrough/seethrough_output.model3.json",
    manifestExpectation: {
      modelId: "companion-live2d-seethrough-v2",
      status: "development",
      commercialReleaseAllowed: false,
    },
    lipSyncParameter: "ParamMouthOpenY",
    presentationMotion: SEETHROUGH_PRESENTATION_MOTION,
    emotionMotion: SEETHROUGH_EMOTION_MOTION,
    emotionExpression: {},
    propRoles: {},
    momentCue: SEETHROUGH_MOMENT_CUE,
    fadeInMs: 240,
    fadeOutMs: 200,
  },
};

/** 2026-09-20 Owner 指定：伴星默认形态是大肥鱼（mao / 小彩 仍可在设置里切换）。 */
export const DEFAULT_WINDOW_LIVE2D_MODEL_ID: WindowLive2DModelId = "whale";

export function isWindowLive2DModelId(value: unknown): value is WindowLive2DModelId {
  return typeof value === "string" && value in WINDOW_LIVE2D_MODEL_REGISTRY;
}

export function windowLive2DModelDescriptor(
  modelId: WindowLive2DModelId,
): WindowLive2DModelDescriptor {
  return WINDOW_LIVE2D_MODEL_REGISTRY[modelId];
}

export function isApprovedWindowLive2DManifest(
  value: unknown,
  /** 缺省 = 当前默认形态的验收要求；调用方（驱动器）始终显式传自己那个。 */
  expectation: WindowLive2DManifestExpectation = windowLive2DModelDescriptor(
    DEFAULT_WINDOW_LIVE2D_MODEL_ID,
  ).manifestExpectation,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as {
    schemaVersion?: unknown;
    modelId?: unknown;
    status?: unknown;
    ownerApproved?: { by?: unknown; date?: unknown };
    modelLicense?: { name?: unknown; acceptanceRequired?: unknown; commercialReleaseAllowed?: unknown };
  };
  return manifest.schemaVersion === 1
    && manifest.modelId === expectation.modelId
    && manifest.status === expectation.status
    && manifest.modelLicense?.commercialReleaseAllowed === expectation.commercialReleaseAllowed
    && typeof manifest.ownerApproved?.by === "string"
    && manifest.ownerApproved.by.trim().length > 0
    && typeof manifest.ownerApproved.date === "string"
    && manifest.ownerApproved.date.trim().length > 0
    && typeof manifest.modelLicense?.name === "string"
    && manifest.modelLicense.name.trim().length > 0
    && manifest.modelLicense.acceptanceRequired === true;
}

export function motionForWindowLive2D(
  presentation: WindowLive2DPresentation,
  modelId: WindowLive2DModelId = DEFAULT_WINDOW_LIVE2D_MODEL_ID,
): WindowLive2DMotionCue | null {
  return WINDOW_LIVE2D_MODEL_REGISTRY[modelId].presentationMotion[presentation];
}

/** 归一化语义情绪 key；空串 / 非字符串统一返回 null。 */
function normalizedEmotionKey(emotion: string | null | undefined): string | null {
  if (typeof emotion !== "string") return null;
  const key = emotion.trim().toLowerCase();
  return key ? key : null;
}

export function motionForWindowLive2DEmotion(
  emotion: string | null | undefined,
  modelId: WindowLive2DModelId = DEFAULT_WINDOW_LIVE2D_MODEL_ID,
): WindowLive2DMotionCue | null {
  const key = normalizedEmotionKey(emotion);
  return key ? WINDOW_LIVE2D_MODEL_REGISTRY[modelId].emotionMotion[key] ?? null : null;
}

/** 情绪 → 模型自带表情名（model3.json Expressions 的 Name）；无映射返回 null。 */
export function expressionForWindowLive2DEmotion(
  emotion: string | null | undefined,
  modelId: WindowLive2DModelId = DEFAULT_WINDOW_LIVE2D_MODEL_ID,
): string | null {
  const key = normalizedEmotionKey(emotion);
  return key ? WINDOW_LIVE2D_MODEL_REGISTRY[modelId].emotionExpression[key] ?? null : null;
}

/**
 * 语义 cue 的 intent → 呈现状态。
 *
 * 服务端每轮回复都带 intent（`companion-dialogue-content.ts` 的四条固定 cue +
 * 分类器结果），桌面端过去只取 emotion / intensity，把 intent 直接丢掉，
 * 于是"她在解释"和"她在鼓励你"是同一副身体。这里把它接回来：intent 只决定**姿势**，
 * 表情仍由 emotion 决定，两者不互相覆盖。
 */
export function presentationForCharacterCueIntent(
  intent: CharacterCueIntentV1 | null | undefined,
): WindowLive2DPresentation | null {
  switch (intent) {
    case "listen":
      return "listen";
    case "think":
      return "think";
    case "explain":
      return "speak";
    case "acknowledge":
      return "invite";
    case "encourage":
      return "encourage";
    case "celebrate":
      return "celebrate";
    case "uncertain":
    case "warn":
      return "uncertain";
    case "sleep":
      return "idle";
    default:
      return null;
  }
}

export function momentCueForWindowLive2D(
  moment: WindowLive2DCharacterMoment,
  modelId: WindowLive2DModelId = DEFAULT_WINDOW_LIVE2D_MODEL_ID,
): WindowLive2DMomentCue | null {
  return WINDOW_LIVE2D_MODEL_REGISTRY[modelId].momentCue[moment] ?? null;
}

/** 一条表情写入里的一次参数赋值（与 `live2d-performance-catalog` 同一形状）。 */
export interface WindowLive2DParameterWrite {
  readonly parameter: string;
  readonly value: number;
  readonly blend: string;
}

/**
 * 会长表情、会被道具通道误伤的脸部参数前缀。
 *
 * 道具通道对**没穿上**的道具一律写 0（不然一片贴纸收不回去）。这一步绝不能碰到
 * 脸部参数：把 `ParamEyeLOpen` 写成 0 就是永久闭眼。登记表若写了含脸部参数的
 * 表情，这些参数会被整条跳过，由 `live2d-performance-catalog.test.ts` 负责报警。
 */
/**
 * 由模型自带的逐帧层（眨眼 / 呼吸 / 视线跟随 / 口型）负责的脸部参数。
 *
 * 道具通道和整活参数归位都不许碰这些：把 `ParamEyeLOpen` 写成 0 就是永久闭眼，
 * 把 `ParamAngleX` 按住就是再也不抬头。`ParamMouthForm` / `ParamMouthUp` 不在这里——
 * 自拍结束时的笑嘴正是要归位的东西，而我们的 FACS 层写在归位之后，不会互相打架。
 */
const FACE_LAYER_PARAMETER_PREFIXES = [
  "ParamEye",
  "ParamBrow",
  "ParamAngle",
  "ParamBody",
  "ParamBreath",
  "ParamMouthOpenY",
] as const;

export function isFaceLayerLive2DParameter(parameter: string): boolean {
  return FACE_LAYER_PARAMETER_PREFIXES.some((prefix) => parameter.startsWith(prefix))
    || parameter === "ParamA";
}

/**
 * 逐帧道具层：两个槽（costume / overlay）各自"穿上写资产值、没穿写 0"。
 *
 * `reservedParameters` = 当前那张脸自己写过的参数：同一个装饰（感叹号、问号）既是
 * 大肥鱼的惊讶表情又是 reminder 贴纸，谁的参数归谁，两边不能抢。
 */
export function propParameterValuesForWindowLive2D(input: {
  readonly costume: readonly WindowLive2DParameterWrite[] | null;
  readonly overlay: readonly WindowLive2DParameterWrite[] | null;
  readonly declared: Readonly<Record<string, ReadonlyArray<WindowLive2DParameterWrite>>>;
  readonly reservedParameters?: ReadonlySet<string>;
}): WindowLive2DParameterValue[] {
  const active = new Map<string, number>();
  for (const writes of [input.costume, input.overlay]) {
    for (const write of writes ?? []) {
      if (write.blend !== "Add") continue;
      active.set(write.parameter, write.value);
    }
  }
  const values: WindowLive2DParameterValue[] = [];
  const seen = new Set<string>();
  for (const writes of Object.values(input.declared)) {
    for (const write of writes) {
      if (write.blend !== "Add" || seen.has(write.parameter)) continue;
      if (isFaceLayerLive2DParameter(write.parameter)) continue;
      if (input.reservedParameters?.has(write.parameter)) continue;
      seen.add(write.parameter);
      values.push({
        parameter: write.parameter,
        value: active.get(write.parameter) ?? 0,
      });
    }
  }
  return values;
}

type ParameterRange = { readonly min: number; readonly max: number };

/**
 * Mao PRO parameter allowlist. Unknown parameters fail closed and all
 * values are clamped before reaching Cubism Core.
 */
const PARAMETER_ALLOWLIST: Readonly<Record<string, ParameterRange>> = {
  ParamBodyAngleX: { min: -10, max: 10 },
  ParamBreath: { min: 0, max: 1 },
  ParamBrowLY: { min: -1, max: 1 },
  ParamBrowRY: { min: -1, max: 1 },
  ParamCheek: { min: 0, max: 1 },
  ParamEyeLOpen: { min: 0, max: 1 },
  ParamEyeROpen: { min: 0, max: 1 },
  ParamEyeLSmile: { min: 0, max: 1 },
  ParamEyeRSmile: { min: 0, max: 1 },
  ParamMouthUp: { min: 0, max: 1 },
  ParamMouthOpenY: { min: 0, max: 1 },
  ParamA: { min: 0, max: 1 },
};

export interface WindowLive2DParameterValue {
  readonly parameter: string;
  readonly value: number;
}

function clampParameter(parameter: string, value: number): WindowLive2DParameterValue | null {
  const range = PARAMETER_ALLOWLIST[parameter];
  if (!range || !Number.isFinite(value)) return null;

  return {
    parameter,
    value: Math.min(range.max, Math.max(range.min, value)),
  };
}

/**
 * Deterministic parameter layer. Cubism motions keep ownership of choreography;
 * this layer supplies breathing, blinking, voice amplitude and the currently
 * active Mao semantic expression while the renderer is active.
 */
export function parameterValuesForWindowLive2D(input: {
  readonly presentation: WindowLive2DPresentation;
  readonly nowMs: number;
  readonly voiceLevel: number;
  readonly emotion?: Live2DEmotionState | null;
  /** Timestamp (same clock as `nowMs`) of the latest tool-executing impulse. */
  readonly toolAttentionAtMs?: number;
  /** 当前模型的口型参数；缺省 = mao 的 ParamA（保持既有调用方与测试不变）。 */
  readonly lipSyncParameter?: string;
  /**
   * 当前生效的表情**自己写了**哪些 Cubism 参数（来自表情的 exp3，见
   * `live2d-performance-catalog.ts`）。
   *
   * 我们的逐帧参数层写在表情应用**之后**，会把表情作者好的曲线整批抹平：mao 的
   * exp_02「笑到眯眼」（Multiply 0）、大肥鱼的 mischievous「单眼眨」（Add -1）被抹平
   * 后就等于表情没生效——这正是用户"表情几乎没看到"的机制。表情有效期间，它写过的
   * 参数归它；只写中性值的（Add 0 / Multiply 1）不算接管，眨眼照常。
   * 呼吸、身体摇摆和口型不放手：那是活着的证据，不是表情内容。
   */
  readonly expressionOwnedParameters?: ReadonlySet<string>;
}): WindowLive2DParameterValue[] {
  const owned = input.expressionOwnedParameters;
  const blinkPhase = input.nowMs % 4_500;
  const eyeOpen = blinkPhase >= 3_600 && blinkPhase < 3_750
    ? Math.abs((blinkPhase - 3_675) / 75)
    : 1;
  const idleBodyAngleX = Math.sin(input.nowMs / 2_400) * IDLE_BODY_ANGLE_SWAY_DEGREES;
  const requests: Live2DParameterRequest[] = [
    { layer: "idle", parameter: "ParamBreath", value: 0.5 + Math.sin(input.nowMs / 900) * 0.25 },
    { layer: "idle", parameter: "ParamBodyAngleX", value: idleBodyAngleX },
    { layer: "blink", parameter: "ParamEyeLOpen", value: eyeOpen },
    { layer: "blink", parameter: "ParamEyeROpen", value: eyeOpen },
  ];

  // The impulse rides on top of the idle sway instead of replacing it, so the
  // `gaze` layer can hand `ParamBodyAngleX` back without a visible jump.
  const toolAttention = toolAttentionBodyAngleOffset(input.toolAttentionAtMs, input.nowMs);
  if (toolAttention !== null) {
    requests.push({
      layer: "gaze",
      parameter: "ParamBodyAngleX",
      value: idleBodyAngleX + toolAttention,
    });
  }

  const presentationFacs: Live2DParameterRequest[] = [];
  switch (input.presentation) {
    case "encourage":
    case "celebrate":
      presentationFacs.push(
        { layer: "facs", parameter: "ParamBrowLY", value: 0.25 },
        { layer: "facs", parameter: "ParamBrowRY", value: 0.25 },
        { layer: "facs", parameter: "ParamEyeLSmile", value: 0.35 },
        { layer: "facs", parameter: "ParamEyeRSmile", value: 0.35 },
        { layer: "facs", parameter: "ParamCheek", value: 0.3 },
        { layer: "facs", parameter: "ParamMouthUp", value: 0.25 },
      );
      break;
    case "think":
    case "analyze":
      presentationFacs.push(
        { layer: "facs", parameter: "ParamBrowLY", value: 0.1 },
        { layer: "facs", parameter: "ParamBrowRY", value: 0.1 },
      );
      break;
    default:
      break;
  }

  const emotionFacs = input.emotion?.emotion
    ? parameterRequestsForLive2DEmotion(input.emotion.emotion, input.emotion.intensity)
    : [];
  requests.push(...LIVE2D_NEUTRAL_FACS_PARAMETERS);
  requests.push(...(emotionFacs.length > 0 ? emotionFacs : presentationFacs));

  if (input.presentation === "speak" || input.voiceLevel > 0) {
    const voiceLevel = Math.min(1, Math.max(0, input.voiceLevel));
    const lipSyncParameter = input.lipSyncParameter ?? "ParamA";
    requests.push(
      { layer: "lipsync", parameter: lipSyncParameter, value: voiceLevel },
      { layer: "lipsync", parameter: "ParamMouthUp", value: voiceLevel * 0.2 },
    );
  }

  return arbitrateLive2DParameters(owned
    ? requests.filter((request) => !(
      (request.layer === "blink" || request.layer === "facs")
      && owned.has(request.parameter)
    ))
    : requests)
    .map(({ parameter, value }) => clampParameter(parameter, value))
    .filter((value): value is WindowLive2DParameterValue => value !== null);
}
