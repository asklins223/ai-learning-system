# 项目性能问题扫描报告（第五轮，含 Worker）
> 扫描时间：2026-08-16（第五轮）
> 扫描范围：`apps/api`、`apps/web`、`apps/desktop`、`packages/*`、**`workers/ai-worker`** 生产代码（排除测试、构建产物、迁移、node_modules）。
> 说明：本轮在前四轮修复后重新扫描，继续包含 worker 相关代码。

共发现 **37** 项性能风险。

| 严重度 | 数量 |
|---|---|
| High | 3 |
| Medium | 15 |
| Low | 19 |

| 分区 | 数量 |
|---|---|
| api-core | 3 |
| api-learning | 7 |
| api-companion-other | 5 |
| web-frontend | 7 |
| desktop-shared-ai | 4 |
| worker | 11 |

## 完整发现清单
| 严重度 | 分区 | 文件 | 行 | 类别 | 问题 |
|---|---|---|---|---|---|
| Medium | api-core | `apps/api/src/modules/benchmark/service.ts` | 649-674 | Polling | waitForAlignEvidence polls by loading all evidence rows instead of a COUNT |
| Medium | api-core | `apps/api/src/modules/understanding/projection-routes.ts` | 547-560 | Other | Projection evidence query silently truncates at LIMIT 500 without a cap/truncation signal |
| Low | api-core | `apps/api/src/modules/search/routes.ts` | 12 | DB-unbounded-query | Search supports deep OFFSET pagination up to 100,000 with DISTINCT ON + ILIKE |
| Medium | api-learning | `apps/api/src/modules/review/service.ts` | 173-177 | DB-unbounded-query | Full-table COUNT(*) with correlated EXISTS predicate on every review list page |
| Medium | api-learning | `apps/api/src/modules/review/service.ts` | 567-627 | DB-unbounded-query | listSanitizedReviews performs full heavy hydration then discards most of it |
| Low | api-learning | `apps/api/src/modules/review/service.ts` | 650-840 | DB-N+1 | getSanitizedReviewMeta makes 5-7 sequential DB round-trips for a single schedule |
| Low | api-learning | `apps/api/src/modules/review/attempt-service.ts` | 1026-1029 | DB-unbounded-query | Full count(*) scan per review-attempt history page |
| Medium | api-learning | `apps/api/src/modules/learning-runs/shadow-translator.ts` | 78-123 | DB-unbounded-query | Shadow reconciliation materializes entire workspace fact/envelope sets into memory (no LIMIT) |
| Low | api-learning | `apps/api/src/modules/learning-sessions/voice-service.ts` | 408-419 | Algorithmic | O(segments × criticalTerms) string-includes loop in ASR quality gate |
| High | api-companion-other | `apps/api/src/modules/companion-conversation/companion-rate-limit.ts` | 63-73 | Algorithmic | Full-Map O(n) sweep runs per call once size crosses 40k |
| Medium | api-learning | `apps/api/src/modules/companion-conversation/learning-action-bridge.ts` | 1254-1255 (also 1473-1529) | DB-N+1 | Action-run confirm path repeats epoch read + counter update + event insert twice |
| Low | api-companion-other | `apps/api/src/modules/companion-conversation/companion-events.ts` | 188-215 | DB-unbounded-query | Every SSE connect runs full-window min() and count() scans for validation |
| Low | api-companion-other | `apps/api/src/server.ts` | 431-451 | Timer-Leak | dbGaugeTimer not cleared during graceful shutdown |
| Low | api-companion-other | `apps/api/src/modules/companion-shell/account-events.ts` | 143 and 168 | Memory-Leak | The same close handler is registered twice on req.raw per SSE connection |
| Low | api-companion-other | `apps/api/src/modules/companion-shell/service.ts` | 909 and 933 | Other | Runtime-fence read paths perform DELETE before every SELECT |
| Medium | web-frontend | `apps/web/lib/api-types.ts` | 997-1019 | Algorithmic | Markdown import batch splitting re-encodes the whole candidate on every item (O(n²)) |
| Medium | web-frontend | `apps/web/lib/api.ts and memory pages` | 861-863 / 120 / 499 | DB-unbounded-query | Companion memory list is fetched with no limit/pagination |
| Medium | web-frontend | `apps/web/features/companion-pet/deliveries/useDeliveryInbox.ts` | 38,165 | Memory-Leak | Delivery inbox pending queue is unbounded |
| Low | web-frontend | `apps/web/app/(workspace)/(default)/cards/page.tsx` | 293-325 | Algorithmic | Cards page re-parses each card's coverage/date ~6x per recompute |
| Low | web-frontend | `apps/web/app/(workspace)/(default)/graph/page.tsx` | 728-735 | Algorithmic | Graph filterCounts performs four separate full passes over nodes |
| Low | web-frontend | `apps/web/app/(workspace)/(default)/today/page.tsx` | 705 | Algorithmic | Activity sort comparator reparses ISO timestamps on each comparison |
| Low | web-frontend | `apps/web/features/companion-history/CompanionHistoryArchive.tsx` | 142-145 | Algorithmic | History filterCounts filters the full entry list once per filter kind |
| Medium | desktop-shared-ai | `packages/shared/src/question-safety.ts` | 125-136 | Algorithmic | substringSet builds O(n²) substring set on every question safety assessment |
| Medium | desktop-shared-ai | `packages/db/src/schema/learning-metrics.ts` | 32-37 | DB-unbounded-query | High-volume metrics event table has no eventType/time index for aggregation queries |
| Low | desktop-shared-ai | `apps/desktop/src/persistence/device-pet-preferences.ts` | 109-117 | IO-Blocking | Synchronous writeFileSync+renameSync on Electron main event loop |
| Low | desktop-shared-ai | `apps/desktop/src/ipc/companion-bridge-ipc.ts` | 197-233 | Memory-Leak | Context lease heap retains stale/renewed entries until lazy expiry sweep |
| High | worker | `workers/ai-worker/src/agent/run-phase-context.ts` | 101-641 | DB-N+1 | Per-turn context load performs many serial DB round-trips with unbounded queries |
| Medium | worker | `workers/ai-worker/src/agent/run-phase-context.ts` | 168-229 | DB-unbounded-query | sourceBundles and candidates loaded without LIMIT on every turn |
| High | worker | `workers/ai-worker/src/agent/run-phase-executor.ts` | 605-628 | DB-unbounded-query | Critic turn loads ALL evidence spans/blocks with no LIMIT |
| Medium | worker | `workers/ai-worker/src/lib/governance.ts` | 594-633 | DB-N+1 | logAICall makes an extra workspaces SELECT on every AI audit write |
| Medium | worker | `workers/ai-worker/src/agent/context-builder.ts` | 179-188, 327-330, 488-491 | Algorithmic | Tool schemas JSON.parse + JSON.stringify on every agent turn |
| Low | worker | `workers/ai-worker/src/lib/providers/openai-compatible.ts` | 271-287 | Algorithmic | SSE stream buffer repeatedly sliced per line (potential O(n^2)) |
| Medium | worker | `workers/ai-worker/src/agent/tools/executor.ts` | 172-205 | DB-N+1 | Idempotency cache hit still performs a DB SELECT to replay results |
| Low | worker | `workers/ai-worker/src/agent/run-phase-context.ts` | 81-90, 415-419 | Cache | New per-run stable-cache adapter and new ContextBuilder constructed every turn |
| Low | worker | `workers/ai-worker/src/agent/tools/deck-draft.ts` | 916-929 | DB-unbounded-query | validate_draft loads all note blocks for a version with no LIMIT |
| Low | worker | `workers/ai-worker/src/index.ts` | 621-647 | DB-N+1 | Learning-assessment outbox claim loop is fully serial |
| Low | worker | `workers/ai-worker/src/agent/run-phase-executor.ts` | 136-187 | Algorithmic | countConsecutiveReadOnlySupervisorTurns rebuilds a full event map per supervisor turn |

## 详细描述
### 1. [Medium] waitForAlignEvidence polls by loading all evidence rows instead of a COUNT
- **文件**：`apps/api/src/modules/benchmark/service.ts:649-674`
- **类别**：Polling
- **问题**：waitForAlignEvidence runs inside the benchmark advisory lock and every 2s calls evidences.findMany to load every evidence row for all key points just to count distinct keyPointIds. This repeatedly transfers unbounded row sets on a hot polling loop.
- **建议**：Replace findMany with SELECT COUNT(DISTINCT key_point_id) / GROUP BY; optionally move polling outside the advisory lock.
### 2. [Medium] Projection evidence query silently truncates at LIMIT 500 without a cap/truncation signal
- **文件**：`apps/api/src/modules/understanding/projection-routes.ts:547-560`
- **类别**：Other
- **问题**：The evidence node query uses .limit(500) without recording whether the limit was hit; the consuming loop builds evidence nodes from whatever is returned, producing silently incomplete projection graphs.
- **建议**：Track whether evidenceRows.length reached 500 (fetch limit+1 then slice), set a capped flag, log warning, expose to callers.
### 3. [Low] Search supports deep OFFSET pagination up to 100,000 with DISTINCT ON + ILIKE
- **文件**：`apps/api/src/modules/search/routes.ts:12`
- **类别**：DB-unbounded-query
- **问题**：The search endpoint accepts offset up to 100_000 and applies OFFSET after DISTINCT ON over all matching documents, forcing deep scans on each page.
- **建议**：Switch to keyset cursor (e.g. indexedAt/objectId) or cap offset much lower.
### 4. [Medium] Full-table COUNT(*) with correlated EXISTS predicate on every review list page
- **文件**：`apps/api/src/modules/review/service.ts:173-177`
- **类别**：DB-unbounded-query
- **问题**：listReviews runs count(*) on every request with reviewScheduleTargetsConsumableCardPredicate, scanning the entire pending/existing schedule set regardless of page size.
- **建议**：Skip total count when not needed, or use cheaper index-only/pre-aggregated count; only run precise count when required.
### 5. [Medium] listSanitizedReviews performs full heavy hydration then discards most of it
- **文件**：`apps/api/src/modules/review/service.ts:567-627`
- **类别**：DB-unbounded-query
- **问题**：The sanitized review queue endpoint delegates to full listReviews, hydrating claims/evidence/noteBlocks/V2 projections then stripping them for the response.
- **建议**：Add a lightweight sanitized query path selecting only neutral schedule + minimal keyPoint/card id resolution.
### 6. [Low] getSanitizedReviewMeta makes 5-7 sequential DB round-trips for a single schedule
- **文件**：`apps/api/src/modules/review/service.ts:650-840`
- **类别**：DB-N+1
- **问题**：Resolving one sanitized review meta performs a long sequential await chain with many dependent lookups.
- **建议**：Defer keyPoint-only lookups into one Promise.all, and compute reviewReason/evidence/exposure in a parallel batch after card resolution.
### 7. [Low] Full count(*) scan per review-attempt history page
- **文件**：`apps/api/src/modules/review/attempt-service.ts:1026-1029`
- **类别**：DB-unbounded-query
- **问题**：listReviewAttemptHistory fetches limit+1 page rows via cursor, then runs count(*) over the full base predicate on every request.
- **建议**：Return nextCursor from hasMore and drop total count, or expose total only on first page.
### 8. [Medium] Shadow reconciliation materializes entire workspace fact/envelope sets into memory (no LIMIT)
- **文件**：`apps/api/src/modules/learning-runs/shadow-translator.ts:78-123`
- **类别**：DB-unbounded-query
- **问题**：runShadowReconciliation executes three SELECTs with no LIMIT and builds full in-memory Maps/arrays, which can exhaust memory on large workspaces.
- **建议**：Page/stream these queries or add a workspace/cutover watermark threshold with early exit to avoid OOM.
### 9. [Low] O(segments × criticalTerms) string-includes loop in ASR quality gate
- **文件**：`apps/api/src/modules/learning-sessions/voice-service.ts:408-419`
- **类别**：Algorithmic
- **问题**：assessTranscriptionQuality iterates transcript segments and for each low-confidence segment calls critical.some(term => segText.includes(term)).
- **建议**：Pre-index critical terms into a Set/single regex and scan segment tokenization once.
### 10. [High] Full-Map O(n) sweep runs per call once size crosses 40k
- **文件**：`apps/api/src/modules/companion-conversation/companion-rate-limit.ts:63-73`
- **类别**：Algorithmic
- **问题**：companionRateLimit's size-triggered block iterates the entire buckets Map on every call whenever size >= MAX_BUCKETS_BEFORE_SWEEP, with no interval gate, stalling hot paths under burst keys.
- **建议**：Apply SWEEP_INTERVAL_MS (or size-change threshold) to the size-triggered full sweep so it runs at most once per second.
### 11. [Medium] Action-run confirm path repeats epoch read + counter update + event insert twice
- **文件**：`apps/api/src/modules/companion-conversation/learning-action-bridge.ts:1254-1255 (also 1473-1529)`
- **类别**：DB-N+1
- **问题**：appendDecisionEvent and appendActionStartedEvent each execute getCompanionAccountEpoch + counter UPDATE + INSERT = 6 DB round trips for events sharing the same user/conversation.
- **建议**：Merge into a single batch: fetch account_epoch once, one counter UPDATE incrementing by N, and multi-row INSERT all events.
### 12. [Low] Every SSE connect runs full-window min() and count() scans for validation
- **文件**：`apps/api/src/modules/companion-conversation/companion-events.ts:188-215`
- **类别**：DB-unbounded-query
- **问题**：validateCompanionCursor runs SELECT min(seq) and count(*) over the entire replayable window on every new SSE connection.
- **建议**：Bound window check when after is close to tail, or maintain a per-conversation durable count.
### 13. [Low] dbGaugeTimer not cleared during graceful shutdown
- **文件**：`apps/api/src/server.ts:431-451`
- **类别**：Timer-Leak
- **问题**：dbGaugeTimer is setInterval/unref'd but not added to the shutdown clearTimer callback, so it keeps issuing DB queries every 30s during graceful shutdown.
- **建议**：Include dbGaugeTimer in the cleanup list.
### 14. [Low] The same close handler is registered twice on req.raw per SSE connection
- **文件**：`apps/api/src/modules/companion-shell/account-events.ts:143 and 168`
- **类别**：Memory-Leak
- **问题**：openCompanionAccountEventStream calls writer.onAbort(close) before the DB read and again inside start(), stacking two identical close listeners per connection.
- **建议**：Register writer.onAbort(close) exactly once, or make writer's onAbort idempotent.
### 15. [Low] Runtime-fence read paths perform DELETE before every SELECT
- **文件**：`apps/api/src/modules/companion-shell/service.ts:909 and 933`
- **类别**：Other
- **问题**：getActiveRuntimeFence/listActiveRuntimeFences run DELETE FROM companion_runtime_fences WHERE expires_at <= now() before each SELECT, mutating the table on read paths.
- **建议**：Make read paths SELECT-only and move expired-fence cleanup to periodic maintenance sweep.
### 16. [Medium] Markdown import batch splitting re-encodes the whole candidate on every item (O(n²))
- **文件**：`apps/web/lib/api-types.ts:997-1019`
- **类别**：Algorithmic
- **问题**：splitMarkdownImportBatches spreads the accumulating array and calls markdownImportPayloadBytes over the whole candidate for every item, producing O(batch²) stringify/encode work.
- **建议**：Track cumulative byte size incrementally and skip growing-spread; serialize once per complete batch.
### 17. [Medium] Companion memory list is fetched with no limit/pagination
- **文件**：`apps/web/lib/api.ts and memory pages:861-863 / 120 / 499`
- **类别**：DB-unbounded-query
- **问题**：api.listCompanionMemories(true) issues /companion/memory with no limit/cursor; memory page and settings card render the full list.
- **建议**：Add server-side limit+cursor pagination and render page-by-page / cap initial fetch.
### 18. [Medium] Delivery inbox pending queue is unbounded
- **文件**：`apps/web/features/companion-pet/deliveries/useDeliveryInbox.ts:38,165`
- **类别**：Memory-Leak
- **问题**：onDelivery unconditionally pushes to pendingRef with no cap/eviction; a large server backlog or burst grows the queue without bound.
- **建议**：Bound pending queue (keep N most-recent, drop/ack oldest) and cap one-at-a-time consumption.
### 19. [Low] Cards page re-parses each card's coverage/date ~6x per recompute
- **文件**：`apps/web/app/(workspace)/(default)/cards/page.tsx:293-325`
- **类别**：Algorithmic
- **问题**：filterCounts and queueCounts each call learningCardMatchesFilter multiple times, re-running coverage warnings and date parsing per card per recompute.
- **建议**：Precompute per-card derived state (learningObjectiveState + review timestamp) into a Map once per items revision.
### 20. [Low] Graph filterCounts performs four separate full passes over nodes
- **文件**：`apps/web/app/(workspace)/(default)/graph/page.tsx:728-735`
- **类别**：Algorithmic
- **问题**：filterCounts filters nodes for card type then attention/unseen/understood separately, plus separate cardCount/keyPointCount passes.
- **建议**：Collapse into a single loop over rawGraph.nodes accumulating all counts.
### 21. [Low] Activity sort comparator reparses ISO timestamps on each comparison
- **文件**：`apps/web/app/(workspace)/(default)/today/page.tsx:705`
- **类别**：Algorithmic
- **问题**：rows.sort comparator calls new Date(b.time).getTime() - new Date(a.time).getTime() per comparison.
- **建议**：Precompute each row's numeric timestamp once and sort by that number.
### 22. [Low] History filterCounts filters the full entry list once per filter kind
- **文件**：`apps/web/features/companion-history/CompanionHistoryArchive.tsx:142-145`
- **类别**：Algorithmic
- **问题**：filterCounts runs entries.filter for each of ~6 FILTERS, O(F×N); visibleEntries separately scans all entries again.
- **建议**：Do a single pass over entries incrementing per-filter counts.
### 23. [Medium] substringSet builds O(n²) substring set on every question safety assessment
- **文件**：`packages/shared/src/question-safety.ts:125-136`
- **类别**：Algorithmic
- **问题**：substringSet materializes every contiguous substring of the question for lengths 8..maxFragmentLen. For Chinese text this can produce ~n²/2 substrings, transiently tens of MB.
- **建议**：Invert the check: build a bounded Set of source fragments and test inclusion, or use rolling-hash/Aho-Corasick; cap maxFragmentLen.
### 24. [Medium] High-volume metrics event table has no eventType/time index for aggregation queries
- **文件**：`packages/db/src/schema/learning-metrics.ts:32-37`
- **类别**：DB-unbounded-query
- **问题**：learning_metric_events only declares (workspace_id, user_id, occurred_at DESC); eventType-scoped aggregates scan the whole workspace partition.
- **建议**：Add index on (workspace_id, event_type, occurred_at DESC) or per-user event-type index.
### 25. [Low] Synchronous writeFileSync+renameSync on Electron main event loop
- **文件**：`apps/desktop/src/persistence/device-pet-preferences.ts:109-117`
- **类别**：IO-Blocking
- **问题**：saveDevicePetPreferences uses synchronous writeFileSync+renameSync from window setters and drag-settle saves, blocking the main process.
- **建议**：Switch to async fs with last-write-wins coalescing/debounce.
### 26. [Low] Context lease heap retains stale/renewed entries until lazy expiry sweep
- **文件**：`apps/desktop/src/ipc/companion-bridge-ipc.ts:197-233`
- **类别**：Memory-Leak
- **问题**：Every publish/renew heapPush()es an entry; revoked/renewed entries are only reclaimed lazily at sweep time, so heap can grow transiently under churn.
- **建议**：Sweep on unregister/renew, cap heap size with compaction, or schedule a reaper keyed to earliest expiry.
### 27. [High] Per-turn context load performs many serial DB round-trips with unbounded queries
- **文件**：`workers/ai-worker/src/agent/run-phase-context.ts:101-641`
- **类别**：DB-N+1
- **问题**：loadAgentRunPhaseContext runs every agent turn and issues ~10 DB round-trips in series, with only first two parallelized, adding latency before each LLM call.
- **建议**：Parallelize independent loads and reuse governance context; cache run-scoped data keyed by stateVersion.
### 28. [Medium] sourceBundles and candidates loaded without LIMIT on every turn
- **文件**：`workers/ai-worker/src/agent/run-phase-context.ts:168-229`
- **类别**：DB-unbounded-query
- **问题**：Both cardGenerationSourceBundles and cardGenerationCandidates are selected with no LIMIT/order and no stateVersion guard, transferring full sets on every turn.
- **建议**：Add reasonable cap + incremental cursor, or cache per run guarded by stateVersion.
### 29. [High] Critic turn loads ALL evidence spans/blocks with no LIMIT
- **文件**：`workers/ai-worker/src/agent/run-phase-executor.ts:605-628`
- **类别**：DB-unbounded-query
- **问题**：executeCriticProviderCall selects every noteEvidenceSpans JOIN noteBlocks for the note version with no LIMIT, plus another full scan of noteBlocks for image assets.
- **建议**：Bound by candidate/draft-referenced evidence refIds only and paginate; avoid loading all spans per critic turn.
### 30. [Medium] logAICall makes an extra workspaces SELECT on every AI audit write
- **文件**：`workers/ai-worker/src/lib/governance.ts:594-633`
- **类别**：DB-N+1
- **问题**：logAICall calls getWorkspaceAIPolicy -> db.query.workspaces.findFirst on every audit write, even though callers already resolved governance earlier.
- **建议**：Pass already-resolved policy via dependencies.getPolicy from callers.
### 31. [Medium] Tool schemas JSON.parse + JSON.stringify on every agent turn
- **文件**：`workers/ai-worker/src/agent/context-builder.ts:179-188, 327-330, 488-491`
- **类别**：Algorithmic
- **问题**：getToolSchemasCached parses cached schema string on hit, then buildAndPack/buildExtractorTurn JSON.stringify the schemas again for token estimation.
- **建议**：Cache parsed schema object with precomputed token estimate; reuse instead of JSON round-trip.
### 32. [Low] SSE stream buffer repeatedly sliced per line (potential O(n^2))
- **文件**：`workers/ai-worker/src/lib/providers/openai-compatible.ts:271-287`
- **类别**：Algorithmic
- **问题**：chatCompletionStream shrinks buffer via buffer.slice(lineEnd+1) inside per-chunk while loop, copying remaining buffer per line.
- **建议**：Track byte offset cursor over chunk; flush decoded lines into array joined at end.
### 33. [Medium] Idempotency cache hit still performs a DB SELECT to replay results
- **文件**：`workers/ai-worker/src/agent/tools/executor.ts:172-205`
- **类别**：DB-N+1
- **问题**：When executedToolCache has the key, executeToolCall still runs db.select against cardGenerationAgentEvents to replay result.
- **建议**：Store sanitized result payload in bounded in-memory cache so cache hits replay without DB query.
### 34. [Low] New per-run stable-cache adapter and new ContextBuilder constructed every turn
- **文件**：`workers/ai-worker/src/agent/run-phase-context.ts:81-90, 415-419`
- **类别**：Cache
- **问题**：p4StableContextCacheFor(runId) returns a fresh closure and a new ContextBuilder/ContextPacker is constructed on each turn.
- **建议**：Cache adapter and ContextBuilder per run and reuse packer across turns.
### 35. [Low] validate_draft loads all note blocks for a version with no LIMIT
- **文件**：`workers/ai-worker/src/agent/tools/deck-draft.ts:916-929`
- **类别**：DB-unbounded-query
- **问题**：In quality-gate path, db.select({content}).from(noteBlocks) loads every block of the note version with no LIMIT.
- **建议**：Bound/paginate; restrict to blocks actually referenced by draft evidence spans.
### 36. [Low] Learning-assessment outbox claim loop is fully serial
- **文件**：`workers/ai-worker/src/index.ts:621-647`
- **类别**：DB-N+1
- **问题**：tickLearningAssessmentOutbox claims jobs one at a time in a sequential for-loop, each claim its own DB transaction.
- **建议**：Issue claim calls concurrently up to available, respecting fixed cap.
### 37. [Low] countConsecutiveReadOnlySupervisorTurns rebuilds a full event map per supervisor turn
- **文件**：`workers/ai-worker/src/agent/run-phase-executor.ts:136-187`
- **类别**：Algorithmic
- **问题**：Every supervisor provider call re-iterates all loaded agentEvents to rebuild Map<turnNo, Set<tool>> for read-only spin detection.
- **建议**：Maintain per-turn tool set incrementally on session/cursor instead of re-scanning all events.
## 修复记录（第五轮，2026-08-16）

- ✅ **已修复：33 项**
- ⏭️ **保留未改：4 项**，原因如下：

| # | 文件 | 行 | 问题 | 保留原因 |
|---|---|---|---|---|
| 4 | `apps/api/src/modules/review/service.ts` | 173-177 | Review 列表每页全表 COUNT(*) | `total` 是 API/前端契约必需字段，测试断言精确 total；暂无现成廉价 count，跳过/近似会破坏契约 |
| 8 | `apps/api/src/modules/learning-runs/shadow-translator.ts` | 78-123 | Shadow reconciliation 全量内存 | 需要全量行才能产生精确对账报告；分页/早退会改变 P2 gate 语义 |
| 17 | `apps/web/lib/api.ts + memory pages` | 861-863 / 120 / 499 | Companion memory 列表无分页 | 服务端已有 `MEMORY_LIST_LIMIT=200` 防御上限；完整分页需跨 API/UI 架构改动，纯前端截断会破坏管理面 |
| 28 | `workers/ai-worker/src/agent/run-phase-context.ts` | 168-229 | sourceBundles/candidates 无 LIMIT | 加 LIMIT 会截断 ledger 完整性；stateVersion 缓存不安全（这些表写入不 bump state_version），需架构级改造 |

### 验证状态

- ✅ `apps/api` typecheck 通过
- ✅ `apps/web` typecheck 通过
- ✅ `apps/desktop` typecheck 通过
- ✅ `packages/shared` typecheck 通过
- ✅ `packages/ai-quality` typecheck 通过
- ✅ `packages/db` typecheck 通过
- ✅ `workers/ai-worker` typecheck 通过
- ✅ `apps/api` 测试：3334 pass / 0 fail / 1 skip
- ✅ `apps/web` 测试：624 pass / 0 fail
- ✅ `apps/web` 组件测试：91 pass / 0 fail
- ✅ `packages/shared` 测试：496 pass / 0 fail
- ✅ `packages/ai-quality` 测试：115 pass / 0 fail
- ✅ `apps/desktop` 测试：37 pass / 0 fail
- ✅ `workers/ai-worker` 测试：1090 pass / 0 fail
