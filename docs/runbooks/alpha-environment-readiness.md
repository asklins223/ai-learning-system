# Private Alpha 环境准备清单

> Status: Development contract accepted；外部资源未声明已配置<br>
> Owner: Platform Owner<br>
> Related: ADR-0001、ADR-0003、ADR-0005、ADR-0006、ADR-0007、ADR-0008、`docs/testing/v0.5-fixture-contract.md`

## 环境边界

Alpha 使用独立 PostgreSQL、API、Worker、Web、备份对象存储和合成探针身份。不得复用开发数据库、个人 MinIO bucket 或 RC Provider Key。最多 3 个活跃 workspace、15 名用户。

## 上线前必须由 Owner 填写的外部证据

- [ ] 环境 URL、区域和基础设施 Owner；
- [ ] API/Worker/migrator 三个独立数据库 DSN，角色矩阵验证报告；
- [ ] AI credential encryption key 的 secret manager 引用和轮换 Owner；
- [ ] DashScope RC Key 的预算 Owner、10 美元等值硬上限和精确 model/revision 证据；
- [ ] 独立备份 bucket、encryption recipient、恢复私钥 custodian；
- [ ] metrics/log/alert endpoint、值班 Owner 和通知通道；
- [ ] synthetic monitor 固定 workspace/user，内容只用公开 fixture；
- [ ] 独立 security/data reviewer 与批准证据；
- [ ] Alpha 用户支持渠道、隐私说明、已知限制与删除联系入口。

任何真实 secret、DSN、邮箱名单或恢复私钥都不得提交到仓库。仓库只保存 secret manager 的逻辑键名和验证报告中的脱敏 fingerprint。

## 部署门禁

1. 从 annotated RC tag 的 clean checkout 运行 `release-check`；
2. manifest 的 commit/tag/migration/image digest 与部署输入逐项相等；
3. 运行 RLS、fixture、浏览器、双 Worker、privacy canary 和 backup smoke；
4. 创建第一份加密备份并在隔离环境恢复；
5. 只有 readiness、告警和合成旅程全绿才邀请内部 workspace；
6. 按计划 48 小时、7 日、14 日门槛扩量，不以日期覆盖失败。

## Fail-closed 条件

缺少任一数据库受限角色、迁移/policy 版本不匹配、备份超过 24 小时、Provider revision 不可识别、manifest digest 不一致或 security/data reviewer 未确认时，不允许进入 RC/Alpha。
