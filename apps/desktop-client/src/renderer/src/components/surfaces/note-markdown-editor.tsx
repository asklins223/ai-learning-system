import { useEffect, useRef, useState } from "react";
import {
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  defaultValueCtx,
  rootCtx,
} from "@milkdown/kit/core";
import {
  commonmark,
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { history } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { $prose, callCommand, getMarkdown, insert, replaceAll } from "@milkdown/kit/utils";
import { keymap } from "@milkdown/kit/prose/keymap";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import { sourceImageObjectKeyFromUrl } from "@ailearn/shared/source-image-contracts";
import { loadSourceImageBlobUrl } from "./source-image";
import { LightboxViewer } from "./image-viewer";
import "@milkdown/kit/prose/view/style/prosemirror.css";

/**
 * 笔记正文的所见即所得编辑器（Milkdown）。
 *
 * 这里用的是 Web 端笔记编辑器那一套：CommonMark + GFM 的 ProseMirror 文档、
 * `history` 承担撤销栈、`listener` 把整篇 Markdown 交出去，正文本身是**真
 * Markdown**——`#`、`> `、`- `、围栏都由编辑器自己写，不再靠工具按钮往纯文本里
 * 拼标记。保存合同存的仍是分类型的块，换算在 `note-blocks.ts` 里收口。
 *
 * 三个自有插件补上写作时的实际需要：
 * - 图片粘贴/拖拽拦截：剪贴板或拖拽里只要有图片就交给父组件上传，正文里先落一个
 *   占位地址，上传完成后原位换成服务端确认的站内地址；
 * - 代码块内 Tab：插两个空格，而不是把焦点移出编辑器；
 * - 空文档占位符：`data-placeholder` 由 CSS 画出来。
 *
 * 命令式操作（工具栏按钮、图片上传后回填）通过 `ref` 暴露的 handle 完成。Web 端
 * 那套 handle 的形状原样保留，因为它已经在真实使用中定过型。
 */
export type NoteMarkdownEditorHandle = {
  /** 当前整篇 Markdown；编辑器尚未就绪时返回 null。 */
  readonly getMarkdown: () => string | null;
  /** 整体替换。`flush` 为真时同时清掉撤销历史（用于外部同步）。 */
  readonly setMarkdown: (markdown: string, flush?: boolean) => void;
  readonly focus: () => void;
  /** 在光标处插入文本，Markdown 语法会被解析渲染。 */
  readonly insertText: (text: string) => void;
  /** 就地替换图片地址，用于上传完成后把占位地址换成真地址。 */
  readonly replaceImageSrc: (oldSrc: string, newSrc: string) => void;
  readonly toggleStrong: () => void;
  readonly toggleEmphasis: () => void;
  readonly toggleInlineCode: () => void;
  readonly toggleHeading: (level: number) => void;
  readonly toggleBlockquote: () => void;
  readonly toggleBulletList: () => void;
  readonly toggleOrderedList: () => void;
  readonly toggleLink: (href: string) => void;
  readonly insertCodeBlock: () => void;
  readonly insertHr: () => void;
};

type Props = {
  readonly initialMarkdown: string;
  readonly onChange: (markdown: string) => void;
  readonly disabled?: boolean;
  /** 图片粘贴/拖拽回调，上传由父组件负责。 */
  readonly onImagePaste?: (file: File) => void;
  readonly ref?: React.Ref<NoteMarkdownEditorHandle | null>;
};

/**
 * Milkdown 在卸载时会异步销毁自己的 context，一个 React ref 可能比它活得久一点。
 * 每个命令式操作都先确认 editor 仍然就绪，并容忍这次竞态。
 */
function withReadyEditor<TEditor extends { readonly status: string }, TResult>(
  editor: TEditor | undefined,
  operation: (readyEditor: TEditor) => TResult,
  fallback: TResult,
): TResult {
  if (!editor || editor.status !== "Created") return fallback;
  try {
    return operation(editor);
  } catch {
    return fallback;
  }
}

/**
 * 图片粘贴/拖拽拦截。
 *
 * 只有整份剪贴板/拖拽内容都是图片时才拦截。图片与文本混在一起（例如从网页复制
 * 一段带图的内容）交回 ProseMirror 走正常粘贴，否则会连文字一起丢掉。
 */
function imageUploadPlugin(onImagePaste: React.RefObject<((file: File) => void) | undefined>) {
  return $prose(() => new Plugin({
    key: new PluginKey("NOTE_IMAGE_UPLOAD"),
    props: {
      handlePaste(_view, event) {
        const items = event.clipboardData?.items;
        if (!items) return false;
        const all = Array.from(items);
        const images = all.filter((item) => item.type.startsWith("image/"));
        if (images.length === 0 || images.length < all.length) return false;
        for (const item of images) {
          const file = item.getAsFile();
          if (!file) continue;
          onImagePaste.current?.(file);
          event.preventDefault();
        }
        return true;
      },
      handleDrop(_view, event) {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const all = Array.from(files);
        const images = all.filter((file) => file.type.startsWith("image/"));
        if (images.length === 0) return false;
        if (images.length === all.length) event.preventDefault();
        for (const file of images) onImagePaste.current?.(file);
        return images.length === all.length;
      },
    },
  }));
}

/**
 * 图片节点视图。
 *
 * 正文里的图有两种地址，`<img>` 都画不出来：
 * - `/api/uploads/{objectKey}` 是站内对象，渲染层的 origin 是 `ailearn-app://`，
 *   这个相对路径会落到应用包内；这里按 objectKey 走共享的字节缓存换成 blob URL。
 * - `uploading:{id}` 是上传中的占位地址，交给 CSS 画成一块虚线格子（见
 *   `hud-surface.css` 的 `img[src^="uploading:"]`）。
 *
 * 节点视图只负责把 src 落成能加载的那个；节点属性本身仍归 ProseMirror 所有，
 * 所以上传完成后只改一次节点属性，DOM 会自己跟上。
 *
 * 点击图片交给 React 侧的灯箱放大（`image-viewer.tsx`，经 ref 回调，与
 * `onImagePaste` 同一个模式）。不拦默认行为：ProseMirror 照常把节点选中，灯箱
 * 关掉后这张图仍处于选中态，按 Delete 即可删除。
 */
function imageNodeViewPlugin(
  onImageZoom: React.RefObject<((src: string, alt: string) => void) | undefined>,
) {
  return $prose(() => new Plugin({
    key: new PluginKey("NOTE_IMAGE_VIEW"),
    props: {
      nodeViews: {
        image: ((initialNode) => {
          const dom = document.createElement("img");
          dom.setAttribute("draggable", "false");
          dom.addEventListener("click", () => {
            // `dom.src` 是解析后的绝对地址（blob: 或外链）；还在取字节的图没有
            // src，点了也不会开出空灯箱。
            if (dom.src) onImageZoom.current?.(dom.src, dom.alt);
          });
          let disposed = false;
          let shown = "";
          let retryTimer: ReturnType<typeof setTimeout> | null = null;

          // 只有真的画得出来的图（blob / 外链）才提示可点；上传占位与取字节失败
          // 的图不提示。
          const markZoomable = (src: string) => {
            dom.classList.toggle("note-image-zoomable", /^(https?:|blob:)/i.test(src));
          };

          const show = (src: string, alt: string, attempt = 0) => {
            dom.alt = alt;
            if (src === shown && attempt === 0) return;
            shown = src;
            dom.removeAttribute("src");
            const objectKey = sourceImageObjectKeyFromUrl(src);
            if (!objectKey) {
              dom.classList.remove("note-image-unavailable");
              if (src) dom.src = src;
              markZoomable(src);
              return;
            }
            void loadSourceImageBlobUrl(objectKey).then((blobUrl) => {
              if (disposed || shown !== src) return;
              if (blobUrl) {
                dom.classList.remove("note-image-unavailable");
                dom.src = blobUrl;
                markZoomable(blobUrl);
                return;
              }
              // 取字节失败多半是瞬时的（API 正在重启、网络抖动）：退避重试。
              // 重试真正重取的前提是失败结果不驻留缓存（见 source-image.ts）。
              dom.classList.add("note-image-unavailable");
              markZoomable("");
              if (attempt >= 2) return;
              if (retryTimer) clearTimeout(retryTimer);
              retryTimer = setTimeout(() => {
                if (!disposed && shown === src) show(src, alt, attempt + 1);
              }, 1200 * (attempt + 1));
            });
          };
          const apply = (node: { readonly attrs: Record<string, unknown> }) => {
            show(String(node.attrs.src ?? ""), String(node.attrs.alt ?? ""));
          };
          apply(initialNode);

          return {
            dom,
            update: (next: { readonly type: { readonly name: string }; readonly attrs: Record<string, unknown> }) => {
              if (next.type.name !== "image") return false;
              apply(next);
              return true;
            },
            ignoreMutation: () => true,
            destroy: () => {
              disposed = true;
              if (retryTimer) clearTimeout(retryTimer);
            },
          };
        }),
      },
    },
  }));
}

/** 代码块内的 Tab 是缩进，不是焦点跳走。 */
function codeBlockTabPlugin() {
  return $prose(() => keymap({
    Tab: (state, dispatch) => {
      const { $head } = state.selection;
      for (let depth = $head.depth; depth > 0; depth -= 1) {
        if ($head.node(depth).type.name === "code_block") {
          if (dispatch) dispatch(state.tr.insertText("  ", $head.pos));
          return true;
        }
      }
      return false;
    },
  }));
}

/** 空文档的占位提示：只含一个空段落时给节点挂上 CSS class。 */
function placeholderPlugin() {
  return $prose(() => new Plugin({
    key: new PluginKey("NOTE_EDITOR_PLACEHOLDER"),
    props: {
      decorations: (state) => {
        const { doc } = state;
        const empty = doc.childCount === 1
          && doc.firstChild?.type.name === "paragraph"
          && doc.firstChild.content.size === 0;
        if (!empty) return null;
        return DecorationSet.create(doc, [
          Decoration.node(0, 2, { class: "note-editor-empty", "data-placeholder": "继续写下结论……" }),
        ]);
      },
    },
  }));
}

function MilkdownBody({ initialMarkdown, onChange, disabled, onImagePaste }: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const onImagePasteRef = useRef(onImagePaste);
  onImagePasteRef.current = onImagePaste;
  // 图片节点的点击放大：节点视图是命令式 DOM，经 ref 把点击交给 React 渲染灯箱。
  const onImageZoomRef = useRef<((src: string, alt: string) => void) | undefined>(undefined);
  onImageZoomRef.current = (src, alt) => setZoom({ src, alt });
  const [zoom, setZoom] = useState<{ readonly src: string; readonly alt: string } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEditor((root) => Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, initialMarkdown);
      // listener 必须按方法调用，不能整体赋值。
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        onChangeRef.current(markdown);
      });
      // Milkdown 没有 setEditable 方法，只读状态经 editorViewOptionsCtx 声明。
      ctx.update(editorViewOptionsCtx, (previous) => ({
        ...previous,
        editable: () => !disabledRef.current,
        attributes: {
          ...previous.attributes,
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
    .use(imageUploadPlugin(onImagePasteRef))
    .use(imageNodeViewPlugin(onImageZoomRef))
    .use(codeBlockTabPlugin())
    .use(placeholderPlugin()));

  // ProseMirror 的 ensureEditable() 只在 view 创建与 view.update() 时执行。
  // disabled 由 true 变 false 时（例如这一版笔记刚读回来）contenteditable 不会
  // 自己同步，编辑器会停在只读；这里手动补上属性。
  useEffect(() => {
    const dom = wrapperRef.current?.querySelector<HTMLElement>(".ProseMirror");
    if (dom) dom.contentEditable = disabled ? "false" : "true";
  }, [disabled]);

  return (
    <div className="note-editor" ref={wrapperRef}>
      <Milkdown />
      {zoom ? (
        <LightboxViewer alt={zoom.alt} count={1} index={0} onClose={() => setZoom(null)}>
          <img src={zoom.src} alt={zoom.alt} />
        </LightboxViewer>
      ) : null}
    </div>
  );
}

/**
 * 控制层：在 provider 内部拿 editor 实例，把命令式操作写进 ref。
 *
 * 同步必须发生在 useEffect 里。`useInstance` 的 loading 由 true 变 false 时只有
 * 本组件重渲染，父组件不会，所以在父组件 render 阶段写 ref 会让外部 ref 一直
 * 停在 null。
 */
function MilkdownControls({
  handleRef,
  externalRef,
}: {
  readonly handleRef: React.RefObject<NoteMarkdownEditorHandle | null>;
  readonly externalRef?: React.Ref<NoteMarkdownEditorHandle | null>;
}) {
  const [loading, getInstance] = useInstance();

  useEffect(() => {
    const writeExternal = (value: NoteMarkdownEditorHandle | null) => {
      if (!externalRef) return;
      if (typeof externalRef === "function") externalRef(value);
      else (externalRef as React.RefObject<NoteMarkdownEditorHandle | null>).current = value;
    };

    /** 每个命令都走同一条「就绪才执行、竞态就放弃」的路。 */
    const run = <T,>(operation: (editor: NonNullable<ReturnType<typeof getInstance>>) => T) => {
      const editor = getInstance();
      withReadyEditor(editor, operation, undefined);
    };
    const command = (...args: readonly unknown[]) => (editor: NonNullable<ReturnType<typeof getInstance>>) => {
      editor.action(callCommand(args[0] as string, ...args.slice(1)));
    };

    const handle: NoteMarkdownEditorHandle | null = loading ? null : {
      getMarkdown: () => withReadyEditor(
        getInstance(),
        (editor) => editor.action(getMarkdown()),
        null,
      ),
      setMarkdown: (markdown, flush) => run((editor) => editor.action(replaceAll(markdown, flush))),
      focus: () => run((editor) => editor.action((ctx) => { ctx.get(editorViewCtx).focus(); })),
      insertText: (text) => run((editor) => editor.action(insert(text))),
      replaceImageSrc: (oldSrc, newSrc) => run((editor) => editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        let transaction = state.tr;
        state.doc.descendants((node, pos) => {
          if (node.type.name === "image" && node.attrs.src === oldSrc) {
            transaction = transaction.setNodeMarkup(pos, undefined, { ...node.attrs, src: newSrc, alt: "" });
          }
        });
        if (transaction.docChanged) view.dispatch(transaction);
      })),
      toggleStrong: () => run(command(toggleStrongCommand.key)),
      toggleEmphasis: () => run(command(toggleEmphasisCommand.key)),
      toggleInlineCode: () => run(command(toggleInlineCodeCommand.key)),
      toggleHeading: (level) => run(command(wrapInHeadingCommand.key, level)),
      toggleBlockquote: () => run(command(wrapInBlockquoteCommand.key)),
      toggleBulletList: () => run(command(wrapInBulletListCommand.key)),
      toggleOrderedList: () => run(command(wrapInOrderedListCommand.key)),
      toggleLink: (href) => run(command(toggleLinkCommand.key, { href })),
      insertCodeBlock: () => run(command(createCodeBlockCommand.key)),
      insertHr: () => run(command(insertHrCommand.key)),
    };

    handleRef.current = handle;
    writeExternal(handle);
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      writeExternal(null);
    };
  }, [loading, getInstance, handleRef, externalRef]);

  return null;
}

/**
 * 笔记正文编辑器。`defaultValueCtx` 只在创建时读一次，所以换笔记、恢复历史版本
 * 这类外部替换由调用方经 ref 的 `setMarkdown` 完成，而不是靠改 props。
 */
export function NoteMarkdownEditor({
  initialMarkdown,
  onChange,
  disabled,
  onImagePaste,
  ref,
}: Props) {
  const handleRef = useRef<NoteMarkdownEditorHandle | null>(null);

  return (
    <MilkdownProvider>
      <MilkdownBody
        initialMarkdown={initialMarkdown}
        onChange={onChange}
        disabled={disabled}
        onImagePaste={onImagePaste}
      />
      <MilkdownControls handleRef={handleRef} externalRef={ref} />
    </MilkdownProvider>
  );
}
