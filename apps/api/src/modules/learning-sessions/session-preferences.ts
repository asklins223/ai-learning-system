/**
 * session-preferences.ts（阶段 07 / W6，任务 07-9：个性化偏好与反馈文案，§11）
 *
 * 本文件是纯逻辑（无数据库 / 无网络 / 无时钟 / 无副作用源），负责 §11 的：
 * - **本轮上下文（§11.1）**：时长 3/10/20/自定义、本轮精力、挑战偏好、
 *   输入方式、复习范围；**默认只要求选择目的地**，其余可选；本轮精力
 *   **不长期保存**、不形成画像，只影响 route composition / 表达 / 数量 /
 *   互动选择，**不能直接进入 mastery 或 official scheduler**；
 * - **长期可编辑偏好（§11.2 清单）**：23 个偏好键的白名单 schema 与值校验
 *   （默认输入优先级 / 禁用 Encounter / 反馈风格 / 存在感 / 页面静音与专注 /
 *   动画与语音输出 / 全局关闭 / 设备本地临时隐藏 / 不再提示 classes / 挑战倾向 /
 *   单主题交错 / 默认时长 / 每周负荷 / 时间窗 / 通知边界 / TTS 语速 / 字幕 /
 *   音效 / reduced-motion / A11y / 原始音频保留与隐私）；
 * - **偏好全量可查看 / 修改 / 重置 / 导出 / 删除**（CRUD 纯函数）；
 * - **Agent 只能提出 `suggested preference`，不能静默改变** explicit 偏好；
 * - **onboarding 完成 / 跳过是产品状态不是学习偏好**（不在白名单，
 *   重置偏好不得重新触发已跳过引导）；
 * - **设置与帮助**：提供「重新播放首次引导」与「伴星当前可使用哪些页面上下文」。
 *
 * 不变量：
 * - 全部函数纯同步；`buildRoundContext` 只要求目的地（其余可选）；
 * - `RoundContextBoundaries.neverPersisted === true`、`masteryInfluence === 0`、
 *   `schedulerInfluence === false`（类型面与运行面双重保证）；
 * - Agent 的一切写路径都只进 `suggested`，`explicit` 只有
 *   `setExplicitPreference` / `acceptSuggestedPreference` / `importPreferences`
 *   三个用户显式路径可改。
 */

// ─── 1. 本轮上下文（§11.1）─────────────────────────────────────────────

export const ROUND_DURATION_OPTIONS = ["3", "10", "20", "custom"] as const;
export type RoundDuration = (typeof ROUND_DURATION_OPTIONS)[number];

export const ROUND_ENERGY_OPTIONS = ["low", "normal"] as const;
export type RoundEnergy = (typeof ROUND_ENERGY_OPTIONS)[number];

export const ROUND_CHALLENGE_OPTIONS = ["gentle", "standard", "challenge"] as const;
export type RoundChallenge = (typeof ROUND_CHALLENGE_OPTIONS)[number];

export const ROUND_INPUT_MODE_OPTIONS = ["silent", "voice", "touch_keyboard"] as const;
export type RoundInputMode = (typeof ROUND_INPUT_MODE_OPTIONS)[number];

export const ROUND_SCOPE_OPTIONS = ["single_cluster", "mixed_review"] as const;
export type RoundScope = (typeof ROUND_SCOPE_OPTIONS)[number];

/** 本轮上下文（§11.1：默认只要求选择目的地，其余可选） */
export interface RoundContext {
  /** 唯一必填：目的地（Key Point） */
  destinationKeyPointId: string;
  /** 时长：null = 未指定（可选） */
  duration: RoundDuration | null;
  /** 自定义分钟数：仅当 duration === "custom" 时使用 */
  customMinutes: number | null;
  /** 本轮精力：低负荷 / 正常（可选；不长期保存） */
  energy: RoundEnergy | null;
  /** 挑战偏好：温和 / 标准 / 挑战（可选） */
  challenge: RoundChallenge | null;
  /** 输入方式：静音 / 可语音 / 只用触控或键盘（可选） */
  inputMode: RoundInputMode | null;
  /** 复习范围：聚焦一个星域 / 混合复习（可选） */
  scope: RoundScope | null;
}

export type RoundContextResult =
  | { ok: true; context: RoundContext }
  | { ok: false; reason: "destination_missing" | "custom_minutes_required" | "custom_minutes_invalid" };

export interface RoundContextInput {
  /** 唯一必填 */
  destinationKeyPointId: string;
  duration?: RoundDuration | null;
  customMinutes?: number | null;
  energy?: RoundEnergy | null;
  challenge?: RoundChallenge | null;
  inputMode?: RoundInputMode | null;
  scope?: RoundScope | null;
}

/**
 * 构建本轮上下文（§11.1）：
 * - 默认只要求选择目的地，其余全部可选（缺省 null）；
 * - duration === "custom" 必须提供合法自定义分钟数（正整数）；
 * - 本轮精力/挑战/输入/范围都只是本轮快速表达，不落到长期偏好。
 */
export function buildRoundContext(input: RoundContextInput): RoundContextResult {
  if (typeof input.destinationKeyPointId !== "string" || input.destinationKeyPointId.length === 0) {
    return { ok: false, reason: "destination_missing" };
  }
  const duration = input.duration ?? null;
  let customMinutes = input.customMinutes ?? null;
  if (duration === "custom") {
    if (customMinutes === null) return { ok: false, reason: "custom_minutes_required" };
    if (!Number.isInteger(customMinutes) || customMinutes <= 0) {
      return { ok: false, reason: "custom_minutes_invalid" };
    }
  } else if (customMinutes !== null) {
    customMinutes = null; // 非 custom 时忽略自定义分钟
  }
  return {
    ok: true,
    context: {
      destinationKeyPointId: input.destinationKeyPointId,
      duration,
      customMinutes,
      energy: input.energy ?? null,
      challenge: input.challenge ?? null,
      inputMode: input.inputMode ?? null,
      scope: input.scope ?? null,
    },
  };
}

/**
 * 本轮上下文边界（§11.1）：
 * - `neverPersisted: true`：本轮精力**不长期保存**、不形成心理画像；
 * - `masteryInfluence: 0` / `schedulerInfluence: false`：不能直接进入
 *   mastery 或 official scheduler；
 * - 只影响 route composition / 表达 / 数量 / 互动选择。
 */
export interface RoundContextBoundaries {
  readonly neverPersisted: true;
  /** 只影响这四项 */
  readonly affectsRouteComposition: true;
  readonly affectsExpression: true;
  readonly affectsQuantity: true;
  readonly affectsInteractionChoice: true;
  /** 对 mastery 的影响恒为 0（类型面 0 字面量） */
  readonly masteryInfluence: 0;
  /** 对 official scheduler 的影响恒为 false */
  readonly schedulerInfluence: false;
}

export function resolveRoundContextBoundaries(_context: Readonly<RoundContext>): RoundContextBoundaries {
  return {
    neverPersisted: true,
    affectsRouteComposition: true,
    affectsExpression: true,
    affectsQuantity: true,
    affectsInteractionChoice: true,
    masteryInfluence: 0,
    schedulerInfluence: false,
  };
}

// ─── 2. 长期可编辑偏好白名单（§11.2 清单）──────────────────────────────

export type InputPriority = "voice" | "touch_structure" | "text";
export type FeedbackStyle = "concise" | "direct" | "guided";
export type PresenceLevel = "quiet" | "moderate" | "active";
export type ChallengeTendency = "gentle" | "standard" | "challenge";
export type InterleaveMode = "single_topic" | "interleaved";
export type NotificationBoundary = "within_window" | "quiet_always" | "all";
export type RawAudioRetention = "keep_until_commit" | "delete_after_commit" | "never_keep";
export type TimeWindow = { start: string; end: string };

/** 长期偏好值类型映射（§11.2 完整清单，23 个键） */
export interface LongTermPreferenceValueMap {
  /** 默认输入优先级：语音 / 触控结构操作 / 文字 */
  default_input_priority: InputPriority;
  /** 明确禁用或不喜欢的 Encounter */
  disabled_encounters: readonly string[];
  /** 反馈风格：简洁 / 直接 / 引导式 */
  feedback_style: FeedbackStyle;
  /** 伴星存在感：安静 / 适度陪伴 / 主动建议 */
  presence: PresenceLevel;
  /** 页面级静音（默认） */
  page_muted_default: boolean;
  /** 专注（默认） */
  focus_default: boolean;
  /** 账号级角色动画 */
  animation_enabled: boolean;
  /** 账号级语音输出 */
  voice_output_enabled: boolean;
  /** 全局关闭 */
  global_off: boolean;
  /** 仅本设备持久化的临时隐藏（device-local，不跨设备同步） */
  temporary_hidden_device_local: boolean;
  /** 「不再提示」的 bounded suggestion classes */
  suppressed_suggestion_classes: readonly string[];
  /** 挑战倾向 */
  challenge_tendency: ChallengeTendency;
  /** 单主题 / 交错复习偏好 */
  single_topic_interleave: InterleaveMode;
  /** 默认时长（分钟） */
  default_duration_minutes: number;
  /** 每周负荷（分钟） */
  weekly_load_minutes: number;
  /** 可用时间窗（"HH:mm" start/end；null = 不限） */
  available_time_window: TimeWindow | null;
  /** 通知边界 */
  notification_boundary: NotificationBoundary;
  /** TTS 语速（0.5 ~ 2.0） */
  tts_rate: number;
  /** 字幕 */
  subtitles_enabled: boolean;
  /** 音效 */
  sound_effects_enabled: boolean;
  /** reduced-motion */
  reduced_motion: boolean;
  /** 无障碍偏好（自由文本，非空） */
  a11y_preference: string;
  /** 原始音频保留与隐私选择 */
  raw_audio_retention: RawAudioRetention;
}

export type PreferenceKey = keyof LongTermPreferenceValueMap;
export type PreferenceValue = LongTermPreferenceValueMap[PreferenceKey];

/** 长期偏好键清单（§11.2 完整清单，23 个键；顺序即展示顺序） */
export const PREFERENCE_KEYS: readonly PreferenceKey[] = [
  "default_input_priority",
  "disabled_encounters",
  "feedback_style",
  "presence",
  "page_muted_default",
  "focus_default",
  "animation_enabled",
  "voice_output_enabled",
  "global_off",
  "temporary_hidden_device_local",
  "suppressed_suggestion_classes",
  "challenge_tendency",
  "single_topic_interleave",
  "default_duration_minutes",
  "weekly_load_minutes",
  "available_time_window",
  "notification_boundary",
  "tts_rate",
  "subtitles_enabled",
  "sound_effects_enabled",
  "reduced_motion",
  "a11y_preference",
  "raw_audio_retention",
];

/** explicit 偏好（用户显式确认；键集合 = 白名单子集） */
export type ExplicitPreferences = { [K in PreferenceKey]?: LongTermPreferenceValueMap[K] };
/** suggested 偏好（Agent 只能写这里；不能静默改变 explicit） */
export type SuggestedPreferences = { [K in PreferenceKey]?: LongTermPreferenceValueMap[K] };

export interface PreferencesState {
  explicit: ExplicitPreferences;
  suggested: SuggestedPreferences;
}

export const EMPTY_PREFERENCES_STATE: PreferencesState = {
  explicit: {},
  suggested: {},
};

/** 设备本地偏好键（不跨设备同步；§11.2「仅本设备持久化的临时隐藏」） */
export const DEVICE_LOCAL_PREFERENCE_KEYS: readonly PreferenceKey[] = [
  "temporary_hidden_device_local",
];

/** 产品状态键（§11.2：onboarding 完成/跳过是产品状态，不是学习偏好） */
export const PRODUCT_STATE_KEYS = ["onboarding_completed", "onboarding_skipped"] as const;
export type ProductStateKey = (typeof PRODUCT_STATE_KEYS)[number];

// ─── 3. 偏好键 schema 与值校验 ─────────────────────────────────────────

interface PreferenceSchemaEntry<K extends PreferenceKey> {
  key: K;
  /** 设置页展示标签 */
  label: string;
  /** 是否设备本地（不跨设备同步） */
  deviceLocal?: boolean;
  validate: (value: unknown) => value is LongTermPreferenceValueMap[K];
}

const TIME_WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTimeWindow(value: unknown): value is TimeWindow {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.start === "string" && TIME_WINDOW_RE.test(candidate.start)
    && typeof candidate.end === "string" && TIME_WINDOW_RE.test(candidate.end)
    && candidate.start < candidate.end
  );
}

function enumOf<T extends string>(options: readonly T[]) {
  return (value: unknown): value is T =>
    typeof value === "string" && (options as readonly string[]).includes(value);
}

/** 长期偏好键 schema（§11.2 完整清单：每个键带标签 / 设备本地标记 / 值校验） */
export const PREFERENCE_SCHEMA: {
  [K in PreferenceKey]: PreferenceSchemaEntry<K>;
} = {
  default_input_priority: {
    key: "default_input_priority",
    label: "默认输入优先级",
    validate: enumOf(["voice", "touch_structure", "text"]),
  },
  disabled_encounters: {
    key: "disabled_encounters",
    label: "禁用的 Encounter",
    validate: isStringArray,
  },
  feedback_style: {
    key: "feedback_style",
    label: "反馈风格",
    validate: enumOf(["concise", "direct", "guided"]),
  },
  presence: {
    key: "presence",
    label: "伴星存在感",
    validate: enumOf(["quiet", "moderate", "active"]),
  },
  page_muted_default: {
    key: "page_muted_default",
    label: "页面静音（默认）",
    validate: (value): value is boolean => typeof value === "boolean",
  },
  focus_default: {
    key: "focus_default",
    label: "专注（默认）",
    validate: (value): value is boolean => typeof value === "boolean",
  },
  animation_enabled: {
    key: "animation_enabled",
    label: "账号级角色动画",
    validate: (value): value is boolean => typeof value === "boolean",
  },
  voice_output_enabled: {
    key: "voice_output_enabled",
    label: "账号级语音输出",
    validate: (value): value is boolean => typeof value === "boolean",
  },
  global_off: {
    key: "global_off",
    label: "全局关闭",
    validate: (value): value is boolean => typeof value === "boolean",
  },
  temporary_hidden_device_local: {
    key: "temporary_hidden_device_local",
    label: "临时隐藏（仅本设备）",
    deviceLocal: true,
    validate: (value): value is boolean => typeof value === "boolean",
  },
  suppressed_suggestion_classes: {
    key: "suppressed_suggestion_classes",
    label: "不再提示的建议类别",
    validate: isStringArray,
  },
  challenge_tendency: {
    key: "challenge_tendency",
    label: "挑战倾向",
    validate: enumOf(["gentle", "standard", "challenge"]),
  },
  single_topic_interleave: {
    key: "single_topic_interleave",
    label: "单主题 / 交错",
    validate: enumOf(["single_topic", "interleaved"]),
  },
  default_duration_minutes: {
    key: "default_duration_minutes",
    label: "默认时长（分钟）",
    validate: isPositiveInteger,
  },
  weekly_load_minutes: {
    key: "weekly_load_minutes",
    label: "每周负荷（分钟）",
    validate: isNonNegativeInteger,
  },
  available_time_window: {
    key: "available_time_window",
    label: "可用时间窗",
    validate: (value): value is TimeWindow | null => value === null || isTimeWindow(value),
  },
  notification_boundary: {
    key: "notification_boundary",
    label: "通知边界",
    validate: enumOf(["within_window", "quiet_always", "all"]),
  },
  tts_rate: {
    key: "tts_rate",
    label: "TTS 语速",
    validate: (value): value is number =>
      typeof value === "number" && value >= 0.5 && value <= 2.0,
  },
  subtitles_enabled: {
    key: "subtitles_enabled",
    label: "字幕",
    validate: (value): value is boolean => typeof value === "boolean",
  },
  sound_effects_enabled: {
    key: "sound_effects_enabled",
    label: "音效",
    validate: (value): value is boolean => typeof value === "boolean",
  },
  reduced_motion: {
    key: "reduced_motion",
    label: "减少动画（reduced-motion）",
    validate: (value): value is boolean => typeof value === "boolean",
  },
  a11y_preference: {
    key: "a11y_preference",
    label: "无障碍偏好",
    validate: isNonEmptyString,
  },
  raw_audio_retention: {
    key: "raw_audio_retention",
    label: "原始音频保留与隐私",
    validate: enumOf(["keep_until_commit", "delete_after_commit", "never_keep"]),
  },
};

export function getPreferenceLabel(key: string): string {
  const entry = (PREFERENCE_SCHEMA as Record<string, PreferenceSchemaEntry<PreferenceKey>>)[key];
  return entry?.label ?? key;
}

/** 是否为设备本地偏好键（不跨设备同步） */
export function isDeviceLocalPreferenceKey(key: PreferenceKey): boolean {
  return DEVICE_LOCAL_PREFERENCE_KEYS.includes(key);
}

/** 是否为合法学习偏好键（onboarding 产品状态键一律不在白名单） */
export function isLearningPreferenceKey(key: string): key is PreferenceKey {
  // Object.hasOwn：普通对象字面量继承 Object.prototype，
  // `key in` 会把 "toString"/"constructor" 判为合法键，
  // 随后 validatePreferenceValue 执行 PREFERENCE_SCHEMA[key].validate 抛 TypeError → 500。
  return Object.hasOwn(PREFERENCE_SCHEMA, key);
}

/** 校验偏好值是否合法（键合法 + 值通过该键 schema） */
export function validatePreferenceValue(
  key: PreferenceKey,
  value: unknown,
): boolean {
  return PREFERENCE_SCHEMA[key].validate(value);
}

// ─── 4. 偏好 CRUD（查看 / 修改 / 重置 / 导出 / 删除）──────────────────

export type SetPreferenceResult =
  | { ok: true; state: PreferencesState }
  | { ok: false; reason: "invalid_key" | "invalid_value" };

function writeExplicit(
  state: PreferencesState,
  key: PreferenceKey,
  value: unknown,
): SetPreferenceResult {
  if (!isLearningPreferenceKey(key)) return { ok: false, reason: "invalid_key" };
  if (!validatePreferenceValue(key, value)) return { ok: false, reason: "invalid_value" };
  return {
    ok: true,
    state: {
      explicit: { ...state.explicit, [key]: value },
      suggested: state.suggested,
    },
  };
}

/**
 * 用户显式修改偏好（§11.2：所有偏好可查看、修改）。只有用户显式路径
 * （本函数 / acceptSuggestedPreference / importPreferences）能改 explicit。
 */
export function setExplicitPreference(
  state: PreferencesState,
  key: PreferenceKey,
  value: unknown,
): SetPreferenceResult {
  return writeExplicit(state, key, value);
}

/** 重置单个偏好（从 explicit 与 suggested 一并移除该键） */
export function resetPreference(state: PreferencesState, key: PreferenceKey): PreferencesState {
  if (!isLearningPreferenceKey(key)) return state;
  const explicit = { ...state.explicit };
  const suggested = { ...state.suggested };
  delete explicit[key];
  delete suggested[key];
  return { explicit, suggested };
}

/**
 * 重置全部偏好（§11.2：所有偏好可重置）。
 * **不触碰 onboarding 产品状态**：重置偏好绝不重新触发已跳过引导。
 */
export function resetAllPreferences(): PreferencesState {
  return { explicit: {}, suggested: {} };
}

/** 导出全部偏好（查看 / 导出；JSON 文本） */
export function exportPreferences(state: PreferencesState): string {
  return JSON.stringify({ explicit: state.explicit, suggested: state.suggested }, null, 2);
}

/**
 * 删除全部偏好（§11.2：所有偏好可删除）。
 * 删除只作用于学习偏好，onboarding 完成/跳过产品状态不受影响。
 */
export function deleteAllPreferences(): PreferencesState {
  return { explicit: {}, suggested: {} };
}

export type ImportPreferencesResult =
  | { ok: true; state: PreferencesState }
  | { ok: false; reason: "invalid_json" | "invalid_key" | "invalid_value" };

/** 导入偏好（导出文件的回读；校验每个键与值，非法即整体拒绝） */
export function importPreferences(json: string): ImportPreferencesResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (parsed === null || typeof parsed !== "object") return { ok: false, reason: "invalid_json" };
  const candidate = parsed as Record<string, unknown>;
  const source = candidate.explicit ?? {};
  const suggestedSource = candidate.suggested ?? {};
  if (typeof source !== "object" || source === null
    || typeof suggestedSource !== "object" || suggestedSource === null) {
    return { ok: false, reason: "invalid_json" };
  }

  const explicit: ExplicitPreferences = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (!isLearningPreferenceKey(key)) return { ok: false, reason: "invalid_key" };
    if (!validatePreferenceValue(key, value)) return { ok: false, reason: "invalid_value" };
    (explicit as Record<string, unknown>)[key] = value;
  }
  const suggested: SuggestedPreferences = {};
  for (const [key, value] of Object.entries(suggestedSource as Record<string, unknown>)) {
    if (!isLearningPreferenceKey(key)) return { ok: false, reason: "invalid_key" };
    if (!validatePreferenceValue(key, value)) return { ok: false, reason: "invalid_value" };
    (suggested as Record<string, unknown>)[key] = value;
  }
  return { ok: true, state: { explicit, suggested } };
}

// ─── 5. Agent 只能提出 suggested preference（§11.2 / 01-9 §3）──────────

export interface AgentSuggestedResult {
  state: PreferencesState;
  /** Agent 写路径永不改变 explicit（恒 false） */
  explicitChanged: false;
  note: string;
}

/**
 * Agent 提出 `suggested preference`（§11.2 / 01-9 §3：Agent 只能提出，
 * **不能静默改变**任何偏好）。写入只进 `suggested`；explicit 保持原样。
 * 值不合法时连 suggested 也不写（fail closed）。
 */
export function applyAgentSuggestedPreference(
  state: PreferencesState,
  key: PreferenceKey,
  value: unknown,
): AgentSuggestedResult {
  if (!isLearningPreferenceKey(key) || !validatePreferenceValue(key, value)) {
    return {
      state,
      explicitChanged: false,
      note: `建议未接受：${key} 不是合法偏好或值不合法（不写入 suggested）。`,
    };
  }
  return {
    state: {
      explicit: state.explicit,
      suggested: { ...state.suggested, [key]: value },
    },
    explicitChanged: false,
    note: `已作为建议提出：${getPreferenceLabel(key)}（需要你确认才会生效）。`,
  };
}

/** 用户显式接受 suggested → 进入 explicit（唯一合法提升路径） */
export function acceptSuggestedPreference(
  state: PreferencesState,
  key: PreferenceKey,
): PreferencesState {
  // Object.hasOwn：state.suggested 是普通对象字面量，`key in` 会把
  // "toString"/"constructor" 等原型链键误判为已建议，随后
  // validatePreferenceValue 对非法键执行 PREFERENCE_SCHEMA[key].validate
  //（undefined.validate）抛 TypeError。hasOwn 只认自有键。
  if (!Object.hasOwn(state.suggested, key)) return state;
  const value = state.suggested[key];
  if (!validatePreferenceValue(key, value)) return state;
  const suggested = { ...state.suggested };
  delete suggested[key];
  return {
    explicit: { ...state.explicit, [key]: value },
    suggested,
  };
}

/** 用户显式拒绝 suggested → 从 suggested 移除，不进 explicit */
export function rejectSuggestedPreference(
  state: PreferencesState,
  key: PreferenceKey,
): PreferencesState {
  // 与 acceptSuggestedPreference 一致：只认自有键，原型链键不当作已建议。
  if (!Object.hasOwn(state.suggested, key)) return state;
  const suggested = { ...state.suggested };
  delete suggested[key];
  return { explicit: state.explicit, suggested };
}

export interface AgentSilentChangeAttemptResult {
  /** 静默改变被阻止（恒 true） */
  blocked: true;
  state: PreferencesState;
  reason: string;
}

/**
 * Agent 试图**静默改变** explicit 偏好 → 一律阻止（§11.2 / 01-9 §3）。
 * explicit 保持原样；建议只能走 `applyAgentSuggestedPreference` 由用户确认。
 */
export function agentSilentChangeAttempt(
  state: PreferencesState,
  key: PreferenceKey,
  _value: unknown,
): AgentSilentChangeAttemptResult {
  return {
    blocked: true,
    state,
    reason: `Agent 不能静默改变偏好「${getPreferenceLabel(key)}」；只能作为建议提出并等你确认。`,
  };
}

// ─── 6. 设置与帮助（§11.2）─────────────────────────────────────────────

/** 设置与帮助提供的「重新播放首次引导」入口（07-1 手动重播接线） */
export const REPLAY_FIRST_GUIDE_ENTRY = "重新播放首次引导";

/** 伴星当前可使用哪些页面上下文（07-2 coverage registry 的页面 kind 列表） */
export function buildCompanionPageContextAvailability(pageKinds: readonly string[]): readonly string[] {
  return [...new Set(pageKinds)].sort();
}
