# 来源收录简化与 URL 解析修复方案

> 创建日期：2026-07-23
> 状态：Proposed
> 关联文件：`apps/web/app/(workspace)/(default)/sources/page.tsx`、`apps/web/app/(workspace)/(default)/page.tsx`、`apps/web/app/(workspace)/(default)/today/page.tsx`、`apps/api/src/modules/source/schema.ts`、`apps/api/src/modules/source/service.ts`、`apps/api/src/modules/source/routes.ts`、`workers/ai-worker/src/handlers/parse-source.ts`、`packages/shared/src/markdown-parser.ts`、`apps/web/lib/api.ts`
> 关联文档：`docs/plans/ai-worker-latency-optimization.md`

---

## 1. 背景与问题

用户反馈三个核心问题：

### 1.1 快速收录 URL 解析一直失败

首页"快速捕获"和来源资料页都支持通过 URL 创建来源，但 URL 解析频繁失败。经过代码审查，发现以下根因：

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| U1 | **不支持压缩响应** | `parse-source.ts` `requestPinnedUrl()` 第 315–319 行 | 发送 `Accept-Encoding: identity`，但大量现代 Web 服务器（Nginx、Cloudflare）忽略此头强制返回 gzip/br，代码直接 `reject(new Error('unsupported content encoding'))`，导致大量正常网页解析失败 |
| U2 | **超时过短** | `parse-source.ts` 第 21 行 `FETCH_TIMEOUT_MS = 15_000` | 15 秒对部分慢速网站或 CDN 回源不够，尤其跨境访问时 |
| U3 | **HTML 解析过于简陋** | `parse-source.ts` `extractTextFromHtml()` 第 355–375 行 | 纯正则剥离标签，不提取 `<title>`、`<meta>`、`<article>` 等语义信息，导致 URL 来源的标题永远是无意义的 URL 截断 |
| U4 | **无重试机制** | `parse-source.ts` `fetchUrlContent()` | DNS 解析失败、TCP 连接重置等瞬时错误直接失败，无二次尝试 |
| U5 | **SSRF 防护可能误杀** | `parse-source.ts` `resolvePublicAddress()` 第 210–249 行 | 部分 CDN 域名 DNS 返回内网地址（如 Cloudflare WARP、Tailscale），会被误判为私有地址而拒绝 |
| U6 | **User-Agent 可能被拦截** | `parse-source.ts` 第 279 行 | `AILearnBot/0.3` UA 被部分网站的反爬机制拦截，返回 403 |

### 1.2 来源资料页表单过于复杂

当前来源资料页（`sources/page.tsx`）的"新建来源"表单要求用户手动填写：

1. **资料类型**：4 个按钮选择（文本 / Markdown / 代码 / 网页链接）
2. **资料标题**：必填，最长 500 字符
3. **内容或 URL**：根据类型显示不同输入框

而首页"快速捕获"已经实现了更简洁的方式——单个 textarea，自动检测类型和标题。两处入口体验不一致，来源页的复杂表单增加了用户录入摩擦。

### 1.3 标题和类型不会自动提取/修正

- **标题**：创建时由前端截取前 60 字符或用户手动填写，Worker 解析后**从不更新标题**。`packages/shared/src/markdown-parser.ts` 第 91 行已导出 `extractTitleFromBlocks()` 函数（通过 `workers/ai-worker/src/lib/markdown-parser.ts` 的 `export *` re-export 可被 worker 访问），但在 `parse-source.ts` 中完全未被调用。本方案应**复用并扩展**该已有函数，而非新造平行实现。
- **类型**：创建时由前端正则推断或用户手动选择，Worker 解析后**从不修正类型**。例如用户粘贴了一段 Markdown 但被检测为 text，Worker 仍按 text 分段（按双换行切分），丢失标题/列表/代码块结构。

---

## 2. 设计目标

1. **统一录入体验**：来源资料页采用与首页一致的"单 textarea + 自动检测"模式
2. **标题自动提取**：Worker 解析完成后从内容中自动提取标题并回写
3. **类型自动检测**：Worker 解析时根据内容特征自动修正类型
4. **URL 解析成功率提升**：支持压缩响应、延长超时、增加重试、改进 HTML 解析
5. **API 向后兼容**：现有 `createSource` API 签名保持兼容，title 和 type 变为可选

---

## 3. 方案设计

### 3.1 API Schema 改造

**文件**：`apps/api/src/modules/source/schema.ts`

将 `title` 和 `type` 改为可选，统一录入通过 `content` + `url` 二选一实现（无需新增字段）：

```typescript
export const sourceCreateSchema = z.object({
  type: z.enum(["text", "markdown", "code", "url"]).optional(),
  title: z.string().max(500).optional(),
  content: z.string().optional(),
  url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine(
  (data) => {
    // url 或 content 至少一项必须有值
    return Boolean(data.url?.trim() || data.content?.trim());
  },
  { message: "url or content is required" },
);
```

**变更说明**：
- `title` 从 `min(1)` 改为 `optional()`：允许不传标题，由 Worker 解析后自动填充
- `type` 改为 `optional()`：允许不传类型，由 Worker 自动检测
- 去掉了 `type === "url"` 时必须传 `url` 的条件分支——改为统一的"url 或 content 至少一项有值"

**`createSource` service 改造**（`apps/api/src/modules/source/service.ts`）：

```typescript
export async function createSource(
  executor: ApiTransaction,
  workspaceId: string,
  userId: string,
  input: SourceCreateInput,
) {
  // 如果未传 type，前端检测为初步值；Worker 会再次检测并修正
  const detectedType = input.type ?? detectSourceType(input.content ?? "", input.url);
  // 如果未传 title，使用临时占位标题；Worker 解析后会更新
  const title = input.title?.trim() || input.url?.slice(0, 60) || input.content?.split("\n")[0]?.slice(0, 60) || "未命名来源";

  // ⚠️ 关键：原代码用 input.type（必填）判断，改成 optional 后必须用 detectedType。
  //    否则当前端不传 type 时，input.type 为 undefined，
  //    undefined === "url" 永远为 false，URL 抓取（fetchUrlContent）不会触发。
  //    后续 metadata 组装、insert sources、insert jobs 中凡引用 input.type 的
  //    地方都要改为 detectedType。
  const isUrlWithoutContent = detectedType === "url" && !input.content?.trim();

  // metadata 组装中使用 detectedType
  const metadata: Record<string, unknown> = { ...input.metadata };
  if (input.content) metadata.rawContent = input.content;
  if (input.url) metadata.url = input.url;
  // 标记 type 来源，供 Worker 判断是否可修正（详见 §3.3.2）
  metadata.typeSource = input.type ? "manual" : "auto";

  // insert sources 时 type 用 detectedType、title 用上面的 title
  // insert jobs payload 中 isUrlWithoutContent 用 detectedType 计算
  // ... 其余逻辑同原实现，但所有 input.type 引用改为 detectedType
}
```

> **⚠️ 部署依赖关系**：Phase A 内部的 URL 修复（steps 1–3）和 schema 放宽（steps 4–5）
> **可以独立部署**，不存在技术上的原子性约束：
>
> - **只部署 URL 修复（steps 1–3）**：前端仍传 type="url"，`isUrlWithoutContent` 用 `input.type`
>   判断（原代码未改），URL 抓取成功率提升，无破坏性影响。
> - **只部署 schema 放宽（steps 4–5）**：前端仍传 type/title，`detectedType = input.type ?? detectSourceType(...)`
>   中 `input.type` 有值故 `detectedType === input.type`，行为与原实现一致，只是 schema 更宽松。
>
> **真正的硬依赖是 Phase C（前端表单简化）→ Phase A steps 4–5（schema 放宽）**：
> 如果 Phase C 先于 Phase A steps 4–5 部署，前端不传 type → 后端 schema 仍要求 type 必填 → 400 报错。
> 因此 **Phase C 不可先于 Phase A steps 4–5 部署**。
>
> 实践中建议 Phase A 整体部署以简化协调，但技术上 steps 1–3 和 steps 4–5 可分批上线。

新增 `detectSourceType` 工具函数（放在 `source/service.ts` 或 `shared` 中）：

```typescript
export function detectSourceType(content: string, url?: string): "text" | "markdown" | "code" | "url" {
  if (url && /^https?:\/\//.test(url) && !content.trim()) return "url";
  const text = content.trim();
  // 代码检测：常见关键字或大量代码特征
  if (/^(function|const|let|var|class|import|export|def |if __name__|#include|package |public class)/m.test(text)) return "code";
  if (/```/.test(text)) return "markdown"; // 含代码块的按 markdown 处理
  // Markdown 检测：标题、列表、引用等语法
  // ⚠️ 正则与 today/page.tsx 的 detectCaptureType 对齐，要求标记后有空格，
  //    避免 "-5 度" 等以 - 开头的纯文本被误判为 markdown。
  if (/^(#{1,6}\s|>|[-*+]\s|\d+\.\s)/m.test(text) || /\[.+?\]\(.+?\)/.test(text)) return "markdown";
  return "text";
}
```

> **⚠️ 与已有 `detectCaptureType` 的关系**：`apps/web/app/(workspace)/(default)/today/page.tsx`
> 第 167 行已有一个 `detectCaptureType` 函数，逻辑与 `detectSourceType` 高度相似但有差异
> （如 `detectCaptureType` 额外检测 `^[a-zA-Z_$][\w$]*\s*[({]` 等代码特征）。
> Markdown 检测正则已与 `detectCaptureType` 对齐（`/^(#{1,6}\s|>|[-*+]\s|\d+\.\s)/m`），
> 要求标记后有空格，避免 `-5 度` 等以 `-` 开头的纯文本被误判。
> Phase C 简化前端后，`detectCaptureType` 和 `captureTitle`（第 183 行）将变为死代码，
> 应一并清理。建议实施时确认 `detectSourceType` 覆盖了 `detectCaptureType` 的所有检测分支，
> 或将 `detectSourceType` 提取到 `shared` 包中作为前后端共用的单一实现。

> **⚠️ `detectSourceType` 与 `correctSourceType` 的两层检测关系**：方案中存在两个类型检测函数——
> `detectSourceType`（`source/service.ts`，创建时调用）使用简单正则做粗粒度初步检测，
> `correctSourceType`（`parse-source.ts`，Worker 解析时调用）使用多模式评分做细粒度修正。
> 两者检测精度不同是**设计意图**：`detectSourceType` 的职责是快速判断 `isUrlWithoutContent`
> 标记（决定 job payload 中是否需要 `fetchUrlContent`），不需要高精度；`correctSourceType`
> 的职责是基于完整内容做深度修正。一个 source 被前者判为 `text` 后被后者修正为 `markdown`
> 是预期行为，不构成逻辑冲突。

### 3.2 来源资料页表单简化

**文件**：`apps/web/app/(workspace)/(default)/sources/page.tsx`

将当前的 4 按钮类型选择器 + 标题输入框 + 条件内容/URL 输入框，替换为与首页一致的**单 textarea + 自动提交**模式。

#### 3.2.1 移除的 UI 元素

- `SOURCE_TYPE_META` 常量及类型选择按钮组（`sources-type-picker`）
- `createType` / `createTitle` / `createUrl` / `createContent` 状态变量
- `titleError` / `urlError` / `contentError` 验证逻辑
- 类型切换时的条件渲染逻辑

#### 3.2.2 新增的 UI 元素

```tsx
// 简化为单个 textarea
const [captureText, setCaptureText] = useState("");
const [captureBusy, setCaptureBusy] = useState(false);
const [captureError, setCaptureError] = useState<string | null>(null);

async function handleCapture() {
  const text = captureText.trim();
  if (!text) return;

  // ⚠️ 保留 isOwner 拦截：成员角色不应能创建来源
  //    原页面在 JSX 层用 showCreate && isOwner 拦截，简化后仍需保留
  if (!isOwner) {
    setCaptureError("此操作需要所有者权限，你当前是成员角色，无法执行。");
    return;
  }

  // ⚠️ 保留 URL 格式校验：原页面有 isValidHttpUrl()，简化后仍应使用
  //    防止 ftp://、拼写错误的 htp:// 等无效 URL 发到后端
  const isUrl = /^https?:\/\//.test(text);
  if (isUrl && !isValidHttpUrl(text)) {
    setCaptureError("请输入以 http:// 或 https:// 开头的有效链接。");
    return;
  }

  setCaptureBusy(true);
  setCaptureError(null);
  try {
    if (isUrl) {
      await api.createSource({ url: text }); // 不传 type 和 title，由后端自动处理
    } else {
      await api.createSource({ content: text });
    }
    setCaptureText("");
    setStatusMessage("材料已添加，正在解析…");
    await loadSources({ fullReload: false });
  } catch (error) {
    setCaptureError(formatApiError(error, "创建来源失败，请重试。"));
  } finally {
    setCaptureBusy(false);
  }
}
```

> **注意**：`isValidHttpUrl` 函数（原 `sources/page.tsx` 第 61 行）和 `useIsOwner` hook
> 必须保留，不能在简化表单时一并删除。JSX 层仍需 `hidden={!isOwner}` 控制入口可见性。

表单 JSX 结构简化为：

```tsx
<section className="sources-capture-paper">
  <header className="sources-capture-header">
    <span className="sources-capture-icon"><Icon.Inbox /></span>
    <div>
      <span className="sources-eyebrow">添加资料</span>
      <h2>收录一份新资料</h2>
      <p>粘贴原文、Markdown、代码或网页链接，系统会自动识别类型并提取标题。</p>
    </div>
  </header>
  <textarea
    className="sources-capture-input"
    placeholder="粘贴原文、Markdown、代码，或输入 URL…"
    value={captureText}
    onChange={(e) => setCaptureText(e.target.value)}
    onKeyDown={(e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleCapture();
      }
    }}
    rows={6}
    disabled={captureBusy}
  />
  <footer className="sources-capture-footer">
    <span className="sources-capture-hint">支持文本、Markdown、代码与 URL · ⌘+Enter</span>
    <button
      type="button"
      className="sources-action-primary"
      onClick={handleCapture}
      disabled={captureBusy || !captureText.trim()}
    >
      {captureBusy ? "正在收录…" : "加入解析队列"}
    </button>
  </footer>
</section>
```

#### 3.2.3 前端 API 改造

**文件**：`apps/web/lib/api.ts`

`createSource` 的参数类型更新，`type` 和 `title` 变为可选：

```typescript
createSource: (body: {
  type?: SourceType;    // 可选，不传时由后端自动检测
  title?: string;       // 可选，不传时由 Worker 解析后自动提取
  content?: string;
  url?: string;
}) =>
  request<SourceDetail>("/sources", {
    method: "POST",
    body: JSON.stringify(body),
  }),
```

### 3.3 Worker 自动提取标题和修正类型

**文件**：`workers/ai-worker/src/handlers/parse-source.ts`

在 `runParseSource` 的内容解析完成后、状态设为 ready 之前，新增标题提取和类型修正逻辑。

> **⚠️ 关键不变式**：现有 `runParseSource` 的 ready 提交使用 `withJobTransaction` +
> `SELECT ... FOR UPDATE` + `ne(status, ARCHIVED)` 条件 update（第 665–742 行）。
> 标题和类型的计算**必须在该事务内部基于 `lockedSource` 重读的快照进行**，
> 而不能在事务外部用 `processingSource`（事务外初始读，存在 TOCTOU 窗口）算好再带入。
> 同时 `finalSegments` 必须贯穿到事务内的 `sourceSegments` 写入，不能只更新 title/type
> 却仍写入旧 segments。
>
> **⚠️ 「无内容」ready 路径不受影响**：`runParseSource` 实际有三个事务提交路径——
> ① URL 抓取后存储 metadata（第 525–559 行）；② **无内容 ready 提交**（第 587–645 行，
> `!rawContent.trim()` 时触发）；③ 有内容 ready 提交（第 665–742 行，本方案改造目标）。
> 路径②在 `rawContent` 为空时触发，此时无内容可提取标题、无特征可修正类型，
> 因此**不需要改造**——搜索索引仍写入 `lockedSource.title` 和 `lockedSource.type`（原始值），
> 行为与改造前一致。但实施时需确认路径②的搜索索引写入不会因路径③的改动
> 而产生字段名不一致（例如路径③新增了 `metadata.type` 而②没有）。最稳妥的做法是在
> 路径②也显式使用 `lockedSource.title`（此时 `finalTitle = lockedSource.title`，行为不变）。

```typescript
// 解析内容（事务外做初步解析，事务内基于 lockedSource 做最终决策）
const segments = parseContent(
  rawContent,
  processingSource.type as "text" | "markdown" | "code" | "url",
);

// ─── 新增：类型自动修正（事务外预计算，事务内基于 lockedSource 最终确认）───
const typeSource = (processingSource.metadata ?? {}).typeSource as string | undefined;
const correctedType = correctSourceType(rawContent, processingSource.type, typeSource);

// 如果类型被修正，用新类型重新解析
const finalSegments = correctedType !== processingSource.type
  ? parseContent(rawContent, correctedType)
  : segments;

const sourceBody = finalSegments.map((s) => s.text).join("\n");

// ─── ready 提交事务（改造原有第 665–742 行的事务）───
const committed = await withJobTransaction(job, async (tx) => {
  await lockJobLease(tx, job);
  const [lockedSource] = await tx
    .select()
    .from(schema.sources)
    .where(/* ... */)
    .for("update");
  if (!lockedSource || !canAdvanceSourceParse(lockedSource.status)) return false;

  // ⚠️ 基于 lockedSource 重新计算 correctedType 和 finalTitle
  //    （lockedSource 可能与 processingSource 不同，例如另一个事务改过 metadata）
  const lockedTypeSource = (lockedSource.metadata ?? {}).typeSource as string | undefined;
  const lockedCorrectedType = correctSourceType(rawContent, lockedSource.type, lockedTypeSource);
  // ⚠️ 始终基于 lockedCorrectedType 重新解析，不回退到事务外的 finalSegments。
  //    lockedSource.type 可能与 processingSource.type 不同（另一事务改过），
  //    此时事务外的 finalSegments 是用旧 type 计算的，回退到它会写入错误 segments。
  //    parseContent 开销可控（内容上限 500KB），牺牲少量性能消除一类隐 bug。
  const lockedFinalSegments = parseContent(rawContent, lockedCorrectedType);
  const lockedSourceBody = lockedFinalSegments.map((s) => s.text).join("\n");

  // 标题提取：传入已计算的 lockedBlocks（避免重复 parseContent）
  // ⚠️ URL 来源的 HTML 标题在 fetchUrlContent 中已提取（fetchedTitle），
  //    存入 metadata.fetchedTitle，事务内从 lockedSource.metadata 读取。
  //    rawContent 已被 extractTextFromHtml 剥离 HTML 标签，不能用于提取 <title>。
  const lockedBlocks = segmentsToBlocks(lockedFinalSegments, lockedCorrectedType as "text" | "markdown" | "code" | "url");
  const lockedFetchedTitle = (lockedSource.metadata ?? {}).fetchedTitle as string | null | undefined;
  const extractedTitle = extractSourceTitle(
    lockedBlocks,
    lockedCorrectedType,
    rawContent,
    lockedSource.origin,
    lockedFetchedTitle,
  );
  const finalTitle = extractedTitle || lockedSource.title;

  // 写入 segments（用 lockedFinalSegments，不是事务外的 segments）
  await tx.delete(schema.sourceSegments).where(/* ... */);
  if (lockedFinalSegments.length > 0) {
    await tx.insert(schema.sourceSegments).values(
      lockedFinalSegments.map((seg, idx) => ({
        sourceId, workspaceId: job.workspaceId, ordinal: idx,
        text: seg.text, charStart: seg.charStart, charEnd: seg.charEnd,
        segmentType: seg.segmentType,
      })),
    );
  }

  // 更新 source：status + 修正后的 type + 提取的 title
  const [updated] = await tx
    .update(schema.sources)
    .set({
      status: SourceStatus.READY,
      type: lockedCorrectedType,    // 修正类型
      title: finalTitle,           // 提取的标题
      updatedAt: new Date(),
    })
    .where(/* ... ne(status, ARCHIVED) ... */)
    .returning({ id: schema.sources.id });
  if (!updated) return false;

  // 搜索索引也用 finalTitle 和 lockedCorrectedType
  const indexedAt = new Date();
  await tx.insert(schema.searchDocuments).values({
    workspaceId: job.workspaceId, objectType: "source", objectId: sourceId,
    title: finalTitle, body: lockedSourceBody,
    metadata: { type: lockedCorrectedType }, indexedAt,
  }).onConflictDoUpdate({
    target: [
      schema.searchDocuments.workspaceId,
      schema.searchDocuments.objectType,
      schema.searchDocuments.objectId,
    ],
    set: { title: finalTitle, body: lockedSourceBody, metadata: { type: lockedCorrectedType }, indexedAt },
  });
  throwIfJobAborted(job);
  return true;
});
```

#### 3.3.1 标题提取函数

**复用已有 `extractTitleFromBlocks`，而非新造平行函数。**

`packages/shared/src/markdown-parser.ts` 第 91 行已导出 `extractTitleFromBlocks(blocks: ParsedBlock[]): string`，内部调用的 `cleanTitle` 也是同一文件的私有函数。该函数从 blocks 中提取第一个 heading 或段落的文本。

改造策略：在 `parse-source.ts` 中新增一个**薄封装** `extractSourceTitle`，负责 URL 来源的 HTML title 提取，其余情况委托给已有函数。

> **⚠️ 避免重复解析**：调用方（§3.3 事务）已经通过 `parseContent` + `segmentsToBlocks`
> 计算出了 `blocks`，`extractSourceTitle` 应**直接接收 `blocks`** 而非原始 `content`，
> 避免在事务内对大内容重复执行 `parseContent`（尤其事务会基于 `lockedSource` 再算一遍）。
> URL 来源的 HTML `<title>` 提取需要原始 HTML 文本，通过 `rawContent` 参数传入即可。

```typescript
import {
  parseContent,
  segmentsToBlocks,
  extractTitleFromBlocks,
  type ParsedBlock,
} from "../lib/markdown-parser.ts";

/**
 * 从解析后的内容中提取标题。
 * - URL 来源：优先使用 fetchUrlContent 已提取的 HTML 标题（fetchedTitle），回退到 blocks 提取
 * - 其余来源：直接复用 extractTitleFromBlocks
 *
 * @param blocks 调用方已通过 parseContent + segmentsToBlocks 计算好的 blocks，避免重复解析
 * @param sourceType 来源类型
 * @param rawContent 原始内容文本（已剥离 HTML 标签的纯文本，不可用于提取 HTML title）
 * @param origin 来源地址（URL 来源的最终回退：hostname）
 * @param fetchedTitle fetchUrlContent 从原始 HTML 中提取的标题（URL 来源优先使用）
 * 返回 null 表示未提取到，调用方应保留原标题
 */
export function extractSourceTitle(
  blocks: ParsedBlock[],
  sourceType: string,
  rawContent?: string,
  origin?: string | null,
  fetchedTitle?: string | null,
): string | null {
  // ⚠️ URL 来源：rawContent 已被 extractTextFromHtml 剥离了 HTML 标签，
  //    不能从中提取 <title>。必须使用 fetchUrlContent 在剥离前提取的 fetchedTitle。
  if (sourceType === "url" && fetchedTitle) {
    return fetchedTitle;
  }

  // 通用：复用已有 extractTitleFromBlocks（直接用传入的 blocks，不再重复 parseContent）
  // ⚠️ 不依赖 extractTitleFromBlocks 返回的 "无标题笔记" 字符串做判断（如果来源
  //    内容首行恰好是"无标题笔记"会被误判），改为先检查 blocks 是否真正有内容。
  if (blocks.length > 0 && blocks.some((b) => b.content.trim())) {
    const title = extractTitleFromBlocks(blocks);
    if (title) return title.slice(0, 100);
  }

  // URL 来源的最终回退：hostname
  if (sourceType === "url" && origin) {
    try {
      return new URL(origin).hostname;
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * 从 HTML 中提取标题。优先 og:title，其次 <title>。
 * 定义在 parse-source.ts 模块级别，仅由 §3.4.3 的 fetchUrlContent 调用
 * （在 extractTextFromHtml 剥离标签前从原始 HTML 提取标题）。
 * extractSourceTitle 不直接调用此函数——它通过 fetchedTitle 参数接收已提取的标题。
 */
function extractHtmlTitle(html: string): string | null {
  // ⚠️ 性能优化：og:title 和 <title> 都在 <head> 中，先截取 <head> 部分可减少
  //    正则在 500KB HTML 上的扫描范围。如 <head> 不存在则回退到全文匹配。
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch?.[1] ?? html;

  // og:title：先匹配整个 <meta> 标签，再从中提取 content 属性，
  // 避免假设 property/name 在 content 之前（部分 HTML 中属性顺序可能反转）。
  const ogTagMatch = head.match(/<meta\s+[^>]*?(?:property|name)=["']og:title["'][^>]*?>/i);
  if (ogTagMatch?.[0]) {
    const contentMatch = ogTagMatch[0].match(/content=["']([^"']+)["']/i);
    if (contentMatch?.[1]?.trim()) return contentMatch[1].trim().slice(0, 100);
  }
  const titleMatch = head.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch?.[1]?.trim()) {
    return titleMatch[1].trim().replace(/\s+/g, " ").slice(0, 100);
  }
  return null;
}
```

> **注意**：不要在 `parse-source.ts` 中新写 `cleanTitle`——已有 `cleanTitle` 是
> `markdown-parser.ts` 的私有函数，`extractTitleFromBlocks` 内部已调用它。
> 如果未来需要调整 clean 逻辑，只需修改 `markdown-parser.ts` 一处。
>
> **`extractHtmlTitle` 单一定义**：该函数在 `parse-source.ts` 模块级别定义一次，
> 仅由 `fetchUrlContent`（§3.4.3）调用——在 HTML 标签被剥离前从原始 HTML 中提取标题。
> `extractSourceTitle` 不再调用 `extractHtmlTitle`，因为其接收的 `rawContent`
> 已被 `extractTextFromHtml` 剥离了 HTML 标签。如果 `fetchUrlContent` 将来被提取到
> 独立模块，需将 `extractHtmlTitle` 一并迁移或抽到 `shared` 包中。
>
> **⚠️ URL 标题提取数据流（评审修正）**：原始方案中 `extractSourceTitle` 尝试从
> `rawContent` 中调用 `extractHtmlTitle` 提取 HTML 标题，但这是**死代码**——
> `rawContent` 在 `fetchUrlContent` 返回前已被 `extractTextFromHtml` 剥离了所有
> HTML 标签，不可能存在 `<title>` 或 `<meta property="og:title">`。
> 修正后的数据流为：`fetchUrlContent` → `extractHtmlTitle(rawHtml)` → `fetched.title`
> → 存入 `metadata.fetchedTitle` → 事务内从 `lockedSource.metadata` 读取 →
> 传入 `extractSourceTitle` 的 `fetchedTitle` 参数。
>
> **标题截断长度统一**：`extractTitleFromBlocks` 内部截取 60 字符（`.slice(0, 60)`），
> `extractSourceTitle` 和 `extractHtmlTitle` 统一截取 100 字符。source 标题比笔记标题
> 允许更长（schema 允许 500 字符），100 字符兼顾了 URL 来源的网页标题长度和 UI 列表显示。
>
> **`extractTitleFromBlocks` 边界 case**：该函数在无内容时返回字符串 `"无标题笔记"`，
> `extractSourceTitle` 通过 `title !== "无标题笔记"` 判断是否提取到。如果来源内容
> 的首行恰好是"无标题笔记"这五个字，会被误判为未提取到而保留原标题。概率极低，
> 更稳健的做法是检查 `blocks.length === 0` 或 `blocks.every(b => !b.content.trim())`
> 来判断是否真正无内容，而非依赖字符串比较。**已在上方代码中采纳此方案**——
> `extractSourceTitle` 先检查 `blocks.length > 0 && blocks.some(...)` 再调用
> `extractTitleFromBlocks`，完全避免了对 "无标题笔记" 字符串的依赖。
>
> `extractTextFromHtml()` 在剥离标签前没有提取 `<title>`。改造后，`fetchUrlContent`
> 在调用 `extractTextFromHtml` **之前**先调用 `extractHtmlTitle` 提取标题，
> 并通过 `FetchedContent.title` 返回给调用方。调用方必须将 `fetched.title` 存入
> `metadata.fetchedTitle`，事务内 `extractSourceTitle` 从该字段获取 URL 来源标题。

#### 3.3.2 类型修正函数

```typescript
/**
 * 根据实际内容特征修正来源类型。
 * 仅在原始类型与内容特征明显不符时修正。
 *
 * @param typeSource "manual" 表示用户手动选择了类型（不可覆盖），
 *                  "auto" 或 undefined 表示自动检测（可修正）。
 *                  该值由 createSource service 写入 metadata.typeSource（见 §3.1）。
 */
export function correctSourceType(
  content: string,
  originalType: string,
  typeSource?: string,
): "text" | "markdown" | "code" | "url" {
  // ⚠️ 用户手动选择的类型优先级最高，不修正
  if (typeSource === "manual") {
    return originalType as "text" | "markdown" | "code" | "url";
  }

  // ⚠️ URL 类型不可修正：URL 抓取到的 HTML 纯文本可能命中代码或 Markdown 特征，
  //    但将其修正为 code/markdown 会导致 parseContent 用错误的分段策略处理。
  //    URL 来源的分段策略是固定的（按 markdown 规则解析提取出的纯文本）。
  if (originalType === "url") {
    return "url";
  }

  const text = content.trim();
  if (!text) return originalType as "text" | "markdown" | "code" | "url";

  // 代码特征
  const codeIndicators = [
    /^(function|const|let|var|class|import|export|def |#include|package |public class)/m,
    /```[\s\S]*?```/,  // 代码块
    /^(if|for|while|switch|try|catch)\s*\(/m,
    /;\s*$/m,  // 行尾分号
  ];
  const codeScore = codeIndicators.filter((re) => re.test(text)).length;

  // Markdown 特征
  const mdIndicators = [
    /^#{1,6}\s/m,       // 标题
    /^[-*+]\s/m,        // 无序列表
    /^\d+\.\s/m,        // 有序列表
    /^>\s/m,            // 引用
    /\[.+?\]\(.+?\)/,   // 链接
    /!\[.*?\]\(.+?\)/,  // 图片
    /```/,              // 代码块
    /^\|.*\|/m,         // 表格
  ];
  const mdScore = mdIndicators.filter((re) => re.test(text)).length;

  // 仅对自动检测的 text 类型做修正
  if (originalType === "text") {
    if (codeScore >= 2 && codeScore > mdScore) return "code";
    if (mdScore >= 2) return "markdown";
  }
  // ⚠️ 修正原方案的死分支：含 ``` 的 markdown mdScore 至少 1（命中 /```/），
  //    原条件 `mdScore === 0` 永远不满足。改为只看 codeScore 是否远超 mdScore
  if (originalType === "markdown" && codeScore >= 3 && codeScore > mdScore + 1) return "code";
  if (originalType === "code" && mdScore >= 2 && mdScore > codeScore) return "markdown";

  return originalType as "text" | "markdown" | "code" | "url";
}
```

> **修正说明**：原方案的 `if (originalType === "markdown" && codeScore >= 3 && mdScore === 0)`
> 是死分支——含 ``` 的 markdown `mdScore` 至少命中 `/```/` 得 1 分，`mdScore === 0` 永远不满足。
> 改为 `codeScore > mdScore + 1` 确保 code 信号明显强于 markdown 信号时才修正。
> 同时新增 `typeSource` 参数实现 R2 承诺的"用户手动选择优先"逻辑。
>
> **URL 类型保护**：`originalType === "url"` 时直接返回 `"url"`，不参与特征评分。
> URL 来源的内容是 `extractTextFromHtml` 提取的纯文本，可能命中代码特征（如技术博客中的
> 代码片段）或 Markdown 特征（如含 `#` 的文本），但将其修正为 code/markdown 会导致
> `parseContent` 用错误的分段策略处理（如 code 会整段作为一个 segment）。
>
> **重解析性能**：当 `correctSourceType` 返回与原类型不同的值时，`parseContent` 会被
> 调用两次（原始 type 一次 + 修正 type 一次）。内容上限 500KB，`parseContent` 为纯正则
> 分段，两次调用的增量开销在毫秒级，可接受。事务内基于 `lockedCorrectedType` 始终重新
> 解析（不再回退到事务外预计算），消除了 `lockedSource.type` 与 `processingSource.type`
> 不一致时写入错误 segments 的隐患。
>
> **⚠️ 无 code→text 回退路径**：`correctSourceType` 处理了 text→code、text→markdown、
> markdown→code、code→markdown 四种修正，但**没有 code→text 回退**。如果用户粘贴的文本
> 被 `detectSourceType` 误判为 code（如首行恰好以 `const` 开头但实际是散文），Worker
> 无法将其修正回 text。实际影响较小——code 的分段策略是整段作为一个 segment，
> 对纯文本来说不会丢内容，只是缺少段落切分。如需更激进地回退，可在 `originalType === "code"`
> 分支中增加 `codeScore === 0 && mdScore === 0` 时返回 `"text"` 的判断。

### 3.4 URL 抓取改进

**文件**：`workers/ai-worker/src/handlers/parse-source.ts`

#### 3.4.1 支持压缩响应（P0 — 修复大部分失败）

当前代码发送 `Accept-Encoding: identity` 并拒绝任何非 identity 的编码。改为支持 gzip、deflate 和 brotli（br）：

> **⚠️ 为什么必须支持 brotli**：Cloudflare 和主流 CDN 默认返回 `content-encoding: br`，
> 如果不处理 br 仍然会丢失一大票流量。原方案把 br 直接 reject 的 else 分支必须去掉。

```typescript
// 修改前
"Accept-Encoding": "identity",

// 修改后 — 通过环境变量控制，支持运行时回滚
const FETCH_ACCEPT_ENCODING =
  process.env.SOURCE_FETCH_ACCEPT_ENCODING ?? "gzip, deflate, br, identity";
// 在 requestPinnedUrl 的 headers 中使用：
"Accept-Encoding": FETCH_ACCEPT_ENCODING,
// 回滚：设 SOURCE_FETCH_ACCEPT_ENCODING=identity 即恢复原行为
```

在 `requestPinnedUrl` 的响应处理中，增加解压逻辑。

> **⚠️ 实现策略：buffer-then-decompress（非流式）**
> 原方案使用流式解压 + deflate error fallback 重新 pipe 的伪代码，但"先 pipe 再 error
> 再重新 pipe"在实践中极易出错——原始 response 流可能已被部分消费，重新 pipe 无法重放已读数据。
> 改为**先收集完整压缩 buffer，再一次性解压**：牺牲流式（来源内容上限 500KB，内存可控），
> 但 deflate raw fallback 逻辑更简单可靠——只需 catch 错误后用 `inflateRaw` 重试即可。
> 解压炸弹防护改为在解压后 buffer 上做 `FETCH_MAX_BYTES` 检查。

```typescript
import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from "node:zlib";

// 在 onResponse 回调中，替换 content-encoding 检查逻辑
const contentEncoding = (getHeader(response, "content-encoding") ?? "identity").toLowerCase();

// 压缩分支下跳过 Content-Length 预检（Content-Length 表示压缩后大小，不能用于判断解压后体积）
if (contentEncoding === "identity") {
  // identity：保留原有的 Content-Length 预检 + 流上限制（双重防护）
  const rawLength = getHeader(response, "content-length");
  const contentLength = rawLength === undefined ? 0 : Number(rawLength);
  if (Number.isFinite(contentLength) && contentLength > FETCH_MAX_BYTES) {
    response.destroy();
    reject(new Error(`content too large: ${contentLength} bytes (max ${FETCH_MAX_BYTES})`));
    return;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  response.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > FETCH_MAX_BYTES) {
      response.destroy(new Error(`content exceeded max size (${FETCH_MAX_BYTES} bytes)`));
      return;
    }
    chunks.push(buffer);
  });
  response.once("end", () => {
    resolve({
      status, statusText,
      contentType: getHeader(response, "content-type") ?? "",
      body: Buffer.concat(chunks),
    });
  });
} else if (contentEncoding === "gzip" || contentEncoding === "deflate" || contentEncoding === "br") {
  // gzip / deflate / br：先收集完整压缩 buffer，再解压
  // 压缩后大小预检：允许压缩后 2x FETCH_MAX_BYTES（压缩比通常 < 10x，500KB 压缩后约 50-100KB）
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  response.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > FETCH_MAX_BYTES * 2) {
      response.destroy(new Error(`compressed content too large (${totalBytes} bytes)`));
      return;
    }
    chunks.push(buffer);
  });
  response.once("end", () => {
    const compressed = Buffer.concat(chunks);
    try {
      const decompressed = decompressBuffer(compressed, contentEncoding);
      // 解压后大小检查（防解压炸弹）
      if (decompressed.length > FETCH_MAX_BYTES) {
        reject(new Error(`decompressed content too large: ${decompressed.length} bytes (max ${FETCH_MAX_BYTES})`));
        return;
      }
      resolve({
        status, statusText,
        contentType: getHeader(response, "content-type") ?? "",
        body: decompressed,
      });
    } catch (err) {
      reject(new Error(`decompression failed (${contentEncoding}): ${err instanceof Error ? err.message : String(err)}`));
    }
  });
  response.once("error", (err) => {
    reject(new Error(`compressed response stream error: ${err.message}`));
  });
} else {
  response.destroy();
  reject(new Error(`unsupported content encoding: ${contentEncoding}`));
  return;
}

/**
 * 解压 buffer，支持 gzip / deflate / br。
 * deflate 先尝试标准 zlib wrapper（inflateSync），Z_DATA_ERROR 时 fallback 到 raw deflate（inflateRawSync）。
 */
function decompressBuffer(compressed: Buffer, encoding: string): Buffer {
  if (encoding === "gzip") {
    return gunzipSync(compressed);
  }
  if (encoding === "br") {
    return brotliDecompressSync(compressed);
  }
  if (encoding === "deflate") {
    try {
      return inflateSync(compressed);
    } catch (err) {
      // ⚠️ 很多服务器把 raw deflate（无 zlib header）误标为 deflate。
      // inflateSync 期望 zlib wrapper，遇到 raw deflate 会抛 Z_DATA_ERROR，
      // 此时 fallback 到 inflateRawSync。
      if (err instanceof Error && /Z_DATA_ERROR/.test(err.message)) {
        return inflateRawSync(compressed);
      }
      throw err;
    }
  }
  throw new Error(`unsupported content encoding: ${encoding}`);
}
```

> **⚠️ 解压炸弹防护**：原代码注释（第 281-283 行）明确指出 `Accept-Encoding: identity`
> 是为了防止解压后体积绕过 `FETCH_MAX_BYTES`。改为支持压缩后，采用**两层防护**：
> 1. 压缩流收集阶段：限制压缩后大小不超过 `FETCH_MAX_BYTES * 2`（防止内存耗尽）
> 2. 解压后 buffer 检查：`decompressed.length > FETCH_MAX_BYTES` 时 reject（防解压炸弹）
>
> **`FETCH_MAX_BYTES * 2` 限制的合理性**：该 2x 限制是为了兼容正常压缩比（文本内容
> 通常压缩 3-10x，500KB 原文压缩后约 50-150KB，远低于 1MB 上限）。恶意服务器可以
> 发送接近 1MB 的压缩数据，但真正的防护依赖第二层——解压后 buffer 检查会拦截任何
> 解压后超过 500KB 的内容。第一层限制的目的是防止在解压阶段耗尽内存（1MB 压缩
> 数据在内存中可控），而非防解压炸弹本身。
>
> **Content-Length 预检**：identity 分支保留预检（双重防护）；gzip/deflate/br 分支
> **跳过预检**（Content-Length 是压缩后大小，不能用于判断解压后体积）。
>
> **为什么用同步 API（`*Sync`）而非流式**：来源内容上限 500KB，解压后同样不超过 500KB，
> 同步解压的内存和时间开销可控（< 1ms）。流式解压的 deflate raw fallback 需要"先 pipe
> 再 error 再重新 pipe"，但原始 response 流已被部分消费无法重放。改为先收集完整 buffer
> 再用同步 API 解压，fallback 只需 catch 后换 `inflateRawSync` 重试，逻辑简单可靠。

#### 3.4.2 延长超时和增加重试（P1）

```typescript
// 修改前
const FETCH_TIMEOUT_MS = 15_000;

// 修改后
const FETCH_TIMEOUT_MS = 20_000;  // 从 15s 延长到 20s
const FETCH_RETRY_COUNT = 1;       // 增加 1 次重试（共 2 次尝试）
```

在 `fetchUrlContent` 中增加重试包装：

```typescript
export async function fetchUrlContent(
  url: string,
  signal?: AbortSignal,
  dependencies: FetchUrlDependencies = {},
): Promise<FetchedContent> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= FETCH_RETRY_COUNT; attempt++) {
    try {
      return await fetchUrlContentOnce(url, signal, dependencies);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // 仅对瞬时错误重试（超时、连接重置、DNS 失败），不重试 HTTP 4xx
      // ⚠️ 修正：ECONNRESET 等网络错误在 Node 中是 err.code 属性，不是 message 字符串。
      //    靠 message.includes("ECONNRESET") 不可靠，应同时检查 err.code。
      const errCode = (err as NodeJS.ErrnoException).code;
      const isTransient =
        lastError.message.includes("timed out")
        || errCode === "ECONNRESET"
        || errCode === "ECONNREFUSED"
        || errCode === "EAI_AGAIN"  // DNS 临时失败
        || lastError.message.includes("DNS resolution failed")
        || lastError.message.includes("socket hang up");
      if (!isTransient || attempt === FETCH_RETRY_COUNT) break;
      // 短暂等待后重试（绑定 signal，job 被 abort 时立即中断延迟）
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000 * (attempt + 1));
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
  throw lastError;
}
```

#### 3.4.3 改进 HTML 解析与标题提取（P1）

当前 `extractTextFromHtml()` 在剥离标签前没有提取 `<title>`。改为在 `fetchUrlContent` 返回前提取结构化信息：

```typescript
// fetchUrlContent 返回类型变更
interface FetchedContent {
  text: string;
  title: string | null;
}

// 在 fetchUrlContent 的返回处
// ⚠️ extractHtmlTitle 必须在 extractTextFromHtml 之前调用——
//    后者会剥离所有 HTML 标签，剥离后无法再提取 <title>。
if (res.contentType.toLowerCase().includes("text/html")) {
  const title = extractHtmlTitle(rawText);
  const text = extractTextFromHtml(rawText);
  return { text, title };
}
return { text: rawText, title: null };

// FetchedContent.url 已移除（YAGNI）——当前无调用方消费重定向后 URL。
// 如未来需要展示最终 URL，可在 metadata 中单独存储 fetchedUrl。

// extractHtmlTitle 已在 §3.3.1 中定义于 parse-source.ts 模块级别，此处直接调用，不重复定义。
// 如果 fetchUrlContent 将来被提取到独立模块，需将 extractHtmlTitle 一并迁移或抽到 shared 包。
```

> **⚠️ 破坏性改动 — 调用方必须同步更新**：`fetchUrlContent` 返回类型从 `string` 变为
> `FetchedContent` 对象。现有调用方（`parse-source.ts`）中所有引用返回值的位置都需同步改造：
>
> 1. **第 520 行**（赋值 rawContent）：
>    ```typescript
>    // 修改前
>    const fetchedContent = await fetchUrlContent(url, job.signal);
>    rawContent = fetchedContent;
>    // 修改后
>    const fetched = await fetchUrlContent(url, job.signal);
>    rawContent = fetched.text;
>    ```
> 2. **第 544 行**（metadataStored 事务写入 rawContent）：
>    ```typescript
>    // 修改前
>    rawContent: fetchedContent,
>    // 修改后
>    rawContent: fetched.text,
>    // ⚠️ 必须写入 fetchedTitle，否则事务内 extractSourceTitle 无法获取 URL 来源的网页标题
>    fetchedTitle: fetched.title,
>    fetchedAt: new Date().toISOString(),
>    ```
> 3. **第 566 行**（日志记录 contentLength）：
>    ```typescript
>    // 修改前
>    logger.info({ sourceId, contentLength: fetchedContent.length }, "URL content fetched");
>    // 修改后
>    logger.info({ sourceId, contentLength: fetched.text.length }, "URL content fetched");
>    ```
>
> **现有测试影响**：现有测试通过 `FetchUrlDependencies` 依赖注入模式 mock 的是
> `request` 函数（`PinnedRequester`）而非 `fetchUrlContent` 本身，因此 mock `request`
> 的测试**不需要改动**。需要同步更新的是**直接调用 `fetchUrlContent` 并断言其返回值为
> string 的测试**（如 `parse-source-extra.test.ts` 中 `const result = await fetchUrlContent(...)`
> 后断言 `result` 为字符串的那些用例）——这些需要改为断言 `result.text`。
> 实施前应 `grep -r 'fetchUrlContent' workers/ai-worker/src/` 确认所有测试调用点。

同时改进 `extractTextFromHtml`，提取更多语义内容：

```typescript
function extractTextFromHtml(html: string): string {
  // 新增：提取 <article> 或 <main> 标签内容（优先使用语义化正文区域）
  // ⚠️ 页面可能有多个 <article>（如博客列表页），取最长的一个作为正文。
  const articleMatches = [...html.matchAll(/<article[\s\S]*?<\/article>/gi)];
  const articleContent = articleMatches.length > 0
    ? articleMatches.reduce((a, b) => a[0].length > b[0].length ? a : b)[0]
    : null;
  const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
  let contentHtml = articleContent || mainMatch?.[0] || html;

  // ⚠️ fallback：如果 <article> 提取后的纯文本过短（< 200 字符），可能只是摘要区块，
  //    回退到全文提取以避免丢失正文。200 字符阈值基于经验：正常文章摘要通常 < 200 字符，
  //    而正文至少数百字符。此阈值可根据实际效果调整。
  if (contentHtml !== html) {
    const previewText = contentHtml
      .replace(/<[^>]+>/g, "")
      .trim();
    if (previewText.length < 200) {
      contentHtml = html;
    }
  }

  return contentHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")        // 新增：移除导航
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")   // 新增：移除页脚
    .replace(/<header[\s\S]*?<\/header>/gi, "")   // 新增：移除页头（可能含重复标题）
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")     // 新增：移除侧边栏
    .replace(/<\/?(p|div|br|h[1-6]|li|ul|ol|blockquote|pre|tr|table)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
```

> **⚠️ 已知局限：字符编码（charset）**：当前 `fetchUrlContent` 使用 `new TextDecoder("utf-8", { fatal: false })`
> 硬编码 UTF-8 解码（`parse-source.ts` 第 434 行）。大量中文网站使用 GBK/GB2312 编码，
> 改进 HTML 解析后这些页面的标题和正文仍会出现乱码。本期不处理此问题（需引入
> `iconv-lite` 或从 `<meta charset>` / `Content-Type` 头解析编码），但应作为已知局限记录。
> 详见 §8 未来扩展。

#### 3.4.4 更新 User-Agent（P2）

```typescript
// 修改前
"User-Agent": "AILearnBot/0.3 (+https://github.com/ailearn)",

// 修改后 — 使用更通用的 UA，减少被反爬拦截的概率
"User-Agent": "Mozilla/5.0 (compatible; AILearnBot/0.5; +https://github.com/ailearn)",
```

### 3.5 首页快速捕获同步简化

**文件**：`apps/web/app/(workspace)/(default)/page.tsx`

首页的 `handleCapture` 当前在前端做类型检测和标题提取，改造后可以直接将原始内容传给后端，由后端统一处理：

```typescript
// 修改前（前端做检测）
const isUrl = /^https?:\/\//.test(text);
const isCode = /^(function|const|let|var|class|import|export|def |if __name__|#include|package |public class)/.test(text);
const hasMarkdown = /^[#>*\-]/m.test(text);
if (isUrl) {
  await api.createSource({ type: "url", title: text.slice(0, 60), url: text });
} else {
  const type = isCode ? "code" : hasMarkdown ? "markdown" : "text";
  const title = text.split("\n")[0].slice(0, 60) || "快速捕获";
  await api.createSource({ type, title, content: text });
}

// 修改后（后端做检测）
const isUrl = /^https?:\/\//.test(text);
if (isUrl) {
  await api.createSource({ url: text });
} else {
  await api.createSource({ content: text });
}
```

> **注意**：此改动是可选的。首页已有前端检测逻辑，如果不改也不影响功能（后端会二次检测并修正）。但统一后可以减少前端代码复杂度，并确保检测逻辑一致。

### 3.5b 今日页快速收录同步简化

**文件**：`apps/web/app/(workspace)/(default)/today/page.tsx`

今日页的 `handleQuickCapture`（第 437 行）同样在前端做类型检测（`detectCaptureType`，第 167 行）和标题提取（`captureTitle`，第 183 行），与首页和来源页的简化方向一致：

```typescript
// 修改前（前端做检测）
const type = detectCaptureType(text);
const title = captureTitle(text, type);
const result = await api.createSource({
  type,
  title,
  content: type === "url" ? undefined : text,
  url: type === "url" ? text : undefined,
});

// 修改后（后端做检测）
// ⚠️ 保留 isOwner 拦截：与来源页一致，成员角色不应能创建来源
if (!isOwner) return;
const isUrl = /^https?:\/\//.test(text);
const result = await api.createSource(
  isUrl ? { url: text } : { content: text }
);
```

> **注意**：简化后 `detectCaptureType`（第 167 行）和 `captureTitle`（第 183 行）变为死代码，
> 应一并删除。如未来需要在前端展示实时类型识别提示（如当前 today 页的 `sourceTypeLabel`
> 提示），可保留 `detectCaptureType` 仅用于 UI 展示，不用于 `createSource` 调用。

### 3.6 搜索索引同步更新

Worker 在更新 source 的 title 和 type 时，搜索索引也需要同步更新。当前 `parse-source.ts` 在设置 ready 状态时已经会 upsert 搜索文档。

> **注意**：§3.3 的完整事务示例已包含搜索索引 upsert，使用的是事务内基于 `lockedSource`
> 计算的 `finalTitle`、`lockedCorrectedType` 和 `lockedSourceBody`。以下代码片段仅作快速参考，
> 实际实现以 §3.3 为准：

```typescript
// 在 ready 状态事务中（变量名以 §3.3 的事务内计算为准）
await tx
  .insert(schema.searchDocuments)
  .values({
    workspaceId: job.workspaceId,
    objectType: "source",
    objectId: sourceId,
    title: finalTitle,              // 事务内提取的标题
    body: lockedSourceBody,        // 基于 lockedFinalSegments 计算
    metadata: { type: lockedCorrectedType },  // 事务内修正的类型
    indexedAt,
  })
  .onConflictDoUpdate({
    target: [
      schema.searchDocuments.workspaceId,
      schema.searchDocuments.objectType,
      schema.searchDocuments.objectId,
    ],
    set: {
      title: finalTitle,
      body: lockedSourceBody,
      metadata: { type: lockedCorrectedType },
      indexedAt,
    },
  });
```

---

## 4. 数据库变更

### 4.1 无 Schema 变更

本次改造**不需要数据库 migration**：

- `sources.title` 列已经是 `text NOT NULL`，改造后仍然不为空（创建时用占位标题，Worker 解析后更新）
- `sources.type` 列已经是 `text NOT NULL`，改造后仍然不为空（创建时用初步检测值，Worker 解析后修正）
- `sources.metadata` 列是 `jsonb`，新增的 `typeSource`、`fetchedTitle` 等字段可直接存入

> **⚠️ 实施前确认**：以上假设基于代码推断，实施前应 grep 建表语句确认：
> ```sql
> -- 检查 sources 表定义
> \d sources
> -- 或在 migration 文件中搜索 create table sources
> ```
> 确认 `title` 和 `type` 列确实是 `NOT NULL` 且无默认值。如果有默认值（如 `DEFAULT 'text'`），
> 则 schema 放宽后后端可以省略默认填充逻辑。

### 4.2 向后兼容

- 现有 API 调用方（前端旧版本）仍可传 `type` 和 `title`，后端兼容接收
- Worker 对已有 source 重新解析时（如 retry），也会执行标题提取和类型修正
- 已创建的 source 数据不受影响

> **⚠️ `typeSource` metadata 存活不变式**：`createSource` 在 metadata 中写入 `typeSource`
> 字段（§3.1）。现有 `runParseSource` 在 URL 抓取成功后覆写 metadata（第 542–545 行），
> 使用了 spread 语法 `{ ...lockedSource.metadata, rawContent, fetchedAt }`，因此 `typeSource`
> 会存活。**实施时必须确认此 spread 语法不被改为非 spread 覆写**，否则 `typeSource` 丢失后
> `correctSourceType` 会将 `undefined` 视为 `"auto"` 并可能错误修正用户手动选择的类型。
>
> **存量数据**：现有 source 的 metadata 中没有 `typeSource` 字段，`correctSourceType` 会将
> `undefined` 视为 `"auto"` 并允许修正。这是预期行为——存量 source 在 retry 时才会被修正，
> 无需批量回填。如需保守，可在 `correctSourceType` 中对 `typeSource === undefined` 也视为
> 不可修正（但这样自动检测的存量 source 就不会被修正了）。
>
> **⚠️ source 编辑场景的 `typeSource` 注意点**：当前 `updateSource`（service.ts 第 262–286 行）
> 只更新 `title` 和 `metadata`，不更新 `type`。如果未来允许用户编辑 type，必须同步将
> `metadata.typeSource` 更新为 `"manual"`，否则 Worker retry 时会基于旧的 `typeSource`
> 判断（可能仍为 `"auto"`）而错误覆盖用户的手动修改。当前不影响（type 不可编辑），
> 但应在未来扩展时注意。

---

## 5. 改动范围

### 5.1 后端

| 文件 | 改动内容 |
|---|---|
| `apps/api/src/modules/source/schema.ts` | `title` 和 `type` 改为 optional；调整 refine 校验 |
| `apps/api/src/modules/source/service.ts` | `createSource` 增加 `detectSourceType` 和默认标题逻辑 |
| `workers/ai-worker/src/handlers/parse-source.ts` | 支持 gzip/deflate/br 解压 + deflate raw fallback；增加重试（abort-aware 延迟）；改进 HTML 解析；提取标题（`fetchUrlContent` 提取 HTML title → `metadata.fetchedTitle` → 事务内 `extractSourceTitle` 消费）；修正类型；事务内回写 title/type/segments；更新搜索索引 |
| `packages/shared/src/markdown-parser.ts` | **不改**——复用已有 `extractTitleFromBlocks()` 和私有 `cleanTitle()`；`correctSourceType()` 和 `extractSourceTitle()` 薄封装放在 `parse-source.ts` 中 |

### 5.2 前端

| 文件 | 改动内容 |
|---|---|
| `apps/web/app/(workspace)/(default)/sources/page.tsx` | 替换复杂表单为单 textarea；移除类型选择器、标题输入框、条件字段；**保留** `isValidHttpUrl()` 和 `useIsOwner` 拦截 |
| `apps/web/lib/api.ts` | `createSource` 参数类型：`type` 和 `title` 改为 optional |
| `apps/web/app/(workspace)/(default)/page.tsx` | 简化 `handleCapture`：不再前端检测类型和标题（可选，向后兼容） |
| `apps/web/app/(workspace)/(default)/today/page.tsx` | 简化 `handleQuickCapture`：不再前端检测类型和标题；清理 `detectCaptureType` 和 `captureTitle` 死代码（可选，向后兼容） |

### 5.3 测试

| 文件 | 改动内容 |
|---|---|
| `apps/api/src/modules/source/` 相关测试 | 更新 schema 校验测试：验证不传 title/type 时也能创建 |
| `workers/ai-worker/src/handlers/parse-source.ts` 相关测试 | 新增：gzip/deflate/br 解压测试、deflate raw fallback 测试、解压炸弹防护测试、标题提取测试（含 HTML title + fetchedTitle 数据流）、类型修正测试（含 typeSource 标记）、重试测试（含 err.code 判断 + abort 中断延迟）、事务一致性测试 |
| 前端 sources page 测试 | 更新：验证简化后的表单交互 |
| 前端 today page 测试 | 更新：验证简化后的 `handleQuickCapture` 交互；确认 `detectCaptureType`/`captureTitle` 清理后无残留引用 |

> **测试 fixture 构造说明**：
>
> 现有 `fetchUrlContent` 已支持 `FetchUrlDependencies` 依赖注入模式
> （`resolveAddress` 和 `request` 可 stub，见 `parse-source.ts` 第 167–170 行）。
> 压缩响应测试应基于此模式注入 mock `PinnedRequester`，构造返回不同 `content-encoding`
> 的 `PinnedResponse`：
>
> ```typescript
> // gzip 测试示例
> const gzipBody = zlib.gzipSync(Buffer.from("<html><title>Test</title><p>Hello</p></html>"));
> const mockRequest: PinnedRequester = async () => ({
>   status: 200,
>   statusText: "OK",
>   contentType: "text/html; charset=utf-8",
>   body: gzipBody,
> });
> // 注入：fetchUrlContent(url, signal, { request: mockRequest })
> ```
>
> - **gzip/deflate/br 解压**：用 `zlib.gzipSync` / `zlib.deflateSync` / `zlib.brotliCompressSync`
>   构造压缩 body，验证 `decompressBuffer` 正确解压
> - **deflate raw fallback**：用 `zlib.deflateRawSync`（无 zlib header）构造 body，
>   验证 `inflateSync` 抛 `Z_DATA_ERROR` 后 `inflateRawSync` 成功
> - **解压炸弹**：构造压缩后极小但解压后超过 `FETCH_MAX_BYTES` 的 body（如全零字节压缩），
>   验证 reject 并返回 `decompressed content too large` 错误
> - **重试测试**：mock `request` 前 N 次抛 `{ code: "ECONNRESET" }`，
>   第 N+1 次返回正常响应，验证重试后成功；同时验证 HTTP 4xx 不重试
> - **标题提取**：构造含 `<title>` 和 `og:title` 的 HTML，验证提取优先级和截断
> - **类型修正**：构造 `typeSource: "manual"` 的 source，验证 `correctSourceType` 不覆盖；
>   构造 `typeSource: "auto"` 且内容含明显 Markdown 特征的 text source，验证修正为 markdown

---

## 6. 实施计划

> **⚠️ 部署依赖关系**：
> - Phase A 内部的 URL 修复（steps 1–3）和 schema 放宽（steps 4–5）可独立部署（详见 §3.1）。
> - **Phase C 硬依赖 Phase A steps 4–5**：前端简化后不传 type → 后端 schema 必须已放宽，否则 400 报错。
> - **Phase B 依赖 Phase A step 5**：`correctSourceType` 需要 `metadata.typeSource` 字段，该字段由 `createSource` service 写入。
> - **Phase B step 2（`fetchUrlContent` 返回类型变更）是破坏性改动**：需同步更新所有调用方和测试 mock，应在 Phase B 内部首先完成，后续 steps 3–5 依赖此变更。
> - Phase B 和 Phase C 之间无依赖，可并行开发。

### Phase A: URL 解析修复 + API Schema 放宽（P0 — 立即止血）

**目标**：修复 URL 解析失败的核心问题，同时放宽 API 兼容不传 type/title 的请求

1. `parse-source.ts`：支持 gzip/deflate/br 解压 + deflate raw fallback
2. `parse-source.ts`：延长超时到 20s + 增加 1 次重试（err.code 判断瞬时错误）
3. `parse-source.ts`：更新 User-Agent
4. `schema.ts`：title 和 type 改为 optional；调整 refine 校验
5. `service.ts`：增加 `detectSourceType`、默认标题逻辑、`metadata.typeSource` 标记；
   所有 `input.type` 引用改为 `detectedType`

> **⚠️ Phase A 不包含 §3.4.3**：§3.4.3（`fetchUrlContent` 返回类型变更 + HTML 标题提取）
> 属于 Phase B step 2–3，不在 Phase A 范围内。Phase A 部署后 `fetchUrlContent` 仍返回
> `string`，URL 来源的 HTML 标题在 Phase B 之前无法提取——这是预期中间状态。

**验收标准**：
- 选取 20 个不同类型的真实 URL（含 Cloudflare 站点、国内站点、慢速站点）测试解析成功率 ≥ 80%
- 不传 type/title 的 POST /sources 请求能正常创建并触发解析
- 传 type/title 的旧请求不受影响（向后兼容）
- gzip/deflate/br 响应均能正确解压；解压炸弹防护（FETCH_MAX_BYTES）在解压流上生效

**回滚策略**：
- `parse-source.ts` 改动通过环境变量 `SOURCE_FETCH_ACCEPT_ENCODING` 控制：
  - 默认 `"gzip, deflate, br, identity"`
  - 回滚设为 `"identity"` 即恢复原行为
- schema/service 改动需 git revert，但不会影响已创建的 source 数据

> **⚠️ 回滚说明**：URL 修复（steps 1–3）和 schema 放宽（steps 4–5）可独立回滚。
> 只回滚环境变量不回滚 schema/service：前端仍传 type → 后端兼容接收，URL 解析回到旧状态，无故障。
> 只 git revert schema/service 不回滚环境变量：前端仍传 type → 后端恢复必填校验，URL 解析成功率高，无故障。
> 但如果 Phase C 已部署（前端不传 type），则回滚 schema/service 会导致 400 报错——
> 此时必须同步回滚 Phase C 或保持 schema/service 不回滚。

### Phase B: 标题提取和类型修正（P1）

**目标**：Worker 解析后自动更新标题和类型

1. 新增 `extractSourceTitle()` 薄封装（复用 `extractTitleFromBlocks`）和 `correctSourceType()` 函数
2. **`fetchUrlContent` 返回类型变更为 `FetchedContent { text, title }`**（破坏性改动，先做）：
   同步更新所有调用方（第 520/544/566 行）和测试 mock（详见 §3.4.3 破坏性改动说明）。
   调用方必须将 `fetched.title` 写入 `metadata.fetchedTitle`，供事务内 `extractSourceTitle` 消费。
3. 改进 HTML 解析：提取 `<title>` 和 og:title（`extractHtmlTitle` 在 `parse-source.ts` 模块级别定义一次）
4. `parse-source.ts`：解析完成后在 `withJobTransaction` 事务内回写 title 和 type
   （基于 `lockedSource` 计算，`finalSegments` 始终基于 `lockedCorrectedType` 重新解析）
5. 搜索索引同步更新（用 `finalTitle` 和 `lockedCorrectedType`）

> **⚠️ 执行顺序**：step 2（`fetchUrlContent` 返回类型变更）是破坏性改动，必须在
> Phase B 内部**首先完成**——后续 steps 3–5 的事务回写代码和 HTML 解析改进都依赖
> `FetchedContent` 的结构化返回值。

**验收标准**：
- URL 来源解析后 title 为网页标题而非 URL 截断
- Markdown 来源解析后 title 为第一个 heading
- `typeSource === "manual"` 的来源不被 `correctSourceType` 覆盖
- 事务一致性：archive 竞态下不回写 title/type（`ne(status, ARCHIVED)` 条件生效）

### Phase C: 前端表单简化（P1）

**目标**：统一来源资料页、首页与今日页的录入体验

**前置条件**：Phase A steps 4–5（schema 放宽）已部署

1. `sources/page.tsx`：替换复杂表单为单 textarea
2. `api.ts`：更新 `createSource` 参数类型
3. `page.tsx`（首页）：简化 `handleCapture`（可选）
4. `today/page.tsx`（今日页）：简化 `handleQuickCapture`；清理 `detectCaptureType` 和 `captureTitle` 死代码（可选）
5. **`detectSourceType` 提取到 `shared` 包**：将 `detectSourceType` 从 `source/service.ts`
   提取到 `@ailearn/shared` 作为前后端共用的单一实现，消除与 `detectCaptureType` 的逻辑重复。
   确认 `detectSourceType` 覆盖了 `detectCaptureType` 的所有检测分支后再提取。

**验收标准**：
- 成员角色看不到创建入口（`hidden={!isOwner}` 保留）
- 无效 URL（非 http/https）前端拦截提示
- 表单提交后列表轮询状态更新正常
- 三处录入入口（来源页、首页、今日页）行为一致

---

## 7. 风险与缓解

| # | 风险 | 缓解措施 |
|---|---|---|
| R1 | gzip/deflate/br 解压引入内存风险（解压炸弹） | 采用 buffer-then-decompress 策略，双层防护：①压缩流收集阶段限制 `FETCH_MAX_BYTES * 2`（防内存耗尽）；②解压后 buffer 检查 `decompressed.length > FETCH_MAX_BYTES` 时 reject（防解压炸弹）；identity 分支保留 Content-Length 预检 |
| R2 | 类型修正可能与用户意图不符 | 通过 `metadata.typeSource` 区分：`"manual"` 不可覆盖，`"auto"` 可修正；`correctSourceType` 首参检查 typeSource |
| R3 | 标题提取可能不准确 | 保留原标题作为 fallback；仅当提取到非空标题时才覆盖——通过 `blocks.length > 0 && blocks.some(b => b.content.trim())` 判断 blocks 是否真正有内容，不依赖 `extractTitleFromBlocks` 返回的 "无标题笔记" 字符串做比较（详见 §3.3.1 边界 case 说明） |
| R4 | 前端旧版本仍传 type/title | API 向后兼容，旧版本不受影响 |
| R5 | SSRF 防护误杀合法 CDN | 本次不改动 SSRF 逻辑；未来可考虑增加 CDN IP 白名单或使用外部抓取服务 |
| R6 | **事务一致性**：title/type 回写破坏 archive 竞态不变式 | 标题/类型计算必须在 `withJobTransaction` 内部基于 `lockedSource`（FOR UPDATE 重读）进行，不可在事务外用 `processingSource` 预计算后带入；`finalSegments` 必须贯穿到事务内 segment 写入 |
| R7 | **Phase C 先于 Phase A steps 4–5 部署导致链路断裂** | Phase C（前端表单简化）硬依赖 Phase A steps 4–5（schema 放宽）。如果 Phase C 先部署，前端不传 type → 后端 schema 仍要求 type 必填 → 400 报错。Phase A 内部的 URL 修复（steps 1–3）和 schema 放宽（steps 4–5）本身可独立部署 |
| R8 | deflate raw 误判导致解压失败 | `inflateSync` 遇到 `Z_DATA_ERROR` 时 fallback 到 `inflateRawSync`（同步 API，buffer-then-decompress 策略） |
| R9 | **Worker job 超时与重试冲突** | 超时从 15s 延长到 20s + 1 次重试（含 1s 延迟），最坏情况约 41s。实施前必须确认 Worker 的 job 执行超时 ≥ 60s，否则重试可能无法完成。如 job 超时不足，需调低 `FETCH_TIMEOUT_MS` 或取消重试（`FETCH_RETRY_COUNT = 0`）。（已验证：`parse_source` 默认超时 60s，lease 超时 120s，41s 在安全范围内 ✅） |
| R10 | **URL 来源 HTML 标题提取死代码** | 原方案 `extractSourceTitle` 对 URL 来源调用 `extractHtmlTitle(rawContent)`，但 `rawContent` 已被 `extractTextFromHtml` 剥离 HTML 标签，提取永远失败。修正：`fetchUrlContent` 在剥离前提取标题存入 `FetchedContent.title` → 调用方写入 `metadata.fetchedTitle` → 事务内传入 `extractSourceTitle` 的 `fetchedTitle` 参数 |

---

## 8. 未来扩展

| # | 扩展点 | 说明 |
|---|---|---|
| F1 | 无头浏览器渲染 | 对于 JavaScript 渲染的 SPA 页面，引入 Puppeteer/Playwright 做服务端渲染抓取 |
| F2 | 外部抓取服务 | 对接 Jina Reader API 或 similar 服务，将 URL 转为 Markdown，绕过 SSRF 和压缩问题 |
| F3 | 用户提供自定义 UA | 允许用户在设置中配置自定义 User-Agent，用于需要特定 UA 的网站 |
| F4 | 来源去重 | 创建来源时检查 URL 是否已存在，避免重复收录 |
| F5 | 批量 URL 收录 | 支持一次粘贴多个 URL，批量创建来源 |
| F6 | 字符编码自动检测 | 从 `<meta charset>` 或 `Content-Type` 头解析页面编码，引入 `iconv-lite` 支持 GBK/GB2312 等非 UTF-8 编码（详见 §3.4.3 已知局限） |

---

## 9. 代码引用验证结果

> 以下为方案评审阶段对文档中所有关键行号引用的交叉验证结果，确认文档与实际代码一致。

### 9.1 `parse-source.ts` 引用验证

| 引用 | 验证结果 |
|---|---|
| 第 21 行 `FETCH_TIMEOUT_MS = 15_000` | ✅ 准确 |
| 第 22 行 `FETCH_MAX_BYTES = 500_000`（500KB） | ✅ 准确 |
| 第 279 行 `User-Agent: "AILearnBot/0.3"` | ✅ 准确 |
| 第 283 行 `Accept-Encoding: "identity"` | ✅ 准确 |
| 第 315–319 行 content-encoding 拒绝非 identity | ✅ 准确 |
| 第 355–375 行 `extractTextFromHtml` 简陋实现 | ✅ 准确 |
| 第 380–446 行 `fetchUrlContent` 返回 `string` | ✅ 准确 |
| 第 520 行 `const fetchedContent = await fetchUrlContent(...)` | ✅ 准确 |
| 第 544 行 `rawContent: fetchedContent` | ✅ 准确 |
| 第 566 行 `contentLength: fetchedContent.length` | ✅ 准确 |
| 第 587–645 行 无内容 ready 提交事务 | ✅ 准确（方案新增覆盖说明） |
| 第 665–742 行 有内容 ready 提交事务 | ✅ 准确 |
| 第 543 行 metadata spread 语法 `...lockedSource.metadata` | ✅ 准确 |

### 9.2 `source/schema.ts` 引用验证

| 引用 | 验证结果 |
|---|---|
| `type: z.enum([...])`（必填） | ✅ 准确 |
| `title: z.string().min(1).max(500)`（必填） | ✅ 准确 |
| `refine` 中 `type === "url"` 条件分支 | ✅ 准确 |

### 9.3 `source/service.ts` 引用验证

| 引用 | 验证结果 |
|---|---|
| 第 87 行 `input.type === "url"` 判断 `isUrlWithoutContent` | ✅ 准确 |
| 第 122 行 `type: input.type`（insert sources） | ✅ 准确 |
| 第 136 行 `isUrlWithoutContent` 用于 job payload | ✅ 准确 |

### 9.4 `markdown-parser.ts` 引用验证

| 引用 | 验证结果 |
|---|---|
| 第 91 行 `extractTitleFromBlocks(blocks: ParsedBlock[]): string` | ✅ 准确 |
| 第 100 行 返回 `"无标题笔记"`（无内容时） | ✅ 准确 |
| 第 103 行 `cleanTitle` 私有函数 | ✅ 准确 |

### 9.5 前端引用验证

| 引用 | 验证结果 |
|---|---|
| `today/page.tsx` 第 167 行 `detectCaptureType` | ✅ 准确 |
| `today/page.tsx` 第 183 行 `captureTitle` | ✅ 准确 |
| `today/page.tsx` 第 437 行 `handleQuickCapture` | ✅ 准确 |
| `sources/page.tsx` 第 30 行 `SOURCE_TYPE_META` | ✅ 准确 |
| `sources/page.tsx` 第 61 行 `isValidHttpUrl` | ✅ 准确 |
| `sources/page.tsx` 第 78 行 `useIsOwner` | ✅ 准确 |
| `page.tsx`（首页）第 159 行 `handleCapture` | ✅ 准确 |

---

## 10. 评审结论与修正记录

> 评审日期：2026-07-23
> 评审方式：逐文件交叉验证所有关键代码引用 + 数据流分析

### 10.1 已修正的问题

| # | 严重度 | 问题 | 修正内容 |
|---|---|---|---|
| F1 | 🔴 关键 | `extractSourceTitle` 对 URL 来源调用 `extractHtmlTitle(rawContent)` 是死代码——`rawContent` 已被 `extractTextFromHtml` 剥离 HTML 标签，提取永远失败 | §3.3.1：`extractSourceTitle` 新增 `fetchedTitle` 参数；§3.3 事务内从 `lockedSource.metadata.fetchedTitle` 读取并传入；§3.4.3 调用方**必须**将 `fetched.title` 写入 `metadata.fetchedTitle` |
| F2 | 🟡 中 | `detectSourceType` 的 Markdown 正则 `/^[#>*\-]/m` 比 `detectCaptureType` 宽松，`-5 度` 等纯文本会被误判 | §3.1：正则改为 `/^(#{1,6}\s\|>\|[-*+]\s\|\d+\.\s)/m`，与 `detectCaptureType` 对齐 |
| F3 | 🟡 中 | 重试延迟 `setTimeout` 不可被 job abort 信号中断 | §3.4.2：延迟绑定 `signal.addEventListener("abort")`，abort 时立即中断 |
| F4 | 🟡 低 | §6 部署依赖说明中 "Phase B step 3" 与 Phase B 步骤列表中 step 2 不一致 | §6：统一为 "step 2"，删除混淆性注释 |
| F5 | 🟢 优化 | `FetchedContent.url` 字段无调用方消费（YAGNI） | §3.4.3：移除 `url` 字段，返回语句同步更新 |
| F6 | 🟢 优化 | `extractTextFromHtml` 的 `<article>` 非贪婪匹配只取第一个，博客列表页会丢失正文 | §3.4.3：改为 `matchAll` 取最长 `<article>` |
| F7 | 🟢 优化 | `fetchUrlContent` 重试包装返回类型仍为 `Promise<string>` | §3.4.2：改为 `Promise<FetchedContent>` |

### 10.2 额外验证结果

| 验证项 | 结果 |
|---|---|
| `sources.title` 列为 `text NOT NULL`（无默认值） | ✅ 确认（`apps/api/src/db/schema/note.ts` 第 12 行） |
| `sources.type` 列为 `text NOT NULL`（无默认值） | ✅ 确认（同上第 11 行） |
| `parse_source` 默认超时 60s ≥ 最坏情况 41s | ✅ 确认（`handler-timeout-config.ts` 第 31 行 `parse_source: 60_000`） |
| lease 超时 120s > handler 超时 + 安全余量 | ✅ 确认（`queue.ts` 第 13 行 `LEASE_TIMEOUT_MS = 120_000`） |
| `extractTitleFromBlocks` 通过 worker re-export 可访问 | ✅ 确认（`workers/ai-worker/src/lib/markdown-parser.ts` 第 1 行 `export * from "@ailearn/shared/markdown-parser"`） |

### 10.3 未采纳的建议（记录备查）

| # | 建议 | 未采纳原因 |
|---|---|---|
| S1 | `correctSourceType` 内 `const text = content.trim()` 改名 | `text` 是常见变量名，改名增加 diff 噪声，不值得 |
| S2 | 解压炸弹防护注释中补充 `zlib` 同步 API 内存峰值说明 | 500KB 上限下内存可控（≈1.5MB），实践中不构成风险 |
| S3 | `correctSourceType` 增加 `code→text` 回退路径 | 实际影响小（code 分段策略不丢内容），方案已有注释说明，留作未来扩展 |
