# P3 已知问题（Known Issues）

1. **desktop dmg 创建失败（宿主环境）**
   - 现象：`npm run dist:arm64` 最后一步 `hdiutil create ... -fs APFS` 退出码 1。
   - 根因：宿主 macOS 的 hdiutil APFS 卷创建限制（磁盘/权限），非代码问题。
   - 已产出：`apps/desktop/release/mac-arm64/AI Learn.app`（arm64，267M，含可执行文件）。
   - 状态：未验证（dmg 未产出）；需在 CI 或其他机器完成打包验证。

2. **worker 组合测试 runner 挂起（既有问题，非 P3 引入）**
   - 现象：`node --import tsx --test $(find src -name '*.test.ts' -not -path '*/agent/*')` 超时无输出。
   - 现状：各 handler 单独运行全绿（companion-dialogue 8/8、tts-segments 6/6、learning-session-assessment 4/4、ffprobe 4/4）。
   - 状态：未验证（组合 runner）；单测已覆盖。

3. **worker 全量测试套件（`npm test` in ai-worker）挂起**
   - 现象：worker 根 `npm test`（含 agent/ 目录与组合 runner）2 分钟超时。
   - 现状：本阶段交付的 handler 测试均单独运行通过。
   - 状态：未验证。

4. **Electron 真机场景（§3.3 步骤 4）未执行**
   - 现象：本轮未启动真实 Electron 应用做麦克风/播放/TTS 端到端人工验证。
   - 状态：未验证；ownerReviewRequired。

5. **postgres.js jsonb 双重序列化（已修复）**
   - 现象：`${JSON.stringify(payload)}` 绑 jsonb 列会把 payload 存成字符串值。
   - 修复：所有 companion event/message/blocks/delta 的 payload 改为传对象（postgres.js 自动序列化）。
   - 验证：集成测试 23/23（SSE/voice.segment.ready/TTS ref 重读）覆盖。

6. **make verify 的 coverage gate 本地 fail-closed（环境限制，非代码）**
   - 现象：`[coverage] changed-lines: need 80% → NOT-EVALUATED`，7 门禁失败。
   - 根因：changed-lines coverage 需要 base/head-aware 配置（CI 提供），本地无基准 → fail closed。
   - 状态：未验证（CI）；verify 的测试/契约/schema 镜像/budget/deploy-readiness 步骤全部通过。

7. **db-commit-port 集成测试既有 bug（本次修复）**
   - 现象：`trailing junk after numeric literal at or near "43d4"`（learning_episodes 有数据后暴露）。
   - 根因：drizzle 0.45 queryChunks 参数是纯 string（非 `{value}` 包装），测试 makeTxAdapter 拼接未加引号。
   - 修复：makeTxAdapter 按 chunk 类型区分 SQL 片段/参数（参数加引号）。
   - 验证：db-commit-port 2/2。

8. **schema 镜像缺失（本次补齐）**
   - 现象：verify-schema-mirror 报 apps/api 缺 5 个 schema 文件 + index.ts 漂移。
   - 修复：镜像 companion-conversations/companion/learning-exposure/learning-sessions/outbox + index；companion-conversations.ts 补 char import（两处）。
   - 验证：`database schema mirror OK (18 files)`；packages/db schema-contract 白名单补 6 张 companion 表（5/5）。

9. **P3 集成测试 jsonb 传参对齐仓库契约**
   - 现象：`postgres-integration-lifecycle` 契约禁止集成测试 `${JSON.stringify(`。
   - 修复：character.cue/presence/notificationsEnabled/message blocks 改为对象传参（postgres.js 自动序列化）。
   - 验证：契约 2/2；集成 23/23；api 3010/0。

10. **Docker build 宿主权限（P4 收尾发现）**
    - 现象：`docker compose build web` → `failed to update builder last activity time: .../.docker/buildx/activity/.tmp-...: operation not permitted`。
    - 根因：宿主 ~/.docker/buildx 权限（非工作区、非代码）。
    - 状态：未验证（本地）；本地 web build（npm run build）已成功且 live2d-v1 资源就位；Docker 镜像构建需在权限正常的机器/CI 完成。

11. **ailearn_worker GRANT 不稳定（P5 确认 + 0094 固化）**
    - 现象：companion-conversation 集成测试间歇 `permission denied for table companion_conversations`。
    - 根因：0088/0091 的 GRANT 在 DO 块（依赖 role bootstrap 顺序），且容器 migrate 的 journal 路径与宿主挂载不一致导致 0090+ 迁移未自动应用。
    - 修复：0094_companion_worker_grants_fix.sql（强制 GRANT 全量）+ 手动应用；恢复后 companion-conversation 23/23。
    - 遗留：容器 migrate 的 journal 路径需根治（0090-0094 均手动应用，CI/重建环境需确认）。
