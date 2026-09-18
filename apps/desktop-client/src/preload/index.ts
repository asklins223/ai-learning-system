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
    changePassword: (input) => invoke(DESKTOP_IPC_CHANNELS.authChangePassword, input),
    joinWorkspace: (input) => invoke(DESKTOP_IPC_CHANNELS.authJoinWorkspace, input)
  },
  workspace: {
    list: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceList, input),
    switch: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceSwitch, input),
    getCurrent: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceGetCurrent, input),
    getAiSettings: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceAiSettingsGet, input),
    updateAiConsent: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceAiConsentUpdate, input),
    updateAiDataPolicy: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceAiDataPolicyUpdate, input),
    export: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceExport, input)
  },
  capabilities: {
    get: (input) => invoke(DESKTOP_IPC_CHANNELS.capabilitiesGet, input)
  },
  clipboard: {
    readLinks: (input) => invoke(DESKTOP_IPC_CHANNELS.clipboardReadLinks, input)
  },
  window: {
    getState: (input) => invoke(DESKTOP_IPC_CHANNELS.windowGetState, input),
    setTitlebarTheme: (input) => invoke(DESKTOP_IPC_CHANNELS.windowSetTitlebarTheme, input),
    focus: (input) => invoke(DESKTOP_IPC_CHANNELS.windowFocus, input)
  },
  room: {
    getProjection: (input) => invoke(DESKTOP_IPC_CHANNELS.roomGetProjection, input)
  },
  activity: {
    getToday: (input) => invoke(DESKTOP_IPC_CHANNELS.activityGetToday, input)
  },
  source: {
    list: (input) => invoke(DESKTOP_IPC_CHANNELS.sourceList, input),
    create: (input) => invoke(DESKTOP_IPC_CHANNELS.sourceCreate, input),
    get: (input) => invoke(DESKTOP_IPC_CHANNELS.sourceGet, input),
    listNotes: (input) => invoke(DESKTOP_IPC_CHANNELS.sourceNotes, input),
    update: (input) => invoke(DESKTOP_IPC_CHANNELS.sourceUpdate, input),
    createNote: (input) => invoke(DESKTOP_IPC_CHANNELS.sourceCreateNote, input),
    archive: (input) => invoke(DESKTOP_IPC_CHANNELS.sourceArchive, input),
    // 站内图片原始字节：正文引用是 `/api/uploads/…`，渲染层够不到 API 源，
    // 由 main 带会话令牌取回，这里只把那条通道接出来。
    getImage: (input) => invoke(DESKTOP_IPC_CHANNELS.sourceImageGet, input)
  },
  companion: {
    home: {
      getProjection: (input) => invoke(DESKTOP_IPC_CHANNELS.companionHomeGetProjection, input)
    },
    room: {
      getProfile: (input) => invoke(DESKTOP_IPC_CHANNELS.companionRoomGetProfile, input),
      patchProfile: (input) => invoke(DESKTOP_IPC_CHANNELS.companionRoomPatchProfile, input)
    },
    voice: {
      speak: (input) => invoke(DESKTOP_IPC_CHANNELS.companionVoiceSpeak, input)
    },
    account: {
      getState: (input) => invoke(DESKTOP_IPC_CHANNELS.companionAccountGetState, input),
      patchState: (input) => invoke(DESKTOP_IPC_CHANNELS.companionAccountPatchState, input)
    },
    // 伴星中心（页 20）：共同记录的读取与记忆裁决。这里没有对话发送通道。
    memory: {
      list: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryList, input),
      starMap: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryStarMap, input),
      confirm: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryConfirm, input),
      pin: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryPin, input),
      unpin: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryUnpin, input),
      archive: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryArchive, input),
      restore: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryRestore, input),
      remove: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryDelete, input)
    },
    daily: {
      get: (input) => invoke(DESKTOP_IPC_CHANNELS.companionDailyGet, input)
    },
    persona: {
      get: (input) => invoke(DESKTOP_IPC_CHANNELS.companionPersonaGet, input),
      patch: (input) => invoke(DESKTOP_IPC_CHANNELS.companionPersonaPatch, input),
      reset: (input) => invoke(DESKTOP_IPC_CHANNELS.companionPersonaReset, input)
    },
    conversations: {
      list: (input) => invoke(DESKTOP_IPC_CHANNELS.companionConversationsList, input)
    }
  },
  note: {
    list: (input) => invoke(DESKTOP_IPC_CHANNELS.noteList, input),
    create: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCreate, input),
    delete: (input) => invoke(DESKTOP_IPC_CHANNELS.noteDelete, input),
    restore: (input) => invoke(DESKTOP_IPC_CHANNELS.noteRestore, input),
    get: (input) => invoke(DESKTOP_IPC_CHANNELS.noteGet, input),
    save: (input) => invoke(DESKTOP_IPC_CHANNELS.noteSave, input),
    versions: (input) => invoke(DESKTOP_IPC_CHANNELS.noteVersions, input),
    restoreVersion: (input) => invoke(DESKTOP_IPC_CHANNELS.noteVersionRestore, input),
    // 编辑器里的图写进对象存储。渲染层不持有令牌也够不到 API 源，只交出字节，
    // 由 main 以 multipart 送出，回传的是可以写进正文的站内地址。
    uploadImage: (input) => invoke(DESKTOP_IPC_CHANNELS.noteImageUpload, input),
    cardGeneration: {
      start: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationStart, input),
      getRun: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationGetRun, input),
      getCandidates: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationGetCandidates, input),
      review: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationReview, input),
      reveal: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationReveal, input),
      exposure: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationExposure, input),
      latestRun: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationLatestRun, input),
      activate: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationActivate, input),
      cancel: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationCancel, input),
      retry: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationRetry, input),
      close: (input) => invoke(DESKTOP_IPC_CHANNELS.noteCardGenerationClose, input)
    }
  },
  objective: {
    list: (input) => invoke(DESKTOP_IPC_CHANNELS.objectiveList, input),
    get: (input) => invoke(DESKTOP_IPC_CHANNELS.objectiveGet, input)
  },
  understanding: {
    getTopology: (input) => invoke(DESKTOP_IPC_CHANNELS.understandingGetTopology, input)
  },
  search: {
    global: (input) => invoke(DESKTOP_IPC_CHANNELS.searchGlobal, input)
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
    getQueue: (input) => invoke(DESKTOP_IPC_CHANNELS.reviewGetQueue, input),
    defer: (input) => invoke(DESKTOP_IPC_CHANNELS.reviewDefer, input)
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
