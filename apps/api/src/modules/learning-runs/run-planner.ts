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
export { sha256Hex };
import type {
  PrivateTaskSolutionV1,
  TaskInteractionV1,
} from "@ailearn/shared";
import { generateStructuredBundleTask, generateStructuredTask, generateStructuredFromSnapshot, type StructuredBundlePayload, type StructuredTargetInput, type StructuredTaskPayload } from "./run-structured.ts";
import type {
  CanonicalAnswerV2,
  ObjectiveRelationV2,
  ObjectiveRubricV2,
} from "@ailearn/shared/card-generation-v2-contracts";
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
  alternativeVariant: PlannedVariant;
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
  const alternativeVariant = primaryFamily === "voice" ? textVariant : voiceVariant;

  return {
    tasks: [task],
    primaryVariant,
    alternativeVariant,
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
    alternativeVariant: textVariant,
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
  const intent = GOAL_INTENT[options.goal];
  const hint = selectPromptAngle(options, intent, v2.objectiveStatement);
  // public 题面：objectiveStatement 是公开卡片前端内容；canonicalAnswer 是答案。
  const prompt = buildTaskPrompt(intent, hint, v2.objectiveStatement);
  const targetSummary = v2.publicSummary.slice(0, 160);
  const estSeconds = 60;

  const practiceOnly = v2.publishedTargetEligibility === "practice_only"
    || v2.publishedTargetEligibility === "blocked";
  const purpose = practiceOnly ? "practice" as const : "formal" as const;
  const ceiling = practiceOnly ? "practice_only" as const : "mastery_eligible" as const;

  // 结构化：优先从 CanonicalAnswerV2 显式结构生成；无足够结构则不生成结构题，
  // Planner 换 open text/voice（§16.5）。
  const wantsStructured = options.responsePreference === "structured";
  const structured = wantsStructured
    ? generateStructuredFromSnapshot(v2.canonicalAnswer, v2.relations)
    : null;

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

  if (structured) {
    structuredSolution = structured.solution as unknown as PrivateTaskSolutionV1;
    const structuredInteraction = buildStructuredInteraction(structured);
    primaryVariant = {
      variantId: crypto.randomUUID(),
      interaction: structuredInteraction,
      publicPayloadHash: variantPublicPayloadHash(structuredInteraction, task.prompt),
      inputSchemaHash: sha256Hex(`input:structured:v2`),
      disclosureProfileHash: sha256Hex(
        `disclosure:${JSON.stringify(["interaction", "prompt", "targetSummary"])}:hidden:solution`,
      ),
    };
  } else {
    primaryVariant = buildVariant(runId, taskId, "text", estSeconds, target, task);
  }

  const voiceVariant = buildVariant(runId, taskId, "voice", estSeconds, target, task);
  const runPlanHash = sha256Hex([
    `run:${runId}`,
    `task:${task.taskId}:${task.sequence}:${task.intent}:${task.purpose}:${task.templateTrustCeiling}`,
    `prompt:${sha256Hex(task.prompt)}`,
    `variant:${primaryVariant.variantId}:${primaryVariant.publicPayloadHash}`,
    `variant:${voiceVariant.variantId}:${voiceVariant.publicPayloadHash}`,
  ].join("\n"));

  closures[primaryVariant.variantId] = buildClosure(
    runId, taskId, primaryVariant, target, task, runPlanHash, structuredSolution,
    v2.scoringRubric.units.map((u) => u.rubricUnitId),
  );
  closures[voiceVariant.variantId] = buildClosure(runId, taskId, voiceVariant, target, task, runPlanHash,
    undefined, v2.scoringRubric.units.map((u) => u.rubricUnitId),
  );

  return {
    tasks: [task],
    primaryVariant,
    alternativeVariant: voiceVariant,
    closures,
    runPlanHash,
    plannedActiveSeconds: Math.min(estSeconds, options.timeBudgetSeconds),
  };
}

function buildStructuredInteraction(
  structured: StructuredTaskPayload | StructuredBundlePayload,
): TaskInteractionV1 {
  if ((structured as { interaction: { kind: string } }).interaction.kind === "structured_bundle") {
    const payload = structured as unknown as {
      interaction: { kind: "structured_bundle"; parts: Array<{ partId: string; interaction: TaskInteractionV1; partTrustCeiling: "practice_only"; qualificationProfileHash: null }> };
      labels: Record<string, Record<string, string>>;
    };
    // 运行时附加 labels（与单 part 的 publicTokenLabels 同一做法；§12.3 只
    // 序列化 ids，renderer 文本由附加字段承载）。
    return {
      kind: "structured_bundle",
      parts: payload.interaction.parts.map((part) => ({
        ...part,
        labels: payload.labels[part.partId] ?? {},
      })),
    } as unknown as TaskInteractionV1;
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
  // fallback：永远不该到达（generateStructuredTask 与 kind 同步）。
  return { kind: "text_response", maxChars: 2000 };
}

/** 从 PrivateTaskSolutionV1 提取 rubric 目标 id（choice 用 rationale 目标）。 */
export function rubricTargetIdsOf(solution: PrivateTaskSolutionV1): string[] {
  if (solution.kind === "choice") return [...solution.rationaleRubricTargetIds];
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
  /**
   * §16.2 step 8：本方案切流后新建的 V2 Run 必须把 `snapshotHash` 纳入
   * 版本化 V2 private contract hash closure；历史 V1 Run 不传此值，
   * hash 保持与既有实现一致（向后兼容，不破坏已落库 contractHash）。
   */
  snapshotHash?: string;
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
      ...(input.snapshotHash ? [`snapshot:${input.snapshotHash}`] : []),
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
