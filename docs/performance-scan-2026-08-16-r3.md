# 项目性能问题扫描报告（第三轮，含 Worker）
> 扫描时间：2026-08-16（第三轮）
> 扫描范围：`apps/api`、`apps/web`、`apps/desktop`、`packages/*`、**`workers/ai-worker`** 生产代码（排除测试、构建产物、迁移、node_modules）。
> 说明：本轮在第一、二轮修复后重新扫描，并首次将 **worker 相关代码**纳入正式扫描范围。

共发现 **31** 项性能风险。

| 严重度 | 数量 |
|---|---|
| High | 4 |
| Medium | 13 |
| Low | 14 |

| 分区 | 数量 |
|---|---|
| api-core | 2 |
| api-companion-other | 4 |
| web-frontend | 6 |
| desktop-shared-ai | 6 |
| worker | 13 |

## 完整发现清单
| 严重度 | 分区 | 文件 | 行 | 类别 | 问题 |
|---|---|---|---|---|---|
| Medium | api-core | `apps/api/src/modules/search/service.ts` | 871-919, 1061-1064 | DB-unbounded-query | detectSearchDrift reads the entire search_documents index without a cap |
| Low | api-core | `apps/api/src/modules/understanding/service.ts` | 334-350 | Memory-Leak | understandingStatesCache is an unbounded in-process Map |
| Medium | api-companion-other | `apps/api/src/modules/companion-conversation/inbox-routes.ts` | 109-132 | Polling | Inbox SSE is pure polling with no NOTIFY wake; every open connection issues a DB transaction every 3s |
| Low | api-companion-other | `apps/api/src/modules/companion-conversation/companion-events.ts` | 305-346, 365-367 | Polling | SSE durable poll opens a full workspace transaction per tick even when idle |
| Low | api-companion-other | `apps/api/src/modules/companion-conversation/companion-export.ts` | 265-401 | Other | Export materializes the full NDJSON array in memory before hashing/streaming |
| Low | api-companion-other | `apps/api/src/modules/companion-shell/security-audit.ts` | 607-628 | Algorithmic | checkCrossWorkspaceRefReuse is O(activeRefs × previouslyIssuedRefKeys) |
| Medium | web-frontend | `apps/web/features/companion-pet/conversation/fetch-sse.ts` | 58-114 | Algorithmic | SSE chunk parser performs O(n^2) string copies/encodes over accumulated buffer |
| Medium | web-frontend | `apps/web/features/learning-run/api/sse.ts` | 86-98 | Algorithmic | Learning-run SSE reader re-splits and re-joins the whole buffer every chunk |
| Medium | web-frontend | `apps/web/features/companion-pet/conversation/useCompanionConversations.ts` | 60-66 | Algorithmic | Streaming assistant delta flush rebuilds full message text and message array every flush |
| Low | web-frontend | `apps/web/lib/api.ts` | 564-575 | Cache | GET cache eviction sweeps entire map on every cache write |
| Low | web-frontend | `apps/web/components/note-editor/useImageUploads.ts` | 88-100 | UI-Render | Upload progress handler re-filters and re-maps the entire upload list per progress tick |
| Low | web-frontend | `apps/web/components/NoteEditor.tsx` | 635-662 | UI-Render | Preview heading tracking queries DOM and reads layout for every heading on each scroll frame |
| Medium | desktop-shared-ai | `packages/ai-quality/src/card-generation-supervisor-v1/rc-runner.ts` | 377-500 | Concurrency | Shared mutable budget counter races across concurrent sample workers |
| Medium | desktop-shared-ai | `apps/desktop/src/main.ts` | 665-669 | IO-Blocking | Synchronous file read+JSON.parse on every pet-mode IPC call blocks main event loop |
| Low | desktop-shared-ai | `packages/ai-quality/src/card-generation-supervisor-v1/../../packages/ai-quality/src/cli/supervisor-rc-gate.ts` | 520-531 | Timer-Leak | Polling loop accumulates abort listeners on every 3s iteration |
| Low | desktop-shared-ai | `packages/ai-quality/src/card-generation-v2/semantic-judge.ts` | 107-133 | Algorithmic | normalize() recomputed per-needle inside candidate loop |
| Low | desktop-shared-ai | `packages/ai-quality/src/card-generation-v2/rc-gate.ts` | 118 | Algorithmic | Nested includes for zero-card precision/recall left un-indexed |
| Low | desktop-shared-ai | `apps/desktop/src/main.ts` | 1017-1020 | Memory-Leak | Process signal/exception listeners re-registered on each before-quit |
| High | worker | `workers/ai-worker/src/agent/specialist-persist.ts` | 424-562 | DB-N+1 | persistExtractionResults performs per-candidate + per-evidence sequential DB inserts |
| High | worker | `workers/ai-worker/src/handlers/card-generation-v2-handler.ts` | 827-853 | DB-N+1 | V2 pipeline inserts each authored candidate with its own transaction round-trip |
| High | worker | `workers/ai-worker/src/agent/reconciler.ts` | 209-275 | DB-N+1 | resumeStuckWaitingParents issues 3-4 DB queries per waiting parent in a loop |
| High | worker | `workers/ai-worker/src/agent/tools/candidate-ledger.ts` | 144-171, 247-411 | DB-N+1 | apply_candidate_operations issues per-ref and per-candidate DB writes in loops |
| Medium | worker | `workers/ai-worker/src/handlers/card-generation-v2-handler.ts` | 908-1137 | DB-N+1 | critiqueAndFinalizeCandidates performs per-candidate DB updates and per-event inserts in loops |
| Medium | worker | `workers/ai-worker/src/agent/specialist-persist.ts` | 580-616 | DB-N+1 | Per-bundle decision-status updates run as one DB round-trip per bundle |
| Medium | worker | `workers/ai-worker/src/agent/tools/manifest.ts` | 168-181 | DB-N+1 | get_next_unassigned_bundles marks bundles assigned with one UPDATE per bundle |
| Medium | worker | `workers/ai-worker/src/agent/specialist-persist.ts` | 721-866 | DB-N+1 | persistRepairPatches runs a DB update per patch and a findIndex per patch |
| Medium | worker | `workers/ai-worker/src/agent/fast-to-planned.ts` | 53-68 | Algorithmic | Fast-artifact bundle attribution dedups evidenceRefIds with includes() inside nested loop |
| Medium | worker | `workers/ai-worker/src/handlers/parse-source.ts` | 512-536, 672-681 | Algorithmic | removeElementsByClass reconstructs the whole HTML string per match, called for dozens of patterns |
| Low | worker | `workers/ai-worker/src/agent/tools/deck-draft.ts` | 322-409 | Algorithmic | apply_draft_patch uses cards.findIndex inside the operations loop |
| Low | worker | `workers/ai-worker/src/handlers/companion-dialogue.ts` | 1307-1354 | DB-N+1 | writeBatchedDeltas fallback runs a full transaction per delta chunk |
| Low | worker | `workers/ai-worker/src/agent/unit-artifact-cache.ts` | 61-84 | Memory-Leak | createMemoryArtifactCache defaults to an unbounded Map when maxSize is omitted |

## 详细描述
### 1. [Medium] detectSearchDrift reads the entire search_documents index without a cap
- **文件**：`apps/api/src/modules/search/service.ts:871-919, 1061-1064`
- **类别**：DB-unbounded-query
- **问题**：In detectSearchDrift, every domain table read is bounded with limit: REINDEX_MAX_ROWS_PER_TABLE, but the corresponding search_documents index reads have no LIMIT at all. The evidence index in particular can be much larger than the 50k domain cap, so a large workspace makes this load all docs into JS memory and can OOM or block the event loop.
- **建议**：Add the same deterministic limit + orderBy to the five search_documents reads so drift analysis stays bounded; treat capped index side as known truncation.
### 2. [Low] understandingStatesCache is an unbounded in-process Map
- **文件**：`apps/api/src/modules/understanding/service.ts:334-350`
- **类别**：Memory-Leak
- **问题**：understandingStatesCache is a module-level Map only cleaned by sweepUnderstandingCache, which removes merely expired entries and is throttled to once per TTL. There is no hard max-size cap, so under a burst of distinct keys it can grow temporarily unbounded and hold full UnderstandingState[] arrays.
- **建议**：Bound the map on write (evict oldest/last-inserted when size exceeds a cap) and expose a max-size constant.
### 3. [Medium] Inbox SSE is pure polling with no NOTIFY wake; every open connection issues a DB transaction every 3s
- **文件**：`apps/api/src/modules/companion-conversation/inbox-routes.ts:109-132`
- **类别**：Polling
- **问题**：GET /companion/deliveries/inbox/stream starts a setInterval that calls listInbox inside withWorkspaceTransaction every 3000ms for the lifetime of the connection. There is no LISTEN/NOTIFY subscription, so each open connection opens a fresh transaction every 3s even with zero new deliveries.
- **建议**：Subscribe to LISTEN/NOTIFY so the poll fires only after a NOTIFY or on a slower heartbeat; or batch multiple users' inbox windows into a shared poller.
### 4. [Low] SSE durable poll opens a full workspace transaction per tick even when idle
- **文件**：`apps/api/src/modules/companion-conversation/companion-events.ts:305-346, 365-367`
- **类别**：Polling
- **问题**：pump() wraps each tick in withWorkspaceTransaction, i.e. one RLS set_config round-trip plus a SELECT every 2.5s per open connection. Although NOTIFY is the primary wake path, the per-tick transaction setup creates steady baseline load proportional to open SSE connections.
- **建议**：Rate-limit the poll only to ticks where a NOTIFY was missed, or reuse a process-level heartbeat that amortizes RLS context setup across connections.
### 5. [Low] Export materializes the full NDJSON array in memory before hashing/streaming
- **文件**：`apps/api/src/modules/companion-conversation/companion-export.ts:265-401`
- **类别**：Other
- **问题**：exportCompanionData builds the entire ndjson string array in memory before hashing and returning it as one response. It is capped at 50k rows per type, but a history-heavy export still holds up to ~2x the row volume on the event loop.
- **建议**：Stream the NDJSON incrementally as rows are paged in and maintain the SHA-256 hasher incrementally, bounding peak memory to one page.
### 6. [Low] checkCrossWorkspaceRefReuse is O(activeRefs × previouslyIssuedRefKeys)
- **文件**：`apps/api/src/modules/companion-shell/security-audit.ts:607-628`
- **类别**：Algorithmic
- **问题**：For each active ref, the inner loop linearly scans all previouslyIssuedRefKeys, even though the code already maintains a seen Map for the same-workspace check.
- **建议**：Build a Map<key, workspaceId[]> from previouslyIssuedRefKeys once, then do O(1) lookup per active ref.
### 7. [Medium] SSE chunk parser performs O(n^2) string copies/encodes over accumulated buffer
- **文件**：`apps/web/features/companion-pet/conversation/fetch-sse.ts:58-114`
- **类别**：Algorithmic
- **问题**：parseCompanionSseChunk operates on combined = buffer + chunk; for every line it calls slice/encode over the whole buffer, so a long companion chat stream degrades quadratically and creates per-line garbage.
- **建议**：Track line boundaries with offsets/indices instead of repeatedly slicing the whole buffer, and compute wire-byte size incrementally.
### 8. [Medium] Learning-run SSE reader re-splits and re-joins the whole buffer every chunk
- **文件**：`apps/web/features/learning-run/api/sse.ts:86-98`
- **类别**：Algorithmic
- **问题**：Inside the read loop, buffer += decoder.decode(...) then buffer.split(/\n\n/), .pop(), and lines.join re-stringifies all complete events, which parseSseChunk then splits again. Every read chunk re-processes every previously received event.
- **建议**：Use an incremental parser that consumes only newly appended bytes and carries the incomplete tail as a separate buffer.
### 9. [Medium] Streaming assistant delta flush rebuilds full message text and message array every flush
- **文件**：`apps/web/features/companion-pet/conversation/useCompanionConversations.ts:60-66`
- **类别**：Algorithmic
- **问题**：flushPendingDeltas appends each delta by calling textFromBlocks(item.blocks) and creating a brand-new text, then next = next.map(...) recreates the whole message array per pending run. Cumulatively this is O(n^2) in reply length.
- **建议**：Maintain the streaming message's raw text in a ref and update by index instead of map-rebuilding the entire messages array.
### 10. [Low] GET cache eviction sweeps entire map on every cache write
- **文件**：`apps/web/lib/api.ts:564-575`
- **类别**：Cache
- **问题**：cacheSetGet iterates every entry of requestGetCache on each write to prune expired entries. With REQUEST_CACHE_MAX_ENTRIES=200 this is O(cache size) per write, O(n^2) across a burst of unique GETs.
- **建议**：Prune lazily or amortize: only sweep when the map crosses a size threshold, or use an insertion-ordered queue.
### 11. [Low] Upload progress handler re-filters and re-maps the entire upload list per progress tick
- **文件**：`apps/web/components/note-editor/useImageUploads.ts:88-100`
- **类别**：UI-Render
- **问题**：syncImageUploadState runs on every upload onProgress callback: it Array.from all tasks, filters for pending count, maps every task into fresh view objects and setState. Each progress event rebuilds the whole upload list.
- **建议**：Throttle progress-to-React updates and/or keep view objects stable so unchanged tasks retain identity.
### 12. [Low] Preview heading tracking queries DOM and reads layout for every heading on each scroll frame
- **文件**：`apps/web/components/NoteEditor.tsx:635-662`
- **类别**：UI-Render
- **问题**：updateActiveHeading runs on every scroll/resize event; it does querySelectorAll for all h1-h6 and getBoundingClientRect on each heading per frame.
- **建议**：Debounce/coalesce scroll updates, cache heading offsets once on content change, or use IntersectionObserver.
### 13. [Medium] Shared mutable budget counter races across concurrent sample workers
- **文件**：`packages/ai-quality/src/card-generation-supervisor-v1/rc-runner.ts:377-500`
- **类别**：Concurrency
- **问题**：costUsd and totalDurationMs are captured at the closure top and mutated by up to 3 concurrent runSample workers. Several workers can pass the cap check before any commits cost, overshooting by up to concurrency × one sample's cost.
- **建议**：Reserve budget before launching a concurrent sample or enforce the budget atomically with a mutex around check+reserve.
### 14. [Medium] Synchronous file read+JSON.parse on every pet-mode IPC call blocks main event loop
- **文件**：`apps/desktop/src/main.ts:665-669`
- **类别**：IO-Blocking
- **问题**：The desktopGetPetMode IPC handler calls getPetModeEnabled(), which invokes loadDevicePetPreferences() (readFileSync + JSON.parse) synchronously on the Electron main process each time the renderer queries the setting.
- **建议**：Reuse the cached petModeEnabled value for getPetModeEnabled; invalidate via persistPetMode.
### 15. [Low] Polling loop accumulates abort listeners on every 3s iteration
- **文件**：`packages/ai-quality/src/card-generation-supervisor-v1/../../packages/ai-quality/src/cli/supervisor-rc-gate.ts:520-531`
- **类别**：Timer-Leak
- **问题**：pollRunUntilTerminal registers a new signal.addEventListener('abort', ..., { once: true }) on each poll iteration but never removes it when the iteration completes. A long run leaves 100 listeners attached to the shared AbortSignal.
- **建议**：Register a single abort listener per call that clears any pending timer and resolves, or remove it via removeEventListener in the timer callback.
### 16. [Low] normalize() recomputed per-needle inside candidate loop
- **文件**：`packages/ai-quality/src/card-generation-v2/semantic-judge.ts:107-133`
- **类别**：Algorithmic
- **问题**：line 115 recomputes normalizeJudge(c.frontPrompt) inside leakedNeedles.some(...) for every leaked needle on every candidate; line 112 does full normSource.includes(normStmt) substring scan per candidate.
- **建议**：Pre-normalize each candidate's frontPrompt/frontCue once into the loop and reuse across all needles.
### 17. [Low] Nested includes for zero-card precision/recall left un-indexed
- **文件**：`packages/ai-quality/src/card-generation-v2/rc-gate.ts:118`
- **类别**：Algorithmic
- **问题**：Line 118 computes truePositive via input.zeroCardPredictedIds.filter((id) => input.zeroCardFixtureIds.includes(id)), an O(predicted × gold) contains-check.
- **建议**：Build a Set from zeroCardFixtureIds once and use Set.has() in the filter.
### 18. [Low] Process signal/exception listeners re-registered on each before-quit
- **文件**：`apps/desktop/src/main.ts:1017-1020`
- **类别**：Memory-Leak
- **问题**：Lines 1017-1020 register process.on(SIGTERM/SIGINT/uncaughtException/unhandledRejection) inside the before-quit handler before the shuttingDown guard. Every before-quit invocation appends four more permanent listeners.
- **建议**：Register these diagnostic handlers once at module load, or guard with a module-level boolean.
### 19. [High] persistExtractionResults performs per-candidate + per-evidence sequential DB inserts
- **文件**：`workers/ai-worker/src/agent/specialist-persist.ts:424-562`
- **类别**：DB-N+1
- **问题**：The extraction persistence loop inserts one candidate then, for each candidate, loops over validEvidenceRefs inserting one card_generationCandidateEvidence row at a time. For N candidates × M evidence refs this is O(N×M) sequential DB round-trips.
- **建议**：Batch INSERT all candidates and all evidence rows with multi-row VALUES, and drop the per-row fallback SELECT by using onConflictDoNothing().returning().
### 20. [High] V2 pipeline inserts each authored candidate with its own transaction round-trip
- **文件**：`workers/ai-worker/src/handlers/card-generation-v2-handler.ts:827-853`
- **类别**：DB-N+1
- **问题**：processCardGenerationPlan loops over candidates and issues one INSERT plus one insertEvent per candidate inside the long-running run transaction. With many candidates this adds N sequential DB round-trips.
- **建议**：Batch the candidate INSERTs with multi-row VALUES and batch the insertEvent writes into a single multi-row INSERT per run.
### 21. [High] resumeStuckWaitingParents issues 3-4 DB queries per waiting parent in a loop
- **文件**：`workers/ai-worker/src/agent/reconciler.ts:209-275`
- **类别**：DB-N+1
- **问题**：For each waiting_child parent, the loop performs a children SELECT, an update CAS, and an enqueue call, all sequentially awaited. A reconciler run touching many parents yields N×3+ sequential round-trips every 60s.
- **建议**：Batch-load all children of the waiting parents in one query, resolve resumable parents in memory, and run CAS/enqueue as bulk statements.
### 22. [High] apply_candidate_operations issues per-ref and per-candidate DB writes in loops
- **文件**：`workers/ai-worker/src/agent/tools/candidate-ledger.ts:144-171, 247-411`
- **类别**：DB-N+1
- **问题**：persistEvidenceRefs inserts one row per refId, and the operations loop runs per-candidate UPDATE/DELETE/INSERT round-trips for merge/split/restore/etc. A single tool call with many operations generates unbounded sequential DB round-trips.
- **建议**：Accumulate all evidence rows and candidate mutations and flush with multi-row INSERT / single UPDATE with IN (...) per mutation type.
### 23. [Medium] critiqueAndFinalizeCandidates performs per-candidate DB updates and per-event inserts in loops
- **文件**：`workers/ai-worker/src/handlers/card-generation-v2-handler.ts:908-1137`
- **类别**：DB-N+1
- **问题**：The per-candidate critic loop updates the candidate row and inserts an event one at a time; quality reports and pedagogy events are each inserted in separate loops.
- **建议**：Batch per-candidate status updates with a single UPDATE ... WHERE candidate_revision_id = ANY(...), and write all quality reports/events with multi-row inserts.
### 24. [Medium] Per-bundle decision-status updates run as one DB round-trip per bundle
- **文件**：`workers/ai-worker/src/agent/specialist-persist.ts:580-616`
- **类别**：DB-N+1
- **问题**：The noCandidates loop and assignedBundleIds loop each run a separate db.update per bundle. For a run with many bundles this is N sequential updates.
- **建议**：Collapse both loops into one bulk UPDATE that sets decisionStatus/candidateCount per bundleKey with a CASE or VALUES-jointed update.
### 25. [Medium] get_next_unassigned_bundles marks bundles assigned with one UPDATE per bundle
- **文件**：`workers/ai-worker/src/agent/tools/manifest.ts:168-181`
- **类别**：DB-N+1
- **问题**：The assignment transaction loops over unassigned bundles and runs a separate tx.update per bundle.
- **建议**：Replace the loop with a single UPDATE ... WHERE id = ANY(unassignedIds) AND assignmentStatus = 'pending'.
### 26. [Medium] persistRepairPatches runs a DB update per patch and a findIndex per patch
- **文件**：`workers/ai-worker/src/agent/specialist-persist.ts:721-866`
- **类别**：DB-N+1
- **问题**：The patch loop performs a db.update for rewrite_claim patches and a cards.findIndex per patch, so repair patches generate N sequential DB writes plus O(patches × cards) array scans.
- **建议**：Batch the rewrite_claim updates with a single UPDATE ... WHERE id = ANY(...) using a VALUES map, and pre-index cards by draftCardId/localId.
### 27. [Medium] Fast-artifact bundle attribution dedups evidenceRefIds with includes() inside nested loop
- **文件**：`workers/ai-worker/src/agent/fast-to-planned.ts:53-68`
- **类别**：Algorithmic
- **问题**：For each candidate matched to a bucket, bucket.evidenceRefIds.filter((r) => !bucket.evidenceRefIds.includes(r)) is O(m) per ref, nested inside the bundle task loop and candidate loop.
- **建议**：Maintain a Set<string> per bucket for seen evidence refs and only push refs not already in the Set.
### 28. [Medium] removeElementsByClass reconstructs the whole HTML string per match, called for dozens of patterns
- **文件**：`workers/ai-worker/src/handlers/parse-source.ts:512-536, 672-681`
- **类别**：Algorithmic
- **问题**：Each call scans the whole HTML and, per matched element, rebuilds the string via slice concatenation. It is called once per noise/class pattern, so a large page is re-scanned and re-allocated ~40+ times.
- **建议**：Collect match ranges first, then perform a single pass reconstruction; pre-compile per-pattern regexes.
### 29. [Low] apply_draft_patch uses cards.findIndex inside the operations loop
- **文件**：`workers/ai-worker/src/agent/tools/deck-draft.ts:322-409`
- **类别**：Algorithmic
- **问题**：Each patch operation calls cards.findIndex inside the operations loop, giving O(ops × cards).
- **建议**：Build a Map from draftCardId/localId -> card index once before the loop and reuse it.
### 30. [Low] writeBatchedDeltas fallback runs a full transaction per delta chunk
- **文件**：`workers/ai-worker/src/handlers/companion-dialogue.ts:1307-1354`
- **类别**：DB-N+1
- **问题**：The fallback non-streaming path loops over every 256-unit delta chunk and opens a withWorkerWorkspaceTransaction with 4 SQL statements per chunk, then sleeps 50ms.
- **建议**：Reduce per-chunk transaction overhead by batching several chunks per transaction while keeping the throttling via a single sleep between batches.
### 31. [Low] createMemoryArtifactCache defaults to an unbounded Map when maxSize is omitted
- **文件**：`workers/ai-worker/src/agent/unit-artifact-cache.ts:61-84`
- **类别**：Memory-Leak
- **问题**：The cache only evicts when maxSize is provided, and callers that omit it get a Map that grows indefinitely per process. Keys include runId so long-running workers accumulate entries.
- **建议**：Make a bounded cache the default (e.g. maxSize 1024) so every ArtifactCache instance has a hard eviction bound.
## 修复记录（第三轮，2026-08-16）

- ✅ **已修复：30 项**
- ⏭️ **保留未改：1 项**，原因如下：

| # | 文件 | 行 | 问题 | 保留原因 |
|---|---|---|---|---|
| 4 | `apps/api/src/modules/companion-conversation/companion-events.ts` | 305-346, 365-367 | SSE durable poll 每 tick 打开完整 workspace 事务 | 当前 2.5s poll 实际是主事件投递机制，NOTIFY 只在部分写路径发出；若只改 companion-events.ts 无法安全降频，完整修复需要跨多个写路径统一接入 NOTIFY，属于架构级改动，单独修改会引入事件延迟/正确性风险 |

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
