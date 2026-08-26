export const WINDOW_STATE_CHANNEL = 'window:state-changed'
export const WINDOW_STATE_SNAPSHOT_CHANNEL = 'window:get-state'

export type AILearnWindowState = 'visible' | 'hidden' | 'minimized'

export interface WindowStateSnapshot {
  readonly state: AILearnWindowState
  readonly revision: number
}

export function isWindowStateSnapshot(value: unknown): value is WindowStateSnapshot {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Partial<WindowStateSnapshot>

  return (
    (candidate.state === 'visible' ||
      candidate.state === 'hidden' ||
      candidate.state === 'minimized') &&
    Number.isSafeInteger(candidate.revision) &&
    typeof candidate.revision === 'number' &&
    candidate.revision >= 0
  )
}
