// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GatewayResultV1, SessionContextV1, WorkspaceAiSettingsV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { AI_CONSENT_VERSION } from "@ailearn/shared/desktop-ipc-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../app/room-store";
import { SettingsSurface } from "./settings-surface";

/**
 * The settings centre's regressions all had the same shape: a value the reader
 * could see but not change, or a value that was never the server's. These tests
 * hold the two contracts that keep it honest — every write goes through a real
 * gateway call and comes back from the server's answer, and a workspace switch
 * made from this page does not eject the reader from it.
 */

const OWNER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const OTHER_WORKSPACE = "33333333-3333-4333-8333-333333333333";

function session(role: "owner" | "member"): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "11111111-1111-4111-8111-111111111111", email: "reader@example.com" },
    workspace: {
      version: 1,
      workspaceId: OWNER_WORKSPACE,
      name: "理解空间",
      role,
      workspaceType: "personal",
      isPersonal: true,
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
    workspaceId: OWNER_WORKSPACE,
    requiresConsent: true,
    consentVersion: null,
    consentAt: null,
    consentBy: null,
    canManage: true,
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

function installApi(options: {
  readonly role?: "owner" | "member";
  readonly ai?: WorkspaceAiSettingsV1;
  readonly companionAllowed?: boolean;
  readonly switchRejects?: boolean;
  readonly exportResult?: {
    readonly version: 1;
    readonly saved: boolean;
    readonly canceled: boolean;
    readonly filePath: string | null;
    readonly bytes: number;
  };
} = {}) {
  const role = options.role ?? "owner";
  let ai = options.ai ?? aiSettings({ canManage: role === "owner" });
  const calls: { method: string; input: unknown }[] = [];
  const api = {
    auth: {
      getState: vi.fn(async () => ok(session(role))),
      joinWorkspace: vi.fn(async () => ok(session(role))),
    },
    workspace: {
      list: vi.fn(async () => ok({
        workspaces: [
          { version: 1, workspaceId: OWNER_WORKSPACE, name: "理解空间", role, workspaceType: "personal", isPersonal: true },
          { version: 1, workspaceId: OTHER_WORKSPACE, name: "协作空间", role: "member", workspaceType: "collaborative", isPersonal: false },
        ],
      })),
      switch: vi.fn(async (input: unknown) => {
        calls.push({ method: "switch", input });
        if (options.switchRejects) throw new Error("switch refused");
        return ok(session(role));
      }),
      getAiSettings: vi.fn(async () => ok(ai)),
      updateAiConsent: vi.fn(async (input: { consentVersion: string }) => {
        calls.push({ method: "updateAiConsent", input });
        ai = aiSettings({ canManage: role === "owner", consentVersion: input.consentVersion, consentAt: "2026-09-17T00:00:00.000Z" });
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

beforeEach(() => {
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
  Reflect.deleteProperty(window, "ailearn");
  Reflect.deleteProperty(window, "ResizeObserver");
  // The room store is a module singleton shared by every test file in a worker.
  useRoomStore.setState({
    surface: null,
    hudPage: "home",
    settingsSection: "account",
    masterMuted: false,
    live2dStatus: "loading",
  });
  vi.restoreAllMocks();
});

describe("AI consent is a real control, not a display", () => {
  it("signs through the gateway and shows the version the server stored", async () => {
    const { api } = installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

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
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("AI 数据同意");
    const row = (await screen.findByText("允许发送到外部模型服务")).closest(".settings-consent-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("switch"));

    await waitFor(() => expect(api.workspace.updateAiDataPolicy).toHaveBeenCalledTimes(1));
    expect(api.workspace.updateAiDataPolicy.mock.calls[0]![0]).toMatchObject({
      policy: { sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: false },
    });
    // Consent gates the companion capabilities, so the projection is re-read too.
    await waitFor(() => expect(api.capabilities.get).toHaveBeenCalledTimes(2));
  });

  it("keeps every policy read-only for a member", async () => {
    installApi({ role: "member" });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("AI 数据同意");
    const row = (await screen.findByText("允许发送到外部模型服务")).closest(".settings-consent-row") as HTMLElement;
    expect(within(row).getByRole("switch").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "签署" })).toBeNull();
    await screen.findByText("只读");
  });

  it("labels a native capability as 未接入 with the reason attached", async () => {
    installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("AI 数据同意");
    const row = (await screen.findByText("系统通知")).closest(".settings-consent-row") as HTMLElement;
    const chip = within(row).getByText("未接入");
    expect(chip.getAttribute("title")).toContain("还没有接入这条链路");
  });

  it("shows the server's real companion grant instead of a fixed 未允许", async () => {
    installApi({ companionAllowed: true });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("AI 数据同意");
    const row = (await screen.findByText("伴星读取工作区内容")).closest(".settings-consent-row") as HTMLElement;
    expect(within(row).getByText("已允许")).toBeTruthy();
  });

  it("shows the companion dialogue flag the deployment actually has", async () => {
    installApi({ companionAllowed: true });
    // The projection is the server's answer, so this test only has to prove the
    // panel renders what it was given rather than a constant.
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });
    openSection("语音与伴星");

    const row = (await screen.findByText("对话能力")).closest(".settings-capability") as HTMLElement;
    expect(within(row).getByText("已关闭")).toBeTruthy();
  });

  it("reports a failed write as an alert instead of a quiet note", async () => {
    const { api } = installApi();
    api.workspace.updateAiDataPolicy.mockRejectedValueOnce(new Error("network down"));
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("AI 数据同意");
    const row = (await screen.findByText("记录 AI 审计日志")).closest(".settings-consent-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("switch"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBeTruthy();
  });
});

describe("workspace switching from inside settings", () => {
  it("keeps the reader on the settings page and in the same section", async () => {
    const { api } = installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("成员与邀请");
    const ledger = await screen.findByRole("group", { name: "我的空间身份" });
    fireEvent.click(within(ledger).getByRole("button", { name: /协作空间/ }));

    await waitFor(() => expect(api.workspace.switch).toHaveBeenCalledTimes(1));
    // A switch is a whole-room boundary change; the surface, the section it was
    // on and the page identity the chrome reads all have to come back, or the
    // reader is thrown into the room mid-task.
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("settings"));
    expect(useRoomStore.getState().settingsSection).toBe("members");
    expect(useRoomStore.getState().hudPage).toBe("settings");
    await screen.findByText(/已切换到「协作空间」/);
  });

  it("reports a refused switch without leaving the page", async () => {
    installApi({ switchRejects: true });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("账户与空间");
    const trigger = await screen.findByRole("button", { name: /进入的空间/ });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: /协作空间/ }));

    await screen.findByRole("alert");
    expect(useRoomStore.getState().surface).toBe("settings");
  });
});

describe("the sound switch", () => {
  it("sets the store value the reader asked for, with no double negation", async () => {
    installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });
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
    await screen.findByText("理解空间", { selector: "h2.title" });

    expect(screen.getByRole("button", { name: "账户与空间" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "数据管理" }).getAttribute("aria-current")).toBeNull();
  });

  it("does not repeat the same preference in two sections", async () => {
    installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    expect(screen.queryByRole("radiogroup", { name: "动效等级" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "左侧目录" })).toBeNull();

    openSection("主题与无障碍");
    expect(await screen.findByRole("radiogroup", { name: "动效等级" })).toBeTruthy();
    expect(await screen.findByRole("radiogroup", { name: "目录行为" })).toBeTruthy();
  });
});

describe("the inventory", () => {
  it("reads each total from the library list the pages themselves use", async () => {
    const { api } = installApi();
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("数据管理");
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
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("数据管理");
    fireEvent.click(await screen.findByRole("button", { name: "导出…" }));

    await waitFor(() => expect(api.workspace.export).toHaveBeenCalledTimes(1));
    // The receipt carries the reader's own choice of path, so the confirmation
    // can name the file instead of saying "exported" into the void.
    await screen.findByText(/已导出到 \/Users\/reader\/Documents\/ailearn-workspace-2026-09-17\.json（4\.0 KB）/);
  });

  it("treats a cancelled save dialog as a cancellation, not a failure", async () => {
    installApi({ exportResult: { version: 1, saved: false, canceled: true, filePath: null, bytes: 0 } });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("数据管理");
    fireEvent.click(await screen.findByRole("button", { name: "导出…" }));

    await screen.findByText("已取消导出，没有写入任何文件。");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps export closed for a member", async () => {
    installApi({ role: "member" });
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("数据管理");
    const button = await screen.findByRole("button", { name: "导出…" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("reports a failed export as an alert", async () => {
    const { api } = installApi();
    api.workspace.export.mockRejectedValueOnce(new Error("disk full"));
    render(<SettingsSurface />);
    await screen.findByText("理解空间", { selector: "h2.title" });

    openSection("数据管理");
    fireEvent.click(await screen.findByRole("button", { name: "导出…" }));

    await screen.findByRole("alert");
    expect(screen.queryByText(/已导出到/)).toBeNull();
  });
});
