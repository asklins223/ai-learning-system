# P5 known-issues（evidence）

## 新增（P5）

1. **容器 migrate journal 路径与宿主挂载不一致**
   - 现象：`docker compose run --rm migrate` 输出 "Migrations complete" 但不执行 0090+（journal 在容器内与宿主不同步）。
   - 处理：0090–0095 均手动 `psql -f` 应用（SQL 幂等）；CI/重建环境需根治挂载或迁移执行方式。
2. **ailearn_worker GRANT 间歇丢失**
   - 现象：companion-conversation 集成测试间歇 `permission denied for table companion_conversations`。
   - 根因：0088/0091 的 GRANT 位于 DO 块（依赖角色 bootstrap 顺序）；且 0090+ 未自动应用导致 0094 未生效。
   - 处理：0094_companion_worker_grants_fix.sql 强制重授 + 手动应用；恢复后 companion-conversation 23/23。
3. **jsonb 参数行为差异**
   - drizzle `tx.execute(sql\`${JSON.stringify(x)}\`)` 对 jsonb 列正常解析为对象（实验验证）；
   - postgres.js 原生 tag 对 jsonb 列会双重序列化（存字符串值）；
   - 处理：worker companion-action handler 对 payload 增加字符串容错（JSON.parse fallback）；测试 seed 用 `::jsonb` + 字符串或对象传参。
4. **ask_grounded_tutor 为确定性引导**
   - 当前 worker 对该动作返回确定性引导文本（「请先完成当前卡片…」）；grounded 增强问答后续接入。
5. **FK 循环**（companion_action_proposals.action_run_id ↔ companion_action_runs.proposal_id）
   - 删除顺序必须：清 action_run_id → 删 runs → 删 proposals；测试 cleanup 已按此实现。

## 既有（P3/P4 延续）

6. desktop dmg hdiutil/APFS 宿主限制（.app 可产出；dmg 未完成）。
7. make verify coverage gate 本地 fail-closed（CI 专用基准；测试步骤全过）。
8. worker 组合测试 runner 挂起（各 handler 单独跑绿）。
9. Docker buildx 权限（宿主 `.docker/buildx` 受限）。
10. ~~Live2D Mao PRO 许可边界~~（已解除：Owner 2026-08-11 确认 Mao PRO 为 Live2D Free Material，免费使用、无需商业许可，`commercialReleaseAllowed=true`；再分发仍受限 `redistributionAllowed=false`）。
