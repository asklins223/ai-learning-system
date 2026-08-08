/**
 * 任务 07-5：四入口共享内核与 origin-aware completion 单测（§8/§3，W6 任务 07-5）。
 *
 * 覆盖：
 * - 四入口一致（同一 FrozenPrepareOrigin → 视图共享 Session/Episode 内核、就地完成）；
 * - originRef / viewport / selection / completion summary 在 PREPARE 深度冻结；
 * - completion summary 只接受 trusted 验证/复习事件（practice/contact 进入为 0）；
 * - 每处可「在星图中查看」但不强制跳转（forced 恒为 false）；
 * - 学习卡状态 ≠ 用户理解（发布/接触 → no_change，Tutor → practice，trusted → 变化）；
 * - 内容工具按实际暴露记录 exposure，随后开始航程遵守 assistance cooldown；
 * - star_map 恢复原 viewport/zoom/selection 并显影真实变化；
 * - card 返回能力/复习变化摘要；review/now 展示 schedule 结果与未处理事实；
 * - tutor_detour 回到原 Episode / 保留为练习 / 明确结束三选一。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FOUR_ENTRY_IDS,
  LEARNING_CARD_PRIMARY_ACTION,
  LEARNING_CARD_TOOLS,
  buildCompletionSummary,
  classifyCardEvent,
  fourEntriesShareCore,
  fourEntryGroup,
  freezePrepareOrigin,
  projectCardStateEffects,
  recordToolExposure,
  resolveEntryView,
  resolveJourneyReadiness,
  type CompletionSummaryContract,
  type FourEntryView,
  type PrepareOriginInput,
} from "./four-entry-origin.ts";

function baseInput(overrides: Partial<PrepareOriginInput> = {}): PrepareOriginInput {
  const completionSummary: CompletionSummaryContract = {
    version: 1,
    fromTrustedContractOnly: true,
    capabilityChangeSummary: ["recall"],
    reviewChangeSummary: ["下次复习：已安排 3 天后"],
    unhandledFacts: ["有一个到期项尚未处理（不欠债，保留事实）"],
    scheduleResult: "consume_pending",
  };
  return {
    entry: "card",
    sessionId: "session-1",
    episodeId: "episode-1",
    targetKeyPointId: "kp-1",
    originRef: { type: "key_point", id: "kp-1" },
    viewportSnapshot: null,
    selectionSnapshot: null,
    completionSummary,
    frozenEpoch: 1,
    ...overrides,
  };
}

function starMapInput(overrides: Partial<PrepareOriginInput> = {}): PrepareOriginInput {
  return baseInput({
    entry: "star_map",
    viewportSnapshot: { offsetX: 12.5, offsetY: -8, zoom: 1.75 },
    selectionSnapshot: { selectedId: "kp-1", highlightedNodeIds: ["card-1"] },
    ...overrides,
  });
}

// ─── 1. 四入口一致 ─────────────────────────────────────────────────────

describe("四入口共享同一 Session/Episode 内核（§3 四入口结果一致且就地完成）", () => {
  it("同一 frozen 派生的五个入口视图共享 core，且就地完成", () => {
    const views: FourEntryView[] = FOUR_ENTRY_IDS.map((entry) => {
      const input =
        entry === "star_map" ? starMapInput() : baseInput({ entry });
      return resolveEntryView(freezePrepareOrigin(input));
    });
    assert.equal(views.length, 5);
    assert.equal(fourEntriesShareCore(views), true);
    for (const view of views) {
      assert.equal(view.core.sessionId, "session-1");
      assert.equal(view.core.episodeId, "episode-1");
      assert.equal(view.core.targetKeyPointId, "kp-1");
      assert.deepEqual(view.core.originRef, { type: "key_point", id: "kp-1" });
      assert.equal(view.completedInPlace, true);
    }
  });

  it("四入口从不同 core 派生则不一致（fail 判定可见）", () => {
    const a = resolveEntryView(freezePrepareOrigin(baseInput()));
    const b = resolveEntryView(freezePrepareOrigin(baseInput({ episodeId: "episode-2" })));
    assert.equal(fourEntriesShareCore([a, b]), false);
  });

  it("review 与 now 归入同一 review_now 组（共享「此刻/复习」语义）", () => {
    assert.equal(fourEntryGroup("review"), "review_now");
    assert.equal(fourEntryGroup("now"), "review_now");
    assert.equal(fourEntryGroup("star_map"), "star_map");
    assert.equal(fourEntryGroup("card"), "card");
    assert.equal(fourEntryGroup("tutor_detour"), "tutor_detour");
  });
});

// ─── 2. PREPARE 冻结 ───────────────────────────────────────────────────

describe("originRef / snapshot / completion summary 在 PREPARE 冻结（§3）", () => {
  it("freezePrepareOrigin 返回深度冻结对象：originRef / completionSummary / snapshot 均不可变", () => {
    const frozen = freezePrepareOrigin(starMapInput());
    assert.equal(Object.isFrozen(frozen), true);
    assert.equal(Object.isFrozen(frozen.originRef), true);
    assert.equal(Object.isFrozen(frozen.completionSummary), true);
    assert.equal(Object.isFrozen(frozen.viewportSnapshot), true);
    assert.equal(Object.isFrozen(frozen.selectionSnapshot), true);
    assert.equal(Object.isFrozen(frozen.completionSummary.capabilityChangeSummary), true);
  });

  it("修改冻结 originRef 抛错（fail closed）", () => {
    const frozen = freezePrepareOrigin(baseInput());
    assert.throws(() => {
      (frozen as unknown as { originRef: { type: string } }).originRef.type = "card";
    }, TypeError);
    assert.throws(() => {
      (frozen as unknown as { originRef: { id: string } }).originRef.id = "other";
    }, TypeError);
  });

  it("修改冻结 completion summary 抛错（PREPARE 后 contract 不改写）", () => {
    const frozen = freezePrepareOrigin(baseInput());
    assert.throws(() => {
      (
        frozen.completionSummary as unknown as {
          capabilityChangeSummary: string[];
        }
      ).capabilityChangeSummary.push("apply");
    }, TypeError);
  });

  it("修改冻结视口/选择 snapshot 抛错", () => {
    const frozen = freezePrepareOrigin(starMapInput());
    assert.throws(() => {
      (frozen.viewportSnapshot as unknown as { zoom: number }).zoom = 3;
    }, TypeError);
    assert.throws(() => {
      (frozen.selectionSnapshot as unknown as { selectedId: string }).selectedId = "other";
    }, TypeError);
  });

  it("frozenEpoch 由调用方递增提供，同一输入恒等（确定性）", () => {
    const a = freezePrepareOrigin(baseInput({ frozenEpoch: 3 }));
    const b = freezePrepareOrigin(baseInput({ frozenEpoch: 4 }));
    assert.equal(a.frozenEpoch, 3);
    assert.equal(b.frozenEpoch, 4);
    assert.equal(a.frozenEpoch < b.frozenEpoch, true);
  });

  it("star_map 入口必须携带 viewport/selection snapshot，缺失 fail closed", () => {
    assert.throws(
      () => freezePrepareOrigin(baseInput({ entry: "star_map", viewportSnapshot: null })),
      /star_map entry requires a frozen viewport snapshot/,
    );
    assert.throws(
      () =>
        freezePrepareOrigin(
          baseInput({
            entry: "star_map",
            viewportSnapshot: { offsetX: 0, offsetY: 0, zoom: 1 },
            selectionSnapshot: null,
          }),
        ),
      /star_map entry requires a frozen selection snapshot/,
    );
  });

  it("非法输入 fail closed：非法 entry / originRef / 非 trusted contract", () => {
    assert.throws(
      () => freezePrepareOrigin(baseInput({ entry: "nope" as never })),
      /invalid four-entry id/,
    );
    assert.throws(
      () => freezePrepareOrigin(baseInput({ originRef: { type: "nope", id: "x" } as never })),
      /invalid originRef type/,
    );
    assert.throws(
      () => freezePrepareOrigin(baseInput({ originRef: { type: "card", id: "" } })),
      /originRef.id must be a non-empty string/,
    );
    assert.throws(
      () =>
        freezePrepareOrigin(
          baseInput({
            completionSummary: {
              ...baseInput().completionSummary,
              fromTrustedContractOnly: false,
            } as unknown as PrepareOriginInput["completionSummary"],
          }),
        ),
      /completion summary must come from trusted contract only/,
    );
  });
});

// ─── 3. completion summary contract ────────────────────────────────────

describe("completion summary：只 trusted 事件进入，且 contract 在 PREPARE 冻结（§8）", () => {
  it("buildCompletionSummary 只接受 trusted 验证/复习事件；practice/contact 进入为 0", () => {
    const frozen = freezePrepareOrigin(baseInput());
    const summary = buildCompletionSummary(frozen.completionSummary, [
      { kind: "trusted_validation", facet: "recall" },
      { kind: "trusted_validation", facet: "explain" },
      { kind: "trusted_review", facet: "recall", scheduleNote: "复习时间已更新" },
      { kind: "practice", facet: "apply" },
      { kind: "contact" },
      { kind: "practice" },
    ]);
    assert.deepEqual(summary.capabilityChangeSummary, ["explain", "recall"]);
    assert.deepEqual(summary.reviewChangeSummary, ["复习时间已更新"]);
    assert.equal(summary.fromTrustedContractOnly, true);
    assert.equal(summary.scheduleResult, "consume_pending");
    assert.deepEqual(summary.unhandledFacts, frozen.completionSummary.unhandledFacts);
  });

  it("只有 practice/contact 事件时，无任何理解变化进入摘要", () => {
    const frozen = freezePrepareOrigin(baseInput());
    const summary = buildCompletionSummary(frozen.completionSummary, [
      { kind: "contact" },
      { kind: "practice", facet: "apply" },
    ]);
    // practice/contact 不进入能力摘要；未处理事实仍按 contract 呈现（事实语言）
    assert.deepEqual(summary.capabilityChangeSummary, []);
    assert.deepEqual(summary.reviewChangeSummary, []);
  });
});

// ─── 4. 不强制跳转 ─────────────────────────────────────────────────────

describe("每处可「在星图中查看」但不强制跳转（§3 四入口 / §10.6 星图不是唯一入口）", () => {
  it("全部入口 starMapView.forced === false；star_map 本身不再提供星图入口", () => {
    for (const entry of FOUR_ENTRY_IDS) {
      const input = entry === "star_map" ? starMapInput() : baseInput({ entry });
      const view = resolveEntryView(freezePrepareOrigin(input));
      assert.equal(view.starMapView.forced, false, `${entry} 不得强制跳转星图`);
      assert.equal(view.starMapView.available, entry !== "star_map");
    }
  });

  it("card/review/now/tutor_detour 不强制跳转即可就地完成（不恢复星图视口）", () => {
    for (const entry of ["card", "review", "now", "tutor_detour"] as const) {
      const view = resolveEntryView(freezePrepareOrigin(baseInput({ entry })));
      assert.equal(view.restoredViewport, null);
      assert.equal(view.restoredSelection, null);
      assert.equal(view.completedInPlace, true);
    }
  });
});

// ─── 5. 学习卡状态 ≠ 用户理解 ──────────────────────────────────────────

describe("学习卡状态 ≠ 用户理解（§8 / 07-5）", () => {
  it("发布/打开/收听/收藏只表示接触 → no_change", () => {
    assert.equal(classifyCardEvent("asset_published"), "no_change");
    assert.equal(classifyCardEvent("opened"), "no_change");
    assert.equal(classifyCardEvent("listened"), "no_change");
    assert.equal(classifyCardEvent("favorited"), "no_change");
  });

  it("Tutor 解释只产生 practice 事件", () => {
    assert.equal(classifyCardEvent("tutor_explained"), "practice_event");
  });

  it("只有 trusted contract 的验证/复习事件改变理解投影", () => {
    assert.equal(classifyCardEvent("trusted_validation"), "understanding_change");
    assert.equal(classifyCardEvent("trusted_review"), "understanding_change");
  });

  it("事件序列投影：发布+接触+Tutor 变化为 0，trusted 事件才计数", () => {
    const projection = projectCardStateEffects([
      { kind: "asset_published", atEpoch: 1 },
      { kind: "opened", atEpoch: 2 },
      { kind: "listened", atEpoch: 3 },
      { kind: "favorited", atEpoch: 4 },
      { kind: "tutor_explained", atEpoch: 5 },
      { kind: "trusted_validation", atEpoch: 6 },
      { kind: "trusted_review", atEpoch: 7 },
    ]);
    assert.equal(projection.understandingChange, 2);
    assert.equal(projection.practiceEvents, 1);
    assert.equal(projection.contactOnly, 4);
  });
});

// ─── 6. 内容工具 exposure 与 assistance cooldown ───────────────────────

describe("内容工具按实际暴露记录 exposure，随后开始航程遵守 assistance cooldown（§8）", () => {
  it("主行动唯一：常量即「开始/继续一小段航程」；内容工具为三个，无平级玩法", () => {
    assert.equal(LEARNING_CARD_PRIMARY_ACTION, "开始/继续一小段航程");
    assert.deepEqual(LEARNING_CARD_TOOLS, ["read_aloud", "view_evidence", "ask_tutor"]);
  });

  it("recordToolExposure 记录合法工具；非法工具/空键 fail closed", () => {
    const record = recordToolExposure({
      tool: "read_aloud",
      contentExposureKey: "cex:abc",
      atEpoch: 5,
    });
    assert.deepEqual(record, { tool: "read_aloud", contentExposureKey: "cex:abc", atEpoch: 5 });
    assert.throws(
      () =>
        recordToolExposure({
          tool: "play_game" as never,
          contentExposureKey: "cex:abc",
          atEpoch: 5,
        }),
      /invalid learning card tool/,
    );
    assert.throws(
      () =>
        recordToolExposure({ tool: "ask_tutor", contentExposureKey: "", atEpoch: 5 }),
      /contentExposureKey must be a non-empty string/,
    );
  });

  it("无 exposure → formal 可 trusted 验证", () => {
    const readiness = resolveJourneyReadiness([], { nowEpoch: 100, cooldownWindowEpochs: 60 });
    assert.equal(readiness.inAssistanceCooldown, false);
    assert.equal(readiness.journeyMode, "formal");
    assert.equal(readiness.trustedEligible, true);
    assert.equal(readiness.cooldownUntilEpoch, null);
  });

  it("内容工具暴露后冷却期内开始航程 → practice_only（不制造「已掌握」）", () => {
    const exposures = [
      recordToolExposure({ tool: "view_evidence", contentExposureKey: "cex:kp-1", atEpoch: 100 }),
      recordToolExposure({ tool: "ask_tutor", contentExposureKey: "cex:kp-1", atEpoch: 120 }),
    ];
    const readiness = resolveJourneyReadiness(exposures, {
      nowEpoch: 130,
      cooldownWindowEpochs: 60,
    });
    assert.equal(readiness.inAssistanceCooldown, true);
    assert.equal(readiness.journeyMode, "practice_only");
    assert.equal(readiness.trustedEligible, false);
    assert.equal(readiness.cooldownUntilEpoch, 180);
  });

  it("冷却过后可再独立验证（旅程 E：冷却后再独立验证）", () => {
    const exposures = [
      recordToolExposure({ tool: "read_aloud", contentExposureKey: "cex:kp-1", atEpoch: 100 }),
    ];
    const readiness = resolveJourneyReadiness(exposures, {
      nowEpoch: 161,
      cooldownWindowEpochs: 60,
    });
    assert.equal(readiness.inAssistanceCooldown, false);
    assert.equal(readiness.journeyMode, "formal");
    assert.equal(readiness.trustedEligible, true);
  });
});

// ─── 7. 四入口各自恢复语义 ─────────────────────────────────────────────

describe("star_map 入口：恢复原 viewport/zoom/selection 并显影真实变化（旅程 A）", () => {
  it("恢复 PREPARE 冻结的视口与选择，且 revealRealChange=true", () => {
    const frozen = freezePrepareOrigin(starMapInput());
    const view = resolveEntryView(frozen);
    assert.deepEqual(view.restoredViewport, { offsetX: 12.5, offsetY: -8, zoom: 1.75 });
    assert.deepEqual(view.restoredSelection, {
      selectedId: "kp-1",
      highlightedNodeIds: ["card-1"],
    });
    assert.equal(view.revealRealChange, true);
    assert.equal(view.group, "star_map");
  });

  it("恢复的是冻结快照引用（不可变，后续修改 fail closed）", () => {
    const view = resolveEntryView(freezePrepareOrigin(starMapInput()));
    assert.throws(() => {
      (view.restoredViewport as unknown as { zoom: number }).zoom = 9;
    }, TypeError);
  });
});

describe("card 入口：返回当前卡片显示能力/复习变化摘要（旅程 D/E 返回卡片）", () => {
  it("能力/复习变化摘要与 schedule 结果来自冻结 contract", () => {
    const frozen = freezePrepareOrigin(baseInput({ entry: "card" }));
    const view = resolveEntryView(frozen);
    assert.deepEqual(view.capabilityChangeSummary, ["recall"]);
    assert.deepEqual(view.reviewChangeSummary, ["下次复习：已安排 3 天后"]);
    assert.equal(view.scheduleResult, "consume_pending");
    assert.equal(view.revealRealChange, false);
  });
});

describe("review/now 入口：展示本 Episode schedule 结果与未处理事实（旅程 F）", () => {
  for (const entry of ["review", "now"] as const) {
    it(`${entry}：schedule 结果与未处理事实按事实语言呈现，不道德化为债务`, () => {
      const view = resolveEntryView(freezePrepareOrigin(baseInput({ entry })));
      assert.equal(view.scheduleResult, "consume_pending");
      assert.deepEqual(view.unhandledFacts, ["有一个到期项尚未处理（不欠债，保留事实）"]);
      assert.equal(view.group, "review_now");
    });
  }
});

describe("scoped Tutor detour 入口：回到原 Episode / 保留为练习 / 明确结束（旅程 D）", () => {
  it("默认回到原 Episode（Must 固定结束动作三选一）", () => {
    const view = resolveEntryView(freezePrepareOrigin(baseInput({ entry: "tutor_detour" })));
    assert.equal(view.detourOutcome, "return_to_episode");
  });

  it("保留为练习：detour 结果只产生 practice 事件，不改变理解投影", () => {
    const view = resolveEntryView(
      freezePrepareOrigin(baseInput({ entry: "tutor_detour" })),
      { detourOutcome: "keep_as_practice" },
    );
    assert.equal(view.detourOutcome, "keep_as_practice");
    assert.equal(view.completedInPlace, true);
  });

  it("明确结束：detour 结束后不自动续题", () => {
    const view = resolveEntryView(
      freezePrepareOrigin(baseInput({ entry: "tutor_detour" })),
      { detourOutcome: "explicit_end" },
    );
    assert.equal(view.detourOutcome, "explicit_end");
  });

  it("非法 detour outcome fail closed", () => {
    assert.throws(
      () =>
        resolveEntryView(
          freezePrepareOrigin(baseInput({ entry: "tutor_detour" })),
          { detourOutcome: "keep_going" as never },
        ),
      /invalid detour outcome/,
    );
  });
});
