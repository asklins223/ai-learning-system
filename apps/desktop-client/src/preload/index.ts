import { contextBridge, ipcRenderer } from 'electron'

import type { AILearnDesktopApi } from './index.d'
import {
  DESKTOP_IPC_CHANNELS,
  desktopContractSnapshotSchema,
  gatewayEventSchema,
  type AILearnDesktopApiM2,
  type GatewayEventV1
} from '@ailearn/shared/desktop-ipc-contracts'
import {
  WINDOW_STATE_CHANNEL,
  WINDOW_STATE_SNAPSHOT_CHANNEL,
  isWindowStateSnapshot,
  type WindowStateSnapshot
} from '../shared/window-state'

const api: AILearnDesktopApi = {
  platform: process.platform,
  setTitleBarTheme: (theme) => ipcRenderer.send('window:set-titlebar-theme', theme),
  onWindowState: (listener) => {
    let active = true
    let latestRevision = -1

    const deliver = (snapshot: unknown): void => {
      if (!active || !isWindowStateSnapshot(snapshot) || snapshot.revision <= latestRevision) return

      latestRevision = snapshot.revision
      listener(snapshot.state)
    }

    const handleState = (_event: Electron.IpcRendererEvent, snapshot: unknown): void => {
      deliver(snapshot)
    }

    ipcRenderer.on(WINDOW_STATE_CHANNEL, handleState)
    void ipcRenderer
      .invoke(WINDOW_STATE_SNAPSHOT_CHANNEL)
      .then((snapshot: WindowStateSnapshot | null) => deliver(snapshot))
      .catch(() => undefined)

    return () => {
      active = false
      ipcRenderer.removeListener(WINDOW_STATE_CHANNEL, handleState)
    }
  }
}

const contract = desktopContractSnapshotSchema.parse(
  ipcRenderer.sendSync(DESKTOP_IPC_CHANNELS.contractGetSnapshot),
)

function invoke<T>(channel: string, input: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, input) as Promise<T>
}

function deepFreeze<T>(value: T): T {
  if (value && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

const desktopApi: AILearnDesktopApiM2 = {
  contract,
  runtime: {
    getSnapshot: (input) => invoke(DESKTOP_IPC_CHANNELS.runtimeGetSnapshot, input),
    retryApiConnection: (input) => invoke(DESKTOP_IPC_CHANNELS.runtimeRetryApiConnection, input),
    getHealth: (input) => invoke(DESKTOP_IPC_CHANNELS.runtimeGetHealth, input),
    cancel: (input) => invoke(DESKTOP_IPC_CHANNELS.runtimeCancel, input)
  },
  navigation: {
    resolve: (input) => invoke(DESKTOP_IPC_CHANNELS.navigationResolve, input),
    go: (input) => invoke(DESKTOP_IPC_CHANNELS.navigationGo, input),
    back: (input) => invoke(DESKTOP_IPC_CHANNELS.navigationBack, input),
    restore: (input) => invoke(DESKTOP_IPC_CHANNELS.navigationRestore, input)
  },
  auth: {
    getState: (input) => invoke(DESKTOP_IPC_CHANNELS.authGetState, input),
    login: (input) => invoke(DESKTOP_IPC_CHANNELS.authLogin, input),
    register: (input) => invoke(DESKTOP_IPC_CHANNELS.authRegister, input),
    logout: (input) => invoke(DESKTOP_IPC_CHANNELS.authLogout, input),
    reauthenticate: (input) => invoke(DESKTOP_IPC_CHANNELS.authReauthenticate, input),
    changePassword: (input) => invoke(DESKTOP_IPC_CHANNELS.authChangePassword, input)
  },
  workspace: {
    list: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceList, input),
    switch: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceSwitch, input),
    getCurrent: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceGetCurrent, input)
  },
  capabilities: {
    get: (input) => invoke(DESKTOP_IPC_CHANNELS.capabilitiesGet, input)
  },
  window: {
    getState: (input) => invoke(DESKTOP_IPC_CHANNELS.windowGetState, input),
    setTitlebarTheme: (input) => invoke(DESKTOP_IPC_CHANNELS.windowSetTitlebarTheme, input),
    focus: (input) => invoke(DESKTOP_IPC_CHANNELS.windowFocus, input)
  },
  room: {
    getProjection: (input) => invoke(DESKTOP_IPC_CHANNELS.roomGetProjection, input)
  },
  note: {
    get: (input) => invoke(DESKTOP_IPC_CHANNELS.noteGet, input),
    save: (input) => invoke(DESKTOP_IPC_CHANNELS.noteSave, input),
    cardGeneration: {
      start: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationStart, input),
      getRun: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationGetRun, input),
      getCandidates: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationGetCandidates, input),
      review: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationReview, input),
      reveal: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationReveal, input),
      activate: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationActivate, input),
      cancel: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationCancel, input),
      close: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationClose, input)
    }
  },
  subscriptions: {
    subscribe: (input) => invoke(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe, input),
    onEvent: (subscriptionId, listener) => {
      let active = true
      const handleEvent = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        if (!active) return
        const parsed = gatewayEventSchema.safeParse(raw)
        if (!parsed.success || parsed.data.subscriptionId !== subscriptionId) return
        listener(parsed.data as GatewayEventV1)
      }
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.subscriptionsEvent, handleEvent)
      return () => {
        active = false
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.subscriptionsEvent, handleEvent)
      }
    },
    unsubscribe: (input) => invoke(DESKTOP_IPC_CHANNELS.subscriptionsUnsubscribe, input)
  },
  review: {
    getQueue: (input) => invoke(DESKTOP_IPC_CHANNELS.reviewGetQueue, input)
  },
  learningRun: {
    get: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunGet, input),
    start: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunStart, input),
    getDraft: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunGetDraft, input),
    saveDraft: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunSaveDraft, input),
    submit: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunSubmit, input),
    action: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunAction, input),
    getResult: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunGetResult, input),
    getReturnContract: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunGetReturnContract, input),
    recordActivityLease: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunRecordActivityLease, input),
    abandon: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunAbandon, input)
  }
}

contextBridge.exposeInMainWorld('ailearnDesktop', Object.freeze(api))
contextBridge.exposeInMainWorld('ailearn', deepFreeze(desktopApi))
