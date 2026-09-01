import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review')
const reviewSurfaceRegistry = JSON.parse(await readFile(
  resolve(appRoot, 'src/renderer/src/scene/review-surfaces.json'),
  'utf8',
))
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

const reviewBackplates = {
  day: '/assets/learning-room/v1/posters/review-seat-day-v1.png',
  night: '/assets/learning-room/v1/posters/review-seat-night-v1.png',
}
const showFixtureLabel = process.env.REVIEW_LAYOUT_FIXTURE_LABEL !== '0'
const reviewPartialFailures = {
  pagination: { message: '继续读取失败，已载入项目仍然保留。', action: '重试读取' },
  queue: { message: '队列刷新失败，当前项目仍然保留。', action: '重新读取' },
  start: { message: '开始结果未确认；再次开始会复用同一请求。', action: null },
}

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
  {
    key: 'blockedItemCompactZoom200',
    fixtureId: 'review-v4-blocked-item',
    itemCount: 8,
    windowStart: 0,
    selectedIndex: 1,
    hasNextPage: false,
    blocked: true,
    theme: 'night',
    width: 1440,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-review-v4-blocked-item-zoom-200-compact.png',
  },
  {
    key: 'paginationFailureNarrowCompactZoom200',
    fixtureId: 'review-v4-pagination-failure-narrow',
    itemCount: 8,
    windowStart: 0,
    selectedIndex: 0,
    hasNextPage: true,
    partialFailure: 'pagination',
    theme: 'night',
    width: 1120,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-review-v4-pagination-failure-narrow-zoom-200-compact.png',
  },
  {
    key: 'paginationFailureEndWindowCompactZoom200',
    fixtureId: 'review-v4-pagination-failure-end-window',
    itemCount: 8,
    windowStart: 6,
    selectedIndex: 6,
    hasNextPage: true,
    partialFailure: 'pagination',
    footerAction: 'continue',
    navigationState: { previous: true, next: false },
    theme: 'night',
    width: 1120,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-review-v4-pagination-failure-end-window-zoom-200-compact.png',
  },
  {
    key: 'multiWindowCompactZoom200',
    fixtureId: 'review-v4-multi-window-compact',
    itemCount: 20,
    windowStart: 6,
    selectedIndex: 11,
    hasNextPage: false,
    navigationState: { previous: true, next: true },
    navigationReachability: 'entry',
    theme: 'day',
    width: 1120,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-review-v4-multi-window-zoom-200-compact.png',
  },
  {
    key: 'queueRefreshFailureDesktopDay',
    fixtureId: 'review-v4-queue-refresh-failure',
    itemCount: 8,
    windowStart: 0,
    selectedIndex: 0,
    hasNextPage: false,
    partialFailure: 'queue',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 1,
    compact: false,
    output: 'layout-harness-review-v4-queue-refresh-failure-1440x810-day.png',
  },
  {
    key: 'startFailureCompactZoom200',
    fixtureId: 'review-v4-start-failure',
    itemCount: 8,
    windowStart: 0,
    selectedIndex: 0,
    hasNextPage: false,
    partialFailure: 'start',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-review-v4-start-failure-zoom-200-compact.png',
  },
  {
    key: 'emptyDesktopDay',
    fixtureId: 'review-v4-empty-state',
    itemCount: 0,
    windowStart: 0,
    selectedIndex: -1,
    hasNextPage: false,
    boundaryTone: 'empty',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 1,
    compact: false,
    output: 'layout-harness-review-v4-empty-1440x810-day.png',
  },
  {
    key: 'errorCompactZoom200',
    fixtureId: 'review-v4-error-state',
    itemCount: 0,
    windowStart: 0,
    selectedIndex: -1,
    hasNextPage: false,
    boundaryTone: 'error',
    theme: 'night',
    width: 1440,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-review-v4-error-zoom-200-compact.png',
  },
  {
    key: 'loadingCompactZoom200',
    fixtureId: 'review-v4-loading-state',
    itemCount: 0,
    windowStart: 0,
    selectedIndex: -1,
    hasNextPage: false,
    boundaryTone: 'loading',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-review-v4-loading-zoom-200-compact.png',
  },
  {
    key: 'errorNarrowCompactZoom200',
    fixtureId: 'review-v4-error-state-narrow',
    itemCount: 0,
    windowStart: 0,
    selectedIndex: -1,
    hasNextPage: false,
    boundaryTone: 'error',
    theme: 'night',
    width: 1120,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-review-v4-error-narrow-zoom-200-compact.png',
  },
  {
    key: 'readyExtremeNarrowCompactZoom200',
    fixtureId: 'review-v4-ready-320-css-px',
    itemCount: 8,
    windowStart: 0,
    selectedIndex: 0,
    hasNextPage: false,
    theme: 'night',
    width: 640,
    height: 810,
    zoomFactor: 2,
    compact: true,
    cssViewportWidth: 320,
    avoidStickyOverlap: true,
    output: 'layout-harness-review-v4-ready-320-css-px-zoom-200.png',
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
    const percentage = (value) => `${Number((value * 100).toFixed(6))}%`
    const sceneRectStyle = (rect, container) => [
      `--scene-rect-left:${percentage((rect.x - container.x) / container.width)}`,
      `--scene-rect-top:${percentage((rect.y - container.y) / container.height)}`,
      `--scene-rect-width:${percentage(rect.width / container.width)}`,
      `--scene-rect-height:${percentage(rect.height / container.height)}`,
    ].join(';')
    const surfaceStyle = (surface, container) => [
      sceneRectStyle(surface.sourceRect, container),
      `--scene-surface-clip:polygon(${surface.clipPolygon.map(([x, y]) => `${percentage(x)} ${percentage(y)}`).join(', ')})`,
    ].join(';')
    const worldBounds = {
      x: 0,
      y: 0,
      width: config.surfaceRegistry.coordinateSpace.width,
      height: config.surfaceRegistry.coordinateSpace.height,
    }
    const tapeStyle = sceneRectStyle(config.surfaceRegistry.tapeBounds, worldBounds)
    const notebookStyle = sceneRectStyle(config.surfaceRegistry.notebookBounds, worldBounds)
    const tapeHeaderSurface = config.surfaceRegistry.surfaces.tapeHeader
    const tapeBodySurface = config.surfaceRegistry.surfaces.tapeBody
    const tapeFooterSurface = config.surfaceRegistry.surfaces.tapeFooter
    const leftSurface = config.surfaceRegistry.surfaces.notebookLeft
    const rightSurface = config.surfaceRegistry.surfaces.notebookRight
    const referenceStyle = `--scene-world-aspect:${worldBounds.width / worldBounds.height}`
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
    const selectedReady = selectedItem?.ready ?? false
    const selectedTitle = selectedReady ? '三分钟巩固' : '这项还不能开始'
    const selectedStatus = selectedReady ? '现在可以开始' : '仍在冷却期'
    const selectedAction = selectedReady
      ? '<button class="surface-primary" type="button">开始三分钟巩固 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></button>'
      : '<button class="review-notebook__refresh" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 4v5h5"/></svg>刷新开始条件</button>'
    const partialFailure = config.partialFailure
      ? {
          pagination: { message: '继续读取失败，已载入项目仍然保留。', action: '重试读取' },
          queue: { message: '队列刷新失败，当前项目仍然保留。', action: '重新读取' },
          start: { message: '开始结果未确认；再次开始会复用同一请求。', action: null },
        }[config.partialFailure]
      : null
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

    const boundaryTone = config.boundaryTone ?? null
    const boundaryCopy = boundaryTone === 'loading'
      ? { heading: '正在读取复习队列…', message: '正在确认真实到期项与开始条件。' }
      : boundaryTone === 'error'
        ? { heading: '无法读取真实复习队列', message: '服务端暂时没有响应：复习队列请求在网络恢复前无法完成，请检查连接后重试。' }
        : { heading: '今天没有到期项', message: '服务端没有返回可开始或待确认的到期复习。' }
    const queueSummary = boundaryTone === 'loading'
      ? '正在确认队列'
      : boundaryTone === 'error'
        ? '队列暂不可用'
        : boundaryTone === 'empty'
          ? '0 项待复习 · 0 项可开始'
          : config.hasNextPage
            ? `已载入 ${config.itemCount} 项 · ${readyCount} 项可开始`
            : `${config.itemCount} 项待复习 · ${readyCount} 项可开始`
    const boundaryMarkup = boundaryTone ? `
              <div class="review-scene__boundary">
                <div class="review-scene-state review-scene-state--${boundaryTone}" role="${boundaryTone === 'error' ? 'alert' : 'status'}">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></svg>
                  <div>
                    <h3>${boundaryCopy.heading}</h3>
                    <p>${boundaryCopy.message}</p>
                  </div>
                  ${boundaryTone === 'error' ? '<button type="button" class="surface-primary">重新读取队列</button>' : ''}
                  ${boundaryTone === 'loading' ? '<div class="review-scene-state__lines" aria-hidden="true"><span></span><span></span><span></span></div>' : ''}
                </div>
              </div>
    ` : ''
    const partialFailureMarkup = partialFailure ? `
          <div class="review-scene__partial-error" data-failure-source="${config.partialFailure}" role="alert">
            <span>${partialFailure.message}</span>
            ${partialFailure.action ? `<button type="button">${partialFailure.action}</button>` : ''}
          </div>
    ` : ''

    const fixture = document.createElement('div')
    fixture.className = 'review-layout-fixture'
    fixture.dataset.theme = config.theme
    fixture.dataset.fixtureId = config.fixtureId
    fixture.dataset.fixtureItems = String(config.itemCount)
    fixture.dataset.fixtureState = boundaryTone ?? 'ready'
    fixture.dataset.fixtureAction = config.blocked ? 'blocked' : 'ready'
    fixture.dataset.fixtureFailure = config.partialFailure ?? 'none'
    fixture.innerHTML = `
      <img class="review-layout-fixture__room" src="${config.backplate}" alt="" aria-hidden="true">
      <main class="task-surface task-surface--review">
        <div class="surface-content task-surface__spatial-layer">
          <section class="review-object-surface review-workbench task-artifact review-workbench--${boundaryTone ?? 'ready'}" aria-labelledby="review-surface-title">
            <div
              class="scene-reference-frame review-reference-frame"
              data-scene-coordinate-space="${config.surfaceRegistry.coordinateSpace.id}"
              data-scene-fit="${config.surfaceRegistry.coordinateSpace.fitMode}"
              style="${referenceStyle}"
            >
              <button class="surface-return-control review-scene__return" type="button" aria-label="关闭任务面并返回书房">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></svg>
                <span>返回书房</span>
              </button>

              <header class="review-scene__heading">
                <time datetime="2026-08-25T00:00:00+08:00">8月25日周二</time>
                <h2 id="review-surface-title">今日复习</h2>
                <p>${queueSummary}</p>
                ${config.hasNextPage ? '<small>当前队列还有更多到期项</small>' : ''}
                ${partialFailureMarkup}
              </header>

              ${boundaryMarkup}
              ${boundaryTone ? '' : `
              <section class="review-tape" style="${tapeStyle}" aria-label="复习队列纸带">
                <div
                  class="review-tape__surface review-tape__surface--header"
                  data-scene-surface="${tapeHeaderSurface.id}"
                  style="${surfaceStyle(tapeHeaderSurface, config.surfaceRegistry.tapeBounds)}"
                >
                  <div class="review-tape__plane">
                    <header class="review-tape__header review-tape__ink">
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
                    <span class="review-tape__material review-tape__material--header" aria-hidden="true"></span>
                  </div>
                </div>
                <div
                  class="review-tape__surface review-tape__surface--body"
                  data-scene-surface="${tapeBodySurface.id}"
                  style="${surfaceStyle(tapeBodySurface, config.surfaceRegistry.tapeBounds)}"
                >
                  <div class="review-tape__plane">
                    <div class="review-tape__window review-tape__ink" data-window-start="${config.windowStart}">
                      <ol class="review-tape__list" data-testid="review-queue" aria-label="已载入的待复习项目">${rows}</ol>
                    </div>
                    <span class="review-tape__material review-tape__material--body" aria-hidden="true"></span>
                  </div>
                </div>
                <div
                  class="review-tape__surface review-tape__surface--footer"
                  data-scene-surface="${tapeFooterSurface.id}"
                  style="${surfaceStyle(tapeFooterSurface, config.surfaceRegistry.tapeBounds)}"
                >
                  <div class="review-tape__plane">
                    <footer class="review-tape__footer review-tape__ink">
                      ${hasNextWindow
                        ? '<span>选择箭头继续浏览</span>'
                        : config.hasNextPage
                          ? '<button type="button">继续读取到期项</button>'
                          : '<span>已到已载入队列末尾</span>'}
                    </footer>
                    <span class="review-tape__material review-tape__material--footer" aria-hidden="true"></span>
                  </div>
                </div>
              </section>

                <article id="review-selected-detail" class="review-notebook" style="${notebookStyle}" aria-labelledby="review-selected-heading">
                  <div
                    class="review-notebook__surface review-notebook__surface--left"
                    data-scene-surface="${leftSurface.id}"
                    style="${surfaceStyle(leftSurface, config.surfaceRegistry.notebookBounds)}"
                  >
                    <div class="review-notebook__page review-notebook__page--left">
                      <div class="review-notebook__ink review-notebook__ink--left">
                        <div class="review-notebook__semantic-copy">
                          <span class="review-notebook__sequence">第 ${selectedItem.index + 1} 项</span>
                          <h3 id="review-selected-heading">${selectedTitle}</h3>
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
                          <text class="review-notebook__curved-title"><textPath href="#review-left-title-path">${selectedTitle}</textPath></text>
                          <text class="review-notebook__curved-body"><textPath href="#review-left-body-one-path">开始后显示内容，先</textPath></text>
                          <text class="review-notebook__curved-body"><textPath href="#review-left-body-two-path">完成独立回忆。</textPath></text>
                        </svg>
                      </div>
                      <span class="review-notebook__material review-notebook__material--left" aria-hidden="true"></span>
                    </div>
                  </div>
                  <div
                    class="review-notebook__surface review-notebook__surface--right"
                    data-scene-surface="${rightSurface.id}"
                    style="${surfaceStyle(rightSurface, config.surfaceRegistry.notebookBounds)}"
                  >
                    <div class="review-notebook__page review-notebook__page--right">
                      <div class="review-notebook__ink review-notebook__ink--right">
                        <time class="review-notebook__due" datetime="${selectedItem.dueDate}"><span>${selectedItem.dueFullLabel}</span><strong>${selectedItem.dueLabel.split(' ')[1]}</strong></time>
                        <p class="review-notebook__status${selectedReady ? ' review-notebook__status--ready' : ''}">${selectedStatus}</p>
                        <div class="review-notebook__action">${selectedAction}</div>
                      </div>
                      <span class="review-notebook__material review-notebook__material--right" aria-hidden="true"></span>
                    </div>
                  </div>
                  <span class="review-notebook__spine" aria-hidden="true"></span>
                </article>
              `}
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
  }, {
    ...fixtureCase,
    backplate: reviewBackplates[fixtureCase.theme],
    showFixtureLabel,
    surfaceRegistry: reviewSurfaceRegistry,
  })

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

const applyFixtureSurfaceProjection = async (window) => {
  await window.evaluate((registry) => {
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

    const compact = matchMedia(registry.compactMediaQuery).matches
    for (const surface of Object.values(registry.surfaces)) {
      const projection = document.querySelector(`[data-scene-surface="${surface.id}"]`)
      if (!(projection instanceof HTMLElement)) continue
      if (compact) {
        projection.style.setProperty('--scene-surface-projection', 'none')
        projection.dataset.sceneSurfaceProjection = 'flat'
        continue
      }

      const width = projection.offsetWidth
      const height = projection.offsetHeight
      const source = [[0, 0], [width, 0], [width, height], [0, height]]
      const destination = surface.quad.map(([x, y]) => [
        ((x - surface.sourceRect.x) / surface.sourceRect.width) * width,
        ((y - surface.sourceRect.y) / surface.sourceRect.height) * height,
      ])
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
      if (values.length !== 9 || values.some((value) => !Number.isFinite(value))) {
        projection.style.setProperty('--scene-surface-projection', 'none')
        projection.dataset.sceneSurfaceProjection = 'invalid'
        continue
      }
      const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = values
      projection.style.setProperty(
        '--scene-surface-projection',
        `matrix3d(${h11}, ${h21}, 0, ${h31}, ${h12}, ${h22}, 0, ${h32}, 0, 0, 1, 0, ${h13}, ${h23}, 0, ${h33})`,
      )
      projection.dataset.sceneSurfaceProjection = 'projected'
    }
  }, reviewSurfaceRegistry)
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
  const registeredSurfaces = [...document.querySelectorAll('[data-scene-surface]')]
  const returnButton = document.querySelector('.review-scene__return')
  const returnLabel = returnButton?.querySelector('span')
  const heading = document.querySelector('.review-scene__heading')
  const partialError = document.querySelector('.review-scene__partial-error')
  const partialErrorCopy = partialError?.querySelector('span')
  const partialErrorButton = partialError?.querySelector('button')
  const footerActionButton = document.querySelector('.review-tape__footer button')
  const navigation = document.querySelector('.review-tape__navigation')
  const previousWindowButton = navigation?.querySelector('button:first-of-type')
  const nextWindowButton = navigation?.querySelector('button:last-of-type')
  const boundary = document.querySelector('.review-scene__boundary')
  const boundaryState = document.querySelector('.review-scene-state')
  const boundaryHeading = boundaryState?.querySelector('h3')
  const boundaryMessage = boundaryState?.querySelector('p')
  const boundaryCopy = boundaryState?.querySelector(':scope > div')
  const loadingLines = document.querySelector('.review-scene-state__lines')
  const retryButton = document.querySelector('.review-scene-state--error .surface-primary')
  const notebookHeading = document.querySelector('.review-notebook__semantic-copy h3')
  const notebookStatus = document.querySelector('.review-notebook__status')
  const startButton = document.querySelector('.review-notebook__action .surface-primary')
  const refreshButton = document.querySelector('.review-notebook__action .review-notebook__refresh')
  const room = document.querySelector('.review-layout-fixture__room')
  const rect = (node) => node instanceof HTMLElement
    ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [key, node.getBoundingClientRect()[key]]))
    : null
  const hit = (node) => {
    const nodeRect = node?.getBoundingClientRect()
    if (!(node instanceof HTMLElement) || !nodeRect) return false
    return document.elementFromPoint(nodeRect.left + nodeRect.width / 2, nodeRect.top + nodeRect.height / 2)?.closest('button') === node
  }
  const returnHit = hit(returnButton)
  const startHit = hit(startButton)
  const refreshHit = hit(refreshButton)
  const footerActionHit = hit(footerActionButton)
  const navigationButton = (node) => ({
    rect: rect(node),
    hit: hit(node),
    disabled: node instanceof HTMLButtonElement ? node.disabled : null,
    label: node instanceof HTMLElement ? node.getAttribute('aria-label') : null,
  })
  const boundaryStateElement = boundaryState instanceof HTMLElement ? boundaryState : null
  const boundaryCopyElement = boundaryCopy instanceof HTMLElement ? boundaryCopy : null
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
    fixtureState: fixture instanceof HTMLElement ? fixture.dataset.fixtureState ?? null : null,
    fixtureAction: fixture instanceof HTMLElement ? fixture.dataset.fixtureAction ?? null : null,
    fixtureFailure: fixture instanceof HTMLElement ? fixture.dataset.fixtureFailure ?? null : null,
    theme: fixture instanceof HTMLElement ? fixture.dataset.theme ?? null : null,
    coordinateSpace: referenceFrame instanceof HTMLElement ? referenceFrame.dataset.sceneCoordinateSpace ?? null : null,
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
    heading: rect(heading),
    partialError: {
      rect: rect(partialError),
      source: partialError instanceof HTMLElement ? partialError.dataset.failureSource ?? null : null,
      text: partialErrorCopy instanceof HTMLElement ? partialErrorCopy.textContent?.trim() ?? null : null,
      button: {
        rect: rect(partialErrorButton),
        hit: hit(partialErrorButton),
        text: partialErrorButton instanceof HTMLElement ? partialErrorButton.textContent?.trim() ?? null : null,
      },
    },
    boundary: rect(boundary),
    boundaryState: {
      rect: rect(boundaryState),
      role: boundaryState instanceof HTMLElement ? boundaryState.getAttribute('role') : null,
      heading: rect(boundaryHeading),
      message: rect(boundaryMessage),
      copy: rect(boundaryCopy),
      clientWidth: boundaryStateElement?.clientWidth ?? null,
      scrollWidth: boundaryStateElement?.scrollWidth ?? null,
      overflowX: boundaryStateElement ? getComputedStyle(boundaryStateElement).overflowX : null,
      copyClientWidth: boundaryCopyElement?.clientWidth ?? null,
      copyScrollWidth: boundaryCopyElement?.scrollWidth ?? null,
      lines: rect(loadingLines),
      lineCount: loadingLines?.querySelectorAll('span').length ?? 0,
    },
    tape: rect(tape),
    footerAction: {
      rect: rect(footerActionButton),
      hit: footerActionHit,
      text: footerActionButton instanceof HTMLElement ? footerActionButton.textContent?.trim() ?? null : null,
    },
    navigation: {
      rect: rect(navigation),
      previous: navigationButton(previousWindowButton),
      next: navigationButton(nextWindowButton),
    },
    queue: rect(queue),
    notebook: rect(notebook),
    notebookLeft: rect(notebookLeft),
    notebookRight: rect(notebookRight),
    notebookPageCount: document.querySelectorAll('.review-notebook__page').length,
    notebookPagesSeparate,
    notebookHeading: notebookHeading instanceof HTMLElement ? notebookHeading.textContent?.trim() ?? null : null,
    notebookHeadingRect: rect(notebookHeading),
    notebookStatus: notebookStatus instanceof HTMLElement ? notebookStatus.textContent?.trim() ?? null : null,
    surfaceProjections: registeredSurfaces.map((node) => node instanceof HTMLElement
      ? {
        id: node.dataset.sceneSurface ?? null,
        state: node.dataset.sceneSurfaceProjection ?? null,
        transform: getComputedStyle(node).transform,
      }
      : null),
    startButton: rect(startButton),
    startButtonHit: startHit,
    refreshButton: {
      rect: rect(refreshButton),
      hit: refreshHit,
    },
    retryButton: {
      rect: rect(retryButton),
      hit: hit(retryButton),
    },
    returnButton: {
      rect: rect(returnButton),
      hit: returnHit,
      position: returnButton instanceof HTMLElement ? getComputedStyle(returnButton).position : null,
      labelDisplay: returnLabel instanceof HTMLElement ? getComputedStyle(returnLabel).display : null,
    },
    scrollTop: task instanceof HTMLElement ? task.scrollTop : null,
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
      boundaryHeading: fontFamily('.review-scene-state h3'),
      boundaryBody: fontFamily('.review-scene-state p'),
    },
    fontSizes: {
      notebookBody: fontSize('.review-notebook__page--left p'),
      notebookAction: fontSize('.review-notebook__action .surface-primary, .review-notebook__action .review-notebook__refresh'),
      boundaryBody: fontSize('.review-scene-state p'),
    },
    backplate: room instanceof HTMLImageElement
      ? { source: room.getAttribute('src'), naturalWidth: room.naturalWidth, naturalHeight: room.naturalHeight }
      : null,
  }
})

const rectsOverlap = (left, right) => Boolean(left && right && !(
  left.right <= right.left + 1
  || right.right <= left.left + 1
  || left.bottom <= right.top + 1
  || right.bottom <= left.top + 1
))

const rectContains = (outer, inner) => Boolean(outer && inner && (
  inner.left >= outer.left - 1
  && inner.top >= outer.top - 1
  && inner.right <= outer.right + 1
  && inner.bottom <= outer.bottom + 1
))

const rectWithinViewport = (rect, viewport) => Boolean(rect && viewport && (
  rect.left >= -1
  && rect.top >= -1
  && rect.right <= viewport.width + 1
  && rect.bottom <= viewport.height + 1
))

const assertLayout = (layout, fixtureCase) => {
  const boundaryFixture = Boolean(fixtureCase.boundaryTone)
  const blockedFixture = Boolean(fixtureCase.blocked)
  const partialFailure = fixtureCase.partialFailure ?? null
  const expectedRows = Math.min(6, fixtureCase.itemCount - fixtureCase.windowStart)
  const expectedBackplate = reviewBackplates[fixtureCase.theme]
  const expectedSurfaceIds = Object.values(reviewSurfaceRegistry.surfaces).map((surface) => surface.id).sort()
  if (!layout.task || !layout.referenceFrame || !layout.returnButton?.rect) {
    throw new Error(`Review V4 fixture is incomplete: ${JSON.stringify(layout)}`)
  }
  if (
    layout.fixtureId !== fixtureCase.fixtureId
    || layout.fixtureItemCount !== fixtureCase.itemCount
    || layout.fixtureState !== (fixtureCase.boundaryTone ?? 'ready')
    || layout.fixtureAction !== (fixtureCase.blocked ? 'blocked' : 'ready')
    || layout.fixtureFailure !== (partialFailure ?? 'none')
    || layout.theme !== fixtureCase.theme
  ) {
    throw new Error(`Review V4 fixture metadata drifted: ${JSON.stringify(layout)}`)
  }
  if (fixtureCase.cssViewportWidth && Math.abs((layout.viewport?.width ?? 0) - fixtureCase.cssViewportWidth) > 1) {
    throw new Error(`Review fixture did not capture the requested CSS viewport width: ${JSON.stringify(layout)}`)
  }
  if (layout.coordinateSpace !== reviewSurfaceRegistry.coordinateSpace.id) {
    throw new Error(`Review fixture left the canonical scene coordinate space: ${JSON.stringify(layout)}`)
  }
  if (layout.spatialPanelContent !== 'none') throw new Error(`Spatial layer paints a panel: ${JSON.stringify(layout)}`)
  if (!layout.returnButton.hit) throw new Error(`Return control is not hit-testable: ${JSON.stringify(layout)}`)
  if (layout.visibleTextContainsRawIdentity) throw new Error(`Fixture exposes a raw identity: ${JSON.stringify(layout)}`)
  if (layout.retiredClasses.length || layout.retiredMediaCount !== 0) throw new Error(`Fixture still mounts a retired tray, stand, or ledger: ${JSON.stringify(layout)}`)

  if (boundaryFixture) {
    if (!layout.boundary || !layout.boundaryState?.rect || layout.queueCount !== 0 || layout.renderedRowCount !== 0) {
      throw new Error(`Review boundary fixture mounted ready-state content: ${JSON.stringify(layout)}`)
    }
    if (layout.notebookPageCount !== 0 || layout.tape || layout.footerAction?.rect || layout.navigation?.rect || layout.queue || layout.notebook || layout.startButton || layout.partialError?.rect || layout.surfaceProjections.length !== 0) {
      throw new Error(`Review boundary fixture mounted a queue, notebook, or projected surface: ${JSON.stringify(layout)}`)
    }
    const expectedRole = fixtureCase.boundaryTone === 'error' ? 'alert' : 'status'
    if (layout.boundaryState.role !== expectedRole) {
      throw new Error(`Review boundary fixture has the wrong accessibility role: ${JSON.stringify(layout)}`)
    }
    if (!rectContains(layout.boundary, layout.boundaryState.rect)) {
      throw new Error(`Review boundary state escapes its authored scene region: ${JSON.stringify(layout)}`)
    }
    if (
      (layout.boundaryState.scrollWidth ?? 0) > (layout.boundaryState.clientWidth ?? 0) + 1
      || (layout.boundaryState.copyScrollWidth ?? 0) > (layout.boundaryState.copyClientWidth ?? 0) + 1
    ) {
      throw new Error(`Review boundary copy creates horizontal overflow: ${JSON.stringify(layout)}`)
    }
    if (rectsOverlap(layout.heading, layout.boundary)) {
      throw new Error(`Review boundary collides with the heading: ${JSON.stringify(layout)}`)
    }
    if (fixtureCase.boundaryTone === 'error') {
      if (!layout.retryButton.rect || !rectContains(layout.boundary, layout.retryButton.rect)) {
        throw new Error(`Review boundary retry action escapes its authored scene region: ${JSON.stringify(layout)}`)
      }
      if (!fixtureCase.compact && (!layout.retryButton.hit || !rectWithinViewport(layout.retryButton.rect, layout.viewport))) {
        throw new Error(`Desktop Review boundary retry action is not reachable: ${JSON.stringify(layout)}`)
      }
    } else if (layout.retryButton.rect) {
      throw new Error(`Non-error Review boundary unexpectedly exposes a retry action: ${JSON.stringify(layout)}`)
    }
  } else {
    const actionRect = blockedFixture ? layout.refreshButton?.rect : layout.startButton
    if (!layout.tape || !layout.queue || !layout.notebook || !actionRect || layout.queueCount !== 1) {
      throw new Error(`Review V4 fixture is incomplete: ${JSON.stringify(layout)}`)
    }
    if (blockedFixture) {
      if (layout.startButton || layout.startButtonHit || !layout.refreshButton?.rect || layout.notebookHeading !== '这项还不能开始' || layout.notebookStatus !== '仍在冷却期') {
        throw new Error(`Blocked Review fixture exposed the wrong selected-item action: ${JSON.stringify(layout)}`)
      }
    } else if (layout.refreshButton?.rect || layout.notebookHeading !== '三分钟巩固' || layout.notebookStatus !== '现在可以开始') {
      throw new Error(`Ready Review fixture exposed the wrong selected-item action: ${JSON.stringify(layout)}`)
    }
    if (partialFailure) {
      const expectedFailure = reviewPartialFailures[partialFailure]
      if (
        !expectedFailure
        || !layout.partialError?.rect
        || layout.partialError.source !== partialFailure
        || layout.partialError.text !== expectedFailure.message
        || !rectContains(layout.heading, layout.partialError.rect)
      ) {
        throw new Error(`Review partial-failure copy escaped or drifted: ${JSON.stringify(layout)}`)
      }
      if (expectedFailure.action) {
        if (
          !layout.partialError.button?.rect
          || layout.partialError.button.text !== expectedFailure.action
          || layout.partialError.button.rect.height < 44
          || !rectContains(layout.partialError.rect, layout.partialError.button.rect)
        ) {
          throw new Error(`Review partial-failure recovery action is missing or too small: ${JSON.stringify(layout)}`)
        }
      } else if (layout.partialError.button?.rect) {
        throw new Error(`Review start failure unexpectedly exposed a separate retry action: ${JSON.stringify(layout)}`)
      }
    } else if (layout.partialError?.rect) {
      throw new Error(`Review ready fixture unexpectedly mounted a partial-failure notice: ${JSON.stringify(layout)}`)
    }
    if (fixtureCase.footerAction === 'continue') {
      if (
        !layout.footerAction?.rect
        || layout.footerAction.text !== '继续读取到期项'
        || layout.footerAction.rect.height < 44
        || !rectContains(layout.tape, layout.footerAction.rect)
      ) {
        throw new Error(`Review end-window continuation action is missing, too small, or outside the tape: ${JSON.stringify(layout)}`)
      }
    } else if (layout.footerAction?.rect) {
      throw new Error(`Review fixture unexpectedly exposed a footer continuation action: ${JSON.stringify(layout)}`)
    }
    if (fixtureCase.navigationState) {
      const controls = [
        ['previous', layout.navigation?.previous, fixtureCase.navigationState.previous, '查看上一组复习项目'],
        ['next', layout.navigation?.next, fixtureCase.navigationState.next, '查看下一组复习项目'],
      ]
      if (
        !layout.navigation?.rect
        || !layout.navigation.previous?.rect
        || !layout.navigation.next?.rect
        || rectsOverlap(layout.navigation.previous.rect, layout.navigation.next.rect)
        || !rectContains(layout.tape, layout.navigation.rect)
      ) {
        throw new Error(`Review pagination navigation is missing or outside the tape: ${JSON.stringify(layout)}`)
      }
      for (const [name, control, enabled, label] of controls) {
        if (
          !control.rect
          || control.rect.width < 44
          || control.rect.height < 44
          || control.disabled !== !enabled
          || control.label !== label
          || !rectContains(layout.tape, control.rect)
        ) {
          throw new Error(`Review ${name} pagination control has invalid state or target size: ${JSON.stringify(layout)}`)
        }
      }
    }
    if (layout.renderedRowCount > 6 || layout.renderedRowCount !== expectedRows) throw new Error(`Review tape did not render the expected six-row window: ${JSON.stringify(layout)}`)
    if (layout.notebookPageCount !== 2 || !layout.notebookPagesSeparate) throw new Error(`Review notebook pages are not separate: ${JSON.stringify(layout)}`)
    const actualSurfaceIds = layout.surfaceProjections.map((surface) => surface?.id).filter(Boolean).sort()
    if (layout.surfaceProjections.length !== expectedSurfaceIds.length || JSON.stringify(actualSurfaceIds) !== JSON.stringify(expectedSurfaceIds)) {
      throw new Error(`Review tape and notebook surfaces are not fully registered: ${JSON.stringify(layout)}`)
    }
    if (fixtureCase.compact) {
      if (layout.surfaceProjections.some((surface) => surface?.state !== 'flat' || surface.transform !== 'none')) {
        throw new Error(`Compact Review did not flatten every registered surface: ${JSON.stringify(layout)}`)
      }
    } else if (layout.surfaceProjections.some((surface) => surface?.state !== 'projected' || !surface.transform.startsWith('matrix3d('))) {
      throw new Error(`Desktop Review did not project every registered surface: ${JSON.stringify(layout)}`)
    }
  }

  if (layout.document.scrollWidth > layout.document.clientWidth + 1 || (layout.task.scrollWidth > layout.task.clientWidth + 1 && layout.task.overflowX !== 'hidden')) {
    throw new Error(`Review fixture has visible horizontal overflow: ${JSON.stringify(layout)}`)
  }
  if (layout.internalVerticalScrollers.length) throw new Error(`Review fixture created a nested vertical scroller: ${JSON.stringify(layout)}`)
  if (fixtureCase.compact && layout.task.overflowY !== 'auto') throw new Error(`Compact Review does not own the single scroll root: ${JSON.stringify(layout)}`)
  if (!fixtureCase.compact) {
    const primaryRect = boundaryFixture ? layout.boundaryState.rect : blockedFixture ? layout.refreshButton.rect : layout.startButton
    if (!rectWithinViewport(primaryRect, layout.viewport)) throw new Error(`Desktop Review primary content is clipped: ${JSON.stringify(layout)}`)
  }
  if (layout.fontStatus !== 'loaded' || !layout.fontFacesReady.sans || !layout.fontFacesReady.serif) {
    throw new Error(`Review fixture did not resolve the bundled Noto font faces: ${JSON.stringify(layout)}`)
  }
  const requiredFamilies = boundaryFixture
    ? [layout.fontFamilies.sceneHeading, layout.fontFamilies.boundaryHeading, layout.fontFamilies.boundaryBody]
    : [layout.fontFamilies.sceneHeading, layout.fontFamilies.tapeRow, layout.fontFamilies.notebookHeading, layout.fontFamilies.notebookBody]
  if (requiredFamilies.some((family) => !family || !/Noto/i.test(family))) {
    throw new Error(`Review fixture did not resolve the bundled Noto font families: ${JSON.stringify(layout)}`)
  }
  if (boundaryFixture) {
    if ((layout.fontSizes.boundaryBody ?? 0) <= 0 || (fixtureCase.boundaryTone === 'error' && (layout.retryButton.rect?.height ?? 0) < 40)) {
      throw new Error(`Review boundary dropped its readable copy or action target: ${JSON.stringify(layout)}`)
    }
  } else if ((layout.fontSizes.notebookBody ?? 0) < 14 || (layout.fontSizes.notebookAction ?? 0) < 14) {
    throw new Error(`Review fixture dropped body or primary-action type below 14px: ${JSON.stringify(layout)}`)
  }
  if (!layout.backplate || layout.backplate.source !== expectedBackplate || layout.backplate.naturalWidth !== 1672 || layout.backplate.naturalHeight !== 941) {
    throw new Error(`Review fixture did not use the registered ${fixtureCase.theme} backplate: ${JSON.stringify(layout)}`)
  }
}

const assertPartialFailureReachability = (layout, fixtureCase) => {
  const failure = fixtureCase.partialFailure ? reviewPartialFailures[fixtureCase.partialFailure] : null
  if (!failure) return
  if (!rectWithinViewport(layout.partialError?.rect, layout.viewport)) {
    throw new Error(`Review partial-failure notice is not visible on entry: ${JSON.stringify(layout)}`)
  }
  if (failure.action && (
    !layout.partialError.button?.hit
    || !rectWithinViewport(layout.partialError.button.rect, layout.viewport)
  )) {
    throw new Error(`Review partial-failure recovery action is not reachable on entry: ${JSON.stringify(layout)}`)
  }
}

const assertFooterReachability = (layout, fixtureCase) => {
  if (!fixtureCase.footerAction) return
  if (
    !layout.footerAction?.hit
    || !layout.footerAction.rect
    || layout.footerAction.rect.height < 44
    || !rectWithinViewport(layout.footerAction.rect, layout.viewport)
  ) {
    throw new Error(`Review footer continuation action is not reachable after targeted scrolling: ${JSON.stringify(layout)}`)
  }
}

const assertNavigationReachability = (layout, fixtureCase) => {
  if (fixtureCase.navigationReachability !== 'entry') return
  for (const [name, control] of [
    ['previous', layout.navigation?.previous],
    ['next', layout.navigation?.next],
  ]) {
    if (!control?.hit || !rectWithinViewport(control.rect, layout.viewport)) {
      throw new Error(`Review ${name} pagination control is not reachable on entry: ${JSON.stringify(layout)}`)
    }
  }
}

const assertCompactReachability = (initialLayout, scrolledLayout, fixtureCase) => {
  const returnRect = initialLayout.returnButton?.rect
  const headingRect = initialLayout.heading
  if (!initialLayout.task || initialLayout.task.scrollHeight <= initialLayout.task.clientHeight || initialLayout.task.overflowY !== 'auto') {
    throw new Error(`Compact Review does not expose a real single scroll root: ${JSON.stringify(initialLayout)}`)
  }
  if (
    initialLayout.returnButton.position !== 'sticky'
    || initialLayout.returnButton.labelDisplay !== 'none'
    || !returnRect
    || returnRect.width > 44.5
    || returnRect.height < 44
  ) {
    throw new Error(`Compact Review return control is not a compact sticky affordance: ${JSON.stringify(initialLayout)}`)
  }
  if (headingRect && returnRect && !(
    headingRect.right <= returnRect.left + 1
    || returnRect.right <= headingRect.left + 1
    || headingRect.bottom <= returnRect.top + 1
    || returnRect.bottom <= headingRect.top + 1
  )) {
    throw new Error(`Compact Review return control overlaps the heading: ${JSON.stringify(initialLayout)}`)
  }
  const scrolledReturnRect = scrolledLayout.returnButton?.rect
  const scrolledActionRect = fixtureCase.blocked ? scrolledLayout.refreshButton?.rect : scrolledLayout.startButton
  const scrolledActionHit = fixtureCase.blocked ? scrolledLayout.refreshButton?.hit : scrolledLayout.startButtonHit
  const viewportHeight = scrolledLayout.viewport?.height ?? 0
  if (
    (scrolledLayout.scrollTop ?? 0) <= 0
    || !scrolledLayout.returnButton.hit
    || !scrolledReturnRect
    || scrolledReturnRect.top < -1
    || scrolledReturnRect.bottom > viewportHeight + 1
    || !scrolledActionHit
    || !scrolledActionRect
    || scrolledActionRect.height < 44
    || scrolledActionRect.top < -1
    || scrolledActionRect.bottom > viewportHeight + 1
  ) {
    throw new Error(`Compact Review loses return or selected-item action reachability after scrolling: ${JSON.stringify({ initialLayout, scrolledLayout })}`)
  }
  if (fixtureCase.avoidStickyOverlap && rectsOverlap(scrolledLayout.returnButton?.rect, scrolledLayout.notebookHeadingRect)) {
    throw new Error(`Compact Review return control overlaps the selected-item heading after scrolling: ${JSON.stringify({ initialLayout, scrolledLayout })}`)
  }
}

const assertCompactBoundaryReachability = (initialLayout, scrolledLayout, fixtureCase) => {
  const returnRect = initialLayout.returnButton?.rect
  const headingRect = initialLayout.heading
  if (!initialLayout.task || initialLayout.task.scrollHeight <= initialLayout.task.clientHeight || initialLayout.task.overflowY !== 'auto') {
    throw new Error(`Compact Review boundary does not expose a real single scroll root: ${JSON.stringify(initialLayout)}`)
  }
  if (
    initialLayout.returnButton.position !== 'sticky'
    || initialLayout.returnButton.labelDisplay !== 'none'
    || !returnRect
    || returnRect.width > 44.5
    || returnRect.height < 44
  ) {
    throw new Error(`Compact Review boundary return control is not a compact sticky affordance: ${JSON.stringify(initialLayout)}`)
  }
  if (headingRect && returnRect && rectsOverlap(headingRect, returnRect)) {
    throw new Error(`Compact Review boundary return control overlaps the heading: ${JSON.stringify(initialLayout)}`)
  }
  if (fixtureCase.boundaryTone === 'error') {
    if (!initialLayout.retryButton?.hit || !rectWithinViewport(initialLayout.retryButton.rect, initialLayout.viewport)) {
      throw new Error(`Compact Review boundary retry action is not reachable on entry: ${JSON.stringify(initialLayout)}`)
    }
    const retryCandidates = [initialLayout, scrolledLayout]
      .map((layout) => ({
        layout,
        rect: layout.retryButton?.rect,
      }))
      .filter(({ layout, rect }) => layout.retryButton?.hit && rectWithinViewport(rect, layout.viewport))
    if (!retryCandidates.length) {
      throw new Error(`Compact Review boundary retry action is never reachable: ${JSON.stringify({ initialLayout, scrolledLayout })}`)
    }
  } else if (fixtureCase.boundaryTone === 'loading' && (
    !rectWithinViewport(initialLayout.boundaryState?.heading, initialLayout.viewport)
    || !rectWithinViewport(initialLayout.boundaryState?.message, initialLayout.viewport)
    || !rectWithinViewport(initialLayout.boundaryState?.lines, initialLayout.viewport)
    || initialLayout.boundaryState.lineCount !== 3
  )) {
    throw new Error(`Compact Review loading copy is not visible on entry: ${JSON.stringify(initialLayout)}`)
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
    await applyFixtureSurfaceProjection(window)
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
      assertPartialFailureReachability(layout, fixtureCase)
      assertNavigationReachability(layout, fixtureCase)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      assertion = { passed: false, message }
      assertionFailures.push({ fixtureId: fixtureCase.fixtureId, message })
    }
    let footerEvidence = null
    if (fixtureCase.compact && fixtureCase.footerAction) {
      await window.evaluate(() => {
        const button = document.querySelector('.review-tape__footer button')
        if (button instanceof HTMLElement) button.scrollIntoView({ block: 'center', inline: 'nearest' })
      })
      await window.waitForTimeout(100)
      const footerLayout = await readLayout(window)
      const footerOutputPath = resolve(reviewRoot, outputName.replace(/\.png$/, '-footer-scrolled.png'))
      await window.screenshot({ path: footerOutputPath })
      let footerAssertion = { passed: true }
      try {
        assertLayout(footerLayout, fixtureCase)
        assertFooterReachability(footerLayout, fixtureCase)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        footerAssertion = { passed: false, message }
        assertionFailures.push({ fixtureId: `${fixtureCase.fixtureId}:footer-scrolled`, message })
      }
      footerEvidence = {
        output: footerOutputPath,
        assertion: footerAssertion,
        layout: footerLayout,
      }
    }
    let scrollEvidence = null
    if (fixtureCase.compact) {
      await window.evaluate(() => {
        const task = document.querySelector('.task-surface--review')
        if (task instanceof HTMLElement) task.scrollTop = task.scrollHeight
      })
      await window.waitForTimeout(100)
      const scrolledLayout = await readLayout(window)
      const scrolledOutputPath = resolve(reviewRoot, outputName.replace(/\.png$/, '-scrolled.png'))
      await window.screenshot({ path: scrolledOutputPath })
      let scrollAssertion = { passed: true }
      try {
        assertLayout(scrolledLayout, fixtureCase)
        if (fixtureCase.boundaryTone) assertCompactBoundaryReachability(layout, scrolledLayout, fixtureCase)
        else assertCompactReachability(layout, scrolledLayout, fixtureCase)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        scrollAssertion = { passed: false, message }
        assertionFailures.push({ fixtureId: `${fixtureCase.fixtureId}:scrolled`, message })
      }
      scrollEvidence = {
        output: scrolledOutputPath,
        assertion: scrollAssertion,
        layout: scrolledLayout,
      }
    }
    captures[fixtureCase.key] = {
      fixture: {
        id: fixtureCase.fixtureId,
        itemCount: fixtureCase.itemCount,
        selectedIndex: fixtureCase.selectedIndex,
        windowStart: fixtureCase.windowStart,
        maximumVisibleRows: 6,
        hasNextPage: fixtureCase.hasNextPage,
        state: fixtureCase.boundaryTone ?? 'ready',
        action: fixtureCase.blocked ? 'blocked' : 'ready',
        failure: fixtureCase.partialFailure ?? null,
        footerAction: fixtureCase.footerAction ?? null,
        navigationState: fixtureCase.navigationState ?? null,
        theme: fixtureCase.theme,
        cssViewportWidth: fixtureCase.cssViewportWidth ?? null,
        requestedViewport: { width: fixtureCase.width, height: fixtureCase.height, zoomFactor: fixtureCase.zoomFactor },
      },
      output: outputPath,
      assertion,
      footerEvidence,
      layout,
      scrollEvidence,
    }
  }

  const metadataPath = resolve(reviewRoot, 'layout-harness-review-v4.json')
  await writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: 4,
    evidenceClass: 'LAYOUT_FIXTURE_ONLY',
    visualLabel: showFixtureLabel ? 'evidence' : 'review-preview-without-label',
    productData: false,
    realJourneyEvidence: false,
    frozenClock: '2026-08-25T00:00:00+08:00',
    fixtureSizes: fixtureCases.map((fixtureCase) => fixtureCase.itemCount).sort((left, right) => left - right),
    maximumVisibleRows: 6,
    backplates: reviewBackplates,
    surfaceRegistry: {
      schemaVersion: reviewSurfaceRegistry.schemaVersion,
      coordinateSpace: reviewSurfaceRegistry.coordinateSpace,
      assetRevision: reviewSurfaceRegistry.assetRevision,
      assetHashes: reviewSurfaceRegistry.assetHashes,
      calibrationRevision: reviewSurfaceRegistry.calibrationRevision,
      surfaceIds: Object.values(reviewSurfaceRegistry.surfaces).map((surface) => surface.id),
    },
    captures,
  }, null, 2)}\n`, 'utf8')
  console.log(`Captured Review V4 layout fixtures and metadata in ${reviewRoot}`)
  if (assertionFailures.length) {
    throw new Error(`Review V4 layout assertions failed: ${JSON.stringify(assertionFailures)}`)
  }
} finally {
  await electronApp.close()
}
