import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review')
await mkdir(reviewRoot, { recursive: true })

const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-island-review-'))
const electronApp = await electron.launch({ args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`], cwd: appRoot, executablePath })

try {
  const window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0]
    target?.setContentSize(1440, 810)
    target?.center()
  })

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
    actionContract.width !== 290
    || actionContract.height !== 58
    || actionContract.left !== 18
    || actionContract.bottom !== 18
    || actionContract.radius !== '999px'
    || actionContract.background !== 'rgba(28, 24, 22, 0.68)'
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
    || contract.box.width !== 238
    || contract.box.height !== 48
    || contract.shellOpacity !== '1'
    || contract.panelOpacity !== '1'
    || contract.panelTransform !== 'matrix(1, 0, 0, 1, 0, 0)'
  ) {
    throw new Error(`Approved island contract drifted: ${JSON.stringify(contract)}`)
  }

  await window.screenshot({ path: resolve(reviewRoot, 'global-island-controls.png') })
  console.log(JSON.stringify(contract, null, 2))
} finally {
  await electronApp.close()
}
