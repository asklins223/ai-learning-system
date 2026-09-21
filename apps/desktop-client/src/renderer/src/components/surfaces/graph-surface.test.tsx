// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  UnderstandingEdgeProjectionV3,
  UnderstandingNodeProjectionV3,
} from "@ailearn/shared/understanding-topology-v3-contracts";
import { useRoomStore } from "../../app/room-store";
import { GraphSurface } from "./graph-surface";

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => null),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let uuid = 0;
function nextId(): string {
  uuid += 1;
  return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
}

const OBJECTIVE_ID = nextId();
const NOTE_ID = nextId();
const SOURCE_ID = nextId();
const EVIDENCE_ID = nextId();

function snapshot(overrides: Partial<{ nodes: UnderstandingNodeProjectionV3[]; edges: UnderstandingEdgeProjectionV3[]; truncated: boolean }> = {}) {
  const nodes: UnderstandingNodeProjectionV3[] = overrides.nodes ?? [
    {
      nodeRef: { kind: "objective", objectiveId: OBJECTIVE_ID },
      label: "提取练习",
      publicSummary: "关于提取练习的主张",
      activeCardId: null,
      lifecycle: "active",
      freshness: "fresh",
      personal: {
        state: "learning",
        activeRunId: nextId(),
        activeScheduleId: null,
        nextReviewAt: null,
        practiceTrailCount: 0,
        lastCanonicalEventId: null,
        primaryAction: { kind: "none" },
      },
    } as UnderstandingNodeProjectionV3,
    {
      nodeRef: { kind: "note", noteId: NOTE_ID },
      label: "记忆笔记",
      currentVersionId: nextId(),
      hasSource: true,
    },
    {
      nodeRef: { kind: "source", sourceId: SOURCE_ID },
      label: "认知科学讲义",
      modality: "web",
      createdAt: "2026-09-01T08:00:00+08:00",
    },
    {
      nodeRef: { kind: "evidence", evidenceSnapshotId: EVIDENCE_ID },
      supportSummary: "来自讲义第 3 段的证据",
      sourceLabel: "认知科学讲义",
      restricted: false,
    },
  ];
  const edges: UnderstandingEdgeProjectionV3[] = overrides.edges ?? [
    {
      edgeId: "edge-note-objective",
      kind: "sourced_from",
      from: { kind: "note", id: NOTE_ID },
      to: { kind: "objective", id: OBJECTIVE_ID },
      reasonCodes: [],
    },
    {
      edgeId: "edge-evidence-objective",
      kind: "supported_by",
      from: { kind: "objective", id: OBJECTIVE_ID },
      to: { kind: "evidence", id: EVIDENCE_ID },
      reasonCodes: [],
    },
    {
      edgeId: "edge-source-note",
      kind: "contains_note",
      from: { kind: "source", id: SOURCE_ID },
      to: { kind: "note", id: NOTE_ID },
      reasonCodes: [],
    },
  ];
  return {
    version: 3 as const,
    workspaceId: "00000000-0000-4000-8000-000000000001",
    topologyRevision: "rev-1",
    checkpointToken: "cp-1",
    nodes,
    edges,
    continuationToken: null,
    integrity: { truncated: overrides.truncated ?? false, missingOriginObjectiveIds: [] },
  };
}

function stubGateway(result: ReturnType<typeof snapshot> | { failure: true }) {
  const gateway = {
    auth: {
      getState: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { status: "authenticated" as const, workspace: { workspaceId: "workspace-1" } },
      })),
    },
    understanding: {
      getTopology: vi.fn(async () => (
        "failure" in result
          ? { ok: false as const, error: { code: "api_unavailable" as const, safeMessageKey: "error.api_unavailable", retry: "user_action" as const } }
          : { ok: true as const, workspaceEpoch: 1, data: result }
      )),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return gateway;
}

describe("GraphSurface · Web 成熟版 Understanding Universe 移植", () => {
  it("以可缩放 Canvas 呈现真实节点、关系和完整图例", async () => {
    stubGateway(snapshot());
    render(<GraphSurface />);

    expect(await screen.findByRole("region", { name: "理解星图：你的真实知识宇宙" })).toBeTruthy();
    expect(screen.getByLabelText("星体图例").textContent).toContain("来源行星");
    expect(screen.getByLabelText("星体图例").textContent).toContain("证据卫星");
  });

  it("页标题只出现一次：外壳承担标题，画布不再重复", async () => {
    stubGateway(snapshot());
    render(<GraphSurface />);

    await screen.findByRole("region", { name: "理解星图：你的真实知识宇宙" });
    expect(screen.getAllByRole("heading", { name: "理解星图" })).toHaveLength(1);
    expect(screen.queryByText("理解关系图")).toBeNull();
  });

  it("图层读数按真实拓扑报告星体、恒星、证据与光路", async () => {
    stubGateway(snapshot());
    render(<GraphSurface />);

    const readout = await screen.findByText("4 / 4 星体 · 1 理解恒星 · 1 证据卫星 · 3 真实光路");
    expect(readout.className).toContain("universe-layer-readout");
  });

  it("保留成熟版的缩放、适配、状态筛选和图层控制", async () => {
    stubGateway(snapshot());
    render(<GraphSurface />);

    await screen.findByRole("region", { name: "理解星图：你的真实知识宇宙" });
    expect(screen.getByRole("button", { name: "放大星图" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "缩小星图" })).toBeTruthy();
    // 适配只重置相机；恢复默认布局（清除手动拖拽）是独立的破坏性动作。
    expect(screen.getByRole("button", { name: "适配全部星图" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "清除手动拖拽并恢复默认布局" })).toBeTruthy();
    expect(screen.getByLabelText("按理解目标状态筛选星图")).toBeTruthy();
    expect(screen.getByLabelText("控制知识宇宙图层")).toBeTruthy();
  });

  it("搜索可以聚焦星体并打开带真实关系的详情抽屉", async () => {
    stubGateway(snapshot());
    render(<GraphSurface />);

    const search = await screen.findByRole("combobox", { name: "搜索理解星图" });
    fireEvent.change(search, { target: { value: "提取练习" } });
    const listbox = await screen.findByRole("listbox", { name: "搜索结果" });
    const result = await within(listbox).findByRole("option", { name: /提取练习/ });
    fireEvent.click(result);

    await waitFor(() => {
      expect((search as HTMLInputElement).value).toBe("");
      const detail = screen.getByRole("complementary", { name: "星体详情" });
      expect(detail.textContent).toContain("关于提取练习的主张");
      expect(detail.textContent).toContain("直接关系");
      expect(detail.textContent).toContain("2 条");
      expect(detail.textContent).toContain("记忆笔记");
      expect(detail.textContent).toContain("认知科学讲义");
    });
  });

  it("详情抽屉的目标行动进入同一目标并保留返回星图", async () => {
    stubGateway(snapshot());
    const invoke = vi.fn();
    useRoomStore.setState({ invoke } as never);
    render(<GraphSurface />);

    const search = await screen.findByRole("combobox", { name: "搜索理解星图" });
    fireEvent.change(search, { target: { value: "提取练习" } });
    const listbox = await screen.findByRole("listbox", { name: "搜索结果" });
    fireEvent.click(await within(listbox).findByRole("option", { name: /提取练习/ }));
    fireEvent.click(screen.getByRole("button", { name: /查看目标详情/ }));

    expect(useRoomStore.getState().activeObjectiveId).toBe(OBJECTIVE_ID);
    expect(invoke).toHaveBeenCalledWith("open-objective", {
      returnTo: { label: "返回星图", run: expect.any(Function) },
    });
  });

  it("服务端没有节点时不造假，解释星体如何出现", async () => {
    const invoke = vi.fn();
    useRoomStore.setState({ invoke } as never);
    stubGateway(snapshot({ nodes: [], edges: [] }));
    render(<GraphSurface />);

    expect(await screen.findByText("这片宇宙还没有星体")).toBeTruthy();
    expect(screen.getByText(/先从来源写下笔记并形成理解目标/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看来源库" }));
    expect(invoke).toHaveBeenCalledWith("open-sources");
  });

  it("没有对应数据的图层控制会明确禁用，不伪装成有效操作", async () => {
    stubGateway(snapshot({
      nodes: snapshot().nodes.filter((node) => node.nodeRef.kind === "objective"),
      edges: [],
    }));
    render(<GraphSurface />);

    await screen.findByRole("region", { name: "理解星图：你的真实知识宇宙" });
    expect((screen.getByRole("checkbox", { name: "证据卫星" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "来源行星" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "关系光路" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("读取失败时给重试，不用演示数据填充", async () => {
    const gateway = stubGateway({ failure: true });
    render(<GraphSurface />);

    expect(await screen.findByText("理解星图暂时不可用")).toBeTruthy();
    gateway.understanding.getTopology.mockResolvedValueOnce({ ok: true as const, workspaceEpoch: 1, data: snapshot() });
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByText("4 / 4 星体 · 1 理解恒星 · 1 证据卫星 · 3 真实光路")).toBeTruthy();
  });

  it("服务端上报截断时如实说明载入边界", async () => {
    stubGateway(snapshot({ truncated: true }));
    render(<GraphSurface />);

    expect(await screen.findByText(/这张星图已经装到本次的上限/)).toBeTruthy();
  });

  it("缩放读数不进入无障碍树，避免缩放过程被逐帧播报", async () => {
    stubGateway(snapshot());
    const { container } = render(<GraphSurface />);

    await screen.findByRole("region", { name: "理解星图：你的真实知识宇宙" });
    const readout = container.querySelector(".universe-canvas-readout");
    // <output> carries an implicit aria-live="polite"; a plain aria-hidden span
    // cannot be announced, which is the point.
    expect(readout?.tagName).toBe("SPAN");
    expect(readout?.getAttribute("aria-hidden")).toBe("true");
  });

  it("没有可见星体时，键盘索引不留下空的 tab 停靠点", async () => {
    stubGateway(snapshot({ nodes: [], edges: [] }));
    render(<GraphSurface />);

    await screen.findByText("这片宇宙还没有星体");
    const index = screen.getByRole("listbox", { name: /星图节点索引/ });
    expect(index.getAttribute("tabindex")).toBe("-1");
  });

  it("打开详情面板时焦点进入面板，Esc 关闭后交还", async () => {
    stubGateway(snapshot());
    render(<GraphSurface />);

    const search = await screen.findByRole("combobox", { name: "搜索理解星图" });
    fireEvent.change(search, { target: { value: "提取练习" } });
    const listbox = await screen.findByRole("listbox", { name: "搜索结果" });
    fireEvent.click(await within(listbox).findByRole("option", { name: /提取练习/ }));

    const panel = await screen.findByRole("complementary", { name: "星体详情" });
    await waitFor(() => {
      expect(panel.contains(document.activeElement)).toBe(true);
    });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(panel.getAttribute("aria-hidden")).toBe("true");
      expect(panel.contains(document.activeElement)).toBe(false);
    });
  });
});
