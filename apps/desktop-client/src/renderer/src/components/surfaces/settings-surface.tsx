import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  AudioLines,
  Bell,
  BookOpen,
  Check,
  CircleHelp,
  Clipboard,
  ClipboardCheck,
  Compass,
  Copy,
  Download,
  FileUp,
  ImageUp,
  KeyRound,
  LogOut,
  MessageCircle,
  MessagesSquare,
  Mic,
  Pause,
  Play,
  Moon,
  RefreshCw,
  SearchCheck,
  Sparkles,
  Sun,
  Trash2,
  UserPlus,
} from "lucide-react";
import {
  AI_CONSENT_VERSION,
  type AiDataPolicyV1,
  type AuthProfileResultV1,
  type CapabilityProjectionV1,
  type InviteCreatedV1,
  type InviteListResultV1,
  type InviteStatusV1,
  type MemberListResultV1,
  type SearchDriftResultV1,
  type SearchReindexResultV1,
  type SessionContextV1,
  type WorkspaceAiSettingsV1,
  type WorkspaceSummaryV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import type { CompanionAnswerModePreferenceV1, CompanionVoicePreferenceV1 } from "@ailearn/shared/companion-shell-contracts";
import {
  EDGE_TTS_VOICE_OPTIONS,
  QWEN_TTS_VOICE_OPTIONS,
  TTS_PREVIEW_TEXT,
  findTtsVoiceOption,
  type TtsEngineV1,
  type TtsVoiceOptionV1,
} from "@ailearn/shared/tts-voice-catalog";
import type { MotionMode } from "../../app/room-machine";
import {
  MAX_COMPANION_SCALE,
  MIN_COMPANION_SCALE,
  useRoomStore,
} from "../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { signOutCurrentAccount } from "../../app/account-signout";
import { SETTINGS_ATTENTION_AI_CONSENT } from "../../app/companion-consent-gate";
import { publishGateInvalidation } from "../../app/gate-invalidation";
import {
  DIRECTORY_RAIL_MODE_EVENT,
  DIRECTORY_RAIL_MODE_KEY,
  readDirectoryRailMode,
  type DirectoryRailMode,
} from "../DirectoryRail";
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
  ["appearance", "主题与动效"],
  ["companion", "语音与伴星"],
  ["data", "AI 数据同意"],
  ["management", "数据与维护"],
] as const;

type SettingsSectionId = (typeof SECTIONS)[number][0];

const SECTION_IDS: readonly string[] = SECTIONS.map(([id]) => id);

/**
 * 注意力高亮的持续时长（与 hud-surface.css 的 `settings-attention-pulse`
 * 动画时长成对：改一处要改两处）。到期后清掉一次性请求，避免下次进页面还闪。
 */
export const SETTINGS_ATTENTION_MS = 4_200;

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
  if (!value) return "这一项还没拿到答复。";
  if (value === "allowed") return "已经允许。";
  if (value === "conditional") return "满足条件时才允许，由系统按当前情况判断。";
  return "当前不允许。伴星相关能力由工作区 AI 同意与数据外发策略决定，管理类能力由角色决定。";
}

function featureReason(state: string | undefined, reason: string | undefined): string {
  if (!state) return "这一项还没拿到答复。";
  if (state === "enabled") return "这条链路已经启用。";
  if (state === "conditional") return "按条件启用。";
  return reason === "error.feature_disabled"
    ? "部署时没有打开这条链路。"
    : "这一项当前不可用。";
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
  if (!value) return <span className="tag" title={reason} aria-label={`状态未知：${reason ?? "尚未读取"}`}>—</span>;
  const on = value === "allowed" || value === "available" || value === "enabled";
  const label = kind === "native"
    // 本机能力为 unavailable 时，含义是「客户端没有这条链路」，而不是「权限被拒」。
    ? (value === "available" ? "已接入" : "未接入")
    : kind === "feature"
      ? (value === "enabled" ? "已开启" : value === "conditional" ? "按条件" : value === "disabled" ? "已关闭" : "暂不可用")
      : (value === "allowed" ? "已允许" : value === "conditional" ? "按条件" : "未允许");
  return <span className={on ? "tag green" : "tag"} title={reason} aria-label={`${label}：${reason ?? ""}`}>{label}</span>;
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

/** 头像文件读成 base64；分块 btoa，避免一次性展开整个字符串。 */
async function fileToBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < buffer.length; offset += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

const INVITE_EXPIRY_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["24", "24 小时"],
  ["72", "72 小时"],
  ["168", "7 天"],
  ["none", "无限制"],
];

/**
 * 数据外发策略的四个开关：字段、标题、说明。以前它们是四段复制粘贴的 JSX，
 * 只有一处写错就会让开关写进另一个字段，而那种错误在类型上是看不出来的。
 */
const DATA_POLICY_FIELDS: ReadonlyArray<readonly [keyof AiDataPolicyV1, string, string]> = [
  ["sendToExternal", "允许发送到外部模型服务", "关闭后，内容不会发送给外部模型服务。"],
  ["sendImageContent", "允许发送图片内容", "只影响图片类素材；关闭后图片留在本机。"],
  ["piiDetection", "外发前做个人信息检测", "在内容离开本机前先标记可能的个人信息。"],
  ["auditLogging", "记录 AI 审计日志", "每次外发都留下可追溯的记录，供你回看。"],
];

const formatVoiceTime = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const TTS_ENGINE_OPTIONS: ReadonlyArray<readonly [TtsEngineV1, string]> = [
  ["qwen", "千问"],
  ["edge", "Edge-TTS"],
];

/** 切引擎时一起落定的音色：edge 只有一条，千问取目录第一条。 */
const ttsDefaultVoiceFor = (engine: TtsEngineV1): string =>
  engine === "qwen" ? QWEN_TTS_VOICE_OPTIONS[0].voice : EDGE_TTS_VOICE_OPTIONS[0].voice;

const ANSWER_MODE_OPTIONS: ReadonlyArray<readonly [CompanionAnswerModePreferenceV1["preference"], string]> = [  ["any", "跟随安排"],
  ["voice", "语音"],
  ["silent", "静默结构"],
  ["text", "文字"],
];

function inviteStatusLabel(status: InviteStatusV1): string {
  if (status === "active") return "可用";
  if (status === "consumed") return "已使用";
  if (status === "revoked") return "已撤销";
  return "已过期";
}

/**
 * 「168 小时内有效」不是读者写得出来的话。选项自己带着人读得懂的说法，就直接
 * 用它，别把内部小时数再抄一遍。
 */
function inviteExpiryLabel(value: string): string {
  if (value === "none") return "长期有效，直到手动撤销";
  return `${INVITE_EXPIRY_OPTIONS.find(([option]) => option === value)?.[1] ?? value}内有效`;
}

/** 邀请与成员时间只作展示，按日历日截取。 */
function dayLabel(value: string | null): string {
  return value ? value.slice(0, 10) : "—";
}

/**
 * One row of the settings card, and the only one there is: an optional mark,
 * the copy, and the control cell on the right. A consent toggle, a capability
 * chip, a roster entry, a ledger value and a preference choice are all the same
 * object here, which is what the three near-identical rows this replaces
 * (`choice-row`, `settings-consent-row`, `settings-capability`) had stopped
 * being — they disagreed on padding, on the gap before the control, and on
 * whether the title was serif 12px or sans 11px.
 *
 * The three cells are placed explicitly (`settings-row__body` → column 2,
 * `settings-row__control` → column 3): with auto-placement a mark-less row
 * dropped its control into the flexible middle track, which un-anchored it
 * from the right edge and, in a narrow column with long copy, squeezed that
 * track to zero and let the control spill out of the card.
 */
function SettingRow({
  mark,
  title,
  detail,
  children,
  selected = false,
}: {
  /** The drawn glyph in front of the copy. Capability lists use it; rows that
   *  are pure label/value pairs leave it out and start at the card's edge. */
  readonly mark?: React.ReactNode;
  readonly title: React.ReactNode;
  readonly detail: React.ReactNode;
  /** The right-hand cell: a chip, a switch, a button, a value — or nothing, in
   *  which case the copy keeps the full width. */
  readonly children?: React.ReactNode;
  /** 这一行就是当前生效的选择。列表里五行长得一模一样时，"哪个在用"不该靠读小字。 */
  readonly selected?: boolean;
}) {
  return (
    <div className={selected ? "settings-row settings-row--selected" : "settings-row"}>
      {mark ? <span className="settings-row__mark" aria-hidden="true">{mark}</span> : null}
      <span className="settings-row__body">
        <b>{title}</b>
        <small>{detail}</small>
      </span>
      {children ? <span className="settings-row__control">{children}</span> : null}
    </div>
  );
}

type SettingsPanel = {
  readonly title: string;
  readonly body: React.ReactNode;
  readonly footerNote?: string;
};

function SettingsInlineState({
  title,
  detail,
  tone = "neutral",
  onRetry,
}: {
  readonly title: string;
  readonly detail: string;
  readonly tone?: "neutral" | "error";
  readonly onRetry?: () => void;
}) {
  return (
    <div className="settings-inline-state" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      <span>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
      {onRetry ? <button type="button" className="button" onClick={onRetry}>重试</button> : null}
    </div>
  );
}

/**
 * Page 21 — the settings centre.
 *
 * The mockup composes the page as three HUD surfaces: a green directory, the
 * current space's ledger, and one card for whatever the directory has selected.
 * This file owns that third card, and it is written per entry: the account
 * groups the room's defaults, membership is a ledger plus a real invite form,
 * appearance picks the theme off the plate itself, the companion tab is a
 * control block over a capability list, consent is drawn as the path data takes
 * and is **writable by the signed-in account only**, and data management is an
 * inventory of what the workspace holds.
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
  const settingsAttention = useRoomStore((state) => state.settingsAttention);
  const setSettingsAttention = useRoomStore((state) => state.setSettingsAttention);
  const setHudPage = useRoomStore((state) => state.setHudPage);
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
  const [workspaceListFailure, setWorkspaceListFailure] = useState<string | null>(null);
  const [capabilityFailure, setCapabilityFailure] = useState<string | null>(null);
  const [aiSettingsFailure, setAiSettingsFailure] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failureNotice, setFailureNotice] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [aiSaving, setAiSaving] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [inventory, setInventory] = useState<{ sources: number; notes: number; objectives: number } | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryFailure, setInventoryFailure] = useState<string | null>(null);
  // ── 旧版设置页回补（2026-09-18）────────────────────────────────
  const [profile, setProfile] = useState<AuthProfileResultV1 | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [profileBusy, setProfileBusy] = useState<string | null>(null);
  const [profileFailure, setProfileFailure] = useState<string | null>(null);
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [passwordForm, setPasswordForm] = useState({ current: "", next: "", confirm: "" });
  /** 退出登录后这台设备就交还给登录页了；这一位只用来让按下去的那一下有回音。 */
  const [signingOut, setSigningOut] = useState(false);
  const [invites, setInvites] = useState<InviteListResultV1 | null>(null);
  const [members, setMembers] = useState<MemberListResultV1 | null>(null);
  const [invitesRead, setInvitesRead] = useState(false);
  const [membersRead, setMembersRead] = useState(false);
  const [invitesFailure, setInvitesFailure] = useState<string | null>(null);
  const [membersFailure, setMembersFailure] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<"member" | "owner">("member");
  const [inviteExpiry, setInviteExpiry] = useState("72");
  const [createdInvite, setCreatedInvite] = useState<InviteCreatedV1 | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [ownerBusy, setOwnerBusy] = useState<string | null>(null);
  const [removeCandidate, setRemoveCandidate] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [drift, setDrift] = useState<SearchDriftResultV1 | null>(null);
  const [reindexResult, setReindexResult] = useState<SearchReindexResultV1 | null>(null);
  const [answerMode, setAnswerMode] = useState<CompanionAnswerModePreferenceV1 | null>(null);
  /** 作答方式是账号级偏好，读取失败时不能把「跟随安排」当成服务端答案展示。 */
  const [answerModeRead, setAnswerModeRead] = useState(false);
  const [answerModeSaving, setAnswerModeSaving] = useState(false);
  // 声音：引擎 + 音色（账号级）。与作答方式同样"读到才画选项"，没读到不能把默认值演成用户的选择。
  const [voicePreference, setVoicePreference] = useState<CompanionVoicePreferenceV1 | null>(null);
  const [voicePreferenceRead, setVoicePreferenceRead] = useState(false);
  const [voiceSaving, setVoiceSaving] = useState(false);
  /** 录音放不出来时的读数（例如资产没打进包）：控件在响但没声音，比没控件更难查。 */
  const [voicePreviewError, setVoicePreviewError] = useState<string | null>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  /** 播放器读数：只有真合成回来才有值，没试听过时界面讲的是"将要念的那句"。 */
  const [voicePlayer, setVoicePlayer] = useState<{
    readonly name: string;
    readonly voice: string;
    readonly at: number;
    readonly total: number;
    readonly playing: boolean;
  } | null>(null);
  const [inventoryEpoch, setInventoryEpoch] = useState(0);
  const [auxiliaryEpoch, setAuxiliaryEpoch] = useState(0);
  const epochRef = useRef<number | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHasMore, setBodyHasMore] = useState(false);
  const consentGroupRef = useRef<HTMLElement | null>(null);
  const consentAttentionTimerRef = useRef<number | null>(null);
  const [consentAttention, setConsentAttention] = useState(false);
  useHudPage("settings");

  const section: SettingsSectionId = SECTION_IDS.includes(settingsSection)
    ? settingsSection as SettingsSectionId
    : "account";

  /**
   * 伴星因缺少 AI 同意停摆时会把读者送到这里（2026-09-19）：滚到「签署状态」卡、
   * 闪一下。请求**立刻消费**（只引导一次，下次进页面不再闪），高亮由计时器摘掉；
   * 计时器住在 ref 里而不是 effect 清理函数里——消费请求会让 effect 重跑，
   * 返回清理函数会把刚设好的计时器立刻取消，高亮就永远摘不掉了。
   */
  useEffect(() => {
    if (settingsAttention !== SETTINGS_ATTENTION_AI_CONSENT || section !== "data") return;
    setSettingsAttention(null);
    setConsentAttention(true);
    consentGroupRef.current?.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
    if (consentAttentionTimerRef.current !== null) window.clearTimeout(consentAttentionTimerRef.current);
    consentAttentionTimerRef.current = window.setTimeout(() => {
      consentAttentionTimerRef.current = null;
      setConsentAttention(false);
    }, SETTINGS_ATTENTION_MS);
  }, [reducedMotion, section, setSettingsAttention, settingsAttention]);

  useEffect(() => () => {
    if (consentAttentionTimerRef.current !== null) window.clearTimeout(consentAttentionTimerRef.current);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    setWorkspaceListFailure(null);
    setCapabilityFailure(null);
    setAiSettingsFailure(null);
    try {
      const current = await readAuthenticatedSession(epochRef);
      setSession(current);
      const meta = () => createRequestMeta(current.workspaceEpoch);
      const [workspaceResult, capabilityResult, aiResult] = await Promise.allSettled([
        (async () => {
          const response = await window.ailearn.workspace.list({ meta: meta() });
          if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
          return unwrapGatewayResult(response).workspaces;
        })(),
        (async () => {
          const response = await window.ailearn.capabilities.get({ meta: meta() });
          if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
          return unwrapGatewayResult(response);
        })(),
        (async () => {
          const response = await window.ailearn.workspace.getAiSettings({ meta: meta() });
          if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
          return unwrapGatewayResult(response);
        })(),
      ]);

      if (workspaceResult.status === "fulfilled") setWorkspaces(workspaceResult.value);
      else {
        setWorkspaces([]);
        setWorkspaceListFailure(gatewayErrorMessage(workspaceResult.reason));
      }
      if (capabilityResult.status === "fulfilled") setCapabilities(capabilityResult.value);
      else {
        setCapabilities(null);
        setCapabilityFailure(gatewayErrorMessage(capabilityResult.reason));
      }
      if (aiResult.status === "fulfilled") setAiSettings(aiResult.value);
      else {
        setAiSettings(null);
        setAiSettingsFailure(gatewayErrorMessage(aiResult.reason));
      }
      setFailureNotice(null);
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
    const [capabilityResult, aiResult] = await Promise.allSettled([
      (async () => {
        const response = await window.ailearn.capabilities.get({ meta: createRequestMeta(epochRef.current) });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        return unwrapGatewayResult(response);
      })(),
      (async () => {
        const response = await window.ailearn.workspace.getAiSettings({ meta: createRequestMeta(epochRef.current) });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        return unwrapGatewayResult(response);
      })(),
    ]);
    if (capabilityResult.status === "fulfilled") {
      setCapabilities(capabilityResult.value);
      setCapabilityFailure(null);
    } else {
      setCapabilityFailure(gatewayErrorMessage(capabilityResult.reason));
    }
    if (aiResult.status === "fulfilled") {
      setAiSettings(aiResult.value);
      setAiSettingsFailure(null);
    } else {
      setAiSettingsFailure(gatewayErrorMessage(aiResult.reason));
    }
  }, []);

  /** What the workspace holds, read from the same lists the library pages use. */
  useEffect(() => {
    if (!session?.workspace?.workspaceId) return undefined;
    let active = true;
    setInventoryLoading(true);
    setInventoryFailure(null);
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
      } catch (error) {
        // The inventory is informational; the rest of the page still stands.
        if (active) {
          setInventory(null);
          setInventoryFailure(gatewayErrorMessage(error));
        }
      } finally {
        if (active) setInventoryLoading(false);
      }
    })();
    return () => { active = false; };
  }, [session?.workspace?.workspaceId, inventoryEpoch]);

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
      setNotice(`已切换到「${workspace.name}」，这一页读的是新空间的最新状态。`);
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
    setNotice(null);
    setFailureNotice(null);
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
      setNotice("AI 数据策略已更新。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
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
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.workspace.updateAiConsent({
        meta: createRequestMeta(epochRef.current),
        consentVersion: AI_CONSENT_VERSION,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setAiSettings(unwrapGatewayResult(response));
      await reloadAfterPolicyWrite();
      setNotice("AI 使用同意已签署，能力状态已刷新。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setAiSaving(null);
    }
  };

  // ── 旧版设置页回补的操作 ───────────────────────────────────────────
  /** 改昵称。空串等价于清除；服务端自己截断到 32 字。 */
  const saveDisplayName = async () => {
    if (profileBusy) return;
    setProfileBusy("displayName");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.auth.updateProfile({
        meta: createRequestMeta(epochRef.current),
        displayName: displayName.trim() || null,
      });
      const next = unwrapGatewayResult(response);
      setProfile(next);
      setSession((current) => {
        if (current?.status !== "authenticated" || !current.user) return current;
        return { ...current, user: { ...current.user, displayName: next.displayName ?? undefined } };
      });
      setNotice(next.displayName ? `显示名已更新为「${next.displayName}」。` : "显示名已清除。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  /** 上传头像：main 以 multipart 送 /uploads/avatars，服务端同时持久化 avatarUrl。 */
  const uploadAvatar = async (file: File) => {
    if (profileBusy) return;
    setProfileBusy("avatar");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.auth.uploadAvatar({
        meta: createRequestMeta(epochRef.current),
        request: {
          version: 1,
          fileName: file.name,
          mimeType: file.type,
          bytesBase64: await fileToBase64(file),
        },
      });
      const result = unwrapGatewayResult(response);
      setProfile((current) => ({ version: 1, displayName: current?.displayName ?? null, avatarUrl: result.url }));
      setNotice("头像已更新。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  const clearAvatar = async () => {
    if (profileBusy) return;
    setProfileBusy("avatar");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.auth.updateProfile({
        meta: createRequestMeta(epochRef.current),
        avatarUrl: null,
      });
      setProfile(unwrapGatewayResult(response));
      setNotice("头像已清除，恢复首字母印章。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  /** 改密码：服务端会撤销所有会话，改完必须重新登录。 */
  const submitPasswordChange = async () => {
    if (profileBusy) return;
    if (!passwordForm.current || passwordForm.next.length < 8) {
      setFailureNotice("新密码至少 8 位。");
      return;
    }
    if (passwordForm.next !== passwordForm.confirm) {
      setFailureNotice("两次输入的新密码不一致。");
      return;
    }
    setProfileBusy("password");
    setNotice(null);
    setFailureNotice(null);
    try {
      unwrapGatewayResult(await window.ailearn.auth.changePassword({
        meta: createRequestMeta(epochRef.current),
        commandId: crypto.randomUUID(),
        currentPassword: passwordForm.current,
        newPassword: passwordForm.next,
      }));
      setPasswordForm({ current: "", next: "", confirm: "" });
      // 所有会话已被服务端撤销，凭据也已在本机清除：走 gate 重新登录。
      publishGateInvalidation("stale_workspace");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  /**
   * 退出登录。动作本体在 `app/account-signout.ts`，与顶栏账户小框共用一份：
   * 两处对「退出了没有」的说法必须一致，三种结局的话也由它一次写好。
   *
   * 这里不接 `setNotice`：门禁随即把整页换成登录页，页面自己的提示活不过那一行
   * （设置页以前就是这么把「已切换到…」弄丢的）。
   */
  const signOutOfAccount = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await signOutCurrentAccount();
  };

  /** Owner：生成邀请。结果里的 token 只显示这一次。 */
  const createInvite = async () => {
    if (ownerBusy) return;
    setOwnerBusy("create");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.invites.create({
        meta: createRequestMeta(epochRef.current),
        role: inviteRole,
        expiresInHours: inviteExpiry === "none" ? undefined : Number(inviteExpiry),
      });
      setCreatedInvite(unwrapGatewayResult(response));
      const listResponse = await window.ailearn.invites.list({ meta: createRequestMeta(epochRef.current) });
      setInvites(unwrapGatewayResult(listResponse));
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  const revokeInvite = async (inviteId: string) => {
    if (ownerBusy) return;
    setOwnerBusy(inviteId);
    setNotice(null);
    setFailureNotice(null);
    try {
      unwrapGatewayResult(await window.ailearn.invites.revoke({
        meta: createRequestMeta(epochRef.current),
        inviteId,
      }));
      const listResponse = await window.ailearn.invites.list({ meta: createRequestMeta(epochRef.current) });
      setInvites(unwrapGatewayResult(listResponse));
      setNotice("邀请已撤销。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  /** Owner：移除成员。二次确认在行内完成（第一次点变成确认）。 */
  const removeMember = async (userId: string) => {
    if (ownerBusy) return;
    if (removeCandidate !== userId) {
      setRemoveCandidate(userId);
      return;
    }
    setOwnerBusy(userId);
    setRemoveCandidate(null);
    setNotice(null);
    setFailureNotice(null);
    try {
      unwrapGatewayResult(await window.ailearn.members.remove({
        meta: createRequestMeta(epochRef.current),
        userId,
      }));
      const listResponse = await window.ailearn.members.list({ meta: createRequestMeta(epochRef.current) });
      setMembers(unwrapGatewayResult(listResponse));
      setNotice("成员已移除，其在当前空间的会话立即失效。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  /** Member：退出协作工作区。退出当前空间时服务端会签发个人空间的新会话。 */
  const leaveWorkspace = async (workspace: WorkspaceSummaryV1) => {
    if (profileBusy) return;
    setProfileBusy(`leave-${workspace.workspaceId}`);
    setNotice(null);
    setFailureNotice(null);
    try {
      unwrapGatewayResult(await window.ailearn.auth.leaveWorkspace({
        meta: createRequestMeta(epochRef.current),
        workspaceId: workspace.workspaceId,
      }));
      setNotice(`已退出「${workspace.name}」。`);
      // 空间边界变化：沿用切换空间的失效路径，但把读者送回这一页。
      publishGateInvalidation("stale_workspace");
      invoke("open-settings");
      setSettingsSection(section);
      setHudPage("settings", "returning");
      await load();
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  /** 重命名自己的个人工作区。 */
  const renamePersonalWorkspace = async () => {
    const name = renameValue.trim();
    if (!personalWorkspace || !name || profileBusy) return;
    setProfileBusy("rename");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.workspace.rename({
        meta: createRequestMeta(epochRef.current),
        workspaceId: personalWorkspace.workspaceId,
        name,
      });
      const result = unwrapGatewayResult(response);
      setWorkspaces((current) => current.map((workspace) => (
        workspace.workspaceId === result.workspaceId ? { ...workspace, name: result.name } : workspace
      )));
      setSession((current) => {
        if (current?.status !== "authenticated" || !current.workspace) return current;
        if (current.workspace.workspaceId !== result.workspaceId) return current;
        return { ...current, workspace: { ...current.workspace, name: result.name } };
      });
      setNotice(`个人空间已更名为「${result.name}」。`);
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  /** Markdown 批量导入：文件名（去扩展名）作标题，正文是 UTF-8 文本。 */
  const importMarkdownFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || importBusy) return;
    setImportBusy(true);
    setNotice(null);
    setFailureNotice(null);
    try {
      const items = await Promise.all(Array.from(files).slice(0, 100).map(async (file) => ({
        title: file.name.replace(/\.(md|markdown|txt)$/i, "").slice(0, 200),
        content: await file.text(),
      })));
      const response = await window.ailearn.markdownImport.run({
        meta: createRequestMeta(epochRef.current),
        items,
        importId: crypto.randomUUID(),
      });
      const result = unwrapGatewayResult(response);
      setNotice(result.failed > 0
        ? `已导入 ${result.imported} 篇，${result.failed} 条失败；失败条目可在重试时一起再导。`
        : `已导入 ${result.imported} 篇笔记。`);
      setInventoryEpoch((value) => value + 1);
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setImportBusy(false);
    }
  };

  const checkSearchDrift = async () => {
    if (ownerBusy) return;
    setOwnerBusy("drift");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.search.drift({ meta: createRequestMeta(epochRef.current) });
      setDrift(unwrapGatewayResult(response));
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  const runSearchReindex = async () => {
    if (ownerBusy) return;
    setOwnerBusy("reindex");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.search.reindex({ meta: createRequestMeta(epochRef.current) });
      setReindexResult(unwrapGatewayResult(response));
      setNotice("搜索索引已重建。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  /**
   * 作答方式是账号级偏好，写它有自己的忙碌位：以前借用 `profileBusy`，结果是
   * 改昵称的同时点这一行会被静默丢弃（控件没有 disabled 状态，也没有反馈）。
   */
  const changeAnswerMode = async (preference: CompanionAnswerModePreferenceV1["preference"]) => {
    if (answerModeSaving) return;
    setAnswerModeSaving(true);
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.companion.answerMode.patch({
        meta: createRequestMeta(epochRef.current),
        preference,
      });
      setAnswerMode(unwrapGatewayResult(response));
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setAnswerModeSaving(false);
    }
  };

  /**
   * 保存"这一身"。引擎与音色成对写：切到 edge 时把 edge 那条固定音色一起写下去，
   * 库里不留"引擎=edge + 音色是千问的"的半套状态（服务端读到不配对会整条回默认，
   * 但那是兜底，不该由界面产生）。
   */
  const changeVoice = async (engine: TtsEngineV1, voice: string) => {
    if (voiceSaving) return;
    setVoiceSaving(true);
    setFailureNotice(null);
    try {
      const response = await window.ailearn.companion.voicePreference.patch({
        meta: createRequestMeta(epochRef.current),
        engine,
        voice,
      });
      setVoicePreference(unwrapGatewayResult(response));
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setVoiceSaving(false);
    }
  };

  /**
   * 播放器读数：换掉原生 <audio controls> 之后，进度、时长和"在放哪一身"全由这几个事件供。
   *
   * 不能挂在一次性 mount effect 上：<audio> 渲染在「语音与伴星」这一屏里，effect 跑的
   * 那一刻它还不存在（真窗口实测：音频在放，读数却永远停在 0:00 / 0:00、进度条一动不动）。
   * 所以改成第一次要用它之前接线，按元素身份去重。
   */
  const wiredAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceAudioHandlersRef = useRef<Record<string, EventListener> | null>(null);
  const wireVoiceAudio = () => {
    const element = voiceAudioRef.current;
    if (!element || wiredAudioRef.current === element) return;
    const patch = (next: Partial<{ at: number; total: number; playing: boolean }>) =>
      setVoicePlayer((prev) => (prev ? { ...prev, ...next } : prev));
    const handlers: Record<string, EventListener> = {
      loadedmetadata: () => patch({ total: Number.isFinite(element.duration) ? element.duration : 0 }),
      timeupdate: () => patch({ at: element.currentTime }),
      play: () => patch({ playing: true }),
      pause: () => patch({ playing: false }),
      ended: () => patch({ playing: false }),
      error: () => setVoicePreviewError("这段试听录音没能放出来。"),
    };
    for (const [event, handler] of Object.entries(handlers)) element.addEventListener(event, handler);
    wiredAudioRef.current = element;
    voiceAudioHandlersRef.current = handlers;
  };

  /**
   * 试听：直接放渲染进程里的那段录音。
   *
   * 这里刻意不再调服务端。挑声音天然要把同一句话反复听好几遍，每听一遍就合成一次
   * 是白花钱；录音按当前 model + voice + instruction 生成，改那三样要重新生成资产
   * （见 public/assets/companion/voice-preview-v1/PROVENANCE.md）。
   */
  const previewVoice = (option: TtsVoiceOptionV1) => {
    setVoicePreviewError(null);
    setVoicePlayer({ name: option.name, voice: option.voice, at: 0, total: 0, playing: false });
    const element = voiceAudioRef.current;
    if (!element) return;
    wireVoiceAudio();
    element.src = option.previewAsset;
    element.load();
    // 用户点的就是"放给我听"，不再要求二次点击；被自动播放策略拦下时播放器仍可手动按。
    void element.play().catch(() => undefined);
  };

  useEffect(() => () => {
    const element = wiredAudioRef.current;
    const handlers = voiceAudioHandlersRef.current;
    if (element && handlers) {
      for (const [event, handler] of Object.entries(handlers)) element.removeEventListener(event, handler);
    }
  }, []);

  const toggleVoicePlayer = () => {
    const element = voiceAudioRef.current;
    if (!element || !voicePlayer) return;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  };

  const copyInviteToken = async (token: string) => {
    setCopiedCode(false);
    setFailureNotice(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(token);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 2_000);
    } catch {
      setFailureNotice("无法写入剪贴板。邀请码已显示在页面中，请手动选择并复制。");
    }
  };

  const currentWorkspace = session?.workspace ?? null;
  const currentRole = session?.membership?.role;
  const companion = capabilities?.actionCapabilities;
  const features = capabilities?.featureAvailability;

  const isOwner = currentRole === "owner";
  const personalWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.isPersonal) ?? null,
    [workspaces],
  );

  // ── 旧版设置页回补：档案、Owner 名册、作答偏好随会话读取 ───────────
  const sessionUserId = session?.user?.userId ?? null;
  const sessionWorkspaceId = session?.workspace?.workspaceId ?? null;
  /**
   * 只在「换了人」或「换了空间」时重读，而不是在 `session` 对象每次换引用时
   * 重读：改显示名、改头像都会写一份新的 session，之前那样会让这段读取再跑一遍，
   * 回填的旧值会把读者正在输入的内容覆盖掉。
   */
  useEffect(() => {
    if (!sessionUserId || !sessionWorkspaceId) return undefined;
    let active = true;
    const meta = () => createRequestMeta(epochRef.current);
    setProfileFailure(null);
    setAnswerModeRead(false);
    setInvitesRead(!isOwner);
    setMembersRead(!isOwner);
    setInvitesFailure(null);
    setMembersFailure(null);
    if (!isOwner) {
      setInvites(null);
      setMembers(null);
    }

    void (async () => {
      try {
        const profileResult = unwrapGatewayResult(
          await window.ailearn.auth.getProfile({ meta: meta() }),
        );
        if (!active) return;
        setProfile(profileResult);
        setDisplayName(profileResult.displayName ?? "");
      } catch (error) {
        if (active) setProfileFailure(gatewayErrorMessage(error));
      }
    })();

    void (async () => {
      try {
        const result = unwrapGatewayResult(
          await window.ailearn.companion.answerMode.get({ meta: meta() }),
        );
        if (active) setAnswerMode(result);
      } catch {
        if (active) setAnswerMode(null);
      } finally {
        if (active) setAnswerModeRead(true);
      }
    })();

    void (async () => {
      try {
        const result = unwrapGatewayResult(
          await window.ailearn.companion.voicePreference.get({ meta: meta() }),
        );
        if (active) setVoicePreference(result);
      } catch {
        if (active) setVoicePreference(null);
      } finally {
        if (active) setVoicePreferenceRead(true);
      }
    })();

    if (isOwner) {
      void (async () => {
        try {
          const result = unwrapGatewayResult(await window.ailearn.invites.list({ meta: meta() }));
          if (active) setInvites(result);
        } catch (error) {
          if (active) setInvitesFailure(gatewayErrorMessage(error));
        } finally {
          if (active) setInvitesRead(true);
        }
      })();
      void (async () => {
        try {
          const result = unwrapGatewayResult(await window.ailearn.members.list({ meta: meta() }));
          if (active) setMembers(result);
        } catch (error) {
          if (active) setMembersFailure(gatewayErrorMessage(error));
        } finally {
          if (active) setMembersRead(true);
        }
      })();
    }

    return () => { active = false; };
  }, [auxiliaryEpoch, sessionUserId, sessionWorkspaceId, isOwner]);

  // 头像字节：站内地址渲染层够不到，走 main 的字节通道取 base64。
  const avatarObjectKey = profile?.avatarUrl
    ? profile.avatarUrl.replace("/api/uploads/", "")
    : null;
  useEffect(() => {
    if (!avatarObjectKey) {
      setAvatarSrc(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const response = await window.ailearn.auth.getAvatar({
          meta: createRequestMeta(epochRef.current),
          request: { version: 1, objectKey: avatarObjectKey },
        });
        const data = unwrapGatewayResult(response);
        if (active) setAvatarSrc(`data:${data.mimeType};base64,${data.imageBase64}`);
      } catch {
        // 头像取不回就落回首字母印章，不算页面失败。
      }
    })();
    return () => { active = false; };
  }, [avatarObjectKey]);
  /** 账户与空间共用一张稳定的主纸面：左边回答「我在哪里」，右边回答「我是谁」。 */
  const accountPanel = (): SettingsPanel => ({
    title: "账户与空间",
    body: (
      <div className="settings-account-grid">
        <section className="settings-account-column" aria-label="当前空间">
          <div className="space-identity">
            <span className="space-seal">{currentWorkspace?.name?.slice(0, 1) ?? "学"}</span>
            <div>
              <h3>{currentWorkspace?.name ?? "未选择学习空间"}</h3>
              <div className="meta">
                <span>{roleLabel(currentRole)}</span>
                <span>{spaceTypeLabel(currentWorkspace?.workspaceType)}</span>
              </div>
            </div>
          </div>
          {workspaceListFailure ? (
            <SettingsInlineState
              title="空间列表暂时不可用"
              detail={workspaceListFailure}
              tone="error"
              onRetry={() => void load()}
            />
          ) : null}
          <section className="settings-group">
            <h3 className="settings-group__title">这个空间的边界</h3>
            <div className="ledger-field">
              <b>数据边界</b>
              <span className="write-line">
                <Compass className="write-line__icon" size={12} aria-hidden="true" />
                {capabilityFailure
                  ? "状态未读取"
                  : companion?.["companion.read"] === "allowed" ? "伴星可读取" : "当前不外发"}
              </span>
            </div>
          </section>
          <section className="settings-group">
            <h3 className="settings-group__title">我的空间</h3>
            <div className="settings-ledger" role="group" aria-label="我的空间身份">
              {workspaces.length === 0 && !workspaceListFailure ? (
                <SettingsInlineState title="没有可切换的空间" detail="当前会话未返回其他学习空间。" />
              ) : workspaces.map((workspace) => {
                const current = workspace.workspaceId === currentWorkspace?.workspaceId;
                const busy = switching === workspace.workspaceId;
                const canLeave = !workspace.isPersonal && workspace.role !== "owner";
                return (
                  <div key={workspace.workspaceId} className="settings-ledger__item">
                    <button
                      type="button"
                      className="settings-ledger__row"
                      aria-current={current ? "true" : undefined}
                      aria-busy={busy || undefined}
                      disabled={switching !== null}
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
                    {canLeave ? (
                      <button
                        type="button"
                        className="button danger settings-ledger__leave"
                        aria-label={`退出 ${workspace.name}`}
                        disabled={profileBusy !== null || switching !== null}
                        onClick={() => void leaveWorkspace(workspace)}
                      >
                        <LogOut size={12} aria-hidden="true" />
                        {profileBusy === `leave-${workspace.workspaceId}` ? "退出中…" : "退出"}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {personalWorkspace ? (
              <div className="settings-block">
                <div className="settings-block__head">
                  <div>
                    <b>个人空间改名</b>
                    <p>只对「{personalWorkspace.name}」生效，协作空间不能从这里改名。</p>
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field__label" htmlFor="settings-personal-name">个人空间名称</label>
                  <div className="hud-field">
                    <input
                      id="settings-personal-name"
                      value={renameValue}
                      placeholder="最长 50 字"
                      maxLength={50}
                      disabled={profileBusy !== null}
                      onChange={(event) => setRenameValue(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        void renamePersonalWorkspace();
                      }}
                    />
                    <button
                      type="button"
                      className="button primary"
                      disabled={profileBusy !== null || !renameValue.trim()}
                      onClick={() => void renamePersonalWorkspace()}
                    >
                      {profileBusy === "rename" ? "改名中…" : "改名"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </section>

        <section className="settings-account-column" aria-label="个人账户">
          <div className="settings-identity">
            {avatarSrc
              ? <img className="settings-identity__avatar" src={avatarSrc} alt="头像" />
              : (
                <span className="settings-identity__seal" aria-hidden="true">
                  {(session?.user?.displayName ?? session?.user?.email ?? "我").slice(0, 1).toUpperCase()}
                </span>
              )}
            <div>
              <b>{session?.user?.displayName ?? session?.user?.email ?? "已登录"}</b>
              <small>{session?.user?.displayName ? session.user.email : "凭据只加密保存在这台设备上"}</small>
            </div>
          </div>
          {profileFailure ? (
            <SettingsInlineState
              title="个人档案暂时未同步"
              detail={profileFailure}
              tone="error"
              onRetry={() => setAuxiliaryEpoch((value) => value + 1)}
            />
          ) : null}
          <div className="settings-block">
            <div className="settings-block__head">
              <div>
                <b>个人档案</b>
                <p>显示名与头像在所有空间通用；清空显示名则只显示邮箱。</p>
              </div>
            </div>
            <div className="settings-field">
              <label className="settings-field__label" htmlFor="settings-display-name">显示名</label>
              <div className="hud-field">
                <input
                  id="settings-display-name"
                  value={displayName}
                  placeholder="最长 32 字"
                  maxLength={32}
                  disabled={profileBusy !== null}
                  onChange={(event) => setDisplayName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void saveDisplayName();
                  }}
                />
                <button
                  type="button"
                  className="button primary"
                  disabled={profileBusy !== null || displayName.trim() === (profile?.displayName ?? "")}
                  onClick={() => void saveDisplayName()}
                >
                  {profileBusy === "displayName" ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
            <div className="settings-rows">
              <SettingRow title="头像" detail="PNG / JPG / WebP / GIF，最大 2MB；上传后立即生效。">
                <label className="button" data-disabled={profileBusy !== null ? "true" : undefined} aria-disabled={profileBusy !== null}>
                  <ImageUp size={13} aria-hidden="true" />
                  {profileBusy === "avatar" ? "上传中…" : "更换…"}
                  <input
                    className="settings-file-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    disabled={profileBusy !== null}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void uploadAvatar(file);
                    }}
                  />
                </label>
                {profile?.avatarUrl ? (
                  <button type="button" className="button" disabled={profileBusy !== null} onClick={() => void clearAvatar()}>
                    清除
                  </button>
                ) : null}
              </SettingRow>
            </div>
          </div>

          <details className="settings-disclosure">
            <summary>
              <span>
                <b>修改密码</b>
                <small>修改后所有已登录会话都会失效。</small>
              </span>
            </summary>
            <div className="settings-form">
              <div className="settings-field">
                <label className="settings-field__label" htmlFor="settings-password-current">当前密码</label>
                <div className="hud-field">
                  <input id="settings-password-current" type="password" value={passwordForm.current} autoComplete="current-password" disabled={profileBusy !== null} onChange={(event) => setPasswordForm((form) => ({ ...form, current: event.currentTarget.value }))} />
                </div>
              </div>
              <div className="settings-field">
                <label className="settings-field__label" htmlFor="settings-password-next">新密码</label>
                <div className="hud-field">
                  <input id="settings-password-next" type="password" value={passwordForm.next} placeholder="至少 8 位" autoComplete="new-password" disabled={profileBusy !== null} onChange={(event) => setPasswordForm((form) => ({ ...form, next: event.currentTarget.value }))} />
                </div>
              </div>
              <div className="settings-field">
                <label className="settings-field__label" htmlFor="settings-password-confirm">确认新密码</label>
                <div className="hud-field">
                  <input
                    id="settings-password-confirm"
                    type="password"
                    value={passwordForm.confirm}
                    autoComplete="new-password"
                    disabled={profileBusy !== null}
                    onChange={(event) => setPasswordForm((form) => ({ ...form, confirm: event.currentTarget.value }))}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void submitPasswordChange();
                    }}
                  />
                </div>
              </div>
              <button type="button" className="button" disabled={profileBusy !== null || !passwordForm.current || !passwordForm.next} onClick={() => void submitPasswordChange()}>
                <KeyRound size={13} aria-hidden="true" />
                {profileBusy === "password" ? "修改中…" : "修改密码"}
              </button>
            </div>
          </details>
          <details className="settings-disclosure">
            <summary>
              <span>
                <b>退出登录</b>
                <small>换一个人用这台设备，或者到别的设备上继续。</small>
              </span>
            </summary>
            <div className="settings-rows">
              <SettingRow
                title={`退出 ${session?.user?.email ?? "这个账号"}`}
                detail="清掉这台设备上的登录状态，并请学习服务撤销这次登录。学习记录不会因为退出而减少，其他设备上的登录也不受影响。"
              >
                <button
                  type="button"
                  className="button danger"
                  disabled={signingOut}
                  onClick={() => void signOutOfAccount()}
                >
                  <LogOut size={13} aria-hidden="true" />
                  {signingOut ? "正在退出…" : "退出登录"}
                </button>
              </SettingRow>
            </div>
          </details>
        </section>
      </div>
    ),
    footerNote: "空间数据彼此隔离；显示名与头像跨空间通用。",
  });


  /** 成员与邀请：这个空间里的"人"——加入入口，Owner 的邀请与成员名册。 */
  const membersPanel = (): SettingsPanel => ({
    title: "成员与邀请",
    body: (
      <>
        <div className="settings-block">
          <div className="settings-block__head">
            <div>
              <b>用邀请码加入协作空间</b>
              <p>邀请码由空间所有者发出，加入后立刻出现在「账户与空间」的空间列表里。</p>
            </div>
          </div>
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="settings-invite-code">协作空间邀请码</label>
            <div className="hud-field">
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
                {joining ? "加入中…" : "加入"}
              </button>
            </div>
          </div>
        </div>

        {/* Owner 专属：创建邀请、邀请记录、成员管理。写入由服务端 requireOwner 收口。
            三个 settings-group 用与「数据与维护」一致的小标题节奏，不再用 block 堆叠。
            Member 侧不是整块消失，而是留一个说清边界的锁定块：看不见不等于知道
            自己不能做，审查里「只读没有常驻表达」正是从这里来的。
            「谁能改政策」不在这一页说：它已经归到「AI 数据同意」的账号级设置里。 */}
        {isOwner ? (
          <>
            <section className="settings-group">
              <h3 className="settings-group__title">发出邀请</h3>
              <div className="settings-rows">
                <SettingRow
                  title="角色"
                  detail={inviteRole === "owner" ? "所有者：完整读写，可管理成员与邀请" : "成员：只读访问 + 验证/复习"}
                >
                  <HudSegmented
                    label="邀请角色"
                    value={inviteRole}
                    options={[["member", "成员"], ["owner", "所有者"]] as const}
                    compact
                    onChange={(next) => setInviteRole(next)}
                  />
                </SettingRow>
                <SettingRow title="有效期" detail={inviteExpiryLabel(inviteExpiry)}>
                  <HudPicker
                    label="邀请有效期"
                    value={inviteExpiry}
                    options={INVITE_EXPIRY_OPTIONS}
                    onChange={setInviteExpiry}
                  />
                </SettingRow>
                <SettingRow title="生成邀请" detail="邀请码只在生成后显示一次，请立即复制保存。">
                  <button type="button" className="button primary" disabled={ownerBusy !== null} onClick={() => void createInvite()}>
                    <UserPlus size={13} aria-hidden="true" />
                    {ownerBusy === "create" ? "生成中…" : "生成邀请"}
                  </button>
                </SettingRow>
              </div>
              {createdInvite ? (
                <div className="settings-invite-receipt" role="status">
                  <span>
                    <b>邀请码（只显示这一次）</b>
                    <small>{`${createdInvite.tokenHint} · ${createdInvite.role === "owner" ? "所有者" : "成员"}${createdInvite.expiresAt ? ` · ${dayLabel(createdInvite.expiresAt)} 前有效` : " · 长期有效"}`}</small>
                  </span>
                  <code>{createdInvite.token}</code>
                  <button type="button" className="button primary" onClick={() => void copyInviteToken(createdInvite.token)}>
                    {copiedCode ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                    {copiedCode ? "已复制" : "复制"}
                  </button>
                </div>
              ) : null}
            </section>

            <section className="settings-group">
              <h3 className="settings-group__title">邀请记录</h3>
              <div className="settings-rows">
                {invitesFailure ? (
                  <SettingRow title="邀请记录暂时不可用" detail={invitesFailure}>
                    <button type="button" className="button" onClick={() => setAuxiliaryEpoch((value) => value + 1)}>重试</button>
                  </SettingRow>
                ) : !invitesRead ? (
                  <SettingRow title="正在读取邀请记录" detail="稍候，这不会阻塞其他设置。" />
                ) : (invites?.items.length ?? 0) === 0 ? (
                  <SettingRow title="暂无邀请记录" detail="在上方生成第一个邀请码。" />
                ) : invites?.items.map((invite) => (
                  <SettingRow
                    key={invite.id}
                    title={`${invite.tokenHint} · ${invite.role === "owner" ? "所有者" : "成员"}`}
                    detail={`创建 ${dayLabel(invite.createdAt)} · ${invite.expiresAt ? `过期 ${dayLabel(invite.expiresAt)}` : "长期有效"}${invite.consumedByEmail ? ` · 使用人 ${invite.consumedByEmail}` : ""}`}
                  >
                    <span className={invite.status === "active" ? "tag green" : "tag"}>{inviteStatusLabel(invite.status)}</span>
                    {invite.status === "active" ? (
                      <button
                        type="button"
                        className="button danger"
                        aria-label={`撤销邀请 ${invite.tokenHint}`}
                        disabled={ownerBusy !== null}
                        onClick={() => void revokeInvite(invite.id)}
                      >
                        {ownerBusy === invite.id ? "撤销中…" : "撤销"}
                      </button>
                    ) : null}
                  </SettingRow>
                ))}
              </div>
            </section>

            <section className="settings-group">
              <h3 className="settings-group__title">工作区成员</h3>
              <div className="settings-rows">
                {membersFailure ? (
                  <SettingRow title="成员名册暂时不可用" detail={membersFailure}>
                    <button type="button" className="button" onClick={() => setAuxiliaryEpoch((value) => value + 1)}>重试</button>
                  </SettingRow>
                ) : !membersRead ? (
                  <SettingRow title="正在读取成员" detail="稍候，这不会阻塞邀请功能。" />
                ) : (members?.items.length ?? 0) === 0 ? (
                  <SettingRow title="暂无成员" detail="通过邀请码邀请第一位成员。" />
                ) : members?.items.map((member) => (
                  <SettingRow
                    key={member.userId}
                    title={member.email}
                    detail={`${member.role === "owner" ? "所有者" : "成员"} · ${dayLabel(member.joinedAt)} 加入`}
                  >
                    {member.role !== "owner" ? (removeCandidate === member.userId ? (
                      <>
                        <button type="button" className="button danger" aria-label={`移除成员 ${member.email}`} disabled={ownerBusy !== null} onClick={() => void removeMember(member.userId)}>
                          <Trash2 size={12} aria-hidden="true" />
                          确认移除
                        </button>
                        <button type="button" className="button" disabled={ownerBusy !== null} onClick={() => setRemoveCandidate(null)}>取消</button>
                      </>
                    ) : (
                      <button type="button" className="button danger" aria-label={`移除成员 ${member.email}`} disabled={ownerBusy !== null} onClick={() => void removeMember(member.userId)}>
                        <Trash2 size={12} aria-hidden="true" />
                        {ownerBusy === member.userId ? "移除中…" : "移除"}
                      </button>
                    )) : (
                      <span className="tag green">Owner</span>
                    )}
                  </SettingRow>
                ))}
              </div>
            </section>
          </>
        ) : (
          <section className="settings-group">
            <h3 className="settings-group__title">邀请与成员</h3>
            <div className="settings-rows">
              <SettingRow
                title="只有空间所有者能发邀请、看名册、移成员"
                detail="你在这个空间是成员：读得到已共享的资料，也能做复习与验证；采集、写笔记和生成学习卡由所有者发起。名册与邀请要改动，请找所有者。"
              >
                <span className="tag">只读</span>
              </SettingRow>
            </div>
          </section>
        )}
      </>
    ),
    footerNote: isOwner
      ? "邀请与成员管理只对当前空间生效；AI 同意与数据政策在你的账号上，在「AI 数据同意」里改。"
      : "加入协作空间需要空间所有者发出的邀请码；AI 同意与数据政策始终由你本人签署，不看这里的角色。",
  });


  /** A visual choice: the two plates the reader actually stands on. */
  const appearancePanel = (): SettingsPanel => ({
    title: "主题与动效",
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
                    {value === "day" ? "日间场景" : "夜间场景"}
                  </span>
                  {active ? (
                    <span className="settings-theme__check" aria-hidden="true"><Check size={13} strokeWidth={3} /></span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        {/* 两列是两个平行的「本机开关」：动效与目录各占一格，谁也不比谁矮一层。
            引导是一次性的动作，不是可以和它们并排比较的偏好，所以它单独成组
            落在下面，而不是挤在右列里再包一层容器。 */}
        <div className="settings-columns">
          <section className="settings-group">
            <h3 className="settings-group__title">动效与无障碍</h3>
            <div className="settings-rows">
              <SettingRow title="动效等级" detail="场景移动、页面进入与卡片的运动量。">
                <HudSegmented label="动效等级" value={motionMode} options={MOTION_OPTIONS} onChange={setMotionMode} compact />
              </SettingRow>
              <SettingRow title="系统减少动效" detail="由操作系统决定，优先级高于上面的等级。">
                <span className={reducedMotion ? "tag green" : "tag"}>{reducedMotion ? "已开启" : "未开启"}</span>
              </SettingRow>
            </div>
          </section>

          <section className="settings-group">
            <h3 className="settings-group__title">左侧目录</h3>
            <div className="settings-rows">
              <SettingRow title="目录行为" detail="自动模式下进入内容后缩回底部，手动操作始终优先。">
                <HudSegmented label="目录行为" value={directoryMode} options={DIRECTORY_OPTIONS} onChange={changeDirectoryMode} compact />
              </SettingRow>
            </div>
          </section>
        </div>

        <section className="settings-group">
          <h3 className="settings-group__title">首页引导</h3>
          <div className="settings-rows">
            <SettingRow title="重播首次进入引导" detail="回到学习空间并重播入场说明，不改动任何学习记录。">
              <button
                className="button"
                type="button"
                onClick={() => {
                  closeSurface();
                  // 重播引导只有一条路：v2 首页的入场序列。以前这里分叉过，v1 走
                  // openOnboarding()——那个模态随 v1 首页一起删了。
                  replayIntro();
                }}
              >
                <CircleHelp size={13} aria-hidden="true" />
                重播
              </button>
            </SettingRow>
          </div>
        </section>
      </>
    ),
    footerNote: "主题、动效、目录行为与入场引导都只影响这台设备，不写入工作区。",
  });

  /**
   * 一行一个音色：名字与说明直接用官方口径（声线特质、试听语种），不自己形容音质。
   * 「试听」不要求先选中——挑声音本来就是先听再定。
   */
  const voiceRow = (option: TtsVoiceOptionV1, inUse: boolean) => (
    <SettingRow
      key={option.voice}
      title={option.name}
      detail={option.note || "官方没有给这一条额外的说明，听上面的试听。"}
      selected={inUse}
    >
      <span className="settings-voice__actions">
        {inUse ? <span className="tag green">在用</span> : null}
        {inUse ? null : (
          <button
            type="button"
            className="button ghost"
            disabled={voiceSaving}
            onClick={() => void changeVoice(option.engine, option.voice)}
          >
            用这一身
          </button>
        )}
        <button
          type="button"
          className="button"
          onClick={() => previewVoice(option)}
        >
          试听
        </button>
      </span>
    </SettingRow>
  );

  /** A control block, then what the companion is currently allowed to do. */
  const companionPanel = (): SettingsPanel => ({
    title: "语音与伴星",
    body: (
      <>
        {/* 两个并排的控制块：块头一律「标题 + 说明（+ 自己的开关）」，和账户
            卡里的个人档案/修改密码块同一副骨架，不再各挂一枚装饰图标。 */}
        <div className="settings-columns">
          <div className="settings-block">
            <div className="settings-block__head">
              <div>
                <b>伴星大小</b>
                <p>只影响伴星在场景与页面里的显示比例，位置由你自己拖动决定。</p>
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
              <div>
                <b>声音</b>
                <p>总静音会同时关闭环境音与伴星语音，只影响这台设备。</p>
              </div>
              <HudSwitch checked={!masterMuted} onChange={(next) => setMasterMuted(!next)} label="伴星与环境音" />
            </div>
          </div>
        </div>

        {capabilityFailure ? (
          <SettingsInlineState
            title="伴星能力状态暂时不可用"
            detail={capabilityFailure}
            tone="error"
            onRetry={() => void load()}
          />
        ) : null}

        <section className="settings-group">
          <h3 className="settings-group__title">作答方式</h3>
          <div className="settings-rows">
            {/* 读到之前不画选项：把「跟随安排」画成已选，就是把一个服务端从没
                回答过的值当成答案给读者看。 */}
            <SettingRow
              title="默认作答方式"
              detail={answerMode
                ? "账号级偏好，跨设备一致；「跟随安排」由系统按当时情况编排。"
                : "正在读取这个账号的作答偏好。"}
            >
              {answerMode ? (
                <HudSegmented
                  label="默认作答方式"
                  value={answerMode.preference}
                  options={ANSWER_MODE_OPTIONS}
                  compact
                  disabled={answerModeSaving}
                  onChange={(next) => void changeAnswerMode(next)}
                />
              ) : (
                <span className="tag">{answerModeRead ? "未读到" : "读取中…"}</span>
              )}
            </SettingRow>
          </div>
        </section>

        <section className="settings-group">
          <h3 className="settings-group__title">声音</h3>
          <div className="settings-rows">
            <SettingRow
              title="用哪套声音合成"
              detail={voicePreference
                ? "换的是她说话用的合成引擎；跟着账号走，换设备也在。"
                : "正在读取这个账号的声音设置。"}
            >
              {voicePreference ? (
                <HudSegmented
                  label="合成引擎"
                  value={voicePreference.engine}
                  options={TTS_ENGINE_OPTIONS}
                  compact
                  disabled={voiceSaving}
                  onChange={(next) => void changeVoice(next, ttsDefaultVoiceFor(next))}
                />
              ) : (
                <span className="tag">{voicePreferenceRead ? "未读到" : "读取中…"}</span>
              )}
            </SettingRow>

            {/* 只画当前引擎下的那一份名单：两套引擎的音色名不通用，混在一张列表里
                会让人以为"龙安灵希"和"晓晓"是可以互换了再听的同一批。 */}
            {voicePreference
              ? (voicePreference.engine === "qwen" ? QWEN_TTS_VOICE_OPTIONS : EDGE_TTS_VOICE_OPTIONS).map(
                  (option) => voiceRow(option, voicePreference.voice === option.voice),
                )
              : null}
          </div>

          {/* 一个播放器反复换源，而不是每条一个 audio：试听多了会留下一排进度各异的控件。
              控件全部自己画：原生 controls 是浏览器的灰色条，和这套纸面没有关系，
              而且没试听过的时候它显示 0:00 / 0:00，看起来像坏了。 */}
          <div className="settings-voice__player" data-empty={voicePlayer ? undefined : "true"}>
            <button
              type="button"
              className="settings-voice__toggle"
              disabled={!voicePlayer}
              aria-label={voicePlayer?.playing ? "暂停试听" : "播放试听"}
              onClick={toggleVoicePlayer}
            >
              {voicePlayer?.playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
            </button>
            <span className="settings-voice__reading">
              <b>{voicePlayer ? `正在试听：${voicePlayer.name}` : "还没有试听过"}</b>
              <small>{voicePlayer ? TTS_PREVIEW_TEXT : "点某一行的「试听」，她会用同一句话念给你听：" + TTS_PREVIEW_TEXT}</small>
            </span>
            <span className="settings-voice__track" aria-hidden="true">
              <i style={{ transform: `scaleX(${voicePlayer && voicePlayer.total > 0 ? voicePlayer.at / voicePlayer.total : 0})` }} />
            </span>
            <span className="settings-voice__time">
              {voicePlayer
                ? `${formatVoiceTime(voicePlayer.at)} / ${formatVoiceTime(voicePlayer.total)}`
                : "尚未开始"}
            </span>
          </div>
          <audio ref={voiceAudioRef} className="settings-voice__source" preload="none" />
          {voicePreviewError ? (
            <SettingsInlineState title="这一段没试听成" detail={voicePreviewError} tone="error" />
          ) : null}
        </section>

        <section className="settings-group">
          <h3 className="settings-group__title">伴星能力</h3>
          <div className="settings-rows settings-rows--split">
            {/* 伴星形态的切换入口在伴星快捷设置（「更多功能」→ 伴星设置），2026-09-20 用户裁决；
                这里只保留本机加载状态。 */}
            <SettingRow mark={<Sparkles size={15} />} title="模型状态" detail="当前形态的模型在本机的加载状态。">
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
            </SettingRow>
            <SettingRow mark={<MessageCircle size={15} />} title="实时对话" detail="完整对话是否写入由系统开关决定。">
              <CapabilityChip value={companion?.["companion.sendMessage"]} reason={actionReason(companion?.["companion.sendMessage"])} />
            </SettingRow>
            <SettingRow mark={<MessagesSquare size={15} />} title="对话能力" detail="伴星对话链路的启用状态。">
              <CapabilityChip
                kind="feature"
                value={features?.companion_dialogue_v1.state}
                reason={featureReason(features?.companion_dialogue_v1.state, features?.companion_dialogue_v1.reason)}
              />
            </SettingRow>
            <SettingRow mark={<Mic size={15} />} title="本机语音识别" detail="不可用时自动回落到文字输入。">
              <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.asr} reason={nativeReason(capabilities?.nativeCapabilities.asr)} />
            </SettingRow>
            <SettingRow mark={<AudioLines size={15} />} title="语音对话" detail="语音能力由系统开关决定。">
              <CapabilityChip
                kind="feature"
                value={features?.companion_voice_dialogue_v1.state}
                reason={featureReason(features?.companion_voice_dialogue_v1.state, features?.companion_voice_dialogue_v1.reason)}
              />
            </SettingRow>
          </div>
        </section>
      </>
    ),
    footerNote: "伴星的能力全部来自服务器返回的开关状态；形态选择只保存在这台设备上。",
  });

  /** Consent drawn as the path the data takes, then the policy your own account signs. */
  const dataPanel = (): SettingsPanel => {
    const policy = aiSettings?.dataPolicy ?? null;
    const signed = Boolean(aiSettings?.consentVersion);
    const busy = aiSaving !== null;
    if (aiSettingsFailure) {
      return {
        title: "AI 数据同意",
        body: (
          <SettingsInlineState
            title="没能读到你的 AI 数据设置"
            detail={`${aiSettingsFailure} 这一页不用默认值猜一个状态给你看，重试即可。`}
            tone="error"
            onRetry={() => void load()}
          />
        ),
        footerNote: "政策状态读取成功后，才会开放签署与修改入口。",
      };
    }
    return {
      title: "AI 数据同意",
      body: (
        <>
          {capabilityFailure ? (
            <SettingsInlineState
              title="授权能力状态暂时不可用"
              detail={capabilityFailure}
              tone="error"
              onRetry={() => void load()}
            />
          ) : null}
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
                <small>由你本人签署</small>
              </div>
            </div>
          </section>

          <section
            ref={consentGroupRef}
            className={`settings-group${consentAttention ? " settings-group--attention" : ""}`}
            data-attention={consentAttention ? SETTINGS_ATTENTION_AI_CONSENT : undefined}
          >
            <h3 className="settings-group__title">签署状态</h3>
            <div className="settings-rows">
              <SettingRow
                title="AI 使用同意"
                detail={!aiSettings
                  ? "还没有读到你的同意状态。"
                  : signed
                    ? `已签署（版本 ${aiSettings.consentVersion}）${aiSettings.consentAt ? ` · ${aiSettings.consentAt.slice(0, 10)}` : ""}`
                    : aiSettings.requiresConsent
                      ? "这里配了外部模型服务，没签署前你的内容不会离开这台设备。"
                      : "现在只用本机模型跑，不需要签署。"}
              >
                {signed
                  ? <span className="tag green">已签署</span>
                  : <span className="tag">{aiSettings?.requiresConsent ? "需要签署" : "未签署"}</span>}
              </SettingRow>
              {!signed ? (
                <SettingRow
                  title="签署同意"
                  detail={`用你的账号签署当前版本（${AI_CONSENT_VERSION}），签署后内容才允许离开本机。签署只对你自己生效，换到别人的空间也要重新签署。`}
                >
                  <button type="button" className="button primary" disabled={busy} onClick={() => void signConsent()}>
                    {aiSaving === "consent" ? "签署中…" : "签署"}
                  </button>
                </SettingRow>
              ) : null}
            </div>
          </section>

          <section className="settings-group">
            <h3 className="settings-group__title">数据外发策略</h3>
            <p className="settings-group__note">跟着你的账号走，不跟空间走：在这个部署里签一次、调一次，去哪个空间都沿用同一份设置。</p>
            <div className="settings-rows">
              {DATA_POLICY_FIELDS.map(([field, title, detail]) => (
                <SettingRow key={field} title={title} detail={detail}>
                  {aiSaving === field ? <span className="tag">保存中…</span> : null}
                  <HudSwitch
                    checked={policy?.[field] ?? false}
                    disabled={!policy || busy}
                    onChange={(next) => void saveDataPolicy({ [field]: next }, field)}
                    label={title}
                  />
                </SettingRow>
              ))}
            </div>
          </section>

          <section className="settings-group">
            <h3 className="settings-group__title">伴星授权</h3>
            <p className="settings-group__note">由上面的同意与数据策略推导，这一组不能单独修改。</p>
            <div className="settings-rows settings-rows--split">
              <SettingRow mark={<BookOpen size={15} />} title="伴星读取工作区内容" detail="决定伴星能看到哪些来源、笔记与目标。">
                <CapabilityChip value={companion?.["companion.read"]} reason={actionReason(companion?.["companion.read"])} />
              </SettingRow>
              <SettingRow mark={<MessageCircle size={15} />} title="向伴星发送消息" detail="消息内容可能离开这台电脑，交给服务器处理。">
                <CapabilityChip value={companion?.["companion.sendMessage"]} reason={actionReason(companion?.["companion.sendMessage"])} />
              </SettingRow>
              <SettingRow mark={<ClipboardCheck size={15} />} title="确认伴星的提议" detail="提议写入笔记或目标前始终需要你确认。">
                <CapabilityChip value={companion?.["companion.decideProposal"]} reason={actionReason(companion?.["companion.decideProposal"])} />
              </SettingRow>
              <SettingRow mark={<KeyRound size={15} />} title="代你改空间设置" detail="空间级的设置只有所有者能改；上面那份同意与策略始终归你自己。">
                <CapabilityChip value={companion?.["settings.update"]} reason={actionReason(companion?.["settings.update"])} />
              </SettingRow>
            </div>
          </section>

          <p className="settings-notice-paper">
            本产品没有用户级模型或供应商选择，也没有 BYOK 配置；AI 同意与数据策略是
            账号级设置，由你在上面这几行签署和调整，不随空间转移。
          </p>
        </>
      ),
      footerNote: "改动会立刻存到服务器，这一页的能力状态同时刷新。",
    };
  };

  /** An inventory of what the workspace holds, then where lifecycle actions live. */
  const managementPanel = (): SettingsPanel => ({
    title: "数据与维护",
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
          {inventoryFailure ? (
            <SettingsInlineState
              title="空间内容数量暂时不可用"
              detail={inventoryFailure}
              tone="error"
              onRetry={() => setInventoryEpoch((value) => value + 1)}
            />
          ) : null}
        </section>

        <div className="settings-columns">
          <section className="settings-group">
            <h3 className="settings-group__title">归属</h3>
            <div className="settings-rows">
              <SettingRow
                title="当前工作区"
                detail={`${spaceTypeLabel(currentWorkspace?.workspaceType)} · 你的身份是 ${currentRole === "owner" ? "Owner" : "Member"}`}
              >
                <span className="write-line">{currentWorkspace?.name ?? "未选择"}</span>
              </SettingRow>
              <SettingRow title="可见空间" detail="这些空间的数据彼此隔离，不会互相索引。">
                <span className="write-line">{`${workspaces.length} 个`}</span>
              </SettingRow>
            </div>
          </section>

          <section className="settings-group">
            <h3 className="settings-group__title">生命周期</h3>
            <div className="settings-rows">
              <SettingRow
                title="导出工作区"
                detail={currentRole === "owner"
                  ? "把当前空间的来源、笔记、理解目标与版本写成一个 JSON 文件；保存位置由你在系统对话框里选择。"
                  : "整库导出只对空间所有者开放，你在这个空间是成员。"}
              >
                <button
                  type="button"
                  className="button"
                  disabled={exporting || currentRole !== "owner"}
                  onClick={() => void exportWorkspace()}
                >
                  {exporting ? "导出中…" : "导出…"}
                </button>
              </SettingRow>
              <SettingRow
                title="导入 Markdown 笔记"
                detail={currentRole === "owner"
                  ? "一次最多 100 个 .md 文件，文件名作标题；相同批次重试不会产生重复笔记。导进来的文件属于这个空间——协作空间里所有成员和他们的伴星都会读到。"
                  : "批量导入只对空间所有者开放，你在这个空间是成员。"}
              >
                <label
                  className="button"
                  data-disabled={importBusy || currentRole !== "owner" ? "true" : undefined}
                  aria-disabled={importBusy || currentRole !== "owner"}
                >
                  <FileUp size={13} aria-hidden="true" />
                  {importBusy ? "导入中…" : "选择文件…"}
                  <input
                    className="settings-file-input"
                    type="file"
                    accept=".md,.markdown,text/markdown"
                    multiple
                    disabled={importBusy || currentRole !== "owner"}
                    onChange={(event) => {
                      const files = event.currentTarget.files;
                      void importMarkdownFiles(files);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </SettingRow>
              <SettingRow title="删除来源与笔记" detail="删除是逐条的危险操作，入口在各自的库里，这一页只统计数量。">
                <button
                  type="button"
                  className="button"
                  onClick={() => { closeSurface(); invoke("open-notes"); }}
                >
                  去笔记库
                </button>
              </SettingRow>
            </div>
          </section>
        </div>

        <section className="settings-group">
          <h3 className="settings-group__title">本机接入状态</h3>
          <p className="settings-group__note">只报告这台设备上真实存在的客户端通道，不把“平台理论上支持”写成已实现。</p>
          {capabilityFailure ? (
            <SettingsInlineState title="本机能力状态暂时不可用" detail={capabilityFailure} tone="error" onRetry={() => void load()} />
          ) : (
            <div className="settings-rows settings-rows--split">
              <SettingRow mark={<Clipboard size={15} />} title="剪贴板链接识别" detail="回到学习空间时只识别刚复制的链接；导入前一定先问你。">
                <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.clipboard} reason={nativeReason(capabilities?.nativeCapabilities.clipboard)} />
              </SettingRow>
              <SettingRow mark={<Bell size={15} />} title="系统通知" detail="学习提醒通道；未接入时不会伪装成可配置开关。">
                <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.notifications} reason={nativeReason(capabilities?.nativeCapabilities.notifications)} />
              </SettingRow>
              <SettingRow mark={<Download size={15} />} title="自动更新" detail="客户端更新通道；未接入时不会显示虚假的检查按钮。">
                <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.updates} reason={nativeReason(capabilities?.nativeCapabilities.updates)} />
              </SettingRow>
            </div>
          )}
          <p className="settings-group__note settings-group__note--after">“未接入”表示客户端没有这条链路，不是系统权限被拒绝。</p>
        </section>

        {/* 搜索索引维护（F-025 / F-011，Owner）。 */}
        {currentRole === "owner" ? (
          <details className="settings-disclosure">
            <summary>
              <span>
                <b>高级维护</b>
                <small>检测或重建当前空间的搜索索引。</small>
              </span>
            </summary>
            <div className="settings-rows">
              <SettingRow
                title="漂移检测"
                detail={!drift
                  ? "核对业务表与搜索索引是否一致（幽灵 / 缺失 / 过期文档）。"
                  : drift.hasDrift
                    ? `发现漂移：缺失 ${drift.missing}、幽灵 ${drift.ghosts}、内容过期 ${drift.stale}。`
                    : "索引与业务表一致，没有漂移。"}
              >
                {drift
                  ? <span className={drift.hasDrift ? "tag" : "tag green"}>{drift.hasDrift ? "有漂移" : "一致"}</span>
                  : null}
                <button type="button" className="button" disabled={ownerBusy !== null} onClick={() => void checkSearchDrift()}>
                  <SearchCheck size={13} aria-hidden="true" />
                  {ownerBusy === "drift" ? "检测中…" : "检测"}
                </button>
              </SettingRow>
              <SettingRow
                title="重建索引"
                detail={!reindexResult
                  ? "清空并重建这个空间的搜索索引；中间任何一步失败都会退回原样。"
                  : `已删除 ${reindexResult.deleted} 条旧文档，重建笔记 ${reindexResult.indexedNotes} / 来源 ${reindexResult.indexedSources} / 目标 ${reindexResult.indexedObjectives}${reindexResult.errors > 0 ? `，${reindexResult.errors} 条失败` : ""}${reindexResult.capped ? "（超出单表行数上限，结果被截断）" : ""}。`}
              >
                <button type="button" className="button" disabled={ownerBusy !== null} onClick={() => void runSearchReindex()}>
                  <RefreshCw size={13} aria-hidden="true" />
                  {ownerBusy === "reindex" ? "重建中…" : "重建"}
                </button>
              </SettingRow>
            </div>
          </details>
        ) : null}
      </>
    ),
    footerNote: "内容数量来自各库列表接口；本机状态来自主进程注册的真实通道。",
  });

  const PANELS: Record<SettingsSectionId, () => SettingsPanel> = {
    account: accountPanel,
    members: membersPanel,
    appearance: appearancePanel,
    companion: companionPanel,
    data: dataPanel,
    management: managementPanel,
  };

  // 切换分区时回到卡片顶部：body 是同一个滚动容器，上一分区留下的滚动
  // 位置会让新分区从中间开始，标题直接被滚过去。scrollTo 在测试环境
  // （jsdom）不存在，用可选调用兜底。
  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: 0 });
  }, [section]);

  const panel = PANELS[section]();

  // The fade says “there is more below”, not merely “this body can scroll”. It
  // therefore follows scroll position and disappears at the end of the paper.
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return undefined;
    const sync = () => setBodyHasMore(element.scrollHeight - element.scrollTop - element.clientHeight > 4);
    sync();
    const resizeObserver = new ResizeObserver(sync);
    const mutationObserver = new MutationObserver(sync);
    resizeObserver.observe(element);
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });
    element.addEventListener("scroll", sync, { passive: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      element.removeEventListener("scroll", sync);
    };
  }, [section, loading, failure]);

  return (
    <HudPage page="settings">
      <section className="settings-hud" data-layout="single">
        <nav className="settings-menu" aria-label="设置分类">
          <h2>设置目录</h2>
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
        </nav>

        {loading ? (
          <article className="settings-card settings-card--state">
            <SurfaceDataState kind="loading" message="正在读取设置" detail="这一页只显示服务器确认过的账户、空间与能力。" />
          </article>
        ) : failure ? (
          <article className="settings-card settings-card--state">
            <SurfaceDataState kind="error" message="设置暂时不可用" detail={failure} onRetry={() => void load()} />
          </article>
        ) : (
          <article className="settings-card preference" aria-labelledby="settings-panel-title">
            <h2 id="settings-panel-title" className="title">{panel.title}</h2>
            <div className="settings-body" ref={bodyRef} data-has-more={bodyHasMore ? "true" : undefined}>
              {panel.body}
            </div>
            {failureNotice
              ? <p id="settings-action-message" className="settings-notice settings-notice--error" role="alert">{failureNotice}</p>
              : notice ? <p id="settings-action-message" className="settings-notice" role="status">{notice}</p> : null}
            {panel.footerNote ? (
              <div className="settings-actions">
                <span className="small">{panel.footerNote}</span>
              </div>
            ) : null}
          </article>
        )}
      </section>
    </HudPage>
  );
}
