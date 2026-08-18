# 冻结记录 01-10：文件级改造方向（§19）

> 状态：**Confirmed（已确认）**
> 批准人：Repository Owner（阶段 01 W0 执行）
> 日期：2026-08-07
> 来源：`01-w0-contracts-and-baseline.md` 任务 01-10（原方案 §19）
> 约束级别：文件边界确认；作为各阶段实现与 Code Review 的参考。

## 交付物

新增/修改/不应修改的文件边界（W1~W9 的实现范围参考）。

## 新增文件建议清单（原文完整列表）

以下为原文完整清单，按原文分组（同一组内省略了共用路径前缀）。新增范围按原样分入 Shared、API/DB、Worker、Web、Quality、Docs 六类；带 `*` 的子项表示该目录下新增的子目录/文件，与源文档一致。

### Shared（`packages/shared/src/`）

- `learning-session-contracts.ts`
- `learning-scene-contracts.ts`
- `learning-scheduling-decisions.ts`
- `companion-shell-contracts.ts`

### API / DB（`apps/api/`）

- `apps/api/src/modules/companion-shell/`
- `apps/api/src/modules/learning-sessions/`
- `apps/api/src/modules/learning-companion/`
- `apps/api/src/modules/learning-exposure/`
- `apps/api/src/db/schema/learning-sessions.ts`

### Worker（`workers/ai-worker/src/learning-agent/`）

- `learning-agent/runtime`（* 子目录）
- `learning-agent/session-supervisor`（* 子目录）
- `learning-agent/scene-author`（* 子目录）
- `learning-agent/rubric-scene-critic`（* 子目录）
- `learning-agent/assessment-critic`（* 子目录）
- `learning-agent/grounded-tutor`（* 子目录）
- `learning-agent/grounded-answer-critic`（* 子目录）
- `learning-agent/tools/`（* 子目录）

### Web（`apps/web/`）

- `apps/web/components/global-companion/`
- `apps/web/components/learning-companion/`
- `apps/web/components/learning-scenes/`
- `apps/web/components/understanding-universe/`
- `apps/web/lib/page-companion/`

### Quality

- `packages/ai-quality/src/learning-session-supervisor-v1/`

### Docs

- `docs/image/learning-companion-character-action-reference.png`
- `docs/runbooks/learning-companion-rollout-rollback.md`
- `docs/evidence/learning-companion-v1/`

> 说明：上表为完整新增清单，未删减、未增加源文档之外的项目。

## 修改方向（原文要点）

### Auth/App Shell

- credential-safe auth manifest
- 全局锚点/侧板
- versioned onboarding
- 页面 registry
- trigger arbiter
- 隐藏/关闭与静态 fallback

### Validation

- 多模态 artifact
- evidence-aware Critic
- trust/facet
- assistance

### Review

- official scheduler adapter
- 路线启动
- formal/practice 结果

### Understanding

- 两数据平面
- 四透镜
- 行动入口
- 伴星 overlay
- origin-aware 回写

### Web

- coverage registry
- context/action adapter
- 一个航程主行动
- Scene Renderer
- 语音与替代输入
- 关闭后手动路径

### Shared

- Companion 与 Session/Episode/Scene/Disposition/Artifact/Trust/Facet contracts

### DB

- onboarding/global epoch
- workspace ledger
- ephemeral fences/leases
- audit TTL
- session/episode/artifact/assessment
- exposure/runtime/target guard
- outbox
- prefs/projection

### Worker/API

- Session Supervisor
- Scene Author/Activation
- 双 Critic
- Tutor/Grounded Critic
- ASR/LLM budget

### Quality

- credential-safe
- coverage
- stale action
- 多模态
- 泄漏
- grounding
- assessment
- a11y/fault

## 不应修改的边界（§19.3 完整）

以下边界逐条冻结，禁止越过：

1. Global Shell 不依赖 Session Supervisor 才能工作，不抓 DOM/截图代替页面 contract。
2. 不为「全站常驻」复制多套页面聊天 Agent。
3. 不把 Learning Session 逻辑塞入 Generation Supervisor。
4. 不让 Generation Supervisor 为用户维护理解状态。
5. 不删除现有 canonical validation/review 事实，优先兼容扩展。
6. 不为每种 Scene 建一条固定业务 pipeline。
7. 不将 Scene 模板/视觉动效/伴星人格写入 mastery/scheduler。
8. 不以向量索引代替 evidence、relationship publish governance 或 coverage 真相。

## 废弃代码处理规则

当某个文件、模块、函数或类型因架构演进（如 V1 → V2 升级、节点类型移除、数据模型切换等）不再被使用时：

1. **直接删除**，不要标记 `@deprecated`、不要注释掉、不要保留空壳文件。
2. 同步删除对应的测试文件、类型导出和所有引用。
3. 如果外部包通过 `index.ts` 导出了被删除的符号，需同步移除导出，不要保留 re-export 空壳。
4. 删除后执行全量 typecheck，确保没有遗留引用。

> 原则：**废弃即删除，不留僵尸代码。** 代码的历史版本由 Git 保留，不需要在代码库中用 `@deprecated` 或注释来标记已不使用的代码。

## 验收标准

- 文件边界确认；作为各阶段实现与 Code Review 的参考。
