/*
 * Captures the rebuilt note pages (07 library, 08 reading, 09 editing) from the
 * client the owner is actually looking at, over CDP.
 *
 * Usage: AILEARN_CAPTURE_CDP=http://127.0.0.1:9222 node scripts/capture-note-pages.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const outRoot = resolve(appRoot, '../../.impeccable/review/desktop-pages-v3/live/notes')
await mkdir(outRoot, { recursive: true })

const endpoint = process.env.AILEARN_CAPTURE_CDP ?? 'http://127.0.0.1:9222'
const browser = await chromium.connectOverCDP(endpoint)
const window = browser.contexts()[0].pages()[0]

const settle = (ms = 900) => window.waitForTimeout(ms)

/** The gate is a real login when the session has expired; capture needs the room. */
async function ensureRoom() {
  await window.waitForFunction(
    () => Boolean(document.querySelector('.hud-rail')) || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')),
    undefined,
    { timeout: 30_000 },
  )
  if (await window.locator('.hud-rail').count()) return
  await window.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL ?? '')
  await window.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
  await window.getByRole('button', { name: '登录', exact: true }).click()
  await window.waitForFunction(() => Boolean(document.querySelector('.hud-rail')), undefined, { timeout: 30_000 })
  await settle(1600)
}
const errors = []
window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
window.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })

const geometry = () => window.evaluate(() => {
  const box = (selector) => {
    const element = document.querySelector(selector)
    if (!(element instanceof HTMLElement)) return null
    const rect = element.getBoundingClientRect()
    return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
  }
  return {
    page: document.querySelector('.desktop-app')?.getAttribute('data-hud-page') ?? null,
    classes: document.querySelector('.desktop-app')?.className ?? '',
    title: document.querySelector('.task-title h1')?.textContent?.trim() ?? null,
    subtitle: document.querySelector('.task-title p')?.textContent?.trim() ?? null,
    shelf: box('.note-shelf'),
    currentNote: box('.current-note'),
    covers: [...document.querySelectorAll('.book-cover')].map((cover) => ({
      cls: cover.className,
      box: box(`.${[...cover.classList].join('.')}`),
      text: cover.textContent?.replace(/\s+/g, ' ').trim(),
    })),
    notebook: box('.notebook'),
    // A paper that reports more scroll width than client width is showing the
    // horizontal scrollbar the pasted clips used to push it into.
    notebookScroll: (() => {
      const paper = document.querySelector('.notebook')
      if (!(paper instanceof HTMLElement)) return null
      return {
        scroll: [paper.scrollWidth, paper.scrollHeight],
        client: [paper.clientWidth, paper.clientHeight],
      }
    })(),
    body: box('.reading-body'),
    clips: box('.source-clips'),
    actions: box('.notebook-actions'),
    saveLine: box('.save-line'),
    rail: box('.hud-rail'),
    control: box('.room-control'),
    companion: box('.companion-scene-anchor'),
    bodyOverflow: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    inner: [window.innerWidth, window.innerHeight],
  }
})

async function shot(name) {
  const snapshot = await geometry()
  await window.screenshot({ path: resolve(outRoot, `${name}.png`) })
  await writeFile(resolve(outRoot, `${name}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  console.log(`${name} page=${snapshot.page} title=${snapshot.title} body=${JSON.stringify(snapshot.bodyOverflow)}`)
}

const click = async (selector) => {
  await window.waitForSelector(selector, { timeout: 15_000 })
  await window.evaluate((target) => {
    const element = document.querySelector(target)
    if (element instanceof HTMLElement) element.click()
  }, selector)
  await settle(1000)
}

try {
  await ensureRoom()
  await window.waitForFunction(
    () => Boolean(document.querySelector('.hud-rail .nav-chip[aria-label="笔记"]')),
    undefined,
    { timeout: 30_000 },
  )
  // The flow the pages promise: shelf → a note's reading page → its editor.
  await click('.hud-rail .nav-chip[aria-label="笔记"]')
  await settle(1200)
  await shot('07-note-library')

  await click('.current-note .note-open')
  await settle(1400)
  await shot('08-note-read')

  await click('.notebook-actions .button.primary')
  await settle(1400)
  await shot('09-note-edit')

  if (errors.length) console.log(`\n--- console/page errors (${errors.length}) ---\n${errors.slice(0, 12).join('\n')}`)
  console.log(`captured -> ${outRoot}`)
} catch (error) {
  console.error(error)
  if (errors.length) console.error(errors.slice(0, 12).join('\n'))
  process.exitCode = 1
} finally {
  // Disconnect without closing the window under review.
process.exit(0)
}
