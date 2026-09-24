// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GatewayResultV1, SessionContextV1, WorkspaceAiSettingsV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { DesktopAiAuditItemV1 } from "@ailearn/shared/desktop-surface-contracts";
import { AI_CONSENT_VERSION } from "@ailearn/shared/desktop-ipc-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QWEN_TTS_VOICE_OPTIONS } from "@ailearn/shared/tts-voice-catalog";
import { useRoomStore } from "../../app/room-store";
import { SETTINGS_ATTENTION_AI_CONSENT } from "../../app/companion-consent-gate";
import { SETTINGS_ATTENTION_MS, SettingsSurface, summaryOfDissolveCounts } from "./settings-surface";
import { subscribeGateInvalidation } from "../../app/gate-invalidation";
import { clearAccountSignOutNotice, peekAccountSignOutNotice } from "../../app/account-signout";

/**
 * The settings centre's regressions all had the same shape: a value the reader
 * could see but not change, or a value that was never the server's. These tests
 * hold the two contracts that keep it honest — every write goes through a real
 * gateway call and comes back from the server's answer, and a workspace switch
 * made from this page does not eject the reader from it.
 */

const OWNER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const OTHER_WORKSPACE = "33333333-3333-4333-8333-333333333333";

function session(role: "owner" | "member", options: { readonly collaborative?: boolean } = {}): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "11111111-1111-4111-8111-111111111111", email: "reader@example.com" },
    workspace: {
      version: 1,
      workspaceId: OWNER_WORKSPACE,
      name: "理解空间",
      role,
      workspaceType: options.collaborative ? "collaborative" : "personal",
      isPersonal: !options.collaborative,
      workspaceEpoch: 7,
    },
    membership: { role },
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
    requestId: "settings-test",
    correlationId: "settings-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

function aiSettings(overrides: Partial<WorkspaceAiSettingsV1> = {}): WorkspaceAiSettingsV1 {
  return {
    version: 1,
    requiresConsent: true,
    consentVersion: null,
    consentAt: null,
    dataPolicy: { sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: false },
    ...overrides,
  };
}

/** A capability projection whose companion grants follow the AI consent facts. */
function capabilities(companionAllowed: boolean, dialogueEnabled = false) {
  const action = companionAllowed ? "allowed" : "denied";
  return {
    version: 1 as const,
    revision: "test",
    workspaceEpoch: 7,
    actionCapabilities: {
      "source.read": "denied", "source.create": "allowed", "source.update": "allowed", "source.archive": "allowed", "source.createNote": "allowed",
      "note.read": "allowed", "note.create": "allowed", "note.save": "allowed", "note.delete": "allowed", "note.restore": "allowed", "note.permanentDelete": "allowed",
      "objective.read": "allowed", "review.read": "allowed", "understanding.read": "denied", "search.read": "denied",
      "card_generation.start": "denied", "card_generation.review": "denied", "card_generation.reveal": "denied", "card_generation.activate": "denied", "card_generation.cancel": "denied", "card_generation.close": "denied",
      "learning_run.read": "denied", "learning_run.start": "denied", "learning_run.saveDraft": "denied", "learning_run.submit": "denied", "learning_run.action": "denied",
      "companion.read": action, "companion.sendMessage": action, "companion.decideProposal": action,
      "settings.read": "allowed", "settings.update": "allowed",
    },
    featureAvailability: {
      learning_objective_system_v3: { state: "enabled" as const },
      learning_run_v2: { state: "disabled" as const, reason: "error.feature_disabled" as const },
      card_generation_v2: { state: "disabled" as const, reason: "error.feature_disabled" as const },
      companion_dialogue_v1: dialogueEnabled ? { state: "enabled" as const } : { state: "disabled" as const, reason: "error.feature_disabled" as const },
      companion_voice_dialogue_v1: { state: "disabled" as const, reason: "error.feature_disabled" as const },
    },
    nativeCapabilities: {
      filePicker: "unavailable" as const,
      clipboard: "unavailable" as const,
      notifications: "unavailable" as const,
      asr: "unavailable" as const,
      updates: "unavailable" as const,
      live2d: "unavailable" as const,
    },
  };
}

/** 一条外发审计记录：字段按服务端 `listAIAuditLog` 的实际返回写，不按界面想要什么编。 */
function auditItem(overrides: Partial<DesktopAiAuditItemV1> = {}): DesktopAiAuditItemV1 {
  return {
    id: "9f1f2f3f-4444-4aaa-8bbb-ccccdddddddd",
    provider: "dashscope",
    modelId: "qwen-plus",
    operation: "generate_cards",
    dataCategories: ["note_content", "question"],
    dataSizeBytes: 4096,
    costTokens: 320,
    durationMs: 2100,
    status: "success",
    errorMessage: null,
    createdAt: "2026-09-21T06:12:00.000Z",
    operator: { userId: "11111111-1111-4111-8111-111111111111", email: "reader@example.com" },
    ...overrides,
  };
}

function installApi(options: {
  readonly role?: "owner" | "member";
  /** true = 那个协作空间的当前用户是 owner（解散入口只该在这种行上出现）。 */
  readonly ownerCollaborative?: boolean;
  readonly ai?: WorkspaceAiSettingsV1;
  readonly companionAllowed?: boolean;
  /** 读到就抛：界面必须是"未读到"，不能把 config 默认演成用户的选择。 */
  readonly voiceUnavailable?: boolean;
  /** 声音偏好的读取结果；null = 这个账号没设过（服务端回默认并标 explicit:false）。 */
  readonly voice?: {
    readonly version: 1;
    readonly engine: "qwen" | "edge";
    readonly voice: string;
    readonly explicit: boolean;
    readonly updatedAt: string | null;
  };
  /** AI 外发审计那一页；"reject" = 读不到，缺省给一条成功记录。 */
  readonly audit?: { items: DesktopAiAuditItemV1[]; total: number } | "reject";
  /**
   * true = 当前空间是协作空间。邀请/名册/转让这些面板只该在协作空间里出现
   * （审计 F17：个人空间不摆做不到的按钮），所以这一族用例必须站在协作空间上。
   */
  readonly collaborativeSpace?: boolean;
  readonly switchRejects?: boolean;
  readonly dissolveRejects?: boolean;
  readonly transferRejects?: boolean;
  readonly exportResult?: {
    readonly version: 1;
    readonly saved: boolean;
    readonly canceled: boolean;
    readonly filePath: string | null;
    readonly bytes: number;
  };
} = {}) {
  const role = options.role ?? "owner";
  let ai = options.ai ?? aiSettings();
  const calls: { method: string; input: unknown }[] = [];
  const api = {
    auth: {
      getState: vi.fn(async () => ok(session(role, { collaborative: options.collaborativeSpace }))),
      joinWorkspace: vi.fn(async () => ok(session(role, { collaborative: options.collaborativeSpace }))),
      getProfile: vi.fn(async () => ok({ version: 1 as const, displayName: "读者", avatarUrl: null })),
      logout: vi.fn(async (input: unknown): Promise<GatewayResultV1<{ loggedOut: true; serverRevoked: boolean }>> => {
        calls.push({ method: "logout", input });
        return ok({ loggedOut: true as const, serverRevoked: true });
      }),
    },
    companion: {
      answerMode: {
        get: vi.fn(async () => ok({ version: 1 as const, preference: "any" as const, updatedAt: null })),
        patch: vi.fn(async (input: { preference: "voice" | "silent" | "text" | "any" }) =>
          ok({ version: 1 as const, preference: input.preference, updatedAt: "2026-09-18T00:00:00.000Z" })),
      },
      // 声音：默认回"没用过"，用例自己改成显式偏好。
      voicePreference: {
        get: vi.fn(async () => {
          if (options.voiceUnavailable) throw new Error("voice preference unavailable");
          return ok(
            options.voice ?? {
            version: 1 as const,
            engine: "qwen" as const,
            voice: "longhua_v3.1",
              explicit: false,
              updatedAt: null,
            },
          );
        }),
        patch: vi.fn(async (input: { engine: "qwen" | "edge"; voice: string }) => {
          calls.push({ method: "voicePreference.patch", input });
          return ok({
            version: 1 as const,
            engine: input.engine,
            voice: input.voice,
            explicit: true,
            updatedAt: "2026-09-22T00:00:00.000Z",
          });
        }),
      },
    },
    invites: {
      list: vi.fn(async () => ok({
        version: 1 as const,
        items: [{
          version: 1 as const, id: "invite-1", tokenHint: "hint-1", role: "member" as const,
          status: "active" as const, createdAt: "2026-09-18T00:00:00.000Z", expiresAt: null,
          consumedAt: null, consumedByEmail: null, revokedAt: null,
        }],
        total: 1,
      })),
      create: vi.fn(async (input: { role: "member" | "owner"; expiresInHours?: number }) => {
        calls.push({ method: "invites.create", input });
        return ok({
          version: 1 as const, id: "invite-2", token: "token-secret", tokenHint: "hint-2",
          role: input.role, expiresAt: null,
        });
      }),
      revoke: vi.fn(async () => ok({ revoked: true as const })),
    },
    members: {
      list: vi.fn(async () => ok({
        version: 1 as const,
        items: [
          { version: 1 as const, userId: "11111111-1111-4111-8111-111111111111", email: "reader@example.com", role: "owner" as const, joinedAt: "2026-09-01T00:00:00.000Z" },
          { version: 1 as const, userId: OTHER_WORKSPACE, email: "peer@example.com", role: "member" as const, joinedAt: "2026-09-02T00:00:00.000Z" },
        ],
        total: 2,
      })),
      remove: vi.fn(async (_input: { userId: string }) => ok({ removed: true as const })),
    },
    workspace: {
      list: vi.fn(async () => ok({
        workspaces: [
          { version: 1, workspaceId: OWNER_WORKSPACE, name: "理解空间", role, workspaceType: "personal", isPersonal: true },
          { version: 1, workspaceId: OTHER_WORKSPACE, name: "协作空间", role: options.ownerCollaborative ? "owner" : "member", workspaceType: "collaborative", isPersonal: false },
        ],
      })),
      switch: vi.fn(async (input: unknown) => {
        calls.push({ method: "switch", input });
        if (options.switchRejects) throw new Error("switch refused");
        return ok(session(role));
      }),
      // 服务端返回的是**逐表计数**（迁移 0276），界面只转述它，不自己估数。
      transferOwnership: vi.fn(async (input: unknown) => {
        calls.push({ method: "transferOwnership", input });
        if (options.transferRejects) throw new Error("transfer refused");
        return ok({ version: 1 as const, workspaceId: OTHER_WORKSPACE, newOwnerUserId: OTHER_WORKSPACE });
      }),
      dissolve: vi.fn(async (input: unknown) => {
        calls.push({ method: "dissolve", input });
        if (options.dissolveRejects) throw new Error("dissolve refused");
        return ok({
          version: 1 as const,
          workspaceId: OTHER_WORKSPACE,
          counts: { notes: 7, learning_cards_v2: 12, _rehomedGlobalMemories: 3, _retiredWorkspaceMemories: 5 },
        });
      }),
      getAiAuditLog: vi.fn(async (input: { limit?: number; offset?: number }) => {
        calls.push({ method: "getAiAuditLog", input });
        if (options.audit === "reject") throw new Error("audit log unavailable");
        return ok(options.audit ?? { items: [auditItem()], total: 1 });
      }),
      getAiSettings: vi.fn(async () => ok(ai)),
      updateAiConsent: vi.fn(async (input: { consentVersion: string }) => {
        calls.push({ method: "updateAiConsent", input });
        ai = aiSettings({ consentVersion: input.consentVersion, consentAt: "2026-09-17T00:00:00.000Z" });
        return ok(ai);
      }),
      updateAiDataPolicy: vi.fn(async (input: { policy: WorkspaceAiSettingsV1["dataPolicy"] }) => {
        calls.push({ method: "updateAiDataPolicy", input });
        ai = { ...ai, dataPolicy: input.policy };
        return ok(ai);
      }),
      export: vi.fn(async (input: unknown) => {
        calls.push({ method: "export", input });
        return ok(options.exportResult ?? {
          version: 1 as const,
          saved: true,
          canceled: false,
          filePath: "/Users/reader/Documents/ailearn-workspace-2026-09-17.json",
          bytes: 4096,
        });
      }),
    },
    capabilities: {
      get: vi.fn(async () => ok(capabilities(options.companionAllowed ?? false))),
    },
    source: { list: vi.fn(async () => ok({ items: [], nextCursor: null, total: 3 })) },
    note: { list: vi.fn(async () => ok({ items: [], nextCursor: null, total: 5 })) },
    objective: { list: vi.fn(async () => ok({ items: [], total: 2, nextCursor: null })) },
  };
  Object.defineProperty(window, "ailearn", { configurable: true, value: api });
  return { api, calls, currentAi: () => ai };
}

function openSection(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

const createdObjectUrls: string[] = [];

beforeEach(() => {
  // jsdom 不实现 createObjectURL；试听要把 base64 变成可播的源，就得给它一个。
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      const url = `blob:mock/${createdObjectUrls.length}`;
      createdObjectUrls.push(url);
      void blob;
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  // The surface measures its body to decide whether to show the overflow fade.
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  useRoomStore.setState({ settingsSection: "account", surface: "settings" });
});

afterEach(() => {
  cleanup();
  // 这三个必须留在 afterEach 体内：先前它们被拼到块外面，等于整个文件只跑一次，
  // 于是 blob 计数在相邻用例之间累加，"点了几次试听"这种断言就各说各话。
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  createdObjectUrls.length = 0;
  Reflect.deleteProperty(window, "ailearn");
  Reflect.deleteProperty(window, "ResizeObserver");
  Reflect.deleteProperty(navigator, "clipboard");
  // The room store is a module singleton shared by every test file in a worker.
  useRoomStore.setState({
    surface: null,
    hudPage: "home",
    settingsSection: "account",
    // 一次性注意力请求也可能被用例留在 store 里（"停在别的 section"那条就是），
    // 不复位会泄漏到下一个用例、在那里触发滚动。
    settingsAttention: null,
    masterMuted: false,
    live2dStatus: "loading",
  });
  vi.restoreAllMocks();
});

describe("伴星把读者送到同意卡（2026-09-19）", () => {
  function mockScrollIntoView(): ReturnType<typeof vi.fn> {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    return scrollIntoView;
  }

  it("注意力请求：滚到「签署状态」卡、闪一下并立刻消费掉（只引导一次）", async () => {
    installApi();
    const scrollIntoView = mockScrollIntoView();
    try {
      render(<SettingsSurface />);
      await screen.findByText("理解空间", { selector: ".space-identity h3" });
      openSection("AI 数据同意");
      await screen.findByRole("button", { name: "签署" });

      act(() => {
        useRoomStore.setState({ settingsAttention: SETTINGS_ATTENTION_AI_CONSENT });
      });

      // 滚到的是签署卡本身，不是页面顶端。
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      const card = document.querySelector('[data-attention="ai-consent"]');
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByText("签署状态")).toBeTruthy();
      // 一次性请求被立刻消费：下次进设置页不会再闪。
      expect(useRoomStore.getState().settingsAttention).toBeNull();
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("闪光到期后摘掉高亮（动画不会永远挂着）", async () => {
    installApi();
    mockScrollIntoView();
    try {
      render(<SettingsSurface />);
      await screen.findByText("理解空间", { selector: ".space-identity h3" });
      openSection("AI 数据同意");
      await screen.findByRole("button", { name: "签署" });

      vi.useFakeTimers();
      act(() => {
        useRoomStore.setState({ settingsAttention: SETTINGS_ATTENTION_AI_CONSENT });
      });
      expect(document.querySelector(".settings-group--attention")).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(SETTINGS_ATTENTION_MS + 50);
      });
      expect(document.querySelector(".settings-group--attention")).toBeNull();
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("停在别的 section 时不闪：请求留着，切到「AI 数据同意」才生效", async () => {
    installApi();
    const scrollIntoView = mockScrollIntoView();
    try {
      render(<SettingsSurface />);
      await screen.findByText("理解空间", { selector: ".space-identity h3" });

      act(() => {
        useRoomStore.setState({ settingsAttention: SETTINGS_ATTENTION_AI_CONSENT });
      });

      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(useRoomStore.getState().settingsAttention).toBe(SETTINGS_ATTENTION_AI_CONSENT);
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });
});

describe("AI consent is a real control, not a display", () => {
  it("signs through the gateway and shows the version the server stored", async () => {
    const { api } = installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("AI 数据同意");
    const sign = await screen.findByRole("button", { name: "签署" });
    fireEvent.click(sign);

    await waitFor(() => expect(api.workspace.updateAiConsent).toHaveBeenCalledTimes(1));
    expect(api.workspace.updateAiConsent.mock.calls[0]![0]).toMatchObject({ consentVersion: AI_CONSENT_VERSION });
    // The chip reflects the server's answer, not an optimistic local guess.
    await screen.findByText("已签署");
  });

  it("writes a policy switch through to the server and re-reads the projection", async () => {
    const { api } = installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("AI 数据同意");
    const row = (await screen.findByText("允许发送到外部模型服务")).closest(".settings-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("switch"));

    await waitFor(() => expect(api.workspace.updateAiDataPolicy).toHaveBeenCalledTimes(1));
    expect(api.workspace.updateAiDataPolicy.mock.calls[0]![0]).toMatchObject({
      policy: { sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: false },
    });
    // Consent gates the companion capabilities, so the projection is re-read too.
    await waitFor(() => expect(api.capabilities.get).toHaveBeenCalledTimes(2));
  });

  it("stays writable for a member: the consent belongs to the account, not the space", async () => {
    const { api } = installApi({ role: "member" });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("AI 数据同意");
    const row = (await screen.findByText("允许发送到外部模型服务")).closest(".settings-row") as HTMLElement;
    expect(within(row).getByRole("switch").hasAttribute("disabled")).toBe(false);
    const sign = await screen.findByRole("button", { name: "签署" });
    fireEvent.click(sign);
    await waitFor(() => expect(api.workspace.updateAiConsent).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("只有空间 Owner 可以签署或修改这些政策")).toBeNull();
  });

  it("labels a native capability as 未接入 with the reason attached", async () => {
    installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("数据与维护");
    const row = (await screen.findByText("系统通知")).closest(".settings-row") as HTMLElement;
    const chip = within(row).getByText("未接入");
    expect(chip.getAttribute("title")).toContain("还没有接入这条链路");
    expect(chip.getAttribute("aria-label")).toContain("还没有接入这条链路");
  });

  it("shows the server's real companion grant instead of a fixed 未允许", async () => {
    installApi({ companionAllowed: true });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("AI 数据同意");
    const row = (await screen.findByText("伴星读取工作区内容")).closest(".settings-row") as HTMLElement;
    expect(within(row).getByText("已允许")).toBeTruthy();
  });

  it("shows the companion dialogue flag the deployment actually has", async () => {
    installApi({ companionAllowed: true });
    // The projection is the server's answer, so this test only has to prove the
    // panel renders what it was given rather than a constant.
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });
    openSection("语音与伴星");

    const row = (await screen.findByText("对话能力")).closest(".settings-row") as HTMLElement;
    expect(within(row).getByText("已关闭")).toBeTruthy();
  });

  it("reports a failed write as an alert instead of a quiet note", async () => {
    const { api } = installApi();
    api.workspace.updateAiDataPolicy.mockRejectedValueOnce(new Error("network down"));
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("AI 数据同意");
    const row = (await screen.findByText("记录 AI 审计日志")).closest(".settings-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("switch"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBeTruthy();
  });

  it("keeps local settings usable when the AI policy projection fails", async () => {
    const { api } = installApi();
    api.workspace.getAiSettings.mockRejectedValueOnce(new Error("network down"));
    render(<SettingsSurface />);

    // An optional server projection must not replace the whole settings centre
    // with a fatal error: appearance and account preferences remain usable.
    await screen.findByText("理解空间", { selector: ".space-identity h3" });
    openSection("主题与动效");
    expect(await screen.findByRole("radiogroup", { name: "动效等级" })).toBeTruthy();

    openSection("AI 数据同意");
    await screen.findByText("没能读到你的 AI 数据设置");
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("owner invite and member management (旧版设置页回补)", () => {
  it("creates an invite through the gateway and shows the one-time code", async () => {
    const { api, calls } = installApi({ collaborativeSpace: true });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("成员与邀请");
    fireEvent.click(await screen.findByRole("button", { name: "生成邀请" }));

    await waitFor(() => expect(api.invites.create).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.method === "invites.create")?.input).toMatchObject({
      role: "member",
      expiresInHours: 72,
    });
    // The token is shown exactly once, next to a copy affordance.
    await screen.findByText(/邀请码（只显示这一次）/);
    expect(screen.getByText("token-secret")).toBeTruthy();
    expect(screen.getByText("hint-2 · 成员 · 长期有效")).toBeTruthy();
  });

  it("does not claim an invite was copied when the clipboard write fails", async () => {
    installApi({ collaborativeSpace: true });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("permission denied"); }) },
    });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("成员与邀请");
    fireEvent.click(await screen.findByRole("button", { name: "生成邀请" }));
    fireEvent.click(await screen.findByRole("button", { name: "复制" }));

    await screen.findByText("无法写入剪贴板。邀请码已显示在页面中，请手动选择并复制。");
    expect(screen.queryByRole("button", { name: "已复制" })).toBeNull();
    expect(screen.getByText("token-secret")).toBeTruthy();
  });

  it("loads the member roster even when the invite ledger fails", async () => {
    const { api } = installApi({ collaborativeSpace: true });
    api.invites.list.mockRejectedValueOnce(new Error("invite ledger offline"));
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("成员与邀请");
    await screen.findByText("邀请记录暂时不可用");
    expect(await screen.findByText("peer@example.com")).toBeTruthy();
  });

  it("removes a member only after the inline confirmation", async () => {
    const { api } = installApi({ collaborativeSpace: true });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("成员与邀请");
    const row = (await screen.findByText("peer@example.com")).closest(".settings-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "移除成员 peer@example.com" }));
    expect(api.members.remove).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole("button", { name: "移除成员 peer@example.com" }));
    await waitFor(() => expect(api.members.remove).toHaveBeenCalledTimes(1));
    expect(api.members.remove.mock.calls[0]![0]).toMatchObject({ userId: OTHER_WORKSPACE });
  });

  it("tells a member why the roster is missing instead of deleting the block", async () => {
    installApi({ role: "member", collaborativeSpace: true });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("成员与邀请");
    await screen.findByText("用邀请码加入协作空间");
    expect(screen.queryByRole("button", { name: "生成邀请" })).toBeNull();
    // 看不见 ≠ 知道自己不能做：这一块必须以锁定态出现在原位。
    const row = (await screen.findByText("只有空间所有者能发邀请、看名册、移成员")).closest(".settings-row") as HTMLElement;
    expect(within(row).getByText("只读")).toBeTruthy();
    // 说明本身也要是真的：能力投影里 member 只放开读取 + learning_run.*，
    // 采集/写笔记/生成卡都在 owner 那一支。写成"可以读写学习资料"会让人
    // 在点不动按钮时以为是界面坏了。
    const detail = within(row).getByText(/你在这个空间是成员/) as HTMLElement;
    expect(detail.textContent).toMatch("复习");
    expect(detail.textContent).toMatch("所有者发起");
    expect(detail.textContent).not.toMatch(/可以读写|能读写资料/);
  });
});

describe("个人空间的成员与邀请（审计 F17 / F31）", () => {
  it("个人空间不摆「生成邀请」：说清边界，并指向真正能做的地方", async () => {
    installApi(); // 默认夹具就是个人空间
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("成员与邀请");

    expect(screen.queryByRole("button", { name: "生成邀请" })).toBeNull();
    const row = (await screen.findByText("个人空间不邀请别人")).closest(".settings-row") as HTMLElement;
    // 说明本身要可执行：新建协作空间在哪、之后在哪邀请。
    expect(within(row).getByText(/新建协作空间/)).toBeTruthy();
    expect(within(row).getByText(/空间胶囊/)).toBeTruthy();
  });

  it("协作空间里的同类拒绝：说的就是这件事，且提示贴在触发它的那张卡里（审计 F31）", async () => {
    const { api } = installApi({ collaborativeSpace: true });
    api.invites.create = vi.fn(async () => ({
      ok: false as const,
      workspaceEpoch: 1,
      error: {
        code: "personal_workspace_not_shareable" as const,
        safeMessageKey: "error.personal_workspace_not_shareable" as const,
        retry: "never" as const,
      },
    }));
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("成员与邀请");
    fireEvent.click(await screen.findByRole("button", { name: "生成邀请" }));

    // 文案说的是"个人空间不能邀请"，不是"学习状态已经变化"。
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("个人空间不能邀请成员");
    expect(alert.textContent).not.toMatch(/学习状态/);
    // 位置：紧挨着触发它的那张卡（邀请那一组），不是页尾那条通用提示。
    expect(alert.closest(".settings-group")?.textContent).toContain("生成邀请");
  });
});

describe("workspace switching from inside settings", () => {  it("keeps the reader on the settings page and in the same section", async () => {
    const { api } = installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("账户与空间");
    const ledger = await screen.findByRole("group", { name: "我的空间身份" });
    // 名册行现在还带一个「退出 <空间名>」按钮（成员可退出协作空间），切换行的
    // 可访问名以空间名开头，用它区分。
    fireEvent.click(within(ledger).getByRole("button", { name: /^协作空间/ }));

    await waitFor(() => expect(api.workspace.switch).toHaveBeenCalledTimes(1));
    // A switch is a whole-room boundary change; the surface, the section it was
    // on and the page identity the chrome reads all have to come back, or the
    // reader is thrown into the room mid-task.
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("settings"));
    expect(useRoomStore.getState().settingsSection).toBe("account");
    expect(useRoomStore.getState().hudPage).toBe("settings");
    await screen.findByText(/已切换到「协作空间」/);
  });

  it("reports a refused switch without leaving the page", async () => {
    installApi({ switchRejects: true });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("账户与空间");
    const ledger = await screen.findByRole("group", { name: "我的空间身份" });
    fireEvent.click(within(ledger).getByRole("button", { name: /^协作空间/ }));

    await screen.findByRole("alert");
    expect(useRoomStore.getState().surface).toBe("settings");
  });
});

describe("the sound switch", () => {
  it("sets the store value the reader asked for, with no double negation", async () => {
    installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });
    openSection("语音与伴星");

    const sound = await screen.findByRole("switch", { name: "伴星与环境音" });
    expect(sound.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(sound);
    expect(useRoomStore.getState().masterMuted).toBe(true);
  });
});

describe("the settings directory", () => {
  it("marks the open entry as the current page, not as an arbitrary current item", async () => {
    installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    expect(screen.getByRole("button", { name: "账户与空间" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "数据与维护" }).getAttribute("aria-current")).toBeNull();
  });

  it("does not repeat the same preference in two sections", async () => {
    installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    expect(screen.queryByRole("radiogroup", { name: "动效等级" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "左侧目录" })).toBeNull();

    openSection("主题与动效");
    expect(await screen.findByRole("radiogroup", { name: "动效等级" })).toBeTruthy();
    expect(await screen.findByRole("radiogroup", { name: "目录行为" })).toBeTruthy();
  });
});

describe("the inventory", () => {
  it("reads each total from the library list the pages themselves use", async () => {
    const { api } = installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("数据与维护");
    await waitFor(() => expect(api.source.list).toHaveBeenCalled());
    expect(await screen.findByText("3")).toBeTruthy();
    expect(await screen.findByText("5")).toBeTruthy();
    expect(await screen.findByText("2")).toBeTruthy();
  });
});

describe("workspace export", () => {
  it("runs the real export and reports where the file landed", async () => {
    const { api } = installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("数据与维护");
    fireEvent.click(await screen.findByRole("button", { name: "导出…" }));

    await waitFor(() => expect(api.workspace.export).toHaveBeenCalledTimes(1));
    // The receipt carries the reader's own choice of path, so the confirmation
    // can name the file instead of saying "exported" into the void.
    await screen.findByText(/已导出到 \/Users\/reader\/Documents\/ailearn-workspace-2026-09-17\.json（4\.0 KB）/);
  });

  it("treats a cancelled save dialog as a cancellation, not a failure", async () => {
    installApi({ exportResult: { version: 1, saved: false, canceled: true, filePath: null, bytes: 0 } });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("数据与维护");
    fireEvent.click(await screen.findByRole("button", { name: "导出…" }));

    await screen.findByText("已取消导出，没有写入任何文件。");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps export closed for a member", async () => {
    installApi({ role: "member" });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("数据与维护");
    const button = await screen.findByRole("button", { name: "导出…" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("reports a failed export as an alert", async () => {
    const { api } = installApi();
    api.workspace.export.mockRejectedValueOnce(new Error("disk full"));
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });

    openSection("数据与维护");
    fireEvent.click(await screen.findByRole("button", { name: "导出…" }));

    await screen.findByRole("alert");
    expect(screen.queryByText(/已导出到/)).toBeNull();
  });
});

/**
 * 退出登录（2026-09-21）：设置页里也要有一条走得出的退出路。此前客户端只有
 * 「改密码」会间接把人踢回登录页，换账号因此没有正当入口。
 *
 * 这块故意藏在 `<details>` 里：折叠时那枚按钮不该被 role 查询命中——一条断言
 * 同时钉住「要两步才算数」和「别把退出摆在随手可按的地方」。
 */
describe("设置页的退出登录", () => {
  afterEach(() => {
    clearAccountSignOutNotice();
  });

  async function renderAccountSection() {
    const installed = installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: ".space-identity h3" });
    return installed;
  }

  function openSignOutDisclosure() {
    fireEvent.click(screen.getByText("换一个人用这台设备，或者到别的设备上继续。").closest("summary") as Element);
  }

  it("退出这块默认是折着的：先展开说清楚的那一步，才轮到按钮", async () => {
    await renderAccountSection();

    const disclosure = screen
      .getByText("换一个人用这台设备，或者到别的设备上继续。")
      .closest("details") as HTMLDetailsElement;
    // 注意：jsdom 里折叠的 <details> 仍然把子节点留在 DOM 里，role 查询照样命中，
    // 所以「藏起来了」只能钉 `open` 这一个事实，不能钉查询查不到。
    expect(disclosure.open).toBe(false);

    fireEvent.click(disclosure.querySelector("summary") as Element);
    await screen.findByRole("button", { name: "退出登录" });
    expect(disclosure.open).toBe(true);
  });

  it("退的是屏幕上写明的这个账号", async () => {
    await renderAccountSection();
    openSignOutDisclosure();

    expect(screen.getByText("退出 reader@example.com")).toBeTruthy();
  });

  it("按下去真的调用了退出，并把房间交还给登录页", async () => {
    const { api } = await renderAccountSection();
    const invalidations: string[] = [];
    const stop = subscribeGateInvalidation((code) => { invalidations.push(code); });
    openSignOutDisclosure();

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => expect(api.auth.logout).toHaveBeenCalledOnce());
    expect(invalidations).toContain("auth_required");
    stop();
  });

  it("与顶栏小框共用同一份结论：撤销没送达时那句话留给登录页", async () => {
    const { api } = await renderAccountSection();
    api.auth.logout.mockResolvedValueOnce(ok({ loggedOut: true as const, serverRevoked: false as const }));
    openSignOutDisclosure();

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(api.auth.logout).toHaveBeenCalledOnce());

    expect(peekAccountSignOutNotice()).toContain("没能通知学习服务撤销");
  });
});

// ─── 设置 → 语音与伴星：引擎、音色与试听 ─────────────────────────────────
it("播放读数跟着音频事件走：接线不能只挂在挂载 effect 上", async () => {
  // <audio> 渲染在「语音与伴星」这一屏里，一次性 effect 跑的时候它还不存在。
  // 真窗口里踩到过：音频在放，读数却永远停在 0:00 / 0:00、进度条一动不动。
  await openVoiceSection();
  const audio = document.querySelector("audio.settings-voice__source") as HTMLAudioElement;
  Object.defineProperty(audio, "duration", { configurable: true, value: 5.87 });
  Object.defineProperty(audio, "currentTime", { configurable: true, value: 3.59 });
  // 替身也必须守浏览器的合同：`play()` 返回 Promise。返回 undefined 会让被测代码里
  // 那句 `.catch(...)` 抛成一条**未捕获异常**，掉在用例结束之后，只出现在摘要的
  // `Errors` 里而不影响 exit code。
  const spy = vi.fn(() => Promise.resolve());
  audio.play = spy;
  const last = QWEN_TTS_VOICE_OPTIONS.length - 1;
  fireEvent.click(screen.getAllByText("试听")[last]);
  await waitFor(() => expect(spy).toHaveBeenCalled());
  // 媒体事件在真实浏览器里总是稍后的任务，不会在 play() 里同步吐出来
  await act(async () => {
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("play"));
    audio.dispatchEvent(new Event("timeupdate"));
  });
  await waitFor(() => expect(screen.getByText("0:03 / 0:05")).toBeTruthy());
  const bar = document.querySelector(".settings-voice__track i") as HTMLElement;
  expect(bar.style.transform).toContain("0.6");
  expect(screen.getByRole("button", { name: "暂停试听" })).toBeTruthy();
});


async function openVoiceSection(options: Parameters<typeof installApi>[0] = {}) {
  // installApi 自己会把桩挂到 window.ailearn（那个属性不可重新赋值），用例只改它的成员。
  const { api, calls } = installApi({ ...options, collaborativeSpace: true });
  render(<SettingsSurface />);
  await screen.findByText("理解空间", { selector: ".space-identity h3" });
  openSection("语音与伴星");
  await waitFor(() => expect(screen.getByText("用哪套声音合成")).toBeTruthy());
  return { api, calls };
}

/**
 * F9（方案 35）：试听离开页面要真停下来。
 * 卸载那个 effect 以前只 `removeEventListener`，从不 `pause()` —— 于是切走这一屏之后
 * 录音还在放，而播放器读数、进度条、那颗「暂停试听」按钮全都跟着界面一起没了，
 * 用户只剩"哪儿来的声音"。
 */
it("试听：离开这一屏要停下来，也不把录音源留在脱离的元素上", async () => {
  installApi({});
  const view = render(<SettingsSurface />);
  await screen.findByText("理解空间", { selector: ".space-identity h3" });
  openSection("语音与伴星");
  await waitFor(() => expect(screen.getByText("用哪套声音合成")).toBeTruthy());
  const audio = document.querySelector("audio.settings-voice__source") as HTMLAudioElement;
  let playing = false;
  audio.play = () => { playing = true; return Promise.resolve(); };
  audio.pause = () => { playing = false; };
  fireEvent.click(screen.getAllByText("试听")[0]);
  await waitFor(() => expect(playing).toBe(true));
  act(() => { view.unmount(); });
  expect(playing).toBe(false);
  expect(audio.getAttribute("src")).toBeNull();
});

it("声音分组：千问下画满目录里的 5 个音色，并在用的那一条标出来", async () => {
  await openVoiceSection();
  // 名单从目录取，不再抄一遍数字：删一条音色时，这里跟着缩，不会留下断言不过的用例
  expect(QWEN_TTS_VOICE_OPTIONS.length).toBeGreaterThan(1);
  for (const option of QWEN_TTS_VOICE_OPTIONS) {
    expect(screen.getAllByText(option.name).length).toBeGreaterThan(0);
  }
  // 默认那条（服务端回 longhua_v3.1）必须带"在用"，其余行不带。
  expect(screen.getAllByText("在用").length).toBe(1);
  expect(screen.getAllByText("试听").length).toBe(QWEN_TTS_VOICE_OPTIONS.length);
  // 未生效的行不挂"在用"，也不该被画成选中档
  expect(document.querySelectorAll(".settings-row--selected").length).toBe(1);
  expect(screen.getByText("尚未开始")).toBeTruthy();
});

it("切到 Edge-TTS：列表只剩固定那一条，写入带成对的引擎与音色", async () => {
  const { calls } = await openVoiceSection();
  fireEvent.click(screen.getByRole("radio", { name: "Edge-TTS" }));
  await waitFor(() => {
    const write = calls.find((call) => call.method === "voicePreference.patch");
    expect(write?.input).toEqual({
      meta: expect.objectContaining({ version: 1 }),
      engine: "edge",
      voice: "zh-CN-XiaoxiaoNeural",
    });
  });
  await waitFor(() => {
    expect(screen.queryByText("龙安灵希")).toBeNull();
    expect(screen.getAllByText("试听").length).toBe(1);
  });
});

it("点某一行「用这一身」：写进去的就是那一行的 voice", async () => {
  const { calls } = await openVoiceSection();
  const rows = screen.getAllByRole("button", { name: "用这一身" });
  // 生效那一行根本不给这个按钮（不是给一个点不动的）：45° 之外它还占着一格位置，
  // 留着只会让五行看起来都有同一个可点的动作。
  expect(rows.length).toBe(QWEN_TTS_VOICE_OPTIONS.length - 1);
  const inUseRow = screen.getByText("在用").closest(".settings-row") as HTMLElement;
  expect(inUseRow.textContent).toContain("龙华");
  expect(within(inUseRow).queryByRole("button", { name: "用这一身" })).toBeNull();
  fireEvent.click(rows[0]);
  await waitFor(() => {
    const write = calls.find((call) => call.method === "voicePreference.patch");
    expect((write?.input as { voice: string }).voice).toBe("longanlingxi_v3.1");
    expect((write?.input as { engine: string }).engine).toBe("qwen");
  });
});

it("试听：放的是本地录音，一次上游调用都不发", async () => {
  const { calls } = await openVoiceSection();
  const audio = document.querySelector("audio.settings-voice__source") as HTMLAudioElement;
  expect(audio).toBeTruthy();
  const played: string[] = [];
  audio.play = () => {
    played.push(audio.src);
    return Promise.resolve();
  };
  const target = QWEN_TTS_VOICE_OPTIONS[QWEN_TTS_VOICE_OPTIONS.length - 1];
  fireEvent.click(screen.getAllByText("试听")[QWEN_TTS_VOICE_OPTIONS.length - 1]);
  await waitFor(() => expect(played.length).toBe(1));
  // 源就是目录里那条音色对应的资产：不是 blob（那要现合成），也不是 http
  expect(played[0]).toContain(`assets/companion/voice-preview-v1/${target.voice}.mp3`);
  expect(played[0].startsWith("blob:")).toBe(false);
  expect(screen.getByText("用哪套声音合成")).toBeTruthy();
  await waitFor(() => expect(screen.getByText(`正在试听：${target.name}`)).toBeTruthy());
  expect(calls.filter((c) => String(c.method).toLowerCase().includes("preview")).length).toBe(0);
});

it("录音放不出来：给出这一句的失败读数，不把选择改掉", async () => {
  const { calls } = await openVoiceSection();
  const before = calls.filter((c) => c.method === "voicePreference.patch").length;
  fireEvent.click(screen.getAllByText("试听")[0]);
  const audio = document.querySelector("audio.settings-voice__source") as HTMLAudioElement;
  audio.dispatchEvent(new Event("error"));
  await waitFor(() => expect(screen.getByText("这段试听录音没能放出来。")).toBeTruthy());
  expect(calls.filter((c) => c.method === "voicePreference.patch").length).toBe(before);
});

it("没读到偏好：不画音色列表，也不把默认值演成用户的选择", async () => {
  await openVoiceSection({ voiceUnavailable: true });
  expect(screen.getByText("未读到")).toBeTruthy();
  expect(screen.queryByText("试听")).toBeNull();
});

/**
 * doc 34 L3 的另一半：`auditLogging` 那行写着"供你回看"，而桌面以前没有任何地方读
 * 这条审计。下面按"点开了才读、读到什么就说什么"钉住这个读端。
 */
async function openAuditSection(options: Parameters<typeof installApi>[0] = {}) {
  const installed = installApi(options);
  render(<SettingsSurface />);
  await screen.findByText("理解空间", { selector: ".space-identity h3" });
  openSection("AI 数据同意");
  return installed;
}

it("外发记录：不点「查看」就不读，点了读到的是服务端那一页", async () => {
  const { api, calls } = await openAuditSection();
  expect(calls.filter((c) => c.method === "getAiAuditLog")).toHaveLength(0);

  fireEvent.click(await screen.findByRole("button", { name: "查看" }));
  await waitFor(() => expect(calls.filter((c) => c.method === "getAiAuditLog")).toHaveLength(1));
  expect(calls.filter((c) => c.method === "getAiAuditLog")[0]!.input).toMatchObject({ limit: 20, offset: 0 });

  // 供应商与模型是事实；内部枚举名（note_content / question）翻成人话再上屏。
  await screen.findByText("dashscope · qwen-plus");
  expect(screen.getByText(/笔记正文/)).toBeTruthy();
  expect(screen.getByText(/题目/)).toBeTruthy();
  expect(screen.queryByText(/note_content/)).toBeNull();
  expect(screen.getByText("已完成")).toBeTruthy();
});

it("外发记录：还有更早的就给下一页，offset 按已读到的条数往前走", async () => {
  const page = { items: [auditItem(), auditItem({ id: "8f1f2f3f-4444-4aaa-8bbb-ccccdddddddd" })], total: 21 };
  const { calls } = await openAuditSection({ audit: page });
  fireEvent.click(await screen.findByRole("button", { name: "查看" }));
  fireEvent.click(await screen.findByRole("button", { name: "更早的记录" }));
  await waitFor(() => expect(calls.filter((c) => c.method === "getAiAuditLog")).toHaveLength(2));
  expect(calls.filter((c) => c.method === "getAiAuditLog")[1]!.input).toMatchObject({ offset: 2 });
});

it("外发记录：空清单说没有记录，不是一片空白", async () => {
  await openAuditSection({ audit: { items: [], total: 0 } });
  fireEvent.click(await screen.findByRole("button", { name: "查看" }));
  await screen.findByText("还没有外发记录");
});

it("外发记录：读失败给可重试的状态，不留一个看着像\"没有\"的空列表", async () => {
  const { api } = await openAuditSection({ audit: "reject" });
  fireEvent.click(await screen.findByRole("button", { name: "查看" }));
  await screen.findByText("外发记录暂时读不到");
  expect(api.workspace.getAiAuditLog).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(api.workspace.getAiAuditLog).toHaveBeenCalledTimes(2));
});

it("外发记录：成员看不到读取入口，但这一行说清了记录仍在写、由所有者回看", async () => {
  await openAuditSection({ role: "member" });
  await screen.findByText("外发记录");
  expect(screen.queryByRole("button", { name: "查看" })).toBeNull();
  expect(screen.getByText(/这份清单由这个空间的所有者回看/)).toBeTruthy();
});

// ─── 解散空间（不可逆出口；服务端逐表计数是唯一数字来源）─────────────────────

async function openSpaceLedger(options: Parameters<typeof installApi>[0]) {
  const installed = installApi(options);
  render(<SettingsSurface />);
  await screen.findByText("理解空间", { selector: ".space-identity h3" });
  openSection("账户与空间");
  return installed;
}

it("解散入口只出现在「我是 owner 的协作空间」那一行：member 看不到", async () => {
  await openSpaceLedger({ ownerCollaborative: false });
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByRole("button", { name: "解散 协作空间" })).toBeNull();
});

it("解散入口出现在 owner 的协作空间那一行", async () => {
  await openSpaceLedger({ ownerCollaborative: true });
  expect(await screen.findByRole("button", { name: "解散 协作空间" })).toBeTruthy();
});

it("确认必须输入空间名；没输对就不发调用", async () => {
  const { api } = await openSpaceLedger({ ownerCollaborative: true });
  fireEvent.click(await screen.findByRole("button", { name: "解散 协作空间" }));
  const confirm = await screen.findByRole("button", { name: "确认解散" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(confirm);
  expect(api.workspace.dissolve).not.toHaveBeenCalled();

  fireEvent.change(screen.getByPlaceholderText("输入空间名"), { target: { value: "协作" } });
  expect((screen.getByRole("button", { name: "确认解散" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(screen.getByPlaceholderText("输入空间名"), { target: { value: "协作空间" } });
  fireEvent.click(screen.getByRole("button", { name: "确认解散" }));
  await waitFor(() => expect(api.workspace.dissolve).toHaveBeenCalledTimes(1));
});

it("成功后照服务端计数说话", async () => {
  await openSpaceLedger({ ownerCollaborative: true });
  fireEvent.click(await screen.findByRole("button", { name: "解散 协作空间" }));
  fireEvent.change(screen.getByPlaceholderText("输入空间名"), { target: { value: "协作空间" } });
  fireEvent.click(screen.getByRole("button", { name: "确认解散" }));
  // 19 = notes 7 + cards 12；摘要键说的是去处，不进这个总数
  await screen.findByText(/已解散「协作空间」。清掉了 19 项内容，3 条属于你的记忆已迁回你的个人空间，5 条只属于这个空间的记忆已收掉。/);
});

it("解散失败时不许写成「已解散」", async () => {
  const { api } = await openSpaceLedger({ ownerCollaborative: true, dissolveRejects: true });
  fireEvent.click(await screen.findByRole("button", { name: "解散 协作空间" }));
  fireEvent.change(screen.getByPlaceholderText("输入空间名"), { target: { value: "协作空间" } });
  fireEvent.click(screen.getByRole("button", { name: "确认解散" }));
  await waitFor(() => expect(api.workspace.dissolve).toHaveBeenCalledTimes(1));
  // 方向要对：失败最坏的后果不是"没提示"，是**看起来像成功了**。
  expect(screen.queryByText(/已解散「协作空间」/)).toBeNull();
  // 失败后确认面板**留在原地**（她不必重打空间名），所以这里在的是"确认解散"而不是入口按钮。
  expect(screen.getByRole("button", { name: "确认解散" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "确认解散" }) as HTMLButtonElement).disabled).toBe(false);
});

it("计数句子：摘要键不混进总数，空计数也不编数字", () => {
  expect(summaryOfDissolveCounts({ notes: 2, _rehomedGlobalMemories: 1 }))
    .toBe("清掉了 2 项内容，1 条属于你的记忆已迁回你的个人空间。");
  expect(summaryOfDissolveCounts({})).toBe("清掉了 0 项内容。");
});

// ─── 转让所有权（owner 唯一体面出口；没有它，owner 既不能退也不能交）───────────

async function openMemberRows(options: Parameters<typeof installApi>[0]) {
  // 名册/转让只存在于协作空间（审计 F17）：站在协作空间上开这一屏。
  const installed = installApi({ role: "owner", collaborativeSpace: true, ...options });
  render(<SettingsSurface />);
  await screen.findByText("理解空间", { selector: ".space-identity h3" });
  // 成员行在「成员与邀请」那一区，不在「账户与空间」。
  openSection("成员与邀请");
  return installed;
}

it("成员行给 owner 一个「设为所有者」", async () => {
  await openMemberRows({});
  expect(await screen.findByRole("button", { name: "把 peer@example.com 设为所有者" })).toBeTruthy();
});

it("member 看不到「设为所有者」，但这一屏不是空白", async () => {
  installApi({ role: "member" });
  render(<SettingsSurface />);
  await screen.findByText("理解空间", { selector: ".space-identity h3" });
  openSection("成员与邀请");
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByRole("button", { name: "把 peer@example.com 设为所有者" })).toBeNull();
  expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
});

it("转让是行内二次确认：第一下只变成「确认交出」，不发调用", async () => {
  const { api } = await openMemberRows({});
  const trigger = await screen.findByRole("button", { name: "把 peer@example.com 设为所有者" });
  fireEvent.click(trigger);
  expect(api.workspace.transferOwnership).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "把 peer@example.com 设为所有者" }));
  await waitFor(() => expect(api.workspace.transferOwnership).toHaveBeenCalledTimes(1));
  const input = (api.workspace.transferOwnership as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
    workspaceId: string; toUserId: string;
  };
  expect(input.toUserId).toBe(OTHER_WORKSPACE);
  expect(input.workspaceId).toBeTruthy();
});

it("转让失败时不许说成「已交出」", async () => {
  const { api } = await openMemberRows({ transferRejects: true });
  fireEvent.click(await screen.findByRole("button", { name: "把 peer@example.com 设为所有者" }));
  fireEvent.click(await screen.findByRole("button", { name: "把 peer@example.com 设为所有者" }));
  await waitFor(() => expect(api.workspace.transferOwnership).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/你不再是它的所有者/)).toBeNull();
});
