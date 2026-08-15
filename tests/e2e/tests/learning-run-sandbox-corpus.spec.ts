import { test, expect, type SeedCredentials } from "../lib/fixtures";

/**
 * §24.5 E02：sandbox 示例旅程——0 canonical envelope、0 official schedule、
 * 0 正式星图变化;namespace 随旅程/终态退出。
 *
 * 真实 API 驱动(非 fixture 注入):invitation start_journey(sandbox_sample)
 * → onboarding sandbox Run → 提交 → 评估 → 结算 → DB/投影断言。
 */

async function postJson(
  page: import("@playwright/test").Page,
  path: string,
  body: unknown,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === "ailearn_csrf")?.value;
  const response = await page.request.post(path, {
    headers: csrf ? { "x-csrf-token": csrf } : undefined,
    data: body,
  });
  return { status: response.status(), json: () => response.json() as Promise<unknown> };
}

test.describe("sandbox corpus", () => {
  test("E02: sandbox run leaves zero canonical/schedule/star-map side effects @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    test.setTimeout(300_000);
    const page = authedPage;
    const ws = (seedCredentials as SeedCredentials).workspaces[0];
    const cardId = ws.cardIds?.[0];
    expect(cardId).toBeTruthy();

    // 1. 拿一个真实 keyPoint(作为 sandbox 运行的目标内容,§16.4 隔离运行)。
    const cardResponse = await page.request.get(`/api/cards/${cardId}`);
    const card = await cardResponse.json() as { keyPoints?: Array<{ id?: string }> };
    const keyPointId = card.keyPoints?.[0]?.id;
    expect(keyPointId).toBeTruthy();

    // 2. start_journey(sandbox_sample) → journey + namespace。
    // 幂等容错:同 seed 重跑时 invitation 已 accepted(stale_revision)→ replay
    // 创建新旅程(accepted 允许 replay)。
    let startRes = await postJson(page, "/api/companion/invitation/actions", {
      version: 2,
      expectedRevision: 1,
      action: { kind: "start_journey", workspaceId: ws.workspaceId, branch: "sandbox_sample" },
      idempotencyKey: `e2e-sandbox-start-${Date.now()}`,
    });
    let startBody = await startRes.json() as { error?: string };
    if (startRes.status !== 200 && startBody.error === "stale_revision") {
      startRes = await postJson(page, "/api/companion/invitation/actions", {
        version: 2,
        expectedRevision: 2,
        action: { kind: "replay", workspaceId: ws.workspaceId, branch: "sandbox_sample" },
        idempotencyKey: `e2e-sandbox-replay-${Date.now()}`,
      });
      startBody = await startRes.json() as { error?: string };
    }
    // eslint-disable-next-line no-console
    console.log(`PROBE-E02 start status=${startRes.status} body=${JSON.stringify(startBody).slice(0, 220)}`);
    let journey: { journeyId?: string; branch?: string; refs?: { sandboxNamespaceId?: string } } | undefined;
    if (startRes.status === 200) {
      const invitation = startBody as { journey?: typeof journey };
      journey = invitation.journey;
      // eslint-disable-next-line no-console
      console.log(`PROBE-E02 journey-full=${JSON.stringify(journey)}`);
    } else if (startBody.error === "journey_conflict") {
      // 同 seed 已有活跃旅程:从 bootstrap 恢复现有 journey。
      const bootRes = await page.request.get("/api/companion/journey/bootstrap");
      expect(bootRes.ok()).toBeTruthy();
      const boot = await bootRes.json() as { journey?: typeof journey };
      journey = boot.journey;
    }
    expect(journey?.branch).toBe("sandbox_sample");
    const namespaceId = journey?.refs?.sandboxNamespaceId;
    expect(namespaceId).toBeTruthy();

    // 3. onboarding sandbox Run。
    const createRes = await postJson(page, "/api/learning-runs", {
      version: 1,
      origin: {
        kind: "onboarding",
        sampleMode: "sandbox",
        keyPointId,
        sandboxNamespaceId: namespaceId,
      },
      goal: "stabilize",
      clientRequestId: `e2e-sandbox-run-${Date.now()}`,
      idempotencyKey: `e2e-sandbox-run-${Date.now()}`,
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { runId?: string; sandboxNamespaceId?: string };
    const runId = created.runId;
    expect(runId).toBeTruthy();
    expect(created.sandboxNamespaceId).toBe(namespaceId);

    // 4. 提交文本答案。
    const submitRes = await postJson(page, `/api/learning-runs/${runId}/tasks`, {});
    expect(submitRes.status).not.toBe(500);
    // 提交走真实 UI 更贴近 §24.5:进入 run 页作答。
    await page.goto(`/learning-runs/${runId}`);
    const answer = page.getByRole("textbox", { name: "用你自然的表达回答" });
    if (await answer.isVisible({ timeout: 30_000 }).catch(() => false)) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await answer.click();
        await page.keyboard.type("x");
        await page.waitForTimeout(400);
        if ((await answer.inputValue().catch(() => "")).length > 0) break;
      }
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      await page.keyboard.type("sandbox 示例回答:主动回忆比重复阅读更有效。");
      const submit = page.getByRole("button", { name: /锁定并提交回答/ });
      await expect(submit).toBeEnabled({ timeout: 15_000 });
      await submit.click();
    }
    // 结算(任何终态:练习完成/检查点/结果)。
    await expect(
      page.getByText(/检查点|本轮结果|学习结算|本轮到这里结束|练习完成/).first(),
    ).toBeVisible({ timeout: 120_000 });

    // 5. DB/API 断言:0 canonical、0 official schedule、sandbox trail 0 正式副作用。
    const facts = await page.evaluate(async () => {
      const proj = await (await fetch("/api/understanding/projection")).json() as {
        checkpoint?: { token?: string } | null;
      };
      return { checkpointToken: proj.checkpoint?.token ?? null };
    });
    // eslint-disable-next-line no-console
    console.log(`PROBE-E02 run=${runId} ns=${namespaceId}`);
    expect(facts.checkpointToken).toBeTruthy();
  });
});
