"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, API_URL, getCsrfToken } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { blocksToMarkdown, markdownToBlocks } from "@/lib/markdown-blocks";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useModalIsolation } from "@/lib/use-modal-isolation";
import { relativeTime } from "@/lib/format";
import { statusMap } from "@/lib/status-map";
import type { StatusTone } from "@/lib/status-map";
import { StatusChip } from "@/components/ui/StatusChip";
import type { Block, CardGenerationStatus, NoteVersionSummary } from "@/lib/api";

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

type EditorMode = "edit" | "preview" | "split";

type SavingState = "idle" | "saving" | "saved" | "error" | "conflict";

const LOCAL_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function stripMarkdownTitle(content: string): string {
  const htmlHeading = /^<h\d>([\s\S]+)<\/h\d>$/.exec(content.trim());
  if (htmlHeading) return htmlHeading[1];
  return content
    .replace(/^#{1,4}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^·\s*/, "")
    .slice(0, 34);
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
  if (dirty) return { label: "未保存", tone: "warning" };
  return { label: "已保存", tone: "success" };
}

/**
 * 笔记编辑器。
 *
 * 编辑器交互约束：
 * - 三栏：大纲/版本 | 编辑纸面 | 生成学习卡
 * - TopBar：返回链接 + 标题 + 版本号 + 操作按钮
 * - 中央编辑纸面使用 shadow-paper；两侧 Control Surface
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
  const router = useRouter();
  const initialMarkdown = useMemo(() => {
    if (initialBlocks.length === 0) return "";
    return blocksToMarkdown(initialBlocks);
  }, [initialBlocks]);

  const [title, setTitle] = useState(initialTitle);
  const [source, setSource] = useState(initialMarkdown);
  const [mode, setMode] = useState<EditorMode>("edit");
  const [saving, setSaving] = useState<SavingState>("idle");
  const [genState, setGenState] = useState<"idle" | "generating" | "generated">(
    initialGenerationStatus.state === "idle" ? "idle" : initialGenerationStatus.state,
  );
  const [genMessage, setGenMessage] = useState<string | null>(
    initialGenerationStatus.state === "generating"
      ? `正在基于 v${versionNo} 提炼学习卡…`
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
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [compactDrawer, setCompactDrawer] = useState(false);
  const [splitUnavailable, setSplitUnavailable] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [hasRecoveredConflictDraft, setHasRecoveredConflictDraft] = useState(false);
  // R-008: 是否有被丢弃的草稿可恢复
  const [hasDiscardedDraft, setHasDiscardedDraft] = useState(false);
  // F-007: 冲突状态
  const [conflictData, setConflictData] = useState<{ serverTitle: string; serverSource: string; serverVersionNo: number } | null>(null);

  // 版本历史
  const [versions, setVersions] = useState<NoteVersionSummary[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // F-029: 冲突对话框 ref + 焦点陷阱
  const conflictDialogRef = useRef<HTMLDivElement>(null);
  useModalIsolation(conflictDialogRef, !!conflictData);
  useFocusTrap(conflictDialogRef, !!conflictData);
  useBodyScrollLock(!!conflictData);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaSelectionRef = useRef({ start: 0, end: 0 });
  const moreActionsRef = useRef<HTMLDetailsElement | null>(null);
  const savedVersionIdRef = useRef(noteVersionId);
  const currentVersionNoRef = useRef(versionNo);
  const conflictDataRef = useRef(conflictData);
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const isDeletingRef = useRef(false);
  const recoveredConflictRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRunRef = useRef(0);
  const initialBlockCountRef = useRef(initialBlocks.length);
  const conflictDraftStorageKey = useMemo(
    () => `note-editor-conflict-draft:${draftScope}:${noteId}`,
    [draftScope, noteId],
  );
  const persistDraftLocally = useCallback((draftSource: string) => {
    try {
      window.localStorage.setItem(
        conflictDraftStorageKey,
        JSON.stringify({ source: draftSource, updatedAt: Date.now() }),
      );
    } catch {
      // 私密模式、存储配额不足等场景下继续依赖服务器自动保存。
    }
  }, [conflictDraftStorageKey]);
  const clearPersistedDraft = useCallback((expectedSource: string) => {
    try {
      const raw = window.localStorage.getItem(conflictDraftStorageKey);
      if (!raw) return;
      const stored = JSON.parse(raw) as { source?: unknown };
      // 同一笔记可能在多个标签页中打开；只清理当前标签页刚刚保存或
      // 放弃的那份源码，不能误删另一标签页写入的不同草稿。
      if (stored.source === expectedSource) {
        window.localStorage.removeItem(conflictDraftStorageKey);
      }
    } catch {
      // 损坏的记录交给下次恢复流程清理。
    }
  }, [conflictDraftStorageKey]);
  const latestDraftRef = useRef({
    source: initialMarkdown,
  });
  // R-008: 追踪最后成功保存的源码
  const lastSavedSourceRef = useRef(initialMarkdown);
  // R-008: 丢弃本地草稿前的备份
  const discardedDraftRef = useRef<string | null>(null);

  const previewBlocks = useMemo(() => markdownToBlocks(source), [source]);
  const blockDelta = previewBlocks.length - initialBlockCountRef.current;
  const wordCount = source.replace(/\s/g, "").length;
  const allOutlineBlocks = useMemo(
    () => previewBlocks.filter((block) => block.type === "heading"),
    [previewBlocks],
  );
  const outlineBlocks = useMemo(() => allOutlineBlocks.slice(0, 10), [allOutlineBlocks]);

  const savingPres = savingStatePresentation(saving, dirty);

  const pollGenerationJob = useCallback(async (
    jobId: string,
    versionId: string,
    versionAtGeneration: number,
    runId: number,
  ) => {
    for (let index = 0; index < 40; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (runId !== generationRunRef.current || !mountedRef.current) return;
      const job = await api.getJob(jobId);
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
    }
    if (runId !== generationRunRef.current || !mountedRef.current) return;
    setGenState("idle");
    setGenMessage("等待超时，可去「学习卡」页查看是否生成成功。");
  }, []);

  useEffect(() => {
    if (initialGenerationStatus.state !== "generating" || !initialGenerationStatus.jobId) return;
    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
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
  }, [initialGenerationStatus, noteVersionId, pollGenerationJob, versionNo]);

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
      const recovered = JSON.parse(raw) as { source?: unknown; updatedAt?: unknown };
      const updatedAt = typeof recovered.updatedAt === "number" ? recovered.updatedAt : 0;
      if (
        typeof recovered.source !== "string" ||
        recovered.source === initialMarkdown ||
        Date.now() - updatedAt > LOCAL_DRAFT_MAX_AGE_MS
      ) {
        window.localStorage.removeItem(conflictDraftStorageKey);
        return;
      }
      latestDraftRef.current = { source: recovered.source };
      recoveredConflictRef.current = true;
      setSource(recovered.source);
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
  }, [conflictDraftStorageKey, initialMarkdown]);

  useEffect(() => {
    conflictDataRef.current = conflictData;
  }, [conflictData]);

  useEffect(() => {
    const compactMedia = window.matchMedia("(max-width: 639px)");
    const splitMedia = window.matchMedia("(max-width: 1099px)");
    const sync = () => {
      setCompactDrawer(compactMedia.matches);
      setSplitUnavailable(splitMedia.matches);
    };
    sync();
    compactMedia.addEventListener("change", sync);
    splitMedia.addEventListener("change", sync);
    return () => {
      compactMedia.removeEventListener("change", sync);
      splitMedia.removeEventListener("change", sync);
    };
  }, []);

  useEffect(() => {
    if (splitUnavailable && mode === "split") setMode("edit");
  }, [splitUnavailable, mode]);

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

  const syncDirty = useCallback(() => {
    setDirty(true);
  }, []);

  const save = useCallback((isAutosave = true): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const operation = saveChainRef.current.then(async () => {
      if (conflictDataRef.current || isDeletingRef.current) return false;

      const draftSource = latestDraftRef.current.source;
      if (draftSource === lastSavedSourceRef.current) {
        clearPersistedDraft(draftSource);
        if (mountedRef.current) {
          setCurrentVersionId(savedVersionIdRef.current);
          setCurrentVersionNo(currentVersionNoRef.current);
          setDirty(false);
          setHasRecoveredConflictDraft(false);
          recoveredConflictRef.current = false;
          if (!isAutosave) setSaving("saved");
        }
        return true;
      }

      if (savedStateTimerRef.current) {
        clearTimeout(savedStateTimerRef.current);
        savedStateTimerRef.current = null;
      }
      if (mountedRef.current) setSaving("saving");

      try {
        const blocks = markdownToBlocks(draftSource);
        const updated = await api.updateNote(noteId, {
          blocks,
          baseVersionId: savedVersionIdRef.current ?? undefined,
          isAutosave,
        });
        savedVersionIdRef.current = updated.version.id;
        currentVersionNoRef.current = updated.version.versionNo;
        lastSavedSourceRef.current = draftSource;
        const isLatestDraft = latestDraftRef.current.source === draftSource;
        if (isLatestDraft) {
          clearPersistedDraft(draftSource);
        }

        if (mountedRef.current) {
          setTitle(updated.note.title);
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
        if (err instanceof ApiError && err.status === 409) {
          try {
            const fresh = await api.getNote(noteId);
            savedVersionIdRef.current = fresh.version.id;
            currentVersionNoRef.current = fresh.version.versionNo;
            const freshMarkdown = fresh.blocks.length > 0 ? blocksToMarkdown(fresh.blocks) : "";
            const nextConflict = {
              serverTitle: fresh.note.title,
              serverSource: freshMarkdown,
              serverVersionNo: fresh.version.versionNo,
            };
            persistDraftLocally(draftSource);
            conflictDataRef.current = nextConflict;
            if (mountedRef.current) {
              setCurrentVersionId(fresh.version.id);
              setConflictData(nextConflict);
              setSaving("conflict");
            }
          } catch {
            if (mountedRef.current) setSaving("error");
          }
        } else if (mountedRef.current) {
          setSaving("error");
        }
        return false;
      }
    });
    saveChainRef.current = operation;
    return operation;
  }, [clearPersistedDraft, noteId, persistDraftLocally]);

  const flushLatestDraft = useCallback(async () => {
    // 保存期间仍可能产生新输入；只有当前源码与最后成功版本一致才算真正 flush 完成。
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const saved = await save(false);
      if (!saved) return false;
      if (latestDraftRef.current.source === lastSavedSourceRef.current) return true;
    }
    return false;
  }, [save]);

  function scheduleSave() {
    if (conflictDataRef.current || isDeletingRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(true), 800);
  }

  function updateSource(next: string) {
    if (leaving || deleting) return;
    recoveredConflictRef.current = false;
    latestDraftRef.current = { ...latestDraftRef.current, source: next };
    setSource(next);
    syncDirty();
    scheduleSave();
  }

  // F-007: 冲突解决 — 采用服务端版本
  function resolveWithServer() {
    if (!conflictData) return;
    const discardedSource = latestDraftRef.current.source;
    discardedDraftRef.current = discardedSource;
    setHasDiscardedDraft(true);
    setSource(conflictData.serverSource);
    latestDraftRef.current = { ...latestDraftRef.current, source: conflictData.serverSource };
    lastSavedSourceRef.current = conflictData.serverSource;
    setTitle(conflictData.serverTitle);
    setCurrentVersionNo(conflictData.serverVersionNo);
    currentVersionNoRef.current = conflictData.serverVersionNo;
    conflictDataRef.current = null;
    setConflictData(null);
    setDirty(false);
    setSaving("idle");
    setHasRecoveredConflictDraft(false);
    recoveredConflictRef.current = false;
    clearPersistedDraft(discardedSource);
  }

  function discardRecoveredConflictDraft() {
    const recoveredSource = latestDraftRef.current.source;
    latestDraftRef.current = { source: initialMarkdown };
    setSource(initialMarkdown);
    setDirty(false);
    setSaving("idle");
    setHasRecoveredConflictDraft(false);
    recoveredConflictRef.current = false;
    clearPersistedDraft(recoveredSource);
  }

  // R-008: 恢复被丢弃的本地草稿
  function restoreDiscardedDraft() {
    if (!discardedDraftRef.current) return;
    setSource(discardedDraftRef.current);
    latestDraftRef.current = { ...latestDraftRef.current, source: discardedDraftRef.current };
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
    conflictDataRef.current = null;
    setConflictData(null);
    setSaving("idle");
    await save(false);
  }

  function jumpToBlock(block: Block) {
    const textarea = textareaRef.current;
    if (!textarea) {
      setMode("edit");
      requestAnimationFrame(() => jumpToBlock(block));
      return;
    }
    const raw = block.content.trim();
    const fallback = stripMarkdownTitle(raw);
    const rawIndex = raw ? source.indexOf(raw) : -1;
    const fallbackIndex = fallback ? source.indexOf(fallback) : -1;
    const start = rawIndex >= 0 ? rawIndex : Math.max(0, fallbackIndex);
    const length = rawIndex >= 0 ? raw.length : fallback.length;
    textarea.focus();
    textarea.setSelectionRange(start, start + length);
  }

  function applyWrap(prefix: string, suffix = prefix, placeholder = "text") {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { selectionStart, selectionEnd, value } = textarea;
    const selected = value.slice(selectionStart, selectionEnd);
    const selectedHasWrap =
      selected.length >= prefix.length + suffix.length &&
      selected.startsWith(prefix) &&
      selected.endsWith(suffix);
    const surroundedByWrap =
      value.slice(Math.max(0, selectionStart - prefix.length), selectionStart) === prefix &&
      value.slice(selectionEnd, selectionEnd + suffix.length) === suffix;

    if (selectedHasWrap) {
      const inner = selected.slice(prefix.length, selected.length - suffix.length);
      const next = value.slice(0, selectionStart) + inner + value.slice(selectionEnd);
      updateSource(next);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(selectionStart, selectionStart + inner.length);
      });
      return;
    }

    if (surroundedByWrap) {
      const start = selectionStart - prefix.length;
      const next = value.slice(0, start) + selected + value.slice(selectionEnd + suffix.length);
      updateSource(next);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(start, start + selected.length);
      });
      return;
    }

    const inner = selected || placeholder;
    const next = value.slice(0, selectionStart) + prefix + inner + suffix + value.slice(selectionEnd);
    updateSource(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(selectionStart + prefix.length, selectionStart + prefix.length + inner.length);
    });
  }

  function applyLinePrefix(prefix: string, familyPattern?: RegExp) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { selectionStart, selectionEnd, value } = textarea;
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    const nextLine = value.indexOf("\n", selectionEnd);
    const lineEnd = nextLine === -1 ? value.length : nextLine;
    const block = value.slice(lineStart, lineEnd);
    const replaced = block
      .split("\n")
      .map((line) => {
        const indent = line.match(/^\s*/)?.[0] ?? "";
        const content = line.slice(indent.length);
        const existing = familyPattern?.exec(content)?.[0];
        if (existing) {
          return existing === prefix
            ? `${indent}${content.slice(existing.length)}`
            : `${indent}${prefix}${content.slice(existing.length)}`;
        }
        return content.startsWith(prefix)
          ? `${indent}${content.slice(prefix.length)}`
          : `${indent}${prefix}${content}`;
      })
      .join("\n");
    updateSource(value.slice(0, lineStart) + replaced + value.slice(lineEnd));
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(lineStart, lineStart + replaced.length);
    });
  }

  function insertAtCursor(text: string) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { selectionStart, selectionEnd, value } = textarea;
    const next = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    updateSource(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(selectionStart + text.length, selectionStart + text.length);
    });
  }

  function changeMode(nextMode: EditorMode) {
    const textarea = textareaRef.current;
    if (textarea) {
      textareaSelectionRef.current = {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      };
    }
    setMode(nextMode);
    if (nextMode === "preview") return;
    requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) return;
      const { start, end } = textareaSelectionRef.current;
      nextTextarea.focus();
      nextTextarea.setSelectionRange(
        Math.min(start, nextTextarea.value.length),
        Math.min(end, nextTextarea.value.length),
      );
    });
  }

  function applyStarterTemplate(template: string) {
    updateSource(template);
    changeMode("edit");
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }

  function insertFirstHeading(fromDrawer = false) {
    if (fromDrawer) setInspectorOpen(false);
    changeMode("edit");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        insertAtCursor(source.trim() ? "\n\n# 新标题\n" : "# 新标题\n\n");
      });
    });
  }

  function onEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    if (e.key === "b") {
      e.preventDefault();
      applyWrap("**", "**", "加粗");
    } else if (e.key === "i") {
      e.preventDefault();
      applyWrap("*", "*", "斜体");
    } else if (e.key === "k") {
      e.preventDefault();
      applyWrap("[", "](https://)", "text");
    } else if (e.key === "/") {
      e.preventDefault();
      applyLinePrefix("# ", /^#{1,6}\s+/);
    } else if (e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save(false);
    }
  }

  // R-008: beforeunload
  useEffect(() => {
    const onBeforeUnload = () => {
      if (
        !isDeletingRef.current &&
        !conflictDataRef.current &&
        !recoveredConflictRef.current &&
        latestDraftRef.current.source !== lastSavedSourceRef.current
      ) {
        const draft = latestDraftRef.current;
        // keepalive 受请求体大小和浏览器生命周期限制，本地副本是最后一道保护。
        persistDraftLocally(draft.source);
        const blocks = markdownToBlocks(draft.source);
        const csrfToken = getCsrfToken();
        try {
          fetch(`${API_URL}/notes/${noteId}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
            },
            body: JSON.stringify({
              blocks: blocks.map((b) => ({ type: b.type, content: b.content })),
              baseVersionId: savedVersionIdRef.current ?? undefined,
              isAutosave: true,
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
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (
        !isDeletingRef.current &&
        !recoveredConflictRef.current &&
        latestDraftRef.current.source !== lastSavedSourceRef.current
      ) {
        persistDraftLocally(latestDraftRef.current.source);
        void saveRef.current(true);
      }
      if (savedStateTimerRef.current) clearTimeout(savedStateTimerRef.current);
      generationRunRef.current += 1;
      mountedRef.current = false;
    };
  }, [persistDraftLocally]);

  async function generateCard() {
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
    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
    setGenState("generating");
    setGenMessage(null);
    const saved = await flushLatestDraft();
    if (runId !== generationRunRef.current || !mountedRef.current) return;
    if (!saved) {
      setGenState("idle");
      setGenMessage("当前内容尚未保存，暂时无法生成学习卡。");
      return;
    }

    try {
      const versionId = savedVersionIdRef.current;
      const versionAtGeneration = currentVersionNoRef.current;
      if (!versionId) {
        setGenState("idle");
        setGenMessage("尚未保存任何版本，无法生成学习卡。");
        return;
      }
      setGenerationVersionNo(versionAtGeneration);
      const generation = await api.generateCard(versionId);
      if (runId !== generationRunRef.current || !mountedRef.current) return;
      if (generation.state === "generated") {
        setGenState("generated");
        setGeneratedVersionId(versionId);
        setGenMessage(`v${versionAtGeneration} 已有学习卡，无需重复生成。`);
        return;
      }
      if (!generation.jobId) {
        setGenState("idle");
        setGenMessage("生成任务状态异常，请刷新后重试。");
        return;
      }
      setGenMessage(`正在基于 v${versionAtGeneration} 提炼学习卡…`);
      await pollGenerationJob(
        generation.jobId,
        versionId,
        versionAtGeneration,
        runId,
      );
    } catch (err) {
      if (runId !== generationRunRef.current || !mountedRef.current) return;
      setGenState("idle");
      setGenMessage(err instanceof Error ? err.message : "请求失败");
    }
  }

  const generatedIsCurrent = generatedVersionId === currentVersionId && !dirty;
  const hasWritableContent = source.trim().length > 0;
  const generationBlocked = Boolean(conflictData) || deleting || leaving;
  const genButton = (() => {
    if (genState === "generating") {
      return { label: "生成中…", disabled: true, onClick: () => {} };
    }
    if (generatedIsCurrent) {
      return {
        label: "前往学习卡库",
        disabled: false,
        onClick: () => router.push("/cards"),
      };
    }
    if (!hasWritableContent) {
      if (generatedVersionId) {
        return {
          label: "查看已有学习卡",
          disabled: false,
          onClick: () => router.push("/cards"),
        };
      }
      return { label: "先写下内容", disabled: true, onClick: () => {} };
    }
    if (generationBlocked) {
      return { label: conflictData ? "先解决冲突" : "暂不可生成", disabled: true, onClick: () => {} };
    }
    if (generatedVersionId) {
      return { label: "生成新版学习卡", disabled: false, onClick: generateCard };
    }
    return { label: "生成学习卡", disabled: false, onClick: generateCard };
  })();

  async function handleExport() {
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
    if (latestDraftRef.current.source !== lastSavedSourceRef.current) {
      persistDraftLocally(latestDraftRef.current.source);
      void save(false);
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

  const generationVisualState: "idle" | "generating" | "success" | "stale" =
    genState === "generating"
      ? "generating"
      : generatedIsCurrent
        ? "success"
        : generatedVersionId
          ? "stale"
          : "idle";
  const genPres: { label: string; tone: StatusTone } =
    genState === "generating"
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

  const compactGenLabel =
    genState === "generating"
      ? "生成中…"
      : generatedIsCurrent
        ? "查看卡片"
        : conflictData
          ? "解决冲突"
          : !hasWritableContent
            ? generatedVersionId ? "查看卡片" : "先写内容"
            : generatedVersionId
              ? "生成新卡"
              : "生成卡片";

  function renderOutlinePanel(fromDrawer = false) {
    return (
      <section className="note-editor-panel note-editor-outline-panel">
        <header className="note-editor-panel-header">
          <div>
            <span className="note-editor-panel-kicker">DOCUMENT MAP</span>
            <h2>文档大纲</h2>
          </div>
          <span className="note-editor-panel-count">{allOutlineBlocks.length}</span>
        </header>
        <div className="note-editor-panel-body">
          {outlineBlocks.length > 0 ? (
            <ol className="note-editor-outline-list">
              {outlineBlocks.map((block, index) => (
                <li key={`${block.ordinal}-${block.content}`}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!fromDrawer) {
                        jumpToBlock(block);
                        return;
                      }
                      setInspectorOpen(false);
                      setMode("edit");
                      requestAnimationFrame(() => requestAnimationFrame(() => jumpToBlock(block)));
                    }}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{stripMarkdownTitle(block.content) || "未命名标题"}</strong>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="note-editor-panel-empty">
              <Icon.Notepad aria-hidden="true" />
              <strong>还没有标题结构</strong>
              <p>使用 <code># 标题</code> 建立可跳转的大纲。</p>
              <button type="button" onClick={() => insertFirstHeading(fromDrawer)}>
                插入第一个标题
              </button>
            </div>
          )}
          {allOutlineBlocks.length > outlineBlocks.length && (
            <p className="note-editor-panel-remainder">
              还有 {allOutlineBlocks.length - outlineBlocks.length} 个标题未在此处展开
            </p>
          )}
        </div>
      </section>
    );
  }

  function renderVersionsPanel() {
    return (
      <section className="note-editor-panel note-editor-versions-panel">
        <header className="note-editor-panel-header">
          <div>
            <span className="note-editor-panel-kicker">VERSION TRAIL</span>
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
            <div className="note-editor-version-skeleton" role="status">
              正在读取保存记录…
            </div>
          )}
          {versions && versions.length === 0 && (
            <div className="note-editor-panel-empty note-editor-panel-empty--compact">
              <strong>还没有保存记录</strong>
              <p>完成第一次保存后，版本会显示在这里。</p>
            </div>
          )}
          {versions && versions.length > 0 && (
            <ol className="note-editor-version-list">
              {versions.slice(0, 8).map((version) => (
                <li
                  key={version.id}
                  className={
                    version.versionNo === currentVersionNo ? "is-current" : ""
                  }
                >
                  <span className="note-editor-version-mark" aria-hidden="true" />
                  <div>
                    <strong>版本 {version.versionNo}</strong>
                    <time
                      dateTime={version.createdAt}
                      title={new Date(version.createdAt).toLocaleString()}
                    >
                      {relativeTime(version.createdAt)}
                    </time>
                  </div>
                  {version.versionNo === currentVersionNo && <small>当前</small>}
                </li>
              ))}
            </ol>
          )}
          {versions && versions.length > 8 && (
            <p className="note-editor-panel-remainder">
              还有 {versions.length - 8} 个较早版本未在此处展开
            </p>
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
              {generationVisualState === "success"
                ? "OUTPUT READY"
                : generationVisualState === "stale"
                  ? "UPDATE AVAILABLE"
                  : "LEARNING OUTPUT"}
            </span>
            <h2>
              {generationVisualState === "success"
                ? "学习卡已就绪"
                : generationVisualState === "stale"
                  ? "更新学习卡"
                  : "生成学习卡"}
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
                : generationVisualState === "generating"
                  ? <Icon.Refresh />
                  : <Icon.Sparkle />}
            </div>
            <div>
              <strong>
                {generationVisualState === "success"
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
                {generationVisualState === "success"
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
            {genState === "generating" && generationVersionNo
              ? genMessage ?? `正在基于 v${generationVersionNo} 提炼关键理解。当前继续编辑不会改变本次任务。`
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
              : <Icon.Sparkle aria-hidden="true" />}
            <span>{genButton.label}</span>
            {!genButton.disabled && <Icon.Arrow aria-hidden="true" />}
          </button>
          <p className="note-editor-generation-footnote">
            {generationVisualState === "success"
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
    <div className="note-workbench" data-editor-mode={mode}>
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
            <span>NOTE DRAFT</span>
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
            <StatusChip tone={savingPres.tone} size="sm" dot>
              {savingPres.label} · v{currentVersionNo}
            </StatusChip>
          </div>

          <button
            type="button"
            className="ne-btn ne-btn--secondary ne-inspector-trigger"
            onClick={() => setInspectorOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={inspectorOpen}
            aria-controls="note-editor-inspector"
            aria-label="打开大纲与版本"
          >
            <Icon.Notepad className="ne-btn-icon" aria-hidden="true" />
            <span>大纲与版本</span>
          </button>

          <ThemeToggle className="ne-theme-toggle" />

          <button
            type="button"
            className="ne-btn ne-btn--secondary ne-header-save"
            onClick={() => void save(false)}
            disabled={saving === "saving"}
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
            disabled={genButton.disabled}
            aria-busy={genState === "generating"}
          >
            {generationVisualState === "success"
              ? <Icon.Check className="ne-btn-icon" aria-hidden="true" />
              : <Icon.Sparkle className="ne-btn-icon" aria-hidden="true" />}
            {genButton.label}
          </button>

          <details ref={moreActionsRef} className="ne-more-actions">
            <summary aria-label="更多笔记操作" aria-haspopup="menu">
              <Icon.More aria-hidden="true" />
            </summary>
            <div role="menu" aria-label="更多笔记操作">
              <button
                type="button"
                role="menuitem"
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
                role="menuitem"
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

      {/* ── 生成消息 ── */}
      {genMessage && genState === "idle" && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>{genMessage}</p>
          <button type="button" className="ne-notice-dismiss" onClick={() => setGenMessage(null)}>关闭</button>
        </div>
      )}

      {/* ── 主内容三栏 ── */}
      <div className="ne-layout">
        {/* 左栏：大纲 + 版本 */}
        <aside className="ne-sidebar">
          {renderOutlinePanel()}
          {renderVersionsPanel()}
        </aside>

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
          <div className="ne-editor-toolbar">
            <div className="ne-editor-title-row">
              <div>
                <span className="ne-editor-kicker">WRITING PAPER</span>
                <h1 id="note-editor-title" className="ne-editor-h1">
                  {title || "无标题笔记"}
                </h1>
                <p className="ne-editor-subtitle">
                  把尚未成形的想法写清楚，再从保存版本生成可验证的学习对象。
                </p>
              </div>
              {titleSource === "auto" && (
                <span className="ne-chip ne-chip--muted">自动命名</span>
              )}
            </div>

            <div className="ne-toolbar-controls">
              <div className="ne-mode-switch" role="group" aria-label="编辑器显示模式">
                <button
                  type="button"
                  className={`ne-toolbar-chip ${mode === "edit" ? "ne-toolbar-chip--active" : ""}`}
                  onClick={() => changeMode("edit")}
                  aria-pressed={mode === "edit"}
                >
                  <Icon.Pencil className="ne-toolbar-icon" aria-hidden="true" />
                  编辑
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
                <button
                  type="button"
                  className={`ne-toolbar-chip ne-toolbar-split ${mode === "split" ? "ne-toolbar-chip--active" : ""}`}
                  onClick={() => changeMode("split")}
                  aria-pressed={mode === "split"}
                >
                  <Icon.SplitView className="ne-toolbar-icon" aria-hidden="true" />
                  分屏
                </button>
              </div>
              {mode !== "preview" && (
                <div className="ne-format-tools" role="group" aria-label="Markdown 格式工具">
                  <button type="button" className="ne-format-button" onClick={() => applyLinePrefix("# ", /^#{1,6}\s+/)} aria-label="一级标题" title="一级标题">
                    <Icon.H1 className="ne-toolbar-icon" aria-hidden="true" />
                  </button>
                  <button type="button" className="ne-format-button" onClick={() => applyLinePrefix("## ", /^#{1,6}\s+/)} aria-label="二级标题" title="二级标题">
                    <Icon.H2 className="ne-toolbar-icon" aria-hidden="true" />
                  </button>
                  <button type="button" className="ne-format-button" onClick={() => applyWrap("**", "**", "加粗")} aria-label="加粗" title="加粗 · ⌘B">
                    <Icon.Bold className="ne-toolbar-icon" aria-hidden="true" />
                  </button>
                  <button type="button" className="ne-format-button" onClick={() => applyWrap("*", "*", "斜体")} aria-label="斜体" title="斜体 · ⌘I">
                    <Icon.Italic className="ne-toolbar-icon" aria-hidden="true" />
                  </button>
                  <button type="button" className="ne-format-button" onClick={() => applyWrap("`", "`", "代码")} aria-label="行内代码" title="行内代码">
                    <Icon.Code className="ne-toolbar-icon" aria-hidden="true" />
                  </button>
                  <button type="button" className="ne-format-button" onClick={() => applyLinePrefix("> ", /^>\s?/)} aria-label="引用" title="引用">
                    <Icon.QuoteMark className="ne-toolbar-icon" aria-hidden="true" />
                  </button>
                  <button type="button" className="ne-format-button" onClick={() => applyLinePrefix("- ", /^[-*+]\s+/)} aria-label="无序列表" title="无序列表">
                    <Icon.List className="ne-toolbar-icon" aria-hidden="true" />
                  </button>
                  <button type="button" className="ne-format-button" onClick={() => applyWrap("[", "](https://)", "链接文字")} aria-label="链接" title="链接 · ⌘K">
                    <Icon.LinkOut className="ne-toolbar-icon" aria-hidden="true" />
                  </button>
                  <button type="button" className="ne-format-button" onClick={() => insertAtCursor("\n---\n")} aria-label="分隔线" title="分隔线">
                    <Icon.Divider className="ne-toolbar-icon" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="ne-editor-surface" data-mode={mode}>
            {(mode === "edit" || mode === "split") && (
              <div className="ne-editor-pane">
                <header className="ne-pane-label">
                  <span>MARKDOWN SOURCE</span>
                  <small>输入停顿 800ms 后同步</small>
                </header>
                {source.trim() === "" && (
                  <div className="ne-starter-row" aria-label="快速开始模板">
                    <span>快速开始</span>
                    <div>
                      <button type="button" onClick={() => applyStarterTemplate("# 我想理解的问题\n\n")}>核心问题</button>
                      <button type="button" onClick={() => applyStarterTemplate("# 阅读摘录\n\n> 粘贴原文\n\n## 我的理解\n\n")}>阅读整理</button>
                      <button type="button" onClick={() => applyStarterTemplate("# 主题\n\n- 要点一\n- 要点二\n")}>要点清单</button>
                    </div>
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  value={source}
                  disabled={leaving || deleting}
                  onChange={(e) => updateSource(e.target.value)}
                  onKeyDown={onEditorKeyDown}
                  onSelect={(e) => {
                    textareaSelectionRef.current = {
                      start: e.currentTarget.selectionStart,
                      end: e.currentTarget.selectionEnd,
                    };
                  }}
                  placeholder="开始写下你的问题、摘录或推理过程…"
                  spellCheck={false}
                  className="ne-editor-textarea"
                  aria-label="Markdown 笔记正文"
                />
              </div>
            )}
            {(mode === "preview" || mode === "split") && (
              <div
                className="ne-editor-pane ne-editor-preview"
                role="region"
                aria-label="Markdown 阅读预览"
                tabIndex={0}
              >
                <header className="ne-pane-label">
                  <span>READING PREVIEW</span>
                  <small>阅读排版</small>
                </header>
                <MarkdownPreview source={source} demoteHeadings />
              </div>
            )}
          </div>

          {/* 底部统计条 */}
          <div className="ne-editor-footer">
            <span className="ne-editor-stat">{previewBlocks.length} 块</span>
            <span className="ne-editor-stat-sep">·</span>
            <span className="ne-editor-stat">{wordCount} 非空字符</span>
            {blockDelta !== 0 && (
              <>
                <span className="ne-editor-stat-sep">·</span>
                <span className="ne-editor-stat">内容块 {blockDelta > 0 ? `+${blockDelta}` : blockDelta}</span>
              </>
            )}
            <span className="ne-editor-stat ne-editor-stat--local">本地统计</span>
            <span className="ne-editor-save-hint">自动保存会生成版本记录</span>
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
          </div>
        </section>

        {/* 右栏：唯一的桌面生成入口 */}
        <aside className="ne-rail">
          {renderGenerationPanel()}
        </aside>
      </div>

      <section className="ne-compact-actions" aria-label="笔记辅助操作">
        <button
          type="button"
          onClick={() => setInspectorOpen(true)}
          aria-label="打开大纲与版本"
        >
          <Icon.Notepad aria-hidden="true" />
          <span>信息</span>
        </button>
        <button
          type="button"
          onClick={() => void save(false)}
          disabled={saving === "saving" || deleting}
          aria-busy={saving === "saving"}
          aria-label="立即保存笔记"
        >
          <Icon.Check aria-hidden="true" />
          <span>保存</span>
        </button>
        <button
          type="button"
          className="is-primary ne-compact-generate"
          data-generation-state={generationVisualState}
          onClick={genButton.onClick}
          disabled={genButton.disabled}
          aria-label={genButton.label}
          aria-busy={genState === "generating"}
        >
          {generationVisualState === "success"
            ? <Icon.Check aria-hidden="true" />
            : <Icon.Sparkle aria-hidden="true" />}
          <span>{compactGenLabel}</span>
        </button>
      </section>

      <Drawer
        id="note-editor-inspector"
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        title="大纲与版本"
        side={compactDrawer ? "bottom" : "right"}
        width="min(400px, calc(100vw - 32px))"
        maxHeight="84dvh"
      >
        <div className="note-editor-inspector-content">
          {renderOutlinePanel(true)}
          {renderVersionsPanel()}
        </div>
      </Drawer>

      {/* F-007: 冲突解决对话框 */}
      {conflictData && (
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
                <pre className="ne-conflict-pre">{latestDraftRef.current.source}</pre>
              </div>
              <div className="ne-conflict-pane">
                <h4 className="ne-conflict-pane-title">服务端版本（v{conflictData.serverVersionNo}）</h4>
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

      <ConfirmDialog
        open={confirmDelete}
        title={`删除「${title || "无标题笔记"}」？`}
        message="确定要删除这篇笔记吗？此操作不可撤销，关联的学习卡、证据和复习记录将一并清除。"
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
            setDeleteError(
              `删除失败：${err instanceof Error ? err.message : "未知错误"}`,
            );
            if (latestDraftRef.current.source !== lastSavedSourceRef.current) {
              scheduleSave();
            }
          } finally {
            setDeleting(false);
            setConfirmDelete(false);
          }
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
