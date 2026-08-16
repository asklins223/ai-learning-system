# 项目性能问题扫描报告（第四轮，含 Worker）
> 扫描时间：2026-08-16（第四轮）
> 扫描范围：`apps/api`、`apps/web`、`apps/desktop`、`packages/*`、**`workers/ai-worker`** 生产代码（排除测试、构建产物、迁移、node_modules）。
> 说明：本轮在第一、二、三轮修复后重新扫描，继续包含 worker 相关代码。

共发现 **43** 项性能风险。

| 严重度 | 数量 |
|---|---|
| High | 1 |
| Medium | 23 |
| Low | 19 |

| 分区 | 数量 |
|---|---|
| api-core | 5 |
| api-learning | 11 |
| api-companion-other | 8 |
| web-frontend | 5 |
| desktop-shared-ai | 4 |
| worker | 10 |

## 完整发现清单
| 严重度 | 分区 | 文件 | 行 | 类别 | 问题 |
|---|---|---|---|---|---|
| Medium | api-core | `apps/api/src/modules/export/service.ts` | 128-137, 287-698 | Other | Export keyset batching does not bound peak memory — full tables accumulated |
| Medium | api-core | `apps/api/src/modules/search/service.ts` | 516-527, 578-648 | Other | reindexWorkspaceSearch builds unbounded in-memory documents array before batch insert |
| Low | api-core | `apps/api/src/modules/note/service.ts` | 1221-1264, 1727-1746 | DB-unbounded-query | Unchunked inArray on versionIds/cardIds/blockAssetIds in delete paths |
| Low | api-core | `apps/api/src/modules/export/service.ts` | 1134-1153 | DB-N+1 | Restore performs one UPDATE users per recovered user inside a loop |
| Low | api-core | `apps/api/src/modules/understanding/service.ts` | 136-144 | DB-unbounded-query | Unchunked inArray over all key points when loading evidence stats |
| Medium | api-learning | `apps/api/src/modules/review/service.ts` | 188-427 | Other | listReviews performs a long serial DB round-trip waterfall per request |
| Medium | api-learning | `apps/api/src/modules/review/routes.ts` | 29 | DB-unbounded-query | Review list allows deep offset pagination up to 100k and always runs a full count |
| Medium | api-learning | `apps/api/src/modules/review/consumer-eligibility.ts` | 8-105 | DB-N+1 | Consumable-card predicate is a 4-branch OR of correlated EXISTS subqueries applied per review row |
| Medium | api-learning | `apps/api/src/modules/learning-runs/run-routes.ts` | 248-274 | Polling | SSE event stream polls the DB every 3s per connected client with no re-entrancy guard |
| Medium | api-learning | `apps/api/src/modules/learning-runs/run-routes.ts` | 397, 445 | Concurrency | Fire-and-forget learning metrics writes have no backpressure |
| Medium | api-learning | `apps/api/src/modules/learning-runs/run-processing-tick.ts` | 96-163 | Concurrency | Run processing tick executes Critic HTTP calls serially for every claimed command within one tick |
| Medium | api-learning | `apps/api/src/modules/learning-sessions/commit-outbox.ts` | 288-295 | Concurrency | Commit outbox pre-claims 10 jobs serially then processes them serially, risking lease expiry |
| Low | api-learning | `apps/api/src/modules/learning-runs/run-service.ts` | 880-899, 1312-1331 | DB-N+1 | Per-variant disclosure-profile existence SELECT inside the variant insert loop |
| Low | api-learning | `apps/api/src/modules/learning-runs/shadow-translator.ts` | 79-127 | DB-unbounded-query | Shadow reconciliation loads all workspace facts and all outbox rows into memory without LIMIT |
| Low | api-learning | `apps/api/src/modules/learning-runs/legacy-backfill.ts` | 131-242 | DB-unbounded-query | Legacy backfill loads entire workspace episode/session/run/envelope sets into memory |
| Low | api-learning | `apps/api/src/modules/learning-sessions/gold-rounds.ts` | 401-447 | Algorithmic | Coverage matrix recomputes full-sample filters inside nested loops |
| Medium | api-companion-other | `apps/api/src/modules/companion-conversation/companion-rate-limit.ts` | 25-65 | Algorithmic | Per-request O(n) Map sweep on every companion API call |
| Low | api-companion-other | `apps/api/src/modules/companion-conversation/assistant-session-routes.ts` | 131-143 | DB-N+1 | History search opens a second DB transaction to fetch conversation titles |
| Medium | api-companion-other | `apps/api/src/modules/companion-conversation/companion-export.ts` | 76-91, 380-387 | Memory-Leak | Companion export accumulates the entire NDJSON output in memory before writing |
| Medium | api-companion-other | `apps/api/src/modules/companion-shell/audit-service.ts` | 744-795 | Memory-Leak | exportCompanionUserData loads the full audit and ledger tables into memory with no cap |
| Medium | api-companion-other | `apps/api/src/modules/companion-shell/audit-service.ts` | 856-873 | Concurrency | deleteAllUserCompanionAuditAndLedger issues unbounded parallel transactions per workspace |
| Low | api-companion-other | `apps/api/src/modules/companion-journey/journey-service.ts` | 534, 654 | Algorithmic | JSON.stringify(refs) comparison performed per event/pending-row |
| Low | api-companion-other | `apps/api/src/modules/companion-conversation/proactive-hook.ts` | 146-196 | DB-N+1 | Run-completion proactive hook runs 4 independent queries serially |
| Low | api-companion-other | `apps/api/src/modules/identity/rate-limit.ts` | 34-35, 53-57 | Algorithmic | MemoryRateLimitStore.increment runs an O(n) lazySweep on every consume |
| Medium | web-frontend | `apps/web/app/(workspace)/(default)/notes/page.tsx` | 123 (also 228, 260) | DB-unbounded-query | Unbounded initial/refresh fetch of all notes (no limit) |
| Medium | web-frontend | `apps/web/app/(workspace)/(default)/cards/page.tsx` | 149 (api lib/api.ts:984-986) | DB-unbounded-query | listLearningCardsV2() fetches all V2 cards with no pagination |
| Medium | web-frontend | `apps/web/app/(workspace)/(default)/graph/page.tsx` | 703-716 (searchableText at 192-202) | Algorithmic | Graph search re-runs JSON.stringify on every node for each keystroke |
| Low | web-frontend | `apps/web/features/learning-run/renderers/OrderingTask.tsx` | 25 | Algorithmic | Un-memoized O(n·m) filter(!includes) recomputed each render |
| Low | web-frontend | `apps/web/features/learning-run/renderers/StructuredBundleTask.tsx` | 159-160 | Algorithmic | selectedTokens.includes() inside map over token list per render |
| Low | desktop-shared-ai | `apps/desktop/src/windows/pet-window-state.ts` | 187-211 | IO-Blocking | getState() re-enumerates all displays + recomputes SHA-256 fingerprints on every call |
| Low | desktop-shared-ai | `apps/desktop/src/main.ts` | 160-168 | UI-Render | broadcastWindowState() runs zod parse + native display work on every state change |
| Low | desktop-shared-ai | `apps/desktop/src/ipc/companion-bridge-ipc.ts` | 280-281 | Polling | Bridge context lease sweep iterates the whole records Map every 30s |
| Low | desktop-shared-ai | `apps/desktop/src/windows/pet-window-state.ts` | 219-257 | Cache | selectDisplay/displayContainingWindow perform repeated linear finds over display list |
| High | worker | `workers/ai-worker/src/agent/specialist-persist.ts` | 1243-1297 | DB-N+1 | reconcileStuckSupervisors does 5 sequential DB round-trips per waiting_child parent |
| Medium | worker | `workers/ai-worker/src/agent/plan-path.ts` | 209-210, 369 | DB-N+1 | createNextTurnJob runs a full workspace transaction per created unit |
| Medium | worker | `workers/ai-worker/src/agent/reconciler.ts` | 222-275 | DB-N+1 | resumeStuckWaitingParents enqueues resume jobs one DB call per parent |
| Medium | worker | `workers/ai-worker/src/agent/compose-consistency.ts` | 47-60 | Algorithmic | O(candidates × bundles) lookup via Object.values().some() inside per-candidate loop |
| Medium | worker | `workers/ai-worker/src/agent/run-phase-executor.ts` | 973-990 | Concurrency | Model tool calls executed serially; batched read-only parallel path is dead code |
| Medium | worker | `workers/ai-worker/src/handlers/companion-dialogue.ts` | 1122-1131 | DB-N+1 | TTS segments emitted one at a time, each with its own workspace transaction |
| Medium | worker | `workers/ai-worker/src/handlers/parse-source.ts` | 1287-1305 | Concurrency | External source images downloaded sequentially (network I/O per image) |
| Medium | worker | `workers/ai-worker/src/agent/tools/candidate-ledger.ts` | 253-416 | DB-N+1 | applyCandidateOperations performs per-operation sequential DB writes |
| Low | worker | `workers/ai-worker/src/learning-agent/orchestrator.ts` | 442-500 | DB-N+1 | Per-rubric-target serial LLM calls (author + critic, plus repair) |
| Low | worker | `workers/ai-worker/src/agent/verify.ts` | 367, 386 | Algorithmic | O(n^2) duplicate detection via indexOf on verdict id arrays |

## 详细描述
### 1. [Medium] Export keyset batching does not bound peak memory — full tables accumulated
- **文件**：`apps/api/src/modules/export/service.ts:128-137, 287-698`
- **类别**：Other
- **问题**：loadInBatches appends every row into out via out.push(...rows), so each table is fully resident in memory; exportWorkspace's Promise.all holds all tables simultaneously and returns them in one object. Peak memory is O(sum of all exported rows), so OOM risk persists (mitigated only by the 100k/table hard cap).
- **建议**：Stream/NDJSON the export page-batch-by-batch to the response, or serialize each table's batches incrementally instead of accumulating out; otherwise lower EXPORT_MAX_ROWS_PER_TABLE.
### 2. [Medium] reindexWorkspaceSearch builds unbounded in-memory documents array before batch insert
- **文件**：`apps/api/src/modules/search/service.ts:516-527, 578-648`
- **类别**：Other
- **问题**：evidenceRows is loaded with no row cap, and the documents array is fully materialized in memory before batched inserts inside a transaction that also holds the old index. On large workspaces this can build hundreds of thousands of objects at once, causing a memory spike and long transaction hold.
- **建议**：Stream projection inserts per entity type with a bounded per-insert window, and cap total evidence rows projected (mirror REINDEX_MAX_ROWS_PER_TABLE for derived evidence).
### 3. [Low] Unchunked inArray on versionIds/cardIds/blockAssetIds in delete paths
- **文件**：`apps/api/src/modules/note/service.ts:1221-1264, 1727-1746`
- **类别**：DB-unbounded-query
- **问题**：deleteNote/physicalDeleteNote use raw inArray on versionIds/cardIds/blockAssetIds without chunking. For heavily-edited notes these raw IN clauses can exceed postgres-js parameter limits or degrade.
- **建议**：Route through chunkedInArraySelect/chunkedInArrayDelete helpers or per-500 chunk the IN clauses.
### 4. [Low] Restore performs one UPDATE users per recovered user inside a loop
- **文件**：`apps/api/src/modules/export/service.ts:1134-1153`
- **类别**：DB-N+1
- **问题**：The restored-users phase issues a separate await tx.update(users).set({ personalWorkspaceId }) round-trip per recovered user. For many workspace members this becomes N sequential DB writes.
- **建议**：Collect (userId -> personalWorkspaceId) pairs and issue one multi-row UPDATE per 500-batch.
### 5. [Low] Unchunked inArray over all key points when loading evidence stats
- **文件**：`apps/api/src/modules/understanding/service.ts:136-144`
- **类别**：DB-unbounded-query
- **问题**：getUnderstandingStates loads evidences with inArray over allKeyPointIds without per-batch chunking and no per-key-point evidence cap.
- **建议**：Chunk keyPointIds and consider capping evidence rows per key point or using SQL-level aggregation.
### 6. [Medium] listReviews performs a long serial DB round-trip waterfall per request
- **文件**：`apps/api/src/modules/review/service.ts:188-427`
- **类别**：Other
- **问题**：After count + paginated findMany, the 8 hydration steps are awaited sequentially one after another with no Promise.all. This is the primary review queue hot path, so a request incurs 9+ serial RTTs.
- **建议**：Batch independent hydration queries into Promise.all groups once cardIds/keyPointIds are known.
### 7. [Medium] Review list allows deep offset pagination up to 100k and always runs a full count
- **文件**：`apps/api/src/modules/review/routes.ts:29`
- **类别**：DB-unbounded-query
- **问题**：reviewQuerySchema caps offset at 100_000 with no default window, and listReviews always runs count(*) plus an offset findMany. A client can force deep offset scans.
- **建议**：Replace offset pagination with keyset/cursor pagination, and/or lower the offset cap; consider skipping total count when not needed.
### 8. [Medium] Consumable-card predicate is a 4-branch OR of correlated EXISTS subqueries applied per review row
- **文件**：`apps/api/src/modules/review/consumer-eligibility.ts:8-105`
- **类别**：DB-N+1
- **问题**：The predicate is embedded in both count and findMany of listReviews; for every review row the planner evaluates up to four correlated EXISTS branches, multiplying per-row cost.
- **建议**：Push eligibility into a single set-based JOIN to consumable cards or a materialized active-card set; verify execution plan.
### 9. [Medium] SSE event stream polls the DB every 3s per connected client with no re-entrancy guard
- **文件**：`apps/api/src/modules/learning-runs/run-routes.ts:248-274`
- **类别**：Polling
- **问题**：Each SSE connection installs a 3s setInterval whose async callback opens a withWorkspaceTransaction and runs getEventsAfter. N clients produce N DB round-trips every 3s; a slow DB can cause overlapping intervals to pile up.
- **建议**：Add in-flight guard, backoff when no events, and/or share a single long-poll/keyset subscription per run.
### 10. [Medium] Fire-and-forget learning metrics writes have no backpressure
- **文件**：`apps/api/src/modules/learning-runs/run-routes.ts:397, 445`
- **类别**：Concurrency
- **问题**：submit and action handlers call void recordLearningMetric(...) after responding. Each call enqueues a DB write never awaited/tracked, so in-flight metric transactions are unbounded under high traffic.
- **建议**：Await the metric write or route through a bounded queue/outbox with concurrency cap and drop-on-overflow.
### 11. [Medium] Run processing tick executes Critic HTTP calls serially for every claimed command within one tick
- **文件**：`apps/api/src/modules/learning-runs/run-processing-tick.ts:96-163`
- **类别**：Concurrency
- **问题**：The while loop claims one command at a time and each assessment invokes a multi-second LLM HTTP call synchronously before next iteration, serializing k × LLM latency.
- **建议**：Process the transaction-free Critic calls with bounded concurrency (e.g. 2-3) per tick, or claim-per-command with concurrent HTTP calls.
### 12. [Medium] Commit outbox pre-claims 10 jobs serially then processes them serially, risking lease expiry
- **文件**：`apps/api/src/modules/learning-sessions/commit-outbox.ts:288-295`
- **类别**：Concurrency
- **问题**：runCommitOutboxTick claims up to 10 jobs before processing any; early claims have older leases, and if processing is slow their leases can expire before mark, allowing re-claim/re-execute.
- **建议**：Claim one job and process immediately, or re-check lease ownership before markProcessed.
### 13. [Low] Per-variant disclosure-profile existence SELECT inside the variant insert loop
- **文件**：`apps/api/src/modules/learning-runs/run-service.ts:880-899, 1312-1331`
- **类别**：DB-N+1
- **问题**：createRun/createRunV2 iterate over two variants and, inside each, perform a SELECT learningTaskDisclosureProfiles then a conditional INSERT, adding one extra DB round trip per variant on the PREPARE hot path.
- **建议**：Pre-load disclosure profiles for both variants in one IN (...) query before the loop, or use ON CONFLICT DO NOTHING with RETURNING.
### 14. [Low] Shadow reconciliation loads all workspace facts and all outbox rows into memory without LIMIT
- **文件**：`apps/api/src/modules/learning-runs/shadow-translator.ts:79-127`
- **类别**：DB-unbounded-query
- **问题**：runShadowReconciliation selects every covered assessment, every completed review attempt, and every canonical outbox row for the workspace with no LIMIT, materializing them all.
- **建议**：Stream/batch these reads (keyset/limit loops) or push intersection/conflict computation down into SQL.
### 15. [Low] Legacy backfill loads entire workspace episode/session/run/envelope sets into memory
- **文件**：`apps/api/src/modules/learning-runs/legacy-backfill.ts:131-242`
- **类别**：DB-unbounded-query
- **问题**：backfillLegacySessionsToRuns selects all episodes/runs/sessions and verifyLegacyRunReconciliation selects all canonical envelopes without LIMIT. One-off maintenance path but unbounded memory on large workspaces.
- **建议**：Process in bounded per-episode batches and use SQL-level EXISTS/counts.
### 16. [Low] Coverage matrix recomputes full-sample filters inside nested loops
- **文件**：`apps/api/src/modules/learning-sessions/gold-rounds.ts:401-447`
- **类别**：Algorithmic
- **问题**：buildCoverageMatrix repeatedly calls samples.filter(...) for every combination, scanning the full samples array inside nested iterations. Offline tooling on bounded dataset, but O(samples × output-buckets).
- **建议**：Build single-pass index Maps keyed by coverage dimensions and count from maps.
### 17. [Medium] Per-request O(n) Map sweep on every companion API call
- **文件**：`apps/api/src/modules/companion-conversation/companion-rate-limit.ts:25-65`
- **类别**：Algorithmic
- **问题**：companionRateLimit() calls lazySweep() on every request, iterating the whole buckets Map (up to 50k). Each companion request can walk tens of thousands of map entries.
- **建议**：Replace linear scan with a min-heap/priority queue or only run sweep when Date.now()-checkpoint > interval.
### 18. [Low] History search opens a second DB transaction to fetch conversation titles
- **文件**：`apps/api/src/modules/companion-conversation/assistant-session-routes.ts:131-143`
- **类别**：DB-N+1
- **问题**：The handler finishes its first withWorkspaceTransaction then opens a separate second transaction to batch-load conversation titles. This doubles transaction count and can see inconsistent titles.
- **建议**：Fetch conversation IDs inside the same transaction as the message search, sharing the tx and RLS snapshot.
### 19. [Medium] Companion export accumulates the entire NDJSON output in memory before writing
- **文件**：`apps/api/src/modules/companion-conversation/companion-export.ts:76-91, 380-387`
- **类别**：Memory-Leak
- **问题**：exportCompanionData collects every emitted line into the ndjson array (up to 300k lines) before the route writes them. Heavy users can hold hundreds of MB of serialized JSON.
- **建议**：Stream NDJSON lines to the socket as produced, or return an async iterator/generator flushing each page.
### 20. [Medium] exportCompanionUserData loads the full audit and ledger tables into memory with no cap
- **文件**：`apps/api/src/modules/companion-shell/audit-service.ts:744-795`
- **类别**：Memory-Leak
- **问题**：The export paginates in batches of 1000 but pushes every page into unbounded audit/ledger arrays, building the complete result body in memory with no row-count ceiling.
- **建议**：Add a maximum-rows guard and/or stream rows as paged, or return an async generator.
### 21. [Medium] deleteAllUserCompanionAuditAndLedger issues unbounded parallel transactions per workspace
- **文件**：`apps/api/src/modules/companion-shell/audit-service.ts:856-873`
- **类别**：Concurrency
- **问题**：The function uses Promise.all(workspaces.map(...)) to run a separate withWorkspaceTransaction for every workspace concurrently, with no concurrency cap.
- **建议**：Bound parallelism with a small worker pool (e.g. batches of 4-8) or a semaphore.
### 22. [Low] JSON.stringify(refs) comparison performed per event/pending-row
- **文件**：`apps/api/src/modules/companion-journey/journey-service.ts:534, 654`
- **类别**：Algorithmic
- **问题**：applyJourneyDomainEvent and drainPendingJourneyEvents compare refs changes via JSON.stringify(next.refs) !== JSON.stringify(state.refs), re-serializing in a loop over up to 50 pending events.
- **建议**：Replace with lightweight structural comparison or maintain a mutation counter/hash.
### 23. [Low] Run-completion proactive hook runs 4 independent queries serially
- **文件**：`apps/api/src/modules/companion-conversation/proactive-hook.ts:146-196`
- **类别**：DB-N+1
- **问题**：hookProactiveOnRunCompleted awaits account state, page context, delivery count, and last-shown delivery time sequentially even though they are independent.
- **建议**：Run the four read-only queries concurrently with Promise.all.
### 24. [Low] MemoryRateLimitStore.increment runs an O(n) lazySweep on every consume
- **文件**：`apps/api/src/modules/identity/rate-limit.ts:34-35, 53-57`
- **类别**：Algorithmic
- **问题**：The in-memory rate-limit store calls lazySweep() on every increment(), iterating the whole entries Map.
- **建议**：Use time-bucketed expiry queue or only sweep when now-lastSweepAt > windowMs.
### 25. [Medium] Unbounded initial/refresh fetch of all notes (no limit)
- **文件**：`apps/web/app/(workspace)/(default)/notes/page.tsx:123 (also 228, 260)`
- **类别**：DB-unbounded-query
- **问题**：Initial load calls api.listNotes({ trashed: ... }) with no limit, repeated after import/restore. This fetches the entire note collection in one request; loadMore correctly uses limit:50.
- **建议**：Pass limit:50 to every listNotes call and use nextCursor for additional pages.
### 26. [Medium] listLearningCardsV2() fetches all V2 cards with no pagination
- **文件**：`apps/web/app/(workspace)/(default)/cards/page.tsx:149 (api lib/api.ts:984-986)`
- **类别**：DB-unbounded-query
- **问题**：The cards index unconditionally calls api.listLearningCardsV2() and merges every returned item into the paginated V1 list. listLearningCardsV2 has no limit/cursor parameters.
- **建议**：Add limit/cursor pagination to /v2/cards endpoint and client method, then merge pages incrementally.
### 27. [Medium] Graph search re-runs JSON.stringify on every node for each keystroke
- **文件**：`apps/web/app/(workspace)/(default)/graph/page.tsx:703-716 (searchableText at 192-202)`
- **类别**：Algorithmic
- **问题**：searchResults useMemo filters over full rawGraph.nodes and calls searchableText(node) for every node, which includes JSON.stringify(node.metadata). Each deferred search keystroke does O(n) string builds over potentially thousands of nodes.
- **建议**：Precompute node.searchText map once per rawGraph and read from that map per keystroke.
### 28. [Low] Un-memoized O(n·m) filter(!includes) recomputed each render
- **文件**：`apps/web/features/learning-run/renderers/OrderingTask.tsx:25`
- **类别**：Algorithmic
- **问题**：const available = task.interaction.publicTokenIds.filter((id) => !orderedIds.includes(id)) runs on every render with no useMemo caching.
- **建议**：Wrap in useMemo and build a Set of orderedIds once.
### 29. [Low] selectedTokens.includes() inside map over token list per render
- **文件**：`apps/web/features/learning-run/renderers/StructuredBundleTask.tsx:159-160`
- **类别**：Algorithmic
- **问题**：selectedTokens.includes(tokenId) is evaluated inside .map over tokenIds, O(n·m) per render; same pattern repeats in ScenarioTask/ChoiceWithRationaleTask.
- **建议**：Derive a Set of selected ids once and use has() in the map.
### 30. [Low] getState() re-enumerates all displays + recomputes SHA-256 fingerprints on every call
- **文件**：`apps/desktop/src/windows/pet-window-state.ts:187-211`
- **类别**：IO-Blocking
- **问题**：getState() calls selectDisplay(), which calls getAllDisplays() and currentDisplayGeometry, computing SHA-256 per display. It also calls getContentBounds() on every invocation.
- **建议**：Cache display-geometry list and fingerprints, invalidate on display change events.
### 31. [Low] broadcastWindowState() runs zod parse + native display work on every state change
- **文件**：`apps/desktop/src/main.ts:160-168`
- **类别**：UI-Render
- **问题**：broadcastWindowState() executes schema.parse(petState.getState()) then sends over IPC. getState() triggers native getContentBounds()+getAllDisplays() on many IPC handlers.
- **建议**：Memoize parsed state at controller level or debounce broadcast; reuse cached display geometry list.
### 32. [Low] Bridge context lease sweep iterates the whole records Map every 30s
- **文件**：`apps/desktop/src/ipc/companion-bridge-ipc.ts:280-281`
- **类别**：Polling
- **问题**：sweepExpiredRecords() performs full O(n) iteration over records Map every 30s via setInterval. Minor today, but scales with concurrent page contexts.
- **建议**：Keep records in an ordered structure keyed by expiresAt or scan lazily when handling events.
### 33. [Low] selectDisplay/displayContainingWindow perform repeated linear finds over display list
- **文件**：`apps/desktop/src/windows/pet-window-state.ts:219-257`
- **类别**：Cache
- **问题**：selectDisplay chains multiple all.find() scans, and displayContainingWindow may scan again to pick max overlap, on every getState()/setWindowPosition/savePosition path.
- **建议**：Cache resolved display selection keyed by displayId/fingerprint and invalidate on display change events.
### 34. [High] reconcileStuckSupervisors does 5 sequential DB round-trips per waiting_child parent
- **文件**：`workers/ai-worker/src/agent/specialist-persist.ts:1243-1297`
- **类别**：DB-N+1
- **问题**：The loop over waitingParents performs children SELECT, active-job SELECT, CAS UPDATE, enqueue, and second UPDATE per parent, called on child-agent completion and 60s reconciler timer.
- **建议**：Batch per-parent work: load all children + active jobs in two IN-batched queries, filter in memory, then enqueue all resume jobs and do a single CAS UPDATE.
### 35. [Medium] createNextTurnJob runs a full workspace transaction per created unit
- **文件**：`workers/ai-worker/src/agent/plan-path.ts:209-210, 369`
- **类别**：DB-N+1
- **问题**：Both planned-path creation and replan paths iterate over created unitIds and await createNextTurnJob serially, each opening a withWorkerWorkspaceTransaction with SELECT + conditional UPDATE/INSERT.
- **建议**：Batch the job-enqueue step: collect all (runId, unitId, turnNo) triples and enqueue in one multi-row call.
### 36. [Medium] resumeStuckWaitingParents enqueues resume jobs one DB call per parent
- **文件**：`workers/ai-worker/src/agent/reconciler.ts:222-275`
- **类别**：DB-N+1
- **问题**：Children are batch-loaded, but the final per-parent loop calls db.execute(ailearn_enqueue_agent_turn_job(...)) once per resumed parent.
- **建议**：Enqueue all resume jobs in a single batched statement or reuse one workspace transaction/connection.
### 37. [Medium] O(candidates × bundles) lookup via Object.values().some() inside per-candidate loop
- **文件**：`workers/ai-worker/src/agent/compose-consistency.ts:47-60`
- **类别**：Algorithmic
- **问题**：For every candidate ID, Object.values(input.bundleCandidates).some((s) => s.has(cid)) scans all bundle candidate sets, giving O(candidates × bundles).
- **建议**：Build a single global allCandidateIds Set once and use has(cid).
### 38. [Medium] Model tool calls executed serially; batched read-only parallel path is dead code
- **文件**：`workers/ai-worker/src/agent/run-phase-executor.ts:973-990`
- **类别**：Concurrency
- **问题**：The agent turn loop calls executeToolCall one tool call at a time. The parallel executeToolCalls path is never referenced by production callers.
- **建议**：Route model tool calls through executeToolCalls, which parallelizes read-only tools with error isolation.
### 39. [Medium] TTS segments emitted one at a time, each with its own workspace transaction
- **文件**：`workers/ai-worker/src/handlers/companion-dialogue.ts:1122-1131`
- **类别**：DB-N+1
- **问题**：emitSegments loops over segs and awaits emitCompanionTtsSegment per segment, each opening a withWorkerWorkspaceTransaction with UPDATE + INSERT + NOTIFY.
- **建议**：Batch segments: allocate consecutive event seqs in one UPDATE and insert all voice.segment.ready rows in a single multi-row INSERT + one NOTIFY.
### 40. [Medium] External source images downloaded sequentially (network I/O per image)
- **文件**：`workers/ai-worker/src/handlers/parse-source.ts:1287-1305`
- **类别**：Concurrency
- **问题**：The loop over externalImages awaits downloadAndUploadImage serially for every unique external image, inflating parse_source runtime.
- **建议**：Fetch unique images with bounded parallelism (e.g. concurrency cap ~4) while deduping by URL and preserving abort propagation.
### 41. [Medium] applyCandidateOperations performs per-operation sequential DB writes
- **文件**：`workers/ai-worker/src/agent/tools/candidate-ledger.ts:253-416`
- **类别**：DB-N+1
- **问题**：For each operation the loop runs 1-3 awaited DB statements; a batch of many ledger ops yields many sequential round-trips.
- **建议**：Accumulate all DB effects for the whole batch and flush as one multi-row INSERT + one batched UPDATE.
### 42. [Low] Per-rubric-target serial LLM calls (author + critic, plus repair)
- **文件**：`workers/ai-worker/src/learning-agent/orchestrator.ts:442-500`
- **类别**：DB-N+1
- **问题**：The loop over rubricTargets awaits proposeSceneDraft then reviewScene (and repair) serially per target, making 2-4 sequential model requests per item.
- **建议**：If targets are independent, run them with bounded concurrency; at minimum cap the number of targets.
### 43. [Low] O(n^2) duplicate detection via indexOf on verdict id arrays
- **文件**：`workers/ai-worker/src/agent/verify.ts:367, 386`
- **类别**：Algorithmic
- **问题**：verdictIds.filter((id, i) => verdictIds.indexOf(id) !== i) and arr.indexOf(id) !== i are O(n^2) duplicate scans.
- **建议**：Replace with a single-pass Set to collect duplicates in O(n).
## 修复记录（第四轮，2026-08-16）

- ✅ **已修复：39 项**
- 🟡 **部分修复：1 项**（#41 `candidate-ledger.ts` 已修复 adjust_support 子路径，整批 DB 效果冲刷因会破坏 ledger CAS/哈希顺序而暂缓）
- ⏭️ **保留未改：3 项**，原因如下：

| # | 文件 | 行 | 问题 | 保留原因 |
|---|---|---|---|---|
| 11 | `apps/api/src/modules/learning-runs/run-processing-tick.ts` | 96-163 | Critic HTTP 串行 | 当前 claim-per-command 串行是有意设计，防止批领取后租约过期/重复执行；并行化需要重做领取与租约语义，属正确性关键路径 |
| 14 | `apps/api/src/modules/learning-runs/shadow-translator.ts` | 79-127 | Shadow reconciliation 全量内存 | 必须持有全量 canonical-id 集合以证明无双写，键集流式不能降低主导内存；下推 SQL 风险高，属离线只读诊断 |
| 42 | `workers/ai-worker/src/learning-agent/orchestrator.ts` | 442-500 | 每个 rubric target 串行 LLM | target 间有确定性顺序与 probe sequence 编号依赖，并行会破坏审计/哈希顺序，属正确性约束 |

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
- ✅ `workers/ai-worker` 测试：1086 pass / 0 fail
