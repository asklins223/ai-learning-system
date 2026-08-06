"use client";

/**
 * PERF-04 拆分（第九轮）：版本历史面板组件。
 *
 * 从 NoteEditor.tsx 的 renderVersionsPanel 函数提取为独立组件。
 * 支持两种展示模式：侧边栏紧凑模式（compact=true，只显示前 2 条）
 * 和抽屉完整模式（compact=false，显示全部版本）。
 */

import type { NoteVersionSummary } from "@/lib/api";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { Icon } from "@/components/ui/icons";

export interface VersionsPanelProps {
  /** 全部版本列表（null 表示尚未加载） */
  versions: NoteVersionSummary[] | null;
  /** 加载错误信息 */
  versionsError: string | null;
  /** 笔记 ID（用于重试加载） */
  noteId: string;
  /** 当前版本号 */
  currentVersionNo: number;
  /** 是否为紧凑模式（侧边栏只显示前 2 条） */
  compact: boolean;
  /** 是否为工作区所有者（影响恢复按钮显示） */
  isOwner: boolean;
  /** 是否正在恢复版本 */
  restoring: boolean;
  /** 设置版本列表（重试加载时使用） */
  onVersionsChange: (versions: NoteVersionSummary[]) => void;
  /** 设置错误信息 */
  onVersionsErrorChange: (error: string | null) => void;
  /** 点击恢复版本时回调 */
  onConfirmRestore: (version: { versionId: string; versionNo: number }) => void;
  /** 点击"查看全部"时回调（切换到抽屉完整模式） */
  onViewAll: () => void;
}

export function VersionsPanel({
  versions,
  versionsError,
  noteId,
  currentVersionNo,
  compact,
  isOwner,
  restoring,
  onVersionsChange,
  onVersionsErrorChange,
  onConfirmRestore,
  onViewAll,
}: VersionsPanelProps) {
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
                    onVersionsChange(items);
                    onVersionsErrorChange(null);
                  })
                  .catch(() => onVersionsErrorChange("版本历史加载失败"));
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
                        onClick={() => onConfirmRestore({ versionId: version.id, versionNo: version.versionNo })}
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
            onClick={onViewAll}
          >
            查看全部 {allVersions.length} 个版本
            <Icon.Arrow aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
}
