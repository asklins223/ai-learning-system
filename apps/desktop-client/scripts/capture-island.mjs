import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review')
await mkdir(reviewRoot, { recursive: true })

const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-island-review-'))
const electronApp = await electron.launch({ args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`], cwd: appRoot, executablePath })
const captureOwnerCredentialsAvailable = Boolean(process.env.OWNER_EMAIL?.trim() && process.env.OWNER_PASSWORD)

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

async function enterOwnerRoom(window) {
  if (!captureOwnerCredentialsAvailable) {
    throw new Error('Global island capture requires OWNER_EMAIL and OWNER_PASSWORD for the authenticated Room shell')
  }

  await window.waitForFunction(
    () => Boolean(document.querySelector('.action-rail')) || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')),
    undefined,
    { timeout: 20_000 },
  )
  const visibleActionRail = window.locator('.action-rail:visible').first()
  if (await visibleActionRail.count() > 0) return
  if (await window.locator('.desktop-access-gate input[type="email"]').count() === 0) {
    await visibleActionRail.waitFor({ state: 'visible', timeout: 20_000 })
    return
  }

  await window.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL)
  await window.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD)
  await window.getByRole('button', { name: '登录并继续' }).click()

  const deadline = Date.now() + 30_000
  let workspaceChosen = false
  while (Date.now() < deadline && await window.locator('.action-rail:visible').count() === 0) {
    const formError = window.locator('.desktop-access-gate__form-error')
    if (await formError.count()) throw new Error(`Owner Gate login failed: ${await formError.innerText()}`)

    const workspaceButtons = window.locator('.desktop-access-gate__workspace-list button')
    if (!workspaceChosen && await workspaceButtons.count()) {
      const ownerWorkspace = workspaceButtons.filter({ hasText: '所有者' }).first()
      await (await ownerWorkspace.count() ? ownerWorkspace : workspaceButtons.first()).click()
      workspaceChosen = true
    }

    const blockedNotice = window.locator('.desktop-access-gate__notice')
    if (await blockedNotice.count()) throw new Error(`Owner Gate stopped before Room ready: ${await blockedNotice.innerText()}`)
    await window.waitForTimeout(250)
  }

  await visibleActionRail.waitFor({ state: 'visible', timeout: 1_000 })
}

try {
  const window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0]
    target?.setContentSize(1440, 810)
    target?.center()
  })

  await enterOwnerRoom(window)
  await window.waitForFunction(() => {
    const images = [...document.querySelectorAll('.room-backplate--home-day, .room-backplate--home-night')]
    return images.length === 2 && images.every((image) => image instanceof HTMLImageElement && image.complete)
  })
  await window.waitForTimeout(850)

  if (await window.locator('.onboarding-card').count()) {
    const onboardingContract = await window.locator('.onboarding-card').evaluate((card) => {
      const style = getComputedStyle(card)
      const box = card.getBoundingClientRect()
      return {
        width: box.width,
        minHeight: style.minHeight,
        radius: style.borderRadius,
        background: style.backgroundColor,
        backdropFilter: style.backdropFilter,
      }
    })
    if (
      onboardingContract.width !== 820
      || onboardingContract.minHeight !== '82px'
      || onboardingContract.radius !== '28px'
      || onboardingContract.background !== 'rgba(25, 22, 20, 0.64)'
    ) {
      throw new Error(`Approved onboarding island contract drifted: ${JSON.stringify(onboardingContract)}`)
    }
    await window.screenshot({ path: resolve(reviewRoot, 'global-island-onboarding.png') })
    await window.getByRole('button', { name: '无声进入' }).click()
    await window.waitForTimeout(450)
  }

  const trigger = window.getByLabel('展开房间控制')
  await trigger.waitFor({ state: 'visible' })
  const actionContract = await window.locator('.action-rail').evaluate((rail) => {
    const style = getComputedStyle(rail)
    const box = rail.getBoundingClientRect()
    const primary = rail.querySelector('.rail-action--primary')
    const primaryStyle = primary ? getComputedStyle(primary) : null
    const icon = primary?.querySelector('.rail-action__icon')
    const iconStyle = icon ? getComputedStyle(icon) : null
    return {
      width: box.width,
      height: box.height,
      left: box.left,
      bottom: innerHeight - box.bottom,
      radius: style.borderRadius,
      background: style.backgroundColor,
      primaryBackground: primaryStyle?.backgroundColor,
      iconRadius: iconStyle?.borderRadius,
      iconSize: icon ? icon.getBoundingClientRect().width : 0,
    }
  })
  if (
    actionContract.width !== 286
    || actionContract.height !== 58
    || actionContract.left !== 18
    || actionContract.bottom !== 18
    || actionContract.radius !== '999px'
    || actionContract.background !== 'rgba(27, 24, 21, 0.76)'
    || actionContract.primaryBackground !== 'rgba(0, 0, 0, 0)'
    || actionContract.iconRadius !== '50%'
    || actionContract.iconSize !== 32
  ) {
    throw new Error(`Approved action island contract drifted: ${JSON.stringify(actionContract)}`)
  }
  await window.screenshot({ path: resolve(reviewRoot, 'global-island-actions.png') })

  await trigger.click()
  await window.waitForTimeout(500)

  const contract = await window.locator('.immersive-island').evaluate((island) => {
    const panel = island.querySelector('.island-panel')
    const triggerButton = island.querySelector('.island-trigger')
    const islandStyle = getComputedStyle(island)
    const shellStyle = getComputedStyle(island, '::before')
    const highlightStyle = getComputedStyle(island, '::after')
    const panelStyle = panel ? getComputedStyle(panel) : null
    const triggerStyle = triggerButton ? getComputedStyle(triggerButton) : null
    const box = island.getBoundingClientRect()
    return {
      box: { width: box.width, height: box.height, top: box.top, right: innerWidth - box.right },
      color: islandStyle.color,
      shellOpacity: shellStyle.opacity,
      shellTransform: shellStyle.transform,
      shellBackground: shellStyle.backgroundColor,
      highlightOpacity: highlightStyle.opacity,
      panelOpacity: panelStyle?.opacity,
      panelTransform: panelStyle?.transform,
      triggerBackground: triggerStyle?.backgroundColor,
      expanded: island.classList.contains('immersive-island--expanded'),
    }
  })

  if (
    !contract.expanded
    || contract.box.width !== 286
    || contract.box.height !== 48
    || contract.shellOpacity !== '1'
    || contract.panelOpacity !== '1'
    || contract.panelTransform !== 'matrix(1, 0, 0, 1, 0, 0)'
  ) {
    throw new Error(`Approved island contract drifted: ${JSON.stringify(contract)}`)
  }

  await window.screenshot({ path: resolve(reviewRoot, 'global-island-controls.png') })
  await setZoomFactor(2)
  await setSize(640, 810, true)
  await window.waitForTimeout(400)
  const compactContract = await window.locator('.immersive-island').evaluate((island) => {
    const controls = [...island.querySelectorAll('.island-trigger, .island-panel button')]
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
    const hit = (element) => {
      const bounds = rect(element)
      if (!bounds) return false
      const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return target === element || target?.closest?.('button') === element
    }
    const islandStyle = getComputedStyle(island)
    const panel = island.querySelector('.island-panel')
    const panelStyle = panel ? getComputedStyle(panel) : null
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      island: rect(island),
      panel: rect(panel),
      controls: controls.map((element) => ({ ...rect(element), hit: hit(element) })),
      islandOverflowX: islandStyle.overflowX,
      panelOverflowX: panelStyle?.overflowX ?? null,
      panelScrollWidth: panel instanceof HTMLElement ? panel.scrollWidth : 0,
      panelClientWidth: panel instanceof HTMLElement ? panel.clientWidth : 0,
    }
  })
  if (
    compactContract.viewport.width !== 320
    || !compactContract.island
    || !compactContract.panel
    || compactContract.controls.length !== 6
    || compactContract.controls.some((control) => !control || control.height < 44 || control.top < -1 || control.left < -1 || control.bottom > compactContract.viewport.height + 1 || control.right > compactContract.viewport.width + 1 || !control.hit)
    || compactContract.panelScrollWidth > compactContract.panelClientWidth + 1
  ) {
    throw new Error(`Global island 320 CSS px controls were not reachable: ${JSON.stringify(compactContract)}`)
  }
  await writeFile(resolve(reviewRoot, 'global-island-320-css-px.json'), `${JSON.stringify(compactContract, null, 2)}\n`, 'utf8')
  await window.screenshot({ path: resolve(reviewRoot, 'global-island-320-css-px.png') })
  await setZoomFactor(1)
  await setSize(1440, 810)
  console.log(JSON.stringify(contract, null, 2))
} finally {
  await electronApp.close()
}
