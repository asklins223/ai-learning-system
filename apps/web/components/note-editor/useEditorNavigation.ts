/**
 * PERF-04 拆分（第十三轮）：导航与大纲逻辑提取为自定义 Hook。
 *
 * 从 NoteEditor.tsx 提取以下功能：
 * - jumpToPreviewHeading()：在预览面板中跳转到对应标题
 * - jumpToBlock()：在大纲/预览间跳转到标题
 * - changeMode()：切换编辑/预览模式
 * - changeViewMode()：切换 normal/wide/fullscreen 视图模式
 * - applyStarterTemplate()：应用快速开始模板
 * - insertFirstHeading()：插入第一个标题
 *
 * 提取后 NoteEditor.tsx 减少约 160 行逻辑代码。
 */

import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Block } from "@/lib/api";
import { hasDuplicateArticleLeadHeading } from "@/components/NoteArticlePreview";
import type { MilkdownEditorHandle } from "@/components/MilkdownEditor";
import { stripMarkdownTitle } from "./note-editor-utils";
import type { EditorMode, ViewMode } from "./note-editor-types";

/** useEditorNavigation 的上下文参数 */
export interface EditorNavigationContext {
  // ── Refs ──
  editorRef: RefObject<MilkdownEditorHandle | null>;
  editorPaneRef: RefObject<HTMLDivElement | null>;
  previewRef: RefObject<HTMLDivElement | null>;
  workbenchRef: RefObject<HTMLDivElement | null>;
  exitingFullscreenRef: RefObject<boolean>;

  // ── 状态值 ──
  source: string;
  title: string;
  mode: EditorMode;
  viewMode: ViewMode;
  allOutlineBlocks: Block[];

  // ── 状态设置器 ──
  setMode: Dispatch<SetStateAction<EditorMode>>;
  setViewMode: Dispatch<SetStateAction<ViewMode>>;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;

  // ── 回调 ──
  updateSource: (next: string) => void;
}

/** 从 useEditorNavigation 返回的导航接口 */
export interface EditorNavigationControls {
  jumpToBlock: (block: Block) => void;
  changeMode: (nextMode: EditorMode) => void;
  changeViewMode: (next: ViewMode) => void;
  applyStarterTemplate: (template: string) => void;
  insertFirstHeading: (fromDrawer?: boolean) => void;
}

/**
 * 编辑器导航 Hook。
 *
 * 封装大纲跳转、模式切换、模板应用等交互逻辑。
 */
export function useEditorNavigation(ctx: EditorNavigationContext): EditorNavigationControls {
  const {
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
  } = ctx;

  // ── 预览面板跳转到标题 ─────────────────────────────────────────────

  const jumpToPreviewHeading = useCallback((block: Block) => {
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
  }, [
    previewRef, allOutlineBlocks, source, title, mode, workbenchRef,
  ]);

  // ── 大纲跳转 ────────────────────────────────────────────────────────

  const jumpToBlock = useCallback((block: Block) => {
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
  }, [
    mode, previewRef, editorPaneRef, editorRef, jumpToPreviewHeading,
  ]);

  // ── 切换编辑/预览模式 ──────────────────────────────────────────────

  const changeMode = useCallback((nextMode: EditorMode) => {
    setMode(nextMode);
    if (nextMode === "edit") {
      requestAnimationFrame(() => {
        editorRef.current?.focus();
      });
    }
  }, [setMode, editorRef]);

  // ── 切换视图模式 ────────────────────────────────────────────────────

  const changeViewMode = useCallback((next: ViewMode) => {
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
  }, [viewMode, workbenchRef, exitingFullscreenRef, setViewMode]);

  // ── 应用快速开始模板 ──────────────────────────────────────────────

  const applyStarterTemplate = useCallback((template: string) => {
    updateSource(template);
    editorRef.current?.setMarkdown(template);
    changeMode("edit");
    requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  }, [updateSource, editorRef, changeMode]);

  // ── 插入第一个标题 ──────────────────────────────────────────────────

  const insertFirstHeading = useCallback((fromDrawer = false) => {
    if (fromDrawer) setInspectorOpen(false);
    changeMode("edit");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        editorRef.current?.focus();
        const currentMd = editorRef.current?.getMarkdown() ?? source;
        editorRef.current?.insertText(currentMd.trim() ? "\n\n# 新标题\n" : "# 新标题\n\n");
      });
    });
  }, [setInspectorOpen, changeMode, editorRef, source]);

  return {
    jumpToBlock,
    changeMode,
    changeViewMode,
    applyStarterTemplate,
    insertFirstHeading,
  };
}
