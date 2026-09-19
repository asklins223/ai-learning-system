import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const outRoot = resolve(appRoot, '../../outputs/companion-demo-audit')
mkdirSync(outRoot, { recursive: true })

const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-companion-backdrop-'))
const electronApp = await electron.launch({ args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`], cwd: appRoot, executablePath })
const window = await electronApp.firstWindow()
await window.waitForLoadState('domcontentloaded')
await electronApp.evaluate(({ BrowserWindow }) => {
  const target = BrowserWindow.getAllWindows()[0]
  target?.setMinimumSize(1, 1)
  target?.setContentSize(1440, 810)
  target?.center()
})

await window.waitForFunction(
  () => Boolean(document.querySelector('.action-rail')) || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')),
  undefined,
  { timeout: 20_000 },
)
if (await window.locator('.action-rail').count() === 0) {
  await window.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL)
  await window.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD)
  await window.getByRole('button', { name: '登录', exact: true }).click()
  const deadline = Date.now() + 30_000
  let workspaceChosen = false
  while (Date.now() < deadline && await window.locator('.action-rail').count() === 0) {
    const workspaceButtons = window.locator('.desktop-access-gate__workspace-list button')
    if (!workspaceChosen && await workspaceButtons.count()) {
      await workspaceButtons.first().click()
      workspaceChosen = true
    }
    await window.waitForTimeout(250)
  }
}
await window.locator('.action-rail').waitFor({ state: 'visible', timeout: 20_000 })

// 稳妥地关掉首次引导
try {
  await window.locator('.onboarding-card').waitFor({ state: 'visible', timeout: 8_000 })
  for (const name of ['无声进入', '跳过首次引导']) {
    const button = window.getByRole('button', { name })
    if (await button.count()) {
      await button.click()
      break
    }
  }
  await window.locator('.onboarding-card').waitFor({ state: 'hidden', timeout: 8_000 })
} catch (error) {
  console.log('onboarding dismiss issue:', error.message.split('\n')[0])
}

// 如果停在设置中心等页面，回到书房
try {
  const back = window.getByRole('button', { name: '返回书房' })
  await back.waitFor({ state: 'visible', timeout: 4000 })
  await back.click()
  console.log('returned to room from settings page')
} catch {}

// 等 Live2D canvas 真正渲染出内容（非空白）
const rendered = await window.waitForFunction(() => {
  const canvas = document.querySelector('.companion-visual-shell canvas')
  if (!canvas) return false
  const rect = canvas.getBoundingClientRect()
  if (rect.width < 40 || rect.height < 60) return false
  try {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return true
    const px = new Uint8Array(4 * 200)
    gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 10, 10, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return px.some((v) => v > 12)
  } catch {
    return true
  }
}, undefined, { timeout: 40_000 }).then(() => true).catch(() => false)
console.log('live2d rendered:', rendered)
await window.waitForTimeout(3500)
const rect = await window.evaluate(() => {
  const shell = document.querySelector('.companion-visual-shell')
  const canvas = document.querySelector('.companion-visual-shell canvas')
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  return { shell: box(shell), canvas: box(canvas), dpr: window.devicePixelRatio }
})
console.log('rect:', JSON.stringify(rect))
await window.screenshot({ path: resolve(outRoot, 'backdrop-raw.png') })
await electronApp.close()
