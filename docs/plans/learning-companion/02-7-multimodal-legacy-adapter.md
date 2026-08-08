# 决策记录 02-7：existing-domain-multimodal-adapter-v1（§12.2）

> 状态：**Frozen（已冻结）**
> 执行：阶段 02（W1）任务 02-7
> 日期：2026-08-08
> 来源：`02-w1-data-rls-privacy-events.md` 任务 02-7（原方案 §12.2）
> 约束级别：multimodal legacy adapter Gate 通过；旧 question-first/new Episode schedule 唯一消费约束与读写兼容。

**交付物**：非文本 artifact ref/摘要、历史 reader、input uniqueness 和 redaction cascade。

---

## 1. 目标与边界

旧域（validation/review 域）的 reader 只能消费 `userAnswer` 文本，不理解多模态
Artifact（voice / text_or_mixed / drag_graph / ordering / repair / scenario）。
adapter 让旧域 reader 能**展示可读摘要并跳转私有 artifact**，同时严格保证：

- 非文本 Artifact 在旧域只存 **opaque artifact ref/hash、render summary 和
  point assessments**，**绝不把 graph/order/repair JSON 伪装进 `userAnswer`**；
- redaction 会**级联清理旧域中的任何 answer copy**（content-free tombstone）；
- input uniqueness 使用 **artifact content hash + probe/version**；
- 旧 question-first 与新 Episode 的 **canonical compatibility matrix 冻结**，
  数据库约束保证二者不能同时消费同一 pending schedule。

**不做**：不新建第二套 canonical 真相；正式 outcome/attempt/schedule 仍落现有
`validation_events` / `review_attempts` / `understanding_events` 及其现行权威表；
本 adapter 不写掌握/schedule 直接真值。

实现位置：`apps/api/src/modules/learning-sessions/legacy-adapter.ts`（纯转换器 +
一个执行包装器，风格同任务 02-6 handoff-adapter：fail closed、sha256、最小只读
视图输入类型）。

---

## 2. toLegacyDomainSummary：非文本 artifact → 旧域可读摘要

输入是 `learning_response_artifacts` 行的最小只读视图；输出：

```ts
type LegacyDomainSummary = {
  artifactRef: string;        // opaque ref，形如 artifact:{artifactId}
  artifactHash: string;       // artifact content hash（uniqueness 键组成部分）
  renderSummary: string;      // 可读摘要，不含任何结构 JSON / 完整 answer copy
  pointAssessmentRefs: string[]; // 调用方从 learning_assessment_reports 解析
};
```

### 2.1 render summary 规则（不含 JSON）

| 模态 | 摘要内容 | 永不包含 |
| --- | --- | --- |
| `voice` | `语音回答（确认转写 N 字）` | 转写原文、ASR 明细 |
| `text_or_mixed` | `文本回答（N 字）：“{预览}…”`（预览 ≤ 80 字，超出截断） | 完整原文（仅预览） |
| `drag_graph` | `拖拽图回答（N 节点 / M 边）`（计数缺失时泛化） | 节点/边/relation type ID、action digest |
| `ordering` | `排序回答（N 项）` | item ID 与顺序 |
| `repair` | `修复回答（N 个操作）` | 删除/替换/移动/连接操作 JSON 与 target ID |
| `scenario` | `情景作答（N 步）` | 每步 option ID、branch path、理由 |

计数读取是**防御性的**（payload 为 `Record<string, unknown>`）：只取已知键名下的
数组长度/数值；结构未知时给泛化摘要，不抛错、不透出任何字段。摘要永不
`JSON.stringify(payload)`。

### 2.2 历史 reader 语义

- 旧域行落 `artifactRef`（opaque），历史 API/UI 通过 adapter 渲染 `renderSummary`
  并**跳转私有 artifact**（`parseOpaqueArtifactRef` 解析出 artifactId 后按私有
  artifact 读取权限访问）；
- 旧域行**不落** payload / transcript / graph / order / repair JSON。

---

## 3. input uniqueness：artifact content hash + probe/version

```text
uniquenessKey = sha256("content:{contentHash}|probe:{probeRef}|version:{version}")
```

- 键**只由** artifact content hash + probe ref + artifact revision 决定，与任何
  模态 JSON、probe payload、Scene/rubric/policy 版本无关；
- `fromLegacyAnswer(legacyRow)` 从旧域行重建该键；required（content hash /
  probe ref / version）缺失时 **fail closed 抛错**（redaction 后 tombstone 行或
  未落 ref 的老行无法可靠重建唯一键，拒绝用不可靠信息去重）；
- 与旧域 `validation_events.input_unique_idx`（question+userAnswer 文本组合）的
  关系：多模态 artifact 的 uniqueness 不再依赖文本 answer copy，而是哈希级
  去重——同一 content hash + probe/version 幂等，不同内容必然不同键。

---

## 4. redaction 级联（content-free tombstone）

范围（"级联清理旧域中的任何 answer copy"）：

| 表 | 列 | tombstone |
| --- | --- | --- |
| `validation_events` | `user_answer`（NOT NULL） | 固定标记 `[redacted]` |
| `validation_events` | `feedback`（jsonb） | `NULL` |
| `review_attempts` | `answer_text`（nullable） | `NULL` |
| `review_attempts` | `answer_type`（nullable） | `NULL` |

- 关联键：**opaque artifact ref**（`artifact:{id}`）出现在 answer copy 列中
  （LIKE `%{artifactRef}%`）；ref 只含字母/数字/冒号/连字符，无 LIKE 通配符，
  drizzle 参数化后无注入面；
- 语义：**不可逆、content-free**（不携带任何用户答案内容），与 companion 域
  tombstone（01-3 §2.2、02-4）一致——UPDATE 清空内容字段、保留行与审计信息；
- `buildRedactionCascadeSql(artifactId)` 是纯函数，输出可审计的级联计划；
  `applyRedactionCascade(tx, artifactId)` 在调用方 workspace 事务内执行（RLS
  上下文由调用方 `withWorkspaceTransaction` 保证）；
- redaction 后，`fromLegacyAnswer` 对 tombstone 行 fail closed（§3），
  旧域 reader 仅见摘要与跳转链接，不可恢复为 locked。

---

## 5. canonical compatibility matrix（冻结）

同一 pending schedule 的两条写路径：
- **旧 question-first**：legacy reveal → submit（validation session 消费 schedule，
  生成 successor）；
- **新 Episode**：enter-practice/reveal → confirm-and-lock（`consume_pending`，
  生成 successor）。

### 5.1 每组合的读写/消费规则

| pending 状态 | 旧 question-first 预检 | 新 Episode 预检 |
| --- | --- | --- |
| `pending`，无人消费 | **allowed**（`consume_pending` 授权内） | **allowed** |
| 已被旧 question-first 消费 | allowed（同路径幂等重放） | **blocked**（`already_consumed`） |
| 已被新 Episode 消费 | **blocked**（`already_consumed`） | allowed（同路径幂等重放） |
| 非 `pending`（completed/cancelled/deleted） | **blocked**（`schedule_not_pending`） | **blocked** |
| generation 不匹配（supersede 换代） | **blocked**（`generation_mismatch`） | **blocked** |
| 消费状态未知 | **blocked**（`unknown_state`，fail closed） | **blocked** |

读规则：两者都只读权威 `review_schedules`（pending 判定 + `pending_unique_idx`
保证每 `(workspace,user,key_point)` 至多一条 pending）。

### 5.2 唯一消费的保证分层

1. **应用层预检**（本 adapter）：`canonicalCompatibilityCheck(inputScheduleId,
   generation, requester, pendingState)` 在任何写入前按上表返回 allowed/blocked；
2. **数据库约束**（最终兜底）：`review_schedules_pending_unique_idx` 保证同一
   `(workspace,user,key_point)` 至多一条 pending；写路径消费 pending 时在同一
   事务内把原 schedule 移出 pending（换代/终态）并创建 successor，使另一条写路径
   的预检在下一读看到非 pending 或已被消费 → blocked。

二者不能同时消费同一 pending schedule：即使预检竞态，数据库约束拒绝第二写。

### 5.3 校验参数

- `inputScheduleId` 非空；`generation` 非负整数；请求 schedule 与 pending 快照
  id 不匹配时 fail closed（`SCHEDULE_MISMATCH`）。

---

## 6. 验收对照

- [x] 非文本 Artifact 旧域只存 opaque ref/hash + render summary + point
  assessments，不把 graph/order/repair JSON 伪装进 `userAnswer`（§2 测试：
  摘要不泄 payload JSON / 节点 / 边 / 操作 / item ID）；
- [x] 历史 API/UI 通过 adapter 展示可读摘要并跳转私有 artifact（`artifactRef`
  round-trip，§2.2）；
- [x] input uniqueness = artifact content hash + probe/version，键稳定可复现
  （§3 测试：三要素任一变化 → 键变化；键不含 JSON）；
- [x] redaction 级联清理旧域 answer copy → content-free tombstone（§4 测试：
  计划结构 + mock tx 执行）；
- [x] canonical compatibility matrix 冻结，数据库约束兜底唯一消费（§5 测试：
  矩阵全组合 + fail closed 参数校验）。

---

## 7. 后续

- 任务 02-8 `learning_unit_exposure` guard 落地后，两条写路径的 reveal/lock 锁
  同一 `contentExposureKey`，与本节预检共同构成竞态防线；
- 若 `validation_point_assessments` 扩展 artifact/probe/facet ref 后，
  `pointAssessmentRefs` 可直接由该表派生（当前由 `learning_assessment_reports`
  的 `responseBindings[].responseArtifactId` 解析）。
