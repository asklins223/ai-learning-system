# D2 · 唯一调度与观察类别

> 日期：2026-09-24
>
> 状态：**W0-2 交付的设计件（39d §5）。本文件不写产品代码、不改数据库、不删任何链路。**
>
> 依据：39 §15.3-3/-4/-8/-16/-18、§8.3、§9.1、§9.6；39d §5 备注（「D2 的分量最大」）；坐标与读数实测于提交 `e7cea900` + 干净树。
>
> 谁在用它：W5-4（单次提醒的最小切片）、W7-2（保存并开启复习）、W7-3（持续授权与排除）、W7-5（同目标复用）、W7-8（调度与投影闭环）、W7-9（伴星接入制卡与停订）。**W7 整波压在本文件上**；不够用时回来改本文件。

---

## 0. 一句话结论

**"策略唯一"今天已经是真的**——一个纯函数、一个版本常量、六个档位。**要收敛的是写入点**（实测三处），**要补的是回访维度列、唯一键、新观察类别与组合回执**，**要审计的是存量 `subject_id` 的混存语义**（实测 32 行里 26 行是 objective、4 行是 card、2 行两者都不是）。

---

## 1. 现状（逐项实测，不是转述）

| # | 事实 | 坐标 | 读数 |
| --- | --- | --- | --- |
| 1 | **策略唯一确实是状态** | `packages/shared/src/scheduling-policy-v2.ts` | `calculateDiscreteV2Schedule()` 纯函数（"不读取时钟、不修改状态、不调用外部服务"）；`DISCRETE_V2_POLICY_VERSION = "discrete-v2"`；档位 `[1, 3, 7, 14, 30, 60]` |
| 2 | 现有观察类别 8 个 | 同上 `DISCRETE_V2_OUTCOMES` | `correct` / `partial` / `incorrect` / `unable` / `source_viewed` / `later` / `stale` / `provider_failure` |
| 3 | **写入点三处** | 见 §1.1 | 结算 6 个写操作、卡片生命周期 1 个、延期服务 1 个 |
| 4 | 表**没有回访维度列** | `packages/shared/src/db-schema/evidence.ts:17-50` | 15 列：`id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, last_review_at, generation, policy_version, reason_code, supersedes_schedule_id, user_deferred_until, created_at, updated_at` |
| 5 | **唯一键不存在** | `pg_indexes` | 唯一索引只有 `review_schedules_pkey(id)` 与 `review_schedules_id_workspace_unique(id, workspace_id)`；`(subject_type, subject_id)` 只是**普通**索引 ⇒ 39 §15.3-18 要的（工作区、本人、目标及修订、维度、待处理）唯一性**今天没有任何东西在保证** |
| 6 | 状态枚举 6 值 | `packages/shared/src/enums.ts:75-83` | `pending` / `accepted` / `dismissed` / `completed` / `superseded` / `cancelled`；**实测库里只出现过 pending 21 / cancelled 1 / completed 10** |
| 7 | worker 侧只读 | `workers/ai-worker/src/handlers/companion-agent-runtime.ts:667` | 注释自己写着"名字骗人：这张表的 `subject_type` 被 CHECK 成 `'card'`" |

### 1.1 三处写入点（实测坐标）

| 写入点 | 文件 | 写操作 |
| --- | --- | --- |
| **结算** | `apps/api/src/modules/learning-runs/run-processing-tick.ts` | `insert(reviewSchedules)` ×4（`:1813` `:1864` `:1907` `:1949`）、`update(reviewSchedules)` ×2（`:1850` `:1935`） |
| **卡片生命周期** | `apps/api/src/modules/card-generation-v2/card-service.ts` | `update(reviewSchedules)` ×1（`:1062`） |
| **延期服务** | `apps/api/src/modules/review/review-defer-service.ts` | `update(reviewSchedules)` ×1（`:71`） |

四处 `insert` 落在同一个 handler 里，按 `policyReason` 分成 `demonstrated`（`:1829`）与 `declared_unable`（`:1921`）两条路，各自还有"已有行则 update、没有则 insert"的分支（`:1833`／`:1925` 先读 `intervalDays`）——**"先查后写"这个形状本身就是在替唯一键干活**，而它没有并发保护。

### 1.2 存量审计口径（39 §15.3-18 要求的那个）

```
SELECT subject_type, count(*) AS n,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM learning_objectives_v2 o WHERE o.objective_id = s.subject_id)) AS hit_objective,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM learning_cards_v2 c WHERE c.card_id = s.subject_id)) AS hit_card
FROM review_schedules s GROUP BY subject_type;
```

**2026-09-24 实测**：

| 项 | 读数 |
| --- | --- |
| 总行数 | **32** |
| `subject_type` 取值 | **全部为 `'card'`**（唯一取值） |
| `subject_id` 命中 `learning_objectives_v2.objective_id` | **26** |
| `subject_id` 命中 `learning_cards_v2.card_id` | **4** |
| 两者都不命中 | **2** |
| status 分布 | `pending` 21 / `cancelled` 1 / `completed` 10 |
| 带 `policy_version` | 28 / 32 |

**与 39 §15.3-18 记的"23 条里 19 条为 objective"不矛盾，是同一现象的两个时刻**：存量在长，比例不变（约 81% 是 objective）。⇒ **`subject_type='card'` 这个列名与 `subject_id` 的实际语义不一致，而这不是历史遗留的一次性脏数据——它每天都在被写。**

---

## 2. 决定一：一个写入边界

**收敛方向**：把三处写入点收成一个**领域服务**（下称"调度服务"），三处只**调用**它，不再各自 `insert`／`update` 这张表。

### 2.1 契约

```ts
export interface ScheduleCommand {
  readonly kind:
    | "apply_observation"      // 一次观察 → 可能改安排（结算路径）
    | "revoke_source"          // 停用某个授权来源（笔记订阅 / 卡片订阅）
    | "exclude_target"         // 目标「暂不安排」
    | "restore_target"         // 解除排除
    | "defer_once"             // 延后一次（单次提醒 / 某次回访）
    | "cancel_once"            // 取消一次提醒
    | "card_lifecycle_changed" // 卡停用 / 删除 / 恢复
    | "note_lifecycle_changed";// 归档 / 恢复
  readonly workspaceId: string;
  readonly userId: string;
  /** 幂等键：一律由调用方给，服务端不生成 */
  readonly idempotencyKey: string;
  /** 乐观并发：预期版本，不符即拒绝并回具体差异 */
  readonly expected: { workspaceId: string; userId: string; subject: SubjectRef; dimension?: ReviewDimension; generation?: number };
  readonly payload: unknown;
}

export interface ScheduleReceipt {
  readonly changed: boolean;              // 没变也要有回执（39 §9.6："没有调度变化也应说明原因"）
  readonly reasonCode: string;
  readonly entries: Array<{ subject: SubjectRef; dimension: ReviewDimension | null; nextReviewAt: string | null; status: ReviewStatus }>;
  readonly policyVersion: string;
}
```

**三条硬约束**：

1. **没有任何调用方能直接写那张表。** 收敛的判据不是"函数名统一"，是**全仓 `insert(reviewSchedules)` / `update(reviewSchedules)` 只剩调度服务这一处**（可 grep 验证，见 §9）。
2. **每个命令都返回回执**，包括"什么都没变"（reasonCode 说明为什么）。客户端不靠"有没有行变化"猜结果。
3. **旧事件含义不得重用**（39 §15.3-3 原话）：新增观察类别一律**新取值**。特别地——
   - 不许把"自评"塞进 `correct`；
   - 不许把"借助完成"塞进 `partial`（39 §9.3："提示后完成 | 保留借助条件，**不提升为独立成功**"）；
   - 不许把"没有回忆报告只阅读过"塞进 `source_viewed` 之外的值（`source_viewed` 已经在，直接复用）。

---

## 3. 决定二：回访维度列与唯一键

### 3.1 加一列 `review_dimension`

39 §9.1 原话："可调度状态以**工作区＋本人＋可确认的目标及修订适用范围＋回访维度**为单位维护"，并且明确"不同能力维度仍可分别需要回访，例如记住定义与在综合情境中使用"。

- 列名：`review_dimension text`（**可空**——旧行没有这个概念，空值表示"未指定维度"，读侧按一个**显式的缺省维度**处理，而不是按 NULL 散成多份）。
- 取值范围：与**目标维度**同一套枚举（从 `learning_objectives_v2` 的能力维度取值域派生，不另造第二套词表）。**运维/实施时从 schema 现读，不写死数字。**
- 旧的 `subject_type` 列：**保留列、不再写入新语义**（改名会牵动 13 个读取模块；先冻结语义，等 W7 的读取方全部切完再谈改名或删除）。

### 3.2 唯一键（39 §15.3-18 的那条）

```sql
CREATE UNIQUE INDEX review_schedules_pending_dimension_unique
  ON public.review_schedules (workspace_id, user_id, subject_id, review_dimension)
  WHERE status = 'pending';
```

三点设计判断，逐条给理由：

1. **`subject_id` 而不是 `(subject_type, subject_id)`**：因为 `subject_type` 恒为 `'card'`（§1.2），把它放进键里只会让"同一个目标用两种 subject_type 写进来"绕过唯一性。**语义上这张表的 subject_id 是"可确认的目标 id"**（无论它背后有没有卡）。
2. **`WHERE status = 'pending'` 的部分索引**：终态行（`completed`/`cancelled`/`superseded`/`dismissed`）必须允许同一目标有**多行历史**——唯一的只是"待处理的那一份"。
3. **`review_dimension` 参与键**：这是 §3.1 的目的；维度为空的行会被当成"未指定维度"这一档参与唯一性（`NULL` 在唯一索引里不参与比较，所以**必须**把列 `SET DEFAULT ''` 用空串，或者用 `coalesce(review_dimension,'')` 的函数索引——**二选一，实施时按迁移成本定，但不许留 NULL 导致唯一性漏掉这一档**）。

### 3.3 存量怎么办

**不在本文件授权迁移。** 存量有 2 行两者都不命中（可能是测试夹具的悬空引用），且 `subject_id` 有 26 行指向 objective、4 行指向 card。加唯一索引前必须：

1. 先跑一次**冲突探测**（同一个 `(workspace, user, subject_id, 维度)` 在 `pending` 上有没有多行）；
2. 有冲突 → 按"保留 `supersededScheduleId` 链上最新的那一行、其余转 `superseded` 并写 `supersedes_schedule_id`"处理，**不物理删除**（历史要留）；
3. 2 行悬空引用单独列表，交产品确认后处理（**不许按标题猜造**——39 §8.5 的取向）。

**前置**：39d §1 的红线"涉及 schema 历史先确认开发库可重建"。dev 库可重建这一条在 W0-9 已确认过迁移账可用；但**加索引是一次正式迁移**，要登记 journal（39d §1 末条）。

---

## 4. 决定三：观察类别与策略版本

### 4.1 现有 8 个 outcome 的覆盖缺口

逐条对 39 §9.3 的表：

| 39 §9.3 的本次观察 | 今天的落点 | 缺口 |
| --- | --- | --- |
| 可靠的独立正确作答 | `correct` | — |
| 可靠的独立错误／明确不会 | `incorrect` / `unable` | — |
| **提示后完成** | 无 | **缺**（现在被压进 `partial`，而 §9.3 要求"保留借助条件，不提升为独立成功"） |
| **回忆后用户自评** | 无 | **缺**（39 §9.3："标记本人报告，**不伪装系统判定**"） |
| 只阅读／翻面，没有回忆报告 | `source_viewed` | — |
| 模型评估失败 | `provider_failure` | — |
| **部分完成** | 无 | **缺**（已做目标分别结算、未做目标不产生完成事实） |
| **内容改变或权限不足** | `stale`（近似） | 需明确 `stale` 是否覆盖"权限不足"；若否，**新增取值** |

### 4.2 新增取值（一律新名字，不重用旧含义）

```
assisted_completed   // 借助提示/揭示后完成；不提升为独立成功
self_reported        // 回忆后用户自评（想起来了/有些困难/忘了）；本人报告，不是系统判定
partial_completed    // 本轮部分完成：已做目标分别结算，未做目标不产生完成事实
permission_revoked   // 内容权限不足导致该目标不可继续（与 stale 分开：stale 是内容变了）
```

**必须做的事**（不然新类别是空壳）：

- `DISCRETE_V2_OUTCOMES` 扩展，并**同批更新纯函数的判决表**（每一档 → 间隔怎么动、reasonCode 是什么）。**新取值不许落到"默认分支"上**——纯函数里要显式 `case`，漏一个就编译不过（用 exhaustive switch）。
- `DISCRETE_V2_POLICY_VERSION` **递增**（如 `discrete-v3`）。39 §15.3-3 原话："新观察类别、用户授权和策略版本如何进入唯一调度服务；旧事件含义不得重用。"
- **旧 `policy_version='discrete-v2'` 的行不被新策略追溯重写**：版本是历史记录，不是开关。
- 首期不宣称精确遗忘概率（39 §9.3 末段）：间隔仍是离散档位，不给"遗忘曲线"话术。

### 4.3 谁产生这些观察

| 观察 | 产生方 | 时机 |
| --- | --- | --- |
| `assisted_completed` | 结算路径，**依据是帮助记录**（39 §14.1.1 的暴露链，W0-7 定稿） | 回答锁定前已有呈现的帮助 |
| `self_reported` | 客户端自评 → 服务端落成观察（**不是**直接把自评写进调度） | 翻面后 |
| `partial_completed` | 轮次收尾（D1 的 `outcome=partial`） | 用户主动收尾 |
| `permission_revoked` | 权限变更事件 | 撤权/退出空间 |

**红线**：自评与借助**必须**在能力记录里可区分（39 §9.2 的三种事实分开：活动回执 / 能力证据 / 安排回执）。

---

## 5. 决定四：「保存并开启复习」的组合回执

39 §8.3、§15.3-16、§16.35。这是一个**组合业务命令**，不是两个动作的串联。

### 5.1 契约

```ts
POST /...  { candidateIds: [...], subscribe: true|false, idempotencyKey }
→ 单个回执 {
     saved:  { cardIds: [...] },            // 全部保存成功
     authorization: { source: "card", subjectIds: [...], firstReviewAt: "..." },
     combined: "saved_and_subscribed" | "saved_only",
     reason: string                          // 已有同目标安排时说明"沿用既有日期"
   }
```

### 5.2 三条硬约束

1. **不部分提交**：所选范围里任一版本冲突／排除项未解除，**整条命令不提交**，返回可解释冲突，用户可改选或改为仅保存（39 §16.35 第一句）。
2. **幂等**：重试恢复**同一回执**，不重复建卡或订阅（39 §8.3："重试恢复原回执，不重复建卡或订阅"）。
3. **通知不属于这个事务**：提醒的实际送达**不在**原子范围内；通知失败不改变"保存／授权成功"这一事实，也不回滚（39 §15.3-16、39c §6.3 末段）。

### 5.3 已有同目标安排时

- 显示**沿用/合并后的实际日期**，不另编一个"首次日期"（39 §8.3 末句）。
- 若该目标被"暂不安排"排除，**必须明示仍被暂停，只有用户选「恢复此目标并开启」才解除**（39 §15.3-16、§9.1 规则表的第三行）。
- 若该目标已被笔记复习覆盖，界面说明"此内容已随笔记复习"，**且不增加第二个重复日程**（39 §8.3 末段）。

---

## 6. 决定五：排除优先于一切授权来源

39 §9.1 的规则表，本文件原文接收为合同（它是"入口不得各自解释"的那张表）：

| 操作 | 实际影响 |
| --- | --- |
| 暂停/移除笔记订阅或卡片订阅 | **仅停用该授权来源**；其他来源仍有效时显示原因 |
| 对目标选择"暂不安排" | **对本人在当前笔记内该目标的所有持续回访维度生效，优先于笔记和卡片授权**；不停止其他目标、不删除历史 |
| 在排除仍有效时开启该卡复习 | 明示该目标仍被暂停；只有"恢复此目标并开启"才解除——**不能暗中复活** |
| 延后某一次回访 | 只改明确的目标/维度或单次提醒及日期；笔记级批量延后**列明本次涉及范围**，不影响未来新增目标 |
| 略过首页建议或本批某题 | 只影响本次展示，**不等于取消订阅**，也不记作已复习 |

**实现约束**：排除是一个**与授权来源并列的状态**，不是"把来源删掉"。数据上它必须能表达"笔记订阅还在、卡片订阅还在、但这个目标被排除了"——否则"恢复"就无从谈起（§9.1："主动恢复后才重新进入"）。

**另外两条**（39 §9.1）：

- 目标排除**不静默取消**本人另外约定的一次性提醒；操作时说明是否还有该提醒，用户可一并取消。
- 排除仍有效时**主动学习被排除目标可以更新记录，但不会自动解除排除**。

---

## 7. 决定六：迟到、更正、改期、并发

39 §9.6、§16.19、§16.20。四条规则：

### 7.1 迟到结果

- 按**原作答时间与任务身份**归属历史，**不按"最后返回"覆盖较新的表现**。
- 若用户期间改了提醒日期、暂停、移除订阅，或**其他提交已经更新该项**，旧结果**不得覆盖这些决定**。
- 需要重算时**仍经调度服务**，基于全部适用事实与当前授权给**一次**明确回执。
- **失败后的保守展示调整与最终评估不能各消费一次同一日程**（39 §9.6 末段）。
- 用户已选择本次结束时，**不为收集新答案自动重开任务**。

### 7.2 更正 vs 补答（39 §16.25，不许混算）

| 情形 | 处理 |
| --- | --- |
| 复核发现**原回答本身已满足原评分条件**（系统漏判） | 以**更正记录**修正原判 → 影响调度 |
| 用户**看到反馈后才补出**原来没有的条件 | **保留原回答**，形成**新的解释/练习**，不覆盖第一次 |
| 判断仍不可靠 | 维持争议状态，**不强行选一方作为事实**；用户可将该项暂不安排 |

### 7.3 改期

- 手动日期约束属于**本次需求版本**，不是"永久禁止以后安排"的规则；处理完成／再次改期／明确恢复自动安排后按相应回执结束该约束。
- **手动日期约束仍有效时，自动策略不能把提醒提前**（39 §9.1 末段、§16.38）。

### 7.4 并发

- 同一目标已在另一页／轮次／设备处理中 → **优先恢复现有任务**；确实已并发产生的提交**分别保留**，但**不能重复消费同一待办**。
- 选题时预先去重，**提交时仍再次核对**权限、目标修订、授权与日程版本（39 §9.6）。
- 写入侧：§2.1 的 `expected`（乐观并发）不符即拒绝并回具体差异——**不自动把确认应用到另一项安排**（39b C3）。

---

## 8. 迁移与删除清单

**本文件不授权删除任何链路。** 下表是实施时的处置与核对方式：

| 现有部分 | 处置 | 调用方核对方式 |
| --- | --- | --- |
| `run-processing-tick.ts` 的 6 个写操作 | **改造**：改为调用调度服务，删除直写 | `grep -n "insert(reviewSchedules)\|update(reviewSchedules)" apps/api/src` → 收敛后应只剩调度服务一处 |
| `card-service.ts:1062` | 同上 | 同上 |
| `review-defer-service.ts:71` | 同上（`defer_once` 命令） | 同上 |
| `subject_type` 列 | **冻结语义、保留列** | 13 个读取模块（§1 的 grep 清单）逐个确认不依赖 `subject_type` 的取值做分支 |
| 旧 `policy_version='discrete-v2'` 的行 | **保留**，不追溯重写 | 读侧按行的 `policy_version` 解释，不按当前版本 |
| 13 个读取模块 | 保留；读侧统一走"按 (workspace, user, subject[, dimension]) 取 pending" | `grep -rln "reviewSchedules" apps/api/src` → 逐个人工确认 |

**删除的前置**：39d §3 的两条红线（不用 git 写操作删代码、删除前核对调用方并列范围）。

---

## 9. 验收判据（实施时逐条可跑）

| # | 判据 | 怎么算过 |
| --- | --- | --- |
| 1 | 写入点收敛 | `grep -rn "insert(reviewSchedules)\|update(reviewSchedules)" apps/api/src` **只剩调度服务一处** |
| 2 | 唯一键成立 | 对 `pending` 行，同一 `(workspace, user, subject_id, 维度)` 插入第二行**必须被拒**（数据库层，不是应用层先查后写） |
| 3 | 排除优先 | 构造"笔记订阅在 + 卡片订阅在 + 目标被排除"，断言**不产生待办**；解除排除后才产生 |
| 4 | 组合回执不部分提交 | 三张候选里一张版本冲突 → 断言**一张都没存**，且返回可解释冲突（39 §16.35） |
| 5 | 组合回执幂等 | 同一 `idempotencyKey` 重发 → **同一回执**，无新卡、无新订阅 |
| 6 | 通知失败不改事实 | 通知通道注入失败 → 保存/授权仍为成功，回执不变 |
| 7 | 旧含义不被重用 | 断言新版 `DISCRETE_V2_OUTCOMES` 的**每一个新取值**都在纯函数的判决表里有显式分支（exhaustive switch 编译期就挡） |
| 8 | 迟到不覆盖 | 用户改期后迟到结果返回 → 断言日期未被改回、且有一次带原因的调度回执 |
| 9 | 更正 vs 补答不混算 | 两条路径各自产生对应记录，原回答不被覆盖（39 §16.25） |
| 10 | 存量无悬空 | 审计查询的"两者都不命中"从 2 降到**经产品确认后的**期望值（不是无脑清零） |

---

## 10. 未决项与落点

| 未决项 | 为什么本文件不定 | 落点 |
| --- | --- | --- |
| 唯一索引里 `review_dimension` 用空串还是 `coalesce` 函数索引（§3.2 第 3 点） | 取决于迁移成本与既有读法 | 实施迁移时定 |
| 能力维度枚举的取值域 | 从目标侧派生，需要核 `learning_objectives_v2` 的维度词表 | W7-3 开工时核 |
| 4 个新 outcome 的间隔判决数值 | 属试用前冻结项 | 39 §18.4；W7-8 |
| `subject_type` 是否改名或删除 | 牵动 13 个读取模块 | W7 之后评估（本文件只冻结语义） |
| 2 行悬空引用的处置 | 需要产品确认 | 迁移前单独列表 |

---

## 附：本文件用到的实测读数（可复算）

```
# 1) 三处写入点
grep -rn "insert(reviewSchedules)\|update(reviewSchedules)" apps/api/src | grep -v test
  → run-processing-tick.ts:1813/1850/1864/1907/1935/1949
  → card-generation-v2/card-service.ts:1062
  → review/review-defer-service.ts:71

# 2) 唯一键不存在
select indexname, indexdef from pg_indexes where tablename='review_schedules';
  → 唯一索引只有 pkey(id) 与 (id, workspace_id)；subject_type/subject_id 是普通索引

# 3) 存量审计（§1.2 的查询）
  → 32 行；subject_type 全为 'card'；命中 objective 26 / 命中 card 4 / 都不命中 2；
    pending 21 / cancelled 1 / completed 10；带 policy_version 28

# 4) 策略唯一
packages/shared/src/scheduling-policy-v2.ts
  → calculateDiscreteV2Schedule() 纯函数；DISCRETE_V2_POLICY_VERSION="discrete-v2"；
    DISCRETE_V2_INTERVAL_TIERS=[1,3,7,14,30,60]；8 个 outcome

# 5) 状态枚举 6 值
packages/shared/src/enums.ts:75-83
  → pending / accepted / dismissed / completed / superseded / cancelled
```
