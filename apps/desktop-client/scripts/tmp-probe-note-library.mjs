/*
 * Temporary probe: confirm root causes seen in the audit screenshots.
 * Usage: AILEARN_CAPTURE_CDP=http://127.0.0.1:9222 node scripts/tmp-probe-note-library.mjs
 */
import { chromium } from '@playwright/test'
import './load-capture-env.mjs'

const endpoint = process.env.AILEARN_CAPTURE_CDP ?? 'http://127.0.0.1:9222'
const browser = await chromium.connectOverCDP(endpoint)
const window = browser.contexts()[0].pages()[0]
const cdp = await window.context().newCDPSession(window)
const settle = (ms = 700) => window.waitForTimeout(ms)
const setViewport = async (width, height) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
  await settle(400)
}

const read = (label) => window.evaluate((tag) => {
  const style = (selector, prop) => {
    const element = document.querySelector(selector)
    return element instanceof HTMLElement ? getComputedStyle(element)[prop] : null
  }
  const paper = document.querySelector('.note-index')
  const rows = paper instanceof HTMLElement ? getComputedStyle(paper).gridTemplateRows : null
  const list = paper?.querySelector('.source-list')
  return {
    tag,
    currentNoteBg: style('.current-note', 'backgroundImage').slice(0, 160),
    currentNoteBgColor: style('.current-note', 'backgroundColor'),
    notebookBg: style('.notebook', 'backgroundImage')?.slice(0, 160) ?? null,
    gridRows: rows,
    listHeight: list instanceof HTMLElement ? list.getBoundingClientRect().height : null,
    textActionSize: style('.text-action', 'fontSize'),
    rowTitleSize: style('.note-row strong', 'fontSize'),
    rowSmallSize: style('.note-row small', 'fontSize'),
    tabButtonSize: style('.index-tabs button', 'fontSize'),
  }
}, label)

try {
  await window.waitForFunction(() => Boolean(document.querySelector('.hud-rail')), undefined, { timeout: 30_000 })
  await window.locator('.hud-rail .nav-chip[aria-label="笔记"]').click()
  await settle(1000)

  console.log(JSON.stringify(await read('shelf@1440'), null, 1))
  await setViewport(720, 405)
  console.log(JSON.stringify(await read('shelf@720'), null, 1))
  await setViewport(1440, 810)

  await window.locator('.note-shelf-all').click()
  await settle(900)
  console.log(JSON.stringify(await read('index@1440'), null, 1))

  await window.locator('.note-index-trash').click()
  await settle(1000)
  console.log(JSON.stringify(await read('trash@1440'), null, 1))
  await setViewport(720, 405)
  console.log(JSON.stringify(await read('trash@720'), null, 1))
  await setViewport(1440, 810)
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
