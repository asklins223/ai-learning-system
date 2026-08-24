# 全系统行为审计：问题清单与最优解方案

> 状态：**Open（问题已登记，待逐项修复；每完成一项请回写本表状态列）**
>
> 文档类型：审计报告 + 修复方案
>
> 版本：0.4
>
> 日期：2026-08-23（审计）/ 2026-08-24（复核回写）/ 2026-08-24（二次复核）/
> 2026-08-24（三轮对抗验证与域补扫）
>
> 修订 v0.4（2026-08-24 三轮）：(1) **对抗验证**——§10 的 15 条待验新发现逐条
> 以反驳立场再验，15 条全部成立无一推翻；其中 N-7 错误码机制修正（400 合同拒绝
> 而非 409）、N-11 升级（一个坏时区可致全体用户日记调度停摆，P3→P2）、N-14
> 升级（叠加 0183 为日记全量静默死亡，P3→P2）、N-19 触发面修正（真窗口是与
> worker 长事务的重叠而非双开标签页）、N-15 标注「修 N-5 即激活」捆绑警告；
> N-6 获加重实证（needs_attention 弹窗数据源恒 404 是死代码、'failed' 是死值，
> 轮询盲区覆盖 100% 确定性失败，实库现存一例）。各条以「三轮验证」就地标注。
> (2) **域补扫新发现 N-21…N-24**（identity/note 域首轮覆盖）：含 P1 一条
> ——removeMember 可驱逐 workspaces.ownerId 本人致账号级死锁（已亲核）；
> 另一条在途 diff 引入的回归 N-22（onboarding evidence_review 主键错配，
> 已亲核）。(3) **C-3 三轮验证修正**：0183 回归的触发还需
> user_companion_account_state 存在启用行（当前 0 行故尚未爆），此前「下一次
> 01:00 即炸」表述过宽，见该条更正。(4) 实库验证贯穿：约束/枚举/迁移台账/
> 函数体/索引均经开发库 psql 只读探针证实。残余盲区：desktop-client 深审、
> understanding-v3/review 域、shared 合同双向对账、api diff 全量审计四路
> 因超时未完成（desktop 安全面已抽查：gateway IPC-only 无网络暴露、隔离/
> CSP/导航守卫齐全，初步无红旗），待后续补扫。
>
> 修订 v0.3（2026-08-24 二次复核）：以当前工作树为准逐条再验（工作树约有 99 个文件
> 在途未提交改动）——26 条登记项 24 条完全属实、2 条部分属实（D-4/D-7 后果高估近
> P3）、0 条被推翻；**A-1 已被在途改动修复**（缺文档要求的四步 e2e 测试）。方案级
> 硬伤 6 处：A-3/B-4/C-5/D-7 按原案字面实施会失败或自毁、D-5 前提被新增
> desktop-client 推翻、B-2 登记场景被数据流证伪；C-2 补充方案的枚举值有误。定级
> 修正 3 条（A-2 建议降 P2、D-4/D-7 近 P3）。盲区补扫新发现 16 条（N-5…N-20，
> P1×3），登记于 §10；其中 N-5 与 §3.1「自动提取 ✅」正面基线冲突（疑环境漂移），
> 见 §3.1 勘误。各条以「二次复核 08-24」就地标注。
>
> 修订 v0.2（2026-08-24）：全量复核完成——27 条逐条沿真实数据流验证，25 条完全属实、
> 2 条比登记更重（C-4 另缺 `COMPANION_BRIDGE_V2`；A-5 存在真实勾选 UI）、无一条被推翻。
> 方案级修正 1 处（A-2 映射现有 RelationTask 不可行，改为止血 + 另立项）；补前提 4 处
> （A-1 mergedDraft 同坑、C-2 failed 重入队残余缺口、C-3 列名口径定死、D-1 busy-lock 复位）。
> 各条以「复核 08-24」就地标注，汇总见 §9。
>
> 审查对象：[20](./20-learning-card-v2-value-first-generation-and-learning-target-rebase.md) /
> [21](./21-real-desktop-pet-memory-context-design.md) /
> [22](./22-real-desktop-pet-memory-context-prd-tdd.md) /
> [23](./23-learning-objective-content-topology-system-rebase.md) /
> [24](./24-learning-card-v1-cleanup-remaining-plan.md) 所覆盖的实现面
>
> 审查方法：五路独立审查（卡生成与多题型 / 桌宠记忆 / 日记·主动提醒·人格 /
> 三分钟微旅程 / 消费面一致性），以"沿真实数据流验证行为"为主，辅以文档↔代码比对；
> 所有 file:line 均为 2026-08-23 工作区快照，后续提交可能漂移，修复时以符号名为准。

---

## 0. 结论先行

| 域 | 总评 | P1 数 | 关键风险 |
|---|---|---:|---|
| 学习卡生成链路 | ✅ 优秀 | 2 | 用户编辑的答案字段静默丢失；关系题渲染空白 |
| 多题型支持 | ⚠️ 与文档宣称差距大 | （归入上行）| 默认体验退化为单一开放问答；repair/double-task 不可达 |
| 桌宠真实记忆 | ✅ 开发机可闭环 / ❌ 出厂即失能 | 1 | "忽略 30 天不弹"实际无效，重复候选反复弹 |
| 桌宠日记 | ✅ 工程严谨 / ⚠️ 设计硬伤 | 2 | 漏跑当天永久缺失且无补救；"不再提醒这类"未实施 |
| 三分钟微旅程 | ✅ 主链通畅 | 2 | 提交失败无反馈卡死；commit 冲突误入不可自愈死局 |
| 消费面一致性（方案 23 目标） | ✅ 达成 | 0 | — |

**一句话**：主流程通畅、工程纪律（幂等/OCC/fail-closed）真实存在，方案 23 的消费面
统一目标已兑现；问题集中在**承诺性细粒度功能未落地而文档标了 Implemented**、以及
**若干错误处理路径会把用户带进死局**。共登记 P1×7、P2×19、产品决策项×4。

> **二次复核 08-24 增补**：26 条登记项 24 条属实、0 条被推翻，A-1 已在途修复；
> 方案级硬伤 6 处已就地修正（A-3/B-4/C-5/D-4/D-7 按原案实施会失败或自毁、
> D-5 被 desktop-client 推翻）。盲区补扫另发现 16 条（§10）：P1×3——
> N-5 memory_candidate 违反 CHECK 约束疑致记忆提取链路在新环境整体断裂（动摇
> §3.1「自动提取 ✅」基线，需立即验证开发库）、N-6 Web V2 生成失败永久卡死且
> localStorage 封死入口、N-7 候选审核三动作空 hash 恒 409 在 Web 上永不生效；
> P2×5 含个性化文案绕过 AI 同意外发记忆原文（N-8，隐私级）、abandon 的 run 被
> 迟到 Critic 结果复活并产生 canonical 调度副作用（N-13）；P3×8。当前有效计数：
> P1×9（原 7 + N-5/N-6/N-7，其中 A-1 已修、A-2 建议降 P2）、P2×24。
> **N-5 已实库验证（2026-08-24）**：开发库约束确为窄版、探针 INSERT 被拒——
> 属实且非环境漂移；§3.1「自动提取 ✅」基线改判 ❌（详见 §3.1 勘误与 §10 N-5）。
>
> **三轮结论汇总（2026-08-24，5 组对抗验证 + identity/note 域补扫 + 主会话实库
> 验证）**：§10 的 15 条待验新发现以反驳立场逐条再验，**全部成立、无一推翻**；
> 修正 4 处（N-7 错误码为 400 非 409 且 merge 修法不同、N-11 升 P2 跨租户 DoS、
> N-14 升 P2 全量静默死亡、N-19 真窗口是与 worker 长事务重叠）、加重 1 条
> （N-6：弹窗数据源恒 404 死代码、'failed' 死值，盲区覆盖 100% 失败，实库现存
> 一例）、捆绑警告 1 条（N-15 修 N-5 即激活）。C-3 三轮修正：0183 回归触发还需
> account_state 存在启用行（当前潜伏），首个开启桌宠全局开关的用户将引爆。
> 新发现 N-21…N-24（§11）：P1×1 removeMember 驱逐属主链（已亲核）、P2×1 在途
> onboarding 主键错配（已亲核）、P3×2。当前有效计数：P1×10、P2×26、P3×11、
> 产品决策项×4。残余盲区待补扫：desktop-client 深审、understanding-v3/review 域、
> shared 合同双向对账、api diff 全量审计（desktop 安全面已抽查无红旗：
> gateway 为 IPC-only 无网络暴露，contextIsolation/sandbox/CSP/导航守卫齐全）。

---

## 1. 学习卡生成链路（方案 20 域）

### A-1【P1】用户编辑的答案字段静默丢失

- **位置**：`apps/api/src/modules/card-generation-v2/candidate-review-service.ts:686-689`
  （`buildObjectivePatch`）、`helpers.ts:327-340`（`applyPatch`）、
  `reveal-service.ts:222`（读取处）、`activation-service.ts:900-913`（落库处）
- **机制**：keep/edit 流程中，用户编辑的 `explanation / boundary / misconception /
  workedExample` 被 `buildObjectivePatch` 写到 `objectiveDraft` **顶层**，而这些字段
  的真实结构嵌套在 `objectiveDraft.learningSupport.*` 之下。`applyPatch` 只做顶层
  键覆盖，不会深入嵌套路径合并。
- **后果链**：
  1. 用户编辑的解释/边界/误区永远进不了 Reveal 返回内容（reveal 读
     `learningSupport.explanation`，读到的一直是旧值）；
  2. recheck 门禁校验的也是旧内容——校验通过了，但通过的不是用户改过的东西；
  3. 激活落库写入的还是旧 `learningSupport`，编辑等于没发生，且**无任何报错**。
- **为什么危险**：这是"操作成功但效果丢失"的最恶性类别——用户以为自己改好了答案
  讲解，学生视角看到的仍是 AI 原稿。文本比对这些字段名都对得上（都在代码里出现），
  只有沿数据流才能发现路径错位。
- **最优解**：
  ```ts
  // buildObjectivePatch 改为输出与目标结构同形的 patch：
  const patch = {
    /* ...顶层字段不变... */
    learningSupport: {
      explanation: draft.explanation,      // 从编辑表单取值
      boundary: draft.boundary,
      misconception: draft.misconception,
      workedExample: draft.workedExample,
    },
  };
  ```
  同时 `applyPatch` 对 `learningSupport` 做**字段级浅合并**（只覆盖 patch 中出现的
  键，不整体替换对象，防止误删未编辑的支持字段）。补一条端到端测试锁定：
  *edit explanation → recheck 通过 → reveal 返回新内容 → 激活后 DB 中
  learning_support.explanation 为新值*。四步缺一不可，只测前两步还会漏。
- **复核 08-24【属实】**：`buildObjectivePatch` 四字段写顶层、`applyPatch`
  （helpers.ts `applyPatch`）纯顶层覆盖无嵌套路由、reveal 读
  `learningSupport.*`、激活落库 `objectiveDraft.learningSupport`——四步后果链逐步验证成立。
  **补充前提**：除 keep/edit 路径外，candidate-review-service 中 recheck 的
  **mergedDraft 合并草稿路径走同一个 `buildObjectivePatch`，同坑同修**；修复时两条
  调用点都要覆盖进 e2e 断言。方案本身维持原案。
- **二次复核 08-24【已被在途改动修复】**：未提交 diff 中 `buildObjectivePatch`
  （candidate-review-service.ts:682-698）改为把四字段组装进局部 `learningSupport`
  对象再挂 patch（仅编辑过的键写入）；`applyPatch`（helpers.ts:344-360）对
  `learningSupport` 键做递归字段级合并、null 删单字段不删兄弟字段。edit 与
  mergedDraft 两条调用点同被覆盖（复核 08-24 补充前提满足）；合同 strictObject
  不含 learningSupport 键，客户端无法注入该路径。下游 reveal（按 revision 定位）
  与 activation 落库/hash 计算均拿到新值。单测已补 helpers 2 条 + review-service
  2 条（实跑通过）。**残余缺口**：文档要求的「edit→recheck→reveal 返回新内容→
  激活落库 DB 为新值」四步端到端测试仍不存在——C15 集成用例只断言 edit→新
  revision→recheck 终态，不断言嵌套存储内容；建议补一条真实 DB 集成测试锁定，
  否则未来重构仍可能无声回退。另注：当前 web 编辑表单实际只提交
  objectiveStatement+front.prompt，四字段的即时爆炸半径有限，但合同级开放
  （candidateEditablePatchV2Schema），P1 维持。

### A-2【P1】关系题（relation_canvas）渲染断裂，用户看到空白

- **位置**：服务端 `workers/ai-worker/src/handlers/run-planner.ts:483-489` 产出独立
  `relation_canvas` 变体；`apps/web/features/learning-run/ui-adapter.ts:92-97`
  原样透传该 kind；UI 合同独立题型名叫 `"relation"`
  （`features/learning-run/contracts.ts:73`）；分发处
  `TaskRenderer.tsx:20-37` 的 switch **没有 `relation_canvas` 分支**。
- **机制**：命名不一致导致整组件返回 `undefined`，React 渲染出空白区域，
  用户无法作答也无法理解发生了什么。
- **后果**：只要 planner 在某次 Run 中选择了独立关系题变体，该次微旅程必然卡死在
  一个白屏任务上（skip 是唯一出路，而 skip 会终结整个 run）。
- **最优解**（两层都做，第二层是保险丝）：
  1. `TaskRenderer` 增加 `case "relation_canvas":` 映射到已有的
     `RelationTask` 组件（组件本身已存在且有样式，只是没人分发到它）；
  2. 建立一份**planner 可产 kind ↔ renderer 注册表的一致性测试**：遍历
     planner/structured 生成器所有可能输出的 interaction kind，断言每个都能在
     TaskRenderer 解析到非空组件。今后新增题型时这条测试会强制同步注册 renderer，
     从机制上杜绝"服务端能出、前端接不住"这类断裂再次发生。
- **复核 08-24【属实，方案有硬伤，已改打法】**：断裂机制与可达性确认成立，且
  可达性比登记的更集中——`goal=repair` 是全站唯一传
  `responsePreference="structured"` 的入口（web learning-runs/new 页），
  **断裂渲染器恰好卡死在"我要修复薄弱点"这条用户诉求最明确的旅程上**。
  但方案第 1 步不可直接做：`RelationTask` 是**两节点单边题**（组件内
  `const [firstId, secondId] = publicNodeIds` 只取前两个节点、提交单条边），而
  独立 `relation_canvas` 变体是 **N 节点 + solution 含多条 requiredEdges**
  （run-structured 的 relation 变体按 rubric relations 构图，确定性评估按多边
  对比打分）。直接映射 = 白屏换成"永远拿不到满分的错题"。修正为三选一：
  - **① 最小止血（推荐先做）**：planner 侧独立关系变体生成失败/节点数 >2 时回退
    open_recall，先杜绝空白屏；
  - **② 同构化后映射**：生成端限制为严格 2 节点单边变体（与 RelationTask 数据
    形状同构），再挂 `case "relation_canvas"` 分支——注意两处 kind 名仍需统一，
    一致性测试会逼出这个决定：要么服务端改发 `relation`，要么前端合同加分支；
  - **③ 真画布 renderer**：作为独立工作项另立项，不并入本批。
  方案第 2 步（kind↔renderer 一致性测试）维持原案，无论如何都做。
- **二次复核 08-24【属实，两项修正】**：
  **(1) 后果修正——「skip 是唯一出路」不成立**：web 播放器控制轨
  （player/LearningRunPlayer.tsx:204-251）在 TaskRenderer 之外独立渲染，白屏时
  用户仍可「换个方式」switch_variant 切到 standby voice 变体继续
  （run-view.ts:269-276 构建 alternatives；run-service.ts 换制不终结 run），
  也可用提示或 declare_unable。实际后果是「作答区空白 + 需手动换模态」而非
  「旅程卡死」。桌面端另有完整 relation_canvas 编辑器不受影响。
  **(2) 可达性修正——repair 入口当前休眠**：穷尽 grep web/desktop/companion/api
  后未发现任何现存 UI 生产 goal=repair 链接或 structured 偏好——new/page.tsx
  两处映射是仅有的注入点也是死入口（星图 repair_gap 所指链接不存在；
  companion/desktop 恒 stabilize+adaptive）。断裂真实存在且 API 合同对任意客户端
  开放，但两个加重前提均不完整成立，**建议降 P2 跟踪；在 repair 入口接线前必须
  完成修复**。方案细化：① 止血条件应覆盖「生成失败 || 节点数>2 ||
  requiredEdges>1」（comparison 变体天然 2 节点单边，直接映射其实可玩）；回退
  目标是 planV2Run 既有的 text 分支（文档原写 open_recall 符号不存在）；② 若走
  同构化需同时约束 relations 路径取单边子集或拒绝；③ 一致性测试落地建议把
  TaskRenderer 改为导出 kind↔组件注册表对象再 switch，跨包断言无需解析源码。
  当前工作树无任何止血动作。

### A-3【P2】关系题节点显示原始哈希串

- **位置**：`run-structured.ts:411` 输出 `publicNodeLabels: {}`；
  节点 id 本身是 sha256 截断哈希；`RelationTask.tsx:42` 回退直接渲染 id。
- **影响**：用户看到形如 `a3f9c2…` 的节点标签，题目不可读。
- **最优解**：生成端填充标签——优先取 relation 目标 Objective 的 `conceptLabel`
  （查询已在同一事务上下文内，成本极低），缺省回退 `publicSummary.slice(0,12)`；
  前端兜底从"原始 id"改为"概念 N"。两端都改，保证任何情况下不出哈希串。
- **复核 08-24【属实】**：run-structured 独立关系变体 `publicNodeLabels: {}` 与
  RelationTask `nodeLabels[id] ?? id` 回退渲染 id 均确认。方案维持原案。
- **二次复核 08-24【属实；方案的标签来源有数据模型错误，已改】**：三处登记事实
  核实成立，且影响面细化——空标签仅发生在 relations 路径变体（comparison 路径
  已填 dimension 文本标签）；桌面端已有「节点 N」兜底（indexedPublicLabel），
  哈希串暴露是 web 特有；该变体即使产出也先撞 A-2 白屏，本条是 A-2 的二阶缺陷。
  **但原案的标签来源是错的**：`ObjectiveRelationV2.fromAnswerUnitId/toAnswerUnitId`
  引用的是【同一 Objective 自己】canonicalAnswer 内的 answer unit（prompts 明确
  约束引用本目标 canonicalAnswer 的 unitId），不存在「relation 目标 Objective」
  这个跨目标概念——取其它 Objective 的 conceptLabel 是张冠李戴，「查询已在同一
  事务上下文内成本极低」的设想也不需要。**修正后的做法更简单且零查询**：给
  generateRelationFromObjectiveRelations 传入其调用方手头就有的 canonicalAnswer，
  复用现成的 `flattenAnswerUnits`（run-critic.ts:268 已实现并导出）把 unitId 映射
  到单元文本截断作标签；前端兜底改「概念 N」时对齐桌面既有 indexedPublicLabel
  惯例保持双端一致。

### A-4【P2】repair 目标语义错位：想修错反而拿不到修复题

- **位置**：web 侧 `learning-runs/new/page.tsx:186` 把 `goal=repair` 映射为
  `structured` 偏好；但 V2 快照路径的结构化生成器
  （`run-structured.ts:425-443`）返回类型只含 ordering/relation，**repair 题型
  在 V2 不可达**（仅 V1 claim 路径能产）。
- **影响**：用户带着"我要修复薄弱点"的目标进来，拿到的是排序/关系题——不是错，
  但与目标语义错位；真正的 repair 题（针对 misconception 的纠偏作答）反而永远见不到。
- **最优解**：分两步。(1) 短期：web 的 repair goal 如实映射到当前可达的最接近变体，
  并在 UI 上注明"将以排序/关系形式检验你的薄弱点"；(2) 正式修法：在
  `generateStructuredFromSnapshot` 中增加 repair 变体生成——输入是快照中的
  `misconception`/历史 assessment 弱项，构造"给出常见错误理解，请指出错在哪并纠正"
  型任务（canonical answer 由 misconception 的否定式构成，可确定性生成，无需 LLM）。
  若判定近期不做 (2)，则必须把文档中 repair 相关表述改为"预留"。
- **复核 08-24【属实】**：`goal === "repair" ? "structured"`（web new 页两处）与
  结构化生成器 switch 只含 ordered_steps/mapping/comparison/text/bullets/
  formula/code → 仅产 ordering/relation_canvas，类型上确实不产 repair。方案维持
  原案；注意与 A-2 复核联动——repair 入口正是 relation_canvas 空屏的唯一入口，
  两项宜同批修。
- **二次复核 08-24【属实；入口休眠 + 四点补充】**：可达性与 A-2 同一保留——当前
  全部入口均不产生 goal=repair URL 或 structured 偏好，语义错位当前休眠，一旦
  接线立即与 A-2 叠加成白屏。方案四点补充：(a) 正式修法的输入应同时纳入
  scoringRubric.units[].contradictionRules 与历史 assessment 弱项，不止
  misconception（后者 optional，很多目标没有）；(b) 「canonical answer 由否定式
  构成、可确定性生成」低估质量风险——确定性拼否定句易产出别扭题面，应按库内
  惯例做成「判断不足则返回 null 回退开放回答」而非硬造；(c) 若做 (2) 还需同步
  处理 GOAL_INTENT.repair 仍是 explain 的 intent 错位及复活被 skip 的集成测试
  （learning-runs-structured-postgres.integration.ts:312，skip 理由原文写明 V2
  无 repair 生成入口）；(d) 短期案里 repair 继续映射 structured 应是有意识决定
  ——若认为 ordering/relation 不足以承载修复语义，短期更如实的做法是映射回
  adaptive（开放回答 repair 角度池本含「找出哪里不牢靠」等三角度）。

### A-5【P2】preferredStrategies 是死字段，用户偏好无效

- **位置**：`generation-run-service.ts:192` 只把它存进 `semanticSpec`；
  worker 全文 grep 确认 planner/author prompt 均不消费。
- **影响**：请求合同向调用方暗示"可以指定策略偏好"，实际完全无效——虚假承诺。
- **最优解**：二选一，推荐前者：(a) 把 `preferredStrategies` 注入 planner prompt
  的"变体选择约束"段落（一两行 prompt 改动 + 一个单测断言 prompt 含偏好）；
  (b) 若认为不该让用户选策略，就从请求合同中删除该字段。不能维持现状。
- **复核 08-24【属实且更重】**：worker 侧全文 grep 确认零消费；但比登记更重的
  是——**web 有真实用户 UI**（card-generation-v2 GenerationControls 的复选框，
  用户可勾选策略偏好），勾了完全无效。"虚假承诺"不是合同层面的暗示，而是用户
  实际操作得到的静默无效。这使选项 (b) 的代价上升（删字段还得删 UI），进一步
  倾向方案 (a) 注入 planner prompt。
- **二次复核 08-24【属实；方案 (a) 注入点打偏】**：UI 存在性确认——
  GenerationControls 七个策略复选框（legend「偏好的练习结构·系统仍会按内容选择」）
  真实发送 preferredStrategies，桌面端还硬编码 ["recall","why"]。worker 零专用消费
  确认，但有一个登记未捕捉的细节：planner user prompt 整体
  JSON.stringify(semanticRequest)，字段**物理存在于 planner 输入**（只是无任何指令
  使其生效）；真正决定 presentation.strategy 的是 **author 阶段** prompt（完全不含
  偏好），确定性路径仅按 knowledgeForm 映射。**因此只注入 planner prompt 大概率仍
  无效**——有效修法须同时把偏好传入 buildAuthorUserPrompt（或在 executeAuthor 加
  偏好感知的确定性映射/回退），且 planner+author 两条 prompt 都纳入单测断言
  （原案只要求断言一处）。

### A-6【P2】长事务行锁横跨分钟级 LLM 管道 + 重试重放已付费阶段

- **位置**：`card-generation-v2-handler.ts:647-658` FOR UPDATE 行锁横跨
  planner→author→grounding→pedagogy 四阶段（分钟级）；`:1038-1047` 自述
  grounding 抖动重试会重放已完成的 planner/author（token 双花）。
- **影响**：并发生成同一目标的请求被长时间阻塞；网络抖动的代价从"重试一次
  grounding"放大为"整个管道重跑一遍"。
- **最优解**（两阶段改造，工作量约 1 天）：
  1. 短事务只做 claim（状态置 `processing` + 持有者标记）随即提交释放锁；
  2. LLM 管道在锁外执行，**每阶段产物即时持久化为 checkpoint**（planner 结果落库后
     grounding 失败只重跑 grounding）；最终结果用一次短事务 CAS 提交
     （`WHERE status='processing' AND claimed_by=…`）。
  单人开发、当前无并发压力，此项可排后，但**不应无限期挂起**——它是唯一一处
  "锁语义与执行时长不匹配"的结构性问题。
- **复核 08-24【属实】**：FOR UPDATE 锁范围与 grounding 可重试错误向上抛、
  job 级重试导致整管道重放的机制均确认——代码注释（round-8 🟡3 段）已自述
  "token 双花/三花"。两阶段 checkpoint+CAS 方案维持原案，排期按 D-4' 决策项。
- **二次复核 08-24【属实；工作量 1 天偏乐观，执行清单须扩】**：机制原样确认
  （FOR UPDATE 锁现于 :661-667，注释原文命中）；另确认 `loadV2RunInputs` 使
  regenerate/replan/recheck 三条路径复用同一 FOR UPDATE 模式——**同坑三入口，
  只修主管线会留三个同型入口**。三点扩清单：(1) 覆盖面——三条复用路径一并改造；
  (2) 联动——30min 租约的设计前提（无心跳才放大租约）依赖管道在事务内，LLM 移出
  事务后需同步引入阶段间续租或缩短租约，否则 reaper 会误回收正常慢 job（代码
  注释已自标此耦合）；checkpoint 各阶段写入需幂等键防重，中间态对读方的可见性要
  定义；(3) 更便宜的止血存在——grounding 单阶段进程内限次重试即可消除大部分
  token 双花，可作不等状态机的过渡措施。outbox 已有 lease_token+status CAS 范式
  可复用于最终提交 CAS，与库内惯例契合。

### A-7【P2】激活信任 draft 内 rubricHash 不复算

- **位置**：`activation-service.ts:796` 直接采用候选 JSONB 里的 `rubricHash`。
- **影响**：当前 patch 路径确实改不到 rubric 所以风险低，但这属于"类型断言式信任"——
  未来任何人给 draft 增加新的可变路径，这里就变成完整性漏洞。
- **最优解**：激活事务内对最终 canonical answer/rubric 重算 hash，与 draft 声明值
  比对，不一致 fail-closed（拒绝激活并记 `surface_revision_mismatch` 类指标）。
  十几行改动，一次性消除信任假设。
- **复核 08-24【属实】**：activation-service 两处直接取 `objectiveDraft.rubric.rubricHash`
  确认。当前 patch 路径确实改不到 rubric（buildObjectivePatch 无 rubric 键），
  P2 定级恰当。方案维持原案。
- **二次复核 08-24【属实；方案最优，行号更新】**：两处采信点现位于
  activation-service.ts:796（create_new 路径）与 :1272（target_equivalent_update
  路径）；canonicalAnswer 的哈希在激活时是重算的（:794/:1270），rubric 是唯一
  「存啥信啥」的组件哈希。方案与库内惯例完全契合：target-snapshot-adapter.ts:463
  已有同型「复算比对」惯用法（computeRubricHashV2 + stripRubricHash 均现成可复用），
  author-service 冻结前已确立「写入时验证哈希」先例，fail-closed 与 stale_revision
  家族一致。实施注意：两处都要改（建议提一个事务内共享助手）；指标可复用现存
  `ailearn_surface_revision_mismatch_total` 计数器。「十几行改动」估计准确，
  无更简替代（废弃存储哈希反而牵动 candidateRevisionHash 闭包）。

---

## 2. 多题型支持：真实矩阵与产品决策

### 2.1 真实可用性矩阵（2026-08-23 实证）

| 题型 | V2 微旅程真实可用性 | renderer | 测试 |
|---|---|---|---|
| open_recall（开放问答） | **默认唯一主变体**（responsePreference 缺省 adaptive → 不生成结构题，run-planner.ts:392-395） | ✅ | ✅ |
| voice_teachback | 备选变体，语音链路真实接通（录音→ASR→逐字稿确认） | ✅ | ✅ |
| ordering | 仅 structured 偏好且 canonicalAnswer 为 ordered_steps/mapping（run-structured.ts:300,324）；而 web 仅 goal=repair 才传 structured | ✅ | ✅ |
| relations | structured 偏向下可产出，但独立变体**渲染断裂**（A-2） | ⚠️ | 仅 bundle 内 |
| repair | **V2 不可达**（快照路径类型上就不产，见 A-4） | ✅ | ✅（V1 路径） |
| structured_bundle 双题型 | **V2 恒不生成**，仅 V1 stabilize/clarify/explore 路径 | ✅ | ✅ |
| cloze | 属卡面策略非 Run 题型；知识形态映射中无来源（author-service.ts:242-255），**永不被生成** | 组件存在，零消费者 | 无 |
| choice_with_rationale / scenario | planner 永不生成；提交侧 fail-closed（ui-adapter.ts:429-432 返回 null） | 存在 | 无 |

### 2.2 核心结论

**一次微旅程恒为单 task**（`planV2Run` 的 tasks 数组恒 1 项），默认路径退化为单一
开放问答。"多题型"目前只在 V1 structured bundle 中真实出现过；文档设想的
"多 Task 序列"实况是"一题 + 仅 partial/not_assessable 时可经 activate_followup
补一题（上限 supplement:1）"。skip_task 会终结整个 run（run-service.ts:1508 注释
明示单任务是已知 P2 取舍）。

> **复核 08-24【矩阵抽查通过】**：planV2Run 三处构造均 `tasks: [task]` 单任务确认；
> cloze 在 shared 合同存在枚举值但生成侧无知识形态映射来源确认；choice/scenario
> 提交侧 fail-closed 返回 null 确认。矩阵结论维持。

### 2.3 产品决策项 D-1：多题型要不要真做？

三个选项：

- **选项 a（推荐）**：接受"单题 + 可选补题"作为产品形态，把 20 号及 PRD 中
  "多 Task 序列"相关表述改为如实描述；同时修 A-2/A-4 让 relations/repair 两条
  已有资产的路径真正可用。理由：三分钟微旅程的定位下，单题深度作答 + 定向补题
  本身是合理设计，多题序列反而稀释"三分钟"承诺；voice/ordering/relations/repair
  四类齐备后，"题型多样性"的实际观感已经达标。
- **选项 b**：真做多 task 序列。涉及方案 16 冻结面（phase 机、Commit 边界、
  schedule successor 语义都要重新论证），成本高，除非用户调研明确需要，不建议。
- **选项 c**：不动代码也不改文档。**不可接受**——文档失真是本次审计最集中的教训。

---

## 3. 桌宠真实记忆（方案 21/22 域）

### 3.1 链路实测状态

| 环节 | 状态 | 说明 |
|---|---|---|
| 自动提取 | ✅ | 终态事务入队；置信度 >0.6 过滤、≤3 条、candidate+delivery |
| 会话摘要 | ✅ | seq≥30 触发，episodic 候选 |
| 手动新增/纠正 | ✅ | POST 路由 + 管理页表单（未提交改动中） |
| 向量检索 | ✅ | pgvector cosine 加权；EXISTS 探测降级 keyword；中文 bigram+头尾采样关键词提取 |
| `<memory_data>` 注入 | ✅ | 边界块 + 防注入声明；200 字/条、1000 字总额 |
| memoryRefs 回传 | ✅ | final 事件 ≤3 条×80 字 → 气泡"我记得你说过" |
| 确认闭环 | ⚠️ | 三按钮接通，但 dismiss 语义失效（B-1） |
| familiarity 关系值 | ✅ | 对话 +0.01 / 确认 +0.03 / >14 天衰减 -0.05，三条链路齐全 |

> **二次复核 08-24【勘误：自动提取行实为 ❌，已实库验证】**：开发库
> （ailearn-dev-postgres-1，pgvector/pg16）实测 `assistant_deliveries_kind_check`
> 就是窄版 5 值（message/proposal/action_result/proactive_cue/system_event），
> 无 `memory_candidate`；回滚事务内探针 INSERT 直接报
> `violates check constraint`——N-5 属实，非环境漂移。上表「✅ 实测通过」不成立：
> 库内 candidate 态记忆为 0 条，8/20 仅有的 4 个提取 job 全部 succeeded 是因为
> LLM 未产出置信度 >0.6 的候选（提前 return，没走到 delivery 写入）——约束炸点
> 从未被触发过而已。8/22 后的 60 组对话全是 learning-action-bridge 的 action
> 提案（run_id 全空，不经 dialogue 管道），因此连提取任务都不再入队。管理页的
> 4 条 preference 记忆系手动新增。**结论：一旦对话管道正常使用且某轮提取出
> 阈上候选，该轮事务必回滚**——修复优先级维持 P1。详见 §10 N-5。

**出厂配置问题**：`.env.example` 中 7 个 COMPANION flag 全 false +
`NEXT_PUBLIC_COMPANION_PET_ENABLED=false` + `COMPANION_DIALOGUE_V1_ENABLED=false`
→ 新环境零配置时整条记忆链路静默不存在。开发机 `.env` 已全开故可跑通。
→ 归入产品决策项 D-2（见 §7）。

### B-1【P1】"忽略 30 天不弹"未真正实现

- **位置**：`memory-service.ts:333`（dismissMemory 只盖 `dismissed_at` 时间戳）；
  `companion-memory-extractor.ts`（提取前不查历史 dismissed 相似项）；
  `delivery-service.ts:214-231`（delivery 列表不过滤 dismissed 关联）。
- **机制**：dismiss 只对"这一条候选"生效。同一主题的信息在下轮对话中被重新提取时，
  会生成**全新 candidate + 新气泡**——因为 extractor 既不知道历史上有过被忽略的
  相似记忆，sourceEventId 又含 runId 导致逐轮去重天然失效。
- **后果**：PRD §2.2.4 承诺的"忽略则 30 天内不再自动弹出"完全不成立。真实体验
  二选一：频繁弹卡打扰，或候选永远躺在管理页没人理。这是确认闭环运营成本的
  最大单一来源。
- **最优解**（在 extractor 入口加一道闸，约 30 行 + 1 个单测）：
  ```text
  extractor 生成候选 content 后、写库前：
    SELECT 1 FROM assistant_memory_items
    WHERE workspace_id=? AND user_id=? AND deleted_at IS NULL
      AND dismissed_at IS NOT NULL
      AND dismissed_at > now() - interval '30 days'
      AND similarity(content, ?) > 0.85   -- pg_trgm，与冲突检测同阈值
    LIMIT 1
  命中 → 跳过该候选（记 debug 日志 dismissed_duplicate_skip）
  ```
  pg_trgm 扩展与 GIN 索引已因冲突检测存在于库中，无新增基建。同理给
  `upsertMemory` 的查重池纳入 candidate 态记忆，缓解同主题候选堆积（B-4 同根）。
- **复核 08-24【属实，且代码注释自证】**：dismissMemory 仅盖 `dismissed_at` 确认，
  且其函数注释自己写着"忽略：气泡内 30 天不重复弹出"——承诺与实现脱节在源码级
  实锤。extractor 全文无 dismissed/similarity 检查确认；
  `sourceEventId = memory-extract:${runId}:${index}` 含 runId 确认跨轮去重失效。
  PRD §2.2.4（22 号 250 行）确有"30 天内不再自动弹出"原文。pg_trgm 已因
  0006/0053/0169 三处 migration 在库确认。0.85 阈值与冲突检测同档合理，方案
  维持原案；建议单测覆盖"相似但不相同的新记忆被误杀"边界（阈值过高时降 0.8 再验）。
- **二次复核 08-24【属实；方案最优，三点修正】**：dismissMemory 只盖时间戳、
  dismissedAt 为全库纯写字段确认——且比登记更彻底：**连检索注入也不过滤
  dismissed_at**（向量与 keyword 检索均无该过滤），被忽略的记忆本身仍进 prompt。
  extractor 入库前无任何检查、sourceEventId 含 runId 确认。闸门放 extractor 是
  精确覆盖：全库只有 extractor 生成 memory_candidate 类型的 delivery，
  summarizer/daily-summary 候选不弹气泡。三点修正：(a) 审计「GIN 索引已因冲突
  检测存在」对该表不准确——trgm GIN 只在 search_documents 与 companion_messages
  上，assistant_memory_items.content 无索引；但既有冲突检测本就按 workspace+user
  圈定后无索引跑 similarity，单用户量级可接受，非阻塞；(b) 阈值边界单测
  （中文短文本误杀）应作为验收条件而非可选；(c) 残留缺口不阻塞本条：被 dismiss
  后又转正的 active 记忆仍会注入 prompt（可在实施时顺带补检索过滤）。

### B-2【P2】flag 门控不一致：气泡能弹出来，按钮全 404

- **位置**：extractor 只看 `COMPANION_MEMORY_EXTRACTOR_V1`（dialogue.ts:1169）；
  而 confirm/dismiss/correct 等 memory 路由要求
  `COMPANION_MEMORY_VECTOR_V1 || COMPANION_JOURNEY_V2`（memory-routes.ts:50-53）。
- **后果**：只开 EXTRACTOR 的部署会产生候选气泡，但确认/纠正/忽略三个按钮全部 404，
  候选永远无法转正。
- **最优解**：抽一个共享门控 helper（如 `hasCompanionMemoryCapability(flags)` =
  `VECTOR_V1 || EXTRACTOR_V1 || JOURNEY_V2`），所有 memory 路由与 delivery 写入
  统一使用；`.env.example` 注释写明三者依赖关系。半小时改动。
- **复核 08-24【属实】**：extractor 门控在 worker dialogue 只查
  `COMPANION_MEMORY_EXTRACTOR_V1`、memory-routes 门控只认
  `VECTOR_V1 || JOURNEY_V2` 均确认，"只开 EXTRACTOR → 气泡弹、按钮 404"组合成立。
  方案维持原案；helper 落点建议放 shared 包供 api 与 workers 共用（worker 的
  extractor 门控也要换用同一 helper，否则两边还会再漂移）。
- **二次复核 08-24【部分属实；登记的核心场景被数据流证伪】**：门控不一致本体
  属实且实为**三套**布尔组合并存：worker 记忆检索注入用
  VECTOR||EXTRACTOR||SUMMARIZER、extractor 入队只看 EXTRACTOR 单旗、memory 全部
  路由用 VECTOR||JOURNEY。但「只开 EXTRACTOR → 气泡能弹出来、按钮全 404」不
  成立——候选气泡唯一展示通道是 inbox SSE（只认 JOURNEY_V2），而 JOURNEY_V2=true
  本身就满足 memory 路由的 VECTOR||JOURNEY 门控，不存在「气泡可见但按钮 404」
  的旗组合。EXTRACTOR-only 的真实后果是**静默浪费**：extractor 正常跑 LLM 写入
  候选+delivery，但 SSE/lease/ack/管理页全部 404——产出不可见不可消费，纯烧
  token。P2 可保留（三套组合的维护性债务真实存在），按用户影响论甚至可议降 P3。
  方案两点补充：(1) 真正的漂移面还包括 delivery **读取面**——inbox SSE、lease/
  ack、timeline 三处全是 JOURNEY 单旗硬编码，helper 必须一并覆盖，否则
  EXTRACTOR-only 部署依旧产生无人能消费的 delivery；(2) 把 EXTRACTOR 纳入读取面
  门控是产品语义变更（EXTRACTOR-only 变成完整可用），应在 .env.example 注释明示。
  更保守的并列措施：让 extractor 入队门控要求组合能力
  EXTRACTOR && (VECTOR||JOURNEY)——「不生产无法呈现的工作」，一行改动天然消除
  浪费。

### B-3【P2】"我记得你说过"没有删除入口

- **位置**：PRD §3.6.2 承诺每条记忆引用附"删除这条记忆"；`PetBubble.tsx:155`
  目前仅 title 展示。
- **最优解**：memoryRefs chip 点击展开小菜单（查看全文 / 删除此记忆），删除调既有
  `DELETE /companion/memory/:id`。最小可用版：chip hover 出 × 按钮。这也是 22 号
  文档标 Implemented 而未落地的又一例（归入 §7 文档治理）。
- **复核 08-24【属实】**：PetBubble 仅 title 展示确认；`DELETE /companion/memory/:id`
  路由已存在可直接复用确认；PRD §3.6.2（22 号 579 行）"删除这条记忆"原文在案。
  方案维持原案。
- **二次复核 08-24【属实；方案最优，建议直接做菜单版】**：PetBubble.tsx:151-159
  仅 `<li title>` 确认；DELETE 路由与 web 客户端方法（deleteCompanionMemory）
  均存在可复用。落地细节两点：(1) memoryRefs 内容是截断到 80 字的预览，「查看
  全文」需按 memoryId 拉取，不能只用本地数据；(2) 从气泡删除是不可逆 soft delete
  且删的是底层记忆本身（不只是引用），hover-× 一步操作误触成本偏高——**直接按
  展开菜单版（查看全文/删除）实施，跳过最小版**。

### B-4【P2】同主题候选堆积刷屏管理页

- 与 B-1 同根（sourceEventId 含 runId 使逐轮去重失效）。修 B-1 的闸门后自然缓解；
  叠加手段是把 candidate 态纳入 `upsertMemory` 冲突检测（trigram 已具备）。
- **复核 08-24【属实】**：与 B-1 同源证据链确认。叠加手段有一个需注意的副作用：
  candidate 态纳入冲突池后，用户刻意分开记录的相似内容（如"喜欢咖啡"与"对咖啡因
  敏感"）可能被误合并——建议冲突检测仅做"跳过入库 + debug 日志"，不做合并改写，
  保留管理页人工裁决。
- **二次复核 08-24【属实；原方案按字面实施无效，已改打法】**：两处与登记不符的
  关键事实：(1) `markMemoryConflictIfSimilar` 的比对池**本就不筛 candidate**——
  「把 candidate 态纳入冲突池」在 upsertMemory 现有代码里已是事实，真正缺的是
  extractor 根本不走 upsertMemory 而是裸 SQL 写入；(2) 即便让 extractor 走通冲突
  检测，conflict_group 只是打标供裁决页归组，**不阻止入库也不阻止气泡弹出**
  （delivery 在 extractor 内独立插入）——「修 B-1 后自然缓解」也只覆盖 dismiss 后
  的重提，用户确认过的主题被再次提取（确认动作对提取无反馈）不受 B-1 闸门影响。
  **修正后的有效解法是并入 B-1 实现**：把 B-1 的 extractor 闸门查询池从「30 天内
  dismissed」扩展为「全部活跃记忆（active+candidate，deleted_at IS NULL）」，一处
  查询同解 B-1（30 天承诺）与本条（堆积），阈值与边界单测共用；复核 08-24 补充的
  「仅跳过+debug 日志、不做合并改写」设计成立。不要单独立项改 upsertMemory；
  conflict_group 保持现状用于已入库内容的裁决。另注：summarizer 的 episodic 候选
  （sourceEventId 同样含 runId）是堆积的第二来源，闸门扩展后一并覆盖。

---

## 4. 桌宠日记 / 主动提醒 / 人格（方案 22 §10-15 域）

### 4.1 实测状态

调度（01:00 时区桶、幂等键）→ 生成 → 只读 API 三态 → 页面全通，失败落行、
500 字截断、Policy Gate（dnd/offline/quiet/moderate/active/30min 冷却）、
quietHours 跨午夜环绕、2s 超时模板回退、SSE inbox lease/ack、5 套人格预设、
revision CAS 前后端、人格注入 prompt——均确认真实工作。人格子系统评级 A-。

### C-1【P1】"不再提醒这类"（cue_class 抑制）完全未实施

- **位置**：PRD §11.5 要求以 `cue_class` 为粒度的抑制表；全库 grep 无 cue_class
  字段/表/API，只有单条 delivery 的 dismissed/snoozed。文档状态却是 Implemented。
- **后果**：用户对某类提醒（如 resume_nudge）说"别再推了"，系统做不到——下次
  同类提醒照发。这是主动提醒域用户可感知的最大硬缺口。
- **最优解**（最小落地约半天）：
  1. 新表 `companion_cue_suppressions(workspace_id, user_id, cue_class,
     suppressed_at, reason)`，RLS 同既有表；
  2. proactive delivery payload 增加可选 `cueClass` 字段（shared zod 同步扩展，
     向后兼容）——枚举先只设 `resume_run / review_due / context_hint` 三档；
  3. 气泡菜单加"不再提醒这类"→ 写抑制行；
  4. `proactive-hook` Policy Gate 链末尾（发送前最后一步）查抑制表命中即跳过。
  若短期决定不做，**必须**把 PRD §11.5 状态改为"未实施"，不允许继续挂着 Implemented。
- **复核 08-24【属实】**：全库（api/web/workers/packages）grep `cue_class|cueClass`
  零命中确认；PRD 三处承诺原文在案（142 行"可被'不再提醒这类'抑制"、380 行、
  902 行"以 cue_class 为粒度"），而文档头部状态为 Implemented——E-1 的又一实证。
  最小落地四步方案完整（RLS 同既有表、shared zod 可选字段向后兼容、气泡菜单入口、
  Gate 链末尾拦截），无遗漏，维持原案。
- **二次复核 08-24【属实；佐证强化 + 两点补充】**：全库 grep 零命中复现；新增
  佐证——assistant_deliveries.state 枚举中的 `'suppressed'` 是**全库不可达值**
  （0131 定义、TERMINAL_STATES 引用、无任何写入路径），说明抑制机制连占位都未
  落地。Gate 链末尾拦截点成立：当前唯一主动投递生产者就是
  hookProactiveOnRunCompleted。两点补齐：(1) PRD:902 同时承诺「用户可撤销」，
  四步只写了写入+拦截，需补撤销入口/API（如人格设置页管理列表）；(2) 被抑制的
  delivery 更契合库内语义的做法是落 `state='suppressed'`（终态已预留）而非静默
  跳过，保留可观测性与 timeline 审计痕迹。

### C-2【P1】日记调度漏跑无补救：定时 + 只读 + 无补跑 = 数据黑洞

- **位置**：`0171` 调度函数判 `extract(hour)=1`——worker 进程宕机跨越本地
  01:00–01:59 这一小时，那天的日记**永久缺失**；页面只读（§16.6 有意设计），
  用户无任何自救手段。
- **为什么说是设计不合理而非单纯 bug**：定时任务天然可能错过（部署、重启、宿主机
  维护），"错过即永久丢失 + 禁止补救"的组合把小概率故障变成了确定性损失。
- **最优解（推荐，改动极小）**：把触发条件从 `hour = 1` 放宽为
  `hour BETWEEN 1 AND 6`——幂等键 `daily-summary:<ws>:<user>:<date>` 已保证
  一天只会成功生成一次，放宽窗口只是给"首个可达 tick"更多机会。宕机 5 小时内恢复
  都能自动补上，且完全不破坏"用户不可手动生成"的只读边界。SQL 函数一个条件的
  改动 + 一个跨小时幂等回归测试。（备选：受控 POST 补生成端点——更灵活但引入
  写接口，违背 §16.6 裁决，不作首选。）
- **复核 08-24【属实】**：0171 第 28 行 `extract(hour ...) <> 1 THEN CONTINUE`
  与幂等键 `daily-summary:<ws>:<user>:<date>`（唯一索引 + ON CONFLICT DO NOTHING）
  均确认；幂等键确实保证一天至多一条 job，放宽窗口不产生重复，方案安全。
  **补充一个残余缺口**：放宽只解决"入队没发生"；若 job 已入队但处理失败
  （status='failed'），幂等键冲突仍阻止当天重新入队。可选增强：
  `ON CONFLICT DO UPDATE SET status='pending' WHERE jobs.status='failed'`；
  不做也可接受，但须在本节注明该残余边界。改动落在 SQL 函数内，发新 migration
  重定义函数即可。
- **二次复核 08-24【属实；主方案最优，补充方案枚举值有误 + 新增硬前提】**：
  主方案验证安全且最优——窗口内每天各小时算出的 local_date 相同、幂等键逐字
  相同必撞唯一索引，放宽确实不产生重复（Asia/Shanghai 无 DST）。**但复核 08-24
  补充的 failed 重入队增强有一处错误**：本库 jobs 终态是 `'dead'` 而非
  `'failed'`（ailearn_fail_job 重试耗尽转 dead；唯一写 'failed' 的路径经
  max_attempts=1 立即强制 dead，无代码让 job 停留在 'failed'）——原文
  `WHERE jobs.status='failed'` 匹配零行，应改为 `WHERE jobs.status='dead'`
  （或防御性 IN ('failed','dead')）。且重试已内置（指数退避三次后 dead），残余
  缺口实际只覆盖「连续失败 3 次进 dead」的窄边界，维持可选定位。文档要求的
  跨小时幂等回归测试尚不存在，修复时应补。**新增硬前提（登记时不存在）**：在途
  未跟踪 migration 0183 已 DROP learning_cards 表而 0171 函数 :81 仍 EXISTS 查询
  它——见 C-3 二次复核标注，C-2/C-3/C-6 的函数重写必须一并处理。

### C-3【P2】多用户工作区计数串味

- **位置**：`0171:80-98` 活动判定与 `companion-daily-summary.ts:97-100` 的
  learning_cards/sources 计数只按 workspace 过滤、不带 user 条件。
- **后果**：协作工作区里他人建卡计入"你的日记"与"你有活动"判定。
- **最优解**：两处 SQL 补 `user_id` 过滤（与 notes/companion_messages 等其余
  五张表的对齐）。注意核对列名（cards/sources 是否有 creator 列；若无则该表
  维持 workspace 粒度并在文档注明口径）。
- **复核 08-24【属实，口径可定死】**：0171 活动判定中 learning_cards/sources
  两表确实只有 workspace 条件（其余五张均带 user 过滤）确认；
  companion-daily-summary 计数子查询同病确认。**列名核对结果**：`sources` 有
  `created_by` 列 → 两处均可直接加过滤；`learning_cards` 与 `learning_cards_v2`
  均无任何 owner/user 列 → 只能维持 workspace 粒度并在文档注明"卡维度按工作区
  口径"。按此分叉执行，不再留开放问题。
- **二次复核 08-24【属实；分叉口径成立，但出现登记时不存在的新回归】**：五表带
  user 过滤、两表只有 workspace 过滤、sources 有 created_by 可加过滤均复核成立。
  **但「learning_cards 维持 workspace 粒度」的落点表必须改**：在途未跟踪 migration
  0183（drop_legacy_card_v1_orphan_tables）:57 已 DROP `learning_cards` 表，而 0171
  函数 :81 仍 EXISTS 查询该表——**0183 一旦应用，调度函数每次执行抛 relation does
  not exist**（tick 侧 catch 后仅 warn 日志），桌宠日记功能整体静默停摆。这是在途
  改动引入的新回归。C-2/C-3/C-6 合并落地的函数重写中，learning_cards EXISTS 子句
  必须删除或改指 learning_cards_v2（workspace 粒度，与处理器计数口径对齐）。若
  未来真要按用户归属卡片，join 路径存在（card_generation_runs_v2.user_id），但需
  多表 join，维持 workspace 粒度 + 文档注明仍是合理取舍。
- **三轮验证 08-24【回归已激活，实库证实】**：开发库 `drizzle.__drizzle_migrations`
  已含 0183（共 185 条已应用），`to_regclass('public.learning_cards')` 返回 NULL——
  表已删。线上函数体（pg_get_functiondef 实读）仍含 `SELECT 1 FROM learning_cards`
  的 EXISTS 子句；直接执行同型语句报 `relation "learning_cards" does not exist`。
  当前调用函数返回 0 不报错只是因为不在 01 点窗口、per-user 循环未进入——**下一次
  本地 01:00 窗口起，日记调度对每个用户处理即抛错**，worker catch 后仅 warn，
  日记功能在开发环境已处于「触发即停摆」状态。修复紧急度上调：C-2/C-3/C-6 的
  函数重写 migration 应尽快落地（或先发一个仅删该 EXISTS 子句的热修 migration）。
- **三轮验证 08-24【触发前提修正】**：函数入口先查
  `user_companion_account_state WHERE global_enabled=true`（实库当前 **0 行**），
  循环根本不会进入——回归实际处于潜伏态，此前「下一次 01:00 即炸」表述过宽。
  精确前景：**第一个打开桌宠全局开关的用户会在当天 01:00 触发全站调度失败**
  （该用户及之后所有用户的日记入队每分钟抛 42P01 被 warn 吞掉）。热修紧迫度不变：
  该开关就是 companion 设置页的一个普通选项，触达只是时间问题。

### C-4【P2】`COMPANION_JOURNEY_V2` 不在 .env.example

- **位置**：`pet-profile-routes.ts:27` 与 inbox-routes 引用该 flag，但
  `.env.example` 没有它。照 example 配置的新环境：人格设置页与 SSE 收件箱 404，
  且无任何提示告诉你少了哪个开关。
- **最优解**：补进 `.env.example` 并注释其影响面。顺手做一次**flag 清单核对**：
  grep 全库所有 `COMPANION_*` 引用与 example 逐一对账，杜绝同类遗漏（预计还有）。
- **复核 08-24【属实且对账已完成】**：全库引用 15 个 flag 与 example 逐一对账，
  结果：**缺 2 个**——`COMPANION_JOURNEY_V2`（如登记）与
  `COMPANION_BRIDGE_V2`（新发现，companion-bridge 域引用、example 无此行）。
  其余 13 个均在 example 中。修 C-4 时两个一起补。三档预设块方案维持原案。
- **二次复核 08-24【属实；对账独立复现精确一致，范围须扩两处】**：15-flag 对账
  独立复现（服务端 process.env.COMPANION_* 恰 15 个、example 含 13 个、缺
  JOURNEY_V2 与 BRIDGE_V2）。两个应并入修复范围的补充发现：(1)
  **NEXT_PUBLIC_COMPANION_JOURNEY_V2 也缺席 .env.example 的 NEXT_PUBLIC 段**——
  web/lib/feature-flags.ts 读取它，浏览器 dev 场景 journey UI 恒关；desktop 路径
  由 web-manager 直接注入不受影响，但既然对账就该一并补；(2) **生产用
  docker-compose.yml 完全没有 COMPANION_JOURNEY_V2 / COMPANION_BRIDGE_V2 /
  COMPANION_MEMORY_STAR_MAP_V1 的环境变量透传**（dev 版 compose 有）——compose
  部署的生产栈连显式开启的通道都没有，flag 清单对账应扩展到 compose 文件。另注：
  三档预设块是 D-2 决策项，C-4 本身的最小闭环（补两行+注释）不应被 D-2 未裁决
  阻塞。

### C-5【P2】个性化提醒文案竞态 + 硬编码限频

- **位置**：SSE 先推模板文本，异步个性化覆盖（proactive-hook.ts:173-185）对已展示
  的气泡无效；24h 限频靠硬编码模板字符串 `'刚才的学习已完成，要继续吗？'` 双处
  复制比对（:149）。
- **最优解**：短期把模板字符串提为 shared 常量（消除双处漂移）；正式修法是
  delivery 未 ack 前允许 update payload + SSE 推 `delivery.updated` 事件，
  气泡收到后原地换文案；限频判断改查 `payload_ref->>'personalized'` 标记 +
  时间戳，不再做文本比对。
- **复核 08-24【属实】**：模板字符串双处复制确认（proactive-hook 内两处：SQL
  比对一处 + templateText 一处）；SSE 先推、异步 jsonb_set 覆盖已入队 delivery
  确认对已展示气泡无效。方案维持原案。
- **二次复核 08-24【属实；正式方案按字面实施会自毁，窗口定义必须改】**：双处
  复制确认且均在 proactive-hook 同文件内（SQL 频率比对 + templateText），全库无
  第三处也无 shared 常量。竞态机制逐步核实：客户端在展示瞬间就异步发了
  displayed ack 并推进游标，而 LLM 生成需 ≤2s，届时几乎总是已 ack；
  listInbox 按 inboxSequence 游标增量拉取，已越过的行不会被重推；SSE 协议只有
  单一 assistant.delivery 事件，不存在 delivery.updated。**关键修正**：正式方案的
  「delivery 未 ack 前允许 update」若指任意 ack 则方案失效——必须把窗口定义为
  「未达终态（acted/dismissed）前」或「创建后短 TTL 内」。两点补充设计：
  (a) SSE 以 inboxSequence 为 Last-Event-ID 游标，update 事件的重放/去重语义
  （复用原 sequence 还是独立序号空间）需先设计；(b) 限频标记应同时写时间戳进
  payload_ref。短期常量化正确必要，但注意它只消除漂移轴，文本比对的语义脆弱性
  （任何 text≠模板即被视为已个性化）仍在。

### C-6【P2】调度函数性能与日志虚高

- **位置**：`0171:52→104`——01 点窗口内每分钟对每用户先跑完 7 表活动 UNION 子查询，
  **之后**才撞幂等键；`v_inserted` 对 ON CONFLICT 也 +1，日志虚高。
- **最优解**：函数内调整顺序：先 `ON CONFLICT DO NOTHING` 探测占位（或先查已入队
  集合过滤），命中跳过的用户不做活动扫描；inserted 计数取真实 affected rows。
  单用户量级下非性能瓶颈，属于"顺序颠倒的正确性卫生"。
- **复核 08-24【属实】**：活动判定 7 表 EXISTS 在 INSERT 之前逐用户执行、
  `v_inserted := v_inserted + 1` 无条件自增（ON CONFLICT DO NOTHING 也计数）
  均确认。方案维持原案。
- **二次复核 08-24【属实；方案第一表述有暗坑】**：「先 ON CONFLICT DO NOTHING
  探测占位」若理解为先 INSERT 占位再扫活动，会把无活动用户也建出 job，破坏
  有活动门（正确性回归）——同一句话括号里的备选「先查已入队集合过滤」才是唯一
  安全实现：循环体内先对幂等键做廉价 EXISTS 探测（走既有唯一索引），命中跳过，
  再做活动扫描，INSERT 后用 FOUND 或 GET DIAGNOSTICS 取真实计数。反正 C-2 已要求
  发新 migration 重写函数，顺带完成零额外成本。

### C-7【P2】grounded tutor 分支完全绕过人格注入

- **位置**：`companion-dialogue.ts:404-408`——学习辅导模式下人格/记忆都不注入。
- **分析**：记忆不注入是 22 号 §11.1 的**有意隔离**（防污染正式学习），应当保留；
  但"语气"也被一并隔离了，而学习场景恰是桌宠人设最该出现的场景。
- **最优解**：grounded 分支 system prompt 允许追加**persona tone 段**（仅说话风格/
  称呼/口头禅，不含任何记忆内容），并显式声明"语气参考，不得改变事实来源约束"。
  若 Owner 认为学习场景就该切换成纯导师口吻，则维持现状并把该裁决回写 22 号文档
  ——关键是别让代码行为与文档双双沉默。
- **复核 08-24【属实】**：`groundedTutorContext ? GROUNDED_TUTOR_COMPANION_PROMPT
  : persona+记忆注入` 的分支确认——grounded 分支确实既无人格也无记忆。记忆隔离
  系 PRD §11.1 有意设计，维持隔离；tone 段方案成立，推荐维持原案（最终按 D-3'
  裁决）。
- **二次复核 08-24【属实；选 tone 注入路线时两个实施要点】**：分支与记忆隔离均
  原样确认（read 阶段无条件读了 pet_profiles 表但 grounded 分支不用）。要点：
  (1) **可观测性账目**——grounded 分支现以固定 prompt 的 sha256 记 prompt_hash，
  追加动态 tone 段后 hash 不再覆盖完整 prompt，需要 tone 模板版本化（hash 覆盖
  模板+引用 profile revision），否则 prompt 审计链断裂；(2) **注入硬化**——
  speakingStyle/catchphrase/examples 是用户可控输入，进入强约束的 grounded tutor
  prompt 有诱导越权风险，须沿用人格分支的长度上限并在 tone 段内显式声明「语气
  仅供参考，事实来源约束优先级更高」。若走维持现状路线，回写位置应是 PRD §11.1
  与 §12 人格章节双处。现有测试只断言 grounded 分支的证据约束，未锁定人格缺失
  为预期行为——代码与文档对该行为均沉默，正如审计所述。

### C-8【P2】日记模板干瘪，像系统周报不像日记

- **位置**：`buildSummaryText` 仅罗列五类数字；已采集的 pageContexts/jobs/
  对话消息数不入正文；highlights 采了最近 8 条对话却只在页面展示、不进摘要文本。
- **影响**：与页面"桌宠写给你的一页小记"的情感定位落差明显。
- **最优解**（不启用 LLM 也有明显改善）：确定性模板升级为三段式——
  ①一句基于事实的开场（挑当日最大变化项："今天你主要在推进《光合作用》，新增
  5 张学习卡"）；②引用 highlights 第一条用户原话（≤40 字，"你说：……"）；
  ③一句规则化收尾（连续 N 天有活动→肯定句；无活动→温和句）。LLM 润色位与
  500 字防御性截断已就绪，将来打开即可。
- **复核 08-24【属实】**：buildSummaryText 仅拼五类数字确认；facts 子查询已采集
  notes/jobs/runs 等计数但 highlights 不入摘要文本确认。三段式确定性模板可行，
  维持原案。
- **二次复核 08-24【属实；方案最优，三个落地注意点】**：(1) **200 字内存注入
  约束未被原案提及**——摘要会 `.slice(0,200)` 写入 assistant_memory_items（§9.4
  写端限长），三段式文本很可能超 200 被拦腰截断污染记忆注入文本；应控制模板
  总长 ≤200 或接受记忆侧截断并测观感。(2) 「引用第一条用户原话」注意 highlights
  按 created_at DESC 排序，取最早一条用户消息需反向找 role='user'，且 blocks
  聚合可能得空串（COALESCE ''），需空文本回退到下一条。(3) 收尾句的「连续 N 天
  有活动」需要一条新的 streak 查询（查此前已生成日期）。现有测试仅两条旧断言，
  三段式各分支（全空日、无用户发言、超长引用截断、≤200 字约束）落地时应补单测。

---

## 5. 三分钟微旅程衔接（方案 16 域）

### 5.1 主链实测

typed action 服务端唯一裁决 → createRunV2/resume → phase 机 → outbox 评估 →
Commit（epoch 复验）→ schedule 恰一 successor → 返回刷新：闭环成立。复习 OCC 真实
（generation 不匹配返回 stale 不猜测）。中途退出经 runId 直链精确恢复；草稿 CAS+
800ms 防抖串行队列、SSE+2s 轮询+lease 续租正常。语音作答真实接通。

### D-1【P1】提交失败零反馈，用户卡死在原界面

- **位置**：`useLearningRun.ts:481-495` 的 `submit()` 无 try/catch；调用方
  `LearningRunLivePlayer.tsx:166` 以 `void hook.submit(...)` fire-and-forget。
- **机制**：409 stale / 断网 / 5xx 一律成为 unhandled rejection。UI 层没有任何
  error state 变化——用户点提交后界面纹丝不动，既不知道失败也不知道该怎么办，
  反复点击也无济于事。对比：`dispatchAction` 有兜底重读，submit 这条**最关键**
  的路径反而是裸的。
- **最优解**：
  ```ts
  const submit = useCallback(async () => {
    setSubmitError(null);
    try {
      await doSubmit();
    } catch (e) {
      if (isConflict(e)) {
        setSubmitError("学习进度已在其他设备更新，正在刷新…");
        await refetchSnapshot();          // 409 → 拉最新快照接管
      } else {
        setSubmitError("提交失败，草稿已保存，请重试");
        // 草稿本来就有本地持久化，明确告知不丢
      }
    }
  }, [...]);
  ```
  Player 渲染 inline 错误条 + 重试按钮（aria-live="assertive"）。
  附一条模拟 409/断网的交互测试。
- **复核 08-24【属实，补一个连带修复】**：submit 无 try/catch、调用方
  `void hook.submit(...)` fire-and-forget、对照 dispatchAction 有 catch+重读兜底，
  三点均确认。原案维持；**必须连带修**：各 renderer 的提交 busy-lock 只在 task
  对象身份变化时复位（F22 机制），提交失败后 task 不变——不复位的话按钮永久卡
  "正在提交…"，用户连"按报告说的重试"都做不到。失败路径上需显式通知 renderer
  复位（如 submitError state 变化作为 reset 信号）。
- **二次复核 08-24【属实；submit 原样未修，N-4 比登记更重且分题型】**：submit
  （useLearningRun.ts:481-495）全程无 try/catch 确认，调用方 fire-and-forget
  确认，对照 dispatchAction 有兜底反差属实；apps/web/features/learning-run/
  整目录无在途改动。**N-4 细化**：StructuredBundleTask 的锁仅按 taskId 变化
  复位——失败后即使 lease 推高 activeSecondsUsed 使 task 引用更新也不解锁，
  **structured_bundle 失败后按钮必然永久锁死**；其余 7 个 renderer 的 [task]
  身份复位靠 lease 每 15s 表面变化（约 ≤17s 自解），但 run-service 的计费封顶
  （min(180,...)）到达后同样转永久锁死。因此 submitError 复位信号必须穿透
  TaskRenderer 到全部 8 个 renderer（含 bundle 的 taskId 键控变体）。执行注意：
  (1) 测试现状为零覆盖（useLearningRun.test.ts 只测纯函数；TextResponseTask 只测
  锁定成功路径），409/断网交互测试必须补；(2) 重试按钮复用原提交键即可，注意
  解锁瞬间的单飞防双发；(3) 文案「草稿已保存」基本准确（800ms 防抖落服务端草稿）。

### D-2【P1】commit 冲突 fail-closed 误入不可自愈死局

- **位置**：`run-processing-tick.ts:978-1011` 的 `revalidateV2CommitEpochs` 在
  fingerprint/generation 漂移时抛 `CriticOutputError`（fail-closed，方向正确）；
  但 `:120-171` 的通用 catch 把它当成普通评估失败 → run 置
  `recoverable_error(commit_conflict, retryable=true)`。
- **机制矛盾**：retry_commit 必然再次触发同样的 epoch 校验失败——`retryable=true`
  指向一条**数学上不可能成功**的重试路径。方案 16 §8.5 的设计意图是这种情况应
  终态化为 stale 并引导新 Run，现在的行为与之相悖。用户只剩 end 一个出口，
  且界面上是一个看似"稍后重试就好"的误导性状态。
- **最优解**：在 catch 中按错误类型分流——识别 commit_conflict（或让
  revalidateV2CommitEpochs 抛专用错误类型）→ 直接终态化 run 为 `ended(stale)`，
  reasonCode 带 `commit_conflict_stale`；前端对该终态渲染"这次练习未能存档
  （学习目标已被更新），开始新一轮"CTA，走既有 createRunV2。**顺带修 D-3**：
  该终态 UPDATE 加 `WHERE status='processing'`（或 phase 白名单），0 行即放弃，
  消除与用户并发 end 的竞态。
- **复核 08-24【属实】**：revalidateV2CommitEpochs 对 objective lifecycle epoch
  与 evidence eligibility epoch 漂移抛 CriticOutputError 确认；通用 catch 不分流、
  一律置 `recoverable_error(commit_conflict, retryable=true)` 确认——重试必然
  复现同一漂移，死局成立。16 号文档 683 行"内容 fingerprint 或 schedule generation
  变化 → Run 进入 stale，解释原因并创建新 Run"设计意图原文在案，报告与文档的
  相悖判定成立。专用错误类型分流方案维持原案。
- **二次复核 08-24【属实且比登记更糟；方案成立，四点执行要求】**：死局机制逐步
  复核成立（epoch 单调只增、usable→revoked 无回退写点，重试数学上必败）。
  **加重情节**：审计称「用户只剩 end 一个出口」——实测该出口也是坏的：end 的
  phase 白名单只有 preparing/active/paused（assessing/committing 需 abandon=true，
  recoverable_error 落入 else → invalid_phase 409），**用户在 commit_conflict 下
  连 end 都发不出去，完全被困**。集成测试只断言 allowedActions 广告含 end、从未
  实际执行，故漏检。前端零新增成本确认：stale 终态消费链路已全线就绪（Player
  已渲染 stale 终态卡带 create_fresh_run CTA）。执行四点：(1) 直接用既有
  `phase='stale'` + terminalReasonCode='commit_conflict_stale'，勿自造 ended(stale)
  混合表述；(2) 终态化事务追加 learning_run.ended/stale 领域事件驱动 SSE/轮询
  刷新；(3) **顺带补 end-from-recoverable_error 的白名单缺口**（否则修复前用户连
  手动脱困都不可能）；(4) 验收测试覆盖「注入 epoch 漂移→retry 必败→终态 stale」
  与「并发用户 end 后结算不再翻转终态」（即 D-3 用例）。

### D-3【P2】失败结算 UPDATE 仅按 id，可与用户 end 竞态翻转终态

- **位置**：`run-processing-tick.ts:134-149`。
- **最优解**：见 D-2 顺带修。一行 WHERE 条件。
- **复核 08-24【属实】**：失败结算 UPDATE 仅 `eq(learningRuns.id, row.run_id)`
  无状态条件确认。一行 WHERE 维持原案；建议顺带 grep 该文件其余终态写点，
  确认无同型裸 UPDATE（本次抽查未发现第二处，但不加防线）。
- **二次复核 08-24【属实；grep 落实，发现第二处同型裸写】**：竞态真实可达性
  确认（用户 end 先提交后，结算 catch 无条件覆写回 recoverable_error；此后
  retry_commit 因 phase 门静默 no-op——run 永久滞留错误态且重试无可见效果）。
  **文档要求的 grep 已做：成功结算写点 :1245-1247 存在同型裸 UPDATE**（其前置
  phase 读非 FOR UPDATE，存在同类 TOCTOU 窗口，可将用户 ended 覆写为 completed
  并产生 result——危害较轻但同型），宜与失败写点一并加 phase 白名单条件统一
  防线。0 行放弃分支应有 stderr 日志观测竞态频率；测试覆盖并发 end×结算两序。
  与 D-2 合并实施合理。

### D-4【P2】`generation ?? 0` 兜底掩盖上游数据缺失

- **位置**：`review/page.tsx:280` 与 `review/service.ts:538` 双处 `?? 0`；
  generation<1 时 new 页 `buildCreateV2Request(:192)` 返回 null，页面只显示
  "该入口尚未开放"。
- **后果**：schedule 数据异常（generation 缺失）被静默降级成一个与真相无关的
  模糊文案，无法诊断。
- **最优解**：service 层将 generation 缺失视为数据异常，返回专用错误码
  `SCHEDULE_GENERATION_MISSING`；Review 页据此显示"该复习计划数据异常，请刷新
  或重新进入"；删除两处 `?? 0`。
- **复核 08-24【属实】**：web review 页 `generation: String(item.generation ?? 0)`
  与 api review service `item.review.generation ?? 0` 双处兜底确认；service 层
  另一处（111-112 行）已有严格校验 `!Number.isInteger || <1`——说明正确姿势在
  同文件已存在，538 行属于漏网。方案维持原案。
- **二次复核 08-24【代码事实属实；后果高估近 P3，方案有两个坑】**：两处兜底仍在
  但机制比登记轻：(1) db schema 中 generation 列 `NOT NULL DEFAULT 0`——`?? 0`
  两侧都不可能实际触发，纯死代码；(2) 唯一可达症状是 legacy generation=0 死胡同
  行，而 V1 卡栈已退役（0183 删表）、当前写入路径全部 ≥1，异常行现树近乎不可达。
  定级建议降 P3。方案两个坑：(a) 若对整个 sanitized 队列做「无 generation≥1 即
  抛错」，**一条 legacy 行会炸掉用户整页复习队列**——比现状更糟；必须限定
  isV2===true 的项才判异常或逐项跳过标记；(b) 「generation 缺失」措辞不准，列
  NOT NULL，真实信号是 generation<1。更优替代：在途的 projectReviewQueueV2 +
  /reviews/v2/queue 已实现完全相同的严格投影，让 web review 页迁移到该端点即可
  自然消灭两处兜底，无需为 legacy 端点发明新错误码；若保留原案则错误码方案可
  接受但需补测试（当前该异常路径零测试）。

### D-5【P2】V2 wire 合同漂移：/v2 端点全套无人消费

- **位置**：API 侧 run-routes.ts:254-660 的全套 /v2 端点已建成；web 客户端
  （lib/api.ts）几乎零使用，V2 run 全程走 V1 wire；`returnTargetV2` 字段服务端
  返回但从未被消费，导航靠 LivePlayer 手工映射 V1 returnTarget。
- **定性**：不是运行时 bug（V1 wire 工作正常），但是**假合同**——存在的代码
  让人以为前后端已经 V2 直连。
- **最优解**（推荐渐进切换，共约 2 天）：第一步切 run create/resume 两个命令到
  /v2（收益最大：typed originV2 直达，消灭手工参数拼装）；第二步事件流与
  returnTarget 切 /v2；完成后删除 V1 兼容壳。若决定长期保留 V1 wire，则删除
  `returnTargetV2` 死字段并在 16 号文档注明裁决——同样不允许双向沉默。
- **复核 08-24【属实】**：web 侧 grep `learning-runs/v2|/v2/resume|returnTargetV2`
  零命中确认——全套 /v2 端点与 returnTargetV2 字段当前无任何前端消费。
  渐进切换方案维持原案。
- **二次复核 08-24【前提已被在途改动实质推翻；两分支今日均不可照做】**：web 侧
  事实全部核实成立（api.ts 仅 V1 路径，V2 create 只取 runId 即重定向）。**但登记
  的「全套无人消费/假合同」定性失效**：工作树新增的未跟踪目录 apps/desktop-client
  是 V2 合同的真实原生消费者——desktop-gateway.ts:909-1157 消费全部七个 /v2 端点
  （含 /reviews/v2/queue），learning-run-return-resolver.ts 直接消费
  returnTargetV2/fallbackTargetV2 做导航解析；run-routes 注释亦明言 desktop client
  never consumes V1。现实已经替项目选择了「双合同各有真实消费者」的路线。因此：
  (a) 「删除 returnTargetV2 死字段」明确不可行（会打断在途桌面集成）；
  (b) 「web 渐进切换后删 V1 壳」作为缺陷修法不再成立（web=V1 自洽可用）。剩余
  动作只有文档裁决一支：在 16 号文档注明 web=V1 兼容客户端、desktop=V2 原生。
  方案细节勘误：「事件流切 /v2」不存在对应端点——SSE 只有单一 events 路由，
  V2 绑定靠 snapshotId 查询参数而非独立 /v2 路由。定级降为「文档如实化」项，
  不再是缺陷级 P2。

### D-6【P2】hint 曝光按 run 全局查询，污染后续任务快照哈希

- **位置**：`run-service.ts:2503-2508` 查询曝光 ledger 无 taskId 过滤。
- **影响**：当前单任务制下影响有限；一旦启用 followup 补题（activate_followup
  已存在），早前任务的 hint 会污染补题任务的 assistanceSnapshotHash。
- **最优解**：查询补 `AND task_id = ?`。一行改动，趁记得时顺手修。
- **复核 08-24【属实】**：run-service 中 hint 曝光查询只按
  `runId + eventType = "learning_task.hint_requested"` 过滤、无 taskId 确认。
  一行修法维持原案。
- **二次复核 08-24【属实；方案最优，一处必要修正 + 范围克制】**：污染路径机械
  成立（任务 1 请求过提示后，followup 补题任务 2 的 artifact 会被任务 1 的曝光
  事件污染）。**必要修正**：`learning_run_events` 表没有 task_id 列——taskId 只
  存在于 payload jsonb 内，一行 WHERE 不能字面写成 `AND task_id = ?`，应写
  `sql\`payload->>'taskId' = ${taskId}\``（写入侧键名为驼峰 taskId 已核实；
  run-scoped 行数极小无索引亦可）。范围上应克制：只改 submitArtifact 这一处
  per-artifact 快照点；hasHintExposure 与 backfillPresentationHistory 两处 run 级
  查询是故意的 run 级语义（本轮任何曝光则本 run 不进 canonical），一并加过滤反而
  改变结算行为，不要顺手改。

### D-7【P2】rendererState 恒写 text 占位，结构题中间态不持久化

- **位置**：`LearningRunLivePlayer.tsx:246-247` 恒写 `{kind:"text",selection:0}`。
- **影响**：ordering/relation 的拖拽、连线等中间状态跨设备恢复不了，与 §8.5
  "结构操作状态恢复"不符。
- **最优解**：renderer 接口增加可选 `serializeState(): unknown`，Player 统一写入
  rendererState；首期只接 ordering 与 relation_canvas 两个 renderer 即可覆盖
  全部结构题。
- **复核 08-24【属实】**：LivePlayer 恒写 `{kind:"text", selectionStart:0,
  selectionEnd:0}` 确认。方案维持原案；注意与 A-2 复核联动——若采纳止血方案①，
  首期接的应是 ordering 与 relation（而非 relation_canvas），以最终落地的 kind
  注册表为准。
- **二次复核 08-24【代码事实属实；影响高估近 P3，原案有三处硬缺口】**：恢复侧
  同样断链确认（GET 回的 rendererState 被完全丢弃）。但登记的影响被高估：结构题
  的答案态中间态其实**已经由 payload 持久化并跨设备恢复**——ordering 序列/
  relation 边/bundle 分部进度全部在 payload 内序列化、恢复侧逆映射回各 renderer；
  真正丢的是 rendererState 通道本应承载的细粒度 UI 态（焦点/激活分部/选区），
  是一条死的合同通道而非「拖拽连线中间态恢复不了」。实质近 P3。按原案落地会
  失败的三点：(1) **合同先行**——putLearningTaskDraftRequestSchema 复用的
  learningRendererDraftStateSchema 是 strictObject 闭联合同（voice/text/
  structured 三型），`serializeState(): unknown` 直传会被 zod 校验 400 拒收，
  必须先在 packages/shared 扩充 discriminatedUnion；(2) **只写了半边**——Player
  不读 rendererState，没有 deserialize/hydrate 对应端就是零收益死写；(3) kind
  命名等 A-2 注册表落地后统一。另注：rendererState 与 payload 一起静态加密落库，
  扩展形状不影响加密路径。补齐三点后方案可行。

### D-8【观察项】多轮交互受限是已知取舍，需文档如实化

skip_task 终结整个 run；仅 partial/not_assessable 可经 activate_followup 补一题。
处理方式并入产品决策 D-1（§2.3）——无论选哪条路线，把"一题+可选补题"的实况
写回文档是必做项。

> **复核 08-24**：D-8 属实（planV2Run 三处 `tasks: [task]` 确认），并入 D-1
> 处理合理，维持。

### 新发现（复核 08-24 登记）

复核中发现的 4 个未登记问题，随本表一并追踪：

| # | 问题 | 定级 | 说明 |
|---|---|---|---|
| N-1 | `.env.example` 另缺 `COMPANION_BRIDGE_V2` | P2 | 并入 C-4 一并补 |
| N-2 | `preferredStrategies` 有真实勾选 UI（GenerationControls），非仅合同暗示 | P2→加重 | 见 A-5 复核标注，强化选方案 (a) 的理由 |
| N-3 | relation_canvas 断裂的唯一入口恰是 goal=repair 旅程 | 已并入 A-2/A-4 | 用户带着明确修复诉求进来却撞空屏，修复优先级上调 |
| N-4 | 提交失败后 renderer busy-lock 不复位，重试按钮按不了 | 并入 D-1 | 见 D-1 复核标注，为 D-1 验收必查项；二次复核：bundle 永久锁死、其余 renderer 180s 封顶后转永久，见 D-1 二次标注 |

---

## 6. 消费面一致性（方案 23 目标）：达成 ✅

以下经逐一抽查确认（2026-08-23），作为正面基线记录：

| 检查项 | 结果 |
|---|---|
| 首页 | ✅ DashboardHome 单一 `/v2/learning-dashboard` 聚合驱动，degraded 显式渲染，primaryFocus typed action |
| 卡库 | ✅ 仅剩 ObjectiveLibrary，无 V1/V2 数组合并 |
| 详情/Today/星图/首页跳转 | ✅ 全部经 action-navigation.ts 单一实现，无 label 推断 |
| 搜索 | ✅ 索引 conceptLabel/publicSummary/来源标题，不含答案/rubric（CS-03 注释在案） |
| Stats | ✅ objective 口径 + alias 规则 subjectType='card'/subjectId=objectiveId |
| 导出 | ✅ objectivesV2/objectiveRevisionRows 分块导出 |
| 星图 adapter | ✅ 旧的 key_point 映射 projection-adapter.ts 已删除，仅 UnderstandingGraphV3 |
| Bridge | ✅ context-hydration 逐 EntityRef RLS 内校验，fail-closed 签发 |
| 方案 23 §0.2 三项登记 | ✅ 确定性缓存哈希 / 首页单一事实源 / 自播种测试夹具均已落地 |

**观察项 O-1**：Today 页除 dashboard 外仍并发拉 notes/reviews/jobs/sources 四源
（today/page.tsx:419-423）。dashboard 是主内容源（recentObjectives 取自它），
Today 页职责本是聚合今日视图，判定为可接受混合态；但若未来 counts 出现
首页↔Today 口径分歧，此处是第一个排查点。登记备查，不需行动。

---

## 7. 文档治理与出厂配置

### E-1【治理】"Implemented" 标签可信度被稀释

22 号 PRD 状态 Implemented，但本轮实证以下承诺未落地：cue_class 抑制（§11.5）、
memoryRefs 删除入口（§3.6.2）、"忽略 30 天不弹"（§2.2.4）。20 号的多 Task 序列、
多题型叙事与实况（单任务制）也有明显落差。

**制度建议**：今后凡 PRD 中"承诺用户可感知行为"的条目，实施时在条目旁就地打钩或
标注"未实施"，而不是只在文档头部维护一个整体状态。整体状态只回答"主体完成了吗"，
条目级标注才回答"这个功能到底有没有"。本轮已把偏差逐条登记于本文对应章节，
修复时同步回写。

### D-2【产品决策】出厂 flag 默认值

现状：`.env.example` 全关 → 新环境桌宠/记忆/日记静默不存在；本机 .env 全开。
这不是 bug，是需要一个明确决定的配置策略：

- **推荐**：`.env.example` 提供**三档注释好的预设块**——
  `# --- Companion: off（默认）---` / `# --- Companion: dev（记忆+日记开，主动提醒 moderate）---` /
  `# --- Companion: full（全部开）---`，默认仍 off，但把"怎么开"从考古变成抄写；
  同时借 C-4 的 flag 对账把清单补全。

### 其余决策项汇总

| 编号 | 问题 | 推荐 |
|---|---|---|
| D-1 | 多题型/多任务形态 | 选 a：如实化文档 + 打通 relations/repair 存量资产 |
| D-2 | 出厂 flag 默认 | 三档预设块，默认 off |
| D-3' | grounded tutor 是否注人人格语气 | 注入 tone 段（保留记忆隔离），或维持并回写文档 |
| D-4' | A-6 长事务改造排期 | 登记，1 天工作量，勿无限期挂起 |

---

## 8. 修复优先级总表

> **二次复核 08-24 调整**：A-1 已在途修复（余项为 e2e 测试）；A-2 建议降 P2；
> D-4/D-7 降近 P3；D-5 改判文档如实化项。新发现 N-5/N-6/N-7（P1）插入第一批；
> N-8…N-13 按域插入第二批；N-14…N-20 归入第三批或随域顺带。各条目方案的执行
> 要点以正文「二次复核」标注为准——A-3/B-4/C-5/D-4/D-7 五条方案已修正，
> 勿按原案字面实施。

### 第一批：P1（影响正确性/体验，单项改动都不大，合计约 2-3 天）

| # | 问题 | 章节 | 预估 |
|---|---|---|---|
| 0 | N-7 候选审核三动作空 hash 恒 409（三处传真值即可）+ N-6 V2 轮询纳入 needs_attention + N-5 验证开发库 CHECK 约束并放宽 | §10 | 合计 ~0.5d |
| 1 | D-1 submit 错误反馈（含 busy-lock 复位，见 N-4 二次标注：须覆盖全部 8 个 renderer） | §5 | 0.5d |
| 2 | D-2+D-3 commit 死局改 stale 引导 + UPDATE 条件（含成功结算写点同型防线、end-from-recoverable_error 白名单缺口） | §5 | 0.5d |
| 3 | A-1 ~~buildObjectivePatch 字段路径~~ 已修复 → 余项：edit→recheck→reveal→落库 四步 e2e 测试 | §1 | 0.25d |
| 4 | A-2 止血：planner 关系变体回退 text 分支（条件含 requiredEdges>1；renderer 映射另立项）+ kind↔renderer 一致性测试 | §1 | 0.5d |
| 5 | B-1 dismiss 提取端去重闸（查询池扩 active+candidate 同解 B-4） | §3 | 0.5d |
| 6 | C-2 日记触发窗 1→6 点（函数重写须一并处理 C-3/C-6 与 0183 DROP learning_cards 的交互） | §4 | 0.5h+ |
| 7 | C-1 cue_class 抑制（或先把 PRD §11.5 改为未实施） | §4 | 0.5d / 10min |

### 第二批：P2 卫生批（多为小改动）

A-3 节点标签（按二次复核修正案：flattenAnswerUnits 零查询）、A-4 repair 映射
如实化、A-5 preferredStrategies 接线（planner+author 双 prompt 注入）、
A-7 rubricHash 复算、B-2 flag 门控统一（helper 须覆盖 delivery 读取面三条路由）、
B-3 删除入口（直接做菜单版）、C-1 撤销入口补齐、C-3 user 过滤、C-4 flag 对账
（扩 compose 文件与 NEXT_PUBLIC 段）、C-5 模板常量化、C-6 调度顺序（先探测后扫描）、
C-8 模板三段式（≤200 字约束）、N-8 个性化外发 consentOk 门控、N-9 deliveries
TTL 清理、N-10 snooze 接通、N-11 时区校验 fail-closed、N-12 账号首写字段补全、
N-13 Critic 回写 CAS 守卫、D-4 generation 兜底（迁 /reviews/v2/queue 或 isV2 限定）、
D-6 hint 过滤（payload->>'taskId' 谓词）。D-7 降 P3 移第三批。

### 第三批：结构与决策批

A-6 两阶段事务（清单按二次复核扩：三条复用路径+租约联动，或先做 grounding
单阶段重试止血）、~~D-5 wire 合同切换~~ 改判为 16 号文档注明 web=V1 兼容/
desktop=V2 原生裁决、D-1/D-2/D-3'/D-4' 产品决策、§7 条目级标注制度、
D-7 rendererState 序列化（先扩 shared 合同+补恢复半边）、N-14 多工作区日记口径、
N-15 inboxSequence 取号统一、N-16 embedding 版本检测、N-17 highlights 级联删除、
N-18 pet_profile CAS 谓词、N-19 23505 转 stale。

### 验收口径

- 第一批全部落地后：五路审查中所有"用户会卡死/看到空白/操作无效"的场景复测通过；
- 每项修复按项目惯例回写本文状态列 + 对应 PRD 条目级标注；
- kind↔renderer 一致性测试、dismiss 去重单测、commit stale 终态测试进入常规套件。
- 二次复核增补：N-5 类「测试 mock 掉真实约束」的漏检模式要针对性补测
  （delivery INSERT 走真实 schema 校验）；N-6/N-7 的失败面各补一条交互测试。

---

## 9. 修复状态追踪

| # | 问题 | 状态 | 修复记录 |
|---|---|---|---|
| A-1…A-7 | 卡生成 | A-1 **Fixed-in-worktree（余 e2e 测试）**；其余 Open（二次复核：A-3/A-5 方案已修正，A-2 建议降 P2） | A-1 见 §1 二次标注 |
| B-1…B-4 | 桌宠记忆 | Open（二次复核：B-2 场景证伪改判静默浪费；B-4 并入 B-1 实现；B-1/B-3 方案确认最优） | — |
| C-1…C-8 | 日记/提醒/人格 | Open（二次复核：C-2 补充方案枚举值改 'dead'；C-5 窗口定义必须改；C-6 实现路径定死为「先探测后扫描」；C-2/C-3/C-6 函数重写须一并处理 0183 DROP learning_cards 回归） | — |
| D-1…D-7 | 微旅程 | Open（二次复核：D-2 比登记更糟——end 也发不出须顺带补白名单；D-3 发现第二处同型裸写 :1245；D-4/D-7 降近 P3 且方案修正；D-5 前景被 desktop-client 推翻、改判文档项；D-6 谓词形态修正） | — |
| N-1…N-4 | 新发现（一轮复核） | Open（并入 C-4/A-5/A-2/D-1 追踪，见 §5 新发现表） | — |
| N-5…N-20 | 新发现（二轮盲区补扫，§10） | Open；三轮对抗验证 15 条全部成立（N-7 错误码机制修正、N-11/N-14 升 P2、N-19 触发面修正、N-15 捆绑警告） | — |
| N-21…N-24 | 新发现（三轮 identity/note 域补扫，§11） | Open（P1×1：removeMember 可驱逐属主致账号死锁，已亲核；N-22 为在途 diff 回归，已亲核） | — |

> **复核结论汇总（2026-08-24，一轮）**：27 条登记问题逐条沿真实数据流验证——25 条
> 完全属实、2 条比登记更重（C-4 另缺 `COMPANION_BRIDGE_V2`；A-5 有真实用户 UI）、
> 0 条被推翻。方案级修正仅 A-2 一处（映射 RelationTask 因数据形状不同构不可行，
> 改为 planner 回退止血 + renderer 另立项）；补前提四处（A-1 mergedDraft 同坑、C-2
> failed 重入队残余缺口、C-3 sources/cards 列名分叉口径、D-1 busy-lock 连带修复）。
> 其余方案经前提核验（pg_trgm 在库、16 号 stale 意图原文、DELETE 路由可复用等）
> 均可按原案执行。
>
> **二次复核结论汇总（2026-08-24，11 路独立验证 + 3 路盲区扫描，以当时工作树为准）**：
> 26 条再验——24 条属实、2 条部分属实（D-4/D-7 后果高估近 P3）、0 条被推翻；
> A-1 已被在途改动修复且实现与方案吻合。方案级硬伤 6 处并已就地给出修正案：
> A-3 标签来源张冠李戴（改 flattenAnswerUnits 零查询）、B-4 主杠杆已是现状
> （并入 B-1 查询池扩展）、C-5 「未 ack 前 update」按字面会自毁（窗口改未达终态前）、
> D-7 缺合同扩展与恢复半边（影响实近 P3）、D-4 异常判定须 isV2 限定否则一条坏行炸
> 全队（更优替代：迁 /reviews/v2/queue）、D-5 两分支均不可照做（desktop-client 已
> 全面消费 /v2 与 returnTargetV2）。另 C-2 补充方案的 jobs 终态枚举 'failed' 应为
> 'dead'；B-2 登记的「气泡弹按钮 404」场景被数据流证伪。新发现 16 条登记于 §10，
> 其中 N-5（memory_candidate 违反 CHECK 约束）动摇 §3.1 自动提取正面基线、N-6/N-7
> （V2 失败永久卡死 / 候选审核三动作恒 409）均为用户完全无出路的死局级缺陷，
> 三条已插入第一批。

---

## 10. 二次复核盲区补扫新发现（2026-08-24）

三路独立盲区扫描（卡生成+微旅程 / companion 全域 / 横切面）在既有审计之外发现的
问题。P1 三条均经主会话亲自二次核实；行号为 2026-08-24 工作树。

#### P1

**N-5【P1】memory_candidate 违反 assistant_deliveries CHECK 约束：记忆提取事务整体回滚**

- 0131 迁移的 `assistant_deliveries_kind_check` 只允许 5 种 kind
  （message/proposal/action_result/proactive_cue/system_event），而 extractor 写入
  `'memory_candidate'`（companion-memory-extractor.ts:277）；全库无任何迁移放宽过
  该约束（已穷尽 grep）。INSERT 报 23514 → 候选记忆、delivery、memory_links 整个
  事务回滚 → job 重试再烧一次 LLM 仍失败 → dead。
- **后果**：照 migrations 新建的环境里确认气泡永不出现、jobs 持续产生死信。
- **【已实库验证 2026-08-24】**：开发库实测约束即窄版 5 值，探针 INSERT
  `memory_candidate` 直接 `violates check constraint`。历史上未爆是因为运气而非
  正确：8/20 的 4 个提取 job 全部 succeeded 系 LLM 未产出阈上候选（置信过滤提前
  return）；8/22 后的对话全是 bridge action 提案（不经 dialogue 管道、不触发提取
  入队）——约束炸点至今零次触达。现有测试用 fakeTx mock 掉真实 SQL 故全绿——
  测试未覆盖真实约束是漏检根因。
- **修法**：新 migration 放宽 CHECK 纳入 memory_candidate（shared 合同早已含该
  枚举）；并补一条走真实 schema 的 delivery INSERT 测试防回归。

**N-6【P1】Web V2 生成失败永久卡死：轮询不识别 needs_attention 且 localStorage 封死入口**

- worker 失败落点 failV2OutboxJob 置 `card_generation_runs_v2.status='needs_attention'`
  （V2 唯一真实失败态）；但 NoteEditor V2 轮询的终态判定只含
  failed/terminal_failed/cancelled/closed_without_activation（NoteEditor.tsx:1169-1173），
  不含 needs_attention——plan 404 后走「还没生成继续等待」分支，1.5s 无限轮询；
  run.error 已下发但该分支不读。v2Run progress 态写入 localStorage，刷新/重启浏览器
  都恢复轮询；重试按钮只在 error 态渲染，progress 态无逃生入口。CandidateReviewPage
  直连 URL 同病。已有的 needs_attention 处理弹窗挂在另一条已退役的 V1 数据源上，
  救不了这条链路。
- **后果**：确定性失败（author schema 持续违规/provider 缺失等）后，进度弹窗永久
  停留「正在判断什么值得练」，除手改 localStorage 外无法复位，该笔记的生成入口
  永久失效。
- **修法方向**：轮询终态判定纳入 needs_attention（读取 run.error 渲染失败面 +
  重试入口）；CandidateReviewPage.boot 终态数组同步补。
- **三轮验证 08-24【CONFIRMED，加重实证】**：实库现存一例 needs_attention、
  零例 failed——V2 状态机里 'failed'/'terminal_failed' 均为无写入方的死值，
  **轮询盲区覆盖 100% 的确定性失败**而非部分。关键分叉裁定：NoteEditor 已有的
  needs_attention 弹窗数据源是 `GET /card-generation-runs/:id`（无 /v2 前缀），
  服务端唯一注册的是 /v2 路由、legacy 模块已在 commit e145dd9 删除——该链路
  **恒 404，是死代码**，救不了本条。修法三坑：(1) CandidateReviewPage 仅往终态
  数组追加会得到空白页（plan=null 时渲染被守卫跳过），须补专门失败 UI；(2) 项目
  已有三份手抄状态列表，应改为从 shared 的状态枚举派生「非成功终态」，否则下次
  新增状态再漏；(3) 重试入口要新造幂等键并处置旧 run，建议进度弹窗补 cancelRun
  手动逃生口——任何未知终态都不应封死入口。

**N-7【P1】候选审核 reject/undo_reject/merge 提交空 expectedRevisionHash，服务端恒 409，三个审核动作在 Web 上永不生效**

- CandidateReview.tsx 中 reject(:263)/undoReject(:291)/previewMerge(:398) 均提交
  `expectedRevisionHash: ""`，merge 分支还把空 hash 复制给所有 expectedRevisions；
  服务端 getCandidateForAction 严格比对 candidateRevisionHash !== expectedRevisionHash
  即抛 stale_revision 409（helpers.ts:392-394），64 位 hex 永远不等于空串。前端
  catch 后回滚乐观更新。keep(:231)/edit(:352) 传真值正常，形成对照。
- **后果**：「不保留」「撤销不保留」「合并预览」点了永远弹「提交失败已恢复」，
  web 完全失去剔除劣质候选与合并碎片候选的能力（仅能 close 整单放弃）。
- **修法方向**：三处改传 `item.revisionHash`（与 keep/edit 一致）。
- **三轮验证 08-24【PARTIAL：结论成立，错误码机制有误】**：功能结论不变——
  三个动作每次必败、前端回滚乐观更新（实库佐证：candidate_feedback 仅 23 条
  keep、0 条 reject/merge/undo）。但登记的「服务端恒 409」不对：zod 合同要求
  hash 匹配 64 位 hex，空串在路由层 parseBody 即被拒为 **400 BAD_REQUEST**，
  根本到不了 stale_revision 分支。修法修正：「改传真值」对 reject/undoReject
  成立，对 **merge 不成立**——装配层会把同一 hash 盖到全部 expectedRevisions，
  目标候选 revision 对不上会先撞 404 candidate_not_found；须扩展本地请求类型
  携带逐候选 {revision,revisionHash} 或在 page 层反查组装。若补回归测试勿断言
  409。

#### P2

**N-8【P2】主动个性化文案将用户记忆原文发往外部 LLM，绕过全部 AI 同意检查**
proactive-hook 与 proactive-generator 直接读 CRITIC/DASHSCOPE 配置发外部请求，
均无 consentOk 门控——对照 dialogue/extractor/summarizer 三处都有强制检查。
工作区撤销 AI 同意后对话与记忆功能全部拒绝，但学习结算仍可把最多 3 条×200 字
长期记忆原文送第三方端点。隐私级缺口，修法：两处补齐与同文件族一致的 consentOk
门控。
- **三轮验证 08-24【CONFIRMED，两处精确化】**：两文件全文读毕确无治理层；上游
  兜底排查为否——唯一触发链 run-processing-tick 全程无 consent 检查，api 侧全仓
  唯一的 consent 门在 session-routes（episode answer 时点），run 七个写端点零覆盖，
  入队后撤销同意也不复检；传输层只做 HTTPS+SSRF 校验。本部署该路径**实际在线**
  （.env 个性化 flag=true、CRITIC_URL 指向 dashscope），而 workspaces.ai_data_policy
  默认 sendToExternal=false。精确化两点：(a) 记忆原文外发仅发生在个性化分支
  （受 flag 控制）；generator 分支外发的是学习元数据且不受 flag 控制；
  (b) 实施要点——门放在 hookProactiveOnRunCompleted 事务内、读取 topMemories
  **之前**（不读即不发）；失败语义必须 fail-closed，不能沿用本文件既有的
  fail-open catch 风格；api 侧无 resolveAIGovernanceContext 等价物，直接读
  workspaces 的 consent 字段，勿造第二套判定标准。同链的 Critic 调用与 PII 脱敏
  是否同批补齐需一并决策，否则治理面依旧裂缝。

**N-9【P2】assistant_deliveries 无 TTL 清理且 listInbox 不过滤 expires_at**
全库无任何代码写 state='expired'；ttl-maintenance 清理的是另一张表；
assistant_deliveries 只增不删。用户离线一天回来，SSE 重推已过期十余小时的提醒
以新鲜文案弹出；新设备 cursor=0 首连需重放全部历史 delivery。
- **三轮验证 08-24【CONFIRMED，实库佐证 + 修法修正】**：全仓穷举确认无任何
  expired/suppressed 写入方、无触发器；TTL 维护函数实测目标是另一张表。
  **实库现状：assistant_deliveries 63 行全部 queued，其中 62 行 expires_at 已过**
  （最早四天前）。加重事实：claimDisplayLease 同样不校验过期，过期行可被正常
  租约展示；客户端按 state 跳过的判断因服务端永不置 expired 而是死代码。修法三坑：
  (1) 不能在 listInbox 全局过滤 expires_at——timeline 审计端点依赖看见过期行，
  应只在 SSE 泵路径过滤或加 includeExpired 参数；(2) 清理优先选状态迁移而非
  DELETE（保住 timeline 审计历史，且客户端既有跳过逻辑零改动生效），表是 FORCE
  RLS 须走 SECURITY DEFINER 函数（照抄 ttl-maintenance 同伴模式）；现有
  (state,expires_at) 索引恰好服务该谓词——当初规划了没做；(3) snoozed 行策略要
  与 N-10 一并决定（ackDelivery snoozed 只延租约不改行级 expires_at，修完 N-10
  会立刻在这里再爆一次）。

**N-10【P2】气泡「稍后提醒」实发 transition=dismissed，提醒永不再现**
PetDeliveryLayer onSnooze 调 inbox.dismiss(30)；客户端 finishCurrent 仅 snoozed
分支才携带 snoozedUntil，且立即推进游标——服务端 snoozed 分支永远收不到请求，
delivery 进入 dismissed 终态永不复现。22 号 PRD §10.2 snooze 承诺前后端皆未接通（E-1 又一例）。
- **三轮验证 08-24【CONFIRMED，比登记更强：三层同时缺失】**：UI→状态机→网络
  逐步核实，`"snoozed"` 字面量在三端代码中除类型声明外零次出现——没有任何调用方
  能发出 snoozed transition；本部署两个 flag 均 true，「稍后提醒」按钮必然渲染可点。
  **更强的结论**：即使客户端硬发 snoozed 也救不了——ackDelivery 只把 snoozedUntil
  塞进租约、行 state 变 snoozed 后，全仓没有任何调度器扫描到点复投；且游标已推过
  该行，纯游标增量协议下行永不再达客户端。即 UI 接线、状态机使用、复投调度三层
  同时缺失。修法：只改映射会出现「状态 snoozed 但无人复投」的新死态，须三层一起：
  客户端按分钟数分流、服务端到期以**新 inbox_sequence 插影子行**（原行已被游标
  消费，改 state 无用）、ack 的 snoozed 分支改为清空租约（现把冲突窗口横跨整个
  小憩期会阻塞其他设备 claim）。

**N-11【P2，三轮升级】quietHours 时区不校验且解析失败 fail-open，与注释宣称的 fail-closed 相反**
shared 合同对 timezone 仅限长度；非法 IANA 时区使 Intl.DateTimeFormat 抛
RangeError 被 catch 吞掉返回 false（不在静默时段→放行），注释却声称 fail closed。
用户拼写错时区保存成功后深夜提醒照发，且 GET 回显看似正常无从察觉。修法：
PATCH 时校验时区合法性拒收 + 解析失败按 fail-closed 处理。
- **三轮验证 08-24【CONFIRMED，升级 P3→P2：实库证实跨租户 DoS】**：同一坏时区
  还流经日记调度——实库验证 `now() AT TIME ZONE 'Not/AZone'` 直接报
  `time zone not recognized`；0171 函数在普通 FOR 循环内逐 tz 执行、无
  BEGIN/EXCEPTION——**一行坏时区使整个 SECURITY DEFINER 函数中止**，每分钟 tick
  失败仅 warn，全体用户的日记入队停摆（用户可控输入导致的跨租户持久性拒绝服务）。
  两层修都要做：入口 superRefine 用 try/catch Intl 校验（兼容别名/UTC 偏移）+
  存量清洗；0171 重写时内层包 EXCEPTION CONTINUE 或先 JOIN pg_timezone_names 过滤
  （把全站停摆降级为单用户跳过）。只改入口防不住未来新写入方，只改函数则静默
  时段 fail-open 与注释撒谎仍在。

**N-12【P2】账号状态首写分支丢弃 interventionLevel/quietHours**
companion-shell service 首次 INSERT user_companion_account_state 的 values 缺这两个
字段（更新分支正确处理）：新用户第一次 PATCH 设置静默时段即静默丢失，返回 200
但回显默认值。与 N-11 叠加构成主动提醒配置陷阱链。
- **三轮验证 08-24【CONFIRMED，触发序列实证】**：双分支逐行核实；首写触达条件
  确认（该表唯一插入点即此、服务端要求首写 patch.revision===0、GET 空态返回
  revision=0）。真实序列：新用户设置页直接配置静默时段 → 200 但字段蒸发，且
  revision 已推进到 1——客户端按旧 payload 重试将 409，**损失固化到手动刷新
  重设为止**。修法坑：drizzle 里 `?? undefined` 才回落 DB 默认、null 是显式写
  NULL；根治建议合并为单条 INSERT..ON CONFLICT DO UPDATE upsert（消灭双分支
  手工字段清单这一漂移温床），并补「patch 全字段经首写分支往返不丢」回归测试。

**N-13【P2】Critic 回写第三段事务不复验 phase/runtimeEpoch，abandon 的 run 被迟到评估复活**
评估链路分三段事务，第三段 finishCriticAssessmentWrite 重新 SELECT 后直接按
verdict 更新 phase，全程无 phase/epoch 校验（UPDATE 仅 WHERE id）；事务外的
failClosedNotAssessable 同样无守卫。用户在 assessing 期 end(abandon) 置 ended+
epoch+1 后，数十秒迟到的 Critic 结果仍能把 run 改回 committing 并完成 canonical
Commit——用户明确放弃的一次学习反而在后台推进复习计划与理解度投影，UI 无任何
提示。run-service 注释明言设计意图是「epoch 前移，迟到 Assessment 无副作用」，
实现与之相悖。修法：第三段 UPDATE 加 phase/runtimeEpoch CAS 谓词，0 行放弃。
- **三轮验证 08-24【CONFIRMED，三个关键增量】**：端到端竞态成立且无补偿——
  processCommitCommand 的 phase 门会被复活后的 committing 骗过，
  revalidateV2CommitEpochs 验的是 objective/evidence epoch 与 run.runtimeEpoch
  无关；实库确认 learning_runs 无触发器、outbox 仅 claim/release/mark 三函数、
  end 路径不取消在途命令。增量：(a) **守卫意图存在、实现缺失**——第三段函数
  签名带 runtimeEpoch 形参却从未比较；(b) **E09 集成测试只覆盖 end 先于 claim
  的顺序**，HTTP 窗口内的交错零覆盖，解释了测试全绿问题仍在；(c) practice/
  completed 分支与第一段 SELECT 同样无锁，修复须统一而非只补第三段。修法要点：
  第一段读 run 加 .for('update')（事务短持锁无害）最简；assessment 行回写与 run
  副作用解耦（保住「报告留档」语义）；revision 改 SQL 侧原子自增；补「claim 后
  end 再回写」顺序的真交错测试。定级维持高位：污染的是学习事实账本（SRS 推进/
  掌握投影）而非瞬态计数，且「等评估不耐烦点结束」是现实用户行为序列。

#### P3

**N-14【P2，三轮升级】日记调度只为用户最早加入的单个 workspace 生成**：0171 ORDER BY
joined_at LIMIT 1 每 user 选一个 workspace，多工作区用户日常在 W2 学习也会因扫 W1
而无活动不入队，日记恒空。与 C-3 不同根，函数重写时一并考虑多 workspace 聚合或
明确单 workspace 口径文档化。
- **三轮验证 08-24【CONFIRMED，升级 P3→P2：实为日记全量静默死亡】**：机制与
  函数体逐字比对属实，且实库确有多工作区用户（恒空场景已成立）。叠加事实使
  后果升级：函数体仍引用已被 0183 删除的 learning_cards（见 C-3 三轮标注）——
  一旦出现首个启用桌宠的用户，**所有用户**的日记入队每分钟抛 42P01 被 warn
  吞掉，不止多工作区用户恒空。修法硬前提：重写必须先改掉 learning_cards 子句；
  口径建议最小改动为「对全部活跃 workspace 逐一活动检测并入队」（幂等键已含
  workspace、主键天然支持每 workspace 一篇），避免跨空间聚合的归属语义难题；
  改完务必用带 account_state 数据的库实测——本次就是被空表掩盖才潜伏至今。

**N-15【P3】extractor 的 inboxSequence 用裸 MAX+1**：advisory lock 键只有
extractor 自己用，与其他写入方（deliver/companion-action 的 FOR UPDATE 行锁）
互不互斥——并发下两者读到相同 MAX，一方撞唯一索引 23514 整事务回滚，提取丢失/
延迟。统一为与 delivery-service 相同的 max 行 FOR UPDATE 取号即可。
- **三轮验证 08-24【CONFIRMED，双重掩蔽警告】**：机制属实（三方取号代码、唯一
  索引均实库核对）。两点后果修正：(1) 非永久丢失——23505 不在不可重试名单，队列
  3 次重试 + source_event_id 幂等保证最终入库，实际是「延迟 + 烧一次 LLM」；
  (2) 当前被 N-5 完全遮蔽——extractor 的 delivery INSERT 今天必先撞 kind CHECK
  回滚，序列竞态根本来不及发生。**⚠️ 捆绑警告：修 N-5（往 CHECK 加第 6 个值）而
  不动取号逻辑会无声激活本竞态**，两者必须同批修；修法注意空分区 FOR UPDATE
  锁不到行的边界（delivery-service 今天就带此坑），建议行锁+advisory 锁双保险，
  并把 API 侧三处手抄取号抽成同一份 SQL 片段。

**N-16【P3】embedding 模型漂移无检测**：检索 join 不比对 model_revision/
embedding_profile_version 与当前 provider；重建只扫 pending/none，无「模型版本
过期→重置 pending」路径。换模型后旧 ready 向量与新查询向量跨空间做 cosine，排序
退化为噪声且永不自愈。字段存在但读取侧零消费。
- **三轮验证 08-24【CONFIRMED，后果细化】**：读取侧零消费、无自愈路径属实；
  另发现 embedding worker 的 SELECT 明明捞了 embedding_profile_version 却从未
  使用（死列，作者预留未接线）。后果细化：异维换模型会 cast 报错优雅降级 keyword
  （非静默垃圾），**同维换模型才是静默噪声**。修法修正：检测放写入侧而非检索侧
  （worker 已 SELECT 该列，比对不等即重置 pending，零额外查询；检索时跳过旧行
  会造成召回黑洞）；profile_version 口径应含 provider+model+dimensions；异维迁移
  需改列型全量重建，与同维重嵌分开处理。潜伏缺陷（flag 默认关、实库 embeddings
  0 行）；向量检索转正生产时应升 P2。

**N-17【P3】硬删对话不清除日记 highlights 中的消息原文摘录副本**：highlights 存
最近 8 条消息原文各 ≤160 字且无 TTL；deleteCompanionConversation 级联删除清单不含
daily_summaries。§12 hard delete 预期内容彻底消失，次日日记页仍展示摘录——
隐私边界被派生副本逃逸。
- **三轮验证 08-24【CONFIRMED，暴露面收窄 + 修法修正】**：级联缺口属实且该行
  永不再生（调度只入队昨天的日期）。**导出半句为否定**：companion-export 与
  exportMemories 均不含 highlights，残留暴露面收窄为日记页历史浏览一条路（仅本人
  可见、体量有界、受默认关闭的 flag 门控、账号删除有 FK CASCADE 兜底）。修法
  修正：不能把 daily_summaries 加进对话级联按日期整行删——日记是当天全部活动的
  聚合，会连带毁掉其他合法来源；正确做法是删后重算（生成器确定性幂等，直接投递
  job 而非复用调度函数）或产品拍板改读取时实时派生。

**N-18【P3】pet_profile CAS 防护对并发无效**：路由事务内校验 revision 后调用的
upsertPetProfile，其 UPDATE WHERE 仅含 (workspace,user) 不含 revision 谓词——
READ COMMITTED 下两端并发编辑都通过校验先后覆盖，revision 各自 +1 掩盖丢失，与
路由注释宣称的防 TOCTOU 矛盾。修法：UPDATE 加 AND revision=期望值，0 行返冲突。
- **三轮验证 08-24【CONFIRMED，实施要点】**：逐点属实（隔离级别、无触发器、
  无 revision 约束均实库核对）；本质是「注释宣称的 CAS 实际不存在」。修法两坑：
  (1) 谓词须用客户端期望值——需给 upsertPetProfile 增加 expectedRevision 参数
  穿透；若误用服务层刚读的 existing.revision 作谓词，并发下 0 行更新会让
  returning()[0] 为 undefined 直接崩 500，等于把静默丢失换成 500；(2) revision
  自增改 SQL 侧 pet_profiles.revision+1；插入路径并发首存撞唯一索引现被 catch
  兜成 500，顺手处理。附带：body.revision 在 zod 里 optional 的无条件覆盖逃生门
  是否保留需写进注释。

**N-19【P3，触发面修正】候选动作事件序号分配在 reviewDraftRevision CAS 之前，并发撞唯一索引返 500**
insertEvent 用 SELECT MAX+1 分配序号先于 CAS 执行，两并发请求读到相同 MAX 时后
提交者撞 (workspace,run,event_seq) 唯一索引；sendServiceError 只识别本域错误，
全局兜底返回 500 internal_error 而非设计中的 409 stale_review_draft。修法：捕获
23505 转 stale 语义，或把事件插入移到 CAS 之后。
- **三轮验证 08-24【CONFIRMED，登记的触发场景多数不成立】**：唯一索引列序与
  500 错误链实库证实。但「双开标签页同时 keep 即触发」不对：同候选并发会在候选行
  UPDATE 处先行串行化，输家等到赢家提交后读新 MAX 干净拿到 409。真实窗口更宽：
  (a) 同 run 不同候选的并发动作（互不阻塞）；(b) API 动作与 worker 分钟级长事务
  （A-6 的 FOR UPDATE）赛跑——recheck/regenerate 期间用户对其他候选的动作极易命中。
  后果良性（整事务回滚零副作用、重试自愈），维持 P3。修法优先「事件插入移到
  CAS 之后」（CAS 成功即单赢家天然串行化）；若选捕 23505 必须匹配约束名而非裸
  错误码（同事务家族还有其他唯一索引，误标会误导前端刷新逻辑）；worker 侧
  insertEventsBatched 共享同一 MAX+1 但有 run 行锁庇护，勿顺手「统一」丢锁。

**N-20【P3】web 编辑表单当前只暴露 objectiveStatement+front.prompt**：A-1 合同级
开放的四支持字段编辑（explanation/boundary/misconception/workedExample）尚无 UI
入口——不是缺陷而是范围记录：A-1 在途修复的价值要等表单扩展后才对用户完全可见。
- **三轮验证 08-24【CONFIRMED，补 UI 有真障碍】**：web 表单是全产品唯一候选编辑
  入口（desktop 只读展示），装配层还有第二道白名单过滤——只改弹窗不改装配等于
  白改。真正的障碍不是缺四个输入框：explanation/workedExample 属 reveal 后内容，
  编辑器打开时前端未必持有明文（防泄题设计），补 UI 需后端提供不经 reveal 的字段
  回读通道；且合同 nullable 不对称（explanation 无 null 分支，「清空」做不了）。

---

## 11. 三轮域补扫新发现（2026-08-24，identity/note 域）

前三轮从未覆盖的 identity/invite/note 域首轮扫描结果。P1 与在途回归两条均经
主会话亲自核实源码与实库。

**N-21【P1】removeMember 双缺陷链：可驱逐 workspaces.ownerId 本人 → 账号级死锁**

- `removeMember`（invite-service.ts:491-561）两道防线均有洞：
  (1) ownerCount 统计不过滤 left_at——软退出的历史 owner 仍计入配额，
  「最后一个活跃 owner」保护被虚高计数绕过；(2) 整个函数无
  `workspaces.ownerId` 保护（`self_remove_owner` 只挡自删）。而
  requireOwner 的判定是 OR 语义（membershipRole==='owner' 或 ownerId===userId，
  middleware.ts:46-52 实读确认）——**workspace 属主即使不在 members 表里有
  owner 角色（或角色被降级）也能调 removeMember，也能被其他 owner 移除**。
- **后果链**：U1 注册后其个人工作区邀请 U2 为 owner 协作 → U2 调
  DELETE /members/U1 → ownerCount 因虚高通过 → U1 被 soft-left 且该工作区全部
  session 被删（decodeToken 对 left_at 非空成员直接删 session）。若 U1 无其他
  工作区成员资格，登录接口因 memberships.length===0 返回 401——**密码正确也永远
  登不上（账号级死锁）**；即便有其他空间，其笔记/AI 同意等数据已归 U2 控制。
  反向变体：多个历史 owner 软退出后把最后一个活跃 owner 也移除，工作区陷入
  无人可管的死局。
- **修法方向**：removeMember 增加目标为 workspaces.ownerId 时拒绝；
  ownerCount 加 `left_at IS NULL` 过滤；驱逐属主场景补 personalWorkspaceId/
  恢复通道语义。三条都要改，只堵一条仍有变体。

**N-22【P2，在途回归】onboarding evidence_review 主键错配：该步骤经 API 永远失败**

- 在途 diff 将 evidence_review 校验从已删除的 V1 evidences 表改为
  `evidenceSnapshotsV2.findFirst({ id: evidenceId })`（invite-service.ts:754-759
  亲核），沿用了 V1「客户端可见主键」语义。但 evidence_snapshots_v2 有两个
  UUID：随机主键 id 与业务标识 evidence_snapshot_id；全仓所有暴露面（reveal 的
  来源预览、学习卡来源、understanding-v3 拓扑）一律返回 evidence_snapshot_id，
  没有任何端点返回内部主键 id——客户端能拿到的任何 evidenceId 都查不中，
  恒 409 business_fact_missing。
- **后果**：evidence_review 是 ONBOARDING_STEPS 中唯一需人工确认的步骤，
  该步卡死即 onboarding 永远到不了 completed。当前 web/desktop 尚无活跃调用方
  （潜伏断裂），但按合同接入即稳定复现。
- **修法**：一行改为 `eq(evidenceSnapshotsV2.evidenceSnapshotId, evidenceId)`。

**N-23【P3】新端点角色判定与 requireOwner 的 OR 语义分裂**

- 在途新增的 GET /auth/capabilities/v1 与 /v2/notes 投影只用 membershipRole
  推导权限，而 requireOwner 是 OR 语义。owner 被移除后以 member 身份受邀重回
  （workspaces.ownerId 不变、membership role 被 joinWorkspaceByInviteToken 直接
  覆写）时：桌面端能力矩阵显示只读、卡片生成不可用，但直连 API 写入成功——
  fail-closed 方向（不会提权），但两端权限展示互相矛盾。修法：capability/投影
  判定统一走 isWorkspaceOwner 同款 OR 语义。

**N-24【P3，结构性风险】租户隔离完全依赖应用层 WHERE：业务表 RLS 处于禁用扩展模式**

- 实库 pg_class 证实 notes/note_versions/workspace_members/users/sessions 等
  全部业务表 relrowsecurity=f（迁移 0027 的显式决定：策略保留待审、执行留在
  扩展模式）。identity/note 域内查询本次已逐一核对带 workspace 过滤、未发现
  具体漏点，但这是整个隔离模型的单一前提：任何一处新增查询漏掉谓词即成跨租户
  泄漏且无数据库层兜底（understanding-v3 曾犯过此错有先例注释）。建议将 RLS
  重启用作为独立跟踪项而非口头约定。
