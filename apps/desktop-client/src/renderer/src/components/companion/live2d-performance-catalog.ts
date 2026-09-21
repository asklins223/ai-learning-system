import type {
  WindowLive2DModelDescriptor,
  WindowLive2DPerformanceCue,
  WindowLive2DPropKind,
} from "./window-live2d-contract";

/**
 * 每个形态「一共会演什么」不写死在代码里，而是从它自己的资产清单读出来
 * （2026-09-20 用户："你真的有接入全部动作和表情吗"——手写表必然漏，漏掉的
 * 那些正好谁都看不见）。
 *
 * 读到的东西有三件：
 * 1. 表演池：除待机动作组之外的全部动作 + 表情 + 道具，洗牌袋轮播（见
 *    `WindowLive2DPerformanceRotation`）。
 * 2. 每个表情自己写了哪些参数、写成什么值。逐帧参数层（眨眼 / FACS）写在表情之后，
 *    会把表情作者好的眼睛、眉毛、嘴整批抹平——mao 的 exp_02「笑到眯眼」、大肥鱼
 *    的 happy「闭眼笑」被抹平后就等于表情没生效。表情有效期间，它写过的参数归它；
 *    道具通道则按这些值逐帧写，所以眼镜、贴纸能穿上也能脱下。
 * 3. 每条动作演多久、动了哪些参数。喷水的 `pengshui`、自拍的 `phone` 这类整活参数
 *    待机动作不碰，演完不回位就会永久挂在身上（2026-09-20 接入时实测到），
 *    所以演完由「道具参数归位层」把它们写回模型默认值。
 */

export interface Model3File {
  FileReferences?: {
    Motions?: Record<string, Array<{ File?: unknown } | null> | null>;
    Expressions?: Array<{ Name?: unknown; File?: unknown } | null> | null;
  };
}

export interface Expression3File {
  Parameters?: Array<{ Id?: unknown; Value?: unknown; Blend?: unknown } | null> | null;
}

/** Cubism 4 的 motion3.json：`Curves` 在顶层与 `FileReferences` 下都见过，两边都读。 */
export interface Motion3File {
  Meta?: { Duration?: unknown };
  Curves?: Array<CurveJson | null> | null;
  FileReferences?: { Curves?: Array<CurveJson | null> | null };
}

interface CurveJson {
  Target?: unknown;
  Id?: unknown;
}

/** 一条 exp3 里的一次参数写入；`blend` 决定它能不能当成独立道具层来写。 */
export interface ExpressionParameterWrite {
  readonly parameter: string;
  readonly value: number;
  readonly blend: string;
}

/** 一条动作演多久、动了哪些参数——演完要把这些参数放回默认值。 */
export interface MotionSpec {
  readonly parameters: ReadonlyArray<string>;
  readonly durationMs: number;
}

/** 动作池条目的键：`WindowLive2DMotionCue` 的 `group|index`。 */
export function motionSpecKey(group: string, index: number): string {
  return `${group}|${index}`;
}

export interface WindowLive2DCatalog {
  /** 表演池：除待机动作组之外的全部动作 + 表情 + 道具，按资产里声明的顺序。 */
  readonly performanceCues: ReadonlyArray<WindowLive2DPerformanceCue>;
  /** 表情名 → 它非中性写入的参数 id；表情生效期间这些参数不再由我们写。 */
  readonly expressionParameters: Readonly<Record<string, ReadonlySet<string>>>;
  /** 表情名 → 它的全部写入（含数值）。道具通道按这个逐帧写参数。 */
  readonly expressionWrites: Readonly<Record<string, ReadonlyArray<ExpressionParameterWrite>>>;
  /** `group|index` → 这条动作动的参数与时长。 */
  readonly motionSpecs: Readonly<Record<string, MotionSpec>>;
  /** 待机动作常驻在写哪些参数：这些参数不能被告警重置层冻结。 */
  readonly idleMotionParameters: ReadonlySet<string>;
  /** 模型是否自带这个名字的表情 / 动作组（情绪语义名和资产名对得上时直接落）。 */
  hasExpression(name: string): boolean;
  hasMotionGroup(group: string): boolean;
}

/** 清单读不出来时的兜底：只丢表演，不丢形象。 */
export const EMPTY_WINDOW_LIVE2D_CATALOG: WindowLive2DCatalog = {
  performanceCues: [],
  expressionParameters: {},
  expressionWrites: {},
  motionSpecs: {},
  idleMotionParameters: new Set(),
  hasExpression: () => false,
  hasMotionGroup: () => false,
};

/**
 * 从 model3.json + 已读出的 exp3 / motion3 内容建清单（纯函数，资产解析与 I/O 分开，
 * 这样"每个形态到底接入了多少动作/表情"可以直接拿仓库里的真资产来测）。
 *
 * `propNames` 由注册表给出（哪个表情是服装配件、哪个是贴纸）：同一份 exp3 资产，
 * 挂在表情槽位上是一次性换脸，挂在道具通道上是可以叠加、可以收回的穿戴物。
 */
export function parseWindowLive2DCatalog(
  model3: Model3File,
  expressionFiles: ReadonlyMap<string, Expression3File>,
  motionFiles: ReadonlyMap<string, Motion3File>,
  idleMotionGroup: string | undefined,
  propNames: ReadonlyMap<string, WindowLive2DPropKind> = new Map(),
): WindowLive2DCatalog {
  const cues: WindowLive2DPerformanceCue[] = [];
  const motionSpecs: Record<string, MotionSpec> = {};
  const motionGroups: string[] = [];
  const motions = model3.FileReferences?.Motions;
  if (motions && typeof motions === "object") {
    for (const [group, entries] of Object.entries(motions)) {
      if (!Array.isArray(entries)) continue;
      if (group !== idleMotionGroup) motionGroups.push(group);
      for (let index = 0; index < entries.length; index += 1) {
        if (!entries[index]) continue;
        const key = motionSpecKey(group, index);
        motionSpecs[key] = motionFileToSpec(motionFiles.get(key));
        if (group === idleMotionGroup) continue;
        cues.push({ kind: "motion", cue: { group, index } });
      }
    }
  }

  const expressionParameters: Record<string, ReadonlySet<string>> = {};
  const expressionWrites: Record<string, ReadonlyArray<ExpressionParameterWrite>> = {};
  for (const entry of model3.FileReferences?.Expressions ?? []) {
    if (!entry || typeof entry.Name !== "string" || !entry.Name) continue;
    const writes = parameterWrites(expressionFiles.get(entry.Name));
    expressionWrites[entry.Name] = writes;
    const owned = new Set(writes.filter((write) => !isNeutral(write)).map((write) => write.parameter));
    expressionParameters[entry.Name] = owned;
    // 一个"什么都没写"的表情（mao 的 exp_01 全表都是中性值）演出来就是站着不动，
    // 白占一格轮播；只丢这一类，眼睛闭上的 exp_03 那种是有内容的。
    if (owned.size === 0) continue;
    const prop = propNames.get(entry.Name);
    cues.push(prop
      ? { kind: "prop", name: entry.Name, prop }
      : { kind: "expression", name: entry.Name });
  }

  const expressionNames = new Set(Object.keys(expressionParameters));
  const groupSet = new Set(motionGroups);
  const idle = idleMotionGroup === undefined
    ? undefined
    : motionFiles.get(motionSpecKey(idleMotionGroup, 0));
  return {
    performanceCues: cues,
    expressionParameters,
    expressionWrites,
    motionSpecs,
    idleMotionParameters: new Set(idle ? motionFileToSpec(idle).parameters : []),
    hasExpression: (name) => expressionNames.has(name),
    hasMotionGroup: (group) => groupSet.has(group),
  };
}

function motionFileToSpec(file: Motion3File | undefined): MotionSpec {
  const curves = file?.Curves ?? file?.FileReferences?.Curves ?? [];
  const parameters: string[] = [];
  for (const curve of curves) {
    if (!curve || curve.Target !== "Parameter" || typeof curve.Id !== "string" || !curve.Id) continue;
    parameters.push(curve.Id);
  }
  const duration = typeof file?.Meta?.Duration === "number" ? file.Meta.Duration : Number.NaN;
  return {
    parameters,
    durationMs: Number.isFinite(duration) && duration > 0 ? duration * 1_000 : 0,
  };
}

/**
 * 表情写入的参数值。
 *
 * 与 `ownedParameterIds` 同一份来源，但保留数值：道具通道要按作者写的值把眼镜、
 * 贴纸打开，收回去时写 0。
 */
function parameterWrites(file: Expression3File | undefined): ExpressionParameterWrite[] {
  const writes: ExpressionParameterWrite[] = [];
  for (const parameter of file?.Parameters ?? []) {
    if (!parameter || typeof parameter.Id !== "string" || !parameter.Id) continue;
    const value = typeof parameter.Value === "number" ? parameter.Value : Number.NaN;
    if (!Number.isFinite(value)) continue;
    writes.push({
      parameter: parameter.Id,
      value,
      blend: typeof parameter.Blend === "string" ? parameter.Blend : "Add",
    });
  }
  return writes;
}

/** Add 0 / Multiply 1 = 不改变，其余一律算这条表情自己写了这个参数。 */
function isNeutral(write: ExpressionParameterWrite): boolean {
  return write.value === (write.blend === "Multiply" ? 1 : 0);
}

function resolveRelative(modelUrl: string, relative: string): string {
  const base = new URL(".", modelUrl);
  const url = new URL(relative.replace(/^\/+/, ""), base);
  if (url.protocol !== base.protocol || url.host !== base.host) {
    throw new Error(`Refusing non-bundled Live2D asset: ${url.href}`);
  }
  return url.href;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "force-cache", credentials: "same-origin" });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

/**
 * 读一个形态的完整表演清单。失败时返回空清单（只丢表演，不丢形象）：
 * 一个读不出来的资产清单不应该让伴星消失，但也必须留下日志，否则"接入了全部
 * 动作"就又是一句没证据的话。
 */
export async function loadWindowLive2DCatalog(
  descriptor: WindowLive2DModelDescriptor,
  resolveAsset: (path: string) => string,
): Promise<WindowLive2DCatalog> {
  const modelUrl = resolveAsset(descriptor.model);
  const model3 = await fetchJson<Model3File>(modelUrl);
  if (!model3) {
    console.warn("[WindowLive2D] performance catalog unavailable; model3.json unreadable", modelUrl);
    return EMPTY_WINDOW_LIVE2D_CATALOG;
  }

  const expressionFiles = new Map<string, Expression3File>();
  const declarations = (model3.FileReferences?.Expressions ?? []).filter(
    (entry): entry is { Name: string; File: string } =>
      typeof entry?.Name === "string"
      && !!entry.Name
      && typeof entry.File === "string"
      && !!entry.File,
  );
  const motionDeclarations: Array<{ key: string; file: string }> = [];
  for (const [group, entries] of Object.entries(model3.FileReferences?.Motions ?? {})) {
    (entries ?? []).forEach((entry, index) => {
      const file = typeof entry?.File === "string" ? entry.File : undefined;
      if (file) motionDeclarations.push({ key: motionSpecKey(group, index), file });
    });
  }
  const [loadedExpressions, loadedMotions] = await Promise.all([
    Promise.all(declarations.map(async (entry) => [
      entry.Name, await fetchJson<Expression3File>(resolveRelative(modelUrl, entry.File)),
    ] as const)),
    Promise.all(motionDeclarations.map(async (entry) => [
      entry.key, await fetchJson<Motion3File>(resolveRelative(modelUrl, entry.file)),
    ] as const)),
  ]);
  for (const [name, file] of loadedExpressions) {
    if (file) expressionFiles.set(name, file);
  }
  const motionFiles = new Map<string, Motion3File>();
  for (const [key, file] of loadedMotions) {
    if (file) motionFiles.set(key, file);
  }

  const catalog = parseWindowLive2DCatalog(
    model3,
    expressionFiles,
    motionFiles,
    descriptor.presentationMotion.idle?.group,
    new Map(Object.entries(descriptor.propRoles)),
  );
  if (catalog.performanceCues.length === 0) {
    console.warn("[WindowLive2D] performance catalog is empty", modelUrl);
  }
  return catalog;
}
