---
phase: P2
result: passed
scope: "真实文字对话纵切（04 runbook 6.4 步骤 1-14）：strict contracts → conversation foundation migration → bootstrap → 原子 turn create + worker persona 对话 → SSE → Pet 流式接入 → 会话管理/导出 → proactive delivery"
ownerApproval: "docs/plans/learning-companion/desktop-pet-handoff/README.md §4: approvedPhases=[P1, P2]（Owner 2026-08-10 批准 P2 开工）；P3 未批准（Owner 2026-08-11 交互确认暂缓）；ffmpeg/ffprobe 加入 API image 由 Owner 2026-08-11 ask 确认批准"
previousEvidence: "docs/evidence/learning-companion-desktop-pet/P1/20260811-surface-v2/"
implementedScope:
  - "packages/shared: companion-conversation-contracts.ts（conversation/message/blocks/page-context/SSE 16 事件 discriminated union/错误码/限额/export NDJSON schemas）+ canonicalJsonV1/sha256Utf8V1 golden vectors；companion-persona.ts（companion-persona-v1 逐字冻结 1335 bytes + 固定 SHA-256）；task-router companion_dialogue"
  - "migration 0088（六张表 + RLS ENABLE/FORCE + workspace/user policy + grants）+ 0089 last_event_seq + 0090 prompt_hash + 0091 worker grants 幂等补齐；Drizzle schema 同步"
  - "无副作用 /companion/bootstrap（服务端能力投影 fail-closed）+ 原子 turn create（RLS 事务、seq/generation、幂等 key/clientMessageId、turn.accepted durable event、companion_dialogue job）"
  - "worker companion_dialogue handler（opaque runId、§9.3 persona 输入组装、§9.5 参数、输出校验、delta 分块事件、fence 终态写、expires 24h、NOTIFY、cancel/supersede 迟到拒绝）+ HANDLERS/超时/调度注册"
  - "SSE（cursor 400/409、replay→live NOTIFY+1s poll、15s heartbeat、3/10 连接限制 429）+ 进程级单 NOTIFY listener + cancel 端点（202/200 幂等）"
  - "fetch-SSE client（§5.3）+ companion chat client（ensure/submit/stream、delta 累积）+ PetRuntimeProvider 接线（textConversationEnabled、fixture 回退）+ POST /companion/conversations（§6.1）"
  - "inbox ensure（§6.2 幂等）+ 签名 keyset list（§6.3 HMAC cursor）+ messages（§6.4）+ 硬删除（§12 fence+cascade）+ NDJSON export（§12 read-only repeatable-read、footer hash、active 409）"
  - "proactive delivery（§10.3/10.4/10.5：presence/notification 准入、确定性模板、quietHours suppressed、TTL、permit 幂等、proactive.delivery event、NOTIFY）+ viewed/dismiss 幂等端点"
  - "P3 前置（Owner 2026-08-11 批准）：API image 增加 Alpine ffmpeg 6.1.1/ffprobe（镜像 131MB）"
deferredScope:
  - "P3 PTT 半双工语音（Owner 2026-08-11 暂缓，approvedPhases 不含 P3）"
  - "streamingVoiceTransport（blocked：provider 与 v1 wire contract 未批准）"
  - "P4 Live2D 生产资产 / P5 学习动作 / P6 后续阶段"
  - "worker 全量测试 runner 组合跑挂起（既有问题；单文件全绿，非 P2 引入）"
  - "ailearn_worker 对 companion 表 GRANT 曾失效一次（0091 后手动恢复；migration integration test3 为权限安全网，根因未完全定位）"
  - "make verify 全绿（既有 verify-schema-mirror Gate，P0 known-issue，未改 DB）"
testsPassed:
  - "apps/api: 3006 tests / fail 0；tsc 0 error"
  - "packages/shared: 397/397（persona 1335B+hash、contracts golden vector、export schemas）"
  - "apps/web companion-pet: 34/34（reducer 20 含 P2 §10.6 单次提交守卫、chat client 11、bubble-model）"
  - "apps/api companion integration（真实 Postgres）: 18/18（turn 原子/幂等/supersede、cancel、SSE replay/cursor/429、create conversation RLS scope、inbox/list/messages/delete、export、proactive、flag off）"
  - "migration integration: 3/3（0088-0091；ailearn_worker 非 superuser FORCE RLS 行为断言）"
  - "workers/ai-worker: tsc 0；companion-dialogue 单测 8/8；learning-session-assessment 4/4"
  - "apps/web host npm run build 成功（P2-7 后重跑）"
  - "docker compose build api（含 ffmpeg 6.1.1）+ ffmpeg/ffprobe -version 验证 + 镜像体积 131MB"
  - "测试后 companion 表 0 残留"
notes:
  - "postgres-js raw SQL 的 jsonb 返回字符串、Date 参数需 ISO 字符串（测试与 service 已按此处理）"
  - "job status 无 cancelled 枚举，delete fence 使用 dead 终态"
  - "dnd presence 映射 quiet 档 → 准入 fail closed（skipped），与 quietHours suppressed 区分"
