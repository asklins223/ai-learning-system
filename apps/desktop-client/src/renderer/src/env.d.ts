/// <reference types="vite/client" />

import type { AILearnWindowState } from "../../shared/window-state";
import type { AILearnDesktopApiM2 } from "@ailearn/shared/desktop-ipc-contracts";

type DesktopBridge = {
  platform: string;
  setTitleBarTheme: (theme: "day" | "night") => void;
  onWindowState: (listener: (state: AILearnWindowState) => void) => () => void;
};

declare global {
  interface Window {
    ailearnDesktop?: DesktopBridge;
    ailearn: AILearnDesktopApiM2;
  }
}

export {};
