/**
 * Preload bridge — minimal, no-op in the current architecture.
 *
 * The splash window was removed; the main window loads the web app directly.
 * Kept for future use (e.g. native menu integration, file dialogs).
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktopAPI", {
  /** Open external URLs in the system browser. */
  openExternal: (url: string) => ipcRenderer.send("desktop:open-external", url),

  /** Quit the app. */
  quit: () => ipcRenderer.send("desktop:quit"),

  /** Get the current app version. */
  getVersion: () => ipcRenderer.invoke("desktop:get-version"),
});
