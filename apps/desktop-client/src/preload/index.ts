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
    getSurfaceManifest: (input) => invoke(DESKTOP_IPC_CHANNELS.authGetSurfaceManifest, input),
    getState: (input) => invoke(DESKTOP_IPC_CHANNELS.authGetState, input),
    login: (input) => invoke(DESKTOP_IPC_CHANNELS.authLogin, input),
    register: (input) => invoke(DESKTOP_IPC_CHANNELS.authRegister, input),
    logout: (input) => invoke(DESKTOP_IPC_CHANNELS.authLogout, input),
    reauthenticate: (input) => invoke(DESKTOP_IPC_CHANNELS.authReauthenticate, input),
    changePassword: (input) => invoke(DESKTOP_IPC_CHANNELS.authChangePassword, input),
    joinWorkspace: (input) => invoke(DESKTOP_IPC_CHANNELS.authJoinWorkspace, input),
    // 旧版设置页回补（2026-09-18）：档案、头像与退出协作工作区。
    getProfile: (input) => invoke(DESKTOP_IPC_CHANNELS.authProfileGet, input),
    updateProfile: (input) => invoke(DESKTOP_IPC_CHANNELS.authUpdateProfile, input),
    uploadAvatar: (input) => invoke(DESKTOP_IPC_CHANNELS.authUploadAvatar, input),
    getAvatar: (input) => invoke(DESKTOP_IPC_CHANNELS.authAvatarGet, input),
    leaveWorkspace: (input) => invoke(DESKTOP_IPC_CHANNELS.authLeaveWorkspace, input)
  },
  workspace: {
    list: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceList, input),
    switch: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceSwitch, input),
    getCurrent: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceGetCurrent, input),
    getAiSettings: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceAiSettingsGet, input),
    updateAiConsent: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceAiConsentUpdate, input),
    updateAiDataPolicy: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceAiDataPolicyUpdate, input),
    export: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceExport, input),
    rename: (input) => invoke(DESKTOP_IPC_CHANNELS.workspaceRename, input)
  },
  // SEC-02 / ADR-0009：Owner 的邀请发出与成员管理。
  invites: {
    create: (input) => invoke(DESKTOP_IPC_CHANNELS.inviteCreate, input),
    list: (input) => invoke(DESKTOP_IPC_CHANNELS.inviteList, input),
    revoke: (input) => invoke(DESKTOP_IPC_CHANNELS.inviteRevoke, input)
  },
  members: {
    list: (input) => invoke(DESKTOP_IPC_CHANNELS.memberList, input),
    remove: (input) => invoke(DESKTOP_IPC_CHANNELS.memberRemove, input)
  },
  markdownImport: {
    run: (input) => invoke(DESKTOP_IPC_CHANNELS.settingsMarkdownImport, input)
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
      speak: (input) => invoke(DESKTOP_IPC_CHANNELS.companionVoiceSpeak, input),
      speakSegment: (input) => invoke(DESKTOP_IPC_CHANNELS.companionVoiceSpeakSegment, input),
      // 语音转文本（2026-09-18）：本地 SenseVoice 优先，这条云通道是兜底。
      transcribe: (input) => invoke(DESKTOP_IPC_CHANNELS.companionVoiceTranscribe, input)
    },
    // 聊天发送链路（2026-09-18）：建/复用 dialogue → 发 turn → 轮询消息。
    chat: {
      ensureConversation: (input) => invoke(DESKTOP_IPC_CHANNELS.companionChatEnsureConversation, input),
      sendTurn: (input) => invoke(DESKTOP_IPC_CHANNELS.companionChatSendTurn, input),
      listMessages: (input) => invoke(DESKTOP_IPC_CHANNELS.companionChatListMessages, input),
      // 提案确认 + agent 导航 route 轮询（2026-09-18 补接线）。
      getProposal: (input) => invoke(DESKTOP_IPC_CHANNELS.companionChatProposalGet, input),
      decideProposal: (input) => invoke(DESKTOP_IPC_CHANNELS.companionChatProposalDecide, input),
      listAgentRoutes: (input) => invoke(DESKTOP_IPC_CHANNELS.companionChatAgentRoutes, input),
      // 过程节点留痕（2026-09-19）：抽屉里的「过程 N 步 · 调用 M 次工具」。
      listRunNodes: (input) => invoke(DESKTOP_IPC_CHANNELS.companionChatRunNodes, input),
      // 念头主动开场（切片④）：点击念头气泡，她先开口。
      openThought: (input) => invoke(DESKTOP_IPC_CHANNELS.companionChatOpenThought, input),
      // 停止本轮（2026-09-19）：服务端原子取消 + 已输出文本留档。
      cancelRun: (input) => invoke(DESKTOP_IPC_CHANNELS.companionChatCancelRun, input)
    },
    learningRun: {
      getContext: (input) => invoke(DESKTOP_IPC_CHANNELS.companionLearningRunGetContext, input),
      createContextGrant: (input) => invoke(DESKTOP_IPC_CHANNELS.companionLearningRunCreateContextGrant, input)
    },
    account: {
      getState: (input) => invoke(DESKTOP_IPC_CHANNELS.companionAccountGetState, input),
      patchState: (input) => invoke(DESKTOP_IPC_CHANNELS.companionAccountPatchState, input),
      transitionOnboarding: (input) => invoke(DESKTOP_IPC_CHANNELS.companionOnboardingTransition, input)
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
      remove: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryDelete, input),
      create: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryCreate, input),
      correct: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryCorrect, input),
      dismiss: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryDismiss, input),
      conflicts: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryConflicts, input),
      resolveConflict: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryResolveConflict, input),
      rebuildEmbeddings: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryRebuildEmbeddings, input),
      clear: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemoryClear, input),
      summarizeRecent: (input) => invoke(DESKTOP_IPC_CHANNELS.companionMemorySummarizeRecent, input)
    },
    daily: {
      get: (input) => invoke(DESKTOP_IPC_CHANNELS.companionDailyGet, input)
    },
    persona: {
      get: (input) => invoke(DESKTOP_IPC_CHANNELS.companionPersonaGet, input),
      patch: (input) => invoke(DESKTOP_IPC_CHANNELS.companionPersonaPatch, input),
      reset: (input) => invoke(DESKTOP_IPC_CHANNELS.companionPersonaReset, input)
    },
    history: {
      list: (input) => invoke(DESKTOP_IPC_CHANNELS.companionHistoryList, input),
      search: (input) => invoke(DESKTOP_IPC_CHANNELS.companionHistorySearch, input),
      clear: (input) => invoke(DESKTOP_IPC_CHANNELS.companionHistoryClear, input)
    },
    learningContext: {
      get: (input) => invoke(DESKTOP_IPC_CHANNELS.companionLearningContextGet, input)
    },
    journey: {
      bootstrap: (input) => invoke(DESKTOP_IPC_CHANNELS.companionJourneyBootstrap, input),
      get: (input) => invoke(DESKTOP_IPC_CHANNELS.companionJourneyGet, input),
      actOnInvitation: (input) => invoke(DESKTOP_IPC_CHANNELS.companionInvitationAction, input),
      act: (input) => invoke(DESKTOP_IPC_CHANNELS.companionJourneyAction, input)
    },
    activity: {
      timeline: (input) => invoke(DESKTOP_IPC_CHANNELS.companionActivityTimeline, input),
      present: (input) => invoke(DESKTOP_IPC_CHANNELS.companionActivityPresent, input),
      ack: (input) => invoke(DESKTOP_IPC_CHANNELS.companionActivityAck, input)
    },
    bridge: {
      setContext: (input) => invoke(DESKTOP_IPC_CHANNELS.companionBridgeSetContext, input),
      clearContext: (input) => invoke(DESKTOP_IPC_CHANNELS.companionBridgeClearContext, input)
    },
    data: {
      export: (input) => invoke(DESKTOP_IPC_CHANNELS.companionDataExport, input),
      deleteAudit: (input) => invoke(DESKTOP_IPC_CHANNELS.companionAuditDelete, input)
    },
    // 任务 14：作答模态偏好（账号级跨设备）。
    answerMode: {
      get: (input) => invoke(DESKTOP_IPC_CHANNELS.companionAnswerModeGet, input),
      patch: (input) => invoke(DESKTOP_IPC_CHANNELS.companionAnswerModePatch, input)
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
    global: (input) => invoke(DESKTOP_IPC_CHANNELS.searchGlobal, input),
    drift: (input) => invoke(DESKTOP_IPC_CHANNELS.searchDriftGet, input),
    reindex: (input) => invoke(DESKTOP_IPC_CHANNELS.searchReindex, input)
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
    revealTarget: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunRevealTarget, input),
    getReturnContract: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunGetReturnContract, input),
    recordActivityLease: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunRecordActivityLease, input),
    abandon: (input) => invoke(DESKTOP_IPC_CHANNELS.learningRunAbandon, input)
  }
}

contextBridge.exposeInMainWorld('ailearnDesktop', Object.freeze(api))
contextBridge.exposeInMainWorld('ailearn', deepFreeze(desktopApi))
