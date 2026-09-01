import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review')
const surfaceRegistry = JSON.parse(await readFile(
  resolve(appRoot, 'src/renderer/src/scene/study-surfaces.json'),
  'utf8',
))
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const showFixtureLabel = process.env.STUDY_LAYOUT_FIXTURE_LABEL !== '0'

const backplates = {
  day: '/assets/learning-room/v1/posters/study-seat-day-v2.png',
  night: '/assets/learning-room/v1/posters/study-seat-night-v2.png',
}

const fixtureCases = [
  {
    key: 'desktopDay',
    fixtureId: 'study-v1-desktop-day',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 1,
    compact: false,
    output: 'layout-harness-study-v1-1440x810-day.png',
  },
  {
    key: 'minimumNight',
    fixtureId: 'study-v1-minimum-night',
    theme: 'night',
    width: 1024,
    height: 700,
    zoomFactor: 1,
    compact: false,
    output: 'layout-harness-study-v1-1024x700-night.png',
  },
  {
    key: 'compactZoom200',
    fixtureId: 'study-v1-zoom-200',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-study-v1-zoom-200-compact.png',
  },
  {
    key: 'compact320CssZoom200',
    fixtureId: 'study-v1-320-css-px',
    theme: 'night',
    width: 640,
    height: 810,
    zoomFactor: 2,
    compact: true,
    cssViewportWidth: 320,
    output: 'layout-harness-study-v1-320-css-px-zoom-200.png',
  },
]

await mkdir(reviewRoot, { recursive: true })
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-study-layout-'))
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
      `--scene-content-top:${percentage(surface.contentInsets.top)}`,
      `--scene-content-right:${percentage(surface.contentInsets.right)}`,
      `--scene-content-bottom:${percentage(surface.contentInsets.bottom)}`,
      `--scene-content-left:${percentage(surface.contentInsets.left)}`,
    ].join(';')
    const worldBounds = {
      x: 0,
      y: 0,
      width: config.surfaceRegistry.coordinateSpace.width,
      height: config.surfaceRegistry.coordinateSpace.height,
    }
    const notebookStyle = sceneRectStyle(config.surfaceRegistry.notebookBounds, worldBounds)
    const leftSurface = config.surfaceRegistry.surfaces.notebookLeft
    const rightSurface = config.surfaceRegistry.surfaces.notebookRight
    const sourceSurface = config.surfaceRegistry.surfaces.sourceSlip
    const referenceStyle = `--scene-world-aspect:${worldBounds.width / worldBounds.height}`

    const fixture = document.createElement('div')
    fixture.className = 'study-layout-fixture'
    fixture.dataset.theme = config.theme
    fixture.dataset.fixtureId = config.fixtureId
    fixture.innerHTML = `
      <img class="study-layout-fixture__room" src="${config.backplate}" alt="" aria-hidden="true">
      <main class="task-surface task-surface--study">
        <div class="surface-content task-surface__spatial-layer">
          <section class="study-object-surface study-workbench task-artifact study-workbench--ready" aria-labelledby="study-surface-title">
            <button class="surface-return-control study-workbench__bookmark" type="button" aria-label="关闭任务面并返回书房">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></svg>
              <span>返回书房</span>
            </button>
            <div
              class="scene-reference-frame study-reference-frame"
              data-scene-coordinate-space="${config.surfaceRegistry.coordinateSpace.id}"
              data-scene-fit="${config.surfaceRegistry.coordinateSpace.fitMode}"
              style="${referenceStyle}"
            >
              <div class="study-notebook" style="${notebookStyle}">
                <img
                  class="study-notebook__object"
                  src="/assets/learning-room/v1/objects/study-open-notebook-v1.png"
                  data-scene-surface-base="true"
                  alt=""
                  aria-hidden="true"
                >
                <div
                  class="study-notebook__surface study-notebook__surface--reading"
                  data-scene-surface="${leftSurface.id}"
                  style="${surfaceStyle(leftSurface, config.surfaceRegistry.notebookBounds)}"
                >
                  <article class="study-notebook__page study-notebook__page--reading">
                    <div class="study-notebook__ink study-notebook__ink--reading" data-scene-surface-layer="ink">
                      <header class="study-objective"><h2 id="study-surface-title">受激辐射与增益介质</h2></header>
                      <blockquote>理解受激辐射如何在增益介质中形成可验证的光放大因果链。</blockquote>
                      <footer class="study-objective__status"><strong>待首次验证</strong><span>内容版本 7</span></footer>
                    </div>
                    <span class="study-notebook__material study-notebook__material--left" data-scene-surface-layer="material" aria-hidden="true"></span>
                  </article>
                </div>
                <div
                  class="study-notebook__surface study-notebook__surface--next"
                  data-scene-surface="${rightSurface.id}"
                  style="${surfaceStyle(rightSurface, config.surfaceRegistry.notebookBounds)}"
                >
                  <section class="study-notebook__page study-notebook__page--next" aria-labelledby="study-next-action-title">
                    <div class="study-notebook__ink study-notebook__ink--next" data-scene-surface-layer="ink">
                      <div class="study-next-action">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m12 3-1.9 5.1L5 10l5.1 1.9L12 17l1.9-5.1L19 10l-5.1-1.9L12 3Z"/></svg>
                        <div><h3 id="study-next-action-title">开始首次验证</h3><p>用自己的语言解释受激辐射与光放大的因果关系</p></div>
                      </div>
                      <div class="study-notebook__actions">
                        <button class="surface-primary" type="button">开始首次验证 <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></button>
                        <button class="surface-secondary" type="button"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 6.5A2.5 2.5 0 0 1 4.5 4H9l3 3 3-3h4.5A2.5 2.5 0 0 1 22 6.5V19H15l-3 2-3-2H2V6.5Z"/></svg>进入研究册</button>
                      </div>
                    </div>
                    <span class="study-notebook__material study-notebook__material--right" data-scene-surface-layer="material" aria-hidden="true"></span>
                  </section>
                </div>
                <aside
                  class="study-source-slip study-notebook__surface"
                  data-scene-surface="${sourceSurface.id}"
                  style="${surfaceStyle(sourceSurface, config.surfaceRegistry.notebookBounds)}"
                  aria-label="学习目标来源"
                >
                  <div class="study-source-slip__plane">
                    <div class="study-source-slip__ink" data-scene-surface-layer="ink"><span>来源</span><strong>光学原理笔记</strong></div>
                    <span class="study-source-slip__material" data-scene-surface-layer="material" aria-hidden="true"></span>
                  </div>
                </aside>
                <span class="study-notebook__spine" data-scene-surface-layer="occluder" aria-hidden="true"></span>
              </div>
            </div>
          </section>
        </div>
      </main>
      ${config.showFixtureLabel ? '<p class="study-layout-fixture__label">LAYOUT FIXTURE · 非产品数据 · 非真实旅程证据</p>' : ''}
    `

    let style = document.querySelector('style[data-study-layout-fixture="v1"]')
    if (!(style instanceof HTMLStyleElement)) {
      style = document.createElement('style')
      style.dataset.studyLayoutFixture = 'v1'
      style.textContent = `
        html, body, #root { width: 100%; height: 100%; margin: 0; }
        body { overflow: hidden; }
        .study-layout-fixture { position: relative; width: 100vw; height: 100vh; overflow: hidden; background: #261b14; }
        .study-layout-fixture__room { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .study-layout-fixture__label { position: fixed; z-index: 100; right: 10px; bottom: 8px; margin: 0; padding: 5px 8px; color: rgba(255,247,234,.8); font-size: 9px; letter-spacing: .03em; border: 1px solid rgba(255,247,234,.18); border-radius: 999px; background: rgba(35,25,19,.78); pointer-events: none; }
      `
      document.head.append(style)
    }

    const currentFixture = document.querySelector('.study-layout-fixture')
    if (currentFixture) currentFixture.replaceWith(fixture)
    else document.querySelector('#root')?.replaceWith(fixture)
  }, {
    ...fixtureCase,
    backplate: backplates[fixtureCase.theme],
    showFixtureLabel,
    surfaceRegistry,
  })

  await window.waitForFunction(() => [...document.querySelectorAll('.study-layout-fixture img')].every((image) => (
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
}

const applySurfaceProjection = async (window) => {
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
  }, surfaceRegistry)
}

const readLayout = (window) => window.evaluate(() => {
  const fixture = document.querySelector('.study-layout-fixture')
  const task = document.querySelector('.task-surface--study')
  const referenceFrame = document.querySelector('.study-reference-frame')
  const notebook = document.querySelector('.study-notebook')
  const notebookObject = document.querySelector('.study-notebook__object')
  const leftPage = document.querySelector('.study-notebook__surface--reading')
  const rightPage = document.querySelector('.study-notebook__surface--next')
  const sourceSlip = document.querySelector('.study-source-slip')
  const rightInk = document.querySelector('.study-notebook__ink--next')
  const nextAction = document.querySelector('.study-next-action')
  const nextActionDescription = document.querySelector('.study-next-action p')
  const nextActions = document.querySelector('.study-notebook__actions')
  const primaryAction = document.querySelector('.study-notebook__actions .surface-primary')
  const secondaryAction = document.querySelector('.study-notebook__actions .surface-secondary')
  const returnButton = document.querySelector('.study-workbench__bookmark')
  const room = document.querySelector('.study-layout-fixture__room')
  const registeredSurfaces = [...document.querySelectorAll('[data-scene-surface]')]
  const rect = (node) => node instanceof HTMLElement
    ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [key, node.getBoundingClientRect()[key]]))
    : null
  const metrics = (node) => node instanceof HTMLElement
    ? { rect: rect(node), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }
    : null
  const hit = (node) => {
    const bounds = node?.getBoundingClientRect()
    if (!(node instanceof HTMLElement) || !bounds) return false
    return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button') === node
  }
  const fontSize = (selector) => {
    const node = document.querySelector(selector)
    const value = node ? Number.parseFloat(getComputedStyle(node).fontSize) : NaN
    return Number.isFinite(value) ? value : null
  }
  const fontFamily = (selector) => {
    const node = document.querySelector(selector)
    return node ? getComputedStyle(node).fontFamily : null
  }
  const surfaceFill = (selector) => {
    const node = document.querySelector(selector)
    if (!(node instanceof HTMLElement)) return null
    const style = getComputedStyle(node)
    return {
      selector,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
    }
  }
  const internalVerticalScrollers = referenceFrame instanceof HTMLElement
    ? [referenceFrame, ...referenceFrame.querySelectorAll('*')].filter((node) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      return node.scrollHeight > node.clientHeight + 1 && ['auto', 'scroll'].includes(style.overflowY)
    }).map((node) => node.className)
    : []

  return {
    fixtureId: fixture instanceof HTMLElement ? fixture.dataset.fixtureId ?? null : null,
    theme: fixture instanceof HTMLElement ? fixture.dataset.theme ?? null : null,
    coordinateSpace: referenceFrame instanceof HTMLElement ? referenceFrame.dataset.sceneCoordinateSpace ?? null : null,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    task: task instanceof HTMLElement ? {
      clientWidth: task.clientWidth,
      scrollWidth: task.scrollWidth,
      clientHeight: task.clientHeight,
      scrollHeight: task.scrollHeight,
      overflowX: getComputedStyle(task).overflowX,
      overflowY: getComputedStyle(task).overflowY,
    } : null,
    referenceFrame: rect(referenceFrame),
    notebook: rect(notebook),
    leftPage: rect(leftPage),
    rightPage: rect(rightPage),
    sourceSlip: rect(sourceSlip),
    rightInk: metrics(rightInk),
    nextAction: metrics(nextAction),
    nextActionDescription: metrics(nextActionDescription),
    nextActions: metrics(nextActions),
    primaryAction: { rect: rect(primaryAction), hit: hit(primaryAction) },
    secondaryAction: { rect: rect(secondaryAction), hit: hit(secondaryAction) },
    domControlFills: [surfaceFill('.study-notebook__actions .surface-secondary')],
    returnButton: {
      rect: rect(returnButton),
      hit: hit(returnButton),
      backgroundColor: returnButton instanceof HTMLElement ? getComputedStyle(returnButton).backgroundColor : null,
    },
    objectDisplay: notebookObject instanceof HTMLElement ? getComputedStyle(notebookObject).display : null,
    surfaceProjections: registeredSurfaces.map((node) => node instanceof HTMLElement ? {
      id: node.dataset.sceneSurface ?? null,
      state: node.dataset.sceneSurfaceProjection ?? null,
      transform: getComputedStyle(node).transform,
    } : null),
    internalVerticalScrollers,
    visibleTextContainsRawIdentity: referenceFrame instanceof HTMLElement
      ? /识别码|[0-9a-f]{8}-[0-9a-f-]{27}/i.test(referenceFrame.innerText)
      : false,
    fontStatus: document.fonts?.status ?? 'unavailable',
    fontFacesReady: {
      sans: document.fonts?.check('400 16px "Noto Sans SC Variable"') ?? false,
      serif: document.fonts?.check('400 16px "Noto Serif SC Variable"') ?? false,
    },
    fontFamilies: {
      title: fontFamily('.study-objective h2'),
      body: fontFamily('.study-notebook blockquote'),
      action: fontFamily('.study-next-action h3'),
    },
    fontSizes: {
      body: fontSize('.study-notebook blockquote'),
      actionDescription: fontSize('.study-next-action p'),
    },
    backplate: room instanceof HTMLImageElement
      ? { source: room.getAttribute('src'), naturalWidth: room.naturalWidth, naturalHeight: room.naturalHeight }
      : null,
  }
})

const assertLayout = (layout, fixtureCase) => {
  const expectedIds = Object.values(surfaceRegistry.surfaces).map((surface) => surface.id).sort()
  const actualIds = layout.surfaceProjections.map((surface) => surface?.id).filter(Boolean).sort()
  if (!layout.task || !layout.referenceFrame || !layout.notebook || !layout.leftPage || !layout.rightPage || !layout.sourceSlip || !layout.primaryAction.rect) {
    throw new Error(`Study V1 fixture is incomplete: ${JSON.stringify(layout)}`)
  }
  if (layout.fixtureId !== fixtureCase.fixtureId || layout.theme !== fixtureCase.theme) {
    throw new Error(`Study V1 fixture metadata drifted: ${JSON.stringify(layout)}`)
  }
  if (fixtureCase.cssViewportWidth && Math.abs((layout.viewport?.width ?? 0) - fixtureCase.cssViewportWidth) > 1) {
    throw new Error(`Study fixture did not capture the requested CSS viewport width: ${JSON.stringify(layout)}`)
  }
  if (layout.coordinateSpace !== surfaceRegistry.coordinateSpace.id) {
    throw new Error(`Study fixture left the canonical coordinate space: ${JSON.stringify(layout)}`)
  }
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds) || layout.surfaceProjections.length !== expectedIds.length) {
    throw new Error(`Study fixture did not mount all three registered surfaces: ${JSON.stringify(layout)}`)
  }
  if (!layout.primaryAction.hit || (layout.secondaryAction.rect && !layout.secondaryAction.hit) || !layout.returnButton.hit) {
    throw new Error(`Study fixture has a non-hit-testable action: ${JSON.stringify(layout)}`)
  }
  if (layout.domControlFills.some((surface) => !surface || surface.backgroundColor !== 'rgba(0, 0, 0, 0)' || surface.backgroundImage !== 'none')) {
    throw new Error(`Study fixture still paints a secondary control surface: ${JSON.stringify(layout)}`)
  }
  if (layout.visibleTextContainsRawIdentity) throw new Error(`Study fixture exposes a raw identity: ${JSON.stringify(layout)}`)
  if (layout.document.scrollWidth > layout.document.clientWidth + 1 || (layout.task.scrollWidth > layout.task.clientWidth + 1 && layout.task.overflowX !== 'hidden')) {
    throw new Error(`Study fixture has visible horizontal overflow: ${JSON.stringify(layout)}`)
  }
  if (layout.internalVerticalScrollers.length) {
    throw new Error(`Study fixture created a nested vertical scroller: ${JSON.stringify(layout)}`)
  }
  if (fixtureCase.compact) {
    if (layout.surfaceProjections.some((surface) => surface?.state !== 'flat' || surface.transform !== 'none')) {
      throw new Error(`Compact Study did not flatten every registered surface: ${JSON.stringify(layout)}`)
    }
    if (layout.objectDisplay !== 'none' || layout.task.overflowY !== 'auto' || layout.leftPage.bottom > layout.rightPage.top) {
      throw new Error(`Compact Study did not become one paper-card flow: ${JSON.stringify(layout)}`)
    }
    if (!layout.returnButton.backgroundColor?.startsWith('rgb(') || layout.returnButton.rect.width > 48 || layout.returnButton.rect.height > 48) {
      throw new Error(`Compact Study return control is too large or translucent over scrolling ink: ${JSON.stringify(layout)}`)
    }
    const contentFits = (content, container) => content?.rect && container?.rect
      && content.rect.left >= container.rect.left - 1
      && content.rect.right <= container.rect.right + 1
      && content.rect.top >= container.rect.top - 1
      && content.rect.bottom <= container.rect.bottom + 1
    if (!contentFits(layout.nextAction, layout.rightInk)
      || !contentFits(layout.nextActionDescription, layout.rightInk)
      || !contentFits(layout.nextActions, layout.rightInk)
      || (layout.secondaryAction.rect && !contentFits(layout.secondaryAction, layout.nextActions))
      || (layout.secondaryAction.rect && layout.secondaryAction.rect.height < 44)
      || (layout.rightInk?.scrollWidth ?? 0) > (layout.rightInk?.clientWidth ?? 0) + 1
      || (layout.nextAction?.scrollWidth ?? 0) > (layout.nextAction?.clientWidth ?? 0) + 1
      || (layout.nextActionDescription?.scrollWidth ?? 0) > (layout.nextActionDescription?.clientWidth ?? 0) + 1
      || (layout.nextActions?.scrollWidth ?? 0) > (layout.nextActions?.clientWidth ?? 0) + 1) {
      throw new Error(`Compact Study next-action content exceeded the reading bounds: ${JSON.stringify(layout)}`)
    }
  } else {
    if (layout.surfaceProjections.some((surface) => surface?.state !== 'projected' || !surface.transform.startsWith('matrix3d('))) {
      throw new Error(`Desktop Study did not project every registered surface: ${JSON.stringify(layout)}`)
    }
    if (layout.objectDisplay === 'none' || layout.primaryAction.rect.top < 0 || layout.primaryAction.rect.bottom > layout.viewport.height) {
      throw new Error(`Desktop Study lost its notebook base or clipped the primary action: ${JSON.stringify(layout)}`)
    }
  }
  if (layout.fontStatus !== 'loaded' || !layout.fontFacesReady.sans || !layout.fontFacesReady.serif || Object.values(layout.fontFamilies).some((family) => !family || !/Noto/i.test(family))) {
    throw new Error(`Study fixture did not resolve bundled Noto fonts: ${JSON.stringify(layout)}`)
  }
  if ((layout.fontSizes.body ?? 0) < 13 || (layout.fontSizes.actionDescription ?? 0) < 11) {
    throw new Error(`Study fixture dropped body copy below the readability floor: ${JSON.stringify(layout)}`)
  }
  const expectedBackplate = backplates[fixtureCase.theme]
  if (!layout.backplate || layout.backplate.source !== expectedBackplate || layout.backplate.naturalWidth !== 1672 || layout.backplate.naturalHeight !== 941) {
    throw new Error(`Study fixture did not use the registered ${fixtureCase.theme} backplate: ${JSON.stringify(layout)}`)
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
    await applySurfaceProjection(window)
    if (fixtureCase.compact) {
      await window.evaluate(() => document.querySelector('.study-notebook__actions .surface-primary')?.scrollIntoView({ block: 'center' }))
    }
    await window.waitForTimeout(250)
    const layout = await readLayout(window)
    const outputName = showFixtureLabel ? fixtureCase.output : fixtureCase.output.replace(/\.png$/, '-preview.png')
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
        theme: fixtureCase.theme,
        cssViewportWidth: fixtureCase.cssViewportWidth ?? null,
        requestedViewport: { width: fixtureCase.width, height: fixtureCase.height, zoomFactor: fixtureCase.zoomFactor },
      },
      output: outputPath,
      assertion,
      layout,
    }
  }

  const metadataPath = resolve(reviewRoot, 'layout-harness-study-v1.json')
  await writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    evidenceClass: 'LAYOUT_FIXTURE_ONLY',
    visualLabel: showFixtureLabel ? 'evidence' : 'study-preview-without-label',
    productData: false,
    realJourneyEvidence: false,
    backplates,
    surfaceRegistry: {
      schemaVersion: surfaceRegistry.schemaVersion,
      coordinateSpace: surfaceRegistry.coordinateSpace,
      assetRevision: surfaceRegistry.assetRevision,
      assetHashes: surfaceRegistry.assetHashes,
      calibrationRevision: surfaceRegistry.calibrationRevision,
      surfaceIds: Object.values(surfaceRegistry.surfaces).map((surface) => surface.id),
    },
    captures,
  }, null, 2)}\n`, 'utf8')
  console.log(`Captured Study V1 layout fixtures and metadata in ${reviewRoot}`)
  if (assertionFailures.length) {
    throw new Error(`Study V1 layout assertions failed: ${JSON.stringify(assertionFailures)}`)
  }
} finally {
  await electronApp.close()
}
