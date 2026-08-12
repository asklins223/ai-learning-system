import type { Page } from "@playwright/test";
import { test, expect, type SeedCredentials } from "../lib/fixtures";

const PRIMARY_ACTION = "开始巩固练习";
const EVIDENCE_ACTION = "查看原文依据";

async function resolveCardId(
  page: Page,
  seedCredentials: SeedCredentials,
): Promise<string> {
  const seededCardId = seedCredentials.workspaces[0]?.cardIds?.[0];
  if (seededCardId) return seededCardId;
  const response = await page.evaluate(async () => {
    const result = await fetch("/api/cards");
    if (!result.ok) return undefined;
    const payload = await result.json() as { items?: Array<{ id?: string }> };
    return payload.items?.[0]?.id;
  });
  if (!response) {
    throw new Error("the authenticated workspace must expose a card for the Companion practice");
  }
  return response;
}

async function expectPracticeSurface(page: Page): Promise<void> {
  const main = page.locator("main[data-ui='companion-practice-page'][data-stage-state]");
  await expect(main).toBeVisible({ timeout: 15_000 });
  await expect(main.getByText("巩固练习", { exact: true }).first()).toBeVisible();
  await expect(page.locator("#companion-answer")).toBeVisible();

  // 巩固练习是一张单列任务页，不再用角色图和「航程」叙事包裹表单。
  await expect(main.locator('img[alt="学习伴星"]')).toHaveCount(0);
  await expect(main.locator(".companion-stage-intro, .companion-stage-portrait"))
    .toHaveCount(0);
  await expect(main.locator("aside")).toHaveCount(0);
  await expect(main.getByText(/航程/)).toHaveCount(0);

  const renderedColumns = await main.locator(".companion-stage-content").evaluate((element) =>
    window.getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).filter(Boolean)
  );
  expect(renderedColumns).toHaveLength(1);

  // 各视口下标题和作答区都应落在同一水平列，而不是左右分栏。
  const headingBox = await main.locator("h1").boundingBox();
  const answerBox = await page.locator("#companion-answer").boundingBox();
  expect(headingBox).not.toBeNull();
  expect(answerBox).not.toBeNull();
  const horizontalOverlap = Math.min(
    headingBox!.x + headingBox!.width,
    answerBox!.x + answerBox!.width,
  ) - Math.max(headingBox!.x, answerBox!.x);
  expect(horizontalOverlap).toBeGreaterThan(0);
}

async function leavePractice(page: Page): Promise<void> {
  await page.getByRole("button", { name: "退出练习" }).click();
}

async function mockCreateSessionError(
  page: Page,
  code: "AI_CONSENT_REQUIRED" | "ai_consent_required" | "SESSION_LIMIT_REACHED",
  message: string,
  activeSessionId?: string,
): Promise<void> {
  await page.route("**/api/learning-sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: code.toLowerCase() === "ai_consent_required" ? 403 : 409,
      contentType: "application/json",
      body: JSON.stringify({ error: code, message, activeSessionId }),
    });
  });
}

/**
 * Authenticated consolidation-practice vertical slice.
 *
 * These journeys deliberately drive the real authenticated browser. Typed
 * create errors and the asynchronous assessment phases use narrow response
 * mocks so every recovery/processing state is deterministic and no test
 * pretends that an assessment completed before the server says `committed`.
 *
 * @pr
 */
test.describe.serial("authenticated consolidation practice journeys", () => {
  test("learning card keeps exactly one primary practice action and one evidence action @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    const page = authedPage;
    const cardId = await resolveCardId(page, seedCredentials);

    await page.goto(`/cards/${cardId}`);
    await expect(page.locator(".card-detail-desk")).toBeVisible({ timeout: 15_000 });

    const actions = page.locator("[data-ui='lc-learning-card-actions']");
    await expect(actions).toBeVisible();
    await expect(actions.getByRole("button")).toHaveCount(2);
    await expect(actions.locator("[data-ui='lc-card-primary-action']"))
      .toHaveAccessibleName(PRIMARY_ACTION);
    await expect(actions.locator("[data-ui='lc-card-evidence-action']"))
      .toHaveAccessibleName(EVIDENCE_ACTION);
    await expect(actions.getByRole("button", { name: /朗读|问一问|开始.*航程/ })).toHaveCount(0);

    // 操作区可以说明下一步，但不再重复学习卡本身的标题与核心概述。
    const cardTitle = (await page.locator("#card-detail-title").textContent())?.trim() ?? "";
    const cardSummary = (await page.locator(".card-detail-core-understanding p").textContent())
      ?.trim() ?? "";
    expect(cardTitle).not.toBe("");
    expect(cardSummary).not.toBe("");
    await expect(actions.getByText(cardTitle, { exact: true })).toHaveCount(0);
    await expect(actions.getByText(cardSummary, { exact: true })).toHaveCount(0);
  });

  test("Companion practice is a single-column task without character or journey chrome @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    const page = authedPage;
    const cardId = await resolveCardId(page, seedCredentials);

    await page.goto(`/cards/${cardId}`);
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    await page.route("**/api/learning-sessions", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      await createGate;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: PRIMARY_ACTION, exact: true }).click();
    const practicePage = page.locator("main[data-ui='companion-practice-page']");
    await expect(practicePage).toHaveAttribute("data-stage-state", "creating");
    await expect(
      practicePage.getByRole("status").filter({ hasText: "正在准备练习…" }),
    ).toBeVisible();
    releaseCreate();
    await expect(page).toHaveURL(
      new RegExp(`/cards/${cardId}/companion\\?keyPoint=[^&]+&session=[^&]+`),
    );
    await page.unroute("**/api/learning-sessions");
    await expectPracticeSurface(page);

    await leavePractice(page);
    await expect(page).toHaveURL(new RegExp(`/cards/${cardId}$`));
  });

  test("answer submission moves from assessment_pending to assessment_complete @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    const page = authedPage;
    const cardId = await resolveCardId(page, seedCredentials);

    await page.goto(`/cards/${cardId}`);
    await page.getByRole("button", { name: PRIMARY_ACTION, exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/cards/${cardId}/companion\\?keyPoint=[^&]+&session=[^&]+`),
    );
    await expectPracticeSurface(page);

    const stageUrl = new URL(page.url());
    const sessionId = stageUrl.searchParams.get("session");
    expect(sessionId).toBeTruthy();
    const sessionResponse = await page.request.get(`/api/learning-sessions/${sessionId}`);
    expect(sessionResponse.ok()).toBeTruthy();
    const session = await sessionResponse.json() as {
      activeEpisode?: {
        episodeId?: string;
        keyPointId?: string;
        status?: string;
        processingPhase?: string;
      } | null;
      episodes?: Array<{
        episodeId?: string;
        keyPointId?: string;
        status?: string;
        processingPhase?: string;
      }>;
      [key: string]: unknown;
    };
    const episode = session.activeEpisode ?? session.episodes?.[0];
    expect(episode?.episodeId).toBeTruthy();

    const artifactId = "00000000-0000-4000-8000-000000000101";
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    await page.route(
      `**/api/learning-sessions/${sessionId}/episodes/${episode!.episodeId}/answer`,
      async (route) => {
        await answerGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            artifact: {
              artifactId,
              episodeId: episode!.episodeId,
              keyPointId: episode!.keyPointId,
              probeId: "00000000-0000-4000-8000-000000000102",
              modality: "text_or_mixed",
              contentHash: "e2e-answer-content-hash",
              status: "locked",
              answerLockedAt: new Date().toISOString(),
            },
            episodeStatus: "active",
            processingPhase: "assessment_pending",
          }),
        });
      },
    );

    const processingPhases = [
      "assessment_pending",
      "assessment_complete",
      "committed",
    ] as const;
    let pollCount = 0;
    await page.route(`**/api/learning-sessions/${sessionId}`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const processingPhase = processingPhases[Math.min(pollCount, processingPhases.length - 1)];
      pollCount += 1;
      const updateEpisode = <T extends typeof episode>(value: T): T => ({
        ...value,
        status: processingPhase === "committed" ? "completed" : "active",
        processingPhase,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...session,
          activeEpisode: session.activeEpisode ? updateEpisode(session.activeEpisode) : null,
          episodes: (session.episodes ?? []).map((item) =>
            item.episodeId === episode!.episodeId ? updateEpisode(item) : item
          ),
        }),
      });
    });

    await page.locator("#companion-answer").fill("我先用自己的话说明这张卡的核心理解。");
    const answerResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST"
        && /\/api\/learning-sessions\/[^/]+\/episodes\/[^/]+\/answer$/.test(url.pathname);
    });
    await page.getByRole("button", { name: "提交回答", exact: true }).click();
    const practicePage = page.locator("main[data-ui='companion-practice-page']");
    await expect(practicePage).toHaveAttribute("data-stage-state", "submitting");
    await expect(
      practicePage.getByRole("status").filter({ hasText: "正在保存你的回答…" }),
    ).toBeVisible();
    releaseAnswer();
    const answerResponse = await answerResponsePromise;
    expect(answerResponse.ok()).toBeTruthy();
    const answerPayload = await answerResponse.json() as { processingPhase?: string };
    expect(answerPayload.processingPhase).toBe("assessment_pending");

    await expect(practicePage).toHaveAttribute("data-processing-phase", "assessment_pending");
    await expect(
      practicePage.getByRole("status").filter({
        hasText: "回答已保存，正在等待独立评估…",
      }),
    ).toBeVisible();

    await expect(practicePage).toHaveAttribute(
      "data-processing-phase",
      "assessment_complete",
      { timeout: 45_000 },
    );
    await expect(
      practicePage.getByRole("status").filter({ hasText: "评估已完成，正在写入结果…" }),
    ).toBeVisible();

    await expect(practicePage).toHaveAttribute("data-processing-phase", "committed", {
      timeout: 45_000,
    });
    const resultStatus = practicePage.getByRole("status").filter({ hasText: "巩固练习已完成" });
    await expect(resultStatus.getByText("巩固练习已完成", { exact: true })).toBeVisible();

    await resultStatus.getByRole("button", { name: "返回学习卡", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/cards/${cardId}$`));
    await expect(page.locator(".card-detail-desk")).toBeVisible({ timeout: 15_000 });
  });

  test("AI consent error codes lead to the AI agreement settings @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    const page = authedPage;
    const cardId = await resolveCardId(page, seedCredentials);

    for (const code of ["AI_CONSENT_REQUIRED", "ai_consent_required"] as const) {
      await page.goto(`/cards/${cardId}`);
      await mockCreateSessionError(page, code, "AI consent not signed");
      await page.getByRole("button", { name: PRIMARY_ACTION, exact: true }).click();

      const practicePage = page.locator("main[data-ui='companion-practice-page']");
      await expect(practicePage).toHaveAttribute("data-error-code", code);
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("需要先签署 AI 使用协议");
      await expect(alert.getByRole("button", { name: "前往协议设置", exact: true })).toBeVisible();
      await page.unroute("**/api/learning-sessions");
    }

    await page.getByRole("button", { name: "前往协议设置", exact: true }).click();
    await expect(page).toHaveURL(/\/settings#model$/);
  });

  test("SESSION_LIMIT_REACHED explains that another practice is active @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    const page = authedPage;
    const cardId = await resolveCardId(page, seedCredentials);
    const blockedSessionId = "00000000-0000-4000-8000-000000000199";

    await page.goto(`/cards/${cardId}`);
    await mockCreateSessionError(
      page,
      "SESSION_LIMIT_REACHED",
      "每用户同时只允许 1 个 active 学习会话",
      blockedSessionId,
    );
    await page.getByRole("button", { name: PRIMARY_ACTION, exact: true }).click();

    const practicePage = page.locator("main[data-ui='companion-practice-page']");
    await expect(practicePage).toHaveAttribute("data-error-code", "SESSION_LIMIT_REACHED");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("已有巩固练习进行中");
    await expect(alert).not.toContainText("稍后再试");
    const recovery = alert.getByRole("button", {
      name: "结束旧练习并重新开始",
      exact: true,
    });
    await expect(recovery).toBeVisible();
    await expect(alert.getByRole("button", { name: "返回学习卡", exact: true })).toBeVisible();

    await page.unroute("**/api/learning-sessions");
    await page.route(`**/api/learning-sessions/${blockedSessionId}/end`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessionId: blockedSessionId, status: "ended" }),
      });
    });
    const endRequest = page.waitForRequest((request) =>
      request.method() === "POST"
      && request.url().endsWith(`/api/learning-sessions/${blockedSessionId}/end`)
    );
    await recovery.click();
    await endRequest;
    await page.unroute(`**/api/learning-sessions/${blockedSessionId}/end`);
    await expectPracticeSurface(page);
    await leavePractice(page);
  });

  test("review, today and star map do not add competing practice actions @pr", async ({
    authedPage,
  }) => {
    const page = authedPage;

    await page.goto("/review");
    await expect(page.locator(".review-v06-companion-entry")).toHaveCount(0);
    await expect(page.locator("a[href*='/companion?']")).toHaveCount(0);

    await page.goto("/today");
    await expect(page.locator(".today-context-companion-link")).toHaveCount(0);
    await expect(page.locator("a[href*='/companion?']")).toHaveCount(0);

    await page.goto("/graph");
    await expect(page.locator("a[href*='/companion?']")).toHaveCount(0);
  });
});
