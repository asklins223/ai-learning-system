import { describe, expect, it } from 'vitest'
import { resolveWindowState } from './window-state'

describe('window activity state', () => {
  /**
   * 焦点不参与这条判断（方案 35 E7，2026-09-23 用户确认推翻旧口径）。
   * 旧实现写着 `visible && focused`，本文件当时还有一条用例把它**当成正确行为钉住**：
   * "pauses room activity when a visible window loses focus" —— 断言的是缺陷本身。
   */
  it('可见但没聚焦，仍然算可见：副屏与并排窗口不是离场', () => {
    expect(resolveWindowState({ minimized: false, visible: true })).toBe('visible')
  })

  it('看不见才算 hidden', () => {
    expect(resolveWindowState({ minimized: false, visible: false })).toBe('hidden')
  })

  it('keeps minimized as the strongest inactivity signal', () => {
    expect(resolveWindowState({ minimized: true, visible: true })).toBe('minimized')
    expect(resolveWindowState({ minimized: true, visible: false })).toBe('minimized')
  })
})
