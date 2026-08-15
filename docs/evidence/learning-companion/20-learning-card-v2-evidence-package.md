# 方案 20 — Card Generation V2 各阶段证据包（§26.2）

> 归属：`docs/evidence/learning-companion/`（方案 20 §26.2 证据包）
> 状态：R1–R33 各阶段证据齐备（2026-08-15）；C8 停写机制已落地（guard + drill 通过），生产观察窗口归零后执行正式停写
> 关联：`docs/evidence/learning-companion/20-learning-card-v2-implementation-review.md`（缺陷审查与修复进度）、
> `20-learning-card-v2-corpus-labeling.md`（§23.1 语料标注证据）

## 1. 各阶段 contract/schema/migration 文档

| 阶段 | 产物 | 位置 |
|---|---|---|
| R1 工程硬伤 | journal 补登记 0136/0137；`learning-runs.ts` CASCADE→RESTRICT；shared 3 子路径导出 | `apps/api/src/db/migrations/meta/_journal.json`、`apps/api/src/db/schema/learning-runs.ts` |
| R2 合同补齐 | GroundingCriticReportV2、Equivalence Report/Binding、LearningTargetSnapshotV2、LearningRunTargetPublicV2、LegacyAttachment、ExposureV2/Objective/Reminder/DTO；§14.3 六 hash 域 + §15.2 reveal 域 + snapshotHash + semanticSupportReportSetHash | `packages/shared/src/card-generation-v2-contracts.ts`、`learning-target-v2-contracts.ts`、`learning-card-v2-contracts.ts`、`card-generation-v2-hashing.ts` |
| R3 DB | 迁移 0138：15 张新表 + 16 RLS worker 豁免 + receipt 幂等补 user + eligibility unique/FK + snapshot run_id FK RESTRICT + §16.1 列 + §21.3 列；drizzle schema 同步 | `apps/api/src/db/migrations/0138_card_generation_v2_review_fixes.sql`、`apps/api/src/db/schema/card-generation-v2.ts` |
| R4 worker | 四阶段 LLM provider（planner/author/grounding/pedagogy 独立调用，`CARD_GENERATION_V2_LLM=true` 切换）+ binding plan assembler + §13 deterministic gates + bounded repair + worker 合同 | `workers/ai-worker/src/handlers/card-generation-v2-handler.ts`、`lib/ai-provider.ts` |
| R5 API | Card/Reminder 端点、Idempotency-Key 强制、regenerate/replan、激活锁序/绑定映射/lineage exposure/outbox、SSE 白名单、feature flag 门禁 | `apps/api/src/modules/card-generation-v2/routes.ts`、`card-service.ts`、`activation-service.ts`、`generation-run-service.ts`、`helpers.ts` |
| R6 C5 重基 | freezeTargetSnapshotV2 全 §16.1 重写、V2 分支消费 snapshot、epoch 复验、V2 origin 路由、legacy sidecar、迁移 0139 | `apps/api/src/modules/learning-runs/`（freeze/planner/structured/critic/commit 的 V2 分支）、`0139_learning_run_v2_target_contract.sql` |
| R7 Web | createV2Client 真实接入、CandidateReviewPage/adapters/activation-builder、generateCardV2 接线、移除 legacy density | `apps/web/lib/api-client.ts`、`features/`（CandidateReview 等） |
| R8 权限 | 迁移 0142 GRANT 重放、`roles.sql` V2 worker 镜像 + matrix 31 行、SSE payload 白名单、C03 待办识别补强、postgres 集成 1 条 + E2E 4 条、`SHA("pending")` 占位修正 | `0142_card_generation_v2_grant_repair.sql`、`infra/postgres/roles.sql`、`workers/ai-worker/src/integration-tests/` |
| R9 语料 | corpus 374 条（9 批次）+ `corpus-validation.test.ts` 16 项质量校验 + 聚合导出 | `packages/ai-quality/src/card-generation-v2/corpus/` |
| R10 E2E 扩展 | planner 篇内去重（C04 修复）；E2E 4→13 条（C01/C02/C03/C04/C05/C07/C12/C13/C17/C22/C23/C25/C32/C33 中 13 条 + C0 纵切）；worker 连接池关闭 | `workers/ai-worker/src/integration-tests/card-generation-v2-e2e-subset.integration.ts`、`planner-service.ts` |
| R11 探针 + 证据包 | `recordLegacyWriterHit` 接线 V1 run 创建（C8 Gate 可观测）；§26.2 证据包文档 | `apps/api/src/modules/card-generation/service.ts`、`legacy-consumer-audit.ts` |
| R12 worker regenerate/replan | 抽出 `loadV2RunInputs`/`critiqueAndFinalizeCandidates`（门禁循环复用）；实现 regenerate（旧 revision supersede + boundedRepair 重写 + 重跑门禁）与 replan（新 immutable plan revision + 旧候选 supersede + 全量重生成）；`card_v2_post_activation` 投递确认（投影消费者为已知缺口）；E2E 13→15 条（C20/C20b） | `workers/ai-worker/src/handlers/card-generation-v2-handler.ts` |
| R13 E2E 补齐 | C06/C08/C09/C14/C21/C36（确定性模式可用 C 用例）；E2E 15→21 条 | `card-generation-v2-e2e-subset.integration.ts` |
| R14 review 重跑门禁 | edit/merge 入队 `card_generation_recheck_candidate` + worker `processRecheckCandidateJob`（完整重跑门禁）；修复 merge 产物结构性缺陷（mergedDraft 叠加而非全量）；E2E 21→23 条（C15/C16） | `candidate-review-service.ts`、`card-generation-v2-handler.ts` |
| R15 §24 加固 | worker zod 严格校验 input_snapshot/semantic_spec（非重试失败）；E2E 23→26 条（C10/C24/C30） | `card-generation-v2-handler.ts` |
| R16 类型边界 | TS6059 46→0（rootDir 提至仓库根）；worker db 直引 apps/api 权威 schema；drizzle-orm symlink 统一实例；V2 文件 tsc 0 错误 | `workers/ai-worker/tsconfig.json`、`src/db.ts` |
| R17 E2E 27 条 | C18（reveal exposure-first + 幂等重放 + stale 409）+ C44 前置（Reminder 非 Schedule） | `card-generation-v2-e2e-subset.integration.ts` |
| R19 §23.3 Judge | 确定性 semantic judge（scorer 信号 → 判定）+ 11 条单测 + 374 链式冒烟 | `packages/ai-quality/src/card-generation-v2/semantic-judge.ts` |
| R20 LLM 回退守卫 | LLM 模式解析到 mock → fail-fast 非重试（§10.5 无 fallback）；E2E 28 条 | `workers/ai-worker/src/card-generation-v2/providers.ts` |
| R21 C5 PREPARE 链路 | 修复 createRunV2 FK 顺序（骨架行先于 freeze）；C5 E2E（snapshot 冻结/公共投影零泄漏/幂等/0 Schedule）；E2E 29 条 | `apps/api/src/modules/learning-runs/run-service.ts` |
| R22 Commit 依赖审计 + IT 回归 | V2 事实目标恒为 text 变体 → Commit 验收归 LLM 模式；api IT 4/4+7/7 绿；worker 两预存 IT 门控确认 | — |
| R23 C19-lite | reveal 后 PREPARE → practice_only（Trust 降级，§16.2）；C5 测试双场景 | `card-generation-v2-e2e-subset.integration.ts` |
| R24 §23.5 分桶 | rc-gate micro/long/zero/safety/modality/language 全分桶（强制 ≥95% + language 报告制） | `packages/ai-quality/src/card-generation-v2/rc-gate.ts` |
| R25 queue IT 修复 | 陈旧 RLS 前置断言修正 + finally 不再关闭 RLS（安全回归）；RLS 下 claim/reap 验证通过 | `workers/ai-worker/src/integration-tests/queue-postgres.integration.ts` |
| R26 LLM 模式里程碑 | 真实四阶段端到端（bigmodel/glm-4.6）；修复 rubricHash 伪造/输出零校验/归一化顺序 4 缺陷；真实教学候选 + fail-closed 保持 | `workers/ai-worker/src/card-generation-v2/providers.ts` |
| R27 证据引用修复 | evidenceList 透传 + prompt 证据清单 + 保留模型引用；`no_evidence_reference` 消失；grounding 超时/保守判定待调优 | `providers.ts`/`prompts.ts`/`author-service.ts`/handler |
| R28 reportHash + 迁移积压 | grounding/pedagogy reportHash 占位解析 + 确定性重算；0154 lease 列迁移应用（0150–0158 积压 9 个）；E2E 恢复 29/29 | `providers.ts`、`0154_v2_outbox_lease_columns.sql` |
| R29 Grounding 证据打通 | evidence content 切片入 prompt（SealedEvidenceEntryV2.content + 数组字面量修复）；幻觉防护实证（超证据 learningSupport 逐字段 hard 拦截） | `evidence-seal-service.ts`/handler/`providers.ts` |
| R30 review_ready 链路 | author prompt 证据内约束 → Grounding passed 实证；final deck gate 报告数组真实填充（修复 LLM 模式永远无法 review_ready 的 bug） | `prompts.ts`/`providers.ts`/handler |
| R31 LLM 验收闭环 | 真实四阶段 → review_ready（grounding_passed + binding plan + pedagogy 通过）；9 个 LLM 模式缺陷修复完成 | tokenrhythm/deepseek-v4-flash-0731 |
| R32 自然激活链路修复 | ① assembler 持久化完整 binding 条目（不再只落 targetUnit）；② activation §13.1 复验按合同单数键读取（不再空转）；③ target-snapshot-adapter `ANY` 数组改 `{uuid,...}::uuid[]` 字面量；④ 正式 binding 行 targetUnitId 按 kind 取值（learning_support=field） | `binding-plan-assembler.ts`、`activation-service.ts`、`target-snapshot-adapter.ts` |

## 2. 自动测试与覆盖的 invariant 清单（2026-08-15 全绿）

| 套件 | 计数 | 覆盖的 invariant |
|---|---|---|
| **api 全量（__tests__ 全部）** | **1604/1604**（R35 +5：C35 eligibility 4 + 其它 1） | V2 全套 + learning-runs/companion/review/来源域 + SEC-01 跨租户隔离静态扫描（含事务模式启发式） |
| api V2（card-generation-v2-*.test.ts） | 240/240（R33 +1：planner 交/买误伤回归） | schema strict parse、scorer 消费、metamorphic 10 变体、rc-gate 阈值、激活幂等/锁序/绑定映射/lineage/outbox、Card/Reminder 端点、SSE 白名单、planner 去重（C04）、探针接线（C0/C8） |
| ai-quality（card-generation-v2 + corpus-validation） | 30/30 | §23.1 语料 16 项质量指标（总量 ≥300/micro ≥180/medium ≥60/modality ≥30/零卡 ≥20%/split 三组/hash 真实性/mustMerge 字面） |
| web（lib + features） | 1016/1016 + 组件 91/91（R35 +5 a11y） | redraw-contract、CandidateReview 行为、真实 api-client 断言（不再断言"未集成"） |
| shared 全量 | 493/493 | 合同 schema、hash 域闭包（§14.3/§15.2/§15.6/§16.1） |
| ai-quality 全量 | 115/115 | fixture schema/corpus/scorer/**deterministic judge（R19）**/metamorphic/**rc-gate §23.5 全分桶（R24）** + corpus 16 项质量校验 + 374 fixture 链式冒烟 |
| worker 单测 | 1085/1085（R35 +7：pipeline-route 6 + 其它 1） | provider 选择、agent 管线、V2 handler 辅助（schema 校验后无回归） |
| E2E C-subset（真实 postgres + worker，NOBYPASSRLS） | 30/30（含 C5 双场景 + R33 §17.5 step 17 投影消费者：幂等对账/重放不重复/坏 receipt fail-closed） | C01 卡数上限、C02 泄题门禁、C03 零卡无副作用、C04 重复不翻倍 + atom 决策、C05 合并恰一、C06 独立目标恰 2、C07 fail-closed、C08 步骤不拆卡、C09 比较单卡、C10 代码拒绝不归一化、C12 注入不越权、C13 drop 不 fallback、C14 重复候选不可激活、C15 edit 重跑门禁旧 revision 不可变、C16 merge derived + 父不可激活、C17 reject-all 0 卡、C18 reveal exposure-first/幂等/Reminder 非 Schedule、C20 重生成旧 revision 不可变、C20b replan 新 plan revision、C21 编辑期间绑定旧版本、C22 幂等重放、C23 激活幂等/恰一映射、C24 schema 非重试失败 + CAS 拒绝、C25 0 Schedule、C30 archive 生命周期/历史可读、C32 跨租户零泄漏、C33 SSE 白名单、C36 感想零副作用 |
| E2E C 项补集（C27/C28/C38/C37-lite） | 3/3（R33） | C27 presentation-only edit（旧 Run frozen 可读、objective identity 不重置、0 Schedule）、C28 semantic_replace（新 Objective ID、旧对象 supersede、§15.3 lineage supersede 行、0 Schedule）、C38 target-equivalent after PREPARE（旧 Run 读 rev1、新 Run rev2、lineage edit、读视图一致性）、C37-lite 公共投影一致 |
| E2E C34/C35/C43 迁移 IT | 3/3（R35） | C34：key point UUID=stable objective ID、不伪造 canonical answer（rubric-evidence 结构强制）、cutover 事件审计+幂等；C35：legacy_unreviewed→practice_only（detect + eligibility 分支 + freeze 接入）；C43：upgrade 保留 ID/generation/dueAt / blocked 标记 / invalid cancelled+reason、幂等 |
| E2E redaction + quota IT | 2/2（R34） | §15.7/C31：tombstone 幂等 + eligibility 前移（revoked/epoch+1）+ 激活 409 evidence_revoked + PREPARE evidence_not_usable fail-closed + 跨租户 404；§22.6：在途并发 429 / 24h 上限 429 / 幂等重放豁免 |
| E2E C8 停写 drill（api IT） | 1/1（R33） | readiness canShutdown → execute（epoch bump + cutover 事件）→ V1 guard 409 v1_writer_disabled / 显式开启放行 → legacy hit 后 blocked |
| E2E LLM 自然态全用户旅程（真实四阶段 provider，零 force* 代设） | 1/1（R32） | 自然 review_ready（qs=passed/undecided/unpublished + assembler 落库 binding plan）→ **§13.1 复验实证**（撤销证据 → 409 evidence_revoked 0 副作用；恢复 → 成功）→ 真实 keep（reviewDraftRevision CAS）→ 真实激活（幂等重放同 receipt、重激活 409、恰一 canonical mapping、卡/目标/revision active、**§14.3 evidenceBindings 保留真实证据身份**、正式 binding 行、IVR ready、C25 0 Schedule、post-activation outbox 恰一、事件）→ C5 PREPARE（subject=objectiveId 冻结、公共投影零泄漏、幂等重放同 run、0 排程） |
| postgres 纵切（C0） | 1/1 | seal→planner→author→critics→review_ready（条件）→activation 0 Schedule |
| planner 单测 | 11/11 | 确定性提取、0 卡、micro cap、client hardMax、existing-objective dedup、篇内重复 dedup |
| V1 行为回归 | 32/32 + c0 探针 18/18 | V1 run 创建不受探针影响；幂等/配额/复用路径不变 |

不变量要点（对应 §29.2/§29.3）：Author 无发布权（泄题候选 0 passed）、Grounding/Pedagogy hard issue 真阻断、repair 失败 drop 不 fallback、0 卡独立成功状态、激活不建 Schedule、幂等重放同 receipt、每 candidate revision 恰一 canonical mapping、跨租户 0 泄漏、激活时 evidence eligibility 重验。

## 3. 固定 fixture 输入与完整结构化输出

- **§23.1 语料**：374 条 fixture 全量聚合于 `V2_FIXTURE_CORPUS_SEED`（`packages/ai-quality/src/card-generation-v2/corpus/index.ts`）；逐条含 source/generationSpec/gold 标注（卡数范围、objective、mustMerge/mustNotMerge/mustNotCard、transformations、forbiddenFrontLeaks、zeroCardReasonCodes）；`exactTextHash` 为真实 SHA-256。JSON 序列化聚合可复现（374 条、61 条 >500 字、76 条零卡、split dev 157/validation 159/holdout 58）。
- **E2E 固定输入**：`card-generation-v2-e2e-subset.integration.ts` 内 OSI 153 字短笔记、待办、重复段、光合作用两事实、沸点边界、prompt injection、纯改写原文等固定文本；每次运行输出 run 状态、候选计数与质量态、atom_decisions、receipt/mappings、outbox 行数断言。
- **完整结构化输出**：候选行含 `objective_draft`（objectiveStatement/publicSummary/knowledgeForm/canonicalAnswer/rubric）+ `presentation_draft`（front.cue/prompt/strategy/transformationKind）+ `evidence_set_hash`；激活产出 receipt（mappings[].cardId/objectiveId/objectiveRevisionId/publicationRevision）+ learning_objectives_v2 + learning_cards_v2 + learning_objective_evidence_bindings_v2 行。

## 4. UI/API/DB/outbox trace

- **API**：R7 Web 真实调用 `generateCardV2`；routes 测试 42 用例覆盖端点契约（Idempotency-Key 缺失 400、activation 复数别名、SSE 白名单）。
- **DB**：E2E 以 `ailearn_worker`（NOBYPASSRLS）执行 outbox claim 与全链路写入，RLS 隔离在真实行级生效（C32 跨租户 0 行）。
- **outbox**：run 创建 → `card_generation_plan` 恰一；激活 → `card_v2_post_activation` 恰一（C23 断言）；幂等重放不重复投递（C22）。
- **SSE**：事件 payload 经 `sanitizeEventPayloadV2` 递归裁剪，canonicalAnswer/learningSupport/scoringRubric/evidenceBindings 零透传（C33）。
- **UI trace**：web 1014 测试中的行为断言覆盖候选审核/激活构建器交互路径（R7）。

## 5. 质量/性能/成本比较（确定性基线）

| 维度 | 确定性模式（当前 E2E 基线） | LLM 模式（待 provider 就绪） |
|---|---|---|
| 单 run 端到端（seal→终态） | ~30–70ms/run（13 条 E2E 实测中位） | 未测（依赖 provider 可用性） |
| 候选质量 | 占位复制 → 门禁全 fail（fail-closed，0 泄漏发布） | 待真实盲评（§23.4/§23.5 rc-gate 阈值） |
| 成本 | 0（无外部调用） | 待测（四阶段独立调用） |
| 覆盖 | 合同/DB/RLS/幂等/门禁语义 | 内容质量（grounding/pedagogy 真实判定） |

> 结论：确定性模式验证了全部工程合同与 fail-closed 语义；内容质量维度须在
> `CARD_GENERATION_V2_LLM=true` + 真实 provider 下用 374 条语料跑 rc-gate 后补齐
> （当前为已知未放行能力，见 §6）。

## 6. 已知问题与未放行能力

> R34/R35 已关闭：§22.6 配额、§15.7 redaction、§24.7 runbook（成文）、
> §23.7 性能 Gate（确定性侧实测）、C0 registry（review rebase + status 化）、
> §10.2 轻链路路由、C34/C35/C43 迁移服务、C40 a11y 测试、C8 停写脚本、
> §23.1 扩展盲标（160 条）。剩余问题均为外部依赖/流程/环境类。
>
> R36 已关闭（再次全量扫描 §1–§32 → 修复）：§13.2 deck 语义聚类（semanticClusters
> 真实聚类）、§13.3 eligibility 行锁 + vector 闭包、§16.2 snapshotHash 入 run
> contract hash、§17.7 领域事件通道（0166 + 全部 lifecycle 事件生产者 +
> IVR durable timer）、§18.2 learning_card_revisions_v2（0167，四个 bump 点）、
> §5.4 equivalence report 持久化 + 服务端重算闭包、§14.2 非文本模态显式提示、
> §22.2 prompt data delimiters、§20 反馈落库、§23.9 provider snapshot RC、
> §28.2 故障注入矩阵成文（`20-learning-card-v2-fault-injection-matrix.md`）。
>
> **R36+ 放行（测试环境，2026-08-15）**：用户指示"先放行，测试环境不用讲究
> 那么多"。`.env` 已启用 `CARD_GENERATION_V2_ENABLED=true`、
> `CARD_GENERATION_V2_LLM=true`（真实 LLM 四阶段）、
> `NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED=true`、`AI_PLATFORMS_CONFIG`（绝对
> 路径，修复 worker CWD 相对路径解析失效）。**桌面 app 打包侧同步放行**：
> `apps/desktop/package.json` 的 `prebuild:web` 补齐全部 NEXT_PUBLIC 开关
> （含 V2，此前打包产物 V2 fail-closed）；`apps/desktop/src/web-manager.ts`
> 运行时 env 对齐；`apps/desktop/electron-builder.yml` 修复 electron-builder
> 26.x schema 漂移（publisherName 移出 WindowsConfiguration 至 publish 配置，
> 此前 `npm run pack` 直接 schema 校验失败）。放行验证：LLM 自然态全用户旅程
> 35.9s 一次成功（真实四阶段 → review_ready → §13.1 复验 → keep → 激活 →
> PREPARE）；desktop `pack:linux`/`dist:linux` 打包链路通过。V1 writer 停写
> guard 生效（V2 启用 + `CARD_GENERATION_V1_WRITER_ENABLED` 未设 → V1 409）。

1. **内容质量未放行**：确定性 Author 为占位复制实现（§10.5 明确禁止其发布），
   真实内容质量验收依赖 LLM 模式 + rc-gate + 人类双人盲评；LLM 模式已 E2E 验收（R31/R32）。
2. **人类双人独立标注 + 第三人仲裁**：R33/R35 已执行两轮独立上下文盲标共 160 条
   （§6.1/§6.2：范围一致 96.7%/100%、标注者间 98%，无系统性 gold 错误）；人类双人
   流程与 2 处实质分歧仲裁仍为 RC 前待办（自动标注不能替代）。
3. **多模态 deep check / region evidence / C11**：依赖视觉 pipeline（typed evidence /
   region）；代码/图片 block 当前 seal 拒绝 = fail-closed（C10 已验），R36 起 planner
   对非文本模态显式返回 `unsupported_for_requested_goal`（"当前无法可靠制卡"提示，
   不再静默跳过；region evidence 生产者留待视觉 pipeline）。
4. **C26/C41/C42/C44-full trusted-Commit LLM 旅程**：V2 接缝全确定性验证
   （snapshot/eligibility/practice_only/0-Schedule/幂等/redaction）；
   完整 LLM 评估旅程为平台稳定窗口内上线前验收项（调用序列见
   `20-learning-card-v2-trusted-commit-acceptance.md` §3）。
5. **§23.7 production 侧性能门槛**：activation p95 / reveal 压测 / PREPARE 成功率
   计数 / 首屏交互需上线后由 dashboard 观测（确定性侧已达标，报告
   `20-learning-card-v2-perf-gate-report.md`）。
6. **C8 生产停写执行**：机制与脚本已就绪（`scripts/card-v2-writer-shutdown.sh`，
   当前 dev 观察窗口 hit>0 → blocked 属预期）；生产侧按 §7 双窗口 hit=0 到期后
   翻转 `CARD_GENERATION_V1_WRITER_ENABLED`（需 owner 批准）。
7. **C0 registry delete 清单**：worker agent 5 个 delete 条目（V1 fast/planned/
   publish/prepare/plan-path）在 C8 shrink 阶段删除；rebase 条目已 status 化
   （review 域 done，其余 dual——V1 origin 保留读取 / V2 origin 走 snapshot）。
8. **C40 全旅程 a11y**：CandidateReview 关键旅程已测（5/5）；Today/Review/Star
   Map 页面的键盘/读屏/320px/reduced-motion 全旅程测试随 Web 迭代补测。

## 7. 回滚/停写步骤

- **迁移**：0138/0139/0142 均 additive；回滚 = 反向执行 DROP（若需）或保留表
  仅停用能力。已应用迁移**不得编辑**（hash 校验）；任何修正走新迁移。
- **能力开关**：`CARD_GENERATION_V2_ENABLED=true` 才注册 V2 路由（server.ts 门禁，
  默认 fail-closed）；Web 在 V2 不可用时回退 legacy（R7）。
- **停写 V1（C8）**：前置条件 = V2 验收通过 + `card_generation_legacy_writer_hits`
  观察窗口（建议 7d + 24h 双窗口，shutdown-rc-service 已实现计数）全部为 0；
  然后依次：Web 移除 legacy 回退分支 → 删除 V1 生成路由/worker agent 写入路径
  → 最后按 C0 registry 的 delete 清单清理 claim 消费者。
- **数据安全**：active/historical 对象 FK RESTRICT，不级联删除；证据 redaction 走
  eligibility 前移（§17.5），不物理删除 snapshot。

## 8. owner 签字与日期

| 阶段 | owner | 日期 |
|---|---|---|
| R1–R8 | 实现方（goal-c75d4f64 会话） | 2026-08-15 |
| R9 语料规模化 | 实现方（双遍复核 + 校验套件裁决） | 2026-08-15 |
| R10 E2E 扩展 + C0/C8 探针接线 | 实现方 | 2026-08-15 |
| R11 探针接线 + 证据包 | 实现方 | 2026-08-15 |
| R12 worker regenerate/replan + E2E 15 条 | 实现方 | 2026-08-15 |
| R13 E2E 21 条（C06/C08/C09/C14/C21/C36） | 实现方 | 2026-08-15 |
| R14 edit/merge 重跑门禁 + E2E 23 条（C15/C16） | 实现方 | 2026-08-15 |
| R15 §24 加固 + E2E 26 条（C10/C24/C30） | 实现方 | 2026-08-15 |
| R16 worker 类型边界根治 | 实现方 | 2026-08-15 |
| R17 E2E 27 条（C18 + C44 前置） | 实现方 | 2026-08-15 |
| R18 全量回归矩阵 + sec01 启发式修复 | 实现方 | 2026-08-15 |
| R19 确定性 Semantic Judge | 实现方 | 2026-08-15 |
| R20 LLM mock 回退守卫 + E2E 28 条 | 实现方 | 2026-08-15 |
| R21 C5 PREPARE 链路 + createRunV2 FK 修复 | 实现方 | 2026-08-15 |
| R22 集成回归 + 依赖审计 | 实现方 | 2026-08-15 |
| R23 C19-lite Trust 降级 | 实现方 | 2026-08-15 |
| R24 §23.5 rc-gate 全分桶 | 实现方 | 2026-08-15 |
| R25 queue IT RLS 安全修复 | 实现方 | 2026-08-15 |
| R26 LLM 模式真实运行 | 实现方 | 2026-08-15 |
| R27 证据引用 + 诊断 | 实现方 | 2026-08-15 |
| R28 reportHash 修复 + 迁移积压处理 | 实现方 | 2026-08-15 |
| R29 Grounding 真实证据判定 | 实现方 | 2026-08-15 |
| R30 review_ready 链路修复 | 实现方 | 2026-08-15 |
| R31 LLM 模式验收闭环 | 实现方 | 2026-08-15 |
| R32 LLM 自然态全用户旅程 E2E（review_ready→§13.1 复验→keep→激活→C5 PREPARE）+ 4 个自然链路缺陷修复（assembler 落库形状 / §13.1 复验键 / ANY 数组字面量 / targetUnitId 按 kind） | 实现方 | 2026-08-15 |
| R33 剩余项收官：投影消费者（迁移 0162 + worker 幂等对账 + fail-closed）· C8 停写（V1 guard + executeV1WriterShutdown drill）· C 项补集 E2E（C27/C28/C38/C37-lite + lineage 补写入 + IVR 幂等 + card 摘要同步 + planner 交/买误伤修复）· §23.1 独立盲标抽查 60 条 · worker tsc 全量 0 错误 | 实现方 | 2026-08-15 |
| R34 文档复查修复：§15.7/C31 evidence redaction 服务（tombstone + eligibility 前移 + fail-closed 实证）+ §22.6 V2 生成配额（在途并发 + 24h 速率 + advisory lock + 幂等豁免） | 实现方 | 2026-08-15 |
| R35 复查剩余项全部实施：runbook 成文 · 性能 Gate 实测 · C0 registry 修复（review rebase）· 轻链路显式路由 · C43 三路迁移 · C34 multi-keypoint 迁移 · C35 legacy_unreviewed practice_only · trusted Commit 验收说明 · C40 a11y 测试 · C8 停写脚本 · 扩展盲标 100 条 | 实现方 | 2026-08-15 |
| R36 再次全量扫描（3 子代理 §1–15/§16–22/§23–32）→ 修复：§13.2 语义聚类 · §13.3 eligibility 行锁+vector 闭包 · §16.2 snapshotHash 入 contract hash · §17.7 领域事件通道（0166+全生产者+IVR timer）· §18.2 不可变 card revision 表（0167）· §5.4 equivalence 闭包 · §14.2 非文本显式提示 · §22.2 prompt delimiters · §20 反馈落库 · §23.9 provider snapshot RC · §28.2 故障注入矩阵 | 实现方 | 2026-08-15 |
| 待办：LLM 模式质量验收、双人盲测、C8 停写 | 需独立标注者/QA + provider 环境 | 待定 |

## 9. 验证命令

```bash
# api V2
cd apps/api && node --import tsx --test $(find src/__tests__ -name 'card-generation-v2-*.test.ts' | sort)
# ai-quality
cd packages/ai-quality && node --import tsx --test src/card-generation-v2/card-generation-v2.test.ts src/card-generation-v2/corpus-validation.test.ts
# web / shared
cd apps/web && node --import tsx --test $(find lib features -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)
cd packages/shared && node --import tsx --test $(find src -name '*.test.ts' | sort)
# E2E（必须单文件）
cd workers/ai-worker && DATABASE_URL_WORKER="postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn" \
  DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
  node --import tsx --test --test-concurrency=1 \
  src/integration-tests/card-generation-v2-e2e-subset.integration.ts
# LLM 自然态全用户旅程 E2E（真实 provider + 网络；从仓库根；单文件）
DATABASE_URL_MIGRATOR="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
  DATABASE_URL_WORKER="postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn" \
  DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
  node --import workers/ai-worker/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 \
  workers/ai-worker/src/integration-tests/card-generation-v2-llm-natural-activation.integration.ts
# C 项补集（C27/C28/C38/C37-lite；单文件）
DATABASE_URL_MIGRATOR="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
  DATABASE_URL_WORKER="postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn" \
  DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
  node --import workers/ai-worker/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 \
  workers/ai-worker/src/integration-tests/card-generation-v2-c-cases.integration.ts
# C8 停写 drill（api IT）
DATABASE_URL_MIGRATOR="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
  DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
  node --import workers/ai-worker/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 \
  apps/api/src/integration-tests/card-generation-v2-c8-shutdown.integration.ts
```
