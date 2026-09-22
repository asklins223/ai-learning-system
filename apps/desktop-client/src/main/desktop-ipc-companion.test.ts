import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfilePatchV1Schema,
  companionRoomProfileV1Schema,
} from "@ailearn/shared/companion-home-contracts";
import { companionVoiceSpeakResultV1Schema } from "@ailearn/shared/companion-voice-contracts";
import {
  companionAccountPatchSchema,
  companionAccountStateV1Schema,
  companionOverviewSchema,
} from "@ailearn/shared/companion-shell-contracts";
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

import { registerM1DesktopIpc } from "./desktop-ipc";

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "request-companion-ipc",
  correlationId: "correlation-companion-ipc",
  clientStartedAt: "2026-08-23T00:00:00.000Z",
};

const roomProfile = companionRoomProfileV1Schema.parse({
  version: 1,
  revision: 2,
  unlockedDecorIds: ["keepsake.first-note"],
  equippedDecorBySlot: {
    desk: "keepsake.first-note",
    shelf: null,
    window: null,
    rest: null,
  },
  unlockedEffectIds: [],
  equippedEffectId: null,
  proactiveMuted: false,
  updatedAt: "2026-08-23T00:00:00.000Z",
});

const homeProjection = companionHomeProjectionV1Schema.parse({
  version: 1,
  snapshotAt: "2026-08-23T00:00:01.000Z",
  profileSummary: {
    name: "小岚",
    activeness: "quiet",
    boundaries: {
      allowPlayful: true,
      allowNudgeLearning: false,
      allowVoiceTags: false,
      catchphrase: null,
    },
    familiarity: 0.5,
    interactionCount: 4,
    source: "saved_profile",
  },
  memorySummary: {
    confirmedCount: 1,
    candidateCount: 0,
    updatedAt: "2026-08-23T00:00:00.000Z",
  },
  proactiveCue: null,
  roomProfile,
});

const roomPatch = companionRoomProfilePatchV1Schema.parse({
  version: 1,
  revision: 2,
  equippedDecorBySlot: { desk: null },
});

// 账号级 presence（裁决 3）：GET / PATCH /me/companion 的桌面端通道夹具。
const accountState = companionAccountStateV1Schema.parse({
  revision: 3,
  epoch: 1,
  globalEnabled: true,
  presence: { presence: "online", updatedAt: "2026-08-23T00:00:00.000Z" },
  interventionLevel: "moderate",
  quietHours: { startLocal: "22:00", endLocal: "07:00", timezone: "Asia/Shanghai" },
});

const accountOverview = companionOverviewSchema.parse({
  account: accountState,
  onboardingStates: [],
});

const accountPatch = companionAccountPatchSchema.parse({
  revision: 3,
  presence: { presence: "dnd" },
  interventionLevel: "quiet",
  quietHours: null,
});

const voiceRequest = { version: 1 as const, text: "今天还有一张复习卡。" };

const voiceResult = companionVoiceSpeakResultV1Schema.parse({
  version: 1,
  mimeType: "audio/mpeg",
  audioBase64: "SUQzBA==",
  byteLength: 4,
  voice: "zh-CN-XiaoxiaoNeural",
});

const learningRunContext = {
  version: 1 as const,
  pageKind: "learning_run" as const,
  sharing: "page_registered" as const,
  runId: "00000000-0000-4000-8000-000000000301",
  snapshotId: "00000000-0000-4000-8000-000000000302",
  taskId: "00000000-0000-4000-8000-000000000303",
  requestedCapability: "none" as const,
  contextRevision: "a".repeat(64),
  groundedTutorGrant: null,
};

const learningRunGrantRequest = {
  version: 1 as const,
  pageInstanceId: "00000000-0000-4000-8000-000000000304",
  taskId: learningRunContext.taskId,
  contextRevision: learningRunContext.contextRevision,
};

const learningRunGrant = {
  version: 1 as const,
  grantId: "00000000-0000-4000-8000-000000000305",
  userId: "00000000-0000-4000-8000-000000000306",
  workspaceId: "00000000-0000-4000-8000-000000000307",
  pageInstanceId: learningRunGrantRequest.pageInstanceId,
  pageKind: "learning_run" as const,
  capability: "grounded_tutor" as const,
  runId: learningRunContext.runId,
  snapshotId: learningRunContext.snapshotId,
  taskId: learningRunContext.taskId,
  contextRevision: learningRunContext.contextRevision,
  permissionSnapshotHash: "b".repeat(64),
  issuedAt: "2026-09-18T08:00:00.000Z",
  expiresAt: "2026-09-18T08:05:00.000Z",
  signature: "c".repeat(64),
};

function requiredHandler(channel: string): InvokeHandler {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`missing IPC handler for ${channel}`);
  return handler;
}

describe("companion home desktop IPC", () => {
  it("registers strict read, CAS-patch and voice handlers without exposing raw gateway output", async () => {
    const getHomeProjection = vi.fn().mockResolvedValue(homeProjection);
    const getRoomProfile = vi.fn().mockResolvedValue(roomProfile);
    const patchRoomProfile = vi.fn().mockResolvedValue(roomProfile);
    const speakVoice = vi.fn().mockResolvedValue(voiceResult);
    const getAccountOverview = vi.fn().mockResolvedValue(accountOverview);
    const patchAccountState = vi.fn().mockResolvedValue(accountState);
    const getCompanionLearningRunContext = vi.fn().mockResolvedValue(learningRunContext);
    const createCompanionLearningRunContextGrant = vi.fn().mockResolvedValue(learningRunGrant);
    const gateway = {
      getDeploymentConfig: () => undefined,
      getSession: vi.fn().mockResolvedValue({
        version: 1,
        status: "authenticated",
        user: {
          userId: "11111111-1111-4111-8111-111111111111",
          email: "owner@example.com",
        },
        workspace: {
          version: 1,
          workspaceId: "22222222-2222-4222-8222-222222222222",
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
      }),
      getCompanionHomeProjection: getHomeProjection,
      getCompanionRoomProfile: getRoomProfile,
      patchCompanionRoomProfile: patchRoomProfile,
      speakCompanionVoice: speakVoice,
      getCompanionAccountOverview: getAccountOverview,
      patchCompanionAccountState: patchAccountState,
      getCompanionLearningRunContext,
      createCompanionLearningRunContextGrant,
    } as unknown as DesktopGateway;
    const fakeWindow = {} as never;

    registerM1DesktopIpc({
      gateway,
      env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
      resolveWindow: () => fakeWindow,
      getWindowState: () => ({ state: "visible", revision: 1 }),
      setTitlebarTheme: () => true,
    });

    const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };
    await requiredHandler(DESKTOP_IPC_CHANNELS.authGetState)(event, { meta });
    const scopedMeta = { ...meta, workspaceEpoch: 9 };
    const homeResult = await requiredHandler(DESKTOP_IPC_CHANNELS.companionHomeGetProjection)(event, { meta: scopedMeta });
    const profileResult = await requiredHandler(DESKTOP_IPC_CHANNELS.companionRoomGetProfile)(event, { meta: scopedMeta });
    const patchResult = await requiredHandler(DESKTOP_IPC_CHANNELS.companionRoomPatchProfile)(
      event,
      { meta: scopedMeta, request: roomPatch },
    );

    expect(homeResult).toMatchObject({ ok: true, data: homeProjection, workspaceEpoch: 9 });
    expect(profileResult).toMatchObject({ ok: true, data: roomProfile, workspaceEpoch: 9 });
    expect(patchResult).toMatchObject({ ok: true, data: roomProfile, workspaceEpoch: 9 });
    expect(getHomeProjection).toHaveBeenCalledWith(meta.requestId);
    expect(getRoomProfile).toHaveBeenCalledWith(meta.requestId);
    expect(patchRoomProfile).toHaveBeenCalledWith(roomPatch, meta.requestId);

    const voiceSpeakResult = await requiredHandler(DESKTOP_IPC_CHANNELS.companionVoiceSpeak)(
      event,
      { meta: scopedMeta, request: voiceRequest },
    );
    expect(voiceSpeakResult).toMatchObject({ ok: true, data: voiceResult, workspaceEpoch: 9 });
    expect(speakVoice).toHaveBeenCalledWith(voiceRequest, meta.requestId);

    // 非法/超限文本必须在 main 边界被拒绝，绝不进入 gateway。
    for (const invalidText of ["", "   ", "字".repeat(121)]) {
      const invalidVoice = await requiredHandler(DESKTOP_IPC_CHANNELS.companionVoiceSpeak)(
        event,
        { meta: scopedMeta, request: { version: 1, text: invalidText } },
      );
      expect(invalidVoice).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    const unknownVoiceKey = await requiredHandler(DESKTOP_IPC_CHANNELS.companionVoiceSpeak)(
      event,
      { meta: scopedMeta, request: { ...voiceRequest, voice: "zh-CN-YunxiNeural" } },
    );
    expect(unknownVoiceKey).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(speakVoice).toHaveBeenCalledTimes(1);

    const invalidPatch = await requiredHandler(DESKTOP_IPC_CHANNELS.companionRoomPatchProfile)(
      event,
      { meta: scopedMeta, request: { ...roomPatch, revision: 0 } },
    );
    expect(invalidPatch).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(patchRoomProfile).toHaveBeenCalledTimes(1);

    // 账号级 presence：读走 GET，写走 revision CAS，两者都不自动重放。
    const accountOverviewResult = await requiredHandler(DESKTOP_IPC_CHANNELS.companionAccountGetState)(event, { meta: scopedMeta });
    expect(accountOverviewResult).toMatchObject({ ok: true, data: accountOverview, workspaceEpoch: 9 });
    expect(getAccountOverview).toHaveBeenCalledWith(meta.requestId);

    const accountPatchResult = await requiredHandler(DESKTOP_IPC_CHANNELS.companionAccountPatchState)(
      event,
      { meta: scopedMeta, request: accountPatch },
    );
    expect(accountPatchResult).toMatchObject({ ok: true, data: accountState, workspaceEpoch: 9 });
    expect(patchAccountState).toHaveBeenCalledWith(accountPatch, meta.requestId);

    // 非法枚举、空改动（仅 revision）与未知字段都必须在 main 边界拒绝。
    const invalidPresence = await requiredHandler(DESKTOP_IPC_CHANNELS.companionAccountPatchState)(
      event,
      { meta: scopedMeta, request: { ...accountPatch, presence: { presence: "busy" } } },
    );
    expect(invalidPresence).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const emptyPatch = await requiredHandler(DESKTOP_IPC_CHANNELS.companionAccountPatchState)(
      event,
      { meta: scopedMeta, request: { revision: 3 } },
    );
    expect(emptyPatch).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const unknownPatchKey = await requiredHandler(DESKTOP_IPC_CHANNELS.companionAccountPatchState)(
      event,
      { meta: scopedMeta, request: { ...accountPatch, clientMood: "calm" } },
    );
    expect(unknownPatchKey).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(patchAccountState).toHaveBeenCalledTimes(1);

    // 正式测评上下文通过现有 LearningRun 路由读取；每次提问的 grant 请求
    // 原样交给服务端签发，main 只做共享 schema 与 workspace epoch 边界。
    const learningContextResult = await requiredHandler(DESKTOP_IPC_CHANNELS.companionLearningRunGetContext)(
      event,
      { meta: scopedMeta, runId: learningRunContext.runId },
    );
    expect(learningContextResult).toMatchObject({ ok: true, data: learningRunContext, workspaceEpoch: 9 });
    expect(getCompanionLearningRunContext).toHaveBeenCalledWith(learningRunContext.runId, meta.requestId);

    const learningGrantResult = await requiredHandler(DESKTOP_IPC_CHANNELS.companionLearningRunCreateContextGrant)(
      event,
      { meta: scopedMeta, runId: learningRunContext.runId, request: learningRunGrantRequest },
    );
    expect(learningGrantResult).toMatchObject({ ok: true, data: learningRunGrant, workspaceEpoch: 9 });
    expect(createCompanionLearningRunContextGrant).toHaveBeenCalledWith(
      learningRunContext.runId,
      learningRunGrantRequest,
      meta.requestId,
    );

    const invalidLearningGrant = await requiredHandler(DESKTOP_IPC_CHANNELS.companionLearningRunCreateContextGrant)(
      event,
      {
        meta: scopedMeta,
        runId: learningRunContext.runId,
        request: { ...learningRunGrantRequest, contextRevision: "stale" },
      },
    );
    expect(invalidLearningGrant).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(createCompanionLearningRunContextGrant).toHaveBeenCalledTimes(1);

    getHomeProjection.mockResolvedValueOnce({ ...homeProjection, rawMemoryText: "must stay main-only" });
    const unsafeOutput = await requiredHandler(DESKTOP_IPC_CHANNELS.companionHomeGetProjection)(event, { meta: scopedMeta });
    expect(unsafeOutput).toMatchObject({
      ok: false,
      error: { code: "unsupported_contract" },
      workspaceEpoch: 9,
    });

    // 账号 overview 里出现 main-only 字段时同样 fail closed，不把原样 payload 交给渲染层。
    getAccountOverview.mockResolvedValueOnce({
      ...accountOverview,
      account: { ...accountState, rawQuietHoursSource: "must stay main-only" },
    });
    const unsafeAccountOutput = await requiredHandler(DESKTOP_IPC_CHANNELS.companionAccountGetState)(event, { meta: scopedMeta });
    expect(unsafeAccountOutput).toMatchObject({
      ok: false,
      error: { code: "unsupported_contract" },
      workspaceEpoch: 9,
    });

    // gateway 返回越界/漂移的音频 receipt 时，output schema 必须 fail closed。
    speakVoice.mockResolvedValueOnce({ ...voiceResult, mimeType: "audio/wav" });
    const unsafeVoiceOutput = await requiredHandler(DESKTOP_IPC_CHANNELS.companionVoiceSpeak)(
      event,
      { meta: scopedMeta, request: voiceRequest },
    );
    expect(unsafeVoiceOutput).toMatchObject({
      ok: false,
      error: { code: "unsupported_contract" },
      workspaceEpoch: 9,
    });
  });
});
