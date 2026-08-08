/**
 * scene-activation.ts（阶段 05 / W4，任务 05-2）
 *
 * Scene Activation Service（01-2 §3.3）：唯一激活权限属于 deterministic
 * Scene Activation Service。事务内验证（全部通过才产出 immutable active
 * contract）：
 * - Scene Author staging（staging 状态，非模型/客户端任意生成）；
 * - scene-safety-v1 verdict=approved（01-2 §3.3）；
 * - Critic=approved 或合法静态 certification（safety 报告已承载该判定）；
 * - public/private/solution/disclosure hashes 与冻结 FrozenProbeRef 逐项一致；
 * - planHash（Episode 冻结 planHash 覆盖本 probe 全部 hashes）；
 * - epoch（runtimeEpoch + episodeEpoch 与当前一致，缺失 fail closed，03-6）；
 * - BudgetEnvelope（不可借用：ref/hash 匹配且预算预留充足，01-2 §5.3）；
 * - 两态 formal/practice 与 scene mode / feedbackTiming / assistance 约束。
 * 写入一次 immutable active contract（exactly-once，通过注入端口）。
 *
 * 权限：Author / Supervisor / Critic / Companion 都没有 activate_scene_contract
 * 权限；网关侧（03-4 workers/ai-worker/src/learning-agent/tools/gateway.ts）
 * `scene_activation` 是唯一被允许的 actor，已确认（DETERMINISTIC_ROLE_TOOL_IDS
 * scene_activation=["activate_scene_contract"]，六个 LLM 角色 allowlist 均不含
 * 该工具）。本模块提供断言与 isActivationAuthorizedActor 作为双重防线。
 *
 * 纯函数核心 + 注入端口：不读时钟（active contract 不写时间戳，用确定性 nonce
 * 保证 exactly-once）、不改状态、不写掌握/schedule 真值；真实 DB 写入由阶段 06
 * COMMIT/repository 接入，本模块只提供端口契约与内存实现。
 */

import { createHash } from "node:crypto";
import { TrustClass } from "@ailearn/shared";
import {
  computeDisclosureProfileHash,
  SceneMode,
  SceneSafetyVerdict,
  type LearningScene,
  type PrivateEpisodeContractLite,
  type SceneSafetyReport,
} from "./scene-safety.ts";

// ─── 运行两态（01-2 §6.3/§6.4）───────────────────────────────────────────

export const SceneRuntimeMode = SceneMode;
export type SceneRuntimeMode = SceneMode;

// ─── 权限（Author/Supervisor/Critic/Companion 无 activate 权限）──────────

/** 无 activate_scene_contract 权限的 actor（03-4 actor 矩阵） */
export const NO_ACTIVATE_ACTOR_IDS = [
  "session_supervisor",
  "scene_author",
  "rubric_scene_critic",
  "assessment_critic",
  "grounded_tutor",
  "grounded_answer_critic",
  "companion",
] as const;
export type NoActivateActor = (typeof NO_ACTIVATE_ACTOR_IDS)[number];

/** 唯一授权 actor：deterministic Scene Activation Service（03-4 网关角色）。 */
export const ACTIVATION_AUTHORIZED_ACTOR = "scene_activation" as const;

export class SceneActivationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SceneActivationError";
    this.code = code;
  }
}

/** 是否授权激活该 Scene 的 actor（唯一 scene_activation）。 */
export function isActivationAuthorizedActor(actor: string): boolean {
  return actor === ACTIVATION_AUTHORIZED_ACTOR;
}

/** 断言 actor 无激活权限（越权尝试 → 抛错，fail closed）。 */
export function assertNoActivatePermission(actor: NoActivateActor): never {
  throw new SceneActivationError(
    "no_activate_permission",
    `actor ${actor} has no activate_scene_contract permission`,
  );
}

// ─── 两态一致性（formal 无即时泄题 / practice 可即时反馈）────────────────

export interface ModeConsistencyResult {
  ok: boolean;
  reasonCodes: string[];
}

/**
 * 两态约束（01-2 §6.4 / 05-w4 任务 05-2）：
 * - formal：无即时泄题（feedbackTiming ≠ immediate、不揭示答案、无内容帮助）；
 * - practice：可即时反馈，template trust ceiling 不得高于 practice_only。
 */
export function checkModeConsistency(scene: LearningScene): ModeConsistencyResult {
  const reasons: string[] = [];
  if (scene.mode === SceneMode.FORMAL) {
    if (scene.feedbackTiming === "immediate") reasons.push("formal_immediate_feedback");
    if (scene.assistancePolicy.revealsAnswerOnAttempt) reasons.push("formal_reveals_answer");
    if (scene.assistancePolicy.contentHelpAllowed) reasons.push("formal_content_help");
    if (scene.disclosureProfile.feedbackTiming === "immediate") {
      reasons.push("formal_disclosure_immediate_feedback");
    }
  } else if (scene.mode === SceneMode.PRACTICE) {
    // practice 模式：可即时反馈；但 ceiling 不得宣称可信等级。
    if (scene.templateTrustCeiling !== TrustClass.PRACTICE_ONLY) {
      reasons.push("practice_ceiling_not_practice_only");
    }
    if (scene.disclosureProfile.maxProvableTrustClass !== TrustClass.PRACTICE_ONLY) {
      reasons.push("practice_disclosure_not_practice_only");
    }
  }
  return { ok: reasons.length === 0, reasonCodes: reasons };
}

// ─── Active Scene Contract（immutable，exactly-once）──────────────────────

export interface ActiveSceneContract {
  contractVersion: "active-scene-contract-v1";
  activeContractId: string;
  sceneId: string;
  probeId: string;
  mode: SceneRuntimeMode;
  /** 净化题面（零 private 字段）：仅 public 字段 + opaque IDs + A11y */
  publicSceneContract: {
    contractVersion: "public-scene-contract-v1";
    sceneId: string;
    probeId: string;
    sceneType: string;
    template: string;
    version: string;
    mode: SceneRuntimeMode;
    targetKeyPointId: string;
    publicPayload: unknown;
    publicPayloadHash: string;
    disclosureProfileHash: string;
    templateTrustCeiling: TrustClass;
    a11yEquivalentPaths: Array<{ kind: string; description: string; semanticRequirementUnchanged: boolean }>;
  };
  /** private solution 仅服务端引用（不返回客户端） */
  privateSolutionRef: {
    privateSolutionId: string;
    privateSolutionHash: string;
    sceneId: string;
  };
  hashes: {
    publicPayloadHash: string;
    privateSolutionHash: string;
    disclosureProfileHash: string;
    safetyReportHash: string;
    planHash: string;
  };
  epochSnapshot: {
    runtimeEpoch: number;
    episodeEpoch: number;
  };
  budgetEnvelopeRef: string;
  budgetEnvelopeHash: string;
  safetyReportId: string;
  /** 字面量 true：active contract 不可变（类型层面禁止修改） */
  readonly immutable: true;
  /** exactly-once：确定性 nonce（同冻结输入恒等，重复激活被拒绝） */
  activationNonce: string;
}

// ─── 激活校验输入与端口 ──────────────────────────────────────────────────

export interface FrozenProbeBindingInput {
  probeId: string;
  publicSceneContractId: string;
  privateSolutionId: string;
}

export interface SceneActivationInput {
  /** 申请激活的 actor（网关强制 allowlist 后的 actor 身份） */
  actor: string;
  /** Scene Author staging 的 Scene（staging 状态由端口验证） */
  scene: LearningScene;
  /** 本次激活绑定的 probe */
  probe: FrozenProbeBindingInput;
  /** scene-safety-v1 报告（必须 approved） */
  safetyReport: SceneSafetyReport;
  /** Episode 冻结契约（planHash/epoch/budget 来源） */
  episode: PrivateEpisodeContractLite;
  /** 当前 epoch（执行前重读取；03-6 缺失 → fail closed） */
  currentEpoch: { runtimeEpoch: number | null; episodeEpoch: number | null };
  /** BudgetEnvelope（03-2 冻结；sufficient=false → 预算不足，作答前阻断） */
  budgetEnvelope: {
    envelopeRef: string;
    envelopeHash: string;
    sufficient: boolean;
  };
}

export interface ActivationPorts {
  /** 读取 Scene Author staging 状态（staged / active / missing） */
  readStagingStatus: (sceneId: string) => { status: "staged" | "active" | "missing" };
  /** 验证 planHash 覆盖本 probe 全部 hashes（委托 session-service 重算） */
  verifyPlanHash: (episode: PrivateEpisodeContractLite, probeHashes: ProbeHashSet) => boolean;
  /** 写入 immutable active contract（exactly-once；已激活 → already_active） */
  writeActiveContract: (
    contract: ActiveSceneContract,
  ) => { ok: true } | { ok: false; code: "already_active" };
}

export interface ProbeHashSet {
  probeId: string;
  publicPayloadHash: string;
  privateSolutionHash: string;
  safetyReportHash: string;
  disclosureProfileHash: string;
}

export type SceneActivationVerdict =
  | {
      ok: true;
      activeContract: ActiveSceneContract;
      reasonCodes: string[];
    }
  | {
      ok: false;
      errorCode:
        | "no_activate_permission"
        | "scene_not_staged"
        | "scene_safety_not_approved"
        | "critic_not_approved"
        | "hash_mismatch"
        | "plan_hash_mismatch"
        | "epoch_mismatch"
        | "budget_insufficient"
        | "formal_practice_mismatch"
        | "already_active";
      reasonCodes: string[];
    };

// ─── 确定性哈希（SEC-01 静态扫描兼容，trust-service 同款）────────────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const pairs: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    pairs.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${pairs.join(",")}}`;
}

function sha256Hex(data: string): string {
  const hash = createHash("sha256");
  const update = hash.update.bind(hash);
  update(data, "utf8");
  return hash.digest("hex");
}

/** 计算 activation nonce（exactly-once；同冻结输入恒等）。 */
export function computeActivationNonce(input: {
  sceneId: string;
  probeId: string;
  planHash: string;
  publicPayloadHash: string;
  privateSolutionHash: string;
  runtimeEpoch: number;
  episodeEpoch: number;
}): string {
  return sha256Hex(
    "scene-activation-v1:" +
      stableStringify({
        sceneId: input.sceneId,
        probeId: input.probeId,
        planHash: input.planHash,
        publicPayloadHash: input.publicPayloadHash,
        privateSolutionHash: input.privateSolutionHash,
        runtimeEpoch: input.runtimeEpoch,
        episodeEpoch: input.episodeEpoch,
      }),
  );
}

/** 从校验输入构造 immutable active contract（纯函数）。 */
export function buildActiveSceneContract(
  input: SceneActivationInput,
  probeHashes: ProbeHashSet,
): ActiveSceneContract {
  const nonce = computeActivationNonce({
    sceneId: input.scene.sceneId,
    probeId: input.probe.probeId,
    planHash: input.episode.planHash,
    publicPayloadHash: probeHashes.publicPayloadHash,
    privateSolutionHash: probeHashes.privateSolutionHash,
    runtimeEpoch: input.episode.runtimeEpochSnapshot,
    episodeEpoch: input.episode.episodeEpoch,
  });
  const activeContractId = `active:${nonce}`;
  return {
    contractVersion: "active-scene-contract-v1",
    activeContractId,
    sceneId: input.scene.sceneId,
    probeId: input.probe.probeId,
    mode: input.scene.mode,
    publicSceneContract: {
      contractVersion: "public-scene-contract-v1",
      sceneId: input.scene.sceneId,
      probeId: input.probe.probeId,
      sceneType: input.scene.sceneType,
      template: input.scene.template,
      version: input.scene.version,
      mode: input.scene.mode,
      targetKeyPointId: input.scene.target.keyPointId,
      publicPayload: input.scene.public,
      publicPayloadHash: probeHashes.publicPayloadHash,
      disclosureProfileHash: probeHashes.disclosureProfileHash,
      templateTrustCeiling: input.scene.templateTrustCeiling,
      a11yEquivalentPaths: input.scene.a11yEquivalentPaths,
    },
    privateSolutionRef: {
      privateSolutionId: input.probe.privateSolutionId,
      privateSolutionHash: probeHashes.privateSolutionHash,
      sceneId: input.scene.sceneId,
    },
    hashes: {
      publicPayloadHash: probeHashes.publicPayloadHash,
      privateSolutionHash: probeHashes.privateSolutionHash,
      disclosureProfileHash: probeHashes.disclosureProfileHash,
      safetyReportHash: probeHashes.safetyReportHash,
      planHash: input.episode.planHash,
    },
    epochSnapshot: {
      runtimeEpoch: input.episode.runtimeEpochSnapshot,
      episodeEpoch: input.episode.episodeEpoch,
    },
    budgetEnvelopeRef: input.episode.budgetEnvelopeRef,
    budgetEnvelopeHash: input.episode.budgetEnvelopeHash,
    safetyReportId: input.safetyReport.reportId,
    immutable: true,
    activationNonce: nonce,
  };
}

// ─── 校验核心（纯函数）───────────────────────────────────────────────────

/** 提取与冻结 FrozenProbeRef 逐项一致的 hash 集合；不一致 → null。 */
export function resolveProbeHashes(
  input: SceneActivationInput,
): ProbeHashSet | null {
  const probe = input.episode.frozenProbes.find(
    (p) => p.probeId === input.probe.probeId,
  );
  if (!probe) return null;
  if (
    probe.publicSceneContractId !== input.probe.publicSceneContractId ||
    probe.privateSolutionId !== input.probe.privateSolutionId ||
    probe.publicPayloadHash !== input.scene.publicPayloadHash ||
    probe.privateSolutionHash !== input.scene.secretSolutionHash ||
    probe.sceneSafetyReportHash !== input.safetyReport.reportHash ||
    probe.disclosureProfileHash !== computeDisclosureProfileHash(input.scene) ||
    probe.templateTrustCeiling !== input.scene.templateTrustCeiling
  ) {
    return null;
  }
  return {
    probeId: probe.probeId,
    publicPayloadHash: probe.publicPayloadHash,
    privateSolutionHash: probe.privateSolutionHash,
    safetyReportHash: probe.sceneSafetyReportHash,
    disclosureProfileHash: probe.disclosureProfileHash,
  };
}

/** 事务内全部确定性校验（纯函数，不写入）。 */
export function validateSceneActivation(
  input: SceneActivationInput,
  ports: ActivationPorts,
): SceneActivationVerdict {
  if (!isActivationAuthorizedActor(input.actor)) {
    return {
      ok: false,
      errorCode: "no_activate_permission",
      reasonCodes: [`actor_not_authorized:${input.actor}`],
    };
  }

  const staging = ports.readStagingStatus(input.scene.sceneId);
  if (staging.status !== "staged") {
    return {
      ok: false,
      errorCode: "scene_not_staged",
      reasonCodes: [`staging_status:${staging.status}`],
    };
  }

  if (input.safetyReport.verdict !== SceneSafetyVerdict.APPROVED) {
    return {
      ok: false,
      errorCode: "scene_safety_not_approved",
      reasonCodes: [`safety_verdict:${input.safetyReport.verdict}`],
    };
  }
  if (!input.safetyReport.criticApproved && !input.safetyReport.staticCertificationUsed) {
    return {
      ok: false,
      errorCode: "critic_not_approved",
      reasonCodes: ["critic_not_approved_or_static_certification_missing"],
    };
  }

  const modeCheck = checkModeConsistency(input.scene);
  if (!modeCheck.ok) {
    return { ok: false, errorCode: "formal_practice_mismatch", reasonCodes: modeCheck.reasonCodes };
  }

  const probeHashes = resolveProbeHashes(input);
  if (!probeHashes) {
    return {
      ok: false,
      errorCode: "hash_mismatch",
      reasonCodes: ["frozen_probe_hashes_mismatch"],
    };
  }

  const planOk = ports.verifyPlanHash(input.episode, probeHashes);
  if (!planOk) {
    return { ok: false, errorCode: "plan_hash_mismatch", reasonCodes: ["plan_hash_does_not_cover_probe"] };
  }

  // epoch 重比较（03-6）：当前值缺失（null）→ fail closed。
  if (
    input.currentEpoch.runtimeEpoch === null ||
    input.currentEpoch.episodeEpoch === null ||
    input.currentEpoch.runtimeEpoch !== input.episode.runtimeEpochSnapshot ||
    input.currentEpoch.episodeEpoch !== input.episode.episodeEpoch
  ) {
    return {
      ok: false,
      errorCode: "epoch_mismatch",
      reasonCodes: ["epoch_mismatch_or_missing"],
    };
  }

  // BudgetEnvelope（不可借用，01-2 §5.3）。
  if (
    input.budgetEnvelope.envelopeRef !== input.episode.budgetEnvelopeRef ||
    input.budgetEnvelope.envelopeHash !== input.episode.budgetEnvelopeHash ||
    !input.budgetEnvelope.sufficient
  ) {
    return {
      ok: false,
      errorCode: "budget_insufficient",
      reasonCodes: ["budget_envelope_mismatch_or_insufficient"],
    };
  }

  const contract = buildActiveSceneContract(input, probeHashes);
  return { ok: true, activeContract: contract, reasonCodes: [] };
}

// ─── 激活入口（唯一激活权限；exactly-once 写入）──────────────────────────

export const DEFAULT_ACTIVATION_PORTS: ActivationPorts = {
  readStagingStatus: () => ({ status: "missing" }), // 未注入 → fail closed
  verifyPlanHash: () => false, // 未注入 → fail closed
  // 未注入 → fail closed：绝不"假成功"（security_review MEDIUM #1 修复——
  // 漏注入时返回 already_active，调用方据此拒绝，避免零持久化却报成功）。
  writeActiveContract: () => ({ ok: false, code: "already_active" }),
};

/**
 * Scene Activation Service 激活入口：校验全部通过后写入一次 immutable active
 * contract（exactly-once）。写入端口返回 already_active → 拒绝（fail closed，
 * 同一 probe 不能二次激活）。
 */
export function activateSceneContract(
  input: SceneActivationInput,
  ports: ActivationPorts = DEFAULT_ACTIVATION_PORTS,
): SceneActivationVerdict {
  const verdict = validateSceneActivation(input, ports);
  if (!verdict.ok) return verdict;
  const write = ports.writeActiveContract(verdict.activeContract);
  if (!write.ok) {
    return {
      ok: false,
      errorCode: "already_active",
      reasonCodes: ["active_contract_already_written"],
    };
  }
  return verdict;
}
