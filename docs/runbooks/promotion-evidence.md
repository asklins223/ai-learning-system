# REL-01 灰度扩量 Promotion Evidence 模板

> 版本：1.0<br>
> 创建日期：2026-07-20<br>
> Owner：Release Owner / repository owner<br>
> 关联：ADR-0001、`docs/plans/AI学习系统-v0.5-版本实施计划-2026-07-18.md` §4.3、§6.8<br>
> 用途：记录 RC 灰度扩量每个阶段的门禁检查结果，作为 promotion 决策的不可变证据。

## 使用说明

本模板用于 v0.5 RC 灰度发布的三个扩量门槛。每个门槛必须独立填写并附证据链接。
任一门槛失败时，执行回滚流程（`docs/runbooks/rollback-v0.5.md`）并创建事故 Issue。

灰度顺序（计划 §6.6 M6）：
1. 创建 `v0.5.0-rc.1`，从 tag clean checkout 运行完整 release-check
2. 部署内部 workspace，观察至少 48 小时
3. 通过 48 小时快速门槛后扩到 1～2 个外部 workspace
4. 满 7 日且稳态 SLO 达标后扩到 5～15 人
5. 满 14 日、安全不变量、稳态 SLO、已知问题和反馈复盘满足后决定是否转正

---

## 门槛一：48 小时快速门槛

> 用途：决定是否从内部 workspace 扩到 1～2 个外部 workspace

### 基本信息

| 字段 | 值 |
| --- | --- |
| RC 版本 | `v0.5.0-rc.X` |
| 部署时间 | YYYY-MM-DD HH:MM UTC |
| 观察 window | 部署后 48 小时 |
| 内部 workspace 用户数 | |
| 决策人 | |

### 门禁检查

| 检查项 | 阈值 | 实际值 | 通过 | 证据 |
| --- | --- | --- | --- | --- |
| 安全不变量事件 | 0 | | ☐ | Prometheus alert 或日志查询链接 |
| 未归属 dead job | 0 | | ☐ | `SELECT count(*) FROM jobs WHERE status='dead' AND last_error IS NULL` |
| API 5xx 率 | < 1% | | ☐ | `rate(http_requests_total{status=~"5.."}[48h]) / rate(http_requests_total[48h])` |
| 持续积压告警 | 无 >30min | | ☐ | `max_over_time(oldest_pending_age_seconds[48h])` < 120s 或告警记录 |
| 跨 workspace 泄漏 | 0 | | ☐ | 安全不变量，容忍度为 0 |
| 不可恢复数据丢失 | 0 | | ☐ | 安全不变量，容忍度为 0 |
| Secret 泄漏 | 0 | | ☐ | privacy-scan.ts 结果 |

### 附加观察

| 指标 | 48h 观察值 | 备注 |
| --- | --- | --- |
| API 请求总量 | | 最小样本 ≥ 100 |
| API 成功率（status < 500） | | 目标 ≥ 99.5% |
| Job 终态数 | | succeeded + dead |
| Job 成功率 | | succeeded / (succeeded + dead) |
| 最老 pending age（p99） | | 目标 < 120s |
| 备份新鲜度 | | 目标 ≤ 24h |
| Worker metrics 可达 | | :9100/metrics 200 OK |

### 决策

- [ ] **通过**：扩量到 1～2 个外部 workspace
- [ ] **不通过**：执行回滚或修复后重新部署

| 决策人 | 签名 | 日期 |
| --- | --- | --- |
| | | |

---

## 门槛二：7 日稳态门槛

> 用途：决定是否从 1～2 个外部 workspace 扩到 5～15 人

### 基本信息

| 字段 | 值 |
| --- | --- |
| RC 版本 | `v0.5.0-rc.X` |
| 观察 window | 7 日 |
| 外部 workspace 数 | |
| 总用户数 | |
| 决策人 | |

### SLO 达标检查（计划 §4.2）

| SLI | 目标 | 7 日实际值 | 样本量 | 状态 | 证据 |
| --- | --- | --- | | --- | --- |
| API 请求成功率 | ≥ 99.5% | | ≥ 100 请求 | ☐ 达标 / ☐ insufficient_data | |
| 核心旅程合成可用性 | ≥ 99.5% | | ≥ 1,000 次 | ☐ 达标 / ☐ insufficient_data | |
| Job 业务成功率 | ≥ 98% | | ≥ 30 个终态 job | ☐ 达标 / ☐ insufficient_data | |
| 队列积压（p99） | < 120s | | ≥ 1,000 次采样 | ☐ 达标 / ☐ insufficient_data | |
| 学习卡端到端时长（Mock p95） | < 15s | | ≥ 30 次 | ☐ 达标 / ☐ insufficient_data | |
| 备份新鲜度（RPO） | ≤ 24h | | 连续监控 | ☐ 达标 / ☐ insufficient_data | |

> **重要**：样本不足项必须标记 `insufficient_data`，不得伪装成通过。

### 安全不变量检查

| 检查项 | 7 日结果 | 通过 |
| --- | --- | --- |
| 跨 workspace 泄漏 | 0 | ☐ |
| 不可恢复数据丢失 | 0 | ☐ |
| Secret 泄漏 | 0 | ☐ |
| 连续两次相同 P1 故障 | 0 | ☐ |

### 已知问题

| Issue | 严重度 | Owner | 影响范围 | 规避方案 |
| --- | --- | --- | --- | --- |
| | | | | |

### 决策

- [ ] **通过**：扩量到 5～15 人
- [ ] **不通过**：执行回滚或修复后继续观察

| 决策人 | 签名 | 日期 |
| --- | --- | --- |
| | | |

---

## 门槛三：14 日发布门槛

> 用途：决定 `v0.5.0-rc.X` 是否转正为 `v0.5.0`

### 基本信息

| 字段 | 值 |
| --- | --- |
| RC 版本 | `v0.5.0-rc.X` |
| 观察 window | 14 日 |
| 总用户数 | |
| 决策人 | |

### 最终门禁检查

| 检查项 | 结果 | 通过 | 证据 |
| --- | --- | --- | --- |
| 安全不变量（14 日） | 0 事件 | ☐ | |
| 稳态 SLO 全部达标 | 门槛二通过 | ☐ | |
| 已知问题全部有 Owner + 影响评估 + 规避方案 | | ☐ | |
| 反馈复盘完成 | | ☐ | 复盘文档链接 |
| Release manifest 与线上 digest 一致 | | ☐ | manifest 中的 images.digest = `docker image inspect` |
| 回滚 runbook 演练通过 | | ☐ | 演练证据链接 |
| 备份恢复演练通过（RTO ≤ 2h） | | ☐ | restore.sh 输出 |
| 无未关闭 P0/P1 | | ☐ | Issue tracker 查询 |

### RC 硬门禁回顾（计划 §4.1）

| 门禁 | RC 发布时状态 | 当前状态 |
| --- | --- | --- |
| canonical main 与目标 SHA 已确认 | ☐ | ☐ |
| 所有 package 版本一致 | ☐ | ☐ |
| 空库/旧库/重复迁移/备份恢复通过 | ☐ | ☐ |
| API/Worker/migrator 受限角色和 RLS 权限矩阵全绿 | ☐ | ☐ |
| 跨 workspace 读写/关联/导出/删除 0 泄漏 | ☐ | ☐ |
| 双 Worker 竞争及故障注入无重复副作用 | ☐ | ☐ |
| 关键浏览器 E2E 三视口通过 | ☐ | ☐ |
| E2E 无未允许 console.error/page error | ☐ | ☐ |
| 固定黄金集 ≥ 30 篇，阈值达标 | ☐ | ☐ |
| 覆盖率达到 lines ≥ 70% / branches ≥ 60% | ☐ | ☐ |
| 无未列入 allowlist 的 skip/todo | ☐ | ☐ |
| 生产依赖和镜像无 high/critical 漏洞 | ☐ | ☐ |
| 发布清单包含 commit/tag/迁移/镜像 digest/测试摘要 | ☐ | ☐ |
| Alpha 环境定时加密备份 + 恢复演练通过 | ☐ | ☐ |
| 无未关闭 P0/P1 | ☐ | ☐ |

### 转正决策

- [ ] **通过**：发布 `v0.5.0` 正式版
- [ ] **不通过**：继续 RC，不以日期强行转正

| 决策人 | 角色 | 签名 | 日期 |
| --- | --- | --- | --- |
| | Release Owner | | |
| | Security Reviewer | | |
| | Product Owner | | |

### 转正后行动

| 行动 | 负责人 | 时限 |
| --- | --- | --- |
| 创建 `v0.5.0` annotated tag | Release Owner | 决策后立即 |
| 更新 release manifest 为正式版 | Release Owner | tag 后 1 小时 |
| 通知所有 Alpha 用户版本转正 | Product Owner | tag 后 24 小时 |
| 归档 RC 期间的 promotion evidence | Release Owner | tag 后 48 小时 |
| 开始 V1 决策评估（§4.4 退出指标） | Product Owner | 观察期结束后 |

---

## 附录 A：暂停扩量条件

任一以下条件触发时，停止扩量并执行回滚/修复流程（计划 §4.3）：

1. 任一 P0 事件
2. 跨 workspace 数据泄漏
3. 不可恢复数据丢失
4. 连续两次相同 P1 故障复现
5. 安全不变量告警
6. Secret 泄漏

触发后操作：
1. 立即执行 `docs/runbooks/rollback-v0.5.md` 中的回滚流程
2. 创建事故 Issue 并关联 P0/P1 标签
3. 通知所有受影响用户
4. 完成 root cause 分析后重新评估扩量

---

## 附录 B：Release Manifest Approvals 填写指南

release manifest JSON 中的 `approvals` 字段在灰度期间按以下时间线填写：

```json
{
  "approvals": {
    "owner": {
      "decision": "approved",
      "approver": "@asklins223",
      "decidedAt": "2026-07-2xT..:..:..Z",
      "evidence": "docs/runbooks/promotion-evidence.md#门槛一"
    },
    "securityDataReviewer": {
      "decision": "approved",
      "approver": "@reviewer-name",
      "decidedAt": "2026-07-2xT..:..:..Z",
      "evidence": "docs/runbooks/sec01-independent-review-request.md#6-审查者信息"
    }
  }
}
```

- `owner.decision` 在门槛一通过后设为 `approved`
- `securityDataReviewer.decision` 在 SEC-01 独立 review 通过后设为 `approved`
- 两项均为 `approved` 后，release manifest 可通过 contract verifier 的完整校验
