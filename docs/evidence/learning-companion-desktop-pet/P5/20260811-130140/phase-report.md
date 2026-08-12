---
phase: P5
result: blocked
headBefore: "c73f9ea（P5 开工前最近 commit，工作区含 P2–P4 未提交交付）"
headAfter: "c73f9ea（HEAD；P5 交付全部在工作区未提交，见 changed-files.txt）"
ownerApproval: "用户口头批准 P5（「继续呗」）；§9.5 停止决策：用户选择 P5 收尾停止（ask 2026-08-11「P5 收尾停止（§9.5）」）"
previousEvidence: "docs/evidence/learning-companion-desktop-pet/P3/20260811-110633/（P3 phase-report；P4 交付经 complete_step 逐项签收，无独立 evidence 目录）"
implementedScope:
  - P5-1 冻结 typed action enum/strict payload（§4.5 proposal/run、§6.6 decision、§6.7 menu/context/grant + companion-action-router-v1 578 bytes SHA-256 冻结）+ migration 0092（proposals/runs 表、single pending、decision key 索引、turn run 6 个 frozen router 字段、RLS/grants）+ test:companion-actions:postgres 脚本
  - P5-2 Learning 只读 menu context adapter（resume/start 候选、稳定 contextRevision、payloadSha256、净化）+ GET /companion/learning-context（零 canonical write/零模型调用）+ 无候选 disabled
  - P5-3 menu proposal create 原子事务（重算 context → 精确验证 revision/candidate/payloadSha256 → 双消息 + action_ref + pending proposal + action.proposed event + 幂等 key）+ POST /companion/menu-proposals + 0093 action_ref
  - P5-4 proposal decision 原子消费（FOR UPDATE、同 key 幂等、TTL/active run 校验；reject 零副作用；confirm 纯导航同步 succeeded；session/tutor 建 action run + COMPANION_ACTION job）+ POST /companion/proposals/:id/decision + COMPANION_ACTION job 类型 + 0095 action_run_id
  - P5-5 worker companion-action handler（accepted→running→succeeded 状态机、start_session 真实创建 learning_session/resume 恢复、恰好一条 durable result 消息、action.completed + NOTIFY、非 accepted 跳过、jsonb 字符串容错）+ 人设口吻不改变事实 + HANDLERS/超时注册
  - P5-6 context-grants 签发（HMAC-SHA256 domain-separated + 5min TTL + episode 解引用 + permissionSnapshot 不落库）+ COMPANION_ACTION_BRIDGE_V1_ENABLED flag gate（off → 404，P3 对话可用）+ menu proposal TTL 5min（§626）+ opaque entity ref（companionPersistedPageContextV1Schema 已落地）+ RLS/必测矩阵测试
deferredScope:
  - ask_grounded_tutor 的 grounded 回答为确定性引导（增强问答后续接入）
  - streaming voice（P6）按 §9.5 停止，未开始
  - 容器 migrate journal 路径根治（0090–0095 手动应用，CI/重建环境需确认）
  - P5 phase-report 的 docker-logs/electron-main/renderer-console 真机日志（未启动真实 Electron/桌面）
changedFiles: "见 changed-files.txt（工作区全量；P5 核心见 test-summary.md 覆盖文件）"
newDependencies: []
migrations:
  - 0092_companion_action_bridge（proposals/runs + router 字段 + RLS）
  - 0093_companion_action_ref（messages.action_ref）
  - 0094_companion_worker_grants_fix（ailearn_worker 权限固化）
  - 0095_companion_action_run_id（proposals.action_run_id）
featureFlags:
  - COMPANION_ACTION_BRIDGE_V1_ENABLED（P5 主开关；off → menu/decision/grants 404，P3 对话可用）
  - COMPANION_DIALOGUE_V1_ENABLED（P2/P3 对话主开关，不受 P5 flag 影响）
testsPassed:
  - api 全量 3010/0、api tsc 0
  - shared 397/397
  - api companion action 集成 10/10（migration 2 + RLS 2 + bridge 6：menu create/decision/reject/纯导航/session+job/grant HMAC+5min TTL）
  - worker companion-action 集成 2/2（start_session 真实创建 + 恰好一条 result + 非 accepted 跳过）
  - worker handler 单测 14/14、worker tsc 0
  - 重跑后 0 残留（proposals/runs/conversations/start sessions 均 0）
testsFailed: []
dockerServicesChecked: [postgres, api, worker, web, edge-tts, minio]
unexplainedErrors:
  - ailearn_worker GRANT 间歇丢失（根因：0088/0091 DO 块依赖角色顺序 + 容器 migrate journal 路径；0094 固化 + 手动应用后恢复，companion-conversation 23/23）
  - jsonb 参数行为差异（drizzle tx.execute 用 JSON.stringify 字符串参数正常；postgres.js 原生 tag 双重序列化 → worker handler 加字符串容错）
  - 既有：desktop dmg hdiutil 限制、make verify coverage gate 本地 fail-closed、worker 组合测试 runner 挂起
rollbackVerified: false
ownerReviewRequired:
  - P6 输入 Gate：streaming ASR/TTS provider 资料/费用/配额/数据处理条款批准 + README streamingVoiceTransport blocked→approved + WSS wire contract 冻结（实施 Agent 不得自行发明协议）
  - 容器 migrate journal 路径根治（CI/重建环境确认 0090–0095 应用）
  - ~~商业发布前替换 Live2D Mao PRO 或获 Live2D 许可~~（已解除：Owner 2026-08-11 确认 Mao PRO 免费，无需商业许可）

---

## 更正记录（2026-08-12 审计）

原 `result: gate_passed` 与 runbook §2.4/§3.3 及 desktop-pet-handoff README §4.4 冲突：
P5 交付代码存在且 bridge/worker 集成测试通过，但**真实 Electron 纵切、e2e spec、真机日志、rollback 验证均未执行**，
按 runbook 只能标 `blocked`。此外方案 13 §7.2 的 Dialogue Router 三态（casual_chat / learning_question /
learning_action）在本次审计时仍未接线到 turn/worker 链路，本状态更正为 `blocked` 后由后续会话补齐。
