import { createHash } from "node:crypto";
import type { BrowserWindow } from "electron";
import type {
  DesktopPetInteractionModeV1,
  DesktopPetScaleV1,
  DesktopPetWindowStateV1,
} from "@ailearn/shared";
import {
  type DevicePetPreferencesV1,
  type DisplayGeometryV1,
  getDefaultDevicePetPreferences,
  loadDevicePetPreferences,
  normalizeDevicePetPreferences,
  resolvePetPosition,
  saveDevicePetPreferences,
  updatePreferencesForPosition,
} from "../persistence/device-pet-preferences";
import { petContentSizeForScale } from "./pet-window-contract";

export interface PetDisplayProvider {
  getAllDisplays(): DisplayGeometryV1[];
  getPrimaryDisplay(): DisplayGeometryV1;
}

export interface PetWindowStateControllerOptions {
  userDataPath: string;
  displays: PetDisplayProvider;
  window: BrowserWindow;
  spikeEnabled: boolean;
}

export class PetWindowStateController {
  private preferences: DevicePetPreferencesV1;
  private revision = 0;
  private interactionMode: DesktopPetInteractionModeV1 = "passive";
  private temporaryHidden = false;
  private readonly userDataPath: string;
  private readonly displays: PetDisplayProvider;
  private readonly window: BrowserWindow;
  private readonly spikeEnabled: boolean;

  constructor(options: PetWindowStateControllerOptions) {
    this.userDataPath = options.userDataPath;
    this.displays = options.displays;
    this.window = options.window;
    this.spikeEnabled = options.spikeEnabled;
    const primary = options.displays.getPrimaryDisplay();
    this.preferences = loadDevicePetPreferences(this.userDataPath)
      ?? getDefaultDevicePetPreferences(primary);
    this.preferences = normalizeDevicePetPreferences(this.preferences, primary);
  }

  get currentPreferences(): DevicePetPreferencesV1 {
    return this.preferences;
  }

  get petModeEnabled(): boolean {
    return this.preferences.petModeEnabled || this.spikeEnabled;
  }

  get isTemporarilyHidden(): boolean {
    return this.temporaryHidden;
  }

  setTemporaryHidden(hidden: boolean): void {
    this.temporaryHidden = hidden;
    this.revision += 1;
  }

  applySavedPosition(): void {
    const display = this.selectDisplay();
    const size = petContentSizeForScale(this.preferences.petScale);
    const position = resolvePetPosition(this.preferences, display, size);
    this.window.setContentSize(size.width, size.height);
    this.window.setPosition(position.x, position.y, false);
    this.window.setAlwaysOnTop(this.preferences.alwaysOnTop);
    // §10.3：显示器变化后 clamp 只保证在 workArea 内，无法保证可见面积
    // 足够。不足 60% 时先降 scale 到 0.85 重试；仍不足则回退主屏右下安全区，
    // 保证桌宠不会"飘在屏幕外"只剩一条边。
    if (!this.hasEnoughVisibleArea(display)) {
      const fallbackScale = this.preferences.petScale === 0.85
        ? this.preferences.petScale
        : 0.85;
      if (fallbackScale !== this.preferences.petScale) {
        this.preferences = { ...this.preferences, petScale: fallbackScale };
        const fallbackSize = petContentSizeForScale(fallbackScale);
        const fallbackPosition = resolvePetPosition(this.preferences, display, fallbackSize);
        this.window.setContentSize(fallbackSize.width, fallbackSize.height);
        this.window.setPosition(fallbackPosition.x, fallbackPosition.y, false);
        this.savePosition();
      }
      if (!this.hasEnoughVisibleArea(display)) {
        this.moveToSafePosition();
      }
    }
    this.revision += 1;
  }

  private hasEnoughVisibleArea(display: DisplayGeometryV1): boolean {
    const bounds = this.window.getContentBounds();
    const work = display.workArea;
    const interWidth = Math.max(0, Math.min(bounds.x + bounds.width, work.x + work.width) - Math.max(bounds.x, work.x));
    const interHeight = Math.max(0, Math.min(bounds.y + bounds.height, work.y + work.height) - Math.max(bounds.y, work.y));
    const interArea = interWidth * interHeight;
    const totalArea = bounds.width * bounds.height;
    if (totalArea <= 0) return true; // 窗口尚未显示时不做判定
    return interArea / totalArea >= 0.6;
  }

  private savePosition(): void {
    // §10.3：按窗口当前所在显示器保存归一化基准（跨屏拖动后 displayId
    // 不再等于原显示器，旧基准会把位置 clamp 回原屏）。窗口在显示器间隙
    // 时回退到偏好显示器。
    const display = this.displayContainingWindow() ?? this.selectDisplay();
    const size = petContentSizeForScale(this.preferences.petScale);
    const [x, y] = this.window.getPosition();
    this.preferences = updatePreferencesForPosition(this.preferences, display, { x, y }, size);
    saveDevicePetPreferences(this.userDataPath, this.preferences);
  }

  setWindowPosition(x: number, y: number): void {
    // 拖动结束时按窗口当前所在显示器保存，避免跨屏后恢复错基准。
    const display = this.displayContainingWindow() ?? this.selectDisplay();
    const size = petContentSizeForScale(this.preferences.petScale);
    this.preferences = updatePreferencesForPosition(
      this.preferences,
      display,
      { x, y },
      size,
    );
    saveDevicePetPreferences(this.userDataPath, this.preferences);
    this.revision += 1;
  }

  setPetModeEnabled(enabled: boolean): void {
    this.preferences = { ...this.preferences, petModeEnabled: enabled };
    saveDevicePetPreferences(this.userDataPath, this.preferences);
    this.revision += 1;
  }

  setAlwaysOnTop(enabled: boolean): void {
    this.preferences = { ...this.preferences, alwaysOnTop: enabled };
    saveDevicePetPreferences(this.userDataPath, this.preferences);
    this.window.setAlwaysOnTop(enabled);
    this.revision += 1;
  }

  setLocked(locked: boolean): void {
    this.preferences = { ...this.preferences, locked };
    saveDevicePetPreferences(this.userDataPath, this.preferences);
    this.revision += 1;
  }

  setPetScale(petScale: DesktopPetScaleV1): void {
    this.preferences = { ...this.preferences, petScale };
    saveDevicePetPreferences(this.userDataPath, this.preferences);
    // applySavedPosition 末尾已 revision += 1（位置/尺寸变化），不再重复递增。
    this.applySavedPosition();
  }

  setPrivacyMode(privacyMode: boolean): void {
    this.preferences = { ...this.preferences, privacyMode };
    saveDevicePetPreferences(this.userDataPath, this.preferences);
    this.revision += 1;
  }

  moveToSafePosition(): void {
    const display = this.displays.getPrimaryDisplay();
    const size = petContentSizeForScale(this.preferences.petScale);
    const margin = 8;
    const x = display.workArea.x + Math.max(0, display.workArea.width - size.width - margin);
    const y = display.workArea.y + Math.max(0, display.workArea.height - size.height - margin);
    this.preferences = updatePreferencesForPosition(this.preferences, display, { x, y }, size);
    saveDevicePetPreferences(this.userDataPath, this.preferences);
    this.window.setPosition(x, y, false);
    this.revision += 1;
  }

  /** 返回是否真的发生了 mode 变化（供调用方决定是否需要广播）。 */
  setInteractionMode(mode: DesktopPetInteractionModeV1): boolean {
    if (this.interactionMode === mode) return false;
    this.interactionMode = mode;
    this.revision += 1;
    return true;
  }

  getState(): DesktopPetWindowStateV1 {
    const bounds = this.window.getContentBounds();
    const display = this.selectDisplay();
    const size = petContentSizeForScale(this.preferences.petScale);
    return {
      version: 1,
      revision: this.revision,
      visible: this.window.isVisible(),
      displayId: display.id,
      boundsDip: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      contentSizeCssPx: size,
      scaleFactor: display.scaleFactor,
      petModeEnabled: this.petModeEnabled,
      petScale: this.preferences.petScale,
      locked: this.preferences.locked,
      alwaysOnTop: this.preferences.alwaysOnTop,
      privacyMode: this.preferences.privacyMode,
      interactionMode: this.interactionMode,
    };
  }

  getDisplayFingerprint(): string {
    return createHash("sha256")
      .update(this.selectDisplay().fingerprint)
      .digest("hex");
  }

  private selectDisplay(): DisplayGeometryV1 {
    return this.displays.getAllDisplays().find((display) => display.id === this.preferences.displayId)
      ?? this.displays.getAllDisplays().find((display) => display.fingerprint === this.preferences.displayFingerprint)
      ?? this.displayContainingWindow()
      ?? this.displays.getPrimaryDisplay();
  }

  /**
   * §10.3：返回窗口当前所在显示器（中心点所在 display；落在显示器间隙时
   * 按与 workArea 的最大重叠面积）。用于保存位置时的归一化基准，避免跨屏
   * 拖动后按旧显示器 clamp。找不到时返回 null 由调用方回退。
   */
  private displayContainingWindow(): DisplayGeometryV1 | null {
    const all = this.displays.getAllDisplays();
    if (all.length === 0) return null;
    const bounds = this.window.getContentBounds();
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const containing = all.find((display) => {
      const work = display.workArea;
      return centerX >= work.x && centerX < work.x + work.width
        && centerY >= work.y && centerY < work.y + work.height;
    });
    if (containing) return containing;
    let best: DisplayGeometryV1 | null = null;
    let bestArea = -1;
    for (const display of all) {
      const work = display.workArea;
      const interWidth = Math.max(0, Math.min(bounds.x + bounds.width, work.x + work.width) - Math.max(bounds.x, work.x));
      const interHeight = Math.max(0, Math.min(bounds.y + bounds.height, work.y + work.height) - Math.max(bounds.y, work.y));
      const area = interWidth * interHeight;
      if (area > bestArea) {
        bestArea = area;
        best = display;
      }
    }
    return best;
  }
}
