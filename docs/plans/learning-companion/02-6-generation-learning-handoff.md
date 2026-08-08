# 决策记录 02-6：Generation → Learning handoff adapter（§0.3）

> 状态：**Frozen（已冻结）**
> 执行：阶段 02（W1）任务 02-6
> 日期：2026-08-08
> 来源：`02-w1-data-rls-privacy-events.md` 任务 02-6（原方案 §0.3）
> 约束级别：Generation → Learning Handoff Gate 通过（作为 W3/W5 前置）。

---

## 1. 交付物

真实 published row → `PublishedLearningAssetContractV1` 转换器（`handoff-adapter.ts`）；
契约类型/zod schema 与 contract hash（`packages/shared/src/published-learning-asset-contract.ts`）；
required 缺失 fail closed；`cardRevision` 来自 active Card Set 权威字段；集成 Gate 测试。

## 2. 消费边界（只读 required canonical 字段）

- Learning 侧只读已确定性 Publish 的 canonical Card/Key Point/Evidence 的 required 字段：
  Card（`cardId`/`cardRevision`）、Key Point（`keyPointId`）、claim、exact evidence（`exactEvidenceRefs`）、
  semantic support（`semanticSupportReportId`/`semanticSupportReportHash`）、source fingerprint
  （`sourceFingerprint`）、生命周期（`lifecycle: active|superseded`）。
- `cognitiveType` 与 `interactionAffordances` 只是 optional hint（00-3 §6.2）；缺失时由调用方决定是否
  通过已验证安全 Scene fallback 注入，adapter 不猜测 UI/能力。
- **forbidden 清单**（00-3 §6.3）：`candidateLedger`（Candidate Ledger）、`relationHints`（relation
  hints）、`privateDraft`（private draft）、`publishStatus`（未 Publish 产物状态）一律拒绝；zod schema
  使用 `.strict()` 拒绝任何未知键，另提供 `validateForbiddenFields` 显式负向校验。
- adapter 是纯转换器，**不写任何学习事实**（learning_episodes、复习、理解事件、问题标记均不在本模块写入）。

## 3. 权威字段确认（Generation 侧实际字段名）

| 契约字段 | Generation 侧权威来源 |
| --- | --- |
| `cardId` | `learning_cards.id` |
| `cardRevision` | **`card_generation_runs.generation_epoch`**（note 级递增整数、同 note 唯一；链路 `learning_cards.card_set_id → learning_card_sets.generation_run_id → card_generation_runs.generation_epoch`）。Generation 侧无显式 `card_revision` 列；adapter 不查库，由调用方解析该 epoch 传入 `cardSet.generationEpoch`；缺省/null → required 缺失 fail closed。 |
| `keyPointId` / `claim` | `card_key_points.id` / `card_key_points.claim` |
| `exactEvidenceRefs` | `evidences.id`（非空数组，按 id 排序保证幂等） |
| `semanticSupportReportId/Hash` | Generation 侧无专门落库字段，由调用方传入 `SemanticSupportReportRef`（未来 semantic support 管线产物或已验证安全 Scene 的 report ref）；缺失 fail closed |
| `sourceFingerprint` | Generation 侧 `learning_cards` 无该列；用 deterministic hash of card+keyPoint+evidence content 计算（trim + 空白折叠规范化、证据按 id 排序、SHA-256） |
| `lifecycle` | `learning_card_sets.status`：`active → active`；`superseded/archived → superseded`；`draft/partial_ready → 未 Publish 产物，fail closed` |

## 4. 集成 Gate 定义（Generation → Learning，00-3 §6.5）

`runHandoffIntegrationGate` 一次性执行三项检查，任一失败抛 `HandoffAdapterError`（fail closed），
全部通过返回断言结果：

1. **contract hash**：`hashPublishedLearningAsset` 对契约做稳定化（键排序递归、数组保序、undefined 属性
   跳过）JSON 序列化后取 SHA-256；同一契约 hash 恒等，内容变化必然改变 hash。
2. **替换/stale**：active Card Set 被替换（`cardId`/`cardRevision` 变化）或 `sourceFingerprint` 改变 →
   未提交 Episode stale（`isEpisodeTargetStale`）；历史结果保留原版本引用。
3. **forbidden-field 负向**：`validateForbiddenFields` 对 probe 命中并拒绝 forbidden 字段。

以上三项作为 W3/W5 的 Generation → Learning Handoff Gate 前置。

## 5. stale 规则（00-3 §6.4）

- active Card Set 被替换或 source fingerprint 改变时，所有**未提交 Episode** stale。
- 历史结果（已提交/已锁定）保留原版本引用，不被改写。

## 6. 验收标准

1. `npm run typecheck --prefix packages/shared` 通过。
2. `npm run typecheck --prefix apps/api` 通过。
3. `handoff-adapter.test.ts`（node:test + assert）通过：required 缺失 fail closed、forbidden 负向、
   contract hash 稳定、stale 判定、集成 Gate 全部用例。
