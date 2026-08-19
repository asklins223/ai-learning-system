"use client";

import "@/app/styles/settings.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import { api, type SearchDriftResult, type CurrentUser } from "@/lib/api";
import Link from "next/link";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import { PageHeader } from "@/components/layout/PageHeader";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/icons";
import {
  MarkdownFilePicker,
  useMarkdownFileSelection,
} from "@/components/MarkdownFilePicker";
import { AIPrivacySettings } from "@/components/settings/AIPrivacySettings";
import { InviteMemberSettings } from "@/components/settings/InviteMemberSettings";
import {
  DEFAULT_PET_TTS,
  PET_TTS_RATES,
  PET_TTS_SEGMENT_GAPS,
  PET_TTS_VOICES,
  readPetTtsSettings,
  writePetTtsSettings,
  type PetTtsSettingsV1,
} from "@/features/companion-pet/tts-settings";
import { WorkspaceManagement } from "@/components/settings/WorkspaceManagement";
import { AvatarUploader } from "@/components/account/AvatarUploader";

type SettingsSectionId = "account" | "workspaces" | "invites" | "model" | "pet" | "export" | "import" | "search";
type SettingsIcon = ComponentType<SVGProps<SVGSVGElement>>;
type ReindexResult = {
  deleted: number;
  indexed: { note: number; source: number; card: number; evidence: number };
  errors: number;
};

const ALL_SETTINGS_SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  caption: string;
  group: "账户与空间" | "AI 与学习" | "数据与维护";
  icon: SettingsIcon;
  ownerOnly?: boolean;
}> = [
  { id: "account", label: "个人账户", caption: "身份与个人档案", group: "账户与空间", icon: Icon.User },
  { id: "workspaces", label: "工作区管理", caption: "加入或退出协作空间", group: "账户与空间", icon: Icon.Layers },
  { id: "invites", label: "邀请与成员", caption: "管理协作权限", group: "账户与空间", icon: Icon.User, ownerOnly: true },
  { id: "model", label: "AI 使用与数据", caption: "授权与数据边界", group: "AI 与学习", icon: Icon.Sparkle },
  { id: "pet", label: "桌宠伴星", caption: "桌面 AI 学习伙伴", group: "AI 与学习", icon: Icon.Sparkle },
  { id: "export", label: "数据导出", caption: "保存完整副本", group: "数据与维护", icon: Icon.Download },
  { id: "import", label: "内容导入", caption: "迁移 Markdown", group: "数据与维护", icon: Icon.Inbox },
  { id: "search", label: "搜索维护", caption: "检测与重建索引", group: "数据与维护", icon: Icon.Search },
];

const SETTINGS_GROUPS = ["账户与空间", "AI 与学习", "数据与维护"] as const;

function roleLabel(role: string) {
  switch (role.toLowerCase()) {
    case "owner":
      return "所有者";
    case "admin":
      return "管理员";
    case "member":
      return "成员";
    default:
      return role;
  }
}

function createImportId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `markdown-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function SettingsPanelHeading({
  title,
  description,
  icon: PanelIcon,
}: {
  title: string;
  description: string;
  icon: SettingsIcon;
}) {
  return (
    <header className="settings-panel-heading">
      <span className="settings-panel-icon" aria-hidden="true">
        <PanelIcon />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </header>
  );
}

interface DesktopPetApiShim {
  getPetModeEnabled?: () => Promise<{ ok?: boolean; enabled?: boolean }>;
  setPetModeEnabled?: (enabled: boolean) => Promise<{ ok?: boolean; enabled?: boolean }>;
}

/**
 * 2026-08-12：设置页桌宠开关（Owner 需求——个人中心可开关，新用户默认开）。
 * Electron 桌面应用：读/写 device-local petModeEnabled（main window IPC）；
 * 浏览器环境：desktopAPI 不存在 → 显示降级提示（不冒充桌面能力）。
 */
function PetModeSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktopApi = typeof window !== "undefined"
    ? (window as unknown as { desktopAPI?: DesktopPetApiShim }).desktopAPI
    : undefined;

  useEffect(() => {
    let cancelled = false;
    if (!desktopApi?.getPetModeEnabled) {
      setEnabled(null);
      return;
    }
    void desktopApi.getPetModeEnabled()
      .then((result) => {
        if (!cancelled && typeof result?.enabled === "boolean") setEnabled(result.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(null);
      });
    return () => { cancelled = true; };
  }, [desktopApi]);

  const toggle = (): void => {
    if (!desktopApi?.setPetModeEnabled || enabled === null || busy) return;
    setBusy(true);
    setError(null);
    void desktopApi.setPetModeEnabled(!enabled)
      .then((result) => {
        if (typeof result?.enabled === "boolean") setEnabled(result.enabled);
      })
      .catch(() => setError("切换失败，请重试。"))
      .finally(() => setBusy(false));
  };

  if (enabled === null) {
    return (
      <p className="settings-section-note">
        桌宠模式仅在桌面应用（Electron）中可用——浏览器内不可用。
        请通过桌面应用打开本页面进行设置。
      </p>
    );
  }

  return (
    <div className="settings-ai-control-row" role="group" aria-label="桌宠开关">
      <span className="settings-ai-control-icon" aria-hidden="true"><Icon.Sparkle /></span>
      <span className="settings-ai-control-copy">
        <strong>桌面桌宠</strong>
        <small>
          在桌面上显示 AI 学习伴星角色（点击对话、长按菜单、可拖动、支持语音）。
          新用户默认开启；关闭后角色从桌面消失，学习数据不受影响。
          {error ? <span className="settings-section-error">{error}</span> : null}
        </small>
      </span>
      <label className="settings-switch">
        <input
          type="checkbox"
          checked={enabled}
          onChange={() => toggle()}
          disabled={busy}
          aria-label="桌宠开关"
        />
        <i aria-hidden="true" />
      </label>
    </div>
  );
}

// 任务 14：作答模态偏好（设置 → 伴星，跨设备一致；Owner 决策 4）。
// 偏好落在 account 级 user_learning_preferences（workspace_id IS NULL），
// 跨设备同步；"any" = 未设置（跟随安排，Supervisor 默认编排）。
//
// F#7（🟠1）：以下三个伴星控件由 CompanionSettingsPanel 在宠物面板层
// 拉取一次共享数据（getCompanionOverview + getAnswerModePreference），
// 以 props 接收，消除各自独立 GET 与独立 revision 副本的 CAS 冲突。
function AnswerModePreferenceRow({
  preference,
  busy,
  error,
  onChoose,
}: {
  preference: "voice" | "silent" | "text" | "any";
  busy: boolean;
  error: string | null;
  onChoose: (value: "voice" | "silent" | "text" | "any") => void;
}) {
  const options: Array<{ value: "voice" | "silent" | "text" | "any"; label: string; hint: string }> = [
    { value: "any", label: "跟随安排", hint: "由伴星按当前要点自动选择（默认）" },
    { value: "voice", label: "语音优先", hint: "能语音时优先语音回答" },
    { value: "silent", label: "静音结构优先", hint: "优先排序/修复等不发声的结构作答" },
    { value: "text", label: "文字优先", hint: "始终先用文字回答" },
  ];

  return (
    <div className="settings-ai-control-row" role="group" aria-label="默认作答方式">
      <span className="settings-ai-control-icon" aria-hidden="true"><Icon.Edit /></span>
      <span className="settings-ai-control-copy">
        <strong>默认作答方式</strong>
        <small>
          练习与复习时优先使用的作答方式（语音 / 静音结构 / 文字）。
          此偏好跨设备一致；不影响「换一种方式」临时切换。
          {error ? <span className="settings-section-error">{error}</span> : null}
        </small>
        <span className="settings-radio-group" role="radiogroup" aria-label="默认作答方式">
          {options.map((option) => (
            <label key={option.value} className="settings-radio-option">
              <input
                type="radio"
                name="answer-mode-preference"
                value={option.value}
                checked={preference === option.value}
                onChange={() => onChoose(option.value)}
                disabled={busy}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </span>
            </label>
          ))}
        </span>
      </span>
    </div>
  );
}

// 方案 16 §10.2/§10.3：主动介入强度（账号级跨设备；PATCH /me/companion CAS）。
function InterventionLevelRow({
  level,
  busy,
  error,
  onChoose,
}: {
  level: "quiet" | "moderate" | "active";
  busy: boolean;
  error: string | null;
  onChoose: (value: "quiet" | "moderate" | "active") => void;
}) {
  const options: Array<{ value: "quiet" | "moderate" | "active"; label: string; hint: string }> = [
    { value: "quiet", label: "安静", hint: "不主动提醒（首次邀请与可恢复故障除外）" },
    { value: "moderate", label: "适中", hint: "每天最多 3 条，间隔至少 30 分钟（默认）" },
    { value: "active", label: "积极", hint: "每天最多 6 条，间隔至少 15 分钟" },
  ];

  return (
    <div className="settings-ai-control-row" role="group" aria-label="主动提醒强度">
      <span className="settings-ai-control-icon" aria-hidden="true"><Icon.Bell /></span>
      <span className="settings-ai-control-copy">
        <strong>主动提醒强度</strong>
        <small>
          桌宠在正式作答、输入与勿扰时段内不会打扰；此偏好跨设备一致。
          {error ? <span className="settings-section-error">{error}</span> : null}
        </small>
        <span className="settings-radio-group" role="radiogroup" aria-label="主动提醒强度">
          {options.map((option) => (
            <label key={option.value} className="settings-radio-option">
              <input
                type="radio"
                name="intervention-level"
                value={option.value}
                checked={level === option.value}
                onChange={() => onChoose(option.value)}
                disabled={busy}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </span>
            </label>
          ))}
        </span>
      </span>
    </div>
  );
}

// 方案 16 §10.2/§10.3：静默时段（账号级；时段内抑制全部主动 cue）。
function QuietHoursRow({
  quietHours,
  busy,
  error,
  onSave,
}: {
  quietHours: { startLocal: string; endLocal: string; timezone: string } | null;
  busy: boolean;
  error: string | null;
  onSave: (next: { startLocal: string; endLocal: string; timezone: string } | null) => void;
}) {
  const timezone = useMemo(() => (
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"
  ), []);

  const enabled = quietHours !== null;
  const start = quietHours?.startLocal ?? "22:00";
  const end = quietHours?.endLocal ?? "07:00";

  return (
    <div className="settings-ai-control-row" role="group" aria-label="静默时段">
      <span className="settings-ai-control-icon" aria-hidden="true"><Icon.Moon /></span>
      <span className="settings-ai-control-copy">
        <strong>静默时段</strong>
        <small>
          时段内桌宠不主动提醒（例如夜间）。按你的本地时区（{timezone}）计算。
          {error ? <span className="settings-section-error">{error}</span> : null}
        </small>
        <span className="settings-quiet-hours-controls">
          <label className="settings-switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={() => onSave(enabled ? null : { startLocal: start, endLocal: end, timezone })}
              disabled={busy}
              aria-label="静默时段开关"
            />
            <i aria-hidden="true" />
          </label>
          {enabled ? (
            <span className="settings-quiet-hours-inputs">
              <label>
                <span>开始</span>
                <input
                  type="time"
                  value={start}
                  disabled={busy}
                  onChange={(event) => {
                    if (!quietHours) return;
                    const next = { ...quietHours, startLocal: event.target.value };
                    onSave(next);
                  }}
                />
              </label>
              <label>
                <span>结束</span>
                <input
                  type="time"
                  value={end}
                  disabled={busy}
                  onChange={(event) => {
                    if (!quietHours) return;
                    const next = { ...quietHours, endLocal: event.target.value };
                    onSave(next);
                  }}
                />
              </label>
            </span>
          ) : null}
        </span>
      </span>
    </div>
  );
}

/**
 * F#7（🟠1）：伴星面板数据提升到面板层拉取一次共享。
 *
 * - 并行拉 getCompanionOverview + getAnswerModePreference 仅一次；
 * - 维护单一 revision 来源（账号 CAS），消除 InterventionLevel /
 *   QuietHours 两控件各自独立 revision 副本的后保存者 CAS 冲突；
 * - 子控件为纯呈现（不各自 GET），面板自身始终挂载（父级仅 CSS hidden），
 *   因此再次进入伴星 tab 不会重复发 GET。
 */
function CompanionSettingsPanel() {
  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const [answerModeLoaded, setAnswerModeLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 单一 revision 来源：每次 PATCH 成功用服务端返回的 account.revision 更新。
  const [revision, setRevision] = useState(0);
  const [interventionLevel, setInterventionLevel] = useState<"quiet" | "moderate" | "active">("moderate");
  const [quietHours, setQuietHours] = useState<{ startLocal: string; endLocal: string; timezone: string } | null>(null);
  const [answerMode, setAnswerMode] = useState<"voice" | "silent" | "text" | "any">("any");

  // 各控件局部互动态（busy/error 不共享，避免一个控件的保存阻塞其它）。
  const [answerModeBusy, setAnswerModeBusy] = useState(false);
  const [answerModeError, setAnswerModeError] = useState<string | null>(null);
  const [interventionBusy, setInterventionBusy] = useState(false);
  const [interventionError, setInterventionError] = useState<string | null>(null);
  const [quietBusy, setQuietBusy] = useState(false);
  const [quietError, setQuietError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      api.getCompanionOverview(),
      api.getAnswerModePreference(),
    ]).then(([overviewResult, answerModeResult]) => {
      if (cancelled) return;
      if (overviewResult.status === "fulfilled") {
        const account = overviewResult.value.account;
        setRevision(account.revision);
        setInterventionLevel(account.interventionLevel ?? "moderate");
        setQuietHours(account.quietHours ?? null);
        setOverviewLoaded(true);
      } else {
        setLoadError("暂时无法读取提醒偏好，请稍后重试。");
      }
      if (answerModeResult.status === "fulfilled") {
        setAnswerMode(answerModeResult.value.preference);
        setAnswerModeLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const chooseIntervention = (value: "quiet" | "moderate" | "active"): void => {
    if (interventionBusy) return;
    setInterventionBusy(true);
    setInterventionError(null);
    void api.updateCompanionAccount({ revision, interventionLevel: value })
      .then((account) => {
        setInterventionLevel(account.interventionLevel ?? value);
        setRevision(account.revision);
      })
      .catch(() => setInterventionError("保存失败，请重试。"))
      .finally(() => setInterventionBusy(false));
  };

  const saveQuietHours = (next: { startLocal: string; endLocal: string; timezone: string } | null): void => {
    if (quietBusy) return;
    setQuietBusy(true);
    setQuietError(null);
    void api.updateCompanionAccount({ revision, quietHours: next })
      .then((account) => {
        setQuietHours(account.quietHours ?? null);
        setRevision(account.revision);
      })
      .catch(() => setQuietError("保存失败，请重试。"))
      .finally(() => setQuietBusy(false));
  };

  const chooseAnswerMode = (value: "voice" | "silent" | "text" | "any"): void => {
    if (answerModeBusy) return;
    setAnswerModeBusy(true);
    setAnswerModeError(null);
    void api.setAnswerModePreference(value)
      .then((result) => setAnswerMode(result.preference))
      .catch(() => setAnswerModeError("保存失败，请重试。"))
      .finally(() => setAnswerModeBusy(false));
  };

  return (
    <>
      <AnswerModePreferenceRow
        preference={answerMode}
        busy={answerModeBusy}
        error={answerModeError}
        onChoose={chooseAnswerMode}
      />
      {!answerModeLoaded && !loadError
        ? <p className="settings-section-note">正在读取作答偏好…</p>
        : null}
      <InterventionLevelRow
        level={interventionLevel}
        busy={interventionBusy}
        error={interventionError || loadError}
        onChoose={chooseIntervention}
      />
      {!overviewLoaded && !loadError
        ? <p className="settings-section-note">正在读取主动提醒偏好…</p>
        : null}
      <QuietHoursRow
        quietHours={quietHours}
        busy={quietBusy}
        error={quietError || loadError}
        onSave={saveQuietHours}
      />
    </>
  );
}

/** 桌宠记忆管理入口（设置 → 桌宠伴星 → 记忆管理）。
 *  只展示数量摘要 + 跳转完整管理页，不在设置页重复实现列表/确认/删除，
 *  避免与 /companion/memory 双份状态源。 */
function MemoryManagementCard() {
  const [summary, setSummary] = useState<{ active: number; candidates: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.listCompanionMemories(true)
      .then((result) => {
        if (cancelled) return;
        const items = (result.items as Array<{ candidate?: boolean }>) ?? [];
        setSummary({
          active: items.filter((item) => !item.candidate).length,
          candidates: items.filter((item) => item.candidate).length,
        });
      })
      .catch(() => {
        if (!cancelled) setError("暂时无法读取记忆");
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="settings-operation-card">
      <div className="settings-operation-mark is-memory" aria-hidden="true"><Icon.Notepad /></div>
      <div className="settings-operation-copy">
        <h3>记忆管理</h3>
        <p>
          桌宠会记住你明确表达的目标、偏好与学习情境；候选记忆需要你确认后才会被使用。
          删除记忆不会影响任何已提交的学习事实与复习安排。
        </p>
        {summary ? (
          <div className="settings-operation-tags" aria-label="记忆数量">
            <span>{summary.active} 条活跃记忆</span>
            {summary.candidates > 0 ? <span>{summary.candidates} 条待确认</span> : null}
          </div>
        ) : error ? (
          <small className="settings-section-error">{error}</small>
        ) : (
          <small>正在读取记忆…</small>
        )}
      </div>
      <Link className="settings-primary-button" href="/companion/memory">
        <Icon.Notepad aria-hidden="true" />
        管理记忆
      </Link>
    </div>
  );
}

// 2026-08-12：伴星语音偏好（设置 → 伴星 → 伴星语音）。
// 音色/语速/段落停顿，设备级（localStorage 跨窗口共享：settings 写入、
// 桌宠窗口读取并作用于 TTS 请求与段间播放）。
function TtsVoiceSettings() {
  const [settings, setSettings] = useState<PetTtsSettingsV1>(DEFAULT_PET_TTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setSettings(readPetTtsSettings());
    setLoaded(true);
  }, []);

  const update = (patch: Partial<PetTtsSettingsV1>): void => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      writePetTtsSettings(next);
      return next;
    });
  };

  if (!loaded) {
    return <p className="settings-section-note">正在读取伴星语音设置…</p>;
  }

  return (
    <div className="settings-ai-control-row" role="group" aria-label="伴星语音">
      <span className="settings-ai-control-icon" aria-hidden="true"><Icon.Play /></span>
      <span className="settings-ai-control-copy">
        <strong>伴星语音</strong>
        <small>
          语音播报的音色、语速与段落停顿。此偏好保存在本机，即时生效。
        </small>

        <span className="settings-tts-field">
          <label htmlFor="pet-tts-voice">音色</label>
          <select
            id="pet-tts-voice"
            className="settings-tts-select"
            value={settings.voice}
            onChange={(event) => update({ voice: event.target.value })}
          >
            {PET_TTS_VOICES.map((voice) => (
              <option key={voice.value} value={voice.value}>
                {voice.label} · {voice.hint}
              </option>
            ))}
          </select>
        </span>

        <span className="settings-radio-group" role="radiogroup" aria-label="语速">
          {PET_TTS_RATES.map((rate) => (
            <label key={rate.value} className="settings-radio-option">
              <input
                type="radio"
                name="pet-tts-rate"
                value={rate.value}
                checked={settings.rate === rate.value}
                onChange={() => update({ rate: rate.value })}
              />
              <span>
                <strong>{rate.label}</strong>
                <small>{rate.hint}</small>
              </span>
            </label>
          ))}
        </span>

        <span className="settings-radio-group" role="radiogroup" aria-label="段落间隔">
          {PET_TTS_SEGMENT_GAPS.map((gap) => (
            <label key={gap.value} className="settings-radio-option">
              <input
                type="radio"
                name="pet-tts-gap"
                value={gap.value}
                checked={settings.segmentGapMs === gap.value}
                onChange={() => update({ segmentGapMs: gap.value })}
              />
              <span>
                <strong>{gap.label}</strong>
                <small>{gap.hint}</small>
              </span>
            </label>
          ))}
        </span>
      </span>
    </div>
  );
}

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("account");
  // P5（文档 16 §14.6）：设置页发布 bounded context（凭据/隐私面敏感）。
  // 第八轮 🟡B-1：useMemo 稳定引用。
  useMainPageContext(useMemo(() => ({
    routeRef: { kind: "settings" },
    pageKind: "settings",
    entityRefs: [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "credential_surface",
  }), []));
  const navRef = useRef<HTMLElement>(null);
  // F#8（round3）：unmount 守卫——异步 handler（loadAccount/handleSaveProfile/
  // handleAvatarUploaded/checkDrift/handleReindex/handleExportWorkspace/handleImport）
  // 在 await 后 setState，卸载后需跳过，避免 setState-after-unmount。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [accountLoading, setAccountLoading] = useState(true);
  const [accountData, setAccountData] = useState<CurrentUser | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  // PROFILE-01: 用户档案编辑
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileAvatarUrl, setProfileAvatarUrl] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);

  async function handleSaveProfile() {
    if (profileSaving) return;
    const nextDisplayName = profileDisplayName.trim();
    if (nextDisplayName.length > 32) {
      setProfileError("昵称最多 32 个字符");
      return;
    }
    setProfileSaving(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      await api.updateProfile({
        displayName: nextDisplayName || null,
      });
      if (!mountedRef.current) return;
      setProfileSuccess("档案已更新");
      setProfileEditing(false);
      await loadAccount();
    } catch (error) {
      if (!mountedRef.current) return;
      setProfileError(error instanceof Error ? error.message : "档案更新失败");
    } finally {
      if (mountedRef.current) setProfileSaving(false);
    }
  }

  async function handleAvatarUploaded(url: string) {
    setProfileAvatarUrl(url);
    setProfileSaving(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      await api.updateProfile({ avatarUrl: url });
      if (!mountedRef.current) return;
      setProfileSuccess("头像已更新");
      await loadAccount();
    } catch (error) {
      if (!mountedRef.current) return;
      setProfileError(error instanceof Error ? error.message : "头像更新失败");
    } finally {
      if (mountedRef.current) setProfileSaving(false);
    }
  }

  function handleCancelProfileEdit() {
    setProfileEditing(false);
    setProfileDisplayName(accountData?.displayName ?? "");
    setProfileAvatarUrl(accountData?.avatarUrl ?? "");
    setProfileError(null);
    setProfileSuccess(null);
  }

  const isOwner = accountData?.role.toLowerCase() === "owner";

  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);

  const importFiles = useMarkdownFileSelection();
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importPartial, setImportPartial] = useState(false);
  const [importId, setImportId] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  const [driftResult, setDriftResult] = useState<SearchDriftResult | null>(null);
  const [driftLoading, setDriftLoading] = useState(false);
  const [driftError, setDriftError] = useState<string | null>(null);

  const [reindexLoading, setReindexLoading] = useState(false);
  const [reindexResult, setReindexResult] = useState<ReindexResult | null>(null);
  const [reindexTone, setReindexTone] = useState<"success" | "warning">("success");
  const [reindexError, setReindexError] = useState<string | null>(null);
  const [showReindexConfirm, setShowReindexConfirm] = useState(false);

  const loadAccount = useCallback(async () => {
    setAccountLoading(true);
    setAccountError(null);
    try {
      const data = await api.getMe();
      if (!mountedRef.current) return;
      setAccountData(data);
      setAvatarFailed(false);
      setProfileDisplayName(data.displayName ?? "");
      setProfileAvatarUrl(data.avatarUrl ?? "");
    } catch (error) {
      if (!mountedRef.current) return;
      setAccountError(error instanceof Error ? error.message : "账户信息暂时无法读取");
    } finally {
      if (mountedRef.current) setAccountLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  // 根据角色计算可见的设置分区；accountData 加载完成后才确定 invites 是否可见
  const visibleSections = ALL_SETTINGS_SECTIONS.filter(
    (item) => !item.ownerOnly || isOwner,
  );
  const visibleSectionIds = visibleSections.map((item) => item.id).join(",");

  useEffect(() => {
    const ids = visibleSectionIds.split(",").filter(Boolean);
    const syncFromHash = () => {
      const hash = window.location.hash.slice(1);
      if (ids.includes(hash)) setActiveSection(hash as SettingsSectionId);
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [visibleSectionIds]);

  // 伴星菜单“伴星设置”等入口通过 /settings?section=<id> 直达具体选项卡
  //（桌面主进程 focusMainWindow 与浏览器 fallback 均生成该 query）。
  // 仅首次挂载消费一次，避免与 hash 机制（selectSection 写入）互相覆盖。
  useEffect(() => {
    const ids = visibleSectionIds.split(",").filter(Boolean);
    const params = new URLSearchParams(window.location.search);
    const section = params.get("section");
    if (section && ids.includes(section)) {
      setActiveSection(section as SettingsSectionId);
      params.delete("section");
      const query = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}#${section}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时消费一次
  }, [visibleSectionIds]);

  useEffect(() => {
    const ids = visibleSectionIds.split(",").filter(Boolean);
    if (!ids.includes(activeSection)) setActiveSection("account");
  }, [activeSection, visibleSectionIds]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const activeItem = nav.querySelector<HTMLElement>(`[data-section="${activeSection}"]`);
    if (!activeItem) return;

    const navRect = nav.getBoundingClientRect();
    const itemRect = activeItem.getBoundingClientRect();
    const safeEdge = 12;
    const isOutside = itemRect.left < navRect.left + safeEdge || itemRect.right > navRect.right - safeEdge;
    if (!isOutside) return;

    let nextLeft = nav.scrollLeft;
    if (itemRect.left < navRect.left + safeEdge) {
      nextLeft -= navRect.left + safeEdge - itemRect.left;
    } else if (itemRect.right > navRect.right - safeEdge) {
      nextLeft += itemRect.right - (navRect.right - safeEdge);
    }

    nav.scrollTo({
      left: nextLeft,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [activeSection]);

  const selectSection = useCallback((section: SettingsSectionId) => {
    setActiveSection(section);
    const nextUrl = `${window.location.pathname}${window.location.search}#${section}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, []);

  const importLimitMessage = importFiles.validationError;

  async function handleExportWorkspace() {
    setExportLoading(true);
    setExportError(null);
    setExportSuccess(null);
    try {
      const blob = await api.exportWorkspace();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `workspace-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Safari may not have consumed the object URL when the click handler returns.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      if (!mountedRef.current) return;
      setExportSuccess("工作区副本已开始下载");
    } catch (error) {
      if (!mountedRef.current) return;
      setExportError(error instanceof Error ? error.message : "工作区导出失败");
    } finally {
      if (mountedRef.current) setExportLoading(false);
    }
  }

  async function handleImport() {
    if (importFiles.items.length === 0 || importLimitMessage || importFiles.reading) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    setImportPartial(false);
    try {
      const requestId = importId || createImportId();
      if (!importId) setImportId(requestId);
      const result = await api.importMarkdown(importFiles.items, requestId);
      if (!mountedRef.current) return;
      const failed = result.errors?.length ?? 0;
      if (failed > 0) {
        const failedKeys = result.errors!
          .map((item) => importFiles.validFiles[item.index]?.key)
          .filter((key): key is string => Boolean(key));
        // 后端若返回了无法映射的异常索引，保留当前选择，避免把待重试文件误清空。
        if (failedKeys.length > 0) importFiles.retainFiles(failedKeys);
        setImportPartial(true);
        setImportResult(`导入完成：成功 ${result.imported} 篇，失败 ${failed} 篇`);
        setImportError(
          result.errors!
            .map((item) => {
              const filename = importFiles.validFiles[item.index]?.name;
              return `${filename || item.title || `第 ${item.index + 1} 个文件`}：${item.error}`;
            })
            .join("\n"),
        );
      } else {
        setImportResult(
          result.idempotent
            ? `批次导入完成，共 ${result.imported} 篇；已自动跳过此前成功的内容`
            : `已成功导入 ${result.imported} 篇笔记`,
        );
        importFiles.clearFiles();
        setImportId(createImportId());
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setImportError(error instanceof Error ? error.message : "Markdown 导入失败");
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  }

  const checkDrift = useCallback(async () => {
    setDriftLoading(true);
    setDriftError(null);
    setReindexResult(null);
    try {
      const result = await api.detectSearchDrift();
      if (!mountedRef.current) return;
      setDriftResult(result);
    } catch (error) {
      if (!mountedRef.current) return;
      setDriftError(error instanceof Error ? error.message : "索引检测失败");
      setDriftResult(null);
    } finally {
      if (mountedRef.current) setDriftLoading(false);
    }
  }, []);

  const handleReindex = useCallback(async () => {
    setShowReindexConfirm(false);
    setReindexLoading(true);
    setReindexError(null);
    setReindexResult(null);
    try {
      const result = await api.reindexSearch();
      if (!mountedRef.current) return;
      setReindexResult(result);
      setReindexTone(result.errors > 0 ? "warning" : "success");
      setDriftResult(null);
    } catch (error) {
      if (!mountedRef.current) return;
      setReindexError(error instanceof Error ? error.message : "索引重建失败");
    } finally {
      if (mountedRef.current) setReindexLoading(false);
    }
  }, []);

  const isKnownNonOwner = Boolean(accountData && !isOwner);
  const ownerActionDisabled = accountLoading || !isOwner;

  return (
    <div className="settings-page">
      <PageHeader
        className="workspace-page-header"
        title="设置"
        kicker="账户与数据"
        subtitle="在一个地方管理个人资料、工作区、AI 使用授权和数据工具。"
        actions={<ThemeToggle className="settings-theme-toggle" />}
      />

      <div className="settings-content">
        <label className="settings-mobile-section-picker">
          <span>当前设置分区</span>
          <select
            value={activeSection}
            onChange={(event) => selectSection(event.target.value as SettingsSectionId)}
          >
            {SETTINGS_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {visibleSections
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="settings-layout">
          <aside className="settings-rail" aria-label="设置目录">
            <nav ref={navRef} className="settings-nav" role="tablist" aria-label="设置分区">
              {visibleSections.map((item, index) => {
                const NavIcon = item.icon;
                return (
                  <button
                    key={item.id}
                    id={`settings-tab-${item.id}`}
                    type="button"
                    role="tab"
                    data-section={item.id}
                    className={`settings-nav-item${activeSection === item.id ? " is-active" : ""}`}
                    aria-controls={item.id}
                    aria-selected={activeSection === item.id}
                    tabIndex={activeSection === item.id ? 0 : -1}
                    onClick={() => selectSection(item.id)}
                    onKeyDown={(event) => {
                      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                      event.preventDefault();
                      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
                      const targetIndex = event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? visibleSections.length - 1
                          : (index + delta + visibleSections.length) % visibleSections.length;
                      const target = visibleSections[targetIndex];
                      selectSection(target.id);
                      window.requestAnimationFrame(() => {
                        navRef.current
                          ?.querySelector<HTMLElement>(`[data-section="${target.id}"]`)
                          ?.focus();
                      });
                    }}
                  >
                    <span className="settings-nav-icon" aria-hidden="true"><NavIcon /></span>
                    <span className="settings-nav-copy">
                      <strong>{item.label}</strong>
                      <small>{item.caption}</small>
                    </span>
                    <Icon.Chevron aria-hidden="true" />
                  </button>
                );
              })}
            </nav>
            <div className="settings-rail-note">
              <Icon.Lock aria-hidden="true" />
              <p><strong>数据边界清晰</strong><span>导出与维护操作不会修改笔记正文。</span></p>
            </div>
          </aside>

          <div className="settings-panels">
            <section
              id="account"
              className="settings-panel"
              role="tabpanel"
              aria-labelledby="settings-tab-account"
              hidden={activeSection !== "account"}
            >
              <SettingsPanelHeading
                title="当前账户"
                description="确认正在操作的身份与工作区，避免在错误空间中维护数据。"
                icon={Icon.User}
              />

              <div className="settings-profile-card">
                <div className="settings-profile-hero">
                  <div className="settings-profile-hero-body">
                    <span className="settings-avatar-wrap is-lg">
                      {accountData?.avatarUrl && !avatarFailed ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={accountData.avatarUrl}
                          alt="当前账户头像"
                          width={84}
                          height={84}
                          onError={() => setAvatarFailed(true)}
                        />
                      ) : (
                        <span className="settings-avatar-fallback" aria-label="账户头像">
                          {(() => {
                            const letter = (accountData?.displayName?.trim() || accountData?.email?.trim() || "").charAt(0).toUpperCase();
                            return letter || <Icon.User className="settings-avatar-placeholder-icon" />;
                          })()}
                        </span>
                      )}
                      {accountData && !accountError && <i aria-hidden="true" />}
                    </span>
                    <div className="settings-profile-hero-copy">
                      <span className="settings-profile-label">当前登录</span>
                      {accountLoading ? (
                        <span className="settings-account-skeleton" aria-label="正在读取账户信息" />
                      ) : (
                        <h3>{accountData?.displayName?.trim() || accountData?.email || "账户信息未加载"}</h3>
                      )}
                      <p>{accountData?.email || "正在确认当前账户"}</p>
                      {accountData && !accountLoading && (
                        <span className="settings-profile-role-tag">{roleLabel(accountData.role)}</span>
                      )}
                    </div>
                    <div className="settings-profile-hero-actions">
                      <button
                        type="button"
                        className="settings-icon-button"
                        onClick={() => void loadAccount()}
                        disabled={accountLoading}
                        aria-label="刷新账户信息"
                        title="刷新账户信息"
                      >
                        <Icon.Refresh className={accountLoading ? "settings-spin" : undefined} />
                      </button>
                      {!profileEditing && (
                        <button
                          type="button"
                          className="settings-secondary-button"
                          onClick={() => {
                            setProfileDisplayName(accountData?.displayName ?? "");
                            setProfileAvatarUrl(accountData?.avatarUrl ?? "");
                            setProfileError(null);
                            setProfileSuccess(null);
                            setProfileEditing(true);
                          }}
                          disabled={accountLoading}
                        >
                          <Icon.Edit aria-hidden="true" />
                          编辑档案
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {accountError && (
                  <div className="settings-notice is-danger" role="alert">
                    <Icon.Warn aria-hidden="true" />
                    <span>{accountError}</span>
                    <button type="button" onClick={() => void loadAccount()}>重试</button>
                  </div>
                )}

                {/* PROFILE-01: 编辑时才展开详细表单，避免重复展示同一份账户信息。 */}
                {(profileEditing || profileError || profileSuccess) && (
                <div className="settings-profile-edit">
                  {profileEditing && (
                  <>
                  <div className="settings-profile-edit-heading">
                    <div className="settings-profile-edit-title">
                      <span className="settings-profile-edit-icon" aria-hidden="true"><Icon.User /></span>
                      <div>
                        <strong>个人档案</strong>
                        <small>管理昵称与头像</small>
                      </div>
                    </div>
                  </div>

                  <div className="settings-profile-edit-form">
                      <div className="settings-profile-edit-avatar">
                        <AvatarUploader
                          currentUrl={profileAvatarUrl || null}
                          displayName={accountData?.displayName}
                          email={accountData?.email}
                          onUploaded={(url) => void handleAvatarUploaded(url)}
                          onError={(msg) => setProfileError(msg)}
                          disabled={profileSaving}
                          size={72}
                        />
                      </div>
                      <div className="settings-profile-edit-field">
                        <label htmlFor="profile-display-name" className="settings-field-label-row">
                          <span>昵称</span>
                          <span className="settings-field-counter" aria-live="polite">
                            {profileDisplayName.length}/32
                          </span>
                        </label>
                        <input
                          id="profile-display-name"
                          type="text"
                          value={profileDisplayName}
                          onChange={(e) => setProfileDisplayName(e.target.value)}
                          placeholder="展示在侧栏和工作区名称中"
                          maxLength={32}
                          disabled={profileSaving}
                          autoComplete="nickname"
                        />
                      </div>
                      <div className="settings-profile-edit-actions">
                        <button
                          type="button"
                          className="settings-secondary-button"
                          onClick={handleCancelProfileEdit}
                          disabled={profileSaving}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="settings-primary-button"
                          onClick={() => void handleSaveProfile()}
                          disabled={profileSaving}
                          aria-busy={profileSaving}
                        >
                          {profileSaving ? <Icon.Refresh className="settings-spin" /> : <Icon.Check />}
                          {profileSaving ? "保存中…" : "保存"}
                        </button>
                      </div>
                  </div>
                  </>
                  )}

                  {profileError && (
                    <div className="settings-notice is-danger" role="alert">
                      <Icon.Warn aria-hidden="true" />
                      <span>{profileError}</span>
                    </div>
                  )}
                  {profileSuccess && (
                    <div className="settings-notice is-success" role="status">
                      <Icon.Check aria-hidden="true" />
                      <span>{profileSuccess}</span>
                    </div>
                  )}
                </div>
                )}
              </div>
            </section>

            {isOwner && (
              <section
                id="invites"
                className="settings-panel"
                role="tabpanel"
                aria-labelledby="settings-tab-invites"
                hidden={activeSection !== "invites"}
              >
                {activeSection === "invites" && <>
                <SettingsPanelHeading
                  title="邀请与成员管理"
                  description="创建邀请链接、查看邀请状态、管理工作区成员。邀请链接只显示一次，请及时复制保存。"
                  icon={Icon.User}
                />
                <InviteMemberSettings />
                </>}
              </section>
            )}

            <section
              id="workspaces"
              className="settings-panel"
              role="tabpanel"
              aria-labelledby="settings-tab-workspaces"
              hidden={activeSection !== "workspaces"}
            >
              {activeSection === "workspaces" && <>
              <SettingsPanelHeading
                title="工作区管理"
                description="管理你的个人工作区与协作工作区。可通过邀请码加入他人的协作空间，也可随时退出。"
                icon={Icon.Layers}
              />
              <WorkspaceManagement currentUser={accountData} />
              </>}
            </section>

            <section
              id="model"
              className="settings-panel"
              role="tabpanel"
              aria-labelledby="settings-tab-model"
              hidden={activeSection !== "model"}
            >
              {activeSection === "model" && <>
              <SettingsPanelHeading
                title="AI 使用与数据"
                description="管理工作区的 AI 使用授权、内容外发范围与数据保护策略。"
                icon={Icon.Sparkle}
              />
              <AIPrivacySettings isOwner={isOwner} accountLoading={accountLoading} />
              </>}
            </section>

            <section
              id="pet"
              className="settings-panel"
              role="tabpanel"
              aria-labelledby="settings-tab-pet"
              hidden={activeSection !== "pet"}
            >
              {/* F#7（🟠1）：伴星面板始终挂载（仅 CSS hidden，不 && 卸载）+ 数据
                  在面板层拉一次共享——再次进入 tab 不重复发 GET。 */}
              <SettingsPanelHeading
                title="桌宠伴星"
                description="桌面 AI 学习伴星（角色 + 气泡 + 语音对话）。新用户默认开启，可在桌面角色菜单随时退出。"
                icon={Icon.Sparkle}
              />
              <PetModeSetting />
              <CompanionSettingsPanel />
              <MemoryManagementCard />
              <TtsVoiceSettings />
            </section>

            <section
              id="export"
              className="settings-panel"
              role="tabpanel"
              aria-labelledby="settings-tab-export"
              hidden={activeSection !== "export"}
            >
              <SettingsPanelHeading
                title="导出工作区副本"
                description="把主要学习对象整理为 JSON 文件，便于备份、迁移或自行分析。"
                icon={Icon.Download}
              />
              <div className="settings-operation-card">
                <div className="settings-operation-mark is-export" aria-hidden="true"><Icon.Archive /></div>
                <div className="settings-operation-copy">
                  <h3>完整数据快照</h3>
                  <p>包含笔记、学习卡、证据、验证与理解状态；导出过程不会修改线上数据。</p>
                  <div className="settings-operation-tags" aria-label="导出内容">
                    <span>JSON 格式</span><span>只读副本</span><span>当前工作区</span>
                  </div>
                </div>
                <button
                  className="settings-primary-button"
                  onClick={() => void handleExportWorkspace()}
                  disabled={exportLoading || ownerActionDisabled}
                  title={isKnownNonOwner ? "仅工作区所有者可导出完整副本" : undefined}
                  type="button"
                >
                  {exportLoading ? <Icon.Refresh className="settings-spin" /> : <Icon.Download />}
                  {exportLoading ? "正在整理" : "下载工作区副本"}
                </button>
              </div>
              {isKnownNonOwner && (
                <div className="settings-permission-note"><Icon.Lock />完整工作区导出仅对所有者开放。</div>
              )}
              {exportSuccess && (
                <div className="settings-notice is-success" role="status">
                  <Icon.Check aria-hidden="true" /><span>{exportSuccess}</span>
                </div>
              )}
              {exportError && (
                <div className="settings-notice is-danger" role="alert">
                  <Icon.Warn aria-hidden="true" /><span>{exportError}</span>
                </div>
              )}
            </section>

            <section
              id="import"
              className="settings-panel"
              role="tabpanel"
              aria-labelledby="settings-tab-import"
              hidden={activeSection !== "import"}
            >
              <SettingsPanelHeading
                title="导入 Markdown 文件"
                description="选择或拖入 .md / .markdown 文件；每个文件创建一篇笔记，不再需要粘贴文本。"
                icon={Icon.Inbox}
              />

              <div className="settings-import-desk">
                <div className="settings-import-toolbar">
                  <div>
                    <strong>待导入文件</strong>
                    <span>可拖放或选择多个 Markdown 文件</span>
                  </div>
                  <div className="settings-import-stats" aria-live="polite">
                    <span><strong>{importFiles.summary.files}</strong> 个文件</span>
                    <span><strong>{importFiles.summary.characters.toLocaleString("zh-CN")}</strong> 字符</span>
                    {importFiles.summary.errors > 0 && <span className="is-danger"><strong>{importFiles.summary.errors}</strong> 个异常</span>}
                  </div>
                </div>
                <MarkdownFilePicker
                  id="settings-import-files"
                  selection={importFiles}
                  disabled={importing}
                  className="settings-markdown-file-picker"
                  onSelectionChange={() => {
                    setImportId("");
                    setImportResult(null);
                    setImportError(null);
                    setImportPartial(false);
                  }}
                />
                <div className="settings-import-foot">
                  <p
                    className={importLimitMessage ? "is-invalid" : undefined}
                    role={importLimitMessage ? "alert" : undefined}
                  >
                    <Icon.Warn aria-hidden="true" />
                    {importLimitMessage ?? "单次最多 100 个文件、每个文件最多 500,000 字符；仅支持 UTF-8 Markdown。"}
                  </p>
                  <div>
                    <button
                      className="settings-secondary-button"
                      onClick={() => {
                        importFiles.clearFiles();
                        setImportId(createImportId());
                        setImportResult(null);
                        setImportError(null);
                        setImportPartial(false);
                      }}
                      disabled={importing || importFiles.reading || importFiles.files.length === 0}
                      type="button"
                    >
                      清空文件
                    </button>
                    <button
                      className="settings-primary-button"
                      onClick={() => void handleImport()}
                      disabled={importing || importFiles.reading || importFiles.items.length === 0 || Boolean(importLimitMessage)}
                      aria-busy={importing}
                      type="button"
                    >
                      {importing ? <Icon.Refresh className="settings-spin" /> : <Icon.Inbox />}
                      {importing ? "正在导入" : `确认导入${importFiles.summary.ready > 0 ? ` ${importFiles.summary.ready} 篇` : ""}`}
                    </button>
                  </div>
                </div>
                {importResult && (
                  <div className={`settings-notice ${importPartial ? "is-warning" : "is-success"}`} role="status">
                    {importPartial ? <Icon.Warn aria-hidden="true" /> : <Icon.Check aria-hidden="true" />}<span>{importResult}</span>
                  </div>
                )}
                {importError && (
                  <div className={`settings-notice ${importPartial ? "is-warning" : "is-danger"}`} role="alert">
                    <Icon.Warn aria-hidden="true" />
                    <pre>{importError}</pre>
                  </div>
                )}
              </div>
            </section>

            <section
              id="search"
              className="settings-panel"
              role="tabpanel"
              aria-labelledby="settings-tab-search"
              hidden={activeSection !== "search"}
            >
              <SettingsPanelHeading
                title="搜索索引维护"
                description="检查搜索结果是否与真实学习对象一致，仅在出现缺失或旧内容时重建。"
                icon={Icon.Search}
              />

              <div className="settings-maintenance-grid">
                <article className="settings-maintenance-card">
                  <span className="settings-maintenance-icon" aria-hidden="true"><Icon.Search /></span>
                  <h3>检测索引漂移</h3>
                  <p>对比搜索索引和业务数据，识别幽灵文档、缺失对象及过期内容。</p>
                  <button
                    className="settings-secondary-button"
                    onClick={() => void checkDrift()}
                    disabled={driftLoading || reindexLoading || ownerActionDisabled}
                    title={isKnownNonOwner ? "仅工作区所有者可运行索引检测" : undefined}
                    type="button"
                  >
                    {driftLoading ? <Icon.Refresh className="settings-spin" /> : <Icon.Search />}
                    {driftLoading ? "正在检测" : "运行一致性检测"}
                  </button>
                </article>

                <article className="settings-maintenance-card is-caution">
                  <span className="settings-maintenance-icon" aria-hidden="true"><Icon.Refresh /></span>
                  <h3>重建搜索索引</h3>
                  <p>清理派生索引并从真实学习数据重新生成；不会删除笔记或学习卡。</p>
                  <button
                    className="settings-primary-button"
                    onClick={() => setShowReindexConfirm(true)}
                    disabled={reindexLoading || driftLoading || ownerActionDisabled}
                    title={isKnownNonOwner ? "仅工作区所有者可重建索引" : undefined}
                    type="button"
                  >
                    {reindexLoading ? <Icon.Refresh className="settings-spin" /> : <Icon.Refresh />}
                    {reindexLoading ? "正在重建" : "重建索引"}
                  </button>
                </article>
              </div>

              {isKnownNonOwner && (
                <div className="settings-permission-note"><Icon.Lock />搜索维护工具仅对所有者开放。</div>
              )}

              {driftError && (
                <div className="settings-notice is-danger" role="alert">
                  <Icon.Warn aria-hidden="true" /><span>{driftError}</span>
                </div>
              )}
              {reindexError && (
                <div className="settings-notice is-danger" role="alert">
                  <Icon.Warn aria-hidden="true" /><span>{reindexError}</span>
                </div>
              )}
              {reindexResult && (
                <div className={`settings-notice is-${reindexTone}`} role="status">
                  {reindexTone === "warning" ? <Icon.Warn aria-hidden="true" /> : <Icon.Check aria-hidden="true" />}
                  <div className="settings-reindex-result">
                    <strong>
                      {reindexResult.errors > 0
                        ? `重建完成，但有 ${reindexResult.errors} 条对象未能写入`
                        : `索引已重建，并清理 ${reindexResult.deleted} 条旧索引`}
                    </strong>
                    <dl>
                      <div><dt>笔记</dt><dd>{reindexResult.indexed.note}</dd></div>
                      <div><dt>来源</dt><dd>{reindexResult.indexed.source}</dd></div>
                      <div><dt>学习卡</dt><dd>{reindexResult.indexed.card}</dd></div>
                      <div><dt>证据</dt><dd>{reindexResult.indexed.evidence}</dd></div>
                    </dl>
                  </div>
                </div>
              )}

              {driftResult && (
                <div className={`settings-drift-card ${driftResult.hasDrift ? "has-drift" : "is-clean"}`}>
                  <div className="settings-drift-heading">
                    <span aria-hidden="true">{driftResult.hasDrift ? <Icon.Warn /> : <Icon.Check />}</span>
                    <div>
                      <h3>{driftResult.hasDrift ? "检测到索引差异" : "搜索索引与学习数据一致"}</h3>
                      <p>{driftResult.hasDrift ? "可核对下方差异后再决定是否重建。" : "当前无需执行重建操作。"}</p>
                    </div>
                  </div>
                  <div className="settings-drift-stats">
                    {(["note", "source"] as const).map((type) => {
                      const labels = { note: "笔记", source: "来源" };
                      return (
                        <div key={type}>
                          <span>{labels[type]}</span>
                          <strong>{driftResult.actual[type]} <i>/ {driftResult.expected[type]}</i></strong>
                        </div>
                      );
                    })}
                  </div>
                  {driftResult.hasDrift && (
                    <ul className="settings-drift-details">
                      <li><span>幽灵文档</span><strong>{driftResult.ghosts.length}</strong></li>
                      <li><span>缺失文档</span><strong>{driftResult.missing.length}</strong></li>
                      <li><span>过期标题</span><strong>{driftResult.staleTitles.length}</strong></li>
                      <li><span>过期正文</span><strong>{driftResult.staleBodies.length}</strong></li>
                    </ul>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showReindexConfirm}
        title="确认重建搜索索引？"
        message="系统会删除派生索引并从当前工作区重新生成。学习数据不会被删除，但搜索可能在短时间内不可用。"
        confirmLabel="确认重建"
        cancelLabel="暂不重建"
        loading={reindexLoading}
        onCancel={() => setShowReindexConfirm(false)}
        onConfirm={() => void handleReindex()}
      />
    </div>
  );
}
