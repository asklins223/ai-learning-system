# 桌宠记忆与学习目标系统：四文档审查修复报告

> 状态：**Done（全部修复已落地并验证）**
> 日期：2026-08-19
> 审查对象：[21](./21-real-desktop-pet-memory-context-design.md) /
> [22](./22-real-desktop-pet-memory-context-prd-tdd.md) /
> [23](./23-learning-objective-content-topology-system-rebase.md) /
> [24](./24-learning-card-v1-cleanup-remaining-plan.md)
> 关联修订：22 号文档 v1.4（§30）、23 号文档 v0.3（§0.1）、24 号文档 v0.2（§9.1）、
> 21 号文档状态改为 Superseded

---

## 0. 结论先行

对四份方案文档做了"文档 ↔ 代码 ↔ 真实行为"三层审查。总体结论：

- **23（Objective 拓扑重接）与 24（V1 清理）执行质量良好**，主要问题是文档状态失真
  （均标 Proposed，实际早已大规模实施/执行完毕），本次已回写；
- **22（桌宠记忆）写入侧严谨、读出侧存在三处端到端行为断裂**——此前十轮代码审查
  全部聚焦"文档措辞与代码文本比对"，抓不到需要沿数据流验证的行为缺陷。本轮共修复
  **8 项代码问题 + 3 项文档治理**，全部验证通过。

---

## 1. 代码修复清单（按严重度）

### P0-1 keyword fallback 形同虚设 ✅

- **问题**：`companion-memory-vector.ts` 把 ≤1000 字符的整段查询（userText + 近 4 条
  消息）塞进 `content ILIKE '%<全文>%'`；content 上限 200 字，模式比字段还长，
  几乎永不匹配。embedding provider 故障时记忆召回≈0。
- **修复**：新增 `extractQueryKeywords()`（CJK 连续段 / 拉丁·数字词，≥2 字、去重、
  封顶 8 个、单 token ≤30 字符），SQL 改为 `ILIKE ANY(text[])` 多关键词 OR 匹配；
  无可用关键词时回退 pinned/importance/updated_at 规则排序，保证降级仍有召回。
  新增 `toTextArrayLiteral()` 安全序列化（转义引号/反斜杠）。

### P0-2 人格 revision CAS 前端未接通 ✅

- **问题**：v0.5 修复了服务端 TOCTOU（CAS 与写入合并同事务），但 web 端
  `updatePetProfile` 入参没有 revision 字段、页面也从不携带——服务端
  `revision !== undefined` 恒为 false，乐观锁形同虚设，并发保存仍互相覆盖。
- **修复**：`apps/web/lib/api.ts` 入参增加可选 `revision`；`pet-profile/page.tsx`
  维护 revision 状态（GET 时记录 → PATCH 携带 → 响应后更新）；409
  `PROFILE_CAS_CONFLICT` 时提示"已在其他设备被修改"并自动 reload 最新版本。

### P0-3 scope 死维度（global/task 记忆永不召回）✅

- **问题**：orchestrator 硬编码 `currentScope="workspace"`，检索 SQL 只匹配
  `'workspace' OR currentScope`——extractor schema 允许产出的 `global`/`task`
  记忆写入后永远召不回。根因是 PRD §9.2.2 示例 SQL 自带此缺陷，实现原样照抄。
- **修复**：向量与 keyword 两条路径的 SQL 增加 `OR scope = 'global'`；
  orchestrator 新增并导出 `deriveMemoryScope(pageContext)`：pageKind ∈
  {card, learning_run, review} → `task`，其余 → `workspace`；dialogue 调用点传入
  pageContext（兼容对象 / JSON 字符串 / `{context:{...}}` 包裹形态）。PRD §9.2.2
  SQL 已同步修订。

### P1-4 无 ready embedding 时向量路径零召回不降级 ✅

- **问题**：provider 正常但用户还没有任何 ready embedding（新确认记忆
  pending→ready 窗口、embedding 任务积压）时，向量查询正常返回空集且
  mode=vector，不会降级——"有记忆但永远召不回"。
- **修复**：向量空结果时 EXISTS 探测该用户是否存在 ready embedding：
  不存在 → 降级 keyword 规则排序；存在但相似度不足 → 保持空集（真正无相关记忆，
  避免向用户注入无关记忆）。

### P1-5 §10.5 关系状态模型完全未实施 ✅

- **问题**：familiarity / interaction_count / last_active_at 三列自迁移 0170 建好后
  从未被任何代码更新，永远是初始值；且 worker 对 pet_profiles 只有 SELECT 权限，
  想写也写不了。
- **修复**（三条更新链路 + 一个迁移）：
  - 对话终态（`companion-dialogue.ts`）：interaction_count+1、familiarity+0.01
    （上限 1）、刷新 last_active_at；独立事务、失败仅 debug 日志，绝不影响主链路；
  - 确认记忆（`memory-routes.ts` confirm 路由）：familiarity+0.03（上限 1）；
    API 主事务完成后独立事务执行、失败静默；
  - 每日维护 tick（`companion-memory-maintenance.ts`）：>14 天未互动
    familiarity-0.05（下限 0），与记忆归档维护同一调度节拍；
  - 新迁移 `0178_worker_pet_profile_relationship.sql`：幂等补齐 worker 对
    pet_profiles 的 INSERT/UPDATE 授权（RLS 策略本身对 ailearn_worker 角色放行，
    只缺 GRANT）。迁移未应用时上述 UPDATE 以权限错误失败并被 catch 吞掉，安全降级。

### P1-6 memory_candidate 气泡缺内容摘要 + window.prompt 纠正 ✅

- **问题 A**：delivery payloadRef 只带 memoryItemId，气泡只能显示通用文案
  "伴星记住了一条新信息"，违背 §16.2 "携带 ≤80 字内容摘要"。
- **修复 A**：shared 合同 `AssistantDeliveryPayloadRefV2` 的 `memory_item` 变体增加
  可选 `contentPreview`（TS 类型 + zod strictObject 同步扩展，老 payload 向后兼容）；
  extractor 写入 `candidate.content.slice(0, 80)`；气泡优先展示
  "伴星记住了：<preview>。对吗？"。
- **问题 B**："纠正"按钮使用原生 `window.prompt`——无法样式化、阻塞主线程、
  读屏不友好，违背 §14.1 composer 方案与 §14.6 无障碍要求。
- **修复 B**：改为气泡内联编辑态——textarea（≤200 字、进入自动聚焦、Escape 取消、
  ⌘/Ctrl+Enter 提交、提交前 trim + 截断），有 contentPreview 时展示"原记忆"行并
  用作 placeholder；配套 `.pet-delivery-correct*` 样式沿用气泡既有 token 体系。

### P2-7 星图路由缺少 feature flag 门控 ✅

- **问题**：§9.8 承诺每个能力独立 flag，但 `COMPANION_MEMORY_STAR_MAP_V1` 在代码中
  零引用，`/companion/memory/star-map` 仅 requireSession 即可访问（fail-open）。
- **修复**：路由补 `COMPANION_MEMORY_STAR_MAP_V1=true` 门控，关闭时 404
  fail-closed（`.env.example:60` 该 flag 原已声明，本次只是接线）。前端 star-map 页
  已有 catch 展示 API message，无需改动。

### 设计裁决（回写 PRD，不改代码）

| 裁决 | 内容 |
|---|---|
| Episodic 通道 | §2.3.1/§3.4 描述的独立 "Episodic Top K" 通道**不实施**。情景摘要经确认后作为 `kind=episodic` 普通记忆参与统一检索管线；`conversation_summaries` 定位调整为存储/审计层。理由：Owner 决策#2 已定候选不入上下文，独立通道只会双重注入 |
| 预算 vs topK | topK=8×200字=1600 > MEMORY_BUDGET_MAX=1000，预算先触顶（实际注入约 5 条）。维持"预算优先"，topK=8 仅为检索单次取回上限 |
| 气泡互斥 §11.3 | 核实 `PetDeliveryLayer` 已有单槽 inbox + journeyVisible/suppressed/voiceBusy 三重抑制，判定满足；文字 turn 流式期间不额外挂起确认卡 |

---

## 2. 文档治理

| 文档 | 动作 |
|---|---|
| 21 | 状态 Proposed → **Superseded**，头部注明由 22 取代、冲突以 22 为准 |
| 22 | 版本 v1.3 → **v1.4**：修订记录新增本轮条目；§9.2.2 SQL 补 `OR scope='global'`；新增 **§30 第十一轮端到端行为审查与修复**（8 项修复表 + 两项设计裁决 + 验证记录 + 已知遗留） |
| 23 | 状态 Proposed → **Implemented**：新增 §0.1 实施状态回写（已实施/简化落地/待决三档清单），正文 WBS 保留作任务溯源不再逐项勾选 |
| 24 | 状态 Proposed → **Executed**：新增 §9.1 执行记录（五阶段逐项核对证据表 + 遗留动作：本机 PG 补跑集成测试签收） |

---

## 3. 验证矩阵

| 包 | typecheck | 测试 |
|---|---|---|
| workers/ai-worker | tsc --noEmit **0 错误** | companion-memory-vector 17/17、companion-context-orchestrator 3/3（均含新增用例）、companion-* 合计通过（终态见 §7.3 全量 **758/758**） |
| apps/api | tsc --noEmit **0 错误** | companion-conversation 单测 22 pass / 1 skip（原有跳过项） |
| packages/shared | tsc --noEmit **0 错误** | companion-bridge-contracts 7/7 + conversation-contracts 合计 32/32（payloadRef 扩展向后兼容验证通过） |
| apps/web | tsc --noEmit **0 错误**；改动文件 eslint 0 warning | 单测套件 **529/529** 通过 |

新增测试覆盖：关键词提取（拉丁词整留 / 长 CJK 段 bigram / ≤4 字 Han 段整留 /
混排拆分 / 封顶去重 / 空输入，共 6 用例）、text[] 字面量转义、ILIKE ANY 生成与否、
global scope 过滤断言、EXISTS 零召回窗口降级两分支、deriveMemoryScope 六种输入形态。

---

## 4. 变更文件清单

```
workers/ai-worker/src/handlers/
  companion-memory-vector.ts          # P0-1/P0-3/P1-4：关键词提取 + ILIKE ANY + global scope + EXISTS 降级
  companion-memory-vector.test.ts     # 新增 8 个用例
  companion-context-orchestrator.ts   # P0-3：deriveMemoryScope + pageContext 入参
  companion-context-orchestrator.test.ts  # 新增：scope 推导 3 用例
  companion-dialogue.ts               # P1-5：终态 familiarity bump；P0-3：传 pageContext
  companion-memory-extractor.ts       # P1-6A：payloadRef contentPreview
  companion-memory-maintenance.ts     # P1-5：familiarity 每日衰减
apps/api/src/db/migrations/
  0178_worker_pet_profile_relationship.sql  # 新增：worker 写授权
  meta/_journal.json                  # 复审 R1：登记 0178（否则 runner 静默跳过）
apps/api/src/modules/companion-conversation/
  memory-routes.ts                    # P2-7：star-map flag 门控；P1-5：确认记忆 familiarity bump
packages/shared/src/
  companion-bridge-contracts.ts       # P1-6A：memory_item.contentPreview（类型+zod）
apps/web/
  lib/api.ts                          # P0-2：updatePetProfile revision 入参
  app/(workspace)/(default)/companion/pet-profile/page.tsx   # P0-2 + P1-5 预览
  features/companion-pet/deliveries/DeliveryBubble.tsx        # P1-6B：内联纠正编辑
  features/companion-pet/deliveries/delivery-bubble.css       # 内联编辑样式
  features/companion-pet/deliveries/delivery-client.ts        # 确认卡展示 contentPreview
  app/(workspace)/(default)/companion/conversations/conversation-page.css  # 预览面板样式
docs/plans/learning-companion/
  21-*.md 22-*.md 23-*.md 24-*.md     # 状态治理与偏差回写
  25-companion-objective-review-fix-report.md  # 本报告
```

---

## 5. 已知遗留（不在本轮处理）

1. **last_used_at 反馈回路**：检索命中刷新 last_used_at 而 freshness 又按其加权，
   存在"富者愈富"倾向——属排序策略权衡而非缺陷；如需调整（freshness 改锚
   confirmed_at 或衰减设上限）需 Owner 决策。
2. **真实 PG 集成签收**：文档 24 §7 的"集成测试在真实 PG 全绿"、本轮检索层修复的
   pgvector/RLS 行为验证，需在本机 PG 环境跑一轮集成测试收尾（含迁移 0178 应用）。
3. **视觉 QA 矩阵**（文档 23 §37）：320px/键盘/读屏/reduced-motion 的系统性浏览器
   验收尚未执行。
4. **记忆星图 Canvas overlay**：当前为独立列表页（PRD Owner 决策#4 的完整形态是
   叠加在理解星图上的图层），属功能增强项，非缺陷。

---

## 6. 第二次复审（对 §1 修复自身的审查）

首轮修复落地后立即做了一轮针对性复审——用与审查原实现相同的标准审视自己的改动，
发现 **2 个真实问题并已修复**，另有 7 项确认无误。

### 6.1 复审发现并修复的问题

**R1（严重）：迁移 0178 没有登记进 drizzle journal，永远不会被执行**

- 首轮修复只创建了 `0178_worker_pet_profile_relationship.sql` 文件。复查迁移 runner
  （`apps/api/src/db/migrate.ts`）发现它走 drizzle `readMigrationFiles({ migrationsFolder })`
  ——该函数以 `meta/_journal.json` 为准加载迁移，不在 journal 中的 SQL 文件会被
  **静默跳过**。也就是说 familiarity 三条更新链路里的 worker 写授权永远不会生效。
- 根因：想当然沿用"手写迁移文件即可"的假设，没有核对 0170-0177 每个手写迁移都
  有对应 journal 条目这一事实。
- 修复：journal 追加 idx=178 条目（tag 与文件名精确一致、breakpoints=true）。

**R2（中）：CJK 关键词提取首版对中文仍然低效**

- 首版 `extractQueryKeywords` 把整段中文 run 当作单个关键词（截断 30 字）。中文无词
  边界，"今天我们聊聊光合作用吧"产出的"关键词"就是整串本身——作为 ILIKE 子串依旧
  匹配不到记忆"这周掌握光合作用"。即 P0-1 的修复对拉丁文有效、对主要场景中文
  改善有限。
- 修复：Han 连续段 >4 字改为滑窗重叠 bigram（产出含"光合"/"作用"等可命中子串）；
  ≤4 字 Han 段整体保留（短语子串比 bigram 精准）；混排 token（如"DNA复制过程"）
  先拆拉丁子串再处理 Han 段；封顶提升到 12 个控制模式规模；新增 6 个提取用例
  锁定行为（含"长句必须产出可命中 bigram"的回归断言）。

### 6.2 复审确认无误的项

| 项 | 结论 |
|---|---|
| dialogue familiarity bump 事务位置 | 位于终态事务成功后的独立事务 + 内层 try/catch，不会触发 `markCompanionRunFailed`；0178 未应用时权限错误被吞掉安全跳过 |
| web 409 处理 | `ApiError.status` 为 public 字段，`caught.status === 409` 分支类型与运行时行为均正确 |
| ILIKE 注入面 | 关键词字符集限定字母/数字/Han（无 `%`/`_` 通配符），text[] 字面量转义引号/反斜杠，无注入路径 |
| EXISTS 探测 | JOIN 条件（workspace/user/deleted/candidate/archived/ready）与主查询一致，无越权读取 |
| payloadRef contentPreview | 全仓唯一生产方为 extractor；≤80 截断与 zod max(80) 一致；strictObject 对老 payload 向后兼容 |
| star-map 门控 | 路由级 flag + 前端 catch 展示 API message，fail-closed 闭环 |
| 预算/topK、episodic 裁决、气泡互斥 | 文档裁决与代码现状一致（见 §1 设计裁决表） |

### 6.3 复审后回归结果

- workers/ai-worker：tsc 0 错误；companion-* 单测 **59/59**（vector 16 含 bigram 用例）；
- apps/web：tsc 0 错误；4 个改动文件 eslint `--max-warnings=0` 通过；
- packages/shared：合同测试 32/32；
- apps/api：tsc 0 错误（本轮无 api 代码变更，仅 journal 登记）。

### 6.4 复审方法论注记

R1/R2 有一个共同教训：**修复验证停留在"单测绿 + typecheck 绿"，没有验证交付物是否
真正进入生效路径**（R1：文件写了但 runner 不加载；R2：函数对了但策略对目标语言无效）。
后续对基础设施类改动（迁移、构建配置、runner 行为）应增加"从入口到底层"的存在性
断言，例如迁移条目数 = 目录文件数的守卫测试。

---

## 7. 第三次复审（运行时行为验证 + 全量回归）

第三轮换角度：不再只读代码，而是**实际运行**改动函数验证真实输出，并把回归范围
扩大到 worker 全量单测。

### 7.1 发现并修复

**R3/R4（中）：bigram 顺序枚举在封顶处丢失句尾语义重心**

- 运行时采样发现：`extractQueryKeywords("我上周说过这周想重点突破有机化学")`
  实际输出不含"有机"/"化学"——16 字 run 产生 15 个 bigram，被 12 上限按位置顺序
  截断，而中文句子语义重心（宾语）恰好在尾部。R2 声称"已修复中文召回"时只验证了
  短句用例，没跑长句真实输入。
- 修复：bigram 超出剩余预算时改为**头尾采样**（保前 half + 后 half），上例现含
  "这周 / 突破 / 有机 / 化学"；新增回归用例断言长句必须保留句尾关键词。
- 验证方式升级：纯函数类修复一律附 `node --import tsx -e` 直跑输出作为证据。

### 7.2 本轮确认无误

- 六组真实输入的提取输出符合设计（长句 bigram / 混排拆分 / 空 / 纯标点 / 封顶）；
- keyword fallback 与 EXISTS 探测 SQL 为标准 PG 语法；参数化数组字面量模式与代码库
  既有 `${idsLiteral}::uuid[]` 用法一致；本地无 PG 容器，语法级最终确认留待集成测试；
- 全量 worker 单测 **758/758** 通过，无跨模块回归。

### 7.3 第三轮终态回归

| 包 | typecheck | 测试 |
|---|---|---|
| workers/ai-worker | ✅ 0 错误 | **758/758**（全量套件） |
| apps/web | ✅ 0 错误 | 529/529 |
| packages/shared | ✅ 0 错误 | 合同测试 32/32 |
| apps/api | ✅ 0 错误 | journal 校验通过（179 条目，idx 178 就位） |

### 7.4 三轮复审累计

| 轮次 | 视角 | 发现 |
|---|---|---|
| 第一轮（原审查） | 文档 ↔ 代码 ↔ 数据流 | 8 项缺陷 + 3 项未实施承诺 |
| 第二轮 | 以同等标准审视自己的修复 | R1 journal 登记缺失、R2 中文分词失效 |
| 第三轮 | 运行时输出 + 全量回归 | R3/R4 封顶截断丢句尾语义 |

收敛判据：本轮未再发现新问题层级（R3 是 R2 的参数化精化而非新类别），全量回归零失败，
视为修复收敛。
