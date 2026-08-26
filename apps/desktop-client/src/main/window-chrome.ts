import type { BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron'

export type NativeTitleBarTheme = 'day' | 'night'

export function titleBarOverlayForTheme(theme: NativeTitleBarTheme): TitleBarOverlay {
  return {
    color: '#00000000',
    symbolColor: theme === 'day' ? '#33251d' : '#f6ead7',
    height: 40
  }
}

export function nativeWindowChrome(
  platform: NodeJS.Platform
): Pick<BrowserWindowConstructorOptions, 'frame' | 'titleBarStyle' | 'titleBarOverlay'> {
  if (platform === 'darwin') {
    return {
      frame: true,
      titleBarStyle: 'hiddenInset'
    }
  }

  return {
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayForTheme('day')
  }
}
