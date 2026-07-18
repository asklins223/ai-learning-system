# AI 原生学习系统云端核心架构

## 0. 文档定位

本文档定义 AI 原生学习系统的云端核心架构。

对应文档：

- [产品愿景](ai-learning-system-product-plan.md)
- [V0 Personal Beta](ai-learning-system-v0-personal-beta.md)

设计前提：

> 系统第一阶段先服务个人使用，但从第一天按未来可上线、多用户、多端、云端 AI 后台处理的方向设计。

本文档不追求过早复杂化。早期推荐使用：

```text
Web App + Backend API + Postgres + Object Storage + Job Queue + AI Workers
```

不建议第一阶段拆成多个微服务。更合理的方式是：

- 一个主后端应用。
- 一套清晰模块边界。
- 多个后台 worker。
- 共享数据库。
- 统一任务队列。
- 后续按压力和团队规模再拆服务。

## 1. 架构原则

### 1.1 Cloud-first

云端数据库是事实来源。

本地客户端可以缓存：

- 编辑草稿。
- 最近打开的笔记。
- 最近 Source。
- 最近 AIArtifact。
- 离线待同步操作。

但最终状态以云端为准。

### 1.2 Multi-tenant from day one

即使第一阶段只有一个用户，也必须从第一天加入：

- `user_id`
- `workspace_id`
- 权限边界
- 数据归属

这样未来上线不会重写数据模型。

### 1.3 原始数据和 AI 派生数据分离

系统必须区分：

- 用户输入的原始资料。
- 用户编辑的笔记。
- 不可变快照。
- AI 生成的派生物。
- 用户理解状态。

AI 结果可以重算、废弃、失效。原始资料和用户笔记不能被 AI 隐式覆盖。

### 1.4 引用是底层能力

Evidence 引用不是 UI 小功能，而是底层数据结构。

所有重要 AI 结论都必须能指向：

- Source Snapshot。
- Note Version Block。
- 文件页码。
- 图片区域。
- 网页段落。
- 代码行号。

没有引用的 AI 内容只能作为临时草稿，不应进入长期理解状态。

### 1.5 AI 处理异步化

以下任务必须走后台队列：

- URL 抓取。
- 网页正文抽取。
- PDF 解析。
- 图片 OCR。
- 截图理解。
- 向量化。
- 学习卡生成。
- 概念抽取。
- 关系发现。
- 验证题生成。
- 用户回答评估。
- 复习调度。
- 今日理解更新。

同步 API 只负责创建任务、返回状态和展示已有结果。

### 1.6 先模块化单体，后服务化

第一阶段不拆微服务。

后端内部按模块组织：

- Identity
- Workspace
- Source
- Note
- Snapshot
- AI Artifact
- Evidence
- Concept
- Validation
- Review
- Search
- Billing
- Job

未来如果需要拆分，优先拆：

- AI Worker。
- Ingestion Worker。
- Search Indexer。
- Billing。

## 2. 总体架构

```text
Client Layer
  Web App
  Future Desktop App
  Future Mobile App

API Layer
  Auth API
  Workspace API
  Source API
  Note API
  AI Artifact API
  Concept API
  Validation API
  Review API
  Search API

Domain Layer
  Source Service
  Note Service
  Snapshot Service
  Evidence Service
  AI Artifact Service
  Understanding Service
  Review Service

Async Layer
  Job Queue
  Ingestion Worker
  Parsing Worker
  Embedding Worker
  AI Generation Worker
  Validation Worker
  Review Worker
  Daily Update Worker

Storage Layer
  Postgres
  Object Storage
  Vector Index
  Search Index
  Cache
```

## 3. 推荐技术形态

具体选型可以后续定，但架构形态建议如下：

### 3.1 V0 默认技术栈

V0 应先收敛到一套默认技术栈，除非出现明确工程约束，不在第一阶段反复摇摆。

推荐默认选择：

| 层级 | V0 默认选择 | 说明 |
|---|---|---|
| Web App | Next.js + TypeScript | 先用成熟全栈框架降低前后端集成成本。 |
| UI | React + 轻量组件库 | 重点是编辑、任务状态和学习卡体验，不自研基础组件。 |
| Editor | Block-based editor library | 必须支持块结构、代码块、自动保存和可序列化内容。 |
| API | 模块化单体 | 可以由 Next.js Route Handlers 承担，也可以独立为 Fastify / NestJS，边界按 domain module 切。 |
| ORM / Query | Drizzle 或 Prisma | 二选一后保持一致；如果大量使用 Postgres 特性，优先 Drizzle。 |
| Database | Postgres | 云端事实来源。 |
| Job Queue | Postgres-based queue | V0 可用 pg-boss / graphile-worker 或等价方案，后续再按压力换 Redis / BullMQ。 |
| Object Storage | S3-compatible storage | 本地开发可用 MinIO，线上使用云厂商对象存储。 |
| AI Schema | Zod / JSON Schema | 所有 AI 输出必须服务端校验。 |
| Search | Postgres full-text search | V0 先用统一搜索投影表，后续再拆搜索服务。 |
| Vector | pgvector 可选 | V0.1 不必做，语义检索稳定后再启用。 |

这些选择不是长期锁死，而是为了让 V0 优先验证学习闭环。真正需要替换时，应该通过清晰接口替换底层实现，而不是改动核心数据模型。

### 3.2 前端

推荐：

- Web App 先行。
- React / Next.js 或同类全栈框架。
- 编辑器选择支持块结构和 Markdown 兼容的方案。

前端职责：

- 编辑体验。
- 输入和导入入口。
- AI 任务状态展示。
- 学习卡和验证交互。
- 搜索和回溯浏览。

前端不负责：

- 直接调用大模型。
- 保存最终事实状态。
- 执行长期后台任务。

### 3.3 后端

推荐：

- 一个主 API 服务。
- 一个 worker 进程或多类 worker。
- 统一数据库。
- 统一鉴权。

后端职责：

- 多用户隔离。
- 数据写入和事务。
- 任务创建和状态管理。
- AI 调用编排。
- Evidence 写入。
- 搜索和向量索引更新。

### 3.4 数据库

核心结构化数据放在 Postgres。

Postgres 作为第一事实来源，是因为系统核心数据具有强关系、强追溯、强事务和多租户隔离要求，同时又需要 JSONB 承载 AI 派生结构。后续可以用全文搜索和 pgvector 支撑早期检索能力，再按规模拆出专门搜索或向量服务。

适合 Postgres 的数据：

- 用户、工作区和权限。
- Source 元数据。
- Note 和 Block。
- Snapshot。
- AIArtifact。
- Evidence。
- Concept 和 Relation。
- Validation。
- Review。
- Job。
- Event。

### 3.5 对象存储

大文件和原始资产放对象存储。

包括：

- PDF。
- 图片。
- 截图。
- 原始网页 HTML。
- 导入附件。
- OCR 原图。
- 未来音频或视频片段。

数据库只保存：

- object key。
- hash。
- mime type。
- size。
- ownership。
- processing status。

对象存储访问规则：

- object key 必须包含 workspace 范围，例如 `workspaces/{workspace_id}/sources/{source_id}/...`。
- 默认不使用公开 bucket，所有下载通过后端鉴权后签发短期 signed URL。
- 上传完成后记录 `content_hash`、`size_bytes` 和 `mime_type`，用于去重、校验和成本控制。
- 删除对象前必须确认没有 active snapshot、source asset 或 evidence 引用。
- 原始文件和解析产物分开存储，AI 处理失败不能破坏原始资产。

### 3.6 搜索和向量

早期可以先用 Postgres 全文搜索和向量扩展。

V0 不建议直接跨多张业务表临时拼搜索结果。应维护一个统一的搜索投影表 `search_documents`，把可搜索对象同步进去：

- Source。
- Note。
- AIArtifact。
- Learning Unit。
- Concept。
- Evidence 片段。

这样 V0 可以用 Postgres full-text search，未来也能平滑同步到专用 Search Index 或 Vector Index。

未来再根据规模拆成：

- Search Index：标题、正文、AI 摘要、OCR、代码、来源。
- Vector Index：语义检索、相似资料、概念聚类。

搜索不应只查笔记标题。它要覆盖：

- Source。
- Note。
- Snapshot。
- AIArtifact。
- Concept。
- OCR。
- 代码片段。
- Evidence 片段。

### 3.7 缓存

缓存用于体验优化，不作为事实来源。

可缓存：

- Session。
- 最近打开对象。
- AI 任务状态。
- 搜索结果。
- 首页聚合视图。

## 4. 核心数据模型

以下是逻辑模型，不是最终迁移脚本。

### 4.0 Schema 约束和索引策略

正式迁移脚本必须补齐数据库约束，不能只依赖业务代码保证数据正确。

基础唯一约束：

- `users.email` unique。
- `workspace_members(workspace_id, user_id)` unique。
- `note_versions(note_id, version_number)` unique。
- `jobs(workspace_id, job_type, subject_type, subject_id, idempotency_key)` unique。
- `concepts(workspace_id, canonical_name)` 在 `status != merged` 时应尽量唯一。

基础索引：

- 所有业务表至少有 `workspace_id` 索引。
- 列表页常用表增加 `(workspace_id, status, updated_at)` 或 `(workspace_id, created_at)` 索引。
- `note_blocks(note_id, position)` 用于稳定读取编辑器块。
- `note_version_blocks(note_version_id, position)` 用于稳定重放快照。
- `source_segments(source_snapshot_id, position)` 用于 Evidence 回溯。
- `evidence_refs(workspace_id, target_type, target_id)` 用于展示 AI 结论证据。
- `review_schedules(workspace_id, user_id, status, due_at)` 用于复习队列。
- `jobs(status, priority, next_run_at)` 用于 worker 拉取任务。

删除和归档策略：

- 用户内容默认软删除或归档，不做物理删除。
- workspace 删除必须进入异步清理流程，不能同步级联删除大量业务数据。
- `note_versions`、`source_snapshots`、`source_segments`、`evidence_refs` 默认不可变，不随原 Note 或 Source 编辑而更新。
- AIArtifact 可以标记 `stale` / `dismissed`，不应直接覆盖历史记录。
- 对象存储资产删除必须先确认没有 active snapshot 或 evidence 引用。

### 4.1 identity

#### users

- id
- email
- display_name
- avatar_url
- created_at
- updated_at

#### workspaces

- id
- owner_user_id
- name
- plan
- created_at
- updated_at

#### workspace_members

- id
- workspace_id
- user_id
- role：`owner` / `admin` / `member`
- created_at

早期只有一个 workspace，也必须保留该结构。

### 4.2 source

#### sources

保存进入系统的学习材料。

- id
- workspace_id
- created_by_user_id
- source_type：`manual` / `url` / `text` / `markdown` / `pdf` / `image` / `screenshot` / `code`
- title
- original_url
- status：`draft` / `processing` / `ready` / `failed` / `archived`
- language
- metadata_json
- created_at
- updated_at

#### source_assets

保存 Source 关联的对象存储资产。

- id
- workspace_id
- source_id
- asset_type：`html` / `pdf` / `image` / `screenshot` / `attachment`
- object_key
- mime_type
- size_bytes
- content_hash
- created_at

#### source_snapshots

保存 Source 某次解析后的不可变内容。

- id
- workspace_id
- source_id
- snapshot_type：`raw` / `cleaned` / `ocr` / `parsed`
- content_text
- content_json
- content_hash
- parser_version
- created_at

#### source_segments

保存可引用的来源片段。

- id
- workspace_id
- source_snapshot_id
- segment_type：`paragraph` / `heading` / `code` / `table` / `image_region` / `pdf_page`
- content_text
- locator_json
- position
- content_hash
- created_at

`locator_json` 用于保存页码、区域坐标、DOM 路径、代码行号等定位信息。

### 4.3 note

#### notes

- id
- workspace_id
- created_by_user_id
- title
- status：`draft` / `active` / `archived`
- source_id
- created_at
- updated_at

`source_id` 可为空。手写笔记不一定有外部 Source。

#### note_blocks

- id
- workspace_id
- note_id
- block_type：`heading` / `paragraph` / `list` / `code` / `quote` / `image` / `source_ref`
- content
- position
- revision
- metadata_json
- created_at
- updated_at

#### note_versions

保存用于 AI 处理和回溯的笔记版本。

- id
- workspace_id
- note_id
- version_number
- status：`current` / `superseded`
- snapshot_hash
- created_from_note_updated_at
- created_at

#### note_version_blocks

- id
- workspace_id
- note_version_id
- original_note_block_id
- block_type
- content_snapshot
- position
- content_hash
- metadata_json
- created_at

AI 生成、验证题、判断反馈都应引用 `note_version_blocks`，不能直接引用可变的 `note_blocks`。

编辑器存储规则：

- V0 使用块级自动保存，不要求实时多人协作。
- `position` 用可排序数值，建议以 1000 为间隔写入；频繁插入导致间隔不足时由服务端重新排序。
- `revision` 用于自动保存冲突检测。客户端提交时带上旧 revision，服务端成功写入后递增。
- 代码块语言保存在 `metadata_json.language`。
- `source_ref` 块通过 `metadata_json.source_type` 和 `metadata_json.source_id` 指向 `source_segment` 或 `note_version_block`。
- 创建 `note_version` 时必须复制当时的块内容、顺序和 metadata，后续编辑不得修改旧版本。

### 4.4 evidence

#### evidence_refs

保存 AI 结论和可信来源之间的引用。

- id
- workspace_id
- target_type：`ai_artifact` / `claim` / `concept` / `validation_question` / `validation_attempt`
- target_id
- target_path
- source_type：`source_segment` / `note_version_block` / `asset_region`
- source_id
- quote_text
- locator_json
- confidence
- alignment_status：`aligned` / `soft` / `unaligned` / `stale_alignment`
- alignment_score
- alignment_method：`exact` / `fuzzy` / `embedding` / `manual`
- alignment_candidates_json
- aligned_at
- created_at

说明：

- `target_path` 用 JSON Pointer 或等价路径指向目标对象内部的具体字段，例如 `/key_points/0`、`/pitfalls/2`、`/validation_question/expected_points/1`。
- `quote_text` 保存模型输出或用户确认的引用文本，方便展示和后续重算。
- 可信内容仍以 source snapshot 或 note version block 为准。
- Evidence 不应只证明“这个学习卡有依据”，而应证明“这条具体结论有依据”。
- `aligned` 是硬引用，可以支撑理解状态升级；`soft` 和 `unaligned` 只能作为弱提示。

字段语义：

- `aligned`：`source_id` 必须指向最终确认的 source segment、note version block 或 asset region。
- `soft`：`source_id` 可以为空；如果系统有最佳候选，可以暂存候选 source id，但不能作为硬引用使用。
- `unaligned`：`source_id` 必须为空，只保留 `quote_text` 和失败原因。
- `stale_alignment`：原 `source_id` 可能已失效，必须重新对齐后才能恢复为 `aligned`。
- `alignment_candidates_json` 保存候选列表、分数和方法，用于调试、人工修正和后续重算。

### 4.5 ai artifact

#### ai_artifacts

统一保存 AI 生成内容。

- id
- workspace_id
- created_by_job_id
- artifact_type：`summary` / `learning_card` / `code_explanation` / `pitfall` / `question` / `daily_update` / `handbook_section` / `graph_suggestion`
- subject_type：`source` / `note` / `note_version` / `concept` / `learning_unit` / `workspace`
- subject_id
- status：`pending` / `ready` / `failed` / `stale` / `dismissed` / `accepted`
- title
- content_text
- content_json
- raw_output
- schema_version
- validation_status：`unchecked` / `valid` / `invalid` / `repaired`
- validation_errors_json
- model_name
- prompt_version
- input_hash
- output_hash
- evidence_coverage
- evidence_hard_count
- evidence_soft_count
- quality_flags_json
- created_at
- updated_at

AIArtifact 是可重算对象，不是原始事实。

### 4.6 concept graph

#### concepts

- id
- workspace_id
- name
- canonical_name
- aliases_json
- description
- status：`candidate` / `accepted` / `merged` / `archived`
- merged_into_concept_id
- created_at
- updated_at

#### claims

- id
- workspace_id
- claim_text
- status：`candidate` / `accepted` / `rejected` / `conflicting`
- confidence
- created_at
- updated_at

#### concept_mentions

记录概念在来源和笔记中的出现。

- id
- workspace_id
- concept_id
- mention_source_type：`source_segment` / `note_version_block` / `ai_artifact`
- mention_source_id
- mention_text
- confidence
- created_at

#### relations

- id
- workspace_id
- from_type：`concept` / `claim` / `source` / `note`
- from_id
- relation_type：`prerequisite` / `similar` / `confuses_with` / `example_of` / `evidence_for` / `contradicts` / `applies_to` / `part_of`
- to_type：`concept` / `claim` / `source` / `note`
- to_id
- status：`candidate` / `accepted` / `rejected`
- confidence
- created_at
- updated_at

早期所有关系都可以先是 `candidate`，由用户或后续 AI 确认。

### 4.7 learning and understanding

#### learning_units

学习单元是学习视图，不是所有事实的中心。

- id
- workspace_id
- subject_type：`source` / `note_version` / `concept` / `topic`
- subject_id
- title
- status：`active` / `stale` / `archived`
- created_at
- updated_at

#### validation_questions

- id
- workspace_id
- learning_unit_id
- ai_artifact_id
- question_type：`explain` / `example` / `apply` / `compare`
- question
- expected_points_json
- status：`active` / `stale` / `archived`
- created_at

`expected_points_json` 不应只是字符串数组。每个 expected point 应尽量包含：

- point text。
- 对应 `evidence_refs`。
- 是否为理解升级所必需。

没有 Evidence 的 expected point 可以用于提示，但不能单独支撑理解状态升级。

#### validation_attempts

- id
- workspace_id
- user_id
- learning_unit_id
- question_id
- user_answer
- result：`preliminary_understanding` / `unclear_expression` / `misunderstanding` / `unknown`
- confidence
- ai_judgement_json
- created_at

#### understanding_events

理解账户的事件流。

- id
- workspace_id
- user_id
- subject_type：`concept` / `learning_unit` / `note` / `source`
- subject_id
- event_type：`seen` / `explained` / `example_given` / `validated` / `misunderstood` / `reviewed` / `recalled` / `forgotten_risk`
- evidence_json
- source_validation_attempt_id
- created_at

正式理解状态可以从事件流聚合，也可以后续维护物化表。

V0 阶段优先把理解事件绑定到 `learning_unit` 和 `note`。在 Concept 候选抽取、合并和去重稳定前，不把 Concept 作为理解状态的主粒度，避免早期概念噪声污染长期账户。

#### understanding_states

可选物化表，用于快速展示。

- id
- workspace_id
- user_id
- subject_type
- subject_id
- state：`unseen` / `seen` / `unverified` / `preliminary_understood` / `can_explain` / `can_apply` / `misunderstood` / `stale`
- confidence
- last_event_id
- updated_at

### 4.8 review

#### review_schedules

- id
- workspace_id
- user_id
- subject_type：`learning_unit` / `concept` / `note`
- subject_id
- due_at
- review_type：`recall` / `reread` / `compare` / `apply` / `fix_misunderstanding`
- reason
- status：`pending` / `accepted` / `dismissed` / `completed` / `superseded` / `cancelled`
- source_validation_attempt_id
- created_at
- updated_at

#### review_attempts

- id
- workspace_id
- user_id
- review_schedule_id
- action：`opened` / `answered` / `dismissed` / `completed`
- validation_attempt_id
- created_at

复习调度规则：

- V0 可以用固定规则启动，例如初步理解后 3 天复述。
- 后续必须让间隔受 `validation_attempt.confidence`、误解状态和复习结果影响。
- 高置信度且复习完成的内容可以拉长间隔。
- 表达不清、低置信度或误解内容应缩短间隔，必要时立即回看 Evidence。
- 每次复习结果都应写入 `review_attempts` 和 `understanding_events`，作为下一次调度输入。

### 4.9 jobs and events

#### jobs

- id
- workspace_id
- job_type：`ingest_url` / `parse_source` / `embed_source` / `generate_learning_card` / `align_evidence` / `extract_concepts` / `generate_question` / `judge_validation` / `schedule_review` / `daily_update` / `recompute_artifact`
- status：`queued` / `running` / `succeeded` / `failed` / `cancelled`
- subject_type
- subject_id
- idempotency_key
- priority
- attempts
- max_attempts
- next_run_at
- locked_by
- locked_at
- error_message
- payload_json
- result_json
- cost_json
- created_at
- started_at
- finished_at

任务执行规则：

- 同一 `workspace_id + job_type + subject_type + subject_id + idempotency_key` 不应重复创建等价任务。
- worker 领取任务时写入 `locked_by` 和 `locked_at`，超时后允许重新领取。
- 失败任务根据 `attempts`、`max_attempts` 和 `next_run_at` 重试。
- AI 相关任务必须在 `cost_json` 记录模型、token、耗时和估算成本。
- 任务读取或写入 subject 前必须校验 workspace ownership。

#### domain_events

- id
- workspace_id
- actor_user_id
- event_type
- subject_type
- subject_id
- metadata_json
- created_at

事件用于：

- 审计。
- 指标。
- 调试。
- 后续自动化。

### 4.10 search projection

#### search_documents

统一保存可搜索对象的投影，不作为事实来源。

- id
- workspace_id
- object_type：`source` / `note` / `ai_artifact` / `learning_unit` / `concept` / `evidence`
- object_id
- title
- body
- language
- tsvector
- metadata_json
- source_updated_at
- indexed_at

同步规则：

- Note、Source、AIArtifact 更新后，通过 domain event 或 job 更新 `search_documents`。
- 搜索结果只返回 object_type 和 object_id，详情仍回到原业务表读取。
- V0 可以只做 Postgres full-text search；向量 embedding 可后续增加到同一投影或独立表。
- 搜索投影允许重建，不能把用户唯一数据只保存在这里。

## 5. 核心流程

### 5.1 粘贴 URL 导入

完整 URL 抓取流程属于 V0.2 或 V1。V0.1 只保存 URL 和用户手动粘贴正文，不自动抓取网页正文。

```text
1. 用户粘贴 URL
2. API 创建 source(status=processing)
3. API 创建 ingest_url job
4. worker 抓取网页并保存 html asset
5. worker 解析正文，创建 source_snapshot 和 source_segments
6. worker 创建 note draft
7. worker 触发 generate_learning_card / extract_concepts
8. 前端展示处理状态和可编辑草稿
```

URL 抓取安全边界：

- 禁止抓取 localhost、内网 IP、link-local 地址和云厂商 metadata service。
- DNS 解析后仍要校验目标 IP，不能只校验原始 URL 字符串。
- 限制响应大小、下载时间、重定向次数和最终内容类型。
- 默认只允许 `http` / `https`。
- HTML asset 保存前应做大小限制和基础清洗。
- 抓取错误需要记录 `fetch_error_type`，例如 `timeout`、`blocked_private_ip`、`too_large`、`unsupported_content_type`。
- 抓取失败只影响 Source 处理状态，不应阻塞用户手动粘贴正文和创建 Note。

### 5.2 手写笔记生成学习卡

```text
1. 用户编辑 note_blocks
2. 用户点击生成学习卡
3. API 创建 note_version 和 note_version_blocks
4. API 创建 learning_unit
5. API 创建 generate_learning_card job
6. worker 读取 note_version_blocks
7. worker 生成 AIArtifact
8. worker 写入 evidence_refs
9. worker 生成 validation_question
10. 前端展示学习卡和问题
```

### 5.3 用户回答理解验证

```text
1. 用户提交回答
2. API 创建 validation_attempt(status pending 可选)
3. API 创建 judge_validation job
4. worker 根据问题、expected_points、Evidence 和用户回答进行判断
5. worker 更新 validation_attempt
6. worker 写入 understanding_event
7. worker 创建或更新 review_schedule
8. 前端展示判断和复习建议
```

### 5.4 笔记编辑后的失效

```text
1. 用户继续编辑 note_blocks
2. note.updated_at 改变
3. 旧 note_version 不变
4. 旧 AIArtifact 仍可查看
5. 如果用户重新生成，系统创建新 note_version
6. 旧 learning_unit / AIArtifact 标记 stale
7. 旧未完成 review_schedule 标记 superseded
```

## 6. API 边界

早期 API 可以按资源组织。

### 6.1 Source API

- `POST /sources`
- `GET /sources`
- `GET /sources/:id`
- `POST /sources/:id/reprocess`
- `POST /sources/:id/create-note`

### 6.2 Note API

- `POST /notes`
- `GET /notes`
- `GET /notes/:id`
- `PATCH /notes/:id`
- `PUT /notes/:id/blocks`
- `POST /notes/:id/versions`
- `POST /notes/:id/generate-learning-card`

### 6.3 AI Artifact API

- `GET /ai-artifacts`
- `GET /ai-artifacts/:id`
- `POST /ai-artifacts/:id/accept`
- `POST /ai-artifacts/:id/dismiss`
- `POST /ai-artifacts/:id/regenerate`

### 6.4 Validation API

- `POST /validation-attempts`
- `GET /learning-units/:id/validation`

### 6.5 Review API

- `GET /reviews`
- `POST /reviews/:id/complete`
- `POST /reviews/:id/dismiss`

### 6.6 Search API

- `GET /search`
- `GET /concepts`
- `GET /concepts/:id`

## 7. AI 处理规范

### 7.1 AI 输出必须结构化

AI 输出不能只是一段自然语言。

每类任务都应有 schema，例如学习卡：

```json
{
  "summary": "string",
  "key_points": [
    {
      "text": "string",
      "quote": "string"
    }
  ],
  "concepts": [
    {
      "name": "string",
      "description": "string",
      "quote": "string"
    }
  ],
  "pitfalls": [
    {
      "text": "string",
      "quote": "string"
    }
  ],
  "validation_question": {
    "type": "explain",
    "question": "string",
    "expected_points": [
      {
        "text": "string",
        "required": true,
        "quote": "string"
      }
    ]
  }
}
```

模型不直接输出 `source_segment_id` 或 `note_version_block_id`。模型只输出尽量逐字复制的 `quote`，系统通过 Evidence 对齐流程生成 `evidence_refs`。这样可以降低模型幻觉引用不存在 ID 或错配 ID 的风险。

服务端校验流程：

```text
1. worker 调用模型，拿到 raw_output
2. 保存 raw_output、model_name、prompt_version、input_hash
3. 用 Zod / JSON Schema 校验 raw_output
4. 校验通过后写入 content_json，validation_status=valid
5. 校验失败时记录 validation_errors_json，status=failed 或 validation_status=invalid
6. 可修复的格式问题进入 repair 流程，修复后 validation_status=repaired
7. 对每个 quote 执行 Evidence 对齐
8. 只有 valid / repaired 且 Evidence 对齐达标的结构化结果可以进入 Validation 和 Review
```

前端只能消费服务端校验后的 `content_json`，不能直接展示未校验的模型 JSON 作为可信结果。

### 7.2 Evidence 对齐流程

Evidence 对齐不依赖模型直接产 ID。

```text
1. worker 读取 note_version_blocks / source_segments 作为引用池
2. 模型输出学习卡结构化内容和 quote
3. worker 对每个 quote 执行对齐
4. 对齐成功写入 evidence_ref(alignment_status=aligned)
5. 对齐不确定写入 soft 引用
6. 对齐失败标记 unaligned，该结论只能作为弱提示
7. 更新 AIArtifact evidence_coverage 和 hard / soft count
```

对齐算法分三级：

- exact：归一化后做子串匹配，命中时 `alignment_score=1.0`。
- fuzzy：使用 token 相似度匹配轻微改写的 quote。
- embedding：使用向量相似度匹配语义改写的 quote。

V0.1a 前必须用 20-30 篇真实笔记做 Evidence 对齐基准测试，人工标注硬引用是否真的对应原文。这个基准决定后续质量阈值。

初始建议阈值：

- 硬引用 precision >= 80%。
- 关键结论 hard evidence coverage >= 60%。
- validation expected points hard coverage >= 80%。

低于阈值时，不应继续扩展 Validation 和 Review，应优先优化 prompt、quote 长度约束、分段策略和对齐算法。

### 7.3 AI 质量闸门

AI 结果进入长期理解状态前必须通过质量闸门：

- 学习卡的关键结论、易错点和验证题 expected points 应绑定硬引用 Evidence。
- 只有 `alignment_status=aligned` 的 Evidence 可以支撑理解状态升级。
- `soft`、`unaligned` 或缺少 Evidence 的内容只能作为草稿或弱提示展示。
- `evidence_coverage` 低于阈值时，AIArtifact 可以 `ready`，但标记为 `low_evidence`，不能用于 Understanding Event 和 Review Schedule。
- `judge_validation` 置信度低于阈值时必须返回 `unknown`。
- `unknown`、低置信度或缺少硬引用 Evidence 的判断不能写入 `validated` 事件。
- AIArtifact 可以 `ready`，但只有满足引用要求的部分才能用于 Understanding Event 和 Review Schedule。

### 7.4 Prompt versioning

每次 AIArtifact 必须记录：

- `model_name`
- `prompt_version`
- `input_hash`
- `output_hash`

这样后续可以：

- 复现问题。
- 批量重算。
- 比较不同 prompt 效果。
- 标记旧版本 AI 结果失效。

### 7.5 Human override

用户必须可以：

- 接受 AI 结果。
- 忽略 AI 结果。
- 修改后保存为自己的笔记。
- 标记 AI 错误。
- 重新生成。

用户修正后的内容优先级高于 AI 派生结果。

### 7.6 模型路由和缓存

AI 调用层必须抽象为统一 provider 接口，避免业务代码直接绑定单一模型供应商。

路由原则：

- 学习卡生成、验证判断等高价值任务优先使用强模型。
- 分段、摘要、概念候选等低风险任务可以使用小模型。
- 相同 `input_hash + prompt_version + model_name` 的结果默认可复用，不重复生成。
- 供应商限流、涨价或不可用时，应支持备用模型。
- 所有调用记录 token、耗时、模型、错误和估算成本。

### 7.7 重算和失效

AIArtifact 和 Evidence 都必须支持重算。

- prompt 或 schema 升级后，旧 `schema_version` 的 AIArtifact 可以标记 `stale` 并批量重算。
- source segment 重新分段后，相关 evidence_ref 标记 `stale_alignment`。
- Evidence 重算优先基于 `quote_text` 重新对齐，不必重新调用模型。
- 人工修正的 Evidence 使用 `alignment_method=manual`，默认不被自动重算覆盖。
- 重算后如果 `evidence_coverage` 下降，相关学习卡和 Review 应降级或提示用户复核。

## 8. 权限和隔离

第一阶段也要实现基础权限边界：

- 所有业务表必须带 `workspace_id`。
- 所有查询必须按 workspace 过滤。
- 用户必须通过 membership 访问 workspace。
- 对象存储路径必须包含 workspace 范围。
- 后台 job 必须验证 workspace ownership。

实现约束：

- 后端应提供 workspace-scoped repository / query helper，业务代码默认不能绕过。
- API 层必须先解析当前 workspace membership，再进入业务 service。
- 所有按 id 查询的接口都必须同时带上 `workspace_id` 条件。
- 后台 worker 不能只信任 job payload 中的 subject_id，必须重新从数据库按 workspace 校验。
- 测试必须覆盖跨 workspace 读取、更新、生成 AIArtifact 和执行 job 的失败场景。

### 8.1 数据主权

学习数据包含用户的理解盲区、误解、知识缺口和长期学习轨迹，必须按个人敏感数据处理。

数据主权要求：

- 用户必须可以导出自己的数据。
- 用户必须可以删除 workspace 或单个学习对象。
- 默认不把用户数据用于训练第三方模型。
- AI provider 调用应优先选择不保留训练数据的配置或企业/API 模式。
- 日志中不得记录完整用户笔记、完整 AI 输入和长期有效 signed URL。

导出格式：

- Note 导出为 Markdown。
- Source、AIArtifact、Evidence、Validation、Review 和 Understanding Event 导出为 JSON。
- 导出包只保存 object key、文件元数据和可选原始资产，不保存长期有效 signed URL。

删除流程：

- 普通内容删除先进入软删除或归档状态。
- 用户触发永久删除时，系统创建异步删除 job。
- 删除 job 需要清理数据库记录、搜索投影、对象存储资产和后续待执行 AI job。
- 有快照或 Evidence 依赖的对象，应先标记为不可用并进入引用清理流程，不能直接破坏历史一致性。
- 删除完成后写入 domain event 供审计和调试。

未来上线前再补：

- 邀请系统。
- 角色权限。
- 共享笔记。
- 公开链接。
- 计费配额。

## 9. 部署阶段

### 9.1 Personal Cloud

给自己使用。

可接受：

- 单环境。
- 简单日志。
- 手动部署。
- 少量 worker。
- 小规模对象存储。

不可接受：

- 数据无备份。
- AI 输出无引用。
- 无用户和 workspace 隔离。
- 同步请求直接等待长 AI 任务。

最低数据可靠性要求：

- 每日数据库备份。
- 对象存储开启版本保留或定期备份。
- 至少每月验证一次从备份恢复到临时环境。
- 支持导出 Markdown + JSON，保证 Note、Source、AIArtifact、Evidence 和 Review 记录可带走。
- 备份和导出不包含长期有效的 signed URL，只保存 object key 和元数据。

### 9.2 Private Alpha

邀请少量用户。

需要增加：

- 生产和预发布环境。
- 数据库备份。
- 基础监控。
- 错误告警。
- AI 成本统计。
- 任务失败重试。
- 用户反馈入口。

### 9.3 Public Beta

面向公开用户。

需要增加：

- 计费和配额。
- 数据导出。
- 更完整的权限。
- 安全审计。
- SLA 风险控制。
- 速率限制。
- 模型成本优化。

## 10. 关键风险

### 10.1 Learning Unit 过度中心化

风险：

> 把所有内容、状态、AI 结果都挂在 learning_unit 上，后续会变成巨型对象。

应对：

- Learning Unit 只作为学习视图。
- 底层事实放在 Source、Note、Snapshot、Evidence、AIArtifact、Concept、Understanding Event。

### 10.2 AI 结果不可信

风险：

> 用户看不到 AI 从哪里得出结论，长期不会信任。

应对：

- Evidence 作为底层表。
- AI 输出必须携带引用。
- 无引用结果只能作为草稿。

### 10.3 过早微服务化

风险：

> 架构复杂度超过个人开发和早期迭代能力。

应对：

- 先做模块化单体。
- 只拆 worker。
- 数据模型先稳定。

### 10.4 只做笔记，不做理解

风险：

> 产品退化成 AI 笔记工具。

应对：

- 从 V0 就保留 Validation、Understanding Event、Review。
- 学习卡必须有验证入口。
- 复习必须来自理解状态，而不是固定模板。

### 10.5 云端成本失控

风险：

> 抓取、OCR、向量化、大模型生成导致成本不可控。

应对：

- 所有 AI 任务进入 jobs。
- 记录 token、模型、耗时和成本。
- 支持重试和取消。
- 用户主动触发高成本任务。
- 后续接入配额。

## 11. 架构一句话

> 用云端数据库保存可信事实，用对象存储保存原始资产，用任务队列处理 AI 派生，用 Evidence 连接 AI 结论和原始来源，用 Understanding Event 长期维护用户的理解账户。
