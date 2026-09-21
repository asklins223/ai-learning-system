// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardGenerationSurface } from "./CardGenerationSurface";
import { useRoomStore } from "../app/room-store";

/**
 * 候选审核页的合同：
 * - 决定一旦提交，卡片必须自己说出新状态，并走到下一张未决候选；
 * - 不保留必须带上复核人选择的原因码，而不是永远写死 not_useful；
 * - 答案与来源证据只有主动查看才下发，且查看后要说明这次曝光的后果；
 * - 动作失败只影响卡片内的提示行，不会把整块审核界面换成错误卡；
 * - needs_attention 的 run 只要还有通过门禁的候选就必须能审核、能激活；
 * - 「返回笔记」在同一屏只出现一次。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "aaaaaaa1-1111-4111-8111-111111111111";

type CandidateState = {
  candidateId: string;
  practiceItem?: { kind: string; optionCount: number } | null;
  statement: string;
  reviewDecision: string;
  publishState: string;
};

function stubGateway(initial: readonly CandidateState[], runOverride: { status?: string; recovery?: unknown } = {}) {
  const state = {
    candidates: initial.map((candidate) => ({ ...candidate })),
    reviewCalls: [] as unknown[],
    revealCalls: [] as string[],
    exposureCalls: [] as string[],
    reviewFails: false,
    // 状态是活的：结束审核之后服务端会把 run 收成 closed_without_activation，
    // 后续 getRun 必须能读到这个新状态，否则「点完没反应」的缺陷会再次溜进来。
    status: runOverride.status ?? "review_ready",
  };
  const runSnapshot = () => ({
    version: 1,
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status: state.status,
    cardContentEpoch: 1,
    currentPlanVersion: 1,
    reviewDraftRevision: 1,
    sourceOutdated: false,
    sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID },
    // 恢复契约只在 needs_attention / failed / stale 这三种状态下存在
    // （共享 schema 的 recoveryMatchesRunStatus 就是这么约束的）。stub 必须照做，
    // 否则"重试之后 run 回到工作态"这件事在测试里永远不会发生——按钮会挂在那里
    // 假装按下去没反应。
    recovery: ["needs_attention", "failed", "stale"].includes(state.status)
      ? runOverride.recovery ?? null
      : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const candidates = () => state.candidates.map((candidate, index) => ({
    candidateId: candidate.candidateId,
    candidateRevisionId: `${candidate.candidateId}-rev`,
    revision: 1,
    candidateRevisionHash: `hash-${index}`,
    reviewDecision: candidate.reviewDecision,
    isReviewReady: true,
    candidateEvidenceBindingPlanHash: "plan-hash",
    publishState: candidate.publishState,
    qualityState: "passed",
    practiceItem: candidate.practiceItem ?? null,
    strategy: "why",
    transformationKind: "mechanism_reconstruction",
    planVersion: 1,
    estimatedReviewSeconds: 45,
    recommendation: { recommended: true, reasonCodes: ["mechanism_gap"] },
    objective: { statement: candidate.statement, publicSummary: "提取练习", knowledgeForm: "causal_model" },
    front: { cue: "回忆一次提取练习", prompt: "请解释机制" },
  }));
  const gateway = {
    contract: { enabledRoutes: ["note.detail", "note.cardGeneration"] },
    auth: {
      getState: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { status: "authenticated" as const, workspace: { workspaceId: "w-1" } },
      })),
    },
    room: {
      getProjection: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          activeGenerationSummary: { state: "data", data: { ...runSnapshot(), route: { kind: "note.cardGeneration", cardGenerationRunId: RUN_ID } } },
        },
      })),
    },
    note: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { noteId: NOTE_ID, title: "提取练习笔记", sourceId: null },
      })),
      cardGeneration: {
        getRun: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: runSnapshot() })),
        getCandidates: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { candidates: candidates() } })),
        review: vi.fn(async (input: { request: { action: { type: string; candidateId: string; reasonCode?: string } } }) => {
          state.reviewCalls.push(input.request.action);
          if (state.reviewFails) return { ok: false as const, workspaceEpoch: 1, error: { code: "conflict", message: "候选已被改动" } };
          const action = input.request.action;
          state.candidates = state.candidates.map((candidate) => candidate.candidateId === action.candidateId
            ? { ...candidate, reviewDecision: action.type === "undo_decision" ? "undecided" : action.type }
            : candidate);
          return { ok: true as const, workspaceEpoch: 1, data: { version: 1, runId: RUN_ID, actionType: action.type, reviewDraftRevision: 2 } };
        }),
        exposure: vi.fn(async (input: { candidateId: string }) => {
          state.exposureCalls.push(input.candidateId);
          const exposed = state.revealCalls.includes(input.candidateId);
          return {
            ok: true as const,
            workspaceEpoch: 1,
            data: {
              version: 1,
              runId: RUN_ID,
              candidateId: input.candidateId,
              candidateRevisionId: `${input.candidateId}-rev`,
              revision: 1,
              exposureStatus: exposed ? "exposed" as const : "not_exposed" as const,
              initialValidationPolicyEffect: exposed ? "wait_for_initial_validation" as const : "eligible" as const,
              lastExposedAt: exposed ? new Date().toISOString() : null,
            },
          };
        }),
        reveal: vi.fn(async (input: { candidateId: string }) => {
          state.revealCalls.push(input.candidateId);
          return {
            ok: true as const,
            workspaceEpoch: 1,
            data: {
              version: 2,
              candidateId: input.candidateId,
              candidateRevisionId: `${input.candidateId}-rev`,
              revision: 1,
              exposureId: "exposure-1",
              canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "提取练习强迫大脑重建记忆痕迹。" } },
              explanation: "提取比重复阅读产生更强的记忆痕迹。",
              boundary: "对完全陌生的材料不成立。",
              evidencePreviews: [{ evidenceSnapshotId: "ev-1", preview: "测试效应在多项研究中被重复。", sourceLabel: "来源第 3 段" }],
              exposedAt: new Date().toISOString(),
            },
          };
        }),
        close: vi.fn(async () => {
          state.status = "closed_without_activation";
          return {
            ok: true as const,
            workspaceEpoch: 1,
            data: { version: 1, runId: RUN_ID, status: "closed_without_activation" as const, reviewDraftRevision: 2 },
          };
        }),
        // 就地重试：服务端把 run 推回工作态（checking），并把失败码清掉。
        retry: vi.fn(async () => {
          state.status = "checking";
          return {
            ok: true as const,
            workspaceEpoch: 1,
            data: { version: 1, runId: RUN_ID, status: "checking" as const },
          };
        }),
      },
    },
    subscriptions: {
      subscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ({ ok: true as const, data: null })),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return { gateway, state };
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ activeCardGenerationRunId: null, activeNoteRef: null, surface: null, returnTarget: null });
});

describe("CardGenerationSurface · 候选审核", () => {
  it("保留后卡片说出新状态，并自动走到下一张未决候选", async () => {
    const { state } = stubGateway([
      { candidateId: "cand-1", statement: "第一张", reviewDecision: "undecided", publishState: "unpublished" },
      { candidateId: "cand-2", statement: "第二张", reviewDecision: "undecided", publishState: "unpublished" },
    ]);
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getByText("第一张")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^保留（进入激活队列）/ }));

    await waitFor(() => expect(state.reviewCalls).toHaveLength(1));
    expect(state.reviewCalls[0]).toMatchObject({ type: "keep", candidateId: "cand-1" });
    // 决定被记下后，审核继续往前走，而不是停在按钮已消失的卡片上。
    await waitFor(() => expect(screen.getByText("第二张")).toBeTruthy());
    expect(screen.queryByText("第一张")).toBeNull();
  });

  it("未决计数说清的是整批还剩多少，不是「这张之后还剩几张」", async () => {
    const { state } = stubGateway([
      { candidateId: "cand-1", statement: "第一张", reviewDecision: "undecided", publishState: "unpublished" },
      { candidateId: "cand-2", statement: "第二张", reviewDecision: "undecided", publishState: "unpublished" },
      { candidateId: "cand-3", statement: "第三张", reviewDecision: "undecided", publishState: "unpublished" },
    ]);
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getByText("第一张")).toBeTruthy());
    // 2026-09-21 真实批次实测：这一行以前写「还有 N 张未决」，而这个 N 是**整批**
    // 的未决数——于是停在最后一张时仍写「还有 4 张」，读起来像后面还有 4 张。
    const meta = () => (document.querySelector(".candidate-card__meta")?.textContent ?? "");
    expect(meta()).toContain("3 张还没决定");
    expect(meta()).not.toContain("还有");
    expect(meta()).not.toContain("未决");

    fireEvent.click(screen.getByRole("button", { name: /^保留（进入激活队列）/ }));
    await waitFor(() => expect(state.reviewCalls).toHaveLength(1));
    await waitFor(() => expect(meta()).toContain("2 张还没决定"));
  });

  it("卡面的线索不占用「提示」这个词", async () => {
    stubGateway([
      { candidateId: "cand-1", statement: "第一张", reviewDecision: "undecided", publishState: "unpublished" },
    ]);
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getByText("第一张")).toBeTruthy());
    // 生成时产出的两级提示才是「提示」；审核卡面上这行是题面线索，
    // 两者混用会让人以为已经给了提示。
    const cue = document.querySelector(".candidate-card__cue b");
    expect(cue?.textContent).toBe("线索");
    expect(document.querySelector(".candidate-card__cue")?.textContent).toContain("回忆一次提取练习");
  });

  it("审核页说出这张卡带哪种客观练习，且不把选项文本漏给列表", async () => {
    stubGateway([
      {
        candidateId: "cand-1",
        statement: "第一张",
        reviewDecision: "undecided",
        publishState: "unpublished",
        practiceItem: { kind: "ordering", optionCount: 4 },
      },
    ]);
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getByText("第一张")).toBeTruthy());
    expect(screen.getByText("排序题 · 排 4 步")).toBeTruthy();
    // 正确项与选项文本连字段都没下发，这里再确认一次界面没自己造出来。
    const board = JSON.stringify((window.ailearn.note.cardGeneration.getCandidates as ReturnType<typeof vi.fn>).mock.calls);
    expect(board).not.toContain("correctUnitId");
  });

  it("没配练习件的卡直说没有，不假装有一道题", async () => {
    stubGateway([
      { candidateId: "cand-1", statement: "第一张", reviewDecision: "undecided", publishState: "unpublished" },
    ]);
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getByText("第一张")).toBeTruthy());
    expect(screen.getByText("没有，只能用自己的话答")).toBeTruthy();
  });

  it("不保留先问原因，并把选择的原因码交给服务端", async () => {
    const { state } = stubGateway([
      { candidateId: "cand-1", statement: "第一张", reviewDecision: "undecided", publishState: "unpublished" },
    ]);
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getByText("第一张")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /不保留/ }));

    const reason = await waitFor(() => screen.getByRole("button", { name: "拆得太碎" }));
    expect(state.reviewCalls).toHaveLength(0);
    fireEvent.click(reason);

    await waitFor(() => expect(state.reviewCalls).toHaveLength(1));
    expect(state.reviewCalls[0]).toMatchObject({ type: "reject", candidateId: "cand-1", reasonCode: "too_fragmented" });
  });

  it("已决定的候选可以撤销，且不会掉出审核页", async () => {
    const { state } = stubGateway([
      { candidateId: "cand-1", statement: "第一张", reviewDecision: "keep", publishState: "unpublished" },
    ]);
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getAllByText("已保留 · 在激活队列里").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /撤销决定/ }));

    await waitFor(() => expect(state.reviewCalls).toHaveLength(1));
    expect(state.reviewCalls[0]).toMatchObject({ type: "undo_decision", candidateId: "cand-1" });
    await waitFor(() => expect(screen.getAllByText("待审核").length).toBeGreaterThan(0));
  });

  it("查看答案会调用 reveal，并同时给出答案与来源证据", async () => {
    const { state } = stubGateway([
      { candidateId: "cand-1", statement: "第一张", reviewDecision: "undecided", publishState: "unpublished" },
    ]);
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getByText("第一张")).toBeTruthy());
    // 代价要说在点之前：这个按钮的提示必须已经写明"看答案会让正式验证等 24 小时"。
    const revealButton = screen.getByRole("button", { name: /查看答案与证据/ });
    expect(revealButton.title).toContain("24 小时");
    fireEvent.click(revealButton);

    await waitFor(() => expect(state.revealCalls).toEqual(["cand-1"]));
    await waitFor(() => expect(screen.getByText("提取练习强迫大脑重建记忆痕迹。")).toBeTruthy());
    expect(screen.getByText("来源第 3 段")).toBeTruthy();
    expect(screen.getByText("测试效应在多项研究中被重复。")).toBeTruthy();
    // 曝光有后果，而且后果是服务端的预检结果，不是一句笼统的说明。
    await waitFor(() => expect(screen.getByText("答案看过了：激活后要等 24 小时才能正式验证")).toBeTruthy());
    expect(screen.getByText(/不计入正式状态/)).toBeTruthy();
    expect(screen.getByText(/已查看/)).toBeTruthy();
  });

  it("一次动作失败不会清空候选卡，只在卡内报错", async () => {
    const { state } = stubGateway([
      { candidateId: "cand-1", statement: "第一张", reviewDecision: "undecided", publishState: "unpublished" },
    ]);
    state.reviewFails = true;
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getByText("第一张")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^保留（进入激活队列）/ }));

    await waitFor(() => expect(screen.getByText(/这一步没成功/)).toBeTruthy());
    // 候选卡与它的决定按钮仍在原地。
    expect(screen.getByText("第一张")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^保留（进入激活队列）/ })).toBeTruthy();
  });

  /**
   * deck gate 失败会把 run 落到 needs_attention，但通过各自门禁的候选仍然保留给
   * 用户。此前审核动作被锁死在 `run.status === "review_ready"`，这种 run 会拿着
   * 可保留的候选停在页面上，却一个决定按钮都不给 —— 任务就此卡死。
   */
  it("needs_attention 的 run 仍能保留通过门禁的候选", async () => {
    const { state } = stubGateway(
      [{ candidateId: "cand-1", statement: "第一张", reviewDecision: "undecided", publishState: "unpublished" }],
      {
        status: "needs_attention",
        recovery: {
          version: 1,
          publicReasonCode: "attention_required",
          retryability: "resync_required",
          allowedActions: [
            { kind: "refresh_status", runId: RUN_ID },
            { kind: "return_note", route: "note.detail", sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
          ],
        },
      },
    );
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    render(<CardGenerationSurface />);

    // 页面身份仍是候选审核，候选卡与决定按钮都在。
    await waitFor(() => expect(screen.getByText("第一张")).toBeTruthy());
    const keep = screen.getByRole("button", { name: /^保留（进入激活队列）/ });
    expect(screen.getByRole("button", { name: /不保留/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "结束本次审核" })).toBeTruthy();

    fireEvent.click(keep);
    await waitFor(() => expect(state.reviewCalls).toHaveLength(1));
    expect(state.reviewCalls[0]).toMatchObject({ type: "keep", candidateId: "cand-1" });
    await waitFor(() => expect(screen.getAllByText("已保留 · 在激活队列里").length).toBeGreaterThan(0));
  });

  /**
   * 「返回笔记」曾经在同一屏出现两次：恢复契约签发的那个 + 旁栏常驻的那个。
   * 一屏一个就够了，而且必须是可点的那一个。
   */
  it("恢复态的候选审核页只有一个『返回笔记』", async () => {
    stubGateway(
      [],
      {
        status: "needs_attention",
        recovery: {
          version: 1,
          publicReasonCode: "attention_required",
          retryability: "resync_required",
          allowedActions: [
            { kind: "refresh_status", runId: RUN_ID },
            { kind: "return_note", route: "note.detail", sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
          ],
        },
      },
    );
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID, activeNoteRef: null });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getAllByText("需要后台再看一次才能继续").length).toBeGreaterThan(0));
    expect(screen.getAllByText("返回笔记")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /重新检查/ })).toBeTruthy();

    // 唯一那一个必须是真入口，不是一段死文案。
    fireEvent.click(screen.getAllByText("返回笔记")[0]);
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("notebook"));
    expect(useRoomStore.getState().activeNoteRef).toMatchObject({ noteId: NOTE_ID, noteVersionId: VERSION_ID });
  });

  /**
   * 一张候选都没有的恢复态（截图里那一屏）曾经只剩「重新检查」和「返回笔记」——
   * 笔记页的生成入口又写着「处理生成任务」把用户送回工作台，来回没有任何出口。
   * 结束审核是这条路的出口：它把 run 收成 closed_without_activation，笔记页随后
   * 就能重新发起一次生成。
   */
  it("没有候选的恢复态给出「结束本次审核」这个出口", async () => {
    const { gateway } = stubGateway(
      [],
      {
        status: "needs_attention",
        recovery: {
          version: 1,
          publicReasonCode: "attention_required",
          retryability: "resync_required",
          allowedActions: [
            { kind: "refresh_status", runId: RUN_ID },
            { kind: "return_note", route: "note.detail", sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
          ],
        },
      },
    );
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID, activeNoteRef: null });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getAllByText("需要后台再看一次才能继续").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "结束本次审核" }));
    // 结束审核必须真的打到服务端，而不是一个点了没反应的按钮。
    await waitFor(() => expect(gateway.note.cardGeneration.close).toHaveBeenCalledTimes(1));
    // 而且点完之后这一屏必须真的离开审核态：出口消失、状态说出新结论。
    await waitFor(() => expect(screen.queryByRole("button", { name: "结束本次审核" })).toBeNull());
    expect(screen.getAllByText("已结束，未激活").length).toBeGreaterThan(0);
  });

  /**
   * 唯一候选被 critic 否决时，run 会终态化为 needs_attention 且一个候选都不剩。
   * 服务端确认这次失败是质量门禁造成、来源也没过期时，会签发 `retry_generation`——
   * 用户点它就**在同一条 run 内重跑**（复用已封存来源），而不是回笔记重开一次全新生成。
   *
   * 这条用例锁两件事：按钮真的出现，且真的打到服务端；点完之后这一屏必须离开失败态，
   * 而不是停在那里假装按下去了。
   */
  it("质量门禁失败的无候选恢复态给出「再生成一次候选」并真的触发重试", async () => {
    const { gateway, state } = stubGateway(
      [],
      {
        status: "needs_attention",
        recovery: {
          version: 1,
          publicReasonCode: "quality_gate_failed",
          retryability: "retry_in_place",
          allowedActions: [
            { kind: "refresh_status", runId: RUN_ID },
            { kind: "return_note", route: "note.detail", sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
            { kind: "retry_generation", runId: RUN_ID },
          ],
        },
      },
    );
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID, activeNoteRef: null });
    render(<CardGenerationSurface />);

    const retryButton = await screen.findByRole("button", { name: /再生成一次候选/ });
    fireEvent.click(retryButton);

    await waitFor(() => expect(gateway.note.cardGeneration.retry).toHaveBeenCalledTimes(1));
    expect(gateway.note.cardGeneration.retry).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID }),
    );
    // 点完必须真的离开失败态：重试入口消失，服务端已把 run 推回工作态。
    await waitFor(() => expect(screen.queryByRole("button", { name: /再生成一次候选/ })).toBeNull());
    expect(state.status).toBe("checking");
  });

  /**
   * 反向约束：服务端**没有**签发 retry_generation 时（例如 provider 配置错误），
   * 客户端不得自作主张给一个"再试一次"的按钮——那只会让用户再失败一次。
   */
  it("恢复契约未签发重试时客户端不显示重试入口", async () => {
    stubGateway(
      [],
      {
        status: "needs_attention",
        recovery: {
          version: 1,
          publicReasonCode: "provider_unavailable",
          retryability: "resync_required",
          allowedActions: [
            { kind: "refresh_status", runId: RUN_ID },
            { kind: "return_note", route: "note.detail", sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
          ],
        },
      },
    );
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID, activeNoteRef: null });
    render(<CardGenerationSurface />);

    await waitFor(() => expect(screen.getAllByText("生成服务暂时不可用").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /再生成一次候选/ })).toBeNull();
  });
});
