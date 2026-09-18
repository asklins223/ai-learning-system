import { describe, expect, it } from 'vitest'
import { resolveWindowState } from './window-state'

describe('window activity state', () => {
  it('pauses room activity when a visible window loses focus', () => {
    expect(resolveWindowState({ minimized: false, visible: true, focused: false })).toBe('hidden')
  })

  it('reports visible only while the window is both shown and focused', () => {
    expect(resolveWindowState({ minimized: false, visible: true, focused: true })).toBe('visible')
    expect(resolveWindowState({ minimized: false, visible: false, focused: true })).toBe('hidden')
  })

  it('keeps minimized as the strongest inactivity signal', () => {
    expect(resolveWindowState({ minimized: true, visible: true, focused: true })).toBe('minimized')
  })
})
