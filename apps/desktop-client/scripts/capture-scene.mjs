import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review')
await mkdir(reviewRoot, { recursive: true })

const errors = []
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-room-review-'))
const electronApp = await electron.launch({ args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`], cwd: appRoot, executablePath })
const captureOwnerCredentialsAvailable = Boolean(process.env.OWNER_EMAIL?.trim() && process.env.OWNER_PASSWORD)
const captureAuthMode = captureOwnerCredentialsAvailable ? 'owner' : 'anonymous'

const setSize = async (width, height, unlock = false) => {
  await electronApp.evaluate(({ BrowserWindow }, dimensions) => {
    const target = BrowserWindow.getAllWindows()[0]
    if (dimensions.unlock) target?.setMinimumSize(1, 1)
    target?.setContentSize(dimensions.width, dimensions.height)
    target?.center()
  }, { width, height, unlock })
}

const settleSurface = (window) => window.waitForTimeout(900)

async function writeCaptureRuntime(window, captureMode, gateBoundary = null) {
  const processRuntime = await electronApp.evaluate(() => ({
    electronVersion: process.versions.electron ?? 'unknown',
    chromiumVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    platform: process.platform,
    osVersion: process.getSystemVersion?.() ?? 'unknown',
    arch: process.arch,
  }))
  await window.evaluate(async () => {
    if (!document.fonts) return
    await Promise.all([
      document.fonts.load('400 16px "Noto Sans SC Variable"'),
      document.fonts.load('400 16px "Noto Serif SC Variable"'),
    ])
  })
  const rendererRuntime = await window.evaluate(() => {
    const app = document.querySelector('.desktop-app')
    const fontEntries = document.fonts
      ? [...document.fonts].map((font) => ({ family: font.family, status: font.status, style: font.style, weight: font.weight }))
      : []
    const fontStacks = Object.fromEntries(
      ['body', '.scene-stage', '.study-workbench', '.action-rail']
        .map((selector) => [selector, getComputedStyle(document.querySelector(selector) ?? document.body).fontFamily]),
    )
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      deviceScaleFactor: window.devicePixelRatio,
      zoomFactor: window.visualViewport?.scale ?? 1,
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      theme: app?.getAttribute('data-theme') ?? 'day',
      motionMode: app?.getAttribute('data-motion-mode') ?? 'full',
      mediaMode: document.querySelector('.window-ambient-video--ready') ? 'enabled' : 'poster-only',
      fontStatus: document.fonts?.status ?? 'unavailable',
      fontEntries,
      fontStacks,
    }
  })
  await writeFile(
    resolve(reviewRoot, 'capture-runtime.json'),
    `${JSON.stringify({ ...processRuntime, ...rendererRuntime, captureMode, authMode: captureAuthMode, ...(gateBoundary ? { gateBoundary } : {}) }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    resolve(reviewRoot, 'capture-font-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, ...rendererRuntime, authMode: captureAuthMode, source: 'runtime-computed-fonts' }, null, 2)}\n`,
    'utf8',
  )
}

async function readGateBoundary(window) {
  return window.evaluate(() => {
    const gate = document.querySelector('.desktop-access-gate')
    return {
      present: gate instanceof HTMLElement,
      phase: gate?.querySelector('.desktop-access-gate__form')
        ? 'auth'
        : gate?.querySelector('.desktop-access-gate__workspace-list')
          ? 'workspace'
          : gate?.querySelector('.desktop-access-gate__notice')
            ? 'blocked'
            : 'loading',
      heading: gate?.querySelector('h1')?.textContent?.trim() ?? null,
      detail: gate?.querySelector('#desktop-gate-detail')?.textContent?.trim() ?? null,
      hasRoomDom: document.querySelector('.scene-stage') !== null,
      hasOnboarding: document.querySelector('.onboarding-card') !== null,
      hasActionRail: document.querySelector('.action-rail') !== null,
    }
  })
}

async function enterOwnerRoomThroughGate(window) {
  await window.waitForFunction(
    () => Boolean(document.querySelector('.action-rail')) || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator('.action-rail').count() === 0) {
    await window.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL)
    await window.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD)
    await window.getByRole('button', { name: '登录并继续' }).click()
  }

  const deadline = Date.now() + 30_000
  let workspaceChosen = false
  while (Date.now() < deadline && await window.locator('.action-rail').count() === 0) {
    const formError = window.locator('.desktop-access-gate__form-error')
    if (await formError.count()) throw new Error(`Owner Gate login failed: ${await formError.innerText()}`)
    const workspaceButtons = window.locator('.desktop-access-gate__workspace-list button')
    if (!workspaceChosen && await workspaceButtons.count()) {
      const ownerWorkspace = workspaceButtons.filter({ hasText: '所有者' }).first()
      await (await ownerWorkspace.count() ? ownerWorkspace : workspaceButtons.first()).click()
      workspaceChosen = true
    }
    const blockedNotice = window.locator('.desktop-access-gate__notice')
    if (await blockedNotice.count()) {
      const boundary = await readGateBoundary(window)
      throw new Error(`Owner Gate stopped before Room ready: ${JSON.stringify(boundary)}`)
    }
    await window.waitForTimeout(250)
  }
  await window.locator('.action-rail').waitFor({ state: 'visible', timeout: 1_000 })

  const session = await window.evaluate(async () => {
    const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const response = await window.ailearn.auth.getState({
      meta: {
        version: 1,
        contractVersion: window.ailearn.contract.contractVersion,
        requestId: opaqueId('capture-session-request'),
        correlationId: opaqueId('capture-session-correlation'),
        clientStartedAt: new Date().toISOString(),
      },
    })
    return response.ok
      ? { ok: true, status: response.data.status, role: response.data.membership?.role ?? null }
      : { ok: false, errorCode: response.error.code }
  })
  if (!session.ok || session.status !== 'authenticated' || session.role !== 'owner') {
    throw new Error(`Owner Gate did not reach an authenticated owner Room: ${JSON.stringify(session)}`)
  }
}

try {
  const window = await electronApp.firstWindow()
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  window.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  await window.waitForLoadState('domcontentloaded')
  await setSize(1440, 810)

  captureJourney: {
  if (!captureOwnerCredentialsAvailable) {
    await window.locator('.desktop-access-gate').waitFor({ state: 'visible', timeout: 20_000 })
    await window.waitForFunction(
      () => !document.querySelector('.desktop-access-gate__loading'),
      undefined,
      { timeout: 20_000 },
    ).catch(() => undefined)
    const gateBoundary = await readGateBoundary(window)
    if (!gateBoundary.present || gateBoundary.hasRoomDom || gateBoundary.hasOnboarding || gateBoundary.hasActionRail) {
      throw new Error(`Anonymous capture did not stop at the fail-closed DesktopAccessGate: ${JSON.stringify(gateBoundary)}`)
    }
    await writeCaptureRuntime(window, 'fail_closed_gate', gateBoundary)
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-access-gate.png') })
    await window.screenshot({ path: resolve(reviewRoot, 'desktop.png') })
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2)
    })
    await window.waitForTimeout(250)
    await window.locator('.desktop-access-gate__panel').scrollIntoViewIfNeeded()
    const zoom200 = await window.evaluate(() => {
      const gate = document.querySelector('.desktop-access-gate')
      const panel = document.querySelector('.desktop-access-gate__panel')
      const finalContent = gate?.querySelector('button:last-of-type, .desktop-access-gate__notice, .desktop-access-gate__loading')
      const panelRect = panel?.getBoundingClientRect()
      const finalRect = finalContent?.getBoundingClientRect()
      return {
        zoomFactor: 2,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        gate: gate instanceof HTMLElement
          ? {
              clientHeight: gate.clientHeight,
              scrollHeight: gate.scrollHeight,
              clientWidth: gate.clientWidth,
              scrollWidth: gate.scrollWidth,
              overflowY: getComputedStyle(gate).overflowY,
            }
          : null,
        panel: panelRect
          ? { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom }
          : null,
        finalContent: finalRect
          ? { top: finalRect.top, bottom: finalRect.bottom }
          : null,
      }
    })
    if (
      !zoom200.gate
      || !zoom200.panel
      || !zoom200.finalContent
      || zoom200.gate.overflowY !== 'auto'
      || zoom200.gate.scrollWidth > zoom200.gate.clientWidth + 1
      || zoom200.panel.left < -1
      || zoom200.panel.right > zoom200.viewport.width + 1
      || zoom200.finalContent.top < -1
      || zoom200.finalContent.bottom > zoom200.viewport.height + 1
    ) {
      throw new Error(`DesktopAccessGate 200% reflow drifted: ${JSON.stringify(zoom200)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-access-gate-zoom-200.json'), `${JSON.stringify(zoom200, null, 2)}\n`, 'utf8')
    const zoom200Image = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0]
      if (!target) throw new Error('DesktopAccessGate capture window disappeared')
      return (await target.webContents.capturePage()).toPNG().toString('base64')
    })
    await writeFile(resolve(reviewRoot, 'desktop-access-gate-zoom-200.png'), Buffer.from(zoom200Image, 'base64'))
    const normalizedErrors = errors.filter((message) => !message.includes('ResizeObserver loop'))
    if (normalizedErrors.length) throw new Error(`Renderer errors:\n${normalizedErrors.join('\n')}`)
    console.log(`Captured fail-closed DesktopAccessGate evidence in ${reviewRoot}`)
    break captureJourney
  }

  await enterOwnerRoomThroughGate(window)
  await window.locator('.scene-stage').waitFor({ state: 'visible', timeout: 20_000 })
  await window.waitForFunction(() => {
    const homeImages = [...document.querySelectorAll('.room-backplate--home-day, .room-backplate--home-night')]
    const seatImages = [...document.querySelectorAll('.room-backplate--seat-day, .room-backplate--seat-night')]
    return homeImages.length === 2
      && seatImages.length === 2
      && homeImages.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 3344 && image.naturalHeight === 1882)
      && seatImages.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1672 && image.naturalHeight === 941)
  }, undefined, { timeout: 15_000 })
  await window.waitForTimeout(900)

  if (await window.locator('.onboarding-card').count()) {
    if (await window.locator('.onboarding-video').count() !== 1) throw new Error('Approved onboarding video was not mounted')
    if (await window.locator('.onboarding-video track[kind="captions"]').count() !== 1) throw new Error('Onboarding captions track is missing')
    if (await window.locator('.onboarding-video track[kind="captions"]').getAttribute('default') !== null) throw new Error('Native captions overlap the visible DOM transcript')
    if (await window.locator('.onboarding-layer audio').count() !== 1) throw new Error('Independent onboarding voice track is missing')
    if (await window.locator('.action-rail').getAttribute('aria-hidden') !== 'true') throw new Error('First-entry guide did not quiet the primary action island')
    await window.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '跳过首次引导')
    await window.screenshot({ path: resolve(reviewRoot, 'onboarding.png') })
    await window.getByRole('button', { name: '无声进入' }).click()
  }

  const mediaReady = await window.waitForFunction(() => {
    const video = document.querySelector('.window-ambient-video__media')
    return Boolean(document.querySelector('.window-ambient-video--ready'))
      || !video
      || Boolean((video instanceof HTMLVideoElement) && video.error)
  }, undefined, { timeout: 12_000 }).catch(() => false)
  if (!mediaReady) console.log('Window ambient media did not settle; continuing with poster-only evidence')
  await window.waitForTimeout(250)

  await writeCaptureRuntime(window, 'real_journey')

  const seatSceneContract = await window.evaluate(() => {
    const homeDay = document.querySelector('.room-backplate--home-day')
    const homeNight = document.querySelector('.room-backplate--home-night')
    const seatDay = document.querySelector('.room-backplate--seat-day')
    const seatNight = document.querySelector('.room-backplate--seat-night')
    const atmosphere = document.querySelector('.window-atmosphere')
    return {
      homeDayPath: homeDay?.getAttribute('src'),
      homeNightPath: homeNight?.getAttribute('src'),
      seatDayPath: seatDay?.getAttribute('src'),
      seatNightPath: seatNight?.getAttribute('src'),
      atmospherePresent: atmosphere instanceof HTMLElement,
      homeWindowMedia: document.querySelectorAll('.window-ambient-video').length,
      legacySurfaceWorld: document.querySelectorAll('.surface-world').length,
    }
  })
  if (
    !seatSceneContract.homeDayPath?.includes('room-day.webp')
    || !seatSceneContract.homeNightPath?.includes('room-night.webp')
    || !seatSceneContract.seatDayPath?.includes('study-seat-day-v2.png')
    || !seatSceneContract.seatNightPath?.includes('study-seat-night-v2.png')
    || !seatSceneContract.atmospherePresent
    || seatSceneContract.homeWindowMedia !== 1
    || seatSceneContract.legacySurfaceWorld !== 0
  ) {
    throw new Error(`Overview-to-seat scene contract drifted: ${JSON.stringify(seatSceneContract)}`)
  }

  const nativeChrome = await electronApp.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0]
    return {
      platform: process.platform,
      minimizable: target?.isMinimizable() ?? false,
      maximizable: target?.isMaximizable() ?? false,
      closable: target?.isClosable() ?? false,
      minimumSize: target?.getMinimumSize() ?? [0, 0],
    }
  })
  if (!nativeChrome.minimizable || !nativeChrome.maximizable || !nativeChrome.closable || nativeChrome.minimumSize[1] < 700) {
    throw new Error(`Native window contract drifted: ${JSON.stringify(nativeChrome)}`)
  }

  const referenceBox = await window.locator('.room-reference-frame').boundingBox()
  const stageBox = await window.locator('.scene-stage').boundingBox()
  const ratio = referenceBox ? referenceBox.width / referenceBox.height : 0
  if (!referenceBox || !stageBox || Math.abs(ratio - (1672 / 941)) > 0.001) {
    throw new Error(`Reference frame drifted: ${JSON.stringify({ referenceBox, stageBox })}`)
  }
  if (
    referenceBox.x > stageBox.x
    || referenceBox.y > stageBox.y
    || referenceBox.x + referenceBox.width < stageBox.x + stageBox.width
    || referenceBox.y + referenceBox.height < stageBox.y + stageBox.height
  ) {
    throw new Error('Reference frame exposes an empty band')
  }

  await window.screenshot({ path: resolve(reviewRoot, 'desktop.png') })

  if (captureOwnerCredentialsAvailable) {
    const generationRecoveryButton = window.getByRole('button', { name: /查看恢复状态|恢复候选审核/ })
    await generationRecoveryButton.waitFor({ state: 'visible', timeout: 15_000 })
    await generationRecoveryButton.click()
    await window.getByRole('heading', { name: '整理学习卡' }).waitFor()
    await window.waitForFunction(() => Boolean(document.querySelector('.card-generation-meta')) || Boolean(document.querySelector('.card-generation-state--error')), undefined, { timeout: 15_000 })
    if (await window.locator('.card-generation-state--error').count()) {
      const generationError = await window.locator('.card-generation-state--error').innerText()
      throw new Error(`Owner Card Generation recovery did not load: ${generationError}`)
    }
    const generationContract = await window.evaluate(() => ({
      surfaceVisible: Boolean(document.querySelector('.card-generation-surface')),
      runMetaVisible: Boolean(document.querySelector('.card-generation-meta')),
      candidateListVisible: Boolean(document.querySelector('.card-generation-list')),
      terminalStateVisible: Boolean(document.querySelector('.card-generation-state--inline, .card-generation-empty')),
      localSuccessControls: [...document.querySelectorAll('button')].filter((button) => /本机候选|自动激活|生成完成/.test(button.textContent ?? '')).length,
    }))
    if (!generationContract.surfaceVisible || !generationContract.runMetaVisible || (!generationContract.candidateListVisible && !generationContract.terminalStateVisible) || generationContract.localSuccessControls !== 0) {
      throw new Error(`Owner Card Generation recovery did not consume the real run safely: ${JSON.stringify(generationContract)}`)
    }
    await settleSurface(window)
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-card-generation-owner.png') })
    await window.getByRole('button', { name: '关闭学习卡生成并返回房间' }).click()
  }

  await window.getByRole('button', { name: '与书桌上的 AI 伴星互动' }).click()
  await window.getByRole('heading', { name: '现在想从哪里继续？' }).waitFor()
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-companion-orb.png') })
  const live2dGateButton = window.getByRole('button', { name: 'Live2D 待许可', exact: true })
  if (!await live2dGateButton.isDisabled()) throw new Error('Unlicensed Live2D selection was exposed as an enabled runtime action')
  const live2dContract = await window.evaluate(() => {
    const renderer = document.querySelector('.window-live2d')
    return {
      form: document.querySelector('.companion-presence')?.getAttribute('data-form'),
      available: document.querySelector('.companion-presence')?.getAttribute('data-live2d-available'),
      renderer: renderer?.getAttribute('data-companion-renderer'),
      status: renderer?.getAttribute('data-companion-status'),
    }
  })
  if (live2dContract.available !== 'false' || live2dContract.form !== 'orb' || live2dContract.renderer !== 'orb' || live2dContract.status !== 'fallback') {
    throw new Error(`Unlicensed Live2D package capability did not fail closed: ${JSON.stringify(live2dContract)}`)
  }
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-companion-license-gate.png') })
  await window.getByRole('button', { name: '收起伴星' }).click()
  await window.waitForTimeout(400)
  await window.getByLabel('展开房间控制').click()
  if (await window.locator('.island-panel button').count() !== 5) throw new Error('Room control island is incomplete')
  await window.waitForTimeout(400)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-controls.png') })
  await window.getByLabel('收起房间控制').click()
  await window.getByLabel('切换书房灯光').click({ force: true })
  await window.waitForFunction(
    () => document.querySelector('.desktop-app')?.getAttribute('data-theme') === 'night',
    undefined,
    { timeout: 8_000 },
  )
  await window.waitForTimeout(500)
  await window.getByText('台灯亮了。光只落在桌面上，我们可以安静地继续。').waitFor()
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-lamp-response.png') })
  await window.getByRole('button', { name: '收起伴星' }).click()
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-night.png') })

  await window.getByTestId('action-continue').click()
  await window.getByLabel('关闭任务面并返回房间').waitFor({ state: 'visible' })
  await settleSurface(window)
  const concreteSceneContract = await window.evaluate(() => ({
    preset: document.querySelector('.room-reference-frame')?.getAttribute('data-view-preset'),
    seatOpacity: Number.parseFloat(getComputedStyle(document.querySelector('.room-backplate--seat-night')).opacity),
    homeOpacity: Number.parseFloat(getComputedStyle(document.querySelector('.room-backplate--home-night')).opacity),
    homeWindowMedia: document.querySelectorAll('.window-ambient-video').length,
  }))
  if (concreteSceneContract.preset !== 'study' || concreteSceneContract.seatOpacity < 0.98 || concreteSceneContract.homeOpacity > 0.02 || concreteSceneContract.homeWindowMedia !== 0) {
    throw new Error(`Concrete scene did not advance from overview to Seat V2: ${JSON.stringify(concreteSceneContract)}`)
  }
  const sceneCoverage = await window.locator('.task-surface').boundingBox()
  const sceneViewport = await window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  if (!sceneCoverage || sceneCoverage.width < sceneViewport.width || sceneCoverage.height < sceneViewport.height) {
    throw new Error(`Spatial task layer does not cover the viewport: ${JSON.stringify({ sceneCoverage, sceneViewport })}`)
  }
  await window.waitForFunction(
    () => Boolean(document.querySelector('.study-workbench.study-workbench--ready'))
      || Boolean(document.querySelector('.study-boundary:is([role="alert"]), .study-workbench--empty, .study-workbench--error')),
    undefined,
    { timeout: 12_000 },
  )
  const studyContract = await window.evaluate(() => ({
    objectSurfaceVisible: Boolean(document.querySelector('.study-workbench.study-workbench--ready')),
    safeStateVisible: Boolean(document.querySelector('.study-boundary:is([role="alert"]), .study-workbench--empty, .study-workbench--error')),
  }))
  if (!studyContract.objectSurfaceVisible && !studyContract.safeStateVisible) {
    throw new Error(`Study scene did not consume a real RoomProjection or stop safely: ${JSON.stringify(studyContract)}`)
  }
  if (captureOwnerCredentialsAvailable && !studyContract.objectSurfaceVisible) {
    throw new Error(`Owner capture did not reach the real Study projection: ${JSON.stringify(studyContract)}`)
  }
  let focusSearchTerm = '概率'
  if (captureOwnerCredentialsAvailable) {
    focusSearchTerm = (await window.locator('.study-workbench .study-objective h2').innerText()).trim()
    if (!focusSearchTerm) throw new Error('Owner capture did not expose a searchable primary-focus title')
  }
  const ambientPaused = await window.evaluate(() => {
    const audio = document.querySelector('.room-reference-frame audio')
    const companion = document.querySelector('.companion-presence .window-live2d')
    return document.querySelectorAll('.window-ambient-video').length === 0
      && (!audio || audio.paused)
      && companion instanceof HTMLElement
      && companion.getClientRects().length > 0
  })
  if (!ambientPaused) throw new Error('Ambient media continued under a reading surface or the companion disappeared')
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-study.png') })

  if (captureOwnerCredentialsAvailable) {
    if (await window.getByRole('button', { name: '进入研究册' }).count() !== 1) {
      throw new Error('Owner Study projection did not expose the confirmed primary Note entry')
    }
    await window.getByRole('button', { name: '进入研究册' }).click()
    await window.locator('.notebook-surface').waitFor({ state: 'visible' })
    await window.waitForFunction(() => Boolean(document.querySelector('.notebook-readonly, textarea[aria-label="真实笔记内容"]')) || Boolean(document.querySelector('.notebook-state--error')), undefined, { timeout: 12_000 })
    if (await window.locator('.notebook-state--error').count()) {
      const notebookError = await window.locator('.notebook-state--error').innerText()
      throw new Error(`Owner Note projection did not load: ${notebookError}`)
    }
    if (await window.locator('.notebook-readonly, textarea[aria-label="真实笔记内容"]').count() !== 1) {
      throw new Error('Owner Note projection did not expose real note content')
    }
    if (await window.getByRole('button', { name: /从选区整理学习卡/ }).count() !== 0) {
      throw new Error('Notebook still exposes the removed local card-generation action')
    }
    await settleSurface(window)
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-notebook-owner.png') })
    await window.getByLabel('关闭任务面并返回房间').click()
  } else if (await window.getByRole('button', { name: '进入研究册' }).count()) {
    await window.getByRole('button', { name: '进入研究册' }).click()
    await window.getByText('研究册暂时不可用').waitFor()
    await settleSurface(window)
    const notebookBoundaryText = await window.locator('.notebook-state--error').innerText()
    if (!/(登录|服务|API|桌面端)/.test(notebookBoundaryText)) {
      throw new Error(`Notebook did not stop at a safe authenticated Note boundary: ${notebookBoundaryText}`)
    }
    if (await window.getByRole('button', { name: /从选区整理学习卡/ }).count() !== 0) {
      throw new Error('Notebook still exposes the removed local card-generation action')
    }
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-notebook-boundary.png') })
    await window.getByLabel('关闭任务面并返回房间').click()
  } else {
    const studyBoundaryText = await window.locator('.study-boundary').first().innerText()
    if (!/(身份|工作区|RoomProjection|服务|API|主焦点)/.test(studyBoundaryText)) {
      throw new Error(`Study did not stop at a safe primary-focus boundary: ${studyBoundaryText}`)
    }
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-study-boundary.png') })
    await window.getByLabel('关闭任务面并返回房间').click()
  }
  await window.getByTestId('action-review').click()
  await window.getByRole('heading', { name: '今日复习' }).waitFor()
  await window.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="review-queue"]') && document.querySelector('.review-notebook'))
      || Boolean(document.querySelector('.review-scene-state--empty, .review-scene-state--error')),
    undefined,
    { timeout: 12_000 },
  )
  const reviewBoundary = await window.evaluate(() => ({
    safeStateVisible: Boolean(document.querySelector('.review-scene-state--empty, .review-scene-state--error')),
    queueVisible: Boolean(document.querySelector('[data-testid="review-queue"]') && document.querySelector('.review-notebook')),
    legacyCardTrayVisible: Boolean(document.querySelector('img[src*="review-card-tray-v1"]')),
    reviewStandVisible: Boolean(document.querySelector('img[src*="review-card-stand-v2"]')),
    legacyReviewStructureVisible: Boolean(document.querySelector('.review-planner, .review-index, .review-planner__frame'))
      || [...document.querySelectorAll('[class]')].some((node) => [...node.classList].some((className) => className.startsWith('review-ledger'))),
    rawIdentityVisible: /识别码|[0-9a-f]{8}-[0-9a-f-]{27}/i.test(document.querySelector('.review-reference-frame')?.textContent ?? ''),
    spatialLayerPaintsPanel: getComputedStyle(document.querySelector('.task-surface__spatial-layer'), '::before').content !== 'none',
    returnControlHit: (() => {
      const button = document.querySelector('.review-scene__return')
      if (!(button instanceof HTMLElement)) return false
      const rect = button.getBoundingClientRect()
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === button
    })(),
    oldFlipActionCount: [...document.querySelectorAll('button')].filter((button) => button.textContent?.includes('翻面查看答案')).length,
    oldRatingActionCount: [...document.querySelectorAll('button')].filter((button) => ['掌握', '模糊', '不会'].includes(button.textContent?.trim() ?? '')).length,
  }))
  if (
    reviewBoundary.oldFlipActionCount !== 0
    || reviewBoundary.oldRatingActionCount !== 0
    || reviewBoundary.legacyCardTrayVisible
    || reviewBoundary.reviewStandVisible
    || reviewBoundary.legacyReviewStructureVisible
    || reviewBoundary.rawIdentityVisible
    || reviewBoundary.spatialLayerPaintsPanel
    || !reviewBoundary.returnControlHit
    || (!reviewBoundary.safeStateVisible && !reviewBoundary.queueVisible)
  ) {
    throw new Error(`Review V4 queue contract drifted: ${JSON.stringify(reviewBoundary)}`)
  }
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-review-boundary.png') })

  await window.getByLabel('关闭任务面并返回房间').click()
  await window.getByTestId('action-continue').click()
  if (captureOwnerCredentialsAvailable) {
    const primaryAction = window.locator('.study-workbench .surface-primary').first()
    await primaryAction.waitFor({ state: 'visible' })
    if (await primaryAction.isDisabled()) throw new Error('Owner primary Study action is unavailable')
    await primaryAction.click()
    await window.getByRole('heading', { name: '三分钟学习旅程' }).waitFor()
    await window.waitForFunction(() => Boolean(document.querySelector('.run-player:not(.run-player--loading)')) || Boolean(document.querySelector('.run-player--error')), undefined, { timeout: 15_000 })
    if (await window.locator('.run-player--error').count()) {
      const runError = await window.locator('.run-player--error').innerText()
      throw new Error(`Owner LearningRun did not load: ${runError}`)
    }
    if (await window.locator('.run-player').count() !== 1) throw new Error('Owner LearningRun player did not mount')
    await settleSurface(window)
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-owner.png') })
  } else {
    if (await window.getByRole('button', { name: '进入研究册' }).count()) {
      await window.getByRole('button', { name: '进入研究册' }).click()
      await window.getByRole('button', { name: '验证这段理解' }).click()
    } else {
      await window.getByRole('button', { name: '验证这段理解' }).click()
    }
    await window.getByRole('heading', { name: '三分钟学习旅程' }).waitFor()
    await window.getByRole('heading', { name: '请从真实复习队列开始' }).waitFor()
    if (await window.getByPlaceholder('先说清先验，再说新证据如何改变判断…').count() !== 0) {
      throw new Error('LearningRun entry exposed the removed local validation form')
    }
    await settleSurface(window)
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-entry.png') })
  }

  await window.getByLabel('关闭任务面并返回房间').click()
  await window.getByTestId('action-search').click()
  await window.getByPlaceholder('输入概念、问题或来源…').fill('不存在的概念')
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-search-empty.png') })
  await window.getByPlaceholder('输入概念、问题或来源…').fill(focusSearchTerm)
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-search.png') })
  await window.getByPlaceholder('输入概念、问题或来源…').press('Enter')
  await settleSurface(window)
  const searchResultContract = await window.evaluate(() => ({
    studyOpened: Boolean(document.querySelector('.task-surface--study')),
    safeSearchState: Boolean(document.querySelector('.search-surface .surface-empty')),
  }))
  if (!searchResultContract.studyOpened && !searchResultContract.safeSearchState) {
    throw new Error(`Search did not open the real focus or stop at a safe boundary: ${JSON.stringify(searchResultContract)}`)
  }

  await window.getByLabel('关闭任务面并返回房间').click()
  await window.getByLabel('从窗户进入理解星图').click()
  await window.getByRole('heading', { name: '理解星图' }).waitFor()
  const graphBoundary = await window.evaluate(() => ({
    safeStateVisible: Boolean(document.querySelector('.graph-boundary')),
    oldNodeCount: document.querySelectorAll('.graph-stage, #graph-relations, .graph-list').length,
  }))
  if (!graphBoundary.safeStateVisible || graphBoundary.oldNodeCount !== 0) {
    throw new Error(`Graph did not stop at the real topology boundary: ${JSON.stringify(graphBoundary)}`)
  }
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-graph.png') })

  await window.getByLabel('关闭任务面并返回房间').click()
  await setSize(1024, 700)
  await window.waitForTimeout(300)
  await window.screenshot({ path: resolve(reviewRoot, 'compact.png') })
  await window.getByTestId('action-continue').click()
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'compact-study.png') })

  await window.getByLabel('关闭任务面并返回房间').click()
  await setSize(512, 350, true)
  await window.waitForTimeout(250)
  const viewport = await window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const actionBoxes = await window.locator('.rail-action').evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect()
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
  }))
  if (actionBoxes.length !== 3 || actionBoxes.some((box) => box.left < 0 || box.top < 0 || box.right > viewport.width || box.bottom > viewport.height)) {
    throw new Error(`Primary actions overflow at 200%: ${JSON.stringify({ viewport, actionBoxes })}`)
  }
  if (await window.locator('.scene-status').count()) throw new Error('Persistent scene status overlaps the 200% action rail')
  await window.screenshot({ path: resolve(reviewRoot, 'zoom-200.png') })
  await window.getByTestId('action-continue').click()
  await settleSurface(window)
  await window.waitForFunction(
    () => Boolean(document.querySelector('.study-workbench.study-workbench--ready'))
      || Boolean(document.querySelector('.study-boundary:is([role="alert"]), .study-workbench--empty, .study-workbench--error')),
    undefined,
    { timeout: 12_000 },
  )
  if (await window.locator('.study-workbench.study-workbench--ready').count()) {
    const studyObjectSurface = window.locator('.study-workbench.study-workbench--ready').first()
    await studyObjectSurface.scrollIntoViewIfNeeded()
    if (!(await studyObjectSurface.isVisible())) throw new Error('Study object surface is hidden at 200%')
  } else {
    const studyState = window.locator('.study-boundary:is([role="alert"]), .study-workbench--empty, .study-workbench--error').first()
    await studyState.waitFor({ state: 'visible' })
    await studyState.scrollIntoViewIfNeeded()
    if (!(await studyState.isVisible())) throw new Error('Safe Study boundary is hidden at 200%')
  }
  await window.screenshot({ path: resolve(reviewRoot, 'zoom-200-study.png') })
  await window.getByLabel('关闭任务面并返回房间').click()

  await window.emulateMedia({ reducedMotion: 'reduce' })
  await window.reload()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForFunction(() => document.querySelector('.desktop-app')?.getAttribute('data-motion-mode') === 'off')
  await window.locator('.action-rail').waitFor({ state: 'visible', timeout: 20_000 })
  const reducedMedia = await window.locator('.window-ambient-video').count()
  if (reducedMedia !== 0) throw new Error('Reduced motion still mounted ambient video')
  if (await window.locator('.window-live2d[data-companion-renderer="orb"]').count() !== 1) throw new Error('Reduced motion did not keep the companion as a static orb')
  if (await window.locator('.onboarding-card').count()) await window.getByRole('button', { name: '无声进入' }).click()
  await window.screenshot({ path: resolve(reviewRoot, 'reduced-motion.png') })

  const normalizedErrors = errors.filter((message) => !message.includes('ResizeObserver loop'))
  if (normalizedErrors.length) throw new Error(`Renderer errors:\n${normalizedErrors.join('\n')}`)

  console.log(`Captured Seat V2 room and in-window companion review set in ${reviewRoot}`)
  }
} finally {
  await electronApp.close()
}
