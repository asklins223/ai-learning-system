/**
 * Learning Tool Gateway（阶段 03 / W2 任务 03-1，规范 03-4 §12.4）
 *
 * 按 actor 分派 allowlist，**拒绝越权**（默认拒绝）：
 * - 各 actor 使用不同工具 allowlist（Session Supervisor / Scene Author / 双 Critic /
 *   Tutor / Answer Critic / Scene Activation / Deterministic Core）；
 * - 任何 Agent actor 调用 `enter-practice` / `confirm-and-lock` / `submit` / `commit`
 *   都被确定性拒绝（forbidden product actions）；
 * - 禁止清单（01-3 §4）：任意 SQL/shell/文件系统/HTTP/插件不在 manifest 中，网关层面不可达。
 *
 * 本文件实现（任务 03-4）：
 * - actor allowlist 分派（默认拒绝）+ forbidden product actions 拒绝；
 * - executeTool 执行前 epoch 重比较（runtimeEpochSnapshot + episodeEpoch，
 *   缺失/失配 → epoch_mismatch，fail-closed）；
 * - public DTO serializer（serializePublicSceneContract / serializePublicSessionView，
 *   显式 allowlist、零 private 字段）+ sanitizePublicPayload；
 * - prompt-injection 防护（validateToolArguments：ID allowlist + HTML/JS 标记拒绝）。
 * 真实工具副作用执行（staging 写入、tool-result 事件同事务记录，01-3 §5）
 * 仍实现于 W2 后续任务（03-4 executor），executeTool 对合法工具返回 not_implemented，
 * 全程保持 0 canonical write。
 */

import type {
  LearningAgentRole,
  LearningRoleSpec,
  LearningToolCall,
  LearningToolId,
} from "../types.ts";
import { FORBIDDEN_LEARNING_TOOL_IDS } from "../types.ts";
import { createSessionSupervisorRole } from "../roles/session-supervisor.ts";
import { createSceneAuthorRole } from "../roles/scene-author.ts";
import { createRubricSceneCriticRole } from "../roles/rubric-scene-critic.ts";
import { createAssessmentCriticRole } from "../roles/assessment-critic.ts";
import { createGroundedTutorRole } from "../roles/grounded-tutor.ts";
import { createGroundedAnswerCriticRole } from "../roles/grounded-answer-critic.ts";

/** deterministic（非 LLM）角色的 allowlist，定义在网关层（无 roles/ 文件） */
const DETERMINISTIC_ROLE_TOOL_IDS: Readonly<Record<LearningAgentRole, readonly LearningToolId[]>> = {
  scene_activation: ["activate_scene_contract"],
  deterministic_core: [
    "dispatch_independent_assess",
    "lock_response_artifact",
    "run_rubric_reducer",
    "existing_domain_commit",
    "record_outbox",
    "consume_schedule",
  ],
  // 占位：以下字段由 LLM 角色工厂填充，构建后覆盖
  session_supervisor: [],
  scene_author: [],
  rubric_scene_critic: [],
  assessment_critic: [],
  grounded_tutor: [],
  grounded_answer_critic: [],
};

/** 工具执行请求 */
export interface LearningToolExecutionRequest {
  actor: LearningAgentRole;
  toolId: string;
  args: Record<string, unknown>;
  /** 幂等键（side-effect tool 必须携带；01-3 §5） */
  idempotencyKey: string | null;
  runId: string;
  sessionId: string;
  episodeId: string;
  turnNo: number;
  /** contract epoch 快照（任务 03-6：执行前重比较） */
  runtimeEpochSnapshot: number;
  episodeEpoch: number;
}

/**
 * 当前 contract 的 epoch 快照（任务 03-4 / 03-6 执行前重比较来源）。
 *
 * `null` 表示「当前 epoch 未知」：网关按 fail-closed 拒绝（epoch_mismatch），
 * 不依赖任何陈旧/缺失的 epoch 执行工具（hard kill / privacy incident 后
 * 迟到响应无法恢复为 trusted）。
 */
export interface LearningEpochSnapshot {
  readonly runtimeEpoch: number | null;
  readonly episodeEpoch: number | null;
}

/**
 * epoch provider：从当前 contract/state 重新读取 epoch（执行前重比较）。
 * 返回 `null` 或含 `null` 字段的快照 = 缺失，按 epoch_mismatch 拒绝。
 */
export type LearningEpochProvider = (
  request: LearningToolExecutionRequest,
) => LearningEpochSnapshot | null;

/** 默认 provider：无注入时不提供任何已知 epoch（fail-closed → epoch_mismatch） */
const DEFAULT_EPOCH_PROVIDER: LearningEpochProvider = () => null;

/** 工具执行结果 */
export type LearningToolExecutionResult =
  | { ok: true; payload: Record<string, unknown> }
  | {
      ok: false;
      error: {
        code:
          | "tool_not_allowed"
          | "tool_unknown"
          | "missing_idempotency_key"
          | "epoch_mismatch"
          | "not_implemented"
          | "executor_error";
        message: string;
      };
    };

/**
 * 救火 4（审计 #4）：工具副作用 executor 注入端口。
 *
 * 骨架阶段所有合法工具返回 not_implemented；真实实现经此端口分派：
 * - 读工具（read_*）返回净化数据（不含 hidden rubric/solution/evidence）；
 * - 写工具（submit_ / lock_ / dispatch_ 前缀）由宿主注入副作用实现（staging 写入、
 *   tool-result 事件同事务记录）；未注入 → fail closed executor_error。
 */
export interface LearningToolExecutor {
  execute(request: LearningToolExecutionRequest): Promise<LearningToolExecutionResult>;
}

/** 默认 executor：未注入 → fail closed（保持 0 canonical write） */
const DEFAULT_TOOL_EXECUTOR: LearningToolExecutor = {
  async execute(request) {
    return {
      ok: false,
      error: {
        code: "executor_error",
        message: `工具 ${request.toolId} 的 executor 未注入（救火 4：宿主应用在 worker 初始化时接入真实实现）`,
      },
    };
  },
};

/**
 * Learning Tool Gateway。
 *
 * allowlist 来源：
 * - 六个 LLM 角色工厂（roles/）的 allowedToolIds；
 * - deterministic 角色内联 allowlist；
 * - forbidden product actions 对任意 actor 拒绝。
 */
export class LearningToolGateway {
  private readonly allowlists: Record<LearningAgentRole, Set<LearningToolId>>;
  private readonly epochProvider: LearningEpochProvider;
  private readonly toolExecutor: LearningToolExecutor;

  constructor(
    llmRoleSpecs: readonly LearningRoleSpec[] = [
      createSessionSupervisorRole(),
      createSceneAuthorRole(),
      createRubricSceneCriticRole(),
      createAssessmentCriticRole(),
      createGroundedTutorRole(),
      createGroundedAnswerCriticRole(),
    ],
    epochProvider: LearningEpochProvider = DEFAULT_EPOCH_PROVIDER,
    toolExecutor: LearningToolExecutor = DEFAULT_TOOL_EXECUTOR,
  ) {
    const allowlists: Record<LearningAgentRole, Set<LearningToolId>> = {
      session_supervisor: new Set<LearningToolId>(),
      scene_author: new Set<LearningToolId>(),
      rubric_scene_critic: new Set<LearningToolId>(),
      assessment_critic: new Set<LearningToolId>(),
      grounded_tutor: new Set<LearningToolId>(),
      grounded_answer_critic: new Set<LearningToolId>(),
      scene_activation: new Set<LearningToolId>(DETERMINISTIC_ROLE_TOOL_IDS.scene_activation),
      deterministic_core: new Set<LearningToolId>(DETERMINISTIC_ROLE_TOOL_IDS.deterministic_core),
    };
    for (const spec of llmRoleSpecs) {
      const set = allowlists[spec.role];
      if (set) {
        for (const toolId of spec.allowedToolIds) {
          set.add(toolId);
        }
      }
    }
    this.allowlists = allowlists;
    this.epochProvider = epochProvider;
    this.toolExecutor = toolExecutor;
  }

  /** 检查某 actor 是否允许某工具（默认拒绝） */
  isToolAllowed(actor: LearningAgentRole, toolId: string): boolean {
    const allowlist = this.allowlists[actor];
    if (!allowlist) return false;
    // forbidden product actions：对任意 actor 一律拒绝
    if ((FORBIDDEN_LEARNING_TOOL_IDS as readonly string[]).includes(toolId)) return false;
    return allowlist.has(toolId as LearningToolId);
  }

  /** 获取某 actor 的全部允许工具 ID */
  getToolsForRole(actor: LearningAgentRole): readonly LearningToolId[] {
    const allowlist = this.allowlists[actor];
    return allowlist ? [...allowlist] : [];
  }

  /**
   * 执行一次工具调用。
   *
   * 执行顺序（任务 03-4 / 03-6）：
   * 1. allowlist 校验（越权 → tool_not_allowed）；
   * 2. epoch 重比较（runtimeEpochSnapshot + episodeEpoch，缺失/失配 → epoch_mismatch，
   *    fail-closed：无注入 epoch provider 或当前 epoch 未知一律拒绝）；
   * 3. side-effect tool 幂等键要求（缺失 → missing_idempotency_key）；
   * 4. 真实副作用 executor（staging 写入、tool-result 事件同事务记录，01-3 §5）
   *    实现于后续任务——当前对合法工具返回 not_implemented，保持 0 canonical write。
   */
  executeTool(request: LearningToolExecutionRequest): Promise<LearningToolExecutionResult> {
    // 1. allowlist 校验（默认拒绝，越权尝试全部被网关拒绝——任务 03-4 验收）
    if (!this.isToolAllowed(request.actor, request.toolId)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "tool_not_allowed",
          message: `actor ${request.actor} 无权调用工具 ${request.toolId}`,
        },
      });
    }
    // 2. epoch 重比较（任务 03-6：所有 turn/tool 结果落库前重新比较 contract epoch；
    //    缺失（provider 未注入 / 当前 epoch 未知）与失配都按 epoch_mismatch 拒绝）
    const epochCheck = this.checkEpoch(request);
    if (!epochCheck.ok) {
      return Promise.resolve({
        ok: false,
        error: { code: "epoch_mismatch", message: epochCheck.reason },
      });
    }
    // 3. 幂等键要求（side-effect tool 必须携带）
    if (request.idempotencyKey === null && request.toolId !== "read_purified_contract_summary") {
      // 骨架简化：所有工具统一要求幂等键（除纯读净化合同外）；严格清单实现于 W2 后续任务。
      return Promise.resolve({
        ok: false,
        error: { code: "missing_idempotency_key", message: `工具 ${request.toolId} 缺少幂等键` },
      });
    }
    // 4. 救火 4：真实工具副作用经注入 executor 分派（读工具返回净化数据、
    //    写工具由宿主接入 staging 落库）；未注入 → fail closed executor_error，
    //    保持 0 canonical write（epoch 校验与 DTO 序列化为完整实现）。
    return this.toolExecutor.execute(request);
  }

  /**
   * 执行前 epoch 重比较（任务 03-6）。
   *
   * 从 epochProvider 重新读取当前 contract 的 runtimeEpoch + episodeEpoch，
   * 与请求携带值逐项比较；provider 返回 null 或任一 epoch 为 null（缺失）即拒绝，
   * 保证 hard kill / privacy incident 后迟到响应不能以 stale epoch 执行。
   */
  private checkEpoch(
    request: LearningToolExecutionRequest,
  ): { ok: true } | { ok: false; reason: string } {
    const current = this.epochProvider(request);
    if (!current) {
      return {
        ok: false,
        reason: `当前 contract epoch 不可得（runtimeEpochSnapshot=${request.runtimeEpochSnapshot}, episodeEpoch=${request.episodeEpoch}），fail-closed 拒绝`,
      };
    }
    if (current.runtimeEpoch === null || current.episodeEpoch === null) {
      return {
        ok: false,
        reason: "当前 contract epoch 缺失（runtimeEpoch 或 episodeEpoch 为 null），fail-closed 拒绝",
      };
    }
    if (
      current.runtimeEpoch !== request.runtimeEpochSnapshot ||
      current.episodeEpoch !== request.episodeEpoch
    ) {
      return {
        ok: false,
        reason: `epoch 失配：current runtime=${current.runtimeEpoch}/episode=${current.episodeEpoch}，请求 runtime=${request.runtimeEpochSnapshot}/episode=${request.episodeEpoch}`,
      };
    }
    return { ok: true };
  }
}

/** 单例网关（默认 allowlist） */
export const learningToolGateway = new LearningToolGateway();

// ─── 供上层 turn 执行使用的辅助函数 ──────────────────────────────────────

/**
 * 从 turn 结果中按网关 allowlist 过滤工具调用：
 * 越权的 tool calls 一律剔除并留痕（0 canonical write）。
 * 骨架：完整越权审计事件（tool_request 记录）实现于 W2 后续任务。
 */
export function filterAllowedToolCalls(
  gateway: LearningToolGateway,
  actor: LearningAgentRole,
  toolCalls: readonly LearningToolCall[],
): LearningToolCall[] {
  return toolCalls.filter((call) => gateway.isToolAllowed(actor, call.name));
}

// ─── public DTO serializer（任务 03-4：显式 allowlist，零 private 字段）────

/**
 * 私有字段集合：任何 public DTO 都**绝不**输出这些字段
 * （expectedTargetRef / privateSolutionHash / rubricTargets /
 *   schedulingDecision / assistanceSnapshot；03-4 验收：public DTO 零 private 字段）。
 * 这些数据只供服务端内部 actor 读取（01-2 §5 / §12.4）。
 */
export const PUBLIC_DTO_FORBIDDEN_FIELDS: readonly string[] = [
  "expectedTargetRef",
  "privateSolutionHash",
  "rubricTargets",
  "schedulingDecision",
  "assistanceSnapshot",
];
const PUBLIC_DTO_FORBIDDEN_SET: ReadonlySet<string> = new Set(PUBLIC_DTO_FORBIDDEN_FIELDS);

/**
 * 通用净化函数：仅输出 `allowlistKeys` 内的字段，且始终剔除私有字段
 * （即使 allowlistKeys 误含私有字段名也不输出）；缺失（undefined/null）即省略。
 * 非 allowlist / 私有 / 缺失三类输入一律不进入输出。
 */
export function sanitizePublicPayload(
  payload: Record<string, unknown>,
  allowlistKeys: readonly string[],
): Record<string, unknown> {
  const allowlist = new Set(allowlistKeys);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    if (!allowlist.has(key)) continue; // 非 allowlist 字段：剔除
    if (PUBLIC_DTO_FORBIDDEN_SET.has(key)) continue; // 私有字段：绝不输出
    const value = payload[key];
    if (value === undefined || value === null) continue; // 缺失即省略
    out[key] = value;
  }
  return out;
}

/** 从净化结果读取必需字符串字段；缺失/类型错误 → 抛错（fail-closed） */
function requireString(
  source: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${where}: 必需 public 字段 ${key} 缺失或类型错误`);
  }
  return value;
}

/** public Scene contract 视图（只含展示安全的 allowlist 字段） */
export interface PublicSceneContractView {
  readonly sceneId: string;
  readonly probeId: string;
  readonly sceneTemplate: string;
  readonly sceneVersion: string;
  readonly publicPayloadHash: string;
  readonly disclosureProfileHash: string;
  readonly templateTrustCeiling: string;
}

/** public Scene contract 显式 allowlist 字段（其余一律不输出） */
export const PUBLIC_SCENE_CONTRACT_KEYS: readonly string[] = [
  "sceneId",
  "probeId",
  "sceneTemplate",
  "sceneVersion",
  "publicPayloadHash",
  "disclosureProfileHash",
  "templateTrustCeiling",
];

/**
 * 序列化 public Scene contract（任务 03-4）：
 * - 只输出显式 allowlist 字段；
 * - 私有字段（privateSolutionHash / rubricTargets / expectedTargetRef 等）绝不输出；
 * - 必需字段缺失 → 抛错（拒绝输出不完整视图）。
 */
export function serializePublicSceneContract(
  input: Record<string, unknown>,
): PublicSceneContractView {
  const sanitized = sanitizePublicPayload(input, PUBLIC_SCENE_CONTRACT_KEYS);
  return {
    sceneId: requireString(sanitized, "sceneId", "serializePublicSceneContract"),
    probeId: requireString(sanitized, "probeId", "serializePublicSceneContract"),
    sceneTemplate: requireString(sanitized, "sceneTemplate", "serializePublicSceneContract"),
    sceneVersion: requireString(sanitized, "sceneVersion", "serializePublicSceneContract"),
    publicPayloadHash: requireString(sanitized, "publicPayloadHash", "serializePublicSceneContract"),
    disclosureProfileHash: requireString(sanitized, "disclosureProfileHash", "serializePublicSceneContract"),
    templateTrustCeiling: requireString(sanitized, "templateTrustCeiling", "serializePublicSceneContract"),
  };
}

/** public Session 视图（route/summary 等展示安全字段，不含调度/协助决策） */
export interface PublicSessionView {
  readonly sessionId: string;
  readonly status: string;
  readonly currentPhase: string;
  readonly routeSummary: string;
  readonly episodeIds: readonly string[];
  readonly completedEpisodeCount: number;
  readonly lastActiveAt: string;
}

/** public Session 显式 allowlist 字段（schedulingDecision/assistanceSnapshot 属私有，绝不输出） */
export const PUBLIC_SESSION_VIEW_KEYS: readonly string[] = [
  "sessionId",
  "status",
  "currentPhase",
  "routeSummary",
  "episodeIds",
  "completedEpisodeCount",
  "lastActiveAt",
];

/**
 * 序列化 public Session 视图（任务 03-4）：
 * - 只输出显式 allowlist 字段；schedulingDecision / assistanceSnapshot /
 *   rubricTargets 等私有字段绝不输出（缺失即省略）；
 * - 必需字段缺失 → 抛错。
 */
export function serializePublicSessionView(
  input: Record<string, unknown>,
): PublicSessionView {
  const sanitized = sanitizePublicPayload(input, PUBLIC_SESSION_VIEW_KEYS);
  const episodeIds = Array.isArray(sanitized.episodeIds)
    ? sanitized.episodeIds.map((item) => String(item))
    : [];
  const completedEpisodeCount =
    typeof sanitized.completedEpisodeCount === "number" ? sanitized.completedEpisodeCount : 0;
  return {
    sessionId: requireString(sanitized, "sessionId", "serializePublicSessionView"),
    status: requireString(sanitized, "status", "serializePublicSessionView"),
    currentPhase: requireString(sanitized, "currentPhase", "serializePublicSessionView"),
    routeSummary: requireString(sanitized, "routeSummary", "serializePublicSessionView"),
    episodeIds,
    completedEpisodeCount,
    lastActiveAt: requireString(sanitized, "lastActiveAt", "serializePublicSessionView"),
  };
}

// ─── prompt-injection 防护（任务 03-4：validateToolArguments）──────────────

/** HTML/JS 脚本形态参数启发式标记（大小写不敏感） */
export const HTML_JS_INJECTION_MARKERS: readonly string[] = [
  "<script",
  "javascript:",
  "data:text/html",
];
const HTML_JS_INJECTION_LOWER: readonly string[] = HTML_JS_INJECTION_MARKERS.map((marker) =>
  marker.toLowerCase(),
);

/** 字符串参数是否包含 HTML/JS 脚本注入标记 */
function containsInjectionMarker(value: string): boolean {
  const lower = value.toLowerCase();
  return HTML_JS_INJECTION_LOWER.some((marker) => lower.includes(marker));
}

/** 判断键是否为 ID/引用字段（id、probeId、evidenceRefIds、targetRef 等） */
function isIdFieldKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === "id" || lower === "ids") return true;
  if (lower.endsWith("id") || lower.endsWith("ids")) return true; // *_id / probeId / episodeIds
  if (lower.endsWith("ref") || lower.endsWith("refs")) return true; // targetRef / evidenceRefs
  return false;
}

/** 参数校验结果 */
export type ToolArgumentValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/** 默认 ID allowlist：不显式传入时为空集，任何 ID 值都被拒绝（fail-closed） */
export const DEFAULT_ID_ALLOWLIST: readonly string[] = [];

/**
 * prompt-injection 对抗（03-4 / 01-4，对抗集）：
 * - ID/引用字段的值必须属于 `idAllowlist`（拒绝任意字符串 / 路径穿越 / 脚本形态 ID）；
 * - 任意字符串参数不得包含 HTML/JS 脚本形态标记
 *   （"<script"、"javascript:"、"data:text/html"，大小写不敏感）；
 * - 数组逐元素、嵌套对象递归检查；
 * - 非法 ID（如 "../etc"、"<script>alert(1)</script>"）与脚本形态参数一律拒绝。
 */
export function validateToolArguments(
  toolId: string,
  args: Record<string, unknown>,
  idAllowlist: readonly string[] = DEFAULT_ID_ALLOWLIST,
): ToolArgumentValidationResult {
  return validateValue(toolId, args, new Set(idAllowlist), "$");
}

/** 递归校验参数树 */
function validateValue(
  toolId: string,
  value: unknown,
  idSet: ReadonlySet<string>,
  path: string,
): ToolArgumentValidationResult {
  if (typeof value === "string") {
    if (containsInjectionMarker(value)) {
      return { ok: false, reason: `工具 ${toolId} 参数 ${path} 含 HTML/JS 脚本形态内容，拒绝` };
    }
    return { ok: true };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const result = validateValue(toolId, value[i], idSet, `${path}[${i}]`);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (isIdFieldKey(key)) {
        const idCheck = checkIdValue(toolId, key, item, idSet, `${path}.${key}`);
        if (!idCheck.ok) return idCheck;
      }
      const result = validateValue(toolId, item, idSet, `${path}.${key}`);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  // number / boolean / null：无字符串形态，放行
  return { ok: true };
}

/** ID/引用字段：值（或数组的每个元素）必须为 allowlist 内的字符串 */
function checkIdValue(
  toolId: string,
  key: string,
  value: unknown,
  idSet: ReadonlySet<string>,
  path: string,
): ToolArgumentValidationResult {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const result = checkSingleId(toolId, key, value[i], idSet, `${path}[${i}]`);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  return checkSingleId(toolId, key, value, idSet, path);
}

function checkSingleId(
  toolId: string,
  key: string,
  value: unknown,
  idSet: ReadonlySet<string>,
  path: string,
): ToolArgumentValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: `工具 ${toolId} 参数 ${path}（ID 字段 ${key}）必须为字符串` };
  }
  if (!idSet.has(value)) {
    return {
      ok: false,
      reason: `工具 ${toolId} 参数 ${path}（ID 字段 ${key}）值 "${value}" 不在 allowlist 中，拒绝`,
    };
  }
  return { ok: true };
}
