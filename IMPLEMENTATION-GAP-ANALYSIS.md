# AI 学习系统 V0 实现 vs 产品文档对照报告

> 生成日期：2026-07-06
> 对照基准：
> - [产品愿景](ai-learning-system-product-plan.md)
> - [页面 PRD](ai-learning-system-page-prd.md)
> - [V0 Personal Beta](ai-learning-system-v0-personal-beta.md)
> - [云端核心架构](ai-learning-system-cloud-architecture.md)
>
> 审计范围：`apps/web`、`apps/api`、`workers/ai-worker`、`packages/shared`、`infra/`、`docker-compose.yml`

## 0. 一句话结论

当前实现是一个**"手写笔记 → 学习卡生成 → 证据对齐回溯"单链路跑通、其余闭环全部伪实现或缺失**的最小后端 + 前端。完成度约对应 **V0.1a 的 70%**、**V0 整体的 30-35%**。产品文档定义的三大闭环里，只有 V0.1a 基本成立；V0.1b 验证复习闭环和 V0.2 来源到笔记闭环在前端、后端两侧都基本断裂。

## 1. 总体完成度速览

| 文档要求能力 | 前端 | 后端 | 综合 |
|---|---|---|---|
| 云端账号 + workspace 多租户 | ✅ 登录页 | ✅ users/workspaces/sessions + scope 过滤 | ✅ 基本完成 |
| Note / Block 编辑 + 自动保存 | ✅ NoteEditor | ⚠️ 每次保存新建 version，**无 revision 冲突检测** | ⚠️ 基本可用但并发不安全 |
| Note Version 快照 | ✅ 展示 versionNo | ✅ note_versions 表 | ✅ 完成 |
| 学习卡生成（generate_learning_card）| ✅ 触发 + 轮询 | ✅ 真实 job + DashScope | ✅ **唯一真闭环** |
| Evidence 对齐 + 回溯 | ✅ EvidenceDrawer + 覆盖率 | ⚠️ trigram 算法有截断 bug，只对 block 不对 segment | ⚠️ 跑通但有缺陷 |
| Validation（验证理解）| ❌ 前端正则伪造 | ❌ 表有但无 API、无 job | ❌ **完全断裂** |
| Review（复习调度）| ❌ listCards + i%5 伪造 | ❌ 表无 status 字段、无生成逻辑 | ❌ **完全断裂** |
| Understanding Event | ❌ 无类型无 API | ❌ 表有但无 API、无枚举约束 | ❌ **完全缺失** |
| Source 输入池（V0.2）| ❌ localStorage 草稿模拟 | ❌ 表有但无 CRUD API、无 parse_source | ❌ **完全断裂** |
| Learning Unit | ❌ 无 | ❌ 无表无代码 | ❌ 完全缺失 |
| AIArtifact 统一存储 | ❌ 不展示状态 | ⚠️ 表有但类型/状态枚举与文档不符，缺 input_hash | ⚠️ 半成品 |
| 搜索（search_documents）| ❌ 前端 .filter | ❌ 无投影表无端点 | ❌ 完全缺失 |
| 对象存储 signed URL | — | ❌ minio 起着但零代码消费 | ❌ 完全缺失 |
| 备份恢复 | — | ❌ 无脚本 | ❌ 完全缺失 |
| Markdown + JSON 导出 | ❌ 无 UI | ❌ 无端点 | ❌ 完全缺失 |
| Concept / Claim / Relation | ❌ 无 | ❌ 无 | ❌ 完全缺失（文档允许延期）|

## 2. 页面 PRD 对照（前端）

PRD §5-6 定义 13 个页面，对照实现：

| PRD 要求页面 | 状态 | 实现位置 | 关键偏差 |
|---|---|---|---|
| 学习驾驶舱 | ⚠️ 部分实现 | `app/(workspace)/page.tsx` | 布局齐全，但**理解分数、复习数、理解分布全是前端启发式伪造**（`page.tsx:62-85`：`Math.min(95, 35+cardCount*8)`、`Math.min(cardCount,3)`、固定比例分配 5 态）|
| 快速捕获 | ⚠️ 部分实现 | dashboard 内 `CaptureBoard` | URL 只存 localStorage 草稿不创建 Source；非 URL 才调 createNote |
| 笔记编辑页 | ✅ 已实现 | `notes/[id]/page.tsx` + `NoteEditor` | 右侧"证据覆盖率"是占位文案（`NoteEditor.tsx:252-257`）|
| 学习卡详情页 | ✅ 已实现 | `cards/[id]/page.tsx` | 4 Tab 中 review 被禁用（`enabled:false`）；validation 是前端正则 |
| 证据抽屉 | ✅ 已实现 | `components/EvidenceDrawer.tsx` | 覆盖 PRD §6.5 要求，无偏差 |
| 验证理解面板 | ❌ 伪实现 | `ValidationPanel.tsx` | UI 完整但 `evaluate()` 是纯正则（`cards/[id]/page.tsx:72-114`）：判断"误解"靠 `/不\|没\|无\|错/`。**不调后端、不写 understanding_event、不创建 review_schedule** |
| 复习队列 | ❌ 伪实现 | `review/page.tsx` | 复习项是 `listCards()` 后按 `i % 5` 伪造 reason/type/evidenceStatus（`:78-107`）；无 review API 调用；"已跳过"过滤 `disabled` |
| 复习详情 | ⚠️ 部分实现 | `ReviewDrawer` 内嵌 | 答题→反馈→回看原文三步有，但**不持久化复习结果**，无 accepted/dismissed 写入 |
| 理解星图 | ❌ 伪实现 | `graph/page.tsx` | 状态/覆盖率全按 `i % N` 伪造（`:252-265`）；注释自认"真实网络图 V0.3 后推出"（`:196`）|
| 今日变化 | ⚠️ 已实现 | `today/page.tsx` | **连续天数硬编码 1**（`:127`）；timeline 仅基于 note/card/job，无 understanding_event |
| 来源收件箱 | ❌ 伪实现 | `sources/page.tsx` | 列表数据来自 `localStorage["ailearn.sourceDrafts"]`（`:57-78`）；**不调任何 source API**；"新建来源"实际调 createNote |
| 来源详情页 | ❌ 伪实现 | `sources/[id]/page.tsx` | **只读 localStorage 草稿**；snapshot/segment/相关学习卡/相关证据四区块全占位"尚未抓取"（`:124-143`）|
| 搜索页 | ❌ 伪实现 | `search/page.tsx` | 非后端 full-text search，是前端 `.filter(includes)`（`:36-49`）；证据分组占位"V0.3" |

**结论**：13 个页面中，3 个真实现（笔记编辑、学习卡详情、证据抽屉），5 个部分实现，**5 个伪实现**（验证、复习、星图、来源收件箱、来源详情），搜索也是伪实现。

## 3. 三大核心闭环跑通情况

### 3.1 V0.1a 学习卡闭环 — ✅ 基本跑通（唯一真闭环）

```
新建笔记 → 自动保存 → 生成 note_version → 生成学习卡 → 对齐证据 → 展示 → 回溯原文
   ✓         ✓              ✓                ✓            ✓          ✓         ✓
```

- 前端：`NoteEditor` 800ms debounce 自动保存 → `updateNote` 返回新 versionId → `generateCard` → 40 次×1.5s 轮询 job
- 后端：`POST /cards/generate` → `generate_card` job → 读 version/blocks → 调 DashScope → 写 `learning_cards`+`card_key_points`+`ai_artifacts` → 自动派生 `align_evidence` job → 写 `evidences`
- **断点**：align 失败无前端重试按钮；worker `runGenerateCard` 取 version 不校验 workspace（见 §6.2）

### 3.2 V0.1b 验证复习闭环 — ❌ 完全断裂

```
验证 → AI 判断 → understanding_event → review_schedule → 复习队列
 ✗        ✗             ✗                    ✗             ✗
```

- 前端：`ValidationPanel.evaluate()` 是纯正则，不调后端；`review/page.tsx` 用 `listCards + i%5` 伪造
- 后端：`validation_events`/`review_schedules`/`understanding_events` 三张表存在但**无 API、无 job、无写入路径**；`judge_validation` 的 provider 实现挂着没人调；`schedule_review` 无任何代码
- **结论**：整条"用户答题→AI 判定→写理解事件→生成复习计划→下次复习"链路 **0% 实现**

### 3.3 V0.2 来源到笔记闭环 — ❌ 完全未实现

```
粘贴 → source → snapshot/segments → note draft → 编辑
  ✓      ✗           ✗                 ✗           ✓(直接建笔记)
```

- 前端：URL 只存 localStorage；"新建来源"实际直接 `createNote`，跳过 source→draft 中间态
- 后端：无 source CRUD API、无 `parse_source` job、无 `generate_note_draft` job、`source_segments` 表从不写入、`note_blocks.source_ref` 字段存在但 API 层从不填
- **结论**：来源系统是 localStorage 草稿 + 直接建笔记的简化绕行，V0.2 闭环 0% 实现

## 4. 核心对象实现对照

对照 V0 文档 §5 的 13 个核心对象：

| 对象 | 前端 | 后端（表/API）| 状态枚举一致性 |
|---|---|---|---|
| User/Workspace | ✅ | ✅ 三表齐全 | — |
| Source | ❌ localStorage 模拟 | ⚠️ 表有但无 API；type 注释缺 markdown/code/manual | ❌ 表注释 `pdf\|url\|image\|text`，缺文档要求的 markdown/code/manual |
| Note/Block | ✅ | ✅ note/notes/note_blocks | — |
| NoteVersion | ✅ | ✅ note_versions | — |
| Snapshot/Segment | ❌ 占位 | ⚠️ source_segments 表有但从不写入；无 source_snapshots 表 | — |
| AIArtifact | ❌ 不展示 | ⚠️ 表有但 type 实际只有 card_generation/tag_suggestion | ❌ 状态枚举 `draft/accepted/rejected/superseded`，缺文档的 pending/ready/failed/stale/dismissed；**无 input_hash 字段** |
| Evidence | ✅ | ✅ evidences 表 + align 算法 | ⚠️ 4 态枚举有，但 `stale_alignment` 无任何代码产生 |
| Learning Unit | ❌ | ❌ 无表无代码 | — |
| Validation | ❌ 正则伪造 | ❌ 表有但无 API、无 job；outcome 是裸 text 无枚举约束 | ❌ DB 枚举 `preliminary/validated/unclear/misunderstanding/unknown` 与文档 `preliminary_understanding/unclear_expression/misunderstanding/unknown` 不一致；且无结构化输出字段（covered/missing/misunderstandings/evidence_refs）|
| Understanding Event | ❌ | ❌ 表有但无 API、event_type 裸 text 无枚举 | — |
| Review Schedule | ❌ | ❌ 表有但**无 status 字段**、无 API、无生成逻辑 | ❌ 文档要求 6 状态，表里一个都没有 |
| Concept/Claim/Relation | ❌ | ❌ 无 | 文档允许延期，符合预期 |
| Job | ✅ 展示状态 | ⚠️ polling 实现但缺锁定/幂等/成本 | ⚠️ JobType 枚举只列 generate_card/align_evidence/suggest_tags，缺 parse_source/generate_note_draft/judge_validation/schedule_review |

## 5. 状态机实现对照

| 状态机 | 文档定义 | 实现情况 |
|---|---|---|
| Source 状态 | draft/processing/ready/failed/archived | ❌ 前端类型有定义但数据全来自 localStorage（全是 draft）；后端表有枚举但无写入 API |
| AIArtifact 状态 | pending/ready/failed/stale/dismissed/accepted | ❌ 枚举是 draft/accepted/rejected/superseded，**完全不匹配**；前端从不展示 |
| Evidence 对齐 | aligned/soft/unaligned/stale_alignment | ⚠️ 前端正确呈现 4 态；后端 `stale_alignment` 无逻辑产生 |
| Validation 结果 | preliminary_understanding/unclear_expression/misunderstanding/unknown | ❌ 前端 UI 映射正确但判定是正则；后端枚举值名称与文档不一致且无 API |
| Review 状态 | pending/accepted/dismissed/completed/superseded/cancelled | ❌ 表无 status 字段，前端无 Review 类型 |
| Job 状态 | （文档未列详）| ✅ 前端 5 态呈现 + 后端 polling |

## 6. 已识别的 Bug 与代码问题

### 6.1 伪造数据（最严重，影响产品信任）

| 位置 | 问题 |
|---|---|
| `app/(workspace)/page.tsx:62-85` | 理解分数 `Math.min(95, 35+cardCount*8)`、复习数 `Math.min(cardCount,3)`、理解分布按固定比例——全与真实状态无关 |
| `app/(workspace)/cards/page.tsx:66` | 学习卡覆盖率 `[92,75,40,88,60,30][index%6]` 按 index 取模 |
| `app/(workspace)/graph/page.tsx:252-265` | 星图状态/覆盖率全按 `i%N` 伪造 |
| `app/(workspace)/review/page.tsx:78-107` | 复习项 reason/type/evidenceStatus 按 `i%5` 伪造 |
| `app/(workspace)/today/page.tsx:127` | "连续天数"硬编码 1 |
| `app/(workspace)/cards/[id]/page.tsx:72-114` | Validation 判定是前端正则：误解靠 `/不\|没\|无\|错/`，初步理解靠 `/因为\|所以\|意味着/` |
| `app/(workspace)/login/page.tsx:10-11` | **默认账号线硬编码** `owner@ailearn.local/ailearn_owner`，UI 明文展示 |

### 6.2 后端逻辑与安全问题

| 位置 | 问题 | 严重度 |
|---|---|---|
| `workers/.../handlers/index.ts:19-32` | `runGenerateCard` 取 version/blocks **完全不做 workspace 校验**，恶意 job payload 可跨 workspace 读 version | 🔴 高 |
| `workers/.../handlers/index.ts:177` | `runSuggestTags` 用 `userId = payload.userId ?? workspaceId`，workspaceId 当 userId 写 `note_tags.created_by` 会触发 FK 约束失败或脏数据 | 🔴 高 |
| `apps/api/.../note/service.ts:294-345` | `updateNote` 每次有 blocks 就无脑 +1 versionNo，**无 revision 冲突检测**，并发编辑会丢数据 | 🔴 高 |
| `apps/api/.../evidence/align.ts:66` | trigram 滑窗 `if (i>50) break`——**长 block 后半段永远匹配不到**，中文长段落尤甚 | 🟠 中 |
| `workers/.../src/index.ts:23-31` | job 取 pending 用普通 SELECT，**无 `FOR UPDATE SKIP LOCKED`**，多 worker 实例会抢同一批 job | 🟠 中 |
| `workers/.../src/index.ts:58` | job 失败 catch 只记 `err.message` 无堆栈；重试无退避延迟，立即回 pending | 🟠 中 |
| 无幂等机制 | `createJob` 纯 insert，无 input_hash、无去重，同 payload 可重复入队重复执行 | 🟠 中 |

### 6.3 前端逻辑 Bug

| 位置 | 问题 |
|---|---|
| `components/CategoryTree.tsx:261-297` | 拖拽 `handleDragEnd` 只更新 `ordinal` 不改 `parentId`，**跨父级拖拽无效**（注释说"拖成 over 的兄弟"但实现没做）|
| `components/NoteEditor.tsx:94-122` | `generateCard` 调 `save()` 后读 `savedVersionIdRef.current`，若 save 网络失败 ref 不更新，**会用旧 versionId 派发任务，生成旧版本学习卡** |
| `components/MarkdownEditor.tsx:60-72` | history 与父组件 value 同步会重复记录，撤销栈混乱 |
| `components/MarkdownPreview.tsx:152-187` | 用 `dangerouslySetInnerHTML`，虽有 escapeHtml 但无 CSP 兜底 |

### 6.4 死代码 / 配置问题

| 位置 | 问题 |
|---|---|
| `apps/api/src/ai/router.ts` + `providers/{openai,anthropic}.ts` | API 侧 AI provider 抽象是**未接线的孤岛**，`aiProvider` 全代码库无人 import；openai/anthropic 直接 throw |
| `apps/api` + `workers` 两套 prompt | `generate-card.v1.md`（API 侧）与 `prompts.ts`（worker 侧）手工同步，注释自承"keep in sync"但**已存在内容偏差** |
| `apps/api/.../evidence/align.ts` 与 `workers/.../lib/align.ts` | **两份逐字重复**的 align 算法，API 侧那份从不被调用 |
| `docker-compose.yml` web 服务 | 引用 `apps/web/Dockerfile` 但该文件不存在，`docker compose up` 会构建失败 |
| `@fastify/jwt` + `JWT_SECRET` | 装了配置了但**从不签/验 JWT**，认证走 sessions 表随机 token |
| DB 连接串 | 默认值 `postgres://ailearn:ailearn_dev@postgres:5432/ailearn` 硬编码在 4 处，生产忘设 DATABASE_URL 会静默连开发库 |

### 6.5 类型/契约不一致

| 问题 |
|---|
| `ai_artifacts.type` 注释写 `card_generation\|validation_evaluation`，worker 实际写 `tag_suggestion`——注释与实现不符且无枚举约束 |
| `ValidationOutcome` 枚举（DB）含 `validated`，但 provider 类型 `EvaluateValidationOutput.outcome` 含 `validated` 而无 `preliminary`——**两边 outcome 值集合不一致** |
| `tag_suggestions` worker 直接 apply 到 note_tags，**审阅环节被绕过**（API 只读不审） |
| `JobType` 枚举只列 3 个，缺文档要求的 parse_source/generate_note_draft/judge_validation/schedule_review |

## 7. 工程可靠性对照（V0 文档 §10.5）

| 要求 | 实现 |
|---|---|
| 所有业务数据带 workspace_id | ✅ 17 张业务表都有 |
| 所有查询通过 workspace scope 过滤 | ⚠️ API 端点贯彻，但 worker handler 不校验，`getNoteWithVersion` 子查询不二次校验 |
| 后台 job 读 subject 前校验 workspace ownership | ❌ `runGenerateCard`/`runSuggestTags` 都不校验 |
| Note 生成学习卡前创建 note_version | ✅ |
| AIArtifact 不直接覆盖 Note | ✅ |
| 学习卡关键内容有 Evidence | ✅ 跑通 |
| 验证记录绑定 learning_unit 和 question | ❌ 无 LU 表，validation 表无绑定 |
| 复习计划来自 validation_attempt | ❌ 无生成逻辑 |
| 长任务通过 job queue 执行 | ✅ |
| Postgres 唯一约束和索引 | ⚠️ 有部分，但无 search_documents 投影 |
| Note Block revision 冲突检测 | ❌ 完全无 |
| Evidence 指向 AIArtifact 内部具体结论 | ✅ 通过 key_point_id |
| AI 原始输出服务端 schema 校验 | ⚠️ 学习卡/标签校验，验证判定未校验枚举 |
| Job 幂等/重试/锁定/成本记录 | ❌ 仅重试（无退避），幂等/锁定/成本全无 |
| 对象存储不公开 + signed URL | ❌ minio 起着但零代码消费 |
| 至少一次备份恢复验证 | ❌ 无脚本 |
| Markdown + JSON 导出 | ❌ 无 |

## 8. 视觉规范与空状态

### 8.1 视觉规范（PRD §3）

| 规范 | 实现 |
|---|---|
| 现代纸卡质感（`.paper-card`/便签/荧光笔/顶部细带）| ✅ `globals.css:73-167` |
| 理解状态色点（5 态全配）| ✅ `UnderstandingChip.tsx` |
| 进度环 | ✅ `ProgressRing.tsx` |
| 状态 chip（13 tone）| ✅ `StatusChip.tsx` |
| 证据线索（细蓝线连接 AI 结论与原文）| ⚠️ 仅色块/边框，**无 SVG 连线** |
| 移动端底部导航（学习流/复习/捕获/状态/我的）| ❌ 实际是 今日/复习/新建/理解/学习卡，**与 PRD 不符** |
| 证据是视觉一等公民 | ✅ 学习卡详情页证据 chip + 抽屉 |

### 8.2 空状态（PRD §8 要求 10 种）

| 空状态 | 实现 |
|---|---|
| 空工作台 | ❌ 无独立整体态 |
| 无学习卡 | ✅ |
| 无到期复习 | ✅ |
| AI 生成中 | ⚠️ 仅按钮态 |
| AI 生成失败 | ⚠️ 显示 error 但无重试按钮 |
| 证据对齐不足 | ✅ `lowEvidence` 粉色警告 |
| 来源解析失败 | ❌ 只有"找不到来源" |
| 自动保存失败 | ✅ StatusChip weak |
| 低置信度验证 | ❌ 无 |
| 数据导出中 | ❌ 无导出功能 |

## 9. 五个 AI 任务实现度

| 任务 | 实现度 | 说明 |
|---|---|---|
| `parse_source` | ❌ 0% | 无 handler、无 job_type、无 API。source_segments 表从不写入 |
| `generate_note_draft` | ❌ 0% | 无 handler、无路由。笔记只能手写 |
| `generate_learning_card` | ✅ 100% | **唯一端到端跑通**。worker `runGenerateCard` 完整链路 |
| `judge_validation` | ⚠️ 30% | provider 有 DashScope 实现，但**无 job handler 调用、无 API 端点提交**，"模型会答但没人问" |
| `schedule_review` | ❌ 0% | 无任何代码。review_schedules 表无 status 字段 |

## 10. AI 调用层问题

| 维度 | 现状 |
|---|---|
| 模型供应商 | 唯一接通 DashScope（qwen-plus）；openai/anthropic 是 throw 桩 |
| prompt 位置 | API 侧 `generate-card.v1.md` + worker 侧 `prompts.ts`，**两处手工同步已存在偏差** |
| schema 校验 | 学习卡/suggest_tags 用 zod 真校验；evaluateValidation 只检查字段存在性，**不校验 outcome 枚举值** |
| 多模型路由 | ❌ 无，单选 provider |
| 失败降级 | ❌ 无 fallback、无重试、无超时 |
| 成本记录 | ❌ ai_artifacts 无 cost/token 列 |
| Evidence 基准测试 | ❌ 文档要求 20-30 篇笔记 benchmark，**完全不存在** |

## 11. 优先修复建议（按影响排序）

### P0 — 阻塞 V0 闭环的关键缺失

1. **打通 V0.1b 验证复习闭环**：后端补 `POST /cards/:id/validate` 端点 + `judge_validation` job handler + 写 `validation_events`/`understanding_events`/`review_schedules`；前端 `ValidationPanel.evaluate()` 改为调后端
2. **打通 V0.2 来源到笔记闭环**：后端补 Source CRUD API + `parse_source` job + `generate_note_draft` job；前端 `sources/page.tsx` 改为调 source API，废弃 localStorage 草稿
3. **修复 `runGenerateCard`/`runSuggestTags` 不校验 workspace** 的安全问题
4. **补 Note revision 冲突检测**（并发编辑丢数据）

### P1 — 数据信任与工程可靠性

5. 修复 align.ts `i>50 break` 截断 bug，长 block 匹配失效
6. job 框架补 `FOR UPDATE SKIP LOCKED` 锁定 + 退避重试 + input_hash 幂等
7. AIArtifact 状态枚举对齐文档（pending/ready/failed/stale/dismissed/accepted）+ 补 input_hash
8. Validation/Review/UnderstandingEvent 状态枚举与字段对齐文档
9. 跑 Evidence 对齐基准测试（20-30 篇笔记），文档要求硬引用 precision >= 80%
10. 消除伪造数据：dashboard 理解分数、cards 覆盖率、review 队列、graph 状态全部改为真实数据（依赖 P0 闭环打通）

### P2 — 产品完整度

11. 补 search_documents 搜索投影 + 后端搜索端点
12. 补 Markdown + JSON 导出
13. 补备份恢复脚本
14. minio signed URL 端点（为未来 PDF/图片准备）
15. 移动端底部导航对齐 PRD（学习流/复习/捕获/状态/我的）
16. 清理死代码：API 侧 ai provider 抽象、重复的 align.ts、两套 prompt 合一
17. 修复 docker-compose web 服务 Dockerfile 缺失
18. CategoryTree 拖拽跨父级 bug、NoteEditor save 失败用旧 versionId bug

## 12. 与 V0 退出标准的差距

文档 §10.6 要求 V0 退出到 V1 需满足：

| 退出标准 | 当前状态 |
|---|---|
| 连续 4 周每周输入 5 份资料/笔记 | ❌ Source 输入闭环未实现，只能输笔记 |
| 连续 4 周每周生成 5 张学习卡 | ⚠️ 学习卡闭环可用，但依赖手工触发 |
| Evidence 硬引用 precision >= 80% | ❌ **从未跑过 benchmark**，且 align 算法有截断 bug |
| 关键结论 hard evidence coverage >= 60% | ❌ 同上，无测量 |
| 没有数据丢失或错误覆盖 | ⚠️ 无 revision 冲突检测，并发编辑会丢 |
| 完成一次完整备份恢复验证 | ❌ 无脚本 |
| 持续使用理解状态列表和 Review | ❌ 两者都是伪实现 |

**结论：当前实现距 V0 退出标准还差约 65-70% 的工作量**，主要缺口在验证复习闭环、来源闭环、Evidence 基准测试、数据可靠性四块。

---

## 附录：审计方法

- 前端：读 `apps/web` 下全部 `.ts/.tsx`（app/ + components/ + lib/），逐页面/组件核对
- 后端：读 `apps/api/src` 全部模块 + `workers/ai-worker/src` 全部 + `packages/shared/src`
- grep 搜索 `TODO/FIXME/XXX/HACK`（前端零命中，后端命中点见 §6.4）
- 对照四份产品文档逐项比对状态枚举、对象字段、闭环步骤、页面要求
