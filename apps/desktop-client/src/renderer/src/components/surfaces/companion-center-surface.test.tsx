// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GatewayResultV1, SessionContextV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type {
  CompanionHistoryItemV1,
  CompanionMemoryItemV1,
  CompanionMemoryStarMapV2,
  CompanionPersonaV1,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompanionChatProvider,
  useCompanionChat,
  type CompanionUiMode,
} from "../../app/companion-chat-session";
import { useRoomStore } from "../../app/room-store";
import { CompanionCenterSurface } from "./companion-center-surface";

/**
 * 伴星中心与伴星叠加层是**兄弟节点**：一个在任务面里，一个挂在 App 外壳。
 * 两者共用同一条会话，所以 `CompanionChatProvider` 必须挂在两棵子树之上——
 * 曾经它只包住叠加层，surface 里的 `useCompanionChat()` 便在渲染时抛错，
 * 而应用没有 ErrorBoundary，点「伴星中心」= 整页黑屏。
 *
 * 这里的用例因此按真实外壳的形状渲染：Provider 在外，surface 在内。
 * 「继续交流」必须落到**同一条**会话上（叠加层的交互台读的就是它），
 * 所以断言读的是 Provider 的 mode，而不是 surface 自己的局部状态。
 */

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const UPDATED_AT = "2026-09-19T08:00:00.000Z";

function session(): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "55555555-5555-4555-8555-555555555555", email: "reader@example.com" },
    workspace: {
      version: 1,
      workspaceId: WORKSPACE_ID,
      name: "理解空间",
      role: "owner",
      workspaceType: "personal",
      isPersonal: true,
      workspaceEpoch: 7,
    },
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch: 7,
    credentialPersistence: "memory",
  };
}

function ok<T>(data: T): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "companion-center-test",
    correlationId: "companion-center-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

function memoryItem(): CompanionMemoryItemV1 {
  return {
    memoryItemId: MEMORY_ID,
    kind: "preference",
    content: "我更喜欢从例子开始理解概念",
    sourceEventId: null,
    sourceSessionId: null,
    userStated: true,
    userConfirmed: true,
    candidate: false,
    importance: 0.9,
    confidence: 1,
    scope: "workspace",
    pinned: true,
    archived: false,
    dismissedAt: null,
    conflictGroup: null,
    embeddingStatus: "ready",
    sourceType: "confirmed",
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function starMap(): CompanionMemoryStarMapV2 {
  return {
    version: 2,
    nodes: [{
      memoryId: MEMORY_ID,
      kind: "preference",
      content: "我更喜欢从例子开始理解概念",
      state: "pinned",
      importance: 0.9,
      updatedAt: UPDATED_AT,
      entityLinks: [{
        entityType: "note",
        entityId: NOTE_ID,
        label: "牛顿第二定律笔记",
        target: { kind: "note", noteId: NOTE_ID },
        orphaned: false,
      }],
    }],
    cursor: null,
  };
}

function persona(): CompanionPersonaV1 {
  return { version: 1, profile: null, presets: [], activePreset: null };
}

function historyItem(): CompanionHistoryItemV1 {
  return {
    version: 1,
    messageId: MESSAGE_ID,
    role: "assistant",
    kind: "text",
    blocks: [{ type: "text", text: "可以先从这道例题入手。" }],
    runId: null,
    createdAt: UPDATED_AT,
    editedAt: null,
  };
}

function installApi() {
  const api = {
    auth: { getState: vi.fn(async () => ok(session())) },
    companion: {
      bridge: {
        setContext: vi.fn(async () => ok({ version: 1, ok: true })),
        clearContext: vi.fn(async () => ok({ version: 1, ok: true })),
      },
      memory: {
        starMap: vi.fn(async () => ok(starMap())),
        list: vi.fn(async () => ok({ version: 2, items: [memoryItem()] })),
      },
      persona: { get: vi.fn(async () => ok(persona())) },
      history: { list: vi.fn(async () => ok({ version: 1, items: [historyItem()], nextCursor: null })) },
      learningContext: { get: vi.fn(async () => { throw new Error("learning context unavailable"); }) },
      journey: { bootstrap: vi.fn(async () => { throw new Error("journey unavailable"); }) },
      activity: { timeline: vi.fn(async () => { throw new Error("activity unavailable"); }) },
      daily: { get: vi.fn(async () => { throw new Error("daily unavailable"); }) },
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ version: 1, subscriptionId: "subscription-1" })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ok({ version: 1, ok: true })),
    },
  };
  Object.defineProperty(window, "ailearn", { configurable: true, value: api });
  return api;
}

/** 外壳里同一条会话的读数：叠加层的交互台读的就是它。 */
let shellMode: CompanionUiMode | null = null;
function ShellSessionProbe() {
  shellMode = useCompanionChat().mode;
  return null;
}

beforeEach(() => {
  shellMode = null;
  // jsdom 没有这两个浏览器接口，而星图画布组件在挂载时会用到它们。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      media: "",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(window, "ResizeObserver");
  Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  // 房间 store 是模块级单例，测试文件之间共用。
  useRoomStore.setState({ hudPage: "home", surface: null, companionCenterTarget: null });
  vi.restoreAllMocks();
});

function renderCompanionCenter() {
  // 与 App 同形：Provider 在两者之上，叠加层（探针）与任务面 surface 是兄弟。
  render(
    <CompanionChatProvider>
      <ShellSessionProbe />
      <CompanionCenterSurface />
    </CompanionChatProvider>,
  );
}

describe("the companion center reads the shell's companion session", () => {
  it("renders the persisted memory graph instead of throwing on an unprovided context", async () => {
    installApi();
    renderCompanionCenter();

    // 记忆列表与星图索引都必须来自服务端确认的记录（候选不进图，见 universe 用例）。
    // 同一条记忆会同时出现在左侧列表和右侧星图索引里，所以这里读的是集合。
    expect((await screen.findAllByText("我更喜欢从例子开始理解概念")).length).toBeGreaterThan(0);
    const index = screen.getByRole("listbox", { name: "星图等价节点索引" });
    expect(index.textContent).toContain("牛顿第二定律笔记");
    expect(screen.queryByText("伴星中心暂时不可用")).toBeNull();
  });

  it("opens the same conversation the companion overlay renders", async () => {
    installApi();
    renderCompanionCenter();

    fireEvent.click(await screen.findByRole("tab", { name: "对话" }, { timeout: 5000 }));
    fireEvent.click(await screen.findByRole("button", { name: /继续交流/ }));

    expect(shellMode).toBe("conversation");
    // 服务端确认的对话记录按全局时间排在同一页上。
    await screen.findByText("可以先从这道例题入手。");
  });
});
