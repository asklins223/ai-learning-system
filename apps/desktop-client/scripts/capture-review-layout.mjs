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

const reviewBackplates = {
  day: '/assets/learning-room/v1/posters/review-seat-day-v1.png',
  night: '/assets/learning-room/v1/posters/review-seat-night-v1.png',
}
const showFixtureLabel = process.env.REVIEW_LAYOUT_FIXTURE_LABEL !== '0'

const fixtureCases = [
  {
    key: 'twentyItemDesktopDay',
    fixtureId: 'review-v4-20-items',
    itemCount: 20,
    windowStart: 12,
    selectedIndex: 17,
    hasNextPage: true,
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 1,
    compact: false,
    output: 'layout-harness-review-v4-20-items-1440x810-day.png',
  },
  {
    key: 'eightItemMinimumNight',
    fixtureId: 'review-v4-8-items',
    itemCount: 8,
    windowStart: 0,
    selectedIndex: 5,
    hasNextPage: false,
    theme: 'night',
    width: 1024,
    height: 700,
    zoomFactor: 1,
    compact: false,
    output: 'layout-harness-review-v4-8-items-1024x700-night.png',
  },
  {
    key: 'oneItemCompactZoom200',
    fixtureId: 'review-v4-1-item',
    itemCount: 1,
    windowStart: 0,
    selectedIndex: 0,
    hasNextPage: false,
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-review-v4-1-item-zoom-200-compact.png',
  },
]

await mkdir(reviewRoot, { recursive: true })
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-review-layout-'))

const electronApp = await electron.launch({ args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`], cwd: appRoot, executablePath })

const setSize = async (width, height, zoomFactor = 1) => {
  await electronApp.evaluate(({ BrowserWindow }, dimensions) => {
    const target = BrowserWindow.getAllWindows()[0]
    target?.setMinimumSize(1, 1)
    target?.webContents.setZoomFactor(dimensions.zoomFactor)
    target?.setContentSize(dimensions.width, dimensions.height)
    target?.center()
  }, { width, height, zoomFactor })
}

const installFixture = async (window, fixtureCase) => {
  await window.evaluate((config) => {
    const pad = (value) => String(value).padStart(2, '0')
    const baseMinutes = 13 * 60 + 50
    const items = Array.from({ length: config.itemCount }, (_, index) => {
      const absoluteMinutes = baseMinutes + index * 50
      const day = 25 + Math.floor(absoluteMinutes / (24 * 60))
      const dayMinutes = absoluteMinutes % (24 * 60)
      const hour = Math.floor(dayMinutes / 60)
      const minute = dayMinutes % 60
      const ready = index % 3 !== 1
      const dueDate = `2026-08-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`
      return {
        index,
        ready,
        dueLabel: `8月${day}日 ${pad(hour)}:${pad(minute)}`,
        dueDate,
        dueFullLabel: new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(dueDate)),
        status: ready ? '可开始' : '冷却中',
      }
    })
    const visibleItems = items.slice(config.windowStart, config.windowStart + 6)
    const selectedItem = items[config.selectedIndex]
    const readyCount = items.filter((item) => item.ready).length
    const windowEnd = config.windowStart + visibleItems.length
    const hasPreviousWindow = config.windowStart > 0
    const hasNextWindow = windowEnd < items.length
    const rows = visibleItems.map((item) => {
      const selected = item.index === config.selectedIndex
      return `
        <li class="review-tape__item${item.ready ? ' review-tape__item--ready' : ''}">
          <button
            type="button"
            class="review-tape__row${selected ? ' review-tape__row--selected' : ''}"
            data-review-id="fixture-review-${item.index + 1}"
            aria-label="第 ${item.index + 1} 项，到期 ${item.dueLabel}，${item.status}"
            ${selected ? 'aria-current="true"' : ''}
            aria-expanded="${selected}"
            aria-controls="review-selected-detail"
          >
            <span class="review-tape__sequence">${item.index + 1}</span>
            <time datetime="${item.dueDate}">${item.dueLabel}</time>
            <span class="review-tape__status">${item.status}</span>
          </button>
        </li>
      `
    }).join('')

    const fixture = document.createElement('div')
    fixture.className = 'review-layout-fixture'
    fixture.dataset.theme = config.theme
    fixture.dataset.fixtureId = config.fixtureId
    fixture.dataset.fixtureItems = String(config.itemCount)
    fixture.innerHTML = `
      <img class="review-layout-fixture__room" src="${config.backplate}" alt="" aria-hidden="true">
      <main class="task-surface task-surface--review">
        <div class="surface-content task-surface__spatial-layer">
          <section class="review-object-surface review-workbench task-artifact review-workbench--ready" aria-labelledby="review-surface-title">
            <div class="review-reference-frame">
              <button class="surface-return-control review-scene__return" type="button" aria-label="关闭任务面并返回书房">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></svg>
                <span>返回书房</span>
              </button>

              <header class="review-scene__heading">
                <time datetime="2026-08-25T00:00:00+08:00">8月25日周二</time>
                <h2 id="review-surface-title">今日复习</h2>
                <p>${config.hasNextPage ? `已载入 ${config.itemCount} 项` : `${config.itemCount} 项待复习`} · ${readyCount} 项可开始</p>
                ${config.hasNextPage ? '<small>当前队列还有更多到期项</small>' : ''}
              </header>

              <section class="review-tape" aria-label="复习队列纸带">
                <header class="review-tape__header">
                  <span>${config.windowStart + 1}—${windowEnd} / 已载入 ${config.itemCount} 项</span>
                  <nav class="review-tape__navigation" aria-label="浏览复习队列">
                    <button type="button" aria-label="查看上一组复习项目" ${hasPreviousWindow ? '' : 'disabled'}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
                    </button>
                    <button type="button" aria-label="查看下一组复习项目" ${hasNextWindow ? '' : 'disabled'}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
                    </button>
                  </nav>
                </header>
                <div class="review-tape__window" data-window-start="${config.windowStart}">
                  <ol class="review-tape__list" data-testid="review-queue" aria-label="已载入的待复习项目">${rows}</ol>
                </div>
                <footer class="review-tape__footer">
                  ${hasNextWindow
                    ? '<span>选择箭头继续浏览</span>'
                    : config.hasNextPage
                      ? '<button type="button">继续读取到期项</button>'
                      : '<span>已到已载入队列末尾</span>'}
                </footer>
              </section>

                <article id="review-selected-detail" class="review-notebook" aria-labelledby="review-selected-heading">
                  <div class="review-notebook__page review-notebook__page--left">
                  <div class="review-notebook__ink review-notebook__ink--left">
                    <div class="review-notebook__semantic-copy">
                      <span class="review-notebook__sequence">第 ${selectedItem.index + 1} 项</span>
                      <h3 id="review-selected-heading">三分钟巩固</h3>
                      <p><span>开始后显示内容，先</span><span>完成独立回忆。</span></p>
                    </div>
                    <svg class="review-notebook__curved-copy" viewBox="0 0 220 134" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                      <defs>
                        <path id="review-left-sequence-path" d="M 72 50 C 116 49.2, 166 47.4, 212 45" />
                        <path id="review-left-title-path" d="M 72 79 C 116 78.2, 166 75.4, 212 73" />
                        <path id="review-left-body-one-path" d="M 72 99 C 116 98.2, 166 95.4, 212 93" />
                        <path id="review-left-body-two-path" d="M 72 117 C 116 116.2, 166 113.4, 212 111" />
                      </defs>
                      <text class="review-notebook__curved-sequence"><textPath href="#review-left-sequence-path">第 ${selectedItem.index + 1} 项</textPath></text>
                      <text class="review-notebook__curved-title"><textPath href="#review-left-title-path">三分钟巩固</textPath></text>
                      <text class="review-notebook__curved-body"><textPath href="#review-left-body-one-path">开始后显示内容，先</textPath></text>
                      <text class="review-notebook__curved-body"><textPath href="#review-left-body-two-path">完成独立回忆。</textPath></text>
                    </svg>
                  </div>
                  </div>
                  <div class="review-notebook__page review-notebook__page--right">
                  <div class="review-notebook__ink review-notebook__ink--right">
                    <time class="review-notebook__due" datetime="${selectedItem.dueDate}"><span>${selectedItem.dueFullLabel}</span><strong>${selectedItem.dueLabel.split(' ')[1]}</strong></time>
                    <p class="review-notebook__status review-notebook__status--ready">现在可以开始</p>
                    <div class="review-notebook__action"><button class="surface-primary" type="button">开始三分钟巩固 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></button></div>
                  </div>
                  </div>
                </article>
            </div>
          </section>
        </div>
      </main>
      ${config.showFixtureLabel ? '<p class="review-layout-fixture__label">LAYOUT FIXTURE · 非产品数据 · 非真实旅程证据</p>' : ''}
    `

    let style = document.querySelector('style[data-review-layout-fixture="v4"]')
    if (!(style instanceof HTMLStyleElement)) {
      style = document.createElement('style')
      style.dataset.reviewLayoutFixture = 'v4'
      style.textContent = `
        html, body, #root { width: 100%; height: 100%; margin: 0; }
        body { overflow: hidden; }
        .review-layout-fixture { position: relative; width: 100vw; height: 100vh; overflow: hidden; background: #261b14; }
        .review-layout-fixture__room { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .review-layout-fixture__label { position: fixed; z-index: 100; right: 10px; bottom: 8px; margin: 0; padding: 5px 8px; color: rgba(255,247,234,.8); font-size: 9px; letter-spacing: .03em; border: 1px solid rgba(255,247,234,.18); border-radius: 999px; background: rgba(35,25,19,.78); pointer-events: none; }
      `
      document.head.append(style)
    }

    const currentFixture = document.querySelector('.review-layout-fixture')
    if (currentFixture) currentFixture.replaceWith(fixture)
    else document.querySelector('#root')?.replaceWith(fixture)
  }, { ...fixtureCase, backplate: reviewBackplates[fixtureCase.theme], showFixtureLabel })

  await window.waitForFunction(() => {
    const image = document.querySelector('.review-layout-fixture__room')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  })
  await window.evaluate(async () => {
    if (!document.fonts) return
    await Promise.all([
      document.fonts.load('400 16px "Noto Sans SC Variable"'),
      document.fonts.load('400 16px "Noto Serif SC Variable"'),
      document.fonts.ready,
    ])
  })
}

const applyFixturePageProjection = async (window) => {
  await window.evaluate(() => {
    const page = document.querySelector('.review-notebook__page--left')
    if (!(page instanceof HTMLElement)) return
    if (matchMedia('(max-width: 900px), (max-height: 660px)').matches) {
      page.style.transform = 'none'
      page.style.transformOrigin = '0 0'
      return
    }
    const solve = (matrix, vector) => {
      const size = vector.length
      for (let pivotIndex = 0; pivotIndex < size; pivotIndex += 1) {
        let pivotRow = pivotIndex
        for (let row = pivotIndex + 1; row < size; row += 1) {
          if (Math.abs(matrix[row][pivotIndex]) > Math.abs(matrix[pivotRow][pivotIndex])) pivotRow = row
        }
        ;[matrix[pivotIndex], matrix[pivotRow]] = [matrix[pivotRow], matrix[pivotIndex]]
        ;[vector[pivotIndex], vector[pivotRow]] = [vector[pivotRow], vector[pivotIndex]]
        const pivot = matrix[pivotIndex][pivotIndex]
        if (Math.abs(pivot) < 1e-9) return []
        for (let column = pivotIndex; column < size; column += 1) matrix[pivotIndex][column] /= pivot
        vector[pivotIndex] /= pivot
        for (let row = 0; row < size; row += 1) {
          if (row === pivotIndex) continue
          const factor = matrix[row][pivotIndex]
          for (let column = pivotIndex; column < size; column += 1) matrix[row][column] -= factor * matrix[pivotIndex][column]
          vector[row] -= factor * vector[pivotIndex]
        }
      }
      return vector
    }
    const width = page.offsetWidth
    const height = page.offsetHeight
    const source = [[0, 0], [width, 0], [width, height], [0, height]]
  const destination = [[0, 0], [width, -height * 0.105], [width, height * 0.95], [0, height * 0.92]]
    const matrix = []
    const vector = []
    for (let index = 0; index < 4; index += 1) {
      const [x, y] = source[index]
      const [X, Y] = destination[index]
      matrix.push([x, y, 1, 0, 0, 0, -x * X, -y * X])
      vector.push(X)
      matrix.push([0, 0, 0, x, y, 1, -x * Y, -y * Y])
      vector.push(Y)
    }
    const values = [...solve(matrix, vector), 1]
    if (values.length !== 9 || values.some((value) => !Number.isFinite(value))) return
    const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = values
    page.style.transformOrigin = '0 0'
    page.style.transform = `matrix3d(${h11}, ${h21}, 0, ${h31}, ${h12}, ${h22}, 0, ${h32}, 0, 0, 1, 0, ${h13}, ${h23}, 0, ${h33})`
  })
}

const readLayout = (window) => window.evaluate(() => {
  const fixture = document.querySelector('.review-layout-fixture')
  const task = document.querySelector('.task-surface--review')
  const spatial = document.querySelector('.task-surface__spatial-layer')
  const referenceFrame = document.querySelector('.review-reference-frame')
  const queue = document.querySelector('[data-testid="review-queue"]')
  const tape = document.querySelector('.review-tape')
  const notebook = document.querySelector('.review-notebook')
  const notebookLeft = document.querySelector('.review-notebook__page--left')
  const notebookRight = document.querySelector('.review-notebook__page--right')
  const returnButton = document.querySelector('.review-scene__return')
  const startButton = document.querySelector('.review-notebook__action .surface-primary')
  const room = document.querySelector('.review-layout-fixture__room')
  const rect = (node) => node instanceof HTMLElement
    ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [key, node.getBoundingClientRect()[key]]))
    : null
  const returnRect = returnButton?.getBoundingClientRect()
  const returnHit = returnRect
    ? document.elementFromPoint(returnRect.left + returnRect.width / 2, returnRect.top + returnRect.height / 2)?.closest('button') === returnButton
    : false
  const visibleRows = [...document.querySelectorAll('.review-tape__row')].filter((node) => {
    if (!(node instanceof HTMLElement)) return false
    const style = getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
  })
  const internalVerticalScrollers = referenceFrame instanceof HTMLElement
    ? [referenceFrame, ...referenceFrame.querySelectorAll('*')].filter((node) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      return node.scrollHeight > node.clientHeight + 1 && ['auto', 'scroll'].includes(style.overflowY)
    }).map((node) => node.className)
    : []
  const retiredClasses = [...document.querySelectorAll('[class]')]
    .flatMap((node) => [...node.classList])
    .filter((className) => className.startsWith('review-ledger') || ['review-planner', 'review-index', 'review-planner__frame'].includes(className))
  const leftRect = notebookLeft?.getBoundingClientRect()
  const rightRect = notebookRight?.getBoundingClientRect()
  const notebookPagesSeparate = Boolean(leftRect && rightRect && (
    leftRect.right <= rightRect.left + 1
    || rightRect.right <= leftRect.left + 1
    || leftRect.bottom <= rightRect.top + 1
    || rightRect.bottom <= leftRect.top + 1
  ))
  const fontFamily = (selector) => {
    const node = document.querySelector(selector)
    return node ? getComputedStyle(node).fontFamily : null
  }
  const fontSize = (selector) => {
    const node = document.querySelector(selector)
    const value = node ? Number.parseFloat(getComputedStyle(node).fontSize) : NaN
    return Number.isFinite(value) ? value : null
  }
  const referenceText = referenceFrame instanceof HTMLElement ? referenceFrame.innerText : ''

  return {
    fixtureId: fixture instanceof HTMLElement ? fixture.dataset.fixtureId ?? null : null,
    fixtureItemCount: fixture instanceof HTMLElement ? Number(fixture.dataset.fixtureItems) : null,
    theme: fixture instanceof HTMLElement ? fixture.dataset.theme ?? null : null,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    task: task instanceof HTMLElement
      ? {
        clientHeight: task.clientHeight,
        scrollHeight: task.scrollHeight,
        clientWidth: task.clientWidth,
        scrollWidth: task.scrollWidth,
        overflowX: getComputedStyle(task).overflowX,
        overflowY: getComputedStyle(task).overflowY,
      }
      : null,
    spatialPanelContent: spatial ? getComputedStyle(spatial, '::before').content : null,
    referenceFrame: rect(referenceFrame),
    tape: rect(tape),
    queue: rect(queue),
    notebook: rect(notebook),
    notebookLeft: rect(notebookLeft),
    notebookRight: rect(notebookRight),
    notebookPageCount: document.querySelectorAll('.review-notebook__page').length,
    notebookPagesSeparate,
    startButton: rect(startButton),
    returnButton: { rect: rect(returnButton), hit: returnHit },
    queueCount: document.querySelectorAll('[data-testid="review-queue"]').length,
    renderedRowCount: visibleRows.length,
    renderedRowLabels: visibleRows.map((row) => row.getAttribute('aria-label')),
    internalVerticalScrollers,
    visibleTextContainsRawIdentity: /识别码|[0-9a-f]{8}-[0-9a-f-]{27}/i.test(referenceText),
    retiredClasses: [...new Set(retiredClasses)],
    retiredMediaCount: document.querySelectorAll('img[src*="review-card-tray"], img[src*="review-card-stand"]').length,
    fontStatus: document.fonts?.status ?? 'unavailable',
    fontFacesReady: {
      sans: document.fonts?.check('400 16px "Noto Sans SC Variable"') ?? false,
      serif: document.fonts?.check('400 16px "Noto Serif SC Variable"') ?? false,
    },
    fontFamilies: {
      sceneHeading: fontFamily('.review-scene__heading h2'),
      tapeRow: fontFamily('.review-tape__row'),
      notebookHeading: fontFamily('.review-notebook h3'),
      notebookBody: fontFamily('.review-notebook__page--left p'),
    },
    fontSizes: {
        notebookBody: fontSize('.review-notebook__page--left p'),
        notebookAction: fontSize('.review-notebook__action .surface-primary'),
      },
    backplate: room instanceof HTMLImageElement
      ? { source: room.getAttribute('src'), naturalWidth: room.naturalWidth, naturalHeight: room.naturalHeight }
      : null,
  }
})

const assertLayout = (layout, fixtureCase) => {
  const expectedRows = Math.min(6, fixtureCase.itemCount - fixtureCase.windowStart)
  const expectedBackplate = reviewBackplates[fixtureCase.theme]
  if (!layout.task || !layout.referenceFrame || !layout.tape || !layout.queue || !layout.notebook || !layout.startButton || layout.queueCount !== 1) {
    throw new Error(`Review V4 fixture is incomplete: ${JSON.stringify(layout)}`)
  }
  if (layout.fixtureId !== fixtureCase.fixtureId || layout.fixtureItemCount !== fixtureCase.itemCount || layout.theme !== fixtureCase.theme) {
    throw new Error(`Review V4 fixture metadata drifted: ${JSON.stringify(layout)}`)
  }
  if (layout.spatialPanelContent !== 'none') throw new Error(`Spatial layer paints a panel: ${JSON.stringify(layout)}`)
  if (!layout.returnButton.hit) throw new Error(`Return control is not hit-testable: ${JSON.stringify(layout)}`)
  if (layout.visibleTextContainsRawIdentity) throw new Error(`Fixture exposes a raw identity: ${JSON.stringify(layout)}`)
  if (layout.retiredClasses.length || layout.retiredMediaCount !== 0) throw new Error(`Fixture still mounts a retired tray, stand, or ledger: ${JSON.stringify(layout)}`)
  if (layout.renderedRowCount > 6 || layout.renderedRowCount !== expectedRows) throw new Error(`Review tape did not render the expected six-row window: ${JSON.stringify(layout)}`)
  if (layout.notebookPageCount !== 2 || !layout.notebookPagesSeparate) throw new Error(`Review notebook pages are not separate: ${JSON.stringify(layout)}`)
  if (layout.document.scrollWidth > layout.document.clientWidth + 1 || (layout.task.scrollWidth > layout.task.clientWidth + 1 && layout.task.overflowX !== 'hidden')) {
    throw new Error(`Review fixture has visible horizontal overflow: ${JSON.stringify(layout)}`)
  }
  if (layout.internalVerticalScrollers.length) throw new Error(`Review fixture created a nested vertical scroller: ${JSON.stringify(layout)}`)
  if (fixtureCase.compact && layout.task.overflowY !== 'auto') throw new Error(`Compact Review does not own the single scroll root: ${JSON.stringify(layout)}`)
  if (!fixtureCase.compact && (layout.startButton.top < 0 || layout.startButton.bottom > layout.viewport.height)) throw new Error(`Desktop primary action is clipped: ${JSON.stringify(layout)}`)
  if (layout.fontStatus !== 'loaded' || !layout.fontFacesReady.sans || !layout.fontFacesReady.serif || Object.values(layout.fontFamilies).some((family) => !family || !/Noto/i.test(family))) {
    throw new Error(`Review fixture did not resolve the bundled Noto font families: ${JSON.stringify(layout)}`)
  }
  if ((layout.fontSizes.notebookBody ?? 0) < 14 || (layout.fontSizes.notebookAction ?? 0) < 14) {
    throw new Error(`Review fixture dropped body or primary-action type below 14px: ${JSON.stringify(layout)}`)
  }
  if (!layout.backplate || layout.backplate.source !== expectedBackplate || layout.backplate.naturalWidth !== 1672 || layout.backplate.naturalHeight !== 941) {
    throw new Error(`Review fixture did not use the registered ${fixtureCase.theme} backplate: ${JSON.stringify(layout)}`)
  }
}

try {
  const window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const captures = {}
  const assertionFailures = []

  for (const fixtureCase of fixtureCases) {
    await setSize(fixtureCase.width, fixtureCase.height, fixtureCase.zoomFactor)
    await installFixture(window, fixtureCase)
    await applyFixturePageProjection(window)
    await window.waitForTimeout(250)
    const layout = await readLayout(window)
    const outputName = showFixtureLabel
      ? fixtureCase.output
      : fixtureCase.output.replace(/\.png$/, '-preview.png')
    const outputPath = resolve(reviewRoot, outputName)
    await window.screenshot({ path: outputPath })
    let assertion = { passed: true }
    try {
      assertLayout(layout, fixtureCase)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      assertion = { passed: false, message }
      assertionFailures.push({ fixtureId: fixtureCase.fixtureId, message })
    }
    captures[fixtureCase.key] = {
      fixture: {
        id: fixtureCase.fixtureId,
        itemCount: fixtureCase.itemCount,
        selectedIndex: fixtureCase.selectedIndex,
        windowStart: fixtureCase.windowStart,
        maximumVisibleRows: 6,
        hasNextPage: fixtureCase.hasNextPage,
        theme: fixtureCase.theme,
        requestedViewport: { width: fixtureCase.width, height: fixtureCase.height, zoomFactor: fixtureCase.zoomFactor },
      },
      output: outputPath,
      assertion,
      layout,
    }
  }

  const metadataPath = resolve(reviewRoot, 'layout-harness-review-v4.json')
  await writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: 2,
    evidenceClass: 'LAYOUT_FIXTURE_ONLY',
    visualLabel: showFixtureLabel ? 'evidence' : 'review-preview-without-label',
    productData: false,
    realJourneyEvidence: false,
    frozenClock: '2026-08-25T00:00:00+08:00',
    fixtureSizes: fixtureCases.map((fixtureCase) => fixtureCase.itemCount).sort((left, right) => left - right),
    maximumVisibleRows: 6,
    backplates: reviewBackplates,
    captures,
  }, null, 2)}\n`, 'utf8')
  console.log(`Captured Review V4 layout fixtures and metadata in ${reviewRoot}`)
  if (assertionFailures.length) {
    throw new Error(`Review V4 layout assertions failed: ${JSON.stringify(assertionFailures)}`)
  }
} finally {
  await electronApp.close()
}
