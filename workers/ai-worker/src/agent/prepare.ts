/**
 * PREPARE 确定性节点（计划 §5.1, §W3）
 *
 * 这是四个稳定外层节点中的第一个，完全确定性，不做任何模型调用。
 *
 * 职责：
 * 1. 封存 noteVersion 快照（G1）
 * 2. 创建 atomic evidence span 和 image evidence unit
 * 3. 规划 MapContextBundle（G3）
 * 4. 初始化 Coverage Ledger（§7.2）
 * 5. 冻结预算快照（§5.5）
 * 6. 记录 Provider capability snapshot（§8.2）
 * 7. 输入规模预检（§10.2）
 *
 * 不变量（G1, G2, G3）：
 * - 输入快照不可变，执行期间配置或正文变化只能创建新 run
 * - 每个 atomic text span 可以按 block 坐标重建并通过 SHA-256
 * - 每个 required image 必须成功形成 typed evidence，或由 Owner 显式排除
 * - 每个 primary evidence 恰好属于一个 owning bundle
 *
 * 退出条件（§W3）：
 * - 向量关闭时 full coverage 仍为 100%
 * - 所有 required bundle 都有明确决策状态（初始为 pending）
 * - 预算和能力快照已冻结
 */

import { createHash } from "node:crypto";
import type {
  RunBudget,
  ProviderCapability,
} from "@ailearn/shared";
import {
  SUPERVISOR_AGENT_ENGINE_MODE,
  SUPERVISOR_SHELL_VERSION,
  SUPERVISOR_POLICY_VERSION,
  TOOL_SCHEMA_VERSION,
  PLANNER_VERSION,
  VERIFIER_VERSION,
  RETRIEVAL_POLICY_VERSION,
  EMBEDDING_PROFILE_VERSION,
  RESULT_CONTRACT_VERSION,
  createDefaultRunBudget,
} from "@ailearn/shared";
import { precheckInput, type InputPrecheckResult } from "./input-precheck.ts";
import {
  planBundles,
  verifyBundlePlan,
  type PlannableEvidence,
  type BundlePlanResult,
  type BundlePlannerConfig,
  DEFAULT_BUNDLE_PLANNER_CONFIG,
} from "./bundle-planner.ts";
import {
  CoverageLedger,
  initLedgerFromBundlePlan,
  type CoverageLedgerSnapshot,
} from "./coverage-ledger.ts";
import type { RequestPackerConfig } from "./request-packer.ts";
import { splitBlockExactly } from "../lib/source-unit-planner.ts";
import { logger } from "../lib/logger.ts";

/** PREPARE 输入 */
export interface PrepareInput {
  /** 运行 ID */
  runId: string;
  /** 工作区 ID */
  workspaceId: string;
  /** noteVersion ID */
  noteVersionId: string;
  /** 笔记标题 */
  noteTitle: string;
  /** 密度 */
  density: "overview" | "standard" | "complete";
  /** 可计划的 block 列表 */
  blocks: Array<{
    id: string;
    ordinal: number;
    type: string;
    content: string;
  }>;
  /** 图片 evidence unit 列表 */
  imageEvidenceUnits: Array<{
    id: string;
    blockId: string;
    blockOrdinal: number;
    sectionPath: string[];
    sourceHash: string;
    text: string;
    tokenEstimate: number;
  }>;
  /** Provider 能力 */
  providerCapability: ProviderCapability;
  /** 预算覆盖（可选） */
  budgetOverride?: Partial<RunBudget>;
  /** Bundle 规划器配置覆盖 */
  bundlePlannerConfigOverride?: Partial<BundlePlannerConfig>;
  /** 请求打包器配置覆盖 */
  requestPackerConfigOverride?: Partial<RequestPackerConfig>;
}

/** PREPARE 输出 */
export interface PrepareOutput {
  /** 运行 ID */
  runId: string;
  /** 预检结果 */
  precheck: InputPrecheckResult;
  /** bundle 规划结果 */
  bundlePlan: BundlePlanResult;
  /** coverage ledger 初始快照 */
  coverageSnapshot: CoverageLedgerSnapshot;
  /** 冻结的预算 */
  budget: RunBudget;
  /** Provider 能力快照 */
  providerCapability: ProviderCapability;
  /** 引擎与版本信息 */
  engineInfo: EngineInfo;
  /** 构建的 evidence 列表（供 Handler 持久化到 note_evidence_spans） */
  evidence: PlannableEvidence[];
  /** PREPARE 是否成功 */
  ok: boolean;
  /** 失败原因 */
  failureReason: string | null;
}

/** 引擎与版本信息 */
export interface EngineInfo {
  engineMode: string;
  shellVersion: string;
  supervisorPolicyVersion: string;
  toolSchemaVersion: string;
  plannerVersion: string;
  verifierVersion: string;
  retrievalPolicyVersion: string;
  embeddingProfileVersion: string;
  resultContractVersion: string;
  providerFingerprint: string;
}

/**
 * 执行 PREPARE 阶段。
 *
 * 这是完全确定性的，不做任何模型调用。
 * 所有操作在一个短事务内完成，封存后不可修改。
 *
 * 执行步骤：
 * 1. 输入规模预检
 * 2. 构建 PlannableEvidence 列表
 * 3. 规划 MapContextBundles
 * 4. 初始化 Coverage Ledger
 * 5. 冻结预算
 * 6. 记录能力快照
 */
export function executePrepare(input: PrepareInput): PrepareOutput {
  const runId = input.runId;
  logger.info({ runId, workspaceId: input.workspaceId }, "PREPARE 阶段开始");

  // 1. 输入规模预检
  const totalSourceChars = input.blocks
    .filter((b) => b.type !== "image")
    .reduce((sum, b) => sum + b.content.length, 0);
  const imageCount = input.imageEvidenceUnits.length;
  const blockCount = input.blocks.length;

  const precheck = precheckInput({
    totalSourceChars,
    blockCount,
    imageCount,
  });

  if (!precheck.ok) {
    logger.warn({ runId, failureReason: precheck.failureReason }, "PREPARE 预检失败");
    return {
      runId,
      precheck,
      bundlePlan: emptyBundlePlan(),
      coverageSnapshot: emptyCoverageSnapshot(),
      budget: resolveBudget(input.budgetOverride),
      providerCapability: input.providerCapability,
      engineInfo: buildEngineInfo(input.providerCapability),
      evidence: [],
      ok: false,
      failureReason: precheck.failureReason,
    };
  }

  // 2. 构建 PlannableEvidence 列表
  const evidence = buildPlannableEvidence(input.blocks, input.imageEvidenceUnits);

  // 3. 规划 MapContextBundles
  const bundlePlannerConfig: BundlePlannerConfig = {
    ...DEFAULT_BUNDLE_PLANNER_CONFIG,
    ...input.bundlePlannerConfigOverride,
  };
  const bundlePlan = planBundles(evidence, bundlePlannerConfig);

  // 验证 bundle 规划的完整性
  verifyBundlePlan(bundlePlan);

  logger.info(
    { runId, bundleCount: bundlePlan.bundles.length, evidenceCount: evidence.length },
    "Bundle 规划完成",
  );

  // 4. 初始化 Coverage Ledger
  const coverageLedger = new CoverageLedger();
  initLedgerFromBundlePlan(
    coverageLedger,
    bundlePlan.bundles.map((b) => ({
      bundleId: b.bundleId,
      ordinal: b.ordinal,
      required: b.required,
    })),
  );
  const coverageSnapshot = coverageLedger.getSnapshot();

  // 5. 冻结预算
  const budget = resolveBudget(input.budgetOverride);

  // 6. 构建引擎信息
  const engineInfo = buildEngineInfo(input.providerCapability);

  logger.info(
    {
      runId,
      bundles: bundlePlan.bundles.length,
      coverage: {
        physical: coverageSnapshot.report.sourcePhysicalCoverage,
        assignment: coverageSnapshot.report.bundleAssignmentCoverage,
        decision: coverageSnapshot.report.explicitDecisionCoverage,
      },
    },
    "PREPARE 阶段完成",
  );

  return {
    runId,
    precheck,
    bundlePlan,
    coverageSnapshot,
    budget,
    providerCapability: input.providerCapability,
    engineInfo,
    evidence,
    ok: true,
    failureReason: null,
  };
}

/**
 * 从 block 列表和 image evidence 构建可计划的证据列表。
 *
 * 集成 source-unit-planner 的 splitBlockExactly 进行原子 span 切分（计划 §G2）。
 * 长 block 会被切分为多个 atomic span，每个 span 有精确的 charStart/charEnd。
 */
function buildPlannableEvidence(
  blocks: PrepareInput["blocks"],
  imageEvidenceUnits: PrepareInput["imageEvidenceUnits"],
): PlannableEvidence[] {
  const evidence: PlannableEvidence[] = [];

  // 使用 source-unit-planner 的 splitBlockExactly 进行原子 span 切分
  const MAX_SPAN_TOKENS = 512; // 每个 atomic span 的最大 token 数

  // 文本 span（从 block 内容构建，使用 splitBlockExactly 进行原子切分）
  const sectionPath: string[] = [];
  for (const block of blocks) {
    if (block.type === "image") continue;

    // 检测章节标题
    if (block.type === "heading") {
      const level = (block.content.match(/^#+/)?.[0].length ?? 1);
      const title = block.content.replace(/^#+\s*/, "").trim() || "未命名章节";
      sectionPath.splice(level - 1);
      // 补齐跳级标题的 null 空洞
      for (let i = 0; i < level - 1; i++) {
        if (sectionPath[i] === undefined || sectionPath[i] === null) {
          sectionPath[i] = "未命名章节";
        }
      }
      sectionPath[level - 1] = title;
    }

    if (block.content.length === 0) continue;

    // 使用 splitBlockExactly 进行原子 span 切分
    const spans = splitBlockExactly(block.content, MAX_SPAN_TOKENS);

    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]!;
      const spanId = `span:${block.id}:${i}`;
      const sourceHash = computeSourceHash(span.exactText);
      const isShort = span.exactText.length < 50;

      evidence.push({
        refId: spanId,
        kind: "text_span",
        blockId: block.id,
        blockOrdinal: block.ordinal,
        sectionPath: [...sectionPath],
        tokenEstimate: span.tokenEstimate,
        sourceHash,
        isShort,
        text: span.exactText,
        charStart: span.charStart,
        charEnd: span.charEnd,
      });
    }
  }

  // 图片 evidence
  for (const img of imageEvidenceUnits) {
    evidence.push({
      refId: `image:${img.id}`,
      kind: "image_evidence",
      blockId: img.blockId,
      blockOrdinal: img.blockOrdinal,
      sectionPath: [...img.sectionPath],
      tokenEstimate: img.tokenEstimate,
      sourceHash: img.sourceHash,
      isShort: false,
      text: img.text,
      charStart: 0,
      charEnd: 0,
    });
  }

  return evidence;
}

/**
 * 解析预算，合并覆盖。
 *
 * R26 修复：使用 createDefaultRunBudget() 在每次调用时计算动态截止时间，
 * 而不是使用模块加载时冻结的 DEFAULT_RUN_BUDGET。
 */
function resolveBudget(override?: Partial<RunBudget>): RunBudget {
  const base = createDefaultRunBudget();
  if (!override) return base;
  return {
    ...base,
    ...override,
    roles: {
      ...base.roles,
      ...(override.roles ?? {}),
    },
  };
}

/**
 * 构建引擎信息。
 */
function buildEngineInfo(capability: ProviderCapability): EngineInfo {
  return {
    engineMode: SUPERVISOR_AGENT_ENGINE_MODE,
    shellVersion: SUPERVISOR_SHELL_VERSION,
    supervisorPolicyVersion: SUPERVISOR_POLICY_VERSION,
    toolSchemaVersion: TOOL_SCHEMA_VERSION,
    plannerVersion: PLANNER_VERSION,
    verifierVersion: VERIFIER_VERSION,
    retrievalPolicyVersion: RETRIEVAL_POLICY_VERSION,
    embeddingProfileVersion: EMBEDDING_PROFILE_VERSION,
    resultContractVersion: RESULT_CONTRACT_VERSION,
    providerFingerprint: capability.fingerprint,
  };
}

/** 空的 bundle plan（预检失败时返回） */
function emptyBundlePlan(): BundlePlanResult {
  return {
    bundles: [],
    primaryOwnership: new Map(),
    unassigned: [],
    totalTokenEstimate: 0,
    plannerVersion: "none",
  };
}

/** 空的 coverage snapshot（预检失败时返回） */
function emptyCoverageSnapshot(): CoverageLedgerSnapshot {
  return {
    bundles: [],
    totalBundles: 0,
    requiredBundles: 0,
    assignedBundles: 0,
    decidedBundles: 0,
    totalCandidates: 0,
    canonicalCandidates: 0,
    eligibleCandidates: 0,
    report: {
      sourcePhysicalCoverage: 0,
      bundleAssignmentCoverage: 0,
      explicitDecisionCoverage: 0,
      candidateSurvivalCoverage: 0,
      publishedConceptCoverage: 0,
      capacityExclusions: [],
      bundleDecisions: [],
    },
  };
}

/** SHA-256 source hash（计划 §G2：每个 atomic text span 可以按 block 坐标重建并通过 SHA-256） */
function computeSourceHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * 构建 Generation Fingerprint（计划 §9.1）。
 *
 * 覆盖所有版本、provider/model、governance、sealed manifests、
 * density 和 generation nonce。
 */
export function buildGenerationFingerprint(params: {
  engineInfo: EngineInfo;
  governancePolicyVersion: string;
  blockManifestHash: string;
  assetManifestHash: string;
  titleSnapshot: string;
  density: string;
  generationNonce: string;
}): string {
  const raw = JSON.stringify({
    engineMode: params.engineInfo.engineMode,
    shellVersion: params.engineInfo.shellVersion,
    supervisorPolicyVersion: params.engineInfo.supervisorPolicyVersion,
    toolSchemaVersion: params.engineInfo.toolSchemaVersion,
    plannerVersion: params.engineInfo.plannerVersion,
    verifierVersion: params.engineInfo.verifierVersion,
    retrievalPolicyVersion: params.engineInfo.retrievalPolicyVersion,
    embeddingProfileVersion: params.engineInfo.embeddingProfileVersion,
    resultContractVersion: params.engineInfo.resultContractVersion,
    providerFingerprint: params.engineInfo.providerFingerprint,
    governancePolicyVersion: params.governancePolicyVersion,
    blockManifestHash: params.blockManifestHash,
    assetManifestHash: params.assetManifestHash,
    titleSnapshot: params.titleSnapshot,
    density: params.density,
    generationNonce: params.generationNonce,
  });
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
