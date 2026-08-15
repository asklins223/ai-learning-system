"use client";

/**
 * PERF-04 拆分（第十二轮）：编辑器底部栏组件。
 *
 * 从 NoteEditor.tsx 提取底部统计条、快捷键面板和学习下一步按钮，
 * 减少主文件约 70 行 JSX。
 */
import { memo } from "react";
import { Icon } from "@/components/ui/icons";
import type { NoteVersionSummary } from "@/lib/api";
import type { SavingPresentation } from "./TopBar";
import type { GenerationButtonConfig } from "./TopBar";

/** 编辑器底部栏属性 */
export interface EditorFooterProps {
  /** 预览块数量 */
  previewBlocksCount: number;
  /** 非空字符数 */
  wordCount: number;
  /** 内容块增减量 */
  blockDelta: number;
  /** 保存状态展示 */
  savingPres: SavingPresentation;
  /** 是否为所有者 */
  isOwner: boolean;
  /** 当前版本号 */
  currentVersionNo: number;
  /** 版本历史列表 */
  versions: NoteVersionSummary[] | null;
  /** 生成区标题 */
  generationHeading: string;
  /** 生成视觉状态 */
  generationVisualState: string;
  /** 生成按钮配置 */
  genButton: GenerationButtonConfig;
  /** 生成锁定中 */
  generationLocked: boolean;
  /** 打开版本历史回调 */
  onOpenVersions: () => void;

  /** V2 入口字段（与 EditorSection 共用 props 对象；本组件不使用） */
  v2Enabled?: boolean;
  onGenerateV2?: () => void;
}

/**
 * 编辑器底部栏。
 *
 * 左侧：文档统计（块数、字符数、增减量）
 * 中间：快捷键折叠面板
 * 右侧：版本历史入口 + 学习下一步 + 生成按钮
 */
export const EditorFooter = memo(function EditorFooter({
  previewBlocksCount,
  wordCount,
  blockDelta,
  savingPres,
  isOwner,
  currentVersionNo,
  versions,
  generationHeading,
  generationVisualState,
  genButton,
  generationLocked,
  onOpenVersions,
}: EditorFooterProps) {
  return (
    <div className="ne-editor-footer">
      {/* 文档统计 */}
      <div className="ne-editor-footer-stats" aria-label="文档统计">
        <span className="ne-editor-stat">{previewBlocksCount} 块</span>
        <span className="ne-editor-stat-sep">·</span>
        <span className="ne-editor-stat">{wordCount} 非空字符</span>
        {blockDelta !== 0 && (
          <>
            <span className="ne-editor-stat-sep">·</span>
            <span className="ne-editor-stat">内容块 {blockDelta > 0 ? `+${blockDelta}` : blockDelta}</span>
          </>
        )}
      </div>

      {/* 快捷键折叠面板 */}
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

      {/* 学习下一步：版本入口 + 生成按钮 */}
      {isOwner && (
        <div className="ne-learning-next" aria-label="学习下一步">
          <button
            type="button"
            className="ne-learning-version"
            onClick={onOpenVersions}
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
  );
});
