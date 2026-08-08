/**
 * 任务 09-4：容量与性能 RC（§16.5，阶段 09 W8）。
 *
 * 本文件是容量/性能验收的**互斥纯函数层**（无 DB / 无网络 / 无时钟 / 无副作用 /
 * 无随机），把冻结记录 01-5 §16.5（体验与性能 Gate）翻译成确定性校验函数：
 * - 容量 fixture 矩阵：Note 2K/13K/50K 字符、每 Card 1/10/30 Key Points、
 *   每 Session 1/3/5 Episodes、星图 100/1K/5K 节点、并发 Session 档位
 *   （`CAPACITY_FIXTURES` = 冻结档位笛卡尔积，共 243 个组合）；
 * - 性能门限（W0 冻结，01-5 §16.5）：本地 companion action pointer/key event →
 *   下一帧视觉 commit p95 < 100ms（不含网络/Provider）；已缓存合法 Session plan
 *   后 Scene state transition → 首个可交互帧 p95 < 300ms（不含网络/Provider）；
 *   Global Shell、auth-surface manifest 和安静锚点不得阻塞认证或页面主内容，
 *   新增 JS/渲染/路由 p95 预算与移动端内存上限按 W0 相对基线冻结；1,000 节点下
 *   星图帧率不低于 W0 基线；
 * - 报告环境完整性强制校验（01-5 §16.5 采集要求）：性能数据必须在 W0 指定的
 *   Chrome stable、桌面参考机和中档移动设备/节流档位上采集，冷热路径分开，
 *   单场景样本量至少 100；RC 报告记录硬件、浏览器、构建、数据 fixture、网络
 *   条件和区间，不允许用开发机平均值替代 p95。
 *
 * 冻结常量（阈值/档位/预算）均由 W0 冻结口径定义并可注入——RC 若校准 W0 阈值只
 * 改常量/注入值，不改变判定逻辑。本模块不采集数据，只对注入的样本与报告元数据
 * 做确定性判定。
 *
 * 关联契约（既有模块）：08-4 observability/metrics-schema.ts（R7 分位语义、
 * 重试放大与成本 Gate 同源）、01-5 冻结记录 §16.5/§16.6、07-6 星图两数据平面。
 */

// ─── 版本 ─────────────────────────────────────────────────────────────────

export const CAPACITY_PERF_VERSION = "capacity-perf-v1" as const;

// ─── 1. 容量 fixture 矩阵（冻结档位）──────────────────────────────────────

/** Note 字符数档位：2K / 13K / 50K。 */
export const NOTE_CHARACTER_LEVELS = [2_000, 13_000, 50_000] as const;
/** 每 Card Key Points 档位：1 / 10 / 30。 */
export const CARD_KEY_POINT_LEVELS = [1, 10, 30] as const;
/** 每 Session Episodes 档位：1 / 3 / 5。 */
export const SESSION_EPISODE_LEVELS = [1, 3, 5] as const;
/** 星图节点档位：100 / 1K / 5K。 */
export const STAR_MAP_NODE_LEVELS = [100, 1_000, 5_000] as const;
/** 并发 Session 档位：1 / 5 / 25（RC 容量测试规模，W0 冻结口径）。 */
export const CONCURRENT_SESSION_LEVELS = [1, 5, 25] as const;

/** 单个容量 fixture：五个维度各取一个冻结档位。 */
export interface CapacityFixture {
  /** Note 字符数（2K/13K/50K）。 */
  noteChars: number;
  /** 每 Card Key Points 数（1/10/30）。 */
  keyPointsPerCard: number;
  /** 每 Session Episodes 数（1/3/5）。 */
  episodesPerSession: number;
  /** 星图节点数（100/1K/5K）。 */
  starMapNodes: number;
  /** 并发 Session 数（1/5/25）。 */
  concurrentSessions: number;
}

/** 冻结档位笛卡尔积：3×3×3×3×3 = 243 个 fixture 组合（确定性，生成一次缓存）。 */
export const CAPACITY_FIXTURES: readonly CapacityFixture[] = (() => {
  const fixtures: CapacityFixture[] = [];
  for (const noteChars of NOTE_CHARACTER_LEVELS) {
    for (const keyPointsPerCard of CARD_KEY_POINT_LEVELS) {
      for (const episodesPerSession of SESSION_EPISODE_LEVELS) {
        for (const starMapNodes of STAR_MAP_NODE_LEVELS) {
          for (const concurrentSessions of CONCURRENT_SESSION_LEVELS) {
            fixtures.push({
              noteChars,
              keyPointsPerCard,
              episodesPerSession,
              starMapNodes,
              concurrentSessions,
            });
          }
        }
      }
    }
  }
  return fixtures;
})();

/** 容量 fixture 校验：任一维度不在冻结档位 → 违规（返回违规列表；空数组 = 合法）。 */
export function validateCapacityFixture(fixture: CapacityFixture): readonly string[] {
  const problems: string[] = [];
  if (!(NOTE_CHARACTER_LEVELS as readonly number[]).includes(fixture.noteChars)) {
    problems.push(`noteChars=${fixture.noteChars} 不在冻结档位 ${NOTE_CHARACTER_LEVELS.join("/")}`);
  }
  if (!(CARD_KEY_POINT_LEVELS as readonly number[]).includes(fixture.keyPointsPerCard)) {
    problems.push(
      `keyPointsPerCard=${fixture.keyPointsPerCard} 不在冻结档位 ${CARD_KEY_POINT_LEVELS.join("/")}`,
    );
  }
  if (!(SESSION_EPISODE_LEVELS as readonly number[]).includes(fixture.episodesPerSession)) {
    problems.push(
      `episodesPerSession=${fixture.episodesPerSession} 不在冻结档位 ${SESSION_EPISODE_LEVELS.join("/")}`,
    );
  }
  if (!(STAR_MAP_NODE_LEVELS as readonly number[]).includes(fixture.starMapNodes)) {
    problems.push(
      `starMapNodes=${fixture.starMapNodes} 不在冻结档位 ${STAR_MAP_NODE_LEVELS.join("/")}`,
    );
  }
  if (!(CONCURRENT_SESSION_LEVELS as readonly number[]).includes(fixture.concurrentSessions)) {
    problems.push(
      `concurrentSessions=${fixture.concurrentSessions} 不在冻结档位 ${CONCURRENT_SESSION_LEVELS.join("/")}`,
    );
  }
  return problems;
}

/** fixture 是否恰为冻结矩阵成员（五个维度全部命中档位）。 */
export function isFrozenCapacityFixture(fixture: CapacityFixture): boolean {
  return validateCapacityFixture(fixture).length === 0;
}

// ─── 2. 性能门限（W0 冻结，01-5 §16.5）────────────────────────────────────

/** 本地 companion action pointer/key event → 下一帧视觉 commit p95 上限：< 100ms。 */
export const ACTION_TO_FRAME_P95_LIMIT_MS = 100;
/** 已缓存合法 Session plan 后 Scene state transition → 首个可交互帧 p95 上限：< 300ms。 */
export const SCENE_TO_INTERACTIVE_P95_LIMIT_MS = 300;
/** 1,000 节点星图帧率基线（不低于此值；W0 冻结口径，RC 校准只改常量）。 */
export const STAR_MAP_1000_NODES_MIN_FPS = 50;
/** 移动端内存上限（W0 冻结口径默认值；RC 校准只改常量）。 */
export const MOBILE_MEMORY_BUDGET_MB = 300;
/** Global Shell 新增 JS/渲染/路由 p95 相对 W0 基线增量预算（超限优先降级角色）。 */
export const SHELL_P95_DELTA_BUDGET_MS = 200;
/** 移动端内存相对 W0 基线增量预算（与绝对上限共同约束）。 */
export const SHELL_MOBILE_MEMORY_DELTA_BUDGET_MB = 80;
/** 单场景最小样本量（01-5 §16.5：至少 100）。 */
export const MIN_SAMPLES_PER_SCENARIO = 100;

/** 性能场景标识（校验函数与报告共用）。 */
export type PerfScenario =
  | "action_to_frame" // 本地 companion action → 下一帧视觉 commit
  | "scene_to_interactive" // Scene state transition → 首个可交互帧
  | "star_map_fps" // 星图帧率（冻结档位 1000 节点）
  | "shell_js_p95" // Global Shell 新增 JS p95（相对 W0 基线）
  | "shell_render_p95" // 新增渲染 p95（相对 W0 基线）
  | "shell_route_p95"; // 新增路由 p95（相对 W0 基线）

/**
 * 确定性分位数计算（R7 线性插值，Excel PERCENTILE.INC 语义，与 08-4
 * metrics-schema `computePercentile` 同源）。`percentile` 取 0..1（如 0.95）；
 * 空数组返回 0（样本量校验由各 Gate 函数负责，不会静默放行）。
 */
export function computePercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  if (percentile <= 0) return Math.min(...values);
  if (percentile >= 1) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = percentile * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const weight = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * weight;
}

/** p95 便捷函数（01-5 §16.5 全部性能门限以 p95 判定）。 */
export function computeP95(values: readonly number[]): number {
  return computePercentile(values, 0.95);
}

/** 样本量检查（< 100 → 违规；禁止以少量样本替代单场景 ≥100 的要求）。 */
function checkSampleSize(samples: readonly number[], scenario: string): string[] {
  const problems: string[] = [];
  if (samples.length < MIN_SAMPLES_PER_SCENARIO) {
    problems.push(
      `${scenario} 样本量 ${samples.length} 不足 ${MIN_SAMPLES_PER_SCENARIO}（单场景样本量至少 100）`,
    );
  }
  return problems;
}

/**
 * 数据有效性检查（security_review MEDIUM 修复）：样本必须包含正值且非常量。
 * 全零/恒定样本的 p95=0 会导致 fps=Infinity / 恒低于门限而静默放行，
 * 属数据异常而非真实性能证据 → 违规。
 */
function checkSampleValidity(samples: readonly number[], scenario: string): string[] {
  const problems: string[] = [];
  if (samples.length === 0) return problems; // 样本量检查已覆盖
  const hasPositive = samples.some((v) => v > 0);
  if (!hasPositive) {
    problems.push(`${scenario} 样本全部为 0/非正值（数据异常，禁止放行）`);
    return problems;
  }
  const allEqual = samples.every((v) => v === samples[0]);
  if (allEqual) {
    problems.push(`${scenario} 样本为恒定值（零方差，数据异常，禁止放行）`);
  }
  return problems;
}

/**
 * 本地 companion action pointer/key event handler → 下一帧视觉 commit：
 * p95 < 100ms（不含网络/Provider）。样本量不足、数据无效或 p95 越限 → 违规。
 */
export function checkActionToFrameP95(
  samplesMs: readonly number[],
  limitMs = ACTION_TO_FRAME_P95_LIMIT_MS,
): readonly string[] {
  const problems = [...checkSampleSize(samplesMs, "action_to_frame"), ...checkSampleValidity(samplesMs, "action_to_frame")];
  const p95 = computeP95(samplesMs);
  if (p95 >= limitMs) {
    problems.push(`action_to_frame p95=${p95.toFixed(2)}ms 未满足 < ${limitMs}ms 门限`);
  }
  return problems;
}

/**
 * 已收到且缓存合法 Session plan 后，Scene state transition → 首个可交互帧：
 * p95 < 300ms（不含网络/Provider）。样本量不足、数据无效或 p95 越限 → 违规。
 */
export function checkSceneToInteractiveP95(
  samplesMs: readonly number[],
  limitMs = SCENE_TO_INTERACTIVE_P95_LIMIT_MS,
): readonly string[] {
  const problems = [...checkSampleSize(samplesMs, "scene_to_interactive"), ...checkSampleValidity(samplesMs, "scene_to_interactive")];
  const p95 = computeP95(samplesMs);
  if (p95 >= limitMs) {
    problems.push(`scene_to_interactive p95=${p95.toFixed(2)}ms 未满足 < ${limitMs}ms 门限`);
  }
  return problems;
}

/**
 * 星图帧率：冻结档位（100/1K/5K 节点）下帧率不低于 W0 基线。
 * 输入为每帧耗时 ms 样本；p95 帧耗时 ≤ 1000/minFps 等价于 p5 帧率 ≥ minFps。
 * 节点数不在冻结档位、样本量不足或 p95 帧耗时越限 → 违规。
 */
export function checkStarMapFps(
  frameMsSamples: readonly number[],
  nodeCount: number,
  minFps = STAR_MAP_1000_NODES_MIN_FPS,
): readonly string[] {
  const problems: string[] = [];
  if (!(STAR_MAP_NODE_LEVELS as readonly number[]).includes(nodeCount)) {
    problems.push(`星图节点数 ${nodeCount} 不在冻结档位 ${STAR_MAP_NODE_LEVELS.join("/")}`);
  }
  problems.push(...checkSampleSize(frameMsSamples, `star_map_fps(${nodeCount} 节点)`));
  problems.push(...checkSampleValidity(frameMsSamples, `star_map_fps(${nodeCount} 节点)`));
  const frameP95 = computeP95(frameMsSamples);
  const fps = frameP95 > 0 ? 1000 / frameP95 : Infinity;
  if (frameP95 > 0 && fps < minFps) {
    problems.push(
      `星图(${nodeCount} 节点) p95 帧耗时 ${frameP95.toFixed(2)}ms（≈${fps.toFixed(1)}fps）低于 W0 基线 ${minFps}fps`,
    );
  }
  return problems;
}

/**
 * 移动端内存上限：绝对上限 + W0 相对基线增量双重约束。
 * 超过绝对上限或超过相对基线增量 → 违规（超限时优先降级角色而不是延迟主页面）。
 */
export function checkMobileMemoryBudget(
  memoryMb: number,
  baselineMb: number,
  absoluteBudgetMb = MOBILE_MEMORY_BUDGET_MB,
  deltaBudgetMb = SHELL_MOBILE_MEMORY_DELTA_BUDGET_MB,
): readonly string[] {
  const problems: string[] = [];
  if (memoryMb > absoluteBudgetMb) {
    problems.push(`移动端内存 ${memoryMb}MB 超过绝对上限 ${absoluteBudgetMb}MB`);
  }
  const delta = memoryMb - baselineMb;
  if (delta > deltaBudgetMb) {
    problems.push(
      `移动端内存相对 W0 基线增加 ${delta.toFixed(1)}MB 超过预算 ${deltaBudgetMb}MB`,
    );
  }
  return problems;
}

/**
 * Global Shell / auth-surface manifest / 安静锚点不得阻塞认证或页面主内容：
 * 新增 JS/渲染/路由 p95 相对 W0 基线增量不得越过冻结预算（超限优先降级角色）。
 */
export function checkShellP95Delta(
  scenario: Exclude<PerfScenario, "action_to_frame" | "scene_to_interactive" | "star_map_fps">,
  baselineP95Ms: number,
  withShellP95Ms: number,
  deltaBudgetMs = SHELL_P95_DELTA_BUDGET_MS,
): readonly string[] {
  const problems: string[] = [];
  if (baselineP95Ms < 0 || withShellP95Ms < 0) {
    problems.push(`${scenario} 存在负值样本（baseline=${baselineP95Ms}, withShell=${withShellP95Ms}）`);
    return problems;
  }
  const delta = withShellP95Ms - baselineP95Ms;
  if (delta > deltaBudgetMs) {
    problems.push(
      `${scenario} p95 相对 W0 基线增加 ${delta.toFixed(2)}ms 超过预算 ${deltaBudgetMs}ms`,
    );
  }
  return problems;
}

// ─── 3. 报告环境完整性（01-5 §16.5 采集要求，强制）────────────────────────

/** 采集设备来源（禁止用开发机数据替代参考机/中档移动设备采集）。 */
export type PerfDataSource = "reference_desktop" | "midrange_mobile" | "dev_machine";

/** 冷热路径分离状态（必须分开采集）。 */
export type PerfHotCold = "separated" | "mixed" | "hot_only" | "cold_only";

/** RC 性能报告环境元数据（每条 Gate 样本都必须附带并校验）。 */
export interface PerfReportEnv {
  /** 硬件描述（桌面参考机 / 中档移动设备型号与配置）。 */
  hardware: string;
  /** 浏览器（必须为 Chrome stable；允许带具体版本号）。 */
  browser: string;
  /** 构建标识（commit/version/build id）。 */
  build: string;
  /** 数据 fixture（必须命中冻结档位矩阵）。 */
  fixture: CapacityFixture;
  /** 网络条件（离线/节流档位等；注意性能测量不含网络，仍需记录）。 */
  network: string;
  /** 区间（必须包含 p95 标识与数值区间）。 */
  interval: string;
  /** 单场景样本量（≥100）。 */
  sampleCount: number;
  /** 冷热路径分离状态（必须 separated）。 */
  hotCold: PerfHotCold;
  /** 数据来源（禁止 dev_machine）。 */
  dataSource: PerfDataSource;
  /** 上报聚合口径（必须为 p95，禁止用开发机平均值替代 p95）。 */
  aggregate: "p95" | "mean" | "other";
}

/**
 * 报告环境完整性校验（强制）：任何一项缺失/违规 → 返回对应违规。
 * - 硬件、构建、网络、区间必须非空且记录完整；
 * - 浏览器必须为 Chrome stable；
 * - fixture 必须命中冻结档位矩阵；
 * - 区间必须含 p95；
 * - 样本量 ≥ 100；
 * - 冷热路径分开（hotCold = separated）；
 * - 数据来源禁止开发机（dev_machine）；
 * - 聚合口径必须为 p95（禁止平均值替代 p95）。
 */
export function validatePerfReportEnv(env: PerfReportEnv): readonly string[] {
  const problems: string[] = [];
  if (env.hardware.trim() === "") {
    problems.push("报告缺少硬件记录（RC 报告必须记录硬件）");
  }
  const browser = env.browser.toLowerCase();
  if (!browser.includes("chrome") || !browser.includes("stable")) {
    problems.push(`浏览器必须为 Chrome stable（实际 "${env.browser}"）`);
  }
  if (env.build.trim() === "") {
    problems.push("报告缺少构建标识（RC 报告必须记录构建）");
  }
  problems.push(...validateCapacityFixture(env.fixture));
  if (env.network.trim() === "") {
    problems.push("报告缺少网络条件记录（RC 报告必须记录网络条件）");
  }
  if (env.interval.trim() === "" || !env.interval.toLowerCase().includes("p95")) {
    problems.push(`报告缺少 p95 区间（RC 报告必须记录区间；实际 "${env.interval}"）`);
  }
  if (env.sampleCount < MIN_SAMPLES_PER_SCENARIO) {
    problems.push(`样本量 ${env.sampleCount} 不足 ${MIN_SAMPLES_PER_SCENARIO}（单场景样本量至少 100）`);
  }
  if (env.hotCold !== "separated") {
    problems.push(`冷热路径必须分开采集（实际 ${env.hotCold}）`);
  }
  if (env.dataSource === "dev_machine") {
    problems.push("禁止用开发机数据替代 W0 指定参考机/中档移动设备采集");
  }
  if (env.aggregate !== "p95") {
    problems.push(`禁止用平均值替代 p95（实际聚合口径 ${env.aggregate}）`);
  }
  return problems;
}

// ─── 4. 汇总报告 ─────────────────────────────────────────────────────────

/** 单个性能场景的 Gate 判定。 */
export interface PerfScenarioGate {
  scenario: PerfScenario;
  sampleCount: number;
  p95: number;
  passed: boolean;
  violations: readonly string[];
}

/** 容量与性能 RC 汇总报告（纯函数产出）。 */
export interface CapacityPerfReport {
  version: typeof CAPACITY_PERF_VERSION;
  fixturesTotal: number;
  envValidated: boolean;
  envViolations: readonly string[];
  scenarioGates: readonly PerfScenarioGate[];
  memoryViolations: readonly string[];
  shellDeltaViolations: readonly string[];
  /** 全部环境、门限、内存与相对预算校验通过。 */
  allPassed: boolean;
}

/** 容量/性能 RC 输入（由采集 harness 注入；本模块只做确定性判定）。 */
export interface CapacityPerfInput {
  env: PerfReportEnv;
  /** 本地 companion action → 下一帧视觉 commit 样本（ms）。 */
  actionToFrameMs: readonly number[];
  /** Scene state transition → 首个可交互帧样本（ms）。 */
  sceneToInteractiveMs: readonly number[];
  /** 星图每帧耗时样本（ms）。 */
  starMapFrameMs: readonly number[];
  /** 星图节点数（冻结档位 100/1K/5K）。 */
  starMapNodeCount: number;
  /** 移动端采集时的内存（MB）与 W0 基线（MB）；缺省跳过内存 Gate。 */
  mobileMemoryMb?: number;
  mobileMemoryBaselineMb?: number;
  /** Global Shell 新增 JS/渲染/路由 p95 相对 W0 基线（ms）；缺省跳过。 */
  shellDeltaBaselineP95Ms?: number;
  shellDeltaWithShellP95Ms?: number;
}

/** 汇总判定：环境完整性 + 全部 p95/帧率门限 + 内存 + Shell 相对预算。 */
export function evaluateCapacityPerf(input: CapacityPerfInput): CapacityPerfReport {
  const envViolations = validatePerfReportEnv(input.env);

  const scenarioGates: PerfScenarioGate[] = [
    {
      scenario: "action_to_frame",
      sampleCount: input.actionToFrameMs.length,
      p95: computeP95(input.actionToFrameMs),
      violations: checkActionToFrameP95(input.actionToFrameMs),
      passed: checkActionToFrameP95(input.actionToFrameMs).length === 0,
    },
    {
      scenario: "scene_to_interactive",
      sampleCount: input.sceneToInteractiveMs.length,
      p95: computeP95(input.sceneToInteractiveMs),
      violations: checkSceneToInteractiveP95(input.sceneToInteractiveMs),
      passed: checkSceneToInteractiveP95(input.sceneToInteractiveMs).length === 0,
    },
    {
      scenario: "star_map_fps",
      sampleCount: input.starMapFrameMs.length,
      p95: computeP95(input.starMapFrameMs),
      violations: checkStarMapFps(input.starMapFrameMs, input.starMapNodeCount),
      passed: checkStarMapFps(input.starMapFrameMs, input.starMapNodeCount).length === 0,
    },
  ];

  const memoryViolations =
    input.mobileMemoryMb !== undefined && input.mobileMemoryBaselineMb !== undefined
      ? checkMobileMemoryBudget(input.mobileMemoryMb, input.mobileMemoryBaselineMb)
      : [];

  const shellDeltaViolations: string[] = [];
  if (input.shellDeltaBaselineP95Ms !== undefined && input.shellDeltaWithShellP95Ms !== undefined) {
    for (const scenario of ["shell_js_p95", "shell_render_p95", "shell_route_p95"] as const) {
      shellDeltaViolations.push(
        ...checkShellP95Delta(scenario, input.shellDeltaBaselineP95Ms, input.shellDeltaWithShellP95Ms),
      );
    }
  }

  const allPassed =
    envViolations.length === 0 &&
    scenarioGates.every((g) => g.passed) &&
    memoryViolations.length === 0 &&
    shellDeltaViolations.length === 0;

  return {
    version: CAPACITY_PERF_VERSION,
    fixturesTotal: CAPACITY_FIXTURES.length,
    envValidated: envViolations.length === 0,
    envViolations,
    scenarioGates,
    memoryViolations,
    shellDeltaViolations,
    allPassed,
  };
}
