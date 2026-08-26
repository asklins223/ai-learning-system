import { describe, expect, it } from 'vitest'
import { nativeWindowChrome, titleBarOverlayForTheme } from './window-chrome'

describe('native window chrome', () => {
  it('keeps the macOS traffic lights over full-size content', () => {
    expect(nativeWindowChrome('darwin')).toEqual({
      frame: true,
      titleBarStyle: 'hiddenInset'
    })
  })

  it('keeps the Windows caption buttons in a transparent overlay', () => {
    expect(nativeWindowChrome('win32')).toEqual({
      frame: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#33251d',
        height: 40
      }
    })
  })

  it('keeps native symbols legible in both room themes', () => {
    expect(titleBarOverlayForTheme('day').symbolColor).toBe('#33251d')
    expect(titleBarOverlayForTheme('night').symbolColor).toBe('#f6ead7')
  })
})
