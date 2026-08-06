/**
 * PERF-04 拆分：NoteEditor 纯工具函数。
 *
 * 此模块从 NoteEditor.tsx 中提取所有无状态的工具函数，
 * 包括生成阶段标签映射、失败单元解析、图片上传进度计算等。
 * 这些函数不依赖 React hooks，可独立测试。
 */

import { ApiError } from "@/lib/api";
import type {
  Block,
  CardGenerationRunStatus,
  CardGenerationRunView,
} from "@/lib/api";
import type { StatusTone } from "@/lib/status-map";
import type {
  FailedGenerationUnit,
  ImageUploadStatus,
  ImageUploadView,
  SavingState,
} from "./note-editor-types";
import { ACTIVE_GENERATION_RUN_STATUSES } from "./note-editor-types";

// ─── 生成运行状态判断 ──────────────────────────────────────────────

export function isActiveGenerationRun(status: CardGenerationRunStatus): boolean {
  return ACTIVE_GENERATION_RUN_STATUSES.has(status);
}

/**
 * 生成阶段标签映射（计划 §12）。
 *
 * 四阶段：preparing | generating | checking | publishing
 * - supervisor_agent_v1 引擎使用 shellStage 字段
 */
export function generationStageLabel(
  stage: string,
  status: CardGenerationRunStatus,
  shellStage: string | null = null,
): string {
  if (status === "needs_attention") return "生成需要处理";
  if (status === "partial_ready") return "部分结果已就绪";

  // Supervisor Agent v1 使用四阶段 shellStage
  if (shellStage) {
    const shellLabels: Record<string, string> = {
      preparing: "准备素材",
      generating: "提炼卡片",
      checking: "引用与覆盖校验",
      publishing: "发布卡组",
    };
    return shellLabels[shellStage] ?? "处理中";
  }

  // fallback：使用 stage 字段
  const key = stage || status;
  const labels: Record<string, string> = {
    queued: "等待处理",
    preparing: "准备素材",
    running: "提炼卡片",
    validating: "引用与覆盖校验",
    publishing: "发布卡组",
    snapshot: "封存版本",
    complete: "处理完成",
  };
  return labels[key] ?? "处理中";
}

export function generationRunMessage(run: CardGenerationRunView): string {
  const version = run.sourceSnapshot.versionNo;
  if (run.status === "succeeded") {
    return `v${version} 的学习卡已生成，可继续查看结果。`;
  }
  if (run.status === "partial_ready") {
    return `v${version} 的部分结果已生成；它不会替换已有完整学习卡。`;
  }
  if (run.status === "cancelled") {
    return `已取消基于 v${version} 的学习卡生成。`;
  }
  if (run.status === "superseded") {
    return `v${version} 的生成结果已被更新版本取代。`;
  }
  if (run.status === "needs_attention") {
    return `v${version} 的生成已按严格覆盖规则暂停，请处理失败素材后继续。`;
  }
  if (run.status === "failed" || run.status === "terminal_failed") {
    return `生成未完成（${run.error?.code ?? "generation_failed"}）。`;
  }
  // 使用 shellStage 优先，否则使用 stage
  const stage = generationStageLabel(run.stage, run.status, run.shellStage);
  return `${stage} · ${generationProgressLabel(run.progress)}；你可以继续编辑，新修改会进入下一版本。`;
}

/**
 * 生成进度文案。
 *
 * supervisor_agent_v1 引擎以 unit="percent"、total=100 表达整体完成百分比，
 * 旧引擎以 unit="blocks" 按素材块计数。统一在此格式化，避免把英文 unit
 * 原样拼进中文文案（如 "0/100 percent"）。
 */
export function generationProgressLabel(progress: {
  completed: number;
  total: number;
  unit: string;
}): string {
  if (progress.total <= 0) return "等待首个进度";
  if (progress.unit === "percent") {
    return `${Math.max(0, Math.min(100, Math.round(progress.completed)))}%`;
  }
  return `${progress.completed}/${progress.total}`;
}

export function measuredCoverageLabel(
  completed: number,
  total: number,
  basisPoints: number | null,
): string {
  const count = `${completed}/${total}`;
  if (basisPoints == null) return `${count} · 待测量`;
  return `${count} · ${basisPoints / 100}%`;
}

/**
 * C1（计划 §2.6）：将 shellStage 映射到四阶段步骤的完成状态。
 *
 * shellStage 值: preparing | generating | checking | publishing
 * 返回每个步骤的 data-state: "done" | "active" | "upcoming"
 *
 * 被 GenerationOverlay 与生成进度弹窗的阶段轨道共用。
 */
export type ShellStageStepState = "done" | "active" | "upcoming";
export type ShellStageStepStates = {
  prepare: ShellStageStepState;
  agentRun: ShellStageStepState;
  verify: ShellStageStepState;
  publish: ShellStageStepState;
};

export function shellStageStepStates(shellStage: string | null | undefined): ShellStageStepStates {
  const order = ["preparing", "generating", "checking", "publishing"];
  const idx = shellStage ? order.indexOf(shellStage) : -1;
  if (idx === -1) {
    return { prepare: "upcoming", agentRun: "upcoming", verify: "upcoming", publish: "upcoming" };
  }
  const state = (i: number): ShellStageStepState =>
    i < idx ? "done" : i === idx ? "active" : "upcoming";
  return {
    prepare: state(0),
    agentRun: state(1),
    verify: state(2),
    publish: state(3),
  };
}

// ─── 真实进度（metrics 推导） ──────────────────────────────────────

/** 把 run.stage 回退值归一化为四阶段 key（shellStage 缺失时用）。 */
function stageKeyOf(run: CardGenerationRunView): string {
  if (run.shellStage) return run.shellStage;
  const stage = run.stage;
  if (stage === "queued" || stage === "preparing") return "preparing";
  if (stage === "running") return "generating";
  if (stage === "validating" || stage === "checking") return "checking";
  if (stage === "publishing") return "publishing";
  return stage;
}

/**
 * 从 run 的真实计数（metrics）推导总体进度百分比。
 *
 * `run.progress` 是后端合成百分比（unit="percent"），活动期常为 0、
 * 完成时才跳到 100，不能反映中间进展。这里按 shellStage 阶段权重
 * 映射，各阶段内用真实计数（childTasks/candidates/verify/bundles）
 * 的完成比例作为"阶段内进度"，让进度条随真实工作推进，而不是
 * 0→100 跳变。权重只影响条的视觉分布，不改变任何计数语义。
 *
 * 阶段权重：preparing 0–15 / generating 15–70 / checking 70–88 /
 * publishing 88–100。succeeded 终态固定 100。
 */
export function measuredGenerationPercent(run: CardGenerationRunView): number {
  const m = run.metrics;
  if (!m) {
    // 无 metrics（旧引擎）：回退合成百分比，但活动 run 禁止提前 100。
    const legacy = run.progress.total > 0
      ? Math.round((run.progress.completed / run.progress.total) * 100)
      : 0;
    const clamped = Math.max(0, Math.min(100, legacy));
    return isActiveGenerationRun(run.status) ? Math.min(clamped, 95) : clamped;
  }

  // 终态：succeeded 直接 100；其它终态（attention/failed/cancelled/partial）
  // 停在当前阶段的估算值，不强行拉满。
  if (!isActiveGenerationRun(run.status)) {
    if (run.status === "succeeded") return 100;
  }

  const stage = stageKeyOf(run);
  const STAGE_BASE: Record<string, number> = {
    preparing: 0,
    generating: 15,
    checking: 70,
    publishing: 88,
  };
  const STAGE_SPAN: Record<string, number> = {
    preparing: 15,
    generating: 55,
    checking: 18,
    publishing: 12,
  };
  const base = STAGE_BASE[stage] ?? 0;
  const span = STAGE_SPAN[stage] ?? 0;

  let within = 0;
  if (stage === "generating") {
    const total = m.childTasks.pending + m.childTasks.running + m.childTasks.completed + m.childTasks.failed;
    if (total > 0) {
      within = (m.childTasks.completed + m.childTasks.failed) / total;
    } else if (m.candidates.extracted > 0) {
      within = 0.5; // 候选已提取但任务计数未就绪 → 半程
    }
  } else if (stage === "checking") {
    const verify = m.verify;
    if (verify && verify.totalChecks > 0) {
      within = Math.min(1, verify.passedChecks / verify.totalChecks);
    } else if (m.critic.status === "passed") {
      within = 1;
    } else {
      within = 0.5; // 校验未报告逐项结果 → 阶段内半程
    }
  } else if (stage === "publishing") {
    within = run.result?.cardSetId || run.result?.cardId ? 1 : 0.6;
  } else if (stage === "preparing") {
    const denominator = m.bundles.planned + m.bundles.required;
    within = denominator > 0
      ? Math.min(1, (m.bundles.assigned + m.bundles.decided) / denominator)
      : 0.3;
  }

  return Math.max(0, Math.min(100, Math.round(base + span * within)));
}

// ─── 预计剩余时间（基于推进速率，非单点线性外推） ─────────────────

export interface EtaSample {
  elapsed: number;
  percent: number;
}

export interface EtaState {
  /** 预计剩余秒数；null 表示数据不足（还没进入生成阶段 / 尚无推进速率）。 */
  remainingSeconds: number | null;
  sample: EtaSample | null;
  /** 平滑推进速率（%/s），EWMA(0.3 新 / 0.7 旧）。 */
  rate: number | null;
}

/**
 * 推进一帧 ETA 估算。
 *
 * 不用单点线性外推 `elapsed*(100-p)/p`：percent 基于真实计数，是粗粒度
 * 台阶（每完成一个子任务才跳一档），档位之间 percent 不变而 elapsed 每秒
 * 增长，会让外推值单调膨胀（"越等越多"）。这里跟踪最近一次进度推进的
 * 速率 `dp/dt`，档位之间速率保持稳定 → ETA 不虚涨，只在进度推进时更新。
 */
export function advanceEta(
  percent: number,
  elapsedSeconds: number,
  sample: EtaSample | null,
  rate: number | null,
): EtaState {
  if (percent < 15) return { remainingSeconds: null, sample, rate };
  if (percent >= 100) return { remainingSeconds: 0, sample, rate };

  const next: EtaState = { remainingSeconds: null, sample, rate };
  if (sample && percent > sample.percent) {
    const dt = elapsedSeconds - sample.elapsed;
    const dp = percent - sample.percent;
    if (dt > 0 && dp > 0) {
      const instantRate = dp / dt;
      next.rate = rate == null ? instantRate : rate * 0.7 + instantRate * 0.3;
    }
    next.sample = { elapsed: elapsedSeconds, percent };
  } else if (!sample) {
    next.sample = { elapsed: elapsedSeconds, percent };
  }

  if (next.rate != null && next.rate > 0) {
    next.remainingSeconds = Math.max(0, Math.round((100 - percent) / next.rate));
  }
  return next;
}

// ─── 类型守卫 ─────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── 失败生成单元解析 ─────────────────────────────────────────────

/**
 * 全量失败检查点。needs_attention 时弹窗按真实失败类型展示。
 */
export function getFailedGenerationUnits(run: CardGenerationRunView): FailedGenerationUnit[] {
  const warning = run.warnings.find((item) => item.code === "generation_units_failed");
  const units = warning?.details?.units;
  if (!Array.isArray(units)) return [];

  return units.flatMap((value) => {
    if (!isRecord(value) || typeof value.unitId !== "string" || typeof value.kind !== "string") {
      return [];
    }
    return [{
      unitId: value.unitId,
      kind: value.kind,
      ordinal: typeof value.ordinal === "number" ? value.ordinal : null,
      status: typeof value.status === "string" ? value.status : "failed",
      errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
    }];
  });
}

/** 失败摘要标题:按真实失败类型措辞,none 时回退到 run 级错误码。 */
export function generationFailureTitle(
  units: FailedGenerationUnit[],
  runErrorCode: string | null | undefined,
): string {
  if (units.length > 0) return `${units.length} 个处理步骤处理失败`;
  if (runErrorCode === "scheduler_capacity") return "后台任务槽位不足";
  if (runErrorCode === "no_learnable_candidate") return "未能提炼出可学习的知识点";
  return "生成需要你的处理";
}

/** 弹窗里单个失败检查点的名称。 */
export function generationFailedUnitName(
  unit: FailedGenerationUnit,
  _imageIndex: number | null,
): string {
  return unit.ordinal == null ? "处理步骤" : `处理步骤 ${unit.ordinal + 1}`;
}

export function generationUnitErrorLabel(errorCode: string | null): string {
  const labels: Record<string, string> = {
    ai_consent_required: "需要先同意工作区 AI 数据处理条款",
    external_ai_disabled: "工作区尚未允许向外部 AI 服务发送内容",
    mock_provider_blocked_in_production: "当前工作区的 AI 模型配置为 Mock，无法在生产环境中生成学习卡",
    no_draft_for_verify: "未找到可校验的草稿",
    no_quality_report: "未生成质量报告",
    prepare_failed: "素材准备失败",
    tool_error: "Agent 工具执行失败",
    provider_authentication: "AI 服务鉴权失败，请检查 API Key",
    provider_billing: "AI 服务余额或账单异常",
    provider_configuration: "AI 服务配置不可用",
    provider_config_invalid: "AI 服务地址或模型配置无效",
  };
  if (!errorCode) return "处理失败";
  return labels[errorCode] ?? "处理失败";
}

export function generationResolutionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : fallback;
  }
  const labels: Record<string, string> = {
    run_not_retryable: "当前失败已无法自动重试。",
    run_restart_required: "生成规则或 AI 设置已变化，请按当前设置重新生成。",
    stale_generation_epoch: "这次任务已被较新的生成请求取代，请刷新后查看最新任务。",
    idempotency_key_reused: "请求标识发生冲突，请重新发起操作。",
  };
  return (error.code && labels[error.code]) || error.message || fallback;
}

// ─── 图片上传工具函数 ──────────────────────────────────────────────

export function imageUploadStatusLabel(status: ImageUploadStatus): string {
  if (status === "queued") return "等待上传";
  if (status === "uploading") return "上传中";
  if (status === "failed") return "上传失败";
  if (status === "succeeded") return "上传完成";
  return "已取消";
}

export function imageUploadProgress(upload: ImageUploadView): number {
  if (upload.status === "succeeded") return 100;
  if (upload.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((upload.loaded / upload.total) * 100)));
}

// ─── 文本处理工具函数 ──────────────────────────────────────────────

export function stripMarkdownTitle(content: string): string {
  const htmlHeading = /^<h\d>([\s\S]+)<\/h\d>$/.exec(content.trim());
  if (htmlHeading) return htmlHeading[1];
  return content
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^·\s*/, "");
}

export function outlineBlockKey(block: Block): string {
  return `${block.ordinal}-${block.content}`;
}

export function markdownDownloadName(title: string, noteId: string): string {
  const safeTitle = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
  return `${safeTitle || `note-${noteId}`}.md`;
}

// ─── 生成按钮状态计算 ──────────────────────────────────────────────

/**
 * PERF-04 拆分（第十二轮）：从 NoteEditor.tsx 提取 genButton IIFE。
 *
 * 根据当前生成状态、权限和内容条件，计算生成按钮的标签、是否禁用以及点击行为。
 * 此函数是纯函数——不产生副作用，所有状态变更通过返回的 onClick 回调延迟执行。
 */
export interface GenButtonParams {
  genState: string;
  generationOverlayDismissed: boolean;
  generationPartialReady: boolean;
  hasGeneratedResult: boolean;
  generationNeedsAttention: boolean;
  isOwner: boolean;
  generatedVersionId: string | null;
  generatedIsCurrent: boolean;
  hasWritableContent: boolean;
  generationBlocked: boolean;
  conflictData: unknown;
  uploadingCount: number;
  failedImageUploadCount: number;
  hasUnresolvedImagePlaceholder: boolean;
  generatedCardHref: string;
  onShowOverlay: () => void;
  onViewCards: () => void;
  onOpenFailureDialog: () => void;
  onGenerate: () => void;
}

export interface GenButtonResult {
  label: string;
  disabled: boolean;
  onClick: () => void;
}

export function computeGenButton(params: GenButtonParams): GenButtonResult {
  const {
    genState,
    generationOverlayDismissed,
    generationPartialReady,
    hasGeneratedResult,
    generationNeedsAttention,
    isOwner,
    generatedVersionId,
    generatedIsCurrent,
    hasWritableContent,
    generationBlocked,
    conflictData,
    uploadingCount,
    failedImageUploadCount,
    hasUnresolvedImagePlaceholder,
    onShowOverlay,
    onViewCards,
    onOpenFailureDialog,
    onGenerate,
  } = params;

  // 正在确认任务状态
  if (genState === "checking" || genState === "status-error") {
    return {
      label: genState === "checking" ? "正在确认任务…" : "任务状态待确认",
      disabled: true,
      onClick: () => {},
    };
  }

  // 正在生成中
  if (genState === "generating") {
    if (generationOverlayDismissed) {
      return { label: "查看生成进度", disabled: false, onClick: onShowOverlay };
    }
    return { label: "后台生成中", disabled: true, onClick: () => {} };
  }

  // 部分就绪——已有部分结果可查看
  if (generationPartialReady && hasGeneratedResult) {
    return { label: "查看部分结果", disabled: false, onClick: onViewCards };
  }

  // 需要处理失败素材
  if (generationNeedsAttention) {
    return { label: "处理失败素材", disabled: false, onClick: onOpenFailureDialog };
  }

  // RBAC: 成员不能创建 AI 任务，但已有学习卡仍应保留清晰、可用的阅读出口
  if (!isOwner) {
    if (generatedVersionId) {
      return { label: "查看已有学习卡", disabled: false, onClick: onViewCards };
    }
    return { label: "由所有者生成", disabled: true, onClick: () => {} };
  }

  // 当前版本已生成——前往学习卡库
  if (generatedIsCurrent) {
    return { label: "前往学习卡库", disabled: false, onClick: onViewCards };
  }

  // 无可写内容
  if (!hasWritableContent) {
    if (generatedVersionId) {
      return { label: "查看已有学习卡", disabled: false, onClick: onViewCards };
    }
    return { label: "先写下内容", disabled: true, onClick: () => {} };
  }

  // 被阻塞（冲突、图片上传中等）
  if (generationBlocked) {
    const label = conflictData
      ? "先解决冲突"
      : uploadingCount > 0
        ? "等待图片上传"
        : failedImageUploadCount > 0 || hasUnresolvedImagePlaceholder
          ? "处理上传失败"
          : "暂不可生成";
    return { label, disabled: true, onClick: () => {} };
  }

  // 已有学习卡但当前版本未生成——生成新版
  if (generatedVersionId) {
    return { label: "生成新版学习卡", disabled: false, onClick: onGenerate };
  }

  // 首次生成
  return { label: "生成学习卡", disabled: false, onClick: onGenerate };
}

// ─── 保存状态展示 ──────────────────────────────────────────────────

/**
 * 保存状态 → chip 样式映射（使用语义 token）
 */
export function savingStatePresentation(
  state: SavingState,
  dirty: boolean,
): { label: string; tone: StatusTone } {
  if (state === "saving") return { label: "保存中", tone: "warning" };
  if (state === "saved") return { label: "已保存", tone: "success" };
  if (state === "error") return { label: "保存失败", tone: "danger" };
  if (state === "conflict") return { label: "内容冲突", tone: "warning" };
  if (state === "deleted") return { label: "笔记已删除", tone: "danger" };
  if (dirty) return { label: "未保存", tone: "warning" };
  return { label: "已保存", tone: "success" };
}
