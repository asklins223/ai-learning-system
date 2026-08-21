import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { DesktopPetScaleV1 } from "@ailearn/shared";

export interface DisplayGeometryV1 {
  id: string;
  scaleFactor: number;
  workArea: { x: number; y: number; width: number; height: number };
  fingerprint: string;
}

export interface DevicePetPreferencesV1 {
  version: 1;
  petModeEnabled: boolean;
  displayId: string;
  displayFingerprint: string;
  normalizedX: number;
  normalizedY: number;
  scaleFactor: number;
  petScale: DesktopPetScaleV1;
  locked: boolean;
  alwaysOnTop: boolean;
  privacyMode: boolean;
}

export interface PetSizeV1 {
  width: number;
  height: number;
}

export const DEVICE_PET_PREFERENCES_FILE = "desktop-pet-preferences-v1.json";

export function preferenceFilePath(userDataPath: string): string {
  return path.join(userDataPath, DEVICE_PET_PREFERENCES_FILE);
}

export function displayFingerprint(input: Omit<DisplayGeometryV1, "fingerprint">): string {
  const value = [
    input.workArea.x,
    input.workArea.y,
    input.workArea.width,
    input.workArea.height,
    input.scaleFactor,
  ].join(":");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function getDefaultDevicePetPreferences(
  primary: DisplayGeometryV1,
): DevicePetPreferencesV1 {
  const size = { width: 560, height: 520 };
  const position = safePosition(primary, size);
  return {
    version: 1,
    // 2026-08-12：新用户默认开启桌宠（Owner 需求：个人中心可关，默认开）。
    petModeEnabled: true,
    displayId: primary.id,
    displayFingerprint: primary.fingerprint,
    normalizedX: normalizedCoordinate(position.x, primary.workArea.x, primary.workArea.width - size.width),
    normalizedY: normalizedCoordinate(position.y, primary.workArea.y, primary.workArea.height - size.height),
    scaleFactor: primary.scaleFactor,
    petScale: 1,
    locked: false,
    alwaysOnTop: true,
    privacyMode: false,
  };
}

const isScale = (value: unknown): value is DesktopPetScaleV1 =>
  value === 0.85 || value === 1 || value === 1.15 || value === 1.25;

export function normalizeDevicePetPreferences(
  input: unknown,
  fallbackDisplay: DisplayGeometryV1,
): DevicePetPreferencesV1 {
  if (!input || typeof input !== "object") return getDefaultDevicePetPreferences(fallbackDisplay);
  const value = input as Partial<DevicePetPreferencesV1>;
  const defaults = getDefaultDevicePetPreferences(fallbackDisplay);
  return {
    version: 1,
    petModeEnabled: value.petModeEnabled === true,
    displayId: typeof value.displayId === "string" && value.displayId.length <= 200
      ? value.displayId
      : defaults.displayId,
    displayFingerprint: typeof value.displayFingerprint === "string" && /^[a-f0-9]{64}$/.test(value.displayFingerprint)
      ? value.displayFingerprint
      : defaults.displayFingerprint,
    normalizedX: clampUnit(value.normalizedX, defaults.normalizedX),
    normalizedY: clampUnit(value.normalizedY, defaults.normalizedY),
    scaleFactor: finitePositive(value.scaleFactor, defaults.scaleFactor),
    petScale: isScale(value.petScale) ? value.petScale : defaults.petScale,
    locked: value.locked === true,
    alwaysOnTop: value.alwaysOnTop !== false,
    privacyMode: value.privacyMode === true,
  };
}

export function loadDevicePetPreferences(userDataPath: string): DevicePetPreferencesV1 | null {
  const file = preferenceFilePath(userDataPath);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DevicePetPreferencesV1;
  } catch {
    return null;
  }
}

// 2026-08-16（性能专项，IO-Blocking）：把同步的 writeFileSync+renameSync 改造成
// 异步 + last-write-wins 合并写入。桌宠拖动/切换等高频 setter 不再阻塞 Electron
// main 事件循环；同一文件的突发写入会被合并成一次原子 write+rename。Data writes
// 仍保证原子性（临时文件 + rename），崩溃时最多丢失最近一次未刷盘的写入。
// 应用退出前应调用 flushDevicePetPreferences() 刷盘（见 main.ts before-quit）。

const WRITE_DEBOUNCE_MS = 150;

interface PendingPetPreferencesWrite {
  temp: string;
  file: string;
  content: string;
  timer: NodeJS.Timeout;
  resolvers: Array<() => void>;
  rejecters: Array<(error: unknown) => void>;
}

const pendingPreferencesWrites = new Map<string, PendingPetPreferencesWrite>();

function flushPreferencesWrite(pending: PendingPetPreferencesWrite): Promise<void> {
  pendingPreferencesWrites.delete(pending.file);
  clearTimeout(pending.timer);
  return (async () => {
    try {
      await writeFile(pending.temp, pending.content, { encoding: "utf8", mode: 0o600 });
      await rename(pending.temp, pending.file);
      for (const resolve of pending.resolvers) resolve();
    } catch (error) {
      for (const reject of pending.rejecters) reject(error);
    }
  })();
}

function schedulePreferencesWrite(file: string, temp: string, content: string): Promise<void> {
  const existing = pendingPreferencesWrites.get(file);
  if (existing) {
    // last-write-wins：同一窗口内的后续写入直接覆盖内容，复用待落盘任务。
    existing.content = content;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      void flushPreferencesWrite(existing);
    }, WRITE_DEBOUNCE_MS);
    return new Promise<void>((resolve, reject) => {
      existing.resolvers.push(resolve);
      existing.rejecters.push(reject);
    });
  }
  const pending: PendingPetPreferencesWrite = {
    temp,
    file,
    content,
    timer: setTimeout(() => {
      void flushPreferencesWrite(pending);
    }, WRITE_DEBOUNCE_MS),
    resolvers: [],
    rejecters: [],
  };
  pendingPreferencesWrites.set(file, pending);
  return new Promise<void>((resolve, reject) => {
    pending.resolvers.push(resolve);
    pending.rejecters.push(reject);
  });
}

export function saveDevicePetPreferences(
  userDataPath: string,
  preferences: DevicePetPreferencesV1,
): Promise<void> {
  const file = preferenceFilePath(userDataPath);
  const temp = `${file}.tmp-${process.pid}`;
  const content = `${JSON.stringify(preferences)}\n`;
  return schedulePreferencesWrite(file, temp, content);
}

/** Flush any pending prefs write for `userDataPath` (resolves once persisted). */
export function flushDevicePetPreferences(userDataPath: string): Promise<void> {
  const file = preferenceFilePath(userDataPath);
  const pending = pendingPreferencesWrites.get(file);
  if (!pending) return Promise.resolve();
  return flushPreferencesWrite(pending);
}

export function resolvePetPosition(
  preferences: DevicePetPreferencesV1,
  display: DisplayGeometryV1,
  size: PetSizeV1,
): { x: number; y: number } {
  const maxX = Math.max(0, display.workArea.width - size.width);
  const maxY = Math.max(0, display.workArea.height - size.height);
  return {
    x: Math.round(display.workArea.x + clampUnit(preferences.normalizedX, 0) * maxX),
    y: Math.round(display.workArea.y + clampUnit(preferences.normalizedY, 0) * maxY),
  };
}

export function updatePreferencesForPosition(
  preferences: DevicePetPreferencesV1,
  display: DisplayGeometryV1,
  position: { x: number; y: number },
  size: PetSizeV1,
): DevicePetPreferencesV1 {
  const maxX = Math.max(1, display.workArea.width - size.width);
  const maxY = Math.max(1, display.workArea.height - size.height);
  return {
    ...preferences,
    displayId: display.id,
    displayFingerprint: display.fingerprint,
    scaleFactor: display.scaleFactor,
    normalizedX: clampUnit((position.x - display.workArea.x) / maxX, 0),
    normalizedY: clampUnit((position.y - display.workArea.y) / maxY, 0),
  };
}

function safePosition(display: DisplayGeometryV1, size: PetSizeV1): { x: number; y: number } {
  return {
    x: display.workArea.x + Math.max(0, display.workArea.width - size.width - 8),
    y: display.workArea.y + Math.max(0, display.workArea.height - size.height - 8),
  };
}

function normalizedCoordinate(value: number, origin: number, range: number): number {
  return clampUnit((value - origin) / Math.max(1, range), 0);
}

function clampUnit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
