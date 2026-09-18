import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  companionDailySummaryV1Schema,
  companionMemoryItemV1Schema,
  companionMemoryListV1Schema,
  companionMemoryStarMapV1Schema,
  companionPersonaV1Schema,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { companionConversationListV1Schema } from "@ailearn/shared/companion-memory-desktop-contracts";
import type { DesktopGateway } from "./desktop-gateway";

type InvokeHandler = (
  event: { readonly sender: unknown; readonly senderFrame?: { readonly url: string } },
  input: unknown,
) => Promise<GatewayResultV1<unknown>>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle: electronMock.handle, on: vi.fn() },
}));

const MEMORY_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "request-companion-memory-ipc",
  correlationId: "correlation-companion-memory-ipc",
  clientStartedAt: "2026-09-16T00:00:00.000Z",
};
const scopedMeta = { ...meta, workspaceEpoch: 9 };

const memoryItem = companionMemoryItemV1Schema.parse({
  memoryItemId: MEMORY_ID,
  kind: "preference",
  content: "我开始能区分熟悉和理解",
  sourceEventId: null,
  sourceSessionId: null,
  userStated: true,
  userConfirmed: false,
  candidate: true,
  importance: 0.6,
  confidence: 0.5,
  scope: "workspace",
  pinned: false,
  archived: false,
  dismissedAt: null,
  conflictGroup: null,
  embeddingStatus: "none",
  sourceType: "model_inferred",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
});

const memoryList = companionMemoryListV1Schema.parse({ version: 2, items: [memoryItem] });

const starMap = companionMemoryStarMapV1Schema.parse({
  version: 1,
  nodes: [{
    memoryId: MEMORY_ID,
    kind: "preference",
    content: "我开始能区分熟悉和理解",
    state: "active",
    entityLinks: [{ entityType: "note", entityId: "44444444-4444-4444-8444-444444444444", orphaned: false }],
  }],
  cursor: null,
});

const daily = companionDailySummaryV1Schema.parse({
  version: 1,
  date: "2026-09-15",
  status: "generated",
  generatedAt: "2026-09-15T23:50:00.000Z",
  summary: "今天补全了错误类型的定义。",
  facts: { notesUpdated: 2, learningRunsCompleted: 1 },
  conversationHighlights: [{ role: "user", text: "我开始能区分熟悉和理解" }],
  memory: { memoryItemId: MEMORY_ID, candidate: true },
});

const persona = companionPersonaV1Schema.parse({
  version: 1,
  profile: {
    id: "55555555-5555-4555-8555-555555555555",
    workspaceId: WORKSPACE_ID,
    userId: "11111111-1111-4111-8111-111111111111",
    presetId: null,
    name: "沉稳助手",
    personalityTags: ["专业", "可靠"],
    speakingStyle: "专业、可靠、克制。",
    examples: [{ text: "建议先确认目标，再安排复习。" }],
    activeness: "quiet",
    boundaries: { allowPlayful: false, allowNudgeLearning: true },
    revision: 3,
    familiarity: 0.12,
    interactionCount: 4,
    lastActiveAt: null,
    createdAt: "2026-08-23T06:47:30.283Z",
    updatedAt: "2026-08-23T06:47:49.196Z",
  },
  presets: [],
  activePreset: null,
});

const conversations = companionConversationListV1Schema.parse({
  version: 1,
  items: [{
    version: 1,
    id: "9a67250d-906e-42b7-8f6a-c4c3ef5207f7",
    workspaceId: WORKSPACE_ID,
    userId: "11111111-1111-4111-8111-111111111111",
    kind: "dialogue",
    title: "请用一句话解释牛顿第二定律",
    titleSource: "auto",
    status: "active",
    createdAt: "2026-08-20T01:33:39.102Z",
    updatedAt: "2026-08-20T01:41:43.279Z",
    lastMessageAt: "2026-08-20T01:41:49.997Z",
  }],
  nextCursor: null,
});

function requiredHandler(channel: string): InvokeHandler {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`missing IPC handler for ${channel}`);
  return handler;
}

/**
 * The registration guard is per module instance, so each case loads a fresh
 * copy of the IPC module; the electron mock is shared, which means the second
 * registration simply replaces the first one's handler table.
 */
async function register(gateway: DesktopGateway) {
  vi.resetModules();
  const { registerM1DesktopIpc } = await import("./desktop-ipc");
  registerM1DesktopIpc({
    gateway,
    env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => ({}) as never,
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
  });
}

const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };

function sessionStub() {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" },
    workspace: {
      version: 1,
      workspaceId: WORKSPACE_ID,
      name: "Owner workspace",
      role: "owner",
      workspaceType: "personal",
      isPersonal: true,
      workspaceEpoch: 9,
    },
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch: 9,
    credentialPersistence: "memory",
  };
}

describe("companion centre desktop IPC", () => {
  it("reads the four record families through typed, validated channels", async () => {
    const gateway = {
      getDeploymentConfig: () => undefined,
      getSession: vi.fn().mockResolvedValue(sessionStub()),
      listCompanionMemories: vi.fn().mockResolvedValue(memoryList),
      getCompanionMemoryStarMap: vi.fn().mockResolvedValue(starMap),
      getCompanionDailySummary: vi.fn().mockResolvedValue(daily),
      getCompanionPersona: vi.fn().mockResolvedValue(persona),
      listCompanionConversations: vi.fn().mockResolvedValue(conversations),
    } as unknown as DesktopGateway;
    await register(gateway);

    await requiredHandler(DESKTOP_IPC_CHANNELS.authGetState)(event, { meta });

    const list = await requiredHandler(DESKTOP_IPC_CHANNELS.companionMemoryList)(event, {
      meta: scopedMeta,
      query: { includeCandidates: true, includeArchived: true },
    });
    expect(list).toMatchObject({ ok: true, data: memoryList, workspaceEpoch: 9 });
    expect((gateway as unknown as { listCompanionMemories: ReturnType<typeof vi.fn> }).listCompanionMemories)
      .toHaveBeenCalledWith({ includeCandidates: true, includeArchived: true }, meta.requestId);

    const trail = await requiredHandler(DESKTOP_IPC_CHANNELS.companionMemoryStarMap)(event, { meta: scopedMeta });
    expect(trail).toMatchObject({ ok: true, data: starMap, workspaceEpoch: 9 });

    const diary = await requiredHandler(DESKTOP_IPC_CHANNELS.companionDailyGet)(event, { meta: scopedMeta, date: "2026-09-15" });
    expect(diary).toMatchObject({ ok: true, data: daily, workspaceEpoch: 9 });
    expect((gateway as unknown as { getCompanionDailySummary: ReturnType<typeof vi.fn> }).getCompanionDailySummary)
      .toHaveBeenCalledWith("2026-09-15", meta.requestId);

    const personaResult = await requiredHandler(DESKTOP_IPC_CHANNELS.companionPersonaGet)(event, { meta: scopedMeta });
    expect(personaResult).toMatchObject({ ok: true, data: persona, workspaceEpoch: 9 });

    const dialogue = await requiredHandler(DESKTOP_IPC_CHANNELS.companionConversationsList)(event, { meta: scopedMeta, limit: 20 });
    expect(dialogue).toMatchObject({ ok: true, data: conversations, workspaceEpoch: 9 });
    expect((gateway as unknown as { listCompanionConversations: ReturnType<typeof vi.fn> }).listCompanionConversations)
      .toHaveBeenCalledWith(20, meta.requestId);
  });

  it("routes each verdict to its own gateway method and rejects malformed ids", async () => {
    const mutate = vi.fn().mockResolvedValue(memoryItem);
    const gateway = {
      getDeploymentConfig: () => undefined,
      getSession: vi.fn().mockResolvedValue(sessionStub()),
      confirmCompanionMemory: mutate,
      pinCompanionMemory: mutate,
      unpinCompanionMemory: mutate,
      archiveCompanionMemory: mutate,
      restoreCompanionMemory: mutate,
      deleteCompanionMemory: vi.fn().mockResolvedValue({ memoryItemId: MEMORY_ID }),
    } as unknown as DesktopGateway;
    await register(gateway);

    await requiredHandler(DESKTOP_IPC_CHANNELS.authGetState)(event, { meta });

    for (const channel of [
      DESKTOP_IPC_CHANNELS.companionMemoryConfirm,
      DESKTOP_IPC_CHANNELS.companionMemoryPin,
      DESKTOP_IPC_CHANNELS.companionMemoryUnpin,
      DESKTOP_IPC_CHANNELS.companionMemoryArchive,
      DESKTOP_IPC_CHANNELS.companionMemoryRestore,
    ]) {
      const result = await requiredHandler(channel)(event, { meta: scopedMeta, memoryId: MEMORY_ID });
      expect(result).toMatchObject({ ok: true, data: memoryItem, workspaceEpoch: 9 });
    }
    expect(mutate).toHaveBeenCalledTimes(5);
    expect(mutate).toHaveBeenCalledWith(MEMORY_ID, meta.requestId);

    const removed = await requiredHandler(DESKTOP_IPC_CHANNELS.companionMemoryDelete)(event, { meta: scopedMeta, memoryId: MEMORY_ID });
    expect(removed).toMatchObject({ ok: true, data: { memoryItemId: MEMORY_ID }, workspaceEpoch: 9 });

    // A non-uuid id never reaches the gateway.
    const invalid = await requiredHandler(DESKTOP_IPC_CHANNELS.companionMemoryDelete)(event, { meta: scopedMeta, memoryId: "not-a-uuid" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect((gateway as unknown as { deleteCompanionMemory: ReturnType<typeof vi.fn> }).deleteCompanionMemory).toHaveBeenCalledTimes(1);

    // An unknown query key is a contract violation, not something to forward.
    const unknownQuery = await requiredHandler(DESKTOP_IPC_CHANNELS.companionMemoryList)(event, {
      meta: scopedMeta,
      query: { includeCandidates: true, includeDeleted: true },
    });
    expect(unknownQuery).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("fails closed when a record carries a main-only field", async () => {
    const drifted = { ...memoryItem, rawMemoryEmbedding: "must stay main-only" };
    const gateway = {
      getDeploymentConfig: () => undefined,
      getSession: vi.fn().mockResolvedValue(sessionStub()),
      confirmCompanionMemory: vi.fn().mockResolvedValue(drifted),
      getCompanionMemoryStarMap: vi.fn().mockResolvedValue({
        ...starMap,
        nodes: [{ ...starMap.nodes[0], embedding: [0.1, 0.2] }],
      }),
    } as unknown as DesktopGateway;
    await register(gateway);

    await requiredHandler(DESKTOP_IPC_CHANNELS.authGetState)(event, { meta });

    const unsafeMemory = await requiredHandler(DESKTOP_IPC_CHANNELS.companionMemoryConfirm)(event, {
      meta: scopedMeta,
      memoryId: MEMORY_ID,
    });
    expect(unsafeMemory).toMatchObject({ ok: false, error: { code: "unsupported_contract" }, workspaceEpoch: 9 });

    const unsafeTrail = await requiredHandler(DESKTOP_IPC_CHANNELS.companionMemoryStarMap)(event, { meta: scopedMeta });
    expect(unsafeTrail).toMatchObject({ ok: false, error: { code: "unsupported_contract" }, workspaceEpoch: 9 });
  });
});
