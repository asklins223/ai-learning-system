/**
 * 阶段 07（W6）任务 07-7：Tutor detour 编排 单元测试（§5.7）。
 *
 * 覆盖（验收，07-w6 任务 07-7）：
 * - trusted → practice 原子切换：trusted challenge（让我试试）中提问 → 先记录
 *   assistance/exposure 再开放 Tutor 权限，然后才创建有界 detour（顺序断言）；
 *   together/free_explore 不切换直接创建；缺切换参数 → missing_switch_params；
 * - 原子性：切换或 detour 保存任一步抛错 → 整体失败（transaction 不产生 detour）；
 * - 有界 detour 创建/结束：绑定 sessionId+episodeId+targetId+questionId；固定结束
 *   动作只有 return_to_origin / end_session；ended 终态不可再次动作；
 *   非法结束动作 / detour 不存在 → 拒绝；
 * - 问题标记是 Should 动作：shouldFlag 未开 → save_marker_flag_off；开 → 保存；
 * - 不建第二套无限 message API：TutorDetourRecord 无 messages 数组；
 * - Session 外提问：只有明确选定 published Key Point 才创建 scoped exploration
 *   Session，否则请用户选择材料。
 *
 * 全部走内存 repo + fake enterPractice（不依赖真实 DB / 不依赖 presence-control 的
 * 真实实现），纯逻辑可测。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  EnterPracticeModeInput,
  EnterPracticeModeResult,
  LearningForegroundState,
  LearningFrontRepo,
  LearningScope,
} from "../companion-shell/presence-control.ts";
import {
  TutorDetourError,
  advanceTutorDetourTurn,
  buildTutorDetourRecord,
  createScopedTutorDetour,
  endScopedTutorDetour,
  resolveOutsideSessionEntry,
  transitionTutorDetourStatus,
  type CreateScopedTutorDetourInput,
  type TutorDetourDeps,
  type TutorDetourRecord,
  type TutorDetourRepo,
} from "./tutor-detour.ts";

// ─── fixtures / fakes ────────────────────────────────────────────────────

const SCOPE: LearningScope = { workspaceId: "ws-1", userId: "user-1" };

class FakeFrontRepo implements LearningFrontRepo {
  readonly state: LearningForegroundState | null;
  constructor(state: LearningForegroundState | null) {
    this.state = state;
  }
  async readForegroundState(): Promise<LearningForegroundState | null> {
    return this.state;
  }
  async recordAssistanceAndExposure(): Promise<void> {}
  async openTutorPermission(): Promise<void> {}
  async writeForegroundState(): Promise<void> {}
}

class FakeDetourRepo implements TutorDetourRepo {
  readonly records = new Map<string, TutorDetourRecord>();
  async saveDetour(_scope: LearningScope, record: TutorDetourRecord): Promise<void> {
    this.records.set(record.detourId, record);
  }
  async findDetour(_scope: LearningScope, detourId: string): Promise<TutorDetourRecord | null> {
    return this.records.get(detourId) ?? null;
  }
  async updateDetour(_scope: LearningScope, record: TutorDetourRecord): Promise<void> {
    this.records.set(record.detourId, record);
  }
}

/** 事件日志 fake：模拟 presence-control.enterPracticeMode 的原子顺序。 */
function makeEnterPractice(log: string[]) {
  return async (_input: EnterPracticeModeInput): Promise<EnterPracticeModeResult> => {
    log.push("enterPractice:assistance_and_exposure");
    log.push("enterPractice:tutor_permission");
    return {
      state: "together",
      assistanceRecorded: true,
      tutorPermissionOpened: true,
    };
  };
}

function makeDeps(overrides?: {
  foreground?: LearningForegroundState | null;
  log?: string[];
  saveDetourThrows?: boolean;
  transactionThrows?: boolean;
  detourRepo?: FakeDetourRepo;
}): {
  deps: TutorDetourDeps;
  repo: FakeDetourRepo;
  log: string[];
} {
  const log = overrides?.log ?? [];
  const repo = overrides?.detourRepo ?? new FakeDetourRepo();
  const originalSave = repo.saveDetour.bind(repo);
  if (overrides?.saveDetourThrows) {
    repo.saveDetour = async () => {
      throw new Error("saveDetour boom");
    };
  } else {
    repo.saveDetour = async (scope, record) => {
      log.push("detourRepo:saveDetour");
      await originalSave(scope, record);
    };
  }
  const deps: TutorDetourDeps = {
    repo: new FakeFrontRepo(overrides?.foreground ?? null),
    transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      log.push("transaction:begin");
      const result = await fn();
      log.push("transaction:commit");
      return result;
    },
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    detourRepo: repo,
    enterPractice: makeEnterPractice(log),
  };
  return { deps, repo, log };
}

function detourInput(overrides?: Partial<CreateScopedTutorDetourInput>): CreateScopedTutorDetourInput {
  return {
    scope: SCOPE,
    detourId: "detour-1",
    sessionId: "sess-1",
    episodeId: "ep-1",
    targetId: "kp-1",
    questionId: "q-1",
    ...overrides,
  };
}

function recordFixture(overrides?: Partial<TutorDetourRecord>): TutorDetourRecord {
  return {
    ...buildTutorDetourRecord({
      detourId: "detour-1",
      sessionId: "sess-1",
      episodeId: "ep-1",
      targetId: "kp-1",
      questionId: "q-1",
      now: new Date("2026-08-08T00:00:00.000Z"),
    }),
    ...overrides,
  };
}

// ─── 1. 有界 detour 记录：绑定四元组 + 无无限 message API ─────────────────

describe("buildTutorDetourRecord", () => {
  it("绑定 sessionId+episodeId+targetId+questionId，status=active，无 messages 数组", () => {
    const record = recordFixture();
    assert.equal(record.detourId, "detour-1");
    assert.equal(record.sessionId, "sess-1");
    assert.equal(record.episodeId, "ep-1");
    assert.equal(record.targetId, "kp-1");
    assert.equal(record.questionId, "q-1");
    assert.equal(record.status, "active");
    assert.equal(record.endReason, null);
    assert.equal(record.questionMarkerSaved, false);
    // 不建第二套无限 message API：记录无 messages 数组（前台不保留无限滚动历史）。
    assert.ok(!("messages" in record));
  });
});

// ─── 2. 生命周期状态机：固定结束动作 / 终态 / 问题标记 ─────────────────────

describe("transitionTutorDetourStatus", () => {
  it("固定结束动作只有 return_to_origin 与 end_session", () => {
    for (const endReason of ["return_to_origin", "end_session"] as const) {
      const next = transitionTutorDetourStatus(recordFixture(), { endReason });
      assert.equal(next.allowed, true);
      assert.equal(next.record.status, "ended");
      assert.equal(next.record.endReason, endReason);
      assert.ok(next.record.endedAt);
    }
  });

  it("ended 终态不可再次动作", () => {
    const ended = transitionTutorDetourStatus(recordFixture(), {
      endReason: "return_to_origin",
    }).record;
    const again = transitionTutorDetourStatus(ended, { endReason: "end_session" });
    assert.equal(again.allowed, false);
    assert.ok(again.reason?.includes("已结束"));
  });

  it("非法结束动作 → allowed=false", () => {
    const next = transitionTutorDetourStatus(recordFixture(), {
      endReason: "save_question_marker" as never,
    });
    assert.equal(next.allowed, false);
    assert.ok(next.reason?.includes("非法结束动作"));
  });

  it("保存问题标记是 Should 动作：shouldFlag 未开拒绝，开则保存", () => {
    const off = transitionTutorDetourStatus(recordFixture(), {
      endReason: "return_to_origin",
      saveQuestionMarker: true,
      shouldFlag: false,
    });
    assert.equal(off.allowed, false);
    assert.ok(off.reason?.includes("Should"));

    const on = transitionTutorDetourStatus(recordFixture(), {
      endReason: "return_to_origin",
      saveQuestionMarker: true,
      shouldFlag: true,
    });
    assert.equal(on.allowed, true);
    assert.equal(on.record.questionMarkerSaved, true);
  });
});

describe("advanceTutorDetourTurn", () => {
  it("最多两次说明，只递增计数且不产生 messages", () => {
    const first = advanceTutorDetourTurn(recordFixture());
    assert.equal(first.allowed, true);
    assert.equal(first.record.turnCount, 1);
    assert.equal(first.record.maxTurns, 2);
    assert.ok(!("messages" in first.record));

    const second = advanceTutorDetourTurn(first.record);
    assert.equal(second.allowed, true);
    assert.equal(second.record.turnCount, 2);

    const third = advanceTutorDetourTurn(second.record);
    assert.equal(third.allowed, false);
    assert.ok(third.reason?.includes("最多支持两次"));
  });

  it("已结束 detour 不再接受回合", () => {
    const ended = transitionTutorDetourStatus(recordFixture(), {
      endReason: "return_to_origin",
    }).record;
    const result = advanceTutorDetourTurn(ended);
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("已结束"));
  });
});

// ─── 3. 创建有界 detour：trusted → practice 原子切换 ─────────────────────

describe("createScopedTutorDetour", () => {
  it("trusted challenge（让我试试）：先记录 assistance/exposure 再开放权限，最后才创建 detour", async () => {
    const log: string[] = [];
    const { deps, repo } = makeDeps({ foreground: "let_me_try", log });
    const result = await createScopedTutorDetour(
      deps,
      detourInput({
        deviceSessionId: "dev-1",
        deviceSurfaceEpoch: 3,
        accountEpoch: 3,
        contentExposureKey: "cex:abc",
        userActionNonce: "nonce-12345678",
      }),
    );
    assert.equal(result.switchedFromTrustedToPractice, true);
    assert.equal(result.foregroundBefore, "let_me_try");
    // 原子顺序：assistance/exposure → tutor 权限 → detour 保存，全部在同一事务内。
    assert.deepEqual(log, [
      "transaction:begin",
      "enterPractice:assistance_and_exposure",
      "enterPractice:tutor_permission",
      "detourRepo:saveDetour",
      "transaction:commit",
    ]);
    assert.ok(repo.records.has("detour-1"));
    assert.equal(repo.records.get("detour-1")!.status, "active");
  });

  it("together（含默认未记录）：不切换，直接创建 detour", async () => {
    for (const foreground of [null, "together"] as const) {
      const log: string[] = [];
      const { deps, repo } = makeDeps({ foreground, log });
      const result = await createScopedTutorDetour(deps, detourInput());
      assert.equal(result.switchedFromTrustedToPractice, false);
      assert.equal(result.foregroundBefore, foreground ?? "together");
      assert.deepEqual(log, ["transaction:begin", "detourRepo:saveDetour", "transaction:commit"]);
      assert.ok(repo.records.has("detour-1"));
    }
  });

  it("free_explore：允许内容辅助，无需切换，直接创建", async () => {
    const log: string[] = [];
    const { deps, repo } = makeDeps({ foreground: "free_explore", log });
    const result = await createScopedTutorDetour(deps, detourInput());
    assert.equal(result.switchedFromTrustedToPractice, false);
    assert.equal(result.foregroundBefore, "free_explore");
    assert.ok(repo.records.has("detour-1"));
  });

  it("trusted challenge 缺切换参数 → missing_switch_params，detour 不创建", async () => {
    const { deps, repo } = makeDeps({ foreground: "let_me_try" });
    await assert.rejects(
      () => createScopedTutorDetour(deps, detourInput()),
      (err: unknown) =>
        err instanceof TutorDetourError && err.code === "missing_switch_params",
    );
    assert.equal(repo.records.has("detour-1"), false);
  });

  it("原子性：切换失败 → 整体回滚，detour 不创建", async () => {
    const repo = new FakeDetourRepo();
    const deps: TutorDetourDeps = {
      repo: new FakeFrontRepo("let_me_try"),
      transaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      detourRepo: repo,
      enterPractice: async () => {
        throw new Error("enterPractice boom");
      },
    };
    await assert.rejects(
      () =>
        createScopedTutorDetour(
          deps,
          detourInput({
            deviceSessionId: "dev-1",
            contentExposureKey: "cex:abc",
            userActionNonce: "nonce-12345678",
            accountEpoch: 5,
          }),
        ),
      /enterPractice boom/,
    );
    assert.equal(repo.records.has("detour-1"), false);
  });

  it("原子性：detour 保存失败 → 整体抛错（不回滚前的半成品不落库）", async () => {
    const { deps, repo } = makeDeps({ foreground: "together", saveDetourThrows: true });
    await assert.rejects(() => createScopedTutorDetour(deps, detourInput()), /saveDetour boom/);
    assert.equal(repo.records.has("detour-1"), false);
  });
});

// ─── 4. 结束有界 detour ─────────────────────────────────────────────────

describe("endScopedTutorDetour", () => {
  it("固定结束动作 return_to_origin / end_session 结束 detour", async () => {
    for (const endReason of ["return_to_origin", "end_session"] as const) {
      const repo = new FakeDetourRepo();
      await repo.saveDetour(SCOPE, recordFixture());
      const { deps } = makeDeps({ detourRepo: repo });
      const result = await endScopedTutorDetour(deps, { scope: SCOPE, detourId: "detour-1", endReason });
      assert.equal(result.detour.status, "ended");
      assert.equal(result.detour.endReason, endReason);
      assert.equal(result.questionMarkerSaved, false);
    }
  });

  it("detour 不存在 → detour_not_found", async () => {
    const { deps } = makeDeps();
    await assert.rejects(
      () => endScopedTutorDetour(deps, { scope: SCOPE, detourId: "nope", endReason: "end_session" }),
      (err: unknown) => err instanceof TutorDetourError && err.code === "detour_not_found",
    );
  });

  it("非法结束动作 → invalid_end_reason", async () => {
    const repo = new FakeDetourRepo();
    await repo.saveDetour(SCOPE, recordFixture());
    const { deps } = makeDeps({ detourRepo: repo });
    await assert.rejects(
      () =>
        endScopedTutorDetour(deps, {
          scope: SCOPE,
          detourId: "detour-1",
          endReason: "save_question_marker" as never,
        }),
      (err: unknown) => err instanceof TutorDetourError && err.code === "invalid_end_reason",
    );
  });

  it("问题标记 Should flag 未开 → save_marker_flag_off；开 → 保存", async () => {
    for (const [shouldFlag, expectedCode] of [
      [false, "save_marker_flag_off"],
      [true, null],
    ] as const) {
      const repo = new FakeDetourRepo();
      await repo.saveDetour(SCOPE, recordFixture());
      const { deps } = makeDeps({ detourRepo: repo });
      const input = {
        scope: SCOPE,
        detourId: "detour-1",
        endReason: "return_to_origin" as const,
        saveQuestionMarker: true,
        shouldFlag,
      };
      if (expectedCode === null) {
        const result = await endScopedTutorDetour(deps, input);
        assert.equal(result.questionMarkerSaved, true);
        assert.equal(result.detour.questionMarkerSaved, true);
      } else {
        await assert.rejects(
          () => endScopedTutorDetour(deps, input),
          (err: unknown) =>
            err instanceof TutorDetourError && err.code === expectedCode,
        );
      }
    }
  });

  it("已 ended 的 detour 不可再次结束 → invalid_end_transition", async () => {
    const repo = new FakeDetourRepo();
    await repo.saveDetour(
      SCOPE,
      recordFixture({ status: "ended", endReason: "end_session" }),
    );
    const { deps } = makeDeps({ detourRepo: repo });
    await assert.rejects(
      () =>
        endScopedTutorDetour(deps, { scope: SCOPE, detourId: "detour-1", endReason: "end_session" }),
      (err: unknown) => err instanceof TutorDetourError && err.code === "invalid_end_transition",
    );
  });
});

// ─── 5. Session 外提问 gate ─────────────────────────────────────────────

describe("resolveOutsideSessionEntry", () => {
  it("明确选定 published Key Point → 创建 scoped exploration Session", () => {
    const result = resolveOutsideSessionEntry({
      selectedKeyPointId: "kp-1",
      publishedKeyPointIds: ["kp-1", "kp-2"],
    });
    assert.deepEqual(result, { kind: "create_scoped_exploration", keyPointId: "kp-1" });
  });

  it("未选定 / 空 / 不在 published 集合 → 请用户选择材料（不提供通用无限消息流）", () => {
    for (const selectedKeyPointId of [null, "", "kp-9"] as const) {
      const result = resolveOutsideSessionEntry({
        selectedKeyPointId,
        publishedKeyPointIds: ["kp-1", "kp-2"],
      });
      assert.deepEqual(result, { kind: "ask_select_material" });
    }
  });
});
