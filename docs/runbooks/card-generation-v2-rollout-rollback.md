# Card Generation v2 rollout / rollback Runbook

> 状态：Active  
> Owner：API / Worker / Web on-call  
> 最后更新：2026-07-26  
> 关联计划：[学习卡生成引擎 v2](../plans/learning-card-generation-engine-v2.md)  
> Gate 记录：[M6 Gate](../evidence/card-generation-v2/m6-gate.md)

## 1. 目的与不可破坏的不变量

Card Generation v2 已是新请求的默认路径。它把一个生成请求建模为可恢复的
generation run，并通过 planner、文本/图片 map、section reduce、deck plan、
card render、全局校验和 publish 检查点生成一个 Card Set。

发布、观察和回滚期间必须同时保持以下不变量：

1. `succeeded` 的完整结果正文覆盖率为 `10000` bps；有 required image 时图片
   覆盖率也为 `10000` bps。
2. active key point 只引用服务端校验过的 exact text span 或合格 image region。
3. 旧 generation epoch 不得激活或替换新请求的结果。
4. `partial_ready` 只能产生带覆盖警告的 `partial_ready` card set 和 archived
   cards；它不能 supersede 既有 active 完整结果，不能进入验证或复习。
5. publish 重试不得重新调用 Provider，也不得重复创建 Card Set。
6. 回滚只切换应用路径，不回滚或删除 v2 数据。

任何一项违反都属于立即停止扩量并回滚的硬故障。

## 2. 开关语义

| 组件 | 开关 | 默认 | 生效方式 |
| --- | --- | --- | --- |
| API / Worker | `CARD_GENERATION_V2_ENABLED` | 开启；未设置或空值也视为开启 | 重启进程 |
| Web | `NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED` | 开启；未设置或空值也视为开启 | **重新构建并部署 Web** |

生产配置应显式写 `true`，不要依赖缺省值。

回滚是一个不可拆分的操作：

```dotenv
CARD_GENERATION_V2_ENABLED=false
NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED=false
```

只改服务端会让 Web 继续展示 v2 run UX；只改 Web 会让新旧客户端对同一 API
产生不同预期。禁止只切一个开关。

## 3. 发布前准备

### 3.1 绑定发布证据

记录并保存：

- Git commit、Web/API/Worker 镜像 digest；
- 数据库当前 migration end 和目标 migration end（包含 `0049`）；
- Provider、model revision、prompt/pipeline version；
- 发布前 24 小时的队列、Provider、延迟和失败基线；
- 执行人、审批人、开始时间和回滚负责人；
- 本 Runbook 第 4 节所有命令的原始 CI artifact。

没有可比较基线时，不得用临时猜测的错误率或时延数字代替发布门槛。

### 3.2 数据库备份与迁移

1. 创建加密备份并完成隔离恢复验证。
2. 前向应用 migration 至 `0049`。
3. 运行 migration fresh / upgrade / repeat 和 RLS 契约。
4. 确认旧 learning card、legacy active card 和显式 rollback handler 仍可读取。

`0049` 是 **forward-only** migration：它不可通过 down migration 回滚。它保留
legacy 行与 rollback handler 的向后兼容，所以应用回滚时数据库继续停留在
`0049`。禁止删除 v2 表、列、索引、约束或 generation rows 来“恢复旧版”。

### 3.3 发布顺序

1. 数据库前向迁移到 `0049`。
2. 部署同时理解 legacy 与 v2 job type 的 Worker。
3. 部署 API。
4. 使用两个开关都为 `true` 的环境重新构建并部署 Web。
5. 运行冒烟检查，再开始观察窗口。

不要先部署一个不认识 v2 job type 的旧 Worker；数据库中可能已经存在可恢复的
v2 checkpoints。

## 4. 验证命令

### 4.1 静态、单测与构建

仓库根目录：

```bash
make verify
make release-check
```

Card Generation v2 定向检查：

```bash
node --import tsx --test \
  packages/shared/src/feature-flags.test.ts \
  workers/ai-worker/src/__tests__/card-generation-m6-retirement-contract.test.ts \
  workers/ai-worker/src/__tests__/card-generation-run.test.ts \
  workers/ai-worker/src/__tests__/card-generation-map-contract.test.ts \
  workers/ai-worker/src/__tests__/card-generation-partial-contract.test.ts \
  workers/ai-worker/src/__tests__/card-set-planner.test.ts \
  workers/ai-worker/src/__tests__/card-set-pipeline-contract.test.ts \
  apps/api/src/__tests__/card-generation-v2-contract.test.ts
```

Web Card Set 定向检查：

```bash
cd apps/web
node --import tsx --test \
  lib/__tests__/api.test.ts \
  lib/__tests__/card-set-ui-contract.test.ts \
  lib/__tests__/card-generation-partial-ui-contract.test.ts \
  lib/__tests__/card-partial-result-ui.test.ts
npm run typecheck
```

### 4.2 PostgreSQL 集成

使用专用、可销毁的测试数据库，串行执行共享数据库的测试；不得指向生产库。

```bash
export CARD_GENERATION_V2_TEST_ADMIN_URL='postgres://.../ailearn_card_v2_test'

node --import tsx --test --test-concurrency=1 \
  apps/api/src/integration-tests/card-generation-v2-postgres.integration.ts \
  apps/api/src/integration-tests/card-generation-text-v2-postgres.integration.ts \
  workers/ai-worker/src/integration-tests/card-generation-run-postgres.integration.ts \
  workers/ai-worker/src/integration-tests/card-generation-text-pipeline-postgres.integration.ts
```

图片/partial 流水线需要独立测试库和对象存储：

```bash
export CARD_GENERATION_IMAGE_V2_TEST_ADMIN_URL='postgres://.../ailearn_card_image_v2_test'
# 同时设置测试专用 STORAGE_ENDPOINT / MINIO_ROOT_USER / MINIO_ROOT_PASSWORD

node --import tsx --test --test-concurrency=1 \
  apps/api/src/integration-tests/card-generation-partial-v2-postgres.integration.ts \
  workers/ai-worker/src/integration-tests/card-generation-image-pipeline-postgres.integration.ts
```

测试输出必须记录数据库名称、migration end、commit 和时间。若因为缺少测试库、
对象存储或 Provider 而未执行，Gate 中必须写“待执行”，不能记为通过。

### 4.3 冒烟旅程

至少覆盖：

1. 短文本：创建 run，刷新页面后恢复进度，最终打开 Card Set。
2. 极长文本：确认分片、reduce、deck plan 和分页 Card Set 全部可见，不存在整篇
   静默截断。
3. 多图：所有 required image 成功时得到完整结果和 `10000` bps 图片覆盖。
4. 图片失败：strict run 进入 `needs_attention`；只有所有者明确排除后才产生
   `partial_ready`，并展示缺失覆盖警告。
5. 并发版本：先后创建两个 note version 的 run，旧 epoch 不得替换新结果。
6. 取消：取消 queued/running run，迟到 Worker 不得发布。
7. publish retry：故障注入后重试，Provider 调用数不增加，Card Set 不重复。

## 5. 只读数据库核查

以下查询仅用于诊断。通过受限只读账户执行，不要把 title、正文、claim、quote
或完整 Provider 响应复制进工单。

### 5.1 在途 run

```sql
SELECT
  id,
  status,
  stage,
  generation_epoch,
  required_units,
  completed_units,
  failed_units,
  required_images,
  completed_images,
  updated_at
FROM card_generation_runs
WHERE status NOT IN ('partial_ready', 'succeeded', 'cancelled', 'superseded')
ORDER BY updated_at ASC;
```

### 5.2 新请求实际执行模式

```sql
SELECT
  provider_snapshot->>'executionMode' AS execution_mode,
  count(*) AS run_count
FROM card_generation_runs
WHERE created_at >= now() - interval '30 minutes'
GROUP BY 1
ORDER BY 1;
```

开启时新请求应为 `text_v2` / `multimodal_v2`；两个回滚开关生效后，新请求应为
`legacy_bridge`。不要改历史 run 的 `provider_snapshot`。

### 5.3 完整结果覆盖硬门槛

```sql
SELECT id, status, source_coverage_bps, image_coverage_bps
FROM card_generation_runs
WHERE status = 'succeeded'
  AND provider_snapshot->>'executionMode' IN ('text_v2', 'multimodal_v2')
  AND (
    source_coverage_bps IS DISTINCT FROM 10000
    OR image_coverage_bps IS DISTINCT FROM 10000
  );
```

结果必须为 0 行。

> 注意：本检查只对 v2 执行模式有意义。`legacy_bridge` run 成功时
> coverage 字段为 NULL（旧链路没有覆盖核算）——不加 executionMode
> 过滤的话，回滚演练期间每个成功的 legacy run 都会误报违规，
> 导致 §8.4 第 5 步的回滚验证永远失败。

### 5.4 partial 不得激活

```sql
SELECT
  card_set.id AS card_set_id,
  card_set.activated_at,
  count(*) FILTER (WHERE card.status = 'active') AS active_cards
FROM learning_card_sets AS card_set
LEFT JOIN learning_cards AS card
  ON card.workspace_id = card_set.workspace_id
 AND card.card_set_id = card_set.id
WHERE card_set.status = 'partial_ready'
GROUP BY card_set.id, card_set.activated_at
HAVING card_set.activated_at IS NOT NULL
    OR count(*) FILTER (WHERE card.status = 'active') > 0;
```

结果必须为 0 行。若该 note 在 partial 之前已有 active 完整 Card Set，它必须继续
保持 active；partial 结果不能 supersede 它。

### 5.5 Card Set 发布完整性

```sql
SELECT card_set.id
FROM learning_card_sets AS card_set
LEFT JOIN learning_cards AS overview
  ON overview.workspace_id = card_set.workspace_id
 AND overview.card_set_id = card_set.id
 AND overview.scope = 'overview'
WHERE card_set.status = 'active'
GROUP BY card_set.id
HAVING count(overview.id) <> 1;
```

结果必须为 0 行。更完整的 candidate exactly-once、typed evidence、ordinal 和
tenant FK 检查由 migration / Worker PostgreSQL 集成测试负责。

## 6. 指标与观察面板

当前实现使用通用的低基数 API/Worker Prometheus 指标；generation run 的覆盖、
epoch 和 partial 安全性仍以第 5 节的只读 SQL 与集成测试作为硬证据。不要在
专用 run 指标尚未落地时伪造同名时序。

建议面板至少包含：

```promql
# v2 DAG job 成功/dead 速率
sum by (type, status) (
  rate(ailearn_job_terminal_total{
    type=~"plan_card_generation|analyze_card_image|map_card_generation|reduce_card_generation|plan_card_set|render_card_generation|publish_card_generation"
  }[5m])
)

# v2 DAG job p95
histogram_quantile(
  0.95,
  sum by (le, type) (
    rate(ailearn_job_duration_seconds_bucket{
      type=~"plan_card_generation|analyze_card_image|map_card_generation|reduce_card_generation|plan_card_set|render_card_generation|publish_card_generation"
    }[5m])
  )
)

# 全局队列压力和最老 pending
ailearn_job_queue_depth{status="pending"}
ailearn_job_oldest_pending_age_seconds

# 重试、lease lost 与不可重试 dead
sum by (type) (rate(ailearn_job_retries_total[5m]))
sum by (type) (rate(ailearn_job_lease_lost_total[5m]))
sum by (type) (rate(ailearn_job_non_retryable_dead_total[5m]))

# Provider 调用、错误和 p95
sum by (operation, status) (rate(ailearn_provider_calls_total[5m]))
sum by (operation, error_category) (rate(ailearn_provider_errors_total[5m]))
histogram_quantile(
  0.95,
  sum by (le, operation) (
    rate(ailearn_provider_call_duration_seconds_bucket[5m])
  )
)
```

监控和日志中只允许 run/unit/job/artifact ID、短 fingerprint、计数、stage、安全
错误码、耗时和 Provider request ID；禁止正文、OCR 全文、claim、quote、密钥、
原始 lease token 或完整对象存储 URL。

## 7. 放量门槛与回滚触发

| 类别 | 放量门槛 | 触发动作 |
| --- | --- | --- |
| 正确性 | 第 1 节六项不变量全部满足；SQL 硬检查 0 行 | 任一违反立即停止并回滚 |
| 覆盖 | 完整 run 的 source/image coverage 均为 `10000` bps | 任一完整结果不足立即回滚 |
| 并发 | stale activation 0；取消后迟到发布 0 | 任一例立即回滚 |
| partial | 必须显式选择、警告可见、旧 active 不变 | 任一例立即回滚 |
| 幂等 | publish retry 的新增 Provider 调用 0、重复 Card Set 0 | 任一例立即回滚 |
| 短笔记延迟 | p95 相对已冻结基线回退不超过 15% | 超过门槛停止扩量；连续两个观察窗仍超标则回滚 |
| API / UI | snapshot/入队 API p95 ≤ 1s；后端状态变化 2s 内可见 | 连续两个观察窗超标则停止扩量 |
| 队列 / Provider | retry、dead、oldest pending、Provider error 不高于已批准基线预算 | 无基线或连续两个观察窗超预算则停止扩量 |

至少经过预发布冒烟、受控小流量和完整观察窗后才能扩大范围。真实 Provider、
成本和长文 p95 没有样本时应标记 `insufficient_data`，不能视为通过。

## 8. 回滚步骤

### 8.1 决策与冻结

1. 停止扩量，记录触发指标、影响范围、首个异常时间和当前镜像 digest。
2. 暂停人工重试和新 partial 排除操作。
3. 查询第 5.1 节在途 run，按 `runId` 建立清单。
4. 不修改 generation epoch，不删除 run/unit/candidate/job 行。

### 8.2 同时切换两个开关

在同一个变更单中设置：

```dotenv
CARD_GENERATION_V2_ENABLED=false
NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED=false
```

然后：

1. **重新构建并部署 Web**，使 `NEXT_PUBLIC_...=false` 写入客户端 bundle。
2. 重启 API，使新 generation run 进入 `legacy_bridge`。
3. 重启 Worker，但使用仍包含 legacy 与 v2 handler 的 rollback-capable 镜像。
4. 清除 CDN/静态资源缓存时只清目标版本；不要让旧 public flag bundle 长期存活。

仅重启 API/Worker、但不重建 Web，不算完成回滚。

### 8.3 安全处理在途 v2 run

关闭开关只影响**新请求的路径选择**，不会把既有 v2 run 改写成 legacy run。
每个在途 run 只能二选一：

- **安全完成**：保留当前 rollback-capable Worker，让既有 v2 job 按原
  fingerprint、epoch 和 checkpoints 运行到 `succeeded` / `partial_ready`；
- **安全取消**：由 workspace owner 调用
  `POST /card-generation-runs/:id/cancel`。取消事务会把 run 标记为
  `cancelled`、撤销 pending/running job lease 并取消未完成 unit；迟到 Worker
  必须在 fence 处停止。

不要：

- 把旧 v2 run 重新入队为 legacy；
- 手工把 run/job/unit 状态改成 succeeded；
- 在仍有 v2 job 时部署不认识 v2 job type 的 Worker；
- 通过删除行或回滚 migration 来清空在途任务。

只有第 5.1 节查询为 0 行后，才可考虑切换到更旧的 Worker 镜像；该镜像仍必须
通过 migration `0049` 的兼容性检查。

### 8.4 回滚后验证

1. 两个开关在运行配置中都为 `false`，Web bundle 已重建。
2. 新请求的 `executionMode` 为 `legacy_bridge`。
3. 在途 v2 run 已有明确的终态或 owner 取消记录。
4. 旧 active Card Set / card、验证和复习仍可读取。
5. partial 安全查询、完整 coverage 查询和 Card Set 完整性查询均通过。
6. readiness、核心生成旅程、队列和 Provider 指标恢复到基线。
7. 数据库 migration end 仍为 `0049`。

## 9. 恢复 v2

完成根因修复和相同验证后，再以一个新发布执行：

1. 保持数据库在 `0049` 或更高前向兼容版本。
2. 同时把两个开关设为 `true`。
3. 重新构建 Web，重启 API 和 Worker。
4. 从小流量重新开始，不沿用回滚前的观察窗。
5. 把新 commit、镜像 digest、测试 artifact 和观察结果追加到
   [M6 Gate](../evidence/card-generation-v2/m6-gate.md)。
