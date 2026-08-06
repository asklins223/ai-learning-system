"use client";

/**
 * PERF-04 拆分（第八轮）：文章大纲面板组件。
 *
 * 从 NoteEditor.tsx 的 renderOutlinePanel 函数提取为独立组件。
 * 支持两种模式：文档工具中的"文章大纲"和预览模式中的"本文目录"。
 */

import type { Block } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import type { PreviewOutlineMode } from "./note-editor-types";
import { stripMarkdownTitle, outlineBlockKey } from "./note-editor-utils";

export interface OutlinePanelProps {
  /** 面板要显示的 blocks 列表 */
  panelBlocks: Block[];
  /** 是否为预览模式中的浮动目录（true 时显示模式切换和关闭按钮） */
  previewDock: boolean;
  /** 是否从抽屉中调用（影响跳转行为） */
  fromDrawer: boolean;
  /** 当前大纲模式 */
  previewOutlineMode: PreviewOutlineMode;
  /** 当前激活的大纲项 key */
  activeOutlineKey: string | null;
  /** 是否为工作区所有者（影响"插入第一个标题"按钮显示） */
  isOwner: boolean;
  /** 点击大纲项时的回调（父组件处理 activeKey 设置、面板关闭和跳转逻辑） */
  onItemClick: (block: Block, blockKey: string) => void;
  /** 切换大纲模式（pinned / auto） */
  onModeChange: (mode: PreviewOutlineMode) => void;
  /** 关闭浮动目录 */
  onClose: () => void;
  /** 点击"插入第一个标题"按钮 */
  onInsertFirstHeading: (fromDrawer: boolean) => void;
}

export function OutlinePanel({
  panelBlocks,
  previewDock,
  fromDrawer,
  previewOutlineMode,
  activeOutlineKey,
  isOwner,
  onModeChange,
  onClose,
  onItemClick,
  onInsertFirstHeading,
}: OutlinePanelProps) {
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
                onModeChange(nextMode);
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
              onClick={onClose}
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
                      onItemClick(block, blockKey);
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
              <button type="button" onClick={() => onInsertFirstHeading(fromDrawer)}>
                插入第一个标题
              </button>
            )}
          </div>
        )}
      </nav>
    </section>
  );
}
