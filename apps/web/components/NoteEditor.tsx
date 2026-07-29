"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, API_URL, getCsrfToken } from "@/lib/api";
import { useIsOwner } from "@/lib/use-current-user";
import { MemberNotice } from "@/components/settings/MemberNotice";
import { Icon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import {
  hasDuplicateArticleLeadHeading,
  NoteArticlePreview,
} from "@/components/NoteArticlePreview";
import dynamic from "next/dynamic";
import type { MilkdownEditorHandle } from "@/components/MilkdownEditor";
import { isCardGenerationV2Enabled } from "@/lib/feature-flags";

const MilkdownEditor = dynamic(
  () => import("@/components/MilkdownEditor").then((m) => m.MilkdownEditor),
  { ssr: false },
);
import {
  blocksToMarkdown,
  markdownToBlocks,
} from "@/lib/markdown-blocks";
import {
  normalizeNoteTitle,
  reconcileSavedNoteTitle,
} from "@/lib/note-title-save";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useModalIsolation } from "@/lib/use-modal-isolation";
import { relativeTime } from "@/lib/format";
import { statusMap } from "@/lib/status-map";
import type { StatusTone } from "@/lib/status-map";
import { StatusChip } from "@/components/ui/StatusChip";
import type {
  Block,
  CardGenerationRunStatus,
  CardGenerationRunView,
  CardGenerationStatus,
  JobRow,
  NoteVersionSummary,
} from "@/lib/api";

interface Props {
  noteId: string;
  draftScope: string;
  noteVersionId: string;
  versionNo: number;
  initialTitle: string;
  titleSource?: "auto" | "manual";
  initialBlocks: Block[];
  initialGenerationStatus: CardGenerationStatus;
  returnHref?: string;
  returnLabel?: string;
}

type EditorMode = "edit" | "preview";
type ViewMode = "normal" | "wide" | "fullscreen";
type InspectorView = "overview" | "versions";
type PreviewOutlineMode = "pinned" | "auto";
type GenerationPhase = "saving" | "queued" | "running";
type GenerationState =
  | "idle"
  | "checking"
  | "status-error"
  | "generating"
  | "generated"
  | "partial-ready";
type GenerationResolutionAction = "retrying" | "excluding" | null;

type SavingState = "idle" | "saving" | "saved" | "error" | "conflict" | "deleted";

type ImageUploadStatus = "queued" | "uploading" | "failed" | "succeeded" | "cancelled";

interface ImageUploadView {
  id: string;
  name: string;
  size: number;
  status: ImageUploadStatus;
  loaded: number;
  total: number;
  error: string | null;
}

interface ImageUploadTask extends ImageUploadView {
  file: File;
  placeholder: string;
  controller: AbortController | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

interface FailedGenerationUnit {
  unitId: string;
  kind: string;
  ordinal: number | null;
  status: string;
  errorCode: string | null;
}

type FailedGenerationImage = FailedGenerationUnit;

const LOCAL_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PREVIEW_OUTLINE_PREFERENCE_KEY = "note-editor:preview-outline-mode";
const CARD_GENERATION_RUN_STORAGE_PREFIX = "note-editor-card-generation-run:";
const CARD_GENERATION_V2_ENABLED = isCardGenerationV2Enabled();
const MAX_CONCURRENT_IMAGE_UPLOADS = 3;
const IMAGE_UPLOAD_TIMEOUT_MS = 60_000;
const IMAGE_UPLOAD_RESULT_VISIBLE_MS = 2_000;
const ACTIVE_GENERATION_RUN_STATUSES = new Set<CardGenerationRunStatus>([
  "queued",
  "planning",
  "awaiting_assets",
  "mapping",
  "reducing",
  "rendering",
  "validating",
  "publishing",
]);

function isActiveGenerationRun(status: CardGenerationRunStatus): boolean {
  return ACTIVE_GENERATION_RUN_STATUSES.has(status);
}

function generationStageLabel(stage: string, status: CardGenerationRunStatus): string {
  if (status === "needs_attention") return "生成需要处理";
  if (status === "partial_ready") return "部分结果已就绪";
  const key = stage || status;
  const labels: Record<string, string> = {
    queued: "等待处理",
    planning: "规划素材",
    source_planning: "规划素材",
    awaiting_assets: "解析图片",
    image_processing: "解析图片",
    mapping: "分片提炼",
    text_map: "分片提炼",
    reducing: "主题归并",
    reduce: "主题归并",
    rendering: "生成卡片",
    render: "生成卡片",
    validating: "引用与覆盖校验",
    validate: "引用与覆盖校验",
    publishing: "发布卡组",
    publish: "发布卡组",
    snapshot: "封存版本",
    planner: "规划素材",
    legacy_generate: "提炼卡片",
    complete: "处理完成",
  };
  return labels[key] ?? "处理中";
}

function generationRunMessage(run: CardGenerationRunView): string {
  const version = run.sourceSnapshot.versionNo;
  if (run.status === "succeeded") {
    return `v${version} 的学习卡已生成，可继续查看结果。`;
  }
  if (run.status === "partial_ready") {
    const excludedCount = getPartialCoverageDetails(run)?.excludedImageCount ?? 0;
    return `v${version} 的部分结果已生成，排除了 ${excludedCount} 张失败图片；它不会替换已有完整学习卡。`;
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
  const stage = generationStageLabel(run.stage, run.status);
  const progress = run.progress.total > 0
    ? ` ${run.progress.completed}/${run.progress.total} ${run.progress.unit}`
    : "";
  return `${stage}${progress}；你可以继续编辑，新修改会进入下一版本。`;
}

function measuredCoverageLabel(completed: number, total: number, basisPoints: number | null): string {
  const count = `${completed}/${total}`;
  if (basisPoints == null) return `${count} · 待测量`;
  return `${count} · ${basisPoints / 100}%`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 全量失败检查点(图片 + 文本分片)。needs_attention 不只发生在图片上:
 * 文本 Map 分片同样会失败,弹窗必须按真实失败类型展示,而不是把一切
 * 硬套成"图片处理失败"。
 */
function getFailedGenerationUnits(run: CardGenerationRunView): FailedGenerationUnit[] {
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

function getFailedGenerationImages(run: CardGenerationRunView): FailedGenerationImage[] {
  return getFailedGenerationUnits(run).filter((unit) => unit.kind === "image");
}

/** 失败摘要标题:按真实失败类型措辞,none 时回退到 run 级错误码。 */
function generationFailureTitle(
  units: FailedGenerationUnit[],
  runErrorCode: string | null | undefined,
): string {
  const imageCount = units.filter((unit) => unit.kind === "image").length;
  const textCount = units.filter((unit) => unit.kind === "text_map").length;
  const otherCount = units.length - imageCount - textCount;
  const parts: string[] = [];
  if (imageCount > 0) parts.push(`${imageCount} 张图片`);
  if (textCount > 0) parts.push(`${textCount} 个文本分片`);
  if (otherCount > 0) parts.push(`${otherCount} 个处理步骤`);
  if (parts.length > 0) return `${parts.join("、")}处理失败`;
  if (runErrorCode === "scheduler_capacity") return "后台任务槽位不足";
  if (runErrorCode === "no_learnable_candidate") return "未能提炼出可学习的知识点";
  return "生成需要你的处理";
}

/** 弹窗里单个失败检查点的名称。 */
function generationFailedUnitName(unit: FailedGenerationUnit, imageIndex: number | null): string {
  if (unit.kind === "image") {
    const base = `图片 ${imageIndex ?? 1}`;
    return unit.ordinal == null ? base : `${base}（素材序号 ${unit.ordinal + 1}）`;
  }
  if (unit.kind === "text_map") {
    return unit.ordinal == null ? "文本分片" : `文本分片 ${unit.ordinal + 1}`;
  }
  return unit.ordinal == null ? "处理步骤" : `处理步骤 ${unit.ordinal + 1}`;
}

function getExcludableFailedImageUnitIds(run: CardGenerationRunView): string[] {
  return getFailedGenerationImages(run)
    .filter((image) => image.status === "terminal_failed")
    .map((image) => image.unitId);
}

function getPartialCoverageDetails(run: CardGenerationRunView): {
  excludedImageCount: number;
  policyAdjustedImageCoverageBps: number | null;
} | null {
  const warning = run.warnings.find((item) => item.code === "partial_coverage");
  const details = warning?.details;
  if (!details) return null;
  const excludedImageCount = details.excludedImageCount;
  const policyAdjustedImageCoverageBps = details.policyAdjustedImageCoverageBps;
  return {
    excludedImageCount:
      typeof excludedImageCount === "number" && Number.isFinite(excludedImageCount)
        ? Math.max(0, Math.trunc(excludedImageCount))
        : 0,
    policyAdjustedImageCoverageBps:
      typeof policyAdjustedImageCoverageBps === "number" &&
      Number.isFinite(policyAdjustedImageCoverageBps)
        ? policyAdjustedImageCoverageBps
        : null,
  };
}

function generationUnitErrorLabel(errorCode: string | null): string {
  // Worker unit error codes are `${unitKind}_${category}`(见 safe-error.ts 的
  // category 枚举),外加 allowlist 里的稳定业务码。两套都在这里翻译。
  const labels: Record<string, string> = {
    image_analysis_failed: "图片解析失败",
    image_download_failed: "图片读取失败",
    image_provider_failed: "图片模型调用失败",
    image_content_not_allowed: "工作区未允许发送图片内容（设置 → AI 模型 → 允许发送图片内容）",
    image_input_too_large: "图片超过处理限制",
    image_provider: "图片模型调用失败",
    image_timeout: "图片解析超时",
    image_validation: "图片解析结果未通过校验",
    image_configuration: "图片流程配置错误",
    image_authentication: "AI 服务鉴权失败",
    image_billing: "AI 服务余额或账单异常",
    image_aborted: "图片解析被中断",
    image_database: "图片结果保存失败",
    image_unknown: "图片处理失败",
    text_map_provider: "文本分片提炼失败",
    text_map_timeout: "文本分片提炼超时",
    text_map_validation: "文本分片输出未通过校验",
  };
  if (!errorCode) return "图片处理失败";
  return labels[errorCode] ?? (errorCode.startsWith("text_map_") ? "文本分片处理失败" : "图片处理失败");
}

function generationResolutionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : fallback;
  }
  const labels: Record<string, string> = {
    run_not_retryable: "当前失败已无法自动重试，请检查失败图片或选择显式排除。",
    run_exclusions_not_available: "当前任务已不再允许排除图片，请重新同步任务状态。",
    stale_generation_epoch: "这次任务已被较新的生成请求取代，请刷新后查看最新任务。",
    invalid_exclusion_units: "失败图片状态已经变化，无法按当前列表继续。",
    no_remaining_generation_input: "排除这些图片后没有可用于生成学习卡的内容。",
    idempotency_key_reused: "请求标识发生冲突，请重新发起操作。",
  };
  return (error.code && labels[error.code]) || error.message || fallback;
}

function imageUploadStatusLabel(status: ImageUploadStatus): string {
  if (status === "queued") return "等待上传";
  if (status === "uploading") return "上传中";
  if (status === "failed") return "上传失败";
  if (status === "succeeded") return "上传完成";
  return "已取消";
}

function imageUploadProgress(upload: ImageUploadView): number {
  if (upload.status === "succeeded") return 100;
  if (upload.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((upload.loaded / upload.total) * 100)));
}

/**
 * Phase 2: 编辑会话超时——30 秒无编辑后封存当前会话版本。
 * 下次自动保存将创建新版本，而非原地更新。
 */
const SESSION_TIMEOUT_MS = 30_000;

function stripMarkdownTitle(content: string): string {
  const htmlHeading = /^<h\d>([\s\S]+)<\/h\d>$/.exec(content.trim());
  if (htmlHeading) return htmlHeading[1];
  return content
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^·\s*/, "");
}

function outlineBlockKey(block: Block): string {
  return `${block.ordinal}-${block.content}`;
}

function markdownDownloadName(title: string, noteId: string): string {
  const safeTitle = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
  return `${safeTitle || `note-${noteId}`}.md`;
}

/**
 * 保存状态 → chip 样式映射（使用语义 token）
 */
function savingStatePresentation(state: SavingState, dirty: boolean): { label: string; tone: StatusTone } {
  if (state === "saving") return { label: "保存中", tone: "warning" };
  if (state === "saved") return { label: "已保存", tone: "success" };
  if (state === "error") return { label: "保存失败", tone: "danger" };
  if (state === "conflict") return { label: "内容冲突", tone: "warning" };
  if (state === "deleted") return { label: "笔记已删除", tone: "danger" };
  if (dirty) return { label: "未保存", tone: "warning" };
  return { label: "已保存", tone: "success" };
}

/**
 * 笔记编辑器。
 *
 * 编辑器交互约束：
 * - 桌面双栏：文档工具 | 写作纸面；中小屏将工具折叠到抽屉
 * - TopBar：返回链接 + 标题 + 版本号 + 操作按钮
 * - 写作、文章预览与分屏共用同一份 Markdown 草稿
 * - 保存状态使用 aria-live="polite"
 * - 鉴权使用同源 HttpOnly Cookie；卸载保存附带 CSRF token
 */
export function NoteEditor({
  noteId,
  draftScope,
  noteVersionId,
  versionNo,
  initialTitle,
  titleSource,
  initialBlocks,
  initialGenerationStatus,
  returnHref = "/notes",
  returnLabel = "笔记库",
}: Props) {
  const { isOwner, loading: ownerLoading } = useIsOwner();
  // Ref mirror so async callbacks (save, beforeunload, cleanup) always see the latest value
  const isOwnerRef = useRef(isOwner);
  isOwnerRef.current = isOwner;
  const router = useRouter();
  const initialMarkdown = useMemo(() => {
    if (initialBlocks.length === 0) return "";
    return blocksToMarkdown(initialBlocks);
  }, [initialBlocks]);
  const generationRunStorageKey = useMemo(
    () => `${CARD_GENERATION_RUN_STORAGE_PREFIX}${draftScope}:${noteId}`,
    [draftScope, noteId],
  );

  const [title, setTitle] = useState(initialTitle);
  const [isAutoTitle, setIsAutoTitle] = useState(titleSource === "auto");
  const [source, setSource] = useState(initialMarkdown);
  const [mode, setMode] = useState<EditorMode>("edit");
  const [previewOutlineMode, setPreviewOutlineMode] = useState<PreviewOutlineMode>("pinned");
  const [previewOutlinePeeked, setPreviewOutlinePeeked] = useState(false);
  const [activeOutlineKey, setActiveOutlineKey] = useState<string | null>(null);
  const [saving, setSaving] = useState<SavingState>("idle");
  const [genState, setGenState] = useState<GenerationState>(initialGenerationStatus.state);
  const [genMessage, setGenMessage] = useState<string | null>(
    initialGenerationStatus.state === "generating"
      ? `正在基于 v${versionNo} 提炼学习卡…`
      : initialGenerationStatus.state === "checking"
        ? "正在重新确认学习卡任务状态…"
      : initialGenerationStatus.message ?? null,
  );
  const [dirty, setDirty] = useState(false);
  const [currentVersionNo, setCurrentVersionNo] = useState(versionNo);
  const [currentVersionId, setCurrentVersionId] = useState(noteVersionId);
  const [generatedVersionId, setGeneratedVersionId] = useState<string | null>(
    initialGenerationStatus.generatedVersionId,
  );
  const [generationVersionNo, setGenerationVersionNo] = useState<number | null>(
    initialGenerationStatus.state === "generating" ? versionNo : null,
  );
  const [generationPhase, setGenerationPhase] = useState<GenerationPhase>(
    initialGenerationStatus.state === "generating" || initialGenerationStatus.state === "checking"
      ? "queued"
      : "saving",
  );
  const [generationRun, setGenerationRun] = useState<CardGenerationRunView | null>(null);
  const [generationRunId, setGenerationRunId] = useState<string | null>(null);
  const [generationRunRecoveryResolved, setGenerationRunRecoveryResolved] = useState(false);
  const [cancellingGeneration, setCancellingGeneration] = useState(false);
  const [generationResolutionAction, setGenerationResolutionAction] =
    useState<GenerationResolutionAction>(null);
  const [generationResolutionError, setGenerationResolutionError] = useState<string | null>(null);
  const [confirmGenerationExclusions, setConfirmGenerationExclusions] = useState(false);
  // 失败素材处理弹窗:run 进入 needs_attention 时自动弹出;用户可"稍后处理"
  // 关闭,再从生成面板/生成按钮重新打开。排除确认(ConfirmDialog)期间让位。
  const [generationFailureDialogOpen, setGenerationFailureDialogOpen] = useState(false);
  const [generationOverlayDismissed, setGenerationOverlayDismissed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>("overview");
  const [compactDrawer, setCompactDrawer] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("normal");
  const workbenchRef = useRef<HTMLDivElement>(null);
  const exitingFullscreenRef = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const restoringRef = useRef(false);
  const [confirmRestore, setConfirmRestore] = useState<{ versionId: string; versionNo: number } | null>(null);
  const [hasRecoveredConflictDraft, setHasRecoveredConflictDraft] = useState(false);
  // R-008: 是否有被丢弃的草稿可恢复
  const [hasDiscardedDraft, setHasDiscardedDraft] = useState(false);
  // F-007: 冲突状态
  const [conflictData, setConflictData] = useState<{
    serverTitle: string;
    serverTitleSource?: "auto" | "manual";
    serverSource: string;
    serverVersionNo: number;
  } | null>(null);
  // 图片上传状态
  const [uploadingCount, setUploadingCount] = useState(0);
  const [imageUploads, setImageUploads] = useState<ImageUploadView[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadingCountRef = useRef(0);
  const imageUploadItemsRef = useRef(new Map<string, ImageUploadTask>());
  const imageUploadQueueRef = useRef<string[]>([]);
  const activeImageUploadsRef = useRef(0);

  // 版本历史
  const [versions, setVersions] = useState<NoteVersionSummary[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // Generation Run v2 only blocks editing while the latest draft is saved and
  // POST /card-generation-runs is awaiting acceptance. Queued/running work is
  // tied to the immutable source snapshot and must not lock the editor.
  const generationLocked = CARD_GENERATION_V2_ENABLED
    ? genState === "generating" && generationPhase === "saving"
    : genState === "generating";
  const generationLockedRef = useRef(generationLocked);
  generationLockedRef.current = generationLocked;
  const generationOverlayRef = useRef<HTMLDivElement>(null);
  // Modal blocking only applies during the brief save+accept handshake.
  const generationOverlayActive = isOwner && generationLocked;
  // The progress overlay stays visible for the entire generating state so the
  // user can see real-time progress. After the save phase it becomes
  // non-modal and dismissible; the gen button reopens it on demand.
  const generationOverlayVisible =
    isOwner
    && (genState === "generating" || genState === "checking")
    && !generationOverlayDismissed;
  const conflictDialogActive = !!conflictData && !generationOverlayActive;

  // 冲突仍是模态；生成遮罩只覆盖短暂的保存/入队握手。
  const conflictDialogRef = useRef<HTMLDivElement>(null);
  useModalIsolation(conflictDialogRef, conflictDialogActive);
  useFocusTrap(conflictDialogRef, conflictDialogActive);
  useBodyScrollLock(conflictDialogActive);

  useModalIsolation(generationOverlayRef, generationOverlayActive);
  useFocusTrap(generationOverlayRef, generationOverlayActive);
  useBodyScrollLock(generationOverlayActive);

  // 失败素材处理弹窗(模态)。排除确认弹窗展示期间本弹窗关闭让位,
  // 冲突对话框与封存遮罩优先级更高。
  const generationFailureDialogRef = useRef<HTMLDivElement>(null);
  const generationFailureDialogActive =
    generationFailureDialogOpen
    && isOwner
    && generationRun?.status === "needs_attention"
    && !confirmGenerationExclusions
    && !generationOverlayActive
    && !conflictData;
  useModalIsolation(generationFailureDialogRef, generationFailureDialogActive);
  useFocusTrap(generationFailureDialogRef, generationFailureDialogActive);
  useBodyScrollLock(generationFailureDialogActive);

  // 失败即弹窗:run 进入 needs_attention 时自动打开;离开该状态(重试
  // 已排队/派生任务已创建/被新请求取代)时自动关闭。用户手动关闭后不再
  // 重复打扰,直到下一次重新进入 needs_attention。
  const previousGenerationRunStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const status = generationRun?.status ?? null;
    const previous = previousGenerationRunStatusRef.current;
    previousGenerationRunStatusRef.current = status;
    if (status === "needs_attention") {
      if (previous !== "needs_attention" && isOwner) {
        setGenerationResolutionError(null);
        setGenerationFailureDialogOpen(true);
      }
      return;
    }
    setGenerationFailureDialogOpen(false);
  }, [generationRun?.status, isOwner]);

  useEffect(() => {
    if (!generationFailureDialogActive) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setGenerationFailureDialogOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [generationFailureDialogActive]);

  // Reset the dismissed flag when generation ends so the overlay can show again
  // on the next run without the user needing to do anything.
  useEffect(() => {
    if (genState !== "generating" && genState !== "checking") {
      setGenerationOverlayDismissed(false);
    }
  }, [genState]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Phase 2: 编辑会话状态
  const sessionVersionIdRef = useRef<string | null>(null);
  const sessionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<MilkdownEditorHandle | null>(null);
  const editorPaneRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewOutlineTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreActionsRef = useRef<HTMLDetailsElement | null>(null);
  const savedVersionIdRef = useRef(noteVersionId);
  const currentVersionNoRef = useRef(versionNo);
  const conflictDataRef = useRef(conflictData);
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const isDeletingRef = useRef(false);
  const recoveredConflictRef = useRef(false);
  const mountedRef = useRef(true);
  // CONC-02: 笔记已被其他用户删除时，阻止后续保存和编辑
  const noteDeletedRef = useRef(false);
  const generationRunRef = useRef(0);
  const lastRunAnnouncementRef = useRef<string | null>(null);
  const generationRequestKeyRef = useRef<{ versionId: string; key: string } | null>(null);
  const generationExclusionRequestKeyRef = useRef<{ runId: string; key: string } | null>(null);
  const initialBlockCountRef = useRef(initialBlocks.length);
  // beforeunload keepalive 请求发出后，如果用户取消导航留在页面，
  // savedVersionIdRef / lastSavedSourceRef 可能已过期（keepalive 响应丢失）。
  // 下次 save() 检测到此标志时先拉取最新笔记状态，避免不必要的 409 冲突。
  const beforeUnloadSaveFiredRef = useRef(false);
  // P2-4: 跟踪 PATCH 请求是否正在进行，避免轮询与保存交错时误判冲突
  const saveInFlightRef = useRef(false);
  const latestTitleRef = useRef(initialTitle);
  const lastSavedTitleRef = useRef(initialTitle);
  const lastSavedTitleSourceRef = useRef(titleSource);
  // 每次用户输入都递增，用于把飞行中保存的响应安全地 rebase 到最新标题。
  const titleEditRevisionRef = useRef(0);
  // 标题修改是独立意图，不能用“标题字符串是否不同”代替：自动标题会随正文变化。
  const titleDirtyRef = useRef(false);
  const conflictDraftStorageKey = useMemo(
    () => `note-editor-conflict-draft:${draftScope}:${noteId}`,
    [draftScope, noteId],
  );
  const persistDraftLocally = useCallback((draftSource: string, draftTitle = latestTitleRef.current) => {
    try {
      window.localStorage.setItem(
        conflictDraftStorageKey,
        JSON.stringify({
          source: draftSource,
          title: draftTitle,
          titleChanged: titleDirtyRef.current,
          updatedAt: Date.now(),
        }),
      );
    } catch {
      // 私密模式、存储配额不足等场景下继续依赖服务器自动保存。
    }
  }, [conflictDraftStorageKey]);
  const clearPersistedDraft = useCallback((expectedSource: string, expectedTitle = latestTitleRef.current) => {
    try {
      const raw = window.localStorage.getItem(conflictDraftStorageKey);
      if (!raw) return;
      const stored = JSON.parse(raw) as {
        source?: unknown;
        title?: unknown;
        titleChanged?: unknown;
      };
      // 同一笔记可能在多个标签页中打开；只清理当前标签页刚刚保存或
      // 放弃的那份源码与标题，不能误删另一标签页写入的不同草稿。
      if (
        stored.source === expectedSource &&
        (
          stored.titleChanged === false ||
          typeof stored.title !== "string" ||
          stored.title === expectedTitle
        )
      ) {
        window.localStorage.removeItem(conflictDraftStorageKey);
      }
    } catch {
      // 损坏的记录交给下次恢复流程清理。
    }
  }, [conflictDraftStorageKey]);
  const latestDraftRef = useRef({
    source: initialMarkdown,
  });
  const setMilkdownEditorHandle = useCallback((handle: MilkdownEditorHandle | null) => {
    editorRef.current = handle;
    if (!handle) return;

    // Milkdown is loaded asynchronously. A local recovery can finish before
    // the imperative handle exists, so reconcile the mounted editor with the
    // latest draft instead of falling back to the server's initial Markdown.
    const latestSource = latestDraftRef.current.source;
    if (handle.getMarkdown() !== latestSource) {
      handle.setMarkdown(latestSource, true);
    }
  }, []);
  // R-008: 追踪最后成功保存的源码
  const lastSavedSourceRef = useRef(initialMarkdown);
  // R-008: 丢弃本地草稿前的备份
  const discardedDraftRef = useRef<{
    source: string;
    title: string;
    isAutoTitle: boolean;
    titleChanged: boolean;
  } | null>(null);

  const previewBlocks = useMemo(() => markdownToBlocks(source), [source]);
  const blockDelta = previewBlocks.length - initialBlockCountRef.current;
  const wordCount = source.replace(/\s/g, "").length;
  const allOutlineBlocks = useMemo(
    () => previewBlocks.filter((block) => block.type === "heading"),
    [previewBlocks],
  );
  const outlineBlocks = allOutlineBlocks;
  const previewOutlineBlocks = useMemo(
    () => hasDuplicateArticleLeadHeading(source, title)
      ? allOutlineBlocks.slice(1)
      : allOutlineBlocks,
    [allOutlineBlocks, source, title],
  );

  const savingPres = savingStatePresentation(saving, dirty);

  const rememberGenerationRun = useCallback((run: {
    runId: string;
    noteVersionId: string;
    versionNo: number;
    sequence: number;
  }) => {
    try {
      window.localStorage.setItem(generationRunStorageKey, JSON.stringify(run));
    } catch {
      // Refresh recovery still falls back to card-generation-latest.
    }
  }, [generationRunStorageKey]);

  const forgetGenerationRun = useCallback(() => {
    try {
      window.localStorage.removeItem(generationRunStorageKey);
    } catch {
      // Storage is optional; the server remains the source of truth.
    }
  }, [generationRunStorageKey]);

  const applyGenerationRun = useCallback((run: CardGenerationRunView) => {
    setGenerationRun(run);
    setGenerationRunId(run.runId);
    setGenerationVersionNo(run.sourceSnapshot.versionNo);
    setGenerationResolutionAction(null);
    setGenerationResolutionError(null);
    generationLockedRef.current = false;

    const announcementKey = `${run.stage}:${run.stateVersion}:${run.status}`;
    const announce = () => {
      if (lastRunAnnouncementRef.current === announcementKey) return;
      lastRunAnnouncementRef.current = announcementKey;
      setGenMessage(generationRunMessage(run));
    };

    if (isActiveGenerationRun(run.status)) {
      setGenerationPhase(
        run.status === "queued" ||
        run.status === "planning" ||
        run.status === "awaiting_assets"
          ? "queued"
          : "running",
      );
      setGenState("generating");
      rememberGenerationRun({
        runId: run.runId,
        noteVersionId: run.sourceSnapshot.noteVersionId,
        versionNo: run.sourceSnapshot.versionNo,
        sequence: run.sequence,
      });
      announce();
      return;
    }

    forgetGenerationRun();
    announce();
    if (run.status === "succeeded") {
      setGeneratedVersionId(run.sourceSnapshot.noteVersionId);
      setGenState("generated");
      return;
    }
    if (run.status === "partial_ready") {
      setGenState("partial-ready");
      return;
    }
    setGenState("idle");
  }, [forgetGenerationRun, rememberGenerationRun]);

  const pollGenerationRun = useCallback(async (activeRunId: string, pollToken: number) => {
    let pollDelay = 0;
    let consecutiveReadFailures = 0;

    while (pollToken === generationRunRef.current && mountedRef.current) {
      if (pollDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollDelay));
        if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      }

      const controller = new AbortController();
      const watchdog = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const run = await api.getCardGenerationRun(activeRunId, controller.signal);
        if (pollToken !== generationRunRef.current || !mountedRef.current) return;
        consecutiveReadFailures = 0;
        applyGenerationRun(run);
        if (!isActiveGenerationRun(run.status)) return;
      } catch (error) {
        if (pollToken !== generationRunRef.current || !mountedRef.current) return;
        consecutiveReadFailures += 1;
        if (error instanceof ApiError && error.status === 404) {
          forgetGenerationRun();
          setGenerationRun(null);
          setGenerationRunId(null);
          setGenState("idle");
          setGenMessage("生成任务已不存在，可以重新生成当前保存版本。");
          return;
        }
        if (consecutiveReadFailures === 1) {
          setGenMessage("暂时无法同步生成进度；任务仍在后台运行，你可以继续编辑。");
        }
      } finally {
        window.clearTimeout(watchdog);
      }

      pollDelay = document.visibilityState === "hidden" ? 5000 : 1500;
    }
  }, [applyGenerationRun, forgetGenerationRun]);

  // Refresh recovery prefers the stored runId because the user may already be
  // editing vN+1 while a run based on vN is still active. Without it, looking
  // up only the current note version would lose the visible task after refresh.
  useEffect(() => {
    if (!CARD_GENERATION_V2_ENABLED) {
      setGenerationRunRecoveryResolved(true);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const recover = async () => {
      let storedRunId: string | null = null;
      try {
        const raw = window.localStorage.getItem(generationRunStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as { runId?: unknown };
          if (typeof parsed.runId === "string" && parsed.runId) {
            storedRunId = parsed.runId;
          }
        }
      } catch {
        // Fall through to the server-side latest lookup.
      }

      try {
        let recoveredRun: CardGenerationRunView | null = null;
        if (storedRunId) {
          try {
            recoveredRun = await api.getCardGenerationRun(storedRunId, controller.signal);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
            forgetGenerationRun();
          }
        }
        if (!recoveredRun) {
          const latest = await api.getLatestCardGenerationRun(noteVersionId, controller.signal);
          recoveredRun = latest.run;
        }
        if (cancelled || !mountedRef.current) return;
        if (recoveredRun) {
          applyGenerationRun(recoveredRun);
          if (isActiveGenerationRun(recoveredRun.status)) {
            const pollToken = generationRunRef.current + 1;
            generationRunRef.current = pollToken;
            void pollGenerationRun(recoveredRun.runId, pollToken);
          }
        }
      } catch {
        // Legacy card-status/getJob recovery below remains available when the
        // run endpoint is unavailable during a rolling deployment.
      } finally {
        if (!cancelled && mountedRef.current) {
          setGenerationRunRecoveryResolved(true);
        }
      }
    };

    void recover();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    applyGenerationRun,
    forgetGenerationRun,
    generationRunStorageKey,
    noteVersionId,
    pollGenerationRun,
  ]);

  const pollGenerationJob = useCallback(async (
    jobId: string,
    versionId: string,
    versionAtGeneration: number,
    runId: number,
  ) => {
    // 105 秒只是“常规耗时”边界，不代表后台任务已经结束。越过边界后
    // 降低轮询频率并继续锁定编辑，避免同一版本仍在生成时再次被修改。
    const slowTaskAt = Date.now() + 105_000;
    let pollDelay = 1000;
    let slowTaskAnnounced = false;
    let activeJobId = jobId;
    let consecutiveReadFailures = 0;
    while (runId === generationRunRef.current && mountedRef.current) {
      await new Promise((resolve) => setTimeout(resolve, pollDelay));
      if (runId !== generationRunRef.current || !mountedRef.current) return;
      let job: JobRow;
      try {
        job = await api.getJob(activeJobId);
        consecutiveReadFailures = 0;
      } catch (error) {
        if (runId !== generationRunRef.current || !mountedRef.current) return;
        consecutiveReadFailures += 1;

        // A removed job or repeated transport failure is reconciled against the
        // version-level status endpoint. This distinguishes a slow/offline job
        // from a task that has actually completed or disappeared.
        if (
          (error instanceof ApiError && error.status === 404) ||
          consecutiveReadFailures >= 3
        ) {
          try {
            const status = await api.getCardGenerationStatus(versionId);
            if (runId !== generationRunRef.current || !mountedRef.current) return;
            if (status.state === "generated" && status.generatedVersionId) {
              setGenState("generated");
              setGeneratedVersionId(status.generatedVersionId);
              setGenMessage(
                status.generatedVersionId === versionId
                  ? `v${versionAtGeneration} 的学习卡已生成，可前往学习卡库查看。`
                  : "本次任务已结束，已有学习卡仍保留；可重新生成当前版本。",
              );
              return;
            }
            if (status.state === "idle") {
              setGenState("idle");
              setGenMessage("未检测到仍在运行的生成任务，可以继续编辑或重新生成。");
              return;
            }
            if (status.state === "generating" && status.jobId) {
              activeJobId = status.jobId;
              consecutiveReadFailures = 0;
              setGenerationPhase("queued");
              setGenMessage(`v${versionAtGeneration} 仍在生成队列中，正在继续同步进度…`);
              pollDelay = 3000;
              continue;
            }
          } catch (statusError) {
            if (runId !== generationRunRef.current || !mountedRef.current) return;
            if (statusError instanceof ApiError && statusError.status === 404) {
              noteDeletedRef.current = true;
              setSaving("deleted");
              setGenState("idle");
              setGenMessage("笔记版本已不存在，生成状态无法继续同步。");
              return;
            }
          }
        }

        setGenMessage("暂时无法读取最新进度，正在后台继续确认任务状态…");
        pollDelay = 5000;
        continue;
      }
      if (runId !== generationRunRef.current || !mountedRef.current) return;
      if (job.status === "succeeded") {
        setGenState("generated");
        setGeneratedVersionId(versionId);
        setGenMessage(`v${versionAtGeneration} 的学习卡已生成，可前往学习卡库查看。`);
        return;
      }
      if (job.status === "failed" || job.status === "dead") {
        setGenState("idle");
        const jobPres = statusMap.jobStatus(job.status);
        setGenMessage(`任务${jobPres.label}：${job.lastError ?? "未知错误"}`);
        return;
      }
      setGenerationPhase(job.status === "running" ? "running" : "queued");
      if (!slowTaskAnnounced && Date.now() >= slowTaskAt) {
        slowTaskAnnounced = true;
        setGenMessage("这次生成需要更长时间，任务仍在后台处理中。");
      } else if (!slowTaskAnnounced) {
        setGenMessage(
          job.status === "running"
            ? `正在基于 v${versionAtGeneration} 提炼关键理解…`
            : `v${versionAtGeneration} 已进入生成队列，正在准备处理…`,
        );
      }
      pollDelay = slowTaskAnnounced
        ? 5000
        : Math.min(3000, Math.round(pollDelay * 1.5));
    }
  }, []);

  useEffect(() => {
    if (!generationRunRecoveryResolved || generationRunId) return;
    if (initialGenerationStatus.state !== "generating" || !initialGenerationStatus.jobId) return;
    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
    setGenerationPhase("queued");
    void pollGenerationJob(
      initialGenerationStatus.jobId,
      noteVersionId,
      versionNo,
      runId,
    ).catch((error) => {
      if (runId !== generationRunRef.current || !mountedRef.current) return;
      setGenState("idle");
      setGenMessage(error instanceof Error ? error.message : "生成状态读取失败");
    });
  }, [
    generationRunId,
    generationRunRecoveryResolved,
    initialGenerationStatus,
    noteVersionId,
    pollGenerationJob,
    versionNo,
  ]);

  useEffect(() => {
    if (!generationRunRecoveryResolved || generationRunId) return;
    const needsRecovery =
      initialGenerationStatus.state === "checking" ||
      (initialGenerationStatus.state === "generating" && !initialGenerationStatus.jobId);
    if (!needsRecovery) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const recheckGenerationStatus = async () => {
      try {
        const status = await api.getCardGenerationStatus(noteVersionId);
        if (cancelled || !mountedRef.current) return;
        if (status.state === "generating") {
          if (!status.jobId) {
            throw new Error("生成任务编号尚未同步");
          }
          setGenState("generating");
          setGenerationVersionNo(versionNo);
          setGenerationPhase("queued");
          setGenMessage(`正在恢复 v${versionNo} 的学习卡生成进度…`);
          const runId = generationRunRef.current + 1;
          generationRunRef.current = runId;
          void pollGenerationJob(status.jobId, noteVersionId, versionNo, runId);
          return;
        }
        if (status.state === "generated" && status.generatedVersionId) {
          setGeneratedVersionId(status.generatedVersionId);
          setGenState("generated");
          setGenMessage(
            status.generatedVersionId === noteVersionId
              ? `v${versionNo} 的学习卡已生成，可前往学习卡库查看。`
              : null,
          );
          return;
        }
        if (status.state === "idle") {
          setGeneratedVersionId(status.generatedVersionId);
          setGenState("idle");
          setGenMessage(null);
          return;
        }
        throw new Error("学习卡状态仍在确认中");
      } catch (error) {
        if (cancelled || !mountedRef.current) return;
        if (error instanceof ApiError && error.status === 404) {
          try {
            await api.getNote(noteId);
            if (cancelled || !mountedRef.current) return;
            setGenState("status-error");
            setGenMessage("当前版本的任务状态无法读取。可重新检查，或返回后重新打开笔记。");
            return;
          } catch (noteError) {
            if (cancelled || !mountedRef.current) return;
            if (noteError instanceof ApiError && noteError.status === 404) {
              noteDeletedRef.current = true;
              setSaving("deleted");
              setGenState("idle");
              setGenMessage("笔记已被删除，无法继续同步生成状态。");
              return;
            }
          }
        }
        setGenState("checking");
        setGenMessage("暂时无法确认任务状态，正在自动重试；确认完成前编辑保持暂停。");
        retryTimer = setTimeout(() => void recheckGenerationStatus(), 5000);
      }
    };

    void recheckGenerationStatus();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    generationRunId,
    generationRunRecoveryResolved,
    initialGenerationStatus,
    noteId,
    noteVersionId,
    pollGenerationJob,
    versionNo,
  ]);

  useEffect(() => {
    try {
      const savedMode = window.localStorage.getItem(PREVIEW_OUTLINE_PREFERENCE_KEY);
      if (savedMode === "pinned" || savedMode === "auto") {
        setPreviewOutlineMode(savedMode);
      }
    } catch {
      // 浏览器禁用本地存储时继续使用默认固定目录。
    }
  }, []);

  useEffect(() => {
    // 旧版本只按 noteId 存储，无法证明草稿属于当前用户和 workspace。
    // 为避免切换账号后恢复他人正文，只清理而不迁移该不安全记录。
    try {
      window.localStorage.removeItem(`note-editor-conflict-draft:${noteId}`);
    } catch {
      // Storage 不可用时跳过。
    }
  }, [noteId]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(conflictDraftStorageKey);
      if (!raw) return;
      const recovered = JSON.parse(raw) as {
        source?: unknown;
        title?: unknown;
        titleChanged?: unknown;
        updatedAt?: unknown;
      };
      const updatedAt = typeof recovered.updatedAt === "number" ? recovered.updatedAt : 0;
      const recoveredTitleChanged = recovered.titleChanged === true;
      const recoveredTitle = recoveredTitleChanged && typeof recovered.title === "string"
        ? recovered.title
        : initialTitle;
      const normalizedRecoveredTitle = recoveredTitle.trim() || "无标题笔记";
      if (
        typeof recovered.source !== "string" ||
        (
          recovered.source === initialMarkdown &&
          (
            !recoveredTitleChanged ||
            normalizedRecoveredTitle === initialTitle
          )
        ) ||
        Date.now() - updatedAt > LOCAL_DRAFT_MAX_AGE_MS
      ) {
        window.localStorage.removeItem(conflictDraftStorageKey);
        return;
      }
      latestDraftRef.current = { source: recovered.source };
      latestTitleRef.current = recoveredTitle;
      titleDirtyRef.current = recoveredTitleChanged;
      recoveredConflictRef.current = true;
      setSource(recovered.source);
      editorRef.current?.setMarkdown(recovered.source, true);
      setTitle(recoveredTitle);
      if (recoveredTitleChanged) setIsAutoTitle(false);
      setDirty(true);
      setSaving("idle");
      setHasRecoveredConflictDraft(true);
    } catch {
      try {
        window.localStorage.removeItem(conflictDraftStorageKey);
      } catch {
        // 持久化不可用时仅跳过恢复。
      }
    }
  }, [conflictDraftStorageKey, initialMarkdown, initialTitle]);

  useEffect(() => {
    conflictDataRef.current = conflictData;
  }, [conflictData]);

  useEffect(() => {
    const compactMedia = window.matchMedia("(max-width: 639px)");
    const sync = () => {
      setCompactDrawer(compactMedia.matches);
    };
    sync();
    compactMedia.addEventListener("change", sync);
    return () => {
      compactMedia.removeEventListener("change", sync);
    };
  }, []);

  // RBAC: 等权限读取完成后再决定模式，避免 owner 首次进入时被初始 false
  // 错误地切到预览且无法恢复。成员仍始终保持只读预览。
  useEffect(() => {
    if (ownerLoading) return;
    if (!isOwner && mode !== "preview") setMode("preview");
  }, [isOwner, mode, ownerLoading]);

  useEffect(() => {
    if (mode !== "preview") {
      setPreviewOutlinePeeked(false);
      setActiveOutlineKey(null);
      return;
    }
    if (previewOutlineBlocks.length === 0) {
      setActiveOutlineKey(null);
      return;
    }

    let frame = 0;
    const updateActiveHeading = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const previewPane = previewRef.current;
        if (!previewPane) return;
        const headings = Array.from(previewPane.querySelectorAll<HTMLElement>(
          ".note-article-body h1, .note-article-body h2, .note-article-body h3, .note-article-body h4, .note-article-body h5, .note-article-body h6",
        ));
        if (headings.length === 0) {
          setActiveOutlineKey(outlineBlockKey(previewOutlineBlocks[0]));
          return;
        }

        const readingAnchor = 138;
        let activeIndex = 0;
        headings.forEach((heading, index) => {
          if (heading.getBoundingClientRect().top <= readingAnchor) activeIndex = index;
        });
        const activeBlock = previewOutlineBlocks[Math.min(activeIndex, previewOutlineBlocks.length - 1)];
        if (activeBlock) setActiveOutlineKey(outlineBlockKey(activeBlock));
      });
    };

    const workbench = workbenchRef.current;
    updateActiveHeading();
    workbench?.addEventListener("scroll", updateActiveHeading, { passive: true });
    window.addEventListener("scroll", updateActiveHeading, { passive: true });
    window.addEventListener("resize", updateActiveHeading);
    return () => {
      cancelAnimationFrame(frame);
      workbench?.removeEventListener("scroll", updateActiveHeading);
      window.removeEventListener("scroll", updateActiveHeading);
      window.removeEventListener("resize", updateActiveHeading);
    };
  }, [mode, previewOutlineBlocks]);

  // Fullscreen API 同步：用户通过 Esc 退出浏览器全屏时，回退到宽屏模式
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && !exitingFullscreenRef.current) {
        setViewMode((prev) => (prev === "fullscreen" ? "wide" : prev));
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  // 组件卸载时退出浏览器全屏，避免离开页面后仍残留全屏状态
  useEffect(() => {
    return () => {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const closeOnOutside = (event: PointerEvent) => {
      const details = moreActionsRef.current;
      if (details?.open && !details.contains(event.target as Node)) details.removeAttribute("open");
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      const details = moreActionsRef.current;
      if (event.key !== "Escape" || !details?.open) return;
      event.preventDefault();
      details.removeAttribute("open");
      details.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  // 加载版本历史
  useEffect(() => {
    let active = true;
    api.listNoteVersions(noteId)
      .then(({ items }) => {
        if (!active) return;
        setVersions(items);
        setVersionsError(null);
      })
      .catch(() => {
        if (!active) return;
        setVersionsError("版本历史加载失败");
      });
    return () => {
      active = false;
    };
  }, [noteId, currentVersionNo]);

  // Phase 2: 编辑会话管理
  const clearSessionTimeout = useCallback(() => {
    if (sessionTimeoutRef.current) {
      clearTimeout(sessionTimeoutRef.current);
      sessionTimeoutRef.current = null;
    }
  }, []);

  const resetSessionTimeout = useCallback(() => {
    clearSessionTimeout();
    sessionTimeoutRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      // 30 秒无编辑：封存当前会话版本，下次自动保存创建新版本
      sessionVersionIdRef.current = null;
      sessionTimeoutRef.current = null;
    }, SESSION_TIMEOUT_MS);
  }, [clearSessionTimeout]);

  const endSession = useCallback(() => {
    sessionVersionIdRef.current = null;
    clearSessionTimeout();
  }, [clearSessionTimeout]);

  // CONC-04: 轮询检测笔记是否被其他用户删除或修改（每 30 秒）
  useEffect(() => {
    let cancelled = false;
    const POLL_INTERVAL = 30_000;

    const checkNoteStatus = async () => {
      if (cancelled || !mountedRef.current) return;
      // 冲突/删除/保存中不轮询
      if (
        conflictDataRef.current ||
        noteDeletedRef.current ||
        isDeletingRef.current ||
        restoringRef.current ||
        generationLockedRef.current
      ) return;
      // P2-4: 只在 PATCH 请求进行中时跳过轮询，而非在有 pending timer 时跳过
      // 避免 continuous editing 时 timer.current 始终非空导致轮询永不执行
      if (saveInFlightRef.current) return;

      try {
        const pollBaseline = {
          versionId: savedVersionIdRef.current,
          source: lastSavedSourceRef.current,
          title: lastSavedTitleRef.current,
        };
        const titleEditRevisionAtPollStart = titleEditRevisionRef.current;
        const hadPendingTitleEdit = titleDirtyRef.current;
        const fresh = await api.getNote(noteId);
        if (cancelled || !mountedRef.current) return;
        if (
          conflictDataRef.current ||
          noteDeletedRef.current ||
          isDeletingRef.current ||
          restoringRef.current ||
          saveInFlightRef.current ||
          savedVersionIdRef.current !== pollBaseline.versionId ||
          lastSavedSourceRef.current !== pollBaseline.source ||
          lastSavedTitleRef.current !== pollBaseline.title
        ) return;

        const freshMarkdown = fresh.blocks.length > 0 ? blocksToMarkdown(fresh.blocks) : "";
        // 会话内自动保存会复用 version.id；必须同时比较内容和标题。
        if (
          fresh.version.id === savedVersionIdRef.current &&
          freshMarkdown === lastSavedSourceRef.current &&
          fresh.note.title === lastSavedTitleRef.current
        ) return;
        const titleWasLocallyTouched =
          hadPendingTitleEdit ||
          titleEditRevisionRef.current !== titleEditRevisionAtPollStart;
        const hasLocalTitleChanges =
          titleWasLocallyTouched &&
          normalizeNoteTitle(latestTitleRef.current) !== fresh.note.title;
        const hasLocalChanges =
          latestDraftRef.current.source !== lastSavedSourceRef.current ||
          hasLocalTitleChanges;

        if (hasLocalChanges) {
          // 有未保存的本地编辑 — 触发冲突对话框
          persistDraftLocally(latestDraftRef.current.source);
          conflictDataRef.current = {
            serverTitle: fresh.note.title,
            serverTitleSource: fresh.note.titleSource,
            serverSource: freshMarkdown,
            serverVersionNo: fresh.version.versionNo,
          };
          endSession();
          if (mountedRef.current) {
            setCurrentVersionId(fresh.version.id);
            setCurrentVersionNo(fresh.version.versionNo);
            savedVersionIdRef.current = fresh.version.id;
            currentVersionNoRef.current = fresh.version.versionNo;
            setConflictData(conflictDataRef.current);
            setSaving("conflict");
          }
        } else {
          // 无本地编辑 — 静默同步到服务端最新版本
          savedVersionIdRef.current = fresh.version.id;
          currentVersionNoRef.current = fresh.version.versionNo;
          lastSavedSourceRef.current = freshMarkdown;
          lastSavedTitleRef.current = fresh.note.title;
          lastSavedTitleSourceRef.current = fresh.note.titleSource;
          latestDraftRef.current = { source: freshMarkdown };
          latestTitleRef.current = fresh.note.title;
          titleDirtyRef.current = false;
          if (mountedRef.current) {
            setCurrentVersionId(fresh.version.id);
            setCurrentVersionNo(fresh.version.versionNo);
            setSource(freshMarkdown);
            editorRef.current?.setMarkdown(freshMarkdown, true);
            setTitle(fresh.note.title);
            setIsAutoTitle(fresh.note.titleSource === "auto");
            setDirty(false);
          }
        }
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        if (err instanceof ApiError && err.status === 404) {
          // 笔记已被其他用户删除
          persistDraftLocally(latestDraftRef.current.source);
          endSession();
          noteDeletedRef.current = true;
          if (mountedRef.current) {
            setSaving("deleted");
          }
        }
        // 其他错误（网络等）静默忽略，下次轮询重试
      }
    };

    const intervalId = setInterval(checkNoteStatus, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [noteId, persistDraftLocally, endSession]);

  const syncDirty = useCallback(() => {
    setDirty(true);
  }, []);

  const save = useCallback((isAutosaveRequest = true): Promise<boolean> => {
    if (!isOwnerRef.current) return Promise.resolve(false);
    if (restoringRef.current) return Promise.resolve(false);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const operation = saveChainRef.current.then(async () => {
      if (conflictDataRef.current || isDeletingRef.current || noteDeletedRef.current) return false;

      // Milkdown listener 有 200ms debounce，save 前主动读取最新内容
      const latestMd = editorRef.current?.getMarkdown();
      if (latestMd != null && latestMd !== latestDraftRef.current.source) {
        latestDraftRef.current = { ...latestDraftRef.current, source: latestMd };
      }

      // beforeunload keepalive 请求可能已更新服务端版本，但响应丢失。
      // 先拉取最新状态，确保 baseVersionId 正确，避免不必要的 409。
      if (beforeUnloadSaveFiredRef.current) {
        beforeUnloadSaveFiredRef.current = false;
        // 标记保存进行中，避免 CONC-04 轮询在此窗口读取中间状态
        saveInFlightRef.current = true;
        try {
          const keepaliveTitleEditRevision = titleEditRevisionRef.current;
          const hadPendingKeepaliveTitle = titleDirtyRef.current;
          const fresh = await api.getNote(noteId);
          savedVersionIdRef.current = fresh.version.id;
          currentVersionNoRef.current = fresh.version.versionNo;
          const freshMarkdown = fresh.blocks.length > 0 ? blocksToMarkdown(fresh.blocks) : "";
          lastSavedSourceRef.current = freshMarkdown;
          lastSavedTitleRef.current = fresh.note.title;
          lastSavedTitleSourceRef.current = fresh.note.titleSource;
          const reconciledTitle = reconcileSavedNoteTitle({
            latestTitle: latestTitleRef.current,
            savedTitle: fresh.note.title,
            requestEditRevision: keepaliveTitleEditRevision,
            currentEditRevision: titleEditRevisionRef.current,
            preservePendingEdit: hadPendingKeepaliveTitle,
          });
          latestTitleRef.current = reconciledTitle.nextTitle;
          titleDirtyRef.current = reconciledTitle.isDirty;
          // 如果 keepalive 成功，服务端内容 === 当前草稿 → 下方的去重检查会跳过保存
          // 如果 keepalive 失败，服务端内容 ≠ 当前草稿 → 正常保存流程
        } catch {
          // 拉取失败时继续使用旧 ref，让 409 处理器兜底
        } finally {
          // 如果后续 try 块执行，saveInFlightRef 会在那里重新设置；
          // 如果 draftSource === lastSavedSourceRef 提前返回，需要在此清除。
          saveInFlightRef.current = false;
        }
      }

      const draftSource = latestDraftRef.current.source;
      const draftTitleInput = latestTitleRef.current;
      const draftTitle = normalizeNoteTitle(draftTitleInput);
      const draftTitleWasDirty = titleDirtyRef.current;
      const sourceChanged = draftSource !== lastSavedSourceRef.current;
      const requestTitleEditRevision = titleEditRevisionRef.current;
      if (
        !sourceChanged &&
        !draftTitleWasDirty
      ) {
        clearPersistedDraft(draftSource, draftTitleInput);
        const settledTitle = lastSavedTitleRef.current;
        latestTitleRef.current = settledTitle;
        if (!isAutosaveRequest) endSession();
        if (mountedRef.current) {
          setTitle(settledTitle);
          setIsAutoTitle(lastSavedTitleSourceRef.current === "auto");
          setCurrentVersionId(savedVersionIdRef.current);
          setCurrentVersionNo(currentVersionNoRef.current);
          setDirty(false);
          setHasRecoveredConflictDraft(false);
          recoveredConflictRef.current = false;
          if (!isAutosaveRequest) setSaving("saved");
        }
        return true;
      }

      if (savedStateTimerRef.current) {
        clearTimeout(savedStateTimerRef.current);
        savedStateTimerRef.current = null;
      }
      if (mountedRef.current) setSaving("saving");

      try {
        const blocks = sourceChanged ? markdownToBlocks(draftSource) : null;
        // Phase 2: 会话内自动保存 → 原地更新（isAutosave=true）
        //          会话外自动保存 → 创建新版本（isAutosave=false），然后开始新会话
        // 标题变更强制创建新版本，使 baseVersionId 继续承担多标签页并发令牌。
        const actualIsAutosave =
          isAutosaveRequest &&
          sessionVersionIdRef.current !== null &&
          !draftTitleWasDirty;
        saveInFlightRef.current = true;
        const updated = await api.updateNote(noteId, {
          ...(draftTitleWasDirty ? { title: draftTitle } : {}),
          ...(blocks ? { blocks } : {}),
          baseVersionId: savedVersionIdRef.current ?? undefined,
          isAutosave: actualIsAutosave,
        });
        saveInFlightRef.current = false;
        savedVersionIdRef.current = updated.version.id;
        currentVersionNoRef.current = updated.version.versionNo;
        lastSavedSourceRef.current = draftSource;
        lastSavedTitleRef.current = updated.note.title;
        lastSavedTitleSourceRef.current = updated.note.titleSource;
        const sourceIsLatest = latestDraftRef.current.source === draftSource;
        const reconciledTitle = reconcileSavedNoteTitle({
          latestTitle: latestTitleRef.current,
          savedTitle: updated.note.title,
          requestEditRevision: requestTitleEditRevision,
          currentEditRevision: titleEditRevisionRef.current,
        });
        latestTitleRef.current = reconciledTitle.nextTitle;
        titleDirtyRef.current = reconciledTitle.isDirty;
        const isLatestDraft = sourceIsLatest && !reconciledTitle.isDirty;
        if (isLatestDraft) {
          clearPersistedDraft(draftSource, draftTitleInput);
        }

        // Phase 2: 编辑会话状态管理
        if (isAutosaveRequest) {
          if (!actualIsAutosave || updated.version.id !== sessionVersionIdRef.current) {
            // 创建了新版本或内容去重匹配：开始新会话
            sessionVersionIdRef.current = updated.version.id;
          }
          // 会话内原地更新时会话继续；无论哪种情况都重置超时
          // 仅在组件仍挂载时重置，避免卸载后的异步保存泄漏定时器
          if (mountedRef.current) resetSessionTimeout();
        } else {
          // 显式保存：结束会话（版本被冻结为快照）
          endSession();
        }

        if (mountedRef.current) {
          if (!reconciledTitle.isDirty) {
            setTitle(reconciledTitle.nextTitle);
            setIsAutoTitle(updated.note.titleSource === "auto");
          }
          setCurrentVersionId(updated.version.id);
          setCurrentVersionNo(updated.version.versionNo);
          setDirty(!isLatestDraft);
          setSaving(isLatestDraft ? "saved" : "idle");
          if (isLatestDraft) {
            setHasRecoveredConflictDraft(false);
            recoveredConflictRef.current = false;
            savedStateTimerRef.current = setTimeout(() => {
              if (mountedRef.current) setSaving("idle");
            }, 1500);
          }
        }
        return true;
      } catch (err) {
        saveInFlightRef.current = false;
        if (err instanceof ApiError && err.status === 409) {
          try {
            const fresh = await api.getNote(noteId);
            savedVersionIdRef.current = fresh.version.id;
            currentVersionNoRef.current = fresh.version.versionNo;
            const freshMarkdown = fresh.blocks.length > 0 ? blocksToMarkdown(fresh.blocks) : "";
            const nextConflict = {
              serverTitle: fresh.note.title,
              serverTitleSource: fresh.note.titleSource,
              serverSource: freshMarkdown,
              serverVersionNo: fresh.version.versionNo,
            };
            persistDraftLocally(draftSource);
            conflictDataRef.current = nextConflict;
            endSession();
            if (mountedRef.current) {
              setCurrentVersionId(fresh.version.id);
              setConflictData(nextConflict);
              setSaving("conflict");
            }
          } catch {
            if (mountedRef.current) setSaving("error");
          }
        } else if (err instanceof ApiError && err.status === 404) {
          // CONC-02: 笔记已被其他用户删除，区分 404 与普通错误
          persistDraftLocally(draftSource);
          endSession();
          noteDeletedRef.current = true;
          if (mountedRef.current) {
            setSaving("deleted");
          }
        } else if (mountedRef.current) {
          setSaving("error");
        }
        return false;
      }
    });
    saveChainRef.current = operation;
    return operation;
  }, [clearPersistedDraft, endSession, noteId, persistDraftLocally, resetSessionTimeout]);

  const flushLatestDraft = useCallback(async () => {
    // Milkdown listener 有 200ms debounce，保存前主动读取最新内容
    const latestMd = editorRef.current?.getMarkdown();
    if (latestMd != null && latestMd !== latestDraftRef.current.source) {
      latestDraftRef.current = { ...latestDraftRef.current, source: latestMd };
    }
    // 保存期间仍可能产生新输入；只有当前源码与最后成功版本一致才算真正 flush 完成。
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const saved = await save(false);
      if (!saved) return false;
      if (
        latestDraftRef.current.source === lastSavedSourceRef.current &&
        !titleDirtyRef.current
      ) return true;
    }
    return false;
  }, [save]);

  function scheduleSave() {
    if (!isOwner) return;
    if (
      conflictDataRef.current ||
      isDeletingRef.current ||
      restoringRef.current ||
      noteDeletedRef.current ||
      generationLockedRef.current
    ) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(true), 2500);
    // Phase 2: 每次编辑都重置会话超时
    resetSessionTimeout();
  }

  function updateSource(next: string) {
    if (!isOwner) return;
    if (
      leaving ||
      deleting ||
      restoringRef.current ||
      noteDeletedRef.current ||
      generationLockedRef.current
    ) return;
    recoveredConflictRef.current = false;
    latestDraftRef.current = { ...latestDraftRef.current, source: next };
    setSource(next);
    syncDirty();
    scheduleSave();
  }

  function updateTitle(next: string) {
    if (!isOwner || ownerLoading) return;
    if (
      leaving ||
      deleting ||
      restoringRef.current ||
      noteDeletedRef.current ||
      generationLockedRef.current
    ) return;
    const boundedTitle = next.slice(0, 200);
    const normalizedTitle = normalizeNoteTitle(boundedTitle);
    titleEditRevisionRef.current += 1;
    latestTitleRef.current = boundedTitle;
    const titleChanged = normalizedTitle !== lastSavedTitleRef.current;
    titleDirtyRef.current = titleChanged;
    setTitle(boundedTitle);
    setIsAutoTitle(
      !titleChanged &&
      lastSavedTitleSourceRef.current === "auto",
    );
    setDirty(
      latestDraftRef.current.source !== lastSavedSourceRef.current || titleChanged,
    );
    scheduleSave();
  }

  // F-007: 冲突解决 — 采用服务端版本
  function resolveWithServer() {
    if (!conflictData) return;
    const discardedSource = latestDraftRef.current.source;
    const discardedTitle = latestTitleRef.current;
    discardedDraftRef.current = {
      source: discardedSource,
      title: discardedTitle,
      isAutoTitle,
      titleChanged: titleDirtyRef.current,
    };
    setHasDiscardedDraft(true);
    setSource(conflictData.serverSource);
    editorRef.current?.setMarkdown(conflictData.serverSource, true);
    latestDraftRef.current = { ...latestDraftRef.current, source: conflictData.serverSource };
    lastSavedSourceRef.current = conflictData.serverSource;
    latestTitleRef.current = conflictData.serverTitle;
    lastSavedTitleRef.current = conflictData.serverTitle;
    lastSavedTitleSourceRef.current = conflictData.serverTitleSource;
    titleDirtyRef.current = false;
    setTitle(conflictData.serverTitle);
    setIsAutoTitle(conflictData.serverTitleSource === "auto");
    setCurrentVersionNo(conflictData.serverVersionNo);
    currentVersionNoRef.current = conflictData.serverVersionNo;
    conflictDataRef.current = null;
    setConflictData(null);
    setDirty(false);
    setSaving("idle");
    setHasRecoveredConflictDraft(false);
    recoveredConflictRef.current = false;
    clearPersistedDraft(discardedSource, discardedTitle);
    endSession();
  }

  function discardRecoveredConflictDraft() {
    const recoveredSource = latestDraftRef.current.source;
    const recoveredTitle = latestTitleRef.current;
    latestDraftRef.current = { source: initialMarkdown };
    latestTitleRef.current = initialTitle;
    lastSavedTitleSourceRef.current = titleSource;
    titleDirtyRef.current = false;
    setSource(initialMarkdown);
    editorRef.current?.setMarkdown(initialMarkdown, true);
    setTitle(initialTitle);
    setIsAutoTitle(titleSource === "auto");
    setDirty(false);
    setSaving("idle");
    setHasRecoveredConflictDraft(false);
    recoveredConflictRef.current = false;
    clearPersistedDraft(recoveredSource, recoveredTitle);
    endSession();
  }

  // R-008: 恢复被丢弃的本地草稿
  function restoreDiscardedDraft() {
    if (!discardedDraftRef.current) return;
    const discardedDraft = discardedDraftRef.current;
    setSource(discardedDraft.source);
    editorRef.current?.setMarkdown(discardedDraft.source, true);
    setTitle(discardedDraft.title);
    setIsAutoTitle(discardedDraft.isAutoTitle);
    latestDraftRef.current = { ...latestDraftRef.current, source: discardedDraft.source };
    latestTitleRef.current = discardedDraft.title;
    titleDirtyRef.current = discardedDraft.titleChanged;
    discardedDraftRef.current = null;
    setHasDiscardedDraft(false);
    setDirty(true);
    setSaving("idle");
    scheduleSave();
  }

  // F-007: 冲突解决 — 保留本地版本
  async function resolveWithLocal() {
    if (!conflictData) return;
    lastSavedSourceRef.current = conflictData.serverSource;
    lastSavedTitleRef.current = conflictData.serverTitle;
    lastSavedTitleSourceRef.current = conflictData.serverTitleSource;
    // “保留本地版本”覆盖正文与标题；按刚拉取的服务端标题重新建立 dirty 基线。
    titleDirtyRef.current =
      normalizeNoteTitle(latestTitleRef.current) !== conflictData.serverTitle;
    if (titleDirtyRef.current) setIsAutoTitle(false);
    conflictDataRef.current = null;
    setConflictData(null);
    setSaving("idle");
    endSession();
    await save(false);
  }

  /** 恢复到指定版本（实际执行恢复操作） */
  async function handleRestoreVersion(versionId: string) {
    if (noteDeletedRef.current) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    restoringRef.current = true;
    setRestoring(true);
    try {
      // 等待飞行中的保存完成，避免 restore 与 save 交错时 baseVersionId 过期
      // 导致不必要的 409 冲突对话框（后端 FOR UPDATE 锁保证数据安全，
      // 但等待 saveChain 可消除此 UX 问题）。
      await saveChainRef.current;
      // CONC-05: 传入 baseVersionId 让服务端做乐观检查，避免无条件覆盖他人编辑
      const result = await api.restoreNoteVersion(noteId, versionId, savedVersionIdRef.current ?? undefined);
      // 更新编辑器状态
      const restoredMarkdown = result.blocks.length > 0
        ? blocksToMarkdown(result.blocks as Block[])
        : "";
      setSource(restoredMarkdown);
      editorRef.current?.setMarkdown(restoredMarkdown, true);
      latestDraftRef.current = { source: restoredMarkdown };
      // blocksToMarkdown 往返可能不完美还原原始 markdown（空行/缩进微差），
      // 但 lastSavedSourceRef 设为 restoredMarkdown 后：
      // - 用户不编辑 → draftSource === lastSavedSourceRef → 不触发保存（正确）
      // - 用户编辑 → 正常保存，baseVersionId 指向恢复后的版本（正确）
      lastSavedSourceRef.current = restoredMarkdown;
      latestTitleRef.current = result.note.title;
      lastSavedTitleRef.current = result.note.title;
      lastSavedTitleSourceRef.current = result.note.titleSource;
      titleDirtyRef.current = false;
      savedVersionIdRef.current = result.version.id;
      currentVersionNoRef.current = result.version.versionNo;
      setTitle(result.note.title);
      setIsAutoTitle(result.note.titleSource === "auto");
      setCurrentVersionId(result.version.id);
      setCurrentVersionNo(result.version.versionNo);
      setDirty(false);
      setSaving("idle");
      // Phase 2: 版本恢复后结束会话——currentVersionId 已切换，旧会话失效
      endSession();
      // 版本列表由 useEffect 依赖 currentVersionNo 自动刷新，无需显式调用
    } catch (err) {
      // CONC-05: 恢复时检测到版本冲突，提示用户刷新
      if (err instanceof ApiError && err.status === 409) {
        setSaving("conflict");
        endSession();
        try {
          const fresh = await api.getNote(noteId);
          savedVersionIdRef.current = fresh.version.id;
          currentVersionNoRef.current = fresh.version.versionNo;
          const freshMarkdown = fresh.blocks.length > 0 ? blocksToMarkdown(fresh.blocks) : "";
          conflictDataRef.current = {
            serverTitle: fresh.note.title,
            serverTitleSource: fresh.note.titleSource,
            serverSource: freshMarkdown,
            serverVersionNo: fresh.version.versionNo,
          };
          if (mountedRef.current) {
            setCurrentVersionId(fresh.version.id);
            setConflictData(conflictDataRef.current);
            setSaving("conflict");
          }
        } catch {
          if (mountedRef.current) setSaving("error");
        }
      } else if (err instanceof ApiError && err.status === 404) {
        // CONC-02: 笔记已被其他用户删除
        endSession();
        noteDeletedRef.current = true;
        if (mountedRef.current) {
          setSaving("deleted");
        }
      } else {
        setSaving("error");
      }
    } finally {
      restoringRef.current = false;
      setRestoring(false);
      setConfirmRestore(null);
    }
  }

  function jumpToPreviewHeading(block: Block) {
    const previewPane = previewRef.current;
    if (!previewPane) return;
    // 优先按大纲中的标题序号匹配预览中对应位置的标题元素。
    const headingIndex = allOutlineBlocks.findIndex(
      (b) => b.content === block.content && b.ordinal === block.ordinal,
    );
    const hasSuppressedLeadHeading = hasDuplicateArticleLeadHeading(source, title);
    if (headingIndex === 0 && hasSuppressedLeadHeading) {
      const articleHeader = previewPane.querySelector<HTMLElement>(".note-article-header");
      if (articleHeader) {
        articleHeader.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        workbenchRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }

    // 文章标题不属于 Markdown 大纲；只在正文中匹配，避免索引整体偏移一位。
    const headings = previewPane.querySelectorAll(
      ".note-article-body h1, .note-article-body h2, .note-article-body h3, .note-article-body h4, .note-article-body h5, .note-article-body h6",
    );
    if (headings.length === 0) return;
    const previewHeadingIndex = hasSuppressedLeadHeading
      ? headingIndex - 1
      : headingIndex;
    let targetHeading: HTMLElement | null = null;
    if (previewHeadingIndex >= 0 && previewHeadingIndex < headings.length) {
      targetHeading = headings[previewHeadingIndex] as HTMLElement;
    }

    // 回退：按文本匹配（兼容行内加粗/斜体等格式差异）
    if (!targetHeading) {
      const headingText = stripMarkdownTitle(block.content);
      if (headingText) {
        for (const heading of Array.from(headings)) {
          const text = heading.textContent ?? "";
          if (text === headingText || text.includes(headingText) || headingText.includes(text)) {
            targetHeading = heading as HTMLElement;
            break;
          }
        }
      }
    }

    if (!targetHeading) return;

    // 完整预览由 workbench / 页面滚动，而不是 previewPane 自己滚动。
    // scrollIntoView 会选择实际滚动祖先，并配合标题 scroll-margin 避开双层顶栏。
    if (mode === "preview") {
      targetHeading.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    // 从标题元素向上查找真正可滚动的容器
    // 桌面端 .ne-editor-preview 是 overflow:hidden，真正滚动的是内层 .md-preview
    // 移动端 .ne-editor-preview 本身是 overflow:auto
    let scrollable: HTMLElement | null = targetHeading.parentElement;
    while (scrollable && scrollable !== previewPane) {
      const style = getComputedStyle(scrollable);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        scrollable.scrollHeight > scrollable.clientHeight
      ) {
        break;
      }
      scrollable = scrollable.parentElement;
    }
    const container = scrollable ?? previewPane;
    const containerRect = container.getBoundingClientRect();
    const headingRect = targetHeading.getBoundingClientRect();
    const offset = headingRect.top - containerRect.top + container.scrollTop;
    container.scrollTo({
      top: Math.max(0, offset - 16),
      behavior: "smooth",
    });
  }

  function jumpToBlock(block: Block) {
    // 预览模式：滚动预览面板到对应标题
    if (mode === "preview") {
      const previewPane = previewRef.current;
      if (previewPane) {
        jumpToPreviewHeading(block);
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(() => jumpToBlock(block)));
      return;
    }
    // 编辑模式：在 Milkdown 编辑器中找到标题元素并滚动
    const editorPane = editorPaneRef.current?.querySelector(".ProseMirror");
    if (!editorPane) {
      requestAnimationFrame(() => requestAnimationFrame(() => jumpToBlock(block)));
      return;
    }
    const headingText = stripMarkdownTitle(block.content.trim());
    if (!headingText) return;
    const headings = Array.from(editorPane.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
    const target = headings.find((h) => {
      const text = h.textContent ?? "";
      return text === headingText || text.includes(headingText) || headingText.includes(text);
    });
    if (target) {
      editorRef.current?.focus();
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function syncImageUploadState() {
    const uploads = Array.from(imageUploadItemsRef.current.values());
    const pendingCount = uploads.filter(
      (upload) => upload.status === "queued" || upload.status === "uploading",
    ).length;
    uploadingCountRef.current = pendingCount;
    if (!mountedRef.current) return;
    setUploadingCount(pendingCount);
    setImageUploads(uploads.map(({
      id,
      name,
      size,
      status,
      loaded,
      total,
      error,
    }) => ({
      id,
      name,
      size,
      status,
      loaded,
      total,
      error,
    })));
  }

  function removeImageUploadPlaceholder(task: ImageUploadTask) {
    const editor = editorRef.current;
    const currentSource = editor?.getMarkdown() ?? latestDraftRef.current.source;
    const cleaned = currentSource.replace(task.placeholder, "");
    if (cleaned === currentSource) return;
    updateSource(cleaned);
    editor?.setMarkdown(cleaned);
  }

  function insertImageUploadPlaceholder(task: ImageUploadTask) {
    const editor = editorRef.current;
    const currentSource = editor?.getMarkdown() ?? latestDraftRef.current.source;
    if (currentSource.includes(`uploading:${task.id}`)) return;
    if (editor) {
      editor.insertText(task.placeholder);
      const updatedSource = editor.getMarkdown();
      if (updatedSource != null) updateSource(updatedSource);
      return;
    }
    const separator = currentSource && !currentSource.endsWith("\n") ? "\n\n" : "";
    updateSource(`${currentSource}${separator}${task.placeholder}`);
  }

  function scheduleImageUploadRemoval(task: ImageUploadTask) {
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
    task.cleanupTimer = setTimeout(() => {
      const current = imageUploadItemsRef.current.get(task.id);
      if (
        current !== task ||
        (task.status !== "succeeded" && task.status !== "cancelled")
      ) return;
      imageUploadItemsRef.current.delete(task.id);
      imageUploadQueueRef.current = imageUploadQueueRef.current.filter((id) => id !== task.id);
      syncImageUploadState();
    }, IMAGE_UPLOAD_RESULT_VISIBLE_MS);
  }

  function imageUploadErrorMessage(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.code === "upload_timeout") return "上传超时，请重试";
      if (error.status === 413) return "图片过大，请压缩后重试";
      if (error.status === 422 || error.status === 400) {
        return error.message || "图片格式或尺寸不受支持";
      }
    }
    return "上传失败，请重试";
  }

  async function runImageUpload(task: ImageUploadTask, controller: AbortController) {
    try {
      const result = await api.uploadImage(task.file, noteId, {
        signal: controller.signal,
        timeoutMs: IMAGE_UPLOAD_TIMEOUT_MS,
        onProgress: (loaded, total) => {
          if (task.status !== "uploading") return;
          task.loaded = loaded;
          task.total = total > 0 ? total : task.size;
          syncImageUploadState();
        },
      });
      if (task.status === "cancelled") return;

      const editor = editorRef.current;
      editor?.replaceImageSrc(`uploading:${task.id}`, result.url);
      let updatedSource = editor?.getMarkdown() ?? latestDraftRef.current.source;
      if (updatedSource.includes(`uploading:${task.id}`)) {
        updatedSource = updatedSource.replace(`uploading:${task.id}`, result.url);
        editor?.setMarkdown(updatedSource);
      }
      updateSource(updatedSource);
      task.status = "succeeded";
      task.loaded = task.total || task.size;
      task.error = null;
    } catch (error) {
      if (
        task.status === "cancelled" ||
        (error instanceof ApiError && error.code === "upload_cancelled")
      ) {
        task.status = "cancelled";
        task.error = null;
      } else {
        task.status = "failed";
        task.error = imageUploadErrorMessage(error);
      }
    } finally {
      task.controller = null;
      activeImageUploadsRef.current = Math.max(0, activeImageUploadsRef.current - 1);
      syncImageUploadState();
      if (!mountedRef.current) return;
      if (task.status === "succeeded" || task.status === "cancelled") {
        scheduleImageUploadRemoval(task);
      }
      pumpImageUploads();
    }
  }

  function pumpImageUploads() {
    if (!mountedRef.current) return;
    while (
      activeImageUploadsRef.current < MAX_CONCURRENT_IMAGE_UPLOADS &&
      imageUploadQueueRef.current.length > 0
    ) {
      const nextId = imageUploadQueueRef.current.shift();
      if (!nextId) continue;
      const task = imageUploadItemsRef.current.get(nextId);
      if (!task || task.status !== "queued") continue;

      const controller = new AbortController();
      task.status = "uploading";
      task.controller = controller;
      activeImageUploadsRef.current += 1;
      syncImageUploadState();
      void runImageUpload(task, controller);
    }
  }

  // 图片上传：先写入稳定占位符，再由最多 3 个并发任务上传并原位替换。
  function queueImageUpload(file: File) {
    if (!file.type.startsWith("image/")) {
      setUploadError("仅支持上传图片文件。");
      return;
    }
    if (
      generationLockedRef.current ||
      restoringRef.current ||
      isDeletingRef.current ||
      noteDeletedRef.current
    ) {
      setUploadError("当前暂不能添加图片，请稍后重试。");
      return;
    }

    const id = crypto.randomUUID();
    const task: ImageUploadTask = {
      id,
      name: file.name || "粘贴的图片",
      size: file.size,
      status: "queued",
      loaded: 0,
      total: file.size,
      error: null,
      file,
      placeholder: `![上传中…](uploading:${id})`,
      controller: null,
      cleanupTimer: null,
    };
    imageUploadItemsRef.current.set(id, task);
    imageUploadQueueRef.current.push(id);
    insertImageUploadPlaceholder(task);
    setUploadError(null);
    syncImageUploadState();
    pumpImageUploads();
  }

  function retryImageUpload(id: string) {
    const task = imageUploadItemsRef.current.get(id);
    if (!task || task.status !== "failed" || generationLockedRef.current) return;
    if (task.cleanupTimer) {
      clearTimeout(task.cleanupTimer);
      task.cleanupTimer = null;
    }
    task.status = "queued";
    task.loaded = 0;
    task.total = task.size;
    task.error = null;
    insertImageUploadPlaceholder(task);
    imageUploadQueueRef.current.push(task.id);
    syncImageUploadState();
    pumpImageUploads();
  }

  function cancelImageUpload(id: string) {
    const task = imageUploadItemsRef.current.get(id);
    if (
      !task ||
      task.status === "succeeded" ||
      task.status === "cancelled"
    ) return;

    imageUploadQueueRef.current = imageUploadQueueRef.current.filter((queuedId) => queuedId !== id);
    task.status = "cancelled";
    task.error = null;
    removeImageUploadPlaceholder(task);
    task.controller?.abort();
    syncImageUploadState();
    if (!task.controller) scheduleImageUploadRemoval(task);
  }

  // 工具栏按钮触发文件选择
  function handleImageFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      queueImageUpload(file);
    }
    e.target.value = "";
  }

  function changeMode(nextMode: EditorMode) {
    setMode(nextMode);
    if (nextMode === "edit") {
      requestAnimationFrame(() => {
        editorRef.current?.focus();
      });
    }
  }

  function changeViewMode(next: ViewMode) {
    if (next === viewMode) return;
    if (next === "fullscreen") {
      const el = workbenchRef.current;
      if (el?.requestFullscreen) {
        void el.requestFullscreen().then(
          () => setViewMode("fullscreen"),
          () => setViewMode("wide"),
        );
      } else {
        setViewMode("wide");
      }
    } else {
      if (document.fullscreenElement) {
        exitingFullscreenRef.current = true;
        void document.exitFullscreen().then(() => {
          exitingFullscreenRef.current = false;
          setViewMode(next);
        });
      } else {
        setViewMode(next);
      }
    }
  }

  function applyStarterTemplate(template: string) {
    updateSource(template);
    editorRef.current?.setMarkdown(template);
    changeMode("edit");
    requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  }

  function insertFirstHeading(fromDrawer = false) {
    if (fromDrawer) setInspectorOpen(false);
    changeMode("edit");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        editorRef.current?.focus();
        const currentMd = editorRef.current?.getMarkdown() ?? source;
        editorRef.current?.insertText(currentMd.trim() ? "\n\n# 新标题\n" : "# 新标题\n\n");
      });
    });
  }

  // R-008: beforeunload
  useEffect(() => {
    const onBeforeUnload = () => {
      // Milkdown listener 有 200ms debounce，beforeunload 时主动读取最新内容
      const latestMd = editorRef.current?.getMarkdown();
      if (latestMd != null && latestMd !== latestDraftRef.current.source) {
        latestDraftRef.current = { ...latestDraftRef.current, source: latestMd };
      }
      if (
        isOwnerRef.current &&
        !isDeletingRef.current &&
        !conflictDataRef.current &&
        !recoveredConflictRef.current &&
        !noteDeletedRef.current &&
        (
          latestDraftRef.current.source !== lastSavedSourceRef.current ||
          titleDirtyRef.current
        )
      ) {
        const draft = latestDraftRef.current;
        // keepalive 受请求体大小和浏览器生命周期限制，本地副本是最后一道保护。
        persistDraftLocally(draft.source);
        // Saving/queued/running generation must never start another PATCH, but
        // the local copy above still protects an in-flight save on hard unload.
        if (generationLockedRef.current) return;
        // 如果保存正在飞行中，跳过 keepalive 请求——飞行中的 save 已经在处理
        // 内容，keepalive 携带的 baseVersionId 已过期，服务端会返回 409 并被
        // 静默吞掉。本地草稿已持久化，下次进入页面时会恢复。
        if (saveInFlightRef.current) return;
        // 标记已发出 keepalive 请求——如果用户取消导航留在页面，
        // 下次 save() 会先拉取最新笔记状态，避免使用过期的 baseVersionId。
        beforeUnloadSaveFiredRef.current = true;
        const sourceChanged = draft.source !== lastSavedSourceRef.current;
        const blocks = sourceChanged ? markdownToBlocks(draft.source) : null;
        const keepaliveTitle = normalizeNoteTitle(latestTitleRef.current);
        const csrfToken = getCsrfToken();
        try {
          fetch(`${API_URL}/notes/${noteId}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
            },
            body: JSON.stringify({
              ...(titleDirtyRef.current
                ? { title: keepaliveTitle }
                : {}),
              ...(blocks
                ? { blocks: blocks.map((b) => ({ type: b.type, content: b.content })) }
                : {}),
              baseVersionId: savedVersionIdRef.current ?? undefined,
              // Phase 2: 遵循会话状态——会话活跃时原地更新，会话结束后创建新版本
              isAutosave: titleDirtyRef.current
                ? false
                : sessionVersionIdRef.current !== null,
            }),
            credentials: "same-origin",
            keepalive: true,
          }).catch(() => {});
        } catch {
          // 忽略，不阻塞卸载
        }
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [noteId, persistDraftLocally]);

  // F-008: SPA 路由跳转时 flush
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    // React Strict Mode 会在开发环境执行一次 setup → cleanup → setup。
    // 每次 setup 都必须恢复存活标记，否则后续保存虽成功却不会同步界面状态。
    mountedRef.current = true;
    const imageUploadItems = imageUploadItemsRef.current;
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      clearSessionTimeout();
      if (
        !isDeletingRef.current &&
        !recoveredConflictRef.current &&
        !noteDeletedRef.current &&
        (
          latestDraftRef.current.source !== lastSavedSourceRef.current ||
          titleDirtyRef.current
        )
      ) {
        persistDraftLocally(latestDraftRef.current.source);
        if (!generationLockedRef.current) void saveRef.current(true);
      }
      if (savedStateTimerRef.current) clearTimeout(savedStateTimerRef.current);
      generationRunRef.current += 1;
      mountedRef.current = false;
      imageUploadQueueRef.current = [];
      for (const upload of imageUploadItems.values()) {
        upload.status = "cancelled";
        upload.controller?.abort();
        if (upload.cleanupTimer) clearTimeout(upload.cleanupTimer);
      }
      imageUploadItems.clear();
      activeImageUploadsRef.current = 0;
      uploadingCountRef.current = 0;
    };
  }, [clearSessionTimeout, persistDraftLocally]);

  async function generateCard() {
    if (uploadingCountRef.current > 0) {
      setGenState("idle");
      setGenMessage("请等待图片上传完成，再生成学习卡。");
      return;
    }
    if (
      Array.from(imageUploadItemsRef.current.values()).some((upload) => upload.status === "failed") ||
      latestDraftRef.current.source.includes("](uploading:")
    ) {
      setGenState("idle");
      setGenMessage("请重试或移除上传失败的图片，再生成学习卡。");
      return;
    }
    if (!latestDraftRef.current.source.trim()) {
      setGenState("idle");
      setGenMessage("先写下一些有效内容，再生成学习卡。");
      return;
    }
    if (conflictDataRef.current) {
      setGenState("idle");
      setGenMessage("请先解决内容冲突，再生成学习卡。");
      conflictDialogRef.current?.focus();
      return;
    }
    const pollToken = generationRunRef.current + 1;
    generationRunRef.current = pollToken;
    setInspectorOpen(false);
    moreActionsRef.current?.removeAttribute("open");
    setGenerationRun(null);
    setGenerationRunId(null);
    setGenerationVersionNo(null);
    setGenerationOverlayDismissed(false);
    setGenerationPhase("saving");
    generationLockedRef.current = true;
    setGenState("generating");
    setGenMessage("正在保存当前内容并锁定生成版本…");
    const saved = await flushLatestDraft();
    if (pollToken !== generationRunRef.current || !mountedRef.current) return;
    if (!saved) {
      generationLockedRef.current = false;
      setGenState("idle");
      setGenMessage("当前内容尚未保存，暂时无法生成学习卡。");
      return;
    }

    try {
      const versionId = savedVersionIdRef.current;
      const versionAtGeneration = currentVersionNoRef.current;
      if (!versionId) {
        generationLockedRef.current = false;
        setGenState("idle");
        setGenMessage("尚未保存任何版本，无法生成学习卡。");
        return;
      }
      setGenerationVersionNo(versionAtGeneration);
      setGenMessage(`已锁定 v${versionAtGeneration}，正在提交生成任务…`);

      if (!CARD_GENERATION_V2_ENABLED) {
        const legacy = await api.generateCard(versionId);
        if (pollToken !== generationRunRef.current || !mountedRef.current) return;
        if (legacy.state === "generated" && legacy.generatedVersionId) {
          generationLockedRef.current = false;
          setGeneratedVersionId(legacy.generatedVersionId);
          setGenState("generated");
          setGenMessage(`v${versionAtGeneration} 的学习卡已生成，可前往学习卡库查看。`);
          return;
        }
        if (!legacy.jobId) {
          throw new Error("服务端未返回可跟踪的生成任务。");
        }
        setGenerationPhase("queued");
        setGenMessage(`v${versionAtGeneration} 已进入生成队列，正在准备处理…`);
        void pollGenerationJob(legacy.jobId, versionId, versionAtGeneration, pollToken);
        return;
      }

      let requestIdentity = generationRequestKeyRef.current;
      if (!requestIdentity || requestIdentity.versionId !== versionId) {
        requestIdentity = {
          versionId,
          key: `card-generation-${globalThis.crypto.randomUUID()}`,
        };
        generationRequestKeyRef.current = requestIdentity;
      }

      const accepted = await api.createCardGenerationRun({
        noteVersionId: versionId,
        idempotencyKey: requestIdentity.key,
      });
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      if (!accepted.canContinueEditing) {
        throw new Error("服务端尚未确认生成快照，暂时无法恢复编辑。");
      }
      generationRequestKeyRef.current = null;
      generationLockedRef.current = false;
      endSession();
      setGenerationRunId(accepted.runId);
      setGenerationVersionNo(accepted.sourceSnapshot.versionNo);
      setGenerationPhase("queued");
      setGenState("generating");
      setGenMessage(
        `已封存 v${accepted.sourceSnapshot.versionNo} 并进入队列；你可以继续编辑，新修改会进入下一版本。`,
      );
      rememberGenerationRun({
        runId: accepted.runId,
        noteVersionId: accepted.sourceSnapshot.noteVersionId,
        versionNo: accepted.sourceSnapshot.versionNo,
        sequence: 0,
      });
      void pollGenerationRun(accepted.runId, pollToken);
    } catch (err) {
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      generationLockedRef.current = false;
      setGenState("idle");
      setGenMessage(err instanceof Error ? err.message : "请求失败");
    }
  }

  async function cancelGenerationRun() {
    if (!generationRunId || cancellingGeneration) return;
    const pollToken = generationRunRef.current + 1;
    generationRunRef.current = pollToken;
    setCancellingGeneration(true);
    setGenMessage("正在取消生成任务…");
    try {
      const cancelledRun = await api.cancelCardGenerationRun(generationRunId);
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      applyGenerationRun(cancelledRun);
      if (isActiveGenerationRun(cancelledRun.status)) {
        void pollGenerationRun(cancelledRun.runId, pollToken);
      }
    } catch (error) {
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      setGenMessage(error instanceof Error ? error.message : "取消失败，任务仍在后台运行。");
      void pollGenerationRun(generationRunId, pollToken);
    } finally {
      if (pollToken === generationRunRef.current && mountedRef.current) {
        setCancellingGeneration(false);
      }
    }
  }

  async function retryGenerationRun() {
    const run = generationRun;
    if (
      !run ||
      run.status !== "needs_attention" ||
      !run.actions.retryable ||
      generationResolutionAction
    ) {
      return;
    }
    const pollToken = generationRunRef.current + 1;
    generationRunRef.current = pollToken;
    setGenerationResolutionAction("retrying");
    setGenerationResolutionError(null);
    setGenMessage("正在从失败检查点重新排队；不会重复处理已经完成的素材…");
    try {
      const retriedRun = await api.retryCardGenerationRun(run.runId);
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      setGenerationResolutionError(null);
      applyGenerationRun(retriedRun);
      if (isActiveGenerationRun(retriedRun.status)) {
        void pollGenerationRun(retriedRun.runId, pollToken);
      }
    } catch (error) {
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      const message = generationResolutionErrorMessage(error, "重试失败，请稍后再试。");
      setGenerationResolutionAction(null);
      setGenerationResolutionError(message);
      setGenMessage(message);
    }
  }

  async function continueGenerationWithExclusions() {
    const run = generationRun;
    if (
      !run ||
      run.status !== "needs_attention" ||
      !run.actions.canContinueWithExclusions ||
      generationResolutionAction
    ) {
      return;
    }
    const excludedUnitIds = getExcludableFailedImageUnitIds(run);
    if (excludedUnitIds.length === 0) {
      setConfirmGenerationExclusions(false);
      setGenerationResolutionError("没有找到可安全排除的失败图片，请重新同步任务状态。");
      setGenerationFailureDialogOpen(true);
      return;
    }

    let requestIdentity = generationExclusionRequestKeyRef.current;
    if (!requestIdentity || requestIdentity.runId !== run.runId) {
      requestIdentity = {
        runId: run.runId,
        key: `card-generation-exclusions-${globalThis.crypto.randomUUID()}`,
      };
      generationExclusionRequestKeyRef.current = requestIdentity;
    }

    const pollToken = generationRunRef.current + 1;
    generationRunRef.current = pollToken;
    setGenerationResolutionAction("excluding");
    setGenerationResolutionError(null);
    setGenMessage(`正在封存排除 ${excludedUnitIds.length} 张失败图片的派生任务…`);
    try {
      const accepted = await api.continueCardGenerationRunWithExclusions(run.runId, {
        excludedUnitIds,
        idempotencyKey: requestIdentity.key,
      });
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      if (!accepted.canContinueEditing) {
        throw new Error("服务端尚未确认派生任务快照，请稍后重试。");
      }
      generationExclusionRequestKeyRef.current = null;
      setConfirmGenerationExclusions(false);
      setGenerationResolutionAction(null);
      setGenerationRun(null);
      setGenerationRunId(accepted.runId);
      setGenerationVersionNo(accepted.sourceSnapshot.versionNo);
      setGenerationPhase("queued");
      setGenState("generating");
      setGenMessage(
        `已排除 ${excludedUnitIds.length} 张失败图片并创建派生任务；正在生成明确标记的部分结果。`,
      );
      rememberGenerationRun({
        runId: accepted.runId,
        noteVersionId: accepted.sourceSnapshot.noteVersionId,
        versionNo: accepted.sourceSnapshot.versionNo,
        sequence: 0,
      });
      void pollGenerationRun(accepted.runId, pollToken);
    } catch (error) {
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      const message = generationResolutionErrorMessage(error, "创建部分结果任务失败，请稍后再试。");
      setConfirmGenerationExclusions(false);
      setGenerationResolutionAction(null);
      setGenerationResolutionError(message);
      setGenerationFailureDialogOpen(true);
      setGenMessage(message);
    }
  }

  const generatedIsCurrent = generatedVersionId === currentVersionId && !dirty;
  const generationNeedsAttention = generationRun?.status === "needs_attention";
  const generationPartialReady = generationRun?.status === "partial_ready";
  const failedGenerationUnits = generationRun
    ? getFailedGenerationUnits(generationRun)
    : [];
  const failedGenerationImages = failedGenerationUnits.filter((unit) => unit.kind === "image");
  const generationFailureHeading = generationFailureTitle(
    failedGenerationUnits,
    generationRun?.error?.code,
  );
  const excludableFailedImageUnitIds = generationRun
    ? getExcludableFailedImageUnitIds(generationRun)
    : [];
  const partialCoverageDetails = generationRun
    ? getPartialCoverageDetails(generationRun)
    : null;
  const generatedCardHref = generationRun?.result?.cardSetId
    ? `/card-sets/${generationRun.result.cardSetId}`
    : generationRun?.result?.cardId
      ? `/cards/${generationRun.result.cardId}`
      : "/cards";
  const hasGeneratedResult = Boolean(
    generationRun?.result?.cardSetId || generationRun?.result?.cardId,
  );
  const hasWritableContent = source.trim().length > 0;
  const failedImageUploadCount = imageUploads.filter((upload) => upload.status === "failed").length;
  const hasUnresolvedImagePlaceholder = source.includes("](uploading:");
  const generationBlocked =
    Boolean(conflictData) ||
    deleting ||
    leaving ||
    saving === "deleted" ||
    uploadingCount > 0 ||
    failedImageUploadCount > 0 ||
    hasUnresolvedImagePlaceholder;
  const genButton = (() => {
    if (genState === "checking") {
      return { label: "正在确认任务…", disabled: true, onClick: () => {} };
    }
    if (genState === "status-error") {
      return { label: "任务状态待确认", disabled: true, onClick: () => {} };
    }
    if (genState === "generating") {
      if (generationOverlayDismissed) {
        return {
          label: "查看生成进度",
          disabled: false,
          onClick: () => setGenerationOverlayDismissed(false),
        };
      }
      return { label: "后台生成中", disabled: true, onClick: () => {} };
    }
    if (generationPartialReady && hasGeneratedResult) {
      return {
        label: "查看部分结果",
        disabled: false,
        onClick: () => router.push(generatedCardHref),
      };
    }
    if (generationNeedsAttention) {
      return {
        label: "处理失败素材",
        disabled: false,
        onClick: () => {
          setGenerationResolutionError(null);
          setGenerationFailureDialogOpen(true);
        },
      };
    }
    // RBAC: 成员不能创建 AI 任务，但已有学习卡仍应保留清晰、可用的阅读出口。
    if (!isOwner) {
      if (generatedVersionId) {
        return {
          label: "查看已有学习卡",
          disabled: false,
          onClick: () => router.push(generatedCardHref),
        };
      }
      return { label: "由所有者生成", disabled: true, onClick: () => {} };
    }
    if (generatedIsCurrent) {
      return {
          label: "前往学习卡库",
          disabled: false,
          onClick: () => router.push(generatedCardHref),
      };
    }
    if (!hasWritableContent) {
      if (generatedVersionId) {
        return {
          label: "查看已有学习卡",
          disabled: false,
          onClick: () => router.push(generatedCardHref),
        };
      }
      return { label: "先写下内容", disabled: true, onClick: () => {} };
    }
    if (generationBlocked) {
      return {
        label: conflictData
          ? "先解决冲突"
          : uploadingCount > 0
            ? "等待图片上传"
            : failedImageUploadCount > 0 || hasUnresolvedImagePlaceholder
              ? "处理上传失败"
            : "暂不可生成",
        disabled: true,
        onClick: () => {},
      };
    }
    if (generatedVersionId) {
      return { label: "生成新版学习卡", disabled: false, onClick: generateCard };
    }
    return { label: "生成学习卡", disabled: false, onClick: generateCard };
  })();

  async function handleExport() {
    if (noteDeletedRef.current) {
      setExportError("笔记已被删除，无法导出。");
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      if (dirty) {
        const saved = await flushLatestDraft();
        if (!saved) throw new Error("请先解决保存问题，再导出当前版本。");
      }
      const blob = await api.exportNoteMarkdown(noteId);
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = markdownDownloadName(title, noteId);
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      window.setTimeout(() => {
        URL.revokeObjectURL(u);
        a.remove();
      }, 1000);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  function returnToLibrary() {
    if (leaving) return;
    if (conflictDataRef.current) {
      conflictDialogRef.current?.focus();
      return;
    }
    setLeaving(true);

    // 返回属于导航操作，不能被网络保存串行阻塞。先同步落一份本地草稿，
    // 再让现有保存链在后台完成；即使请求失败或发生版本冲突，下次进入
    // 仍会从本地草稿恢复，不会用 1～4 轮 PATCH 卡住页面切换。
    if (
      latestDraftRef.current.source !== lastSavedSourceRef.current ||
      titleDirtyRef.current
    ) {
      persistDraftLocally(latestDraftRef.current.source);
      if (!generationLockedRef.current) void save(false);
    }

    if (
      returnHref.startsWith("/search") ||
      returnHref.startsWith("/sources") ||
      returnHref.startsWith("/today")
    ) {
      router.replace(returnHref);
    } else {
      router.push(returnHref);
    }
  }

  const generationVisualState:
    | "idle"
    | "generating"
    | "success"
    | "stale"
    | "attention"
    | "partial" =
    generationPartialReady
      ? "partial"
      : generationNeedsAttention
        ? "attention"
      : genState === "generating" || genState === "checking"
      ? "generating"
      : generatedIsCurrent
        ? "success"
        : generatedVersionId
          ? "stale"
          : "idle";
  const generationHeading = generationVisualState === "partial"
    ? "部分结果已就绪"
    : generationVisualState === "attention"
      ? "生成需要处理"
    : !isOwner
    ? generatedVersionId
      ? "查看学习卡"
      : "等待学习卡"
    : generationVisualState === "success"
      ? "学习卡已就绪"
      : generationVisualState === "generating"
        ? "正在生成学习卡"
        : generationVisualState === "stale"
          ? "更新学习卡"
          : "生成学习卡";
  const genPres: { label: string; tone: StatusTone } =
    generationVisualState === "partial"
      ? { label: "部分结果", tone: "warning" }
      : generationVisualState === "attention"
        ? { label: "需要处理", tone: "warning" }
    : !isOwner
      ? generatedVersionId
        ? { label: "可查看", tone: "success" }
        : { label: "尚未生成", tone: "neutral" }
      : genState === "checking"
        ? { label: "确认中", tone: "running" }
      : genState === "status-error"
        ? { label: "同步异常", tone: "danger" }
      : genState === "generating"
        ? { label: "生成中", tone: "running" }
      : generatedIsCurrent
        ? { label: "已生成", tone: "success" }
        : generatedVersionId
          ? { label: "内容已更新", tone: "warning" }
          : conflictData
            ? { label: "等待处理冲突", tone: "warning" }
            : !hasWritableContent
              ? { label: "等待内容", tone: "neutral" }
              : { label: "尚未生成", tone: "neutral" };
  const previewOutlineOpen = previewOutlineMode === "pinned" || previewOutlinePeeked;
  const generationOverlayTitle = genState === "status-error"
    ? "暂时无法确认任务状态"
    : genState === "checking"
      ? "正在确认学习卡任务状态"
    : generationPhase === "saving"
      ? "正在锁定当前笔记版本"
      : generationPhase === "queued"
        ? "生成任务已进入队列"
        : "正在提炼关键理解";
  const generationOverlayDescription = genState === "status-error"
    ? "任务状态暂时不可用；编辑器不会因此保持锁定。"
    : genState === "checking"
      ? "正在与后台重新同步进度；恢复期间仍可继续编辑。"
    : generationPhase === "saving"
      ? "正在保存并封存这一刻的内容；服务端接受任务后立即恢复编辑。"
      : generationPhase === "queued"
        ? "系统正在准备模型与学习材料，很快开始提炼。"
        : "正在从文章中识别关键概念、关系与可验证的学习要点。";

  function setStoredPreviewOutlineMode(nextMode: PreviewOutlineMode) {
    setPreviewOutlineMode(nextMode);
    // Switching from pinned to auto keeps the panel visible so the focused
    // control never becomes inert. The user can then close it explicitly.
    setPreviewOutlinePeeked(nextMode === "auto");
    try {
      window.localStorage.setItem(PREVIEW_OUTLINE_PREFERENCE_KEY, nextMode);
    } catch {
      // 本地偏好写入失败不影响当前页面交互。
    }
  }

  function closePreviewOutline() {
    previewOutlineTriggerRef.current?.focus({ preventScroll: true });
    setPreviewOutlinePeeked(false);
  }

  function renderOutlinePanel(fromDrawer = false, previewDock = false) {
    const panelBlocks = previewDock ? previewOutlineBlocks : outlineBlocks;
    return (
      <section
        id={previewDock ? "note-preview-outline-panel" : undefined}
        className={`note-editor-panel note-editor-outline-panel${previewDock ? " note-editor-outline-panel--preview" : ""}`}
      >
        <header className="note-editor-panel-header">
          <div className="ne-outline-heading">
            <span className="ne-outline-heading-icon" aria-hidden="true">
              <Icon.Notepad />
            </span>
            <div>
              <h2>{previewDock ? "本文目录" : "文章大纲"}</h2>
              <p>{panelBlocks.length > 0 ? "随正文结构自动更新" : "添加标题后自动生成"}</p>
            </div>
          </div>
          <div className="ne-outline-header-actions">
            <span className="note-editor-panel-count">{panelBlocks.length} 节</span>
            {previewDock && (
              <button
                type="button"
                className="ne-outline-mode-button"
                onClick={() => {
                  const nextMode = previewOutlineMode === "pinned" ? "auto" : "pinned";
                  setStoredPreviewOutlineMode(nextMode);
                }}
                aria-pressed={previewOutlineMode === "pinned"}
                title={previewOutlineMode === "pinned" ? "改为鼠标靠近时显示" : "固定显示目录"}
              >
                <Icon.Pin aria-hidden="true" />
                <span>{previewOutlineMode === "pinned" ? "自动收起" : "固定显示"}</span>
              </button>
            )}
            {previewDock && previewOutlineMode === "auto" && (
              <button
                type="button"
                className="ne-outline-mode-button ne-outline-close-button"
                onClick={closePreviewOutline}
                title="收起文章目录"
                aria-label="收起文章目录"
              >
                <Icon.Close aria-hidden="true" />
                <span>收起</span>
              </button>
            )}
          </div>
        </header>
        <nav className="note-editor-panel-body" aria-label={previewDock ? "本文目录" : "文章大纲"}>
          {panelBlocks.length > 0 ? (
            <ol className="ne-outline-list">
              {panelBlocks.map((block) => {
                const levelMatch = /^<h(\d)>/.exec(block.content.trim());
                const level = levelMatch ? Number(levelMatch[1]) : 1;
                const title = stripMarkdownTitle(block.content) || "未命名标题";
                const blockKey = outlineBlockKey(block);
                return (
                  <li
                    key={blockKey}
                    className="ne-outline-item"
                    data-level={level}
                  >
                    <button
                      type="button"
                      className="ne-outline-link"
                      aria-current={activeOutlineKey === blockKey ? "location" : undefined}
                      onClick={() => {
                        setActiveOutlineKey(blockKey);
                        if (previewDock && previewOutlineMode === "auto") {
                          closePreviewOutline();
                        }
                        if (!fromDrawer) {
                          jumpToBlock(block);
                          return;
                        }
                        setInspectorOpen(false);
                        requestAnimationFrame(() => requestAnimationFrame(() => jumpToBlock(block)));
                      }}
                      title={title}
                    >
                      <strong className="ne-outline-text">{title}</strong>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="note-editor-panel-empty">
              <Icon.Notepad aria-hidden="true" />
              <strong>还没有标题结构</strong>
              <p>使用 <code># 标题</code> 建立可跳转的大纲。</p>
              {isOwner && (
                <button type="button" onClick={() => insertFirstHeading(fromDrawer)}>
                  插入第一个标题
                </button>
              )}
            </div>
          )}
        </nav>
      </section>
    );
  }

  function renderVersionsPanel(compact = false) {
    const allVersions = versions ?? [];
    const visibleVersions = compact ? allVersions.slice(0, 2) : allVersions;
    return (
      <section className={`note-editor-panel note-editor-versions-panel${compact ? " note-editor-versions-panel--compact" : ""}`}>
        <header className="note-editor-panel-header">
          <div>
            <span className="note-editor-panel-kicker">历史版本</span>
            <h2>保存记录</h2>
          </div>
          <span className="note-editor-current-version">v{currentVersionNo}</span>
        </header>
        <div className="note-editor-panel-body">
          {versionsError && (
            <div className="note-editor-inline-error" role="alert">
              <p>{versionsError}</p>
              <button
                type="button"
                onClick={() => {
                  api
                    .listNoteVersions(noteId)
                    .then(({ items }) => {
                      setVersions(items);
                      setVersionsError(null);
                    })
                    .catch(() => setVersionsError("版本历史加载失败"));
                }}
              >
                重试
              </button>
            </div>
          )}
          {versions === null && !versionsError && (
            <div className="ne-version-skeleton-list" role="status" aria-label="正在读取保存记录">
              {[0, 1, 2].map((i) => (
                <div key={i} className="ne-version-skeleton-item">
                  <span className="ne-version-skeleton-node" />
                  <div className="ne-version-skeleton-content">
                    <span className="ne-version-skeleton-line ne-version-skeleton-line--short" />
                    <span className="ne-version-skeleton-line ne-version-skeleton-line--long" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {versions && versions.length === 0 && (
            <div className="note-editor-panel-empty note-editor-panel-empty--compact">
              <Icon.Archive aria-hidden="true" />
              <strong>还没有保存记录</strong>
              <p>完成第一次保存后，版本会显示在这里。</p>
            </div>
          )}
          {visibleVersions.length > 0 && (
            <ol className="ne-version-timeline">
              {visibleVersions.map((version, index) => {
                const isCurrent = version.versionNo === currentVersionNo;
                const isModified = version.updatedAt !== version.createdAt;
                const isLast = index === visibleVersions.length - 1;
                return (
                  <li
                    key={version.id}
                    className="ne-version-timeline-item"
                    data-current={isCurrent || undefined}
                    data-modified={isModified || undefined}
                  >
                    <div className="ne-version-timeline-rail" aria-hidden="true">
                      <span className="ne-version-timeline-node" />
                      {!isLast && <span className="ne-version-timeline-line" />}
                    </div>
                    <div className="ne-version-timeline-card">
                      <div className="ne-version-timeline-head">
                        <strong className="ne-version-timeline-no">
                          v{version.versionNo}
                        </strong>
                        {isCurrent ? (
                          <span className="ne-version-timeline-tag ne-version-timeline-tag--current">
                            <Icon.Check className="ne-version-timeline-tag-icon" aria-hidden="true" />
                            当前
                          </span>
                        ) : isModified ? (
                          <span className="ne-version-timeline-tag ne-version-timeline-tag--auto">
                            自动保存
                          </span>
                        ) : null}
                      </div>
                      <time
                        className="ne-version-timeline-time"
                        dateTime={version.updatedAt}
                        title={`创建：${new Date(version.createdAt).toLocaleString()}\n修改：${new Date(version.updatedAt).toLocaleString()}`}
                      >
                        {relativeTime(version.updatedAt)}
                      </time>
                      {!isCurrent && isOwner && (
                        <button
                          type="button"
                          className="ne-version-restore-btn"
                          onClick={() => setConfirmRestore({ versionId: version.id, versionNo: version.versionNo })}
                          disabled={restoring}
                        >
                          <Icon.Refresh className="ne-version-restore-icon" aria-hidden="true" />
                          恢复此版本
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {compact && allVersions.length > visibleVersions.length && (
            <button
              type="button"
              className="ne-version-view-all"
              onClick={() => {
                setInspectorView("versions");
                setInspectorOpen(true);
              }}
            >
              查看全部 {allVersions.length} 个版本
              <Icon.Arrow aria-hidden="true" />
            </button>
          )}
        </div>
      </section>
    );
  }

  function renderGenerationPanel() {
    return (
      <section
        className="note-editor-panel note-editor-generation-panel"
        data-generation-state={generationVisualState}
      >
        <header className="note-editor-panel-header">
          <div>
            <span className="note-editor-panel-kicker">
              {!isOwner
                ? "成员学习入口"
                : generationVisualState === "partial"
                  ? "受限学习产出"
                : generationVisualState === "attention"
                  ? "严格覆盖保护"
                : generationVisualState === "success"
                ? "学习产出"
                : generationVisualState === "stale"
                  ? "内容有更新"
                  : "从笔记提炼"}
            </span>
            <h2>
              {generationHeading}
            </h2>
          </div>
          <StatusChip tone={genPres.tone} size="sm">
            {genPres.label}
          </StatusChip>
        </header>
        <div
          className="note-editor-panel-body"
          aria-busy={generationVisualState === "generating"}
        >
          <div
            className="note-editor-generation-result"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="note-editor-generation-orbit" aria-hidden="true">
              {generationVisualState === "success"
                ? <Icon.Check />
                : generationVisualState === "partial" || generationVisualState === "attention"
                  ? <Icon.Warn />
                : generationVisualState === "generating"
                  ? <Icon.Refresh />
                  : <Icon.Sparkle />}
            </div>
            <div>
              <strong>
                {!isOwner
                  ? generatedVersionId
                    ? "已有学习卡可以查看"
                    : "等待所有者生成学习卡"
                  : generationVisualState === "partial"
                    ? "已生成明确标记的部分结果"
                  : generationVisualState === "attention"
                    ? generationFailureHeading
                  : generationVisualState === "success"
                  ? "学习卡已经生成"
                  : generationVisualState === "generating"
                    ? "正在提炼关键理解"
                  : generationVisualState === "stale"
                      ? "笔记内容已有更新"
                      : conflictData
                        ? "先解决内容冲突"
                        : !hasWritableContent
                          ? "等待有效内容"
                          : "从当前版本生成"}
              </strong>
              <span>
                {!isOwner
                  ? generatedVersionId
                    ? `基于 v${generationVersionNo ?? currentVersionNo}`
                    : `当前保存版本 v${currentVersionNo}`
                  : generationVisualState === "partial"
                    ? `基于 v${generationVersionNo ?? currentVersionNo} · 未替换完整学习卡`
                  : generationVisualState === "attention"
                    ? `基于 v${generationVersionNo ?? currentVersionNo} · 等待你的选择`
                  : generationVisualState === "success"
                  ? `基于 v${generationVersionNo ?? currentVersionNo} · 已绑定此版本`
                  : generationVisualState === "generating"
                    ? `正在处理 v${generationVersionNo ?? currentVersionNo}`
                    : generationVisualState === "stale"
                      ? `上一张卡片基于 v${generationVersionNo ?? "—"}`
                      : `当前保存版本 v${currentVersionNo}`}
              </span>
            </div>
          </div>
          <p className="note-editor-generation-copy">
            {!isOwner
              ? generatedVersionId
                ? "你可以前往学习卡库继续阅读、验证和复习。"
                : "生成学习卡属于内容管理操作，请联系工作区所有者。"
              : generationVisualState === "partial"
                ? genMessage ?? "部分结果仅包含成功处理的素材，不会替换已有完整学习卡，也不会进入验证或复习流程。"
              : generationVisualState === "attention"
                ? "严格模式已停止发布，不会静默忽略失败素材。可以重试失败检查点；若失败的是图片，也可以明确排除后生成部分结果。"
              : genState === "generating" || genState === "checking" || genState === "status-error"
              ? genMessage ?? (generationVersionNo
                ? `正在基于 v${generationVersionNo} 提炼关键理解；你可以继续编辑。`
                : "正在确认学习卡任务状态；编辑器仍可正常使用。")
              : generatedIsCurrent
                ? "已加入学习卡库，可以立即开始验证与复习。"
                : generatedVersionId
                  ? "正文已有新版本，可以为最新内容生成一张新的学习卡。"
                  : conflictData
                    ? "自动保存已暂停。选择保留本地或服务器版本后即可继续生成。"
                    : !hasWritableContent
                      ? "写下一段概念、摘录或推理，再从保存版本提炼学习卡。"
                      : "先保存当前笔记，再从这个不可变版本生成学习卡。"}
          </p>
          {generationRun && (
            <div
              className="note-editor-generation-progress"
              data-run-status={generationRun.status}
              aria-label="学习卡生成任务进度"
            >
              <div className="note-editor-generation-progress-heading">
                <span>{generationStageLabel(generationRun.stage, generationRun.status)}</span>
                <strong>
                  {generationRun.progress.total > 0
                    ? `${generationRun.progress.completed}/${generationRun.progress.total} ${generationRun.progress.unit}`
                    : "等待首个进度"}
                </strong>
              </div>
              {generationRun.progress.total > 0 && (
                <progress
                  max={generationRun.progress.total}
                  value={Math.min(generationRun.progress.completed, generationRun.progress.total)}
                  aria-label={`${generationRun.progress.completed}/${generationRun.progress.total} ${generationRun.progress.unit}`}
                />
              )}
              <dl className="note-editor-generation-coverage">
                <div>
                  <dt>正文单元</dt>
                  <dd>{measuredCoverageLabel(
                    generationRun.coverage.sourceUnitsCompleted,
                    generationRun.coverage.sourceUnitsTotal,
                    generationRun.coverage.sourceCoverageBps,
                  )}</dd>
                </div>
                <div>
                  <dt>{generationPartialReady ? "图片（实际覆盖）" : "图片"}</dt>
                  <dd>{measuredCoverageLabel(
                    generationRun.coverage.imagesCompleted,
                    generationRun.coverage.imagesTotal,
                    generationRun.coverage.imageCoverageBps,
                  )}</dd>
                </div>
              </dl>
              {generationPartialReady && (
                <div className="note-editor-generation-partial" role="status">
                  <strong>
                    部分结果排除了 {partialCoverageDetails?.excludedImageCount ?? 0} 张失败图片
                  </strong>
                  <span>
                    图片实际覆盖为{" "}
                    {measuredCoverageLabel(
                      generationRun.coverage.imagesCompleted,
                      generationRun.coverage.imagesTotal,
                      generationRun.coverage.imageCoverageBps,
                    )}。策略处理完成度
                    {partialCoverageDetails?.policyAdjustedImageCoverageBps == null
                      ? "待测量"
                      : `${partialCoverageDetails.policyAdjustedImageCoverageBps / 100}%`}
                    只表示其余素材已处理，不代表完整覆盖。
                  </span>
                  <span>该结果不会替换已有完整学习卡，也不会进入验证或复习流程。</span>
                  {hasGeneratedResult && (
                    <a
                      className="note-editor-generation-result-link"
                      href={generatedCardHref}
                    >
                      查看部分结果
                      <Icon.Arrow aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
              {/* 失败明细与处理动作已迁移到独立弹窗(ne-genfail-dialog),
                  抽屉里只保留状态与入口,不再承载失败处理流程。 */}
              {generationRun.warnings.some((warning) => warning.code === "coverage_unmeasured") && (
                <p className="note-editor-generation-warning">
                  当前兼容任务尚未测量完整覆盖率。
                </p>
              )}
              {generationRun.warnings.some((warning) => warning.code === "image_pipeline_not_active") && (
                <p className="note-editor-generation-warning">
                  当前兼容任务没有启用图片解析，图片内容不会进入结果。
                </p>
              )}
              {generationNeedsAttention && isOwner && (
                <div
                  className="note-editor-generation-actions"
                  aria-busy={generationResolutionAction !== null}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setGenerationResolutionError(null);
                      setGenerationFailureDialogOpen(true);
                    }}
                  >
                    {generationResolutionAction === "retrying"
                      ? "正在重试失败检查点…"
                      : generationResolutionAction === "excluding"
                        ? "正在创建部分结果…"
                        : `处理失败素材${failedGenerationUnits.length > 0 ? `（${failedGenerationUnits.length}）` : ""}`}
                  </button>
                </div>
              )}
              {isActiveGenerationRun(generationRun.status) && generationRun.actions.cancellable && (
                <button
                  type="button"
                  className="note-editor-generation-cancel"
                  onClick={() => void cancelGenerationRun()}
                  disabled={cancellingGeneration}
                >
                  {cancellingGeneration ? "正在取消…" : "取消本次生成"}
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className="note-editor-generate-button"
            data-generation-state={generationVisualState}
            onClick={genButton.onClick}
            disabled={genButton.disabled}
            aria-busy={genState === "generating"}
          >
            {generationVisualState === "success"
              ? <Icon.Check aria-hidden="true" />
              : generationVisualState === "partial" || generationVisualState === "attention"
                ? <Icon.Warn aria-hidden="true" />
              : <Icon.Sparkle aria-hidden="true" />}
            <span>{genButton.label}</span>
            {!genButton.disabled && <Icon.Arrow aria-hidden="true" />}
          </button>
          <p className="note-editor-generation-footnote">
            {!isOwner
              ? "成员可以使用已有学习内容，但不会修改原笔记。"
              : generationVisualState === "partial"
                ? "部分结果是独立的受限产物；完整学习卡及其复习状态保持不变。"
              : generationVisualState === "attention"
                ? "未得到你的明确确认前，失败图片不会被自动排除。"
              : generationVisualState === "success"
              ? "继续编辑不会覆盖这张卡。"
              : generationVisualState === "stale"
                ? "重新生成会新增学习卡，不会覆盖旧卡。"
                : "学习卡绑定生成时的保存版本，后续修改不会覆盖旧卡。"}
          </p>
        </div>
      </section>
    );
  }

  return (
    <div
      ref={workbenchRef}
      className="note-workbench"
      data-editor-mode={mode}
      data-view-mode={viewMode}
      data-preview-outline-mode={previewOutlineMode}
      data-generation-active={generationOverlayActive ? "true" : undefined}
    >
      <header className="ne-topbar" data-ui="focus-topbar">
        <div className="ne-topbar-left">
          <button
            type="button"
            className="ne-topbar-back"
            onClick={returnToLibrary}
            disabled={leaving}
            aria-label={`返回${returnLabel}`}
          >
            <Icon.Chevron className="ne-topbar-back-icon" aria-hidden="true" />
            <span>{leaving ? "返回中…" : returnLabel}</span>
          </button>
          <span className="ne-topbar-sep" aria-hidden="true" />
          <div className="ne-topbar-document">
            <span>个人笔记</span>
            <strong>{title || "无标题笔记"}</strong>
          </div>
        </div>

        <div className="ne-topbar-actions">
          <div
            className="ne-save-live"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {!ownerLoading && !isOwner ? (
              <span
                className="ne-readonly-topbar-chip"
                aria-label={`成员只读，当前版本 v${currentVersionNo}`}
              >
                <Icon.Lock aria-hidden="true" />
                <span>成员</span>
                <strong>只读 · v{currentVersionNo}</strong>
              </span>
            ) : (
              <StatusChip tone={savingPres.tone} size="sm" dot>
                {savingPres.label} · v{currentVersionNo}
              </StatusChip>
            )}
          </div>

          <button
            type="button"
            className="ne-btn ne-btn--secondary ne-inspector-trigger"
            onClick={() => {
              setInspectorView("overview");
              setInspectorOpen(true);
            }}
            aria-haspopup="dialog"
            aria-expanded={inspectorOpen}
            aria-controls="note-editor-inspector"
            aria-label={isOwner ? "打开文档工具" : "打开文档信息"}
          >
            <Icon.Notepad className="ne-btn-icon" aria-hidden="true" />
            <span>{isOwner ? "文档工具" : "文档信息"}</span>
          </button>

          <ThemeToggle className="ne-theme-toggle" />

          <button
            type="button"
            className="ne-btn ne-btn--secondary ne-header-save"
            onClick={() => void save(false)}
            hidden={!ownerLoading && !isOwner}
            disabled={ownerLoading || saving === "saving" || restoring || generationLocked}
            aria-busy={saving === "saving"}
          >
            <Icon.Check className="ne-btn-icon" aria-hidden="true" />
            保存
          </button>

          <button
            type="button"
            className="ne-btn ne-btn--primary ne-header-generate"
            data-generation-state={generationVisualState}
            onClick={genButton.onClick}
            hidden={!ownerLoading && !isOwner}
            disabled={genButton.disabled}
            aria-busy={generationLocked}
          >
            {generationVisualState === "success"
              ? <Icon.Check className="ne-btn-icon" aria-hidden="true" />
              : <Icon.Sparkle className="ne-btn-icon" aria-hidden="true" />}
            <span>{genButton.label}</span>
          </button>

          <details ref={moreActionsRef} className="ne-more-actions">
            <summary aria-label="更多笔记操作">
              <Icon.More aria-hidden="true" />
            </summary>
            <div>
              <button
                type="button"
                onClick={() => {
                  moreActionsRef.current?.removeAttribute("open");
                  setInspectorView("overview");
                  setInspectorOpen(true);
                }}
              >
                <Icon.Notepad aria-hidden="true" />
                {isOwner ? "文档工具" : "文档信息"}
              </button>
              <button
                type="button"
                hidden={ownerLoading || !isOwner}
                onClick={() => {
                  moreActionsRef.current?.removeAttribute("open");
                  void save(false);
                }}
                disabled={saving === "saving" || restoring || generationLocked}
              >
                <Icon.Check aria-hidden="true" />
                立即保存
              </button>
              <button
                type="button"
                hidden={ownerLoading || !isOwner}
                onClick={() => {
                  moreActionsRef.current?.removeAttribute("open");
                  genButton.onClick();
                }}
                disabled={genButton.disabled}
              >
                <Icon.Sparkle aria-hidden="true" />
                {genButton.label}
              </button>
              <span className="ne-more-actions-divider" aria-hidden="true" />
              <button
                type="button"
                onClick={() => {
                  moreActionsRef.current?.removeAttribute("open");
                  changeViewMode(viewMode === "normal" ? "wide" : "normal");
                }}
              >
                <Icon.WideView aria-hidden="true" />
                {viewMode === "normal" ? "进入专注模式" : "退出专注模式"}
              </button>
              <button
                type="button"
                onClick={() => {
                  moreActionsRef.current?.removeAttribute("open");
                  changeViewMode(viewMode === "fullscreen" ? "normal" : "fullscreen");
                }}
              >
                <Icon.Fullscreen aria-hidden="true" />
                {viewMode === "fullscreen" ? "退出浏览器全屏" : "浏览器全屏"}
              </button>
              <span className="ne-more-actions-divider" aria-hidden="true" />
              <button
                type="button"
                onClick={() => {
                  moreActionsRef.current?.removeAttribute("open");
                  void handleExport();
                }}
                disabled={exporting}
              >
                <Icon.Download aria-hidden="true" />
                {exporting ? "导出中…" : "导出 Markdown"}
              </button>
              <button
                type="button"
                className="is-danger"
                hidden={!isOwner}
                onClick={() => {
                  moreActionsRef.current?.removeAttribute("open");
                  setConfirmDelete(true);
                }}
              >
                <Icon.Trash aria-hidden="true" />
                删除笔记
              </button>
            </div>
          </details>
        </div>
      </header>

      {/* ── 导出错误 ── */}
      {exportError && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>{exportError}</p>
          <button type="button" className="ne-notice-dismiss" onClick={() => setExportError(null)}>关闭</button>
        </div>
      )}

      {deleteError && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>{deleteError}</p>
          <button type="button" className="ne-notice-dismiss" onClick={() => setDeleteError(null)}>关闭</button>
        </div>
      )}

      {saving === "error" && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>保存没有完成，本地内容仍在当前页面中。</p>
          <button type="button" className="ne-notice-action" onClick={() => void flushLatestDraft()}>
            重试保存
          </button>
        </div>
      )}

      {/* CONC-02: 笔记已被其他用户删除 */}
      {saving === "deleted" && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>这篇笔记已被其他成员删除。你的本地内容已保留，可复制后另存为新笔记。</p>
          <button type="button" className="ne-notice-action" onClick={() => {
            if (
              returnHref.startsWith("/search") ||
              returnHref.startsWith("/sources") ||
              returnHref.startsWith("/today")
            ) {
              router.replace(returnHref);
            } else {
              router.push(returnHref);
            }
          }}>
            返回列表
          </button>
        </div>
      )}

      {/* ── 生成消息 ── */}
      {genMessage && genState === "idle" && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>{genMessage}</p>
          <button type="button" className="ne-notice-dismiss" onClick={() => setGenMessage(null)}>关闭</button>
        </div>
      )}

      {/* ── 主内容：文档工具 + 写作区 ── */}
      <div className="ne-layout">
        {mode === "preview" ? (
          <aside
            className="ne-preview-outline"
            data-open={previewOutlineOpen ? "true" : "false"}
            onPointerEnter={(event) => {
              if (previewOutlineMode !== "auto" || event.pointerType !== "mouse") return;
              if (document.activeElement === previewOutlineTriggerRef.current) {
                previewOutlineTriggerRef.current?.blur();
              }
              setPreviewOutlinePeeked(true);
            }}
            onPointerLeave={(event) => {
              if (
                previewOutlineMode === "auto" &&
                event.pointerType === "mouse" &&
                !event.currentTarget.contains(document.activeElement)
              ) {
                setPreviewOutlinePeeked(false);
              }
            }}
            onBlur={(event) => {
              if (
                previewOutlineMode === "auto" &&
                !event.currentTarget.contains(event.relatedTarget as Node | null)
              ) {
                setPreviewOutlinePeeked(false);
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || previewOutlineMode !== "auto") return;
              event.preventDefault();
              closePreviewOutline();
            }}
          >
            <button
              ref={previewOutlineTriggerRef}
              type="button"
              className="ne-preview-outline-trigger"
              aria-label="显示文章目录"
              aria-controls="note-preview-outline-panel"
              aria-expanded={previewOutlineOpen}
              tabIndex={previewOutlineOpen ? -1 : 0}
              onClick={() => {
                setPreviewOutlinePeeked(true);
                requestAnimationFrame(() => {
                  workbenchRef.current
                    ?.querySelector<HTMLElement>("#note-preview-outline-panel .ne-outline-close-button")
                    ?.focus({ preventScroll: true });
                });
              }}
            >
              <Icon.Notepad aria-hidden="true" />
              <span>目录</span>
            </button>
            <div
              className="ne-preview-outline-panel"
              aria-hidden={!previewOutlineOpen}
              inert={!previewOutlineOpen ? true : undefined}
            >
              {renderOutlinePanel(false, true)}
            </div>
          </aside>
        ) : mode === "edit" ? (
          <aside className="ne-sidebar">
            {renderOutlinePanel()}
            {renderVersionsPanel(true)}
          </aside>
        ) : null}

        {/* 中央：编辑纸面 */}
        <section className="ne-editor">
          {hasRecoveredConflictDraft && (
            <div className="ne-draft-restore" role="status">
              <div>
                <Icon.Refresh aria-hidden="true" />
                <p>
                  <strong>已恢复未解决的本地草稿</strong>
                  <span>这份内容尚未写入服务器；继续编辑或点击保存即可保留。</span>
                </p>
              </div>
              <button type="button" onClick={discardRecoveredConflictDraft}>
                放弃恢复
              </button>
            </div>
          )}
          {hasDiscardedDraft && (
            <div className="ne-draft-restore" role="status">
              <div>
                <Icon.Refresh aria-hidden="true" />
                <p>
                  <strong>保留了一份本地草稿</strong>
                  <span>你刚才采用了服务端版本，仍可把原编辑恢复回来。</span>
                </p>
              </div>
              <button type="button" onClick={restoreDiscardedDraft}>
                恢复草稿
              </button>
            </div>
          )}
          {(isOwner || mode !== "preview") && (
            <div className="ne-editor-toolbar">
              {mode !== "preview" && (
              <div className="ne-editor-title-row">
                <div className="ne-editor-title-field">
                  <span className="ne-editor-kicker">笔记标题</span>
                  <h1 id="note-editor-title" className="ne-editor-visually-hidden">
                    {title.trim() || "无标题笔记"}
                  </h1>
                  <input
                    className="ne-editor-title-input"
                    type="text"
                    value={title}
                    maxLength={200}
                    onChange={(event) => updateTitle(event.target.value)}
                    placeholder="给这篇笔记一个标题"
                    aria-label="笔记标题"
                    disabled={
                      ownerLoading ||
                      !isOwner ||
                      leaving ||
                      deleting ||
                      restoring ||
                      generationLocked ||
                      saving === "deleted"
                    }
                  />
                  <p className="ne-editor-subtitle">
                    支持 Markdown · 实时预览 · 停顿 2.5 秒自动保存
                  </p>
                </div>
                {isAutoTitle && (
                  <span className="ne-chip ne-chip--muted">自动标题</span>
                )}
              </div>
              )}

              {isOwner && (
              <div className="ne-toolbar-controls">
                <div className="ne-mode-switch" role="group" aria-label="编辑器显示模式">
                  <button
                    type="button"
                    className={`ne-toolbar-chip ${mode === "edit" ? "ne-toolbar-chip--active" : ""}`}
                    onClick={() => changeMode("edit")}
                    aria-pressed={mode === "edit"}
                  >
                    <Icon.Pencil className="ne-toolbar-icon" aria-hidden="true" />
                    写作
                  </button>
                  <button
                    type="button"
                    className={`ne-toolbar-chip ${mode === "preview" ? "ne-toolbar-chip--active" : ""}`}
                    onClick={() => changeMode("preview")}
                    aria-pressed={mode === "preview"}
                  >
                    <Icon.Eye className="ne-toolbar-icon" aria-hidden="true" />
                    预览
                  </button>
                </div>
                <div className="ne-toolbar-tail">
                  {mode !== "preview" && (
                    <div className="ne-format-tools" role="group" aria-label="Markdown 格式工具">
                      <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleHeading(1)} aria-label="一级标题" title="一级标题">
                        <Icon.H1 className="ne-toolbar-icon" aria-hidden="true" />
                      </button>
                      <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleHeading(2)} aria-label="二级标题" title="二级标题">
                        <Icon.H2 className="ne-toolbar-icon" aria-hidden="true" />
                      </button>
                      <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleBold()} aria-label="加粗" title="加粗 · ⌘B">
                        <Icon.Bold className="ne-toolbar-icon" aria-hidden="true" />
                      </button>
                      <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleItalic()} aria-label="斜体" title="斜体 · ⌘I">
                        <Icon.Italic className="ne-toolbar-icon" aria-hidden="true" />
                      </button>
                      <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleInlineCode()} aria-label="行内代码" title="行内代码">
                        <Icon.Code className="ne-toolbar-icon" aria-hidden="true" />
                      </button>
                      <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleBlockquote()} aria-label="引用" title="引用">
                        <Icon.QuoteMark className="ne-toolbar-icon" aria-hidden="true" />
                      </button>
                      <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleBulletList()} aria-label="无序列表" title="无序列表">
                        <Icon.List className="ne-toolbar-icon" aria-hidden="true" />
                      </button>
                      <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleLink("https://")} aria-label="链接" title="链接 · ⌘K">
                        <Icon.LinkOut className="ne-toolbar-icon" aria-hidden="true" />
                      </button>
                      <button type="button" className="ne-format-button" onClick={() => editorRef.current?.insertHr()} aria-label="分隔线" title="分隔线">
                        <Icon.Divider className="ne-toolbar-icon" aria-hidden="true" />
                      </button>
                      <button type="button" className="ne-format-button" onClick={() => imageFileInputRef.current?.click()} aria-label="插入图片" title="插入图片">
                        <Icon.Image className="ne-toolbar-icon" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              )}
            </div>
          )}

          <div className="ne-editor-surface" data-mode={mode}>
            {mode === "edit" ? (
              <div className="ne-editor-pane" ref={editorPaneRef} onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "k") {
                  e.preventDefault();
                  editorRef.current?.toggleLink("https://");
                }
              }}>
                {source.trim() === "" && (
                  <div className="ne-starter-row" aria-label="快速开始模板">
                    <span>快速开始</span>
                    <div>
                      <button type="button" disabled={ownerLoading || !isOwner} onClick={() => applyStarterTemplate("# 我想理解的问题\n\n")}>核心问题</button>
                      <button type="button" disabled={ownerLoading || !isOwner} onClick={() => applyStarterTemplate("# 阅读摘录\n\n> 粘贴原文\n\n## 我的理解\n\n")}>阅读整理</button>
                      <button type="button" disabled={ownerLoading || !isOwner} onClick={() => applyStarterTemplate("# 主题\n\n- 要点一\n- 要点二\n")}>要点清单</button>
                    </div>
                  </div>
                )}
                <MilkdownEditor
                  ref={setMilkdownEditorHandle}
                  initialMarkdown={initialMarkdown}
                  onChange={(md) => updateSource(md)}
                  disabled={ownerLoading || !isOwner || leaving || deleting || restoring || generationLocked || saving === "deleted"}
                  onImagePaste={queueImageUpload}
                />
                {imageUploads.length > 0 && (
                  <div className="ne-upload-status" aria-live="polite">
                    <div className="ne-upload-summary">
                      <span>
                        {uploadingCount > 0
                          ? `正在处理 ${uploadingCount} 张图片`
                          : failedImageUploadCount > 0
                            ? `${failedImageUploadCount} 张图片需要处理`
                            : "图片上传已完成"}
                      </span>
                      <span>最多同时上传 {MAX_CONCURRENT_IMAGE_UPLOADS} 张</span>
                    </div>
                    <ul className="ne-upload-list" aria-label="图片上传队列">
                      {imageUploads.map((upload) => {
                        const progress = imageUploadProgress(upload);
                        return (
                          <li
                            key={upload.id}
                            className={`ne-upload-item is-${upload.status}`}
                          >
                            <div className="ne-upload-item-header">
                              <span className="ne-upload-file-name" title={upload.name}>
                                {upload.name}
                              </span>
                              <span className="ne-upload-item-status">
                                {imageUploadStatusLabel(upload.status)}
                              </span>
                            </div>
                            {(upload.status === "uploading" || upload.status === "succeeded") && (
                              <span
                                className="ne-upload-progress-bar"
                                role="progressbar"
                                aria-label={`${upload.name} 上传进度`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={progress}
                              >
                                <span
                                  className="ne-upload-progress-fill"
                                  style={{ width: `${progress}%` }}
                                />
                                <span className="ne-upload-progress-text">{progress}%</span>
                              </span>
                            )}
                            {upload.error && (
                              <span className="ne-upload-item-error" role="alert">
                                {upload.error}
                              </span>
                            )}
                            <span className="ne-upload-item-actions">
                              {upload.status === "failed" && (
                                <button
                                  type="button"
                                  onClick={() => retryImageUpload(upload.id)}
                                >
                                  重试
                                </button>
                              )}
                              {(upload.status === "queued" ||
                                upload.status === "uploading" ||
                                upload.status === "failed") && (
                                <button
                                  type="button"
                                  onClick={() => cancelImageUpload(upload.id)}
                                >
                                  {upload.status === "failed" ? "移除" : "取消"}
                                </button>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {uploadError && (
                  <div className="ne-upload-error" role="alert">
                    {uploadError}
                  </div>
                )}
                <input
                  ref={imageFileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  style={{ display: "none" }}
                  onChange={handleImageFileSelect}
                />
              </div>
            ) : (
              <div
                ref={previewRef}
                className="ne-editor-pane ne-editor-preview"
                role="region"
                aria-label="Markdown 阅读预览"
                tabIndex={0}
              >
                <NoteArticlePreview
                  title={title}
                  source={source}
                  wordCount={wordCount}
                  compact={false}
                  primaryHeading
                  accessory={!ownerLoading && !isOwner ? <MemberNotice context="note" /> : undefined}
                />
              </div>
            )}
          </div>

          {/* 底部统计条 */}
          <div className="ne-editor-footer">
            <div className="ne-editor-footer-stats" aria-label="文档统计">
              <span className="ne-editor-stat">{previewBlocks.length} 块</span>
              <span className="ne-editor-stat-sep">·</span>
              <span className="ne-editor-stat">{wordCount} 非空字符</span>
              {blockDelta !== 0 && (
                <>
                  <span className="ne-editor-stat-sep">·</span>
                  <span className="ne-editor-stat">内容块 {blockDelta > 0 ? `+${blockDelta}` : blockDelta}</span>
                </>
              )}
            </div>
            <details className="ne-footer-help">
              <summary aria-label="查看写作快捷键" title="写作快捷键">
                <Icon.Keyboard aria-hidden="true" />
                <span>快捷键</span>
              </summary>
              <div>
                <strong>写作快捷键</strong>
                <ul>
                  <li><kbd>⌘ / Ctrl + S</kbd><span>立即保存</span></li>
                  <li><kbd>⌘ / Ctrl + B</kbd><span>加粗</span></li>
                  <li><kbd>⌘ / Ctrl + I</kbd><span>斜体</span></li>
                  <li><kbd>⌘ / Ctrl + K</kbd><span>链接</span></li>
                  <li><kbd>⌘ / Ctrl + /</kbd><span>标题</span></li>
                </ul>
              </div>
            </details>
            {isOwner && (
              <div className="ne-learning-next" aria-label="学习下一步">
                <button
                  type="button"
                  className="ne-learning-version"
                  onClick={() => {
                    setInspectorView("versions");
                    setInspectorOpen(true);
                  }}
                  aria-label={`查看版本历史，当前版本 v${currentVersionNo}`}
                >
                  <Icon.Archive aria-hidden="true" />
                  <span>
                    <strong>{savingPres.label} · v{currentVersionNo}</strong>
                    <small>
                      {versions === null
                        ? "读取保存记录…"
                        : `${versions.length} 个保存记录`}
                    </small>
                  </span>
                </button>
                <span className="ne-learning-next-divider" aria-hidden="true" />
                <span className="ne-learning-next-copy">
                  <small>学习下一步</small>
                  <strong>{generationHeading}</strong>
                </span>
                <button
                  type="button"
                  className="ne-learning-generate"
                  data-generation-state={generationVisualState}
                  onClick={genButton.onClick}
                  disabled={genButton.disabled}
                  aria-busy={generationLocked}
                >
                  {generationVisualState === "success"
                    ? <Icon.Check aria-hidden="true" />
                    : <Icon.Sparkle aria-hidden="true" />}
                  <span>{genButton.label}</span>
                  {!genButton.disabled && <Icon.Arrow aria-hidden="true" />}
                </button>
              </div>
            )}
          </div>
        </section>

      </div>

      <Drawer
        id="note-editor-inspector"
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        title={inspectorView === "versions" ? "版本历史" : isOwner ? "文档工具" : "文档信息"}
        side={compactDrawer ? "bottom" : "right"}
        width="min(400px, calc(100vw - 32px))"
        maxHeight="84dvh"
      >
        <div className="note-editor-inspector-content">
          {inspectorView === "versions" ? (
            renderVersionsPanel()
          ) : (
            <>
              {renderOutlinePanel(true)}
              {renderGenerationPanel()}
            </>
          )}
        </div>
      </Drawer>

      {generationOverlayVisible && (
        <div className="ne-generation-overlay" role="presentation" data-modal={generationOverlayActive || undefined}>
          <div
            ref={generationOverlayRef}
            className="ne-generation-dialog"
            role="dialog"
            aria-modal={generationOverlayActive ? "true" : "false"}
            aria-labelledby="ne-generation-title"
            aria-describedby="ne-generation-description"
          >
            <p className="ne-generation-kicker">
              {generationPhase === "saving" ? "正在封存生成快照" : "正在生成学习卡"}
            </p>
            <div className="ne-generation-visual" aria-hidden="true">
              <span className="ne-generation-orbit ne-generation-orbit--outer" />
              <span className="ne-generation-orbit ne-generation-orbit--inner" />
              <span className="ne-generation-card ne-generation-card--back" />
              <span className="ne-generation-card ne-generation-card--middle" />
              <span className="ne-generation-card ne-generation-card--front">
                <Icon.Sparkle />
              </span>
            </div>
            <div className="ne-generation-copy">
              <h2 id="ne-generation-title">{generationOverlayTitle}</h2>
              <p id="ne-generation-description">{generationOverlayDescription}</p>
            </div>
            <ol className="ne-generation-steps" aria-label="生成进度">
              <li data-state={generationPhase === "saving" ? "active" : "done"}>
                <span>1</span>
                <div><strong>保存版本</strong><small>封存本次完整内容</small></div>
              </li>
              <li data-state={generationPhase === "queued" || generationPhase === "running" ? "active" : generationPhase === "saving" ? "upcoming" : "done"}>
                <span>2</span>
                <div><strong>准备材料</strong><small>建立文章结构</small></div>
              </li>
              <li data-state={generationPhase === "running" ? "active" : "upcoming"}>
                <span>3</span>
                <div><strong>提炼卡片</strong><small>后台生成，可继续编辑</small></div>
              </li>
            </ol>
            {generationRun && generationPhase !== "saving" && (
              <div className="ne-generation-progress">
                <div className="ne-generation-progress-bar" aria-hidden="true">
                  <div
                    className="ne-generation-progress-fill"
                    style={{
                      width: `${generationRun.progress.total > 0
                        ? Math.round((generationRun.progress.completed / generationRun.progress.total) * 100)
                        : 0}%`,
                    }}
                  />
                </div>
                <p className="ne-generation-progress-text">
                  {generationStageLabel(generationRun.stage, generationRun.status)}
                  {generationRun.progress.total > 0 && (
                    <> · {generationRun.progress.completed}/{generationRun.progress.total}</>
                  )}
                </p>
              </div>
            )}
            <div className="ne-generation-live" role="status" aria-live="polite" aria-atomic="true">
              <span className="ne-generation-live-dot" aria-hidden="true" />
              <p>{genMessage ?? "任务正在进行，请保持页面打开。"}</p>
            </div>
            {generationPhase === "saving" ? (
              <p className="ne-generation-lock-note">
                <Icon.Lock aria-hidden="true" />
                仅在保存并封存当前版本期间暂停编辑；任务接受后立即恢复。
              </p>
            ) : (
              <button
                type="button"
                className="ne-generation-dismiss"
                onClick={() => setGenerationOverlayDismissed(true)}
              >
                继续编辑，后台生成中
              </button>
            )}
          </div>
        </div>
      )}

      {/* F-007: 冲突解决对话框 */}
      {conflictDialogActive && conflictData && (
        <div className="ne-conflict-overlay" role="dialog" aria-modal="true" aria-label="内容冲突">
          <div ref={conflictDialogRef} className="ne-conflict-dialog" tabIndex={-1}>
            <div className="ne-conflict-header">
              <h3 className="ne-conflict-title">内容冲突</h3>
              <p className="ne-conflict-desc">
                服务端已有更新版本（v{conflictData.serverVersionNo}）。你的本地编辑与服务端不同，请选择保留哪一版。
                自动保存已暂停。
              </p>
            </div>
            <div className="ne-conflict-body">
              <div className="ne-conflict-pane">
                <h4 className="ne-conflict-pane-title">你的本地版本</h4>
                <p className="ne-conflict-document-title">
                  <span>标题</span>
                  <strong>{latestTitleRef.current.trim() || "无标题笔记"}</strong>
                </p>
                <pre className="ne-conflict-pre">{latestDraftRef.current.source}</pre>
              </div>
              <div className="ne-conflict-pane">
                <h4 className="ne-conflict-pane-title">服务端版本（v{conflictData.serverVersionNo}）</h4>
                <p className="ne-conflict-document-title">
                  <span>标题</span>
                  <strong>{conflictData.serverTitle}</strong>
                </p>
                <pre className="ne-conflict-pre">{conflictData.serverSource}</pre>
              </div>
            </div>
            <div className="ne-conflict-footer">
              <button type="button" className="ne-btn ne-btn--secondary" onClick={resolveWithServer}>
                采用服务器内容（保留本地副本）
              </button>
              <button type="button" className="ne-btn ne-btn--primary" onClick={() => void resolveWithLocal()}>
                用本地内容覆盖服务器
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 失败素材处理弹窗:needs_attention 的处理入口。列出全部失败检查点
          (图片 + 文本分片)与对应原因,动作在此完成,不再依赖抽屉。 */}
      {generationFailureDialogOpen && isOwner && generationRun && generationNeedsAttention
        && !conflictData && (
        <div className="ne-genfail-overlay" role="presentation">
          <div
            ref={generationFailureDialogRef}
            className="ne-genfail-dialog"
            role="dialog"
            aria-modal={generationFailureDialogActive ? "true" : "false"}
            aria-labelledby="ne-genfail-title"
            tabIndex={-1}
          >
            <header className="ne-genfail-header">
              <span className="ne-genfail-icon" aria-hidden="true"><Icon.Warn /></span>
              <div className="ne-genfail-heading">
                <h3 id="ne-genfail-title">{generationFailureHeading}</h3>
                <p>
                  基于 v{generationVersionNo ?? currentVersionNo} · 严格模式已停止发布，
                  已完成的素材全部保留，可从失败检查点继续。
                </p>
              </div>
              <button
                type="button"
                className="ne-genfail-close"
                onClick={() => setGenerationFailureDialogOpen(false)}
                aria-label="稍后处理"
              >
                <Icon.X />
              </button>
            </header>
            <div className="ne-genfail-body">
              <dl className="ne-genfail-coverage">
                <div>
                  <dt>正文单元</dt>
                  <dd>{measuredCoverageLabel(
                    generationRun.coverage.sourceUnitsCompleted,
                    generationRun.coverage.sourceUnitsTotal,
                    generationRun.coverage.sourceCoverageBps,
                  )}</dd>
                </div>
                <div>
                  <dt>图片</dt>
                  <dd>{measuredCoverageLabel(
                    generationRun.coverage.imagesCompleted,
                    generationRun.coverage.imagesTotal,
                    generationRun.coverage.imageCoverageBps,
                  )}</dd>
                </div>
              </dl>
              {failedGenerationUnits.length > 0 ? (
                <ul className="ne-genfail-list" aria-label="失败检查点列表">
                  {failedGenerationUnits.map((unit) => {
                    const imageIndex = unit.kind === "image"
                      ? failedGenerationImages.findIndex((image) => image.unitId === unit.unitId) + 1
                      : null;
                    return (
                      <li key={unit.unitId} data-unit-kind={unit.kind}>
                        <span>{generationFailedUnitName(unit, imageIndex)}</span>
                        <small>{generationUnitErrorLabel(unit.errorCode)}</small>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="ne-genfail-empty">
                  {generationRun.error?.code === "scheduler_capacity"
                    ? "后台任务槽位暂时不足，稍后重试即可从当前进度继续。"
                    : generationRun.error?.code === "no_learnable_candidate"
                      ? "已处理全部素材，但没有提炼出可以成卡的知识点。可以充实笔记内容后重新生成。"
                      : "没有失败明细可展示，可以直接重试失败检查点。"}
                </p>
              )}
              {generationResolutionError && (
                <p className="ne-genfail-error" role="alert">{generationResolutionError}</p>
              )}
              <p className="ne-genfail-note">
                未得到你的明确确认前，失败素材不会被静默排除；部分结果也不会替换已有完整学习卡。
              </p>
            </div>
            <footer className="ne-genfail-footer">
              <button
                type="button"
                className="ne-btn ne-btn--secondary ne-genfail-later"
                onClick={() => setGenerationFailureDialogOpen(false)}
              >
                稍后处理
              </button>
              {generationRun.actions.canContinueWithExclusions &&
                excludableFailedImageUnitIds.length > 0 && (
                <button
                  type="button"
                  className="ne-btn ne-btn--secondary"
                  onClick={() => {
                    setGenerationResolutionError(null);
                    setGenerationFailureDialogOpen(false);
                    setConfirmGenerationExclusions(true);
                  }}
                  disabled={generationResolutionAction !== null}
                >
                  {generationResolutionAction === "excluding"
                    ? "正在创建部分结果…"
                    : `排除 ${excludableFailedImageUnitIds.length} 张失败图片并继续`}
                </button>
              )}
              {generationRun.actions.retryable && (
                <button
                  type="button"
                  className="ne-btn ne-btn--primary"
                  onClick={() => void retryGenerationRun()}
                  disabled={generationResolutionAction !== null}
                >
                  {generationResolutionAction === "retrying"
                    ? "正在重试失败检查点…"
                    : failedGenerationUnits.length > 1
                      ? `重试全部 ${failedGenerationUnits.length} 个失败检查点`
                      : "重试失败检查点"}
                </button>
              )}
            </footer>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmGenerationExclusions}
        title={`排除 ${excludableFailedImageUnitIds.length} 张失败图片并继续？`}
        message={`系统将创建一个新的派生任务，并明确排除这 ${excludableFailedImageUnitIds.length} 张无法解析的图片。图片内容不会进入学习卡；生成的部分结果不会替换已有完整学习卡，也不会进入验证或复习流程。`}
        confirmLabel="确认排除并继续"
        loading={generationResolutionAction === "excluding"}
        onConfirm={() => void continueGenerationWithExclusions()}
        onCancel={() => {
          setConfirmGenerationExclusions(false);
          setGenerationFailureDialogOpen(true);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`删除「${title || "无标题笔记"}」？`}
        message="确定要将这篇笔记移入回收站吗？30 天内可在笔记列表恢复，届时关联的学习卡和复习计划将一并归档。超过 30 天后将永久删除。"
        confirmLabel="删除"
        variant="danger"
        loading={deleting}
        onConfirm={async () => {
          setDeleteError(null);
          isDeletingRef.current = true;
          generationRunRef.current += 1;
          if (timer.current) {
            clearTimeout(timer.current);
            timer.current = null;
          }
          setDeleting(true);
          try {
            // 已发出的保存请求必须先收敛，避免 PATCH 与 DELETE 交错。
            await saveChainRef.current;
            await api.deleteNote(noteId);
            if (
              returnHref.startsWith("/search") ||
              returnHref.startsWith("/sources") ||
              returnHref.startsWith("/today")
            ) {
              router.replace(returnHref);
            } else {
              router.push(returnHref);
            }
          } catch (err) {
            isDeletingRef.current = false;
            if (err instanceof ApiError && err.status === 404) {
              // CONC-06: 笔记已被其他用户删除，直接导航返回
              if (
                returnHref.startsWith("/search") ||
                returnHref.startsWith("/sources") ||
                returnHref.startsWith("/today")
              ) {
                router.replace(returnHref);
              } else {
                router.push(returnHref);
              }
              return;
            }
            setDeleteError(
              `删除失败：${err instanceof Error ? err.message : "未知错误"}`,
            );
            if (
              latestDraftRef.current.source !== lastSavedSourceRef.current ||
              titleDirtyRef.current
            ) {
              scheduleSave();
            }
          } finally {
            setDeleting(false);
            setConfirmDelete(false);
          }
        }}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={confirmRestore !== null}
        title={confirmRestore ? `恢复到版本 ${confirmRestore.versionNo}？` : ""}
        message="当前未保存的修改将丢失，编辑器会加载目标版本的内容。"
        confirmLabel="恢复"
        variant="default"
        loading={restoring}
        onConfirm={() => {
          if (!confirmRestore) return;
          void handleRestoreVersion(confirmRestore.versionId);
        }}
        onCancel={() => setConfirmRestore(null)}
      />
    </div>
  );
}
