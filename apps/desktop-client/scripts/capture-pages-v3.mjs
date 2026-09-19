import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron, chromium } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review/desktop-pages-v3/live')
await mkdir(reviewRoot, { recursive: true })

const only = (process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const should = (id) => only.length === 0 || only.includes(id)

const errors = []

/**
 * Attach to the client the owner is actually looking at.
 *
 * `electron-vite dev` exposes the running renderer over CDP; driving that window
 * is the only way a capture proves what the live client shows. Without this the
 * script launches a second, separately built copy whose profile, workspace and
 * reload state all differ from the window under review.
 */
const cdpEndpoint = process.env.AILEARN_CAPTURE_CDP ?? ''
const liveBrowser = cdpEndpoint ? await chromium.connectOverCDP(cdpEndpoint) : null
const attached = liveBrowser ? liveBrowser.contexts()[0].pages()[0] : null

const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-pages-v3-'))
// Chromium cannot initialize its own sandbox when the capture itself runs inside
// a restricted environment (CI containers, sandboxed agent shells). The flag is
// opt-in so an ordinary local run keeps Electron's sandbox in place.
const noSandbox = process.env.AILEARN_CAPTURE_NO_SANDBOX === '1' ? ['--no-sandbox'] : []
const electronApp = liveBrowser
  ? null
  : await electron.launch({
      args: ['.', ...noSandbox, '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
      cwd: appRoot,
      executablePath,
    })

const setSize = async (width, height) => {
  if (liveBrowser) return
  await electronApp.evaluate(({ BrowserWindow }, dimensions) => {
    const target = BrowserWindow.getAllWindows()[0]
    target?.setMinimumSize(1, 1)
    target?.setContentSize(dimensions.width, dimensions.height)
    target?.center()
  }, { width, height })
}

const settle = (window, ms = 900) => window.waitForTimeout(ms)
const roomReady = (window) => window.waitForFunction(
  () => Boolean(document.querySelector('.hud-rail')) || Boolean(document.querySelector('.home-v2-hud')),
  undefined,
  { timeout: 30_000 },
)

/**
 * Sign in and settle on a workspace.
 *
 * A first entry stops on page 04A's one-time paper instead of the old gate
 * list, so the choice is made through that paper: `onFirstSpace` runs while it
 * is still on screen (that is the only moment 04A exists), then the paper's own
 * primary button commits the space and the room reveals behind it.
 */
async function login(window, onFirstSpace) {
  await window.waitForFunction(
    () => Boolean(document.querySelector('.hud-rail'))
      || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')),
    undefined,
    { timeout: 30_000 },
  )
  const signedIn = await roomReady(window).then(() => true, () => false)
  if (!signedIn) {
    await window.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL)
    await window.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD)
    await window.getByRole('button', { name: '登录', exact: true }).click()
  }
  const deadline = Date.now() + 30_000
  let workspaceChosen = false
  const ready = async () => Boolean(await window.evaluate(
    () => document.querySelector('.hud-rail') || document.querySelector('.home-v2-hud'),
  ))
  while (Date.now() < deadline && !(await ready())) {
    const firstSpace = window.locator('.first-space')
    if (!workspaceChosen && await firstSpace.count()) {
      await settle(window, 1200)
      await onFirstSpace?.()
      await window.locator('.first-space .space-choice .button.primary').click()
      workspaceChosen = true
    }
    await window.waitForTimeout(250)
  }
  await roomReady(window)
  await settle(window, 1600)
}

async function dismissOnboarding(window) {
  const skip = window.getByRole('button', { name: '无声进入' })
  if (await skip.count() && await skip.isVisible()) {
    await skip.click()
    await settle(window, 1200)
  }
}

/** Element-dispatched click: the expanding control pill re-lays-out under the
 * cursor, which makes Playwright's hit-target retry double-toggle it. */
async function clickInPage(window, selector) {
  await window.evaluate((target) => {
    const element = document.querySelector(target)
    if (element instanceof HTMLElement) element.click()
  }, selector)
  await settle(window, 800)
}

async function clickNav(window, label) {
  await window.waitForFunction(
    (target) => Boolean(document.querySelector(`.hud-rail .nav-chip[aria-label="${target}"]`)),
    label,
    { timeout: 8_000 },
  )
  await window.evaluate((target) => {
    const button = document.querySelector(`.hud-rail .nav-chip[aria-label="${target}"]`)
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  }, label)
  await settle(window, 1200)
}

async function state(window) {
  return window.evaluate(() => {
    const app = document.querySelector('.desktop-app')
    const rect = (element) => {
      if (!(element instanceof HTMLElement)) return null
      const box = element.getBoundingClientRect()
      return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]
    }
    return {
      page: app?.getAttribute('data-hud-page') ?? null,
      classes: app?.className ?? '',
      rail: rect(document.querySelector('.hud-rail')),
      railChips: [...document.querySelectorAll('.hud-rail .nav-chip')].map((chip) => ({
        label: chip.getAttribute('aria-label'),
        active: chip.classList.contains('active'),
      })),
      control: rect(document.querySelector('.room-control')),
      controlExpanded: Boolean(document.querySelector('.room-control[data-expanded="true"]')),
      controlTrigger: rect(document.querySelector('.room-control-trigger')),
      controlButtons: [...document.querySelectorAll('.room-control > button:not(.room-control-trigger)')].map((button) => button.getAttribute('aria-label')),
      firstSpace: rect(document.querySelector('.first-space')),
      firstSpacePath: rect(document.querySelector('.first-space .space-path')),
      accountMenu: rect(document.querySelector('.room-control-menu .home-menu')),
      spaceRows: [...document.querySelectorAll('.room-control-menu .space-row')].map((row) => ({
        box: [Math.round(row.getBoundingClientRect().width), Math.round(row.getBoundingClientRect().height)],
        seal: rect(row.querySelector('.space-seal')),
        text: row.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      })),
      nextStep: rect(document.querySelector('.home-v2-hud')),
      nextStepText: document.querySelector('.home-v2-hud')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      companion: rect(document.querySelector('.companion-scene-anchor')),
      speech: document.querySelector('.companion-scene-anchor .speech')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      surface: document.querySelector('.task-surface')?.getAttribute('data-surface') ?? null,
      body: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      inner: [window.innerWidth, window.innerHeight],
    }
  })
}

async function shot(window, id, name, notes) {
  const snapshot = await state(window)
  await window.screenshot({ path: resolve(reviewRoot, `${id}-${name}.png`) })
  await writeFile(resolve(reviewRoot, `${id}-${name}.json`), `${JSON.stringify({ state: snapshot, notes }, null, 2)}\n`, 'utf8')
  console.log(`${id} ${name} page=${snapshot.page} surface=${snapshot.surface} control=${JSON.stringify(snapshot.controlButtons)} menu=${snapshot.accountMenu}`)
  return snapshot
}

try {
  const window = attached ?? (await electronApp.firstWindow())
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  window.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  await window.waitForLoadState('domcontentloaded')
  await setSize(1440, 810)

  if (liveBrowser) {
    // The window under review may still be running an older hot-reload graph, so
    // the capture reloads it first and proves the current source, not the last.
    await window.reload()
    await window.waitForLoadState('domcontentloaded')
    await settle(window, 1200)
  }

  if (!liveBrowser && should('02')) {
    await window.waitForSelector('.desktop-access-gate', { timeout: 20_000 })
    await settle(window)
    await shot(window, '02', 'login-desktop', 'gate first paint')
  }

  if (!liveBrowser) {
    await login(window, should('04')
      ? () => shot(window, '04', 'first-space', 'first entry: the one-time learning-space paper (04A)')
      : undefined)
    await dismissOnboarding(window)
  }

  if (should('01')) {
    // The island is collapsed to one seal by default; the six-slot pill is the
    // mockup's `controls()` and only exists while it is expanded.
    await shot(window, '01', 'home-collapsed', 'home, room control collapsed to its trigger seal')
    await clickInPage(window, '.room-control-trigger')
    await shot(window, '01', 'home-pill', 'home, the six-slot room control pill expanded from the seal')
    await window.keyboard.press('Escape')
    await settle(window, 700)
  }

  if (should('04')) {
    // 04B: expand the island first, then the space seal opens the mockup's
    // `.home-menu` card under the pill.
    await clickInPage(window, '.room-control-trigger')
    await clickInPage(window, '.room-control > button[aria-haspopup="true"]')
    await shot(window, '04', 'space-menu', 'returning user learning-space menu (04B)')
    await window.keyboard.press('Escape')
    await settle(window, 700)
  }

  if (should('05')) {
    await clickNav(window, '来源')
    await shot(window, '05', 'source-library', liveBrowser ? 'source library, live dev client' : 'source library via the directory rail')
  }

  if (should('06')) {
    if (!should('05')) await clickNav(window, '来源')
    await clickInPage(window, '.source-index .source-sheet')
    await shot(window, '06', 'source-detail', 'source detail opened from the first index row')
  }

  if (should('10')) {
    await clickNav(window, '理解')
    await window.locator('.v3-goal-workbench').waitFor({ state: 'visible' })
    await shot(window, '10', 'objective-library', 'understanding goals: next action and searchable objective ledger')
    if (!liveBrowser) {
      await setSize(720, 405)
      await settle(window, 700)
      await shot(window, '10', 'objective-library-compact', 'understanding goals at the 200% compact CSS viewport')
      await setSize(1440, 810)
      await settle(window, 700)
    }
  }

  if (should('11')) {
    if (!should('10')) await clickNav(window, '理解')
    await window.locator('.v3-goal-row').first().click()
    await window.locator('.v3-objective-workspace').waitFor({ state: 'visible' })
    await shot(window, '11', 'objective-detail', 'objective detail: claim, personal learning state and full public lineage')
    if (!liveBrowser) {
      await setSize(720, 405)
      await settle(window, 700)
      await shot(window, '11', 'objective-detail-compact', 'objective detail at the 200% compact CSS viewport')
      await setSize(1440, 810)
      await settle(window, 700)
    }
  }

  if (should('18')) {
    await clickNav(window, '查找')
    await shot(window, '18', 'search-idle', 'global search before a query is typed')
    await window.locator('.search-command input').fill('提取练习')
    await settle(window, 1600)
    await shot(window, '18', 'search', 'global search with a real result set and a preview')
    await clickInPage(window, '.search-command .hud-picker__trigger')
    await shot(window, '18', 'search-filter-open', 'the type filter as a drawn list on the paper')
    await window.keyboard.press('Escape')
    await settle(window, 500)
  }

  if (should('21')) {
    await clickNav(window, '设置')
    await shot(window, '21', 'settings', 'settings centre opened over the system plate')
    for (const [section, name] of [['成员与邀请', 'settings-members'], ['主题与动效', 'settings-appearance'], ['语音与伴星', 'settings-companion'], ['AI 数据同意', 'settings-data'], ['数据与维护', 'settings-management']]) {
      await window.locator('.settings-menu button', { hasText: section }).first().click()
      await settle(window, 700)
      await shot(window, '21', name, `settings centre, ${section} section`)
    }
  }

  if (should('15')) {
    await clickNav(window, '复习')
    await shot(window, '15', 'review', 'review deck: the leading card and the reason slip beside it')
  }

  if (should('14')) {
    // 14 carries its own rail chip (今日学习 → the "continue" intent). The room
    // shortcut (Meta+Enter) reaches the same surface from any open page, but the
    // chip is what the review set has to prove, so capture through it.
    await clickNav(window, '今日学习')
    await shot(window, '14', 'today', "today's route: up to three real stops and the study ledger")
  }

  if (should('20')) {
    await clickNav(window, '伴星')
    await window.locator('.memory-field').waitFor({ state: 'visible' })
    await settle(window, 900)
    await shot(window, '20', 'companion-center', 'companion centre: the record card and the memory star trail')

    // The sky is a control, not a picture. A state chip dims the stars the list
    // would drop, a family chip narrows the trail to one ring, and a star
    // selection fills the focus card that sits on the core.
    const skyChip = (selector) => window.evaluate((target) => {
      document.querySelector(target)?.click()
    }, selector)
    await skyChip('.memory-legend button.is-candidate')
    await settle(window, 500)
    await shot(window, '20', 'companion-sky-state', 'state chip pressed: the stars that do not match dim instead of vanishing')
    await skyChip('.memory-legend button.is-all')
    await settle(window, 400)
    await window.evaluate(() => document.querySelectorAll('.memory-bands button')[1]?.click())
    await settle(window, 500)
    await shot(window, '20', 'companion-sky-family', 'family chip pressed: one band of the trail stays lit, the count is on the chip')
    await window.evaluate(() => document.querySelectorAll('.memory-bands button')[0]?.click())
    await settle(window, 400)
    await window.evaluate(() => document.querySelectorAll('.star-node')[0]?.click())
    await settle(window, 700)
    await shot(window, '20', 'companion-star-focus', 'a star selected on the trail: focus card, legal actions and provenance lines')
    // Hovering another star shows the drawn tooltip; the selected star keeps
    // the focus card instead, so the two never stack.
    const hoveredStar = window.locator('.star-node').nth(1)
    if (await hoveredStar.count()) {
      await hoveredStar.hover()
      await settle(window, 450)
      await shot(window, '20', 'companion-star-hover', 'a star hovered: the drawn tooltip names content, state and kind')
      await window.mouse.move(8, 8)
      await settle(window, 300)
    }

    // 对话: the sort chip and an expanded turn.
    await window.evaluate(() => document.querySelectorAll('.memory-tabs button')[0]?.click())
    await settle(window, 600)
    await shot(window, '20', 'companion-dialogue', 'companion centre, dialogue records')
    await window.evaluate(() => document.querySelectorAll('.record-scroll .record-chips button')[1]?.click())
    await settle(window, 500)
    await window.evaluate(() => {
      const rows = [...document.querySelectorAll('.record-scroll button.diary-entry')]
      rows.find((row) => row.getAttribute('aria-expanded') !== null)?.click()
    })
    await settle(window, 600)
    await shot(window, '20', 'companion-dialogue-expanded', 'dialogue sorted oldest-first with one turn expanded')

    // 日记: the day strip is the only way to ask for a day the list does not hold.
    await window.evaluate(() => document.querySelectorAll('.memory-tabs button')[1]?.click())
    await settle(window, 600)
    await shot(window, '20', 'companion-diary', 'companion centre, diary records for the local day')
    await window.evaluate(() => document.querySelector('.diary-days button[aria-label="前一天"]')?.click())
    await settle(window, 700)
    await shot(window, '20', 'companion-diary-prev-day', 'diary stepped back one local calendar day')
    await window.evaluate(() => document.querySelector('.diary-days__reset')?.click())
    await settle(window, 600)

    // 记忆: the search box and the state chips share one predicate with the sky.
    await window.evaluate(() => document.querySelectorAll('.memory-tabs button')[2]?.click())
    await settle(window, 600)
    await shot(window, '20', 'companion-memory', 'companion centre, memory records')
    // The query is read off the leading row so the capture proves a real match,
    // not an empty result set that would look identical to a broken filter.
    const probe = await window.evaluate(() => {
      const row = document.querySelector('.record-scroll button[data-memory-id] small')
      return (row?.textContent ?? '').trim().slice(0, 2)
    })
    if (probe) {
      await window.locator('.record-scroll .record-search input').fill(probe)
      await settle(window, 700)
      await shot(window, '20', 'companion-memory-search', `memory list searched for “${probe}”: the sky dims to the same matches`)
      await window.locator('.record-scroll .record-search input').fill('')
      await settle(window, 500)
    }

    // 人格: the presets, the activeness chips and the reset confirmation. A
    // boundary switch writes the whole profile, so it is toggled back on the
    // same run — the capture never leaves the owner's archive edited.
    await window.evaluate(() => document.querySelectorAll('.memory-tabs button')[3]?.click())
    await settle(window, 600)
    await shot(window, '20', 'companion-persona', 'companion centre, persona records')
    const boundary = '.record-switches button'
    await window.evaluate((selector) => {
      document.querySelectorAll(selector)[0]?.click()
    }, boundary)
    await settle(window, 900)
    await shot(window, '20', 'companion-persona-boundary', 'a boundary switched: the profile is written straight through, with the saving state visible')
    await window.evaluate((selector) => {
      document.querySelectorAll(selector)[0]?.click()
    }, boundary)
    await settle(window, 900)
    // The reset control sits at the bottom of the scrollable record body; bring
    // it into the frame or the confirm state photographs as nothing at all.
    await window.evaluate(() => {
      document.getElementById('companion-record-body')?.scrollTo({ top: Number.MAX_SAFE_INTEGER })
    })
    await settle(window, 400)
    await window.evaluate(() => document.querySelector('.persona-reset button')?.click())
    await settle(window, 500)
    await shot(window, '20', 'companion-persona-reset', 'reset asks once before it can discard the archive')
    await window.evaluate(() => {
      const cancel = [...document.querySelectorAll('.persona-reset button')]
        .find((button) => button.textContent?.trim() === '取消')
      cancel?.click()
    })
    await settle(window, 400)

    await window.evaluate(() => document.querySelectorAll('.memory-tabs button')[0]?.click())
    await settle(window, 500)
    if (!liveBrowser) {
      await setSize(720, 405)
      await settle(window, 900)
      await shot(window, '20', 'companion-compact', 'companion centre at the 200% compact CSS viewport')
      await setSize(1440, 810)
      await settle(window, 900)
    }
  }

  if (errors.length) console.log(`\n--- console/page errors (${errors.length}) ---\n${errors.slice(0, 20).join('\n')}`)
  console.log(`capture complete -> ${reviewRoot}`)
} catch (error) {
  console.error(error)
  if (errors.length) console.error(`\n--- errors ---\n${errors.slice(0, 20).join('\n')}`)
  process.exitCode = 1
} finally {
  // An attached window belongs to whoever is running `electron-vite dev`, and
  // `close()` on a CDP connection closes *their* app. Attaching never owns the
  // window, so the run just drops the connection and lets the process exit.
  if (!liveBrowser) await electronApp.close()
}
