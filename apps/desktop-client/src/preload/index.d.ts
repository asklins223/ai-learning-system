import type { AILearnWindowState } from '../shared/window-state'
import type { AILearnDesktopApiM2 } from '@ailearn/shared/desktop-ipc-contracts'

export type { AILearnWindowState } from '../shared/window-state'
export type { AILearnDesktopApiM1, AILearnDesktopApiM2 } from '@ailearn/shared/desktop-ipc-contracts'

export interface AILearnDesktopApi {
  readonly platform: string
  setTitleBarTheme: (theme: 'day' | 'night') => void
  onWindowState: (listener: (state: AILearnWindowState) => void) => () => void
}

declare global {
  interface Window {
    ailearnDesktop: AILearnDesktopApi
    ailearn: AILearnDesktopApiM2
  }
}
