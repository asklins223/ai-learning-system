# Milkdown WYSIWYG 编辑器接入方案

> **状态**：已实施
> **日期**：2026-07-26
> **关联**：笔记编辑页（`apps/web/components/NoteEditor.tsx`）

## 1. 背景

当前笔记编辑器有三种模式：`live`（逐块渲染）、`edit`（纯 textarea）、`preview`（只读渲染）。其中 `edit` 模式是纯 `<textarea>` 的传统模式——用户在 textarea 里写 Markdown 代码，手动切换到"预览"才能看到渲染效果。`live` 模式尝试了逐块编辑（per-block textarea/rendered，非活动块用 `MarkdownPreview` 渲染），但体验像填空一样不自然。注意：`live` 模式当前已是死代码——工具栏只有"写作"和"预览"两个按钮，UI 无入口触发 `live` 模式，但相关代码仍在 `NoteEditor.tsx` 中。

用户希望实现 Typora 式的所见即所得体验——打字时 Markdown 自动内联渲染（输入图片代码后直接显示图片、标题代码后直接显示为标题），同时可切换纯代码模式。

之前尝试了三种自建方案均不可行：
1. **分屏**（textarea + preview 并排）——用户否决
2. **全局切换**（debounce 后 textarea ↔ rendered 全量 swap）——整篇文档闪动
3. **逐块编辑**（per-block textarea/rendered，即当前 `live` 模式）——像填空一样不自然

结论：自建 WYSIWYG 引擎不现实，需要引入专业编辑器框架。

## 2. 选型对比

| 维度 | Milkdown | Lexical |
|------|----------|---------|
| 定位 | 专为 Markdown 设计的 WYSIWYG 编辑器 | 通用文本编辑器框架 |
| 底层引擎 | ProseMirror + Remark | 自研虚拟 DOM reconciler |
| 包体积（gzip） | ~70kb（核心+常用插件） | ~22kb（核心） |
| Markdown 序列化 | ✅ 内置（基于 Remark，双向） | ❌ 需自行实现 Node ↔ Markdown |
| 图片/代码块/引用 | ✅ 内置插件 | 需自定义 Node 类型 |
| React 绑定 | `@milkdown/react` | `@lexical/react` |
| 与现有生态兼容 | 基于 Remark（与项目 `MarkdownPreview` 手写解析器不同生态） | 无关 |
| GitHub Stars | ~12k | ~20k |
| 维护方 | 社区 | Meta/Facebook |

### 决定：Milkdown

**理由**：
1. 开箱即用的 Markdown WYSIWYG——输入 `![alt](url)` 立即显示图片，输入 `# 标题` 立即渲染为标题
2. 基于 Remark 生态（注：项目现有 `MarkdownPreview` 是手写 token 解析器，非 Remark 生态，后续可统一替换为 Milkdown 的渲染能力）
3. 内置 Markdown 双向序列化，存储格式不变（纯 Markdown 文本），后端 API 无需改动
4. 插件化架构，可逐步加功能（slash 命令、协作编辑等）

## 3. 安装依赖

```bash
cd apps/web
npm install @milkdown/kit@^7.21.0 @milkdown/react@^7.21.0 @milkdown/theme-nord@^7.21.0
```

> 注意：`@milkdown/kit` 是 7.x 的统一入口，通过 subpath exports 提供了 `core`、`ctx`、`prose`、`transformer`、`utils`、`preset/commonmark`、`preset/gfm`、`plugin/history`、`plugin/listener`、`plugin/clipboard`、`plugin/upload` 等子路径，无需单独安装这些分散包。旧版（6.x）用分散包名，本项目以 7.21+ 为准。

## 4. 实施步骤

### 阶段 1：封装 MilkdownEditor 组件

**新建** `apps/web/components/MilkdownEditor.tsx`

使用 `@milkdown/react` 提供的 `MilkdownProvider` + `useEditor` + `useInstance` hooks 进行 React 集成，而非 vanilla JS 的 `Editor.make()` + `useRef` 模式（编辑器是异步创建的，必须通过 hooks 获取实例）。

```tsx
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
} from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { history } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { getMarkdown, insert, replaceAll, callCommand } from "@milkdown/kit/utils";
import { nord } from "@milkdown/theme-nord";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import "@milkdown/theme-nord/style.css";
import "@milkdown/kit/prose/view/style/prosemirror.css";

export interface MilkdownEditorHandle {
  /** 获取当前 Markdown 文本 */
  getMarkdown: () => string;
  /** 替换全部内容 */
  setMarkdown: (md: string) => void;
  /** 聚焦编辑器 */
  focus: () => void;
  /** 在光标处插入文本（Markdown 语法会被解析渲染） */
  insertText: (text: string) => void;
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
}

interface Props {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
}

/**
 * 内部组件：在 MilkdownProvider 内部使用 useEditor 创建编辑器实例。
 */
function MilkdownInner({
  initialMarkdown,
  onChange,
  disabled,
}: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const { get } = useEditor((root) =>
    Editor.make()
      .config(nord)
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialMarkdown);
        // listener 必须用方法调用，不能赋值
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChangeRef.current(markdown);
        });
        // 通过 editorViewOptionsCtx 控制只读状态（Milkdown 没有 setEditable 方法）
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => !disabledRef.current,
        }));
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)
      .use(history)
      .use(clipboard)
  );

  return <Milkdown />;
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
    const handle: MilkdownEditorHandle | null = loading
      ? null
      : {
          getMarkdown: () => {
            const editor = getInstance();
            return editor ? editor.action(getMarkdown()) : "";
          },
          setMarkdown: (md) => {
            const editor = getInstance();
            editor?.action(replaceAll(md));
          },
          focus: () => {
            const editor = getInstance();
            editor?.action((ctx) => {
              ctx.get(editorViewCtx).focus();
            });
          },
          insertText: (text) => {
            const editor = getInstance();
            editor?.action(insert(text));
          },
          toggleBold: () => {
            const editor = getInstance();
            editor?.action(callCommand(toggleStrongCommand.key));
          },
          toggleItalic: () => {
            const editor = getInstance();
            editor?.action(callCommand(toggleEmphasisCommand.key));
          },
          toggleInlineCode: () => {
            const editor = getInstance();
            editor?.action(callCommand(toggleInlineCodeCommand.key));
          },
          toggleHeading: (level) => {
            const editor = getInstance();
            editor?.action(callCommand(wrapInHeadingCommand.key, level));
          },
          toggleBlockquote: () => {
            const editor = getInstance();
            editor?.action(callCommand(wrapInBlockquoteCommand.key));
          },
          toggleBulletList: () => {
            const editor = getInstance();
            editor?.action(callCommand(wrapInBulletListCommand.key));
          },
          toggleOrderedList: () => {
            const editor = getInstance();
            editor?.action(callCommand(wrapInOrderedListCommand.key));
          },
          toggleLink: (href) => {
            const editor = getInstance();
            editor?.action(callCommand(toggleLinkCommand.key, { href }));
          },
        };

    handleRef.current = handle;
    if (externalRef) {
      if (typeof externalRef === "function") {
        externalRef(handle);
      } else {
        (externalRef as React.MutableRefObject<MilkdownEditorHandle | null>).current = handle;
      }
    }
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
  ref,
}: Props & { ref?: React.Ref<MilkdownEditorHandle | null> }) => {
  const handleRef = useRef<MilkdownEditorHandle | null>(null);

  return (
    <MilkdownProvider>
      <MilkdownInner
        initialMarkdown={initialMarkdown}
        onChange={onChange}
        disabled={disabled}
      />
      <MilkdownControls handleRef={handleRef} externalRef={ref} />
    </MilkdownProvider>
  );
};
```

**关键点**：
- 使用 `@milkdown/react` 的 `useEditor` + `useInstance` + `<Milkdown />` 进行 React 集成，`useInstance` 必须在 `MilkdownProvider` 内部使用
- `initialMarkdown` 通过 `defaultValueCtx` 设置，只在编辑器创建时生效
- `getMarkdown()` 使用 `@milkdown/kit/utils` 的 `getMarkdown` 宏，供自动保存读取最新内容
- `setMarkdown()` 使用 `replaceAll` 宏，供冲突恢复、模板插入等场景替换全文
- `insertText()` 使用 `@milkdown/kit/utils` 的 `insert` 宏，供图片上传后插入 Markdown 图片语法
- `disabled` 状态：通过 `editorViewOptionsCtx` 的 `editable` 回调控制（Milkdown 没有 `setEditable` 方法）
- `nord` 是 config 函数，必须用 `.config(nord)` 而非 `.use(nord)`
- `@milkdown/kit/prose/view/style/prosemirror.css` 是 ProseMirror 必需的基础 CSS，必须导入
- 编辑器是**异步创建**的，`useInstance` 返回的 `loading` 为 `true` 时实例尚不可用，所有操作方法需判空
- `onChange` 和 `disabled` 用 ref 镜像，避免编辑器重建
- **`onChange` 有 200ms 延迟**：listener 插件内部对 `markdownUpdated` 事件做了 200ms debounce（源码 `debounce(..., 200)`），因此 `onChange` 不是同步触发的。现有 `scheduleSave` 有 2.5s 防抖，叠加 listener 的 200ms 后总计约 2.7s，影响可忽略；但冲突检测等需要即时获取最新内容的场景应通过 `editorRef.current?.getMarkdown()` 主动读取，而非依赖 `source` state
- **ref 同步必须在 `useEffect` 中完成**：`useInstance` 返回的 `loading` 从 `true` → `false` 时，`MilkdownControls` 自身会重渲染，但父组件 `MilkdownEditor` 不会重渲染。若在父组件 render 中同步 ref，外部 ref 会过期（始终为 `null`）。通过 `useEffect` 确保 `loading` 变化后 handle 和外部 ref 都能正确更新
- `focus()` 通过 `editorViewCtx`（从 `@milkdown/kit/core` 导入）获取 ProseMirror `EditorView` 实例，不要用字符串 key hack
- commonmark preset 已内置加粗、斜体、行内代码、标题、引用、列表、链接等 command，直接 import 使用即可，无需用 `$command` 自定义（详见阶段 3）

### 阶段 2：替换 NoteEditor 中的编辑模式

**修改** `apps/web/components/NoteEditor.tsx`

```tsx
// 替换 textarea 为 MilkdownEditor
{mode === "edit" ? (
  <div className="ne-editor-pane">
    <MilkdownEditor
      ref={editorRef}
      initialMarkdown={initialMarkdown}
      onChange={(md) => updateSource(md)}
      disabled={ownerLoading || !isOwner || leaving || deleting || restoring || generationLocked || saving === "deleted"}
    />
  </div>
) : mode === "preview" ? (
  // 预览模式不变
  <div className="ne-editor-pane ne-editor-preview">
    <NoteArticlePreview ... />
  </div>
) : null}
```

**需要调整的现有函数**：

| 函数 | 当前实现 | 改为 |
|------|---------|------|
| `updateSource(next)` | `setSource(next)` + `scheduleSave()` | 不变（Milkdown `onChange` 直接传入 Markdown） |
| `applyWrap(prefix, suffix)` | 操作 `textareaRef.current.selectionStart/End` | 对应内置 command（加粗→`toggleBold`、斜体→`toggleItalic`、代码→`toggleInlineCode`、链接→`toggleLink`） |
| `applyLinePrefix(prefix)` | 操作 textarea 行 | 对应内置 command（标题→`toggleHeading`、引用→`toggleBlockquote`、列表→`toggleBulletList`/`toggleOrderedList`） |
| `insertAtCursor(text)` | textarea `setSelectionRange` | `editorRef.current.insertText(text)` |
| `uploadAndInsertImage(file)` | `insertAtCursor(placeholder)` → 替换 | `editorRef.current.insertText(placeholder)` → `setMarkdown(updated)` |
| `applyStarterTemplate(template)` | `updateSource(template)` + `changeMode("edit")` + textarea focus/setSelectionRange | `editorRef.current?.setMarkdown(template)` + `editorRef.current?.focus()`（`onChange` 会自动触发 `updateSource`） |
| `onEditorKeyDown` | textarea 快捷键 | Milkdown 内置 `⌘B`/`⌘I` 等快捷键，无需自定义 |
| `handlePaste`/`handleDrop` | textarea 事件 | Milkdown clipboard 插件 + 自定义图片粘贴插件 |

**外部 `source` 同步**：`NoteEditor` 中有多处通过 `setSource()` 直接修改内容（非编辑器输入触发），这些场景都需要额外调用 `editorRef.current?.setMarkdown()` 将新内容同步到 Milkdown 编辑器：

| 场景 | 当前代码位置 | 说明 |
|------|-------------|------|
| 冲突草稿恢复 | `setSource(recovered.source)` | 从 localStorage 恢复本地草稿 |
| 冲突解决—接受服务端版本 | `setSource(conflictData.serverSource)` | 409 冲突后接受服务端内容 |
| 丢弃恢复的草稿 | `setSource(initialMarkdown)` | 丢弃本地草稿，恢复初始内容 |
| 恢复被丢弃的草稿 | `setSource(discardedDraft.source)` | 恢复之前丢弃的本地草稿 |
| 版本回滚 | `setSource(restoredMarkdown)` | `restoreNoteVersion` API 返回后设置内容 |
| 后台轮询静默同步 | `setSource(freshMarkdown)` | 无本地编辑时，后台轮询发现服务端有更新版本，静默同步到最新内容（`NoteEditor.tsx` 第 912 行附近） |

> 注意：`updateSource` 内部的 `setSource` 不需要同步——它由编辑器 `onChange` 触发，内容已经在编辑器中。只有外部直接调用 `setSource` 时才需要 `setMarkdown` 同步。

### 阶段 3：工具栏对接

Milkdown 通过 command 系统操作格式，工具栏按钮改为调用 command。Command 执行需用 `callCommand`（来自 `@milkdown/kit/utils`），传入 command 的 `.key` 属性。

commonmark preset 已内置以下 command（直接 import 使用，无需用 `$command` 自定义）：

| Command | 导出来源 | Payload | 用途 |
|---------|---------|---------|------|
| `toggleStrongCommand` | `@milkdown/kit/preset/commonmark` | — | 加粗 |
| `toggleEmphasisCommand` | `@milkdown/kit/preset/commonmark` | — | 斜体 |
| `toggleInlineCodeCommand` | `@milkdown/kit/preset/commonmark` | — | 行内代码 |
| `wrapInHeadingCommand` | `@milkdown/kit/preset/commonmark` | `number`（标题级别 1-6） | 标题 |
| `wrapInBlockquoteCommand` | `@milkdown/kit/preset/commonmark` | — | 引用 |
| `wrapInBulletListCommand` | `@milkdown/kit/preset/commonmark` | — | 无序列表 |
| `wrapInOrderedListCommand` | `@milkdown/kit/preset/commonmark` | — | 有序列表 |
| `toggleLinkCommand` | `@milkdown/kit/preset/commonmark` | `{ href?: string; title?: string }` | 链接 |
| `downgradeHeadingCommand` | `@milkdown/kit/preset/commonmark` | — | 降级标题 |

GFM preset 额外提供 `toggleStrikethroughCommand`（来自 `@milkdown/kit/preset/gfm`）。

这些 command 已在阶段 1 的 `MilkdownEditorHandle` 中封装为方法，工具栏直接调用即可：

```tsx
// 加粗
<button onClick={() => editorRef.current?.toggleBold()}>加粗</button>

// 斜体
<button onClick={() => editorRef.current?.toggleItalic()}>斜体</button>

// 行内代码
<button onClick={() => editorRef.current?.toggleInlineCode()}>代码</button>

// H1
<button onClick={() => editorRef.current?.toggleHeading(1)}>H1</button>

// 引用
<button onClick={() => editorRef.current?.toggleBlockquote()}>引用</button>

// 无序列表
<button onClick={() => editorRef.current?.toggleBulletList()}>列表</button>

// 链接
<button onClick={() => editorRef.current?.toggleLink("https://example.com")}>链接</button>
```

Handle 中各方法的实现（已用 `callCommand` 包装）：
- `toggleBold()` → `editor.action(callCommand(toggleStrongCommand.key))`
- `toggleItalic()` → `editor.action(callCommand(toggleEmphasisCommand.key))`
- `toggleInlineCode()` → `editor.action(callCommand(toggleInlineCodeCommand.key))`
- `toggleHeading(level)` → `editor.action(callCommand(wrapInHeadingCommand.key, level))`
- `toggleBlockquote()` → `editor.action(callCommand(wrapInBlockquoteCommand.key))`
- `toggleBulletList()` → `editor.action(callCommand(wrapInBulletListCommand.key))`
- `toggleOrderedList()` → `editor.action(callCommand(wrapInOrderedListCommand.key))`
- `toggleLink(href)` → `editor.action(callCommand(toggleLinkCommand.key, { href }))`

> 注意：这些 command 随 `commonmark` / `gfm` 插件注册时自动生效，无需额外在 `Editor.make().use(...)` 中单独注册。若需要 `$command` 自定义新命令（如分隔线插入等 commonmark 未覆盖的格式），可参考 Milkdown 文档中 `$command` 的用法。

### 阶段 4：图片上传

新建 Milkdown 图片上传插件，复用现有 `/api/uploads` 接口。可使用 `@milkdown/kit/plugin/upload` 提供的 upload 插件作为基础，或自定义 ProseMirror 插件拦截 paste/drop 事件：

```tsx
import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";

// 自定义图片粘贴/拖拽处理
const imageUploadPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey("image-upload"),
    props: {
      handlePaste(view, event) {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (!file) continue;
            // 调用 api.uploadImage(file, noteId)
            // 上传完成后通过 view.dispatch 插入图片节点
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
      handleDrop(view, event) {
        // 同理处理拖拽
      },
    },
  });
});

// 注册：Editor.make().use(imageUploadPlugin)
```

> 也可以直接使用 `@milkdown/kit/plugin/upload` 内置的 upload 插件，通过配置自定义上传函数。

### 阶段 5：样式适配

Milkdown 是 headless 的（`@milkdown/theme-nord` 提供基础样式），需要覆盖为项目设计：

新建 `apps/web/app/styles/milkdown-editor.css`：

```css
/* Milkdown 编辑器容器 */
.milkdown-editor {
  min-height: clamp(560px, calc(100dvh - 226px), 900px);
  padding: 34px max(36px, calc((100% - 820px) / 2)) 68px;
  background: var(--color-paper);
  font-family: var(--font-editorial);
  font-size: 17.5px;
  line-height: 1.82;
  color: var(--color-text-secondary);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

/* 标题 */
.milkdown-editor h1 { font-size: 29px; font-weight: 650; margin: 1.2em 0 0.6em; }
.milkdown-editor h2 { font-size: 25px; font-weight: 650; margin: 1.1em 0 0.55em; }
.milkdown-editor h3 { font-size: 21px; font-weight: 650; margin: 1em 0 0.5em; }

/* 图片 */
.milkdown-editor img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 1.6em auto;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: 0 12px 34px color-mix(in srgb, var(--color-text) 8%, transparent);
}

/* 代码块 */
.milkdown-editor pre {
  margin: 1.4em 0;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 20px 22px;
  background: color-mix(in srgb, var(--color-surface-soft) 70%, var(--color-paper));
  font-size: 13.5px;
  line-height: 1.72;
  overflow-x: auto;
}

/* 引用 */
.milkdown-editor blockquote {
  margin: 1.2em 0;
  border-left: 3px solid var(--color-warning);
  border-radius: 0 8px 8px 0;
  padding: 15px 19px;
  background: color-mix(in srgb, var(--color-warning-soft) 38%, var(--color-paper));
  color: var(--color-text-secondary);
}

/* ... 其他元素从 note-editor.css 的 .note-article-body .md-* 迁移 ... */
```

### 阶段 6：清理

- 移除 `NoteEditor.tsx` 中的 `live` 模式相关代码：
  - `splitBlocks` 函数
  - `committedBlocks` / `committedBlocksRef` / `activeBlockIndex` / `activeBlockText` 状态
  - `activateBlock` / `deactivateBlock` / `handleBlockChange` / `commitText` 函数
  - `isUserTypingRef` / `pendingFormatActionRef`
  - `liveFormatClick` 包裹
  - live 模式同步 effect（`committedBlocks` / `activeBlockText` 同步）
  - live 模式待执行格式操作 effect（`pendingFormatActionRef` 消费）
  - live 模式渲染分支（`mode === "live" ? ...`）
  - `textareaRef` / `textareaSelectionRef`（textarea 专属，MilkdownEditor 用 `editorRef` 替代）
- 移除 `note-editor.css` 中的 `.ne-live-*` 规则
- `EditorMode` 类型简化为 `"edit" | "preview"`
- 移除 `MarkdownPreview` 的 import（预览模式仍用 `NoteArticlePreview`）

## 5. 不变的部分

| 模块 | 说明 |
|------|------|
| 后端 API | 存储格式仍为纯 Markdown 文本，无需改动 |
| `NoteArticlePreview` | 预览模式不变 |
| 自动保存逻辑 | `updateSource` → `scheduleSave` → `save` 链路不变 |
| 版本管理 | 版本号、版本历史、回滚逻辑不变 |
| 冲突检测 | 409 冲突 → 本地草稿 → 恢复流程不变 |
| 学习卡生成 | 基于版本触发生成，与编辑器无关 |
| RBAC | 非 owner 只读（`mode = "preview"`）不变 |

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 包体积增加 ~70kb gzip | 首屏加载变慢 | `dynamic import` 懒加载 MilkdownEditor，编辑页才加载 |
| ProseMirror 学习曲线 | 接入初期开发慢 | 先用内置插件，自定义功能留到后续迭代 |
| 光标行为与 textarea 不同 | 用户习惯差异 | Milkdown 光标管理成熟，ProseMirror 广泛验证 |
| 图片上传插件 | 需对接现有接口 | 使用 `$prose` 自定义插件拦截 paste/drop 事件，或用内置 upload 插件 |
| 非法 Markdown 输入 | ProseMirror 可能丢失格式 | Milkdown 的 transformer 有容错处理，序列化保证输出合法 Markdown |
| 编辑器异步创建 | `useInstance` 返回的实例在 `loading=true` 时不可用；父组件不知道 `loading` 何时变化 | 所有操作方法判空；handle 和外部 ref 的同步在 `useEffect` 中完成，确保 `loading` 变化后 ref 不过期 |

## 7. 测试清单

- [ ] 打开有内容的笔记 → 编辑器加载并渲染 Markdown（标题、图片、列表）
- [ ] 输入 `# 标题` → 自动渲染为 H1
- [ ] 输入 `![alt](url)` → 自动显示图片
- [ ] 加粗快捷键 ⌘B → 选中文本加粗
- [ ] 工具栏按钮（标题、引用、列表、链接、行内代码）→ 正确切换格式
- [ ] 编辑器加载后 `editorRef.current` 不为 null（ref 同步正确）
- [ ] 粘贴图片文件 → 自动上传并插入
- [ ] 自动保存 → 停顿 2.5s 后保存，版本号正确
- [ ] 冲突检测 → 409 时弹出冲突对话框
- [ ] 切换预览 → 预览模式正常显示
- [ ] 非 owner 用户 → 默认预览模式，只读
- [ ] 生成学习卡 → 编辑锁定，生成完成后解锁
- [ ] 版本回滚 → 回滚后编辑器内容更新
- [ ] 导出 Markdown → 导出纯 Markdown 文本

## 8. 工时估算

| 阶段 | 内容 | 估时 |
|------|------|------|
| 1 | 封装 MilkdownEditor 组件 | 1.5d |
| 2 | 替换 NoteEditor 编辑模式 | 1d |
| 3 | 工具栏 command 对接 | 0.5d |
| 4 | 图片上传插件 | 0.5d |
| 5 | 样式适配 | 1d |
| 6 | 清理 + 测试 | 0.5d |
| **合计** | | **~5d** |
