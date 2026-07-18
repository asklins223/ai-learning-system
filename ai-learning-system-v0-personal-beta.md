# AI 原生学习系统 V0 Personal Beta

## 0. 文档定位

本文档定义第一阶段版本：V0 Personal Beta。

相关文档：

- [产品愿景](ai-learning-system-product-plan.md)
- [云端核心架构](ai-learning-system-cloud-architecture.md)

V0 不是传统 MVP。

它不以陌生用户增长、转化率或商业验证为核心目标，而是：

> 用未来可上线的云端架构，先做出自己真实愿意使用的 AI 学习系统内核。

V0 要同时满足两件事：

- 自己能每天用。
- 后续上线不用推翻核心架构。

## 1. V0 核心结论

V0 的主线不是“做一个最小 AI 笔记产品”，而是：

> 建立云端学习内核，让 Source、Note、Snapshot、AIArtifact、Evidence、Validation 和 Review 跑通。

第一阶段只做一个可用切片：

```text
输入资料或笔记
-> 生成可编辑笔记
-> 创建快照
-> 生成学习卡
-> 回溯证据
-> 完成一次理解验证
-> 生成一次轻量复习建议
```

V0 不追求完整理解图谱、完整抓取系统、复杂编辑器或多端体验。

但 V0 必须从第一天保留以下底层能力：

- 云端账号和 workspace。
- 多用户可扩展的数据模型。
- Source 和 Note 分层。
- Note Version 和 Snapshot。
- AIArtifact 统一存储。
- Evidence 引用。
- 异步 AI job。
- Understanding Event。
- Review Schedule。

## 2. V0 目标

### 2.1 产品目标

V0 要证明：

- 自己可以把学习资料持续丢进系统。
- 系统能把资料转成可编辑笔记。
- AI 生成内容不是孤立摘要，而是有证据引用的学习卡。
- 用户能通过一个问题验证自己是否理解。
- 系统能根据验证结果生成下一步复习建议。
- 数据结构支持后续扩展到网页、PDF、图片、图谱和多用户。

### 2.2 工程目标

V0 要建立：

- 云端事实来源。
- 后端 API。
- 数据库 schema。
- 后台 job 框架。
- AI 生成结果的统一存储。
- Evidence 引用机制。
- 可观察的任务状态。
- 基础错误处理。

### 2.3 不作为 V0 目标

V0 不验证：

- 大规模用户增长。
- 商业转化。
- 复杂协作。
- 完整学习风格系统。
- 完整图谱体验。
- 全平台覆盖。

## 3. V0 用户

V0 第一用户是产品所有者本人。

系统仍然按多用户设计，但早期可以只开放：

- owner 账号。
- 一个默认 workspace。
- 后续少量邀请用户。

V0 的使用场景：

- 学习一篇技术文章。
- 记录一个概念。
- 保存一段代码和自己的理解。
- 把外部材料转成笔记草稿。
- 让 AI 生成学习卡。
- 回答一个验证问题。
- 几天后收到轻量复习提醒。

## 4. 产品边界

V0 按三个切片交付，避免第一版被导入、搜索和概念图谱拖慢：

- V0.1a：手写 Note -> Snapshot -> 学习卡 -> Evidence 展示 -> 回溯原文。
- V0.1b：验证问题 -> 用户回答 -> Understanding Event -> Review。
- V0.2：Source 输入池 -> Source Snapshot / Segment -> Note Draft。
- V0.3：URL 抽取、基础搜索、AI 反馈、最小理解状态列表和今日理解更新最小版。

第一优先级是 V0.1a。只有学习卡和 Evidence 回溯稳定后，才继续加入验证、Review 和外部资料导入。

在正式开发 V0.1a 前，先做一个端到端硬编码 happy path：

```text
固定笔记文本
-> 调用模型生成学习卡
-> 对齐 Evidence
-> 展示引用
-> 回溯原文
```

这个切片不需要完整编辑器、job 框架或状态机，目标是在 1-2 天内暴露 AI 引用准确性风险。

### 4.1 V0 必做

V0 全量必须包含：

- Web App。
- 登录或单用户账号体系。
- Workspace 数据隔离。
- Source 输入池。
- 手动创建 Note。
- 从文本、Markdown 或代码片段创建 Source。
- URL Source 可以先保存链接和用户手动粘贴正文，自动网页抓取不进入 V0.1。
- Source 转 Note Draft。
- 基础块编辑。
- Note Version。
- 学习卡生成。
- Evidence 回溯。
- 一个验证问题。
- 用户回答和 AI 判断。
- Understanding Event。
- Review Schedule。
- 简单工作台。

分阶段必做：

| 阶段 | 必做范围 | 不进入该阶段的内容 |
|---|---|---|
| V0.1a | 手写 Note、Note Version、学习卡生成、AI 输出校验、Evidence 对齐、Evidence 展示和原文回溯 | Validation、Review、Source 输入池、搜索 |
| V0.1b | 验证问题、用户回答、AI 判断、Understanding Event、Review Schedule、工作台复习入口 | Source 输入池、URL 抓取、完整搜索 |
| V0.2 | Source 创建、文本 / Markdown / 代码输入、Source Snapshot / Segment、Source 转 Note Draft、URL 保存和手动正文粘贴 | 自动 URL 抓取、PDF / 图片处理 |
| V0.3 | 基础搜索、`search_documents`、最近内容、AI 反馈、最小理解状态列表、今日理解更新最小版、Markdown + JSON 导出 | 浏览器插件、复杂图谱、完整导入生态 |

### 4.2 V0 可选

根据开发成本决定是否加入：

- URL 正文自动抽取（V0.3 或 V1）。
- 基础全文搜索。
- Concept 候选抽取。
- 最近资料和最近学习卡。
- AI 结果手动反馈。
- 简单每日回顾。

### 4.3 V0 不做

V0 明确不做：

- 浏览器插件。
- V0.1 不做自动网页抓取。
- iOS / Android。
- 桌面端。
- PDF 批注。
- 图片 OCR。
- 架构图理解。
- 视频字幕导入。
- 完整理解图谱。
- 完整个人技术手册。
- 多学习风格选择。
- 复杂复习算法。
- 团队协作。
- 计费。

这些能力后续可以接入，但不能拖慢 V0 内核。

## 5. V0 核心对象

V0 使用云端架构文档中的完整模型，但只实现必要字段。

### 5.1 User / Workspace

V0 即使只有一个人，也要保留：

- `users`
- `workspaces`
- `workspace_members`

所有业务数据必须带 `workspace_id`。

### 5.2 Source

V0 支持的 Source 类型：

- `text`
- `markdown`
- `url`
- `code`
- `manual`

`url` 在 V0.1 只表示来源链接和可选的用户粘贴正文。没有正文的 URL 不能直接进入学习卡生成；自动抓取、清洗正文和保存 HTML asset 放到 V0.2 或 V1。

V0 暂不支持：

- `pdf`
- `image`
- `screenshot`
- `audio`
- `video`

Source 状态：

- `draft`
- `processing`
- `ready`
- `failed`
- `archived`

### 5.3 Note / Block

V0 Note 是用户可编辑内容。

Block 类型：

- `heading`
- `paragraph`
- `list`
- `code`
- `quote`
- `source_ref`

编辑器要求：

- 能稳定输入。
- 能自动保存。
- 能保存代码块。
- 能从 Source Draft 继续编辑。
- 能重新打开。

V0 不追求复杂块系统，不做 Notion 替代品。

### 5.4 Snapshot / Version

V0 必须实现：

- `note_versions`
- `note_version_blocks`
- `source_snapshots`
- `source_segments`

原因：

> AI 生成结果必须绑定不可变输入，而不是绑定会继续变化的笔记。

### 5.5 AIArtifact

V0 使用 `ai_artifacts` 存储所有 AI 生成结果。

V0 Artifact 类型：

- `learning_card`
- `summary`
- `code_explanation`
- `pitfall`
- `question`
- `validation_feedback`

每条 AIArtifact 必须记录：

- subject。
- status。
- content_json。
- model_name。
- prompt_version。
- input_hash。

### 5.6 Evidence

V0 必须实现 Evidence。

支持引用：

- `source_segment`
- `note_version_block`

暂不支持：

- 图片区域。
- PDF 坐标。
- 视频时间戳。

学习卡中的关键结论、易错点、验证题 expected points，都应该尽量带 Evidence。

### 5.7 Learning Unit

V0 仍然可以有 Learning Unit，但它只作为学习视图。

V0 Learning Unit 绑定：

- 一个 `note_version`
- 或一个 `source`

它聚合：

- 学习卡 AIArtifact。
- 验证问题。
- 验证记录。
- 复习计划。

不要把所有字段都塞进 Learning Unit。

### 5.8 Validation

V0 只支持一种默认验证体验：

> 一个短问题，让用户用自己的话解释、举例或应用。

问题类型：

- `explain`
- `example`
- `apply`

判断结果：

- `preliminary_understanding`
- `unclear_expression`
- `misunderstanding`
- `unknown`

判断必须输出结构化 JSON：

```json
{
  "result": "preliminary_understanding",
  "confidence": 0.82,
  "covered_points": ["核心概念 A"],
  "missing_points": ["限制条件 B"],
  "misunderstandings": [],
  "evidence_refs": ["note_version_block_id"]
}
```

### 5.9 Understanding Event

V0 不需要复杂理解图谱，但必须写入理解事件。

V0 的理解事件优先绑定：

- `learning_unit`
- `note`

在 Concept 候选抽取稳定前，不把 Concept 作为 V0 理解状态的主粒度。

事件类型：

- `seen`
- `validated`
- `misunderstood`
- `reviewed`

这些事件是未来理解账户和图谱的基础。

### 5.10 Review

V0 只做轻量复习建议。

规则：

| 验证结果 | 理解事件 | 复习建议 |
|---|---|---|
| `preliminary_understanding` | `validated` | 3 天后复述 |
| `unclear_expression` | 不升级 | 当天回看关键片段 |
| `misunderstanding` | `misunderstood` | 立即回看 Evidence 和解释 |
| `unknown` | 不升级 | 换一道题或稍后再试 |

这张表是 V0 启动规则，不是长期固定算法。后续复习间隔应根据验证置信度、是否存在误解、用户是否完成复习动态调整。

复习计划状态：

- `pending`
- `accepted`
- `dismissed`
- `completed`
- `superseded`
- `cancelled`

## 6. V0 页面设计

### 6.1 工作台

工作台是第一屏。

包含：

- 快速输入。
- 最近笔记。
- 智能收件箱。
- 今日轻复习。
- 最近学习卡。
- 后台任务状态。

不做复杂仪表盘。

### 6.2 快速输入页或面板

支持：

- 粘贴文本。
- 粘贴 URL（仅保存链接，可附正文）。
- 粘贴 Markdown。
- 粘贴代码。
- 手动新建笔记。

提交后创建 Source 或 Note。

### 6.3 Source 详情页

展示：

- 原始输入。
- 解析状态。
- Source Snapshot。
- Source Segments。
- 转成 Note Draft 的入口。
- 相关 AI 结果。

### 6.4 Note 编辑页

展示：

- 标题。
- 块编辑器。
- 来源引用。
- 自动保存状态。
- 生成学习卡按钮。
- 当前学习卡状态。

### 6.5 学习卡页

展示：

- 摘要。
- 关键概念。
- 关键代码解释。
- 易错点。
- Evidence 回溯。
- 一个验证问题。

学习卡必须能回到原笔记或来源片段。

### 6.6 验证反馈页或区域

展示：

- 用户回答。
- AI 判断。
- 覆盖点。
- 缺失点。
- 误解点。
- 引用证据。
- 下一次复习建议。

### 6.7 复习入口

展示：

- 到期复习。
- 复习原因。
- 复习类型。
- 打开原学习卡。
- 完成或忽略。

## 7. 核心流程

### 7.1 手动笔记流程

```text
1. 用户新建 Note
2. 用户写标题、正文、代码块
3. 系统自动保存 note_blocks
4. 用户点击生成学习卡
5. 系统创建 note_version 和 note_version_blocks
6. 系统创建 learning_unit
7. 系统创建 generate_learning_card job
8. AI 生成 learning_card AIArtifact
9. 系统写入 evidence_refs
10. 系统生成 validation_question
11. 用户回答
12. AI 判断理解状态
13. 系统写入 understanding_event
14. 系统创建 review_schedule
```

### 7.2 外部资料流程

```text
1. 用户粘贴文本、Markdown 或代码
2. 系统创建 source
3. 系统创建 source_snapshot 和 source_segments
4. 系统生成 note draft
5. 用户编辑 note draft
6. 后续进入手动笔记流程
```

URL 在 V0.1 的处理规则：

- 用户可以保存 URL 作为 Source 的 `original_url`。
- 如果用户同时粘贴正文，则按文本 Source 解析并保留 URL 引用。
- 如果只有 URL 没有正文，则只保存来源记录，不触发学习卡生成。
- 未来加入自动抓取后，抓取失败不应阻塞笔记流程；用户始终可以改为手动粘贴正文。

### 7.3 重新生成流程

```text
1. 用户编辑旧 Note
2. 旧 note_version 不变
3. 旧 AIArtifact 仍可查看
4. 用户点击重新生成
5. 系统创建新 note_version
6. 旧 learning_unit 标记 stale
7. 旧 pending review_schedule 标记 superseded
8. 新学习卡重新生成
```

### 7.4 复习流程

```text
1. Review 到期
2. 工作台显示一条轻复习
3. 用户打开
4. 系统展示学习卡、关键 Evidence 和复述入口
5. 用户完成或忽略
6. 系统写入 review_attempt 和 understanding_event
```

## 8. AI 任务

V0 至少需要以下 job：

### 8.1 parse_source

输入：

- source。

输出：

- source_snapshot。
- source_segments。

V0.1 对文本、Markdown 和代码直接分段。URL 只有用户粘贴正文时才参与分段；自动正文抽取放到 V0.2 或 V1。

### 8.2 generate_note_draft

输入：

- source_snapshot。

输出：

- note。
- note_blocks。

原则：

- 草稿必须可编辑。
- AI 不应生成不可修改的剪藏结果。

### 8.3 generate_learning_card

输入：

- note_version_blocks。

输出：

- learning_card AIArtifact。
- evidence_refs。
- validation_question。

### 8.4 judge_validation

输入：

- validation_question。
- expected_points。
- Evidence。
- user_answer。

输出：

- validation_attempt result。
- validation_feedback AIArtifact。
- understanding_event。

### 8.5 schedule_review

输入：

- validation_attempt。

输出：

- review_schedule。

## 9. 数据状态规则

### 9.1 Note 状态

| 状态 | 含义 |
|---|---|
| `draft` | 正在编辑 |
| `active` | 正常可用 |
| `archived` | 已归档 |

### 9.2 Source 状态

| 状态 | 含义 |
|---|---|
| `draft` | 刚创建，尚未处理 |
| `processing` | 正在解析 |
| `ready` | 已可使用 |
| `failed` | 处理失败 |
| `archived` | 已归档 |

### 9.3 AIArtifact 状态

| 状态 | 含义 |
|---|---|
| `pending` | 等待生成 |
| `ready` | 已生成 |
| `failed` | 生成失败 |
| `stale` | 输入已更新，结果过期 |
| `dismissed` | 用户忽略 |
| `accepted` | 用户采纳 |

### 9.4 Learning Unit 状态

| 状态 | 含义 |
|---|---|
| `active` | 当前学习视图 |
| `stale` | 基于旧快照 |
| `archived` | 已归档 |

### 9.5 Review 状态

| 状态 | 含义 |
|---|---|
| `pending` | 待复习 |
| `accepted` | 用户接受 |
| `dismissed` | 用户忽略 |
| `completed` | 已完成 |
| `superseded` | 被新版本替代 |
| `cancelled` | 系统或用户取消 |

## 10. V0 验收标准

V0 不用商业指标验收。

使用以下个人 Beta 标准：

### 10.1 可用性标准

- 能在 30 秒内新建一篇可编辑笔记。
- 能保存标题、段落、列表和代码块。
- 刷新页面后内容不丢失。
- 能从工作台重新打开最近笔记。
- 后台任务状态可见，不会让用户以为卡死。

### 10.2 架构标准

- 所有业务数据带 `workspace_id`。
- 所有业务查询必须通过 workspace scope 过滤。
- 后台 job 读取 subject 前必须校验 workspace ownership。
- Note 生成学习卡前必须创建 note_version。
- AIArtifact 不直接覆盖 Note。
- 学习卡关键内容有 Evidence。
- 验证记录绑定 learning_unit 和 question。
- 复习计划来自 validation_attempt。
- 长任务通过 job queue 执行。

### 10.3 个人使用标准

连续一周使用时，系统应该能支持：

- 每天至少输入 1 份资料或笔记。
- 每天至少生成 1 张学习卡。
- 每天完成或跳过若干轻复习。
- 能回看之前的学习卡和证据。
- 能感觉到系统在沉淀理解，而不是只保存资料。

连续一周后，系统至少应该能回答：

- 这周学了哪些 Note 或 Learning Unit。
- 哪些内容只是看过。
- 哪些内容完成过验证。
- 哪些内容需要复习。
- 每个理解判断能否点回对应 Evidence。

### 10.4 AI 质量标准

- 学习卡能覆盖原笔记主要内容。
- 代码块能被单独解释。
- 至少一个关键结论能点回原文。
- 验证题和笔记内容相关。
- AI 判断能指出缺失点或误解点。
- 模型输出 quote，系统对齐生成 Evidence，不要求模型直接输出 segment id。
- 没有硬引用 Evidence 的关键结论只能作为弱提示，不进入长期理解状态。
- validation expected points 必须尽量绑定硬引用 Evidence；没有硬引用时不能升级理解状态。
- AI 判断置信度低时返回 `unknown`，不写入 `validated` 事件。
- V0.1a 前必须用 20-30 篇真实笔记做 Evidence 准确率基准测试。
- 初始阈值：硬引用 precision >= 80%，关键结论 hard evidence coverage >= 60%，validation expected points hard coverage >= 80%。
- 硬引用指标低于阈值时，不继续推进完整验证和 Review，优先优化 prompt、quote 约束和 Evidence 对齐算法。

### 10.5 工程可靠性标准

- Postgres schema 必须包含核心唯一约束和常用查询索引。
- Note Block 自动保存必须有 `revision` 或等价冲突检测。
- Evidence 必须能指向 AIArtifact 内部具体结论，而不是只指向整个学习卡。
- AI 原始输出必须先经过服务端 schema 校验，再进入 `content_json`。
- Job 必须支持幂等、重试、锁定和成本记录。
- 对象存储不能公开访问，文件下载必须经过鉴权或短期 signed URL。
- 至少存在一次数据库备份和一次可验证恢复流程。
- V0 至少支持 Markdown + JSON 导出。

### 10.6 使用指标和退出标准

V0 应记录以下最小行为指标：

- 每周新增 Source 或 Note 数。
- 学习卡生成率。
- 验证完成率。
- Evidence 回溯点击率。
- Review 完成率。
- AI 结果被接受、忽略或反馈错误的比例。

V0 退出到 V1 的建议条件：

- 连续 4 周每周至少输入 5 份资料或笔记。
- 连续 4 周每周至少生成 5 张学习卡。
- Evidence 硬引用 precision >= 80%。
- 关键结论 hard evidence coverage >= 60%。
- 没有数据丢失或错误覆盖事件。
- 完成一次完整备份恢复验证。
- 自己仍愿意持续使用理解状态列表和 Review。

## 11. V0 开发顺序

### 11.0 第零段：AI 引用验证

目标周期：3-5 天。DoD：拿到硬引用准确率数字，决定是否继续完整工程。

- 准备 20-30 篇真实学习笔记。
- 跑通硬编码 happy path。
- 让模型输出 quote，而不是直接输出 segment id。
- 执行 Evidence 对齐，区分 `aligned` / `soft` / `unaligned`。
- 人工标注硬引用准确率。
- 输出 benchmark report。
- 根据结果决定是否继续完整工程实现。

benchmark report 必须包含：

- 笔记数量。
- 生成的关键结论数、易错点数、expected points 数。
- `aligned` / `soft` / `unaligned` 数量。
- 硬引用 precision。
- 关键结论 hard evidence coverage。
- validation expected points hard coverage。
- 典型失败样例。
- 是否进入 V0.1a 工程化的结论。

### 11.1 第一段：基础云端骨架

目标周期：1 周。DoD：能登录、能创建 workspace、schema 建好、job queue 能跑通一个空任务、备份脚本可用。

- 初始化 Web App。
- 初始化 Backend API。
- 建立用户和 workspace。
- 建立 Postgres schema。
- 建立唯一约束和核心索引。
- 建立对象存储接口占位。
- 建立 job queue。
- 建立备份和恢复验证脚本。

### 11.2 第二段：Note 基础

目标周期：1-2 周。DoD：能新建笔记、编辑块、自动保存、刷新不丢内容、能创建 note_version。

- Note 创建。
- Note Block 编辑。
- 自动保存。
- Block revision 冲突检测。
- Note Version。
- 手写 Note 生成学习卡前的快照链路。

### 11.3 第三段：AIArtifact 和 Evidence

目标周期：1-2 周。DoD：能生成一张带 Evidence 的学习卡，引用能回溯到原文片段，AI 输出经过 schema 校验。

- Learning Unit。
- Generate Learning Card job。
- AIArtifact 存储。
- AI 输出 schema 校验。
- Evidence 写入。
- Evidence target_path 精确引用。
- 学习卡展示。

### 11.4 第四段：Validation 和 Review

目标周期：1-2 周。DoD：能回答一个验证题、AI 判断输出结构化结果、写入 understanding_event、生成 review_schedule 并在工作台可见。

- Validation Question。
- 用户回答。
- Judge Validation job。
- Understanding Event。
- Review Schedule。
- 工作台复习入口。

### 11.5 第五段：Source 输入池

目标周期：1 周。DoD：能从文本/Markdown/代码创建 Source、生成 snapshot 和 segments、转成 Note Draft 继续编辑。

- Source 创建。
- 文本 / Markdown / 代码输入。
- Source Snapshot。
- Source Segment。
- Source 转 Note Draft。
- URL 保存和手动正文粘贴。

### 11.6 第六段：打磨个人使用

目标周期：1-2 周。DoD：工作台能展示最近内容、Postgres 基础搜索可用、导出可用、Markdown 种子导入可用。

- 最近笔记。
- 最近 Source。
- 最近学习卡。
- 任务状态。
- 错误重试。
- 基础搜索。
- `search_documents` 搜索投影。
- URL 正文自动抽取（可延后到 V1）。
- AI 结果反馈。
- Markdown + JSON 导出。
- 已有 Markdown 笔记批量导入（种子学习，跳过冷启动空洞）。

V0 搜索和导入边界：

- V0 只做 Postgres full-text search + `search_documents`。
- V0 只支持 Markdown 种子导入。
- Readwise / Anki / 更完整全文搜索放到 V1。

## 12. 后续阶段

### 12.1 V1 Private Alpha

加入：

- 少量邀请用户。
- 更完整 URL 抓取。
- 更完整全文搜索。
- Concept 候选抽取和合并。
- 复习队列增强。
- 从现有工具导入 Markdown / Readwise / Anki 数据。
- AI 成本统计。
- 数据导出。

### 12.2 V2 Public Beta

加入：

- 公开注册。
- 配额和计费。
- 浏览器插件。
- PDF 导入。
- 图片 OCR。
- 今日理解更新。
- 更完整理解图谱。

### 12.3 V3 Multi-client

加入：

- 桌面端。
- iOS / iPadOS。
- 系统级快捷抓取。
- 移动分享。
- 离线缓存。

## 13. V0 一句话

> V0 Personal Beta 是一个云端优先的个人学习内核：它让用户把资料和笔记转成可追溯的学习卡，通过一次理解验证写入理解事件，并生成下一步轻量复习。
