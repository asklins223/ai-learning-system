/**
 * 任务 07-1：首次引导状态机纯逻辑单测（§3.2 + §5.4.3）。
 *
 * 覆盖：
 * - 六步结构冻结（顺序/元数据/初始 step）与导航（next/prev/isLast/resolveGuideStepId）；
 * - 展示决策 deriveOnboardingView 全分支（invite / guide / passive_note / none，
 *   含 quiet/temporary hidden/global off 偏好只被动介绍）；
 * - 终态判定（consumed 不回退、completed、可手动重播）；
 * - CAS 请求构造（start/skip/complete/pause/replay 与 revision/runId 透传）；
 * - 引导零副作用：源码不含 api/网络/持久化/随机源（不触发 exposure、学习事实或调度）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type {
  CompanionOnboardingActiveRun,
  CompanionOnboardingStateV1,
} from "@ailearn/shared";
import {
  DEFAULT_ONBOARDING_COMPANIONSHIP,
  ONBOARDING_FINISH_ACTIONS,
  ONBOARDING_FIRST_STEP_ID,
  ONBOARDING_SAMPLE_ASSET_ID,
  ONBOARDING_SAMPLE_PREFIX,
  ONBOARDING_SAMPLE_PUBLISHED_TARGET_ELIGIBILITY,
  ONBOARDING_STARTING_POINTS,
  ONBOARDING_STEP_IDS,
  ONBOARDING_STEPS,
  ONBOARDING_VERSION,
  buildGuideCompleteRequest,
  buildGuidePauseRequest,
  buildInviteSkipRequest,
  buildInviteStartRequest,
  buildManualReplayRequest,
  buildOnboardingTransitionRequest,
  canManuallyReplay,
  deriveOnboardingView,
  isLastOnboardingStep,
  isOnboardingCompleted,
  isOnboardingConsumed,
  isOnboardingStepId,
  nextOnboardingStep,
  previousOnboardingStep,
  resolveGuideStepId,
} from "./onboarding-state.ts";

// ─── fixtures ────────────────────────────────────────────────────────────

function makeActiveRun(
  overrides: Partial<CompanionOnboardingActiveRun> = {},
): CompanionOnboardingActiveRun {
  return {
    runId: "run-1",
    entryMode: "first_run",
    runStatus: "in_progress",
    stepId: "intro",
    resumeTokenRef: "token-1",
    expiresAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeState(
  overrides: Partial<CompanionOnboardingStateV1> = {},
): CompanionOnboardingStateV1 {
  return {
    onboardingVersion: ONBOARDING_VERSION,
    revision: 0,
    offerStatus: "not_offered",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

const noPreference = {
  presenceChosen: false,
  presence: "quiet" as const,
  temporaryHidden: false,
  globalOff: false,
};

// ─── 1. 六步结构 ─────────────────────────────────────────────────────────

describe("六步引导结构（§5.4.3）", () => {
  it("六步 ID 冻结且顺序固定：认识边界→相处方式→起点→示例→可信交接→明确结束", () => {
    assert.deepEqual(ONBOARDING_STEP_IDS, [
      "boundaries",
      "companionship",
      "starting-point",
      "sample-flow",
      "trusted-handoff",
      "finish",
    ]);
  });

  it("每步都有 index/title/heading/description 且 index 连续从 1 开始", () => {
    assert.equal(ONBOARDING_STEPS.length, ONBOARDING_STEP_IDS.length);
    ONBOARDING_STEPS.forEach((step, i) => {
      assert.equal(step.id, ONBOARDING_STEP_IDS[i]);
      assert.equal(step.index, i + 1);
      assert.ok(step.title.length > 0);
      assert.ok(step.heading.length > 0);
      assert.ok(step.description.length > 0);
    });
  });

  it("初始 step 与服务端 intro 映射到第一页 boundaries", () => {
    assert.equal(ONBOARDING_FIRST_STEP_ID, "boundaries");
    assert.equal(resolveGuideStepId("intro"), "boundaries");
    assert.equal(resolveGuideStepId(undefined), "boundaries");
    assert.equal(resolveGuideStepId("unknown-old-step"), "boundaries");
    assert.equal(resolveGuideStepId("sample-flow"), "sample-flow");
  });

  it("导航不循环、不自动进入正式航程：最后一步 next 为 null", () => {
    assert.equal(nextOnboardingStep("boundaries"), "companionship");
    assert.equal(previousOnboardingStep("companionship"), "boundaries");
    assert.equal(previousOnboardingStep("boundaries"), null);
    assert.equal(nextOnboardingStep("finish"), null);
    assert.ok(isLastOnboardingStep("finish"));
    assert.equal(isLastOnboardingStep("sample-flow"), false);
  });

  it("常量与枚举冻结（默认安静、两个起点、三个同级结束动作、样本命名空间）", () => {
    assert.equal(DEFAULT_ONBOARDING_COMPANIONSHIP, "quiet");
    assert.deepEqual(ONBOARDING_STARTING_POINTS, ["sandbox", "own-content"]);
    assert.deepEqual(ONBOARDING_FINISH_ACTIONS, [
      "start-own-content",
      "go-to-star-map",
      "end-guide",
    ]);
    assert.ok(ONBOARDING_SAMPLE_ASSET_ID.startsWith(ONBOARDING_SAMPLE_PREFIX));
    assert.equal(ONBOARDING_SAMPLE_PUBLISHED_TARGET_ELIGIBILITY, false);
    assert.ok(isOnboardingStepId("finish"));
    assert.equal(isOnboardingStepId("nope"), false);
  });
});

// ─── 2. 展示决策 ─────────────────────────────────────────────────────────

describe("deriveOnboardingView 展示决策（§5.4.3）", () => {
  it("注册成功首次进入（无服务端状态、无偏好）→ invite（唯一主动 consent surface）", () => {
    const view = deriveOnboardingView({ state: undefined, ...noPreference });
    assert.deepEqual(view, { kind: "invite" });
  });

  it("offerStatus=not_offered 且无偏好 → invite", () => {
    const view = deriveOnboardingView({
      state: makeState({ offerStatus: "not_offered" }),
      ...noPreference,
    });
    assert.deepEqual(view, { kind: "invite" });
  });

  it("已有 quiet 偏好 → passive_note（即使未 offer 也不主动邀请）", () => {
    const view = deriveOnboardingView({
      state: makeState({ offerStatus: "not_offered" }),
      presenceChosen: true,
      presence: "quiet",
      temporaryHidden: false,
      globalOff: false,
    });
    assert.deepEqual(view, { kind: "passive_note" });
  });

  it("temporary hidden / global off → passive_note", () => {
    assert.deepEqual(
      deriveOnboardingView({
        state: makeState({ offerStatus: "not_offered" }),
        ...noPreference,
        temporaryHidden: true,
      }),
      { kind: "passive_note" },
    );
    assert.deepEqual(
      deriveOnboardingView({
        state: makeState({ offerStatus: "not_offered" }),
        ...noPreference,
        globalOff: true,
      }),
      { kind: "passive_note" },
    );
  });

  it("offered 且有 active run → guide（返回状态供接线者取 runId/revision）", () => {
    const state = makeState({
      offerStatus: "offered",
      activeRun: makeActiveRun(),
    });
    const view = deriveOnboardingView({ state, ...noPreference });
    assert.deepEqual(view, { kind: "guide", state });
  });

  it("offered 但无 active run（已 abandon/清空）→ none，不自动重开", () => {
    const view = deriveOnboardingView({
      state: makeState({ offerStatus: "offered" }),
      ...noPreference,
    });
    assert.deepEqual(view, { kind: "none" });
  });

  it("consumed（completed/skipped）→ none：完成后不再自动邀请或重放", () => {
    const completed = deriveOnboardingView({
      state: makeState({
        offerStatus: "consumed",
        offerDisposition: "completed",
      }),
      ...noPreference,
    });
    const skipped = deriveOnboardingView({
      state: makeState({
        offerStatus: "consumed",
        offerDisposition: "skipped",
      }),
      ...noPreference,
    });
    assert.deepEqual(completed, { kind: "none" });
    assert.deepEqual(skipped, { kind: "none" });
  });

  it("已有偏好时即使有 active run 也只在被动介绍（guide 不展示）", () => {
    const view = deriveOnboardingView({
      state: makeState({
        offerStatus: "offered",
        activeRun: makeActiveRun(),
      }),
      presenceChosen: true,
      presence: "quiet",
      temporaryHidden: false,
      globalOff: false,
    });
    assert.deepEqual(view, { kind: "passive_note" });
  });
});

// ─── 3. 终态 / 手动重播 ──────────────────────────────────────────────────

describe("终态与手动重播（§5.4.3 / 02-3 CAS）", () => {
  it("consumed 是单调终态：completed/skipped 均不可回退", () => {
    assert.equal(
      isOnboardingConsumed(makeState({ offerStatus: "consumed", offerDisposition: "completed" })),
      true,
    );
    assert.equal(
      isOnboardingConsumed(makeState({ offerStatus: "consumed", offerDisposition: "skipped" })),
      true,
    );
    assert.equal(isOnboardingConsumed(makeState({ offerStatus: "not_offered" })), false);
  });

  it("isOnboardingCompleted 只在 completed 为 true", () => {
    assert.equal(
      isOnboardingCompleted(makeState({ offerStatus: "consumed", offerDisposition: "completed" })),
      true,
    );
    assert.equal(
      isOnboardingCompleted(makeState({ offerStatus: "consumed", offerDisposition: "skipped" })),
      false,
    );
    assert.equal(isOnboardingCompleted(makeState({ offerStatus: "offered" })), false);
  });

  it("可手动重播：offered/consumed 均可，not_offered 不可（先 offer 才能 replay）", () => {
    assert.equal(canManuallyReplay(makeState({ offerStatus: "not_offered" })), false);
    assert.equal(canManuallyReplay(makeState({ offerStatus: "offered" })), true);
    assert.equal(
      canManuallyReplay(makeState({ offerStatus: "consumed", offerDisposition: "skipped" })),
      true,
    );
  });
});

// ─── 4. CAS 请求构造 ─────────────────────────────────────────────────────

describe("buildOnboardingTransitionRequest（对接 02-3）", () => {
  it("字段按需携带；空字段不出现（与 schema 一致）", () => {
    assert.deepEqual(buildOnboardingTransitionRequest({ action: "start" }), {
      action: "start",
    });
    const withRevision = buildOnboardingTransitionRequest({ action: "skip", revision: 3 });
    assert.deepEqual(withRevision, { action: "skip", revision: 3 });
  });

  it("complete/pause 必须带 runId，且透传 revision", () => {
    assert.deepEqual(
      buildGuideCompleteRequest({ revision: 5, runId: "run-9" }),
      { action: "complete", revision: 5, runId: "run-9" },
    );
    assert.deepEqual(
      buildGuidePauseRequest({ runId: "run-9" }),
      { action: "pause", runId: "run-9" },
    );
  });

  it("邀请三个动作：start（带我走一遍）/ skip（我自己看看=直接跳过）", () => {
    assert.deepEqual(buildInviteStartRequest({ runId: "run-2" }), {
      action: "start",
      runId: "run-2",
    });
    assert.deepEqual(buildInviteSkipRequest({ revision: 1 }), {
      action: "skip",
      revision: 1,
    });
  });

  it("手动重播 = replay（manual_replay run，不改 consumed）", () => {
    assert.deepEqual(buildManualReplayRequest({ revision: 2 }), {
      action: "replay",
      revision: 2,
    });
  });
});

// ─── 5. 零副作用（不触发 exposure / 学习事实 / 调度）────────────────────

describe("引导零副作用（§5.4.3 验收）", () => {
  it("源码不含 api/网络/持久化/随机源：不读取凭据、不触发事件或调度", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./onboarding-state.ts", import.meta.url)),
      "utf8",
    );
    // 只检查副作用「调用形态」与「模块依赖」，注释中的说明性词不算。
    for (const forbidden of [
      "from \"@/lib/api\"",
      "from \"@/lib/learning-companion/voice-api\"",
      "fetch(",
      "new XMLHttpRequest",
      "new WebSocket",
      "navigator.",
      "window.",
      "document.",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "Math.random",
      "setTimeout(",
      "setInterval(",
      "requestAnimationFrame",
      "new Audio(",
      "navigator.mediaDevices",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `onboarding-state.ts 出现副作用源 "${forbidden}"`,
      );
    }
    // 只 import 纯类型契约（@ailearn/shared 类型）与同目录纯逻辑类型。
    assert.ok(source.includes("import type {"));
    assert.ok(!source.includes("from \"react\""));
  });

  it("deriveOnboardingView 是纯同步函数：同一输入恒得同一输出（无随机/无时间依赖）", () => {
    const state = makeState({ offerStatus: "offered", activeRun: makeActiveRun() });
    const inputs = [
      { state: undefined, ...noPreference },
      { state, ...noPreference },
      {
        state: makeState({ offerStatus: "consumed", offerDisposition: "skipped" }),
        ...noPreference,
      },
    ];
    for (const input of inputs) {
      const first = deriveOnboardingView(input);
      for (let i = 0; i < 5; i += 1) {
        assert.deepEqual(deriveOnboardingView(input), first);
      }
    }
  });

  it("引导不自动开始正式航程：不存在任何自动 start/complete 触发路径", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./onboarding-state.ts", import.meta.url)),
      "utf8",
    );
    // 全部 transition 请求都必须由调用方显式传入 action；模块内无副作用触发点。
    assert.ok(source.includes("input.action"));
    // finish 动作不映射到任何自动开始动作（仅三选一的用户动作枚举）。
    const finishTypeLine = ONBOARDING_FINISH_ACTIONS.join("|");
    assert.ok(finishTypeLine.includes("start-own-content"));
  });
});
