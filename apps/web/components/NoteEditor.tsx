"use client";

/**
 * ─── QUAL-04 架构说明 ───────────────────────────────────────────────────
 * 本组件超过 4500 行，包含笔记编辑器的全部状态管理和交互逻辑。
 * 推荐拆分策略（按职责提取自定义 hooks 和子组件）：
 *   1. `useNoteAutosave.ts` — 自动保存逻辑（debounce、冲突检测、版本去重）
 *   2. `useCardGenerationPolling.ts` — 卡片生成轮询和状态管理
 *   3. `useImageUpload.ts` — 图片上传队列和 asset 注册
 *   4. `useVersionRestore.ts` — 版本历史恢复逻辑
 *   5. `NoteEditorToolbar.tsx` — 工具栏 UI
 *   6. `NoteEditorSidebar.tsx` — 侧边栏（卡片列表、证据面板）
 *   7. `GenerationStatusBadge.tsx` — 生成状态徽章和进度展示
 *   8. `useGenerationRunStatus.ts` — 生成运行状态映射（见 QUAL-07）
 * 每个自定义 hook 封装独立的 ref/state/effect，通过参数和返回值组合。
 * ──────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useIsOwner } from "@/lib/use-current-user";
import { isAgentActivityStreamEnabled } from "@/lib/feature-flags";
import { Drawer } from "@/components/ui/Drawer";
import {
  hasDuplicateArticleLeadHeading,
} from "@/components/NoteArticlePreview";
import type { MilkdownEditorHandle } from "@/components/MilkdownEditor";
// PERF-04 拆分：类型定义、常量和工具函数提取到独立模块。

import {
  blocksToMarkdown,
  markdownToBlocks,
} from "@/lib/markdown-blocks";
import {
  normalizeNoteTitle,
} from "@/lib/note-title-save";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useModalIsolation } from "@/lib/use-modal-isolation";
import type {
  CardGenerationRunView,
  NoteVersionSummary,
} from "@/lib/api";
import {
  type EditorMode,
  type ViewMode,
  type InspectorView,
  type PreviewOutlineMode,
  type GenerationPhase,
  type GenerationState,
  type GenerationResolutionAction,
  type SavingState,
  type NoteEditorProps,
  LOCAL_DRAFT_MAX_AGE_MS,
  PREVIEW_OUTLINE_PREFERENCE_KEY,
  CARD_GENERATION_RUN_STORAGE_PREFIX,
} from "./note-editor/note-editor-types";
import { useImageUploads } from "./note-editor/useImageUploads";
// PERF-04 拆分（第十三轮）：保存、轮询、冲突解决、导航逻辑提取为自定义 Hook
import { useNoteSave } from "./note-editor/useNoteSave";
import { useGenerationPolling } from "./note-editor/useGenerationPolling";
import { useConflictResolution } from "./note-editor/useConflictResolution";
import { useEditorNavigation } from "./note-editor/useEditorNavigation";
// PERF-04 拆分（第十三轮）：通知横幅 JSX 提取为独立组件
import { NoticeBanners } from "./note-editor/NoticeBanners";
import {
  isActiveGenerationRun,
  generationRunMessage,
  getFailedGenerationUnits,
  generationFailureTitle,
  outlineBlockKey,
  savingStatePresentation,
  computeGenButton,
} from "./note-editor/note-editor-utils";
// PERF-04 拆分（第八轮）：渲染函数提取为独立子组件
import { OutlinePanel } from "./note-editor/OutlinePanel";
// PERF-04 拆分（第九轮）：进一步提取渲染面板和弹窗组件
import { VersionsPanel } from "./note-editor/VersionsPanel";
import { GenerationPanel } from "./note-editor/GenerationPanel";
import { GenerationFailureDialog } from "./note-editor/GenerationFailureDialog";
import { GenerationOverlay } from "./note-editor/GenerationOverlay";
import { GenerationProgressFab } from "./note-editor/GenerationProgressFab";
// PERF-04 拆分（第十一轮）：TopBar、ConflictDialog、ConfirmDialogs 提取为独立组件
import { TopBar } from "./note-editor/TopBar";
import { ConflictDialog } from "./note-editor/ConflictDialog";
import { ConfirmDialogs } from "./note-editor/ConfirmDialogs";
// PERF-04 拆分（第十二轮）：生成动作逻辑提取为自定义 Hook
import { useGenerationActions } from "./note-editor/useGenerationActions";
// PERF-04 拆分（第十四轮）：预览目录侧栏提取为独立组件
import { PreviewOutlineSidebar } from "./note-editor/PreviewOutlineSidebar";
// PERF-04 拆分（第十四轮）：编辑器主体区域提取为独立组件
import { EditorSection } from "./note-editor/EditorSection";
// PERF-04 拆分（第十四轮）：生成展示计算和笔记操作逻辑提取为自定义 Hook
import { useGenerationPresentation } from "./note-editor/useGenerationPresentation";
import { useNoteActions } from "./note-editor/useNoteActions";
// Props 类型别名——保持向后兼容
interface Props extends NoteEditorProps {}

/**
 * Phase B/C：Agent 活动流控制台特性开关。
 * 构建期读取 NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED，fail-closed。
 */
const AGENT_ACTIVITY_STREAM_ENABLED = isAgentActivityStreamEnabled();

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
  // B1（计划 §2.4）：内容未变时复用已有 succeeded run 的标记
  const [generationReused, setGenerationReused] = useState(false);
  const [generationResolutionAction, setGenerationResolutionAction] =
    useState<GenerationResolutionAction>(null);
  const [generationResolutionError, setGenerationResolutionError] = useState<string | null>(null);
  const [confirmGenerationExclusions] = useState(false);
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
  // 版本历史
  const [versions, setVersions] = useState<NoteVersionSummary[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // Generation Run only blocks editing while the latest draft is saved and
  // POST /card-generation-runs is awaiting acceptance. Queued/running work is
  // tied to the immutable source snapshot and must not lock the editor.
  const generationLocked = genState === "generating" && generationPhase === "saving";
  const generationLockedRef = useRef(generationLocked);
  generationLockedRef.current = generationLocked;
  const generationOverlayRef = useRef<HTMLDivElement>(null);
  // Modal blocking only applies during the brief save+accept handshake.
  const generationOverlayActive = isOwner && generationLocked;
  // The progress overlay stays visible for the entire generating state so the
  // user can see real-time progress. After the save phase it becomes
  // non-modal and dismissible; the FAB + gen button reopens it on demand.
  // Phase B/C：flag 开启时弹窗内展示 Agent 活动流；关闭时展示原有
  // 步骤条 + 覆盖率。两种情况下弹窗都在生成中显示、可隐藏。
  const generationOverlayVisible =
    isOwner
    && (genState === "generating" || genState === "checking" || generationReused)
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
  // 2026-08-11：记录上次已应用的 run 状态键，轮询同状态时跳过 setState 与
  // localStorage 写入（见 applyGenerationRun）。
  const generationRequestKeyRef = useRef<{ versionId: string; key: string } | null>(null);
  const generationRestartRequestKeyRef = useRef<{ runId: string; key: string } | null>(null);
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

  const lastAppliedRunKeyRef = useRef<string | null>(null);
  const applyGenerationRun = useCallback((run: CardGenerationRunView) => {
    // 2026-08-11：轮询每 1.5s 触发；run 停在同状态时跳过全部 setState 与
    // localStorage 写入——此前每轮无条件 setGenerationRun 新对象 → NoteEditor
    // 全树重渲染 + active 期间每 1.5s 写内容完全相同的 localStorage。
    const stateKey = `${run.runId}:${run.stage}:${run.stateVersion}:${run.status}:${run.sourceSnapshot.versionNo}`;
    if (lastAppliedRunKeyRef.current === stateKey) return;
    lastAppliedRunKeyRef.current = stateKey;
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
        run.status === "preparing"
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

  // PERF-04 拆分（第十三轮）：生成任务轮询逻辑提取到 useGenerationPolling hook
  const { pollGenerationRun } = useGenerationPolling({
    noteId,
    noteVersionId,
    versionNo,
    generationRunStorageKey,
    initialGenerationStatus,
    mountedRef,
    generationRunRef,
    noteDeletedRef,
    generationRunId,
    generationRunRecoveryResolved,
    setGenState,
    setGenMessage,
    setGenerationRun,
    setGenerationRunId,
    setGenerationVersionNo,
    setGenerationPhase,
    setGeneratedVersionId,
    setSaving,
    setGenerationRunRecoveryResolved,
    applyGenerationRun,
    rememberGenerationRun,
    forgetGenerationRun,
  });

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

  // PERF-04 拆分（第十三轮）：保存逻辑提取到 useNoteSave hook
  const {
    save,
    flushLatestDraft,
    scheduleSave,
    clearSessionTimeout: _clearSessionTimeout,
    resetSessionTimeout: _resetSessionTimeout,
    endSession,
  } = useNoteSave({
    noteId,
    editorRef,
    latestDraftRef,
    latestTitleRef,
    lastSavedSourceRef,
    lastSavedTitleRef,
    lastSavedTitleSourceRef,
    titleDirtyRef,
    titleEditRevisionRef,
    savedVersionIdRef,
    currentVersionNoRef,
    sessionVersionIdRef,
    sessionTimeoutRef,
    saveChainRef,
    mountedRef,
    isOwnerRef,
    restoringRef,
    isDeletingRef,
    noteDeletedRef,
    conflictDataRef,
    generationLockedRef,
    recoveredConflictRef,
    beforeUnloadSaveFiredRef,
    saveInFlightRef,
    timer,
    savedStateTimerRef,
    isOwner,
    setSaving,
    setTitle,
    setIsAutoTitle,
    setCurrentVersionId,
    setCurrentVersionNo,
    setDirty,
    setHasRecoveredConflictDraft,
    setConflictData,
    setSource,
    persistDraftLocally,
    clearPersistedDraft,
  });

  const syncDirty = useCallback(() => {
    setDirty(true);
  }, []);

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

  // PERF-04 拆分（第十轮）：图片上传逻辑委托给 useImageUploads hook。
  // 使用 ref 包装 updateSource 和 isLocked，确保 hook 内部 useCallback 依赖稳定。
  const updateSourceRef = useRef(updateSource);
  updateSourceRef.current = updateSource;
  const isImageUploadLocked = useCallback(() => {
    return (
      generationLockedRef.current ||
      restoringRef.current ||
      isDeletingRef.current ||
      noteDeletedRef.current
    );
  }, []);
  const {
    uploadingCount,
    imageUploads,
    uploadError,
    imageFileInputRef,
    queueImageUpload,
    retryImageUpload,
    cancelImageUpload,
    handleImageFileSelect,
  } = useImageUploads({
    noteId,
    editorRef,
    latestDraftRef,
    mountedRef,
    updateSource: (next: string) => updateSourceRef.current(next),
    isLocked: isImageUploadLocked,
  });

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

  // PERF-04 拆分（第十三轮）：冲突解决逻辑提取到 useConflictResolution hook
  const {
    resolveWithServer,
    discardRecoveredConflictDraft,
    restoreDiscardedDraft,
    resolveWithLocal,
    handleRestoreVersion,
  } = useConflictResolution({
    noteId,
    initialMarkdown,
    initialTitle,
    titleSource,
    editorRef,
    latestDraftRef,
    latestTitleRef,
    lastSavedSourceRef,
    lastSavedTitleRef,
    lastSavedTitleSourceRef,
    titleDirtyRef,
    savedVersionIdRef,
    currentVersionNoRef,
    discardedDraftRef,
    conflictDataRef,
    timer,
    saveChainRef,
    restoringRef,
    noteDeletedRef,
    mountedRef,
    isAutoTitle,
    conflictData,
    setSource,
    setTitle,
    setIsAutoTitle,
    setCurrentVersionId,
    setCurrentVersionNo,
    setDirty,
    setSaving,
    setConflictData,
    setHasRecoveredConflictDraft,
    setHasDiscardedDraft,
    setRestoring,
    setConfirmRestore,
    clearPersistedDraft,
    endSession,
    save,
    scheduleSave,
  });

  // PERF-04 拆分（第十三轮）：导航与大纲逻辑提取到 useEditorNavigation hook
  const {
    jumpToBlock,
    changeMode,
    changeViewMode,
    applyStarterTemplate,
    insertFirstHeading,
  } = useEditorNavigation({
    editorRef,
    editorPaneRef,
    previewRef,
    workbenchRef,
    exitingFullscreenRef,
    source,
    title,
    mode,
    viewMode,
    allOutlineBlocks,
    setMode,
    setViewMode,
    setInspectorOpen,
    updateSource,
  });

  // PERF-04 拆分（第十三轮）：beforeunload 和卸载清理已移至 useNoteSave hook

  // PERF-04 拆分（第十二轮）：5 个生成动作函数提取为 useGenerationActions hook
  const {
    generateCard,
    cancelGenerationRun,
    retryGenerationRun,
    restartGenerationRun,
    forceRegenerate,
  } = useGenerationActions({
    uploadingCount,
    imageUploads,
    generationRunId,
    generationRun,
    generationResolutionAction,
    cancellingGeneration,
    generationReused,
    setGenState,
    setGenMessage,
    setGenerationRun,
    setGenerationRunId,
    setGenerationVersionNo,
    setGenerationPhase,
    setGenerationOverlayDismissed,
    setInspectorOpen,
    setCancellingGeneration,
    setGenerationResolutionAction,
    setGenerationResolutionError,
    setGenerationFailureDialogOpen,
    setGenerationReused,
    latestDraftRef,
    conflictDataRef,
    conflictDialogRef,
    generationRunRef,
    mountedRef,
    generationLockedRef,
    savedVersionIdRef,
    currentVersionNoRef,
    generationRequestKeyRef,
    generationRestartRequestKeyRef,
    moreActionsRef,
    flushLatestDraft,
    rememberGenerationRun,
    pollGenerationRun,
    applyGenerationRun,
    endSession,
  });

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
  // PERF-04 拆分（第十二轮）：genButton IIFE 提取为纯函数 computeGenButton
  const genButton = computeGenButton({
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
    generatedCardHref,
    onShowOverlay: () => setGenerationOverlayDismissed(false),
    onViewCards: () => router.push(generatedCardHref),
    onOpenFailureDialog: () => {
      setGenerationResolutionError(null);
      setGenerationFailureDialogOpen(true);
    },
    onGenerate: generateCard,
  });

  // PERF-04 拆分（第十四轮）：导出和返回操作提取到 useNoteActions hook
  const { handleExport, returnToLibrary } = useNoteActions({
    noteId,
    returnHref,
    title,
    dirty,
    leaving,
    latestDraftRef,
    lastSavedSourceRef,
    titleDirtyRef,
    conflictDataRef,
    conflictDialogRef,
    generationLockedRef,
    noteDeletedRef,
    setLeaving,
    setExporting,
    setExportError,
    flushLatestDraft,
    save,
    persistDraftLocally,
  });

  // PERF-04 拆分（第十四轮）：生成展示计算逻辑提取到 useGenerationPresentation hook
  const {
    visualState: generationVisualState,
    heading: generationHeading,
    pres: genPres,
    outlineOpen: previewOutlineOpen,
    overlayTitle: generationOverlayTitle,
    overlayDescription: generationOverlayDescription,
  } = useGenerationPresentation({
    genState,
    generationPhase,
    generationPartialReady,
    generationNeedsAttention,
    generatedIsCurrent,
    generatedVersionId,
    isOwner,
    conflictData,
    hasWritableContent,
    previewOutlineMode,
    previewOutlinePeeked,
  });

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

  // PERF-04 拆分（第八轮+第九轮）：renderOutlinePanel、renderVersionsPanel、
  // renderGenerationPanel 已提取为独立子组件（OutlinePanel、VersionsPanel、
  // GenerationPanel），生成遮罩和失败弹窗也提取为独立组件（GenerationOverlay、
  // GenerationFailureDialog）。所有调用通过 JSX <Component .../> 替代。

  return (
    <div
      ref={workbenchRef}
      className="note-workbench"
      data-editor-mode={mode}
      data-view-mode={viewMode}
      data-preview-outline-mode={previewOutlineMode}
      data-generation-active={generationOverlayActive ? "true" : undefined}
    >
      <TopBar
        returnLabel={returnLabel}
        leaving={leaving}
        onReturn={returnToLibrary}
        title={title}
        currentVersionNo={currentVersionNo}
        ownerLoading={ownerLoading}
        isOwner={isOwner}
        saving={saving}
        savingPres={savingPres}
        onSave={save}
        generationVisualState={generationVisualState}
        genButton={genButton}
        generationLocked={generationLocked}
        viewMode={viewMode}
        onChangeViewMode={changeViewMode}
        exporting={exporting}
        onExport={handleExport}
        onOpenInspector={() => {
          setInspectorView("overview");
          setInspectorOpen(true);
        }}
        onConfirmDelete={() => setConfirmDelete(true)}
        moreActionsRef={moreActionsRef}
      />

      {/* PERF-04 拆分（第十三轮）：通知横幅提取为 NoticeBanners 组件 */}
      <NoticeBanners
        exportError={exportError}
        deleteError={deleteError}
        saving={saving}
        genMessage={genMessage}
        genState={genState}
        onDismissExportError={() => setExportError(null)}
        onDismissDeleteError={() => setDeleteError(null)}
        onRetrySave={() => void flushLatestDraft()}
        onReturnToList={() => {
          if (
            returnHref.startsWith("/search") ||
            returnHref.startsWith("/sources") ||
            returnHref.startsWith("/today")
          ) {
            router.replace(returnHref);
          } else {
            router.push(returnHref);
          }
        }}
        onDismissGenMessage={() => setGenMessage(null)}
      />

      {/* ── 主内容：文档工具 + 写作区 ── */}
      <div className="ne-layout">
        {mode === "preview" ? (
          <PreviewOutlineSidebar
            outlineOpen={previewOutlineOpen}
            outlineMode={previewOutlineMode}
            outlineBlocks={previewOutlineBlocks}
            activeOutlineKey={activeOutlineKey}
            isOwner={isOwner}
            triggerRef={previewOutlineTriggerRef}
            workbenchRef={workbenchRef}
            onModeChange={setStoredPreviewOutlineMode}
            onClose={closePreviewOutline}
            onPeekChange={setPreviewOutlinePeeked}
            onItemClick={(block, blockKey) => {
              setActiveOutlineKey(blockKey);
              jumpToBlock(block);
            }}
            onInsertFirstHeading={insertFirstHeading}
          />
        ) : mode === "edit" ? (
          <aside className="ne-sidebar">
            <OutlinePanel
              panelBlocks={outlineBlocks}
              previewDock={false}
              fromDrawer={false}
              previewOutlineMode={previewOutlineMode}
              activeOutlineKey={activeOutlineKey}
              isOwner={isOwner}
              onModeChange={setStoredPreviewOutlineMode}
              onClose={closePreviewOutline}
              onItemClick={(block, blockKey) => {
                setActiveOutlineKey(blockKey);
                jumpToBlock(block);
              }}
              onInsertFirstHeading={insertFirstHeading}
            />
            <VersionsPanel
              versions={versions}
              versionsError={versionsError}
              noteId={noteId}
              currentVersionNo={currentVersionNo}
              compact
              isOwner={isOwner}
              restoring={restoring}
              onVersionsChange={setVersions}
              onVersionsErrorChange={setVersionsError}
              onConfirmRestore={(v: { versionId: string; versionNo: number }) => setConfirmRestore(v)}
              onViewAll={() => {
                setInspectorView("versions");
                setInspectorOpen(true);
              }}
            />
          </aside>
        ) : null}

        {/* 中央：编辑纸面 */}
        {/* PERF-04 拆分（第十四轮）：编辑器主体提取为 EditorSection 组件 */}
        <EditorSection
          title={title}
          isAutoTitle={isAutoTitle}
          mode={mode}
          isOwner={isOwner}
          ownerLoading={ownerLoading}
          leaving={leaving}
          deleting={deleting}
          restoring={restoring}
          generationLocked={generationLocked}
          saving={saving}
          source={source}
          initialMarkdown={initialMarkdown}
          wordCount={wordCount}
          previewBlocksCount={previewBlocks.length}
          blockDelta={blockDelta}
          currentVersionNo={currentVersionNo}
          versions={versions}
          hasRecoveredConflictDraft={hasRecoveredConflictDraft}
          hasDiscardedDraft={hasDiscardedDraft}
          savingPres={savingPres}
          generationHeading={generationHeading}
          generationVisualState={generationVisualState}
          genButton={genButton}
          imageUploads={imageUploads}
          uploadingCount={uploadingCount}
          failedImageUploadCount={failedImageUploadCount}
          uploadError={uploadError}
          editorRef={editorRef}
          editorPaneRef={editorPaneRef}
          previewRef={previewRef}
          imageFileInputRef={imageFileInputRef}
          onTitleChange={updateTitle}
          onModeChange={changeMode}
          onSourceChange={updateSource}
          onSetMarkdown={setMilkdownEditorHandle}
          onImagePaste={queueImageUpload}
          onRetryImageUpload={retryImageUpload}
          onCancelImageUpload={cancelImageUpload}
          onFileSelect={handleImageFileSelect}
          onDiscardRecoveredConflictDraft={discardRecoveredConflictDraft}
          onRestoreDiscardedDraft={restoreDiscardedDraft}
          onApplyStarterTemplate={applyStarterTemplate}
          onOpenVersions={() => {
            setInspectorView("versions");
            setInspectorOpen(true);
          }}
        />

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
            <VersionsPanel
              versions={versions}
              versionsError={versionsError}
              noteId={noteId}
              currentVersionNo={currentVersionNo}
              compact={false}
              isOwner={isOwner}
              restoring={restoring}
              onVersionsChange={setVersions}
              onVersionsErrorChange={setVersionsError}
              onConfirmRestore={(v: { versionId: string; versionNo: number }) => setConfirmRestore(v)}
              onViewAll={() => {}}
            />
          ) : (
            <>
              <OutlinePanel
                panelBlocks={outlineBlocks}
                previewDock={false}
                fromDrawer
                previewOutlineMode={previewOutlineMode}
                activeOutlineKey={activeOutlineKey}
                isOwner={isOwner}
                onModeChange={setStoredPreviewOutlineMode}
                onClose={closePreviewOutline}
                onItemClick={(block, blockKey) => {
                  setActiveOutlineKey(blockKey);
                  setInspectorOpen(false);
                  requestAnimationFrame(() => requestAnimationFrame(() => jumpToBlock(block)));
                }}
                onInsertFirstHeading={insertFirstHeading}
              />
              <GenerationPanel
                visualState={generationVisualState}
                heading={generationHeading}
                pres={genPres}
                button={genButton}
                isOwner={isOwner}
                currentVersionNo={currentVersionNo}
                generationVersionNo={generationVersionNo}
                generatedVersionId={generatedVersionId}
                genState={genState}
                genMessage={genMessage}
                failureHeading={generationFailureHeading}
                hasConflict={!!conflictData}
                hasWritableContent={hasWritableContent}
                generatedIsCurrent={generatedIsCurrent}
                hasGeneratedResult={hasGeneratedResult}
                generatedCardHref={generatedCardHref}
                generationRun={generationRun}
                generationPartialReady={generationPartialReady}
                generationNeedsAttention={generationNeedsAttention}
                generationResolutionAction={generationResolutionAction}
                failedGenerationUnits={failedGenerationUnits}
                cancellingGeneration={cancellingGeneration}
                generationLocked={generationLocked}
                onOpenFailureDialog={() => {
                  setGenerationResolutionError(null);
                  setGenerationFailureDialogOpen(true);
                }}
                onCancelGeneration={() => void cancelGenerationRun()}
                onOpenActivity={AGENT_ACTIVITY_STREAM_ENABLED
                  ? () => setGenerationOverlayDismissed(false)
                  : undefined}
              />
            </>
          )}
        </div>
      </Drawer>

      {generationOverlayVisible && (
        <GenerationOverlay
          ref={generationOverlayRef}
          active={generationOverlayActive}
          phase={generationPhase}
          title={generationOverlayTitle}
          description={generationOverlayDescription}
          run={generationRun}
          message={genMessage}
          onDismiss={() => setGenerationOverlayDismissed(true)}
          reused={generationReused}
          onForceRegenerate={forceRegenerate}
          activityEnabled={AGENT_ACTIVITY_STREAM_ENABLED}
          onCancel={() => void cancelGenerationRun()}
          cancelling={cancellingGeneration}
          onTransientError={setGenMessage}
        />
      )}

      {/* Phase B/C：弹窗被隐藏后，右下角悬浮按钮可重新打开进度弹窗 */}
      <GenerationProgressFab
        show={AGENT_ACTIVITY_STREAM_ENABLED && !!generationRun && generationOverlayDismissed}
        onOpen={() => setGenerationOverlayDismissed(false)}
        stageLabel={generationOverlayTitle}
      />

      {/* F-007: 冲突解决对话框 */}
      <ConflictDialog
        active={conflictDialogActive}
        conflictData={conflictData}
        dialogRef={conflictDialogRef}
        localTitle={latestTitleRef.current}
        localSource={latestDraftRef.current.source}
        onResolveWithServer={resolveWithServer}
        onResolveWithLocal={() => void resolveWithLocal()}
      />

      {/* 失败素材处理弹窗:needs_attention 的处理入口。列出全部失败检查点
          (图片 + 文本分片)与对应原因,动作在此完成,不再依赖抽屉。 */}
      {generationFailureDialogOpen && isOwner && generationRun && generationNeedsAttention
        && !conflictData && (
        <GenerationFailureDialog
          ref={generationFailureDialogRef}
          active={generationFailureDialogActive}
          generationRun={generationRun}
          failedGenerationUnits={failedGenerationUnits}
          failedGenerationImages={failedGenerationImages}
          failureHeading={generationFailureHeading}
          currentVersionNo={currentVersionNo}
          generationVersionNo={generationVersionNo}
          resolutionError={generationResolutionError}
          resolutionAction={generationResolutionAction}
          onClose={() => setGenerationFailureDialogOpen(false)}
          onRetry={() => void retryGenerationRun()}
          onRestart={() => void restartGenerationRun()}
        />
      )}

      {/* PERF-04 拆分（第十一轮）：三个 ConfirmDialog 提取为 ConfirmDialogs 组件 */}
      <ConfirmDialogs
        confirmDelete={confirmDelete}
        deleting={deleting}
        title={title}
        returnHref={returnHref}
        onConfirmDelete={async () => {
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
        onCancelDelete={() => setConfirmDelete(false)}
        confirmRestore={confirmRestore}
        restoring={restoring}
        onConfirmRestore={() => {
          if (!confirmRestore) return;
          void handleRestoreVersion(confirmRestore.versionId);
        }}
        onCancelRestore={() => setConfirmRestore(null)}
      />
    </div>
  );
}
