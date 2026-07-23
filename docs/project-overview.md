# 理解引擎 — 项目技术介绍

> 版本：v0.5.0　|　状态：Private Alpha　|　最后更新：2026-07-21

## 1. 项目定位

**理解引擎**（Understanding Engine）是一个面向个人学习的 AI 原生知识系统。它将资料采集、笔记编辑、AI 学习卡生成、证据对齐、理解验证、复习调度和理解关系图连接成一条**可追溯的学习闭环**——每一条知识断言都能回溯到原文证据，每一次理解判定都驱动下一次复习时间。

与传统笔记工具的区别在于：

- **AI 不是附加功能，而是核心引擎**：笔记写完后由 AI 提炼学习卡（claim + 原文 quote），用户通过回答验证题被 AI 判定理解程度，判定结果驱动离散档位复习调度。
- **证据可追溯**：每个 key point 的 claim 都必须由原文片段（quote_text）支撑，系统通过 n-gram 对齐算法自动将 quote 定位到笔记的具体 block。
- **理解可度量**：理解事件（seen / validated / misunderstood / reviewed）形成时间线，理解关系图可视化 source → note → card → key_point 的完整知识拓扑。

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      浏览器 (Next.js 15)                      │
│  登录 / 笔记编辑 / 学习卡 / 验证 / 复习 / 搜索 / 理解图 / 设置  │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP (HttpOnly Cookie + CSRF)
┌──────────────────────────▼──────────────────────────────────┐
│                   API 服务 (Fastify 5)                        │
│  认证 / 笔记 / 卡片 / 证据 / 验证 / 复习 / 来源 / 搜索 /       │
│  理解图 / 导出 / 统计 / 基准测试 / 上传 / 任务                 │
│  ──────────────────────────────────────────                   │
│  RLS 租户事务 · Prometheus 指标 · 优雅关闭                    │
└──────────┬───────────────────────────────┬───────────────────┘
           │                               │
           │  INSERT jobs (pending)        │  claim jobs (running)
           ▼                               ▼
┌──────────────────────────┐   ┌───────────────────────────────┐
│   PostgreSQL 16          │◄──│   AI Worker (独立进程)          │
│  ─────────────────       │   │  ──────────────────────────    │
│  28+ 业务表 + RLS policy │   │  generate_card                 │
│  pg_trgm 全文搜索        │   │  align_evidence                │
│  SECURITY DEFINER 队列   │   │  evaluate_validation           │
│  函数                    │   │  parse_source                  │
└──────────────────────────┘   │  ──────────────────────────    │
           ▲                   │  lease token · 幂等 · 重试     │
           │                   │  隐私治理 · 审计日志            │
           │                   └───────────┬───────────────────┘
           │                               │
    ┌──────┴───────┐              ┌────────▼────────┐
    │  MinIO (可选) │              │  AI Provider    │
    │  图片对象存储  │              │  Mock /         │
    └──────────────┘              │  DashScope /    │
                                  │  OpenAI-compat  │
                                  └─────────────────┘
```

系统由四个独立进程组成，共享同一个 PostgreSQL 数据库：

| 进程 | 技术 | 职责 |
| --- | --- | --- |
| **Web** (`apps/web`) | Next.js 15, React 19, TypeScript | SSR/CSR 前端应用，端口 3000 |
| **API** (`apps/api`) | Fastify 5, Drizzle ORM, Zod | REST API，认证，业务逻辑，端口 4000 |
| **Worker** (`workers/ai-worker`) | Node.js, TypeScript | 后台 AI 任务消费，独立进程 |
| **PostgreSQL** | PostgreSQL 16 | 数据库 + 任务队列 + 全文搜索 |

## 3. 技术栈总览

| 层 | 技术选型 | 选型理由 |
| --- | --- | --- |
| **前端框架** | Next.js 15 (App Router) + React 19 | 文件路由、SSR、Server Components |
| **前端样式** | Tailwind CSS + 自定义 CSS tokens | 设计系统 token + 深色/浅色主题 |
| **前端类型** | TypeScript 5.7 | 端到端类型安全 |
| **API 框架** | Fastify 5 | 高性能、插件体系、Pino 日志 |
| **ORM** | Drizzle ORM 0.45 | 类型安全 SQL 构建器，接近原生 SQL |
| **校验** | Zod 3 | 运行时 schema 校验，AI 输出契约 |
| **数据库** | PostgreSQL 16 | RLS、pg_trgm、advisory lock、SECURITY DEFINER |
| **对象存储** | MinIO (S3 兼容) | 图片上传，可选 |
| **监控** | Prometheus + prom-client + Alertmanager | SLO 指标与告警 |
| **日志** | Pino (结构化 JSON) | 高性能日志 |
| **构建** | esbuild (API/Worker) + Next.js build (Web) | CJS bundle |
| **开发运行** | tsx watch + Docker Compose | 热重载 |
| **部署** | Docker Compose (dev / prod / alpha) | 容器化 |
| **CI** | GitHub Actions | 构建、测试、迁移、安全扫描、生产 Compose 验证 |

---

## 4. 核心能力技术详解

### 4.1 来源采集与异步解析

**能力**：支持文本、Markdown、代码和 URL 四种来源类型，由 AI Worker 异步解析为结构化 segment，供笔记引用。

**数据模型**：

```
sources (id, workspace_id, type, title, origin, status, metadata, created_by)
  └── source_segments (id, source_id, workspace_id, ordinal, text, char_start, char_end, segment_type)
```

来源状态机：`draft → processing → ready / failed → archived`

- `type` 字段支持 `text | markdown | code | url`
- `source_segments.segment_type` 支持 `paragraph | heading | code | quote | list`
- `note_blocks.source_ref` JSON 字段可指向 `{ sourceId, segmentId }`，建立笔记块与来源片段的引用关系

**异步解析流程**：

1. API 创建 `sources` 记录（status = `processing`）并插入 `parse_source` job
2. Worker 的 `runParseSource` handler 消费 job，抓取 URL 内容或分段已有文本
3. 解析完成后写入 `source_segments` 表，更新 source status 为 `ready`
4. 解析失败更新为 `failed`，错误信息记录在 job 的 `last_error`

**关键文件**：
- `apps/api/src/modules/source/routes.ts` — 来源 CRUD API
- `workers/ai-worker/src/handlers/parse-source.ts` — 异步解析 handler
- `apps/api/src/db/schema/note.ts` — `sources` 和 `source_segments` 表定义

---

### 4.2 笔记编辑与不可变版本系统

**能力**：块级笔记编辑器，自动保存（2.5 秒防抖），每次保存生成不可变版本记录，支持版本恢复、乐观并发控制和软删除。

**三层不可变版本模型**：

```
notes (id, workspace_id, title, current_version_id, source_id, deleted_at)
  └── note_versions (id, note_id, version_no, content_json, content_hash, created_by)
        └── note_blocks (id, version_id, ordinal, type, content, source_ref)
```

**核心技术：内容哈希去重**

`computeContentHash()` 是版本系统的核心——它使用 MD5 计算内容指纹，但关键在于序列化格式必须**精确匹配** PostgreSQL 的 `jsonb::text` 输出：

```typescript
function pgJsonbSerialize(value: unknown): string {
  // key 按「长度升序 → 字母序」排列，匹配 PostgreSQL JSONB 内部排序
  const entries = Object.entries(value)
    .sort(([a], [b]) => {
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  // 分隔符使用 ": " 和 ", "（带空格），匹配 jsonb::text
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ": " + pgJsonbSerialize(v)).join(", ") + "}";
}
```

这样 JS 端计算的 hash 与迁移 SQL 中 `md5(content_json::text)` 的结果完全一致，支持跨迁移前后的去重。集成测试 `content-hash-consistency-postgres.integration.ts` 覆盖 ASCII、Unicode、图片和空 block 等场景。

**自动保存与原地更新优化**：

并非每次保存都创建新版本——系统实现了受控的原地更新优化：

1. 前端 2.5 秒防抖触发 `PUT /notes/:id`
2. 计算 `content_hash`，如果与 `currentVersionId` 的 hash 相同则跳过
3. 如果 hash 不同，检查当前版本是否可原地更新（`canUpdateVersionInPlace`）：
   - 使用 `SELECT ... FOR UPDATE` 锁定 `note_versions` 行
   - 检查该版本是否有关联的 `learning_cards`（ACTIVE 或 SUPERSEDED 状态）
   - **无卡片引用 → 原地更新**：删除旧 blocks，插入新 blocks，更新 `content_json` 和 `content_hash`，刷新 `updatedAt`
   - **有卡片引用 → 创建新版本**：版本一旦被 AI 消费就不可变，后续编辑必须创建新版本

**乐观并发控制**：

客户端提交时携带 `baseVersionId`，服务端比对 `notes.current_version_id`。不一致时抛出 `RevisionConflictError`（HTTP 409），提示客户端重新拉取。

**版本恢复**：

`POST /notes/:id/versions/:versionNo/restore` 将指定版本的内容复制为新版本（version_no 递增），不会修改历史版本。

**软删除与级联清理**：

- `notes.deleted_at` 标记软删除
- 部分索引 `notes_active_idx ON (workspace_id) WHERE deleted_at IS NULL` 确保查询不扫描已删除笔记
- 删除笔记时级联操作：归档关联 `learning_cards`（设置 `archived_by_note_deletion_at`）、取消关联 `review_schedules`（设置 `updatedAt = deletedAt` 精确匹配恢复）
- 定时任务每 6 小时物理清除超过 30 天的软删除笔记（`purgeSoftDeletedNotes`）

**图片上传支持**：

- 图片 block 通过 MinIO（S3 兼容）上传
- 上传中插入 `![上传中…](uploading:${uuid})` 占位符
- `stripUploadingPlaceholders()` 在保存前过滤占符，防止持久化为 broken image
- 保存前提取 image block 的 alt text 转为文字描述，避免将图片 URL 发送给 AI

**关键文件**：
- `apps/api/src/modules/note/service.ts` — 笔记服务（1277 行），含 hash 计算、原地更新、版本恢复
- `apps/api/src/modules/note/maintenance.ts` — 软删除清理
- `apps/web/components/NoteEditor.tsx` — 前端编辑器组件

---

### 4.3 AI 学习卡生成与证据对齐

这是系统最核心的 AI 能力：从笔记内容生成结构化学习卡（title + summary + 最多 5 个 key_points），每个 key point 包含**抽象 claim**（用自己的话概括的知识断言）和**原文 quote_text**（支撑 claim 的近似逐字片段），然后自动将 quote 对齐到笔记的具体 block。

#### 4.3.1 完整生成流程

```
笔记保存 → API 创建 generate_card job (status=pending)
                    │
                    │ Worker claim
                    ▼
         ┌─────────────────────────────┐
         │ 1. 幂等检查                   │  已有 active card → 跳过
         │ 2. 并行查询 note+version,     │  减少 DB 往返
         │    blocks, AI 治理上下文      │
         │ 3. 图片 block 脱敏             │  alt text → 文字描述
         │ 4. 内容长度截断（12000 字符）   │  信息密度优先保留
         │ 5. 隐私治理门禁               │  同意+PII检测+sendToExternal
         │ 6. 调用 AI Provider           │  SYSTEM_PROMPT v7
         │ 7. Zod schema 校验            │  learningCardOutputSchema
         │ 8. 质量清洗                   │  sanitizeCardOutput()
         │ 9. 事务写入                   │  pg_advisory_xact_lock
         │    → supersede 旧卡           │  + card + key_points
         │    → insert artifact          │  + align_evidence jobs
         │    → insert card + kps        │  + search index
         │    → create align jobs        │
         │    → search index upsert      │
         │ 10. 写审计日志                 │  ai_audit_log
         └─────────────────────────────┘
```

#### 4.3.2 Prompt 工程（v7 版本）

Prompt 是所有 AI 生成的单一来源（single source of truth），位于 `packages/shared/src/prompts.ts`（~500 行），被 Worker 和 ai-quality RC 门禁共同导入，确保生产环境和质量门禁使用完全相同的 prompt。

**SYSTEM_PROMPT 结构**：

1. **输出格式定义**：严格 JSON 结构（`thinking` / `title` / `summary` / `key_points`）
2. **生成步骤指引**：先思考再输出——通读 blocks → 识别知识点 → 找原文 → 重新表述 → 自检 → 输出
3. **质量标准**：
   - `title`：概括核心主题与论点，不复述笔记标题
   - `summary`：2-4 句话概述，说明知识为什么重要和各要点关系，不简单罗列
   - `claim` 质量要求（8 条规则）：
     - 必须是抽象提炼，不是原文复述（**最重要标准**）
     - 必须是原子化、自包含的知识断言
     - 必须是可验证的陈述（非模糊话题标签）
     - 聚焦一个知识点，长度 20-80 字
     - 覆盖不同认知层级（概念理解 / 对比辨析 / 实践应用 / 条件边界）
   - `quote_text` 提取规则：近似逐字截取（容忍标点/连接词微调），不跨 block 拼接，30-300 字
4. **claim 反模式**：话题标签、原文截取、模糊评价、泛化描述、复述改写、跨概念混合
5. **claim 正面示例**：对比「复述」与「抽象提炼」的差异
6. **自检清单**：8 项逐项检查
7. **3 个完整 few-shot 示例**：技术实践类、读书笔记类、短笔记类

**EVAL_SYSTEM_PROMPT**（v7.2）——验证评估 prompt：

- 结构化评估步骤：thinking → 拆解要点 → 逐点对照
- 题型适配评估（explain / example / apply 各有独立标准）
- outcome 判定标准量化（覆盖率阈值 + confidence 建议区间）
- 4 个 few-shot 示例覆盖全部 outcome
- 复述检测——区分「用自己的话解释原理」和「换种说法重复断言」

**关键设计**：prompt 版本历史完整记录在文件注释中（v1→v7），每次迭代都有明确的改进目标和理由。

#### 4.3.3 Zod 输出契约

AI 输出必须通过 Zod schema 校验才能写入数据库：

```typescript
export const learningCardKeyPointSchema = z.object({
  ordinal: z.number().int().min(0),
  claim: z.string().min(1).max(500),
  quote_text: z.string().min(1).max(1000),
});

export const learningCardOutputSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1000),
  // max(10) 是安全上限：prompt 要求最多 5 个
  // 允许 10 是为了模型偶尔输出 6-7 个时不直接 fail
  // 而是由 sanitizeCardOutput 截断到 5 个，避免浪费一次模型调用
  key_points: z.array(learningCardKeyPointSchema).min(1).max(10),
});
```

校验失败直接抛出错误，job 进入重试或死信。

#### 4.3.4 质量清洗引擎（`sanitizeCardOutput`）

这是 AI 输出的后处理核心——一个 470 行的纯函数模块，在 handler 持久化之前对输出进行多维度清洗。所有函数无副作用、不依赖外部状态，可在 CI 中直接测试。

**8 步清洗流水线**：

| 步骤 | 检查项 | 阈值/规则 | 实现 |
| --- | --- | --- | --- |
| 1 | claim 过短 | 归一化后 < 12 字符（约 6 汉字） | 过滤话题标签 |
| 2 | claim 模糊评价 | 30+ 正则模式匹配 | `VAGUE_CLAIM_PATTERNS`：很重要/很关键/是基础/至关重要/扮演重要角色/广泛应用/... |
| 3 | quote_text 过短 | 归一化后 < 10 字符 | 太短的引用无法支撑 claim |
| 4 | quote_text 原文验证 | trigram containment ≥ 0.5 | `quoteExistsInSource()`：先精确子串匹配，再 trigram 容器率 |
| 5 | claim-quote 相关性 | 至少 1 个 bigram 重叠 | `claimQuoteRelevant()`：拦截完全无关的 claim-quote 对 |
| 6 | claim-quote 过度相似 | bigram containment ≥ 0.8 | `claimQuoteTooSimilar()`：claim 大量复用原文措辞 → 丢弃（短引用 < 30 字符跳过） |
| 7 | claim 语义去重 | bigram Jaccard ≥ 0.6 | 保留第一个，丢弃后续相似的 |
| 8 | 截断 + 重新编号 | 最多 5 个 | 模型应已按重要性排序 |

**渐进放宽 Fallback 策略**：

如果严格过滤后 key_points 为空，不直接返回空卡，而是分 5 级逐步放宽条件，目标保留 1-3 个「最不差」的 key points：

| 级别 | 放宽条件 |
| --- | --- |
| 1 | quote containment 阈值从 0.5 降到 0.3，仍检查 claim 不太相似 |
| 2 | 额外允许 claim 复述 quote（所有 claim 都是复述时的退路） |
| 3 | claim 最小长度从 12 降到 8，不检查 quote 校验 |
| 4 | 只要求 1 个 unigram 重叠（最宽松的相关性） |
| 5 | 最后退路：返回 claim 最长的原始 key points（最多 2 个） |

**为什么用 containment 而非 Jaccard**：

> 当 block 比 quote 长很多时（常见场景），Jaccard 会被 block 的额外 ngram 稀释，导致即使 quote 完全包含在 block 中也无法检测。Containment 只关注 quote 的 ngram 有多少来自 block，不受 block 长度影响。

#### 4.3.5 证据对齐算法（`alignQuote`）

AI 生成的 `quote_text` 需要自动对齐到笔记的具体 block，这是证据可追溯性的技术基础。

**算法实现**（`workers/ai-worker/src/lib/align.ts`）：

```
输入：quote_text + blocks[{blockId, blockOrdinal, text}]
输出：{best: {blockId, score, method}, candidates: [...top5]}

对每个 block：
  1. Exact 匹配：归一化后子串包含 → score = 100, method = "exact"
  2. Fuzzy 匹配（当 exact < 100）：
     a. Containment ratio：
        - trigram containment = quote 的 trigram 在 block 中的比例
        - bigram containment = quote 的 bigram 在 block 中的比例
        - containmentScore = max(tri, bi) × 100
     b. 滑动窗口 Jaccard：
        - 窗口大小 = min(block长度, max(80, quote长度×2))
        - 步长 = max(1, window/16)（细粒度采样）
        - 对每个窗口切片计算 trigram 和 bigram Jaccard，取最大值
        - jaccardScore = max(tri_jaccard, bi_jaccard) × 100
     c. scoreFuzzy = max(containmentScore, jaccardScore)
  3. score ≥ 40 才加入候选列表

排序：按 score 降序，取 top 5 作为 candidates
```

**归一化**：`s.replace(/\s+/g, "").toLowerCase()` ——去除所有空白并转小写，对中文友好（中文无大小写，去除空白后 bigram/trigram 仍有语义价值）。

**对齐分级**：

| 分数 | 分级 | 含义 |
| --- | --- | --- |
| ≥ 85 | `aligned` | 硬证据——quote 几乎完全来自此 block |
| 60-84 | `soft` | 软证据——quote 部分来自此 block |
| < 60 | `unaligned` | 未对齐——quote 找不到匹配的 block |

**候选证据保留**：当最佳对齐为 `aligned` 时，额外保留 1-2 个 `soft` 候选作为备选证据，用户可在 UI 中切换。

**用户级证据覆盖**：

`evidence_overrides` 表允许每个用户对同一证据有独立的 override（`confirmed | downgraded | rejected`），不再全工作区共享 last-write-wins。重新对齐时，系统在事务中恢复匹配的 override：

```sql
-- 在 advisory lock 保护下，读取旧 override → 删除旧 evidence → 插入新 evidence → 恢复 override
SELECT pg_advisory_xact_lock(hashtextextended('evidence-align:' || key_point_id, 0))
```

#### 4.3.6 事务写入与卡片替代

卡片生成的事务写入是系统中最复杂的事务之一，在 `pg_advisory_xact_lock` 保护下原子完成：

```
BEGIN
  SELECT pg_advisory_xact_lock(hashtextextended('job-quota:' || workspace_id, 0))
    -- 序列化卡片完成与 API 入队/去重/配额检查

  1. 查找并 supersede 旧 active cards（跨版本）
     UPDATE learning_cards SET status = 'superseded'
     WHERE noteId = target_note_id AND status = 'active'

  2. 原子取消旧卡的 pending review schedules
     UPDATE review_schedules SET status = 'superseded'
     WHERE subject_id IN (old_card_ids) AND status = 'pending'

  3. 插入 ai_artifacts（type=learning_card, status=ready）
     记录 model_id, prompt_version, input_hash, cost_tokens

  4. 插入 learning_cards（status=active, artifact_id=...）

  5. 回填旧卡 superseded_by_card_id 指向新卡

  6. 插入 card_key_points（ordinal, claim, quote_text）

  7. 检查工作区 pending job 配额
     pending_count + kps.length > MAX_PENDING_JOBS_PER_WORKSPACE → throw

  8. 为每个 key_point 创建 align_evidence job（自动级联）
     INSERT INTO jobs (type='align_evidence', payload={keyPointId, noteVersionId})

  9. 删除旧卡搜索投影 + 插入新卡搜索投影

  10. throwIfJobAborted(job) — 检查是否已超时
COMMIT
```

**幂等性保障**：

- 事务前检查：如果该 `noteVersionId` 已有 active card → 跳过
- regeneration 检查：如果 `oldCardId.supersededByCardId === existingCard.id` → 跳过
- lease token 保护：事务中通过 `lockJobLease()` 确保持有 job lease，超时则中止

**关键文件**：
- `workers/ai-worker/src/handlers/index.ts` — `runGenerateCard`（~400 行）+ `runAlignEvidence`（~250 行）
- `workers/ai-worker/src/lib/card-quality.ts` — 质量清洗引擎（470 行）
- `workers/ai-worker/src/lib/align.ts` — n-gram 对齐算法
- `packages/shared/src/prompts.ts` — Prompt 单一来源（~500 行）
- `packages/shared/src/schemas.ts` — Zod 输出契约

---

### 4.4 理解验证与 AI 评估

**能力**：用户回答 AI 生成的验证题，AI 评估答案并判定理解程度，结果驱动复习调度。

#### 4.4.1 验证题服务端持久化

验证题不是客户端生成的——服务端创建并持久化题目，客户端只提交 `questionId + answer + idempotencyKey`：

```
POST /cards/:cardId/validation/question
  → 服务端校验 card 归属
  → 确定 keyPoint（显式指定或取第一个）
  → N-004: 校验 keyPoint 是否有硬证据（aligned evidence）
     → 无硬证据 → 返回 { error: "no_hard_evidence" }
  → 持久化到 validation_questions 表（24 小时过期）
  → 返回 { questionId }
```

**题型智能选择**（v7.2）：根据 claim 的句式结构选择题型：
- 条件类 claim（"当…时…"）→ `explain` 题
- 机制类 claim（"…的本质是…"）→ `explain` 题
- 主题类 claim → `example` 题
- 一般类 claim → `apply` 题

#### 4.4.2 AI 评估流程

```
POST /cards/:cardId/validation/submit
  → 创建 evaluate_validation job
  → Worker 消费：

    1. 幂等检查（OR 查询合并两次查重）：
       - by jobId（防重试重复）
       - by 输入组合（cardId + userId + question + userAnswer + keyPointId）

    2. 并行查询 card + keyPoint + AI 治理上下文

    3. 获取参考答案上下文：
       SQL 一次查询获取最高分有效硬证据的 block 内容
       优先级：user_override='rejected' → 最低
               user_override='confirmed' OR alignment='aligned' → 最高
               alignment='soft' → 次之

    4. 隐私治理（PII 检测 + 脱敏）

    5. 调用 provider.evaluateValidation(input, signal)
       → EVAL_SYSTEM_PROMPT（v7.2）
       → evaluateValidationOutputSchema Zod 校验

    6. 事务写入（advisory lock 保护）：
       SELECT pg_advisory_xact_lock(hashtextextended(
         workspace_id || ':' || cardId || ':' || keyPointId || ':' || userId || ':' || question || ':' || userAnswer, 0
       ))
       -- 输入维度锁：相同输入的并发 job 串行化

       a. 再次查重（锁内确认）
       b. 插入 ai_artifacts (type=validation_feedback, input_refs.userId=...)
       c. 插入 validation_events (outcome, confidence×100, feedback, jobId, questionId)
       d. 插入 understanding_events (validated/misunderstood/seen)
       e. supersede 旧 pending review（同 keyPoint + userId 维度）
       f. 插入新 review_schedules（离散档位调度）

    7. 写审计日志
```

**评估输出契约**：

```typescript
evaluateValidationOutputSchema = z.object({
  thinking: z.string().max(2000).optional(),
  outcome: z.enum(["preliminary_understanding", "unclear_expression", "misunderstanding", "unknown"]),
  confidence: z.number().min(0).max(1),
  feedback: z.string().max(500),
  covered_points: z.array(z.string()),
  missing_points: z.array(z.string()),
  misunderstandings: z.array(z.string()),
  evidence_refs: z.array(z.string()),
});
```

**并发安全三重保障**：

1. **事务外快速查重**：`OR(jobId, 输入组合)` 合并为单次查询
2. **输入维度 advisory lock**：相同输入的并发事务串行化
3. **输入组合唯一索引**：`validation_events_input_unique_idx ON (workspace_id, card_id, COALESCE(key_point_id, '000...'), user_id, question, user_answer)` 数据库层面兜底

**关键文件**：
- `workers/ai-worker/src/handlers/index.ts` — `runEvaluateValidation`（~300 行）
- `apps/api/src/modules/validation/service.ts` — 验证 API（题目创建 + 提交）
- `packages/shared/src/schemas.ts` — `evaluateValidationOutputSchema`

---

### 4.5 离散档位复习调度

**能力**：基于理解验证结果和复习 attempt 结果，按离散档位调度下次复习时间，每次调度都有可解释的 reason code。

#### 4.5.1 验证驱动调度（Worker 端）

验证结果直接驱动初始复习时间：

```typescript
function intervalForOutcome(outcome: ValidationOutcome): number {
  switch (outcome) {
    case PRELIMINARY_UNDERSTANDING: return 3;  // 3 天后复习
    case UNCLEAR_EXPRESSION:        return 0;  // 次日复习
    case MISUNDERSTANDING:          return 0;  // 次日复习
    case UNKNOWN:
    default:                        return 1;  // 1 天后复习
  }
}
```

#### 4.5.2 复习 Attempt 驱动调度（API 端，ADR-0004）

复习完成后，基于 attempt 结果更新调度。调度策略是纯函数 `calculateReviewSchedule()`，不读时钟、不修改状态，可在 CI 中完全测试。

**离散档位**：`[1, 3, 7, 14, 30, 60]` 天

**调度规则**：

| Outcome | Before → After | Reason Code | Understanding Effect |
| --- | --- | --- | --- |
| `correct` | 当前 → 下一档 | `correct_advance` 或 `correct_interval_cap`（已到顶档） | upgrade |
| `partial` | 当前 → 下一档 | `partial_advance` 或 `partial_interval_cap` | upgrade |
| `incorrect` | 当前 → 1 天 | `incorrect_reset` | downgrade |
| `unable` | 当前 → 1 天 | `unable_reset` | downgrade |
| `later` | 当前 → 当前 + 12h | `later_short_deferral` | unchanged |

**前置门槛检查**：

- `correct` / `partial` 但 `hasValidServerQuestion = false` → `question_invalid`，interval 不变
- `correct` / `partial` 但 `hasHardEvidence = false` → `evidence_insufficient`，interval 不变

**旧版 interval 归一化**：

`normalizeReviewIntervalDays()` 将 v0.4 的任意 interval（0/2/6/12/24 等）映射到第一个 ≥ 该值的 v0.5 档位，保持向后兼容。

**关键文件**：
- `apps/api/src/modules/review/scheduling-policy.ts` — 纯函数调度策略（226 行）
- `packages/shared/src/review-attempt.ts` — 共享类型

---

### 4.6 复习 Attempt 审计

**能力**：每次复习都有完整的审计行，记录答案、结果、调度变化和理解效果。

**Attempt 生命周期**（ADR-0004）：

```
started → submitted (correct/partial/incorrect/unable)
        → later (推迟 12 小时)
        → abandoned (用户取消 / 新 attempt 开始 / 超时清理)
```

**数据模型**（`review_attempts` 表）：

| 字段 | 用途 |
| --- | --- |
| `answer_type` / `answer_text` | 用户答案类型和文本（nullable，recall/self_grade 可无文本） |
| `outcome` / `confidence` | 复习结果和置信度 |
| `skip_reason` | 跳过原因 |
| `schedule_before_interval_days` | 调度前 interval |
| `schedule_after_interval_days` | 调度后 interval |
| `schedule_reason_code` | 调度变化原因 |
| `understanding_effect` | 理解影响（upgrade/downgrade/unchanged） |
| `next_review_at` | 下次复习时间 |
| `next_schedule_id` | 下一个 schedule 的 ID（跨代追溯） |
| `idempotency_key` | 幂等键 |
| `status` | started/submitted/abandoned |
| `started_at` / `completed_at` / `abandoned_at` | 时间戳 |

**并发安全保障**：

1. **幂等性**：`UNIQUE(workspace_id, user_id, idempotency_key)` 唯一索引
2. **活跃 attempt 唯一性**：`UNIQUE(workspace_id, user_id, review_schedule_id) WHERE status = 'started'` 部分唯一索引——同一计划同时只能有一个 started attempt
3. **自动放弃**：新 attempt 开始时，自动将旧的 started attempt 标记为 `abandoned`

**隐私保护**：

> `answer_text` 只存储在业务表中，永不记录到日志、telemetry 或历史摘要中（除非显式请求完整 attempt）。

**关键文件**：
- `apps/api/src/modules/review/attempt-service.ts` — Attempt 服务
- `apps/api/src/db/schema/evidence.ts` — `review_attempts` 表定义

---

### 4.7 全文搜索

**能力**：跨笔记、学习卡、来源、证据的中文友好全文搜索，支持按类型过滤和分页。

**投影表设计**：

`search_documents` 是派生投影表，不存储原始数据，业务写入时同步 upsert：

```typescript
upsertSearchDocument({
  workspaceId, objectType: "note" | "card" | "source" | "evidence",
  objectId, title, body, metadata
})
```

**搜索实现**（`apps/api/src/modules/search/service.ts`）：

使用 PostgreSQL `pg_trgm` 扩展 + ILIKE 进行中文友好的模糊匹配：

```sql
WITH matching AS (
  SELECT object_type, object_id, title, body, indexed_at, metadata,
    -- evidence 按 cardId 聚合去重，其他类型按自身 ID 去重
    CASE
      WHEN object_type = 'evidence' AND metadata->>'cardId' IS NOT NULL
      THEN 'evidence-card:' || (metadata->>'cardId')
      ELSE object_type || ':' || object_id
    END as dedup_key
  FROM search_documents
  WHERE workspace_id = $1
    AND (body ILIKE '%' || $2 || '%' ESCAPE '\\' OR title ILIKE '%' || $2 || '%' ESCAPE '\\')
    AND ($3::text IS NULL OR object_type = $3)
),
evidence_counts AS (
  SELECT metadata->>'cardId' as card_id, count(*) as match_count
  FROM matching WHERE object_type = 'evidence' AND metadata->>'cardId' IS NOT NULL
  GROUP BY metadata->>'cardId'
),
deduplicated AS (
  SELECT DISTINCT ON (dedup_key) * FROM matching ORDER BY dedup_key, indexed_at DESC
)
-- 分页查询和计数查询并行执行
```

**关键技术点**：

1. **ILIKE 通配符转义**：`%` 和 `_` 被转义为字面量，防止 `%` 查询扫描全表
2. **SQL 层聚合去重**（N-012）：同一张 card 下的多条 evidence 只返回一条，但记录 `matchCount`
3. **分页与计数并行**：`Promise.all([rows, countRows])` 避免两次 DB 串行往返
4. **索引容错**：upsert 失败不中断主流程（savepoint 保护），通过 `GET /search/drift` 检测漂移，`POST /search/reindex` 补偿

**关键文件**：
- `apps/api/src/lib/search-index.ts` — 索引同步入口
- `apps/api/src/modules/search/service.ts` — 搜索服务（含 SQL 层去重）

---

### 4.8 理解关系图

**能力**：可视化 source → note → card → key_point 的知识拓扑，每个节点携带证据覆盖率和理解状态。

**图结构**：

```typescript
interface UnderstandingGraph {
  nodes: UnderstandingGraphNode[];  // source | note | card | key_point
  edges: UnderstandingGraphEdge[];  // derived_from | generated_from | contains
  meta: UnderstandingGraphMeta;     // 统计信息
}

interface UnderstandingGraphNode {
  id: string;
  entityId: string;
  type: "source" | "note" | "card" | "key_point";
  label: string;
  state: string | null;             // 理解状态
  evidenceCoverage: number | null;   // 证据覆盖率
  hardEvidenceCount: number;        // 硬证据数量
  softEvidenceCount: number;        // 软证据数量
  misunderstandingCount: number;    // 误解次数
  lastValidatedAt: string | null;   // 最后验证时间
  nextReviewAt: string | null;      // 下次复习时间
}
```

**边类型**：
- `derived_from`：note → source（笔记来源于资料）
- `generated_from`：card → note（卡片从笔记生成）
- `contains`：card → key_point（卡片包含要点）

**理解事件流**（`understanding_events` 表）：

| 事件类型 | 触发时机 |
| --- | --- |
| `seen` | 用户查看卡片 |
| `validated` | 验证结果为 `preliminary_understanding` |
| `misunderstood` | 验证结果为 `misunderstanding` |
| `reviewed` | 完成复习 attempt |

事件流形成时间线，是未来理解账户和图谱进化的基础。

**关键文件**：
- `apps/api/src/modules/understanding/graph.ts` — 图构建逻辑
- `apps/web/components/study/UnderstandingUniverse.tsx` — 前端星图可视化

---

### 4.9 用户级 BYOK AI 模型配置

**能力**：每个用户自带 AI 模型配置（Bring Your Own Key），支持 Mock、DashScope、OpenAI-compatible 三种 provider。

#### 4.9.1 AES-256-GCM 凭据加密

API Key 使用 AES-256-GCM 加密后写入数据库，AAD（Additional Authenticated Data）绑定 userId 防止跨用户复制：

```typescript
function aadForUser(userId: string): Buffer {
  return Buffer.from(`ailearn:user-ai-model-config:${userId}`, "utf8");
}

export function encryptAiCredential(plaintext: string, userId: string): string {
  const key = parseEncryptionKey(process.env.AI_CREDENTIAL_ENCRYPTION_KEY); // 32 字节
  const iv = randomBytes(12);                    // 96-bit nonce
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(aadForUser(userId));             // 认证 userId
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();               // 128-bit auth tag
  return [FORMAT_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}
```

**安全特性**：
- 格式版本前缀（`v1.iv.tag.ciphertext`）支持未来加密方案迁移
- AAD 绑定 userId：即使密文被复制到其他用户行，解密也会失败（AAD 不匹配）
- 解密时严格校验格式（拒绝多余字段、拒绝篡改）
- 密钥要求 32 字节，支持 hex（64 字符）或 base64 编码

#### 4.9.2 连接测试

`POST /auth/ai-model/test` 发送最小请求验证：
- 接口可达性（HTTP 连接）
- API Key 有效性（认证）
- 模型权限和可用额度（授权）
- 模型 ID 和接口协议匹配（兼容性）

测试不使用学习内容，不保存或返回模型生成正文。

#### 4.9.3 Provider 选择优先级

```
1. 个人配置（user_ai_model_configs）— BYOK，解密后使用
2. workspace 配置（workspaces.ai_provider）
3. 全局环境变量（AI_PROVIDER_CARD，默认 mock）
```

`resolveAIGovernanceContext()` 一次性并行查询个人配置和 workspace，消除重复 DB 往返，返回统一的治理上下文（providerName + config + consentOk + policy）。

#### 4.9.4 三种 Provider 实现

| Provider | 类 | 特点 |
| --- | --- | --- |
| Mock | `MockProvider` | 不访问外部，用简单文本处理生成卡片和评估，开发和测试用 |
| DashScope | `DashScopeProvider` | 阿里云百炼/通义千问，OpenAI 兼容端点，支持 `response_format: json_object` |
| OpenAI-compatible | `OpenAICompatibleProvider` | 通用 `chat/completions` 协议，需提供 baseUrl + model + apiKey |

**统一接口**：

```typescript
interface AIProvider {
  id: string;
  modelId: string;
  promptVersion: string;
  generateCard(input: GenerateCardInput, signal?: AbortSignal): Promise<LearningCardOutput>;
  evaluateValidation(input: EvaluateValidationInput, signal?: AbortSignal): Promise<EvaluateValidationOutput>;
}
```

所有 Provider 输出都经过 Zod schema 校验，JSON 解析使用容错解析器（去除 ``` fence，查找第一个平衡的 JSON 对象）。

**关键文件**：
- `packages/shared/src/ai-credentials.ts` — AES-GCM 加密/解密
- `workers/ai-worker/src/lib/ai-provider.ts` — Provider 工厂和接口定义
- `workers/ai-worker/src/lib/providers/dashscope.ts` — DashScope 实现
- `workers/ai-worker/src/lib/providers/openai-compatible.ts` — OpenAI 兼容实现
- `workers/ai-worker/src/lib/providers/mock.ts` — Mock 实现

---

## 5. 关键技术实现

### 5.1 PostgreSQL 原生任务队列

系统不依赖外部消息中间件（如 Redis、RabbitMQ），而是基于 PostgreSQL 实现完整的任务队列。

#### 5.1.1 SECURITY DEFINER 队列函数

队列操作通过 `SECURITY DEFINER` 函数实现，Worker 不直接操作 `jobs` 表，防止越权修改：

```sql
-- claim 函数：原子领取 N 个 pending job，返回 lease_token
SELECT * FROM public.ailearn_claim_jobs(concurrency, max_attempts);

-- finish 函数：标记 job 成功（lease_token 验证）
SELECT ailearn_finish_job(job_id, workspace_id, lease_token) AS ok;

-- fail 函数：标记 job 失败/死信（lease_token 验证 + 自动重试/死信判定）
SELECT status FROM ailearn_fail_job(job_id, workspace_id, lease_token, error_message, max_attempts);

-- reap 函数：回收超时 job（lease 过期）
SELECT id, status FROM ailearn_reap_stale_jobs(lease_timeout_ms, max_attempts);
```

#### 5.1.2 不可变 Lease Token

```
claim 时：
  - 生成随机 lease_token 写入 jobs.lease_token
  - status 从 pending → running
  - started_at = now()

完成时：
  - WHERE lease_token = $1 AND status = 'running' 原子条件更新
  - status → succeeded, lease_token = NULL

失败时：
  - WHERE lease_token = $1 AND status = 'running' 原子条件更新
  - attempts + 1
  - 如果 attempts >= MAX_ATTEMPTS → status = 'dead', finished_at = now()
  - 否则 → status = 'pending', scheduled_at = now() + backoff, lease_token = NULL

超时回收：
  - reap 函数查找 started_at < now() - LEASE_TIMEOUT_MS 的 running job
  - 同失败逻辑处理
```

#### 5.1.3 配置参数

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `MAX_ATTEMPTS` | 3 | 最大重试次数 |
| `QUEUE_CONCURRENCY` | 3 | 并发消费数 |
| `LEASE_TIMEOUT_MS` | 120,000 (2 分钟) | Lease 超时 |
| `RETRY_BACKOFF_BASE_MS` | 2,000 (2 秒) | 退避基数 |
| `MAX_PENDING_JOBS_PER_WORKSPACE` | 限制值 | 工作区 pending 上限 |

**重试退避**：指数退避 `2000 × 2^attempts`（第一次重试等 2s，第二次等 4s）

#### 5.1.4 Handler 超时配置

每个 job 类型有独立超时，且严格小于 lease timeout（留 10 秒安全余量）：

| Job Type | 默认超时 | 说明 |
| --- | --- | --- |
| `generate_card` | 90s | AI 生成复杂结构化输出 |
| `evaluate_validation` | 90s | AI 评估，较简输出但仍有模型往返 |
| `align_evidence` | 30s | 无 AI 调用，纯文本对齐 |
| `parse_source` | 60s | URL 抓取 + 分段，无 AI 调用 |

超时通过 `AbortSignal` 实现，handler 在关键点检查 `throwIfJobAborted(job)`，超时后不提交副作用。

#### 5.1.5 不可重试错误

`isNonRetryableError()` 检测不会因重试而解决的错误，直接标记为 dead：

- 计费/账户问题：`overdue-payment`、`insufficient balance`、`account suspended`
- 认证失败：`invalid api key`、`unauthorized`、`authentication failed`
- 授权失败：`forbidden`、`permission denied`
- 配置错误：`not configured`、`consent not signed`

#### 5.1.6 去重与配额

- **generate_card 去重**：`UNIQUE(workspace_id, payload->>'noteVersionId') WHERE type='generate_card' AND status IN ('pending', 'running') AND payload->>'noteVersionId' IS NOT NULL`
- **工作区配额**：卡片生成事务中检查 `pending_count + kps.length > MAX_PENDING_JOBS_PER_WORKSPACE` → 拒绝

**关键文件**：
- `workers/ai-worker/src/queue.ts` — 队列 claim/reap/finish/fail 逻辑（313 行）
- `workers/ai-worker/src/lib/job-lease.ts` — lease 管理和事务绑定
- `workers/ai-worker/src/lib/job-retry.ts` — 指数退避
- `workers/ai-worker/src/lib/non-retryable-errors.ts` — 不可重试错误检测
- `workers/ai-worker/src/lib/handler-timeout-config.ts` — 超时配置

---

### 5.2 行级安全（RLS）与租户事务

PostgreSQL RLS 作为数据隔离的第二道防线（ADR-0003），应用层 `WHERE workspace_id = ...` 是第一道。

#### 5.2.1 数据分类与策略

| 分类 | 表示例 | RLS 策略 |
| --- | --- | --- |
| **Workspace-owned** | notes, sources, cards, evidence, search_documents | `workspace_id = current_setting('app.workspace_id', true)::uuid` |
| **User-private-in-workspace** | validation_events, review_schedules, evidence_overrides, understanding_events | 额外要求 `user_id = current_setting('app.user_id', true)::uuid` |
| **Global identity** | users, sessions, auth_rate_limits, user_ai_model_configs | 不做任意表扫描，改用最小权限 SECURITY DEFINER 函数 |
| **Cross-workspace** | jobs | Worker 只可调用原子 claim/renew/finish/reap 函数 |

#### 5.2.2 事务级租户上下文

```typescript
// API 端：withWorkspaceTransaction
export async function withWorkspaceTransaction<T>(
  context: { workspaceId: string; userId: string },
  operation: (tx: ApiTransaction) => Promise<T>,
): Promise<T> {
  const normalized = normalizeWorkspaceTransactionContext(context); // UUID 校验
  return db.transaction(async (transaction) => {
    // 设置 transaction-local 上下文（true = 仅当前事务可见）
    await transaction.execute(sql`
      SELECT pg_catalog.set_config('app.workspace_id', ${normalized.workspaceId}, true),
             pg_catalog.set_config('app.user_id', ${normalized.userId}, true)
    `);
    // 验证 PostgreSQL 返回了精确的归一化值
    // ...
    return await operation(transaction);
  });
  // 事务提交/回滚后，设置自动消失
}
```

**关键约束**：
- 只允许 transaction-local（第三个参数 `true`），**禁止 session-level SET**
- UUID 格式严格校验（`/^[0-9a-f]{8}-...$/i`），缺失/空值/非 UUID 一律 fail-closed
- 嵌套事务不可改变 workspace/user 上下文（`assertWorkspaceTransactionContextCompatible`）
- `AsyncLocalStorage` 跟踪当前活跃事务，同上下文嵌套复用事务

#### 5.2.3 数据库角色分离

| 角色 | 权限 | 用途 |
| --- | --- | --- |
| `ailearn_migrator` | `BYPASSRLS`, DDL, `NOCREATEDB NOCREATEROLE` | 执行迁移 |
| `ailearn_api` | `NOBYPASSRLS`, 无 DDL, `NOINHERIT` | 处理 API 请求 |
| `ailearn_worker` | `NOBYPASSRLS`, 无 DDL, `NOINHERIT` | 处理后台任务 |

API 和 Worker 不拥有表，不能直接修改 schema，不能绕过 RLS。

#### 5.2.4 渐进启用策略

expand → verify → enforce：

1. **Expand**（0018-0023）：补齐 workspace/user 列和复合 FK，创建 policy 但不启用
2. **Verify**（0024-0027）：创建 policy 和权限测试，验证受限角色行为
3. **Enforce**（0024+）：`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`

**关键文件**：
- `apps/api/src/db/client.ts` — `withWorkspaceTransaction` 和上下文管理
- `infra/postgres/roles.sql` — 角色定义和权限授予（700+ 行）
- `apps/api/src/db/migrations/0019_sec01_rls_policies_expand.sql` — RLS policy 创建
- `apps/api/src/db/migrations/0024_sec01_rls_enforce.sql` — RLS 启用

---

### 5.3 AI 隐私治理

Worker 端五层隐私治理（ADR-0006, N-011），在每次 AI 调用前执行：

```
                    ┌─────────────────────┐
                    │ resolveAIGovernance  │
                    │ Context()            │
                    │ (并行查询个人配置+    │
                    │  workspace，消除      │
                    │  重复DB往返)          │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │ 1. 同意门禁          │  mock 豁免
                    │    consentOk?        │  其他需 aiConsentVersion + aiConsentAt
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │ 2. sendToExternal    │  非 mock + sendToExternal=false
                    │    门禁              │  → 拒绝
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │ 3. PII 检测和脱敏    │  递归遍历对象所有字符串
                    │    (4 种 PII 模式)   │  邮箱/手机/身份证/银行卡
                    │    → 脱敏后数据      │  首尾字符+*** 替代
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │ 4. 调用 AI Provider  │  使用脱敏后的数据
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │ 5. 审计日志          │  ai_audit_log
                    │    (可配置开关)      │  provider/model/operation/
                    │                      │  dataCategories/dataSize/
                    │                      │  costTokens/duration/status
                    └─────────────────────┘
```

**PII 检测模式**：

```typescript
const PII_PATTERNS = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: "email" },
  { pattern: /\b1[3-9]\d{9}\b/g, label: "phone" },
  { pattern: /\b\d{6}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, label: "id_card" },
  { pattern: /\b\d{16,19}\b/g, label: "bank_card" },
];
```

**审计日志写入**：失败不阻塞主流程（try-catch），但记录错误日志。

**关键文件**：
- `workers/ai-worker/src/lib/governance.ts` — 治理模块（370 行）
- `apps/api/src/db/schema/identity.ts` — `aiAuditLog` 表定义

---

### 5.4 AI 质量门禁

版本化黄金集 + 分层质量门禁（ADR-0005），确保 AI 输出质量可度量、可复现。

#### 5.4.1 三层门禁

| 门禁 | 触发时机 | Provider | 样本数 | 阈值 |
| --- | --- | --- | --- | --- |
| **PR Gate** | 每次 PR | Mock（固定） | 全部 | 标签完整性 + schema 校验 + 纯函数评分 |
| **RC Gate** | 发布候选 | 真实 DashScope (qwen-plus) | 30 篇 | 两轮均达 90%/85%/85% |
| **Nightly** | 每晚 | 真实 Provider | 10 篇 | 趋势监控（Should） |

#### 5.4.2 三项核心指标

| 指标 | 定义 | 阈值 |
| --- | --- | --- |
| `hardCitationPrecision` | 正确对齐数 / 硬证据对齐总数 | ≥ 90% |
| `keyPointHardCoverage` | 硬证据覆盖的 key point 数 / 总 key point 数 | ≥ 85% |
| `validationExpectedPointsHardCoverage` | 期望位置命中数 / 期望位置总数 | ≥ 85% |

#### 5.4.3 纯函数评分器

`packages/ai-quality/src/scorer.ts` 是版本化的纯函数评分器（SCORER_VERSION = "1.0.0"）：
- 不依赖数据库、Provider 或任何外部状态
- 相同输入永远产生相同输出（确定性）
- 评分逻辑变更时递增版本号
- 与 benchmark service `calculateMetrics` 逻辑一致，但独立于数据库

#### 5.4.4 RC 门禁约束

- 参考 Provider 为 DashScope-compatible `qwen-plus`
- RC manifest 必须记录：endpoint origin、服务商返回的不可变 revision、运行时间、temperature 0.2、prompt/dataset/label/scorer 版本
- 如果只能获得漂移别名且没有 revision 证据，RC 保持阻断
- 单次 RC 成本上限 10 美元等值，超限停止
- 后续 RC 同配置两轮均值相对上一个已接受 RC 不得下降超过 2 个百分点

**关键文件**：
- `packages/ai-quality/src/scorer.ts` — 纯函数评分器
- `packages/ai-quality/src/cli/pr-gate.ts` — PR 门禁 CLI
- `packages/ai-quality/src/cli/rc-gate.ts` — RC 门禁 CLI
- `packages/ai-quality/src/dataset.ts` — 30 篇黄金样本
- `packages/ai-quality/src/labels.ts` — 人工标签

---

### 5.5 Prometheus 可观测性

**指标分类**（ADR-0006）：

| 类别 | 指标 |
| --- | --- |
| HTTP | 请求量、成功率、p95 延迟、5xx 数、readiness |
| Job | queue depth、oldest pending、wait/runtime、retry/dead、lease lost/reap |
| Provider | 调用量、延迟、超时、schema failure、配额不足 |
| Database | 迁移版本、连接池、事务失败、RLS 拒绝 |
| Funnel | 邀请消费、onboarding 完成、生成卡、验证、复习 |
| Release | 版本、commit、migration、镜像 digest |

**隐私约束**（严格）：
- 永不记录 Note/Source/answer/quote/question 正文
- 永不记录 API Key、Cookie、CSRF、Authorization、完整 URL query
- 永不记录 Provider 原始请求/响应
- lease token 只记录不可复用的短 fingerprint
- workspace/user 标识使用 HMAC 后的不可逆标识
- 所有 label 为低基数 allowlist（HTTP_METHODS、HTTP_STATUS_CLASSES、JOB_TYPES、ERROR_CATEGORIES 等）

**SLO 告警**（`infra/prometheus/alerts.yml`，297 行）：

| 告警 | 条件 | 级别 |
| --- | --- | --- |
| API 不可用 | `readiness_status != 1` for 1m | critical |
| HTTP 5xx 错误率 | `> 0.5%` for 5m | warning |
| HTTP p95 延迟 | `> 1s` for 5m | warning |
| Job 队列堆积 | `pending > 100` for 5m | warning |
| 最老 pending job | `> 300s` for 2m | critical |
| Job 死信率 | `> 1%` for 10m | warning |
| Job lease 丢失 | `rate > 0` for 1m | warning |
| Provider 错误率 | `> 5%` for 5m | warning |
| Provider 超时 | `p95 > 30s` for 5m | warning |
| Provider schema failure | `rate > 0` for 2m | warning |
| Provider 配额不足 | `rate > 0` for 1m | critical |
| DB 连接池耗尽 | `active/max > 90%` for 5m | warning |
| RLS 拒绝率 | `rate > 10/s` for 5m | warning |
| 备份过期 | `> 24h` | critical |

**关键文件**：
- `apps/api/src/lib/metrics.ts` — API 指标模块（独立 Registry，不自动收集业务 label）
- `workers/ai-worker/src/lib/metrics.ts` — Worker 指标模块
- `infra/prometheus/prometheus.yml` — Prometheus 配置
- `infra/prometheus/alerts.yml` — 告警规则
- `infra/prometheus/alertmanager.yml` — 告警路由

---

### 5.6 安全机制

| 机制 | 实现详情 |
| --- | --- |
| **认证** | bcryptjs 密码哈希 + PostgreSQL `sessions` 表（token 主键，O(1) 查询），HttpOnly Cookie 传输 |
| **CSRF** | Cookie 携带 CSRF token，写操作需 `x-csrf-token` header 回传校验 |
| **登录限流** | `auth_rate_limits` 表，原子 `INSERT ... ON CONFLICT` 共享窗口，按 IP/email 维度限流 |
| **API Key 加密** | AES-256-GCM，AAD 绑定 userId，格式版本前缀支持迁移 |
| **数据库角色** | 三角色分离：migrator (BYPASSRLS) / api (NOBYPASSRLS) / worker (NOBYPASSRLS) |
| **RLS** | 事务级 workspace/user 上下文，fail-closed，UUID 严格校验 |
| **文件上传** | 10MB 全局上限，头像 2MB，multipart 流式解析阶段拒绝超大文件，每次只允许 1 个文件 |
| **XSS 防护** | Markdown 渲染经过 sanitize，XSS 测试覆盖（`markdown-preview-xss.test.ts`） |
| **非 root 容器** | 生产镜像以非 root 用户运行 |
| **密钥管理** | `.env` 被 Git 忽略，密码 URL 编码，`openssl rand` 生成加密密钥 |
| **Trivy 扫描** | CI 对生产镜像执行漏洞扫描门禁 |
| **gitleaks** | CI 执行密钥泄漏扫描 |

---

### 5.7 优雅关闭与定时任务

```
SIGTERM/SIGINT → 清除定时器 → app.close()（停止接受新请求，等待进行中请求完成） → closeDatabase() → 退出
```

**定时任务**：

| 任务 | 频率 | 说明 |
| --- | --- | --- |
| Session 清理 | 每小时 | 清理过期 session，启动时立即执行一次 |
| 软删除笔记清除 | 每 6 小时 | 物理清除超过 30 天的软删除笔记 |

定时器使用 `unref()`，不阻止进程退出。

**关键文件**：
- `apps/api/src/lib/graceful-shutdown.ts` — 关闭流程
- `apps/api/src/server.ts` — 信号处理和定时器注册

---

## 6. 数据模型

系统包含 28+ 业务表，核心实体关系：

```
users ──┬── workspaces ──┬── sources ── source_segments
        │                 ├── notes ── note_versions ── note_blocks
        │                 │              │
        │                 │              └── learning_cards ── card_key_points
        │                 │                        │
        │                 │                        └── evidences ── evidence_overrides
        │                 │                                │
        │                 │                                └── validation_events
        │                 │                                        │
        │                 │                                        ├── validation_questions
        │                 │                                        ├── review_schedules
        │                 │                                        │        │
        │                 │                                        │        └── review_attempts
        │                 │                                        │
        │                 │                                        └── understanding_events
        │                 │
        │                 ├── ai_artifacts (AI 派生物统一存储)
        │                 ├── ai_audit_log (AI 调用审计)
        │                 ├── jobs (任务队列)
        │                 ├── search_documents (搜索投影)
        │                 ├── benchmark_reports / benchmark_labels
        │                 ├── invite_codes
        │                 └── onboarding_states
        │
        ├── user_ai_model_configs (BYOK)
        ├── sessions (登录态)
        └── auth_rate_limits (限流)
```

**关键设计**：
- 所有业务表携带 `workspace_id`，支持 RLS
- `note_versions` 不可变，`content_hash` (MD5) 用于去重，序列化匹配 PostgreSQL `jsonb::text`
- `ai_artifacts` 统一存储所有 AI 生成结果，记录 `model_id`、`prompt_version`、`input_hash`、`cost_tokens`，支持幂等去重
- `learning_cards` 有 `superseded_by_card_id` 指向新卡（regeneration 时原子切换），`archived_by_note_deletion_at` 专用标记列（精确恢复匹配）
- `review_attempts` 有完整的调度前后 interval 记录和 `next_schedule_id` 跨代追溯链
- `validation_events` 有 `input_unique_idx` 输入组合唯一索引（advisory lock 的数据库兜底）

---

## 7. 架构决策记录（ADR）

| ADR | 决策 | 核心结论 |
| --- | --- | --- |
| ADR-0001 | v0.5 基线与发布追溯 | 统一版本源，CI 构建生产镜像，Trivy 扫描门禁 |
| ADR-0002 | Private Alpha 访问与 onboarding | 邀请码、成员管理、引导流程 |
| ADR-0003 | 数据分类与 RLS | 事务级 workspace/user 上下文，逐表 expand→verify→enforce |
| ADR-0004 | Review Attempt 与离散调度 | 完整审计行，离散档位 `[1,3,7,14,30,60]`，可解释 reason code |
| ADR-0005 | AI 质量门禁 | 版本化黄金集，PR 用 Mock，RC 用真实 Provider 两轮 90/85/85 |
| ADR-0006 | 遥测、隐私与 SLO | Prometheus 指标 allowlist，永不记录正文/密钥，Alpha SLO |
| ADR-0007 | 备份与恢复 | 加密备份，保留轮换，定期恢复演练 |
| ADR-0008 | 浏览器验收 | Playwright E2E 验收矩阵 |

---

## 8. 测试策略

| 层级 | 工具 | 范围 |
| --- | --- | --- |
| 单元测试 | Node.js `node:test` + tsx | API / Web / Worker / Shared 各模块 |
| 集成测试 | PostgreSQL 实例 | RLS policy、并发安全、迁移一致性、内容哈希一致性 |
| E2E 测试 | Playwright (ADR-0008) | 浏览器验收矩阵 |
| AI 质量测试 | `packages/ai-quality` | 30 篇黄金集，PR Mock 门禁，RC 真实 Provider 门禁 |
| 安全测试 | Trivy + gitleaks + 自定义脚本 | 镜像漏洞、密钥泄漏、RLS 强制、跨工作区隔离 |

CI 还执行：全新迁移、重复迁移、旧版本升级迁移、生产构建、非 root 镜像检查、完整 Compose 启动和健康检查、Worker 实际任务消费、PostgreSQL 备份与恢复演练。

---

## 9. 总结

理解引擎的核心技术竞争力在于：

1. **AI 原生学习闭环**：从笔记到学习卡到验证到复习的完整自动化链路，每一步都可追溯、可审计
2. **证据对齐引擎**：n-gram containment + 滑动窗口 Jaccard 多策略对齐，中文友好，分级证据
3. **AI 输出质量保障**：Prompt v7 迭代 + Zod 契约 + 8 步质量清洗 + 5 级渐进 fallback + 黄金集门禁
4. **PostgreSQL 原生任务队列**：SECURITY DEFINER + 不可变 lease token + advisory lock + 不可重试错误检测，无需外部中间件
5. **生产级 RLS**：事务级租户上下文，三角色分离，AsyncLocalStorage 嵌套保护，渐进启用
6. **隐私治理**：同意门禁 + PII 检测脱敏 + 审计日志 + AES-GCM 凭据加密，BYOK 模型配置
7. **可观测性**：Prometheus 指标 allowlist + SLO 告警 + 结构化日志，严格隐私约束
8. **并发安全**：advisory lock + 唯一索引 + 幂等检查 + lease token 多重保障
