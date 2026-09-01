import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review')
const surfaceRegistry = JSON.parse(await readFile(
  resolve(appRoot, 'src/renderer/src/scene/search-surfaces.json'),
  'utf8',
))
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const showFixtureLabel = process.env.SEARCH_LAYOUT_FIXTURE_LABEL !== '0'

const backplates = {
  day: '/assets/learning-room/v1/posters/search-reference-day-v1.png',
  night: '/assets/learning-room/v1/posters/search-reference-night-v1.png',
}

const foregrounds = {
  day: '/assets/learning-room/v1/foreground/search-foreground-day-v1.png',
  night: '/assets/learning-room/v1/foreground/search-foreground-night-v1.png',
}

const fixtureCases = [
  {
    key: 'desktopDay',
    fixtureId: 'search-v1-desktop-day',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 1,
    compact: false,
      output: 'layout-harness-search-v1-1440x810-day.png',
  },
  {
    key: 'minimumNight',
    fixtureId: 'search-v1-minimum-night',
    theme: 'night',
    width: 1024,
    height: 700,
    zoomFactor: 1,
    compact: false,
      output: 'layout-harness-search-v1-1024x700-night.png',
  },
  {
    key: 'compactZoom200',
    fixtureId: 'search-v1-zoom-200',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 2,
    compact: true,
      output: 'layout-harness-search-v1-zoom-200-compact.png',
  },
  {
    key: 'compact320CssZoom200',
    fixtureId: 'search-v1-320-css-px',
    theme: 'night',
    width: 640,
    height: 810,
    zoomFactor: 2,
    compact: true,
    cssViewportWidth: 320,
    output: 'layout-harness-search-v1-320-css-px-zoom-200.png',
  },
]

await mkdir(reviewRoot, { recursive: true })
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-search-layout-'))
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
    const catalogStyle = sceneRectStyle(config.surfaceRegistry.catalogBounds, worldBounds)
    const { queryLedger, upperShelf, lowerShelf, boundarySlip } = config.surfaceRegistry.surfaces
    const referenceStyle = `--scene-world-aspect:${worldBounds.width / worldBounds.height}`
    const cards = [
      ['受激辐射与增益介质', '主焦点 · 激光物理', true],
      ['谐振腔中的相干放大', 'Objective · active', false],
      ['粒子数反转', 'Objective · active', false],
      ['激光阈值条件', 'Objective · active', false],
      ['增益饱和', 'Objective · archived', false],
      ['光子寿命', 'Objective · active', false],
    ]
    const cardMarkup = (items, offset) => items.map(([title, meta, active], index) => `
      <div class="search-index-card__motion" data-search-card-id="search-fixture-card-${index + offset}" data-search-card-state="static">
        <button type="button" class="search-index-card search-index-card--${(index + offset) % 4}" ${active ? '' : 'disabled'}>
          <span class="search-index-card__mark" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><circle cx="11" cy="14" r="2"/><path d="m12.5 15.5 2 2"/></svg></span>
          <span class="search-index-card__copy"><strong>${title}</strong><small>${meta}${active ? ' · 可继续' : ' · 仅供检索'}</small></span>
          ${active ? '<svg class="search-index-card__action" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18-6-6 6-6"/><path d="M3 12h14a4 4 0 0 1 4 4v2"/></svg>' : ''}
        </button>
      </div>
    `).join('')

    const fixture = document.createElement('div')
    fixture.className = 'search-layout-fixture'
    fixture.dataset.theme = config.theme
    fixture.dataset.fixtureId = config.fixtureId
    fixture.innerHTML = `
      <img class="search-layout-fixture__room" src="${config.backplate}" alt="" aria-hidden="true">
      <main class="task-surface task-surface--search" data-motion-mode="full">
        <div class="surface-content task-surface__spatial-layer">
          <section class="search-catalog-workbench task-artifact task-artifact--search-ledger search-catalog-workbench--ready search-catalog-workbench--foreground-ready" data-search-foreground="ready" aria-labelledby="search-catalog-title">
            <button class="surface-return-control search-catalog__return" type="button" aria-label="关闭任务面并返回书房" data-surface-initial-focus="true">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></svg>
              <span>返回书房</span>
            </button>
            <div class="scene-reference-frame search-catalog-reference-frame" data-scene-coordinate-space="${config.surfaceRegistry.coordinateSpace.id}" data-scene-fit="${config.surfaceRegistry.coordinateSpace.fitMode}" style="${referenceStyle}">
              <img class="search-catalog__foreground" src="${config.foreground}" alt="" aria-hidden="true" draggable="false">
              <div class="search-catalog" style="${catalogStyle}">
                <div class="search-catalog__surface search-catalog__surface--query" data-scene-surface="${queryLedger.id}" style="${surfaceStyle(queryLedger, config.surfaceRegistry.catalogBounds)}">
                  <section class="search-catalog__plane search-catalog__plane--query">
                    <div class="search-catalog__ink search-catalog__ink--query" data-scene-surface-layer="ink">
                      <header class="search-catalog__heading"><div><h2 id="search-catalog-title">在理解里查找</h2><p>只检索服务端公开 Objective 与来源标签</p></div><span>6 份索引</span></header>
                      <label class="search-field"><span class="sr-only">搜索公开理解目标</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input type="search" value="" placeholder="输入概念、问题或来源…"><kbd>↵</kbd></label>
                    </div>
                    <span class="search-catalog__occluder search-catalog__occluder--query" data-scene-surface-layer="occluder" aria-hidden="true"></span>
                  </section>
                </div>
                <div class="search-catalog__surface search-catalog__surface--upper" data-scene-surface="${upperShelf.id}" style="${surfaceStyle(upperShelf, config.surfaceRegistry.catalogBounds)}">
                  <section class="search-catalog__plane search-catalog__plane--shelf" aria-label="最近整理内容上层"><div class="search-catalog__ink search-catalog__ink--shelf" data-scene-surface-layer="ink"><div class="search-shelf__items">${cardMarkup(cards.slice(0, 2), 0)}</div></div><span class="search-catalog__occluder search-catalog__occluder--shelf" data-scene-surface-layer="occluder" aria-hidden="true"></span></section>
                </div>
                <div class="search-catalog__surface search-catalog__surface--lower" data-scene-surface="${lowerShelf.id}" style="${surfaceStyle(lowerShelf, config.surfaceRegistry.catalogBounds)}">
                  <section class="search-catalog__plane search-catalog__plane--shelf" aria-label="最近整理内容下层"><div class="search-catalog__ink search-catalog__ink--shelf" data-scene-surface-layer="ink"><div class="search-shelf__items">${cardMarkup(cards.slice(2), 2)}</div></div><span class="search-catalog__occluder search-catalog__occluder--shelf" data-scene-surface-layer="occluder" aria-hidden="true"></span></section>
                </div>
                <footer class="search-catalog__surface search-catalog__surface--boundary" data-scene-surface="${boundarySlip.id}" style="${surfaceStyle(boundarySlip, config.surfaceRegistry.catalogBounds)}"><div class="search-catalog__boundary-plane"><p data-scene-surface-layer="ink">公开索引</p></div></footer>
              </div>
            </div>
          </section>
        </div>
      </main>
      ${config.showFixtureLabel ? '<p class="search-layout-fixture__label">LAYOUT FIXTURE · 非产品数据 · 非真实旅程证据</p>' : ''}
    `

    let style = document.querySelector('style[data-search-layout-fixture="v1"]')
    if (!(style instanceof HTMLStyleElement)) {
      style = document.createElement('style')
      style.dataset.searchLayoutFixture = 'v1'
      style.textContent = `
        html, body, #root { width: 100%; height: 100%; margin: 0; }
        body { overflow: hidden; }
        .search-layout-fixture { position: relative; width: 100vw; height: 100vh; overflow: hidden; background: #261b14; }
        .search-layout-fixture__room { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .search-layout-fixture__label { position: fixed; z-index: 100; right: 10px; bottom: 8px; margin: 0; padding: 5px 8px; color: rgba(255,247,234,.8); font-size: 9px; letter-spacing: .03em; border: 1px solid rgba(255,247,234,.18); border-radius: 999px; background: rgba(35,25,19,.78); pointer-events: none; }
      `
      document.head.append(style)
    }

    const currentFixture = document.querySelector('.search-layout-fixture')
    if (currentFixture) currentFixture.replaceWith(fixture)
    else document.querySelector('#root')?.replaceWith(fixture)
  }, {
  ...fixtureCase,
    backplate: backplates[fixtureCase.theme],
    foreground: foregrounds[fixtureCase.theme],
    showFixtureLabel,
    surfaceRegistry,
  })

  await window.waitForFunction(() => [...document.querySelectorAll('.search-layout-fixture img')].every((image) => (
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
      projection.style.setProperty('--scene-surface-projection', `matrix3d(${h11}, ${h21}, 0, ${h31}, ${h12}, ${h22}, 0, ${h32}, 0, 0, 1, 0, ${h13}, ${h23}, 0, ${h33})`)
      projection.dataset.sceneSurfaceProjection = 'projected'
    }
  }, surfaceRegistry)
}

const readLayout = (window) => window.evaluate(() => {
  const fixture = document.querySelector('.search-layout-fixture')
  const task = document.querySelector('.task-surface--search')
  const referenceFrame = document.querySelector('.search-catalog-reference-frame')
  const catalog = document.querySelector('.search-catalog')
  const legacyShelfObject = document.querySelector('.search-catalog__shelf')
  const foreground = document.querySelector('.search-catalog__foreground')
  const querySurface = document.querySelector('.search-catalog__surface--query')
  const upperSurface = document.querySelector('.search-catalog__surface--upper')
  const lowerSurface = document.querySelector('.search-catalog__surface--lower')
  const boundarySurface = document.querySelector('.search-catalog__surface--boundary')
  const searchField = document.querySelector('.search-field')
  const input = document.querySelector('.search-field input')
  const primaryCard = document.querySelector('.search-index-card:not(:disabled)')
  const returnButton = document.querySelector('.search-catalog__return')
  const room = document.querySelector('.search-layout-fixture__room')
  const registeredSurfaces = [...document.querySelectorAll('[data-scene-surface]')]
  const materialLayers = [...document.querySelectorAll('.search-catalog [data-scene-surface-layer="material"]')]
  const occluderLayers = [...document.querySelectorAll('.search-catalog [data-scene-surface-layer="occluder"]')]
  const rect = (node) => node instanceof HTMLElement
    ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [key, node.getBoundingClientRect()[key]]))
    : null
  const hit = (node) => {
    const bounds = node?.getBoundingClientRect()
    if (!(node instanceof HTMLElement) || !bounds) return false
    return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button, input') === node
  }
  const focusSnapshot = (node) => {
    if (!(node instanceof HTMLElement)) return { rect: null, hit: false, focus: false }
    node.scrollIntoView({ block: 'center', inline: 'nearest' })
    node.focus({ preventScroll: true })
    return { rect: rect(node), hit: hit(node), focus: document.activeElement === node }
  }
  const initialRects = {
    query: rect(querySurface),
    upper: rect(upperSurface),
    lower: rect(lowerSurface),
    boundary: rect(boundarySurface),
  }
  const domSurfaceFills = Object.fromEntries([
    ['queryPlane', document.querySelector('.search-catalog__plane--query')],
    ['shelfPlane', document.querySelector('.search-catalog__plane--shelf')],
    ['searchField', document.querySelector('.search-field')],
    ['primaryCard', primaryCard],
    ['boundaryPlane', document.querySelector('.search-catalog__boundary-plane')],
  ].map(([key, node]) => {
    if (!(node instanceof HTMLElement)) return [key, null]
    const style = getComputedStyle(node)
    return [key, { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage }]
  }))
  const inputState = focusSnapshot(input)
  const primaryCardState = focusSnapshot(primaryCard)
  const returnButtonState = focusSnapshot(returnButton)
  const returnButtonBackgroundColor = returnButton instanceof HTMLElement
    ? getComputedStyle(returnButton).backgroundColor
    : null
  if (task instanceof HTMLElement) task.scrollTop = 0
  const fontSize = (selector) => {
    const node = document.querySelector(selector)
    const value = node ? Number.parseFloat(getComputedStyle(node).fontSize) : NaN
    return Number.isFinite(value) ? value : null
  }
  const internalVerticalScrollers = referenceFrame instanceof HTMLElement
    ? [referenceFrame, ...referenceFrame.querySelectorAll('*')].filter((node) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      return node.scrollHeight > node.clientHeight + 1 && ['auto', 'scroll'].includes(style.overflowY)
    }).map((node) => node.className)
    : []
  const cardStyle = primaryCard instanceof HTMLElement ? getComputedStyle(primaryCard) : null
  const cardTransformOriginY = cardStyle ? Number.parseFloat(cardStyle.transformOrigin.split(/\s+/)[1] ?? '') : null
  const cardOffsetHeight = primaryCard instanceof HTMLElement ? primaryCard.offsetHeight : null
  const previousMotionMode = task instanceof HTMLElement ? task.getAttribute('data-motion-mode') : null
  if (task instanceof HTMLElement) task.dataset.motionMode = 'off'
  const offCardTransitionDuration = primaryCard instanceof HTMLElement ? getComputedStyle(primaryCard).transitionDuration : null
  if (task instanceof HTMLElement) {
    if (previousMotionMode === null) delete task.dataset.motionMode
    else task.setAttribute('data-motion-mode', previousMotionMode)
  }

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
    catalog: rect(catalog),
    surfaces: initialRects,
    searchField: rect(searchField),
    input: inputState,
    primaryCard: primaryCardState,
    cardMotion: {
      transitionProperty: cardStyle?.transitionProperty ?? null,
      transitionDuration: cardStyle?.transitionDuration ?? null,
      transformOrigin: cardStyle?.transformOrigin ?? null,
      transformOriginY: cardTransformOriginY,
      offsetHeight: cardOffsetHeight,
      offTransitionDuration: offCardTransitionDuration,
    },
    returnButton: { ...returnButtonState, backgroundColor: returnButtonBackgroundColor },
    legacyShelfPresent: Boolean(legacyShelfObject),
    surfaceLayers: {
      materialCount: materialLayers.length,
      materialOpacity: materialLayers.map((node) => Number.parseFloat(getComputedStyle(node).opacity)),
      occluderCount: occluderLayers.length,
      occluderDisplay: occluderLayers.map((node) => getComputedStyle(node).display),
    },
    domSurfaceFills,
    foreground: foreground instanceof HTMLImageElement ? {
      source: foreground.getAttribute('src'),
      naturalWidth: foreground.naturalWidth,
      naturalHeight: foreground.naturalHeight,
      display: getComputedStyle(foreground).display,
      opacity: Number.parseFloat(getComputedStyle(foreground).opacity),
      ready: fixture instanceof HTMLElement && fixture.querySelector('.search-catalog-workbench')?.getAttribute('data-search-foreground') === 'ready',
    } : null,
    surfaceProjections: registeredSurfaces.map((node) => node instanceof HTMLElement ? {
      id: node.dataset.sceneSurface ?? null,
      state: node.dataset.sceneSurfaceProjection ?? null,
      transform: getComputedStyle(node).transform,
    } : null),
    internalVerticalScrollers,
    fontStatus: document.fonts?.status ?? 'unavailable',
    fontFacesReady: {
      sans: document.fonts?.check('400 16px "Noto Sans SC Variable"') ?? false,
      serif: document.fonts?.check('400 16px "Noto Serif SC Variable"') ?? false,
    },
    fontSizes: {
      input: fontSize('.search-field input'),
      card: fontSize('.search-index-card__copy strong'),
      boundary: fontSize('.search-catalog__boundary-plane p'),
    },
    backplate: room instanceof HTMLImageElement ? { source: room.getAttribute('src'), naturalWidth: room.naturalWidth, naturalHeight: room.naturalHeight } : null,
  }
})

const readCardInteraction = (window) => window.evaluate(() => {
  const card = document.querySelector('.search-index-card:not(:disabled)')
  if (!(card instanceof HTMLElement)) return null
  const style = getComputedStyle(card)
  return {
    transform: style.transform,
    hovered: card.matches(':hover'),
    active: card.matches(':active'),
  }
})

const assertLayout = (layout, fixtureCase) => {
  const expectedIds = Object.values(surfaceRegistry.surfaces).map((surface) => surface.id).sort()
  const actualIds = layout.surfaceProjections.map((surface) => surface?.id).filter(Boolean).sort()
  if (!layout.task || !layout.referenceFrame || !layout.catalog || !layout.surfaces.query || !layout.surfaces.upper || !layout.surfaces.lower || !layout.surfaces.boundary || !layout.searchField || !layout.input.rect || !layout.primaryCard.rect) {
    throw new Error(`Search V1 fixture is incomplete: ${JSON.stringify(layout)}`)
  }
  if (layout.fixtureId !== fixtureCase.fixtureId || layout.theme !== fixtureCase.theme || layout.coordinateSpace !== surfaceRegistry.coordinateSpace.id) {
    throw new Error(`Search V1 fixture metadata drifted: ${JSON.stringify(layout)}`)
  }
  if (fixtureCase.cssViewportWidth && Math.abs((layout.viewport?.width ?? 0) - fixtureCase.cssViewportWidth) > 1) {
    throw new Error(`Search fixture did not capture the requested CSS viewport width: ${JSON.stringify(layout)}`)
  }
  if (layout.legacyShelfPresent) {
    throw new Error(`Search fixture still mounts the rejected standalone shelf overlay: ${JSON.stringify(layout)}`)
  }
  if (layout.surfaceLayers.materialCount !== 0 || layout.surfaceLayers.occluderCount !== 3 || Object.values(layout.domSurfaceFills).some((fill) => !fill || fill.backgroundColor !== 'rgba(0, 0, 0, 0)' || fill.backgroundImage !== 'none')) {
    throw new Error(`Search fixture did not keep DOM surfaces ink-only and preserve the foreground layer slice: ${JSON.stringify(layout)}`)
  }
  if (!layout.cardMotion || !layout.cardMotion.transitionProperty.includes('transform') || !Number.isFinite(layout.cardMotion.transformOriginY) || !Number.isFinite(layout.cardMotion.offsetHeight) || Math.abs(layout.cardMotion.transformOriginY - layout.cardMotion.offsetHeight) > 1 || layout.cardMotion.offTransitionDuration !== '0s') {
    throw new Error(`Search fixture did not preserve the card-level motion ownership contract: ${JSON.stringify(layout)}`)
  }
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds) || layout.surfaceProjections.length !== expectedIds.length) {
    throw new Error(`Search fixture did not mount all four registered surfaces: ${JSON.stringify(layout)}`)
  }
  if (!layout.input.hit || !layout.input.focus || !layout.primaryCard.hit || !layout.primaryCard.focus || !layout.returnButton.hit || !layout.returnButton.focus) {
    throw new Error(`Search fixture has a broken transformed input, result action or return control: ${JSON.stringify(layout)}`)
  }
  if (layout.document.scrollWidth > layout.document.clientWidth + 1 || (layout.task.scrollWidth > layout.task.clientWidth + 1 && layout.task.overflowX !== 'hidden')) {
    throw new Error(`Search fixture has visible horizontal overflow: ${JSON.stringify(layout)}`)
  }
  if (fixtureCase.compact) {
    if (layout.surfaceProjections.some((surface) => surface?.state !== 'flat' || surface.transform !== 'none')) {
      throw new Error(`Compact Search did not flatten every registered surface: ${JSON.stringify(layout)}`)
    }
    if (layout.task.overflowY !== 'auto' || layout.internalVerticalScrollers.length) {
      throw new Error(`Compact Search did not keep one scroll root: ${JSON.stringify(layout)}`)
    }
    if (!layout.returnButton.backgroundColor?.startsWith('rgb(') || layout.returnButton.rect.width > 48 || layout.returnButton.rect.height > 48) {
      throw new Error(`Compact Search return control is too large or translucent over scrolling content: ${JSON.stringify(layout)}`)
    }
    if (layout.searchField.height < 44 || layout.primaryCard.rect.height < 44) {
      throw new Error(`Compact Search input or primary result card is below the 44px hit target: ${JSON.stringify(layout)}`)
    }
    if (layout.foreground?.display !== 'none' || layout.surfaceLayers.occluderDisplay.some((display) => display !== 'none')) {
      throw new Error(`Compact Search kept a realistic foreground layer in the flat fallback: ${JSON.stringify(layout)}`)
    }
    if (layout.surfaces.query.bottom > layout.surfaces.upper.top || layout.surfaces.upper.bottom > layout.surfaces.lower.top || layout.surfaces.lower.bottom > layout.surfaces.boundary.top) {
      throw new Error(`Compact Search did not preserve query-to-results reading order: ${JSON.stringify(layout)}`)
    }
  } else {
    if (layout.surfaceProjections.some((surface) => surface?.state !== 'projected' || !surface.transform.startsWith('matrix3d('))) {
      throw new Error(`Desktop Search did not project every registered surface: ${JSON.stringify(layout)}`)
    }
    if (layout.input.rect.top < 0 || layout.input.rect.bottom > layout.viewport.height || layout.primaryCard.rect.top < 0 || layout.primaryCard.rect.bottom > layout.viewport.height) {
      throw new Error(`Desktop Search clipped a primary control: ${JSON.stringify(layout)}`)
    }
    if (layout.surfaceLayers.materialCount !== 0 || !layout.foreground || !layout.foreground.ready || layout.foreground.display === 'none' || layout.foreground.opacity <= 0 || layout.foreground.source !== foregrounds[fixtureCase.theme] || layout.foreground.naturalWidth !== 1672 || layout.foreground.naturalHeight !== 941 || layout.surfaceLayers.occluderDisplay.some((display) => display !== 'none')) {
      throw new Error(`Desktop Search did not expose the registered transparent foreground layer: ${JSON.stringify(layout)}`)
    }
  }
  if (layout.fontStatus !== 'loaded' || !layout.fontFacesReady.sans || !layout.fontFacesReady.serif) {
    throw new Error(`Search fixture did not resolve bundled fonts: ${JSON.stringify(layout)}`)
  }
  if ((layout.fontSizes.input ?? 0) < 13 || (layout.fontSizes.card ?? 0) < 11 || (layout.fontSizes.boundary ?? 0) < 8) {
    throw new Error(`Search fixture dropped copy below the agreed floor: ${JSON.stringify(layout)}`)
  }
  const expectedBackplate = backplates[fixtureCase.theme]
  if (!layout.backplate || layout.backplate.source !== expectedBackplate || layout.backplate.naturalWidth !== 1672 || layout.backplate.naturalHeight !== 941) {
    throw new Error(`Search fixture did not use the registered ${fixtureCase.theme} backplate: ${JSON.stringify(layout)}`)
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
    await window.waitForTimeout(250)
    const layout = await readLayout(window)
    await window.evaluate(() => {
      const task = document.querySelector('.task-surface--search')
      if (task instanceof HTMLElement) task.scrollTop = 0
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    const outputName = showFixtureLabel ? fixtureCase.output : fixtureCase.output.replace(/\.png$/, '-preview.png')
    const outputPath = resolve(reviewRoot, outputName)
    await window.screenshot({ path: outputPath })
    await window.mouse.move(1, 1)
    const restingCard = await readCardInteraction(window)
    await window.locator('.search-index-card:not(:disabled)').first().hover()
    await window.waitForTimeout(220)
    const hoveredCard = await readCardInteraction(window)
    await window.mouse.down()
    // Sample after the authored 90ms press transition so the contract reads
    // the settled active transform instead of a browser-dependent mid-frame.
    await window.waitForTimeout(120)
    const pressedCard = await readCardInteraction(window)
    await window.mouse.up()
    await window.mouse.move(1, 1)
    let assertion = { passed: true }
    try {
      assertLayout(layout, fixtureCase)
      if (!restingCard || !hoveredCard || !hoveredCard.hovered || restingCard.transform === hoveredCard.transform || hoveredCard.transform === 'none') {
        throw new Error(`Search fixture did not expose a real hover lift on the active card: ${JSON.stringify({ restingCard, hoveredCard })}`)
      }
      if (!pressedCard || !pressedCard.active || pressedCard.transform === hoveredCard.transform || pressedCard.transform === 'none') {
        throw new Error(`Search fixture did not expose a real press response on the active card: ${JSON.stringify({ hoveredCard, pressedCard })}`)
      }
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
      interaction: {
        restingCard,
        hoveredCard,
        pressedCard,
      },
      layout,
    }
  }

  const metadataPath = resolve(reviewRoot, 'layout-harness-search-v1.json')
  await writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    evidenceClass: 'LAYOUT_FIXTURE_ONLY',
    visualLabel: showFixtureLabel ? 'evidence' : 'search-preview-without-label',
    productData: false,
    realJourneyEvidence: false,
    backplates,
    foregrounds,
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
  console.log(`Captured Search V1 layout fixtures and metadata in ${reviewRoot}`)
  if (assertionFailures.length) throw new Error(`Search V1 layout assertions failed: ${JSON.stringify(assertionFailures)}`)
} finally {
  await electronApp.close()
}
