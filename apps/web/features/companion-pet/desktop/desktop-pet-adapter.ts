"use client";

import type {
  AllowedMainRouteV1,
  DesktopPetApiV1,
  DesktopPetInteractionModeV1,
  DesktopPetScaleV1,
  DesktopPetWindowStateV1,
  PetHitGeometryV1,
  DesktopLifecycleEventV1,
} from "@ailearn/shared/desktop-pet-contracts";

/**
 * Renderer-side adapter over the typed preload bridge. The browser fallback
 * provides a no-op adapter so the same PetSurface code path works in both
 * environments without reaching for Electron APIs.
 */

export interface PetAdapterV1 {
  kind: "electron" | "browser";
  getWindowState(): Promise<DesktopPetWindowStateV1 | null>;
  registerHitGeometry(geometry: PetHitGeometryV1): Promise<void>;
  setInteractionMode(mode: DesktopPetInteractionModeV1): Promise<void>;
  requestTextInputFocus(): Promise<void>;
  releaseTextInputFocus(): Promise<void>;
  setPrivacyMode(enabled: boolean): Promise<void>;
  setAlwaysOnTop(enabled: boolean): Promise<void>;
  setLocked(enabled: boolean): Promise<void>;
  dragBy(deltaX: number, deltaY: number): Promise<void>;
  setPetScale(scale: DesktopPetScaleV1): Promise<void>;
  setPetModeEnabled(enabled: boolean): Promise<void>;
  openMainRoute(route: AllowedMainRouteV1): Promise<void>;
  hidePet(): Promise<void>;
  moveToSafePosition(): Promise<void>;
  onWindowStateChanged(callback: (state: DesktopPetWindowStateV1) => void): () => void;
  onLifecycleEvent(callback: (event: DesktopLifecycleEventV1) => void): () => void;
}

export interface BrowserPetAdapterOptionsV1 {
  onDragBy?(deltaX: number, deltaY: number): void;
  onHide?(): void;
  onMoveToSafePosition?(): void;
  onOpenMainRoute?(route: AllowedMainRouteV1): void;
}

declare global {
  interface Window {
    desktopAPI?: DesktopPetApiV1;
  }
}

export function createPetAdapter(
  api: DesktopPetApiV1 | undefined,
  browserOptions: BrowserPetAdapterOptionsV1 = {},
): PetAdapterV1 {
  if (!api) {
    return createBrowserPetAdapter(browserOptions);
  }
  return {
    kind: "electron",
    getWindowState: () => api.getWindowState(),
    registerHitGeometry: (geometry) => api.registerHitGeometry(geometry),
    setInteractionMode: (mode) => api.setInteractionMode(mode),
    requestTextInputFocus: () => api.requestTextInputFocus(),
    releaseTextInputFocus: () => api.releaseTextInputFocus(),
    setPrivacyMode: (enabled) => api.setPrivacyMode(enabled),
    setAlwaysOnTop: (enabled) => api.setAlwaysOnTop(enabled),
    setLocked: (enabled) => api.setLocked(enabled),
    dragBy: (deltaX, deltaY) => api.dragBy(deltaX, deltaY),
    setPetScale: (scale) => api.setPetScale(scale),
    setPetModeEnabled: (enabled) => api.setPetModeEnabled(enabled),
    openMainRoute: (route) => api.openMainRoute(route),
    hidePet: () => api.hidePet(),
    moveToSafePosition: () => api.moveToSafePosition(),
    onWindowStateChanged: (callback) => api.onWindowStateChanged(callback),
    onLifecycleEvent: (callback) => api.onLifecycleEvent(callback),
  };
}

function createBrowserPetAdapter(options: BrowserPetAdapterOptionsV1): PetAdapterV1 {
  let revision = 0;
  let state: DesktopPetWindowStateV1 = {
    version: 1,
    revision,
    visible: true,
    displayId: "browser-viewport",
    boundsDip: { x: 0, y: 0, width: 560, height: 520 },
    contentSizeCssPx: { width: 560, height: 520 },
    scaleFactor: 1,
    petModeEnabled: true,
    petScale: 1,
    locked: false,
    alwaysOnTop: false,
    privacyMode: false,
    interactionMode: "passive",
  };
  const listeners = new Set<(nextState: DesktopPetWindowStateV1) => void>();
  const updateState = (patch: Partial<DesktopPetWindowStateV1>) => {
    revision += 1;
    state = { ...state, ...patch, revision };
    listeners.forEach((listener) => listener(state));
  };

  return {
    kind: "browser",
    getWindowState: async () => state,
    registerHitGeometry: async () => {},
    setInteractionMode: async (interactionMode) => { updateState({ interactionMode }); },
    requestTextInputFocus: async () => {},
    releaseTextInputFocus: async () => {},
    setPrivacyMode: async (privacyMode) => { updateState({ privacyMode }); },
    setAlwaysOnTop: async () => {},
    setLocked: async (locked) => { updateState({ locked }); },
    dragBy: async (deltaX, deltaY) => {
      if (!state.locked) options.onDragBy?.(deltaX, deltaY);
    },
    setPetScale: async (petScale) => {
      const extraWidth = Math.ceil(244 * (Math.max(1, petScale) - 1));
      updateState({
        petScale,
        contentSizeCssPx: { width: 560 + extraWidth, height: 520 },
      });
    },
    setPetModeEnabled: async (petModeEnabled) => {
      updateState({ petModeEnabled, visible: petModeEnabled });
      if (!petModeEnabled) options.onHide?.();
    },
    openMainRoute: async (route) => {
      if (options.onOpenMainRoute) {
        options.onOpenMainRoute(route);
        return;
      }
      if (typeof window !== "undefined") window.location.assign(browserRoutePath(route));
    },
    hidePet: async () => {
      updateState({ visible: false });
      options.onHide?.();
    },
    moveToSafePosition: async () => { options.onMoveToSafePosition?.(); },
    onWindowStateChanged: (callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
    onLifecycleEvent: () => () => {},
  };
}

function browserRoutePath(route: AllowedMainRouteV1): string {
  switch (route.kind) {
    case "conversation":
      return route.conversationId
        ? `/companion/conversations?conversation=${encodeURIComponent(route.conversationId)}`
        : "/companion/conversations";
    case "settings":
      return `/settings?section=${encodeURIComponent(route.section)}`;
    case "review":
      return "/review";
    case "card":
      return `/cards/${encodeURIComponent(route.cardId)}`;
    case "star_map":
      return route.keyPointId
        ? `/knowledge?keyPoint=${encodeURIComponent(route.keyPointId)}`
        : "/knowledge";
    case "learning_session":
      return `/cards/${encodeURIComponent(route.cardId)}/companion?session=${encodeURIComponent(route.sessionId)}`;
  }
}
