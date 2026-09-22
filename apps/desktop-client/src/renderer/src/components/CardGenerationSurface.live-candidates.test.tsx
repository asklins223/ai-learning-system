// @vitest-environment jsdom

import { randomUUID } from "node:crypto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardGenerationSurface } from "./CardGenerationSurface";
import { useRoomStore } from "../app/room-store";

/**
 * 生成中那一屏在"逐张落盘"之后必须有的样子（方案 A1 · B4）。
 *
 * 背景：候选现在一张一个事务提交（B2），第 1 张写完另一条连接就读得到——但界面在
 * 走到审核阶段之前**根本不去拉**候选列表（`load()` 里那个 review 判定），于是"逐张
 * 可见"这件事对用户并不成立，屏幕上还是只有百分比和四步轨道。这几条钉的是：
 * 1. 在途期间真的去读候选，并把已经落地的每张的题面列出来（张数只有一个来源：
 *    服务端返回的那一份列表，界面不自己数 progress 里的数当张数用）；
 * 2. 没落地的东西不能被提前列出来（`planning` 时列表是空的，不能亮一个 0 张的空壳）；
 * 3. 被门禁判掉/被丢弃的那些不算"写好的卡"；
 * 4. 在途时**不能**出现审核动作（保留/不保留的按钮），决定要等这一批走完。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "aaaaaaa4-4444-4444-8444-444444444444";

interface Row {
  candidateId: string;
  prompt: string;
  concept: string;
  qualityState: string;
  reviewDecision?: string;
  publishState?: string;
}

function stubGateway(options: {
  status: string;
  rows: Row[];
  progress?: Record<string, number> | null;
}) {
  // 候选列表的形状按**服务端投影**写（apps/api serializeCandidatePublic +
  // cardGenerationCandidateListV1Schema），不从客户端组件反推：反推出来的 stub
  // 会把"服务端其实没发这个字段"藏起来。
  const candidates = options.rows.map((row, index) => ({
    // 契约是 strict + uuid + 64hex（cardGenerationCandidateV1Schema），stub 不照它写
    // 就只会在网关解析处静默失败——那看起来像"界面没渲染"，其实是数据没过合同。
    version: 1,
    candidateId: row.candidateId,
    planRevisionId: "3f2b6c1e-5d4a-4a55-9b77-1c2d3e4f5061",
    candidateRevisionId: randomUUID(),
    revision: 1,
    runId: RUN_ID,
    planRevisionId: "plan-rev-1",
    planVersion: 1,
    planObjectiveLocalId: `obj-${index + 1}`,
    recommendation: { recommended: true, reasonCodes: ["mechanism_gap"] },
    objective: { statement: `${row.concept}这条结论`, publicSummary: row.concept, knowledgeForm: "causal_model" },
    front: { cue: "要点", prompt: row.prompt },
    strategy: "why",
    transformationKind: "mechanism_reconstruction",
    estimatedReviewSeconds: 45,
    evidenceSetHash: "e".repeat(64),
    candidateEvidenceBindingPlanHash: "b".repeat(64),
    candidateRevisionHash: `hash-${index}`,
    qualityState: row.qualityState,
    practiceItem: null,
    reviewDecision: row.reviewDecision ?? "undecided",
    publishState: row.publishState ?? "unpublished",
    // 可审核判据按服务端那支函数算（isCandidateReviewReadyV2），不从客户端组件反推。
    isReviewReady:
      row.qualityState === "passed"
      && (row.reviewDecision ?? "undecided") === "undecided"
      && (row.publishState ?? "unpublished") === "unpublished",
  }));
  const run = {
    version: 1,
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status: options.status,
    cardContentEpoch: 1,
    currentPlanVersion: 1,
    reviewDraftRevision: 1,
    sourceOutdated: false,
    sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID },
    recovery: null,
    progress: options.progress ?? null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
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
          activeGenerationSummary: {
            state: "data",
            data: { ...run, route: { kind: "note.cardGeneration", cardGenerationRunId: RUN_ID } },
          },
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
        getRun: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: run })),
        getCandidates: vi.fn(async () => ({
          ok: true as const,
          workspaceEpoch: 1,
          data: {
            candidates,
            practiceQuota: { requiredCount: 3, metCount: 0 },
            total: candidates.length,
            page: 1,
            pageSize: 50,
            totalPages: 1,
          },
        })),
        decideCandidate: vi.fn(),
        revealCandidate: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: {} })),
        recordExposure: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: {} })),
        closeRun: vi.fn(),
        cancelRun: vi.fn(),
        retryRun: vi.fn(),
        activateCandidates: vi.fn(),
        getActivation: vi.fn(),
      },
    },
  };
  Object.defineProperty(window, "ailearn", { value: gateway, configurable: true });
  return gateway;
}

function renderSurface() {
  // 与既有的审核用例同一入口：这条屏靠 `activeCardGenerationRunId` 认任务，
  // 不是靠某个 view 字段（照别的文件抄，别自己发明挂载方式）。
  useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
  return render(<CardGenerationSurface />);
}

const LANDED: Row[] = [
  { candidateId: randomUUID(), prompt: "第一次提取时要先想起什么？", concept: "提取线索", qualityState: "authored" },
  { candidateId: randomUUID(), prompt: "为什么延迟会变高？", concept: "重传触发", qualityState: "authored" },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.setState({ activeCardGenerationRunId: null, activeNoteRef: null, surface: null, returnTarget: null });
});

describe("生成中的那一屏：已经写好的卡要一张张出现", () => {
  it("authoring 期间就去读候选，并把落地的题面列出来", async () => {
    const gateway = stubGateway({
      status: "authoring",
      rows: LANDED,
      progress: { plannedCards: 6, authored: 2, gatePassed: 0, gateFailed: 0 },
    });
    renderSurface();

    await waitFor(() => expect(gateway.note.cardGeneration.getCandidates).toHaveBeenCalled());
    // 张数只有一个来源：列表里出现几条就说几条，且必须是服务端那一份。
    expect(await screen.findByText("第一次提取时要先想起什么？")).toBeTruthy();
    expect(screen.getByText("为什么延迟会变高？")).toBeTruthy();
    expect(screen.getAllByTestId("card-generation-landing-item")).toHaveLength(2);
    // 同一屏只准有一个"已写几张"的数：它必须来自进度头条（与服务端候选计数同源），
    // 列表自己不再报第二个数。
    const countLines = screen.getAllByText(/已写出 \d+ \/ \d+ 张候选/);
    expect(countLines).toHaveLength(1);
    expect(screen.queryByText(/已经写好 \d+ 张/)).toBeNull();
  });

  it("被门禁判掉或被丢弃的那几张不算\"写好的卡\"", async () => {
    stubGateway({
      status: "authoring",
      rows: [
        ...LANDED,
        { candidateId: randomUUID(), prompt: "这条根本不该出现", concept: "落选", qualityState: "dropped" },
        { candidateId: randomUUID(), prompt: "没过证据这一关", concept: "失败", qualityState: "failed" },
      ],
      progress: { plannedCards: 6, authored: 4, gatePassed: 0, gateFailed: 0 },
    });
    renderSurface();

    await waitFor(() => expect(screen.getAllByTestId("card-generation-landing-item")).toHaveLength(2));
    expect(screen.queryByText("这条根本不该出现")).toBeNull();
    expect(screen.queryByText("没过证据这一关")).toBeNull();
  });

  it("planning 阶段一张都还没有 → 不亮空壳，也不报\"已写好 0 张\"", async () => {
    stubGateway({ status: "planning", rows: [], progress: { plannedCards: 6, authored: 0, gatePassed: 0, gateFailed: 0 } });
    renderSurface();

    await waitFor(() => expect(screen.getByLabelText("生成进度")).toBeTruthy());
    expect(screen.queryByTestId("card-generation-landing-item")).toBeNull();
    expect(screen.queryByText("已经写好的卡，后面的还在写")).toBeNull();
  });

  it("在途时不给审核动作：决定要等这一批走完", async () => {
    stubGateway({
      status: "authoring",
      rows: LANDED,
      progress: { plannedCards: 6, authored: 2, gatePassed: 0, gateFailed: 0 },
    });
    renderSurface();

    await waitFor(() => expect(screen.getAllByTestId("card-generation-landing-item")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /^保留/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /不保留/ })).toBeNull();
  });

  it("正向对照：同一批候选到了审核阶段就有这两个按钮（不然上面那条否定式断言是空的）", async () => {
    stubGateway({
      status: "review_ready",
      rows: LANDED.map((row) => ({ ...row, qualityState: "passed" })),
      progress: { plannedCards: 6, authored: 6, gatePassed: 6, gateFailed: 0 },
    });
    renderSurface();

    expect(await screen.findByRole("button", { name: /^保留/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /不保留/ })).toBeTruthy();
    // 到了审核阶段，逐张清单让位给逐张审核卡片。
    expect(screen.queryByTestId("card-generation-landing-item")).toBeNull();
  });
});
