import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  protocol,
  session,
  systemPreferences,
  type WebContents
} from 'electron'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { createAssetResponsePlan, mimeTypeForPath } from './asset-response'
import { nativeWindowChrome, titleBarOverlayForTheme } from './window-chrome'
import {
  WINDOW_STATE_CHANNEL,
  WINDOW_STATE_SNAPSHOT_CHANNEL,
  type AILearnWindowState,
  type WindowStateSnapshot
} from '../shared/window-state'
import { registerM1DesktopIpc } from './desktop-ipc'
import { FilePendingReturnMarkerStore } from './pending-return-marker-store'

const APP_SCHEME = 'ailearn-app'
const APP_HOST = 'bundle'
const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
      stream: true
    }
  }
])

function response(
  status: number,
  message: string,
  method: string,
  extraHeaders: Readonly<Record<string, string>> = {}
): Response {
  const body = method === 'HEAD' ? null : message

  return new Response(body, {
    status,
    headers: {
      'Content-Length': String(Buffer.byteLength(message)),
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders
    }
  })
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)

  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

function registerAppProtocol(): void {
  const rendererRoot = resolve(__dirname, '../renderer')

  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return response(405, 'Method not allowed', request.method, { Allow: 'GET, HEAD' })
    }

    let requestUrl: URL

    try {
      requestUrl = new URL(request.url)
    } catch {
      return response(400, 'Invalid request URL', request.method)
    }

    if (
      requestUrl.hostname !== APP_HOST ||
      requestUrl.username !== '' ||
      requestUrl.password !== '' ||
      requestUrl.port !== ''
    ) {
      return response(403, 'Forbidden', request.method)
    }

    let requestedPath: string

    try {
      requestedPath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '')
    } catch {
      return response(400, 'Invalid path encoding', request.method)
    }

    if (requestedPath.includes('\0')) return response(400, 'Invalid path', request.method)

    const assetPath = requestedPath || 'index.html'
    const absolutePath = resolve(rendererRoot, assetPath)

    if (!isWithin(rendererRoot, absolutePath)) {
      return response(403, 'Forbidden', request.method)
    }

    let rendererRealPath: string
    let assetRealPath: string

    try {
      const resolvedPaths = await Promise.all([
        realpath(rendererRoot),
        realpath(absolutePath)
      ])
      rendererRealPath = resolvedPaths[0]
      assetRealPath = resolvedPaths[1]
    } catch {
      return response(404, 'Not found', request.method)
    }

    if (!isWithin(rendererRealPath, assetRealPath)) {
      return response(403, 'Forbidden', request.method)
    }

    let assetStat

    try {
      assetStat = await stat(assetRealPath)
    } catch {
      return response(404, 'Not found', request.method)
    }

    if (!assetStat.isFile()) return response(404, 'Not found', request.method)

    const plan = createAssetResponsePlan(
      request.method,
      assetStat.size,
      mimeTypeForPath(assetRealPath),
      request.headers.get('range')
    )

    if (!plan.bodyRange) {
      return new Response(null, { status: plan.status, headers: plan.headers })
    }

    const fileStream = createReadStream(assetRealPath, plan.bodyRange)
    return new Response(Readable.toWeb(fileStream), {
      status: plan.status,
      headers: plan.headers
    })
  })
}

function configuredDevOrigin(): string | undefined {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL

  if (!rendererUrl) return undefined

  try {
    const url = new URL(rendererUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

function rendererWebSocketOrigin(devOrigin: string): string {
  const url = new URL(devOrigin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.origin
}

function rendererContentSecurityPolicy(): string {
  const devOrigin = configuredDevOrigin()
  const devConnectSources = devOrigin
    ? ` ${devOrigin} ${rendererWebSocketOrigin(devOrigin)}`
    : ''
  // Vite's React refresh preamble is an inline script in development. Keep
  // this exception scoped to the dev server; packaged renderer pages retain a
  // strict script policy without `unsafe-inline`.
  const devScriptSources = devOrigin ? " 'unsafe-inline'" : ''

  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'${devScriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "font-src 'self' data:",
    `connect-src 'self' blob:${devConnectSources}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join('; ')
}

function isAllowedRendererRequest(target: string): boolean {
  if (target.startsWith('blob:') || target.startsWith('data:')) return true

  try {
    const targetUrl = new URL(target)
    const developmentOrigin = configuredDevOrigin()

    if (developmentOrigin) {
      return targetUrl.origin === developmentOrigin || targetUrl.origin === rendererWebSocketOrigin(developmentOrigin)
    }

    return (
      targetUrl.protocol === `${APP_SCHEME}:` &&
      targetUrl.hostname === APP_HOST &&
      targetUrl.username === '' &&
      targetUrl.password === '' &&
      targetUrl.port === ''
    )
  } catch {
    return false
  }
}

function registerRendererSecurityPolicy(): void {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>', `${APP_SCHEME}://${APP_HOST}/*`] },
    (details, callback) => {
      callback({ cancel: !isAllowedRendererRequest(details.url) })
    }
  )

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['<all_urls>', `${APP_SCHEME}://${APP_HOST}/*`] },
    (details, callback) => {
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
        callback({ responseHeaders: details.responseHeaders })
        return
      }

      const responseHeaders = { ...details.responseHeaders }
      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase() === 'content-security-policy') delete responseHeaders[key]
      }
      responseHeaders['Content-Security-Policy'] = [rendererContentSecurityPolicy()]
      callback({ responseHeaders })
    }
  )
}

function isAllowedNavigation(target: string): boolean {
  try {
    const targetUrl = new URL(target)
    const developmentOrigin = configuredDevOrigin()

    if (developmentOrigin) {
      return targetUrl.origin === developmentOrigin
    }

    return (
      targetUrl.protocol === `${APP_SCHEME}:` &&
      targetUrl.hostname === APP_HOST &&
      targetUrl.username === '' &&
      targetUrl.password === '' &&
      targetUrl.port === ''
    )
  } catch {
    return false
  }
}

function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  contents.on('will-navigate', (event, target) => {
    if (!isAllowedNavigation(target)) event.preventDefault()
  })

  contents.on('will-redirect', (event, target) => {
    if (!isAllowedNavigation(target)) event.preventDefault()
  })

  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

function windowFor(contents: WebContents, sourceUrl: string): BrowserWindow | null {
  if (!isAllowedNavigation(contents.getURL()) || !isAllowedNavigation(sourceUrl)) return null

  const window = BrowserWindow.fromWebContents(contents)
  return window && !window.isDestroyed() ? window : null
}

function registerWindowIpc(): void {
  ipcMain.on('window:set-titlebar-theme', (event, theme: unknown) => {
    const window = windowFor(event.sender, event.senderFrame?.url ?? '')

    if (!window || process.platform === 'darwin' || (theme !== 'day' && theme !== 'night')) return
    window.setTitleBarOverlay(titleBarOverlayForTheme(theme))
  })

  ipcMain.handle(WINDOW_STATE_SNAPSHOT_CHANNEL, (event): WindowStateSnapshot | null => {
    const window = windowFor(event.sender, event.senderFrame?.url ?? '')
    return window ? windowStateSnapshot(window) : null
  })
}

const windowStateRevisions = new WeakMap<BrowserWindow, number>()
const publishedWindowStates = new WeakMap<BrowserWindow, AILearnWindowState>()

function currentWindowState(window: BrowserWindow): AILearnWindowState {
  if (window.isMinimized()) return 'minimized'
  return window.isVisible() ? 'visible' : 'hidden'
}

function windowStateSnapshot(window: BrowserWindow): WindowStateSnapshot {
  return synchronizeWindowState(window).snapshot
}

function synchronizeWindowState(window: BrowserWindow): {
  readonly changed: boolean
  readonly snapshot: WindowStateSnapshot
} {
  const state = currentWindowState(window)
  const changed = publishedWindowStates.get(window) !== state
  const revision = (windowStateRevisions.get(window) ?? 0) + (changed ? 1 : 0)

  windowStateRevisions.set(window, revision)
  publishedWindowStates.set(window, state)

  return { changed, snapshot: { state, revision } }
}

function publishWindowState(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return

  const { changed, snapshot } = synchronizeWindowState(window)
  if (changed) window.webContents.send(WINDOW_STATE_CHANNEL, snapshot)
}

function registerWindowLifecycle(window: BrowserWindow): void {
  windowStateRevisions.set(window, 0)
  publishedWindowStates.set(window, currentWindowState(window))

  window.on('show', () => publishWindowState(window))
  window.on('hide', () => publishWindowState(window))
  window.on('minimize', () => publishWindowState(window))
  window.on('restore', () => publishWindowState(window))
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 810,
    minWidth: 1024,
    minHeight: 700,
    useContentSize: true,
    show: false,
    ...nativeWindowChrome(process.platform),
    autoHideMenuBar: true,
    backgroundColor: '#211914',
    title: 'AI Learn',
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
      safeDialogs: true
    }
  })

  registerWindowLifecycle(window)

  window.once('ready-to-show', () => {
    window.show()
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL

  if (rendererUrl) await window.loadURL(rendererUrl)
  else await window.loadURL(APP_URL)

  return window
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  registerAppProtocol()
  registerRendererSecurityPolicy()
  registerWindowIpc()
  registerM1DesktopIpc({
    resolveWindow: windowFor,
    getWindowState: windowStateSnapshot,
    setTitlebarTheme: (window, theme) => {
      if (process.platform === 'darwin') return false
      window.setTitleBarOverlay(titleBarOverlayForTheme(theme))
      return true
    },
    getReducedMotion: () => {
      try {
        return !systemPreferences.getAnimationSettings().shouldRenderRichAnimation
      } catch {
        return false
      }
    },
    pendingReturnMarkerStore: new FilePendingReturnMarkerStore(
      resolve(app.getPath('userData'), 'pending-return-markers-v2.json')
    )
  })

  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents)
  })

  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })

  await createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
