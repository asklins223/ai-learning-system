/*
 * Measures a rebuilt page against its approved mockup, box by box.
 *
 * Visual review of `.impeccable/review/desktop-pages-v3/effects/<NN>-*.png` can
 * only tell you that a page "looks right"; this script tells you the paper, the
 * guide line, the tickets and the deck landed on the exact pixels the mockup
 * put them on. It recomposes each `dump/<NN>.html` with the mockup's own
 * stylesheet at the reviewed 1440×810 canvas and diffs the result against the
 * live client attached over CDP.
 *
 * Usage:
 *   AILEARN_CAPTURE_CDP=http://127.0.0.1:9222 node scripts/compare-mockup-geometry.mjs --pages=14,15
 *
 * The client must be running with `--remoteDebuggingPort`; the script reloads the
 * window it attaches to so the measurement reflects the current source.
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review/desktop-pages-v3')
const VIEWPORT = { width: 1440, height: 810 }

const pages = (process.argv.find((arg) => arg.startsWith('--pages='))?.slice('--pages='.length) ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
if (!pages.length) throw new Error('--pages=14,15 is required')

const cdpEndpoint = process.env.AILEARN_CAPTURE_CDP ?? ''
if (!cdpEndpoint) throw new Error('AILEARN_CAPTURE_CDP must point at the running client, e.g. http://127.0.0.1:9222')

/** Which surface each page number is reached from, and how. */
const NAVIGATION = {
  14: { rail: '今日学习', note: 'the 今日学习 rail chip, which invokes the continue intent' },
  15: { rail: '复习', note: 'the rail chip' },
}

/**
 * The mockup names the boxes a reviewer needs to check. A page only has to
 * match the ones it actually renders; missing entries are reported as `null`.
 */
const SELECTORS = {
  14: {
    dayRoute: '.day-route',
    dayLine: '.day-line',
    ticket1: '.task-ticket:nth-of-type(1)',
    ticket2: '.task-ticket:nth-of-type(2)',
    ticket3: '.task-ticket:nth-of-type(3)',
    recordStrip: '.record-strip',
    content: '.content',
  },
  15: {
    queueDesk: '.queue-desk',
    cardDeck: '.card-deck',
    // 15 的卡叠现在是一叠真牌：稿面那两张手摆的装饰纸（back1/back2）已经不在了，
    // 压在下面的每一张都是队列里真实的卡，所以这里量最上面那张和它下面第一张。
    deckUnder: '.card-deck > .deck-card[data-depth="1"]',
    deckFront: '.deck-card.front',
    queueReason: '.queue-reason',
    content: '.content',
  },
}

/**
 * The dumps are pretty-printed HTML, so a decorative `<div class="day-line"/>`
 * parses as an *unclosed* div and swallows every following sibling — which moves
 * the tickets' containing block and fakes a 170px offset. Closing those tags
 * restores the markup the mockup's own runtime builds.
 */
const NON_VOID = 'div|section|article|aside|span|strong|small|b|i|p|h[1-6]|button|nav|main|header|footer'
const closeSelfClosing = (html) => html.replace(
  new RegExp(`<(${NON_VOID})\\b([^>]*?)\\/>`, 'g'),
  '<$1$2></$1>',
)

/** The mockup runs a 220ms entrance pop; the settled frame is what to compare. */
const SETTLE_STYLE = '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style>'

const measure = (page, selectors) => page.evaluate((list) => {
  const out = {}
  for (const [name, selector] of Object.entries(list)) {
    const element = document.querySelector(selector)
    if (!element) { out[name] = null; continue }
    const box = element.getBoundingClientRect()
    out[name] = [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]
  }
  return out
}, selectors)

const mockupStyle = [...(await readFile(resolve(reviewRoot, 'mockup.html'), 'utf8')).matchAll(/<style>([\s\S]*?)<\/style>/g)]
  .map((match) => match[1])
  .join('\n')

/**
 * Playwright downloads browsers per version, and the reviewed machine usually
 * carries a build from an earlier release. Reusing whichever Chromium is already
 * cached keeps the reference measurement off the network.
 */
async function resolveChromium() {
  if (process.env.AILEARN_CAPTURE_CHROMIUM) return process.env.AILEARN_CAPTURE_CHROMIUM
  const cacheRoot = process.platform === 'darwin'
    ? join(homedir(), 'Library/Caches/ms-playwright')
    : join(homedir(), '.cache/ms-playwright')
  let entries = []
  try {
    entries = await readdir(cacheRoot)
  } catch {
    return undefined
  }
  const builds = entries
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort((left, right) => Number(right.slice('chromium-'.length)) - Number(left.slice('chromium-'.length)))
  for (const build of builds) {
    const candidates = process.platform === 'darwin'
      ? [join(cacheRoot, build, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium')]
      : [join(cacheRoot, build, 'chrome-linux/chrome'), join(cacheRoot, build, 'chrome-linux64/chrome')]
    for (const candidate of candidates) {
      try {
        await readFile(candidate)
        return candidate
      } catch {
        // try the next layout
      }
    }
  }
  return undefined
}

const browser = await chromium.launch({ executablePath: await resolveChromium() })
const reference = {}
const referencePage = await browser.newPage({ viewport: VIEWPORT })
for (const id of pages) {
  const dump = await readFile(resolve(reviewRoot, `dump/${id}.html`), 'utf8')
  await referencePage.setContent(`<style>${mockupStyle}</style>${SETTLE_STYLE}${closeSelfClosing(dump)}`, { waitUntil: 'load' })
  await referencePage.waitForTimeout(150)
  reference[id] = await measure(referencePage, SELECTORS[id])
}
await referencePage.close()

const live = await chromium.connectOverCDP(cdpEndpoint)
const window = live.contexts()[0].pages()[0]
const failures = []
window.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
window.on('console', (message) => { if (message.type() === 'error') failures.push(`console: ${message.text()}`) })

const settle = (ms) => window.waitForTimeout(ms)
const clickNav = async (label) => {
  await window.waitForFunction(
    (target) => Boolean(document.querySelector(`.hud-rail .nav-chip[aria-label="${target}"]`)),
    label,
    { timeout: 8000 },
  )
  await window.evaluate((target) => {
    document.querySelector(`.hud-rail .nav-chip[aria-label="${target}"]`)?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
    )
  }, label)
  await settle(1200)
}

await window.reload()
await window.waitForLoadState('domcontentloaded')
await settle(1500)
const viewport = await window.evaluate(() => [window.innerWidth, window.innerHeight])
console.log(`live viewport ${JSON.stringify(viewport)}${viewport[0] === VIEWPORT.width && viewport[1] === VIEWPORT.height ? '' : ' (not the reviewed 1440x810 canvas)'}`)

for (const id of pages) {
  const navigation = NAVIGATION[id]
  if (!navigation) throw new Error(`page ${id} has no navigation recipe yet`)
  // A rail chip always re-invokes its own intent and lands on that surface, so
  // asserting it before every page is idempotent — and necessary: a `then` step
  // leaves the surface changed, so caching "which chip we already clicked" would
  // measure the next page on the previous page's surface.
  await clickNav(navigation.rail)
  if (navigation.then) {
    await window.keyboard.press(navigation.then)
    await settle(1400)
  }

  const page = await window.evaluate(() => document.querySelector('.desktop-app')?.getAttribute('data-hud-page') ?? null)
  const actual = await measure(window, SELECTORS[id])
  console.log(`\n===== page ${id} (reached via ${navigation.note}) =====`)
  console.log(`live data-hud-page = ${page}${page === id ? '' : '  ← MISMATCH'}`)
  if (page !== id) failures.push(`page ${id} opened as ${page}`)
  for (const name of Object.keys(SELECTORS[id])) {
    const expected = reference[id][name]
    const shown = actual[name]
    if (!expected && !shown) continue
    const delta = expected && shown ? expected.map((value, index) => value - shown[index]) : null
    const state = !expected || !shown ? 'only on one side' : delta.every((value) => value === 0) ? 'exact' : `Δ${JSON.stringify(delta)}`
    console.log(`  ${name.padEnd(12)} mockup=${JSON.stringify(expected)} live=${JSON.stringify(shown)} ${state}`)
    if (delta && Math.abs(delta[2]) > 2) failures.push(`page ${id} ${name} width differs by ${delta[2]}px`)
  }
}

if (failures.length) console.log(`\n--- ${failures.length} finding(s) ---\n${failures.join('\n')}`)
else console.log('\nno geometry or console findings')

await live.close()
await browser.close()
