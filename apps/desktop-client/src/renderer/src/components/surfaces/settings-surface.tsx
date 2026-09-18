import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  AudioLines,
  Check,
  CircleHelp,
  Compass,
  Layers,
  MessageCircle,
  MessagesSquare,
  Mic,
  Moon,
  Sparkles,
  Sun,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  AI_CONSENT_VERSION,
  type AiDataPolicyV1,
  type CapabilityProjectionV1,
  type SessionContextV1,
  type WorkspaceAiSettingsV1,
  type WorkspaceSummaryV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import type { MotionMode } from "../../app/room-machine";
import {
  MAX_COMPANION_SCALE,
  MIN_COMPANION_SCALE,
  useRoomStore,
} from "../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { publishGateInvalidation } from "../../app/gate-invalidation";
import {
  DIRECTORY_RAIL_MODE_EVENT,
  DIRECTORY_RAIL_MODE_KEY,
  readDirectoryRailMode,
  type DirectoryRailMode,
} from "../DirectoryRail";
import { HOME_V2_ENABLED } from "../home-v2/home-v2";
import { useHomeV2 } from "../home-v2/HomeV2Experience";
import { HudPage } from "../hud/HudPage";
import { HudPicker, HudSegmented, HudSlider, HudSwitch } from "../hud/HudControls";
import { useHudPage } from "../hud/use-hud-page";
import { SurfaceDataState, readAuthenticatedSession } from "./surface-data";

/**
 * The six entries the mockup puts in the settings directory, in its order. Each
 * one is a different kind of decision, so each gets its own composition inside
 * the card rather than sharing one row list.
 */
const SECTIONS = [
  ["account", "账户与空间"],
  ["members", "成员与邀请"],
  ["appearance", "主题与无障碍"],
  ["companion", "语音与伴星"],
  ["data", "AI 数据同意"],
  ["management", "数据管理"],
] as const;

type SettingsSectionId = (typeof SECTIONS)[number][0];

const SECTION_IDS: readonly string[] = SECTIONS.map(([id]) => id);

const THEME_OPTIONS = [
  ["day", "日间", <Sun key="day" aria-hidden="true" />],
  ["night", "夜间", <Moon key="night" aria-hidden="true" />],
] as const;

const MOTION_OPTIONS: ReadonlyArray<readonly [MotionMode, string]> = [
  ["full", "完整"],
  ["lite", "轻量"],
  ["off", "关闭"],
];

const DIRECTORY_OPTIONS: ReadonlyArray<readonly [DirectoryRailMode, string]> = [
  ["auto", "自动"],
  ["expanded", "展开"],
  ["collapsed", "收起"],
];

/** The settings plate itself, which is the room the theme choice repaints. */
const THEME_PLATES: Readonly<Record<"day" | "night", string>> = {
  day: "/assets/approved-v3/environments/companion-system-day-v1.png",
  night: "/assets/approved-v3/environments/companion-system-night-v1.png",
};

type ActionCapabilityValue = CapabilityProjectionV1["actionCapabilities"][keyof CapabilityProjectionV1["actionCapabilities"]];
type NativeCapabilityValue = CapabilityProjectionV1["nativeCapabilities"][keyof CapabilityProjectionV1["nativeCapabilities"]];

/**
 * Why a capability reads the way it does. The server sends a `reason` for
 * features and the projection is derived from consent + role for actions, so
 * the chip can always explain itself instead of leaving "未允许" unexplained.
 */
function actionReason(value: ActionCapabilityValue | undefined): string {
  if (!value) return "服务端还没有回答这一项。";
  if (value === "allowed") return "服务端已允许。";
  if (value === "conditional") return "满足条件时才允许，服务端会按当前上下文判断。";
  return "服务端当前不允许。伴星相关能力由工作区 AI 同意与数据外发策略决定，管理类能力由角色决定。";
}

function featureReason(state: string | undefined, reason: string | undefined): string {
  if (!state) return "服务端还没有回答这一项。";
  if (state === "enabled") return "服务端已启用这条链路。";
  if (state === "conditional") return "按条件启用。";
  return reason === "error.feature_disabled"
    ? "服务端的部署开关没有打开这条链路。"
    : "服务端当前不可用。";
}

function nativeReason(value: NativeCapabilityValue | undefined): string {
  if (!value) return "还没有读到本机能力。";
  return value === "available"
    ? "这台设备上的客户端已接入这条链路。"
    : "桌面端还没有接入这条链路：能力值由主进程按真实存在的通道计算，不是权限被拒绝。";
}

/**
 * One chip for every permission the projection reports. The gateway answers with
 * a three-way grant or a native availability, never a boolean, so the chip says
 * which of those it is instead of collapsing them into allowed / denied.
 */
function CapabilityChip({ value, kind = "action", reason }: {
  readonly value: ActionCapabilityValue | NativeCapabilityValue | undefined;
  readonly kind?: "action" | "native" | "feature";
  /** 悬停说明：为什么是当前这个状态。 */
  readonly reason?: string;
}) {
  if (!value) return <span className="tag" title={reason}>—</span>;
  const on = value === "allowed" || value === "available" || value === "enabled";
  const label = kind === "native"
    // 本机能力为 unavailable 时，含义是「客户端没有这条链路」，而不是「权限被拒」。
    ? (value === "available" ? "已接入" : "未接入")
    : kind === "feature"
      ? (value === "enabled" ? "已开启" : value === "conditional" ? "按条件" : value === "disabled" ? "已关闭" : "暂不可用")
      : (value === "allowed" ? "已允许" : value === "conditional" ? "按条件" : "未允许");
  return <span className={on ? "tag green" : "tag"} title={reason}>{label}</span>;
}

function roleLabel(role: WorkspaceSummaryV1["role"] | undefined): string {
  if (!role) return "—";
  return role === "owner" ? "Owner · 全部读写" : "Member · 只读协作";
}

function spaceTypeLabel(type: WorkspaceSummaryV1["workspaceType"] | undefined): string {
  if (!type) return "—";
  return type === "personal" ? "个人空间" : "协作空间";
}

/** 导出回执里的体积，按人读得懂的单位显示。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ChoiceRow({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="choice-row">
      <div>
        <b>{title}</b>
        <p>{detail}</p>
      </div>
      {children}
    </div>
  );
}

/** A policy switch the reader can actually move, with its own busy state. */
function PolicyRow({
  title,
  detail,
  checked,
  disabled,
  saving,
  onChange,
}: {
  readonly title: string;
  readonly detail: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <div className="settings-consent-row">
      <span>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
      <span className="settings-consent-row__control">
        {saving ? <span className="tag">保存中…</span> : null}
        <HudSwitch checked={checked} disabled={disabled} onChange={onChange} label={title} />
      </span>
    </div>
  );
}

type SettingsPanel = {
  /** The card's own tag, naming what kind of decision this entry holds. */
  readonly eyebrow: string;
  readonly title: string;
  readonly body: React.ReactNode;
  readonly footerNote?: string;
};

/**
 * Page 21 — the settings centre.
 *
 * The mockup composes the page as three HUD surfaces: a green directory, the
 * current space's ledger, and one card for whatever the directory has selected.
 * This file owns that third card, and it is written per entry: the account
 * groups the room's defaults, membership is a ledger plus a real invite form,
 * appearance picks the theme off the plate itself, the companion tab is a
 * control block over a capability list, consent is drawn as the path data takes
 * and is **writable by the Owner**, and data management is an inventory of what
 * the workspace holds.
 *
 * Every control is drawn here rather than borrowed from the browser, and every
 * value comes from a real client or server fact. Nothing offers what the product
 * cannot honour: no model picker, no BYOK field, no "save" the server never sees.
 */
export function SettingsSurface() {
  const theme = useRoomStore((state) => state.theme);
  const setTheme = useRoomStore((state) => state.setTheme);
  const motionMode = useRoomStore((state) => state.motionMode);
  const setMotionMode = useRoomStore((state) => state.setMotionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const setMasterMuted = useRoomStore((state) => state.setMasterMuted);
  const companionScale = useRoomStore((state) => state.companionScale);
  const setCompanionScale = useRoomStore((state) => state.setCompanionScale);
  const live2dStatus = useRoomStore((state) => state.live2dStatus);
  const settingsSection = useRoomStore((state) => state.settingsSection);
  const setSettingsSection = useRoomStore((state) => state.setSettingsSection);
  const setHudPage = useRoomStore((state) => state.setHudPage);
  const openOnboarding = useRoomStore((state) => state.openOnboarding);
  const closeSurface = useRoomStore((state) => state.closeSurface);
  const invoke = useRoomStore((state) => state.invoke);
  const { replayIntro } = useHomeV2();
  const [directoryMode, setDirectoryMode] = useState<DirectoryRailMode>(readDirectoryRailMode);
  const [session, setSession] = useState<SessionContextV1 | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummaryV1[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityProjectionV1 | null>(null);
  const [aiSettings, setAiSettings] = useState<WorkspaceAiSettingsV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failureNotice, setFailureNotice] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [aiSaving, setAiSaving] = useState<string | null>(null);
  const [aiFailure, setAiFailure] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [inventory, setInventory] = useState<{ sources: number; notes: number; objectives: number } | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const epochRef = useRef<number | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyOverflows, setBodyOverflows] = useState(false);
  useHudPage("settings");

  const section: SettingsSectionId = SECTION_IDS.includes(settingsSection)
    ? settingsSection as SettingsSectionId
    : "account";

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const current = await readAuthenticatedSession(epochRef);
      const [workspaceResponse, capabilityResponse, aiResponse] = await Promise.all([
        window.ailearn.workspace.list({ meta: createRequestMeta(current.workspaceEpoch) }),
        window.ailearn.capabilities.get({ meta: createRequestMeta(current.workspaceEpoch) }),
        window.ailearn.workspace.getAiSettings({ meta: createRequestMeta(current.workspaceEpoch) }),
      ]);
      if (workspaceResponse.workspaceEpoch) epochRef.current = workspaceResponse.workspaceEpoch;
      if (capabilityResponse.workspaceEpoch) epochRef.current = capabilityResponse.workspaceEpoch;
      if (aiResponse.workspaceEpoch) epochRef.current = aiResponse.workspaceEpoch;
      setSession(current);
      setWorkspaces(unwrapGatewayResult(workspaceResponse).workspaces);
      setCapabilities(unwrapGatewayResult(capabilityResponse));
      setAiSettings(unwrapGatewayResult(aiResponse));
      setAiFailure(null);
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Re-read only the server facts a policy write can change. A full `load()`
   * would blank the whole card behind the loading paper, which reads as the
   * switch having thrown the page away.
   */
  const reloadAfterPolicyWrite = useCallback(async () => {
    const [capabilityResponse, aiResponse] = await Promise.all([
      window.ailearn.capabilities.get({ meta: createRequestMeta(epochRef.current) }),
      window.ailearn.workspace.getAiSettings({ meta: createRequestMeta(epochRef.current) }),
    ]);
    if (capabilityResponse.workspaceEpoch) epochRef.current = capabilityResponse.workspaceEpoch;
    if (aiResponse.workspaceEpoch) epochRef.current = aiResponse.workspaceEpoch;
    setCapabilities(unwrapGatewayResult(capabilityResponse));
    setAiSettings(unwrapGatewayResult(aiResponse));
  }, []);

  /** What the workspace holds, read from the same lists the library pages use. */
  useEffect(() => {
    let active = true;
    setInventoryLoading(true);
    void (async () => {
      try {
        const meta = () => createRequestMeta(epochRef.current);
        const [sources, notes, objectives] = await Promise.all([
          window.ailearn.source.list({ meta: meta(), limit: 1 }),
          window.ailearn.note.list({ meta: meta(), limit: 1 }),
          window.ailearn.objective.list({ meta: meta(), limit: 1 }),
        ]);
        if (!active) return;
        setInventory({
          sources: unwrapGatewayResult(sources).total,
          notes: unwrapGatewayResult(notes).total,
          objectives: unwrapGatewayResult(objectives).total,
        });
      } catch {
        // The inventory is informational; the rest of the page still stands.
        if (active) setInventory(null);
      } finally {
        if (active) setInventoryLoading(false);
      }
    })();
    return () => { active = false; };
  }, [session?.workspace?.workspaceId]);

  const changeDirectoryMode = useCallback((next: DirectoryRailMode) => {
    setDirectoryMode(next);
    try {
      window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, next);
    } catch {
      // Preference persistence is progressive enhancement.
    }
    window.dispatchEvent(new CustomEvent(DIRECTORY_RAIL_MODE_EVENT, { detail: { mode: next } }));
  }, []);

  const switchTo = async (workspace: WorkspaceSummaryV1) => {
    if (workspace.workspaceId === session?.workspace?.workspaceId || switching) return;
    setSwitching(workspace.workspaceId);
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.workspace.switch({
        meta: createRequestMeta(epochRef.current),
        workspaceId: workspace.workspaceId,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      // The whole room is scoped to one verified workspace, so a switch is a
      // boundary change: reuse the gate's own invalidation path rather than
      // patching each surface's cursor by hand. That reset also drops the
      // surface back to the room, forgets the settings section and republishes
      // `hudPage` as home — right for the room's own space menu, wrong here:
      // the reader asked for a different space *while sitting on this page*, so
      // the page, its section and its published page identity all come straight
      // back and the confirmation is still visible. (`hudPage` is republished
      // explicitly because `useHudPage`'s effect does not re-run for a page that
      // never unmounted, which would leave the chrome reading the home page.)
      publishGateInvalidation("stale_workspace");
      invoke("open-settings");
      setSettingsSection(section);
      setHudPage("settings", "returning");
      setNotice(`已切换到「${workspace.name}」，这一页读取的是新空间的能力投影。`);
      await load();
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setSwitching(null);
    }
  };

  const joinWithInvite = async () => {
    const inviteToken = inviteCode.trim();
    if (!inviteToken || joining) return;
    setJoining(true);
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.auth.joinWorkspace({
        meta: createRequestMeta(epochRef.current),
        inviteToken,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      setInviteCode("");
      // joinWorkspace binds the joined space as the current one (the contract
      // answers with the new session), so this is a workspace boundary too —
      // and, like the picker above, it must not eject the reader from settings.
      publishGateInvalidation("stale_workspace");
      invoke("open-settings");
      setSettingsSection(section);
      setHudPage("settings", "returning");
      setNotice("已加入协作空间，它现在出现在下面的空间列表里。");
      await load();
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setJoining(false);
    }
  };

  const saveDataPolicy = async (patch: Partial<AiDataPolicyV1>, field: string) => {
    if (!aiSettings || aiSaving) return;
    setAiSaving(field);
    setAiFailure(null);
    try {
      const response = await window.ailearn.workspace.updateAiDataPolicy({
        meta: createRequestMeta(epochRef.current),
        policy: { ...aiSettings.dataPolicy, ...patch },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setAiSettings(unwrapGatewayResult(response));
      // 同意与策略会改变服务端的能力投影（伴星读取 / 外发），所以顺带刷新它，
      // 否则同一页的「外发同意」会停在改动前。
      await reloadAfterPolicyWrite();
    } catch (error) {
      setAiFailure(gatewayErrorMessage(error));
    } finally {
      setAiSaving(null);
    }
  };

  /**
   * 整库导出。数据在服务端取，落盘位置由读者在系统保存对话框里选；取消不算
   * 失败，所以回执里 `saved` 与 `canceled` 是分开的两件事。
   */
  const exportWorkspace = async () => {
    if (exporting) return;
    setExporting(true);
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.workspace.export({ meta: createRequestMeta(epochRef.current) });
      const result = unwrapGatewayResult(response);
      setNotice(result.saved
        ? `已导出到 ${result.filePath}（${formatBytes(result.bytes)}）。`
        : "已取消导出，没有写入任何文件。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const signConsent = async () => {
    if (aiSaving) return;
    setAiSaving("consent");
    setAiFailure(null);
    try {
      const response = await window.ailearn.workspace.updateAiConsent({
        meta: createRequestMeta(epochRef.current),
        consentVersion: AI_CONSENT_VERSION,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setAiSettings(unwrapGatewayResult(response));
      await reloadAfterPolicyWrite();
    } catch (error) {
      setAiFailure(gatewayErrorMessage(error));
    } finally {
      setAiSaving(null);
    }
  };

  const currentWorkspace = session?.workspace ?? null;
  const currentRole = session?.membership?.role;
  const companion = capabilities?.actionCapabilities;
  const features = capabilities?.featureAvailability;
  const otherWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.workspaceId !== currentWorkspace?.workspaceId),
    [workspaces, currentWorkspace?.workspaceId],
  );

  const workspacePickerOptions = useMemo(
    () => workspaces.map((workspace) => [
      workspace.workspaceId,
      workspace.name,
      `${workspace.role === "owner" ? "Owner" : "Member"} · ${spaceTypeLabel(workspace.workspaceType)}${workspace.workspaceId === currentWorkspace?.workspaceId ? " · 当前" : ""}`,
    ] as const),
    [workspaces, currentWorkspace?.workspaceId],
  );

  /** The room's own defaults, grouped by when they apply. */
  const accountPanel = (): SettingsPanel => ({
    eyebrow: "本次要调整",
    title: "进入书房时的偏好",
    body: (
      <section className="settings-group">
        <h3 className="settings-group__title">启动</h3>
        <ChoiceRow title="进入的空间" detail="切换后这一页会立即读取新空间的能力投影，并留在这里。">
          <HudPicker
            label="进入的空间"
            value={currentWorkspace?.workspaceId ?? ""}
            options={workspacePickerOptions}
            disabled={switching !== null || workspacePickerOptions.length === 0}
            onChange={(workspaceId) => {
              const target = workspaces.find((workspace) => workspace.workspaceId === workspaceId);
              if (target) void switchTo(target);
            }}
          />
        </ChoiceRow>
        <div className="settings-consent-list">
          <div className="settings-consent-row">
            <span><b>可见空间</b><small>这些空间的数据彼此隔离，不会互相索引。</small></span>
            <span className="write-line">{`${workspaces.length} 个`}</span>
          </div>
        </div>
      </section>
    ),
    footerNote: otherWorkspaces.length > 0
      ? `本机偏好保存在这台设备上；还有 ${otherWorkspaces.length} 个空间可以切换。`
      : "本机偏好保存在这台设备上。",
  });

  /** Who you are here, which spaces answer to it, and how to join another. */
  const membersPanel = (): SettingsPanel => ({
    eyebrow: "空间与身份",
    title: "成员与邀请",
    body: (
      <>
        <div className="settings-identity">
          <span className="settings-identity__seal" aria-hidden="true">
            {(session?.user?.displayName ?? session?.user?.email ?? "我").slice(0, 1).toUpperCase()}
          </span>
          <div>
            <b>{session?.user?.displayName ?? session?.user?.email ?? "已登录"}</b>
            <small>{session?.user?.displayName ? session.user.email : "凭据只加密保存在这台设备上"}</small>
          </div>
          <span className="tag green">{currentRole === "owner" ? "Owner" : currentRole === "member" ? "Member" : "—"}</span>
        </div>

        <div className="settings-columns">
        <div className="settings-column">
        <div className="settings-ledger" role="group" aria-label="我的空间身份">
          {workspaces.map((workspace) => {
            const current = workspace.workspaceId === currentWorkspace?.workspaceId;
            const busy = switching === workspace.workspaceId;
            return (
              <button
                key={workspace.workspaceId}
                type="button"
                className="settings-ledger__row"
                aria-current={current ? "true" : undefined}
                aria-busy={busy || undefined}
                disabled={current || switching !== null}
                onClick={() => void switchTo(workspace)}
              >
                <span className="settings-ledger__seal" aria-hidden="true">{workspace.name.slice(0, 1)}</span>
                <span>
                  <b>{workspace.name}</b>
                  <small>{`${workspace.role === "owner" ? "Owner" : "Member"} · ${spaceTypeLabel(workspace.workspaceType)}`}</small>
                </span>
                {busy
                  ? <span className="tag">切换中…</span>
                  : current ? <span className="tag green">当前</span> : <ArrowRight size={14} aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        </div>
        <div className="settings-column">
        <div className="settings-block">
          <div className="settings-block__head">
            <div>
              <b>用邀请码加入协作空间</b>
              <p>邀请码由空间所有者发出，加入后立刻出现在上面的列表里。</p>
            </div>
          </div>
          <div className="hud-field" style={{ marginTop: 10 }}>
            <label className="sr-only" htmlFor="settings-invite-code">协作空间邀请码</label>
            <input
              id="settings-invite-code"
              value={inviteCode}
              placeholder="粘贴邀请码"
              disabled={joining}
              onChange={(event) => setInviteCode(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void joinWithInvite();
              }}
            />
            <button type="button" className="button primary" disabled={joining || !inviteCode.trim()} onClick={() => void joinWithInvite()}>
              {joining ? "正在加入…" : "加入"}
            </button>
          </div>
        </div>

        <div className="settings-capabilities">
          <div className="settings-capability">
            <span className="settings-capability__mark" aria-hidden="true"><Layers size={15} /></span>
              <span>
                <b>政策管理</b>
                <small>同意与数据政策的修改权限由服务端角色决定。</small>
              </span>
              <CapabilityChip
                value={companion?.["settings.update"]}
                reason={companion?.["settings.update"] === "allowed"
                  ? "你是这个空间的 Owner，可以在「AI 数据同意」里修改政策。"
                  : "只有空间 Owner 可以修改同意与数据政策；写入由服务端 requireOwner 收口。"}
              />
          </div>
        </div>
        </div>
        </div>
      </>
    ),
    footerNote: `当前身份在 ${workspaces.length} 个可见空间内有效。`,
  });

  /** A visual choice: the two plates the reader actually stands on. */
  const appearancePanel = (): SettingsPanel => ({
    eyebrow: "本机偏好",
    title: "主题、动效与目录",
    body: (
      <>
        <section className="settings-group">
          <h3 className="settings-group__title">环境主题</h3>
          <div className="settings-themes" role="group" aria-label="环境主题">
            {(["day", "night"] as const).map((value) => {
              const active = theme === value;
              return (
                <button
                  key={value}
                  type="button"
                  className="settings-theme"
                  aria-pressed={active}
                  onClick={() => setTheme(value)}
                >
                  <span
                    className="settings-theme__plate"
                    style={{ backgroundImage: `url("${THEME_PLATES[value]}")` }}
                    aria-hidden="true"
                  />
                  <span className="settings-theme__label">
                    {value === "day" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
                    {value === "day" ? "日间书房" : "夜间书房"}
                  </span>
                  {active ? (
                    <span className="settings-theme__check" aria-hidden="true"><Check size={13} strokeWidth={3} /></span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        <div className="settings-columns">
        <section className="settings-group">
          <h3 className="settings-group__title">动效与无障碍</h3>
          <ChoiceRow title="动效等级" detail="场景移动、页面进入与卡片的运动量。">
            <HudSegmented label="动效等级" value={motionMode} options={MOTION_OPTIONS} onChange={setMotionMode} compact />
          </ChoiceRow>
          <ChoiceRow title="系统减少动效" detail="由操作系统决定，优先级高于上面的等级。">
            <span className={reducedMotion ? "tag green" : "tag"}>{reducedMotion ? "已开启" : "未开启"}</span>
          </ChoiceRow>
        </section>

        <div className="settings-column">
        <section className="settings-group">
          <h3 className="settings-group__title">左侧目录</h3>
          <ChoiceRow title="目录行为" detail="自动模式下进入内容后缩回底部，手动操作始终优先。">
            <HudSegmented label="目录行为" value={directoryMode} options={DIRECTORY_OPTIONS} onChange={changeDirectoryMode} compact />
          </ChoiceRow>
        </section>

        <section className="settings-group">
          <h3 className="settings-group__title">首页引导</h3>
          <ChoiceRow title="重播首次进入引导" detail="回到书房并重播入场说明，不改动任何学习记录。">
            <button
              className="button"
              type="button"
              onClick={() => {
                closeSurface();
                if (HOME_V2_ENABLED) replayIntro();
                else openOnboarding();
              }}
            >
              <CircleHelp size={13} aria-hidden="true" />
              重播
            </button>
          </ChoiceRow>
        </section>
        </div>
        </div>
      </>
    ),
    footerNote: "主题与动效是本机偏好，不写入工作区。",
  });

  /** A control block, then what the companion is currently allowed to do. */
  const companionPanel = (): SettingsPanel => ({
    eyebrow: "伴星偏好",
    title: "语音与伴星",
    body: (
      <>
        <div className="settings-columns">
        <div className="settings-block">
          <div className="settings-block__head">
            <div>
              <b>伴星大小</b>
              <p>只影响伴星在房间与页面里的显示比例，位置由你自己拖动决定。</p>
            </div>
          </div>
          <HudSlider
            label="伴星大小"
            value={companionScale}
            min={MIN_COMPANION_SCALE}
            max={MAX_COMPANION_SCALE}
            step={0.05}
            onChange={setCompanionScale}
            format={(value) => `${Math.round(value * 100)}%`}
            hint={`${Math.round(MIN_COMPANION_SCALE * 100)}% – ${Math.round(MAX_COMPANION_SCALE * 100)}%`}
          />
        </div>

        <div className="settings-block">
          <div className="settings-block__head">
            <div className="settings-block__title">
              <span className="settings-capability__mark" aria-hidden="true">
                {masterMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
              </span>
              <div>
                <b>声音</b>
                <p>总静音会同时关闭环境音与伴星语音，只影响这台设备。</p>
              </div>
            </div>
            <HudSwitch checked={!masterMuted} onChange={(next) => setMasterMuted(!next)} label="伴星与环境音" />
          </div>
        </div>

        </div>

        <section className="settings-group settings-group--split">
          <h3 className="settings-group__title">伴星能力</h3>
          <div className="settings-capabilities settings-capabilities--split">
            <div className="settings-capability">
              <span className="settings-capability__mark" aria-hidden="true"><Sparkles size={15} /></span>
              <span><b>半身形象</b><small>窗口内 Live2D，是伴星的唯一形态。</small></span>
              <span
                className={live2dStatus === "ready" ? "tag green" : "tag"}
                title={live2dStatus === "ready"
                  ? "模型已在本机加载完成。"
                  : live2dStatus === "loading"
                    ? "模型正在加载，完成后这里会变为已加载。"
                    : "模型、许可或 WebGL 不可用；伴星形象会隐藏并就地给出说明。"}
              >
                {live2dStatus === "ready" ? "已加载" : live2dStatus === "loading" ? "加载中" : "不可用"}
              </span>
            </div>
            <div className="settings-capability">
              <span className="settings-capability__mark" aria-hidden="true"><MessageCircle size={15} /></span>
              <span><b>实时对话</b><small>完整对话写入由服务端开关决定。</small></span>
              <CapabilityChip value={companion?.["companion.sendMessage"]} reason={actionReason(companion?.["companion.sendMessage"])} />
            </div>
            <div className="settings-capability">
              <span className="settings-capability__mark" aria-hidden="true"><MessagesSquare size={15} /></span>
              <span><b>对话能力</b><small>伴星对话链路的启用状态。</small></span>
              <CapabilityChip
                kind="feature"
                value={features?.companion_dialogue_v1.state}
                reason={featureReason(features?.companion_dialogue_v1.state, features?.companion_dialogue_v1.reason)}
              />
            </div>
            <div className="settings-capability">
              <span className="settings-capability__mark" aria-hidden="true"><Mic size={15} /></span>
              <span><b>本机语音识别</b><small>不可用时自动回落到文字输入。</small></span>
              <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.asr} reason={nativeReason(capabilities?.nativeCapabilities.asr)} />
            </div>
            <div className="settings-capability">
              <span className="settings-capability__mark" aria-hidden="true"><AudioLines size={15} /></span>
              <span><b>语音对话</b><small>语音链路由服务端能力开关决定。</small></span>
              <CapabilityChip
                kind="feature"
                value={features?.companion_voice_dialogue_v1.state}
                reason={featureReason(features?.companion_voice_dialogue_v1.state, features?.companion_voice_dialogue_v1.reason)}
              />
            </div>
          </div>
        </section>
      </>
    ),
    footerNote: "伴星能力全部来自服务端的 capability 投影，这里不提供模型选择。",
  });

  /** Consent drawn as the path the data takes, then the policy the Owner signs. */
  const dataPanel = (): SettingsPanel => {
    const policy = aiSettings?.dataPolicy ?? null;
    const canManage = aiSettings?.canManage === true;
    const signed = Boolean(aiSettings?.consentVersion);
    const busy = aiSaving !== null;
    return {
      eyebrow: "工作区政策",
      title: "AI 数据同意",
      body: (
        <>
          <section className="settings-group">
            <h3 className="settings-group__title">数据路径</h3>
            <div className="settings-boundary" role="img" aria-label="工作区内容经伴星读取后到达外发边界">
              <div className="settings-boundary__node">
                <span>工作区内容</span>
                <b>来源 · 笔记 · 目标</b>
                <small>留在当前空间</small>
              </div>
              <span className="settings-boundary__arrow" aria-hidden="true"><ArrowRight size={15} /></span>
              <div className="settings-boundary__node">
                <span>伴星读取</span>
                <CapabilityChip value={companion?.["companion.read"]} reason={actionReason(companion?.["companion.read"])} />
                <small>你确认后才写入</small>
              </div>
              <span className="settings-boundary__arrow" aria-hidden="true"><ArrowRight size={15} /></span>
              <div className={`settings-boundary__node${companion?.["companion.read"] === "allowed" ? "" : " settings-boundary__node--stop"}`}>
                <span>外发边界</span>
                <b>{companion?.["companion.read"] === "allowed" ? "可能发送至模型服务" : "当前不会外发"}</b>
                <small>由 Owner 签署</small>
              </div>
            </div>
          </section>

          <section className="settings-group">
            <h3 className="settings-group__title">签署状态</h3>
            <div className="settings-consent-list">
              <div className="settings-consent-row">
                <span>
                  <b>AI 使用同意</b>
                  <small>
                    {!aiSettings
                      ? "还没有读到这个空间的同意状态。"
                      : signed
                        ? `已签署（版本 ${aiSettings.consentVersion}）${aiSettings.consentAt ? ` · ${aiSettings.consentAt.slice(0, 10)}` : ""}`
                        : aiSettings.requiresConsent
                          ? "这个部署配置了外部模型供应商，未签署前内容不会外发。"
                          : "当前部署只用本机模型，不强制要求签署。"}
                  </small>
                </span>
                {signed
                  ? <span className="tag green">已签署</span>
                  : <span className="tag">{aiSettings?.requiresConsent ? "需要签署" : "未签署"}</span>}
              </div>
              {canManage && !signed ? (
                <div className="settings-consent-row">
                  <span>
                    <b>签署同意</b>
                    <small>以 Owner 身份签署当前版本（{AI_CONSENT_VERSION}），签署后内容才允许离开本机。</small>
                  </span>
                  <button type="button" className="button primary" disabled={busy} onClick={() => void signConsent()}>
                    {aiSaving === "consent" ? "正在签署…" : "签署"}
                  </button>
                </div>
              ) : null}
              {!canManage && aiSettings ? (
                <div className="settings-consent-row">
                  <span>
                    <b>签署权限</b>
                    <small>只有空间 Owner 可以签署或修改这些政策；你在这个空间是 Member。</small>
                  </span>
                  <span className="tag">只读</span>
                </div>
              ) : null}
            </div>
          </section>

          <section className="settings-group">
            <h3 className="settings-group__title">数据外发策略</h3>
            <div className="settings-consent-list">
              <PolicyRow
                title="允许发送到外部模型服务"
                detail="关闭后，工作区内容不再离开本机。"
                checked={policy?.sendToExternal ?? false}
                disabled={!canManage || !policy || busy}
                saving={aiSaving === "sendToExternal"}
                onChange={(next) => void saveDataPolicy({ sendToExternal: next }, "sendToExternal")}
              />
              <PolicyRow
                title="允许发送图片内容"
                detail="只影响图片类素材；关闭后图片留在本机。"
                checked={policy?.sendImageContent ?? false}
                disabled={!canManage || !policy || busy}
                saving={aiSaving === "sendImageContent"}
                onChange={(next) => void saveDataPolicy({ sendImageContent: next }, "sendImageContent")}
              />
              <PolicyRow
                title="外发前做个人信息检测"
                detail="在内容离开本机前先标记可能的个人信息。"
                checked={policy?.piiDetection ?? false}
                disabled={!canManage || !policy || busy}
                saving={aiSaving === "piiDetection"}
                onChange={(next) => void saveDataPolicy({ piiDetection: next }, "piiDetection")}
              />
              <PolicyRow
                title="记录 AI 审计日志"
                detail="每次外发都留下可追溯的记录，供 Owner 复核。"
                checked={policy?.auditLogging ?? false}
                disabled={!canManage || !policy || busy}
                saving={aiSaving === "auditLogging"}
                onChange={(next) => void saveDataPolicy({ auditLogging: next }, "auditLogging")}
              />
            </div>
          </section>

          <div className="settings-columns">
          <section className="settings-group">
            <h3 className="settings-group__title">外发同意（由上面两项推导）</h3>
            <div className="settings-consent-list">
              <div className="settings-consent-row">
                <span><b>伴星读取工作区内容</b><small>决定伴星能看到哪些来源、笔记与目标。</small></span>
                <CapabilityChip value={companion?.["companion.read"]} reason={actionReason(companion?.["companion.read"])} />
              </div>
              <div className="settings-consent-row">
                <span><b>向伴星发送消息</b><small>消息内容可能离开本机，由服务端处理。</small></span>
                <CapabilityChip value={companion?.["companion.sendMessage"]} reason={actionReason(companion?.["companion.sendMessage"])} />
              </div>
              <div className="settings-consent-row">
                <span><b>确认伴星的提议</b><small>提议写入笔记或目标前始终需要你确认。</small></span>
                <CapabilityChip value={companion?.["companion.decideProposal"]} reason={actionReason(companion?.["companion.decideProposal"])} />
              </div>
              <div className="settings-consent-row">
                <span><b>管理工作区政策</b><small>只有 Owner 可以更改同意与数据政策。</small></span>
                <CapabilityChip value={companion?.["settings.update"]} reason={actionReason(companion?.["settings.update"])} />
              </div>
            </div>
          </section>

          <section className="settings-group">
            <h3 className="settings-group__title">本机能力</h3>
            <div className="settings-consent-list">
              <div className="settings-consent-row">
                <span><b>剪贴板</b><small>回到书房时识别你刚复制的链接，只读链接不读原文；导入前一定先问你。</small></span>
                <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.clipboard} reason={nativeReason(capabilities?.nativeCapabilities.clipboard)} />
              </div>
              <div className="settings-consent-row">
                <span><b>系统通知</b><small>学习提醒是否允许出现在桌面。</small></span>
                <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.notifications} reason={nativeReason(capabilities?.nativeCapabilities.notifications)} />
              </div>
              <div className="settings-consent-row">
                <span><b>自动更新</b><small>桌面端是否检查新版本。</small></span>
                <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.updates} reason={nativeReason(capabilities?.nativeCapabilities.updates)} />
              </div>
            </div>
          </section>
          </div>

          {aiFailure ? <p className="settings-notice settings-notice--error" role="alert">{aiFailure}</p> : null}

          <p className="settings-notice-paper">
            「未接入」表示桌面端还没有这条链路（能力值由主进程按真实存在的通道计算），
            不是权限被拒绝。本产品没有用户级模型或供应商选择，也没有 BYOK 配置；
            工作区级 AI 同意与数据策略由 Owner 在上面签署和调整。
          </p>
        </>
      ),
      footerNote: canManage
        ? "改动立即写入服务端，并同步刷新这一页的能力投影。"
        : "你在这个空间是 Member，因此这些政策只读。",
    };
  };

  /** An inventory of what the workspace holds, then where lifecycle actions live. */
  const managementPanel = (): SettingsPanel => ({
    eyebrow: "空间账本",
    title: "当前空间的数据边界",
    body: (
      <>
        <section className="settings-group">
          <h3 className="settings-group__title">空间内容</h3>
          <div className="settings-stats">
            <div className="settings-stat" data-loading={inventoryLoading ? "true" : undefined}>
              <b>{inventory ? inventory.sources : "—"}</b>
              <span>来源</span>
            </div>
            <div className="settings-stat" data-loading={inventoryLoading ? "true" : undefined}>
              <b>{inventory ? inventory.notes : "—"}</b>
              <span>笔记</span>
            </div>
            <div className="settings-stat" data-loading={inventoryLoading ? "true" : undefined}>
              <b>{inventory ? inventory.objectives : "—"}</b>
              <span>理解目标</span>
            </div>
          </div>
        </section>

        <div className="settings-columns">
        <section className="settings-group">
          <h3 className="settings-group__title">归属</h3>
          <div className="settings-consent-list">
            <div className="settings-consent-row">
              <span><b>当前工作区</b><small>{spaceTypeLabel(currentWorkspace?.workspaceType)} · 你的身份是 {currentRole === "owner" ? "Owner" : "Member"}</small></span>
              <span className="write-line">{currentWorkspace?.name ?? "未选择"}</span>
            </div>
            <div className="settings-consent-row">
              <span><b>可见空间</b><small>这些空间的数据彼此隔离，不会互相索引。</small></span>
              <span className="write-line">{`${workspaces.length} 个`}</span>
            </div>
          </div>
        </section>

        <section className="settings-group">
          <h3 className="settings-group__title">生命周期</h3>
          <div className="settings-consent-list">
            <div className="settings-consent-row">
              <span>
                <b>导出工作区</b>
                <small>
                  {currentRole === "owner"
                    ? "把当前空间的来源、笔记、理解目标与版本写成一个 JSON 文件；保存位置由你在系统对话框里选择。"
                    : "整库导出由服务端 requireOwner 收口，你在这个空间是 Member。"}
                </small>
              </span>
              <button
                type="button"
                className="button"
                disabled={exporting || currentRole !== "owner"}
                onClick={() => void exportWorkspace()}
              >
                {exporting ? "正在导出…" : "导出…"}
              </button>
            </div>
            <div className="settings-consent-row">
              <span>
                <b>删除来源与笔记</b>
                <small>删除是逐条的危险操作，入口在各自的库里，这一页只统计数量。</small>
              </span>
              <button
                type="button"
                className="button"
                onClick={() => { closeSurface(); invoke("open-notes"); }}
              >
                去笔记库
              </button>
            </div>
          </div>
        </section>
        </div>
      </>
    ),
    footerNote: "内容数量来自各库列表接口的总数，与库页面看到的一致。",
  });

  const PANELS: Record<SettingsSectionId, () => SettingsPanel> = {
    account: accountPanel,
    members: membersPanel,
    appearance: appearancePanel,
    companion: companionPanel,
    data: dataPanel,
    management: managementPanel,
  };

  const panel = PANELS[section]();

  // The fade that says "there is more below" is measured after every section
  // change, on every resize, and whenever the section's own async content
  // (loading / inventory counts) swaps in, so a section that fits never shows it.
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return undefined;
    const sync = () => setBodyOverflows(element.scrollHeight - element.clientHeight > 4);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [section, loading, failure, inventoryLoading, inventory, aiSettings]);

  return (
    <HudPage page="settings">
      <section className="settings-hud" data-layout={section === "account" ? "account" : "single"}>
        <aside className="settings-menu">
          <span className="tag">设置目录</span>
          <h2>想调整哪一块？</h2>
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={section === id ? "active" : undefined}
              aria-current={section === id ? "page" : undefined}
              onClick={() => { setSettingsSection(id); setNotice(null); setFailureNotice(null); }}
            >
              {label}
            </button>
          ))}
        </aside>

        {loading ? (
          <article className="settings-card settings-card--state">
            <SurfaceDataState kind="loading" message="正在读取设置" detail="设置页只显示服务端确认的账户、空间与能力。" />
          </article>
        ) : failure ? (
          <article className="settings-card settings-card--state">
            <SurfaceDataState kind="error" message="设置暂时不可用" detail={failure} onRetry={() => void load()} />
          </article>
        ) : (
          <>
            {section === "account" ? (
            <article className="settings-card">
              <span className="tag green">当前空间</span>
              <h2 className="title">{currentWorkspace?.name ?? "未选择学习空间"}</h2>
              <p className="sub">当前配置只影响这个账户与学习空间。</p>
              <div className="space-identity">
                <span className="space-seal">{currentWorkspace?.name?.slice(0, 1) ?? "学"}</span>
                <div>
                  <h3>{currentWorkspace?.name ?? "未选择"}</h3>
                  <div className="meta">
                    <span>{currentRole === "owner" ? "Owner" : currentRole === "member" ? "Member" : "—"}</span>
                    <span>{spaceTypeLabel(currentWorkspace?.workspaceType)}</span>
                    <span>当前进入</span>
                  </div>
                </div>
              </div>
              <div className="ledger-field"><b>登录身份</b><span className="write-line">{session?.user?.email ?? "已登录"}</span></div>
              <div className="ledger-field"><b>当前进入</b><span className="write-line">{currentWorkspace?.name ?? "未选择"}</span></div>
              <div className="ledger-field"><b>当前权限</b><span className="write-line">{roleLabel(currentRole)}</span></div>
              <div className="ledger-field">
                <b>数据边界</b>
                <span className="write-line">
                  <Compass size={12} aria-hidden="true" style={{ marginRight: 6, verticalAlign: "-2px" }} />
                  {companion?.["companion.read"] === "allowed" ? "伴星可读取" : "不外发"}
                </span>
              </div>
            </article>
            ) : null}

            <article className="settings-card preference">
              <span className="tag">{panel.eyebrow}</span>
              <h2 className="title">{panel.title}</h2>
              <div className="settings-body" ref={bodyRef} data-overflow={bodyOverflows ? "true" : undefined}>
                {panel.body}
              </div>
              {failureNotice
                ? <p className="settings-notice settings-notice--error" role="alert">{failureNotice}</p>
                : notice ? <p className="settings-notice" role="status">{notice}</p> : null}
              {panel.footerNote ? (
                <div className="settings-actions">
                  <span className="small">{panel.footerNote}</span>
                </div>
              ) : null}
            </article>
          </>
        )}
      </section>
    </HudPage>
  );
}
