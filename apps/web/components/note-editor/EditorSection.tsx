"use client";

/**
 * PERF-04 拆分（第十四轮）：编辑器主体区域提取为独立组件。
 *
 * 从 NoteEditor.tsx 提取编辑器中央 section 区域，包括：
 * - 草稿恢复横幅（已恢复未解决草稿、保留被丢弃草稿）
 * - 编辑器工具栏（EditorToolbar）
 * - 编辑/预览面板（MilkdownEditor / NoteArticlePreview）
 * - 图片上传状态（ImageUploadStatus）
 * - 底部统计栏（EditorFooter）
 *
 * 提取后 NoteEditor.tsx 的 JSX return 减少约 120 行内联代码。
 */

import type { RefObject } from "react";
import { memo } from "react";
import dynamic from "next/dynamic";
import { Icon } from "@/components/ui/icons";
import { MemberNotice } from "@/components/settings/MemberNotice";
import { NoteArticlePreview } from "@/components/NoteArticlePreview";
import type { MilkdownEditorHandle } from "@/components/MilkdownEditor";
import type { NoteVersionSummary } from "@/lib/api";
import type { StatusTone } from "@/lib/status-map";
import type { ImageUploadView, EditorMode, SavingState } from "./note-editor-types";
import type { GenButtonResult } from "./note-editor-utils";
import { EditorToolbar } from "./EditorToolbar";
import { EditorFooter } from "./EditorFooter";
import { ImageUploadStatus } from "./ImageUploadStatus";

const MilkdownEditor = dynamic(
  () => import("@/components/MilkdownEditor").then((m) => m.MilkdownEditor),
  { ssr: false },
);

/** 编辑器主体区域的 Props */
export interface EditorSectionProps {
  // ── 状态值 ──
  title: string;
  isAutoTitle: boolean;
  mode: EditorMode;
  isOwner: boolean;
  ownerLoading: boolean;
  leaving: boolean;
  deleting: boolean;
  restoring: boolean;
  generationLocked: boolean;
  saving: SavingState;
  source: string;
  initialMarkdown: string;
  wordCount: number;
  previewBlocksCount: number;
  blockDelta: number;
  currentVersionNo: number;
  versions: NoteVersionSummary[] | null;
  hasRecoveredConflictDraft: boolean;
  hasDiscardedDraft: boolean;
  savingPres: { label: string; tone: StatusTone };
  generationHeading: string;
  generationVisualState: string;
  genButton: GenButtonResult;

  // ── 图片上传 ──
  imageUploads: ImageUploadView[];
  uploadingCount: number;
  failedImageUploadCount: number;
  uploadError: string | null;

  // ── Refs ──
  editorRef: RefObject<MilkdownEditorHandle | null>;
  editorPaneRef: RefObject<HTMLDivElement | null>;
  previewRef: RefObject<HTMLDivElement | null>;
  imageFileInputRef: RefObject<HTMLInputElement | null>;

  // ── 回调 ──
  onTitleChange: (value: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onSourceChange: (next: string) => void;
  onSetMarkdown: (handle: MilkdownEditorHandle | null) => void;
  onImagePaste: (file: File) => void;
  onRetryImageUpload: (id: string) => void;
  onCancelImageUpload: (id: string) => void;
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onDiscardRecoveredConflictDraft: () => void;
  onRestoreDiscardedDraft: () => void;
  onApplyStarterTemplate: (template: string) => void;
  onOpenVersions: () => void;

  // ── V2（方案 20 §19.1） ──
  v2Enabled?: boolean;
  onGenerateV2?: () => void;
}

/**
 * 编辑器主体区域组件。
 *
 * 渲染编辑器的核心交互区域，包括草稿恢复横幅、工具栏、
 * 编辑/预览面板和底部统计栏。
 *
 * F8：React.memo——NoteEditor 逐击键重渲时，若 props（source/title/callbacks）
 * 浅比较不变则跳过整棵编辑器子树重渲。回调须在 NoteEditor 侧 useCallback 稳定。
 */
export const EditorSection = memo(function EditorSection({
  title,
  isAutoTitle,
  mode,
  isOwner,
  ownerLoading,
  leaving,
  deleting,
  restoring,
  generationLocked,
  saving,
  source,
  initialMarkdown,
  wordCount,
  previewBlocksCount,
  blockDelta,
  currentVersionNo,
  versions,
  hasRecoveredConflictDraft,
  hasDiscardedDraft,
  savingPres,
  generationHeading,
  generationVisualState,
  genButton,
  imageUploads,
  uploadingCount,
  failedImageUploadCount,
  uploadError,
  editorRef,
  editorPaneRef,
  previewRef,
  imageFileInputRef,
  onTitleChange,
  onModeChange,
  onSourceChange,
  onSetMarkdown,
  onImagePaste,
  onRetryImageUpload,
  onCancelImageUpload,
  onFileSelect,
  onDiscardRecoveredConflictDraft,
  onRestoreDiscardedDraft,
  onApplyStarterTemplate,
  onOpenVersions,
  v2Enabled = false,
  onGenerateV2,
}: EditorSectionProps) {
  return (
    <section className="ne-editor">
      {/* ── 草稿恢复横幅 ── */}
      {hasRecoveredConflictDraft && (
        <div className="ne-draft-restore" role="status">
          <div>
            <Icon.Refresh aria-hidden="true" />
            <p>
              <strong>已恢复未解决的本地草稿</strong>
              <span>这份内容尚未写入服务器；继续编辑或点击保存即可保留。</span>
            </p>
          </div>
          <button type="button" onClick={onDiscardRecoveredConflictDraft}>
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
          <button type="button" onClick={onRestoreDiscardedDraft}>
            恢复草稿
          </button>
        </div>
      )}

      {/* ── 工具栏 ── */}
      {(isOwner || mode !== "preview") && (
        <EditorToolbar
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
          editorRef={editorRef}
          imageFileInputRef={imageFileInputRef}
          onTitleChange={onTitleChange}
          onModeChange={onModeChange}
        />
      )}

      {/* ── 编辑/预览面板 ── */}
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
                  <button type="button" disabled={ownerLoading || !isOwner} onClick={() => onApplyStarterTemplate("# 我想理解的问题\n\n")}>核心问题</button>
                  <button type="button" disabled={ownerLoading || !isOwner} onClick={() => onApplyStarterTemplate("# 阅读摘录\n\n> 粘贴原文\n\n## 我的理解\n\n")}>阅读整理</button>
                  <button type="button" disabled={ownerLoading || !isOwner} onClick={() => onApplyStarterTemplate("# 主题\n\n- 要点一\n- 要点二\n")}>要点清单</button>
                </div>
              </div>
            )}
            <MilkdownEditor
              ref={onSetMarkdown}
              initialMarkdown={initialMarkdown}
              onChange={(md) => onSourceChange(md)}
              disabled={ownerLoading || !isOwner || leaving || deleting || restoring || generationLocked || saving === "deleted"}
              onImagePaste={onImagePaste}
            />
            <ImageUploadStatus
              imageUploads={imageUploads}
              uploadingCount={uploadingCount}
              failedImageUploadCount={failedImageUploadCount}
              uploadError={uploadError}
              imageFileInputRef={imageFileInputRef}
              onRetry={onRetryImageUpload}
              onCancel={onCancelImageUpload}
              onFileSelect={onFileSelect}
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

      {/* ── 底部统计栏 ── */}
      <EditorFooter
        previewBlocksCount={previewBlocksCount}
        wordCount={wordCount}
        blockDelta={blockDelta}
        savingPres={savingPres}
        isOwner={isOwner}
        currentVersionNo={currentVersionNo}
        versions={versions}
        generationHeading={generationHeading}
        generationVisualState={generationVisualState}
        genButton={genButton}
        generationLocked={generationLocked}
        onOpenVersions={onOpenVersions}
        v2Enabled={v2Enabled}
        onGenerateV2={onGenerateV2}
      />
    </section>
  );
});
