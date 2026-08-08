# 决策记录 06-1：单 Key Point 可信纵切（§9.1）

> 状态：**Frozen（已冻结）**
> 执行：阶段 06（W5）任务 06-1
> 日期：2026-08-08
> 来源：`06-w5-vertical-slice-scheduler.md` 任务 06-1（原方案 §9.1）
> 约束级别：voice 与 silent 两条主路径在同一 Key Point 上均可完成并产生正确
> disposition；只有 official `create_initial/consume_pending` 的完整 mastery
> Episode 才创建/消费 schedule，并恰好留下一个 active schedule；提示前的完整
> 正式 Episode 可提交，提示后的操作全为 practice。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/vertical-slice.ts`：单 Key Point 纵切编排——
  stabilize（voice recall / structured-proof-v1 → mastery Episode）与 clarify
  （独立诊断 → 结果 → 引导练习）两条主路径的状态机与校验（纯函数 + 可注入
  `VerticalSliceRepository` 与 `CommitExecutor`）。
- `apps/api/src/modules/learning-sessions/vertical-slice.test.ts`：voice/silent 两
  路径、mastery_eligible 签发条件、create_initial/consume_pending 恰好一 active
  schedule、提示后 practice 单测（node:test + assert，DB 走内存 repo）。
- 本文件：决策记录。

## 2. 路径语义与状态机

`VerticalSliceIntent = "stabilize" | "clarify"`，均绑定单个 Key Point。

### stabilize（重新看看）

```
stabilize: collecting → verifying → issuing → committing → done
           │             │           │            └─ commit_failed → done(failed)
           │             │           └─ trust_issued
           │             └─ verify_failed → done(support_only)   # 只保留 support artifact
           └─ 任意 → mark_stale → done(stale) / cancel → done(cancelled)
```

- `collecting`：语音回忆收集 / bundle 结构 Scene 运行（预冻结、无中途反馈）；
- `verifying`：artifact 全量锁定 + fingerprint 匹配 + 无 assistance 校验；
  voice 做 `evaluateVoiceRecall`（覆盖全部 required rubric/facets → 可签发
  `mastery_eligible`，否则最高 `facet_eligible`）；silent 做 `evaluateSilentBundle`
  （§7.4 全部条件：bundle 完整 + structured-proof-v1 资格 + 等价 Gate + 联合覆盖
  全部 required rubric + reducer 可评估 → 归一 canonical outcome）；
- `issuing`：`resolveMasteryEligibility` 服务端签发 `effectiveClass`
  （assisted/integrityFailure → `not_assessable`，fail closed）；
- `committing`：`resolveStabilizeScheduleSideEffect` 决定唯一 schedule 副作用。

### clarify（再弄清一点）

```
clarify: independent_diagnosis → result_presented → guided_practice → done
         └─ hint_given（内容性提示/示例/排除项）→ 此后全部 practice_only
```

`resolveClarifyCommittability`：
- 提示前（step ∈ independent_diagnosis|result_presented && !contentAssisted）
  + 完整 + 已锁 → 完整正式 Episode 可提交（formal）；
- 提示后（guided_practice 或 contentAssisted）→ 可提交但全为 practice_only
  （编排强制 `effectiveTrustClass=PRACTICE_ONLY` + `formalPlanKind="practice"` +
  `policyAllowed=false` → COMMIT 归 `practice_or_diagnostic`，0 canonical/0 schedule/0 review attempt）。

## 3. 唯一 schedule 写路径（§9.1）

`resolveStabilizeScheduleSideEffect` 只对以下全部成立返回 `create_initial/consume_pending`：
planKind 是 `voice_mastery|structured_mastery_bundle`、authorizedAction 是
`create_initial/consume_pending`、episode 完整、masteryEligible、bundle 无 blocked。
其余（record_only/no_effect/未完整/未 mastery/blocked）一律 `none`（0 写）。

`assertSingleActiveSchedule` 在 commit 后断言恰好 1 条 pending；
DB 层 `review_schedules_pending_unique_idx`（workspace,user,keyPoint）pending
唯一索引是最终兜底（02-1 已冻结）。

## 4. 编排与端口边界

`stabilizeEpisode` / `clarifyEpisode` 为薄编排：读 Episode 与 artifacts/
assessments（`VerticalSliceRepository` 只读端口）→ 纯函数校验 → 构造
`EpisodeCommitInput`（`buildEpisodeCommitInput`）→ 注入的 `CommitExecutor`
（真实为 `episode-commit.commitEpisode` 绑事务端口）。编排层 0 直接 DB 写；
正式结果全部由 COMMIT 层落入现有 canonical facts + outbox（见决策记录 06-2）。

## 5. 收口与后续

- `RubricTargetView` 的 `facet` 字段目前为字符串；后续 06-3 落
  `validation_point_assessments` 时以 `@ailearn/shared` 的 `CapabilityFacet` 收口。
- incomplete silent bundle 在第 1 步（§8.6）结束：编排层 `committable=false`
  （不调用 COMMIT），只保留 support artifact，绝不因 `record_only` 落入 facet
  canonical fact。
- 语音未全覆盖（facet_eligible）但授权为 create_initial 的 Episode 仍会进入
  COMMIT 并由 §8.6 优先级链 fail closed 为 `operational_only`（不伪装 facet）——
  这是契约语义而非编排遗漏。

## 6. 验收

- [x] voice 与 silent 两条主路径在同一 Key Point 上均可完成并产生正确 disposition；
- [x] 只有官方 `create_initial/consume_pending` 的完整 mastery Episode 才建/消
  schedule，且 commit 后恰好一个 active schedule；
- [x] 语音路径覆盖全部 required rubric/facets 时签发 `mastery_eligible`；
- [x] silent bundle 满足 §7.4 全部条件时归一 canonical outcome；
- [x] 提示前的完整正式 Episode 可提交，提示后的操作全为 practice。
