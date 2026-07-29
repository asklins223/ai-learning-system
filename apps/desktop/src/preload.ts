/**
 * Preload bridge — exposes a minimal, type-safe API to the renderer process.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktopAPI", {
  /** Subscribe to status updates from the main process. */
  onStatus: (callback: (status: string, detail?: string) => void) =>
    ipcRenderer.on("desktop:status", (_event, status: string, detail?: string) =>
      callback(status, detail),
    ),

  /** Subscribe to log line updates. */
  onLog: (callback: (line: string) => void) =>
    ipcRenderer.on("desktop:log", (_event, line: string) => callback(line)),

  /** Retry the startup sequence. */
  retry: () => ipcRenderer.send("desktop:retry"),

  /** Open external URLs in the system browser. */
  openExternal: (url: string) => ipcRenderer.send("desktop:open-external", url),

  /** Quit the app. */
  quit: () => ipcRenderer.send("desktop:quit"),

  /** Get the current version. */
  getVersion: () => ipcRenderer.invoke("desktop:get-version"),
});
