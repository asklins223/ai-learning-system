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
      taskSurfaceQuiet: companion?.getAttribute('data-task-surface-quiet') === 'true',
      ariaHidden: companion?.getAttribute('aria-hidden') ?? null,
      companionDisplay: companion instanceof HTMLElement ? getComputedStyle(companion).display : 'missing',
      visualDisplay: visual instanceof HTMLElement ? getComputedStyle(visual).display : 'missing',
      visualRectCount: visual?.getClientRects().length ?? 0,
    }
  })
  if (contract.surfaceOpen && (!contract.taskSurfaceQuiet || contract.ariaHidden !== 'true' || contract.companionDisplay !== 'none' || contract.visualRectCount !== 0)) {
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
    || desktop.lampControlLabel !== '调整书房时间'
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
  if (process.env.CAPTURE_DOOR_TRANSITION === '1') {
    await window.evaluate(() => {
      document.documentElement.dataset.captureDoorTransition = 'true'
    })
  }
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

  if (process.env.CAPTURE_DOOR_TRANSITION === '1') {
    const transition = window.locator('[data-transition-engine="pixijs-gsap"]')
    await transition.waitFor({ state: 'attached', timeout: 8_000 })
    const roomContent = window.locator('.desktop-access-gate__room-content[data-door-entry-phase="opening"]')
    await roomContent.waitFor({ state: 'attached', timeout: 8_000 })
    const roomHandoffState = await roomContent.evaluate((element) => ({
      visibility: getComputedStyle(element).visibility,
      pointerEvents: getComputedStyle(element).pointerEvents,
      inert: element.inert,
    }))
    if (roomHandoffState.visibility !== 'hidden' || roomHandoffState.pointerEvents !== 'none' || !roomHandoffState.inert) {
      throw new Error(`Door transition left Room content exposed: ${JSON.stringify(roomHandoffState)}`)
    }
    await transition.locator('canvas').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined)
    if (await transition.locator('canvas').count()) {
      // React mounts the host before Pixi finishes loading the two transition textures
      // and before useGSAP creates the paused capture timeline. Wait for that
      // state instead of sampling the first canvas paint.
      await window.waitForFunction(
        () => document.querySelector('[data-transition-engine="pixijs-gsap"]')?.getAttribute('data-door-resource-state') === 'ready',
        undefined,
        { timeout: 8_000 },
      )
      await window.waitForFunction(
        () => document.querySelector('[data-transition-engine="pixijs-gsap"]')?.getAttribute('data-door-capture-mode') === 'paused',
        undefined,
        { timeout: 8_000 },
      )
      const captureMode = await transition.getAttribute('data-door-capture-mode')
      if (captureMode !== 'paused') throw new Error(`Door transition capture mode was not armed: ${captureMode ?? 'missing'}`)
      const visibilityContract = await transition.evaluate((element) => ({
        assetSource: element.getAttribute('data-door-asset-source'),
        resourceState: element.getAttribute('data-door-resource-state'),
        visibility: element.getAttribute('data-door-visibility'),
        timeline: element.getAttribute('data-door-timeline'),
        renderer: element.getAttribute('data-door-renderer'),
      }))
      if (visibilityContract.assetSource !== 'manifest' || visibilityContract.resourceState !== 'ready' || visibilityContract.visibility !== 'visible' || visibilityContract.timeline !== 'paused' || visibilityContract.renderer !== 'running') {
        throw new Error(`Door transition visibility contract was not armed: ${JSON.stringify(visibilityContract)}`)
      }
      const sequenceRoot = resolve(reviewRoot, 'door-transition-sequence')
      await mkdir(sequenceRoot, { recursive: true })
      const seekDoor = async (progress) => {
        await transition.evaluate((element, value) => {
          element.dispatchEvent(new CustomEvent('door-capture-command', {
            detail: { action: 'seek', progress: value },
          }))
        }, progress)
      }
      // Keep a dense deterministic sequence as motion evidence. The three
      // named stills below are only representative checkpoints; the runtime
      // timeline itself is continuous and this sequence makes that visible
      // during review instead of implying a three-frame animation.
      for (let index = 0; index <= 24; index += 1) {
        // Do not seek to exactly 1 here: GSAP fires onComplete at the final
        // tick, which correctly unmounts the transition before the named
        // checkpoints below can be written.
        await seekDoor(index === 24 ? 0.999 : index / 24)
        await window.screenshot({ path: resolve(sequenceRoot, `frame-${String(index).padStart(2, '0')}.png`) })
      }
      await seekDoor(0.1)
      console.log(`Door latch sample: ${await transition.getAttribute('data-door-latch')} / swing ${await transition.getAttribute('data-door-swing')} / interior ${await transition.getAttribute('data-door-interior')} / portal ${await transition.getAttribute('data-door-portal-alpha')} / texture ${await transition.getAttribute('data-door-texture-size')}`)
      await window.screenshot({ path: resolve(reviewRoot, 'door-transition-latch.png') })
      await seekDoor(0.38)
      console.log(`Door swing sample: ${await transition.getAttribute('data-door-latch')} / swing ${await transition.getAttribute('data-door-swing')} / interior ${await transition.getAttribute('data-door-interior')} / portal ${await transition.getAttribute('data-door-portal-alpha')} / texture ${await transition.getAttribute('data-door-texture-size')}`)
      await window.screenshot({ path: resolve(reviewRoot, 'door-transition-swing.png') })
      await seekDoor(0.76)
      if (await transition.count()) await window.screenshot({ path: resolve(reviewRoot, 'door-transition-open.png') })
      await transition.evaluate((element) => {
        element.dispatchEvent(new CustomEvent('door-capture-command', {
          detail: { action: 'play' },
        }))
      })
      await transition.waitFor({ state: 'detached', timeout: 5_000 })
    }
  }

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
      || gateDesktop.lampControlLabel !== '调整书房时间'
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
    if (!(await window.locator('.immersive-island').evaluate((node) => (node instanceof HTMLElement) && node.inert))) throw new Error('First-entry guide did not inert the control island')
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
      return Boolean(canvasHost) && canvasHost.getAttribute('data-scene-renderer-state') !== 'loading'
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
    || seatSceneContract.homeWindowMedia !== 1
    || seatSceneContract.legacySurfaceWorld !== 0
    || seatSceneContract.sceneRenderer !== 'dom-2.5d'
    || seatSceneContract.scenePhase !== 'idle'
    || seatSceneContract.depthMode !== 'dom-2.5d'
    || JSON.stringify(seatSceneContract.depthBands) !== JSON.stringify(['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6'])
    || !['room.notebook', 'room.review', 'room.lamp', 'room.search', 'room.graph'].every((anchor) => seatSceneContract.sceneAnchors.includes(anchor))
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
      rawIdentityVisible: /\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(document.querySelector('.card-generation-surface')?.textContent ?? ''),
    }))
    if (!generationContract.surfaceVisible || !generationContract.runMetaVisible || (!generationContract.candidateListVisible && !generationContract.terminalStateVisible) || generationContract.localSuccessControls !== 0 || generationContract.rawIdentityVisible) {
      throw new Error(`Owner Card Generation recovery did not consume the real run safely: ${JSON.stringify(generationContract)}`)
    }
    await settleSurface(window)
    const generationLayoutProbe = await window.evaluate(() => {
      const surface = document.querySelector('.card-generation-surface')
      const content = surface?.querySelector('.card-generation-surface__content')
      const recovery = surface?.querySelector('.card-generation-recovery')
      const recoveryActions = surface?.querySelector('.card-generation-recovery .surface-action-pair')
      const footer = surface?.querySelector('.card-generation-footer')
      const footerActions = surface?.querySelector('.card-generation-footer .surface-action-pair')
      const actionEdge = surface?.querySelector('.card-generation-surface__action-edge')
      const footerButton = footer?.querySelector('button')
      const recoveryButtons = [...(recoveryActions?.querySelectorAll('button') ?? [])]
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
      }
      const hits = (element) => {
        if (!(element instanceof HTMLElement)) return false
        const bounds = element.getBoundingClientRect()
        if (bounds.width <= 0 || bounds.height <= 0) return false
        return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === element
      }
      const contentStyle = content instanceof HTMLElement ? getComputedStyle(content) : null
      const contentLogicalBottom = content instanceof HTMLElement ? content.offsetTop + content.clientHeight : null
      const actionEdgeLogicalTop = actionEdge instanceof HTMLElement ? actionEdge.offsetTop : null
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        surface: rect(surface),
        content: rect(content),
        recovery: rect(recovery),
        recoveryActions: rect(recoveryActions),
        actionEdge: rect(actionEdge),
        footer: rect(footer),
        footerActions: rect(footerActions),
        contentClientHeight: content instanceof HTMLElement ? content.clientHeight : 0,
        contentScrollHeight: content instanceof HTMLElement ? content.scrollHeight : 0,
        contentOverflowY: contentStyle?.overflowY ?? null,
        footerOutsideScrollRoot: Boolean(content && footer && !content.contains(footer)),
        contentLogicalBottom,
        actionEdgeLogicalTop,
        contentBeforeActionEdge: contentLogicalBottom !== null && actionEdgeLogicalTop !== null
          ? contentLogicalBottom <= actionEdgeLogicalTop
          : false,
        recoveryActionHits: recoveryButtons.map(hits),
        footerButtonHit: hits(footerButton),
      }
    })
    if (!generationLayoutProbe.footerOutsideScrollRoot
      || generationLayoutProbe.contentScrollHeight <= generationLayoutProbe.contentClientHeight
      || !generationLayoutProbe.contentBeforeActionEdge
      || !generationLayoutProbe.recoveryActionHits.every(Boolean)
      || !generationLayoutProbe.footerButtonHit) {
      throw new Error(`Owner Card Generation action edge is not safely reachable: ${JSON.stringify(generationLayoutProbe)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-card-generation-owner-layout.json'), `${JSON.stringify(generationLayoutProbe, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-card-generation-owner.png') })
    await setSize(512, 350, true)
    await settleSurface(window)
    const compactGenerationLayoutProbe = await window.evaluate(() => {
      const taskSurface = document.querySelector('.task-surface--card-generation')
      const surface = document.querySelector('.card-generation-surface')
      const content = surface?.querySelector('.card-generation-surface__content')
      const actionEdge = surface?.querySelector('.card-generation-surface__action-edge')
      const footer = surface?.querySelector('.card-generation-footer')
      const footerButton = footer?.querySelector('button')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
      }
      const hit = (element) => {
        if (!(element instanceof HTMLElement)) return false
        const bounds = element.getBoundingClientRect()
        if (bounds.width <= 0 || bounds.height <= 0) return false
        return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === element
      }
      const surfaceStyle = surface instanceof HTMLElement ? getComputedStyle(surface) : null
      const contentStyle = content instanceof HTMLElement ? getComputedStyle(content) : null
      const taskSurfaceStyle = taskSurface instanceof HTMLElement ? getComputedStyle(taskSurface) : null
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        taskSurface: rect(taskSurface),
        surface: rect(surface),
        content: rect(content),
        actionEdge: rect(actionEdge),
        footer: rect(footer),
        taskSurfaceClientHeight: taskSurface instanceof HTMLElement ? taskSurface.clientHeight : 0,
        taskSurfaceClientWidth: taskSurface instanceof HTMLElement ? taskSurface.clientWidth : 0,
        taskSurfaceScrollHeight: taskSurface instanceof HTMLElement ? taskSurface.scrollHeight : 0,
        taskSurfaceScrollWidth: taskSurface instanceof HTMLElement ? taskSurface.scrollWidth : 0,
        taskSurfaceOverflowY: taskSurfaceStyle?.overflowY ?? null,
        surfaceClientHeight: surface instanceof HTMLElement ? surface.clientHeight : 0,
        surfaceScrollHeight: surface instanceof HTMLElement ? surface.scrollHeight : 0,
        surfaceScrollWidth: surface instanceof HTMLElement ? surface.scrollWidth : 0,
        surfaceOverflowY: surfaceStyle?.overflowY ?? null,
        contentOverflowY: contentStyle?.overflowY ?? null,
        playerTransform: surface instanceof HTMLElement ? getComputedStyle(surface).transform : null,
        footerOutsideScrollRoot: Boolean(content && footer && !content.contains(footer)),
        contentBeforeActionEdge: (() => {
          const contentBounds = rect(content)
          const edgeBounds = rect(actionEdge)
          return Boolean(contentBounds && edgeBounds && edgeBounds.top >= contentBounds.bottom - 1)
        })(),
        footerButtonWithinViewport: (() => {
          const bounds = rect(footerButton)
          return Boolean(bounds && bounds.left >= -1 && bounds.right <= window.innerWidth + 1 && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1)
        })(),
        footerButtonHit: hit(footerButton),
      }
    })
    if (!compactGenerationLayoutProbe.taskSurface
      || compactGenerationLayoutProbe.taskSurfaceScrollHeight <= compactGenerationLayoutProbe.taskSurfaceClientHeight
      || compactGenerationLayoutProbe.taskSurfaceScrollWidth > compactGenerationLayoutProbe.taskSurfaceClientWidth + 1
      || compactGenerationLayoutProbe.taskSurfaceOverflowY !== 'auto'
      || compactGenerationLayoutProbe.playerTransform !== 'none'
      || compactGenerationLayoutProbe.contentOverflowY !== 'visible'
      || !compactGenerationLayoutProbe.footerOutsideScrollRoot
      || !compactGenerationLayoutProbe.contentBeforeActionEdge) {
      throw new Error(`Card Generation compact surface drifted: ${JSON.stringify(compactGenerationLayoutProbe)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-card-generation-owner-zoom-200-layout.json'), `${JSON.stringify(compactGenerationLayoutProbe, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-card-generation-owner-zoom-200.png') })
    await window.locator('.card-generation-surface__action-edge .text-action').scrollIntoViewIfNeeded()
    const compactGenerationActionAfterScroll = await window.evaluate(() => {
      const button = document.querySelector('.card-generation-surface__action-edge .text-action')
      if (!(button instanceof HTMLElement)) return null
      const bounds = button.getBoundingClientRect()
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        withinViewport: bounds.left >= -1 && bounds.right <= window.innerWidth + 1 && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1,
        hit: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === button,
      }
    })
    if (!compactGenerationActionAfterScroll?.withinViewport || !compactGenerationActionAfterScroll.hit) {
      throw new Error(`Card Generation compact footer was not reachable after scroll: ${JSON.stringify(compactGenerationActionAfterScroll)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-card-generation-owner-zoom-200-action.json'), `${JSON.stringify(compactGenerationActionAfterScroll, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-card-generation-owner-zoom-200-scrolled.png') })
    await window.evaluate(() => {
      const surface = document.querySelector('.task-surface--card-generation')
      if (surface instanceof HTMLElement) surface.scrollTop = 0
    })
    await setZoomFactor(2)
    await setSize(640, 810, true)
    await settleSurface(window)
    const compactGeneration320Layout = await window.evaluate(() => {
      const taskSurface = document.querySelector('.task-surface--card-generation')
      const surface = document.querySelector('.card-generation-surface')
      const content = surface?.querySelector('.card-generation-surface__content')
      const recovery = surface?.querySelector('.card-generation-recovery')
      const recoveryActions = recovery?.querySelector('.surface-action-pair')
      const actionEdge = surface?.querySelector('.card-generation-surface__action-edge')
      const footer = surface?.querySelector('.card-generation-footer')
      const recoveryButtons = [...(recoveryActions?.querySelectorAll('button') ?? [])]
      const footerButtons = [...(footer?.querySelectorAll('button') ?? [])]
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
      }
      const horizontalWithinViewport = (element) => {
        const bounds = rect(element)
        return Boolean(bounds && bounds.left >= -1 && bounds.right <= window.innerWidth + 1)
      }
      const style = (element) => element instanceof HTMLElement ? getComputedStyle(element) : null
      const contentBounds = rect(content)
      const edgeBounds = rect(actionEdge)
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        taskSurface: rect(taskSurface),
        surface: rect(surface),
        content: contentBounds,
        recovery: rect(recovery),
        recoveryActions: rect(recoveryActions),
        actionEdge: edgeBounds,
        footer: rect(footer),
        recoveryButtonHeights: recoveryButtons.map((button) => rect(button)?.height ?? 0),
        footerButtonHeights: footerButtons.map((button) => rect(button)?.height ?? 0),
        recoveryButtonsHorizontallyWithinViewport: recoveryButtons.every(horizontalWithinViewport),
        footerButtonsHorizontallyWithinViewport: footerButtons.every(horizontalWithinViewport),
        taskSurfaceClientHeight: taskSurface instanceof HTMLElement ? taskSurface.clientHeight : 0,
        taskSurfaceClientWidth: taskSurface instanceof HTMLElement ? taskSurface.clientWidth : 0,
        taskSurfaceScrollHeight: taskSurface instanceof HTMLElement ? taskSurface.scrollHeight : 0,
        taskSurfaceScrollWidth: taskSurface instanceof HTMLElement ? taskSurface.scrollWidth : 0,
        taskSurfaceOverflowY: style(taskSurface)?.overflowY ?? null,
        surfaceClientHeight: surface instanceof HTMLElement ? surface.clientHeight : 0,
        surfaceScrollHeight: surface instanceof HTMLElement ? surface.scrollHeight : 0,
        surfaceScrollWidth: surface instanceof HTMLElement ? surface.scrollWidth : 0,
        surfaceTransform: style(surface)?.transform ?? null,
        contentOverflowY: style(content)?.overflowY ?? null,
        footerOutsideScrollRoot: Boolean(content && footer && !content.contains(footer)),
        contentBeforeActionEdge: Boolean(contentBounds && edgeBounds && edgeBounds.top >= contentBounds.bottom - 1),
        recoveryButtonCount: recoveryButtons.length,
        footerButtonCount: footerButtons.length,
      }
    })
    if (compactGeneration320Layout.viewport.width !== 320
      || compactGeneration320Layout.taskSurfaceScrollHeight <= compactGeneration320Layout.taskSurfaceClientHeight
      || compactGeneration320Layout.taskSurfaceScrollWidth > compactGeneration320Layout.taskSurfaceClientWidth + 1
      || compactGeneration320Layout.taskSurfaceOverflowY !== 'auto'
      || compactGeneration320Layout.surfaceScrollWidth > compactGeneration320Layout.surfaceClientWidth + 1
      || compactGeneration320Layout.surfaceTransform !== 'none'
      || compactGeneration320Layout.contentOverflowY !== 'visible'
      || !compactGeneration320Layout.footerOutsideScrollRoot
      || !compactGeneration320Layout.contentBeforeActionEdge
      || compactGeneration320Layout.recoveryButtonCount < 1
      || compactGeneration320Layout.footerButtonCount < 1
      || compactGeneration320Layout.recoveryButtonHeights.some((height) => height < 44)
      || compactGeneration320Layout.footerButtonHeights.some((height) => height < 44)
      || !compactGeneration320Layout.recoveryButtonsHorizontallyWithinViewport
      || !compactGeneration320Layout.footerButtonsHorizontallyWithinViewport) {
      throw new Error(`Card Generation 320 CSS px layout drifted: ${JSON.stringify(compactGeneration320Layout)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-card-generation-owner-320-css-px-layout.json'), `${JSON.stringify(compactGeneration320Layout, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-card-generation-owner-320-css-px.png') })
    await window.locator('.card-generation-recovery .surface-action-pair button').first().scrollIntoViewIfNeeded()
    await window.waitForTimeout(120)
    const compactGeneration320RecoveryAfterScroll = await window.evaluate(() => {
      const buttons = [...document.querySelectorAll('.card-generation-recovery .surface-action-pair button')]
      return buttons.map((button) => {
        const bounds = button.getBoundingClientRect()
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
          height: bounds.height,
          withinViewport: bounds.left >= -1 && bounds.top >= -1 && bounds.right <= window.innerWidth + 1 && bounds.bottom <= window.innerHeight + 1,
          hit: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === button,
        }
      })
    })
    if (!compactGeneration320RecoveryAfterScroll.length
      || compactGeneration320RecoveryAfterScroll.some((action) => !action.withinViewport || !action.hit || action.height < 44)) {
      throw new Error(`Card Generation 320 CSS px recovery actions were not reachable: ${JSON.stringify(compactGeneration320RecoveryAfterScroll)}`)
    }
    await window.locator('.card-generation-surface__action-edge .card-generation-footer button').first().scrollIntoViewIfNeeded()
    await window.waitForTimeout(120)
    const compactGeneration320ActionAfterScroll = await window.evaluate(() => {
      const buttons = [...document.querySelectorAll('.card-generation-surface__action-edge .card-generation-footer button')]
      return buttons.map((button) => {
        const bounds = button.getBoundingClientRect()
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
          height: bounds.height,
          withinViewport: bounds.left >= -1 && bounds.top >= -1 && bounds.right <= window.innerWidth + 1 && bounds.bottom <= window.innerHeight + 1,
          hit: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === button,
        }
      })
    })
    if (!compactGeneration320ActionAfterScroll.length
      || compactGeneration320ActionAfterScroll.some((action) => !action.withinViewport || !action.hit || action.height < 44)) {
      throw new Error(`Card Generation 320 CSS px footer was not reachable: ${JSON.stringify(compactGeneration320ActionAfterScroll)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-card-generation-owner-320-css-px-action.json'), `${JSON.stringify({ recovery: compactGeneration320RecoveryAfterScroll, footer: compactGeneration320ActionAfterScroll }, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-card-generation-owner-320-css-px-scrolled.png') })
    await window.evaluate(() => {
      const surface = document.querySelector('.task-surface--card-generation')
      if (surface instanceof HTMLElement) surface.scrollTop = 0
    })
    await setZoomFactor(1)
    await setSize(1440, 810)
    await settleSurface(window)
    await window.getByRole('button', { name: '关闭学习卡生成并返回房间' }).click()
    await waitForScenePhase(window, 'idle')
    await window.locator('.task-surface').waitFor({ state: 'detached', timeout: 8_000 })
  }

  await window.getByRole('button', { name: '与书桌上的 AI 伴星互动' }).click()
  await window.getByRole('heading', { name: '现在想从哪里继续？' }).waitFor()
  await window.locator('.companion-whisper__settings > summary').click()
  await window.locator('.companion-whisper').waitFor({ state: 'visible', timeout: 5_000 })
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-companion-orb.png') })
  await setZoomFactor(2)
  await setSize(640, 810, true)
  await window.waitForTimeout(400)
  const compactCompanion = await window.evaluate(() => {
    const root = document.querySelector('.companion-presence')
    const panel = document.querySelector('.companion-whisper')
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
  ) {
    throw new Error(`Companion 320 CSS px panel drifted: ${JSON.stringify(compactCompanion)}`)
  }
  await writeFile(resolve(reviewRoot, 'desktop-companion-owner-320-css-px.json'), `${JSON.stringify(compactCompanion, null, 2)}\n`, 'utf8')
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-companion-owner-320-css-px.png') })
  await setZoomFactor(1)
  await setSize(1440, 810)
  await window.waitForTimeout(400)
  const live2dGateButton = window.locator('.companion-form-switch button:disabled').filter({ hasText: 'Live2D 待许可' })
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
  await window.getByLabel(/关闭任务面并返回/).waitFor({ state: 'visible' })
  await waitForScenePhase(window, 'task')
  await settleSurface(window)
  await assertTaskSurfaceCompanionQuiet(window, 'Study')
  const concreteSceneContract = await window.evaluate(() => {
    const app = document.querySelector('.desktop-app')
    const appStyle = app instanceof HTMLElement ? getComputedStyle(app) : null
    const roomCamera = document.querySelector('.room-camera-rig')
    const studyFrame = document.querySelector('.study-reference-frame')
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
  const studyContract = await window.evaluate(() => {
    const studySurface = document.querySelector('.study-workbench')
    const studyText = studySurface?.textContent ?? ''
    return {
      objectSurfaceVisible: Boolean(document.querySelector('.study-workbench.study-workbench--ready')),
      safeStateVisible: Boolean(document.querySelector('.study-boundary:is([role="alert"]), .study-workbench--empty, .study-workbench--error')),
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
  await window.waitForFunction(
    () => {
      const canvasHost = document.querySelector('.study-notebook__canvas')
      return !canvasHost || canvasHost.getAttribute('data-scene-renderer-state') !== 'loading'
    },
    undefined,
    { timeout: 12_000 },
  )
  const studyRendererContract = await window.evaluate(() => {
    const canvasHost = document.querySelector('.study-notebook__canvas')
    const notebook = document.querySelector('.study-notebook')
    const poster = document.querySelector('.study-notebook__object')
    const state = canvasHost?.getAttribute('data-scene-renderer-state') ?? 'missing'
    const posterVisible = poster instanceof HTMLElement && Number.parseFloat(getComputedStyle(poster).opacity) > 0.02
    return {
      state,
      reason: canvasHost?.getAttribute('data-scene-renderer-reason') ?? null,
      rendererName: canvasHost?.getAttribute('data-scene-renderer-name') ?? null,
      canvasCount: canvasHost?.querySelectorAll('canvas').length ?? 0,
      posterVisible,
      notebookRenderer: notebook?.getAttribute('data-scene-canvas-renderer') ?? null,
      canvasActive: canvasHost?.getAttribute('data-scene-renderer-active') === 'true',
      canvasPhase: canvasHost?.getAttribute('data-scene-renderer-phase') ?? null,
    }
  })
  if (
    captureOwnerCredentialsAvailable
    && (studyRendererContract.state === 'missing' || studyRendererContract.state === 'loading')
  ) {
    throw new Error(`Study blank-base renderer did not settle: ${JSON.stringify(studyRendererContract)}`)
  }
  if (
    captureOwnerCredentialsAvailable
    && studyRendererContract.state === 'ready'
    && (studyRendererContract.canvasCount !== 1 || studyRendererContract.posterVisible || studyRendererContract.notebookRenderer !== 'pixi-study-notebook-base' || !studyRendererContract.canvasActive || studyRendererContract.canvasPhase !== 'task')
  ) {
    throw new Error(`Study Pixi base did not replace the poster at a stable frame: ${JSON.stringify(studyRendererContract)}`)
  }
  if (
    captureOwnerCredentialsAvailable
    && studyRendererContract.state === 'fallback'
    && !studyRendererContract.posterVisible
  ) {
    throw new Error(`Study renderer fallback hid the canonical poster: ${JSON.stringify(studyRendererContract)}`)
  }
  let focusSearchTerm = '概率'
  if (captureOwnerCredentialsAvailable) {
    focusSearchTerm = (await window.locator('.study-workbench .study-objective h2').innerText()).trim()
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
    await window.locator('.notebook-editor-workbench').waitFor({ state: 'visible' })
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
    const notebookIdentityContract = await window.evaluate(() => ({
      rawIdentityVisible: /\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(document.querySelector('.notebook-editor-workbench')?.textContent ?? ''),
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
    const notebookBoundaryText = await window.locator('.notebook-state--error').innerText()
    if (!/(登录|服务|API|桌面端)/.test(notebookBoundaryText)) {
      throw new Error(`Notebook did not stop at a safe authenticated Note boundary: ${notebookBoundaryText}`)
    }
    if (await window.getByRole('button', { name: /从选区整理学习卡/ }).count() !== 0) {
      throw new Error('Notebook still exposes the removed local card-generation action')
    }
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-notebook-boundary.png') })
    await window.getByLabel(/关闭任务面并返回/).click()
  } else {
    const studyBoundaryText = await window.locator('.study-boundary').first().innerText()
    if (!/(身份|工作区|RoomProjection|服务|API|主焦点)/.test(studyBoundaryText)) {
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
  await window.getByRole('heading', { name: '今日复习' }).waitFor()
  await window.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="review-queue"]') && document.querySelector('.review-notebook'))
      || Boolean(document.querySelector('.review-scene-state--empty, .review-scene-state--error')),
    undefined,
    { timeout: 12_000 },
  )
  await assertTaskSurfaceCompanionQuiet(window, 'Review')
  const reviewBoundary = await window.evaluate(() => ({
    safeStateVisible: Boolean(document.querySelector('.review-scene-state--empty, .review-scene-state--error')),
    queueVisible: Boolean(document.querySelector('[data-testid="review-queue"]') && document.querySelector('.review-notebook')),
    legacyCardTrayVisible: Boolean(document.querySelector('img[src*="review-card-tray-v1"]')),
    reviewStandVisible: Boolean(document.querySelector('img[src*="review-card-stand-v2"]')),
    legacyReviewStructureVisible: Boolean(document.querySelector('.review-planner, .review-index, .review-planner__frame'))
      || [...document.querySelectorAll('[class]')].some((node) => [...node.classList].some((className) => className.startsWith('review-ledger'))),
    rawIdentityVisible: /识别码|\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(document.querySelector('.review-reference-frame')?.textContent ?? ''),
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

  await window.getByLabel(/关闭任务面并返回/).click()
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
    await assertTaskSurfaceCompanionQuiet(window, 'LearningRun')
    await settleSurface(window)
    const learningRunLayoutProbe = await window.evaluate(() => {
      const player = document.querySelector('.run-player')
      const content = player?.querySelector('.run-player__content')
      const actionEdge = player?.querySelector('.run-player__action-edge')
      const primary = actionEdge?.querySelector('.run-submit-row .surface-primary')
      const editor = player?.querySelector('.run-text-editor textarea, .run-choice-list, .run-order-list, .run-relation-controls, .run-repair-list, .run-scenario-list, .run-bundle-editor, .run-blocker')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const actionRect = rect(actionEdge)
      const primaryRect = rect(primary)
      return {
        viewport,
        content: rect(content),
        editor: rect(editor),
        actionEdge: actionRect,
        primary: primaryRect,
        contentClientHeight: content instanceof HTMLElement ? content.clientHeight : 0,
        contentScrollHeight: content instanceof HTMLElement ? content.scrollHeight : 0,
        primaryWithinViewport: Boolean(primaryRect
          && primaryRect.left >= -1
          && primaryRect.top >= -1
          && primaryRect.right <= viewport.width + 1
          && primaryRect.bottom <= viewport.height + 1),
        primaryWithinEdge: Boolean(primaryRect && actionRect
          && primaryRect.left >= actionRect.left - 1
          && primaryRect.top >= actionRect.top - 1
          && primaryRect.right <= actionRect.right + 1
          && primaryRect.bottom <= actionRect.bottom + 1),
        primaryHit: Boolean(primaryRect && document.elementFromPoint(primaryRect.left + primaryRect.width / 2, primaryRect.top + primaryRect.height / 2)?.closest('.run-submit-row .surface-primary')),
      }
    })
    if (!learningRunLayoutProbe.actionEdge || !learningRunLayoutProbe.primary || !learningRunLayoutProbe.primaryWithinViewport || !learningRunLayoutProbe.primaryWithinEdge || !learningRunLayoutProbe.primaryHit || learningRunLayoutProbe.contentScrollHeight <= learningRunLayoutProbe.contentClientHeight) {
      throw new Error(`LearningRun primary action is not stably reachable: ${JSON.stringify(learningRunLayoutProbe)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-learning-run-owner-layout.json'), `${JSON.stringify(learningRunLayoutProbe, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-owner.png') })
    await window.locator('.run-player__content').evaluate((element) => {
      if (element instanceof HTMLElement) element.scrollTop = element.scrollHeight
    })
    await window.waitForTimeout(180)
    const editorAfterScroll = await window.locator('.run-player__content').evaluate((element) => {
      const editor = element.querySelector('.run-text-editor textarea, .run-choice-list, .run-order-list, .run-relation-controls, .run-repair-list, .run-scenario-list, .run-bundle-editor, .run-blocker')
      if (!(editor instanceof HTMLElement)) return null
      const bounds = editor.getBoundingClientRect()
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, visible: bounds.bottom > 0 && bounds.top < window.innerHeight }
    })
    if (!editorAfterScroll?.visible) throw new Error(`LearningRun editor is not reachable after scrolling: ${JSON.stringify(editorAfterScroll)}`)
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-owner-scrolled.png') })
    await window.locator('.run-player__content').evaluate((element) => {
      if (element instanceof HTMLElement) element.scrollTop = 0
    })
    await setSize(512, 350, true)
    await settleSurface(window)
    const compactLearningRunLayout = await window.evaluate(() => {
      const surface = document.querySelector('.task-surface--validation')
      const player = document.querySelector('.run-player')
      const content = player?.querySelector('.run-player__content')
      const actionEdge = player?.querySelector('.run-player__action-edge')
      const primary = actionEdge?.querySelector('.run-submit-row .surface-primary')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const actionRect = rect(actionEdge)
      const primaryRect = rect(primary)
      const playerStyle = player instanceof HTMLElement ? getComputedStyle(player) : null
      const contentStyle = content instanceof HTMLElement ? getComputedStyle(content) : null
      return {
        viewport,
        surface: rect(surface),
        surfaceClientHeight: surface instanceof HTMLElement ? surface.clientHeight : 0,
        surfaceScrollHeight: surface instanceof HTMLElement ? surface.scrollHeight : 0,
        actionEdge: actionRect,
        primary: primaryRect,
        primaryWithinViewport: Boolean(primaryRect
          && primaryRect.left >= -1
          && primaryRect.top >= -1
          && primaryRect.right <= viewport.width + 1
          && primaryRect.bottom <= viewport.height + 1),
        primaryHorizontallyWithinViewport: Boolean(primaryRect
          && primaryRect.left >= -1
          && primaryRect.right <= viewport.width + 1),
        primaryWithinEdge: Boolean(primaryRect && actionRect
          && primaryRect.left >= actionRect.left - 1
          && primaryRect.top >= actionRect.top - 1
          && primaryRect.right <= actionRect.right + 1
          && primaryRect.bottom <= actionRect.bottom + 1),
        primaryHit: Boolean(primaryRect && document.elementFromPoint(primaryRect.left + primaryRect.width / 2, primaryRect.top + primaryRect.height / 2)?.closest('.run-submit-row .surface-primary')),
        playerTransform: playerStyle?.transform ?? 'missing',
        contentOverflowY: contentStyle?.overflowY ?? 'missing',
      }
    })
    if (!compactLearningRunLayout.surface
      || compactLearningRunLayout.surfaceScrollHeight <= compactLearningRunLayout.surfaceClientHeight
      || !compactLearningRunLayout.primaryHorizontallyWithinViewport
      || compactLearningRunLayout.playerTransform !== 'none'
      || compactLearningRunLayout.contentOverflowY !== 'visible'
    ) {
      throw new Error(`LearningRun compact primary action drifted: ${JSON.stringify(compactLearningRunLayout)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-learning-run-owner-zoom-200-layout.json'), `${JSON.stringify(compactLearningRunLayout, null, 2)}\n`, 'utf8')
    await window.screenshot({ path: resolve(reviewRoot, 'desktop-learning-run-owner-zoom-200.png') })
    await window.locator('.run-player__action-edge .surface-primary').scrollIntoViewIfNeeded()
    await window.waitForTimeout(120)
    const compactLearningRunActionAfterScroll = await window.evaluate(() => {
      const primary = document.querySelector('.run-player__action-edge .surface-primary')
      if (!(primary instanceof HTMLElement)) return null
      const bounds = primary.getBoundingClientRect()
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        withinViewport: bounds.left >= -1 && bounds.top >= -1 && bounds.right <= viewport.width + 1 && bounds.bottom <= viewport.height + 1,
        hit: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('.run-submit-row .surface-primary') === primary,
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
      const player = document.querySelector('.run-player')
      const content = player?.querySelector('.run-player__content')
      const actionEdge = player?.querySelector('.run-player__action-edge')
      const primary = actionEdge?.querySelector('.run-submit-row .surface-primary')
      const editor = content?.querySelector('.run-text-editor textarea, .run-choice-list, .run-order-list, .run-relation-controls, .run-repair-list, .run-scenario-list, .run-bundle-editor, .run-blocker')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const actionRect = rect(actionEdge)
      const primaryRect = rect(primary)
      const playerStyle = player instanceof HTMLElement ? getComputedStyle(player) : null
      const contentStyle = content instanceof HTMLElement ? getComputedStyle(content) : null
      return {
        viewport,
        surface: rect(surface),
        player: rect(player),
        content: rect(content),
        editor: rect(editor),
        actionEdge: actionRect,
        primary: primaryRect,
        surfaceClientWidth: surface instanceof HTMLElement ? surface.clientWidth : 0,
        surfaceScrollWidth: surface instanceof HTMLElement ? surface.scrollWidth : 0,
        surfaceClientHeight: surface instanceof HTMLElement ? surface.clientHeight : 0,
        surfaceScrollHeight: surface instanceof HTMLElement ? surface.scrollHeight : 0,
        playerTransform: playerStyle?.transform ?? 'missing',
        contentOverflowY: contentStyle?.overflowY ?? 'missing',
        primaryWithinViewport: Boolean(primaryRect
          && primaryRect.left >= -1
          && primaryRect.right <= viewport.width + 1),
        primaryWithinEdge: Boolean(primaryRect && actionRect
          && primaryRect.left >= actionRect.left - 1
          && primaryRect.top >= actionRect.top - 1
          && primaryRect.right <= actionRect.right + 1
          && primaryRect.bottom <= actionRect.bottom + 1),
      }
    })
    if (compactLearningRun320Layout.viewport.width !== 320
      || compactLearningRun320Layout.surfaceScrollWidth > compactLearningRun320Layout.surfaceClientWidth + 1
      || compactLearningRun320Layout.surfaceScrollHeight <= compactLearningRun320Layout.surfaceClientHeight
      || compactLearningRun320Layout.playerTransform !== 'none'
      || compactLearningRun320Layout.contentOverflowY !== 'visible'
      || !compactLearningRun320Layout.primary
      || compactLearningRun320Layout.primary.height < 44
      || !compactLearningRun320Layout.primaryWithinViewport
      || !compactLearningRun320Layout.primaryWithinEdge) {
      throw new Error(`LearningRun 320 CSS px layout drifted: ${JSON.stringify(compactLearningRun320Layout)}`)
    }
    await writeFile(resolve(reviewRoot, 'desktop-learning-run-owner-320-css-px-layout.json'), `${JSON.stringify(compactLearningRun320Layout, null, 2)}\n`, 'utf8')
    await window.locator('.run-player__content').evaluate((element) => {
      if (element instanceof HTMLElement) element.scrollTop = element.scrollHeight
    })
    await window.locator('.run-player__action-edge .surface-primary').scrollIntoViewIfNeeded()
    await window.waitForTimeout(120)
    const compactLearningRun320ActionAfterScroll = await window.evaluate(() => {
      const primary = document.querySelector('.run-player__action-edge .surface-primary')
      const editor = document.querySelector('.run-player__content .run-text-editor textarea, .run-player__content .run-choice-list, .run-player__content .run-order-list, .run-player__content .run-relation-controls, .run-player__content .run-repair-list, .run-player__content .run-scenario-list, .run-player__content .run-bundle-editor, .run-player__content .run-blocker')
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
        hit: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('.run-submit-row .surface-primary') === primary,
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
  await window.waitForFunction(() => {
    const frame = document.querySelector('.room-reference-frame')
    const searchImages = [...document.querySelectorAll('.room-backplate--search-day, .room-backplate--search-night')]
    const theme = document.querySelector('.desktop-app')?.getAttribute('data-theme') ?? 'day'
    const visibleSearch = document.querySelector(theme === 'night' ? '.room-backplate--search-night' : '.room-backplate--search-day')
    const searchWorkbench = document.querySelector('.search-catalog-workbench')
    const searchForeground = document.querySelector('.search-catalog__foreground')
    const searchOccluders = [...document.querySelectorAll('.search-catalog__occluder')]
    const homeAndSeatImages = [...document.querySelectorAll('.room-backplate--home-day, .room-backplate--home-night, .room-backplate--seat-day, .room-backplate--seat-night')]
    return frame?.getAttribute('data-view-preset') === 'search'
      && searchImages.length === 2
      && searchImages.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1672 && image.naturalHeight === 941)
      && visibleSearch instanceof HTMLElement
      && Number.parseFloat(getComputedStyle(visibleSearch).opacity) > 0.98
      && searchWorkbench?.getAttribute('data-search-foreground') === 'ready'
      && searchWorkbench?.getAttribute('data-search-foreground-motion') === 'active'
      && searchForeground instanceof HTMLImageElement
      && searchForeground.complete
      && searchForeground.naturalWidth === 1672
      && searchForeground.naturalHeight === 941
      && getComputedStyle(searchForeground).display !== 'none'
      && Number.parseFloat(getComputedStyle(searchForeground).opacity) > 0.98
      && searchOccluders.length === 3
      && searchOccluders.every((occluder) => getComputedStyle(occluder).display === 'none')
      && homeAndSeatImages.every((image) => Number.parseFloat(getComputedStyle(image).opacity) < 0.02)
      && document.querySelectorAll('.window-ambient-video').length === 0
      && !document.querySelector('.search-catalog__shelf')
      && document.querySelectorAll('.search-catalog [data-scene-surface-layer="material"]').length === 0
      && document.querySelectorAll('.search-catalog [data-scene-surface-layer="occluder"]').length === 3
      && document.querySelectorAll('.search-catalog [data-scene-surface-projection="projected"]').length === 4
  }, undefined, { timeout: 15_000 })
  const searchSceneContract = await window.evaluate(() => {
    const app = document.querySelector('.desktop-app')
    const appStyle = app instanceof HTMLElement ? getComputedStyle(app) : null
    const searchFrame = document.querySelector('.search-catalog-reference-frame')
    return {
      preset: document.querySelector('.room-reference-frame')?.getAttribute('data-view-preset'),
      theme: document.querySelector('.desktop-app')?.getAttribute('data-theme'),
      searchDay: document.querySelector('.room-backplate--search-day')?.getAttribute('src'),
      searchNight: document.querySelector('.room-backplate--search-night')?.getAttribute('src'),
      searchOpacity: Number.parseFloat(getComputedStyle(document.querySelector('.room-backplate--search-day') ?? document.body).opacity)
        + Number.parseFloat(getComputedStyle(document.querySelector('.room-backplate--search-night') ?? document.body).opacity),
      foreground: (() => {
        const image = document.querySelector('.search-catalog__foreground')
        const workbench = document.querySelector('.search-catalog-workbench')
        return {
          source: image?.getAttribute('src'),
          naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
          naturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : 0,
          opacity: Number.parseFloat(getComputedStyle(image ?? document.body).opacity),
          display: getComputedStyle(image ?? document.body).display,
          ready: workbench?.getAttribute('data-search-foreground') === 'ready',
          motion: workbench?.getAttribute('data-search-foreground-motion') ?? null,
        }
      })(),
      homeAndSeatOpacity: [...document.querySelectorAll('.room-backplate--home-day, .room-backplate--home-night, .room-backplate--seat-day, .room-backplate--seat-night')]
        .map((image) => Number.parseFloat(getComputedStyle(image).opacity)),
      windowMedia: document.querySelectorAll('.window-ambient-video').length,
      projectedSurfaceCount: document.querySelectorAll('.search-catalog [data-scene-surface-projection="projected"]').length,
      legacyShelfOverlay: Boolean(document.querySelector('.search-catalog__shelf')),
      materialLayerCount: document.querySelectorAll('.search-catalog [data-scene-surface-layer="material"]').length,
      occluderLayerCount: document.querySelectorAll('.search-catalog [data-scene-surface-layer="occluder"]').length,
      occluderDisplay: [...document.querySelectorAll('.search-catalog__occluder')]
        .map((occluder) => getComputedStyle(occluder).display),
      camera: {
        scale: appStyle?.getPropertyValue('--scene-camera-scale').trim() ?? '',
        xPercent: appStyle?.getPropertyValue('--scene-camera-x-percent').trim() ?? '',
        yPercent: appStyle?.getPropertyValue('--scene-camera-y-percent').trim() ?? '',
      },
      taskReferenceTransform: searchFrame instanceof HTMLElement ? getComputedStyle(searchFrame).transform : 'missing',
      rawIdentityVisible: /\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(document.querySelector('.search-catalog')?.textContent ?? ''),
    }
  })
  if (
    searchSceneContract.preset !== 'search'
    || !searchSceneContract.searchDay?.includes('search-reference-day-v1.png')
    || !searchSceneContract.searchNight?.includes('search-reference-night-v1.png')
    || !searchSceneContract.foreground.source?.includes(`search-foreground-${searchSceneContract.theme}-v1.png`)
    || searchSceneContract.foreground.naturalWidth !== 1672
    || searchSceneContract.foreground.naturalHeight !== 941
    || !searchSceneContract.foreground.ready
    || searchSceneContract.foreground.motion !== 'active'
    || searchSceneContract.foreground.display === 'none'
    || searchSceneContract.foreground.opacity <= 0.98
    || searchSceneContract.homeAndSeatOpacity.some((opacity) => opacity > 0.02)
    || searchSceneContract.windowMedia !== 0
    || searchSceneContract.projectedSurfaceCount !== 4
    || searchSceneContract.legacyShelfOverlay
    || searchSceneContract.materialLayerCount !== 0
    || searchSceneContract.occluderLayerCount !== 3
    || searchSceneContract.occluderDisplay.some((display) => display !== 'none')
    || searchSceneContract.camera.scale !== '1'
    || searchSceneContract.camera.xPercent !== '0%'
    || searchSceneContract.camera.yPercent !== '0%'
    || searchSceneContract.taskReferenceTransform === 'none'
    || searchSceneContract.rawIdentityVisible
  ) {
    throw new Error(`Search did not switch to the independent archive scene: ${JSON.stringify(searchSceneContract)}`)
  }
  const foregroundProbe = await window.locator('.search-catalog__foreground').boundingBox()
  if (!foregroundProbe) throw new Error('Search foreground did not expose a measurable desktop frame')
  const foregroundCenter = {
    x: foregroundProbe.x + foregroundProbe.width * 0.5,
    y: foregroundProbe.y + foregroundProbe.height * 0.5,
  }
  await window.mouse.move(foregroundCenter.x, foregroundCenter.y)
  await window.waitForTimeout(80)
  const centeredForeground = await window.locator('.search-catalog__foreground').boundingBox()
  if (!centeredForeground) throw new Error('Search foreground disappeared during motion probe')
  await window.mouse.move(
    foregroundProbe.x + foregroundProbe.width * 0.9,
    foregroundProbe.y + foregroundProbe.height * 0.45,
  )
  await window.waitForFunction(
    (baseline) => {
      const image = document.querySelector('.search-catalog__foreground')
      if (!(image instanceof HTMLElement)) return false
      const bounds = image.getBoundingClientRect()
      return Math.abs(bounds.left - baseline.left) > 0.25 || Math.abs(bounds.top - baseline.top) > 0.25
    },
    { left: centeredForeground.x, top: centeredForeground.y },
    { timeout: 2_000 },
  )
  await window.mouse.move(foregroundCenter.x, foregroundCenter.y)
  await searchInput.fill('不存在的概念')
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-search-empty.png') })
  await searchInput.fill(focusSearchTerm)
  await settleSurface(window)
  await window.screenshot({ path: resolve(reviewRoot, 'desktop-search.png') })
  await searchInput.press('Enter')
  await settleSurface(window)
  const searchResultContract = await window.evaluate(() => ({
    studyOpened: Boolean(document.querySelector('.task-surface--study')),
    safeSearchState: Boolean(document.querySelector('.search-catalog-workbench--error, .search-shelf__state')),
  }))
  if (!searchResultContract.studyOpened && !searchResultContract.safeSearchState) {
    throw new Error(`Search did not open the real focus or stop at a safe boundary: ${JSON.stringify(searchResultContract)}`)
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
    const compactStudyContract = await window.evaluate(() => {
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const workbench = document.querySelector('.study-workbench.study-workbench--ready')
      const ink = workbench?.querySelector('.study-notebook__ink--reading')
      const heading = workbench?.querySelector('.study-objective h2')
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const bounds = element.getBoundingClientRect()
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
      }
      const headingRect = heading instanceof HTMLElement ? heading.getBoundingClientRect() : null
      const inkRect = ink instanceof HTMLElement ? ink.getBoundingClientRect() : null
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
        workbench: rect(workbench),
        ink: inkRect,
        heading: headingRect,
        headingHorizontallyWithinInk: horizontallyWithin(headingRect, inkRect),
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
      || !compactStudyContract.ink
      || !compactStudyContract.headingHorizontallyWithinInk
      || !compactStudyContract.headingHorizontallyWithinViewport
    ) {
      throw new Error(`Study content exceeded the 200% reading bounds: ${JSON.stringify(compactStudyContract)}`)
    }
  } else {
    const studyState = window.locator('.study-boundary:is([role="alert"]), .study-workbench--empty, .study-workbench--error').first()
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
  if (await window.locator('.window-live2d[data-companion-renderer="orb"]').count() !== 1) throw new Error('Reduced motion did not keep the companion as a static orb')
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
