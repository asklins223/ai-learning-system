import { test, expect } from "../lib/fixtures";
import { computeClientReviewHashV2 } from "../../../packages/shared/src/card-generation-v2-hashing.ts";

/**
 * E2E: Card Generation V2 journey (方案 20).
 *
 * 此测试验证 V2 API 端点的完整链路：
 *   1. 创建笔记 → 保存版本 → 创建 V2 生成运行
 *   2. 轮询运行状态直到终态
 *   3. 查询候选列表
 *   4. 揭示候选答案（exposure-first）
 *   5. keep 候选
 *   6. 激活候选 → 生成 LearningObjective + LearningCard
 *
 * 前置条件：
 *   - CARD_GENERATION_V2_ENABLED=true（feature flag 开启）
 *   - 用户已通过 seed CLI 创建
 *
 * @pr
 */

test.describe("Card Generation V2 API journey @pr", () => {
  test("create note, generate V2 run, review candidates, reveal, keep, and activate", async ({ authedPage }) => {
    test.setTimeout(240_000);
    const page = authedPage;

    // 获取 CSRF token（cookie-based auth 需要）
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "ailearn_csrf");
    const csrfToken = csrfCookie?.value ?? "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    };

    // ─── 1. 创建笔记 ─────────────────────────────────────────────────
    const noteTitle = `V2 E2E ${Date.now()}`;
    const createNoteRes = await page.request.post("/api/notes", {
      headers,
      data: {
        title: noteTitle,
        blocks: [
          { type: "heading", content: "什么是贝叶斯定理" },
          { type: "paragraph", content: "贝叶斯定理描述了基于先验概率和条件概率计算后验概率的方法。" },
          { type: "paragraph", content: "公式为 P(A|B) = P(B|A) * P(A) / P(B)。" },
        ],
      },
    });
    expect(createNoteRes.status()).toBeLessThan(300);
    const noteBody = await createNoteRes.json();
    const noteId = noteBody.note.id;
    const noteVersionId = noteBody.version.id;
    expect(noteId).toBeTruthy();
    expect(noteVersionId).toBeTruthy();

    // ─── 2. 创建 V2 生成运行 ───────────────────────────────────────────
    const idempotencyKey = `v2-e2e-${noteVersionId}-${Date.now()}`;
    const runRequest = {
      version: 2 as const,
      noteVersionId,
      sourceScope: { kind: "whole_note" as const },
      learningGoal: "understand" as const,
      detailThreshold: "balanced" as const,
      quantity: { kind: "adaptive" as const },
      clientRequestId: `e2e-${Date.now()}`,
    };
    const createRunRes = await page.request.post("/api/v2/card-generation-runs", {
      headers: { ...headers, "X-Idempotency-Key": idempotencyKey },
      data: runRequest,
    });

    // V2 可能未启用 → 404/503 是合理的（feature flag 关闭）
    if (createRunRes.status() === 404) {
      test.skip(true, "Card Generation V2 is not enabled (CARD_GENERATION_V2_ENABLED not set)");
      return;
    }

    expect(createRunRes.status(), `V2 run creation failed: ${await createRunRes.text()}`).toBe(202);
    const runBody = await createRunRes.json();
    const runId = runBody.runId;
    expect(runId).toBeTruthy();

    // ─── 3. 查询运行详情 ───────────────────────────────────────────────
    const runDetailsRes = await page.request.get(`/api/v2/card-generation-runs/${runId}`);
    expect(runDetailsRes.ok()).toBeTruthy();
    const runDetails = await runDetailsRes.json();
    expect(runDetails.runId).toBe(runId);

    // ─── 4. 查询计划 ───────────────────────────────────────────────────
    // The worker owns plan creation; a 404 is expected while the accepted
    // run is still moving from source_sealing/planning to an observable plan.
    await expect.poll(
      async () => (await page.request.get(`/api/v2/card-generation-runs/${runId}/plan`)).status(),
      { timeout: 120_000, intervals: [500, 1_000, 2_000, 4_000] },
    ).toBe(200);
    const planRes = await page.request.get(`/api/v2/card-generation-runs/${runId}/plan`);
    expect(planRes.ok()).toBeTruthy();
    const plan = await planRes.json();
    expect(plan.planVersion).toBeGreaterThanOrEqual(1);
    expect(plan.planHash.length).toBe(64);

    // ─── 5. 查询事件流 ─────────────────────────────────────────────────
    const eventsRes = await page.request.get(`/api/v2/card-generation-runs/${runId}/events`);
    expect(eventsRes.ok()).toBeTruthy();
    const events = await eventsRes.json();
    expect(Array.isArray(events.events)).toBeTruthy();
    expect(events.events.length).toBeGreaterThan(0);

    // ─── 6. 等待服务端公开审核候选 ───────────────────────────────────────
    await expect.poll(
      async () => {
        const response = await page.request.get(`/api/v2/card-generation-runs/${runId}`);
        if (!response.ok()) return "missing";
        return (await response.json()).status;
      },
      { timeout: 180_000, intervals: [1_000, 2_000, 4_000, 8_000] },
    ).toBe("review_ready");
    const candidatesRes = await page.request.get(`/api/v2/card-generation-runs/${runId}/candidates`);
    expect(candidatesRes.ok()).toBeTruthy();
    const candidatesBody = await candidatesRes.json();
    const candidate = candidatesBody.candidates.find((item: {
      isReviewReady: boolean;
      candidateEvidenceBindingPlanHash: string | null;
    }) => item.isReviewReady && item.candidateEvidenceBindingPlanHash !== null);
    expect(candidate).toBeTruthy();

    // ─── 7. exposure-first reveal ───────────────────────────────────────
    const revealRes = await page.request.post(
      `/api/v2/card-generation-runs/${runId}/candidates/${candidate.candidateId}/reveal`,
      {
        headers: { ...headers, "X-Idempotency-Key": `v2-e2e-reveal-${Date.now()}` },
        data: {
          candidateId: candidate.candidateId,
          expectedCandidateRevision: candidate.revision,
          expectedCandidateRevisionHash: candidate.candidateRevisionHash,
        },
      },
    );
    expect(revealRes.ok(), `candidate reveal failed: ${await revealRes.text()}`).toBeTruthy();
    const revealBody = await revealRes.json();
    expect(revealBody.candidateId).toBe(candidate.candidateId);
    expect(revealBody.exposureId).toBeTruthy();

    // ─── 8. keep 候选（CAS 使用服务端最新 plan/run）────────────────────
    const reviewRun = await (await page.request.get(`/api/v2/card-generation-runs/${runId}`)).json();
    const reviewPlan = await (await page.request.get(`/api/v2/card-generation-runs/${runId}/plan`)).json();
    const reviewRes = await page.request.post(
      `/api/v2/card-generation-runs/${runId}/candidate-actions`,
      {
        headers: { ...headers, "X-Idempotency-Key": `v2-e2e-review-${Date.now()}` },
        data: {
          version: 2,
          runId,
          expectedCardContentEpoch: reviewRun.cardContentEpoch,
          expectedPlanVersion: reviewPlan.planVersion,
          expectedPlanHash: reviewPlan.planHash,
          expectedReviewDraftRevision: reviewRun.reviewDraftRevision,
          action: {
            type: "keep",
            candidateId: candidate.candidateId,
            expectedRevision: candidate.revision,
            expectedRevisionHash: candidate.candidateRevisionHash,
          },
        },
      },
    );
    expect(reviewRes.ok(), `candidate keep failed: ${await reviewRes.text()}`).toBeTruthy();

    const keptCandidates = (await (await page.request.get(`/api/v2/card-generation-runs/${runId}/candidates`)).json()).candidates;
    const kept = keptCandidates.find((item: {
      candidateId: string;
      reviewDecision: string;
      publishState: string;
      candidateEvidenceBindingPlanHash: string | null;
    }) => item.candidateId === candidate.candidateId
      && item.reviewDecision === "keep"
      && item.publishState === "unpublished"
      && item.candidateEvidenceBindingPlanHash !== null);
    expect(kept).toBeTruthy();

    // ─── 9. activate → receipt + activated candidate ───────────────────
    const activationRun = await (await page.request.get(`/api/v2/card-generation-runs/${runId}`)).json();
    const selectedCandidates = [{
      candidateRevisionId: kept.candidateRevisionId,
      candidateId: kept.candidateId,
      revision: kept.revision,
      revisionHash: kept.candidateRevisionHash,
      candidateEvidenceBindingPlanHash: kept.candidateEvidenceBindingPlanHash,
      qualityReportHashes: [],
      intent: { kind: "create_new" as const },
    }];
    const clientReviewHash = computeClientReviewHashV2({
      runId,
      expectedReviewDraftRevision: activationRun.reviewDraftRevision,
      selected: selectedCandidates.map((item) => ({
        candidateId: item.candidateId,
        revision: item.revision,
        revisionHash: item.revisionHash,
      })),
      reviewUiContractVersion: "review-ui-v1",
    });
    const activateRes = await page.request.post(
      `/api/v2/card-generation-runs/${runId}/activate`,
      {
        headers: { ...headers, "X-Idempotency-Key": `v2-e2e-activate-${Date.now()}` },
        // The real worker may still be committing a final recheck transaction
        // for the reviewed revision. Activation remains server-owned and
        // idempotent; allow that lock window to settle instead of treating a
        // normal slow provider/worker cycle as a client failure.
        timeout: 60_000,
        data: {
          version: 2,
          runId,
          sourceSnapshotHash: activationRun.sourceSnapshotHash,
          semanticSpecHash: activationRun.semanticSpecHash,
          inputSnapshotHash: activationRun.inputSnapshotHash,
          expectedCardContentEpoch: activationRun.cardContentEpoch,
          planRevisionId: reviewPlan.planRevisionId,
          expectedPlanVersion: reviewPlan.planVersion,
          planHash: reviewPlan.planHash,
          selectedCandidates,
          existingLifecycleActions: [],
          expectedReviewDraftRevision: activationRun.reviewDraftRevision,
          clientReviewHash,
        },
      },
    );
    expect(activateRes.ok(), `candidate activation failed: ${await activateRes.text()}`).toBeTruthy();
    const receipt = await activateRes.json();
    expect(receipt.mappings.length).toBeGreaterThan(0);
    await expect.poll(
      async () => (await page.request.get(`/api/v2/card-generation-runs/${runId}`)).json().then((body) => body.status),
      { timeout: 30_000 },
    ).toBe("activated");
    const activatedCandidates = (await (await page.request.get(`/api/v2/card-generation-runs/${runId}/candidates`)).json()).candidates;
    expect(activatedCandidates.some((item: { candidateId: string; publishState: string }) => item.candidateId === candidate.candidateId && item.publishState === "activated")).toBeTruthy();

    // ─── 10. 幂等 replay（同 idempotencyKey 应返回同 runId）────────────
    const replayRes = await page.request.post("/api/v2/card-generation-runs", {
      headers: { ...headers, "X-Idempotency-Key": idempotencyKey },
      data: runRequest,
    });
    expect(replayRes.status()).toBe(202);
    const replayBody = await replayRes.json();
    expect(replayBody.runId).toBe(runId); // 幂等

    // ─── 7. 404 测试：查询不存在的 run ─────────────────────────────────
    const notFoundRes = await page.request.get("/api/v2/card-generation-runs/00000000-0000-0000-0000-000000000000");
    expect(notFoundRes.status()).toBe(404);
    const notFoundBody = await notFoundRes.json();
    expect(notFoundBody.error).toBe("run_not_found");

    // ─── 8. 400 测试：无效 UUID ─────────────────────────────────────────
    const badIdRes = await page.request.get("/api/v2/card-generation-runs/not-a-uuid");
    expect(badIdRes.status()).toBe(400);
    const badIdBody = await badIdRes.json();
    expect(badIdBody.error).toBe("invalid_id");

  });

  test("candidate reveal and review actions return correct status codes", async ({ authedPage }) => {
    const page = authedPage;
    const csrfCookie = (await page.context().cookies()).find((cookie) => cookie.name === "ailearn_csrf");
    const headers = {
      "Content-Type": "application/json",
      ...(csrfCookie?.value ? { "X-CSRF-Token": csrfCookie.value } : {}),
    };

    // 对不存在的 run 做操作应返回 404
    const fakeRunId = "00000000-0000-0000-8000-000000000010";
    const fakeCandidateId = "00000000-0000-0000-8000-000000000011";

    // reveal 不存在的候选
    const revealRes = await page.request.post(
      `/api/v2/card-generation-runs/${fakeRunId}/candidates/${fakeCandidateId}/reveal`,
      {
        headers: { ...headers, "X-Idempotency-Key": `v2-e2e-fake-reveal-${Date.now()}` },
        data: {
          candidateId: fakeCandidateId,
          expectedCandidateRevision: 1,
          expectedCandidateRevisionHash: "a".repeat(64),
        },
      },
    );
    // 不存在的 run → 应返回 404（reveal-service 内部）
    expect([404, 409]).toContain(revealRes.status());

    // candidate-actions 对不存在的 run
    const actionRes = await page.request.post(
      `/api/v2/card-generation-runs/${fakeRunId}/candidate-actions`,
      {
        headers: { ...headers, "X-Idempotency-Key": `v2-e2e-fake-action-${Date.now()}` },
        data: {
          version: 2,
          runId: fakeRunId,
          expectedCardContentEpoch: 1,
          expectedPlanVersion: 1,
          expectedPlanHash: "b".repeat(64),
          expectedReviewDraftRevision: 1,
          action: {
            type: "keep",
            candidateId: fakeCandidateId,
            expectedRevision: 1,
            expectedRevisionHash: "c".repeat(64),
          },
        },
      },
    );
    expect([404, 409]).toContain(actionRes.status());
  });

  test("activate endpoint rejects invalid requests", async ({ authedPage }) => {
    const page = authedPage;
    const csrfCookie = (await page.context().cookies()).find((cookie) => cookie.name === "ailearn_csrf");
    const headers = {
      "Content-Type": "application/json",
      ...(csrfCookie?.value ? { "X-CSRF-Token": csrfCookie.value } : {}),
    };

    const fakeRunId = "00000000-0000-0000-8000-000000000020";

    // 激活不存在的 run
    const activateRes = await page.request.post(
      `/api/v2/card-generation-runs/${fakeRunId}/activate`,
      {
        headers: { ...headers, "X-Idempotency-Key": `v2-e2e-fake-activate-${Date.now()}` },
        data: {
          version: 2,
          runId: fakeRunId,
          sourceSnapshotHash: "a".repeat(64),
          semanticSpecHash: "b".repeat(64),
          inputSnapshotHash: "c".repeat(64),
          expectedCardContentEpoch: 1,
          planRevisionId: "00000000-0000-0000-8000-000000000021",
          expectedPlanVersion: 1,
          planHash: "d".repeat(64),
          selectedCandidates: [
            {
              candidateRevisionId: "00000000-0000-0000-8000-000000000022",
              candidateId: "00000000-0000-0000-8000-000000000023",
              revision: 1,
              revisionHash: "e".repeat(64),
              candidateEvidenceBindingPlanHash: "f".repeat(64),
              qualityReportHashes: [],
              intent: { kind: "create_new" },
            },
          ],
          existingLifecycleActions: [],
          expectedReviewDraftRevision: 1,
          clientReviewHash: "0".repeat(64), // wrong hash
        },
      },
    );
    // run_not_found (404) or client_review_hash_mismatch (409)
    expect([404, 409]).toContain(activateRes.status());
  });
});
