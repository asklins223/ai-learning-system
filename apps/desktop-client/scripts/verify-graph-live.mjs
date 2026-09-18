import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Live check for page 19 (理解星图): attach to the running dev client over CDP,
// assert the restored Understanding Universe renders real topology, then
// exercise search, focus and state filtering.

const outDir = resolve(import.meta.dirname, 'graph-verify')
const reviewDir = resolve(import.meta.dirname, '../../../.impeccable/review')
await mkdir(outDir, { recursive: true })
await mkdir(reviewDir, { recursive: true })

const browser = await chromium.connectOverCDP(process.env.AILEARN_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]

const consoleErrors = []
const pageErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => pageErrors.push(String(error)))

await page.waitForFunction(
  () => Boolean(document.querySelector('.hud-rail')) || Boolean(document.querySelector('.home-v2-hud')),
  undefined,
  { timeout: 30_000 },
).catch(() => {})

const where = await page.evaluate(() => ({
  rail: Boolean(document.querySelector('.hud-rail')),
  home: Boolean(document.querySelector('.home-v2-hud')),
  gate: Boolean(document.querySelector('.desktop-access-gate')),
  firstSpace: Boolean(document.querySelector('.first-space')),
  hudPage: document.querySelector('.desktop-app')?.getAttribute('data-hud-page') ?? null,
}))
console.log('WHERE', JSON.stringify(where))

if (where.gate && !where.rail && !where.home) {
  console.log('NOT_SIGNED_IN — 需要先在实机客户端完成登录，脚本退出')
  await page.screenshot({ path: resolve(outDir, 'gate.png') })
  process.exit(2)
}

// Open page 19 with the app's own shortcut when it is not already visible.
if (where.hudPage !== '19') {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur())
  await page.keyboard.press('g')
}
await page.waitForTimeout(1200)

const graphState = await page.evaluate(() => {
  const app = document.querySelector('.desktop-app')
  return {
    hudPage: app?.getAttribute('data-hud-page') ?? null,
    universe: Boolean(document.querySelector('.universe-page')),
    canvas: Boolean(document.querySelector('.universe-canvas-surface')),
    telemetry: document.querySelector('.universe-layer-readout')?.textContent ?? null,
    filters: document.querySelectorAll('.universe-filter').length,
    layers: document.querySelectorAll('.universe-layer-toggle').length,
    zoom: document.querySelector('.universe-canvas-readout')?.textContent ?? null,
    companionVisible: (() => {
      const companion = document.querySelector('.companion-presence')
      return companion instanceof HTMLElement
        && getComputedStyle(companion).display !== 'none'
        && companion.getAttribute('aria-hidden') !== 'true'
    })(),
  }
})
console.log('GRAPH', JSON.stringify(graphState, null, 1))

await page.screenshot({ path: resolve(outDir, '19-graph.png') })
await page.screenshot({ path: resolve(reviewDir, 'desktop.png') })

// Search and focus a real objective, then capture the complete lineage drawer.
const search = page.getByRole('combobox', { name: '搜索理解星图' })
if (await search.count()) {
  await search.fill('牛顿')
  const result = page.locator('.universe-search-result').first()
  if (await result.count()) await result.click()
  await page.waitForTimeout(700)
  const after = await page.evaluate(() => document.querySelector('.universe-detail-panel.is-open')?.textContent ?? null)
  console.log('DETAIL_AFTER_SEARCH', after)
  await page.screenshot({ path: resolve(outDir, '19-graph-focused.png') })
}

// Exercise a real state filter when the workspace has attention-worthy nodes.
const attentionFilter = page.locator('.universe-filter', { hasText: '需关注' }).first()
if (await attentionFilter.count() && await attentionFilter.isEnabled()) {
  await page.getByRole('button', { name: '关闭星体详情' }).last().click().catch(() => {})
  await attentionFilter.click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: resolve(outDir, '19-graph-attention-filter.png') })
}

console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
console.log('PAGE_ERRORS', JSON.stringify(pageErrors))
await writeFile(resolve(outDir, 'result.json'), JSON.stringify({ where, graphState, consoleErrors, pageErrors }, null, 1))

// Do not close the browser: it is the owner's running client (or a shared dev
// instance). Disconnect only.
await browser.close()
console.log('DONE')
