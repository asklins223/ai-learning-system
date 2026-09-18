/**
 * Page 15 「复习队列」 layout harness.
 *
 * Renders the shipped `.queue-desk` structure (what ReviewSurface actually
 * produces) inside the real Electron window, so the stylesheet under test is the
 * ported HUD stylesheet and the geometry measured here is what a reader gets.
 *
 * The defects this page actually had were geometric: the artboard sizes the deck
 * card 520×315 with no rule between 761px and 1234px, so at 125%/150% display
 * scaling the card hung out of its column and the reason slip — painted later —
 * buried the deck's own nav arrows. Every case is a documented acceptance
 * viewport and the assertions are the invariants that broke.
 *
 * Run: node scripts/capture-review-layout.mjs   (from apps/desktop-client, after a build)
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const showFixtureLabel = process.env.REVIEW_LAYOUT_FIXTURE_LABEL !== '0'

const fixtureCases = [
  {
    key: 'desktopDay',
    fixtureId: 'review-v5-1440x810-day',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 1,
    loaded: 20,
    total: 20,
    output: 'layout-harness-review-v5-1440x810-day.png',
  },
  {
    key: 'deepQueueDay',
    fixtureId: 'review-v5-deep-queue',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 1,
    loaded: 20,
    total: 128,
    selectedIndex: 2,
    output: 'layout-harness-review-v5-deep-queue-1440x810.png',
  },
  {
    key: 'minimumDay',
    fixtureId: 'review-v5-1280x720-day',
    theme: 'day',
    width: 1280,
    height: 720,
    zoomFactor: 1,
    loaded: 20,
    total: 128,
    output: 'layout-harness-review-v5-1280x720-day.png',
  },
  {
    key: 'zoom125Band',
    fixtureId: 'review-v5-zoom-125-band',
    theme: 'night',
    width: 1280,
    height: 720,
    zoomFactor: 1.25,
    loaded: 20,
    total: 128,
    output: 'layout-harness-review-v5-zoom-125-band.png',
  },
  {
    key: 'zoom150Band',
    fixtureId: 'review-v5-zoom-150-band',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 1.5,
    loaded: 20,
    total: 128,
    output: 'layout-harness-review-v5-zoom-150-band.png',
  },
  {
    key: 'zoom200Compact',
    fixtureId: 'review-v5-zoom-200-compact',
    theme: 'night',
    width: 1440,
    height: 810,
    zoomFactor: 2,
    loaded: 20,
    total: 128,
    output: 'layout-harness-review-v5-zoom-200-compact.png',
  },
  {
    key: 'blockedCard',
    fixtureId: 'review-v5-blocked-card',
    theme: 'day',
    width: 1280,
    height: 720,
    zoomFactor: 1,
    loaded: 20,
    total: 128,
    blocked: true,
    output: 'layout-harness-review-v5-blocked-1280x720.png',
  },
  {
    key: 'singleCard',
    fixtureId: 'review-v5-single-card',
    theme: 'day',
    width: 1280,
    height: 720,
    zoomFactor: 1,
    loaded: 1,
    total: 1,
    output: 'layout-harness-review-v5-single-1280x720.png',
  },
  {
    key: 'emptyState',
    fixtureId: 'review-v5-empty-state',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 1,
    loaded: 0,
    total: 0,
    boundaryTone: 'empty',
    output: 'layout-harness-review-v5-empty-1440x810.png',
  },
  {
    key: 'errorState',
    fixtureId: 'review-v5-error-state',
    theme: 'night',
    width: 1280,
    height: 720,
    zoomFactor: 1,
    loaded: 0,
    total: 0,
    boundaryTone: 'error',
    output: 'layout-harness-review-v5-error-1280x720.png',
  },
]

await mkdir(reviewRoot, { recursive: true })
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-review-layout-'))
const electronApp = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

const setSize = async (width, height, zoomFactor) => {
  await electronApp.evaluate(({ BrowserWindow }, dimensions) => {
    const target = BrowserWindow.getAllWindows()[0]
    target?.setMinimumSize(1, 1)
    target?.webContents.setZoomFactor(dimensions.zoomFactor)
    target?.setContentSize(dimensions.width, dimensions.height)
    target?.center()
  }, { width, height, zoomFactor })
  // 尺寸与缩放是异步生效的，而 fixture 里量"一步有多远"的脚本按当前布局算 ——
  // 不等它落定，量到的就是上一个用例的几何，截图和 JSON 会对不上。
  const window = await electronApp.firstWindow()
  const expected = { width: Math.round(width / zoomFactor), height: Math.round(height / zoomFactor) }
  await window.waitForFunction(
    (target) => Math.abs(window.innerWidth - target.width) <= 1 && Math.abs(window.innerHeight - target.height) <= 1,
    expected,
  )
  await window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
}

const installFixture = async (window, fixtureCase) => {
  await window.evaluate((config) => {
    const arrowIcon = (paths) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${paths}</svg>`
    const boundary = config.boundaryTone ?? null
    const cardTotal = Math.max(config.total, config.loaded)
    const selected = config.selectedIndex ?? 0
    const hasNext = config.loaded > 1
    const hasMore = config.total > config.loaded
    const stateChip = config.blocked ? '<span class="tag deck-card__state">冷却中</span>' : ''
    const startButton = config.blocked
      ? '<button type="button" class="button">刷新开始条件</button>'
      : '<button type="button" class="button primary">开始复习</button>'
    const boundaryCopy = boundary === 'error'
      ? { title: '无法读取真实复习队列', detail: '服务端暂时没有响应：复习队列请求在网络恢复前无法完成。' }
      : boundary === 'loading'
        ? { title: '正在读取复习队列', detail: '正在确认真实到期项与开始条件。' }
        : { title: '今天没有到期项', detail: '服务端没有返回可开始或待确认的到期复习。' }
    const boundaryMarkup = boundary
      ? `<div class="deck-card front" data-depth="0"><section class="pinboard surface-data-state surface-data-state--${boundary}" role="${boundary === 'error' ? 'alert' : 'status'}">
           <strong class="title">${boundaryCopy.title}</strong><p class="sub">${boundaryCopy.detail}</p>
           ${boundary === 'empty' ? '<div class="actions"><button type="button" class="button">回到今日学习</button><button type="button" class="button">继续写笔记</button></div>' : ''}
           ${boundary === 'error' ? '<button type="button" class="button primary">重新读取</button>' : ''}
         </section></div>`
      : ''

    // 牌堆窗口和 reviewWindowStart 同一条规则：前面留一张，后面留满。
    const windowSize = 6
    // 和 reviewWindowStart 同一条规则：前面只留一张，后面留满。
    const windowStart = config.loaded <= windowSize
      ? 0
      : Math.min(Math.max(0, selected - 1), config.loaded - windowSize)
    const seats = Array.from({ length: Math.min(config.loaded, windowSize) }, (_, index) => windowStart + index)
    const actionsMarkup = `
             ${startButton}
             <button type="button" class="button">查看来源</button>
             <button type="button" class="button">稍后提醒</button>`
    const navMarkup = hasNext || hasMore
      ? `<div class="deck-nav" role="group" aria-label="在到期项之间移动">
             <button type="button" class="deck-nav__step" aria-label="上一张到期项" ${selected > 0 ? '' : 'disabled'}>${arrowIcon('<path d="m15 18-6-6 6-6"/><path d="M9 12h10"/>')}</button>
             <button type="button" class="deck-nav__step" aria-label="下一张到期项">${arrowIcon('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>')}</button>
           </div>`
      : ''
    const pileCards = seats.map((seat) => {
      const isFront = seat === selected
      const depth = seat - selected
      return `<article class="deck-card${isFront ? ' front' : ''}" data-depth="${depth}"${depth < 0 ? ' data-drawn="true"' : ''}${isFront ? '' : ' aria-hidden="true"'}>
           <div class="deck-card__body">
             <div class="meta"><span>第 ${seat + 1} 张 / 共 ${cardTotal} 张</span><span>排期第 ${seat + 1} 轮</span>${isFront ? stateChip : ''}</div>
             <h2${isFront ? ' id="review-deck-question"' : ''}>${isFront ? '受激辐射与增益介质' : '相邻卡预览标题'}</h2>
             <p class="sub">来自笔记《光学原理笔记》</p>
           </div>
           ${isFront ? `<div class="actions">${actionsMarkup}</div>${navMarkup}` : ''}
         </article>`
    }).join('')
    const footMarkup = config.loaded > 0 && !boundary
      ? `<div class="deck-foot">
           <span class="deck-progress" aria-hidden="true">
             <span class="deck-progress__loaded" style="transform:scaleX(${Math.min(1, config.loaded / cardTotal)})"></span>
             <span class="deck-progress__bar" style="transform:scaleX(${(selected + 1) / cardTotal})"></span>
           </span>
           <span class="deck-foot__hint">把最上面那张拖走，或按 ← → 抽下一张</span>
         </div>`
      : ''
    const deck = boundary ? boundaryMarkup : `${pileCards}${footMarkup}`

    const slipRows = config.loaded > 0 && !boundary
      ? `<p>已超过 3 天 · 同一理解目标还有 1 张到期卡，所以它排在队首。</p>
         <div class="rule"></div>
         <p>到期：已超过 3 天<br />同一理解目标：2 张到期卡<br />已载入队列覆盖：3 个理解目标</p>
         <div class="rule"></div>
         <p class="small queue-reason__order">后续顺序：<button type="button">间隔效应</button> → <button type="button">认知负荷</button> → <button type="button">反馈设计</button></p>
         <p class="small">已载入 ${config.loaded} / ${cardTotal} 项</p>
         ${hasMore ? '<p class="small"><button type="button" class="queue-reason__more">继续读取更多到期项</button></p>' : ''}`
      : `<p>${boundary === 'error' ? '这一页没有读到真实的到期队列，因此不给理由。' : '今天没有到期项，理由条也随之留空。'}</p>`

    const fixture = document.createElement('div')
    fixture.className = 'review-layout-fixture'
    fixture.dataset.theme = config.theme
    fixture.dataset.fixtureId = config.fixtureId
    fixture.dataset.fixtureItems = String(config.loaded)
    fixture.dataset.fixtureState = boundary ?? 'ready'
    fixture.innerHTML = `
      <div class="desktop-app hud-surface page-15${config.theme === 'night' ? ' night' : ''} comp-left" data-theme="${config.theme}" data-surface-open="true" data-motion-mode="off">
        <img class="room-backplate room-backplate--review-${config.theme}" src="/assets/approved-v3/environments/review-${config.theme}-v1.png" alt="" aria-hidden="true" />
        <div class="task-surface task-surface--review task-surface--spatial" data-surface="review" data-motion-mode="off" data-scene-phase="task" tabindex="-1">
          <div class="surface-content task-surface__spatial-layer">
            <div class="task-title"><h1>复习队列</h1><p>到期顺序像一叠待复习卡，下一张始终清楚</p></div>
            <main class="content">
              <div class="queue-desk">
                <section class="card-deck" role="group" aria-label="复习队列卡叠" tabindex="0">
                  <p class="sr-only" role="status"></p>
                  ${deck}
                </section>
                <aside class="queue-reason" aria-label="这张卡为什么排在最前">
                  <span class="tag${boundary ? '' : ' red'}">${boundary === 'error' ? '读取失败' : boundary ? '队列' : '排在最前'}</span>
                  <h3>为什么现在复习它</h3>
                  ${slipRows}
                </aside>
              </div>
            </main>
          </div>
        </div>
      </div>
      ${config.showFixtureLabel ? '<p class="review-layout-fixture__label">LAYOUT FIXTURE · 非产品数据 · 非真实旅程证据</p>' : ''}
    `

    let style = document.querySelector('style[data-review-layout-fixture="v5"]')
    if (!(style instanceof HTMLStyleElement)) {
      style = document.createElement('style')
      style.dataset.reviewLayoutFixture = 'v5'
      style.textContent = `
        html, body, #root { width: 100%; height: 100%; margin: 0; }
        body { overflow: hidden; }
        .review-layout-fixture { position: relative; width: 100vw; height: 100vh; overflow: hidden; background: #261b14; }
        .review-layout-fixture .desktop-app { position: absolute; inset: 0; }
        .review-layout-fixture .room-backplate { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .review-layout-fixture__label { position: fixed; z-index: 100; right: 10px; bottom: 8px; margin: 0; padding: 5px 8px; color: rgba(255,247,234,.8); font-size: 9px; letter-spacing: .03em; border: 1px solid rgba(255,247,234,.18); border-radius: 999px; background: rgba(35,25,19,.78); pointer-events: none; }
      `
      document.head.append(style)
    }

    const currentFixture = document.querySelector('.review-layout-fixture')
    if (currentFixture) currentFixture.replaceWith(fixture)
    else document.querySelector('#root')?.replaceWith(fixture)
  }, { ...fixtureCase, showFixtureLabel })

  await window.waitForFunction(() => [...document.querySelectorAll('.review-layout-fixture img')].every((image) => (
    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  )))
  await window.evaluate(async () => {
    if (!document.fonts) return
    await Promise.all([
      document.fonts.load('400 16px "Noto Sans SC Variable"'),
      document.fonts.load('400 16px "Noto Serif SC Variable"'),
      document.fonts.ready,
    ])
  })
  // 卡叠的焦点环：发版代码只在"键盘焦点落下"或"应用把焦点交还卡叠"时打开
  // （data-deck-ring），指针碰过就撤。夹具是静态结构，所以这里复现两个状态：
  // 先用鼠标点一下卡面（读者的真实动作），再打开那一位。
  const deckCentre = await window.evaluate(() => {
    const deck = document.querySelector('.card-deck')
    if (!(deck instanceof HTMLElement)) return null
    const box = deck.getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
  })
  if (deckCentre) {
    await window.mouse.click(deckCentre.x, deckCentre.y)
    await window.evaluate(() => {
      const deck = document.querySelector('.card-deck')
      const fixture = document.querySelector('.review-layout-fixture')
      if (!(deck instanceof HTMLElement) || !(fixture instanceof HTMLElement)) return
      const read = () => {
        const style = getComputedStyle(deck)
        return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor }
      }
      // 指针碰过之后：卡叠可能拿着焦点，但没有任何"交还焦点"的标记。
      deck.focus()
      fixture.dataset.deckFocusPointer = JSON.stringify(read())
      // 应用把焦点交还给卡叠的那一刻（走到队尾、从今日学习带目标回来）。
      deck.dataset.deckRing = 'true'
      deck.focus()
      fixture.dataset.deckFocusRing = JSON.stringify(read())
      delete deck.dataset.deckRing
    })
  }
}

const measure = async (window) => window.evaluate(() => {
  const rectOf = (element) => {
    if (!(element instanceof HTMLElement)) return null
    const box = element.getBoundingClientRect()
    return {
      left: Number(box.left.toFixed(2)),
      top: Number(box.top.toFixed(2)),
      right: Number(box.right.toFixed(2)),
      bottom: Number(box.bottom.toFixed(2)),
      width: Number(box.width.toFixed(2)),
      height: Number(box.height.toFixed(2)),
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
    }
  }
  const hitTest = (element) => {
    if (!(element instanceof HTMLElement)) return null
    const box = element.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return false
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return Boolean(hit && element.contains(hit))
  }
  const card = document.querySelector('.deck-card.front')
  const navButtons = [...document.querySelectorAll('.deck-nav__step')]
  const actionButtons = [...document.querySelectorAll('.deck-card.front .actions .button')]
  const slip = document.querySelector('.queue-reason')
  const slipControls = [...document.querySelectorAll('.queue-reason__more, .queue-reason__order button')]
  const pileCards = [...document.querySelectorAll('.card-deck > .deck-card')]
  const progressBar = document.querySelector('.deck-progress__bar')
  const progressLoaded = document.querySelector('.deck-progress__loaded')
  const desk = document.querySelector('.queue-desk')
  const task = document.querySelector('.task-surface')
  return {
    fixtureId: document.querySelector('.review-layout-fixture')?.getAttribute('data-fixture-id') ?? null,
    theme: document.querySelector('.review-layout-fixture')?.getAttribute('data-theme') ?? null,
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    desk: rectOf(desk),
    deck: rectOf(document.querySelector('.card-deck')),
    card: rectOf(card),
    slip: rectOf(slip),
    progress: rectOf(document.querySelector('.deck-progress')),
    progressBar: rectOf(progressBar),
    progressLoaded: rectOf(progressLoaded),
    pile: pileCards.filter((element) => element.hasAttribute('data-depth')).map((element) => ({
      depth: Number(element.getAttribute('data-depth')),
      drawn: element.getAttribute('data-drawn'),
      front: element.classList.contains('front'),
      hidden: element.getAttribute('aria-hidden'),
      opacity: Number(getComputedStyle(element).opacity),
      hit: hitTest(element),
      rect: rectOf(element),
    })),
    nav: navButtons.map((button) => ({ label: button.getAttribute('aria-label'), disabled: button.hasAttribute('disabled'), hit: hitTest(button), rect: rectOf(button) })),
    actions: actionButtons.map((button) => ({ label: (button.textContent ?? '').trim(), hit: hitTest(button), rect: rectOf(button) })),
    slipControls: slipControls.map((element) => ({ tag: element.tagName.toLowerCase(), hit: hitTest(element), rect: rectOf(element) })),
    deckFocus: (() => {
      const fixture = document.querySelector('.review-layout-fixture')
      if (!(fixture instanceof HTMLElement)) return null
      const parse = (value) => {
        try {
          return value ? JSON.parse(value) : null
        } catch {
          return null
        }
      }
      return {
        pointer: parse(fixture.dataset.deckFocusPointer ?? null),
        ring: parse(fixture.dataset.deckFocusRing ?? null),
      }
    })(),
    deskOverflow: desk instanceof HTMLElement ? desk.scrollWidth > desk.clientWidth + 4 : null,
    taskOverflow: task instanceof HTMLElement
      ? { overflowX: getComputedStyle(task).overflowX, scrollWidth: task.scrollWidth, clientWidth: task.clientWidth }
      : null,
  }
})

const overlaps = (a, b) => Boolean(
  a && b && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1,
)

const assertLayout = (layout, fixtureCase) => {
  if (!layout.deck || !layout.card || !layout.slip) {
    throw new Error(`Review fixture is incomplete: ${JSON.stringify(layout)}`)
  }
  if (layout.fixtureId !== fixtureCase.fixtureId || layout.theme !== fixtureCase.theme) {
    throw new Error(`Review fixture metadata drifted: ${JSON.stringify(layout)}`)
  }
  if (layout.document.scrollWidth > layout.document.clientWidth + 1) {
    throw new Error(`Review fixture scrolls the document horizontally: ${JSON.stringify(layout.document)}`)
  }
  // 理由条带 0.5° 的稿面旋转（mockup 的纸感），它的包围盒比布局盒宽约 2px，
  // 所以这里留 4px 容差，只抓真正的溢出。
  if (layout.deskOverflow && layout.desk.scrollWidth > layout.desk.clientWidth + 4) {
    throw new Error(`Review desk overflows its own box: ${JSON.stringify(layout.desk)}`)
  }
  if (layout.taskOverflow && layout.taskOverflow.overflowX !== 'hidden' && layout.taskOverflow.scrollWidth > layout.taskOverflow.clientWidth + 1) {
    throw new Error(`Review fixture scrolls the task surface horizontally: ${JSON.stringify(layout.taskOverflow)}`)
  }
  // 原缺陷：520px 的卡片在 761–1234px 之间横跨卡槽，右侧被理由条压住。
  if (layout.card.left < layout.deck.left - 1 || layout.card.right > layout.deck.right + 1) {
    throw new Error(`Review deck card left its own column: ${JSON.stringify({ card: layout.card, deck: layout.deck })}`)
  }
  if (overlaps(layout.card, layout.slip)) {
    throw new Error(`Review deck card is painted under the reason slip: ${JSON.stringify({ card: layout.card, slip: layout.slip })}`)
  }
  // 牌堆：最上面那张落在卡槽正中，下面的牌一张比一张更靠上、左右交错地压着 ——
  // 这是"一叠手放的纸"，不是一行并排的卡。
  const pile = layout.pile ?? []
  const top = pile.find((entry) => entry.depth === 0)
  const deckCentre = (layout.deck.left + layout.deck.right) / 2
  const topCentre = top ? (top.rect.left + top.rect.right) / 2 : null
  if (top && Math.abs(topCentre - deckCentre) > 2) {
    throw new Error(`Review pile top card is not centred in its column: ${JSON.stringify({ topCentre, deckCentre })}`)
  }
  if (top && (top.rect.left < layout.deck.left - 1 || top.rect.right > layout.deck.right + 1)) {
    throw new Error(`Review pile top card overflowed the deck column: ${JSON.stringify({ top: top.rect, deck: layout.deck })}`)
  }
  const stack = pile.filter((entry) => entry.depth > 0).sort((left, right) => left.depth - right.depth)
  if (top && stack.length > 0) {
    let previousTop = (top.rect.top + top.rect.bottom) / 2
    let previousCentre = topCentre
    let alternated = false
    for (const entry of stack) {
      const entryCentre = (entry.rect.top + entry.rect.bottom) / 2
      if (entryCentre >= previousTop - 4) {
        throw new Error(`Review pile card at depth ${entry.depth} is not stacked above the one before it: ${JSON.stringify({ entry: entry.rect, previousCentre: previousTop })}`)
      }
      if (!(entry.rect.left < top.rect.right && entry.rect.right > top.rect.left)) {
        throw new Error(`Review pile card at depth ${entry.depth} is not overlapping the top card: ${JSON.stringify({ entry: entry.rect, top: top.rect })}`)
      }
      const centre = (entry.rect.left + entry.rect.right) / 2
      if (previousCentre !== null && Math.sign(centre - previousCentre) !== Math.sign(previousCentre - topCentre || 1)) alternated = true
      previousTop = entryCentre
      previousCentre = centre
    }
    // 交错才算"不规则"：每一张都比上一张往另一边偏。
    if (stack.length > 1 && !alternated) {
      throw new Error(`Review pile is a neat stack, not an irregular one: ${JSON.stringify(stack.map((entry) => entry.rect.left))}`)
    }
  }
  for (const entry of pile) {
    if (entry.front && entry.hidden === 'true') {
      throw new Error(`Review pile top card is hidden from assistive technology: ${JSON.stringify(entry)}`)
    }
    if (!entry.front && entry.drawn && entry.opacity > 0.02) {
      throw new Error(`Review drawn card is still visible: ${JSON.stringify(entry)}`)
    }
    if (entry.drawn && entry.hit === true) {
      throw new Error(`Review drawn card still takes pointer input: ${JSON.stringify(entry)}`)
    }
    if (!entry.drawn && !entry.front && entry.hidden !== 'true') {
      throw new Error(`Review pile card under the top one is exposed to assistive technology: ${JSON.stringify(entry)}`)
    }
  }
  // 位置进度条：深色条按"整条队列"给比例，不是按已载入那一页。
  if (!fixtureCase.boundaryTone && pile.length > 0 && !layout.progress) {
    throw new Error('Review deck is missing its position progress bar')
  }
  if (layout.progress && layout.progressBar && layout.progressBar.width <= 0) {
    throw new Error(`Review deck progress bar has no width: ${JSON.stringify(layout.progressBar)}`)
  }
  if (layout.progress && layout.progressLoaded && layout.progressBar
    && layout.progressLoaded.width + 1 < layout.progressBar.width) {
    throw new Error(`Review deck progress bar is shorter than what has been loaded: ${JSON.stringify({ bar: layout.progressBar, loaded: layout.progressLoaded })}`)
  }
  // 鼠标点过卡面不该留下焦点环（读者会以为出错），而交还焦点时必须有可见的环。
  const focus = layout.deckFocus
  if (focus?.pointer && focus.pointer.style !== 'none' && Number.parseFloat(focus.pointer.width) > 0) {
    throw new Error(`Review deck paints a focus ring after a pointer click: ${JSON.stringify(focus.pointer)}`)
  }
  if (focus?.ring && (focus.ring.style !== 'solid' || Number.parseFloat(focus.ring.width) < 2.5)) {
    throw new Error(`Review deck has no visible focus ring when focus is handed back: ${JSON.stringify(focus.ring)}`)
  }
  if (layout.slip.width < 120) {
    throw new Error(`Review reason slip collapsed: ${JSON.stringify(layout.slip)}`)
  }
  for (const control of layout.slipControls) {
    if (control.hit !== true) {
      throw new Error(`Review slip control <${control.tag}> is not hit-testable: ${JSON.stringify(control)}`)
    }
    if (control.rect.right > layout.slip.right + 1 || control.rect.left < layout.slip.left - 1) {
      throw new Error(`Review slip control <${control.tag}> left the slip: ${JSON.stringify({ control: control.rect, slip: layout.slip })}`)
    }
  }
}

/**
 * 缩放到 125%/150%/200% 时，Playwright 的 window.screenshot() 只截到渲染面的
 * 左上角一块（图的尺寸按未缩放的内容算，像素却是按缩放后的密度画的），证据图和
 * 同一轮的 JSON 几何对不上。capturePage() 拿到的才是整块可见渲染面。
 */
const captureViewport = async (window, path) => {
  // 缩放不为 100% 时合成器会慢一拍：先让它把这一帧画完，否则截到的是"居中还
  // 没生效"的那一版画面，和同一轮的 JSON 对不上。
  await window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
  await window.waitForTimeout(120)
  const base64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0]
    if (!target) return null
    const image = await target.webContents.capturePage()
    return image.isEmpty() ? null : image.toPNG().toString('base64')
  })
  if (base64) await writeFile(path, Buffer.from(base64, 'base64'))
  else await window.screenshot({ path })
}

const failures = []
const measurements = []
try {
  for (const fixtureCase of fixtureCases) {
    await setSize(fixtureCase.width, fixtureCase.height, fixtureCase.zoomFactor)
    const window = await electronApp.firstWindow()
    await installFixture(window, fixtureCase)
    const layout = await measure(window)
    await captureViewport(window, resolve(reviewRoot, fixtureCase.output))
    measurements.push({ case: fixtureCase.key, output: fixtureCase.output, ...layout })
    try {
      assertLayout(layout, fixtureCase)
    } catch (error) {
      failures.push({ fixtureId: fixtureCase.fixtureId, message: error.message })
    }
  }

  await writeFile(
    resolve(reviewRoot, 'layout-harness-review-v5.json'),
    `${JSON.stringify({
      // 这份证据只证明布局几何，不是真实旅程证据（见 docs/design/
      // frontend-quality-gates-and-visual-regression-plan.md 的 Review Gate 要求）。
      evidenceClass: 'LAYOUT_FIXTURE_ONLY',
      productData: false,
      realJourneyEvidence: false,
      generatedAt: new Date().toISOString(),
      cases: measurements,
    }, null, 2)}\n`,
    'utf8',
  )
  console.log(`Captured ${fixtureCases.length} 复习队列 layout cases in ${reviewRoot}`)
  if (failures.length > 0) {
    throw new Error(`Review layout assertions failed: ${JSON.stringify(failures, null, 2)}`)
  }
} finally {
  await electronApp.close()
}
