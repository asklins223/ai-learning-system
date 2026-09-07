export const AUTH_SCENE_TIMES = ["day", "dusk", "night"] as const;

export type AuthSceneTime = (typeof AUTH_SCENE_TIMES)[number];
export type AuthScenePreference = "system" | AuthSceneTime;

export type AuthSceneOption = Readonly<{
  scene: AuthSceneTime;
  label: string;
  representativeTime: string;
}>;

export const AUTH_SCENE_OPTIONS: readonly AuthSceneOption[] = Object.freeze([
  { scene: "day", label: "日间", representativeTime: "10:00" },
  { scene: "dusk", label: "黄昏", representativeTime: "18:30" },
  { scene: "night", label: "夜读", representativeTime: "22:00" },
]);

const MORNING_START_MINUTES = 7 * 60;
const DUSK_START_MINUTES = 17 * 60;
const NIGHT_START_MINUTES = 19 * 60 + 30;

/**
 * The available artwork represents three honest, distinct lighting states.
 * We deliberately map the gaps to the nearest real scene instead of claiming
 * to render a continuously generated clock-accurate sky.
 */
export function resolveAuthSceneFromDate(date: Date): AuthSceneTime {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes >= DUSK_START_MINUTES && minutes < NIGHT_START_MINUTES) return "dusk";
  if (minutes >= MORNING_START_MINUTES && minutes < DUSK_START_MINUTES) return "day";
  return "night";
}

export function resolveAuthScene(
  preference: AuthScenePreference,
  date: Date = new Date(),
): AuthSceneTime {
  return preference === "system" ? resolveAuthSceneFromDate(date) : preference;
}

export function formatAuthSceneClock(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function authSceneLabel(scene: AuthSceneTime): string {
  return AUTH_SCENE_OPTIONS.find((option) => option.scene === scene)?.label ?? "日间";
}
