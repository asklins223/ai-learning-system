/**
 * LearningRun 确定性 Task Planner（文档 16 §12/§13 P2 纵切版）。
 *
 * V1 首发（§7.7）：open_text / open_voice 上限 mastery_eligible，且由
 * 服务端在用户作答前冻结 purpose/ceiling——这里不调用模型，用确定性模板
 * 从 canonical 输入生成题面与 Variant，全部 hash 闭包可重放。
 *
 * 明确不做：动态生成结构题（需独立 Scene/Task Critic）、按上次答案正文
 * 定制题面（§7.8 禁止拼接答案正文）。P2 只提供 text/voice 两类 interaction。
 */

import { sha256Hex } from "@ailearn/shared/content-hash";
import type {
  PrivateTaskSolutionV1,
  StructuredPartPublicV1,
  TaskInteractionV1,
} from "@ailearn/shared";
import { generateChoiceTask, generateMatchingTask, generateOrderingFromUnits, generateStructuredBundleTask, generateStructuredTask, generateStructuredFromSnapshot, generateTrueFalseTask, type StructuredBundlePayload, type StructuredTargetInput, type StructuredTaskPayload } from "./run-structured.ts";
import type {
  CanonicalAnswerV2,
  ObjectiveRelationV2,
  PracticeItemV2,
  ObjectiveRubricV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import { practiceItemCrossRefError } from "@ailearn/shared/card-generation-v2-contracts";
import type {
  LearningTargetSnapshotV2,
  TaskIntentV1,
} from "@ailearn/shared";

/**
 * §16.4 V2 planner 目标：只从 frozen snapshot 消费。public 题面用
 * objectiveStatement（公开卡片前端内容），canonicalAnswer/scoringRubric 是
 * private 评估参照，绝不进入 public payload。
 */
export interface PlannerV2Target {
  /** 公开 cue（卡片前端 objective statement）。 */
  objectiveStatement: string;
  publicSummary: string;
  knowledgeForm: LearningTargetSnapshotV2["target"]["knowledgeForm"];
  preferredIntents: TaskIntentV1[];
  canonicalAnswer: CanonicalAnswerV2;
  scoringRubric: ObjectiveRubricV2;
  relations: ObjectiveRelationV2[];
  /**
   * 0245：作者产出的客观练习件（选择 / 判断 / 排序 / 配对）。null = 这张卡没有
   * 练习件，规划器就只出产出型任务 —— 绝不为"看起来题型多了"伪造一道。
   */
  practiceItem: PracticeItemV2 | null;
  evidence: LearningTargetSnapshotV2["target"]["evidence"];
  /** PREPARE eligibility ceiling（V2 run 的 publishedTargetEligibility）。 */
  publishedTargetEligibility: LearningTargetSnapshotV2["publishedTargetEligibility"];
}

/** 规划输入：服务端权威 canonical 目标（由 listActiveCanonical 提供）。 */
export interface RunPlannerTargetInput {
  keyPointId: string;
  claim: string;
  sourceFingerprint: string;
  /** 已排序 evidence content hashes（不进入公开题面）。 */
  evidenceContentHashes: string[];
  /** P4 relation 题面节点 label 用（公开引用原文，非答案）。 */
  quote?: string;
  /**
   * §16.4 V2 分支：存在时 planRun 走 frozen snapshot 消费路径；否则走 V1
   * claim 路径（与现有 32 个 learning-run 单测行为逐字节一致）。
   */
  v2?: PlannerV2Target;
}

export interface PlannedTaskInput {
  taskId: string;
  runId: string;
  sequence: number;
  intent: "recall" | "paraphrase" | "explain" | "example" | "apply" | "boundary" | "procedure" | "relate" | "repair";
  prompt: string;
  targetSummary: string;
  hintLevels: 0 | 1 | 2 | 3;
  primaryFamily: "text" | "voice";
  purpose: "formal" | "facet" | "diagnostic" | "practice";
  templateTrustCeiling: "mastery_eligible" | "facet_eligible" | "diagnostic_only" | "practice_only" | "not_assessable";
  estimatedActiveSeconds: number;
}

export interface PlannedVariant {
  variantId: string;
  interaction: TaskInteractionV1;
  publicPayloadHash: string;
  inputSchemaHash: string;
  disclosureProfileHash: string;
}

export interface PlannedPrivateClosure {
  solution: PrivateTaskSolutionV1;
  privateSolutionHash: string;
  safetyReport: {
    injectionScan: "passed";
    privateLeakageScan: "passed";
    schemaValidation: "passed";
    accessibilityProfile: "passed" | "restricted";
    activationDecision: "allowed" | "denied";
  };
  reportHash: string;
  disclosure: {
    disclosedFieldPaths: string[];
    hiddenFieldPaths: string[];
  };
  runPlanHash: string;
}

export interface PlannedRun {
  tasks: PlannedTaskInput[];
  primaryVariant: PlannedVariant;
  alternativeVariants: PlannedVariant[];
  closures: {
    [variantId: string]: PlannedPrivateClosure;
  };
  runPlanHash: string;
  plannedActiveSeconds: number;
}

export interface PlannerOptions {
  runId: string;
  goal: "stabilize" | "clarify" | "repair" | "transfer" | "explore";
  responsePreference: "adaptive" | "voice" | "text" | "structured";
  timeBudgetSeconds: number;
  now?: () => Date;
  /** §7.8 题面轮换：同一 (user,kp,intent) 最近 30 天已呈现的 publicPayloadHash 集合。 */
  recentPublicPayloadHashes?: ReadonlySet<string>;
  /** §7.7 interaction qualification：family → 已审批 ceiling（无记录 → practice）。 */
  interactionQualifications?: ReadonlyMap<string, { approvedCeiling: "practice_only" | "diagnostic_only" | "facet_eligible" | "mastery_eligible"; expiresAt: string | null }>;
}

/** §7.7：从 qualification 数据推导 family 的 V1 ceiling（无记录/过期 → practice）。 */
export function structuredCeilingFor(
  family: string,
  qualifications?: ReadonlyMap<string, { approvedCeiling: "practice_only" | "diagnostic_only" | "facet_eligible" | "mastery_eligible"; expiresAt: string | null }>,
): "practice_only" | "facet_eligible" {
  const record = qualifications?.get(family);
  if (!record) return "practice_only";
  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) return "practice_only";
  // V1 上限：单个 ordering/relation/repair 最高 facet；bundle 无批准
  // qualification（bundleQualificationId 为空）时最高 practice。
  return record.approvedCeiling === "facet_eligible" ? "facet_eligible" : "practice_only";
}

const GOAL_INTENT: Record<PlannerOptions["goal"], PlannedTaskInput["intent"]> = {
  stabilize: "explain",
  clarify: "paraphrase",
  repair: "explain", // 修复性巩固仍用开放回答；结构化 repair 属 P4
  transfer: "apply",
  explore: "example",
};

/**
 * §7.8 题面轮换角度池：同一 goal 的多个认知角度（机制/前提/受众/反例等），
 * 不是同义词替换；planRun 按最近呈现 hash 选未用角度。
 */
const GOAL_PROMPT_ANGLES: Record<PlannerOptions["goal"], string[]> = {
  stabilize: ["解释为什么成立", "说明成立的关键机制", "指出它依赖哪些前提"],
  clarify: ["用自己的话转述", "对完全没听过的人讲一遍", "用更简单的词重新表达"],
  repair: ["找出哪里不牢靠并重新解释", "先指出上次薄弱处再完整解释", "对比正确与错误的说法"],
  transfer: ["说明它适用的场景", "举一个实际会用到的例子", "说清它不适用的情况"],
  explore: ["举一个具体的例子", "举一个生活中的例子", "举一个反例并说明原因"],
};

/** 变体 publicPayloadHash：纳入题面 prompt（§7.8 轮换按 hash 可区分）。 */
export function variantPublicPayloadHash(
  interaction: PlannedVariant["interaction"],
  prompt: string,
): string {
  return sha256Hex(`public:${JSON.stringify(interaction)}:prompt:${sha256Hex(prompt)}`);
}

function candidatePromptHashes(prompt: string): string[] {
  const textInteraction = { kind: "text_response", maxChars: 2000 } as const;
  const voiceInteraction = { kind: "voice_teachback", maxSeconds: 120 } as const;
  return [
    variantPublicPayloadHash(textInteraction, prompt),
    variantPublicPayloadHash(voiceInteraction, prompt),
  ];
}

/** §7.8：选择最近 30 天未呈现过的角度；全部呈现过则复用第一个。 */
function selectPromptAngle(
  options: PlannerOptions,
  intent: PlannedTaskInput["intent"],
  claim: string,
): string {
  const angles = GOAL_PROMPT_ANGLES[options.goal];
  const avoid = options.recentPublicPayloadHashes;
  if (!avoid || avoid.size === 0) return angles[0];
  for (const angle of angles) {
    const prompt = buildTaskPrompt(intent, angle, claim);
    const hashes = candidatePromptHashes(prompt);
    if (!hashes.some((hash) => avoid.has(hash))) return angle;
  }
  return angles[0];
}

/**
 * §7.3 泄题防护：recall 题的题面不得内嵌 claim 原文（claim 即答案）。
 * 其余 intent 给出观点再要求解释/举例是合理题面（claim 是公开卡片内容）。
 */
export function buildTaskPrompt(
  intent: PlannedTaskInput["intent"],
  hint: string,
  claim: string,
): string {
  return intent === "recall"
    ? `请${hint}（先不要查看任何材料）`
    : `请${hint}：${claim}`;
}

const RUBRIC_FACET_DIRECTIONS: Record<PlannedTaskInput["intent"], string> = {
  recall: "回忆这个主题的关键信息",
  paraphrase: "用自己的话重新说明它",
  explain: "说明它为何成立以及关键机制",
  example: "给出一个具体例子并说明为什么符合",
  apply: "说明一个适用场景和相应做法",
  boundary: "说明它成立的条件或不适用的情况",
  procedure: "按正确顺序说明处理步骤",
  relate: "说明它与相关概念之间的关系",
  repair: "指出容易出错之处并给出更准确的说法",
};

/**
 * V2 评分合同决定题目要求：每个 required rubric facet 都要在公开题面中有
 * 对应的作答动作。这样 Critic 不会拿一题“解释”去判一个未被要求的“应用”。
 */
export function buildV2TaskPrompt(
  primaryIntent: PlannedTaskInput["intent"],
  objectiveStatement: string,
  requiredFacets: PlannedTaskInput["intent"][],
): string {
  const directions = [...new Set(requiredFacets)].map((facet) => RUBRIC_FACET_DIRECTIONS[facet]);
  if (directions.length === 0) {
    throw new Error("V2 task requires at least one rubric facet");
  }
  return buildTaskPrompt(primaryIntent, directions.join("；并"), objectiveStatement);
}

export function clampTimeBudget(seconds: number | undefined): number {
  if (seconds === undefined || Number.isNaN(seconds)) return 180;
  return Math.min(180, Math.max(30, Math.floor(seconds)));
}

/**
 * 规划一个 Run 的任务与 Variant（P2：恰好一个开放回答 Task，
 * text + voice 两个 Variant，与 primaryFamily 对应主 Variant）。
 */
export function planRun(target: RunPlannerTargetInput, options: PlannerOptions): PlannedRun {
  if (target.v2) {
    return planV2Run(target, options);
  }
  if (options.responsePreference === "structured") {
    return planStructuredRun(target, options);
  }
  const runId = options.runId;
  const taskId = randomTaskId();
  const intent = GOAL_INTENT[options.goal];
  const hint = selectPromptAngle(options, intent, target.claim);
  const prompt = buildTaskPrompt(intent, hint, target.claim);
  const targetSummary = intent === "recall" ? "" : target.claim.slice(0, 160);
  const primaryFamily: "text" | "voice" = options.responsePreference === "voice" ? "voice" : "text";
  const estSeconds = primaryFamily === "voice" ? 75 : 60;

  const task: PlannedTaskInput = {
    taskId,
    runId,
    sequence: 1,
    intent,
    prompt,
    targetSummary,
    hintLevels: 2,
    primaryFamily,
    purpose: "formal",
    templateTrustCeiling: "mastery_eligible",
    estimatedActiveSeconds: estSeconds,
  };

  const textVariant = buildVariant(runId, taskId, "text", estSeconds, target, task);
  const voiceVariant = buildVariant(runId, taskId, "voice", estSeconds, target, task);

  // runPlanHash：tasks+variants 的确定性闭包（§12.6 PrivateRunContractV1.taskPlanHash）。
  const planCanonical = [
    `run:${runId}`,
    `task:${task.taskId}:${task.sequence}:${task.intent}:${task.purpose}:${task.templateTrustCeiling}`,
    `prompt:${sha256Hex(task.prompt)}`,
    `variant:${textVariant.variantId}:${textVariant.publicPayloadHash}`,
    `variant:${voiceVariant.variantId}:${voiceVariant.publicPayloadHash}`,
  ].join("\n");
  const runPlanHash = sha256Hex(planCanonical);

  const closures: Record<string, PlannedPrivateClosure> = {};
  for (const variant of [textVariant, voiceVariant]) {
    closures[variant.variantId] = buildClosure(runId, taskId, variant, target, task, runPlanHash);
  }

  const primaryVariant = primaryFamily === "voice" ? voiceVariant : textVariant;
  const alternativeVariants = [primaryFamily === "voice" ? textVariant : voiceVariant];

  return {
    tasks: [task],
    primaryVariant,
    alternativeVariants,
    closures,
    runPlanHash,
    plannedActiveSeconds: Math.min(estSeconds, options.timeBudgetSeconds),
  };
}

/**
 * P4 结构化主 Variant 规划（§7.7 V1 首发：无 qualification → practice）。
 * 主 Variant = ordering（goal=repair 时 repair）；text/voice 为 standby
 * alternatives（§7.4 换模态无副作用、不降级）。确定性评估只产 verdicts。
 */
function planStructuredRun(target: RunPlannerTargetInput, options: PlannerOptions): PlannedRun {
  const runId = options.runId;
  const taskId = randomTaskId();
  const intent = GOAL_INTENT[options.goal];
  const prompt = buildTaskPrompt(intent, selectPromptAngle(options, intent, target.claim), target.claim);
  const targetSummary = target.claim.slice(0, 160);
  // §5.3/§7.7：stabilize/clarify/explore 偏好下生成 structured_bundle
  // （ordering + relation 两个互补 part；无 qualification → practice 上限）；
  // repair/transfer 目标仍用单 part 结构题（修复/关系语义明确）。
  const structuredTarget = {
    keyPointId: target.keyPointId,
    claim: target.claim,
    quote: target.quote ?? "",
  } satisfies StructuredTargetInput;
  const bundle = options.goal === "stabilize" || options.goal === "clarify" || options.goal === "explore"
    ? generateStructuredBundleTask(structuredTarget)
    : null;
  const singleKind = options.goal === "repair" ? "repair"
    : options.goal === "transfer" ? "relation"
    : "ordering";
  const structured = bundle ?? generateStructuredTask(singleKind, structuredTarget);
  const structuredKind = bundle ? "structured_bundle" : singleKind;
  // §7.7：ceiling 从 qualification 数据推导（V1 无记录 → practice）。
  const structuredCeiling = bundle
    ? structuredCeilingFor("structured_bundle", options.interactionQualifications)
    : structuredCeilingFor(singleKind, options.interactionQualifications);

  const estSeconds = 60;
  const task: PlannedTaskInput = {
    taskId,
    runId,
    sequence: 1,
    intent,
    prompt,
    targetSummary,
    hintLevels: 1,
    primaryFamily: "text",
    // §7.7：无 qualification 数据 → practice 上限；录入且审批 facet 后可提升。
    purpose: structuredCeiling === "facet_eligible" ? "facet" : "practice",
    templateTrustCeiling: structuredCeiling,
    estimatedActiveSeconds: estSeconds,
  };

  const structuredInteraction = buildStructuredInteraction(structured);
  const structuredVariant: PlannedVariant = {
    // variantId 必须为 UUID（learning_task_variants.id 列类型）。
    variantId: crypto.randomUUID(),
    interaction: structuredInteraction,
    publicPayloadHash: variantPublicPayloadHash(structuredInteraction, task.prompt),
    inputSchemaHash: sha256Hex(`input:structured:${structuredKind}`),
    disclosureProfileHash: sha256Hex(
      `disclosure:${JSON.stringify(["interaction", "prompt", "targetSummary"])}:hidden:solution`,
    ),
  };

  const textVariant = buildVariant(runId, taskId, "text", estSeconds, target, task);
  const voiceVariant = buildVariant(runId, taskId, "voice", estSeconds, target, task);

  const runPlanHash = sha256Hex([
    `run:${runId}`,
    `task:${task.taskId}:${task.sequence}:${task.intent}:${task.purpose}:${task.templateTrustCeiling}`,
    `prompt:${sha256Hex(task.prompt)}`,
    `variant:${structuredVariant.variantId}:${structuredVariant.publicPayloadHash}`,
    `variant:${textVariant.variantId}:${textVariant.publicPayloadHash}`,
    `variant:${voiceVariant.variantId}:${voiceVariant.publicPayloadHash}`,
  ].join("\n"));

  const closures: Record<string, PlannedPrivateClosure> = {};
  closures[structuredVariant.variantId] = buildClosure(
    runId, taskId, structuredVariant, target, task, runPlanHash, structured.solution,
  );
  closures[textVariant.variantId] = buildClosure(runId, taskId, textVariant, target, task, runPlanHash);
  closures[voiceVariant.variantId] = buildClosure(runId, taskId, voiceVariant, target, task, runPlanHash);

  return {
    tasks: [task],
    primaryVariant: structuredVariant,
    alternativeVariants: [textVariant],
    closures,
    runPlanHash,
    plannedActiveSeconds: Math.min(estSeconds, options.timeBudgetSeconds),
  };
}

/**
 * §16.4 V2 planner：只消费 frozen snapshot。
 * - objectiveStatement 决定目标（公开 cue）；
 * - canonicalAnswer + scoringRubric 决定正确性，但不进入 public payload；
 * - preferredIntents + knowledgeForm 只是 prior；
 * - purpose/ceiling 受 publishedTargetEligibility 钳制（practice_only 恒
 *   practice_only，eligible 可 formal/mastery）。
 */
function planV2Run(target: RunPlannerTargetInput, options: PlannerOptions): PlannedRun {
  const v2 = target.v2!;
  const runId = options.runId;
  const taskId = randomTaskId();
  // 只有 required rubric 是本轮必须证明的掌握条件；可选项只能作为
  // Critic 的诊断上下文，不能因未覆盖而阻断通过。
  const requiredRubricTargetIds = v2.scoringRubric.units
    .filter((unit) => unit.required)
    .map((unit) => unit.rubricUnitId);
  if (requiredRubricTargetIds.length === 0) {
    throw new Error("V2 scoring rubric must contain at least one required unit");
  }
  const requiredRubricUnits = v2.scoringRubric.units.filter((unit) => unit.required);
  const goalIntent = GOAL_INTENT[options.goal];
  // 用户目标优先；若它不在必需 rubric 中，改用第一个必需能力，避免题目要求
  // 与评分标准脱节。其余必需能力会在题面中以组合动作明确列出。
  const intent = requiredRubricUnits.some((unit) => unit.facet === goalIntent)
    ? goalIntent
    : requiredRubricUnits[0].facet;
  // public 题面只消费 objectiveStatement 与 facet 动作；canonicalAnswer/rubric
  // criterion 仍是 server-private 判分参照。
  const prompt = buildV2TaskPrompt(
    intent,
    v2.objectiveStatement,
    requiredRubricUnits.map((unit) => unit.facet),
  );
  const targetSummary = v2.publicSummary.slice(0, 160);
  const estSeconds = 60;

  // 结构化：主位结构题仅在用户显式要 structured 时生成（此时整题降为
  // practice，见下）；备位结构题（2026-09-18）在 adaptive 下同样尝试生成，
  // 作为「换一种方式」的练习备选。安全性依据：评估层按 payload.kind 把
  // 结构化提交固定路由到 deterministic_structured（migration 0123：只产
  // verdicts 绝不产 canonical），所以挂在 formal 任务上不会打开掌握后门。
  // 判断不足返回 null（绝不为 UI 丰富度伪造片段/关系）。
  const wantsStructured = options.responsePreference === "structured";
  const structuredPrimary = wantsStructured
    ? generateStructuredFromSnapshot(v2.canonicalAnswer, v2.relations)
    : null;
  // 0245：作者产出的练习件**优先于**"从 canonicalAnswer 反推"的备位结构题 ——
  // 作者是看着证据写选项/干扰项的，反推只是猜形状。没有练习件时行为一字不变。
  const practicePayload = practiceItemToPayload(v2.practiceItem ?? null);
  const structuredAlternative = structuredPrimary || practicePayload
    ? null
    : generateStructuredFromSnapshot(v2.canonicalAnswer, v2.relations);
  const practiceOnly = v2.publishedTargetEligibility === "practice_only"
    || v2.publishedTargetEligibility === "blocked";
  // V2 的结构题目前只验证一个可机械比对的答案结构（例如步骤顺序或关系边）。
  // 它尚不能逐一证明冻结 rubric 的全部 required 能力，故不得以一次结构题
  // 通过换取 canonical/schedule；保留为可用的练习与反馈入口。
  // 注意：该降级只作用于「主位」结构题 —— 备位结构题不改变任务的 formal
  // 属性，其练习性由评估层的 deterministic_structured 路由保证。
  const structuredPracticeOnly = structuredPrimary !== null;
  const purpose = practiceOnly || structuredPracticeOnly ? "practice" as const : "formal" as const;
  const ceiling = practiceOnly || structuredPracticeOnly ? "practice_only" as const : "mastery_eligible" as const;

  const task: PlannedTaskInput = {
    taskId,
    runId,
    sequence: 1,
    intent,
    prompt,
    targetSummary,
    hintLevels: wantsStructured ? 1 : 2,
    primaryFamily: "text",
    purpose,
    templateTrustCeiling: ceiling,
    estimatedActiveSeconds: estSeconds,
  };

  let primaryVariant: PlannedVariant;
  const closures: Record<string, PlannedPrivateClosure> = {};
  let structuredSolution: PrivateTaskSolutionV1 | undefined;

  if (structuredPrimary) {
    structuredSolution = structuredPrimary.solution as unknown as PrivateTaskSolutionV1;
    primaryVariant = buildStructuredPlannedVariant(structuredPrimary, task.prompt);
  } else {
    primaryVariant = buildVariant(runId, taskId, "text", estSeconds, target, task);
  }

  const voiceVariant = buildVariant(runId, taskId, "voice", estSeconds, target, task);

  // 备位结构变体（练习通道）：与口述并列进「换一种方式」。
  const alternativeStructured = practicePayload ?? structuredAlternative;
  let structuredAlternativeVariant: PlannedVariant | null = null;
  let structuredAlternativeSolution: PrivateTaskSolutionV1 | undefined;
  if (alternativeStructured) {
    structuredAlternativeSolution = alternativeStructured.solution as unknown as PrivateTaskSolutionV1;
    structuredAlternativeVariant = buildStructuredPlannedVariant(alternativeStructured, task.prompt);
  }

  const runPlanHash = sha256Hex([
    `run:${runId}`,
    `task:${task.taskId}:${task.sequence}:${task.intent}:${task.purpose}:${task.templateTrustCeiling}`,
    `prompt:${sha256Hex(task.prompt)}`,
    `variant:${primaryVariant.variantId}:${primaryVariant.publicPayloadHash}`,
    `variant:${voiceVariant.variantId}:${voiceVariant.publicPayloadHash}`,
    ...(structuredAlternativeVariant
      ? [`variant:${structuredAlternativeVariant.variantId}:${structuredAlternativeVariant.publicPayloadHash}`]
      : []),
  ].join("\n"));

  closures[primaryVariant.variantId] = buildClosure(
    runId, taskId, primaryVariant, target, task, runPlanHash, structuredSolution,
    requiredRubricTargetIds,
  );
  closures[voiceVariant.variantId] = buildClosure(runId, taskId, voiceVariant, target, task, runPlanHash,
    undefined, requiredRubricTargetIds,
  );
  if (structuredAlternativeVariant) {
    closures[structuredAlternativeVariant.variantId] = buildClosure(
      runId, taskId, structuredAlternativeVariant, target, task, runPlanHash,
      structuredAlternativeSolution, requiredRubricTargetIds,
    );
  }

  return {
    tasks: [task],
    primaryVariant,
    alternativeVariants: structuredAlternativeVariant
      ? [structuredAlternativeVariant, voiceVariant]
      : [voiceVariant],
    closures,
    runPlanHash,
    plannedActiveSeconds: Math.min(estSeconds, options.timeBudgetSeconds),
  };
}

/**
 * 0245：作者的练习件 → 结构题载荷。返回 null 的两种情形都故意不出题：
 * 素材自相矛盾（正确项不在选项里 / 顺序不是全排列），此时硬造出来的是
 * 一道"永远判不对"的死题；以及合同层的交叉校验本来就该在生成阶段拦掉它。
 */
function practiceItemToPayload(item: PracticeItemV2 | null): StructuredTaskPayload | null {
  if (!item) return null;
  const error = practiceItemCrossRefError(item);
  if (error) return null;
  switch (item.kind) {
    case "single_choice":
      return generateChoiceTask({ options: item.options, correctUnitId: item.correctUnitId });
    case "true_false":
      return generateTrueFalseTask({ proposition: item.proposition, expected: item.expected });
    case "ordering":
      return generateOrderingFromUnits(item.units, item.correctUnitOrder);
    case "matching":
      return generateMatchingTask({ pairs: item.pairs });
  }
}

function buildStructuredPlannedVariant(
  structured: StructuredTaskPayload | StructuredBundlePayload,
  prompt: string,
): PlannedVariant {
  const structuredInteraction = buildStructuredInteraction(structured);
  return {
    variantId: crypto.randomUUID(),
    interaction: structuredInteraction,
    publicPayloadHash: variantPublicPayloadHash(structuredInteraction, prompt),
    inputSchemaHash: sha256Hex(`input:structured:v2`),
    disclosureProfileHash: sha256Hex(
      `disclosure:${JSON.stringify(["interaction", "prompt", "targetSummary"])}:hidden:solution`,
    ),
  };
}

function buildStructuredInteraction(
  structured: StructuredTaskPayload | StructuredBundlePayload,
): TaskInteractionV1 {
  if ((structured as { interaction: { kind: string } }).interaction.kind === "structured_bundle") {
    const payload = structured as unknown as {
      interaction: { kind: "structured_bundle"; parts: Array<{ partId: string; interaction: StructuredBundlePayload["interaction"]["parts"][number]["interaction"]; partTrustCeiling: "practice_only"; qualificationProfileHash: null }> };
      labels: Record<string, Record<string, string>>;
    };

    const parts: StructuredPartPublicV1[] = payload.interaction.parts.map((part) => {
      const labels = payload.labels[part.partId] ?? {};
      const base = {
        partId: part.partId,
        partTrustCeiling: part.partTrustCeiling,
        qualificationProfileHash: part.qualificationProfileHash,
      } as const;
      switch (part.interaction.kind) {
        case "ordering":
          return {
            ...base,
            kind: "ordering",
            publicTokenIds: part.interaction.publicTokenIds,
            publicTokenLabels: labels,
          };
        case "relation_canvas":
          return {
            ...base,
            kind: "relation",
            publicNodeIds: part.interaction.publicNodeIds,
            allowedEdgeKinds: part.interaction.allowedEdgeKinds,
            publicNodeLabels: labels,
          };
        case "repair":
          return {
            ...base,
            kind: "repair",
            publicElementIds: part.interaction.publicElementIds,
            allowedOperationKinds: part.interaction.allowedOperationKinds,
            replacementOptionIds: part.interaction.replacementOptionIds,
            publicElementLabels: labels,
            replacementOptionLabels: labels,
          };
      }
    });

    return {
      kind: "structured_bundle",
      parts: parts as [StructuredPartPublicV1] | [StructuredPartPublicV1, StructuredPartPublicV1],
    };
  }
  if (structured.interaction.kind === "ordering") {
    const payload = structured as Extract<StructuredTaskPayload, { interaction: { kind: "ordering" } }>;
    return {
      ...payload.interaction,
      publicTokenLabels: payload.publicTokenLabels,
    };
  }
  if (structured.interaction.kind === "relation_canvas") {
    const payload = structured as Extract<StructuredTaskPayload, { interaction: { kind: "relation_canvas" } }>;
    return {
      ...payload.interaction,
      publicNodeLabels: payload.publicNodeLabels,
    };
  }
  if (structured.interaction.kind === "repair") {
    const payload = structured as Extract<StructuredTaskPayload, { interaction: { kind: "repair" } }>;
    return {
      ...payload.interaction,
      publicElementLabels: payload.publicElementLabels,
      replacementOptionLabels: payload.replacementOptionLabels,
    };
  }
  if (structured.interaction.kind === "single_choice") {
    const payload = structured as Extract<StructuredTaskPayload, { interaction: { kind: "single_choice" } }>;
    return {
      ...payload.interaction,
      publicOptionLabels: payload.publicOptionLabels,
    };
  }
  if (structured.interaction.kind === "true_false") {
    return structured.interaction;
  }
  if (structured.interaction.kind === "matching") {
    // 配对的标签就在 interaction 里（左右两列共用一张 label 表），直接展开。
    return structured.interaction;
  }
  // 走到这里说明新加了交互种类却没在这里加分支。绝不再静默退回文本框——
  // 那正是"作者产了练习件、学习者却只拿到一个文本框"能永久藏身的形状
  // （2026-09-21 实测第一次就是这样：交互退化成 text_response，测试还不红）。
  throw new Error(`buildStructuredInteraction：未支持的交互种类 ${String(structured.interaction.kind)}`);
}

/**
 * 从 PrivateTaskSolutionV1 提取 rubric 目标 id。
 *
 * 这里曾有一条 `kind === "choice"` 的分支读 rationaleRubricTargetIds，但
 * PrivateTaskSolutionV1 的五个 kind（open_response / ordering / relation /
 * repair / structured_bundle）都只带 rubricTargetIds —— "choice" 已经不在合同里，
 * 那个分支永远不可达，还让 solution 在该分支内被收窄成 never。
 */
export function rubricTargetIdsOf(solution: PrivateTaskSolutionV1): string[] {
  return [...solution.rubricTargetIds];
}

export function buildVariant(
  _runId: string,
  _taskId: string,
  family: "text" | "voice",
  _estimatedActiveSeconds: number,
  _target: RunPlannerTargetInput,
  task: PlannedTaskInput,
): PlannedVariant {
  const interaction: PlannedVariant["interaction"] = family === "text"
    ? { kind: "text_response", maxChars: 2000 }
    : { kind: "voice_teachback", maxSeconds: 120 };
  const publicPayloadHash = variantPublicPayloadHash(interaction, task.prompt);
  const inputSchemaHash = sha256Hex(
    `input:${family}:min1:max${family === "text" ? 2000 : 20000}`,
  );
  // disclosure：公开字段只有 interaction 与题面；答案承载字段全部隐藏。
  // profile hash 纳入 public payload（不同 Variant 的 disclosure 不同）。
  const disclosureProfileHash = sha256Hex(
    `disclosure:${publicPayloadHash}:${JSON.stringify(["interaction", "prompt", "targetSummary"])}:hidden:solution,rubric,evidence,expected`,
  );
  return {
    // variantId 必须为 UUID（learning_task_variants.id 列类型）；确定性由
    // publicPayloadHash/inputSchemaHash 承担。
    variantId: crypto.randomUUID(),
    interaction,
    publicPayloadHash,
    inputSchemaHash,
    disclosureProfileHash,
  };
}

export function buildClosure(
  runId: string,
  taskId: string,
  variant: PlannedVariant,
  target: RunPlannerTargetInput,
  task: PlannedTaskInput,
  runPlanHash: string,
  structuredSolution?: PrivateTaskSolutionV1,
  rubricTargetIdOverride?: string[],
): PlannedPrivateClosure {
  const rubricTargetId = `rubric:${task.intent}:${variant.publicPayloadHash.slice(0, 12)}`;
  // P4 结构题：solution 由生成器提供（correctTokenIds/requiredEdges/signatures）；
  // 开放回答：rubric 目标 + evidence 引用。
  // §16.6 V2：rubric 目标用 frozen snapshot 的 scoringRubric unit ids，
  // 使 Assessment Critic 输出与 rubric unit coverage 对齐。
  const solution: PlannedPrivateClosure["solution"] = structuredSolution ?? {
    kind: "open_response",
    rubricTargetIds: rubricTargetIdOverride ?? [rubricTargetId],
    // evidenceRefIds 只存 content hash（不存正文），评估 worker 据此读取证据。
    evidenceRefIds: [...target.evidenceContentHashes],
    contradictionRuleIds: [],
  };
  const privateSolutionHash = sha256Hex(`private:${JSON.stringify(solution)}`);
  // P2 确定性安全报告：题面仅由服务端模板 + 公开 claim 拼接（无外部脚本/
  // HTML 执行面）；solution 不进入公开 payload；schema 由 inputSchemaHash 固定。
  const safetyReport = {
    injectionScan: "passed" as const,
    privateLeakageScan: "passed" as const,
    schemaValidation: "passed" as const,
    accessibilityProfile: "passed" as const,
    activationDecision: "allowed" as const,
  };
  const reportHash = sha256Hex(
    `safety:${variant.publicPayloadHash}:${variant.inputSchemaHash}:${privateSolutionHash}:${variant.disclosureProfileHash}:${runId}:${taskId}:${JSON.stringify(safetyReport)}`,
  );
  const disclosure = {
    disclosedFieldPaths: ["interaction", "prompt", "targetSummary"],
    hiddenFieldPaths: ["solution", "rubric", "evidenceRefIds", "expectedTarget"],
  };
  return { solution, privateSolutionHash, safetyReport, reportHash, disclosure, runPlanHash };
}

function randomTaskId(): string {
  // 确定性 planner 需要可重放 ID：V1 用 crypto random（与 DB defaultRandom 一致）。
  // 幂等由 learning_run_idempotency 保证，taskId 只需在 Run 内唯一。
  return crypto.randomUUID();
}

/** 计算 PrivateRunContractV1.contractHash（§12.6）。 */
export function computeRunContractHash(input: {
  runId: string;
  workspaceId: string;
  userId: string;
  keyPointId: string;
  targetFingerprint: string;
  runtimeEpoch: number;
  timeBudgetSeconds: number;
  planningClosesAtActiveSecond: number;
  schedulingAuthorization: unknown;
  taskPlanHash: string;
  projectionBaselineCheckpointToken: string | null;
  /** §16.2 step 8：V2 Run 的 target snapshot 必须进入 contract hash closure。 */
  snapshotHash: string;
}): string {
  return sha256Hex(
    [
      `run:${input.runId}`,
      `ws:${input.workspaceId}`,
      `user:${input.userId}`,
      `kp:${input.keyPointId}`,
      `fp:${input.targetFingerprint}`,
      `epoch:${input.runtimeEpoch}`,
      `budget:${input.timeBudgetSeconds}`,
      `close:${input.planningClosesAtActiveSecond}`,
      `sched:${JSON.stringify(input.schedulingAuthorization)}`,
      `plan:${input.taskPlanHash}`,
      `checkpoint:${input.projectionBaselineCheckpointToken ?? ""}`,
      `snapshot:${input.snapshotHash}`,
    ].join("\n"),
  );
}

/** 确定性 hint 文案（不泄露答案；只给结构引导）。 */
export function buildDeterministicHint(task: { intent: PlannedTaskInput["intent"] }, level: 1 | 2 | 3): string {
  const base: Record<string, string[]> = {
    recall: ["先回想这个观点的关键词。", "试着说出它的两个组成部分。", "它常和什么一起出现？"],
    paraphrase: ["换一种说法试试，保持意思不变。", "想象你在讲给一个没学过的人听。", "删掉术语，还能怎么说？"],
    explain: ["从“原因”或“例子”里挑一个角度开始。", "想想它如果不成立会发生什么。", "它解决了一个什么问题？"],
    example: ["找一个你身边的小例子。", "想象一个具体场景。", "什么情况下你会用到它？"],
    apply: ["找一个你熟悉的场景套进去。", "想想边界在哪里。", "什么情况下它会失效？"],
    boundary: ["试着找出它不适用的情形。", "它和相似概念的区别是什么？", "什么条件下它才成立？"],
    procedure: ["按顺序说，先做什么后做什么。", "中间哪一步最容易出错？", "跳过一步会发生什么？"],
    relate: ["它和哪个概念关系最紧？", "是因果关系还是包含关系？", "谁先谁后？"],
    repair: ["先指出哪里不稳，再重新组织。", "原来的说法缺了什么？", "补上缺的部分再说一遍。"],
  };
  const options = base[task.intent] ?? base.explain;
  return options[Math.min(level, 3) - 1] ?? options[0];
}
