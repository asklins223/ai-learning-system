# 项目性能问题扫描报告（第二轮）
> 扫描时间：2026-08-16（第二轮）
> 扫描范围：`apps/api`、`apps/web`、`apps/desktop`、`packages/shared`、`packages/db`、`packages/ai-quality` 生产代码（排除测试、构建产物、迁移、node_modules）。
> 说明：本轮在第一轮修复后重新扫描，重点记录**当前仍存在或新发现**的性能风险。

共发现 **49** 项性能风险。

| 严重度 | 数量 |
|---|---|
| High | 1 |
| Medium | 26 |
| Low | 22 |

## 完整发现清单
| 严重度 | 分区 | 文件 | 行 | 类别 | 问题 |
|---|---|---|---|---|---|
| Medium | api-core | `apps/api/src/modules/note/service.ts` | 467-469 | DB-N+1 | Sequential per-row UPDATE of changed note blocks on the autosave path |
| Medium | api-core | `apps/api/src/modules/understanding/projection-routes.ts` | 400 | Algorithmic | O(n²) filter+includes over up to 5000 cards on sourceId-filtered star map |
| Medium | api-core | `apps/api/src/modules/import/routes.ts` | 295-308 | DB-unbounded-query | Import dedup query loads every version + full jsonb under an importId without LIMIT |
| Low | api-core | `apps/api/src/modules/source/service.ts` | 469-481 | DB-unbounded-query | createNoteFromSource dedup query has no LIMIT over all notes of a source |
| Low | api-core | `apps/api/src/modules/validation/session-service.ts` | 2564-2565 | Algorithmic | assessments.find inside rubricItems.map is O(n²) |
| Medium | api-learning | `apps/api/src/modules/learning-runs/run-service.ts` | 2260-2274 | DB-N+1 | Per-evidence SELECT FOR UPDATE inside loop in submitArtifact revalidation |
| Low | api-learning | `apps/api/src/modules/learning-runs/run-processing-tick.ts` | 1258-1276 | DB-N+1 | Sequential insertDomainEvent inside completedReminders loop |
| Low | api-learning | `apps/api/src/modules/learning-runs/run-service.ts` | 923-933 | DB-N+1 | Fixed 4-event array inserted one row per await |
| Low | api-learning | `apps/api/src/modules/learning-sessions/canonical-events.ts` | 771-783 | Algorithmic | O(n^2) full-copy projection replay in replayProjection |
| Low | api-learning | `apps/api/src/modules/learning-sessions/star-map-projections.ts` | 587-599 | Algorithmic | O(n^2) full-copy personal-plane replay (replayPersonalPlane) |
| Low | api-learning | `apps/api/src/modules/learning-sessions/session-service.ts` | 1759-1763, 1795-1799 | Algorithmic | O(n^2) array .includes in endSession/cancelSession episode status update |
| Medium | api-companion-other | `apps/api/src/modules/companion-conversation/assistant-session-routes.ts` | 105-134 | DB-unbounded-query | History search performs unbounded scanning of companion_messages.blocks with ILIKE '%q%' |
| Medium | api-companion-other | `apps/api/src/modules/companion-conversation/proactive-hook.ts` | 165-190 | IO-Blocking | External LLM network call awaited inside a DB transaction in run-completed hook |
| Medium | api-companion-other | `apps/api/src/modules/companion-conversation/inbox-routes.ts` | 105-132 | Concurrency | Inbox SSE polling setInterval has no in-flight guard causing overlapping DB queries |
| Medium | api-companion-other | `apps/api/src/modules/companion-conversation/companion-conversations-service.ts` | 222-418 | Concurrency | Companion conversation snapshot executes independent DB reads sequentially |
| Low | api-companion-other | `apps/api/src/modules/companion-bridge/routes.ts` | 55-125 | Other | Companion bridge publish/renew/revoke endpoints have no rate limiting |
| Low | api-companion-other | `apps/api/src/modules/companion-conversation/learning-action-bridge.ts` | 82-201 | Concurrency | resolveCompanionLearningContext runs four independent root queries sequentially |
| Low | api-companion-other | `apps/api/src/scripts/backfill-projection-outbox.ts` | 24-33 | DB-unbounded-query | Projection backfill script loads entire pending outbox into memory without limit |
| Medium | web-frontend | `apps/web/app/(workspace)/(default)/page.tsx` | 96 | DB-unbounded-query | Home page fetches entire pending-review list but only renders 3 |
| Medium | web-frontend | `apps/web/app/(workspace)/(default)/graph/page.tsx` | 756-760 | Algorithmic | O(n·m) parentCardIds.includes inside edge loop in comparisonCandidates |
| Medium | web-frontend | `apps/web/lib/understanding-graph.ts` | 341 | Algorithmic | nodeSearchText recomputed for every node on every filter query (no per-node memoization) |
| Medium | web-frontend | `apps/web/components/settings/WorkspaceManagement.tsx and apps/web/app/(workspace)/(default)/companion/memory/page.tsx` | 499 / 120 | DB-unbounded-query | listCompanionMemories(true) fetches the complete, unbounded memory list |
| Low | web-frontend | `apps/web/components/study/UnderstandingUniverse.tsx` | 1814-1815 | Algorithmic | Redundant double sort of all screen nodes on every scene rebuild |
| Low | web-frontend | `apps/web/features/companion-pet/voice/companion-audio-buffer.ts` | 81-88 | Algorithmic | Audio buffer read copies samples one-by-one with per-element modulo |
| High | desktop-shared-ai | `apps/desktop/src/voice/asr-manager.ts` | 183-203 | Concurrency | Single pending slot overwritten by concurrent recognize/probe calls |
| Medium | desktop-shared-ai | `packages/shared/src/companion-bridge-revision.ts` | 16-17 | Algorithmic | Repeated JSON.stringify in sort comparator |
| Medium | desktop-shared-ai | `packages/shared/src/hash-canonical-v2.ts` | 42-47 (used at 80, 130) | Algorithmic | Buffer allocation per comparison inside sort comparator |
| Medium | desktop-shared-ai | `packages/shared/src/companion-emotion-classifier.ts` | 86-96 | Algorithmic | O(rules × keywords × text) repeated full-text scans on every reply |
| Medium | desktop-shared-ai | `packages/shared/src/public-json-http.ts` | 302-318 | Timer-Leak | SSE totalTimer never cleared on normal stream completion or cancel() |
| Medium | desktop-shared-ai | `apps/desktop/src/ipc/companion-bridge-ipc.ts` | 184, 231 | Algorithmic | O(n) linear scan of context registry on every UI event/command (with array allocation) |
| Medium | desktop-shared-ai | `apps/desktop/src/soak-sampler.ts` | 64-73, 94-99 | Memory-Leak | Soak samples array grows unboundedly for process lifetime |
| Medium | desktop-shared-ai | `apps/desktop/src/main.ts` | 482-505 | IO-Blocking | Synchronous readFileSync+JSON.parse on every main-window navigation when no pet window exists |
| Medium | desktop-shared-ai | `packages/ai-quality/src/card-generation-v2/deterministic-scorer.ts` | 55-61, 81-93, 97-107, 130-134 | Algorithmic | scoreFixtureDeterministic runs multiple O(n^2) loops with repeated normalize() |
| Medium | desktop-shared-ai | `packages/ai-quality/src/card-generation-v2/rc-gate.ts` | 137-144 | Algorithmic | byBucket construction is O(bucketAssignments × scores) via find() |
| Medium | desktop-shared-ai | `packages/ai-quality/src/card-generation-supervisor-v1/scorer.ts` | 488-499 | Algorithmic | compareBlind does flatMap+filter over all verdicts inside a per-dimension loop |
| Medium | desktop-shared-ai | `packages/ai-quality/src/cli/supervisor-rc-gate.ts` | 194-207, 235-284, 292-331 | DB-N+1 | RC runner issues one HTTP GET per generated card (N+1 network fan-out) |
| Medium | desktop-shared-ai | `packages/ai-quality/src/card-generation-supervisor-v1/rc-runner.ts` | 393-411, 474-478 | Concurrency | Deadline/infra retry orphans the in-flight provider call and can exceed CONCURRENCY_LIMIT |
| Medium | desktop-shared-ai | `packages/db/src/schema/card.ts` | 96 | DB-unbounded-query | learningCards.supersededByCardId has no index for regenerate lookups |
| Medium | desktop-shared-ai | `packages/db/src/schema/card-generation.ts` | 49 | DB-unbounded-query | cardGenerationRuns.supersedesRunId has no index for run-lineage queries |
| Low | desktop-shared-ai | `apps/desktop/src/windows/pet-hit-test-controller.ts` | 157-160 | Polling | Fixed 33ms (~30Hz) cursor polling with no idle backoff |
| Low | desktop-shared-ai | `apps/desktop/src/windows/pet-window.ts` | 32-43 | Timer-Leak | loadURL retry timers are not cancelled when the window is closed |
| Low | desktop-shared-ai | `apps/desktop/src/web-manager.ts` | 136-171 | Concurrency | Sequential awaited port checks in startup loop can stall launch |
| Low | desktop-shared-ai | `packages/shared/src/fsrs-compare-report.ts` | 250-271 | Algorithmic | Repeated full-array filter passes per outcome and per interval tier |
| Low | desktop-shared-ai | `packages/shared/src/output-sanitizer.ts` | 264-265 | Algorithmic | Constant Sets allocated per candidate in sanitizeNoCandidate |
| Low | desktop-shared-ai | `packages/shared/src/markdown-parser.ts` | 171-268 | Algorithmic | Repeated string concatenation while accumulating lines |
| Low | desktop-shared-ai | `packages/shared/src/question-safety.ts` | 222-241 | Algorithmic | Same question re-tokenized and Set-rebuilt for every overlap check |
| Low | desktop-shared-ai | `packages/ai-quality/src/card-generation-supervisor-v1/scorer.ts` | 170-194, 200 | Algorithmic | GoldenSetScorer.score does a goldenSet.find() per result (O(R×G)) |
| Low | desktop-shared-ai | `packages/db/src/schema/job.ts` | 31 | DB-unbounded-query | jobs.generationUnitId FK column is not indexed |
| Low | desktop-shared-ai | `packages/ai-quality/src/card-generation-v2/rc-gate.ts` | 84-106 | Algorithmic | evaluateRcGateV2 recomputes the same score aggregates multiple times |

## 详细描述
### 1. [Medium] Sequential per-row UPDATE of changed note blocks on the autosave path
- **文件**：`apps/api/src/modules/note/service.ts:467-469`
- **类别**：DB-N+1
- **问题**：updateVersionInPlace writes each changed block with its own `await tx.update(...)` inside a `for` loop. This runs on the 2.5s autosave hot path; when many blocks change in a large note, it issues N serial DB round-trips instead of a single batched write.
- **建议**：Batch changed blocks in one multi-row UPDATE (e.g. CASE-based set with inArray(ids), or use jsonb_to_recordset/unnest update), or at minimum issue the per-row updates in bounded-parallel chunks.
### 2. [Medium] O(n²) filter+includes over up to 5000 cards on sourceId-filtered star map
- **文件**：`apps/api/src/modules/understanding/projection-routes.ts:400`
- **类别**：Algorithmic
- **问题**：`cardRows.filter((card) => effectiveCardIds.includes(card.id))` is O(cardRows × effectiveCardIds). Both arrays derive from cardRows, which can reach PROJECTION_MAX_CARDS=5000, making the sourceId-filtered projection path up to ~25M comparisons in JS on each request.
- **建议**：Build a Set from effectiveCardIds once and use `cardRows.filter((card) => effSet.has(card.id))`, reducing to O(n) membership checks.
### 3. [Medium] Import dedup query loads every version + full jsonb under an importId without LIMIT
- **文件**：`apps/api/src/modules/import/routes.ts:295-308`
- **类别**：DB-unbounded-query
- **问题**：The idempotency check selects ALL note_versions whose contentJson->>'importId' = ? and pulls the full contentJson column for each. Items can be up to 500KB each and retries accumulate under the same importId, so this can load an unbounded set of large jsonb rows into memory per import request.
- **建议**：Project only the needed fields (`id`, `noteId`, `versionNo`, `content_json->>'itemKey'`) and add LIMIT/keyset pagination; add an index on the importId jsonb expression if volume is significant.
### 4. [Low] createNoteFromSource dedup query has no LIMIT over all notes of a source
- **文件**：`apps/api/src/modules/source/service.ts:469-481`
- **类别**：DB-unbounded-query
- **问题**：The duplicate-content check selects every non-deleted note of a source (joined to its current version hash) into memory and then does `existingNotes.find(...)`. A source with many generated notes loads all of them just to find one hash match, with no row bound.
- **建议**：Add LIMIT and/or push the hash lookup into SQL (e.g. WHERE notes.source_id = ? AND note_versions.content_hash = ? LIMIT 1).
### 5. [Low] assessments.find inside rubricItems.map is O(n²)
- **文件**：`apps/api/src/modules/validation/session-service.ts:2564-2565`
- **类别**：Algorithmic
- **问题**：For each rubric item, `assessments.find((a) => a.rubricItemId === item.id)` scans the assessments array. If a question ever has many rubric items, this is O(N×M). Currently likely small, but it is a straightforward quadratic pattern.
- **建议**：Build a Map(rubricItemId -> assessment) once and look up per item in O(1).
### 6. [Medium] Per-evidence SELECT FOR UPDATE inside loop in submitArtifact revalidation
- **文件**：`apps/api/src/modules/learning-runs/run-service.ts:2260-2274`
- **类别**：DB-N+1
- **问题**：submitArtifact re-validates evidence eligibility by looping over `snapshot.target.evidence` and issuing one `SELECT ... FOR UPDATE ... LIMIT 1` per evidence item inside the transaction. The identical revalidation in run-processing-tick.ts is already batched with inArray into a Map, so this path is an unfixed N+1 on the user-facing submit path.
- **建议**：Batch the eligibility check into a single query with inArray(...).orderBy(...).for('update'), then validate each evidence from an in-memory Map keyed by evidenceSnapshotId.
### 7. [Low] Sequential insertDomainEvent inside completedReminders loop
- **文件**：`apps/api/src/modules/learning-runs/run-processing-tick.ts:1258-1276`
- **类别**：DB-N+1
- **问题**：After updating all pending/ready Initial Validation Reminders to completed with a single UPDATE, the loop calls insertDomainEvent per reminder, awaited sequentially. Cardinality is normally a few reminders, so impact is bounded but it is still N serial DB writes.
- **建议**：Collect all reminder domain-events and insert them in one multi-row INSERT (or Promise.all) after the loop, keeping the same idempotency keys.
### 8. [Low] Fixed 4-event array inserted one row per await
- **文件**：`apps/api/src/modules/learning-runs/run-service.ts:923-933`
- **类别**：DB-N+1
- **问题**：createRun commits the four startup events via a loop with one INSERT per iteration, each await serialized inside the transaction. It is only 4 rows, but the whole batch could be one multi-row INSERT.
- **建议**：Replace the loop with a single `tx.insert(learningRunEvents).values(eventValues.map(...))` multi-row insert.
### 9. [Low] O(n^2) full-copy projection replay in replayProjection
- **文件**：`apps/api/src/modules/learning-sessions/canonical-events.ts:771-783`
- **类别**：Algorithmic
- **问题**：replayProjection folds each event with `reduceMastery({...mastery}, ...)`, `reduceFacet({...facet})` and `reduceMap({...map})`, shallow-copying three projection objects that grow to O(n) entries — replaying n events is O(n^2) copying.
- **建议**：Mutate the projection objects in place (or use per-key Map updates) and only snapshot/copy at the end, preserving determinism since replay order is fixed.
### 10. [Low] O(n^2) full-copy personal-plane replay (replayPersonalPlane)
- **文件**：`apps/api/src/modules/learning-sessions/star-map-projections.ts:587-599`
- **类别**：Algorithmic
- **问题**：replayPersonalPlane applies five growing-projection reducers per event, each performing a full object spread of state that grows with the event stream, giving O(n^2) total copy work for n events.
- **建议**：Mutate the five projection objects in place during the fold and copy only at the end; event order is already deterministic so behavior is preserved.
### 11. [Low] O(n^2) array .includes in endSession/cancelSession episode status update
- **文件**：`apps/api/src/modules/learning-sessions/session-service.ts:1759-1763, 1795-1799`
- **类别**：Algorithmic
- **问题**：Both endSession and cancelSession iterate `for (const episode of episodes)` and test `cancellable.includes(episode.id)`, making the in-memory status flip O(n^2). The DB update is already batched; only the in-memory mirror is quadratic, and per-session episode counts are typically small.
- **建议**：Build a Set of cancellable ids once and use `cancellableSet.has(episode.id)` inside the loop.
### 12. [Medium] History search performs unbounded scanning of companion_messages.blocks with ILIKE '%q%'
- **文件**：`apps/api/src/modules/companion-conversation/assistant-session-routes.ts:105-134`
- **类别**：DB-unbounded-query
- **问题**：The GET /companion/history/search endpoint filters companion_messages with `blocks::text ILIKE '%keyword%'`. A leading-wildcard ILIKE cannot use a B-tree index, and no pg_trgm GIN index exists on this column, so every query is a full scan of the user's entire message history. The LIMIT caps the response but not the scan work.
- **建议**：Create a pg_trgm GIN index on companion_messages.blocks and/or restrict search to conversation-scoped ranges; alternatively switch to a search_documents-style dedicated indexed field.
### 13. [Medium] External LLM network call awaited inside a DB transaction in run-completed hook
- **文件**：`apps/api/src/modules/companion-conversation/proactive-hook.ts:165-190`
- **类别**：IO-Blocking
- **问题**：hookProactiveOnRunCompleted is invoked with the run-processing tx and, when a keyPointClaim exists, `await generateMemoryCandidates(...)` makes a synchronous external HTTPS call to the LLM while the DB transaction/connection is held open. The connection stays pinned for the network round trip, prolonging the run settlement transaction and reducing pool availability.
- **建议**：Fire the LLM call after the transaction commits. Return the inputs needed for memory-upsert generation, then run generateMemoryCandidates and upsertMemory in a separate transaction.
### 14. [Medium] Inbox SSE polling setInterval has no in-flight guard causing overlapping DB queries
- **文件**：`apps/api/src/modules/companion-conversation/inbox-routes.ts:105-132`
- **类别**：Concurrency
- **问题**：The 3s setInterval callback awaits withWorkspaceTransaction(listInbox...) with no in-flight flag. If a poll/tx takes longer than 3s during DB congestion, the next interval tick fires a concurrent transaction on the same connection, amplifying load and queuing under backpressure.
- **建议**：Add a `let pumping = false` guard (set before await, cleared in finally) and skip the tick if a previous poll is still running; consider wiring a NOTIFY wake-up to reduce polling.
### 15. [Medium] Companion conversation snapshot executes independent DB reads sequentially
- **文件**：`apps/api/src/modules/companion-conversation/companion-conversations-service.ts:222-418`
- **类别**：Concurrency
- **问题**：getCompanionConversationSnapshot runs ~5 DB queries serially within the same repeatable-read transaction. The proposal and action-run queries are independent of the active-run query and could run concurrently, but they are awaited one after another on every conversation open/refresh.
- **建议**：Use Promise.all within the same transaction for the independent reads (activeRuns, proposals, actionRuns) once the conversation exists, and only then fetch stream events that depend on the active run.
### 16. [Low] Companion bridge publish/renew/revoke endpoints have no rate limiting
- **文件**：`apps/api/src/modules/companion-bridge/routes.ts:55-125`
- **类别**：Other
- **问题**：The /companion/bridge/contexts publish, renew, and revoke routes are authenticated but carry no companionRateLimit guard, unlike every other companion route. A malicious authenticated client can hammer these endpoints.
- **建议**：Apply a per-(workspace,user) rate limit consistent with the other companion routes.
### 17. [Low] resolveCompanionLearningContext runs four independent root queries sequentially
- **文件**：`apps/api/src/modules/companion-conversation/learning-action-bridge.ts:82-201`
- **类别**：Concurrency
- **问题**：The learning-context resolver issues four independent root queries (sessions, startRows, runResumeRows, runStartRows) one after another before conditional follow-ups. They read different tables and could be issued concurrently.
- **建议**：Issue the four root SELECTs via Promise.all within the transaction, then resolve the conditional follow-ups from their results.
### 18. [Low] Projection backfill script loads entire pending outbox into memory without limit
- **文件**：`apps/api/src/scripts/backfill-projection-outbox.ts:24-33`
- **类别**：DB-unbounded-query
- **问题**：The one-shot backfill script selects all rows with status='pending' from canonical_learning_event_outbox with no LIMIT or keyset cursor, then iterates them with a per-row withWorkspaceTransaction. For a large backlog this loads the full set into memory.
- **建议**：Page the pending envelopes with a keyset cursor (e.g. LIMIT 200) and process each bounded batch.
### 19. [Medium] Home page fetches entire pending-review list but only renders 3
- **文件**：`apps/web/app/(workspace)/(default)/page.tsx:96`
- **类别**：DB-unbounded-query
- **问题**：api.listSanitizedReviews({ status: 'pending' }) is called without a limit alongside other bounded calls. The full items array is stored in state while only pendingReviews.slice(0,3) is rendered; the count it needs is already returned separately.
- **建议**：Pass an explicit limit: api.listSanitizedReviews({ status: 'pending', limit: 3 }) and use response.total for the count.
### 20. [Medium] O(n·m) parentCardIds.includes inside edge loop in comparisonCandidates
- **文件**：`apps/web/app/(workspace)/(default)/graph/page.tsx:756-760`
- **类别**：Algorithmic
- **问题**：For a selected key_point, parentCardIds is built from rawGraph.edges, then a for loop over every rawGraph.edges calls parentCardIds.includes(edge.from) — a linear scan per edge, yielding O(edges × parents) worst case on large graphs.
- **建议**：Convert parentCardIds to a Set once so the contains check inside the loop is O(1).
### 21. [Medium] nodeSearchText recomputed for every node on every filter query (no per-node memoization)
- **文件**：`apps/web/lib/understanding-graph.ts:341`
- **类别**：Algorithmic
- **问题**：When a query is present, indexed.graph.nodes.filter((node) => nodeSearchText(node).includes(query)) calls nodeSearchText per node, which recursively flattens metadata with per-object key sorting every time. This runs on every deferredQuery change, and graph/page separately re-runs an equivalent searchableText for the same query — doubling the cost.
- **建议**：Precompute and cache each node's lowercased search text once (e.g. a Map keyed by node id) and reuse it for both the graph filter and search dropdown.
### 22. [Medium] listCompanionMemories(true) fetches the complete, unbounded memory list
- **文件**：`apps/web/components/settings/WorkspaceManagement.tsx and apps/web/app/(workspace)/(default)/companion/memory/page.tsx:499 / 120`
- **类别**：DB-unbounded-query
- **问题**：Both Settings → MemoryManagementCard and the full memory page call api.listCompanionMemories(true) with no pagination/limit parameter. The settings card only wants two counts and filters the full array twice, while memories accumulate over long user sessions.
- **建议**：Add a server-side limit/offset (or a count/summary endpoint) to /companion/memory. For the settings card, request only the counts; for the memory page, paginate.
### 23. [Low] Redundant double sort of all screen nodes on every scene rebuild
- **文件**：`apps/web/components/study/UnderstandingUniverse.tsx:1814-1815`
- **类别**：Algorithmic
- **问题**：On each scene rebuild (which occurs on every pan/zoom because the scene key includes viewport offset/zoom), orderedNodes is sorted ascending by priority and labelCandidates is orderedNodes.slice().sort descending — a second O(n log n) sort plus a full array copy, then a third O(n) filter for dynamicNodes.
- **建议**：Sort once ascending and derive the descending order by iterating reversed, or sort a single array of {node, priority} once and reuse both views.
### 24. [Low] Audio buffer read copies samples one-by-one with per-element modulo
- **文件**：`apps/web/features/companion-pet/voice/companion-audio-buffer.ts:81-88`
- **类别**：Algorithmic
- **问题**：read() copies up to n samples in a tight loop using buf[this.readIdx] with readIdx modulo capacity. When recognition pulls the whole 16s buffer (768k samples @48kHz), this is ~768k modulo-indexed scalar writes instead of TypedArray copy ops.
- **建议**：Use subarray + buf.set for the (up to) two contiguous segments of the ring buffer instead of the scalar loop.
### 25. [High] Single pending slot overwritten by concurrent recognize/probe calls
- **文件**：`apps/desktop/src/voice/asr-manager.ts:183-203`
- **类别**：Concurrency
- **问题**：`private pending: AsrPendingRequest | null` stores one in-flight request; dispatch() sets this.pending and the worker message handler resolves whatever this.pending currently points to. If two recognize/probe IPC calls overlap, the second overwrites the first, so the worker reply is delivered to the wrong caller, the first hangs until timeout, and the timeout disposes the worker mid-request for the second call.
- **建议**：Maintain a queue or per-request Map keyed by request id; include the id in the posted message and match it in the worker message handler; only tear down the worker when no requests are outstanding.
### 26. [Medium] Repeated JSON.stringify in sort comparator
- **文件**：`packages/shared/src/companion-bridge-revision.ts:16-17`
- **类别**：Algorithmic
- **问题**：`[...input.entityRefs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))` reserialises the same entities O(n log n) times during context-revision computation on a hot companion path.
- **建议**：Precompute canonical strings once and sort the string array, or sort by a cheap stable key.
### 27. [Medium] Buffer allocation per comparison inside sort comparator
- **文件**：`packages/shared/src/hash-canonical-v2.ts:42-47 (used at 80, 130)`
- **类别**：Algorithmic
- **问题**：`compareUtf8` runs Buffer.from(a)/Buffer.from(b) on every comparison and is used as a sort comparator for object keys and hashes, so hashing hot paths allocate two Buffers plus UTF-8 encode + Buffer.compare per comparison.
- **建议**：Sort keys with a plain code-point/string comparator or precompute encoded keys once, avoiding Buffer allocation inside the comparator.
### 28. [Medium] O(rules × keywords × text) repeated full-text scans on every reply
- **文件**：`packages/shared/src/companion-emotion-classifier.ts:86-96`
- **类别**：Algorithmic
- **问题**：classifyCompanionReplyEmotion loops over 4 rules and ~50 keywords, calling normalized.indexOf(keyword) which rescans the whole reply text from the start for each keyword — ~200 independent full-text scans per companion reply on the hot dialogue path.
- **建议**：Build a single-pass matcher (combined RegExp per rule or a trie) and scan the text once per rule instead of once per keyword.
### 29. [Medium] SSE totalTimer never cleared on normal stream completion or cancel()
- **文件**：`packages/shared/src/public-json-http.ts:302-318`
- **类别**：Timer-Leak
- **问题**：For the streaming path, totalTimer is deliberately kept after resolve to catch 'headers arrived but body never streams', but it is only cleared on error. A healthy stream that ends normally, or a caller invoking cancel() without an error, leaves a 300s timer armed per connection; a legitimate stream needing >300s total is destroyed by this retained timer.
- **建议**：Clear totalTimer on response 'end'/'close' and in cancel(); arm a body-stall timer that resets per data-chunk.
### 30. [Medium] O(n) linear scan of context registry on every UI event/command (with array allocation)
- **文件**：`apps/desktop/src/ipc/companion-bridge-ipc.ts:184, 231`
- **类别**：Algorithmic
- **问题**：`const record = [...records.values()].find((r) => r.pageInstanceId === pageInstanceId)` spreads the whole registry into an array and linear-scans it on every UI event and in-page command. The Map is keyed by contextId but lookup is by pageInstanceId.
- **建议**：Keep a secondary Map<pageInstanceId, contextId> (or index records by pageInstanceId) so lookup is O(1).
### 31. [Medium] Soak samples array grows unboundedly for process lifetime
- **文件**：`apps/desktop/src/soak-sampler.ts:64-73, 94-99`
- **类别**：Memory-Leak
- **问题**：record() always pushes to this.samples and snapshotSinceLast() only advances this.lastDeltaIndex without truncating. For a long soak run the array accumulates every sample for the entire process lifetime.
- **建议**：After emitting snapshotSinceLast, splice away the consumed prefix and reset the index, or keep a capped rolling window.
### 32. [Medium] Synchronous readFileSync+JSON.parse on every main-window navigation when no pet window exists
- **文件**：`apps/desktop/src/main.ts:482-505`
- **类别**：IO-Blocking
- **问题**：reloadPetAfterMainLogin is attached to both did-navigate and did-navigate-in-page; when no pet window exists it calls loadDevicePetPreferences, which does a synchronous readFileSync+JSON.parse on the Electron main event loop. In an SPA did-navigate-in-page fires per route change, so pet-disabled users block the main process on every navigation.
- **建议**：Cache loaded preferences (load once at startup, invalidate on save) so the per-navigation handler is a memory check, or short-circuit when petModeEnabled === false.
### 33. [Medium] scoreFixtureDeterministic runs multiple O(n^2) loops with repeated normalize()
- **文件**：`packages/ai-quality/src/card-generation-v2/deterministic-scorer.ts:55-61, 81-93, 97-107, 130-134`
- **类别**：Algorithmic
- **问题**：Nested candidate×objective/fact loops repeatedly call normalize() on the same strings. normalize() lowercases/strips whitespace with regex, so the cost is O(candidates×facts×len) with repeated regex work over the same candidate text.
- **建议**：Pre-normalize each candidate's strings into a cached small array/set once before the loops.
### 34. [Medium] byBucket construction is O(bucketAssignments × scores) via find()
- **文件**：`packages/ai-quality/src/card-generation-v2/rc-gate.ts:137-144`
- **类别**：Algorithmic
- **问题**：`for (const a of input.bucketAssignments ?? []) { const score = input.scores.find(...) }` linear-scans the whole scores array per assignment. With a multi-hundred-fixture corpus this is O(n^2).
- **建议**：Build a Map<string, DeterministicScoreV2> keyed by fixtureId from input.scores once, then get(a.fixtureId) in the loop.
### 35. [Medium] compareBlind does flatMap+filter over all verdicts inside a per-dimension loop
- **文件**：`packages/ai-quality/src/card-generation-supervisor-v1/scorer.ts:488-499`
- **类别**：Algorithmic
- **问题**：keyDimensions.map((dim) => { pairwiseVerdicts.flatMap(...).filter(...) }) rescans the whole verdict/delta list once per key dimension — O(keyDimensions × verdicts × deltasPerVerdict).
- **建议**：Group deltas by dimension once into a Map<string, number[]> (or accumulate sums/counts), then read per dimension.
### 36. [Medium] RC runner issues one HTTP GET per generated card (N+1 network fan-out)
- **文件**：`packages/ai-quality/src/cli/supervisor-rc-gate.ts:194-207, 235-284, 292-331`
- **类别**：DB-N+1
- **问题**：collectActualEvidenceMetrics runs mapLimitCards(cards, 8, ...) and each card does a getCardEvidenceFromApi — one /cards/{cardId}/evidence fetch per card. Bounded at concurrency 8, but with 3 samples running concurrently this fans out many per-card calls per RC run.
- **建议**：Use a batch endpoint for all cardIds of a run/set if available; otherwise keep the bounded pool but raise it deliberately with circuit-breaking.
### 37. [Medium] Deadline/infra retry orphans the in-flight provider call and can exceed CONCURRENCY_LIMIT
- **文件**：`packages/ai-quality/src/card-generation-supervisor-v1/rc-runner.ts:393-411, 474-478`
- **类别**：Concurrency
- **问题**：Each attempt races runner.runSample against a deadline promise; on deadline/infra error it retries after a sleep, but the previous runSample promise is never awaited or drained. The orphaned call keeps polling up to 300s and retries can stack beyond the concurrency limit.
- **建议**：Await or fully abort the losing promise after Promise.race before retrying, and thread the AbortSignal into createNote/createCardGenerationRun/pollRunUntilTerminal so abort actually cancels work.
### 38. [Medium] learningCards.supersededByCardId has no index for regenerate lookups
- **文件**：`packages/db/src/schema/card.ts:96`
- **类别**：DB-unbounded-query
- **问题**：supersededByCardId is a self-referencing column consulted when resolving which new card superseded an old one during regeneration/history queries, but only noteIdx/workspaceIdx/setIdx/generationRunIdx exist — regeneration lookups by this column will full-scan.
- **建议**：Add `supersededByIdx: index("learning_cards_superseded_by_idx").on(t.workspaceId, t.supersededByCardId)`.
### 39. [Medium] cardGenerationRuns.supersedesRunId has no index for run-lineage queries
- **文件**：`packages/db/src/schema/card-generation.ts:49`
- **类别**：DB-unbounded-query
- **问题**：supersedesRunId is a self-reference used to trace run lineage, yet the run table indexes cover workspace/note/status/engineMode only. Queries joining/filtering on supersedesRunId will scan.
- **建议**：Add `index("card_generation_runs_supersedes_idx").on(t.workspaceId, t.supersedesRunId)`.
### 40. [Low] Fixed 33ms (~30Hz) cursor polling with no idle backoff
- **文件**：`apps/desktop/src/windows/pet-hit-test-controller.ts:157-160`
- **类别**：Polling
- **问题**：start() sets setInterval(() => this.tick(), 33) and tick() calls this.getCursorScreenPoint() every tick even when the cursor is static (the guard at 172-174 only skips the expensive geometry/hit computation, not the native cursor query).
- **建议**：Poll only while necessary and back off to a slower cadence after several static ticks.
### 41. [Low] loadURL retry timers are not cancelled when the window is closed
- **文件**：`apps/desktop/src/windows/pet-window.ts:32-43`
- **类别**：Timer-Leak
- **问题**：loadWithRetry schedules setTimeout on each failure with no cancellation reference, retrying until attempt >= 5. If the window is destroyed between attempts, the remaining timers still call window.loadURL on a destroyed window.
- **建议**：Track the retry timer and cancel it in the closed/destroyed path, or check window.isDestroyed() at the top of loadWithRetry.
### 42. [Low] Sequential awaited port checks in startup loop can stall launch
- **文件**：`apps/desktop/src/web-manager.ts:136-171`
- **类别**：Concurrency
- **问题**：findFreePort serially awaits isPortResponding then isPortFree for each of up to 30 ports; in the worst case where all are occupied, isPortResponding waits up to its 1s timeout per port, adding tens of seconds of sequential network I/O before startupSequence proceeds.
- **建议**：Probe candidate ports concurrently (Promise.all) and pick the first free, or use a single net-server bind attempt per port with short timeouts; cap total scan time.
### 43. [Low] Repeated full-array filter passes per outcome and per interval tier
- **文件**：`packages/shared/src/fsrs-compare-report.ts:250-271`
- **类别**：Algorithmic
- **问题**：buildReport re-filters the entire validEntries collection once per outcome and once per interval tier, each also allocating a map array; with a large review-history sample this is O(k·n) with k≈14 passes over the whole collection.
- **建议**：Accumulate per-outcome and per-tier buckets in a single pass and compute means in one traversal.
### 44. [Low] Constant Sets allocated per candidate in sanitizeNoCandidate
- **文件**：`packages/shared/src/output-sanitizer.ts:264-265`
- **类别**：Algorithmic
- **问题**：sanitizeNoCandidate allocates IMPORTANCE_VALUES and COGNITIVE_VALUES Sets on every invocation, and it is called via map(sanitizeNoCandidate) per noCandidate entry — hundreds of identical Set constructions on hot sanitizer runs.
- **建议**：Hoist both Sets to module scope like the other VALID_* sets.
### 45. [Low] Repeated string concatenation while accumulating lines
- **文件**：`packages/shared/src/markdown-parser.ts:171-268`
- **类别**：Algorithmic
- **问题**：parseMarkdown grows currentText/codeBlockContent via per-line `+=`. For long imported markdown documents this repeatedly rebuilds immutable strings in a per-line loop, degrading to O(n²) copying on large inputs.
- **建议**：Collect lines into an array and join("\n") once when flushing a block.
### 46. [Low] Same question re-tokenized and Set-rebuilt for every overlap check
- **文件**：`packages/shared/src/question-safety.ts:222-241`
- **类别**：Algorithmic
- **问题**：Each tokenOverlap(output.question, X) call re-runs tokenize(output.question) and rebuilds a new Set of its tokens. Within a single assessQuestionOutput the full question string is tokenized several times on identical input.
- **建议**：Tokenize output.question once at the top of assessQuestionOutput and reuse its Set across all tokenOverlap calls.
### 47. [Low] GoldenSetScorer.score does a goldenSet.find() per result (O(R×G))
- **文件**：`packages/ai-quality/src/card-generation-supervisor-v1/scorer.ts:170-194, 200`
- **类别**：Algorithmic
- **问题**：scoreSample does this.goldenSet.find((s) => s.sampleId === result.sampleId) per result inside score(). With a 60-sample golden set this is 3600 linear scans per round; fine today but it is an N×M scan that should be a hash lookup.
- **建议**：Build a Map<string, GoldenSample> from goldenSet once and use map.get(result.sampleId).
### 48. [Low] jobs.generationUnitId FK column is not indexed
- **文件**：`packages/db/src/schema/job.ts:31`
- **类别**：DB-unbounded-query
- **问题**：generationUnitId references cardGenerationUnits.id and is a per-unit lookup key, but only generationRunIdx (on generationRunId) is indexed; a lookup by generationUnitId alone cannot use it.
- **建议**：Add `index("jobs_generation_unit_idx").on(t.generationUnitId, t.status)` if unit-scoped job lookups are common.
### 49. [Low] evaluateRcGateV2 recomputes the same score aggregates multiple times
- **文件**：`packages/ai-quality/src/card-generation-v2/rc-gate.ts:84-106`
- **类别**：Algorithmic
- **问题**：Same full-array scans are repeated: input.scores.filter(...).length computed twice, input.scores.reduce(...) twice, and microScores.filter(...) again in 131-132 — redundant O(n) passes per gate evaluation on a 300+ fixture corpus.
- **建议**：Compute each aggregate once into local variables and reuse them in both the actual and passed fields.
## 修复记录（第二轮，2026-08-16）

- ✅ **已修复：47 项**
- ⏭️ **保留未改：2 项**，原因如下：

| # | 文件 | 行 | 问题 | 保留原因 |
|---|---|---|---|---|
| 22 | `apps/web/components/settings/WorkspaceManagement.tsx` / `apps/web/app/(workspace)/(default)/companion/memory/page.tsx` | 499 / 120 | `listCompanionMemories(true)` 拉取完整记忆列表 | 需要服务端 limit/offset 或 count/summary 接口，且当前 API 已有 `MEMORY_LIST_LIMIT=200` 防御性上限；纯前端改动无法真正收敛，跨分区架构改动超出本次安全修复范围 |
| 36 | `packages/ai-quality/src/cli/supervisor-rc-gate.ts` | 194-207, 235-284, 292-331 | RC runner 每张卡一次 HTTP GET（N+1） | 当前 API 只有 per-card evidence 端点，没有批量接口；已有并发 8 的有界池是安全缓解，新增批量 API 属架构级改动 |

### 验证状态

- ✅ `apps/api` typecheck 通过
- ✅ `apps/web` typecheck 通过
- ✅ `apps/desktop` typecheck 通过
- ✅ `packages/shared` typecheck 通过
- ✅ `packages/ai-quality` typecheck 通过
- ✅ `packages/db` typecheck 通过
- ✅ `apps/api` 测试：3334 pass / 0 fail / 1 skip
- ✅ `apps/web` 测试：624 pass / 0 fail
- ✅ `apps/web` 组件测试：91 pass / 0 fail
- ✅ `packages/shared` 测试：496 pass / 0 fail
- ✅ `packages/ai-quality` 测试：115 pass / 0 fail
- ✅ `apps/desktop` 测试：37 pass / 0 fail
