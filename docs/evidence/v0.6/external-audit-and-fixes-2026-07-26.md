# v0.6 与 Card Generation v2 外部实施审计报告（2026-07-26 第二轮）

> 性质：独立外部审计 + 缺陷修复记录
> 审计对象：`v0.6-implementation` 分支工作树快照（含全部未提交修改）
> 审计环境：独立 Linux x64 容器，Node 22.22 + PostgreSQL 16 + tsx，mock provider
> 边界声明：本报告是对"代码候选"状态的复核与加固，**不替代** M7 要求的
> clean-SHA、真实 Provider、compose、E2E 与观察期证据；`release/version.json`
> 保持 `0.5.0`，v0.6 仍未发布。

---

## 1. 审计范围与方法

对照文档：`AI学习系统-v0.6-版本实施计划-2026-07-22.md`（v3.5）、
`v0.6-implementation-register.md`、`docs/evidence/v0.6/m0..m6-gate.md`、
`learning-card-generation-engine-v2.md`（v2.0）、
`docs/evidence/card-generation-v2/m6-gate.md`、
`docs/runbooks/card-generation-v2-rollout-rollback.md`。

方法：
1. 三份计划/登记/证据文档全文精读，提取全部硬性不变量与完成度声称；
2. 五个专项对抗式代码审查（validation session 服务、worker 评估链路、
   card-generation v2 全链路、card repair/M5、web question-first UX），
   逐条核对计划不变量并给出 file:line 级证据；
3. 全量测试实测：六包单元测试、v0.6 PostgreSQL 集成三件套
   （fresh 迁移 0001–0049 + RLS 角色矩阵 + 会话并发）、API 侧 card-gen
   PostgreSQL 集成三件套、六包 `tsc --noEmit`；
4. 对确认缺陷实施最小修复并回归。

## 2. 完成度总评

### 2.1 v0.6（可信掌握闭环）

登记册"M0–M6 代码候选、M7 未开始"的定性**经复核成立**，且文档对
局限（E2E 未实跑、黄金集为 fixture、真实 Provider 未验证、Worker 退出 137）
的披露是诚实的。但"代码候选"的质量在本轮审计前存在实质缺口：

- 有 1 个 **P0**（生产 RLS 角色下会话服务的 post-commit 写入全部失效）；
- 有 8 类 **P1**（详见 §4），其中"重复 rubricItemId 可顶掉 contradicted
  判定"和"assisted 提交仍写 validated 事件"直接违反计划 §4.1 的
  发布阻断级安全不变量；"deterministic fallback 自我拒绝"会在默认
  flag 配置下让大量常见 claim 的验证功能不可用。
- 上一轮"2717/2717 全绿"对当时的树成立，但对本轮工作树已过期：
  `governance.ts` 加了 `sendImageContent` 而旧测试未更新（真实失败），
  且新加的 M6 RLS 集成断言写完从未运行过（断言方式必然失败）。
  **"全绿"声称的时效性管理是一个流程弱点。**

修复后（见 §5），v0.6 主链路的计划符合度显著提高；仍有一批
需要 Owner 决策或后续处理的遗留（§6）。

### 2.2 Card Generation v2

**代码事实**：M1–M6 对应的模块、迁移 0044–0049（journal 连续、fresh
迁移在本容器全量通过）、单元与 API 侧集成测试均存在且通过；G1–G7
七条核心不变量在代码审查中除已修复项外全部得到确认（快照封存、
coverage=10000 门禁、epoch CAS、partial 不激活、publish 重试零新调用、
单 active 卡组单 overview 卡等）。

**文档事实（审计前）**：三份同日文档互相矛盾——计划标
"Draft / 未授权实施"、m6-gate 声称"已实现（待复核）"、runbook 状态
"Active、已是新请求默认路径"。另有两项治理偏差：实施先于计划状态
流转；**默认开启先于计划 §21 要求的 shadow/灰度/回滚验证**（且开关
语义 fail-open，与 v0.6 M0 冻结的全部 flag fail-closed 相反）。
`docs/evidence/card-generation-v2/` 只有 m6-gate，M0 基线冻结
（"没有基线和黄金标签，不进入架构切换"）至今没有证据文件。

本轮已把计划状态栏更正为"已实施（代码候选）"并写入状态更正与治理
偏差记录；m6-gate §2 补记了本容器实际执行的定向验证。**发布 Gate
仍未关闭**：真实 Provider、对象存储/图片链路、回滚演练、观察窗全部待执行。

### 2.3 实测数字（本轮，修复后）

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| packages/shared | 365/365 | 含本轮新增回归测试 |
| packages/db | 5/5 | |
| packages/ai-quality | 84/84 | |
| apps/api | 1451/1451 | |
| workers/ai-worker | 594/594 | |
| apps/web | 326/326 | |
| **全量单元合计** | **2825/2825** | 审计前基线：2 个真实失败 + 6 个测试自身缺陷 |
| v0.6 PostgreSQL 集成 | 42/42 | migration fresh/upgrade/repeat 15 + RLS 矩阵 12 + 会话并发 15；含修复后的 M6 learning_card_sets 断言 |
| card-gen PostgreSQL（API 侧） | 5/5 | v2 1 + text 1 + partial 3；专用可销毁库，需 `DATABASE_URL` 同库（runbook 未写明，建议补） |
| typecheck | 6/6 包 0 错误 | |

未能在本容器验证：worker 侧 card-gen 集成（需完整 compose/对象存储，
挂起）、真实 Provider 链路、Playwright E2E、`make verify/release-check`。
这些保持"待执行"，与各 gate 文档口径一致。

## 3. 审计前的失败基线（证明"全绿"声称已过期）

| 项 | 审计首跑结果 | 定性 |
| --- | --- | --- |
| worker `governance.test.ts` "全部字段覆盖" | 失败 | 真实回归：`normalizeWorkspaceAIPolicy` 新增 `sendImageContent` 字段，测试期望未同步 |
| `v06-rls-matrix` 测试 26（learning_card_sets） | 失败 | 新增测试自身缺陷：postgres `Result` 子类 vs `deepEqual` 原型不等，**写完从未运行过** |
| web 6 个测试文件 | 失败 | 测试健壮性缺陷：裸用 `import.meta.dirname`（CJS 转换下 undefined），仓库其他同类测试均有 `?? __dirname` 兜底 |
| api `privacy-scan.test.ts` | 仅在 Node 原生 TS 运行器下失败 | 运行器差异（`.js`→`.ts` 解析），tsx 下通过，非仓库缺陷 |

## 4. 发现的缺陷（按严重度）

**P0**
1. session-service 的所有 post-commit 阶段（start/submit/retry-question/
   retry-evaluation 的 job 关联、lineage、action command 完成）使用裸
   `db` 句柄，无 `app.user_id/app.workspace_id` GUC。开发环境（owner 角色
   bypass RLS）一切正常，生产 RLS 角色下：读返回空、UPDATE 静默 0 行、
   INSERT 42501——submission 永久卡在 `question_preparing`，幂等命令
   永久 pending。【已修复】

**P1（计划硬不变量 / 功能不可用级）**
2. evaluate-rubric 的一一对应校验只比较集合大小：重复 rubricItemId 可
   顶掉同项的 `contradicted` 判定（`.find()` 取第一个），恶意/异常
   Provider 输出可制造虚假升级（§4.1-6/7、§7.2）。【已修复】
3. assisted（source_viewed）提交在 reducer 结果为 preliminary 时仍写
   `validated` understanding event（只有 schedule 分支降级），违反
   §7.4"assisted 结果理解不变"。【已修复】
4. 默认 `SCHEDULER_POLICY_VERSION=discrete-v1` 下，v1 分发把
   `source_viewed` 映射为 partial → 推进区间 + upgrade，违反 §4.1-4
   "0 次 assistance 却延长正式间隔"（该不变量不随 flag 豁免）。测试
   还把此错误行为固化成了期望。【已修复：assisted_hold 保持区间 +
   冷却下限；测试改写】
5. 题目过期链路三处缺口互相放大：(a) 全库不存在 active→expired 转移，
   过期后同 fingerprint 重新出题必撞 active 部分唯一索引 → 该知识点
   永久 `question_retryable`；(b) submit/unable 检测到过期/失效时先写
   STALE 再 throw——事务回滚吞掉 STALE，用户陷入永远 422 的死循环；
   (c) resume/GET 不检查 `expires_at`，过期题当 ready 返回（§6.2 fail-closed
   违反）。【已修复：四个入口原子翻转 + "提交后抛错"模式 + fail-closed 读】
6. deterministic fallback 对单短句/问句形 claim 生成的题面必然被自身
   安全门禁拒绝（题面嵌入 ≥8 字符 claim 连续片段）→ 不可重试
   `question_blocked`。默认 `AI_QUESTION_V1_ENABLED=false` 时 fallback
   是唯一路径，等于大量常见 claim 的验证功能不可用；mock provider 的
   题面（claim 前 30 字符）同样触发。【已修复：三档降级模板，fallback
   成为全函数，7 类困难 claim 实测全部过闸】
7. card-gen planner 三处确定性失败：map chunk 只按 token 切分可超出
   schema 的 200 单元上限（大纲式笔记在任何 Provider 调用前必然失败且
   无限重试）；跳级标题在 sectionPath 留下 null 空洞（jsonb round-trip
   后 zod 拒绝，普通导入笔记可触发）；编辑器 `<hN>` 标题不解析（层级
   全部塌成 1 且原始标签泄漏进已发布卡组章节标题）。【已修复 + 回归测试】
8. run retry 只恢复一个失败单元：≥2 个 terminal_failed 单元时，重试单元
   完成后 run 停在 awaiting_assets/mapping、无在途 job、不再投影回
   needs_attention——除取消重来外无法恢复（违反 G5）。【已修复：一次
   恢复全部失败单元 + 配额覆盖。注：并行开发会话同日独立实现了窗口化
   版本（超窗单元 scheduledAt=NULL、由 worker 窗口推进接续投放），
   合并采用该版本；本容器回归验证的是审计版，语义一致】
9. repair CAS `none→claimed` 与 `→completed` 均未 lease-fenced（裸
   `db.update`，无 lease_token/status 条件）：lease 已被收割的旧 worker
   可赢得 claim 并发起唯一一次 repair；且 attempt_count 只在成功后写入，
   失败/超时的付费调用无持久痕迹（§7.7）。【已修复】

**P2（本轮已修复的部分）**
10. unable 结果写入的 fingerprint 校验是恒真比较（两个绑定时互拷的
    快照），且证据校验只查 FK 非空——改写笔记/降级证据后仍可经 unable
    写事件与真实 schedule；已补实时重算（与 worker 同构）。
11. stale/blocked 终态不 abandon started review attempt（API unable +
    worker 两个 handler 共 9 处），attempt 永久滞留 started 占用唯一索引。
12. §8.7 第 2 层 learning-unit 锁缺失：reveal/submit/unable/start 跨
    submission 的 exposure 竞争窗口（同 key point 的 initial 与 review
    是两行）。已加 advisory lock 并统一五个动作的锁序。
13. action command 并发首用同 key → 裸 23505 → HTTP 500；request_hash
    直接存 `JSON.stringify(input)`（答案原文入账本，违反 §6.4.1 摘要
    要求）；reveal-after-submit 返回 `invalid_state_transition` 而非
    `submission_locked`。
14. `resultAvailable` 对提交前变 stale（无 validationEventId）的
    submission 为 true → 前端"查看结果"永远 404 死循环（服务端 +
    前端终态视图两侧修复）。
15. legacy_bridge 回滚路径无输入预检（12k 截断移除后，500k 字符笔记
    变成单次无上限 Provider 请求）；legacy 发布不 supersede v2 active
    卡组（回滚后产品面 split-brain）；runbook §5.3 覆盖检查未限定 v2
    executionMode（回滚演练期间每个成功 legacy run 都误报违规）。
16. 其余已修复项：FSRS shadow 快照存了决策后区间（§10.6 回放语义破坏，
    双路径）；mock provider 三方法不写 usage（M5 成本观测在开发/E2E
    不可见）；readUsage 接受 Infinity/负数/浮点（可炸发布事务）；
    evidence_revealed_at 从未写入；attempt↔schedule 一致性断言缺失
    （错绑时 attempt 永久 started）；unknownId 原文入日志；unable 完成
    attempt 缺评估/调度投影；card-set regenerate 幂等键随机（双击双
    run）；派生 partial run 覆写 executionMode；web 提交丢最后按键、
    409/422 不收敛、草稿重载死题面、复习 meta 404 文案误导网络、
    ResultPendingReveal 无读屏播报。

## 5. 修复清单（32 个文件）

**packages/shared**：`scheduling-unified.ts`（+测试）、
`deterministic-question.ts`（+测试）。
**workers/ai-worker**：`handlers/evaluate-rubric.ts`、
`handlers/generate-validation-question.ts`、`handlers/index.ts`、
`handlers/card-generation-text.ts`、`lib/source-unit-planner.ts`（+测试）、
`lib/card-generation-map-contract.ts`、`lib/providers/mock.ts`、
`lib/providers/json-response.ts`、`__tests__/governance.test.ts`。
**apps/api**：`modules/validation/session-service.ts`（P0 + 过期/锁序/
幂等/unable 集群）、`modules/card-generation/service.ts`（retry 全量恢复 +
legacy 预检）、`modules/card-set/service.ts`（幂等键）、
`integration-tests/v06-rls-matrix-postgres.integration.ts`（断言修复）。
**apps/web**：`components/ValidationFocus.tsx`、
`app/(workspace)/(focus)/review/[scheduleId]/page.tsx`、
`lib/__tests__/{v06-dom-leakage,v06-keyboard-a11y,
card-generation-partial-ui-contract,image-upload-queue-contract,
note-editor-404-handling,note-editor-reading-ui}.test.ts`
（`import.meta.dirname ?? __dirname` 兜底，与仓库既有风格一致）。
**docs**：`plans/learning-card-generation-engine-v2.md`（状态更正）、
`runbooks/card-generation-v2-rollout-rollback.md`（§5.3 限定 v2）、
`evidence/card-generation-v2/m6-gate.md`（§2 实际执行记录）、
`plans/v0.6-implementation-register.md`（本轮条目）、
`evidence/v0.6/README.md`（索引）。

验证：修复后泄漏扫描（`v06-dom-leakage`）与键盘无障碍（`v06-keyboard-a11y`）
源码级测试对修改后的 ValidationFocus 仍全绿；泄漏敏感的 SanitizedQuestion
白名单与 Cache-Control 契约测试全绿；全量数字见 §2.3。

## 6. 遗留问题（未修复，按优先级）

**P1 — 建议 M7 前必须处理**
1. `tests/e2e` 的 @pr 套件断言已删除的 v0.5 复习/验证 UI
   （`review-attempt.spec.ts:37-60,102`、`pr-smoke.spec.ts:213-221,387,404`、
   `core-learning-journey.spec.ts:219`、`nightly-content-flows.spec.ts:504`）：
   无论 flag 开关，PR E2E 门禁都无法通过；需要整体迁移到 v0.6 UI。
   同时 `NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED=false` 时复习队列只渲染
   "功能开关已关闭"，用户无法完成任何复习——该回退语义是否可接受需
   Owner 确认（计划 §12.2 允许"只读回退"，但"复习积压不可见"较激进）。
2. legacy `POST /reviews/attempts/submit` 仍接受客户端 outcome 并产生
   升级 + 区间推进，无 exposure/冷却检查；legacy validation 端点仍可
   客户端自由出题。计划 §8.3 要求兼容窗口内"不得提升间隔"、§12.2 要求
   关 flag 不恢复升级权力。因 v0.5 兼容测试断言现行为，收紧属产品决策，
   本轮未擅改——但这是 §4.1-2 不变量在 API 面上的真实旁路。
3. 治理决策：`CARD_GENERATION_V2_ENABLED` fail-open 默认值 vs M0 冻结
   的 fail-closed 原则、以及"默认开启先于 shadow/灰度/回滚验证"的 §21
   顺序违背，需 Owner 显式追认或回退。

**P2**
4. today 页对到期复习拉取未净化 `listReviews({includeAll:true})`
   （claim/quote/blockContent 进入客户端内存，与中性队列的泄漏目标冲突）。
5. reveal-result 的 action-command 快照保存完整结果（含用户答案与
   引文原文），计划 §6.4.1 要求只存受控引用并在回放时重查；同时存在
   "命令 pending 但响应未完成"的回放空洞（崩溃窗口内重放返回 409 而非
   原响应）。
6. `schema_invalid_bounded` 实际不可达（provider zod `max(10)` 先拒），
   "有界但契约不完整"的 draft 类直接终态失败而非进入 repair。
7. repair 对 `jobs` 的直写在 SEC-01 重新收紧（0024 撤销 worker UPDATE
   权限）后会失权——建议改 SECURITY DEFINER 函数（同 lease renew 模式）。
8. reaper 判死的 job 没有 run 级对账器：worker 崩溃在最后一次尝试上时
   run 永久停在非终态（代码注释承诺的 reconciliation 不存在）。
9. repair 流程缺 handler 级测试（flag 开/关、CAS 预占、reassess 失败、
   二次调用计数）；AIQ gold 门用合成完美预测而非真实 assessor 输出。
10. Prometheus 指标无 provider/model 标签；repair prompt 与生成 prompt
    共享版本号且未入 shared/prompts；CARD_ASSESSOR_VERSION 未持久化。

**P3（记录在案）**
11. start 的 blocked 联合返回形不完整（no_key_point/no_hard_evidence 走
    409/422 异常、stale_card 变 404、unsafe_question 不可达且同输入可
    反复重建失败 submission）；later 动作无 UI 调用方，且未按 §8.3 处理
    进行中 submission；`apps/web/lib/validation-question.ts` 死代码；
    FSRS shadow 单状态限制（已文档化）；`@ailearn/*` 手工同步脆弱点。

**流程建议**
- "全绿"声称必须绑定可复现实验（命令 + 环境 + 树状态哈希），新增测试
  必须至少运行一次才能计入 gate 文档（本轮两处失败均源于此）。
- runbook 补充：API 侧 card-gen PostgreSQL 集成需要 `DATABASE_URL`
  与 ADMIN_URL 指向同一可销毁库。
- card-gen v2 缺 M0–M5 的 gate 证据文件，建议按 v0.6 惯例补齐目录，
  避免"只有最后一个里程碑有证据"的倒挂。

## 7. 结论

v0.6 主链路与 Card Generation v2 的**代码实质是扎实的**：架构与计划的
对应关系清晰，绝大多数硬不变量在代码里有真实实现与测试背书；文档体系
对未完成事项的披露总体诚实。本轮审计的价值在于：(1) 修掉了会在生产
RLS、默认 flag 配置和常见输入下真实触发的一批缺陷；(2) 把三份互相矛盾
的 card-gen v2 文档收敛到与仓库事实一致；(3) 把"全绿"声称重新校准到
当前工作树并留下可复现实验记录。

当前状态的准确表述仍然是：**M0–M6 代码候选（本轮加固后），M7 未开始，
v0.5 遗留门禁未关闭，v0.6 未发布**。进入 M7 前建议优先处理 §6 的三个
P1（E2E 迁移、legacy 升级旁路、v2 默认值治理决策）。
