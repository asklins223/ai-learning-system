import { MarkdownPreview } from "@/components/MarkdownPreview";
import type { ReactNode } from "react";

interface NoteArticlePreviewProps {
  title: string;
  source: string;
  wordCount: number;
  compact?: boolean;
  primaryHeading?: boolean;
  accessory?: ReactNode;
}

function normalizeArticleTitle(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~=]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 博客标题已经占据页面 H1；若 Markdown 第一条有效内容就是同名标题，
 * 阅读视图中将它去重，编辑源码仍保持原样。
 */
export function hasDuplicateArticleLeadHeading(source: string, title: string): boolean {
  const firstContentLine = source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .find((line) => line.trim().length > 0);
  const heading = firstContentLine ? /^#{1,6}\s+(.+?)\s*$/.exec(firstContentLine) : null;
  if (!heading) return false;
  return normalizeArticleTitle(heading[1]) === normalizeArticleTitle(title);
}

function articleMarkdown(source: string, title: string): string {
  if (!hasDuplicateArticleLeadHeading(source, title)) return source;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const headingIndex = lines.findIndex((line) => line.trim().length > 0);
  return lines.filter((_, index) => index !== headingIndex).join("\n");
}

/**
 * 笔记的最终阅读形态。
 *
 * 编辑器负责状态与保存，这个组件只负责把同一份 Markdown 呈现成一篇
 * 有标题、阅读节奏和稳定栏宽的文章，避免“预览”仍像开发工具面板。
 */
export function NoteArticlePreview({
  title,
  source,
  wordCount,
  compact = false,
  primaryHeading = true,
  accessory,
}: NoteArticlePreviewProps) {
  const readingMinutes = Math.max(1, Math.ceil(wordCount / 400));
  const displayTitle = title.trim() || "无标题笔记";
  const previewSource = articleMarkdown(source, displayTitle);

  return (
    <article
      className={`note-article${compact ? " note-article--compact" : ""}`}
      aria-labelledby={compact ? undefined : "note-article-title"}
      aria-label={compact ? "文章正文预览" : undefined}
    >
      {!compact && accessory && (
        <div className="note-article-accessory">{accessory}</div>
      )}

      {!compact && (
        <>
          <header className="note-article-header">
            <p className="note-article-kicker">学习笔记</p>
            {primaryHeading ? (
              <h1 id="note-article-title">{displayTitle}</h1>
            ) : (
              <h2 id="note-article-title">{displayTitle}</h2>
            )}
            <p className="note-article-meta">约 {readingMinutes} 分钟阅读</p>
          </header>

          <div className="note-article-divider" aria-hidden="true" />
        </>
      )}

      <div className="note-article-body">
        <MarkdownPreview source={previewSource} demoteHeadings />
      </div>
    </article>
  );
}
