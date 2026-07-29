# 来源收录简化与 URL 解析修复方案

> 创建日期：2026-07-23
> 状态：Implemented（2026-07-23）
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
| U5 | **SSRF 防护可能误杀** | `parse-source.ts` `resolvePublicAddress()` 第 210–249 行 | 部分 CDN 域名 DNS 返回内网地址（如 Cloudflare WARP、Tailscale、bilibili CDN），会被误判为私有地址而拒绝。**已修复**（详见 §14.3 IR-FIX6） |
| U6 | **User-Agent 可能被拦截** | `parse-source.ts` 第 279 行 | `AILearnBot/0.3` UA 被部分网站的反爬机制拦截，返回 403 |
| U7 | **字符编码硬编码 UTF-8** | `parse-source.ts` 第 434 行 `new TextDecoder("utf-8")` | 大量中文网站使用 GBK/GB2312 编码，硬编码 UTF-8 解码导致标题和正文乱码。本期不处理此问题（需引入 `iconv-lite`），但作为已知局限记录（详见 §3.4.3 和 §8 F6） |

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

> **⚠️ refine 放宽的边缘 case**：原 schema 对非 url 类型要求 `content` 必填，新 schema 统一为
> `url?.trim() || content?.trim()`。这导致 `{ type: "text", url: "https://example.com" }`（有 url
> 无 content）能通过校验。此时 `detectedType = input.type = "text"`（因为传了 type），
> `isUrlWithoutContent = false`（type 不是 "url"），Worker 不会抓取 URL，`rawContent` 为空，
> source 进入"无内容 ready"路径，body 只有 URL 字符串。**影响**：前端简化后不会发送此组合，
> 但旧前端或 API 直接调用可能触发。如需严格校验，可在 refine 中保留类型约束：
> `if (data.type && data.type !== "url") return Boolean(data.content?.trim());`。
> 当前方案选择放宽以简化逻辑，接受此边缘 case 的非最优行为（source 仍会创建为 ready，只是无正文）。
>
> **⚠️ 🟡 ER3 评审标注**：外部评审（§11.2 ER3）指出如果对接外部 API 的可能性不为零，
> 建议采用上述严格校验方案。代价很小但更安全。当前方案选择放宽可接受——但实施时需确认
> 无第三方 API 调用入口。如有外部 API 入口，应切换为严格校验。

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

新增 `detectSourceType` 工具函数（放在 `source/service.ts` 或 `shared` 中）。

> **⚠️ 已与 `detectCaptureType` 取并集统一**：以下实现已合并 `detectCaptureType`（today/page.tsx
> 第 167 行）的所有代码检测分支，包括 `interface`/`type`/`enum`/`from`/`private`/`protected`
> 关键字和 `^[a-zA-Z_$][\w$]*\s*[({]` 模式，以及原 `detectSourceType` 独有的
> `if __name__`/`#include`/`package` 关键字。Phase C step 5 提取到 `shared` 包时直接使用此实现。
>
> **``` 处理的设计差异**：`detectCaptureType` 将 ``` 作为 code 信号，本方案 `detectSourceType`
> 将 ``` 作为 markdown 信号——含代码块的内容按 markdown 分段（保留代码块结构）比按 code
> 整段处理更合理。这是**设计意图不同**，不是 bug。`correctSourceType`（Worker 端）中 ```
> 同时作为 code 和 md 评分指标，通过阈值判断最终类型。

```typescript
export function detectSourceType(content: string, url?: string): "text" | "markdown" | "code" | "url" {
  // URL 检测：有 url 参数且无 content，或 content 本身就是 URL
  if (url && /^https?:\/\//.test(url) && !content.trim()) return "url";
  const text = content.trim();
  if (/^https?:\/\/\S+$/i.test(text)) return "url";

  // 代码检测：合并 detectCaptureType 和原 detectSourceType 的所有关键字（并集）
  if (
    /^(?:function|const|let|var|class|interface|type|enum|import|export|def|from|public|private|protected|if __name__|#include|package)\b/m.test(text) ||
    /^[a-zA-Z_$][\w$]*\s*[({]/m.test(text) // 函数调用或定义模式
  ) {
    return "code";
  }

  // ``` 含代码块按 markdown 处理（保留代码块结构，而非 code 整段）
  if (/```/.test(text)) return "markdown";

  // Markdown 检测：标题、列表、引用等语法
  // ⚠️ 正则与 today/page.tsx 的 detectCaptureType 对齐，要求标记后有空格，
  //    避免 "-5 度" 等以 - 开头的纯文本被误判为 markdown。
  if (/^(#{1,6}\s|>|[-*+]\s|\d+\.\s)/m.test(text) || /\[.+?\]\(.+?\)/.test(text)) return "markdown";
  return "text";
}
```

> **⚠️ 与已有 `detectCaptureType` 的关系**：`apps/web/app/(workspace)/(default)/today/page.tsx`
> 第 167 行已有一个 `detectCaptureType` 函数，逻辑与 `detectSourceType` 高度相似但有差异。
> Markdown 检测正则已与 `detectCaptureType` 对齐（`/^(#{1,6}\s|>|[-*+]\s|\d+\.\s)/m`），
> 要求标记后有空格，避免 `-5 度` 等以 `-` 开头的纯文本被误判。
> Phase C 简化前端后，`detectCaptureType` 和 `captureTitle`（第 183 行）将变为死代码，
> 应一并清理。上方 `detectSourceType` 已覆盖 `detectCaptureType` 的所有检测分支（取并集），
> Phase C step 5 提取到 `shared` 包时可直接使用此实现作为前后端共用的单一实现。

> **⚠️ `detectSourceType` 与 `correctSourceType` 的两层检测关系**：方案中存在两个类型检测函数——
> `detectSourceType`（`source/service.ts`，创建时调用）使用简单正则做粗粒度初步检测，
> `correctSourceType`（`parse-source.ts`，Worker 解析时调用）使用多模式评分做细粒度修正。
> 两者检测精度不同是**设计意图**：`detectSourceType` 的职责是快速判断 `isUrlWithoutContent`
> 标记（决定 job payload 中是否需要 `fetchUrlContent`），不需要高精度；`correctSourceType`
> 的职责是基于完整内容做深度修正。一个 source 被前者判为 `text` 后被后者修正为 `markdown`
> 是预期行为，不构成逻辑冲突。

> **⚠️ 🔴 ER1 评审标注：`detectSourceType` 代码检测正则过于激进**：上方
> `/^[a-zA-Z_$][\w$]*\s*[({]/m` 正则会匹配**任何以单词开头、后跟空格和括号的行**，
> 例如 `"The (quick brown fox)"` 会被误判为 code。由于 `correctSourceType` 没有
> code→text 回退路径（S3 未采纳），误判后无法修正。实施时建议在 `correctSourceType`
> 中增加 `codeScore === 0 && mdScore === 0` 时返回 `"text"` 的回退路径
> （详见 §3.3.2 补充说明和 §11.2 ER1）。

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
// ─── 以下计算全部在事务内基于 lockedSource 进行，不在事务外预计算 ───
// ⚠️ 原代码（第 656–661 行）在事务外用 processingSource 预计算 segments 和 sourceBody，
//    然后直接用于事务内写入。但事务外预计算存在 TOCTOU 窗口（processingSource 与 lockedSource
//    可能不同），且预计算结果在事务内完全未被引用——事务内全部基于 lockedSource 重算。
//    因此删除事务外的 segments/sourceBody 预计算，避免对 500KB 内容的无意义双倍解析。

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
  // ⚠️ 从事务内 lockedSource.metadata 重读 rawContent，与 typeSource/fetchedTitle 保持一致。
  //    虽然实际风险较低（job lease + FOR UPDATE 防止并发），但 URL 抓取事务与 ready 提交
  //    事务之间存在理论上的 TOCTOU 窗口——另一事务可能修改 metadata.rawContent。
  //    始终从 lockedSource 重读确保事务内全部基于同一快照计算。
  const lockedRawContent = ((lockedSource.metadata ?? {}).rawContent as string) ?? rawContent;
  const lockedCorrectedType = correctSourceType(lockedRawContent, lockedSource.type, lockedTypeSource);
  // ⚠️ 始终基于 lockedCorrectedType 重新解析，不回退到事务外的 finalSegments。
  //    lockedSource.type 可能与 processingSource.type 不同（另一事务改过），
  //    此时事务外的 finalSegments 是用旧 type 计算的，回退到它会写入错误 segments。
  //    parseContent 开销可控（内容上限 500KB），牺牲少量性能消除一类隐 bug。
  const lockedFinalSegments = parseContent(lockedRawContent, lockedCorrectedType);
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

> **⚠️ import 语句需同步更新**：当前 `parse-source.ts` 第 10 行仅 `import { parseContent } from "../lib/markdown-parser.ts"`。
> 实施时需新增 `segmentsToBlocks`、`extractTitleFromBlocks`、`type ParsedBlock` 的导入
> （下方代码块首行展示了完整的 import 语句）。这些符号均通过 worker 的 re-export
> 文件 `workers/ai-worker/src/lib/markdown-parser.ts`（`export * from "@ailearn/shared/markdown-parser"`）可用。

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
 * @param origin 来源地址（URL 来源的最终回退：hostname）
 * @param fetchedTitle fetchUrlContent 从原始 HTML 中提取的标题（URL 来源优先使用）
 * 返回 null 表示未提取到，调用方应保留原标题
 */
export function extractSourceTitle(
  blocks: ParsedBlock[],
  sourceType: string,
  origin?: string | null,
  fetchedTitle?: string | null,
): string | null {
  // ⚠️ URL 来源：内容已被 extractTextFromHtml 剥离了 HTML 标签，
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
  // ⚠️ [^<]+ 不匹配含 < 字符的 title（如 <title>A < B</title>），会截断在 < 处。
  //    极罕见但如需更健壮可改为 [\s\S]*? 非贪婪匹配。当前实现对绝大多数网页足够。
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
> `extractSourceTitle` 不调用 `extractHtmlTitle`——它不接收原始 HTML 文本，
> URL 来源的标题通过 `fetchedTitle` 参数间接获取。如果 `fetchUrlContent` 将来被提取到
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
> **标题截断长度**：`extractTitleFromBlocks` 内部截取 60 字符（`.slice(0, 60)`），
> `extractSourceTitle` 对 blocks 提取的标题再做 `.slice(0, 100)` 但实际是 no-op（已是 60 字符）。
> `extractHtmlTitle` 截取 100 字符——这是 URL 来源标题的有效截断长度。
> 因此非 URL 来源有效截断为 60 字符，URL 来源为 100 字符。source 标题比笔记标题
> 允许更长（schema 允许 500 字符），兼顾了 URL 来源的网页标题长度和 UI 列表显示。
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
    /;\s*$/m,  // 行尾半角分号 — ⚠️ 英文文本中以 ; 结尾的句子也会命中（如 "do this; then that."），
               //    但需 codeScore >= 2 且 codeScore > mdScore 才触发修正，单指标命中不足以误判。
               //    注意：正则仅匹配半角分号 ;（U+003B），不匹配全角分号 ；（U+FF1B），
               //    中文文本中的全角分号不受影响。
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
> **⚠️ ``` 双重计分的设计意图**：`codeIndicators` 中有 `/```[\s\S]*?```/`（完整代码块），
> `mdIndicators` 中有 `/```/`（代码块标记）。含代码块的内容会同时增加 `codeScore` 和 `mdScore`——
> 这是**设计意图**而非 bug：代码块是 Markdown 的语法子集，Markdown 文档中嵌入代码块是常见模式。
> 当代码块大量出现且其他 code 信号（关键字、分号、控制流）远超 md 信号（标题、列表、引用等）时，
> 说明内容更接近纯代码文件而非 Markdown 文档，此时才触发 markdown→code 修正。
> 阈值 `codeScore > mdScore + 1` 确保 code 信号明显强于 markdown 信号时才修正。
>
> **⚠️ 阈值为经验值**：`codeScore >= 2`、`mdScore >= 2`、`codeScore >= 3` 等阈值基于经验设定，
> 非数据驱动。实施后应选取真实样本（含纯文本、Markdown、代码、混合内容各 20+ 条）验证修正准确率，
> 并根据实际效果调参。如发现误修正率 > 5%，应提高阈值或增加指标。
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
>
> **⚠️ 🔴 ER1 评审决策：采纳 code→text 回退**：外部评审（§11.2 ER1）指出
> `detectSourceType` 的 `/^[a-zA-Z_$][\w$]*\s*[({]/m` 正则会误判正常英文文本
> （如 `"The (quick brown fox)"`）为 code，而 `correctSourceType` 无回退路径导致
> 误判无法修正。评审建议采纳上方"如需更激进地回退"的方案，在 `originalType === "code"`
> 分支中增加 `codeScore === 0 && mdScore === 0` 时返回 `"text"` 的判断：
> ```typescript
> if (originalType === "code") {
>   if (codeScore === 0 && mdScore === 0) return "text";   // ER1: 误判回退
>   if (mdScore >= 2 && mdScore > codeScore) return "markdown";
> }
> ```
> 此回退仅对 `typeSource !== "manual"` 的 auto 来源生效（手动选择 code 的不会被修正），
> 且要求 codeScore 和 mdScore 均为 0（内容不含任何代码或 Markdown 特征）才触发。
> S3 的未采纳理由"实际影响小"在 ER1 场景下不成立——英文文本被 `^[a-zA-Z_$]` 正则
> 误判为 code 的概率远高于"首行恰好以 const 开头但实际是散文"的场景。

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

// ⚠️ 以下代码替换原 requestPinnedUrl 的 onResponse 回调中第 307–340 行的
//    Content-Length 预检 + content-encoding 检查 + 数据收集逻辑（整体替换）。
//    其余 onResponse 代码保持不变：
//    response.once("error", reject)（第 296 行）、重定向处理（第 301–305 行）
//    等均在以下代码之前执行。
//
//    ⚠️ 原始第 307–313 行的 Content-Length 预检移入 identity 分支内部——
//    压缩分支跳过预检（Content-Length 表示压缩后大小，不能用于判断解压后体积），
//    若保留在分支之前的通用位置，会拦截 Content-Length > FETCH_MAX_BYTES 的压缩响应，
//    导致压缩分支的 FETCH_MAX_BYTES * 2 上限形同虚设。
// 在 onResponse 回调中，替换 Content-Length 预检 + content-encoding 检查 + 数据收集逻辑
// ⚠️ 归一化：部分老服务器返回 `x-gzip`（等价于 `gzip`），统一为 `gzip` 简化后续分支判断
const rawEncoding = (getHeader(response, "content-encoding") ?? "identity").toLowerCase();
const contentEncoding = rawEncoding === "x-gzip" ? "gzip" : rawEncoding;

if (contentEncoding === "identity") {
  // identity：Content-Length 预检 + 流上限制（双重防护）
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
  // gzip / deflate / br（含归一化后的 x-gzip → gzip）：先收集完整压缩 buffer，再解压
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
  // ⚠️ 压缩分支不重复注册 response.once("error") ——
  //    第 296 行的 response.once("error", reject) 已对所有响应生效（在 onResponse
  //    开头注册），此处再注册会形成两个 once listener：Promise reject 第二次
  //    调用是 no-op 不会出错，但错误消息格式不一致（原始直接 reject err，
  //    此处包装为 new Error("compressed response stream error: ...")），
  //    先触发的 listener 决定错误格式，行为不确定。依赖第 296 行的已有 listener 即可。
} else {
  response.destroy();
  reject(new Error(`unsupported content encoding: ${contentEncoding}`));
  return;
}

/**
 * 解压 buffer，支持 gzip / deflate / br。
 * deflate 先尝试标准 zlib wrapper（inflateSync），Z_DATA_ERROR 时 fallback 到 raw deflate（inflateRawSync）。
 * ⚠️ 部分老服务器返回 `x-gzip`（等价于 `gzip`），在 contentEncoding 赋值时归一化为 `gzip`。
 */
function decompressBuffer(compressed: Buffer, encoding: string): Buffer {
  if (encoding === "gzip" || encoding === "x-gzip") {
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
> **Content-Length 预检**：原始第 307–313 行的通用 Content-Length 预检已**移入 identity 分支内部**。
> gzip/deflate/br 分支**跳过预检**（Content-Length 是压缩后大小，不能用于判断解压后体积）。
> 若保留在分支之前的通用位置，会拦截 `Content-Length > FETCH_MAX_BYTES` 的压缩响应，
> 导致压缩分支的 `FETCH_MAX_BYTES * 2` 上限形同虚设——压缩响应的 Content-Length
> 永远无法超过 500KB 到达压缩分支的 1MB 上限。
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
// ⚠️ NaN 防护：Number("abc") 返回 NaN，循环 `attempt <= NaN` 恒 false 会导致 lastError 为 null，
//    最终 throw null 而非 Error 对象。必须用 isFinite 校验后回退默认值。
const _parsedRetry = Number(process.env.SOURCE_FETCH_RETRY_COUNT ?? 1);
const FETCH_RETRY_COUNT = Number.isFinite(_parsedRetry) && _parsedRetry >= 0 ? _parsedRetry : 1;  // 增加 1 次重试（共 2 次尝试），可通过环境变量取消重试（设为 0）
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
      // ⚠️ 双向清理：timer 正常触发后应移除 abort listener，避免 listener 泄漏到
      //    长生命周期的 signal 上。abort 触发时 clearTimeout 已清理 timer。
      await new Promise<void>((resolve) => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 1000 * (attempt + 1));
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  throw lastError;
}
```

> **⚠️ `fetchUrlContentOnce` 实施指引**：上方的重试包装器中引用了 `fetchUrlContentOnce`，
> 该函数即当前 `fetchUrlContent`（§3.4.3 改造前）的原有逻辑重命名。**具体操作步骤**：
> 1. 将现有 `fetchUrlContent` 函数（`parse-source.ts` 第 380–446 行）整体重命名为 `fetchUrlContentOnce`，
>    保留原签名和参数（`url`, `signal`, `dependencies`）
> 2. 新增 `fetchUrlContent` 作为重试包装器（上方代码），内部调用 `fetchUrlContentOnce`
> 3. 原有逻辑包括 DNS 解析（`resolvePublicAddress`）、重定向跟随、Content-Length 预检、
>    流式收集、TextDecoder 解码、HTML 提取等**全部保留在 `fetchUrlContentOnce` 中不变**
> 4. Phase A 部署时 `fetchUrlContentOnce` 返回类型仍为 `string`；Phase B step 2 将返回类型改为 `FetchedContent`
>
> **⚠️ Phase A 返回类型澄清**：上方重试包装代码中 `Promise<FetchedContent>` 是
> **Phase B 完成后的最终签名**。Phase A 部署时，重试包装器和 `fetchUrlContentOnce`
> 的返回类型均为 `Promise<string>`——即重试逻辑包裹的仍是返回 `string` 的原有逻辑。
> 实施时 Phase A 的签名应为 `Promise<string>`，Phase B step 2 再统一改为 `Promise<FetchedContent>`。
>
> **⚠️ `FETCH_RETRY_COUNT` 环境变量**：与 `SOURCE_FETCH_ACCEPT_ENCODING` 一致，
> 重试次数通过 `SOURCE_FETCH_RETRY_COUNT` 环境变量控制，支持运行时回滚。
> 回滚：设 `SOURCE_FETCH_RETRY_COUNT=0` 即禁用重试，恢复原单次请求行为。
> 默认值 `1`（共 2 次尝试）。R9 中提到的"取消重试"通过此变量实现。
>
> **⚠️ NaN 防护**：若 `SOURCE_FETCH_RETRY_COUNT` 设为非法值（如 `"abc"`、空字符串），
> `Number(...)` 返回 `NaN`，循环条件 `attempt <= NaN` 恒为 `false`，循环体一次都不执行，
> `lastError` 保持 `null`，最终 `throw null` 抛出的是 `null` 而非 `Error` 对象——调用方
> `catch` 分支无法正常处理。上方代码已用 `Number.isFinite && >= 0` 校验后回退默认值 `1`。
>
> **⚠️ 环境变量需重启生效**：`FETCH_ACCEPT_ENCODING` 和 `FETCH_RETRY_COUNT` 均在模块
> 加载时读取（`process.env` 不会动态重读）。修改环境变量后需重启 Worker 进程才能生效，
> 非"热回滚"。如需热回滚，可改为在 `fetchUrlContent` 内部每次调用时读取 `process.env`，
> 但会增加每次请求的开销（当前模块级常量更高效）。
>
> **⚠️ 线性退避与超时风险**：重试延迟为 `1000 * (attempt + 1)`（线性增长，非指数退避）。
> 默认 `FETCH_RETRY_COUNT=1` 时延迟仅 1s，加上两次 fetch 各 20s，最坏 41s，安全。
> 但如果设为 `FETCH_RETRY_COUNT=5`，延迟总和 1+2+3+4+5=15s + 6 次 fetch × 20s = 135s，
> 远超 `parse_source` 的 60s 超时。**`FETCH_RETRY_COUNT` 不建议超过 1**，否则重试可能
> 无法在 job 超时内完成。如需更多重试，应同时调低 `FETCH_TIMEOUT_MS` 或改为指数退避
> 带上限（如 `Math.min(1000 * 2 ** attempt, 5000)`）。

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
>
> **⚠️ 重试包装器对现有测试的行为变更**：重试包装器将 `fetchUrlContent` 重命名为
> `fetchUrlContentOnce` 并新增了重试逻辑。现有通过 DI 注入 mock `request` 的测试，
> 如果 mock 设计为首次请求失败（如抛 `{ code: "ECONNRESET" }`），原本直接失败，
> 现在会被重试——测试可能意外从"期望失败"变为"重试后成功"。**建议在测试中设
> `SOURCE_FETCH_RETRY_COUNT=0` 禁用重试**，恢复单次请求行为，避免重试逻辑干扰
> 单元测试断言。重试行为本身应通过专门的 `parse-source-extra.test.ts` 重试用例验证。
>
> **⚠️ 环境变量设置时机**：`FETCH_RETRY_COUNT` 在模块加载时读取
> （`const FETCH_RETRY_COUNT = Number(process.env.SOURCE_FETCH_RETRY_COUNT ?? 1)`），
> 因此测试文件必须在 `parse-source.ts` 被 import **之前**设置此环境变量。
> 在 Vitest/Jest 中，正确做法是在全局 setup 文件（如 `vitest.setup.ts` 或 `jest.setup.ts`）
> 中设置：`process.env.SOURCE_FETCH_RETRY_COUNT = "0";`，而非在单个测试文件的 `beforeAll` 中设置
> （此时 `parse-source.ts` 已被 import，常量已固定）。如在测试 runner 的 `globalSetup` 中设置，
> 可确保所有测试文件生效。

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

> **⚠️ `<header>` 移除风险**：部分网站将文章标题 `<h1>` 放在 `<article><header><h1>标题</h1></header>` 结构中。
> 移除 `<header>` 会丢失该 heading，影响 blocks 提取路径的标题回退。影响范围有限——URL 来源标题提取
> 走 `fetchedTitle` 路径，仅在 `fetchedTitle` 提取失败（网页无 `<title>`）且 blocks fallback 时才受影响。
> 如需更保守，可改为只移除 `<article>` 标签之外的页面级 `<header>`，或在移除前先提取 `<header>` 内的 `<h1>` 文本。

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
// ⚠️ 版本号 0.5 是 Bot 自身版本，不与项目版本（v0.6）挂钩，仅用于标识爬虫迭代版本。
"User-Agent": "Mozilla/5.0 (compatible; AILearnBot/0.5; +https://github.com/ailearn)",
```

#### 3.4.5 可观测性（P1）

> **⚠️ 无度量则无法验证改善**：本方案核心目标是"提升 URL 解析成功率"，但当前代码
> 缺少结构化指标来量化改善效果。以下日志增强不增加新依赖，仅利用已有 `logger` 输出
> 结构化字段，便于后续接入 Prometheus 或日志分析平台。

**文件**：`workers/ai-worker/src/handlers/parse-source.ts`

在 `fetchUrlContent` 和 `runParseSource` 中增加以下结构化日志字段：

```typescript
// 1. fetchUrlContent 返回时 — 记录压缩编码和响应大小
logger.info(
  { sourceId, url, contentEncoding, contentLength: decompressed.length, fetchMs },
  "URL fetched successfully",
);

// 2. 重试触发时 — 记录重试次数和错误类型
logger.warn(
  { sourceId, url, attempt: attempt + 1, errCode: errCode ?? "unknown", errMessage: lastError.message },
  "URL fetch retry triggered",
);

// 3. extractSourceTitle 返回时 — 记录标题来源和是否提取成功
logger.info(
  { sourceId, titleSource: lockedFetchedTitle ? "html_title" : extractedTitle ? "blocks" : "fallback", titleLength: finalTitle.length },
  "source title extracted",
);

// 4. correctSourceType 修正时 — 记录原始类型和修正后类型
if (lockedCorrectedType !== lockedSource.type) {
  logger.info(
    { sourceId, originalType: lockedSource.type, correctedType: lockedCorrectedType, typeSource: lockedTypeSource },
    "source type corrected",
  );
}
```

> **注意**：以上日志字段为建议值，实施时可根据实际 `logger` 接口调整字段名。关键是确保
> 能从日志中回答以下问题：
> - URL 抓取的压缩编码分布（gzip/deflate/br/identity 占比）
> - 重试触发率（多少比例的请求需要重试，重试后成功率）
> - 标题提取成功率（从 HTML title 提取 vs blocks 提取 vs fallback 的分布）
> - 类型修正触发率（多少 source 被修正，text→markdown 占比等）

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
>
> **⚠️ 旧代码 `hasMarkdown` 正则不一致**：上方"修改前"代码中 `hasMarkdown = /^[#>*\-]/m.test(text)`
> 不要求标记后有空格，`-5 度` 等以 `-` 开头的纯文本会被误判为 markdown。这与 `detectSourceType`
> 和 `detectCaptureType` 的 `/^(#{1,6}\s|>|[-*+]\s|\d+\.\s)/m`（要求标记后有空格）不一致。
> 简化后此正则被删除，不一致问题自动消除。如不简化，应将此正则对齐为要求空格的版本。

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
- ⚠️ GBK/GB2312 编码的中文网站不在 ≥80% 成功率的测试范围内（已知局限 U7）：
  这些网站因字符编码硬编码 UTF-8（`parse-source.ts` 第 434 行 `new TextDecoder("utf-8")`）
  导致标题和正文乱码，需引入 `iconv-lite` 才能修复（详见 §8 F6）。
  测试样本应以 UTF-8 编码的网站为主。
- ⚠️ 🟡 **ER2 评审建议**：Phase A 完成后，应额外用真实中文网站（含 GBK/GB2312 编码站点，
  如部分知乎、CSDN、博客园页面）做一轮验证，量化 U7 的实际影响范围（乱码率、无法解析比例），
  以便决定是否需要提前将 F6（字符编码自动检测）提优先级。验证结果应记录在部署报告中。

**回滚策略**：
- `parse-source.ts` 改动通过环境变量 `SOURCE_FETCH_ACCEPT_ENCODING` 控制：
  - 默认 `"gzip, deflate, br, identity"`
  - 回滚设为 `"identity"` 即恢复原行为
  - ⚠️ 需重启 Worker 进程生效（`process.env` 在模块加载时读取，非动态）
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

> **⚠️ `typeSource` 功能窗口期**：Phase B 部署后、Phase C 部署前，旧前端仍始终传 `type`，
> 导致所有新建 source 的 `metadata.typeSource = "manual"`，`correctSourceType` 对这些 source
> 是 no-op（不修正类型）。**标题提取不受影响**——`extractSourceTitle` 不检查 `typeSource`，
> 会正常提取并回写标题。类型修正功能在 Phase C 部署（前端不再传 `type`）后才对新建 source
> 生效。存量 source 在 retry 时会被修正（`typeSource` 为 `undefined`，视为 `"auto"`）。
> 这不是 bug 而是 graceful degradation：在两个 Phase 都部署前的中间状态下，只有标题提取
> 这一增量功能生效，类型修正等待前端简化后才启动。

**验收标准**：
- URL 来源解析后 title 为网页标题而非 URL 截断
- Markdown 来源解析后 title 为第一个 heading
- `typeSource === "manual"` 的来源不被 `correctSourceType` 覆盖
- 事务一致性：archive 竞态下不回写 title/type（`ne(status, ARCHIVED)` 条件生效）

**回滚策略**：
- Phase B 的 `fetchUrlContent` 返回类型变更是破坏性改动，回滚需 `git revert` Phase B 全部 commit
  并重新部署 Worker 进程
- 回滚不影响已创建的 source 数据：metadata 中的 `fetchedTitle` 字段被旧代码忽略（spread 语法保留但不被读取），
  title 和 type 已写入的值保持不变
- 回滚后新建 source 不再有标题自动提取和类型修正，但 Phase A 的 URL 解析修复和 schema 放宽仍生效
- ⚠️ 如果 Phase C 已部署（前端不传 type），Phase B 回滚后 `correctSourceType` 消失但
  `detectSourceType`（Phase A step 5）仍工作——source 创建时仍有初步类型检测，
  只是 Worker 不再深度修正。标题保持占位标题（URL 截断或首行文本），不会报错

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
| R5 | SSRF 防护误杀合法 CDN | **已修复**：改为过滤私有地址、选择公网地址的策略（详见 §14.3 IR-FIX6）。安全性不变——`createPinnedLookup` 固定 IP，被跳过的私有地址永远不会被连接 |
| R6 | **事务一致性**：title/type 回写破坏 archive 竞态不变式 | 标题/类型计算必须在 `withJobTransaction` 内部基于 `lockedSource`（FOR UPDATE 重读）进行，不可在事务外用 `processingSource` 预计算后带入；`finalSegments` 必须贯穿到事务内 segment 写入 |
| R7 | **Phase C 先于 Phase A steps 4–5 部署导致链路断裂** | Phase C（前端表单简化）硬依赖 Phase A steps 4–5（schema 放宽）。如果 Phase C 先部署，前端不传 type → 后端 schema 仍要求 type 必填 → 400 报错。Phase A 内部的 URL 修复（steps 1–3）和 schema 放宽（steps 4–5）本身可独立部署 |
| R8 | deflate raw 误判导致解压失败 | `inflateSync` 遇到 `Z_DATA_ERROR` 时 fallback 到 `inflateRawSync`（同步 API，buffer-then-decompress 策略） |
| R9 | **Worker job 超时与重试冲突** | 超时从 15s 延长到 20s + 1 次重试（含 1s 延迟），最坏情况约 41s。实施前必须确认 Worker 的 job 执行超时 ≥ 60s，否则重试可能无法完成。如 job 超时不足，需调低 `FETCH_TIMEOUT_MS` 或取消重试（`FETCH_RETRY_COUNT = 0`）。（已验证：`parse_source` 默认超时 60s，lease 超时 120s，41s 在安全范围内 ✅） |
| R10 | **URL 来源 HTML 标题提取死代码** | 原方案 `extractSourceTitle` 对 URL 来源调用 `extractHtmlTitle(rawContent)`，但 `rawContent` 已被 `extractTextFromHtml` 剥离 HTML 标签，提取永远失败。修正：`fetchUrlContent` 在剥离前提取标题存入 `FetchedContent.title` → 调用方写入 `metadata.fetchedTitle` → 事务内传入 `extractSourceTitle` 的 `fetchedTitle` 参数 |
| R11 | **Phase B–C 间 `typeSource` 功能窗口期** | Phase B 部署后 Phase C 部署前，旧前端始终传 `type`，所有新 source 的 `typeSource = "manual"`，`correctSourceType` 为 no-op。标题提取不受影响（不检查 `typeSource`）。类型修正在 Phase C 部署后才对新建 source 生效；存量 source 在 retry 时修正（`typeSource` 为 `undefined` 视为 `"auto"`）。详见 §6 Phase B 说明 |
| R12 | **`correctSourceType` 分号正则误判** | `/;\s*$/m` 匹配任何以**半角**分号结尾的行，英文自然文本中的分号句也会命中（全角分号 `；` 不受影响）。缓解：需 `codeScore >= 2 && codeScore > mdScore` 才触发 text→code 修正，单指标命中不足以误判 |

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
| F7 | HTTP 429/503 Retry-After | 当前重试仅覆盖瞬时网络错误（ECONNRESET 等），不重试 HTTP 4xx。但 429 (Too Many Requests) 和 503 (Service Unavailable) 常带 `Retry-After` 头，是 web 抓取中值得按服务器建议延迟重试的场景 |

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
| F8 | 🔴 关键 | 事务内 `correctSourceType` 和 `parseContent` 使用事务外局部变量 `rawContent`，存在 TOCTOU 窗口 | §3.3：新增 `lockedRawContent` 从 `lockedSource.metadata.rawContent` 重读，事务内全部基于 `lockedSource` 快照计算 |
| F9 | 🟡 中 | `extractSourceTitle` 的 `rawContent` 参数声明后从未使用（F1 修正后的残留死参数） | §3.3.1：移除 `rawContent` 参数，同步更新 JSDoc、注释和调用方 |
| F10 | 🟡 中 | `detectSourceType` 未覆盖 `detectCaptureType` 的 `interface`/`type`/`enum`/`from`/`private`/`protected` 关键字和 `^[a-zA-Z_$]` 模式 | §3.1：补充分支对比表，Phase C step 5 提取到 shared 前必须取并集 |
| F11 | 🟡 低 | 标题截断长度描述称"统一 100 字符"，但 blocks 路径实际为 60 字符（`extractTitleFromBlocks` 内部已截取） | §3.3.1：修正描述为"URL 来源 100 字符，其余来源 60 字符" |
| F12 | 🟢 优化 | `extractTextFromHtml` 移除 `<header>` 可能丢失 `<article>` 内的 `<h1>` 标题 | §3.4.3：补充风险说明和缓解建议 |
| F13 | 🟢 优化 | §3.4.2 重试包装引用 `fetchUrlContentOnce` 但未说明其实现 | §3.4.2：补充说明即当前 `fetchUrlContent` 原逻辑重命名 |
| F14 | 🟡 中 | §3.4.2 重试包装代码签名 `Promise<FetchedContent>` 是 Phase B 版本，Phase A 部署时返回类型仍为 `string`，但代码未标注可能误导实施者 | §3.4.2：新增 Phase A 返回类型澄清注释，明确 Phase A 签名为 `Promise<string>` |
| F15 | 🟡 中 | `FETCH_RETRY_COUNT` 硬编码为常量，与 `SOURCE_FETCH_ACCEPT_ENCODING` 环境变量回滚策略不一致；R9 提到可设为 0 但未说明通过何种机制 | §3.4.2：改为 `process.env.SOURCE_FETCH_RETRY_COUNT ?? 1`，与 URL 修复的回滚策略一致 |
| F16 | 🟡 中 | Phase B–C 间存在 `typeSource` 功能窗口期：旧前端传 `type` → 所有新 source 为 `manual` → 类型修正 no-op，文档未说明此中间状态 | §6 Phase B：新增功能窗口期说明，明确标题提取不受影响、类型修正在 Phase C 后生效 |
| N1 | 🔴 关键 | `FETCH_RETRY_COUNT` 环境变量设为非法值（如 `"abc"`）时 `Number()` 返回 `NaN`，循环不执行，`throw null` 而非 `Error` | §3.4.2：增加 `Number.isFinite && >= 0` 校验后回退默认值 `1` |
| N2 | 🟡 中 | Schema refine 放宽后 `{ type: "text", url: "..." }` 无 content 组合可通过校验但产生空 source（原 schema 对非 url 类型要求 content 必填） | §3.1：补充边缘 case 说明，提供可选严格校验方案 |
| N3 | 🟡 中 | §3.3 事务外预计算 `segments`/`correctedType`/`finalSegments`/`sourceBody` 在事务内完全未被引用，对 500KB 内容无意义双倍解析 | §3.3：删除事务外死代码，注释说明全部计算移入事务内 |
| N4 | 🟡 低 | 环境变量回滚策略称"设为 identity 即恢复原行为"，但未提及需重启 Worker 进程生效 | §3.4.1 + §6 回滚策略：补充"需重启 Worker 进程生效"说明 |
| N5 | 🟡 低 | `correctSourceType` 分号正则注释示例使用全角分号 `；`，但正则 `/;\s*$/m` 仅匹配半角分号 `;`，示例不成立 | §3.3.2：修正注释为英文示例，补充"仅匹配半角分号"说明 |
| N6 | 🟡 低 | §3.4.1 解压代码片段未说明仅替换 content-encoding 检查部分，实施者可能误替换整个 `onResponse` 回调 | §3.4.1：补充注释"替换第 315–320 行，其余 onResponse 代码不变" |
| N7 | 🟡 低 | `parse-source.ts` import 语句需新增 `segmentsToBlocks`/`extractTitleFromBlocks`/`ParsedBlock` 但未单独提示 | §3.3.1：新增 import 更新提示，说明可通过 re-export 文件获取 |
| N8 | 🟢 优化 | 首页 `hasMarkdown` 正则 `/^[#>*\-]/m` 不要求标记后有空格，与 `detectSourceType`/`detectCaptureType` 不一致 | §3.5：补充旧代码正则不一致说明，简化后自动消除 |
| N9 | 🟢 优化 | §3.4.2 重试延迟的 abort listener 在 timer 正常触发后未移除，可能泄漏到长生命周期 signal | §3.4.2：改为双向清理——timer 回调中 `removeEventListener` |
| N10 | 🟢 优化 | User-Agent 版本号 `0.5` 与项目版本 `v0.6` 不一致可能造成混淆 | §3.4.4：补充注释"Bot 自身版本，不与项目版本挂钩" |
| N11 | 🟡 中 | §3.4.1 替换范围注释称"替换第 315–320 行"，但实际替换代码包含 Content-Length 预检 + content-encoding 检查 + 数据收集逻辑（原 307–340 行），实施者只替换 315–320 会导致 identity 分支与原始 322–340 数据收集重复 | §3.4.1：修正注释为"替换第 307–340 行（整体替换）" |
| N12 | 🟡 中 | §3.4.1 原始第 307–313 行 Content-Length 预检保留在分支之前的通用位置，对压缩响应也生效——Content-Length > 500KB 的压缩响应会被拦截，导致压缩分支的 `FETCH_MAX_BYTES * 2` 上限形同虚设 | §3.4.1：明确原始 307–313 检查移入 identity 分支内部，压缩分支跳过预检 |
| N13 | 🟡 中 | §3.4.2 重试包装器将 `fetchUrlContent` 重命名为 `fetchUrlContentOnce` 并新增重试，现有通过 DI mock `request` 的测试若 mock 首次失败会被重试，可能从"期望失败"变为"重试后成功" | §3.4.2：补充测试行为变更说明，建议测试中设 `SOURCE_FETCH_RETRY_COUNT=0` 禁用重试 |
| N14 | 🟢 低 | §3.4.1 压缩分支重复注册 `response.once("error")`——第 296 行已对所有响应注册，此处再注册形成两个 once listener，错误消息格式不确定 | §3.4.1：移除压缩分支的重复 error listener，注释说明依赖第 296 行已有 listener |
| N15 | 🟢 低 | `decompressBuffer` 用严格相等 `=== "gzip"` 判断，漏掉 `x-gzip` 编码变体（部分老服务器使用） | §3.4.1：contentEncoding 赋值时归一化 `x-gzip → gzip`，`decompressBuffer` 兼容 `x-gzip` |
| N16 | 🟢 低 | §3.4.2 重试延迟 `1000 * (attempt + 1)` 为线性退避，`FETCH_RETRY_COUNT` 设高时延迟总和 + fetch 时间可能超过 job 60s 超时 | §3.4.2：补充线性退避超时警告，建议 `FETCH_RETRY_COUNT` 不超过 1 |
| N17 | 🟢 低 | §1 背景中未提及字符编码（charset）已知局限，但主要用户群为中国用户、大量中文网站使用 GBK/GB2312，该问题影响显著 | §1：新增 U7 条目记录字符编码硬编码 UTF-8 的已知局限 |
| R1 | 🟡 中 | `detectSourceType` 缺少 `interface`/`type`/`enum`/`from`/`private`/`protected` 关键字和 `^[a-zA-Z_$][\w$]*\s*[({]` 模式，与 `detectCaptureType` 不一致，但文档仅说"Phase C 统一"未给出统一实现 | §3.1：直接给出取并集后的统一 `detectSourceType` 完整实现，删除对比表，Phase C step 5 可直接使用 |
| R2 | 🟡 中 | `correctSourceType` 中 ``` 同时出现在 `codeIndicators` 和 `mdIndicators` 中（双重计分），文档未显式说明此设计意图 | §3.3.2：新增 ``` 双重计分设计意图说明，解释代码块是 Markdown 子集的设计理由 |
| R3 | 🟡 中 | `correctSourceType` 阈值（`codeScore >= 2`、`mdScore >= 2`、`codeScore >= 3` 等）为经验值，文档未说明需实施后调参验证 | §3.3.2：新增阈值经验值说明，建议实施后选取真实样本验证修正准确率 |
| R4 | 🟡 中 | `fetchUrlContentOnce` 仅说"原有逻辑重命名"，未给出明确操作步骤，实施者可能误操作 | §3.4.2：补充 4 步操作指引，明确"将第 380–446 行整体重命名、新增包装器" |
| R5 | 🟡 中 | N13 建议测试中设 `SOURCE_FETCH_RETRY_COUNT=0` 但未说明该变量在模块加载时读取，测试文件 `beforeAll` 中设置无效 | §3.4.2：补充环境变量设置时机说明，指导在全局 setup 文件中设置 |
| R6 | 🟡 中 | 缺少可观测性设计——无法从日志量化 URL 解析成功率改善、重试触发率、标题提取成功率等核心指标 | §3.4.5：新增可观测性小节，定义 4 个结构化日志字段 |
| R7 | 🟡 中 | Phase B 有破坏性改动（`fetchUrlContent` 返回类型变更）但缺少回滚策略，仅 Phase A 有 | §6 Phase B：新增回滚策略，说明 `git revert` + 重部署、数据不受影响、与 Phase C 的回滚交互 |

### 10.2 额外验证结果

| 验证项 | 结果 |
|---|---|
| `sources.title` 列为 `text NOT NULL`（无默认值） | ✅ 确认（`apps/api/src/db/schema/note.ts` 第 12 行） |
| `sources.type` 列为 `text NOT NULL`（无默认值） | ✅ 确认（同上第 11 行） |
| `parse_source` 默认超时 60s ≥ 最坏情况 41s | ✅ 确认（`handler-timeout-config.ts` 第 31 行 `parse_source: 60_000`） |
| lease 超时 120s > handler 超时 + 安全余量 | ✅ 确认（`queue.ts` 第 13 行 `LEASE_TIMEOUT_MS = 120_000`） |
| `extractTitleFromBlocks` 通过 worker re-export 可访问 | ✅ 确认（`workers/ai-worker/src/lib/markdown-parser.ts` 第 1 行 `export * from "@ailearn/shared/markdown-parser"`） |
| 测试文件 `parse-source.test.ts` 和 `parse-source-extra.test.ts` 共约 30+ 个断言将 `fetchUrlContent` 返回值当字符串使用 | ✅ 确认（Phase B step 2 需同步更新为 `result.text`） |
| 前端 `api.ts` 第 1152–1161 行 `createSource` 参数 type/title 均为必填 | ✅ 确认（Phase C step 2 需改为 optional） |
| `segmentsToBlocks` 通过 worker re-export 可访问 | ✅ 确认（`packages/shared/src/markdown-parser.ts` 第 58 行定义，通过 `export *` re-export 可用） |
| 原始第 296 行 `response.once("error", reject)` 在 onResponse 开头注册 | ✅ 确认（压缩分支无需重复注册 error listener） |
| 原始第 307–313 行 Content-Length 预检在 content-encoding 分支之前执行 | ✅ 确认（需移入 identity 分支，否则压缩响应被误拦） |

### 10.3 未采纳的建议（记录备查）

| # | 建议 | 未采纳原因 |
|---|---|---|
| S1 | `correctSourceType` 内 `const text = content.trim()` 改名 | `text` 是常见变量名，改名增加 diff 噪声，不值得 |
| S2 | 解压炸弹防护注释中补充 `zlib` 同步 API 内存峰值说明 | 500KB 上限下内存可控（≈1.5MB），实践中不构成风险 |
| S3 | `correctSourceType` 增加 `code→text` 回退路径 | 原因：实际影响小（code 分段策略不丢内容），方案已有注释说明，留作未来扩展。**⚠️ ER1 评审后改为采纳**：外部评审发现 `detectSourceType` 的 `^[a-zA-Z_$][\w$]*\s*[({]` 正则会误判英文文本为 code，S3 原始未采纳理由不成立。已在 §3.3.2 补充 `codeScore === 0 && mdScore === 0` 回退逻辑，详见 §11.2 ER1 |
| S4 | 重试逻辑增加 HTTP 429/503 Retry-After 支持 | 当前重试覆盖范围已够用（瞬时网络错误），429/503 场景较少且需解析 Retry-After 头，复杂度不匹配当前需求。记录为 §8 F7 未来扩展 |
| S5 | 重试延迟改为指数退避带上限（`Math.min(1000 * 2 ** attempt, 5000)`） | 默认 `FETCH_RETRY_COUNT=1` 时线性与指数差异可忽略（1s vs 1s），增加代码复杂度不值得。已在 §3.4.2 补充超时警告供未来参考 |

---

## 11. 外部评审意见（2026-07-23）

> 评审方式：完整阅读方案文档（1607 行）并交叉验证所有引用的源文件
> 评审结论：**方案可进入实施阶段**，以下为需关注的问题和建议

### 11.1 总体评价

方案质量极高、可实施性强。根因分析准确（U1–U7 逐一与实际代码核对无误），方案设计合理，边界 case 覆盖全面，部署策略清晰。§10 的评审修正记录（F1–F15, N1–N17, R1–R12）尤其有价值，将多个关键的实现陷阱提前暴露并给出了修正方案。

### 11.2 需关注的问题

#### 🔴 ER1：`detectSourceType` 代码检测正则过于激进（高优先级）

`detectSourceType` 中的 `/^[a-zA-Z_$][\w$]*\s*[({]/m` 正则会匹配**任何以单词开头、后跟空格和括号的行**，导致正常英文文本被误判为 code：

```
"The (quick brown fox)"  → 匹配 "The" + 空格 + "(" → 误判为 code
"This (is a test)"       → 同样误判
```

此正则继承自 `today/page.tsx` 的 `detectCaptureType`（第 175 行），但 §3.3.2 的 `correctSourceType` **没有 code→text 回退路径**（S3 未采纳）。一旦 `detectSourceType` 误判为 code 且 `typeSource` 为 `"auto"`，Worker 无法修正回 text——code 的分段策略是整段作为一个 segment，对纯文本来说会丢失段落切分。

**建议**（二选一）：
1. 收紧正则：如要求括号前无空格 `/^[a-zA-Z_$][\w$]*\s*\(/m`，或增加排除常见英文单词的逻辑
2. 在 `correctSourceType` 中增加 `codeScore === 0 && mdScore === 0` 时返回 `"text"` 的回退路径（即重新考虑采纳 S3）

> **决策记录**：实施时选择方案 2（增加 code→text 回退），因为收紧正则难以覆盖所有英文单词场景，而回退路径是更稳健的防御性措施。详见 §3.3.2 补充说明。

#### 🟡 ER2：GBK/GB2312 字符编码未处理的影响面评估（中优先级）

方案已记录 U7（`new TextDecoder("utf-8")` 硬编码 UTF-8），并推迟到未来扩展 F6。验收标准明确排除 GBK 网站。但考虑到主要用户群为中国用户，大量中文网站（如部分知乎、CSDN、博客园页面）使用 GBK 编码，此问题的影响面可能比预估更大。

**建议**：Phase A 完成后，用真实中文网站（含 GBK/GB2312 编码站点）做一轮验证，量化此问题的影响范围，以便决定是否需要提前将 F6 提优先级。

#### 🟡 ER3：Schema refine 放宽的边缘 case（中优先级）

N2 已记录：`{ type: "text", url: "https://example.com" }`（有 url 无 content）能通过新 schema 校验但产生无正文 source。方案选择放宽接受此行为。

**建议**：如果对接外部 API 的可能性不为零，建议采用方案中提到的严格校验：

```typescript
if (data.type && data.type !== "url") return Boolean(data.content?.trim());
```

代价很小但更安全。当前方案选择放宽以简化逻辑，可接受——但实施时需确认无第三方 API 调用入口。

#### 🟡 ER4：事务复杂度增加（中优先级）

§3.3 的 ready 提交事务中新增了 `correctSourceType`、`parseContent`（可能调用两次）、`segmentsToBlocks`、`extractSourceTitle` 等计算。对于 500KB 内容，纯 CPU 正则操作开销在毫秒级，考虑到 `parse_source` 的 60s 超时，判断可接受。但如果未来内容上限提高，需注意行锁持有时间。

#### 🟢 ER5：`<header>` 移除风险（低优先级）

§3.4.3 改进的 `extractTextFromHtml` 移除 `<header>` 标签可能丢失 `<article><header><h1>` 中的标题。方案已记录此风险，URL 来源标题优先走 `fetchedTitle` 路径，仅在 `fetchedTitle` 提取失败时才受影响。影响范围有限，可接受。

### 11.3 代码引用验证结果

评审中对 §9 的关键引用项进行了独立抽查，全部准确：

| 验证项 | 结果 |
|---|---|
| `schema.ts`：`type` 必填、`title: z.string().min(1).max(500)` 必填 | ✅ |
| `service.ts`：第 87 行 `input.type === "url"`、第 122 行 `type: input.type`、第 136 行 `isUrlWithoutContent` | ✅ |
| `parse-source.ts`：第 283 行 `Accept-Encoding: identity`、第 316–319 行拒绝非 identity | ✅ |
| `parse-source.ts`：第 520/544/566 行 `fetchedContent` 作为 string 使用 | ✅ |
| `parse-source.ts`：第 434 行 `new TextDecoder("utf-8")` | ✅ |
| `api.ts`：第 1152–1161 行 `createSource` 参数 type/title 必填 | ✅ |
| `today/page.tsx`：第 167 行 `detectCaptureType`、第 183 行 `captureTitle`、第 437 行 `handleQuickCapture` | ✅ |
| `markdown-parser.ts`：第 91 行 `extractTitleFromBlocks`、第 100 行返回 `"无标题笔记"` | ✅ |

### 11.4 评审建议汇总

| 优先级 | 编号 | 建议 | 理由 |
|---|---|---|---|
| 🔴 高 | ER1 | 收紧 `detectSourceType` 正则或增加 code→text 回退 | 正常英文文本会被误判为 code，且无回退路径 |
| 🟡 中 | ER2 | Phase A 后用真实中文网站验证 GBK 影响 | 量化 U7 的实际影响面，决定是否提前排期 |
| 🟡 中 | ER3 | 考虑采用严格 schema refine | 防御第三方 API 调用的边缘 case |
| 🟡 中 | ER4 | 事务复杂度监控 | 当前可接受，但内容上限提高时需注意 |
| 🟢 低 | ER5 | `<header>` 移除风险 | 影响范围有限，已记录缓解措施 |

---

## 12. 二次评审意见（2026-07-23）

> 评审方式：完整阅读方案文档（1718 行）+ 全部引用源文件交叉验证（`parse-source.ts` 828 行、`schema.ts` 40 行、`service.ts` 472 行、`markdown-parser.ts` 288 行、`api.ts` 1607 行、`page.tsx` 765 行、`today/page.tsx`、`handler-timeout-config.ts` 等）
> 评审结论：**方案可进入实施阶段**，以下为补充意见

### 12.1 总体评价

方案质量极高、可实施性强。根因分析（U1–U7）逐一与实际代码核对无误，TOCTOU 修正（F8）、`typeSource` 标记设计、buffer-then-decompress 策略、deflate raw fallback、NaN 防护、三层分阶段部署、环境变量回滚策略等设计决策均合理。§10–§11 的自审/外部评审修正记录（F1–F16、N1–N17、R1–R12、ER1–ER5）将绝大多数实现陷阱提前暴露，尤其有价值。

### 12.2 补充验证结果

二次评审中额外验证了以下项：

| 验证项 | 结果 |
|---|---|
| `parse_source` handler 超时 = 60s（`handler-timeout-config.ts` 第 31 行） | ✅ 准确 |
| lease 超时 = 120s（`queue.ts` 第 13 行） | ✅ 准确 |
| 最坏情况 20s + 1s + 20s = 41s < 60s | ✅ 在安全范围内 |
| `api.ts` 第 1152–1157 行 `createSource` 参数 `type: SourceType` 和 `title: string` 当前必填 | ✅ 准确 |
| `markdown-parser.ts` 第 91 行 `extractTitleFromBlocks` 已导出，worker re-export 文件第 1 行 `export *` 可访问 | ✅ 准确 |
| `today/page.tsx` 第 167 行 `detectCaptureType` 含 `interface`/`type`/`enum`/`from`/`private`/`protected` 关键字 | ✅ 准确 |
| 首页 `page.tsx` 第 159 行 `handleCapture` 前端检测逻辑 | ✅ 准确 |
| 三条事务提交路径行号引用（525–559 / 587–645 / 665–742） | ✅ 准确 |

### 12.3 需关注的问题

#### 🟡 IR1：`correctSourceType` 的 `codeIndicators` 与 `detectSourceType` 关键字集不对称（中优先级）

`detectSourceType`（§3.1）包含 `interface`/`type`/`enum`/`from`/`private`/`protected` 等关键字，但 `correctSourceType`（§3.3.2）的 `codeIndicators` 数组不包含这些。这意味着一个以 `interface Foo {` 开头的 TypeScript 定义文件：

- `detectSourceType` 会检测为 `code`
- `correctSourceType` 中 `codeScore` 可能为 0（如果没有分号、控制流等其他信号）
- ER1 回退触发（`codeScore === 0 && mdScore === 0`）→ `code→text` 降级

虽然 ER1 回退是预期的防御性措施（内容确实没有强 code 信号时应降级），但对于真正的 TypeScript 接口定义文件，`interface`/`type`/`enum` 本身就是强 code 信号，不应因为缺少分号就被降级。

**建议**：在 `correctSourceType` 的 `codeIndicators` 中也加入 `interface`/`type`/`enum` 关键字正则，保持两个函数的信号一致性：

```typescript
const codeIndicators = [
  /^(function|const|let|var|class|import|export|def |#include|package |public class)/m,
  /^(interface|type|enum|from|private|protected)\b/m,  // 新增：与 detectSourceType 对齐
  /```[\s\S]*?```/,
  /^(if|for|while|switch|try|catch)\s*\(/m,
  /;\s*$/m,
];
```

> **注意**：`from` 关键字单独出现时在英文文本中太常见（如 "from the beginning"），建议排除 `from` 或改为 `^from\s+/m`（行首 + `from` + 空格，匹配 ES module import 语法）。

#### 🟡 IR2：Schema refine 放宽建议直接采用严格校验（中优先级）

ER3 已指出 `{ type: "text", url: "https://example.com" }`（有 url 无 content）能通过新 schema 但产生空 source。方案选择放宽以简化逻辑。

**建议**：直接采用严格校验版本，代价很小但更安全：

```typescript
.refine(
  (data) => {
    if (data.type && data.type !== "url") return Boolean(data.content?.trim());
    return Boolean(data.url?.trim() || data.content?.trim());
  },
  { message: "url or content is required" },
)
```

#### 🟡 IR3：Phase A 验收建议将中文 GBK 网站测试列为必选项（中优先级）

ER2 建议用真实中文网站验证 GBK 影响。考虑到主要用户群为中国用户，大量中文网站使用 GBK/GB2312 编码，此问题影响面可能比预估更大。

**建议**：将 ER2 的验证从"建议"提升为 Phase A 验收的**必选项**。选取 5–10 个 GBK 编码的中文网站（如部分知乎、CSDN、博客园页面），量化乱码率和无法解析比例。如乱码率 > 20%，应提前将 F6（字符编码自动检测）提优先级到 Phase B。

#### 🟢 IR4：`detectSourceType` 正则可考虑进一步收紧（低优先级）

ER1 的 `code→text` 回退已提供兜底，但 `detectSourceType` 的 `/^[a-zA-Z_$][\w$]*\s*[({]/m` 正则仍然会误判大量英文文本为 code。虽然 `correctSourceType` 可以修正，但这增加了不必要的 `code→text` 修正开销，且在 Phase B 部署前的窗口期内（`typeSource = "manual"`），误判无法修正。

**可选改进**（二选一）：
1. 收紧为要求括号前无空格：`/^[a-zA-Z_$][\w$]*\s*\(/m`（仅匹配 `foo(` 或 `foo{` 模式）
2. 增加排除常见英文单词的逻辑（如维护一个 stop words 列表）

> 此改进非阻塞性——ER1 回退已覆盖最坏情况。可后续迭代处理。

### 12.4 实施建议

1. **优先实施 Phase A**：URL 解析失败是用户反馈的核心痛点，Phase A steps 1–3 能立竿见影提升成功率
2. **Phase A 验收包含中文 GBK 网站测试**（IR3）
3. **`correctSourceType` 阈值用真实样本验证**：选取纯文本/Markdown/代码/混合内容各 20+ 条，如误修正率 > 5% 应调参
4. **考虑在 `codeIndicators` 中对齐 `detectSourceType` 的关键字集**（IR1）
5. **Schema refine 直接采用严格校验版本**（IR2）
6. **测试同步更新**：
   - `fetchUrlContent` 返回类型变更（Phase B step 2）是破坏性改动，需同步更新所有调用方和测试 mock
   - 重试包装器对现有测试的行为变更——建议在全局 setup 文件中设 `SOURCE_FETCH_RETRY_COUNT=0` 禁用重试
   - 压缩响应测试基于 `FetchUrlDependencies` DI 模式注入 mock `PinnedRequester`

### 12.5 评审建议汇总

| 优先级 | 编号 | 建议 | 理由 |
|---|---|---|---|
| 🟡 中 | IR1 | `correctSourceType` 的 `codeIndicators` 对齐 `detectSourceType` 关键字集 | 防止 TypeScript 接口定义文件被误降级为 text |
| 🟡 中 | IR2 | Schema refine 直接采用严格校验版本 | 代价很小但更安全，防御第三方 API 调用边缘 case |
| 🟡 中 | IR3 | Phase A 验收将中文 GBK 网站测试列为必选项 | 量化 U7 实际影响面，决定 F6 是否需要提前排期 |
| 🟢 低 | IR4 | `detectSourceType` 正则可进一步收紧 | 减少误判，但 ER1 回退已兜底，可后续迭代 |

---

## 13. 实施后代码审查（2026-07-23）

> 审查方式：逐文件对照方案文档检查实际实现，运行全部测试（96 个，全通过）
> 审查结论：**实施方案整体质量高**，三阶段改动均按方案落地。发现一个关键 bug 已修复。

### 13.1 实施验证结果

| Phase | 验证项 | 结果 |
|---|---|---|
| A | gzip/deflate/br 解压 + deflate raw fallback + x-gzip 归一化 | ✅ |
| A | 解压炸弹防护（压缩流 2x 上限 + 解压后 FETCH_MAX_BYTES 检查） | ✅ |
| A | 超时 20s + 环境变量控制重试 + NaN 防护 | ✅ |
| A | User-Agent 更新为 Mozilla 兼容格式 | ✅ |
| A | Schema title/type optional + IR2 严格校验 | ✅ |
| A | `detectSourceType` + 默认标题 + `metadata.typeSource` 标记 | ✅ |
| B | `FetchedContent { text, title }` 返回类型 + 所有调用方更新 | ✅ |
| B | `extractHtmlTitle`（og:title 优先 + `<title>` 回退 + head 截取优化） | ✅ |
| B | `extractTextFromHtml`（article/main 提取 + nav/footer/header/aside 移除） | ✅ |
| B | `extractSourceTitle`（fetchedTitle → blocks → hostname 回退链） | ✅ |
| B | `correctSourceType`（typeSource 保护 + ER1 code→text 回退） | ✅ |
| B | 事务内全部基于 `lockedSource` 计算（TOCTOU 修正） | ✅ |
| B | 搜索索引用 `finalTitle` + `lockedCorrectedType` | ✅ |
| B | 可观测性日志（压缩编码/重试/标题来源/类型修正） | ✅ |
| C | `sources/page.tsx` 单 textarea + 自动检测 | ✅ |
| C | `api.ts` createSource 参数 type/title optional | ✅ |
| C | `page.tsx` handleCapture 简化 | ✅ |
| C | `today/page.tsx` handleQuickCapture 简化 + detectCaptureType/captureTitle 清理 | ✅ |
| 测试 | 压缩解压/decompressBuffer/重试/abort/标题提取/类型修正/事务 | ✅ 96 pass |

### 13.2 发现的问题与修复

#### 🔴 IR-FIX1：`public`/`private`/`protected` 作为独立关键字导致英文文本误判（已修复）

**问题**：实施方案在 `detectSourceType`（`service.ts`）和 `correctSourceType`（`parse-source.ts`）的关键字列表中添加了 `public`、`private`、`protected` 作为独立关键字。方案文档 §3.1 的 `detectSourceType` 代码只包含 `public class`（两词模式），不包含独立 `public`/`private`/`protected`。方案 §12.3 IR1 建议在 `correctSourceType` 的 `codeIndicators` 中加入 `interface`/`type`/`enum`/`from`/`private`/`protected`，但**不包含 `public`**。

**根因链**：
1. `detectSourceType("public transport is great\n...", undefined)` → `^public\b` 匹配 → 返回 `"code"`
2. `correctSourceType("public transport...", "code", "auto")` → `public` 在 `codeIndicators` 中匹配 → `codeScore = 1`
3. code→text 回退条件 `codeScore === 0 && mdScore === 0` → **false**（codeScore=1）
4. 返回 `"code"` ← **英文文本被永久误判为 code**

**与 `from` 移除的平行推理**：方案明确移除了 `from`（"from the beginning" 等英文文本误判），`public`/`private`/`protected` 是同样的常见英文单词（"public transport"、"private matter"、"protected species"），应适用相同处理。

**修复**：
1. `detectSourceType`（`service.ts`）：移除 `public|private|protected` 独立关键字，保留 `public class` 两词模式
2. `correctSourceType`（`parse-source.ts`）：从第二条 `codeIndicators` 中移除 `public|private|protected`，保留 `interface|type|enum`
3. 更新 `parse-source-extra.test.ts` 测试用例
4. 全部 96 个测试通过（74 extra + 22 basic）

**影响范围**：
- 新建来源：`detectSourceType` 不再将 "public transport" 等英文文本误判为 code
- 存量来源：`correctSourceType` 的 code→text 回退（codeScore=0 && mdScore=0）能正确修正存量误判
- 真实代码检测：完整 Java/TypeScript 代码（含 `public class` + `;` + 其他信号）仍能正确检测（codeScore ≥ 2）

#### 🔴 IR-FIX2：`type` 作为独立关键字导致英文文本误判（已修复）

**问题**：`detectSourceType`（`service.ts`）和 `correctSourceType`（`parse-source.ts`）的关键字列表中包含 `type` 作为独立关键字。`type` 是非常常见的英文单词（"type of music"、"type your name"、"type a letter"），与已被移除的 `from`/`public`/`private`/`protected` 属于完全相同的误判模式。

**根因链**：
1. `detectSourceType("type of music is important\n...", undefined)` → `^type\b` 匹配 → 返回 `"code"`
2. `correctSourceType("type of music...", "code", "auto")` → `^(interface|type|enum)\b` 匹配 → `codeScore = 1`
3. code→text 回退条件 `codeScore === 0 && mdScore === 0` → **false**（codeScore=1）
4. 返回 `"code"` ← **英文文本被永久误判为 code**

**与 `from`/`public`/`private`/`protected` 移除的平行推理**：方案已移除 `from`（"from the beginning"）、`public`/`private`/`protected`（"public transport" 等），`type` 是同样的常见英文单词，应适用相同处理。

**修复**：
1. `detectSourceType`（`service.ts`）：从关键字正则中移除 `type`，保留 `interface`/`enum`
2. `correctSourceType`（`parse-source.ts`）：从第二条 `codeIndicators` 中移除 `type`，保留 `interface`/`enum`
3. 新增 3 个测试用例（type 误判检测 + 回退修正 + TypeScript type 定义仍可检测）
4. 全部 99 个测试通过（74 extra + 22 basic + 3 new）

**影响范围**：
- 新建来源：`detectSourceType` 不再将 "type of music" 等英文文本误判为 code
- 存量来源：`correctSourceType` 的 code→text 回退（codeScore=0 && mdScore=0）能正确修正存量误判
- 真实代码检测：TypeScript 代码（含 `type Foo = string;` + `const bar` + `;`）仍能正确检测（codeScore ≥ 2）
- 已知局限：仅有 `type` 定义无其他代码信号的极短片段（如单行 `type Foo = string`）不会被检测为 code，但此场景在实际使用中极罕见

### 13.3 未发现问题的项

| 验证项 | 结果 |
|---|---|
| `extractSourceTitle` 不依赖 "无标题笔记" 字符串比较 | ✅ 用 `blocks.some(b => b.content.trim())` 前置检查 |
| `decompressBuffer` 的 Z_DATA_ERROR 检查同时检查 err.code 和 err.message | ✅ |
| Content-Length 预检只在 identity 分支内，压缩分支跳过 | ✅ |
| 压缩分支不重复注册 `response.once("error")` | ✅ |
| 重试延迟双向清理（timer 移除 abort listener + abort 移除 timer） | ✅ |
| 重试延迟进入前预检 `signal?.aborted` | ✅ |
| `typeSource` 通过 metadata spread 语法存活 | ✅ `{ ...lockedSource.metadata, rawContent, ... }` |
| 无内容 ready 路径不受影响 | ✅ 路径②使用 `lockedSource.title` 原始值 |

---

## 14. 二次实施后代码审查（2026-07-23）

> 审查方式：逐文件对照方案文档和 §13 审查记录检查实际实现，运行全部测试（106 个，全通过）
> 审查结论：**发现 3 个问题已修复**，修复后全部 106 个测试通过（101 原有 + 5 新增）

### 14.1 发现的问题与修复

#### 🟡 IR-FIX3：`correctSourceType` 缺少 `if __name__` 关键字导致 Python 脚本误降级（已修复）

**问题**：`detectSourceType`（`service.ts`）的关键字列表包含 `if __name__`（Python 入口模式），但 `correctSourceType`（`parse-source.ts`）的 `codeIndicators` 第一条不包含此关键字。这导致 `detectSourceType` 与 `correctSourceType` 的关键字集不对齐——IR1 要求两者对齐但遗漏了 `if __name__`。

**根因链**：
1. 用户粘贴 Python 脚本 `if __name__ == "__main__":`，无其他代码关键字（无 `def`/`import`/`;` 等）
2. `detectSourceType` 检测到 `if __name__` 关键字 → 返回 `"code"`
3. `correctSourceType` 中 `codeScore = 0`（`if __name__` 不在 codeIndicators 中，`if\s*\(` 也不匹配 `if __name__`）
4. code→text 回退条件 `codeScore === 0 && mdScore === 0` → **true**（无 code 和 md 信号）
5. 返回 `"text"` ← **Python 脚本被错误降级为 text**

**修复**：
1. `correctSourceType`（`parse-source.ts`）：在第一条 `codeIndicators` 正则中添加 `if __name__`，与 `detectSourceType` 完全对齐
2. 新增 2 个测试用例验证 `if __name__` 不再误降级

**影响范围**：
- Python 脚本：`if __name__` 入口模式不再被 `correctSourceType` 误降级为 text
- 关键字对齐：`detectSourceType` 与 `correctSourceType` 的关键字集完全一致（IR1 目标达成）

#### 🟡 IR-FIX4：`extractHtmlTitle` og:title 提取在标题含引号时截断（已修复）

**问题**：`extractHtmlTitle` 中提取 og:title `content` 属性的正则 `content=["']([^"']+)["']` 使用 `[^"']` 同时排除 `"` 和 `'`。当属性用 `"` 分隔但标题含 `'`（如 `content="John's Blog"`），正则在 `'` 处截断，提取结果为 `John` 而非 `John's Blog`。

**根因**：`[^"']` 字符类排除了两种引号字符，不区分属性值的实际分隔符。即使属性用 `"` 分隔，`'` 也会被当作结束引号。

**修复**：
- 改用反向引用 `content=(["'])([\s\S]*?)\1`：`\1` 回引开头的引号字符，`[\s\S]*?` 非贪婪匹配任意字符（包括另一种引号）
- `contentMatch` 的捕获组从 `[1]` 改为 `[2]`（第一组是引号本身，第二组是内容）

**影响范围**：
- 含单引号的英文网页标题（如 "John's Blog"）不再被截断
- 含双引号的标题（用单引号分隔时，如 `content='Say "Hi"'`）也正确提取

#### 🟢 IR-FIX5：`extractHtmlTitle` `<title>` 提取在标题含 `<` 时截断（已修复）

**问题**：`extractHtmlTitle` 中提取 `<title>` 标签内容的正则 `[^<]+` 不匹配含 `<` 字符的标题。如 `<title>A < B</title>` 会在 `<` 处截断，提取结果为 `A ` 而非 `A < B`。方案 §3.3.1 已注明此为已知局限（"极罕见但如需更健壮可改为 [\s\S]*? 非贪婪匹配"），本次修复采纳该建议。

**修复**：
- 正则从 `([^<]+)` 改为 `([\s\S]*?)` 非贪婪匹配

**影响范围**：
- 含 `<` 字符的网页标题（如数学比较 `A < B`）不再被截断

### 14.2 修复验证

| 修复 | 验证项 | 结果 |
|---|---|---|
| IR-FIX3 | `if __name__` 在 `correctSourceType` codeIndicators 中 | ✅ |
| IR-FIX3 | Python 脚本不误降级为 text | ✅ 新增测试通过 |
| IR-FIX3 | `if __name__` + 分号触发 text→code 修正 | ✅ 新增测试通过 |
| IR-FIX4 | og:title 标题含单引号正确提取 | ✅ 新增测试通过 |
| IR-FIX4 | og:title 标题含双引号正确提取 | ✅ 新增测试通过 |
| IR-FIX5 | `<title>` 标签含 `<` 字符正确提取 | ✅ 新增测试通过 |
| IR-FIX6 | DNS 混合公网/私有地址时跳过私有使用公网 | ✅ 新增测试通过 |
| IR-FIX6 | DNS 全部私有地址仍然拒绝（SSRF 不变） | ✅ 新增测试通过 |
| IR-FIX6 | 被跳过的私有地址记录 warn 日志 | ✅ |
| 全部 | 108 个测试通过（101 原有 + 7 新增） | ✅ |

### 14.3 SSRF 防护误杀修复（生产问题）

#### 🔴 IR-FIX6：`resolvePublicAddress` DNS 混合地址误杀合法 CDN 域名（已修复）

**触发场景**：用户收录 `https://www.bilibili.com/opus/...`，Worker 日志报错 `blocked: private/internal host (www.bilibili.com)`，URL 抓取失败。

**根因**：`resolvePublicAddress` 的旧策略是"DNS 返回的所有地址中任何一个被判定为私有就拒绝整个 hostname"。Bilibili 等大型 CDN 域名的 DNS 会同时返回公网和内网地址（CDN 节点内部地址、负载均衡器地址等），导致整个域名被误杀。

**安全分析**：改为"过滤私有地址、只从公网地址中选择"是安全的：
1. `createPinnedLookup` 固定连接 IP——被跳过的私有地址永远不会被连接
2. SSRF 防护目标是不连接内网地址——新策略保证只连接公网地址
3. 如果全部地址都是私有——仍然拒绝（安全不变）
4. 旧策略注释称"selecting only the public subset would still let an attacker influence which destination is reached"——此担忧不成立，因为公网地址本身就是外部可达的，攻击者无法通过 DNS 操纵使服务器连接到内网

**修复**：
1. `resolvePublicAddress`：将 `for` 循环逐个拒绝改为 `filter` 过滤私有地址
2. 全部地址私有时仍抛 `blocked` 错误，错误消息包含被拒绝的 IP 列表（便于诊断）
3. 部分地址被跳过时输出 `logger.warn` 日志，记录跳过的 IP 和公网/总数比例
4. 新增 2 个测试用例验证过滤行为

**影响范围**：
- Bilibili、知乎等中国 CDN 域名不再被误杀
- IP 字面量检查（127.0.0.1、::1 等）不受影响——仍直接拒绝
- `localhost`/`.local`/`.internal` hostname 检查不受影响——仍直接拒绝
- 全部私有地址的 hostname 不受影响——仍拒绝

---

## 15. 三次审查后修复（2026-07-23）

> 审查方式：逐文件对照方案文档和 §13–§14 审查记录检查实际实现，运行全部测试（116 个，全通过）
> 审查结论：**发现 2 个问题已修复**，修复后全部 116 个测试通过（108 原有 + 2 isPrivateIpAddress + 6 新增）

### 15.1 发现的问题与修复

#### 🟡 IR-FIX7：`extractHtmlTitle` 不解码 HTML 实体（已修复）

**问题**：`extractHtmlTitle` 提取 og:title 和 `<title>` 标签内容时，不解码 HTML 实体。例如 `content="Tom &amp; Jerry"` 提取结果为 `Tom &amp; Jerry` 而非 `Tom & Jerry`。这导致 URL 来源的标题在数据库和 UI 中显示为未解码的实体字符串。

**根因**：`extractTextFromHtml` 有完整的 HTML 实体解码逻辑（`&amp;` → `&`、`&lt;` → `<` 等），但 `extractHtmlTitle` 是独立函数，未复用此逻辑。`extractHtmlTitle` 在 `extractTextFromHtml` 之前调用（从原始 HTML 提取标题），两者各自独立处理，实体解码被遗漏。

**修复**：
1. 新增 `decodeHtmlEntities()` 辅助函数，封装与 `extractTextFromHtml` 一致的 6 种常见实体解码
2. og:title 路径：`contentMatch[2].trim()` → `decodeHtmlEntities(contentMatch[2].trim()).replace(/\s+/g, " ").slice(0, 100)`
3. `<title>` 路径：`titleMatch[1].trim()` → `decodeHtmlEntities(titleMatch[1].trim()).replace(/\s+/g, " ").slice(0, 100)`
4. 新增 6 个测试用例验证实体解码和空白归一化

**影响范围**：
- 含 HTML 实体的网页标题（如 `Tom &amp; Jerry`、`A &lt; B`）正确解码后存储
- og:title 和 `<title>` 的实体解码行为一致
- `extractTextFromHtml` 中的内联实体解码保留（热路径性能优化，避免函数调用开销）

#### 🟢 IR-FIX8：`extractHtmlTitle` og:title 路径不归一化空白（已修复）

**问题**：`extractHtmlTitle` 的 `<title>` 路径有 `.replace(/\s+/g, " ")` 归一化空白（多个空格/换行/制表符合并为单个空格），但 og:title 路径没有。例如 `content="  Hello    World  "` 在 og:title 路径返回 `Hello    World`（内部多余空格未归一化），而在 `<title>` 路径返回 `Hello World`。

**修复**：og:title 路径也添加 `.replace(/\s+/g, " ")`，与 `<title>` 路径保持一致。

**影响范围**：
- og:title 含多余空白时正确归一化
- 两个路径的空白处理行为一致

### 15.2 修复验证

| 修复 | 验证项 | 结果 |
|---|---|---|
| IR-FIX7 | og:title 含 `&amp;` 正确解码为 `&` | ✅ 新增测试通过 |
| IR-FIX7 | og:title 含多种实体（`&lt;` `&amp;` `&gt;` `&quot;` `&#39;`）正确解码 | ✅ 新增测试通过 |
| IR-FIX7 | `<title>` 含 `&amp;` 正确解码为 `&` | ✅ 新增测试通过 |
| IR-FIX7 | og:title 含 `&nbsp;` 正确解码为空格 | ✅ 新增测试通过 |
| IR-FIX8 | og:title 多余空白归一化为单个空格 | ✅ 新增测试通过 |
| IR-FIX8 | `<title>` 含换行和缩进正确归一化 | ✅ 新增测试通过 |
| 全部 | 116 个测试通过（108 原有 + 2 isPrivateIpAddress + 6 新增） | ✅ |

### 15.3 未发现问题的项

| 验证项 | 结果 |
|---|---|
| Schema IR2 严格校验（非 url 类型要求 content 必填） | ✅ |
| `detectSourceType` 关键字集与 `correctSourceType` codeIndicators 完全对齐（IR1） | ✅ |
| `correctSourceType` code→text 回退（ER1，codeScore===0 && mdScore===0） | ✅ |
| `correctSourceType` 不包含 `from`/`public`/`private`/`protected`/`type` 独立关键字 | ✅ |
| `correctSourceType` 包含 `if __name__`（IR-FIX3） | ✅ |
| `extractHtmlTitle` og:title 使用反向引用处理引号（IR-FIX4） | ✅ |
| `extractHtmlTitle` `<title>` 使用 `[\s\S]*?` 匹配含 `<` 字符（IR-FIX5） | ✅ |
| `resolvePublicAddress` DNS 混合地址过滤私有使用公网（IR-FIX6） | ✅ |
| 压缩响应解压（gzip/deflate/br/deflate-raw fallback/x-gzip 归一化） | ✅ |
| 解压炸弹防护（压缩流 2x 上限 + 解压后 FETCH_MAX_BYTES 检查） | ✅ |
| Content-Length 预检只在 identity 分支内，压缩分支跳过 | ✅ |
| 压缩分支不重复注册 `response.once("error")` | ✅ |
| 重试延迟双向清理（timer 移除 abort listener + abort 移除 timer） | ✅ |
| 重试延迟进入前预检 `signal?.aborted` | ✅ |
| NaN 防护（`Number.isFinite && >= 0` 校验后回退默认值 1） | ✅ |
| `typeSource` 通过 metadata spread 语法存活 | ✅ |
| 无内容 ready 路径不受影响（使用 `lockedSource.title` 原始值） | ✅ |
| 事务内全部基于 `lockedSource` 计算（TOCTOU 修正） | ✅ |
| `finalSegments` 始终基于 `lockedCorrectedType` 重新解析 | ✅ |
| 搜索索引用 `finalTitle` + `lockedCorrectedType` | ✅ |
| 可观测性日志（压缩编码/重试/标题来源/类型修正） | ✅ |
| 前端三处录入入口（来源页、首页、今日页）行为一致 | ✅ |
| `detectCaptureType`/`captureTitle` 死代码已清理 | ✅ |
| `api.ts` createSource 参数 type/title optional | ✅ |
