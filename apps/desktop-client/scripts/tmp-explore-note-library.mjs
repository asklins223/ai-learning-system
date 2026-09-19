/*
 * Temporary review harness: walks every note-library state and captures
 * screenshots + geometry so the layout audit works from real evidence.
 * Usage: AILEARN_CAPTURE_CDP=http://127.0.0.1:9222 node scripts/tmp-explore-note-library.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const outRoot = resolve(appRoot, '../../.impeccable/review/desktop-pages-v3/live/note-library-audit')
await mkdir(outRoot, { recursive: true })

const endpoint = process.env.AILEARN_CAPTURE_CDP ?? 'http://127.0.0.1:9222'
const browser = await chromium.connectOverCDP(endpoint)
const window = browser.contexts()[0].pages()[0]
const cdp = await window.context().newCDPSession(window)
const settle = (ms = 900) => window.waitForTimeout(ms)

const setViewport = async (width, height) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
  await settle(500)
}

const errors = []
window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

const geometry = () => window.evaluate(() => {
  const box = (selector) => {
    const element = document.querySelector(selector)
    if (!(element instanceof HTMLElement)) return null
    const rect = element.getBoundingClientRect()
    return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
  }
  const overlapArea = (a, b) => {
    if (!a || !b) return 0
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    return w > 0 && h > 0 ? w * h : 0
  }
  const sheet = box('.current-note')
  const entries = box('.note-shelf-entries')
  const actions = box('.note-shelf-actions')
  const preview = box('.current-note .serif')
  const smallLine = box('.current-note .small')
  const index = box('.note-index')
  const searchLine = box('.note-index .search-line')
  const tabs = box('.note-index .index-tabs')
  const list = box('.note-index .source-list')
  const footer = box('.note-index .index-footer')
  const firstRow = box('.note-index .source-list .note-row')
  const rowTexts = [...document.querySelectorAll('.note-index .source-list .note-row strong')].slice(0, 4).map((node) => node.textContent?.trim())
  const paper = document.querySelector('.note-index')
  return {
    page: document.querySelector('.desktop-app')?.getAttribute('data-hud-page') ?? null,
    inner: [window.innerWidth, window.innerHeight],
    sheet, entries, actions, preview, smallLine,
    previewOverlapsEntries: overlapArea(preview, entries),
    previewOverlapsActions: overlapArea(preview, actions),
    entriesActionsOverlap: overlapArea(entries, actions),
    index, searchLine, tabs, list, footer, firstRow, rowTexts,
    indexRows: document.querySelectorAll('.note-index .note-row').length,
    indexScroll: paper instanceof HTMLElement
      ? { scroll: [paper.scrollWidth, paper.scrollHeight], client: [paper.clientWidth, paper.clientHeight] }
      : null,
    listScroll: (() => {
      const el = document.querySelector('.note-index .source-list')
      if (!(el instanceof HTMLElement)) return null
      return { scroll: [el.scrollWidth, el.scrollHeight], client: [el.clientWidth, el.clientHeight] }
    })(),
    bodyOverflow: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
  }
})

async function shot(name) {
  const snapshot = await geometry()
  await window.screenshot({ path: resolve(outRoot, `${name}.png`) })
  await writeFile(resolve(outRoot, `${name}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  console.log(`${name} page=${snapshot.page} rows=${snapshot.indexRows} inner=${JSON.stringify(snapshot.inner)}`)
}

try {
  await window.waitForFunction(() => Boolean(document.querySelector('.hud-rail')), undefined, { timeout: 30_000 })
  await window.locator('.hud-rail .nav-chip[aria-label="笔记"]').click()
  await settle(1200)

  // 1. shelf
  await shot('a-shelf')

  // 2. index view
  await window.locator('.note-shelf-all').click()
  await settle(1000)
  await shot('b-index')

  // 3. search with a real query
  await window.locator('#note-index-query').fill('IndexTTS')
  await window.locator('.note-index .search-line button[type="submit"]').click()
  await settle(1500)
  await shot('c-index-search')

  // 4. clear search, back to 全部 tab
  await window.locator('#note-index-query').fill('')
  await settle(500)
  await window.locator('.note-index .index-tabs button').first().click()
  await settle(900)

  // 5. rename flow on the first row
  const renameButton = window.locator('.note-row .text-action').first()
  if (await renameButton.count()) {
    await renameButton.click()
    await settle(400)
    await shot('e-index-rename')
    await window.keyboard.press('Escape')
    await settle(300)
  }

  // 6. delete-confirm flow on the first row
  const dangerButtons = window.locator('.note-row .text-action--danger')
  if (await dangerButtons.count()) {
    await dangerButtons.first().click()
    await settle(400)
    await shot('f-index-confirm-delete')
    await window.locator('.note-row .text-action:not(.text-action--danger)').first().click()
    await settle(300)
  }

  // 7. trash view
  await window.locator('.note-index-trash').click()
  await settle(1200)
  await shot('g-trash')
  await window.locator('.note-index-trash').click()
  await settle(500)

  // 8. back to shelf, then compact viewport (200% zoom ⇒ 720×405 CSS)
  await window.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' })))
  await settle(300)
  // use the return target pill added for the index level
  const backToShelf = window.locator('button', { hasText: '返回书架' })
  if (await backToShelf.count()) {
    await backToShelf.first().click()
    await settle(800)
  }
  await shot('a2-shelf-again')

  await setViewport(720, 405)
  await shot('h-compact-shelf')
  await window.locator('.note-shelf-all').click()
  await settle(1000)
  await shot('i-compact-index')
  await window.locator('.note-index-trash').click()
  await settle(1000)
  await shot('j-compact-trash')
  await setViewport(1440, 810)

  if (errors.length) console.log(`--- errors ---\n${errors.slice(0, 10).join('\n')}`)
  console.log(`captured -> ${outRoot}`)
} catch (error) {
  console.error(error)
  if (errors.length) console.log(`--- errors ---\n${errors.slice(0, 10).join('\n')}`)
  process.exitCode = 1
}
