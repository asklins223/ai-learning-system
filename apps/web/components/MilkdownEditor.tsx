"use client";

import { useRef, useEffect } from "react";
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewOptionsCtx,
  editorViewCtx,
} from "@milkdown/kit/core";
import {
  commonmark,
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  toggleLinkCommand,
  insertHrCommand,
} from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { history } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { getMarkdown, insert, replaceAll, callCommand, $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { keymap } from "@milkdown/kit/prose/keymap";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import { withReadyMilkdownEditor } from "@/lib/milkdown-lifecycle";
import "@milkdown/kit/prose/view/style/prosemirror.css";

export interface MilkdownEditorHandle {
  /** 获取当前 Markdown 文本 */
  getMarkdown: () => string | null;
  /** 替换全部内容。flush=true 时清除 undo 历史，用于外部同步。 */
  setMarkdown: (md: string, flush?: boolean) => void;
  /** 聚焦编辑器 */
  focus: () => void;
  /** 在光标处插入文本（Markdown 语法会被解析渲染） */
  insertText: (text: string) => void;
  /** 替换图片 src（保留光标位置，用于图片上传完成后的 URL 替换） */
  replaceImageSrc: (oldSrc: string, newSrc: string) => void;
  /** 切换加粗 */
  toggleBold: () => void;
  /** 切换斜体 */
  toggleItalic: () => void;
  /** 切换行内代码 */
  toggleInlineCode: () => void;
  /** 切换标题级别（1-6） */
  toggleHeading: (level: number) => void;
  /** 切换引用 */
  toggleBlockquote: () => void;
  /** 切换无序列表 */
  toggleBulletList: () => void;
  /** 切换有序列表 */
  toggleOrderedList: () => void;
  /** 切换链接 */
  toggleLink: (href: string) => void;
  /** 插入分隔线 */
  insertHr: () => void;
}

interface Props {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  /** 图片粘贴/拖拽回调，由父组件处理上传逻辑 */
  onImagePaste?: (file: File) => void;
}

/**
 * 创建图片粘贴/拖拽拦截插件。
 * 检测剪贴板或拖拽中的图片文件，转发给 onImagePaste 回调。
 */
function createImageUploadPlugin(onImagePasteRef: React.MutableRefObject<((file: File) => void) | undefined>) {
  return $prose(() => {
    return new Plugin({
      key: new PluginKey("MILKDOWN_IMAGE_UPLOAD"),
      props: {
        handlePaste(_view, event) {
          const items = event.clipboardData?.items;
          if (!items) return false;
          const itemList = Array.from(items);
          const imageItems = itemList.filter((item) => item.type.startsWith("image/"));
          // 仅当剪贴板只包含图片时才拦截。
          // 混合内容（图片+文本，如从网页复制）交给 ProseMirror 正常粘贴文本，
          // 避免丢失文本内容。
          if (imageItems.length === 0 || imageItems.length < itemList.length) return false;
          for (const item of imageItems) {
            const file = item.getAsFile();
            if (file) {
              onImagePasteRef.current?.(file);
              event.preventDefault();
            }
          }
          return true;
        },
        handleDrop(_view, event) {
          const files = event.dataTransfer?.files;
          if (!files || files.length === 0) return false;
          const fileArray = Array.from(files);
          const imageFiles = fileArray.filter((f) => f.type.startsWith("image/"));
          if (imageFiles.length === 0) return false;
          // 纯图片拖拽时拦截；混合内容（图片+其他文件）只处理图片，
          // 不阻止默认行为，让浏览器/编辑器处理其他文件。
          if (imageFiles.length === fileArray.length) {
            event.preventDefault();
          }
          for (const file of imageFiles) {
            onImagePasteRef.current?.(file);
          }
          return imageFiles.length === fileArray.length;
        },
      },
    });
  });
}

/**
 * 代码块内 Tab 键缩进：在 code_block 节点中插入两个空格而非移动焦点。
 */
function createCodeBlockTabPlugin() {
  return $prose(() => {
    return keymap({
      Tab: (state, dispatch) => {
        const { $head } = state.selection;
        // 仅在代码块内拦截 Tab
        for (let d = $head.depth; d > 0; d--) {
          if ($head.node(d).type.name === "code_block") {
            if (dispatch) {
              dispatch(state.tr.insertText("  ", $head.pos));
            }
            return true;
          }
        }
        return false;
      },
    });
  });
}

/**
 * 空文档占位符插件：文档仅含一个空段落时添加 CSS class。
 */
function createPlaceholderPlugin() {
  return $prose(() => {
    return new Plugin({
      key: new PluginKey("MILKDOWN_PLACEHOLDER"),
      props: {
        decorations: (state) => {
          const { doc } = state;
          if (
            doc.childCount === 1 &&
            doc.firstChild?.type.name === "paragraph" &&
            doc.firstChild.content.size === 0
          ) {
            return DecorationSet.create(doc, [
              Decoration.node(0, 2, { class: "is-editor-empty", "data-placeholder": "开始写作…" }),
            ]);
          }
          return null;
        },
      },
    });
  });
}

/**
 * 内部组件：在 MilkdownProvider 内部使用 useEditor 创建编辑器实例。
 */
function MilkdownInner({
  initialMarkdown,
  onChange,
  disabled,
  onImagePaste,
}: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const onImagePasteRef = useRef(onImagePaste);
  onImagePasteRef.current = onImagePaste;
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialMarkdown);
        // listener 必须用方法调用，不能赋值
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChangeRef.current(markdown);
        });
        // 通过 editorViewOptionsCtx 控制只读状态（Milkdown 没有 setEditable 方法）
        // 同时设置 ARIA 属性，提升可访问性
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => !disabledRef.current,
          attributes: {
            ...prev.attributes,
            "aria-label": "笔记正文编辑区",
            "aria-multiline": "true",
          },
        }));
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)
      .use(history)
      .use(clipboard)
      .use(createImageUploadPlugin(onImagePasteRef))
      .use(createCodeBlockTabPlugin())
      .use(createPlaceholderPlugin())
  );

  // ProseMirror 的 ensureEditable() 仅在 view 创建和 view.update() 时调用。
  // 当 disabled 从 true 变为 false 时（例如 ownerLoading 完成后），
  // disabledRef.current 已更新但 .ProseMirror DOM 的 contenteditable 属性
  // 不会自动同步，导致编辑器保持只读、无法输入。此处手动同步属性。
  useEffect(() => {
    const dom = wrapperRef.current?.querySelector<HTMLElement>(".ProseMirror");
    if (dom) {
      dom.contentEditable = disabled ? "false" : "true";
    }
  }, [disabled]);

  return (
    <div className="milkdown-editor" ref={wrapperRef}>
      <Milkdown />
    </div>
  );
}

/**
 * 控制层组件：在 MilkdownProvider 内通过 useInstance 获取 editor 实例，
 * 将操作方法暴露给父组件。
 *
 * 关键：handle 和外部 ref 的同步必须在 useEffect 中完成。
 * useInstance 返回的 loading 从 true→false 时，MilkdownControls 自身会
 * 重渲染，但父组件 MilkdownEditor 不会，因此在父组件 render 中同步 ref
 * 会导致外部 ref 过期（始终为 null）。useEffect 确保 loading 变化后
 * handle 和外部 ref 都能正确更新。
 */
function MilkdownControls({
  handleRef,
  externalRef,
}: {
  handleRef: React.MutableRefObject<MilkdownEditorHandle | null>;
  externalRef?: React.Ref<MilkdownEditorHandle | null>;
}) {
  const [loading, getInstance] = useInstance();

  useEffect(() => {
    const writeExternalRef = (value: MilkdownEditorHandle | null) => {
      if (!externalRef) return;
      if (typeof externalRef === "function") {
        externalRef(value);
      } else {
        (externalRef as React.MutableRefObject<MilkdownEditorHandle | null>).current = value;
      }
    };

    const handle: MilkdownEditorHandle | null = loading
      ? null
      : {
          getMarkdown: () => {
            const editor = getInstance();
            return withReadyMilkdownEditor(
              editor,
              (readyEditor) => readyEditor.action(getMarkdown()),
              null,
            );
          },
          setMarkdown: (md, flush) => {
            const editor = getInstance();
            withReadyMilkdownEditor(
              editor,
              (readyEditor) => readyEditor.action(replaceAll(md, flush)),
              undefined,
            );
          },
          focus: () => {
            const editor = getInstance();
            withReadyMilkdownEditor(
              editor,
              (readyEditor) => readyEditor.action((ctx) => {
                ctx.get(editorViewCtx).focus();
              }),
              undefined,
            );
          },
          insertText: (text) => {
            const editor = getInstance();
            withReadyMilkdownEditor(
              editor,
              (readyEditor) => readyEditor.action(insert(text)),
              undefined,
            );
          },
          replaceImageSrc: (oldSrc, newSrc) => {
            const editor = getInstance();
            withReadyMilkdownEditor(
              editor,
              (readyEditor) => readyEditor.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                const { state } = view;
                let tr = state.tr;
                state.doc.descendants((node, pos) => {
                  if (node.type.name === "image" && node.attrs.src === oldSrc) {
                    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: newSrc, alt: "" });
                  }
                });
                if (tr.docChanged) view.dispatch(tr);
              }),
              undefined,
            );
          },
          toggleBold: () => {
            const editor = getInstance();
            withReadyMilkdownEditor(editor, (readyEditor) => readyEditor.action(callCommand(toggleStrongCommand.key)), undefined);
          },
          toggleItalic: () => {
            const editor = getInstance();
            withReadyMilkdownEditor(editor, (readyEditor) => readyEditor.action(callCommand(toggleEmphasisCommand.key)), undefined);
          },
          toggleInlineCode: () => {
            const editor = getInstance();
            withReadyMilkdownEditor(editor, (readyEditor) => readyEditor.action(callCommand(toggleInlineCodeCommand.key)), undefined);
          },
          toggleHeading: (level) => {
            const editor = getInstance();
            withReadyMilkdownEditor(editor, (readyEditor) => readyEditor.action(callCommand(wrapInHeadingCommand.key, level)), undefined);
          },
          toggleBlockquote: () => {
            const editor = getInstance();
            withReadyMilkdownEditor(editor, (readyEditor) => readyEditor.action(callCommand(wrapInBlockquoteCommand.key)), undefined);
          },
          toggleBulletList: () => {
            const editor = getInstance();
            withReadyMilkdownEditor(editor, (readyEditor) => readyEditor.action(callCommand(wrapInBulletListCommand.key)), undefined);
          },
          toggleOrderedList: () => {
            const editor = getInstance();
            withReadyMilkdownEditor(editor, (readyEditor) => readyEditor.action(callCommand(wrapInOrderedListCommand.key)), undefined);
          },
          toggleLink: (href) => {
            const editor = getInstance();
            withReadyMilkdownEditor(editor, (readyEditor) => readyEditor.action(callCommand(toggleLinkCommand.key, { href })), undefined);
          },
          insertHr: () => {
            const editor = getInstance();
            withReadyMilkdownEditor(editor, (readyEditor) => readyEditor.action(callCommand(insertHrCommand.key)), undefined);
          },
        };

    handleRef.current = handle;
    writeExternalRef(handle);

    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      writeExternalRef(null);
    };
  }, [loading, getInstance, handleRef, externalRef]);

  return null;
}

/**
 * 对外组件：通过 ref prop 暴露 MilkdownEditorHandle（React 19 支持 ref 作为普通 prop）。
 * 内部用 MilkdownProvider 包裹编辑器和控制层。
 */
export const MilkdownEditor = ({
  initialMarkdown,
  onChange,
  disabled,
  onImagePaste,
  ref,
}: Props & { ref?: React.Ref<MilkdownEditorHandle | null> }) => {
  const handleRef = useRef<MilkdownEditorHandle | null>(null);

  return (
    <MilkdownProvider>
      <MilkdownInner
        initialMarkdown={initialMarkdown}
        onChange={onChange}
        disabled={disabled}
        onImagePaste={onImagePaste}
      />
      <MilkdownControls handleRef={handleRef} externalRef={ref} />
    </MilkdownProvider>
  );
};
