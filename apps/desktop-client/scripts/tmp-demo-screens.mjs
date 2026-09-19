import { mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const demosRoot = resolve(appRoot, '../../outputs/companion-demos')
const outRoot = resolve(demosRoot, '_preview')
mkdirSync(outRoot, { recursive: true })

const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

const browser = await electron.launch({ args: ['--window-size=1460,830', resolve(demosRoot, 'index.html')] })
const page = await browser.firstWindow()
await page.waitForTimeout(400)

async function shot(file, prefix, actions) {
  await page.goto('file://' + resolve(demosRoot, file))
  await page.waitForTimeout(700)
  if (actions) await actions()
  await page.screenshot({ path: resolve(outRoot, `${prefix}.png`) })
  console.log('captured', prefix)
}

await shot('demo-a-balloon.html', 'a-1-idle')
await shot('demo-a-balloon.html', 'a-2-open', async () => {
  await page.click('#nameToggle', { force: true })
  await page.waitForTimeout(3200)
})
await shot('demo-a-balloon.html', 'a-3-sent', async () => {
  await page.click('#nameToggle', { force: true })
  await page.waitForTimeout(2600)
  await page.click('.chip', { force: true })
  await page.waitForTimeout(3600)
})
await shot('demo-b-journal.html', 'b-1-open', async () => {
  await page.click('#bookmark', { force: true })
  await page.waitForTimeout(3400)
})
await shot('demo-b-journal.html', 'b-2-sent', async () => {
  await page.click('#bookmark', { force: true })
  await page.waitForTimeout(3200)
  await page.fill('#input', '今天先学点新的')
  await page.click('#sendBtn')
  await page.waitForTimeout(3600)
})
await shot('demo-c-console.html', 'c-1-idle')
await shot('demo-c-console.html', 'c-2-open', async () => {
  await page.click('#console', { position: { x: 30, y: 30 }, force: true })
  await page.waitForTimeout(3200)
})
await browser.close()
