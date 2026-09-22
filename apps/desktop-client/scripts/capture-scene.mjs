import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review')
const lampFrameCaptureStorageKey = 'ailearn:auth-lamp-frame-capture'
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

const setZoomFactor = async (zoomFactor) => {
  await electronApp.evaluate(({ BrowserWindow }, factor) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor)
  }, zoomFactor)
}

const settleSurface = (window) => window.waitForTimeout(900)

async function closeHomeCatalog(window) {
  const toggle = window.getByRole('button', { name: '收起目录', exact: true })
  if (await toggle.count() && await toggle.isVisible()) {
    await toggle.click()
    await window.waitForFunction(
      () => document.querySelector('.home-catalog')?.getAttribute('aria-hidden') === 'true',
      undefined,
      { timeout: 5_000 },
    )
  }
}

const waitForScenePhase = (window, phase) => window.waitForFunction(
  (expectedPhase) => document.querySelector('.desktop-app')?.getAttribute('data-scene-phase') === expectedPhase,
  phase,
  { timeout: 8_000 },
)

const assertTaskSurfaceCompanionQuiet = async (window, label) => {
  const contract = await window.evaluate(() => {
    const app = document.querySelector('.desktop-app')
    const companion = document.querySelector('.companion-presence')
    const visual = document.querySelector('.companion-visual-shell')
    return {
      surfaceOpen: app?.getAttribute('data-surface-open') === 'true',
      policyMode: companion?.getAttribute('data-policy-mode') ?? null,
      taskSurfaceQuiet: companion?.getAttribute('data-task-surface-quiet') === 'true',
      engaged: companion?.getAttribute('data-engaged') === 'true',
      ariaHidden: companion?.getAttribute('aria-hidden') ?? null,
      companionDisplay: companion instanceof HTMLElement ? getComputedStyle(companion).display : 'missing',
      visualDisplay: visual instanceof HTMLElement ? getComputedStyle(visual).display : 'missing',
      visualRectCount: visual?.getClientRects().length ?? 0,
      composerCount: companion?.querySelectorAll('.companion-dock').length ?? 0,
      bubbleCount: companion?.querySelectorAll('.companion-bubble, .companion-page-cue').length ?? 0,
    }
  })
  if (contract.surfaceOpen && (
    !['ambient', 'assessment'].includes(contract.policyMode ?? '')
    || !contract.taskSurfaceQuiet
    || contract.engaged
    || contract.ariaHidden !== null
    || contract.companionDisplay === 'none'
    || contract.visualDisplay === 'none'
    || contract.visualRectCount !== 1
    || contract.composerCount !== 0
    || contract.bubbleCount !== 0
  )) {
    throw new Error(`${label} task surface did not quiet the companion: ${JSON.stringify(contract)}`)
  }
  return contract
}

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
      ['body', '.scene-stage', '.day-route', '.action-rail']
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
      entryAssetSource: gate?.getAttribute('data-gate-asset-source') ?? null,
      hasRoomDom: document.querySelector('.scene-stage') !== null,
      hasOnboarding: document.querySelector('.onboarding-card') !== null,
      hasActionRail: document.querySelector('.action-rail') !== null,
    }
  })
}

async function selectAuthScene(window, scene) {
  const control = window.locator('.desktop-access-gate__lamp-control')
  if (await control.getAttribute('aria-expanded') !== 'true') await control.click()
  const menu = window.locator('#desktop-gate-time-menu')
  await menu.waitFor({ state: 'visible', timeout: 8_000 })
  await menu.locator(`[data-scene-choice="${scene}"]`).click()
  await window.waitForFunction(
    ({ expectedScene, expectedMode }) => {
      const gate = document.querySelector('.desktop-access-gate')
      const switcher = document.querySelector('.desktop-access-gate__lamp-switch')
      const ambient = document.querySelector('.desktop-access-gate__ambient-canvas')
      return gate?.getAttribute('data-gate-time-mode') === expectedMode
        && (expectedScene === null || gate.getAttribute('data-gate-scene') === expectedScene)
        && switcher?.getAttribute('data-transition-direction') === 'idle'
        && ambient?.getAttribute('data-auth-ambient-effect') === 'idle'
    },
    { expectedScene: scene === 'system' ? null : scene, expectedMode: scene },
    { timeout: 8_000 },
  )
}

async function captureDuskChoice(window, { expectedBackdropAsset, screenshotPrefix }) {
  const control = window.locator('.desktop-access-gate__lamp-control')
  await control.click()
  await window.locator('#desktop-gate-time-menu [data-scene-choice="dusk"]').click()
  await window.waitForFunction(
    () => document.querySelector('.desktop-access-gate__lamp-switch')?.getAttribute('data-transition-direction') === 'to-dusk',
    undefined,
    { timeout: 8_000 },
  )
  await window.screenshot({ path: resolve(reviewRoot, `${screenshotPrefix}-00-start.png`) })
  await window.waitForTimeout(110)
  await window.screenshot({ path: resolve(reviewRoot, `${screenshotPrefix}-01-midpoint.png`) })
  await window.waitForFunction(
    () => {
      const gate = document.querySelector('.desktop-access-gate')
      const duskScene = gate?.querySelector('.desktop-access-gate__backdrop-layer--dusk')
      return gate?.getAttribute('data-gate-scene') === 'dusk'
        && gate.getAttribute('data-gate-time-mode') === 'dusk'
        && document.querySelector('.desktop-access-gate__lamp-switch')?.getAttribute('data-transition-direction') === 'idle'
        && document.querySelector('.desktop-access-gate__ambient-canvas')?.getAttribute('data-auth-ambient-effect') === 'idle'
        && duskScene instanceof HTMLElement
        && Number.parseFloat(getComputedStyle(duskScene).opacity) > 0.99
    },
    undefined,
    { timeout: 8_000 },
  )
  const result = await window.evaluate(() => {
    const gate = document.querySelector('.desktop-access-gate')
    const duskScene = gate?.querySelector('.desktop-access-gate__backdrop-layer--dusk')
    return {
      scene: gate?.getAttribute('data-gate-scene') ?? null,
      mode: gate?.getAttribute('data-gate-time-mode') ?? null,
      visualTheme: gate?.getAttribute('data-gate-visual-theme') ?? null,
      duskBackdrop: duskScene instanceof HTMLElement ? getComputedStyle(duskScene).backgroundImage : null,
      duskOpacity: duskScene instanceof HTMLElement ? Number.parseFloat(getComputedStyle(duskScene).opacity) : null,
    }
  })
  if (
    result.scene !== 'dusk'
    || result.mode !== 'dusk'
    || result.visualTheme !== 'dusk'
    || !result.duskBackdrop?.includes(expectedBackdropAsset)
    || result.duskOpacity === null
    || result.duskOpacity < 0.99
  ) {
    throw new Error(`DesktopAccessGate dusk choice drifted: ${JSON.stringify(result)}`)
  }
  await writeFile(resolve(reviewRoot, `${screenshotPrefix}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await window.screenshot({ path: resolve(reviewRoot, `${screenshotPrefix}-02-settled.png`) })
}

async function capturePersistentAmbient(window) {
  // This is deliberately under a second: a decorative layer that only
  // changes in a long screenshot comparison still reads as frozen to a person
  // resting on the sign-in screen.
  const ambientFrameWindowMs = 900
  await window.waitForFunction(
    () => {
      const ambient = document.querySelector('.desktop-access-gate__ambient-canvas')
      return ambient?.getAttribute('data-auth-ambient-state') === 'settled'
        && ambient.getAttribute('data-auth-ambient-motion') === 'persistent'
    },
    undefined,
    { timeout: 8_000 },
  )
  const firstPath = resolve(reviewRoot, 'desktop-access-gate-ambient-persistent-00.png')
  const secondPath = resolve(reviewRoot, 'desktop-access-gate-ambient-persistent-01.png')
  const first = await window.screenshot({ path: firstPath })
  await window.waitForTimeout(ambientFrameWindowMs)
  const second = await window.screenshot({ path: secondPath })
  const ambientCrop = await window.evaluate(() => ({
    x: Math.floor(window.innerWidth * 0.46),
    y: 0,
    width: Math.ceil(window.innerWidth * 0.54),
    height: window.innerHeight,
  }))
  const input = window.locator('.desktop-access-gate input').first()
  await input.focus()
  await window.waitForFunction(
    () => document.querySelector('.desktop-access-gate__ambient-canvas')?.getAttribute('data-auth-ambient-state') === 'quiet',
    undefined,
    { timeout: 8_000 },
  )
  const quietFirst = await window.screenshot({
    path: resolve(reviewRoot, 'desktop-access-gate-ambient-quiet-00.png'),
    clip: ambientCrop,
  })
  await window.waitForTimeout(ambientFrameWindowMs)
  const quietSecond = await window.screenshot({
    path: resolve(reviewRoot, 'desktop-access-gate-ambient-quiet-01.png'),
    clip: ambientCrop,
  })
  await input.evaluate((element) => (element instanceof HTMLElement ? element.blur() : undefined))
  await window.waitForFunction(
    () => document.querySelector('.desktop-access-gate__ambient-canvas')?.getAttribute('data-auth-ambient-motion') === 'persistent',
    undefined,
    { timeout: 8_000 },
  )
  const result = await window.evaluate(() => {
    const ambient = document.querySelector('.desktop-access-gate__ambient-canvas')
    return {
      state: ambient?.getAttribute('data-auth-ambient-state') ?? null,
      motion: ambient?.getAttribute('data-auth-ambient-motion') ?? null,
    }
  })
  if (
    result.state !== 'settled'
    || result.motion !== 'persistent'
    || Buffer.compare(first, second) === 0
    || Buffer.compare(quietFirst, quietSecond) === 0
  ) {
    throw new Error(`DesktopAccessGate ambient did not remain visibly alive: ${JSON.stringify(result)}`)
  }
  await writeFile(
    resolve(reviewRoot, 'desktop-access-gate-ambient-persistent.json'),
    `${JSON.stringify({ ...result, sampleWindowMs: ambientFrameWindowMs, framesDiffer: true, inputFocusFramesDiffer: true }, null, 2)}\n`,
    'utf8',
  )
}

async function captureLampTransition(window, {
  label,
  direction,
  expectedTheme,
  expectedBackdropAsset,
  screenshotPrefix,
}) {
  const control = window.locator('.desktop-access-gate__lamp-control')
  const firstPhase = direction === 'to-night' ? 'dimming' : 'brightening'
  const focalPhase = direction === 'to-night' ? 'lamp-on' : 'lamp-off'
  const readTransition = () => window.evaluate(() => {
    const app = document.querySelector('.desktop-app')
    const gate = document.querySelector('.desktop-access-gate')
    const switcher = gate?.querySelector('.desktop-access-gate__lamp-switch')
    const dayScene = gate?.querySelector('.desktop-access-gate__backdrop-layer--day')
    const duskScene = gate?.querySelector('.desktop-access-gate__backdrop-layer--dusk')
    const nightScene = gate?.querySelector('.desktop-access-gate__backdrop-layer--night')
    const dayScrim = gate?.querySelector('.desktop-access-gate__backdrop-scrim--day')
    const nightScrim = gate?.querySelector('.desktop-access-gate__backdrop-scrim--night')
    const lampLabel = gate?.querySelector('.desktop-access-gate__lamp-control-label')
    const ambient = gate?.querySelector('.desktop-access-gate__ambient-canvas')
    const opacity = (element) => element instanceof HTMLElement ? Number.parseFloat(getComputedStyle(element).opacity) : null
    const numberAttribute = (element, name) => {
      const value = element?.getAttribute(name)
      return value === null || value === undefined ? null : Number.parseFloat(value)
    }
    return {
      capturedAt: Math.round(performance.now()),
      theme: app?.getAttribute('data-theme') ?? null,
      gateScene: gate?.getAttribute('data-gate-scene') ?? null,
      gateVisualTheme: gate?.getAttribute('data-gate-visual-theme') ?? null,
      gateTimeMode: gate?.getAttribute('data-gate-time-mode') ?? null,
      direction: switcher?.getAttribute('data-transition-direction') ?? null,
      phase: switcher?.getAttribute('data-transition-phase') ?? null,
      controlDisabled: gate?.querySelector('.desktop-access-gate__lamp-control') instanceof HTMLButtonElement
        ? gate.querySelector('.desktop-access-gate__lamp-control').disabled
        : null,
      daySceneOpacity: opacity(dayScene),
      duskSceneOpacity: opacity(duskScene),
      nightSceneOpacity: opacity(nightScene),
      dayScrimOpacity: opacity(dayScrim),
      nightScrimOpacity: opacity(nightScrim),
      lampLabelOpacity: opacity(lampLabel),
      daySceneBackdrop: dayScene instanceof HTMLElement ? getComputedStyle(dayScene).backgroundImage : null,
      duskSceneBackdrop: duskScene instanceof HTMLElement ? getComputedStyle(duskScene).backgroundImage : null,
      nightSceneBackdrop: nightScene instanceof HTMLElement ? getComputedStyle(nightScene).backgroundImage : null,
      ambientEffect: ambient?.getAttribute('data-auth-ambient-effect') ?? null,
      ambientEffectProgress: numberAttribute(ambient, 'data-auth-ambient-effect-progress'),
      ambientEffectIntensity: numberAttribute(ambient, 'data-auth-ambient-effect-intensity'),
      hasSyntheticLightLayers: Boolean(
        gate?.querySelector('.desktop-access-gate__theme-veil, .desktop-access-gate__lamp-pool, .desktop-access-gate__scene-shade'),
      ),
      hasFrameCaptureController: typeof window.__ailearnAuthLampCapture?.seek === 'function',
      hasAmbientFrameCaptureController: typeof window.__ailearnAuthAmbientCapture?.seek === 'function',
    }
  })

  await window.evaluate((storageKey) => window.localStorage.setItem(storageKey, 'paused'), lampFrameCaptureStorageKey)
  await control.click()
  await window.locator('#desktop-gate-time-menu').waitFor({ state: 'visible', timeout: 8_000 })
  await window.locator(`#desktop-gate-time-menu [data-scene-choice="${direction.slice(3)}"]`).click()
  await window.waitForFunction(
    ({ expectedDirection, expectedPhase }) => {
      const switcher = document.querySelector('.desktop-access-gate__lamp-switch')
      return switcher?.getAttribute('data-transition-direction') === expectedDirection
        && switcher.getAttribute('data-transition-phase') === expectedPhase
    },
    { expectedDirection: direction, expectedPhase: firstPhase },
    { timeout: 8_000 },
  ).catch(async () => {
    throw new Error(`${label} did not enter ${firstPhase}: ${JSON.stringify(await readTransition())}`)
  })
  await window.waitForFunction(
    () => typeof window.__ailearnAuthAmbientCapture?.seek === 'function',
    undefined,
    { timeout: 8_000 },
  ).catch(async () => {
    throw new Error(`${label} did not arm the Pixi lamp effect: ${JSON.stringify(await readTransition())}`)
  })
  const firstFrame = await readTransition()
  if (
    !firstFrame.controlDisabled
    || firstFrame.hasSyntheticLightLayers
    || !firstFrame.hasFrameCaptureController
    || !firstFrame.hasAmbientFrameCaptureController
    || firstFrame.ambientEffect !== direction
  ) {
    throw new Error(`${label} did not enter the clean ${firstPhase} transition: ${JSON.stringify(firstFrame)}`)
  }

  const timing = await window.evaluate(() => {
    const controller = window.__ailearnAuthLampCapture
    if (!controller) throw new Error('Lamp frame capture controller is unavailable')
    return controller.timing()
  })
  const focalAt = timing.labels[focalPhase]
  const settleAt = timing.labels.settling
  if (
    !Number.isFinite(focalAt)
    || !Number.isFinite(settleAt)
    || !Number.isFinite(timing.duration)
    || timing.duration < 0.32
    || timing.duration > 0.55
  ) {
    throw new Error(`${label} exposed incomplete frame timing: ${JSON.stringify(timing)}`)
  }
  const samplePlan = [
    ['00-click', 0],
    ['01-response', timing.duration * 0.12],
    ['02-crossfade-start', timing.duration * 0.28],
    ['03-before-handoff', Math.max(0, focalAt - 0.012)],
    ['04-theme-handoff', focalAt + 0.012],
    ['05-crossfade-midpoint', timing.duration * 0.58],
    ['06-resolving', timing.duration * 0.75],
    ['07-near-target', timing.duration * 0.9],
    ['08-pre-settle', Math.max(0, timing.duration - 0.018)],
  ]
  const samples = []
  let focalFrame = null
  try {
    for (const [name, time] of samplePlan) {
      await window.evaluate((nextTime) => {
        const lampController = window.__ailearnAuthLampCapture
        const ambientController = window.__ailearnAuthAmbientCapture
        if (!lampController || !ambientController) throw new Error('Lamp effect frame capture controllers are unavailable')
        lampController.seek(nextTime)
        ambientController.seek(nextTime)
      }, time)
      await window.waitForTimeout(90)
      const frame = await readTransition()
      await window.screenshot({ path: resolve(reviewRoot, `${screenshotPrefix}-${name}.png`) })
      samples.push({ name, time, frame })
      if (!focalFrame && frame.direction === direction && frame.phase === focalPhase) {
        focalFrame = frame
        await window.screenshot({ path: resolve(reviewRoot, `${screenshotPrefix}-${focalPhase}.png`) })
      }
    }
  } finally {
    await window.evaluate((storageKey) => {
      const lampController = window.__ailearnAuthLampCapture
      const ambientController = window.__ailearnAuthAmbientCapture
      window.localStorage.removeItem(storageKey)
      lampController?.finish()
      ambientController?.finish()
    }, lampFrameCaptureStorageKey)
  }

  if (!focalFrame) {
    throw new Error(`${label} never reached its ${focalPhase} cue in the sampled transition: ${JSON.stringify(samples)}`)
  }

  const sourceOpacityKey = direction === 'to-night' ? 'daySceneOpacity' : 'nightSceneOpacity'
  const targetOpacityKey = direction === 'to-night' ? 'nightSceneOpacity' : 'daySceneOpacity'
  const hasSourceToDuskCrossfade = samples.some(({ frame }) => (
    frame[sourceOpacityKey] !== null
      && frame.duskSceneOpacity !== null
      && frame[sourceOpacityKey] > 0.02
      && frame.duskSceneOpacity > 0.02
  ))
  const hasDuskToTargetCrossfade = samples.some(({ frame }) => (
    frame[targetOpacityKey] !== null
      && frame.duskSceneOpacity !== null
      && frame[targetOpacityKey] > 0.02
      && frame.duskSceneOpacity > 0.02
  ))
  const hasContinuousSceneOpacity = samples.every(({ frame }) => {
    if (frame.daySceneOpacity === null || frame.duskSceneOpacity === null || frame.nightSceneOpacity === null) return false
    const totalOpacity = frame.daySceneOpacity + frame.duskSceneOpacity + frame.nightSceneOpacity
    return totalOpacity >= 0.94 && totalOpacity <= 1.06
  })
  const beforeHandoffFrame = samples.find(({ name }) => name === '03-before-handoff')?.frame
  const afterHandoffFrame = samples.find(({ name }) => name === '04-theme-handoff')?.frame
  const sourceTheme = direction === 'to-night' ? 'day' : 'night'
  const hasVisibleLampEffect = samples.some(({ name, frame }) => (
    name !== '00-click'
      && frame.ambientEffect === direction
      && (frame.ambientEffectIntensity ?? 0) > 0.05
      && (frame.ambientEffectProgress ?? 0) > 0
  ))
  if (
    !hasSourceToDuskCrossfade
    || !hasDuskToTargetCrossfade
    || !hasContinuousSceneOpacity
    || !hasVisibleLampEffect
    || samples.some(({ frame }) => frame.hasSyntheticLightLayers)
    || samples.some(({ name, frame }) => name !== '00-click' && (frame.lampLabelOpacity ?? 1) > 0.03)
    || beforeHandoffFrame?.gateVisualTheme !== sourceTheme
    || afterHandoffFrame?.gateVisualTheme !== expectedTheme
  ) {
    throw new Error(`${label} did not preserve a continuous three-scene transition: ${JSON.stringify({ beforeHandoffFrame, afterHandoffFrame, samples })}`)
  }

  await window.waitForFunction(
    ({ expectedDirection, expectedTheme }) => {
      const gate = document.querySelector('.desktop-access-gate')
      const switcher = document.querySelector('.desktop-access-gate__lamp-switch')
      return gate?.getAttribute('data-gate-visual-theme') === expectedTheme
        && gate.getAttribute('data-gate-scene') === expectedDirection.slice(3)
        && switcher?.getAttribute('data-transition-direction') === 'idle'
        && switcher.getAttribute('data-transition-phase') === 'idle'
        && document.querySelector('.desktop-access-gate__ambient-canvas')?.getAttribute('data-auth-ambient-effect') === 'idle'
    },
    { expectedDirection: direction, expectedTheme },
    { timeout: 8_000 },
  )
  const settledFrame = await readTransition()
  const activeBackdrop = expectedTheme === 'night' ? settledFrame.nightSceneBackdrop : settledFrame.daySceneBackdrop
  const inactiveOpacity = expectedTheme === 'night' ? settledFrame.daySceneOpacity : settledFrame.nightSceneOpacity
  if (
    settledFrame.controlDisabled
    || !activeBackdrop?.includes(expectedBackdropAsset)
    || inactiveOpacity === null
    || inactiveOpacity > 0.01
    || settledFrame.duskSceneOpacity === null
    || settledFrame.duskSceneOpacity > 0.01
  ) {
    throw new Error(`${label} did not settle into the expected scene: ${JSON.stringify(settledFrame)}`)
  }
  await writeFile(
    resolve(reviewRoot, `${screenshotPrefix}-transition.json`),
    `${JSON.stringify({ direction, firstFrame, focalFrame, samples, settledFrame }, null, 2)}\n`,
    'utf8',
  )
  return settledFrame
}

async function captureRegistrationGate(window) {
  await window.getByRole('button', { name: '还没有账号？注册' }).click()
  const registerGate = window.locator('.desktop-access-gate[data-gate-variant="register"]')
  await registerGate.waitFor({ state: 'visible', timeout: 8_000 })
  await window.waitForFunction(
    () => getComputedStyle(document.querySelector('.desktop-access-gate__backdrop-layer--day')).backgroundImage.includes('register-worktable-day-v1.png'),
    undefined,
    { timeout: 8_000 },
  )
  await window.waitForFunction(
    () => document.querySelector('.desktop-access-gate__ambient-canvas')?.getAttribute('data-auth-ambient-state') === 'settled',
    undefined,
    { timeout: 8_000 },
  )
  await settleSurface(window)

  const readLayout = () => window.evaluate(() => {
    const gate = document.querySelector('.desktop-access-gate')
    const panel = gate?.querySelector('.desktop-access-gate__panel')
    const heading = gate?.querySelector('.desktop-access-gate__heading h1')
    const ambient = gate?.querySelector('.desktop-access-gate__ambient-canvas')
    const ambientCanvas = ambient?.querySelector('canvas')
    const lampControl = gate?.querySelector('.desktop-access-gate__lamp-control')
    const inputs = [...(gate?.querySelectorAll('input') ?? [])]
    const controls = [...(gate?.querySelectorAll('input, button') ?? [])]
    const rect = (element) => {
      if (!(element instanceof HTMLElement)) return null
      const bounds = element.getBoundingClientRect()
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
    }
    const textRects = (element) => {
      if (!(element instanceof HTMLElement)) return []
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const lines = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        lines.push(...[...range.getClientRects()].map((bounds) => ({
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
          height: bounds.height,
        })))
      }
      return lines
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      variant: gate?.getAttribute('data-gate-variant') ?? null,
      motionState: gate?.getAttribute('data-gate-motion-state') ?? null,
      backdrop: getComputedStyle(gate?.querySelector('.desktop-access-gate__backdrop-layer--day') ?? document.body).backgroundImage,
      ambientState: ambient?.getAttribute('data-auth-ambient-state') ?? null,
      ambientMotion: ambient?.getAttribute('data-auth-ambient-motion') ?? null,
      ambientCanvasCount: ambient?.querySelectorAll('canvas').length ?? 0,
      ambientCanvasPointerEvents: ambientCanvas instanceof HTMLElement ? getComputedStyle(ambientCanvas).pointerEvents : null,
      ambientCanvasAriaHidden: ambientCanvas?.getAttribute('aria-hidden') ?? null,
      lampControl: rect(lampControl),
      lampControlLabel: lampControl?.getAttribute('aria-label') ?? null,
      lampControlDisabled: lampControl instanceof HTMLButtonElement ? lampControl.disabled : null,
      gate: rect(gate),
      panel: rect(panel),
      heading: rect(heading),
      headingTextRects: textRects(heading),
      headingClientWidth: heading instanceof HTMLElement ? heading.clientWidth : 0,
      headingScrollWidth: heading instanceof HTMLElement ? heading.scrollWidth : 0,
      inputs: inputs.map(rect),
      controls: controls.map(rect),
      gateClientHeight: gate instanceof HTMLElement ? gate.clientHeight : 0,
      gateClientWidth: gate instanceof HTMLElement ? gate.clientWidth : 0,
      gateScrollHeight: gate instanceof HTMLElement ? gate.scrollHeight : 0,
      gateScrollWidth: gate instanceof HTMLElement ? gate.scrollWidth : 0,
      gateOverflowY: gate instanceof HTMLElement ? getComputedStyle(gate).overflowY : null,
    }
  })

  const desktop = await readLayout()
  if (
    desktop.variant !== 'register'
    || desktop.motionState !== 'settled'
    || !desktop.backdrop.includes('register-worktable-day-v1.png')
    || desktop.ambientState !== 'settled'
    || desktop.ambientMotion !== 'persistent'
    || desktop.ambientCanvasCount !== 1
    || desktop.ambientCanvasPointerEvents !== 'none'
    || desktop.ambientCanvasAriaHidden !== 'true'
    || !desktop.lampControl
    || desktop.lampControlDisabled
    || desktop.lampControlLabel !== '调整场景时间'
    || !desktop.panel
    || !desktop.heading
    || desktop.headingScrollWidth > desktop.headingClientWidth + 1
    || desktop.headingTextRects.some((line) => line.left < desktop.heading.left - 1 || line.right > desktop.heading.right + 1)
    || desktop.inputs.length !== 4
    || desktop.gateOverflowY !== 'auto'
    || desktop.gateScrollWidth > desktop.gateClientWidth + 1
    || desktop.panel.left < -1
    || desktop.panel.right > desktop.viewport.width + 1
    || desktop.controls.some((control) => !control || control.height < 44 || control.left < -1 || control.right > desktop.viewport.width + 1)
  ) {
    throw new Error(`Desktop registration Gate layout drifted: ${JSON.stringify(desktop)}`)
  }
  await writeFile(resolve(reviewRoot, 'desktop-access-gate-register-layout.json'), `${JSON.stringify(desktop, null, 2)}\n`, 'utf8')
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-access-gate-register.png') })

  await setSize(1024, 700)
  await settleSurface(window)
  const minimumDesktop = await readLayout()
  if (
    minimumDesktop.viewport.width !== 1024
    || minimumDesktop.viewport.height !== 700
    || !minimumDesktop.panel
    || !minimumDesktop.heading
    || minimumDesktop.headingScrollWidth > minimumDesktop.headingClientWidth + 1
    || minimumDesktop.headingTextRects.some((line) => line.left < minimumDesktop.heading.left - 1 || line.right > minimumDesktop.heading.right + 1)
    || minimumDesktop.ambientState !== 'settled'
    || minimumDesktop.ambientMotion !== 'persistent'
    || minimumDesktop.ambientCanvasCount !== 1
    || !minimumDesktop.lampControl
    || minimumDesktop.lampControlDisabled
    || minimumDesktop.gateScrollWidth > minimumDesktop.gateClientWidth + 1
    || minimumDesktop.panel.left < -1
    || minimumDesktop.panel.right > minimumDesktop.viewport.width + 1
    || minimumDesktop.controls.some((control) => !control || control.height < 44 || control.left < -1 || control.right > minimumDesktop.viewport.width + 1)
  ) {
    throw new Error(`Desktop registration Gate 1024x700 layout drifted: ${JSON.stringify(minimumDesktop)}`)
  }
  await writeFile(resolve(reviewRoot, 'desktop-access-gate-register-1024x700.json'), `${JSON.stringify(minimumDesktop, null, 2)}\n`, 'utf8')
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-access-gate-register-1024x700.png') })
  await setSize(1440, 810)
  await settleSurface(window)

  await captureLampTransition(window, {
    label: 'Desktop registration Gate day-to-night lamp transition',
    direction: 'to-night',
    expectedTheme: 'night',
    expectedBackdropAsset: 'register-worktable-night-v1.png',
    screenshotPrefix: 'desktop-access-gate-register-to-night',
  })
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-access-gate-register-night.png') })
  await captureLampTransition(window, {
    label: 'Desktop registration Gate night-to-day lamp transition',
    direction: 'to-day',
    expectedTheme: 'day',
    expectedBackdropAsset: 'register-worktable-day-v1.png',
    screenshotPrefix: 'desktop-access-gate-register-to-day',
  })

  await setZoomFactor(2)
  await window.waitForTimeout(250)
  await registerGate.locator('button').last().scrollIntoViewIfNeeded()
  const zoom200 = await readLayout()
  const finalControl = zoom200.controls.at(-1)
  if (
    zoom200.viewport.width !== 720
    || !zoom200.panel
    || !finalControl
    || zoom200.gateOverflowY !== 'auto'
    || zoom200.gateScrollWidth > zoom200.gateClientWidth + 1
    || zoom200.ambientState !== 'disabled'
    || zoom200.ambientCanvasCount !== 0
    || zoom200.panel.left < -1
    || zoom200.panel.right > zoom200.viewport.width + 1
    || finalControl.top < -1
    || finalControl.bottom > zoom200.viewport.height + 1
  ) {
    throw new Error(`Desktop registration Gate 200% reflow drifted: ${JSON.stringify(zoom200)}`)
  }
  await writeFile(resolve(reviewRoot, 'desktop-access-gate-register-zoom-200.json'), `${JSON.stringify(zoom200, null, 2)}\n`, 'utf8')
  const zoomImage = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0]
    if (!target) throw new Error('Desktop registration Gate capture window disappeared')
    return (await target.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(resolve(reviewRoot, 'desktop-access-gate-register-zoom-200.png'), Buffer.from(zoomImage, 'base64'))

  await setSize(640, 810, true)
  await window.waitForTimeout(250)
  await registerGate.evaluate((element) => {
    if (element instanceof HTMLElement) element.scrollTop = 0
  })
  await window.waitForTimeout(120)
  const compact = await readLayout()
  if (
    compact.viewport.width !== 320
    || !compact.panel
    || !compact.heading
    || compact.inputs.length !== 4
    || compact.gateOverflowY !== 'auto'
    || compact.gateScrollWidth > compact.gateClientWidth + 1
    || compact.ambientState !== 'disabled'
    || compact.ambientCanvasCount !== 0
    || compact.headingScrollWidth > compact.headingClientWidth + 1
    || compact.headingTextRects.some((line) => line.left < compact.heading.left - 1 || line.right > compact.heading.right + 1)
    || compact.panel.left < -1
    || compact.panel.right > compact.viewport.width + 1
    || compact.inputs.some((input) => !input || input.height < 44 || input.left < -1 || input.right > compact.viewport.width + 1)
  ) {
    throw new Error(`Desktop registration Gate 320 CSS px reflow drifted: ${JSON.stringify(compact)}`)
  }
  await writeFile(resolve(reviewRoot, 'desktop-access-gate-register-320-css-px.json'), `${JSON.stringify(compact, null, 2)}\n`, 'utf8')
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-access-gate-register-320-css-px.png') })

  await setZoomFactor(1)
  await setSize(1440, 810)
  await window.waitForTimeout(250)
  await registerGate.evaluate((element) => {
    if (element instanceof HTMLElement) element.scrollTop = 0
  })
  await window.waitForFunction(
    () => document.querySelector('.desktop-access-gate__ambient-canvas')?.getAttribute('data-auth-ambient-state') === 'settled',
    undefined,
    { timeout: 8_000 },
  )
  await registerGate.locator('input').first().focus()
  await window.waitForFunction(
    () => document.querySelector('.desktop-access-gate__ambient-canvas')?.getAttribute('data-auth-ambient-state') === 'quiet',
    undefined,
    { timeout: 2_000 },
  )
  await writeFile(resolve(reviewRoot, 'desktop-access-gate-register-input-pauses-ambient.json'), `${JSON.stringify({
    ambientState: await registerGate.locator('.desktop-access-gate__ambient-canvas').getAttribute('data-auth-ambient-state'),
    activeElement: await window.evaluate(() => document.activeElement?.tagName ?? null),
  }, null, 2)}\n`, 'utf8')
  await window.getByRole('button', { name: '已有账号？登录' }).click()
  await window.locator('.desktop-access-gate[data-gate-variant="default"]').waitFor({ state: 'visible', timeout: 8_000 })
  await settleSurface(window)
}

async function enterOwnerRoomThroughGate(window) {
  await window.waitForFunction(
    () => Boolean(document.querySelector('.action-rail')) || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')),
    undefined,
    { timeout: 20_000 },
  )
  const gateAssetSourceHandle = await window.waitForFunction(
    () => document.querySelector('.desktop-access-gate')?.getAttribute('data-gate-asset-source') ?? null,
    undefined,
    { timeout: 8_000 },
  )
  const gateAssetSource = await gateAssetSourceHandle.jsonValue()
  await gateAssetSourceHandle.dispose()
  if (typeof gateAssetSource !== 'string' || !['manifest', 'fallback'].includes(gateAssetSource)) {
    throw new Error(`Desktop gate asset source contract drifted: ${gateAssetSource ?? 'missing'}`)
  }
  if (gateAssetSource !== 'manifest') console.log(`Desktop gate is using its static asset fallback: ${gateAssetSource}`)
  if (await window.locator('.action-rail').count() === 0) {
    await window.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL)
    await window.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD)
    await window.getByRole('button', { name: '登录', exact: true }).click()
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
  await window.locator('.action-rail').waitFor({ state: 'attached', timeout: 1_000 })

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
    await settleSurface(window)
    await window.locator('.desktop-access-gate__lamp-control').click()
    const timeControl = await window.evaluate(() => {
      const gate = document.querySelector('.desktop-access-gate')
      const menu = document.querySelector('#desktop-gate-time-menu')
      const choices = [...(menu?.querySelectorAll('[data-scene-choice]') ?? [])]
      return {
        initialMode: gate?.getAttribute('data-gate-time-mode') ?? null,
        menuOpen: menu instanceof HTMLElement && getComputedStyle(menu).display !== 'none',
        choices: choices.map((choice) => choice.getAttribute('data-scene-choice')),
        systemCopy: menu?.querySelector('[data-scene-choice="system"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      }
    })
    if (
      timeControl.initialMode !== 'system'
      || !timeControl.menuOpen
      || JSON.stringify(timeControl.choices) !== JSON.stringify(['system', 'day', 'dusk', 'night'])
      || !timeControl.systemCopy?.includes('跟随现在')
    ) {
      throw new Error(`DesktopAccessGate time control drifted: ${JSON.stringify(timeControl)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-access-gate-time-control.json'), `${JSON.stringify(timeControl, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-access-gate-time-control.png') })
    await selectAuthScene(window, 'day')
    await capturePersistentAmbient(window)
    const gateBoundary = await readGateBoundary(window)
    if (!gateBoundary.present || gateBoundary.hasRoomDom || gateBoundary.hasOnboarding || gateBoundary.hasActionRail) {
      throw new Error(`Anonymous capture did not stop at the fail-closed DesktopAccessGate: ${JSON.stringify(gateBoundary)}`)
    }
    const gateDesktop = await window.evaluate(() => {
      const gate = document.querySelector('.desktop-access-gate')
      const controls = [...(gate?.querySelectorAll('input, .desktop-access-gate__primary, .desktop-access-gate__text-action, .desktop-access-gate__workspace-list button') ?? [])]
      const lampControl = gate?.querySelector('.desktop-access-gate__lamp-control')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return {
          tagName: element.tagName.toLowerCase(),
          className: element.className,
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
          height: bounds.height,
        }
      }
      const gateBounds = gate instanceof HTMLElement ? gate.getBoundingClientRect() : null
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        phase: gateBoundaryPhase(gate),
        gate: gateBounds
          ? { top: gateBounds.top, bottom: gateBounds.bottom, left: gateBounds.left, right: gateBounds.right, width: gateBounds.width, height: gateBounds.height }
          : null,
        controls: controls.map(rect),
        lampControl: rect(lampControl),
        lampControlLabel: lampControl?.getAttribute('aria-label') ?? null,
        lampControlDisabled: lampControl instanceof HTMLButtonElement ? lampControl.disabled : null,
        gateClientHeight: gate instanceof HTMLElement ? gate.clientHeight : 0,
        gateClientWidth: gate instanceof HTMLElement ? gate.clientWidth : 0,
        gateScrollHeight: gate instanceof HTMLElement ? gate.scrollHeight : 0,
        gateScrollWidth: gate instanceof HTMLElement ? gate.scrollWidth : 0,
        gateOverflowY: gate instanceof HTMLElement ? getComputedStyle(gate).overflowY : null,
      }

      function gateBoundaryPhase(element) {
        return element?.querySelector('.desktop-access-gate__form')
          ? 'auth'
          : element?.querySelector('.desktop-access-gate__workspace-list')
            ? 'workspace'
            : element?.querySelector('.desktop-access-gate__notice')
              ? 'blocked'
              : 'loading'
      }
    })
    if (
      !gateDesktop.gate
      || gateDesktop.gateOverflowY !== 'auto'
      || gateDesktop.gateScrollWidth > gateDesktop.gateClientWidth + 1
      || !gateDesktop.lampControl
      || gateDesktop.lampControlDisabled
      || gateDesktop.lampControlLabel !== '调整场景时间'
      || gateDesktop.controls.some((control) => !control || control.height < 44 || control.left < -1 || control.right > gateDesktop.viewport.width + 1)
    ) {
      throw new Error(`DesktopAccessGate desktop action contract drifted: ${JSON.stringify(gateDesktop)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-access-gate-layout.json'), `${JSON.stringify(gateDesktop, null, 2)}\n`, 'utf8')
    await writeCaptureRuntime(window, 'fail_closed_gate', gateBoundary)
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-access-gate.png') })
    await window.screenshot({ path: resolve(reviewRoot, 'desktop.png') })
    await captureDuskChoice(window, {
      expectedBackdropAsset: 'auth-alcove-dusk-v1.png',
      screenshotPrefix: 'desktop-access-gate-to-dusk',
    })
    await selectAuthScene(window, 'day')
    await captureLampTransition(window, {
      label: 'Desktop login Gate day-to-night lamp transition',
      direction: 'to-night',
      expectedTheme: 'night',
      expectedBackdropAsset: 'auth-alcove-night-v1.png',
      screenshotPrefix: 'desktop-access-gate-to-night',
    })
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-access-gate-night.png') })
    await captureLampTransition(window, {
      label: 'Desktop login Gate night-to-day lamp transition',
      direction: 'to-day',
      expectedTheme: 'day',
      expectedBackdropAsset: 'auth-alcove-day-v1.png',
      screenshotPrefix: 'desktop-access-gate-to-day',
    })
    await captureRegistrationGate(window)
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2)
    })
    await window.waitForTimeout(250)
    await window.locator('.desktop-access-gate__panel').scrollIntoViewIfNeeded()
    await window.locator('.desktop-access-gate__panel button:last-of-type, .desktop-access-gate__notice, .desktop-access-gate__loading').last().scrollIntoViewIfNeeded()
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
    await setSize(640, 810, true)
    await window.waitForTimeout(250)
    await window.locator('.desktop-access-gate').evaluate((element) => {
      if (element instanceof HTMLElement) element.scrollTop = 0
    })
    await window.waitForTimeout(120)
    const gate320 = await window.evaluate(() => {
      const gate = document.querySelector('.desktop-access-gate')
      const panel = gate?.querySelector('.desktop-access-gate__panel')
      const heading = gate?.querySelector('h1')
      const form = gate?.querySelector('.desktop-access-gate__form')
      const inputs = [...(form?.querySelectorAll('input') ?? [])]
      const primary = gate?.querySelector('.desktop-access-gate__primary')
      const textAction = gate?.querySelector('.desktop-access-gate__text-action')
      const notice = gate?.querySelector('.desktop-access-gate__notice')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
      }
      const horizontalWithinViewport = (element) => {
        const bounds = rect(element)
        return Boolean(bounds && bounds.left >= -1 && bounds.right <= window.innerWidth + 1)
      }
      const controls = [...inputs, primary, textAction].filter(Boolean)
      const gateStyle = gate instanceof HTMLElement ? getComputedStyle(gate) : null
      const formStyle = form instanceof HTMLElement ? getComputedStyle(form) : null
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        phase: gate?.querySelector('.desktop-access-gate__form') ? 'auth' : notice ? 'blocked' : 'other',
        gate: rect(gate),
        panel: rect(panel),
        heading: rect(heading),
        form: rect(form),
        notice: rect(notice),
        inputs: inputs.map(rect),
        primary: rect(primary),
        textAction: rect(textAction),
        inputHeights: inputs.map((input) => rect(input)?.height ?? 0),
        primaryHeight: rect(primary)?.height ?? 0,
        textActionHeight: rect(textAction)?.height ?? 0,
        gateClientHeight: gate instanceof HTMLElement ? gate.clientHeight : 0,
        gateClientWidth: gate instanceof HTMLElement ? gate.clientWidth : 0,
        gateScrollHeight: gate instanceof HTMLElement ? gate.scrollHeight : 0,
        gateScrollWidth: gate instanceof HTMLElement ? gate.scrollWidth : 0,
        gateOverflowY: gateStyle?.overflowY ?? null,
        formOverflowY: formStyle?.overflowY ?? null,
        controlsHorizontallyWithinViewport: controls.every(horizontalWithinViewport),
        headingFocused: document.activeElement === heading,
        controlCount: controls.length,
      }
    })
    if (gate320.viewport.width !== 320
      || !gate320.gate
      || !gate320.panel
      || gate320.gateOverflowY !== 'auto'
      || gate320.gateScrollWidth > gate320.gateClientWidth + 1
      || !gate320.controlsHorizontallyWithinViewport
      || !gate320.headingFocused
      || gate320.controlCount < 1
      || gate320.inputHeights.some((height) => height < 44)
      || (gate320.primary && gate320.primaryHeight < 44)
      || (gate320.textAction && gate320.textActionHeight < 44)) {
      throw new Error(`DesktopAccessGate 320 CSS px reflow drifted: ${JSON.stringify(gate320)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-access-gate-320-css-px.json'), `${JSON.stringify(gate320, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-access-gate-320-css-px.png') })
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
    if (await window.locator('.onboarding-layer').evaluate((node) => getComputedStyle(node).pointerEvents) !== 'auto') throw new Error('First-entry guide does not block scene pointer input')
    if (await window.locator('.scene-stage').evaluate((node) => getComputedStyle(node).zIndex) !== '60') throw new Error('First-entry guide is below the task stacking context')
    if (await window.locator('.onboarding-video').count() !== 1) throw new Error('Approved onboarding video was not mounted')
    if (await window.locator('.onboarding-video track[kind="captions"]').count() !== 1) throw new Error('Onboarding captions track is missing')
    if (await window.locator('.onboarding-video track[kind="captions"]').getAttribute('default') !== null) throw new Error('Native captions overlap the visible DOM transcript')
    if (await window.locator('.onboarding-layer audio').count() !== 1) throw new Error('Independent onboarding voice track is missing')
    if (await window.locator('.action-rail').getAttribute('aria-hidden') !== 'true') throw new Error('First-entry guide did not quiet the primary action island')
    if (!(await window.locator('main#main-content').evaluate((node) => (node instanceof HTMLElement) && node.inert))) throw new Error('First-entry guide did not inert the main task layer')
    if (!(await window.locator('.room-control').evaluate((node) => (node instanceof HTMLElement) && node.inert))) throw new Error('First-entry guide did not inert the control island')
    if (await window.locator('.hotspot-layer button').count() !== 0) throw new Error('First-entry guide left room hotspots focusable')
    await window.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '跳过首次引导')
    await window.screenshot({ path: resolve(reviewRoot, 'onboarding.png') })
    await window.getByRole('button', { name: '无声进入' }).click()
  }

  // The first-entry guide intentionally recesses the action rail while the
  // Room remains interactive only through the guide controls. Wait for the
  // rail after dismissing that layer rather than treating its hidden state as
  // a failed gate handoff.
  await window.locator('.action-rail').waitFor({ state: 'visible', timeout: 5_000 })

  const mediaReady = await window.waitForFunction(() => {
    const video = document.querySelector('.window-ambient-video__media')
    return Boolean(document.querySelector('.window-ambient-video--ready'))
      || !video
      || Boolean((video instanceof HTMLVideoElement) && video.error)
  }, undefined, { timeout: 12_000 }).catch(() => false)
  if (!mediaReady) console.log('Window ambient media did not settle; continuing with poster-only evidence')
  await window.waitForTimeout(250)

  await writeCaptureRuntime(window, 'real_journey')

  await window.waitForFunction(
    () => {
      const canvasHost = document.querySelector('.room-pixi-canvas')
      const declaredLayerCount = Number.parseInt(
        document.querySelector('.room-reference-frame')?.getAttribute('data-scene-room-layer-count') ?? '',
        10,
      )
      return declaredLayerCount === 0
        || (Boolean(canvasHost) && canvasHost.getAttribute('data-scene-renderer-state') !== 'loading')
    },
    undefined,
    { timeout: 12_000 },
  )
  const roomRendererContract = await window.evaluate(() => {
    const canvasHost = document.querySelector('.room-pixi-canvas')
    const frame = document.querySelector('.room-reference-frame')
    const homeImages = [...document.querySelectorAll('.room-backplate--home-day, .room-backplate--home-night')]
    const state = canvasHost?.getAttribute('data-scene-renderer-state') ?? 'missing'
    const canvasDepthOrder = canvasHost?.getAttribute('data-scene-renderer-depth-order') ?? null
    const canvasDepthOrderValid = canvasHost?.getAttribute('data-scene-renderer-depth-order-valid') === 'true'
    const canvasLayerCandidates = Number.parseInt(canvasHost?.getAttribute('data-scene-renderer-layer-candidates') ?? '', 10)
    const canvasIndependentLayers = Number.parseInt(canvasHost?.getAttribute('data-scene-renderer-independent-layers') ?? '', 10)
    const canvasLayerBlocked = Number.parseInt(canvasHost?.getAttribute('data-scene-renderer-layer-blocked') ?? '', 10)
    const canvasLayerFailed = Number.parseInt(canvasHost?.getAttribute('data-scene-renderer-layer-failed') ?? '', 10)
    let canvasLayerAudit = null
    try {
      const parsed = JSON.parse(canvasHost?.getAttribute('data-scene-renderer-layer-audit') ?? 'null')
      canvasLayerAudit = Array.isArray(parsed) ? parsed : null
    } catch {
      canvasLayerAudit = null
    }
    let canvasLayerIdentities = null
    try {
      const parsed = JSON.parse(canvasHost?.getAttribute('data-scene-renderer-layer-identities') ?? 'null')
      canvasLayerIdentities = Array.isArray(parsed) ? parsed : null
    } catch {
      canvasLayerIdentities = null
    }
    const identityKey = (entry) => JSON.stringify([entry?.assetId, entry?.theme, entry?.depth, entry?.order])
    const placementKey = (entry) => JSON.stringify([entry?.theme, entry?.depth, entry?.order])
    const validLayerThemes = ['day', 'night']
    const validLayerDepths = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']
    const maxLayerOrder = 63
    const blockedLayerReasons = ['invalid-source', 'opaque-layer', 'review-not-approved', 'release-not-approved', 'source-size-mismatch', 'invalid-registration', 'registration-out-of-bounds', 'unsupported-anchor', 'upload-mode-unavailable']
    const failedLayerReasons = ['texture-load-failed', 'node-mount-failed', 'runtime-failed', 'cancelled']
    const isValidCanvasLayerIdentity = (entry) => (
      entry
      && typeof entry.assetId === 'string'
      && entry.assetId.trim().length > 0
      && validLayerThemes.includes(entry.theme)
      && validLayerDepths.includes(entry.depth)
      && Number.isInteger(entry.order)
      && entry.order >= 0
      && entry.order <= maxLayerOrder
    )
    const isCanonicalLayerOrder = (entries) => entries.every((entry, index) => {
      if (index === 0) return true
      const previous = entries[index - 1]
      const previousDepth = validLayerDepths.indexOf(previous.depth)
      const currentDepth = validLayerDepths.indexOf(entry.depth)
      return previousDepth < currentDepth
        || (previousDepth === currentDepth && previous.order <= entry.order)
    })
    const isValidCanvasLayerAuditRecord = (entry) => {
      if (!isValidCanvasLayerIdentity(entry)) return false
      if (entry.status === 'mounted') return entry.reason === 'mounted'
      if (entry.status === 'blocked') return blockedLayerReasons.includes(entry.reason)
      if (entry.status === 'failed') return failedLayerReasons.includes(entry.reason)
      return false
    }
    const candidateIdentityFieldsValid = Array.isArray(canvasLayerIdentities)
      && canvasLayerIdentities.every(isValidCanvasLayerIdentity)
    const auditIdentityFieldsValid = Array.isArray(canvasLayerAudit)
      && canvasLayerAudit.every(isValidCanvasLayerIdentity)
    const canvasLayerOrderValid = candidateIdentityFieldsValid
      && new Set(canvasLayerIdentities.map(placementKey)).size === canvasLayerIdentities.length
      && isCanonicalLayerOrder(canvasLayerIdentities)
    const canvasLayerIdentityValid = candidateIdentityFieldsValid
      && auditIdentityFieldsValid
      && canvasLayerIdentities.length === canvasLayerCandidates
      && new Set(canvasLayerIdentities.map(identityKey)).size === canvasLayerIdentities.length
      && JSON.stringify(canvasLayerAudit.map(identityKey)) === JSON.stringify(canvasLayerIdentities.map(identityKey))
      && canvasLayerOrderValid
    const canvasLayerAuditValid = Number.isInteger(canvasLayerCandidates)
      && canvasLayerCandidates >= 0
      && Number.isInteger(canvasIndependentLayers)
      && canvasIndependentLayers >= 0
      && Number.isInteger(canvasLayerBlocked)
      && canvasLayerBlocked >= 0
      && Number.isInteger(canvasLayerFailed)
      && canvasLayerFailed >= 0
      && Array.isArray(canvasLayerAudit)
      && canvasLayerAudit.length === canvasLayerCandidates
      && canvasLayerAudit.filter((entry) => entry?.status === 'mounted').length === canvasIndependentLayers
      && canvasLayerAudit.filter((entry) => entry?.status === 'blocked').length === canvasLayerBlocked
      && canvasLayerAudit.filter((entry) => entry?.status === 'failed').length === canvasLayerFailed
      && canvasLayerCandidates === canvasIndependentLayers + canvasLayerBlocked + canvasLayerFailed
      && canvasLayerIdentityValid
      && canvasLayerOrderValid
      && canvasLayerAudit.every(isValidCanvasLayerAuditRecord)
    return {
      declaredLayerCount: Number.parseInt(frame?.getAttribute('data-scene-room-layer-count') ?? '', 10),
      state,
      reason: canvasHost?.getAttribute('data-scene-renderer-reason') ?? null,
      rendererName: canvasHost?.getAttribute('data-scene-renderer-name') ?? null,
      canvasCount: canvasHost?.querySelectorAll('canvas').length ?? 0,
      canvasActive: canvasHost?.getAttribute('data-scene-renderer-active') === 'true',
      canvasPhase: canvasHost?.getAttribute('data-scene-renderer-phase') ?? null,
      canvasWorld: canvasHost?.getAttribute('data-scene-renderer-world') ?? null,
      canvasDepthOrder,
      canvasDepthOrderValid,
      canvasLayerPolicy: canvasHost?.getAttribute('data-scene-renderer-layer-policy') ?? null,
      canvasLayerCandidates,
      canvasIndependentLayers,
      canvasLayerBlocked,
      canvasLayerFailed,
      canvasLayerIdentities,
      canvasLayerIdentityValid,
      canvasLayerOrderValid,
      canvasLayerAudit,
      canvasLayerAuditValid,
      frameCanvasActive: frame?.getAttribute('data-scene-room-canvas-active') === 'true',
      domRenderer: frame?.getAttribute('data-scene-renderer') ?? null,
      homePosterOpacity: homeImages.map((image) => Number.parseFloat(getComputedStyle(image).opacity)),
      canvasPointerEvents: canvasHost instanceof HTMLElement ? getComputedStyle(canvasHost).pointerEvents : null,
    }
  })
  await writeFile(resolve(reviewRoot, 'room-renderer-contract.json'), `${JSON.stringify(roomRendererContract, null, 2)}\n`, 'utf8')
  if (
    captureOwnerCredentialsAvailable
    && roomRendererContract.declaredLayerCount > 0
    && (roomRendererContract.state === 'missing' || roomRendererContract.state === 'loading')
  ) {
    throw new Error(`Room poster-backed renderer did not settle: ${JSON.stringify(roomRendererContract)}`)
  }
  if (
    captureOwnerCredentialsAvailable
    && roomRendererContract.state === 'ready'
    && (
      roomRendererContract.canvasCount !== 1
      || !roomRendererContract.canvasActive
      || !roomRendererContract.frameCanvasActive
      || roomRendererContract.domRenderer !== 'dom-2.5d'
      || roomRendererContract.canvasPhase !== 'idle'
      || roomRendererContract.canvasWorld !== '1672x941'
      || roomRendererContract.canvasDepthOrder !== 'D0>D1>D2>D3>D4>D5>D6'
      || !roomRendererContract.canvasDepthOrderValid
      || roomRendererContract.canvasLayerPolicy !== 'approved-transparent-raster-only'
      || !roomRendererContract.canvasLayerAuditValid
      || !roomRendererContract.canvasLayerOrderValid
      || !roomRendererContract.rendererName
      || roomRendererContract.homePosterOpacity.some((opacity) => !Number.isFinite(opacity) || opacity > 0.02)
      || roomRendererContract.canvasPointerEvents !== 'none'
    )
  ) {
    throw new Error(`Room Pixi canvas did not replace the home poster safely: ${JSON.stringify(roomRendererContract)}`)
  }
  if (
    captureOwnerCredentialsAvailable
    && roomRendererContract.declaredLayerCount === 0
    && (
      roomRendererContract.state !== 'missing'
      || roomRendererContract.canvasCount !== 0
      || roomRendererContract.frameCanvasActive
      || !roomRendererContract.homePosterOpacity.some((opacity) => Number.isFinite(opacity) && opacity > 0.02)
    )
  ) {
    throw new Error(`Empty Room layer pack mounted a redundant Pixi canvas: ${JSON.stringify(roomRendererContract)}`)
  }
  if (
    captureOwnerCredentialsAvailable
    && roomRendererContract.state === 'fallback'
    && !roomRendererContract.homePosterOpacity.some((opacity) => Number.isFinite(opacity) && opacity > 0.02)
  ) {
    throw new Error(`Room renderer fallback hid the canonical poster: ${JSON.stringify(roomRendererContract)}`)
  }

  const seatSceneContract = await window.evaluate(() => {
    const homeDay = document.querySelector('.room-backplate--home-day')
    const homeNight = document.querySelector('.room-backplate--home-night')
    const seatDay = document.querySelector('.room-backplate--seat-day')
    const seatNight = document.querySelector('.room-backplate--seat-night')
    const atmosphere = document.querySelector('.window-atmosphere')
    const frame = document.querySelector('.room-reference-frame')
    const depthRoot = document.querySelector('[data-scene-depth-root="room"]')
    const depthBands = [...document.querySelectorAll('[data-depth-band]')]
      .map((band) => band.getAttribute('data-depth-band'))
      .sort((left, right) => Number(left?.slice(1)) - Number(right?.slice(1)))
    const sceneAnchors = [...document.querySelectorAll('[data-scene-anchor]')].map((anchor) => anchor.getAttribute('data-scene-anchor'))
    return {
      homeDayPath: homeDay?.getAttribute('src'),
      homeNightPath: homeNight?.getAttribute('src'),
      seatDayPath: seatDay?.getAttribute('src'),
      seatNightPath: seatNight?.getAttribute('src'),
      atmospherePresent: atmosphere instanceof HTMLElement,
      homeWindowMedia: document.querySelectorAll('.window-ambient-video').length,
      legacySurfaceWorld: document.querySelectorAll('.surface-world').length,
      sceneRenderer: frame?.getAttribute('data-scene-renderer'),
      scenePhase: frame?.getAttribute('data-scene-phase'),
      depthMode: depthRoot?.getAttribute('data-scene-depth-mode'),
      depthBands,
      sceneAnchors,
    }
  })
  if (
    !seatSceneContract.homeDayPath?.includes('room-day.webp')
    || !seatSceneContract.homeNightPath?.includes('room-night.webp')
    || !seatSceneContract.seatDayPath?.includes('study-seat-day-v2.png')
    || !seatSceneContract.seatNightPath?.includes('study-seat-night-v2.png')
    || !seatSceneContract.atmospherePresent
    || seatSceneContract.homeWindowMedia !== 0
    || seatSceneContract.legacySurfaceWorld !== 0
    || seatSceneContract.sceneRenderer !== 'dom-2.5d'
    || seatSceneContract.scenePhase !== 'idle'
    || seatSceneContract.depthMode !== 'dom-2.5d'
    || JSON.stringify(seatSceneContract.depthBands) !== JSON.stringify(['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6'])
    || !['room.notebook', 'room.review', 'room.lamp', 'room.search', 'room.graph'].every((anchor) => seatSceneContract.sceneAnchors.includes(anchor))
  ) {
    throw new Error(`Overview-to-seat scene contract drifted: ${JSON.stringify(seatSceneContract)}`)
  }

  const homeExperienceContract = await window.evaluate(() => {
    const foreground = document.querySelector('.home-room-foreground img')
    const foregroundRoot = document.querySelector('.home-room-foreground')
    const life = document.querySelector('.home-room-life')
    const catalog = document.querySelector('.home-catalog')
    return {
      catalogInitiallyClosed: catalog?.getAttribute('aria-hidden') === 'true',
      lifeState: life?.getAttribute('data-home-room-life') ?? null,
      foregroundState: foregroundRoot?.getAttribute('data-home-foreground') ?? null,
      foregroundSource: foreground instanceof HTMLImageElement ? foreground.currentSrc : null,
      foregroundReady: foreground instanceof HTMLImageElement && foreground.complete,
      foregroundSize: foreground instanceof HTMLImageElement
        ? [foreground.naturalWidth, foreground.naturalHeight]
        : null,
      foregroundPointerEvents: foregroundRoot instanceof HTMLElement ? getComputedStyle(foregroundRoot).pointerEvents : null,
      depthObjectCount: document.querySelectorAll('.home-room-depth__object').length,
      hotspotCount: document.querySelectorAll('.hotspot-layer button').length,
      windowVideoCount: document.querySelectorAll('.window-ambient-video, .window-ambient-video__media').length,
    }
  })
  if (
    !homeExperienceContract.catalogInitiallyClosed
    || homeExperienceContract.lifeState !== 'active'
    || homeExperienceContract.foregroundState !== 'alive'
    || !homeExperienceContract.foregroundSource?.includes('home-foreground-leaves-v1.png')
    || !homeExperienceContract.foregroundReady
    || JSON.stringify(homeExperienceContract.foregroundSize) !== JSON.stringify([1672, 941])
    || homeExperienceContract.foregroundPointerEvents !== 'none'
    || homeExperienceContract.depthObjectCount !== 8
    || homeExperienceContract.hotspotCount !== 5
    || homeExperienceContract.windowVideoCount !== 0
  ) {
    throw new Error(`Home 2.5D experience contract drifted: ${JSON.stringify(homeExperienceContract)}`)
  }
  await writeFile(resolve(reviewRoot, 'home-2-5d-experience-contract.json'), `${JSON.stringify(homeExperienceContract, null, 2)}\n`, 'utf8')

  const sampleHomeLife = () => window.evaluate(() => {
    const read = (selector) => {
      const element = document.querySelector(selector)
      if (!(element instanceof Element)) return null
      const style = getComputedStyle(element)
      return { transform: style.transform, opacity: style.opacity }
    }
    return {
      foreground: read('.home-room-foreground img'),
      steam: read('.home-room-life__steam'),
      mote: read('.home-room-life__mote'),
      sheen: read('.home-room-life__window-sheen'),
      star: read('.home-room-life__stars circle'),
    }
  })
  const homeLifeStart = await sampleHomeLife()
  await window.waitForTimeout(900)
  const homeLifeEnd = await sampleHomeLife()
  const homeLifeMotion = {
    sampleWindowMs: 900,
    start: homeLifeStart,
    end: homeLifeEnd,
    changed: Object.keys(homeLifeStart).filter((key) => JSON.stringify(homeLifeStart[key]) !== JSON.stringify(homeLifeEnd[key])),
  }
  if (homeLifeMotion.changed.length < 2) {
    throw new Error(`Home environmental motion did not remain visibly alive: ${JSON.stringify(homeLifeMotion)}`)
  }
  await writeFile(resolve(reviewRoot, 'home-2-5d-motion-contract.json'), `${JSON.stringify(homeLifeMotion, null, 2)}\n`, 'utf8')

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

  await window.getByRole('button', { name: '全部功能', exact: true }).click()
  await window.locator('.home-catalog[aria-hidden="false"]').waitFor({ state: 'visible', timeout: 5_000 })
  const catalogModalContract = await window.evaluate(() => {
    const catalog = document.querySelector('.home-catalog')
    const header = catalog?.querySelector('.home-catalog__header')
    const recovery = catalog?.querySelector('details.home-recovery')
    if (recovery instanceof HTMLDetailsElement) recovery.open = true
    const recoveryStack = recovery?.querySelector('.run-recovery-stack')
    const recoveryCopy = recovery?.querySelector('.run-recovery-notice__copy strong')
    const recoverySecondary = recovery?.querySelector('.run-recovery-notice__secondary')
    const background = [
      document.querySelector('.scene-stage'),
      document.querySelector('.companion-presence'),
      document.querySelector('.room-control'),
    ]
    const otherActions = [...document.querySelectorAll('.home-command-deck > .rail-action:not(.rail-action--catalog)')]
    return {
      role: catalog?.getAttribute('role') ?? null,
      ariaModal: catalog?.getAttribute('aria-modal') ?? null,
      scrimCount: document.querySelectorAll('.home-catalog-scrim').length,
      headerPosition: header instanceof HTMLElement ? getComputedStyle(header).position : null,
      backgroundInert: background.every((element) => element instanceof HTMLElement && element.inert),
      otherActionsInert: otherActions.every((element) => element instanceof HTMLElement && element.inert),
      catalogColor: catalog instanceof HTMLElement ? getComputedStyle(catalog).color : null,
      recoveryPresent: recovery instanceof HTMLDetailsElement,
      recoveryCopyColor: recoveryCopy instanceof HTMLElement ? getComputedStyle(recoveryCopy).color : null,
      recoverySecondaryColor: recoverySecondary instanceof HTMLElement ? getComputedStyle(recoverySecondary).color : null,
      recoveryOverflowY: recoveryStack instanceof HTMLElement ? getComputedStyle(recoveryStack).overflowY : null,
    }
  })
  if (
    catalogModalContract.role !== 'dialog'
    || catalogModalContract.ariaModal !== 'true'
    || catalogModalContract.scrimCount !== 1
    || catalogModalContract.headerPosition !== 'sticky'
    || !catalogModalContract.backgroundInert
    || !catalogModalContract.otherActionsInert
    || (catalogModalContract.recoveryPresent && catalogModalContract.recoveryCopyColor !== catalogModalContract.catalogColor)
    || (catalogModalContract.recoverySecondaryColor !== null && catalogModalContract.recoverySecondaryColor !== catalogModalContract.catalogColor)
    || (catalogModalContract.recoveryPresent && catalogModalContract.recoveryOverflowY !== 'visible')
  ) {
    throw new Error(`Home catalog modal boundary drifted: ${JSON.stringify(catalogModalContract)}`)
  }
  await writeFile(resolve(reviewRoot, 'home-catalog-modal-contract.json'), `${JSON.stringify(catalogModalContract, null, 2)}\n`, 'utf8')
  await closeHomeCatalog(window)

  if (captureOwnerCredentialsAvailable) {
    await window.getByRole('button', { name: '全部功能', exact: true }).click()
    await window.locator('.home-catalog[aria-hidden="false"]').waitFor({ state: 'visible', timeout: 5_000 })
    const generationRecoveryButton = window.getByRole('button', { name: /查看恢复状态|恢复候选审核/ })
    await generationRecoveryButton.waitFor({ state: 'visible', timeout: 15_000 })
    await generationRecoveryButton.click()
    await window.getByRole('heading', { name: '整理学习卡' }).waitFor()
    // 页 12「学习卡生成中」/ 页 13「候选卡审核」的真实 DOM。旧的 .card-generation-surface*
    // 工作台（action edge / footer 双带 / recovery pair）已经没有任何渲染端生产者，
    // 原来那套 320px 布局探针测的是不存在的页面，已随该代工作台删除。
    const generationPaper = window.locator('.task-surface--card-generation .card-generation-board, .task-surface--card-generation .candidate-review-table').first()
    await generationPaper.waitFor({ state: 'visible', timeout: 20_000 })
    await settleSurface(window)
    const generationContract = await window.evaluate(() => {
      const surface = document.querySelector('.task-surface--card-generation')
      const paper = surface?.querySelector('.card-generation-board, .candidate-review-table')
      const board = surface?.querySelector('.card-generation-board')
      const candidate = surface?.querySelector('.candidate-study-card')
      const slip = surface?.querySelector('.candidate-review-slip')
      const buttons = [...(surface?.querySelectorAll('.card-generation-board__header button, .candidate-review-slip__actions button, .stamp-actions button') ?? [])]
      const surfaceBounds = surface?.getBoundingClientRect()
      return {
        heading: document.querySelector('.task-title h1')?.textContent?.trim() ?? null,
        paperVisible: Boolean(paper),
        boardFooterVisible: Boolean(board?.querySelector('.card-generation-board__footer')),
        candidateVisible: Boolean(candidate),
        candidateSlipVisible: Boolean(slip),
        hudStateVisible: Boolean(surface?.querySelector('.card-generation-hud-state')),
        errorText: surface?.querySelector('.card-generation-hud-state[role="alert"]')?.textContent?.trim() ?? null,
        // 本机推断出来的"成功"控件在服务端合同里不存在，必须为 0。
        localSuccessControls: [...document.querySelectorAll('button')].filter((button) => /本机候选|自动激活|生成完成/.test(button.textContent ?? '')).length,
        rawIdentityVisible: /\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(surface?.textContent ?? ''),
        actions: buttons.map((button) => {
          const bounds = button.getBoundingClientRect()
          return {
            label: (button.textContent ?? '').trim(),
            height: bounds.height,
            withinPaper: Boolean(surfaceBounds && bounds.left >= surfaceBounds.left - 1 && bounds.right <= surfaceBounds.right + 1),
            hit: bounds.width > 0 && bounds.height > 0
              ? document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === button
              : false,
          }
        }),
      }
    })
    if (generationContract.errorText) {
      throw new Error(`Owner Card Generation recovery did not load: ${generationContract.errorText}`)
    }
    if (!generationContract.paperVisible || !generationContract.heading) {
      throw new Error(`Owner Card Generation page did not render its paper: ${JSON.stringify(generationContract)}`)
    }
    if (!generationContract.boardFooterVisible && !generationContract.candidateVisible && !generationContract.hudStateVisible) {
      throw new Error(`Owner Card Generation recovery did not consume the real run safely: ${JSON.stringify(generationContract)}`)
    }
    if (generationContract.localSuccessControls !== 0 || generationContract.rawIdentityVisible) {
      throw new Error(`Owner Card Generation exposed a local-success control or a raw identity: ${JSON.stringify(generationContract)}`)
    }
    if (generationContract.actions.some((action) => !action.withinPaper || !action.hit)) {
      throw new Error(`Owner Card Generation action is outside the paper or not hit-testable: ${JSON.stringify(generationContract.actions)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-card-generation-owner-contract.json'), `${JSON.stringify(generationContract, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-card-generation-owner.png') })
    await window.getByLabel(/关闭任务面并返回/).click()
    await waitForScenePhase(window, 'idle')
    await window.locator('.task-surface').waitFor({ state: 'detached', timeout: 8_000 })
  }

  await closeHomeCatalog(window)
  await window.getByRole('button', { name: '与书桌上的 AI 伴星互动' }).click()
  await window.getByRole('heading', { name: '现在想从哪里继续？' }).waitFor()
  await window.locator('.companion-whisper__settings > summary').click()
  await window.locator('.companion-whisper').waitFor({ state: 'visible', timeout: 5_000 })
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-companion-settings.png') })
  await setZoomFactor(2)
  await setSize(640, 810, true)
  await window.waitForTimeout(400)
  const compactCompanion = await window.evaluate(() => {
    const root = document.querySelector('.companion-presence')
    const panel = document.querySelector('.companion-whisper')
    const deck = document.querySelector('.home-command-deck')
    const deckActions = [...document.querySelectorAll('.home-command-deck > .rail-action')]
    const controls = [...(panel?.querySelectorAll('.companion-whisper__close, .companion-action, .companion-whisper__settings > summary, .companion-form-switch button, .companion-reset-position') ?? [])]
    const rect = (element) => {
      if (!(element instanceof HTMLElement)) return null
      const bounds = element.getBoundingClientRect()
      return {
        tagName: element.tagName.toLowerCase(),
        className: element.className,
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        height: bounds.height,
      }
    }
    const withinViewport = (element) => {
      const bounds = rect(element)
      return Boolean(bounds
        && bounds.top >= -1
        && bounds.left >= -1
        && bounds.bottom <= window.innerHeight + 1
        && bounds.right <= window.innerWidth + 1)
    }
    const hitDetails = (element) => {
      const bounds = rect(element)
      if (!bounds) return { hit: false, target: null }
      const x = bounds.left + bounds.width / 2
      const y = bounds.top + bounds.height / 2
      const target = document.elementFromPoint(x, y)
      const targetElement = target instanceof HTMLElement ? target : null
      return {
        hit: target === element || target?.closest?.('button, summary') === element,
        target: targetElement ? {
          tagName: targetElement.tagName.toLowerCase(),
          className: targetElement.className,
          id: targetElement.id,
          bounds: rect(targetElement),
          pointerEvents: getComputedStyle(targetElement).pointerEvents,
          zIndex: getComputedStyle(targetElement).zIndex,
        } : null,
      }
    }
    const panelStyle = panel instanceof HTMLElement ? getComputedStyle(panel) : null
    const deckStyle = deck instanceof HTMLElement ? getComputedStyle(deck) : null
    const deckRect = rect(deck)
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      root: rect(root),
      panel: rect(panel),
      panelVisible: panel instanceof HTMLElement && panel.getClientRects().length > 0 && panelStyle?.visibility !== 'hidden' && panelStyle?.opacity !== '0',
      panelAriaHidden: panel?.getAttribute('aria-hidden') ?? null,
      controls: controls.map((element) => {
        const hit = hitDetails(element)
        return { ...rect(element), withinViewport: withinViewport(element), hit: hit.hit, hitTarget: hit.target }
      }),
      rootOverflow: root instanceof HTMLElement ? getComputedStyle(root).overflow : null,
      panelOverflowX: panelStyle?.overflowX ?? null,
      deck: deckRect,
      deckOpacity: deckStyle?.opacity ?? null,
      deckVisibility: deckStyle?.visibility ?? null,
      deckPointerEvents: deckStyle?.pointerEvents ?? null,
      deckActions: deckActions.map(rect),
      deckWithinViewport: Boolean(deckRect
        && deckRect.left >= -1
        && deckRect.right <= window.innerWidth + 1
        && deckRect.bottom <= window.innerHeight + 1),
      deckActionsWithinDeck: deckActions.every((element) => {
        const bounds = rect(element)
        return Boolean(bounds && deckRect
          && bounds.left >= deckRect.left - 1
          && bounds.right <= deckRect.right + 1
          && bounds.top >= deckRect.top - 1
          && bounds.bottom <= deckRect.bottom + 1)
      }),
    }
  })
  if (
    compactCompanion.viewport.width !== 320
    || !compactCompanion.root
    || !compactCompanion.panel
    || !compactCompanion.panelVisible
    || compactCompanion.panelAriaHidden !== 'false'
    || compactCompanion.controls.length < 6
    || compactCompanion.controls.some((control) => !control || !control.withinViewport || !control.hit || control.height < 44)
    || compactCompanion.deckOpacity !== '1'
    || compactCompanion.deckVisibility !== 'visible'
    || compactCompanion.deckPointerEvents !== 'auto'
    || !compactCompanion.deckWithinViewport
    || !compactCompanion.deckActionsWithinDeck
    || compactCompanion.deckActions.some((action) => !action || action.height < 44)
  ) {
    throw new Error(`Companion 320 CSS px panel drifted: ${JSON.stringify(compactCompanion)}`)
  }
  await writeFile(resolve(reviewRoot, 'desktop-companion-owner-320-css-px.json'), `${JSON.stringify(compactCompanion, null, 2)}\n`, 'utf8')
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-companion-owner-320-css-px.png') })
  await setZoomFactor(1)
  await setSize(1440, 810)
  await window.waitForTimeout(400)
  const live2dButton = window.getByRole('button', { name: 'Live2D', exact: true })
  if (await live2dButton.isDisabled()) throw new Error('Owner-approved Live2D selection remained disabled')
  await live2dButton.click()
  await window.waitForFunction(
    () => document.querySelector('.window-live2d')?.getAttribute('data-companion-status') !== 'loading',
    undefined,
    { timeout: 30_000 },
  )
  const live2dContract = await window.evaluate(() => {
    const renderer = document.querySelector('.window-live2d')
    return {
      unavailable: document.querySelector('.companion-presence')?.getAttribute('data-companion-unavailable'),
      available: document.querySelector('.companion-presence')?.getAttribute('data-live2d-available'),
      renderer: renderer?.getAttribute('data-companion-renderer'),
      status: renderer?.getAttribute('data-companion-status'),
    }
  })
  if (live2dContract.available !== 'true' || !['live2d', 'unavailable'].includes(live2dContract.renderer) || !['ready', 'loading', 'unavailable'].includes(live2dContract.status ?? '')) {
    throw new Error(`Owner-approved Live2D package capability did not settle: ${JSON.stringify(live2dContract)}`)
  }
  const scaleControl = window.getByRole('slider', { name: '调整伴星大小' })
  await scaleControl.fill('1.17')
  await window.waitForTimeout(450)
  const directDragTarget = window.getByRole('button', { name: '与书桌上的 AI 伴星互动' })
  const beforeDrag = await directDragTarget.boundingBox()
  if (!beforeDrag) throw new Error('Live2D companion body did not expose a direct drag target')
  await window.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2)
  await window.mouse.down()
  await window.mouse.move(beforeDrag.x + beforeDrag.width / 2 - 380, beforeDrag.y + beforeDrag.height / 2 - 150, { steps: 10 })
  await window.mouse.up()
  await window.waitForTimeout(160)
  const afterDrag = await directDragTarget.boundingBox()
  const directDragContract = {
    scale: await scaleControl.inputValue(),
    before: beforeDrag,
    after: afterDrag,
    movedLeft: Boolean(afterDrag && afterDrag.x < beforeDrag.x - 300),
    movedUp: Boolean(afterDrag && afterDrag.y < beforeDrag.y - 90),
    separateHandleCount: await window.locator('.companion-drag-handle').count(),
  }
  if (directDragContract.scale !== '1.17' || !directDragContract.movedLeft || !directDragContract.movedUp || directDragContract.separateHandleCount !== 0) {
    throw new Error(`Companion direct-drag or continuous scale contract drifted: ${JSON.stringify(directDragContract)}`)
  }
  await writeFile(resolve(reviewRoot, 'desktop-companion-direct-drag.json'), `${JSON.stringify(directDragContract, null, 2)}\n`, 'utf8')
  await window.getByRole('button', { name: '重置位置' }).click()
  await scaleControl.fill('1')
  await window.waitForTimeout(450)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-companion-live2d.png') })
  await window.getByRole('button', { name: '收起伴星' }).click()
  await window.waitForTimeout(400)
  await window.getByLabel('展开学习空间控制').click()
  if (await window.locator('.island-panel button').count() !== 5) throw new Error('Room control island is incomplete')
  await window.waitForTimeout(400)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-controls.png') })
  await window.getByLabel('收起学习空间控制').click()
  await window.getByLabel('切换书房灯光').click({ force: true })
  await window.waitForFunction(
    () => document.querySelector('.desktop-app')?.getAttribute('data-theme') === 'night',
    undefined,
    { timeout: 8_000 },
  )
  await window.waitForTimeout(500)
  const lampContract = await window.evaluate(() => ({
    theme: document.querySelector('.desktop-app')?.getAttribute('data-theme') ?? null,
    hotspotState: document.querySelector('.hotspot--lamp')?.getAttribute('data-hotspot-state') ?? null,
    companionPanelHidden: document.querySelector('.companion-whisper')?.getAttribute('aria-hidden') === 'true',
    companionOpen: document.querySelector('.companion-presence')?.getAttribute('data-open') === 'true',
  }))
  if (lampContract.theme !== 'night' || lampContract.hotspotState !== 'lit' || !lampContract.companionPanelHidden || lampContract.companionOpen) {
    throw new Error(`Lamp interaction obscured the Room or failed to switch theme: ${JSON.stringify(lampContract)}`)
  }
  await writeFile(resolve(reviewRoot, 'desktop-lamp-response.json'), `${JSON.stringify(lampContract, null, 2)}\n`, 'utf8')
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-lamp-response.png') })
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-night.png') })

  await window.getByTestId('action-continue').click()
  await window.getByLabel(/关闭任务面并返回/).waitFor({ state: 'visible' })
  await waitForScenePhase(window, 'task')
  await settleSurface(window)
  await assertTaskSurfaceCompanionQuiet(window, 'Study')
  const concreteSceneContract = await window.evaluate(() => {
    const app = document.querySelector('.desktop-app')
    const appStyle = app instanceof HTMLElement ? getComputedStyle(app) : null
    const roomCamera = document.querySelector('.room-camera-rig')
    const sceneFrame = document.querySelector('.room-reference-frame')
    const taskFocus = document.activeElement?.closest('.task-surface')
    return {
      preset: document.querySelector('.room-reference-frame')?.getAttribute('data-view-preset'),
      scenePhase: sceneFrame?.getAttribute('data-scene-phase'),
      taskHasFocus: taskFocus instanceof HTMLElement,
      seatOpacity: Number.parseFloat(getComputedStyle(document.querySelector('.room-backplate--seat-night')).opacity),
      homeOpacity: Number.parseFloat(getComputedStyle(document.querySelector('.room-backplate--home-night')).opacity),
      homeWindowMedia: document.querySelectorAll('.window-ambient-video').length,
      camera: {
        scale: appStyle?.getPropertyValue('--scene-camera-scale').trim() ?? '',
        xPercent: appStyle?.getPropertyValue('--scene-camera-x-percent').trim() ?? '',
        yPercent: appStyle?.getPropertyValue('--scene-camera-y-percent').trim() ?? '',
      },
      roomCameraTransform: roomCamera instanceof HTMLElement ? getComputedStyle(roomCamera).transform : 'missing',
      taskReferenceTransform: studyFrame instanceof HTMLElement ? getComputedStyle(studyFrame).transform : 'missing',
    }
  })
  if (
    concreteSceneContract.preset !== 'study'
    || concreteSceneContract.scenePhase !== 'task'
    || !concreteSceneContract.taskHasFocus
    || concreteSceneContract.seatOpacity < 0.98
    || concreteSceneContract.homeOpacity > 0.02
    || concreteSceneContract.homeWindowMedia !== 0
    || concreteSceneContract.camera.scale !== '1.12'
    || concreteSceneContract.camera.xPercent !== '0%'
    || concreteSceneContract.camera.yPercent !== '-3.5%'
    || concreteSceneContract.roomCameraTransform === 'none'
    || concreteSceneContract.taskReferenceTransform === 'none'
  ) {
    throw new Error(`Concrete scene did not advance from overview to Seat V2: ${JSON.stringify(concreteSceneContract)}`)
  }
  const waitForTodayRoute = async (target) => {
    await target.waitForFunction(
      () => Boolean(document.querySelector('.task-surface--study .day-route'))
        || Boolean(document.querySelector('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error')),
      undefined,
      { timeout: 12_000 },
    )
  }
  const sceneCoverage = await window.locator('.task-surface').boundingBox()
  const sceneViewport = await window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  if (!sceneCoverage || sceneCoverage.width < sceneViewport.width || sceneCoverage.height < sceneViewport.height) {
    throw new Error(`Spatial task layer does not cover the viewport: ${JSON.stringify({ sceneCoverage, sceneViewport })}`)
  }
  await waitForTodayRoute(window)
  const studyContract = await window.evaluate(() => {
    const studySurface = document.querySelector('.day-route')
    const studyText = studySurface?.textContent ?? ''
    return {
      objectSurfaceVisible: Boolean(document.querySelector('.task-surface--study .day-route')),
      safeStateVisible: Boolean(document.querySelector('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error')),
      rawIdentityVisible: /\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(studyText),
    }
  })
  if (!studyContract.objectSurfaceVisible && !studyContract.safeStateVisible) {
    throw new Error(`Study scene did not consume a real RoomProjection or stop safely: ${JSON.stringify(studyContract)}`)
  }
  if (studyContract.rawIdentityVisible) {
    throw new Error(`Study surface exposed a raw run identity: ${JSON.stringify(studyContract)}`)
  }
  if (captureOwnerCredentialsAvailable && !studyContract.objectSurfaceVisible) {
    throw new Error(`Owner capture did not reach the real Study projection: ${JSON.stringify(studyContract)}`)
  }
  // 已退役：旧学习台的 Pixi 空白底（.study-notebook__canvas / _object）。当前页面是
  // 页 14「今日学习」，桌面上的场景画布由 RoomSceneCanvas 负责，与学习台无关；
  // 这段契约在没有任何渲染端生产者之后只会永远跳过，故删除。
  let focusSearchTerm = '概率'
  if (captureOwnerCredentialsAvailable) {
    focusSearchTerm = (await window.locator('.day-route__route .task-ticket strong').nth(1).innerText()).trim()
    if (!focusSearchTerm) throw new Error('Owner capture did not expose a searchable primary-focus title')
  }
  const ambientPaused = await window.evaluate(() => {
    const audio = document.querySelector('.room-reference-frame audio')
    return document.querySelectorAll('.window-ambient-video').length === 0
      && (!audio || audio.paused)
  })
  if (!ambientPaused) throw new Error('Ambient media continued under a reading surface')
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-study.png') })

  if (captureOwnerCredentialsAvailable) {
    if (await window.getByRole('button', { name: '进入研究册' }).count() !== 1) {
      throw new Error('Owner Study projection did not expose the confirmed primary Note entry')
    }
    await window.getByRole('button', { name: '进入研究册' }).click()
    await window.locator('.notebook[data-mode]').waitFor({ state: 'visible' })
    await window.waitForFunction(
      () => Boolean(document.querySelector('.notebook[data-mode] .reading-body, .notebook[data-mode] .note-editor .ProseMirror'))
        || Boolean(document.querySelector('.notebook .surface-data-state--error, .notebook .surface-data-state--empty')),
      undefined,
      { timeout: 12_000 },
    )
    if (await window.locator('.notebook .surface-data-state--error, .notebook .surface-data-state--empty').count()) {
      const notebookError = await window.locator('.notebook .surface-data-state').first().innerText()
      throw new Error(`Owner Note projection did not load: ${notebookError}`)
    }
    const ownerNoteContract = await window.evaluate(() => {
      const paper = document.querySelector('.notebook[data-mode]')
      const body = paper?.querySelector('.reading-body')
      const editor = paper?.querySelector('.note-editor .ProseMirror')
      return {
        mode: paper?.getAttribute('data-mode') ?? null,
        bodyChars: ((body?.textContent ?? editor?.textContent) ?? '').trim().length,
      }
    })
    if ((ownerNoteContract.mode !== 'read' && ownerNoteContract.mode !== 'edit') || ownerNoteContract.bodyChars === 0) {
      throw new Error(`Owner Note projection did not expose real note content: ${JSON.stringify(ownerNoteContract)}`)
    }
    if (await window.getByRole('button', { name: /从选区整理学习卡/ }).count() !== 0) {
      throw new Error('Notebook still exposes the removed local card-generation action')
    }
    await settleSurface(window)
    const notebookIdentityContract = await window.evaluate(() => ({
      rawIdentityVisible: /\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(document.querySelector('.notebook[data-mode]')?.textContent ?? ''),
    }))
    if (notebookIdentityContract.rawIdentityVisible) {
      throw new Error(`Owner Note surface exposed a raw identity: ${JSON.stringify(notebookIdentityContract)}`)
    }
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-notebook-owner.png') })
    await window.getByLabel(/关闭任务面并返回/).click()
  } else if (await window.getByRole('button', { name: '进入研究册' }).count()) {
    await window.getByRole('button', { name: '进入研究册' }).click()
    await window.getByText('研究册暂时不可用').waitFor()
    await settleSurface(window)
    const notebookBoundaryText = await window.locator('.notebook .surface-data-state').first().innerText()
    if (!/(登录|服务|API|桌面端)/.test(notebookBoundaryText)) {
      throw new Error(`Notebook did not stop at a safe authenticated Note boundary: ${notebookBoundaryText}`)
    }
    if (await window.getByRole('button', { name: /从选区整理学习卡/ }).count() !== 0) {
      throw new Error('Notebook still exposes the removed local card-generation action')
    }
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-notebook-boundary.png') })
    await window.getByLabel(/关闭任务面并返回/).click()
  } else {
    const studyBoundaryText = await window.locator('.task-surface .surface-data-state').first().innerText()
    if (!/(身份|工作区|RoomProjection|服务|API|主焦点|不可用)/.test(studyBoundaryText)) {
      throw new Error(`Study did not stop at a safe primary-focus boundary: ${studyBoundaryText}`)
    }
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-study-boundary.png') })
    await window.getByLabel(/关闭任务面并返回/).click()
  }
  await waitForScenePhase(window, 'idle')
  await window.waitForFunction(
    () => document.activeElement?.getAttribute('data-testid') === 'action-continue'
      || document.activeElement?.getAttribute('data-focus-return') === 'continue',
    undefined,
    { timeout: 2_000 },
  )
  const restoredFocus = await window.evaluate(() => ({
    scenePhase: document.querySelector('.desktop-app')?.getAttribute('data-scene-phase'),
    testId: document.activeElement?.getAttribute('data-testid') ?? null,
    focusReturn: document.activeElement?.getAttribute('data-focus-return') ?? null,
    insideTask: Boolean(document.activeElement?.closest('.task-surface')),
  }))
  if (restoredFocus.scenePhase !== 'idle' || restoredFocus.insideTask || (restoredFocus.testId !== 'action-continue' && restoredFocus.focusReturn !== 'continue')) {
    throw new Error(`Golden Slice did not restore room focus after return: ${JSON.stringify(restoredFocus)}`)
  }
  await window.getByTestId('action-review').click()
  await window.getByRole('heading', { name: '复习队列' }).waitFor({ timeout: 12_000 })
  await window.waitForFunction(
    () => Boolean(document.querySelector('.task-surface--review .deck-card.front'))
      || Boolean(document.querySelector('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error')),
    undefined,
    { timeout: 12_000 },
  )
  await assertTaskSurfaceCompanionQuiet(window, 'Review')
  const reviewBoundary = await window.evaluate(() => ({
    safeStateVisible: Boolean(document.querySelector('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error')),
    queueVisible: Boolean(document.querySelector('.task-surface--review .deck-card.front') && document.querySelector('.queue-reason')),
    legacyCardTrayVisible: Boolean(document.querySelector('img[src*="review-card-tray-v1"]')),
    reviewStandVisible: Boolean(document.querySelector('img[src*="review-card-stand-v2"]')),
    legacyReviewStructureVisible: Boolean(document.querySelector('.review-planner, .review-index, .review-planner__frame'))
      || [...document.querySelectorAll('[class]')].some((node) => [...node.classList].some((className) => className.startsWith('review-ledger'))),
    rawIdentityVisible: /识别码|\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(document.querySelector('.queue-desk')?.textContent ?? ''),
    spatialLayerPaintsPanel: getComputedStyle(document.querySelector('.task-surface__spatial-layer'), '::before').content !== 'none',
    returnControlHit: (() => {
      const button = document.querySelector('.return-home')
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

  await window.getByLabel(/关闭任务面并返回/).click()
  await window.getByTestId('action-continue').click()
  if (captureOwnerCredentialsAvailable) {
    const primaryAction = window.getByRole('button', { name: /继续写作|审核候选卡/ }).first()
    await primaryAction.waitFor({ state: 'visible' })
    if (await primaryAction.isDisabled()) throw new Error('Owner primary Study action is unavailable')
    await primaryAction.click()
    await window.getByRole('heading', { name: '三分钟学习旅程' }).waitFor()
    await window.waitForFunction(() => Boolean(document.querySelector('.learning-run-workbench')) || Boolean(document.querySelector('.task-surface .surface-data-state--error')), undefined, { timeout: 15_000 })
    if (await window.locator('.task-surface .surface-data-state--error').count()) {
      const runError = await window.locator('.task-surface .surface-data-state--error').innerText()
      throw new Error(`Owner LearningRun did not load: ${runError}`)
    }
    if (await window.locator('.learning-run-workbench').count() !== 1) throw new Error('Owner LearningRun workbench did not mount')
    await assertTaskSurfaceCompanionQuiet(window, 'LearningRun')
    await settleSurface(window)
    const learningRunLayoutProbe = await window.evaluate(() => {
      const workbench = document.querySelector('.learning-run-workbench')
      const response = workbench?.querySelector('.learning-run-response')
      const dock = workbench?.querySelector('.learning-run-dock')
      const primary = dock?.querySelector('.button.primary')
      const editor = response?.querySelector('.run-text-editor textarea, .run-choice-list, .run-order-list, .run-relation-controls, .run-repair-list, .run-bundle-editor, .run-blocker')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const dockRect = rect(dock)
      const primaryRect = rect(primary)
      const workbenchStyle = workbench instanceof HTMLElement ? getComputedStyle(workbench) : null
      const responseStyle = response instanceof HTMLElement ? getComputedStyle(response) : null
      return {
        viewport,
        response: rect(response),
        editor: rect(editor),
        dock: dockRect,
        primary: primaryRect,
        responseClientHeight: response instanceof HTMLElement ? response.clientHeight : 0,
        responseScrollHeight: response instanceof HTMLElement ? response.scrollHeight : 0,
        responseOverflowY: responseStyle?.overflowY ?? 'missing',
        workbenchTransform: workbenchStyle?.transform ?? 'missing',
        primaryWithinViewport: Boolean(primaryRect
          && primaryRect.left >= -1
          && primaryRect.top >= -1
          && primaryRect.right <= viewport.width + 1
          && primaryRect.bottom <= viewport.height + 1),
        primaryWithinEdge: Boolean(primaryRect && dockRect
          && primaryRect.left >= dockRect.left - 1
          && primaryRect.top >= dockRect.top - 1
          && primaryRect.right <= dockRect.right + 1
          && primaryRect.bottom <= dockRect.bottom + 1),
        primaryHit: Boolean(primaryRect && document.elementFromPoint(primaryRect.left + primaryRect.width / 2, primaryRect.top + primaryRect.height / 2)?.closest('.learning-run-dock .button.primary')),
      }
    })
    if (!learningRunLayoutProbe.primary || !learningRunLayoutProbe.primaryWithinViewport || !learningRunLayoutProbe.primaryWithinEdge || !learningRunLayoutProbe.primaryHit || learningRunLayoutProbe.workbenchTransform !== 'none' || learningRunLayoutProbe.responseOverflowY !== 'auto') {
      throw new Error(`LearningRun primary action is not stably reachable: ${JSON.stringify(learningRunLayoutProbe)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-learning-run-owner-layout.json'), `${JSON.stringify(learningRunLayoutProbe, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-owner.png') })
    await window.locator('.learning-run-response').evaluate((element) => {
      if (element instanceof HTMLElement) element.scrollTop = element.scrollHeight
    })
    await window.waitForTimeout(180)
    const editorAfterScroll = await window.locator('.learning-run-response').evaluate((element) => {
      const editor = element.querySelector('.run-text-editor textarea, .run-choice-list, .run-order-list, .run-relation-controls, .run-repair-list, .run-bundle-editor, .run-blocker')
      if (!(editor instanceof HTMLElement)) return null
      const bounds = editor.getBoundingClientRect()
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, visible: bounds.bottom > 0 && bounds.top < window.innerHeight }
    })
    if (!editorAfterScroll?.visible) throw new Error(`LearningRun editor is not reachable after scrolling: ${JSON.stringify(editorAfterScroll)}`)
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-owner-scrolled.png') })
    await window.locator('.learning-run-response').evaluate((element) => {
      if (element instanceof HTMLElement) element.scrollTop = 0
    })
    await setSize(512, 350, true)
    await settleSurface(window)
    const compactLearningRunLayout = await window.evaluate(() => {
      const surface = document.querySelector('.task-surface--validation')
      const workbench = document.querySelector('.learning-run-workbench')
      const response = workbench?.querySelector('.learning-run-response')
      const dock = workbench?.querySelector('.learning-run-dock')
      const primary = dock?.querySelector('.button.primary')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const dockRect = rect(dock)
      const primaryRect = rect(primary)
      const workbenchStyle = workbench instanceof HTMLElement ? getComputedStyle(workbench) : null
      const responseStyle = response instanceof HTMLElement ? getComputedStyle(response) : null
      return {
        viewport,
        surface: rect(surface),
        surfaceClientHeight: surface instanceof HTMLElement ? surface.clientHeight : 0,
        surfaceScrollHeight: surface instanceof HTMLElement ? surface.scrollHeight : 0,
        dock: dockRect,
        primary: primaryRect,
        primaryWithinViewport: Boolean(primaryRect
          && primaryRect.left >= -1
          && primaryRect.top >= -1
          && primaryRect.right <= viewport.width + 1
          && primaryRect.bottom <= viewport.height + 1),
        primaryHorizontallyWithinViewport: Boolean(primaryRect
          && primaryRect.left >= -1
          && primaryRect.right <= viewport.width + 1),
        primaryWithinEdge: Boolean(primaryRect && dockRect
          && primaryRect.left >= dockRect.left - 1
          && primaryRect.top >= dockRect.top - 1
          && primaryRect.right <= dockRect.right + 1
          && primaryRect.bottom <= dockRect.bottom + 1),
        primaryHit: Boolean(primaryRect && document.elementFromPoint(primaryRect.left + primaryRect.width / 2, primaryRect.top + primaryRect.height / 2)?.closest('.learning-run-dock .button.primary')),
        workbenchTransform: workbenchStyle?.transform ?? 'missing',
        responseOverflowY: responseStyle?.overflowY ?? 'missing',
      }
    })
    if (!compactLearningRunLayout.surface
      || !compactLearningRunLayout.primaryHorizontallyWithinViewport
      || compactLearningRunLayout.workbenchTransform !== 'none'
      || compactLearningRunLayout.responseOverflowY !== 'auto'
    ) {
      throw new Error(`LearningRun compact primary action drifted: ${JSON.stringify(compactLearningRunLayout)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-learning-run-owner-zoom-200-layout.json'), `${JSON.stringify(compactLearningRunLayout, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-owner-zoom-200.png') })
    await window.locator('.learning-run-dock .button.primary').scrollIntoViewIfNeeded()
    await window.waitForTimeout(120)
    const compactLearningRunActionAfterScroll = await window.evaluate(() => {
      const primary = document.querySelector('.learning-run-dock .button.primary')
      if (!(primary instanceof HTMLElement)) return null
      const bounds = primary.getBoundingClientRect()
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        withinViewport: bounds.left >= -1 && bounds.top >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1,
        hit: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('.learning-run-dock .button.primary') === primary,
      }
    })
    if (!compactLearningRunActionAfterScroll?.withinViewport || !compactLearningRunActionAfterScroll.hit) {
      throw new Error(`LearningRun compact primary action was not reachable after scroll: ${JSON.stringify(compactLearningRunActionAfterScroll)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-learning-run-owner-zoom-200-action.json'), `${JSON.stringify(compactLearningRunActionAfterScroll, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-owner-zoom-200-scrolled.png') })
    await window.evaluate(() => {
      const surface = document.querySelector('.task-surface--validation')
      if (surface instanceof HTMLElement) surface.scrollTop = 0
    })
    await setZoomFactor(2)
    await setSize(640, 810, true)
    await settleSurface(window)
    const compactLearningRun320Layout = await window.evaluate(() => {
      const surface = document.querySelector('.task-surface--validation')
      const workbench = document.querySelector('.learning-run-workbench')
      const response = workbench?.querySelector('.learning-run-response')
      const dock = workbench?.querySelector('.learning-run-dock')
      const primary = dock?.querySelector('.button.primary')
      const editor = response?.querySelector('.run-text-editor textarea, .run-choice-list, .run-order-list, .run-relation-controls, .run-repair-list, .run-bundle-editor, .run-blocker')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const dockRect = rect(dock)
      const primaryRect = rect(primary)
      const workbenchStyle = workbench instanceof HTMLElement ? getComputedStyle(workbench) : null
      const responseStyle = response instanceof HTMLElement ? getComputedStyle(response) : null
      return {
        viewport,
        surface: rect(surface),
        workbench: rect(workbench),
        response: rect(response),
        editor: rect(editor),
        dock: dockRect,
        primary: primaryRect,
        surfaceClientWidth: surface instanceof HTMLElement ? surface.clientWidth : 0,
        surfaceScrollWidth: surface instanceof HTMLElement ? surface.scrollWidth : 0,
        surfaceClientHeight: surface instanceof HTMLElement ? surface.clientHeight : 0,
        surfaceScrollHeight: surface instanceof HTMLElement ? surface.scrollHeight : 0,
        workbenchTransform: workbenchStyle?.transform ?? 'missing',
        responseOverflowY: responseStyle?.overflowY ?? 'missing',
        primaryWithinViewport: Boolean(primaryRect
          && primaryRect.left >= -1
          && primaryRect.right <= viewport.width + 1),
        primaryWithinEdge: Boolean(primaryRect && dockRect
          && primaryRect.left >= dockRect.left - 1
          && primaryRect.top >= dockRect.top - 1
          && primaryRect.right <= dockRect.right + 1
          && primaryRect.bottom <= dockRect.bottom + 1),
      }
    })
    if (compactLearningRun320Layout.viewport.width !== 320
      || compactLearningRun320Layout.surfaceScrollWidth > compactLearningRun320Layout.surfaceClientWidth + 1
      || compactLearningRun320Layout.workbenchTransform !== 'none'
      || compactLearningRun320Layout.responseOverflowY !== 'auto'
      || !compactLearningRun320Layout.primary
      || compactLearningRun320Layout.primary.height < 24
      || !compactLearningRun320Layout.primaryWithinViewport
      || !compactLearningRun320Layout.primaryWithinEdge) {
      throw new Error(`LearningRun 320 CSS px layout drifted: ${JSON.stringify(compactLearningRun320Layout)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-learning-run-owner-320-css-px-layout.json'), `${JSON.stringify(compactLearningRun320Layout, null, 2)}\n`, 'utf8')
    await window.locator('.learning-run-response').evaluate((element) => {
      if (element instanceof HTMLElement) element.scrollTop = element.scrollHeight
    })
    await window.locator('.learning-run-dock .button.primary').scrollIntoViewIfNeeded()
    await window.waitForTimeout(120)
    const compactLearningRun320ActionAfterScroll = await window.evaluate(() => {
      const primary = document.querySelector('.learning-run-dock .button.primary')
      const editor = document.querySelector('.learning-run-response .run-text-editor textarea, .learning-run-response .run-choice-list, .learning-run-response .run-order-list, .learning-run-response .run-relation-controls, .learning-run-response .run-repair-list, .learning-run-response .run-bundle-editor, .learning-run-response .run-blocker')
      if (!(primary instanceof HTMLElement)) return null
      const bounds = primary.getBoundingClientRect()
      const editorBounds = editor instanceof HTMLElement ? editor.getBoundingClientRect() : null
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        height: bounds.height,
        withinViewport: bounds.left >= -1 && bounds.top >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1,
        hit: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('.learning-run-dock .button.primary') === primary,
        editorVisible: Boolean(editorBounds && editorBounds.bottom > 0 && editorBounds.top < viewport.height),
      }
    })
    if (!compactLearningRun320ActionAfterScroll?.withinViewport
      || !compactLearningRun320ActionAfterScroll.hit
      || (compactLearningRun320ActionAfterScroll.height ?? 0) < 44
      || !compactLearningRun320ActionAfterScroll.editorVisible) {
      throw new Error(`LearningRun 320 CSS px action was not reachable after scroll: ${JSON.stringify(compactLearningRun320ActionAfterScroll)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-learning-run-owner-320-css-px-action.json'), `${JSON.stringify(compactLearningRun320ActionAfterScroll, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-owner-320-css-px.png') })
    await window.evaluate(() => {
      const surface = document.querySelector('.task-surface--validation')
      if (surface instanceof HTMLElement) surface.scrollTop = 0
    })
    await setZoomFactor(1)
    await setSize(1440, 810)
    await settleSurface(window)
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
    await assertTaskSurfaceCompanionQuiet(window, 'LearningRun')
    await settleSurface(window)
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-entry.png') })
  }

  await window.getByLabel(/关闭任务面并返回/).click()
  await window.getByTestId('action-search').click()
  const searchInput = window.getByPlaceholder('输入概念、问题或来源…')
  await searchInput.waitFor({ state: 'visible' })
  await assertTaskSurfaceCompanionQuiet(window, 'Search')
  // 页 08「房内查找」的真实 DOM：.search-desk 纸面 + .search-command 输入 +
  // [role="listbox"] 结果。旧 .search-catalog-* 是一代已经没有任何渲染端生产者的
  // 场景投影工作台，那套前景/遮蔽层/投影计数断言测的不是出货页面，已删除。
  await window.waitForFunction(
    () => Boolean(document.querySelector('.search-desk'))
      || Boolean(document.querySelector('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error')),
    undefined,
    { timeout: 15_000 },
  )
  const searchSceneContract = await window.evaluate(() => {
    const desk = document.querySelector('.search-desk')
    return {
      deskVisible: Boolean(desk),
      commandVisible: Boolean(desk?.querySelector('.search-command')),
      indexVisible: Boolean(desk?.querySelector('.search-index')),
      boundaryVisible: Boolean(document.querySelector('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error')),
      legacyCatalogVisible: Boolean(document.querySelector('.search-catalog, .search-shelf, .search-index-card')),
      rawIdentityVisible: /\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(desk?.textContent ?? ''),
    }
  })
  if (!searchSceneContract.deskVisible || !searchSceneContract.commandVisible || !searchSceneContract.indexVisible) {
    throw new Error(`Search did not open the real 房内查找 paper: ${JSON.stringify(searchSceneContract)}`)
  }
  if (searchSceneContract.legacyCatalogVisible) {
    throw new Error(`Search still renders the retired catalog workbench: ${JSON.stringify(searchSceneContract)}`)
  }
  if (searchSceneContract.rawIdentityVisible) {
    throw new Error(`Search exposed a raw identity: ${JSON.stringify(searchSceneContract)}`)
  }
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-search-boundary.png') })

  await searchInput.fill('不存在的概念')
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-search-empty.png') })
  await searchInput.fill(focusSearchTerm)
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-search.png') })
  await searchInput.press('Enter')
  await settleSurface(window)
  // 回车打开命中项的详情（来源 / 理解目标 / 研究册），没有命中时停在安全空态。
  const searchResultContract = await window.evaluate(() => {
    const surface = document.querySelector('.task-surface')
    return {
      openedDetail: Boolean(document.querySelector('.task-surface--source-detail, .task-surface--objective-detail, .task-surface--notebook')),
      surfaceOpen: Boolean(surface),
      safeSearchState: Boolean(document.querySelector('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error')),
    }
  })
  if (!searchResultContract.openedDetail && !searchResultContract.safeSearchState && !searchResultContract.surfaceOpen) {
    throw new Error(`Search did not open the real hit or stop at a safe boundary: ${JSON.stringify(searchResultContract)}`)
  }

  await window.getByLabel(/关闭任务面并返回/).click()
  await window.getByLabel('从窗户进入理解星图').click()
  await window.getByRole('heading', { name: '理解星图' }).waitFor()
  await assertTaskSurfaceCompanionQuiet(window, 'Graph')
  const graphBoundary = await window.evaluate(() => ({
    safeStateVisible: Boolean(document.querySelector('.graph-boundary')),
    oldNodeCount: document.querySelectorAll('.graph-stage, #graph-relations, .graph-list').length,
  }))
  if (!graphBoundary.safeStateVisible || graphBoundary.oldNodeCount !== 0) {
    throw new Error(`Graph did not stop at the real topology boundary: ${JSON.stringify(graphBoundary)}`)
  }
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-graph.png') })

  await window.getByLabel(/关闭任务面并返回/).click()
  await waitForScenePhase(window, 'idle')
  await setSize(1024, 700)
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'compact.png') })
  await window.getByTestId('action-continue').click()
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'compact-study.png') })

  await window.getByLabel(/关闭任务面并返回/).click()
  await setSize(512, 350, true)
  await window.waitForTimeout(250)
  const viewport = await window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const compactActions = await window.locator('.home-command-deck > .rail-action').evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect()
    const visibleLabel = [...button.querySelectorAll('strong, .rail-action__catalog-label, .rail-action__catalog-label--compact')]
      .find((element) => {
        const style = getComputedStyle(element)
        const bounds = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
      })
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      label: visibleLabel?.textContent?.trim() ?? '',
    }
  }))
  if (
    compactActions.length !== 5
    || compactActions.some((box) => box.left < 0 || box.top < 0 || box.right > viewport.width || box.bottom > viewport.height || !box.label)
  ) {
    throw new Error(`Primary actions overflow or lose their labels at 200%: ${JSON.stringify({ viewport, compactActions })}`)
  }
  if (await window.locator('.scene-status').count()) throw new Error('Persistent scene status overlaps the 200% action rail')
  await window.screenshot({ path: resolve(reviewRoot, 'zoom-200.png') })
  await window.getByTestId('action-continue').click()
  await settleSurface(window)
  await waitForTodayRoute(window)
  if (await window.locator('.task-surface--study .day-route').count()) {
    const studyObjectSurface = window.locator('.task-surface--study .day-route').first()
    await studyObjectSurface.scrollIntoViewIfNeeded()
    if (!(await studyObjectSurface.isVisible())) throw new Error('Study object surface is hidden at 200%')
    const compactStudyContract = await window.evaluate(() => {
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const paper = document.querySelector('.task-surface--study .day-route')
      const ledger = paper?.querySelector('.record-strip')
      const heading = paper?.querySelector('h2')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
      }
      const headingRect = heading instanceof HTMLElement ? heading.getBoundingClientRect() : null
      const ledgerRect = ledger instanceof HTMLElement ? ledger.getBoundingClientRect() : null
      const headingRange = heading instanceof HTMLElement ? document.createRange() : null
      if (headingRange && heading) headingRange.selectNodeContents(heading)
      const headingLineRects = headingRange ? [...headingRange.getClientRects()] : []
      const horizontallyWithin = (bounds, container) => Boolean(
        bounds && container
          && bounds.left >= container.left - 1
          && bounds.right <= container.right + 1
      )
      return {
        viewport,
        paper: rect(paper),
        ledger: ledgerRect,
        heading: headingRect,
        headingHorizontallyWithinPaper: horizontallyWithin(headingRect, rect(paper)),
        headingHorizontallyWithinViewport: Boolean(
          headingRect
            && headingRect.left >= -1
            && headingRect.right <= viewport.width + 1,
        ),
        headingLineCount: headingLineRects.length,
      }
    })
    if (
      !compactStudyContract.heading
      || !compactStudyContract.paper
      || !compactStudyContract.headingHorizontallyWithinPaper
      || !compactStudyContract.headingHorizontallyWithinViewport
    ) {
      throw new Error(`Study content exceeded the 200% reading bounds: ${JSON.stringify(compactStudyContract)}`)
    }
  } else {
    const studyState = window.locator('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error').first()
    await studyState.waitFor({ state: 'visible' })
    await studyState.scrollIntoViewIfNeeded()
    if (!(await studyState.isVisible())) throw new Error('Safe Study boundary is hidden at 200%')
  }
  await window.screenshot({ path: resolve(reviewRoot, 'zoom-200-study.png') })
  await window.getByLabel(/关闭任务面并返回/).click()

  await window.emulateMedia({ reducedMotion: 'reduce' })
  await window.reload()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForFunction(() => document.querySelector('.desktop-app')?.getAttribute('data-motion-mode') === 'off')
  await window.locator('.action-rail').waitFor({ state: 'visible', timeout: 20_000 })
  const reducedMedia = await window.locator('.window-ambient-video').count()
  if (reducedMedia !== 0) throw new Error('Reduced motion still mounted ambient video')
  // 唯一形态：reduced motion 只暂停 ticker 并保留最后一帧，不得切换到别的 renderer。
  if (await window.locator('.window-live2d[data-companion-renderer="live2d"]').count() !== 1) throw new Error('Reduced motion did not keep the Live2D renderer (no orb fallback exists)')
  const reducedAnimatedNodes = await window.locator('.scene-status, .run-recovery-notice, .run-spinner, .run-phase__dot').evaluateAll((elements) => elements
    .map((element) => ({
      className: element.className,
      animationName: getComputedStyle(element).animationName,
    }))
    .filter(({ animationName }) => animationName !== 'none'))
  if (reducedAnimatedNodes.length) throw new Error(`Reduced motion left CSS animations active: ${JSON.stringify(reducedAnimatedNodes)}`)
  if (await window.locator('.onboarding-card').count()) await window.getByRole('button', { name: '无声进入' }).click()
  await window.screenshot({ path: resolve(reviewRoot, 'reduced-motion.png') })

  const normalizedErrors = errors.filter((message) => !message.includes('ResizeObserver loop'))
  if (normalizedErrors.length) throw new Error(`Renderer errors:\n${normalizedErrors.join('\n')}`)

  console.log(`Captured Seat V2 room and in-window companion review set in ${reviewRoot}`)
  }
} finally {
  await electronApp.close()
}
