# 决策记录 07-6：理解星图两个数据平面与真实回写（§10）

> **状态**：Frozen
> **执行**：阶段 07（W6）任务 07-6
> **日期**：2026-08-08
> **来源**：07-w6 任务 07-6；原方案 §10.1~10.6；00-7-scope-trimline（星图两数据平面、确定性血缘、Card/Key Point 行动入口、真实结果回写）；00-decision-and-scope（semantic relation、关系理解、持久问题为非阻塞 Should）；02-9（canonical 事件/投影/重放）；06-2（Episode COMMIT + outbox 派生 projection）；01-7（Should bundles）。
> **约束级别**（必须，验收）：
> 1. 星图正式变化全部来自可重放事件，**0 无事件点亮**；
> 2. 共享知识真值 / 个人学习事实及投影**两平面分离**；
> 3. 关系 candidate **无法经验证路径 published**。

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `apps/api/src/modules/learning-sessions/star-map-projections.ts` | 两数据平面投影纯逻辑：共享真值血缘（canonical Publish / FK）、个人投影（validation/review / 时间耐久 / 能力切面 / assistance / 问题与可隐藏航迹，重放同 hash）、只读 0 点亮规则、四透镜数据视图、节点详情、LOD 保留、行动入口、Scene 连线边界 |
| `apps/api/src/modules/learning-sessions/star-map-projections.test.ts` | 20 个单测 |
| `apps/api/src/modules/learning-sessions/relation-governance.ts` | Relationship Governance（§10.5，Should 语义实现但 flag 关闭时动作不可见） |
| `apps/api/src/modules/learning-sessions/relation-governance.test.ts` | 21 个单测 |

## 2. 两个数据平面（§10.1）

### 2.1 平面一：共享知识真值（workspace-owned）

- 节点：Source / Note / Card / Key Point / Evidence；**确定性血缘边**由现有外键
  支持：`notes.source_id`、`note_versions.note_id`、`card_key_points.card_id`、
  `evidences.key_point_id`，边 `provenance` 恒为 `foreign_key`；
- 唯一变化来源：canonical Publish 事件（节点发布 / 版本 / fingerprint /
  official priority）+ 现有 FK 血缘；
- `replaySharedPlane` 纯函数：相同 Publish 事件流（同顺序）→ 相同节点 / 边 /
  hash；乱序 → 不同 hash；不写第二套真相（投影从事件重放，权威事实仍在
  现有 Source/Note/Card/Key Point/Evidence 表）。

### 2.2 平面二：个人学习事实及投影（user-private）

- validation/review outcome、时间耐久、能力切面、assistance、问题标记、
  可隐藏航迹；唯一变化来源 = 现有 canonical 学习事实（validation.event /
  review.attempt / understanding.event 的 outbox）+ 个人专用事件（practice
  trail / assistance / question / trail visibility）重放；
- `replayPersonalPlane` 纯函数：相同事件流 → 相同耐久 / 切面 / assistance /
  问题 / 航迹 / hash；每个事件指纹 `computePersonalEventHash` 覆盖
  workspace/user/eventType/payload（不含 sequence，内容指纹；顺序由调用方
  保证，乱序 → 不同 eventTrace → 不同 hash）；
- 共享与个人两平面互不写入（`buildTwoPlaneView` 组装并标记
  `{ shared: "workspace_owned", personal: "user_private" }`）。

### 2.3 公测 Must

- relation hints **不画成共享语义边**（关系透镜强制 FK provenance 过滤，
  `sharedSemanticEdgesHidden: true`），不宣称具备"关系理解"正式状态
  （`relationUnderstandingClaimed: false`）；
- Scene 连线只是当前 Episode 的 Response Artifact，不会自动创建共享边
  （`assertSceneConnectionDoesNotPublishEdge` 恒拒绝，唯一去向是丢弃或提议为
  candidate 虚线）。

## 3. 四个产品透镜（§10.2）

| 透镜 | 内容 | 数据来源 |
| --- | --- | --- |
| 当前目标 | Key Point + 建议路线（prioritySource / nextReviewAt / routeEligible）+ 同 Card sibling | 当前目标选择 + official schedule + SilentProofProfile eligibility |
| 证据 | 来源 / exact evidence（exactQuoteHash）/ semantic support（报告 id+hash）/ 版本 | 权威 evidence + semantic support 报告 |
| 关系 | 公测只展示**确定性血缘**（FK provenance）；candidate 仅在 Should flag 开启时以虚线可见，不进入 formal target | shared.edges（FK-only）+ relation-governance candidate |
| 问题 | Should：用户主动保存的探索标记（user-private） | question.saved 事件重放 |

到期详情、能力切面、最近验证与 assistance cooldown **放节点详情**（`buildNodeDetail`），不各自成为全图透镜。

## 4. 星图行动（§10.3）

- 选中 Card / Key Point 后可：开始/继续一小段航程、朗读、查看证据、召唤
  当前目标 Tutor（仅 Key Point）、返回来源 Note/Card（`planNodeActions`）；
- 问题标记与关系提议仅在 Should flag 开启时可见（`questionLensEnabled` /
  `relationGovernanceEnabled`）；
- Scene 连线不会自动创建共享边（见 2.3）。

## 5. 星图变化规则（§10.4）

- **只读 0 点亮**：浏览/打开/停留/收藏/朗读/看过答案恒为 0 投影变化
  （`evaluateReadOnlyInteraction` 恒 `changesProjection=false`）；
  `assertZeroEventLightUp` 校验：任何 durable 节点必须能追溯 canonical
  validation.event / review.attempt（含 outcome）事件，无事件 → 无点亮；
- **时间耐久**：只有 canonical validation/review outcome 改变（
  `reduceDurability` 只消费这两类事件）；seen / practice / assistance 不改；
- **能力切面**：只消费 canonical validation.event 的 facetSummaries 安全摘要；
  每条观测绑定 rubricItemId + assessment 事件 hash → facet 变化可追到合格
  assessment（`reduceFacets` / `lastAssessmentEventHash`）；
- **practice 航迹**：默认只本轮 recap / 短期历史；`trail.visibility` 可隐藏
  （user-private）；长期投影 = canonical facts + outbox 重放（同 hash）；
- **不展示伪精确**：不展示"掌握度 87%"，不把活动量包装成知识成长。

## 6. Canvas 改造原则（§10.6）

- 扩展现有缩放 / 平移 / 聚类 / 选中 / LOD / 稳定布局，不重写图渲染；
  伴星动作与路线经受控 overlay / scene layer；
- **低缩放 LOD**：`selectLodNodes` 按当前目标 > official priority > canonical
  gap > 重要性计分保留，确定性（相同输入 → 相同选择），**不随机取样**；
- 星图不是唯一入口（Card/Review/Now 均共享同一 Session/Episode 内核，
  见 07-5）；移动端退化为星域列表 + 路线卡（不在本模块范围，前端约定）。

## 7. Relationship Governance（§10.5，Should）

状态机与动作（全部纯函数；flag 关闭时动作不可见不可执行，fail closed）：

```text
propose（candidate 虚线，formalTargetEligible=false）
  → 独立 relation support check（direct/partial/contradicting；
     引用完整 ≠ 语义支撑通过；存在 contradicting → unsupported）
  → support_passed
  → authorized human confirm | reject
      · 个人 workspace：仅 owner
      · 协作 workspace：owner / editor / specialized_relation_governor
  → versioned publish + fingerprint + audit（版本单调递增）
  → 上游变化 stale → stale_under_review（撤回支持）
  → 重新 support check + 重新 authorized confirm → 更高版本 republish
```

- **所有来源只能提议 candidate**：Generation Claim Critic、Tutor、Session
  Supervisor、用户 Scene 连线（`RelationCandidateSource`）；
- **candidate 不能直接 published**：`publishRelation` 要求 support
  `supported` + authorized `confirm`，任一缺失抛错；
- **fingerprint**：覆盖 candidate 内容 + support check hash + authorization
  hash + version（防篡改）；**audit**：确定性 auditId 的 `buildAuditRecord`；
- **stale**：published 后任一上游引用 fingerprint 变化 → 撤回重审
  （`checkRelationStaleness` → `stale_under_review`；重审未通过 → 保持撤回，
  不发布新版本）；
- Should flag：`semanticRelationGovernance=false` 时 propose / confirm /
  reject / publish 一律拒绝；星图关系透镜不显示 candidate
  （`buildFourLensViews` 在 flag 关闭时 `dashedCandidates=[]`）。

## 8. 验收映射

- [x] 星图正式变化全部来自可重放事件，0 无事件点亮：
  `evaluateReadOnlyInteraction` + `assertZeroEventLightUp`（单测覆盖）；
- [x] 共享/个人两平面分离：`replaySharedPlane` / `replayPersonalPlane`
  独立 hash，`buildTwoPlaneView` 标记两平面（单测覆盖）；
- [x] 关系 candidate 无法经验证路径 published：
  `publishRelation` 强校验 + `assertCandidateNotInFormalTarget` +
  `assertSceneConnectionDoesNotPublishEdge`（单测覆盖）；
- [x] `npm run typecheck --prefix apps/api` 通过；
- [x] `npm test --prefix apps/api` 通过（含新增 41 个单测）。

## 9. 收口与后续

- 投影纯函数层不持有 DB 状态；真实 reader/outbox 适配（pg 实现、当前目标/
  pending schedule / evidence / semantic support 数据源）由后续接线任务补齐，
  本模块仅定义输入形状与重放语义；
- relationship governance 的真实持久化（candidate 表、published relation 表、
  audit 表、flag 开关）属后续 Should 接线，本模块冻结纯函数语义；
- 注意：tsx@node20 下测试文件同时 `import type`（本地 .ts）与直接 import
  `@ailearn/shared` 会导致 loader 挂起；测试文件一律避免该组合（用结构兼容
  字面量类型）。
