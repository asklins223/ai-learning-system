/**
 * 阶段 08（W7）任务 08-4：可观测性指标 schema（§16.4 / §16.6）。
 *
 * 本文件是**纯逻辑**（无 DB / 无网络 / 无时钟 / 无副作用 / 无随机）：把冻结记录
 * 01-5 §16.4（产品与价值观指标）与 §16.6（成本与调用放大 Gate）翻译成确定性
 * 指标定义表与计算/校验函数。dashboard、alerts、runbook 只消费本 schema 的枚举、
 * 定义表与纯函数，不自行定义指标语义。
 *
 * 分类（与冻结记录一一对应）：
 * - `observation`：§16.4 §5.1「观察但不作为强迫优化目标」——首次引导分布、召唤/
 *   建议采纳、无键盘、模态、存在感、路线、问题标记、recall/rubric/迁移、Tutor
 *   反馈、ASR；
 * - `observe-only`：§16.4 §5.2「只观察、不得用于授权强迫优化」——onboarding 完成率、
 *   伴星打开时长、对话轮数、留存、DAU、学习时长、完成数量；
 * - `cost`：§16.6 成本与调用放大监控——每 Episode/Session 的 LLM 调用/token/ASR 秒/
 *   TTS 字符/对象存储/Tutor 独立预算，用户级 p50/p95，重试放大系数；
 * - `hard-gate`：§16.4 §5.3 自主性硬 Gate 与 §16.6 成本硬 Gate 的观测对照项——
 *   hidden/off 后新增成本 0、取消确认后新增调用 0、Tutor 不借用 formal 预算、
 *   重试放大系数上限、p95 成本上限。
 *
 * 观察 vs 硬 Gate 分离：`checkCoerciveAuthorization` 对任何非 hard-gate 指标授权
 * 强迫优化手段（隐藏跳过 / 增加弹窗 / streak / 任务债务 / 自动续题 / 伴侣催促）
 * 一律判违规；`assertObservationOnlyMetric` 对 observe-only 指标 fail closed。
 */

// ─── 1. 分类与枚举 ────────────────────────────────────────────────────────

/** 指标分类（观察 / 只观察 / 成本 / 硬 Gate）。 */
export type MetricCategory =
  | "observation" // §16.4 §5.1：观察但不作为强迫优化目标
  | "observe-only" // §16.4 §5.2：只观察、不得用于授权强迫优化
  | "cost" // §16.6：成本与调用放大监控（观察 + 上限）
  | "hard-gate"; // §16.4 §5.3 + §16.6：0 容忍 / 冻结上限硬 Gate

/** 指标所属产品域。 */
export type MetricGroup =
  | "onboarding"
  | "invocation"
  | "keyboard"
  | "modality"
  | "presence"
  | "route"
  | "question_flag"
  | "learning_outcome"
  | "tutor_feedback"
  | "asr"
  | "observe_only_product"
  | "cost";

/** 指标值形态。 */
export type MetricKind =
  | "distribution" // 多桶分布
  | "ratio" // 比例（0..1 或百分比）
  | "count"
  | "duration"
  | "tokens"
  | "seconds"
  | "characters"
  | "bytes"
  | "budget"
  | "percentile"
  | "factor"
  | "gate-zero" // 0 容忍硬 Gate 观测项
  | "gate-cap"; // 冻结上限硬 Gate 观测项

/** 指标统计口径（观测粒度）。 */
export type MetricScope =
  | "per-user"
  | "per-session"
  | "per-episode"
  | "per-route"
  | "per-page-kind";

/**
 * §16.4 §5.2 明令禁止被观察指标授权的强迫优化手段（W0 冻结，不允许新增/改名）：
 * 隐藏跳过、增加弹窗、streak、任务债务、自动续题、伴侣催促。
 */
export const COERCIVE_MECHANISMS = [
  "hide_skip", // 隐藏/弱化「跳过」入口
  "extra_modal", // 增加弹窗
  "streak", // 连续打卡激励
  "task_debt", // 任务债务
  "auto_advance", // 完成后自动进入下一题/路线
  "companion_nudge", // 伴侣催促
] as const;
export type CoerciveMechanism = (typeof COERCIVE_MECHANISMS)[number];

/** 类型守卫：字符串是否为合法强迫优化手段。 */
export function isCoerciveMechanism(value: string): value is CoerciveMechanism {
  return (COERCIVE_MECHANISMS as readonly string[]).includes(value);
}

// ─── 2. 指标定义表（冻结）─────────────────────────────────────────────────

interface BaseMetricDefinition {
  id: string;
  group: MetricGroup;
  category: MetricCategory;
  kind: Exclude<MetricKind, "distribution">;
  scope: MetricScope;
  description: string;
}

interface DistributionMetricDefinition {
  id: string;
  group: MetricGroup;
  category: MetricCategory;
  kind: "distribution";
  scope: MetricScope;
  description: string;
  /** 冻结的桶名（顺序即显示顺序；不允许运行时新增桶）。 */
  buckets: readonly string[];
}

export type MetricDefinition = BaseMetricDefinition | DistributionMetricDefinition;

/** 冻结指标定义表：dashboard/runbook 的唯一指标字典（确定性、只读）。 */
export const metricDefinitions = [
  // ── §16.4 §5.1 observation：onboarding ──
  { id: "onboarding_started", group: "onboarding", category: "observation", kind: "distribution", scope: "per-user", description: "首次引导开始分布（offer 后进入 run）", buckets: ["started", "skipped", "paused", "resumed", "replayed"] } satisfies DistributionMetricDefinition,
  { id: "onboarding_first_meaningful_action_ratio", group: "onboarding", category: "observation", kind: "ratio", scope: "per-user", description: "引导后用户独立完成第一个有意义动作的比例" } satisfies BaseMetricDefinition,

  // ── §16.4 §5.1 observation：召唤/建议（按 route/page kind）──
  { id: "companion_summoned", group: "invocation", category: "observation", kind: "distribution", scope: "per-page-kind", description: "主动召唤 / 建议采纳 / 忽略 / 立即隐藏 / manual fallback 分布", buckets: ["summoned", "suggestion_adopted", "suggestion_ignored", "immediately_hidden", "manual_fallback"] } satisfies DistributionMetricDefinition,

  // ── §16.4 §5.1 observation：无键盘 / 模态 / 存在感 ──
  { id: "no_keyboard_session_ratio", group: "keyboard", category: "observation", kind: "ratio", scope: "per-session", description: "无键盘完成的 Session 占比" } satisfies BaseMetricDefinition,
  { id: "modality_distribution", group: "modality", category: "observation", kind: "distribution", scope: "per-user", description: "语音 / 触控 / 文字 / 混合模态分布", buckets: ["voice", "touch", "text", "mixed"] } satisfies DistributionMetricDefinition,
  { id: "presence_distribution", group: "presence", category: "observation", kind: "distribution", scope: "per-user", description: "伴星安静 / 适度 / 主动设置分布", buckets: ["quiet", "moderate", "active"] } satisfies DistributionMetricDefinition,
  { id: "presence_turn_off_rate", group: "presence", category: "observation", kind: "ratio", scope: "per-user", description: "存在感关闭率（temporary_hidden / global_off 应用比例）" } satisfies BaseMetricDefinition,

  // ── §16.4 §5.1 observation：路线 ──
  { id: "route_disposition_distribution", group: "route", category: "observation", kind: "distribution", scope: "per-route", description: "路线主动停止 / 缩短 / 换一组 / 完成比例", buckets: ["active_stop", "shortened", "switched_group", "completed"] } satisfies DistributionMetricDefinition,

  // ── §16.4 §5.1 observation：问题标记（Should flag 启用时）──
  { id: "question_flag_disposition_distribution", group: "question_flag", category: "observation", kind: "distribution", scope: "per-user", description: "问题标记保存 / 解决 / 丢弃比例（Should）", buckets: ["saved", "resolved", "discarded"] } satisfies DistributionMetricDefinition,

  // ── §16.4 §5.1 observation：后续学习成效 ──
  { id: "subsequent_independent_recall", group: "learning_outcome", category: "observation", kind: "ratio", scope: "per-user", description: "后续独立 recall（无协助完成率）" } satisfies BaseMetricDefinition,
  { id: "post_repair_same_rubric_miss_rate", group: "learning_outcome", category: "observation", kind: "ratio", scope: "per-user", description: "修补后同类 rubric 缺失率" } satisfies BaseMetricDefinition,
  { id: "transfer_task_success_rate", group: "learning_outcome", category: "observation", kind: "ratio", scope: "per-user", description: "迁移任务成功率" } satisfies BaseMetricDefinition,

  // ── §16.4 §5.1 observation：Tutor 显式反馈 ──
  { id: "tutor_feedback_distribution", group: "tutor_feedback", category: "observation", kind: "distribution", scope: "per-user", description: "Grounded Tutor 回答有帮助 / 没帮助显式反馈", buckets: ["helpful", "not_helpful"] } satisfies DistributionMetricDefinition,

  // ── §16.4 §5.1 observation：ASR ──
  { id: "asr_not_assessable_rate", group: "asr", category: "observation", kind: "ratio", scope: "per-session", description: "ASR 关键内容不可辨时进入 not_assessable 的比例" } satisfies BaseMetricDefinition,
  { id: "modality_switch_rate", group: "asr", category: "observation", kind: "ratio", scope: "per-session", description: "ASR 失败/低置信后用户切换模态的比例" } satisfies BaseMetricDefinition,

  // ── §16.4 §5.2 observe-only：只观察、不得授权强迫优化 ──
  { id: "onboarding_completion_rate", group: "observe_only_product", category: "observe-only", kind: "ratio", scope: "per-user", description: "onboarding 完成率（只观察）" } satisfies BaseMetricDefinition,
  { id: "companion_open_duration", group: "observe_only_product", category: "observe-only", kind: "duration", scope: "per-session", description: "伴星打开时长（只观察）" } satisfies BaseMetricDefinition,
  { id: "conversation_turns", group: "observe_only_product", category: "observe-only", kind: "count", scope: "per-session", description: "对话轮数（只观察）" } satisfies BaseMetricDefinition,
  { id: "retention", group: "observe_only_product", category: "observe-only", kind: "ratio", scope: "per-user", description: "留存（只观察）" } satisfies BaseMetricDefinition,
  { id: "dau", group: "observe_only_product", category: "observe-only", kind: "count", scope: "per-user", description: "DAU（只观察）" } satisfies BaseMetricDefinition,
  { id: "learning_duration", group: "observe_only_product", category: "observe-only", kind: "duration", scope: "per-session", description: "学习时长（只观察）" } satisfies BaseMetricDefinition,
  { id: "completions_count", group: "observe_only_product", category: "observe-only", kind: "count", scope: "per-user", description: "完成数量（只观察）" } satisfies BaseMetricDefinition,

  // ── §16.6 cost：每 Episode/Session 成本 ──
  { id: "llm_calls_per_episode", group: "cost", category: "cost", kind: "count", scope: "per-episode", description: "每 Episode 的 LLM 调用数" } satisfies BaseMetricDefinition,
  { id: "llm_input_tokens_per_episode", group: "cost", category: "cost", kind: "tokens", scope: "per-episode", description: "每 Episode 的 LLM 输入 token 数" } satisfies BaseMetricDefinition,
  { id: "llm_output_tokens_per_episode", group: "cost", category: "cost", kind: "tokens", scope: "per-episode", description: "每 Episode 的 LLM 输出 token 数" } satisfies BaseMetricDefinition,
  { id: "asr_seconds_per_session", group: "cost", category: "cost", kind: "seconds", scope: "per-session", description: "每 Session 的 ASR 秒数" } satisfies BaseMetricDefinition,
  { id: "tts_characters_per_session", group: "cost", category: "cost", kind: "characters", scope: "per-session", description: "每 Session 的 TTS 字符数" } satisfies BaseMetricDefinition,
  { id: "object_storage_bytes_per_episode", group: "cost", category: "cost", kind: "bytes", scope: "per-episode", description: "每 Episode 的对象存储字节数" } satisfies BaseMetricDefinition,
  { id: "tutor_budget_per_episode", group: "cost", category: "cost", kind: "budget", scope: "per-episode", description: "current-target Tutor 独立预算消耗" } satisfies BaseMetricDefinition,
  { id: "user_cost_p50", group: "cost", category: "cost", kind: "percentile", scope: "per-user", description: "用户级 p50 成本" } satisfies BaseMetricDefinition,
  { id: "user_cost_p95", group: "cost", category: "cost", kind: "percentile", scope: "per-user", description: "用户级 p95 成本（冻结上限，超限停止扩量）" } satisfies BaseMetricDefinition,
  { id: "retry_amplification_factor", group: "cost", category: "cost", kind: "factor", scope: "per-user", description: "重试放大系数（计费调用 / 唯一请求）" } satisfies BaseMetricDefinition,

  // ── §16.4 §5.3 + §16.6 hard-gate：观测对照项（0 容忍 / 冻结上限）──
  { id: "hidden_off_zero_new_cost", group: "cost", category: "hard-gate", kind: "gate-zero", scope: "per-user", description: "hidden/off 确认后新增 Companion 成本必须为 0" } satisfies BaseMetricDefinition,
  { id: "cancel_confirmed_zero_new_calls", group: "cost", category: "hard-gate", kind: "gate-zero", scope: "per-user", description: "用户取消被服务端确认后新增 LLM/ASR/TTS/对象存储调用必须为 0" } satisfies BaseMetricDefinition,
  { id: "tutor_formal_budget_isolation", group: "cost", category: "hard-gate", kind: "gate-zero", scope: "per-episode", description: "Tutor 不得消耗或借用 formal assessment 预算" } satisfies BaseMetricDefinition,
  { id: "retry_amplification_cap", group: "cost", category: "hard-gate", kind: "gate-cap", scope: "per-user", description: "重试放大系数上限（W0 冻结，RC 故障注入验证）" } satisfies BaseMetricDefinition,
  { id: "p95_cost_cap", group: "cost", category: "hard-gate", kind: "gate-cap", scope: "per-user", description: "p95 成本上限（超限停止扩量，不得缩减 Critic/证据/A11y 绕过）" } satisfies BaseMetricDefinition,
] as const satisfies readonly MetricDefinition[];

export type MetricId = (typeof metricDefinitions)[number]["id"];

/** 类型守卫：字符串是否为合法冻结指标 id。 */
export function isMetricId(value: string): value is MetricId {
  return metricDefinitions.some((def) => def.id === value);
}

/** 取指标定义；未知 id 返回 undefined（fail closed 由调用方决定）。 */
export function getMetricDefinition(metricId: string): MetricDefinition | undefined {
  return metricDefinitions.find((def) => def.id === metricId);
}

/** 指标类型校验：id 合法且定义结构完整（确定性，供 schema 自检与 dashboard 消费）。 */
export function validateMetricId(metricId: string): readonly string[] {
  const def = getMetricDefinition(metricId);
  if (def === undefined) {
    return [`unknown metric id: ${metricId}`];
  }
  const problems: string[] = [];
  if (def.id === "") problems.push(`metric ${metricId}: empty id`);
  if (def.category === "observation" && def.group === "observe_only_product") {
    problems.push(`metric ${metricId}: observation 指标不得放入 observe_only_product 组`);
  }
  if (def.category === "observe-only" && def.group !== "observe_only_product") {
    problems.push(`metric ${metricId}: observe-only 指标必须放在 observe_only_product 组`);
  }
  if (def.kind === "distribution" && (!("buckets" in def) || def.buckets.length === 0)) {
    problems.push(`metric ${metricId}: distribution 指标缺少非空 buckets`);
  }
  return problems;
}

/**
 * 冻结指标自检：对整个定义表做确定性校验（供测试/CI 调用，任何未知 id、
 * 分类/分组错配或空 buckets 都返回违规）。空数组 = 全表合法。
 */
export function validateMetricSchema(): readonly string[] {
  return metricDefinitions.flatMap((def) => validateMetricId(def.id));
}

// ─── 3. 观察 vs 硬 Gate 分离（§16.4 §5.2 + §16.6）────────────────────────

/**
 * 检查是否给指标授权了强迫优化手段。任何非 hard-gate 指标（observation /
 * observe-only / cost）被授权任意 coercion 即判违规——观察指标只能「看」，
 * 不能授权隐藏跳过、增加弹窗、streak、任务债务、自动续题或伴侣催促。
 * 返回违规列表（空数组 = 通过）。确定性、无副作用。
 */
export function checkCoerciveAuthorization(
  metricId: string,
  authorizedCoercions: readonly string[],
): readonly string[] {
  const def = getMetricDefinition(metricId);
  if (def === undefined) {
    return [`unknown metric id: ${metricId}`];
  }
  if (def.category === "hard-gate") {
    // 硬 Gate 本身就是禁止机制，不存在「授权强迫优化」语义。
    return [];
  }
  const invalid = authorizedCoercions.filter((c) => !isCoerciveMechanism(c));
  const applied = authorizedCoercions.filter((c) => isCoerciveMechanism(c));
  const problems: string[] = [];
  if (invalid.length > 0) {
    problems.push(`metric ${metricId}: 未知强迫优化手段 ${invalid.join(", ")}`);
  }
  if (applied.length > 0) {
    problems.push(
      `metric ${metricId} (${def.category}) 是观察指标，不得授权强迫优化: ${applied.join(", ")}`,
    );
  }
  return problems;
}

/**
 * §16.4 §5.2 fail closed 断言：observe-only 指标永远不得被授权任何强迫优化。
 * 违规即抛 MetricSchemaError（供 dashboard 配置/runbook 校验调用）。
 */
export function assertObservationOnlyMetric(metricId: string): void {
  const def = getMetricDefinition(metricId);
  if (def === undefined) {
    throw new MetricSchemaError(`unknown metric id: ${metricId}`);
  }
  if (def.category !== "observe-only") {
    throw new MetricSchemaError(
      `metric ${metricId} 不是 observe-only 指标（实际 ${def.category}），不可作为只观察口径注册`,
    );
  }
}

/** Schema 校验错误（fail closed）。 */
export class MetricSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricSchemaError";
  }
}

// ─── 4. 分布 / 比例计算（确定性纯函数）────────────────────────────────────

/**
 * 对冻结的 distribution 指标校验并归一化桶计数。`counts` 顺序必须与定义表
 * `buckets` 一致、非负。返回 { ok, normalized }，normalized 总和为 1（确定性）。
 */
export function normalizeDistribution(
  metricId: string,
  counts: readonly number[],
): { ok: boolean; problems: readonly string[]; normalized: readonly number[] } {
  const def = getMetricDefinition(metricId);
  if (def === undefined) {
    return { ok: false, problems: [`unknown metric id: ${metricId}`], normalized: [] };
  }
  if (def.kind !== "distribution") {
    return {
      ok: false,
      problems: [`metric ${metricId} 不是 distribution 指标（实际 ${def.kind}）`],
      normalized: [],
    };
  }
  const problems: string[] = [];
  const expected = def.buckets.length;
  if (counts.length !== expected) {
    problems.push(`metric ${metricId} 桶数不符：期望 ${expected}，实际 ${counts.length}`);
  }
  if (counts.some((c) => c < 0)) {
    problems.push(`metric ${metricId} 存在负计数`);
  }
  if (problems.length > 0) {
    return { ok: false, problems, normalized: [] };
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const normalized = total > 0 ? counts.map((c) => c / total) : counts.map(() => 0);
  return { ok: true, problems: [], normalized };
}

/** 比例计算（0..1）；分母为 0 时确定性返回 0。 */
export function computeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

// ─── 5. 成本与调用放大（§16.6）────────────────────────────────────────────

/** 单次 Episode/Session 的成本样本（与 01-5 §16.6 冻结维度一一对应）。 */
export interface CostSample {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  asrSeconds: number;
  ttsCharacters: number;
  objectStorageBytes: number;
  tutorBudgetUnits: number;
}

/** 成本维度 key（用于用户级分位计算）。 */
export type CostDimension =
  | "llmCalls"
  | "inputTokens"
  | "outputTokens"
  | "asrSeconds"
  | "ttsCharacters"
  | "objectStorageBytes"
  | "tutorBudgetUnits";

export const COST_DIMENSIONS: readonly CostDimension[] = [
  "llmCalls",
  "inputTokens",
  "outputTokens",
  "asrSeconds",
  "ttsCharacters",
  "objectStorageBytes",
  "tutorBudgetUnits",
];

/** 零成本样本（hidden/off 后必须与之一致）。 */
export const ZERO_COST: CostSample = {
  llmCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  asrSeconds: 0,
  ttsCharacters: 0,
  objectStorageBytes: 0,
  tutorBudgetUnits: 0,
};

/** 聚合多个成本样本（每 Session/Episode 汇总；确定性、纯函数）。 */
export function sumCostSamples(samples: readonly CostSample[]): CostSample {
  return samples.reduce<CostSample>(
    (acc, s) => ({
      llmCalls: acc.llmCalls + s.llmCalls,
      inputTokens: acc.inputTokens + s.inputTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
      asrSeconds: acc.asrSeconds + s.asrSeconds,
      ttsCharacters: acc.ttsCharacters + s.ttsCharacters,
      objectStorageBytes: acc.objectStorageBytes + s.objectStorageBytes,
      tutorBudgetUnits: acc.tutorBudgetUnits + s.tutorBudgetUnits,
    }),
    { ...ZERO_COST },
  );
}

/** 样本是否为全零成本（hidden/off 后必须为 true）。 */
export function isZeroCost(sample: CostSample): boolean {
  return COST_DIMENSIONS.every((dim) => sample[dim] === 0);
}

/**
 * 确定性分位数计算（R7 线性插值，Excel PERCENTILE.INC 语义）。
 * `percentile` 取 0..1（如 0.5 = p50，0.95 = p95）；空数组返回 0。
 * 无随机、无时钟；同一输入恒得同一输出。
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

/** 用户级 p50/p95 成本：输入每个用户的成本样本，对指定维度算分位。 */
export function computeUserCostPercentile(
  userCosts: readonly CostSample[],
  dimension: CostDimension,
  percentile: number,
): number {
  return computePercentile(
    userCosts.map((c) => c[dimension]),
    percentile,
  );
}

/**
 * 重试放大系数 = 计费调用数 / 唯一请求数（§16.6：同一 provider/job attempt
 * 的重复计费调用为 0；系数上限 W0 冻结）。唯一请求为 0 时确定性返回 0。
 */
export function computeRetryAmplification(
  uniqueRequests: number,
  billedCalls: number,
): number {
  if (!Number.isFinite(uniqueRequests) || !Number.isFinite(billedCalls) || uniqueRequests <= 0) {
    return 0;
  }
  if (billedCalls < 0) return 0;
  return billedCalls / uniqueRequests;
}

/** 检查重试放大系数是否在冻结上限内（上限可注入，W0 冻结默认 1.5，RC 故障注入验证）。 */
export function checkRetryAmplificationUnderCap(
  uniqueRequests: number,
  billedCalls: number,
  cap = DEFAULT_RETRY_AMPLIFICATION_CAP,
): readonly string[] {
  const factor = computeRetryAmplification(uniqueRequests, billedCalls);
  if (factor > cap) {
    return [
      `重试放大系数 ${factor.toFixed(3)} 超过冻结上限 ${cap}（unique=${uniqueRequests}, billed=${billedCalls})`,
    ];
  }
  return [];
}

/**
 * 重试放大系数默认上限（W0 冻结口径，01-5 §16.6「重试放大系数上限在 W0 冻结并由
 * RC 故障注入验证」）。数值可经 RC 故障注入校准，但只能改常量，不能改判定逻辑。
 */
export const DEFAULT_RETRY_AMPLIFICATION_CAP = 1.5;

/**
 * §16.6 硬 Gate：`temporary_hidden/global_off` 确认后新增 Companion 成本必须为 0。
 * 输入 hidden/off 确认后仍发生的全部成本样本，任一维度 > 0 即违规（返回违规列表；
 * 空数组 = 通过）。用户取消被服务端确认后的新增调用同样为 0（`kind` 区分语义）。
 */
export function checkHiddenOffZeroNewCost(
  callsAfterHiddenOff: readonly CostSample[],
  kind: "hidden_off" | "cancel_confirmed" = "hidden_off",
): readonly string[] {
  const total = sumCostSamples(callsAfterHiddenOff);
  if (isZeroCost(total)) return [];
  const label = kind === "hidden_off" ? "hidden/off 确认后" : "用户取消确认后";
  const offenders = COST_DIMENSIONS.filter((dim) => total[dim] > 0)
    .map((dim) => `${dim}=${total[dim]}`);
  return [`${label}新增成本必须为 0，实际 ${offenders.join(", ")}`];
}

/**
 * §16.6 硬 Gate：Tutor detour 使用独立 envelope，不得消耗或借用 formal assessment
 * 预算。`tutorSpend` 为 Tutor 独立预算消耗，`borrowedFromFormal` 为借用 formal
 * reserve 的额度（必须为 0）。
 */
export function checkTutorFormalBudgetIsolation(
  tutorSpend: CostSample,
  borrowedFromFormal: number,
): readonly string[] {
  const problems: string[] = [];
  if (borrowedFromFormal > 0) {
    problems.push(`Tutor 借用 formal assessment 预算 ${borrowedFromFormal}，必须为 0`);
  }
  if (COST_DIMENSIONS.some((dim) => tutorSpend[dim] < 0)) {
    problems.push("Tutor 独立预算样本存在负维度");
  }
  return problems;
}

/**
 * p95 成本上限：任一 p95 成本越过冻结上限即违规（停止扩量，不能靠缩减 Critic、
 * 证据或 A11y 绕过）。上限按维度注入（W0 冻结）；`metricOverride` 为 true 表示
 * 曾尝试以缩减质量项绕过的上报（一律违规）。
 */
export function checkP95CostCap(
  userCosts: readonly CostSample[],
  caps: Partial<Record<CostDimension, number>>,
  metricOverrideReported = false,
): readonly string[] {
  const problems: string[] = [];
  for (const dim of COST_DIMENSIONS) {
    const cap = caps[dim];
    if (cap === undefined || cap < 0) continue;
    const p95 = computeUserCostPercentile(userCosts, dim, 0.95);
    if (p95 > cap) {
      problems.push(`p95 ${dim}=${p95} 超过冻结上限 ${cap}`);
    }
  }
  if (metricOverrideReported) {
    problems.push("检测到以缩减 Critic/证据/A11y 绕过成本上限的上报");
  }
  return problems;
}
