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
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-companion-demo-'))
const electronApp = await electron.launch({ args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`], cwd: appRoot, executablePath })
const window = await electronApp.firstWindow()

const errors = []
window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

await window.waitForLoadState('domcontentloaded')
await electronApp.evaluate(({ BrowserWindow }) => {
  const target = BrowserWindow.getAllWindows()[0]
  target?.setMinimumSize(1, 1)
  target?.setContentSize(1440, 810)
  target?.center()
})
await window.waitForTimeout(600)

// 登录
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

// 首次引导
if (await window.locator('.onboarding-card').count()) {
  await window.getByRole('button', { name: '无声进入' }).click().catch(async () => {
    await window.getByRole('button', { name: '跳过首次引导' }).click()
  })
}
await window.waitForTimeout(2500)
await window.screenshot({ path: resolve(outRoot, '01-home.png') })

// 伴星形态与入口
const state1 = await window.evaluate(() => ({
  scene: document.querySelector('.desktop-app')?.getAttribute('data-home-scene') ?? null,
  presence: Boolean(document.querySelector('.companion-presence')),
  open: document.querySelector('.companion-presence')?.getAttribute('data-open') ?? null,
  dock: document.querySelectorAll('.companion-dock').length,
  invite: document.querySelector('.companion-invite')?.textContent?.trim() ?? null,
}))
console.log('initial companion state:', JSON.stringify(state1))
await window.screenshot({ path: resolve(outRoot, '02-companion-idle.png') })

// 打开交互台：优先点击角色本体
const shell = window.locator('.companion-visual-shell')
if (await shell.count()) {
  await shell.click()
  await window.waitForTimeout(900)
}
let state2 = await window.evaluate(() => ({
  open: document.querySelector('.companion-presence')?.getAttribute('data-open') ?? null,
  dock: document.querySelectorAll('.companion-dock').length,
}))
console.log('after shell click:', JSON.stringify(state2))
if (!state2.dock) {
  // 找唤醒伴星入口
  const wake = window.getByRole('button', { name: /唤醒伴星|伴星/ }).first()
  if (await wake.count()) {
    await wake.click()
    await window.waitForTimeout(900)
  }
}
state2 = await window.evaluate(() => ({
  open: document.querySelector('.companion-presence')?.getAttribute('data-open') ?? null,
  dock: document.querySelectorAll('.companion-dock').length,
}))
console.log('after wake:', JSON.stringify(state2))
await window.screenshot({ path: resolve(outRoot, '03-dock-open.png') })

// 功能夹
if (await window.getByRole('button', { name: '打开功能夹' }).count()) {
  await window.getByRole('button', { name: '打开功能夹' }).click()
  await window.waitForTimeout(700)
  await window.screenshot({ path: resolve(outRoot, '04-action-menu.png') })
  await window.keyboard.press('Escape')
  await window.waitForTimeout(400)
}

// 对话记录抽屉
if (await window.getByRole('button', { name: '打开对话记录' }).count()) {
  await window.getByRole('button', { name: '打开对话记录' }).click()
  await window.waitForTimeout(700)
  await window.screenshot({ path: resolve(outRoot, '05-chat-drawer.png') })
  await window.keyboard.press('Escape')
  await window.waitForTimeout(400)
}

// 输入一条消息看 thinking 状态
const input = window.locator('.companion-dock__input')
if (await input.count()) {
  await input.fill('今天我该从哪里开始？')
  await window.screenshot({ path: resolve(outRoot, '06-composer-filled.png') })
  await window.locator('.companion-dock__send').click()
  await window.waitForTimeout(1200)
  await window.screenshot({ path: resolve(outRoot, '07-thinking.png') })
  await window.waitForTimeout(6000)
  await window.screenshot({ path: resolve(outRoot, '08-reply.png') })
}

console.log('renderer errors:', JSON.stringify(errors))
await electronApp.close()
