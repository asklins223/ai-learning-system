"use client";

import "@/app/styles/note-editor.css";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, CardGenerationStatus, NoteDetail } from "@/lib/api";
import { NoteEditor } from "@/components/NoteEditor";
import { Skeleton } from "@/components/ui/Skeleton";
import { Icon } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { sanitizeSearchReturnTarget } from "@/lib/search-return";
import {
  sanitizeSourceDetailReturnTarget,
  sanitizeSourceLibraryReturnTarget,
} from "@/lib/source-return";
import { sanitizeTodayReturnTarget } from "@/lib/today-return";

/**
 * /notes/[id] — 笔记编辑页
 *
 * 模板：EditorTemplate
 * Shell：focus
 *
 * auth-gate 由 workspace layout 统一处理。
 * 页面本身只做数据加载和错误展示，编辑逻辑全部在 NoteEditor 组件中。
 */
export default function NotePage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const searchReturnTarget = sanitizeSearchReturnTarget(searchParams.get("returnTo"));
  const todayReturnTarget = sanitizeTodayReturnTarget(searchParams.get("returnTo"));
  const sourceDetailReturnTarget = sanitizeSourceDetailReturnTarget(
    searchParams.get("returnTo"),
  );
  const sourceLibraryReturnTarget = sanitizeSourceLibraryReturnTarget(
    searchParams.get("returnTo"),
  );
  const sourceReturnTarget =
    sourceDetailReturnTarget ?? sourceLibraryReturnTarget;
  const backHref =
    searchReturnTarget ?? todayReturnTarget ?? sourceReturnTarget ?? "/notes";
  const backLabel = searchReturnTarget
    ? "搜索结果"
    : todayReturnTarget
      ? "今日变化"
      : sourceReturnTarget
        ? "来源资料"
        : "笔记库";
  const shouldReplaceBackNavigation = Boolean(
    searchReturnTarget || todayReturnTarget || sourceReturnTarget,
  );
  const [data, setData] = useState<NoteDetail | null>(null);
  const [draftScope, setDraftScope] = useState<string | null>(null);
  const [generationStatus, setGenerationStatus] = useState<CardGenerationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!params?.id) return;
    let active = true;
    setData(null);
    setDraftScope(null);
    setGenerationStatus(null);
    setError(null);
    setNotFound(false);
    Promise.all([api.getNote(params.id), api.getMe()])
      .then(async ([result, currentUser]) => {
        let generation: CardGenerationStatus;
        try {
          generation = await api.getCardGenerationStatus(result.version.id);
        } catch {
          // Keep the note readable while the editor rechecks this auxiliary
          // state. Owners stay write-locked until we can prove that no card job
          // is active; otherwise a refresh could mutate a version mid-run.
          generation = {
            state: "checking",
            cardId: null,
            jobId: null,
            generatedVersionId: null,
            message: "正在重新确认学习卡任务状态…",
          };
        }
        return { result, currentUser, generation };
      })
      .then(({ result, currentUser, generation }) => {
        if (!active) return;
        setData(result);
        setDraftScope(`${currentUser.userId}:${currentUser.workspaceId}`);
        setGenerationStatus(generation);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 404) {
          setError("笔记不存在或已删除");
          setNotFound(true);
        } else {
          setError(e instanceof Error ? e.message : "加载笔记失败");
        }
      });
    return () => {
      active = false;
    };
  }, [params?.id, reloadNonce]);

  if (error) {
    return (
      <div className="note-detail-state-shell">
        <header className="note-detail-state-topbar">
          <Link href={backHref} replace={shouldReplaceBackNavigation} className="note-detail-state-back">
            <Icon.Chevron aria-hidden="true" />
            {backLabel}
          </Link>
          <ThemeToggle />
        </header>
        <div className="note-detail-error" role="alert">
          <Icon.Warn className="note-detail-error-icon" />
          <h1 className="note-detail-error-title">
            {notFound ? "没有找到这篇笔记" : "笔记加载失败"}
          </h1>
          <p className="note-detail-error-desc">{error}</p>
          <div className="note-detail-error-actions">
            {!notFound && (
              <button
                type="button"
                className="note-detail-error-link note-detail-error-retry"
                onClick={() => setReloadNonce((value) => value + 1)}
              >
                <Icon.Refresh aria-hidden="true" />
                重新加载
              </button>
            )}
            <Link href={backHref} replace={shouldReplaceBackNavigation} className="note-detail-error-link">
              返回{backLabel}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!data || !draftScope || !generationStatus) {
    return (
      <div className="note-detail-loading">
        <header className="note-detail-loading-topbar">
          <Link href={backHref} replace={shouldReplaceBackNavigation} className="note-detail-state-back">
            <Icon.Chevron aria-hidden="true" />
            {backLabel}
          </Link>
          <ThemeToggle />
        </header>
        <div className="note-detail-loading-body">
          <div className="note-detail-loading-left">
            <Skeleton lines={4} />
          </div>
          <div className="note-detail-loading-center">
            <Skeleton lines={2} />
            <div className="mt-4">
              <Skeleton lines={8} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <NoteEditor
      key={data.note.id}
      noteId={data.note.id}
      draftScope={draftScope}
      noteVersionId={data.version.id}
      versionNo={data.version.versionNo}
      initialTitle={data.note.title}
      titleSource={data.note.titleSource}
      initialBlocks={data.blocks}
      initialGenerationStatus={generationStatus}
      returnHref={backHref}
      returnLabel={backLabel}
    />
  );
}
