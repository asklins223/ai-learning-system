# 项目性能问题扫描报告

> 扫描时间：2026-08-16
> 扫描范围：`apps/api`、`apps/web`、`apps/desktop`、`packages/shared`、`packages/db`、`packages/ai-quality` 的生产代码（排除测试、构建产物、迁移脚本、node_modules）。
> 方法：静态规则扫描 + 多路并行人工复核；以下为已确认或高置信度的性能风险。

## 摘要

共发现 **62** 项性能风险，按严重级别：

| 级别 | 数量 |
|---|---|
| High | 8 |
| Medium | 26 |
| Low | 28 |

按类别：

| 类别 | 数量 |
|---|---|
| DB-N+1 | 11 |
| DB-unbounded-query | 13 |
| Memory-Leak | 4 |
| Concurrency | 7 |
| Polling | 2 |
| IO-Blocking | 2 |
| Algorithmic | 16 |
| Other | 3 |
| UI-Render | 3 |
| Cache | 1 |

> 说明：High 表示在典型规模/热路径下会造成明显延迟、资源占用或可观测退化的问题；Medium 表示在数据量增长或并发升高时会成为瓶颈；Low 表示当前影响有限但建议随迭代优化。

## 优先处理建议（Top 10）

**note autosave 路径多余回读 + 全量 delete/insert**：`apps/api/src/modules/note/service.ts:958-970` 与 `:380-395`，2.5s 自动保存会重复 3 次查询并整表重建 note_blocks，是编辑器高频路径的最大浪费。

**learning-session 无界查询**：`session-service.ts:1829-1863`（listDueReviews）与 `:1868-1941`（listActiveCanonical）在开始/继续学习时可能一次性拉取全部待复习/全部 active canonical。

**learning-run 创建路径无界历史**：`run-service.ts:631-645` 每次 createRun 拉取 30 天全部 presentation hashes。

**companion journey 事件 drain N+1**：`journey-service.ts:600-625` 每次最多 50 个事件 × 每个 3-5 条 DB 操作。

**前端 NoteEditor 每次保存重新拉全量版本历史**：`NoteEditor.tsx:714-728` + `api.ts:1201-1203` 无分页。

**首页/Today/Sources 页面无分页拉全量数据**：`page.tsx:95-97`、`today/page.tsx:368-371`、`sources/page.tsx:182`。

**SSE/轮询连接缺少上限或过于密集**：`inbox-routes.ts:71-90` 无 per-user 连接上限且每 3s 查库；`run-routes.ts:257-297` 每客户端每 3s 开事务轮询。

**Desktop bridge context Map 无限增长**：`companion-bridge-ipc.ts:54`。

**AI-quality RC gate 串行执行长任务**：`rc-runner.ts:347`，60+ 样本顺序跑完整模型流程。

**若干 O(n×m) 算法**：`question-safety.ts:102`、`real-align.ts:77`、`projection-client.ts:70-79` 等，在文本/投影较大时会造成明显 CPU。

## api-companion-other

| 严重度 | 文件 | 行 | 类别 | 问题 |
|---|---|---|---|---|
| High | `apps/api/src/modules/companion-journey/journey-service.ts` | 600-625 | DB-N+1 | drainPendingJourneyEvents sequentially applies up to 50 events with ~5 DB queries each |
| Medium | `apps/api/src/db/client.ts` | 25 | Concurrency | DB pool max=10 may bottleneck under many simultaneous SSE pollers |
| Medium | `apps/api/src/modules/companion-conversation/assistant-session-routes.ts` | 105-124 | DB-unbounded-query | History search uses blocks::text ILIKE %q% — unindexed full scan per query |
| Medium | `apps/api/src/modules/companion-conversation/companion-export.ts` | 265-394 | Memory-Leak | Export builds entire NDJSON array + full row collections in memory |
| Medium | `apps/api/src/modules/companion-conversation/inbox-routes.ts` | 71-90 | Polling | Proactive inbox SSE has no per-user connection limit; every connection polls DB every 3s |
| Medium | `apps/api/src/scripts/cleanup-soft-deleted-notes.ts` | 46-52, 67-101 | DB-unbounded-query | Note cleanup script loads ALL stale notes at once and processes each in a separate transaction |
| Low | `apps/api/src/modules/companion-conversation/learning-action-bridge.ts` | 286-390 | DB-N+1 | createCompanionMenuProposal re-queries context data it already loaded |
| Low | `apps/api/src/modules/companion-conversation/proactive-hook.ts` | 19-53 | Other | Intl.DateTimeFormat constructed on every quiet-hours evaluation |
| Low | `apps/api/src/modules/companion-shell/audit-service.ts` | 856-866 | Concurrency | deleteAllUserCompanionAuditAndLedger iterates workspaces sequentially |
| Low | `apps/api/src/modules/identity/service.ts` | 149-151, 439-441 | Algorithmic | workspaceRows.find() inside memberships.map() is O(m*n) lookup |

### 详细描述（api-companion-other）

#### [High] drainPendingJourneyEvents sequentially applies up to 50 events with ~5 DB queries each

- **文件**：`apps/api/src/modules/companion-journey/journey-service.ts:600-625`
- **类别**：DB-N+1
- **问题**：drainPendingJourneyEvents loops over up to 50 pending events and calls applyJourneyDomainEvent for each. Each applyJourneyDomainEvent runs 3-5 sequential DB operations (SELECT journey FOR UPDATE, SELECT applied-check, INSERT pending, UPDATE journey, UPDATE pending, final SELECT). That's up to ~250 sequential DB round-trips per drain call, all inside a single open transaction.
- **建议**：Batch the pending-event processing: first load all pending rows (already done), then single query to mutate them. For event application, either combine the journey-lock + applied-check into one query per event or, better, preload all needed data for the 50 events in a few bulk queries and apply the reducer logic in-process before issuing batched UPDATEs.

#### [Medium] DB pool max=10 may bottleneck under many simultaneous SSE pollers

- **文件**：`apps/api/src/db/client.ts:25`
- **类别**：Concurrency
- **问题**：The API uses a single postgres pool with max 10 connections. With unlimited inbox-SSE connections (see inbox-routes) each polling every 3s in its own transaction, plus companion SSE per-user connections, plus normal request traffic, 10 connections can become the contention point during peak periods.
- **建议**：Increase the pool max (e.g. 20-30) or, better, cap SSE connection counts and use NOTIFY (already implemented for companion events) to reduce polling pressure on the limited pool.

#### [Medium] History search uses blocks::text ILIKE %q% — unindexed full scan per query

- **文件**：`apps/api/src/modules/companion-conversation/assistant-session-routes.ts:105-124`
- **类别**：DB-unbounded-query
- **问题**：GET /companion/history/search filters companion_messages with sql`${companionMessages.blocks}::text ILIKE ${keyword}` where keyword is %...%. Leading-wildcard ILIKE on jsonb text cannot use B-tree indexes, so every search does a full workspace-user message table scan (or at best a partial scan relying on the workspace/user index then filtering).
- **建议**：Add a pg_trgm GIN index on companion_messages.blocks::text (or extracts of it) and/or rely on the existing search service's indexed full-text path. At minimum document that this endpoint incurs a full scan and keep limit small (already capped at 50).

#### [Medium] Export builds entire NDJSON array + full row collections in memory

- **文件**：`apps/api/src/modules/companion-conversation/companion-export.ts:265-394`
- **类别**：Memory-Leak
- **问题**：exportCompanionData accumulates up to COMPANION_EXPORT_MAX_ROWS (50k) rows per category (conversations, messages, proactiveDeliveries, proposals, actionRuns — up to ~250k rows total) in arrays, then builds a second `ndjson: string[]` array of serialized lines before hashing and returning. Peak memory roughly doubles (raw rows + serialized strings) and can reach hundreds of MB for large histories.
- **建议**：Stream the NDJSON output progressively to the response (and to the SHA-256 hasher) instead of collecting all lines in memory: hash incrementally while writing chunks, and free row arrays after each section.

#### [Medium] Proactive inbox SSE has no per-user connection limit; every connection polls DB every 3s

- **文件**：`apps/api/src/modules/companion-conversation/inbox-routes.ts:71-90`
- **类别**：Polling
- **问题**：Unlike companion-events.ts (3 slots/conversation, 10/user), the /companion/deliveries/inbox/stream endpoint accepts unlimited connections per user/workspace, each running a 3s DB poll (listInbox) plus a 15s heartbeat. Many open tabs/devices can multiply continuous database load without bound.
- **建议**：Add a per-user connection slot cap (e.g. 3-5 like companion-events) with a 429 response, and/or use the existing COMPANION_CONVERSATION notify channel to wake on new deliveries instead of blind polling.

#### [Medium] Note cleanup script loads ALL stale notes at once and processes each in a separate transaction

- **文件**：`apps/api/src/scripts/cleanup-soft-deleted-notes.ts:46-52, 67-101`
- **类别**：DB-unbounded-query
- **问题**：SELECT on soft-deleted notes has no LIMIT/batch, loading every stale note into memory at once (unbounded for large databases). Then each note is processed in its own individual db.transaction + physicalDeleteNote, sequentially, which for thousands of notes creates thousands of sequential transactions.
- **建议**：Batch: page through stale notes with a keyset cursor (LIMIT 200/batch), and process a few notes per transaction or batch the deletes. Also delete old notes in chunks to bound memory and shorten lock windows.

#### [Low] createCompanionMenuProposal re-queries context data it already loaded

- **文件**：`apps/api/src/modules/companion-conversation/learning-action-bridge.ts:286-390`
- **类别**：DB-N+1
- **问题**：createCompanionMenuProposal first calls resolveCompanionLearningContextInTransaction (5+ DB queries), then for each candidate type issues additional duplicate queries to reconstruct the payload (e.g., re-selecting learning_sessions or card_key_points already seen). This roughly doubles the DB round trips for a single proposal request.
- **建议**：Return enough data from resolveCompanionLearningContextInTransaction to construct the payload directly without re-querying; or reuse the already-fetched rows from the context resolution to avoid redundant SELECTs.

#### [Low] Intl.DateTimeFormat constructed on every quiet-hours evaluation

- **文件**：`apps/api/src/modules/companion-conversation/proactive-hook.ts:19-53`
- **类别**：Other
- **问题**：isWithinQuietHours creates a new Intl.DateTimeFormat (with timezone data) on every call. Since hookProactiveOnRunCompleted runs on every learning-run completion and may be called frequently under load, this adds measurable per-event CPU cost.
- **建议**：Hoist the Intl.DateTimeFormat instance to module scope (or memoize per timezone in a Map keyed by quietHours.timezone).

#### [Low] deleteAllUserCompanionAuditAndLedger iterates workspaces sequentially

- **文件**：`apps/api/src/modules/companion-shell/audit-service.ts:856-866`
- **类别**：Concurrency
- **问题**：The account-deletion helper iterates over every workspace with a separate withWorkspaceTransaction + deleteCompanionUserData call, serially. For a user in many workspaces this is a long sequential chain of transactions.
- **建议**：Process workspaces with Promise.all (bounded by pool capacity) or within a single RLS-scoped transaction per workspace but parallelize across workspaces where isolation permits.

#### [Low] workspaceRows.find() inside memberships.map() is O(m*n) lookup

- **文件**：`apps/api/src/modules/identity/service.ts:149-151, 439-441`
- **类别**：Algorithmic
- **问题**：In loginWithPassword and listUserWorkspaces, memberships.map() performs workspaceRows.find() for each membership, yielding O(m*n) complexity. This is usually trivial (1-5 workspaces per user) but could degrade for users with many workspace memberships.
- **建议**：Build a Map<workspaceId, workspace> once (new Map(workspaceRows.map(w => [w.id, w]))) and look up via the map instead of linear find.

## api-learning

| 严重度 | 文件 | 行 | 类别 | 问题 |
|---|---|---|---|---|
| High | `apps/api/src/modules/learning-runs/run-service.ts` | 631-645 | DB-unbounded-query | recentPresentedPayloadHashes loads unbounded 30-day history on every createRun |
| High | `apps/api/src/modules/learning-sessions/session-service.ts` | 1829-1863 | DB-unbounded-query | listDueReviews fetches all pending due schedules with no LIMIT on hot PREPARE path |
| High | `apps/api/src/modules/learning-sessions/session-service.ts` | 1868-1941 | DB-unbounded-query | listActiveCanonical performs unbounded 4-table join when no keyPointIds filter provided |
| Medium | `apps/api/src/modules/learning-runs/legacy-backfill.ts` | 149-199 | DB-N+1 | backfillLegacySessionsToRuns performs one existence check query per episode in a loop |
| Medium | `apps/api/src/modules/learning-runs/run-draft-crypto.ts` | 15-23, 34, 46 | IO-Blocking | loadKey() re-reads env var and executes regex + Buffer.from on every draft save/restore |
| Medium | `apps/api/src/modules/learning-runs/run-processing-tick.ts` | 978-996 | DB-N+1 | revalidateV2CommitEpochs issues one FOR UPDATE query per evidence item in a loop |
| Medium | `apps/api/src/modules/learning-runs/run-processing-tick.ts` | 570-669 | Concurrency | gatherCriticInput issues sequential DB reads when several are independent |
| Medium | `apps/api/src/modules/learning-runs/run-view.ts` | 126-130 | Algorithmic | buildRunPublicView scans variants linearly for each task (O(tasks × variants)) |
| Medium | `apps/api/src/modules/learning-runs/shadow-translator.ts` | 77-93, 119-123 | DB-unbounded-query | shadow reconciliation performs three unbounded full-table selects |
| Medium | `apps/api/src/modules/review/schedule-migration.ts` | 40-46, 116-186 | DB-unbounded-query | migration loads all pending schedules + issues per-row UPDATE in loop |
| Low | `apps/api/src/modules/learning-runs/run-processing-tick.ts` | 1246-1261 | DB-N+1 | per-reminder insertDomainEvent issues one insert per completed reminder |
| Low | `apps/api/src/modules/learning-runs/run-routes.ts` | 257-297 | Polling | SSE event stream polls DB every 3s per connected client with a new transaction per tick |
| Low | `apps/api/src/modules/learning-sessions/cross-device-recovery.ts` | 726 | Algorithmic | buildRetryPlan does linear .includes inside a .filter over confirmedSteps |
| Low | `apps/api/src/modules/learning-sessions/session-service.ts` | 1729, 1739 and 1753, 1771 | Concurrency | endSession and cancelSession call listEpisodes twice |
| Low | `apps/api/src/modules/learning-sessions/vertical-slice.ts` | 288-290 | Algorithmic | evaluateVoiceRecall does linear .find per rubric target (O(r × a)) |

### 详细描述（api-learning）

#### [High] recentPresentedPayloadHashes loads unbounded 30-day history on every createRun

- **文件**：`apps/api/src/modules/learning-runs/run-service.ts:631-645`
- **类别**：DB-unbounded-query
- **问题**：The hot createRun path calls recentPresentedPayloadHashes which selects all publicPayloadHash rows from learningTaskPresentationHistory for a (user, keyPoint) over the last 30 days with NO LIMIT. A heavy user can accumulate hundreds of rows that are all hydrated into memory just to build a Set used for presentation-dedup.
- **建议**：Add ORDER BY presented_at DESC + LIMIT (the number of hashes actually needed, e.g. 50) and/or add a DISTINCT in SQL. Alternatively maintain a short bounded cache.

#### [High] listDueReviews fetches all pending due schedules with no LIMIT on hot PREPARE path

- **文件**：`apps/api/src/modules/learning-sessions/session-service.ts:1829-1863`
- **类别**：DB-unbounded-query
- **问题**：createSession/continueSession call listDueReviews which selects ALL pending review_schedules with next_review_at <= now for the user with no LIMIT or pagination. A user who accumulates many pending schedules (e.g., after a long absence) forces loading them all, then a subsequent loadCanonical + in-memory sort, on every session start.
- **建议**：Add ORDER BY next_review_at + LIMIT (e.g. 100) to bound the query. Since only the top-priority candidates are needed for candidate derivation, and downstream selectEpisodeCandidate only picks the highest-ranked entry, cap the result set.

#### [High] listActiveCanonical performs unbounded 4-table join when no keyPointIds filter provided

- **文件**：`apps/api/src/modules/learning-sessions/session-service.ts:1868-1941`
- **类别**：DB-unbounded-query
- **问题**：In continueSession (line 1483) listActiveCanonical is called without keyPointIds, selecting every active card_key_points JOIN learning_cards JOIN learning_card_sets JOIN evidences in the workspace with NO LIMIT. This can return thousands of rows on a workspace with many key points, all buffered in memory. The function then groups and hashes every row on the request path.
- **建议**：Bound the query with LIMIT (e.g. a few hundred) plus deterministic ORDER BY, or push more filtering into SQL. Since candidates are consumed top-down by priority, load only the bounded candidate set needed for selection.

#### [Medium] backfillLegacySessionsToRuns performs one existence check query per episode in a loop

- **文件**：`apps/api/src/modules/learning-runs/legacy-backfill.ts:149-199`
- **类别**：DB-N+1
- **问题**：Inside the per-episode loop, a SELECT on learningRuns.legacyEpisodeId runs for every episode (line 151-158). For a workspace with a large legacy episode count, this is an N+1 query pattern with one DB round-trip per episode.
- **建议**：Preload all migrated legacyEpisodeIds with a single SELECT ... WHERE legacyEpisodeId IN (...) into a Set before the loop, then check membership in memory (idempotency is also enforced by the DB partial unique index).

#### [Medium] loadKey() re-reads env var and executes regex + Buffer.from on every draft save/restore

- **文件**：`apps/api/src/modules/learning-runs/run-draft-crypto.ts:15-23, 34, 46`
- **类别**：IO-Blocking
- **问题**：isDraftEncryptionAvailable, encryptDraftPayload and decryptDraftPayload each call loadKey() which re-reads process.env, runs a regex to validate key format, and performs Buffer.from(raw, 'hex') on every call. The draft autosave path (putDraft/getDraft) can fire repeatedly as a user types, so this redundant parsing happens on each save.
- **建议**：Memoize the decoded key in a module-level variable (invalidated only if env changes, which it won't in production), or lazily cache the Buffer result on first use and reuse thereafter.

#### [Medium] revalidateV2CommitEpochs issues one FOR UPDATE query per evidence item in a loop

- **文件**：`apps/api/src/modules/learning-runs/run-processing-tick.ts:978-996`
- **类别**：DB-N+1
- **问题**：For each evidenceSnapshotId in snapshot.target.evidence, the commit path issues a separate SELECT ... FOR UPDATE query. If a target has many evidence items, this becomes N round-trips inside the commit transaction, extending lock hold time on each evidenceEligibilityStatesV2 row.
- **建议**：Batch-lock all evidence rows with a single SELECT ... FOR UPDATE WHERE evidence_snapshot_id IN (...) ORDER BY ..., then validate statuses/epochs in memory against the snapshot. This preserves lock ordering while reducing to one round trip.

#### [Medium] gatherCriticInput issues sequential DB reads when several are independent

- **文件**：`apps/api/src/modules/learning-runs/run-processing-tick.ts:570-669`
- **类别**：Concurrency
- **问题**：gatherCriticInput awaits artifact, task, variant, run, contract (and possibly snapshot/kp) in a strict sequential chain. artifact -> variant and run/contract are independent and could be fetched in parallel; the V2 snapshot path is a separate heavy read. On the worker path latency is sum rather than max of these queries.
- **建议**：Launch independent reads (task, run, contract) via Promise.all while the artifact read is in flight, then resolve variant and the remaining dependent reads from the artifact result. For the V2 branch, load the snapshot in parallel with the contract read.

#### [Medium] buildRunPublicView scans variants linearly for each task (O(tasks × variants))

- **文件**：`apps/api/src/modules/learning-runs/run-view.ts:126-130`
- **类别**：Algorithmic
- **问题**：tasks.map iterates every task and, for each, calls variants.find(...) which scans the entire variants array. With a typical run of ~2 tasks and ~2-3 variants this is small, but the pattern is quadratic and could degrade if task/variant counts grow. The same variants array is rescanned again for the active task on lines 140-144.
- **建议**：Build a Map keyed by taskId -> active variant once, then look up per task in O(1). Precompute a per-task index for active-variant lookups before the map call.

#### [Medium] shadow reconciliation performs three unbounded full-table selects

- **文件**：`apps/api/src/modules/learning-runs/shadow-translator.ts:77-93, 119-123`
- **类别**：DB-unbounded-query
- **问题**：runShadowReconciliation selects all 'covered' validation_point_assessments, all completed review_attempts, and all canonical_learning_event_outbox rows for the workspace with no LIMIT. For large workspaces this buffers entire tables into memory on every reconciliation run.
- **建议**：Add pagination (keyset by primary key) and/or filter with time windows, and stream the results rather than materializing full arrays. The reconciliation is a batch script, but should still be bounded to avoid OOM on large workspaces.

#### [Medium] migration loads all pending schedules + issues per-row UPDATE in loop

- **文件**：`apps/api/src/modules/review/schedule-migration.ts:40-46, 116-186`
- **类别**：DB-unbounded-query
- **问题**：migrateLegacyPendingSchedulesV2 selects ALL pending review_schedules without LIMIT, then in a loop issues individual UPDATEs for blocked/invalid rows (one DB round-trip per row). For a workspace with thousands of pending schedules this is a long-running migration with N round trips.
- **建议**：Batch with LIMIT pagination over the pending rows, and collect blocked/invalid schedule IDs into arrays, executing a single UPDATE ... WHERE id IN (...) per category instead of per-row updates.

#### [Low] per-reminder insertDomainEvent issues one insert per completed reminder

- **文件**：`apps/api/src/modules/learning-runs/run-processing-tick.ts:1246-1261`
- **类别**：DB-N+1
- **问题**：After updating initialValidationRemindersV2, the code loops over completedReminders and calls insertDomainEvent for each one — one DB insert per reminder inside the commit transaction. For typical runs this is 0-2 reminders, but the pattern is iterative rather than batched.
- **建议**：Batch the domain event inserts into a single multi-row insert (or insert via a single INSERT ... SELECT from the UPDATE's RETURNING).

#### [Low] SSE event stream polls DB every 3s per connected client with a new transaction per tick

- **文件**：`apps/api/src/modules/learning-runs/run-routes.ts:257-297`
- **类别**：Polling
- **问题**：Each SSE client holds a setInterval that opens a withWorkspaceTransaction (acquiring RLS context) and executes getEventsAfter every 3 seconds, potentially up to 5 drain rounds per tick. Every active learning-run page keeps a persistent SSE channel, so N viewing clients generate N × (1 transaction / 3s) DB load. Timers are properly unref'd and cleared on close, so no leak, but the polling pattern is chatty.
- **建议**：Consider a shared in-process event bus / query loop that fans events to all clients subscribed to the same run instead of per-client polling, or increase the poll interval and use long-polling to reduce DB transactions.

#### [Low] buildRetryPlan does linear .includes inside a .filter over confirmedSteps

- **文件**：`apps/api/src/modules/learning-sessions/cross-device-recovery.ts:726`
- **类别**：Algorithmic
- **问题**：input.confirmedSteps.filter(... && !input.steps.includes(step)) is O(confirmedSteps × steps). Recovery step lists are small (typically < 10) so impact is bounded, but this is a clear nested-scan pattern.
- **建议**：Convert input.steps to a Set once, then check membership in O(1).

#### [Low] endSession and cancelSession call listEpisodes twice

- **文件**：`apps/api/src/modules/learning-sessions/session-service.ts:1729, 1739 and 1753, 1771`
- **类别**：Concurrency
- **问题**：Both endSession (line 1729 and 1739) and cancelSession (line 1753 and 1771) re-read the episodes list after updating statuses even though the caller already fetched episodes and knows which ids were cancelled. This adds a redundant DB round trip to a request that already made several queries.
- **建议**：After updateEpisodeStatuses, mutate the in-memory episodes copy (status -> cancelled) and build the view from it, avoiding the second listEpisodes query.

#### [Low] evaluateVoiceRecall does linear .find per rubric target (O(r × a))

- **文件**：`apps/api/src/modules/learning-sessions/vertical-slice.ts:288-290`
- **类别**：Algorithmic
- **问题**：For each rubric target, the function scans the entire assessments array to find a matching rubricItemId. With a few rubric items this is negligible, but the pattern is quadratic and repeated for every consolidation evaluation.
- **建议**：Index assessments by rubricItemId into a Map once, then do O(1) lookups per target.

## api-core

| 严重度 | 文件 | 行 | 类别 | 问题 |
|---|---|---|---|---|
| High | `apps/api/src/modules/note/service.ts` | 958-970 | DB-N+1 | updateNote re-reads note/version/blocks after every write, including autosaves |
| Medium | `apps/api/src/modules/export/service.ts` | 1060-1118 | DB-N+1 | restoreWorkspace performs per-user sequential DB writes (5 queries each) |
| Medium | `apps/api/src/modules/note/service.ts` | 380-395 | Other | updateVersionInPlace deletes and re-inserts all note_blocks on every autosave |
| Medium | `apps/api/src/modules/note/service.ts` | 1248-1261 | DB-N+1 | restoreDeletedNote issues one search-index upsert per restored card |
| Medium | `apps/api/src/modules/note/service.ts` | 259-272 | IO-Blocking | ensureImageAssetsForBlocks downloads images serially in a loop |
| Medium | `apps/api/src/modules/source/service.ts` | 197-242 | Concurrency | listSources issues page, note-count, and total-count queries sequentially |
| Low | `apps/api/src/modules/benchmark/service.ts` | 890-897 | Concurrency | benchmark cleanup runs physicalDeleteNote serially per stale note |
| Low | `apps/api/src/modules/card-set/service.ts` | 260-262 | Algorithmic | listCardSets repeatedly scans and allocates per-set card arrays |
| Low | `apps/api/src/modules/import/routes.ts` | 86,241 | Algorithmic | markdownToBlocks parsed twice per imported item |
| Low | `apps/api/src/modules/note/service.ts` | 99-114 | Algorithmic | pgJsonbSerialize does per-number regex and BigInt work in the content-hash hot path |
| Low | `apps/api/src/modules/search/service.ts` | 173-178 | Algorithmic | search count cache performs full O(n) sweep on every cache miss |
| Low | `apps/api/src/modules/search/service.ts` | 125,461 | Memory-Leak | lastReindexCapped Map grows unbounded with distinct workspace IDs |
| Low | `apps/api/src/modules/understanding/service.ts` | 44,340-345 | Algorithmic | understanding states cache sweeps all entries on every request |

### 详细描述（api-core）

#### [High] updateNote re-reads note/version/blocks after every write, including autosaves

- **文件**：`apps/api/src/modules/note/service.ts:958-970`
- **类别**：DB-N+1
- **问题**：After applying a content update (one of the create-version/autosave branches), the code unconditionally issues 3 sequential DB queries to re-fetch uNote, uVer, and uBlocks. On the 2.5s autosave interval this adds 3 redundant round-trips per keystroke-triggered save, and the data (newVersion, sanitizedBlocks, note row) was already in scope from the branch that just wrote it.
- **建议**：Construct the return result directly from the objects already fetched/written in the update branch (newVersion, sanitizedBlocks/currentBlocks, updated note fields) instead of re-querying; only re-read when the caller path genuinely lacks the data (e.g. title-only path).

#### [Medium] restoreWorkspace performs per-user sequential DB writes (5 queries each)

- **文件**：`apps/api/src/modules/export/service.ts:1060-1118`
- **类别**：DB-N+1
- **问题**：The user-restore loop awaits 3-5 sequential DB operations per user (INSERT users, INSERT workspaces, UPDATE users, INSERT workspace_members, INSERT onboarding_states). While the user count is usually small, the writes could be batched where dependency-free and the loop is an N×RTT pattern in a single long transaction.
- **建议**：Two-phase restore: batch-insert all users first, then batch-insert personal workspaces and collect the generated IDs, then batch the members/onboarding rows; at minimum collect inserts into arrays and insert in batches rather than one row per await.

#### [Medium] updateVersionInPlace deletes and re-inserts all note_blocks on every autosave

- **文件**：`apps/api/src/modules/note/service.ts:380-395`
- **类别**：Other
- **问题**：The in-place autosave path performs DELETE of all note_blocks for the version, then re-INSERTs the full block set plus a resolveImageAssetIds DB query, on every 2.5s autosave tick. For large notes this creates constant write amplification, index churn, and table bloat on note_blocks.
- **建议**：Diff the existing blocks against the submitted blocks and only UPDATE/insert/delete changed rows (or mark deleted-at on removed ones); or batch the operation into a single upsert with ordinals rather than full delete+insert.

#### [Medium] restoreDeletedNote issues one search-index upsert per restored card

- **文件**：`apps/api/src/modules/note/service.ts:1248-1261`
- **类别**：DB-N+1
- **问题**：The keyPoints are correctly batch-fetched, but the loop then calls upsertSearchDocument (a nested-transaction INSERT ... ON CONFLICT) once per restored card. Restoring a note with many cards yields N DB round-trips in a serial loop rather than a batched upsert.
- **建议**：Collect all restored-card search documents and perform a single multi-row INSERT ... ON CONFLICT (batched in chunks of 500) inside one savepoint, mirroring the reindex insert-batch pattern.

#### [Medium] ensureImageAssetsForBlocks downloads images serially in a loop

- **文件**：`apps/api/src/modules/note/service.ts:259-272`
- **类别**：IO-Blocking
- **问题**：For missing image assets the fallback path awaits downloadAndValidateImageAsset (MinIO network I/O) one object at a time in a for loop, holding the transaction connection open during each download. The pre-registration path (image-asset.ts) already uses a bounded concurrency of 4; this path is inconsistent and serializes multi-image saves.
- **建议**：Use the same mapWithConcurrency helper (concurrency ~4) as preRegisterImageAssetsForImport for the missing-keys download loop, while keeping the one-buffer-per-image memory constraint by collecting results in bounded batches.

#### [Medium] listSources issues page, note-count, and total-count queries sequentially

- **文件**：`apps/api/src/modules/source/service.ts:197-242`
- **类别**：Concurrency
- **问题**：The source page query (findMany), the note-count GROUP BY query, and the total count query run in three sequential DB round-trips. The total count is independent of the page rows and could run in parallel with the page query (as listNotes and listCards already do with Promise.all).
- **建议**：Run the page query and the total COUNT concurrently via Promise.all, then run the note-count GROUP BY after page rows are available — reducing the source list from 3 RTTs to 2.

#### [Low] benchmark cleanup runs physicalDeleteNote serially per stale note

- **文件**：`apps/api/src/modules/benchmark/service.ts:890-897`
- **类别**：Concurrency
- **问题**：cleanupPreviousBenchmarkData loops over every previously-created benchmark-named note and awaits physicalDeleteNote (a heavy cascading multi-table delete) one at a time. After several benchmark runs the serial cleanup can add minutes to the start of the next run.
- **建议**：Run the physicalDeleteNote calls with a small bounded concurrency (e.g. 2-3) within the same workspace lock, or process deletion in batches while preserving the per-note transaction isolation.

#### [Low] listCardSets repeatedly scans and allocates per-set card arrays

- **文件**：`apps/api/src/modules/card-set/service.ts:260-262`
- **类别**：Algorithmic
- **问题**：Inside the selected.map, each card set's cards are filtered (allocating a temp array just to count) and then rescanned with .find for the overview card. The total work is O(total cards in page), but the filter allocation per set is avoidable.
- **建议**：Compute sectionCardCount and overviewCardId in a single pass over the cards array (accumulate counts while tracking the overview id) instead of filter+find.

#### [Low] markdownToBlocks parsed twice per imported item

- **文件**：`apps/api/src/modules/import/routes.ts:86,241`
- **类别**：Algorithmic
- **问题**：The image pre-registration pass calls markdownToBlocks(item.content) at line 241 for every item, and importItems re-parses the same content again at line 86. Each content string can be up to 500KB, so this doubles the CPU cost of a Max-100-item batch import.
- **建议**：Parse each item once, cache the resulting blocks, and reuse them for both image-key extraction and note creation (e.g. store parsed blocks on ItemWithIndex before the loop).

#### [Low] pgJsonbSerialize does per-number regex and BigInt work in the content-hash hot path

- **文件**：`apps/api/src/modules/note/service.ts:99-114`
- **类别**：Algorithmic
- **问题**：computeContentHash runs on every note create/update and recursively calls pgJsonbSerialize, which for every numeric value executes an /[eE]/ regex test and possibly Number.isInteger + BigInt conversion. On data-heavy notes this adds perceptible CPU to the 2.5s autosave path.
- **建议**：Cache note content hashes when possible, or specialize the number serialization to a fast-path string conversion that avoids regex when the string is non-exponential (only run the expensive path on infrequent edge cases).

#### [Low] search count cache performs full O(n) sweep on every cache miss

- **文件**：`apps/api/src/modules/search/service.ts:173-178`
- **类别**：Algorithmic
- **问题**：getSearchTotal iterates over all entries of searchCountCache to evict expired entries each time the key is absent. With the 500-entry cap, every search keystroke miss is an O(cache-size) scan on top of the miss computation.
- **建议**：Use a min-heap or a single sorted by-insertion time list to evict in O(1)/O(log n), or limit the sweep to a fixed number of evictions per call to bound the per-request cost.

#### [Low] lastReindexCapped Map grows unbounded with distinct workspace IDs

- **文件**：`apps/api/src/modules/search/service.ts:125,461`
- **类别**：Memory-Leak
- **问题**：lastReindexCapped.set(workspaceId, wasCapped) is the only write to this Map and there is no eviction or TTL. In a multi-tenant deployment where many workspaces are reindexed over time, the Map grows without bound (one entry per distinct workspace ever reindexed).
- **建议**：Bound the map (e.g. LRU cap) or use a TTL/refresh-on-read so reindex bookkeeping does not grow forever with workspace count.

#### [Low] understanding states cache sweeps all entries on every request

- **文件**：`apps/api/src/modules/understanding/service.ts:44,340-345`
- **类别**：Algorithmic
- **问题**：sweepUnderstandingCache() is invoked on every non-transaction call to getUnderstandingStates and iterates the entire understandingStatesCache Map to delete expired entries. Under high traffic with many workspace/user/state key combinations this adds an O(cache-size) scan per request.
- **建议**：Evict lazily with a TTL check only on the looked-up key, or use a scheduled/tick-based cleanup that runs infrequently rather than on every request.

## desktop-shared-ai

| 严重度 | 文件 | 行 | 类别 | 问题 |
|---|---|---|---|---|
| High | `apps/desktop/src/ipc/companion-bridge-ipc.ts` | 54 | Memory-Leak | Bridge context records Map never expires stale entries |
| High | `packages/ai-quality/src/card-generation-supervisor-v1/rc-runner.ts` | 347 | Concurrency | RC gate runs expensive Supervisor samples strictly sequentially |
| Medium | `apps/desktop/src/windows/pet-window-state.ts` | 219 | Algorithmic | selectDisplay calls getAllDisplays up to twice, recomputing display SHA-256 each time |
| Medium | `packages/ai-quality/src/cli/supervisor-rc-gate.ts` | 234 | DB-N+1 | Evidence metrics collected via sequential per-card HTTP requests |
| Medium | `packages/ai-quality/src/real-align.ts` | 77 | Algorithmic | Trigram set recomputed for every sliding-window position |
| Medium | `packages/shared/src/question-safety.ts` | 102 | Algorithmic | hasDirectFragment is O(n·m) substring scan over normalized text |
| Low | `packages/shared/src/feature-flags.ts` | 122-132 | Cache | getPromptCacheProviders creates a new Set on every call |

### 详细描述（desktop-shared-ai）

#### [High] Bridge context records Map never expires stale entries

- **文件**：`apps/desktop/src/ipc/companion-bridge-ipc.ts:54`
- **类别**：Memory-Leak
- **问题**：The `records` Map holds context records keyed by contextId with a 30-second lease (BRIDGE_CONTEXT_LEASE_MS), but nothing sweeps expired records. Entries are only removed on explicit revoke or main-window destruction; page navigations that publish new random contextIds (line 113 randomUUID) leave stale records with `expiresAt` already passed. Over long-running sessions with frequent navigations this Map grows unboundedly.
- **建议**：Add a periodic sweep (e.g., setInterval every lease interval) deleting records where `expiresAt < Date.now()`, or check `expiresAt` on every lookup and delete expired entries lazily. Also consider capping the map size.

#### [High] RC gate runs expensive Supervisor samples strictly sequentially

- **文件**：`packages/ai-quality/src/card-generation-supervisor-v1/rc-runner.ts:347`
- **类别**：Concurrency
- **问题**：In `runSingleRound`, `for (const sample of samples)` awaits each full Supervisor Agent run (note creation + card generation + polling to terminal, each potentially minutes) one at a time. With 60+ golden samples and 2 rounds, total wall time is roughly 120 sequential model journeys, wasting capacity and risking the 60-minute deadline.
- **建议**：Process samples with a bounded-concurrency pool (e.g., p-limit style with N=2-4 concurrent samples), still respecting budget/deadline checks, and collect results in sample order. Guard against oversubscription with an explicit concurrency limit.

#### [Medium] selectDisplay calls getAllDisplays up to twice, recomputing display SHA-256 each time

- **文件**：`apps/desktop/src/windows/pet-window-state.ts:219`
- **类别**：Algorithmic
- **问题**：`selectDisplay()` calls `this.displays.getAllDisplays()` twice (lines 220-221), and each call maps every display through `currentDisplayGeometry` which computes a SHA-256 fingerprint (pet-window-state.ts path via main.ts displayProvider). `getState()` calls `selectDisplay()` on every window-state broadcast, so each broadcast re-hashes all displays instead of reusing the provider's cached display geometry.
- **建议**：Cache the display list (and fingerprints) in the provider and invalidate on screen 'display-*' events; fetch `getAllDisplays()` once in `selectDisplay` and reuse the local array for both lookups.

#### [Medium] Evidence metrics collected via sequential per-card HTTP requests

- **文件**：`packages/ai-quality/src/cli/supervisor-rc-gate.ts:234`
- **类别**：DB-N+1
- **问题**：`collectActualEvidenceMetrics` iterates `for (const card of cards)` and `await`s `getCardEvidenceFromApi(token, card.cardId)` one card at a time (line 236). Each request is a full HTTP round-trip to `/cards/:id/evidence`, so latency compounds linearly with card count (N+1 pattern over the network).
- **建议**：Provide a batched endpoint (e.g., POST /cards/evidence/batch with card ids) or run the fetches concurrently with a bounded concurrency limit (e.g., Promise.all with a small pool). Collect results into a Map keyed by cardId.

#### [Medium] Trigram set recomputed for every sliding-window position

- **文件**：`packages/ai-quality/src/real-align.ts:77`
- **类别**：Algorithmic
- **问题**：In `alignSingle`, the fuzzy scoring loop (lines 77-82) calls `trigrams(slice)` at every window step, constructing and hashing a new trigram Set per window. For long blocks this is O(number_of_windows × normalized_length) trigram construction, which dominates alignment time. The query trigram set could be reused across steps.
- **建议**：Precompute the trigram set once per slice window if reuse is possible, but more importantly stop recomputing full normalization/trigram per step: instead maintain a rolling trigram window (add/remove at the edges) or precompute all trigrams of the block once and index by offset for O(1) window checks.

#### [Medium] hasDirectFragment is O(n·m) substring scan over normalized text

- **文件**：`packages/shared/src/question-safety.ts:102`
- **类别**：Algorithmic
- **问题**：`hasDirectFragment` loops over each start position in `source` (up to claim length) and runs `normTarget.includes(fragment)` for each fragment (line 110). With a ~500-char question and similarly sized claim this is ~250k character comparisons per call, and it is invoked multiple times per question assessment (claim, quote, and each rubric item). This runs on every AI question before persistence.
- **建议**：Build a single pass comparing target tokens against source fragments using a Set of target substrings of length >= minLength, or use a rolling-hash/suffix-based scan to detect overlapping fragments in O(n+m) instead of O(n·m).

#### [Low] getPromptCacheProviders creates a new Set on every call

- **文件**：`packages/shared/src/feature-flags.ts:122-132`
- **类别**：Cache
- **问题**：shouldUsePromptCache calls getPromptCacheProviders on every provider invocation, which re-splits the env var and allocates a new Set each time. In hot LLM request paths this is unnecessary per-call allocation.
- **建议**：Memoize the parsed provider Set at module load (or lazily once), since PROMPT_CACHE_PROVIDERS is effectively static in production.

## web-frontend

| 严重度 | 文件 | 行 | 类别 | 问题 |
|---|---|---|---|---|
| High | `apps/web/components/NoteEditor.tsx` | 714-728 | DB-unbounded-query | Full note version history re-fetched on every save |
| Medium | `apps/web/app/(workspace)/(default)/page.tsx` | 95-97 | DB-unbounded-query | Home page fetches all cards and all jobs without pagination |
| Medium | `apps/web/app/(workspace)/(default)/sources/page.tsx` | 182 | DB-unbounded-query | Sources page full reload loads all sources without pagination |
| Medium | `apps/web/app/(workspace)/(default)/today/page.tsx` | 368-371, 466-469 | DB-unbounded-query | Today page loads all notes, cards, and jobs without limits |
| Medium | `apps/web/app/(workspace)/(focus)/cards/[id]/page.tsx` | 84-140 | DB-N+1 | Card detail page walks sequential paginated waterfall to locate a card |
| Medium | `apps/web/lib/api.ts` | 1201-1203 | DB-unbounded-query | listNoteVersions endpoint has no pagination |
| Low | `apps/web/app/(workspace)/(default)/today/page.tsx` | 235-252 | DB-N+1 | listAllReviews performs sequential paginated waterfall with up to 10 pages |
| Low | `apps/web/components/note-editor/useGenerationActivity.ts` | 73-86 | Memory-Leak | seenRef Set grows without bound across run lifetime |
| Low | `apps/web/components/NoteEditor.tsx` | 406, 409 | UI-Render | markdownToBlocks and wordCount re-run on every source change |
| Low | `apps/web/components/study/CardSetDeckPage.tsx` | 442, 694 | UI-Render | filterCount() called inside FILTERS.map causes 4× O(n) scans per render |
| Low | `apps/web/features/card-generation-v2/CandidateReview.tsx` | 192, 244-330 | Algorithmic | CandidateReview uses .find()/.includes() inside array loops |
| Low | `apps/web/features/card-generation-v2/CandidateReview.tsx` | 328-330 | Algorithmic | previewMerge does O(n×m) filter with includes inside each candidate |
| Low | `apps/web/features/companion-history/CompanionHistoryArchive.tsx` | 604 | UI-Render | HistorySummary recomputes actionCount with a filter on every render |
| Low | `apps/web/features/companion-pet/voice/companion-audio-buffer.ts` | 45-59 | Algorithmic | BoundedAudioBuffer.push copies samples one-by-one in a tight loop |
| Low | `apps/web/features/understanding/projection-client.ts` | 70-79 | Algorithmic | mergeProjectionPages JSON.stringifies each node for dedup |
| Low | `apps/web/lib/api.ts` | 1532-1540 | DB-unbounded-query | listMembers has no pagination and is called without parameters |
| Low | `apps/web/lib/api.ts` | 310-314 | Other | getCookie splits and maps the entire document.cookie on every API call |

### 详细描述（web-frontend）

#### [High] Full note version history re-fetched on every save

- **文件**：`apps/web/components/NoteEditor.tsx:714-728`
- **类别**：DB-unbounded-query
- **问题**：The useEffect at line 714 calls api.listNoteVersions(noteId) with dependency [noteId, currentVersionNo] (line 727). currentVersionNo updates on every save including autosaves (every ~2.5s during editing), so each save triggers a full unbounded fetch of ALL note versions. VersionsPanel also independently re-triggers the same endpoint.
- **建议**：Fetch note versions once on mount (or when the versions panel is first opened), not on every versionNo change. If refresh is truly needed after saves, debounce it to e.g. every 30s, or add pagination (limit/offset) to the listNoteVersions endpoint.

#### [Medium] Home page fetches all cards and all jobs without pagination

- **文件**：`apps/web/app/(workspace)/(default)/page.tsx:95-97`
- **类别**：DB-unbounded-query
- **问题**：loadHomeData calls api.listCards() and api.listJobs() with no limit/cursor parameters. For workspaces with large card/job histories, each request transfers the entire collection to the client, consuming memory and network. listJobs() on line 207 is also unbounded after capture.
- **建议**：Add limit (e.g., api.listCards({ limit: 50 })) and use the returned total field for counts rather than loading all items. For jobs, add a limit parameter and only fetch recent/active jobs.

#### [Medium] Sources page full reload loads all sources without pagination

- **文件**：`apps/web/app/(workspace)/(default)/sources/page.tsx:182`
- **类别**：DB-unbounded-query
- **问题**：loadSources({ fullReload: true }) calls api.listSources() with no cursor/limit, fetching the entire source library. On subsequent full reloads (e.g., initial mount and retries) the API transfers every row. The loadMore path (line 309) correctly paginates with limit 50, so the first load should match.
- **建议**：Add a default limit to the initial load (e.g., api.listSources({ limit: 50 })) and rely on nextCursor + loadMore to fetch additional pages.

#### [Medium] Today page loads all notes, cards, and jobs without limits

- **文件**：`apps/web/app/(workspace)/(default)/today/page.tsx:368-371, 466-469`
- **类别**：DB-unbounded-query
- **问题**：The Promise.allSettled on lines 366-373 calls api.listNotes() and api.listCards() with no limit or cursor. The retryDataset function (lines 466-469) also calls the same endpoints without limits. This can saturate memory as collections grow.
- **建议**：Pass explicit limits (e.g., api.listNotes({ limit: 100 }), api.listCards({ limit: 100 })) and drive counts from the `total` fields returned by the API instead of loading all items.

#### [Medium] Card detail page walks sequential paginated waterfall to locate a card

- **文件**：`apps/web/app/(workspace)/(focus)/cards/[id]/page.tsx:84-140`
- **类别**：DB-N+1
- **问题**：locateCardInList (line 84) makes up to 20 sequential api.listCards({cursor, limit:100}) round-trips to find a specific card by ID, then computes prev/next pagination. Each page fetch is awaited serially; if the card is far into the list this creates a slow waterfall. The 60s TTL cache helps repeat visits but the first visit to a card is expensive.
- **建议**：Add a server-side single-card lookup endpoint (GET /cards/:id with prev/next metadata), or fetch multiple pages concurrently via Promise.all since cursor pages are independent when only locating an item.

#### [Medium] listNoteVersions endpoint has no pagination

- **文件**：`apps/web/lib/api.ts:1201-1203`
- **类别**：DB-unbounded-query
- **问题**：api.listNoteVersions(id) calls GET /notes/:id/versions and returns ALL versions without limit/offset. Called from NoteEditor on every save (see NoteEditor finding) and VersionsPanel retry, this endpoint has no way to bound the response size for notes with long edit histories.
- **建议**：Add limit/cursor parameters to the backend endpoint and paginate the frontend, or at minimum cap server-side to the most recent N (e.g., 100) versions.

#### [Low] listAllReviews performs sequential paginated waterfall with up to 10 pages

- **文件**：`apps/web/app/(workspace)/(default)/today/page.tsx:235-252`
- **类别**：DB-N+1
- **问题**：listAllReviews (lines 225-258) iterates listReviews sequentially with while(true), awaiting each page before fetching the next (up to 1000 reviews via 10×100). This is inherently sequential since nextCursor depends on the prior response, but it creates up to 10 serial network round trips on first load.
- **建议**：Consider using a server-side 'due today' aggregate endpoint that returns the bounded result in one request, or reduce the per-page count and rely more heavily on the REVIEW_CACHE.

#### [Low] seenRef Set grows without bound across run lifetime

- **文件**：`apps/web/components/note-editor/useGenerationActivity.ts:73-86`
- **类别**：Memory-Leak
- **问题**：seenRef.current (line 73) accumulates every unique eventKey seen so far, with no eviction strategy. The events buffer is capped at 500 but the seen set retains every event key for the entire run's lifetime, which grows with total agent-event volume (no upper bound for very long runs).
- **建议**：Bound the seen set to the same cap as the buffer (e.g., when buffer truncation drops events, also drop their keys from seen) since events older than the buffer window cannot be deduplicated against anyway.

#### [Low] markdownToBlocks and wordCount re-run on every source change

- **文件**：`apps/web/components/NoteEditor.tsx:406, 409`
- **类别**：UI-Render
- **问题**：previewBlocks (line 406) calls markdownToBlocks(source) and wordCount (line 409) does source.replace(/\\s/g,'').length — both O(n) runs over the entire note on every source update (~5×/sec with the Milkdown 200ms debounce during editing). For 50K+ character notes this is significant synchronous work in render.
- **建议**：Debounce or throttle the costly derivations (e.g., compute previewBlocks only when the preview panel is visible or after a longer debounce window), and compute wordCount incrementally or lazily.

#### [Low] filterCount() called inside FILTERS.map causes 4× O(n) scans per render

- **文件**：`apps/web/components/study/CardSetDeckPage.tsx:442, 694`
- **类别**：UI-Render
- **问题**：Each FILTER button calls filterCount(filtered, item.key) inside the map, which does a full array scan per filter key (4 filters = 4 O(n) passes on every render). Though filtered is memoized, the per-render scan of a large card-set list adds avoidable work.
- **建议**：Precompute all filter counts in a single useMemo that iterates filtered once (like the cards page does with filterCounts), returning a Map<Filter, number>, then look up per button.

#### [Low] CandidateReview uses .find()/.includes() inside array loops

- **文件**：`apps/web/features/card-generation-v2/CandidateReview.tsx:192, 244-330`
- **类别**：Algorithmic
- **问题**：Methods like clearReveal (line 192: Object.entries(current).filter(... !candidateIds.includes(...))) and previewMerge (line 328: candidates.filter(... mergeTargetIds.includes(...))) are O(n×m) when candidate counts are non-trivial. The per-item .find() calls in saveEdit/finishRecheck/undoReject also scan the array per operation.
- **建议**：Build a Map<id, candidate> index once (useMemo) for O(1) lookups, and turn mergeTargetIds into a Set to make includes() O(1).

#### [Low] previewMerge does O(n×m) filter with includes inside each candidate

- **文件**：`apps/web/features/card-generation-v2/CandidateReview.tsx:328-330`
- **类别**：Algorithmic
- **问题**：The targets = candidates.filter(...mergeTargetIds.includes(...)) pattern at line 328 is O(n×m) (n = candidates, m = merge targets). For candidate pools beyond ~dozens this repeated lookup is avoidable with a Set.
- **建议**：Convert mergeTargetIds to a Set once for the operation (new Set(mergeTargetIds)) before filtering; makes the filter O(n).

#### [Low] HistorySummary recomputes actionCount with a filter on every render

- **文件**：`apps/web/features/companion-history/CompanionHistoryArchive.tsx:604`
- **类别**：UI-Render
- **问题**：HistorySummary filters the full entries array on every render (line 604) using ['action','result','route'].includes(entry.kind) — O(n×3) per render for the summary text, with no useMemo. For conversations with hundreds of entries this re-scan runs on each parent re-render.
- **建议**：Memoize the summary computation (useMemo on [entries]) or compute it in one pass along with other derived counts.

#### [Low] BoundedAudioBuffer.push copies samples one-by-one in a tight loop

- **文件**：`apps/web/features/companion-pet/voice/companion-audio-buffer.ts:45-59`
- **类别**：Algorithmic
- **问题**：The push method iterates chunk.length with a per-sample loop performing modulo indexing + individual array writes. For typical 16s @48kHz buffers (768k samples) and frequent AudioWorklet chunks, this per-sample JS loop adds avoidable CPU overhead on the audio processing path.
- **建议**：Use TypedArray.set() with modulo-aware two-copy logic to copy whole runs of samples at once instead of element-by-element, reducing per-sample interpreter overhead substantially.

#### [Low] mergeProjectionPages JSON.stringifies each node for dedup

- **文件**：`apps/web/features/understanding/projection-client.ts:70-79`
- **类别**：Algorithmic
- **问题**：Each node's nodeRef (or the node itself when nodeRef is missing) is JSON.stringify'd on line 73 to build a dedup key. For projections up to 8000 key points, this produces large temporary strings and repeated object serialization on every merge.
- **建议**：If nodeRef is a stable unique ID, use it directly (or a composite string built by concatenation) instead of full JSON serialization; only fall back to JSON dump for genuinely nested structures.

#### [Low] listMembers has no pagination and is called without parameters

- **文件**：`apps/web/lib/api.ts:1532-1540`
- **类别**：DB-unbounded-query
- **问题**：The listMembers API returns the full member list with no limit/offset/cursor. InviteMemberSettings.tsx calls it concurrently with listInvites; for workspaces with many members this loads all rows into memory.
- **建议**：Add limit/offset to the /members endpoint and paginate in the settings UI, or cap the server response.

#### [Low] getCookie splits and maps the entire document.cookie on every API call

- **文件**：`apps/web/lib/api.ts:310-314`
- **类别**：Other
- **问题**：getCsrfToken() → getCookie() runs document.cookie.split(';').map(...).find(...) on every non-GET API request. Each call allocates an array of all cookies, then scans with map. While cookies are small, this is repeated per request in hot paths (e.g., autosave POSTs every 2.5s).
- **建议**：Cache the parsed CSRF cookie value and re-parse only on cookie change, or use a lightweight regex match directly on the cookie string.

## 附：静态扫描低置信度候选（需人工确认）

以下条目来自自动化模式扫描，命中“循环内 DB/网络/查找”等模式，但因规模小、已有注释说明权衡或尚未逐行复核，未列入主清单。建议后续按需确认：

| 文件 | 行 | 模式 | 说明 |
|---|---|---|---|
| `apps/api/src/modules/card-generation-v2/legacy-read-adapter.ts` | 138, 190 | DB-N+1 | `readPublicCardsBatchV2` / `listActiveObjectivesV2` 对每个 objective 单独查最新 revision/public card；objective 数量大时 RTT 线性增长。 |
| `apps/api/src/modules/card-generation-v2/activation-service.ts` | 441-619 | DB-N+1 | 激活路径逐候选执行多次 insert/select；代码注释说明 N≤50 且为单事务内顺序写，收益低风险高，但仍是长事务内大量 RTT。 |
| `apps/api/src/modules/card-generation-v2/evidence-seal-service.ts` | 189-241 | DB-N+1 | 每个 span 先查后插 evidence snapshot/eligibility；批量时可用 `IN` 预查 + 批量 insert。 |
| `apps/api/src/modules/card-generation-v2/card-service.ts` | 444-456 | DB-N+1 | 每个 due reminder 单独 UPDATE + 插 domain event；可批量 UPDATE 后统一插事件。 |
| `apps/api/src/modules/import/routes.ts` | 83-163 | DB-N+1 | 每篇导入笔记一个嵌套事务（约 5 次 DB 操作）；代码注释说明串行是有意为之，但 100 篇约 500 次顺序 RTT，仍属低频批量导入优化点。 |
| `apps/api/src/modules/companion-bridge/context-service.ts` | 185-201 | DB-N+1 | 按 table 分组后每类执行一次 SQL；table 数通常很小，但可改为单条 UNION/批量解析。 |
| `apps/api/src/modules/learning-runs/run-service.ts` | 821-921, 1258-1352 | DB-N+1 | 创建 run 时对 primary/alternative 两个 variant 分别插入 4 张表；数量固定为 2，影响有限。 |
| `apps/api/src/modules/learning-sessions/ffprobe.ts` | 114-119 | IO-Blocking | 清理临时文件时逐个 `stat`/`rm`；脚本/低频路径，可改 `Promise.all` 或 `fs.rm` 目录。 |
| `apps/web/lib/understanding-graph.ts` | 691-712 | Algorithmic | 图布局中多处 filter/sort 扫描节点集合；节点数大时可预建索引。 |
| `apps/web/features/companion-pet/runtime/PetRuntimeProvider.tsx` | 1742-1850 | Timer-Leak | effect 循环内创建多个 `setTimeout`，需确认所有 cleanup 路径都会清 timer。 |

## 修复记录（2026-08-16）

### 主清单（62 项）

- ✅ **已修复：57 项**。覆盖 DB 批量化/加 LIMIT/并行化、N+1 消除、Map/Set 索引、缓存/记忆化、定时器清理、SSE 连接上限、前端分页/防抖、音频 TypedArray 拷贝、AI-quality 并发池等。
- ⏭️ **保留未改：5 项**，原因均为正确性/架构/已是最优，强行修改会改变行为或引入风险：

| 文件 | 行 | 问题 | 保留原因 |
|---|---|---|---|
| `apps/api/src/modules/learning-runs/shadow-translator.ts` | 77-93, 119-123 | shadow reconciliation 三个无界全表 SELECT | 报表需要精确全量计数；分页会静默漏数，属批处理脚本非热路径 |
| `apps/api/src/modules/learning-runs/run-processing-tick.ts` | 1246-1261 | 每个 completed reminder 单独 insertDomainEvent | 每次 run 仅 0-2 条，收益极小且需改共享 helper API |
| `apps/api/src/modules/learning-runs/run-routes.ts` | 257-297 | SSE 每客户端每 3s 轮询 DB | 改为共享事件总线/长轮询属架构级改动，会改变客户端可见行为 |
| `apps/web/app/(workspace)/(default)/today/page.tsx` | 235-252 | listAllReviews 顺序分页瀑布 | 游标分页天然依赖上一页；建议后续做服务端 due-today 聚合接口 |
| `apps/web/components/NoteEditor.tsx` | 406, 409 | markdownToBlocks/wordCount 每次 source 变化重算 | 已有 useMemo([source])，且结果供常驻页脚/大纲使用，无法安全降频 |

### 补充候选（10 项）

| 文件 | 行 | 状态 |
|---|---|---|
| `apps/api/src/modules/card-generation-v2/legacy-read-adapter.ts` | 138, 190 | ✅ 已批量读取 latest revision / cards |
| `apps/api/src/modules/card-generation-v2/activation-service.ts` | 441-619 | ⏭️ 保留：代码注释明确 N≤50 单事务顺序写，批量重构收益低风险高 |
| `apps/api/src/modules/card-generation-v2/evidence-seal-service.ts` | 189-241 | ✅ 已改为批量 insert + 去除无效存在性查询 |
| `apps/api/src/modules/card-generation-v2/card-service.ts` | 444-456 | ✅ 已改为一次批量 UPDATE + 逐条事件（保留 CAS） |
| `apps/api/src/modules/import/routes.ts` | 83-163 | ⏭️ 保留：逐篇嵌套事务为有意设计，低频批量导入可接受 |
| `apps/api/src/modules/companion-bridge/context-service.ts` | 185-201 | ✅ 已并行化 per-table 校验 |
| `apps/api/src/modules/learning-runs/run-service.ts` | 821-921, 1258-1352 | ⏭️ 保留：variant 数量固定为 2，影响有限 |
| `apps/api/src/modules/learning-sessions/ffprobe.ts` | 114-119 | ✅ 已并行化临时文件清理 |
| `apps/web/lib/understanding-graph.ts` | 691-712 | ⏭️ 保留：候选集合小且已有空间哈希，优化收益有限 |
| `apps/web/features/companion-pet/runtime/PetRuntimeProvider.tsx` | 1742-1850 | ⏭️ 确认已有 cleanup 路径清理 cooldown/turn timers，无需改动 |

### 验证状态

- ✅ `apps/api` typecheck 通过
- ✅ `apps/web` typecheck 通过
- ✅ `apps/desktop` typecheck 通过
- ✅ `packages/shared` typecheck 通过
- ✅ `packages/ai-quality` typecheck 通过
- ✅ `apps/api` 测试：3330 pass / 0 fail / 1 skip
- ✅ `apps/web` 测试：624 pass / 0 fail
- ✅ `packages/shared` 测试：495 pass / 0 fail
- ✅ `packages/ai-quality` 测试：115 pass / 0 fail
