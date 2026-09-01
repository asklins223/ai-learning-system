import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const reviewRoot = resolve(appRoot, '../../.impeccable/review')
const surfaceRegistry = JSON.parse(await readFile(
  resolve(appRoot, 'src/renderer/src/scene/notebook-surfaces.json'),
  'utf8',
))
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const showFixtureLabel = process.env.NOTEBOOK_LAYOUT_FIXTURE_LABEL !== '0'

const backplates = {
  day: '/assets/learning-room/v1/posters/study-seat-day-v2.png',
  night: '/assets/learning-room/v1/posters/study-seat-night-v2.png',
}

const fixtureCases = [
  {
    key: 'desktopDay',
    fixtureId: 'notebook-v1-desktop-day',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 1,
    compact: false,
    output: 'layout-harness-notebook-v1-1440x810-day.png',
  },
  {
    key: 'minimumNight',
    fixtureId: 'notebook-v1-minimum-night',
    theme: 'night',
    width: 1024,
    height: 700,
    zoomFactor: 1,
    compact: false,
    output: 'layout-harness-notebook-v1-1024x700-night.png',
  },
  {
    key: 'compactZoom200',
    fixtureId: 'notebook-v1-zoom-200',
    theme: 'day',
    width: 1440,
    height: 810,
    zoomFactor: 2,
    compact: true,
    output: 'layout-harness-notebook-v1-zoom-200-compact.png',
  },
  {
    key: 'compact320CssZoom200',
    fixtureId: 'notebook-v1-320-css-px',
    theme: 'night',
    width: 640,
    height: 810,
    zoomFactor: 2,
    compact: true,
    cssViewportWidth: 320,
    output: 'layout-harness-notebook-v1-320-css-px-zoom-200.png',
  },
]

await mkdir(reviewRoot, { recursive: true })
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-notebook-layout-'))
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
    const editorSurface = config.surfaceRegistry.surfaces.editorPage
    const actionSurface = config.surfaceRegistry.surfaces.actionPage
    const sourceSurface = config.surfaceRegistry.surfaces.sourceSlip
    const referenceStyle = `--scene-world-aspect:${worldBounds.width / worldBounds.height}`

    const fixture = document.createElement('div')
    fixture.className = 'notebook-layout-fixture'
    fixture.dataset.theme = config.theme
    fixture.dataset.fixtureId = config.fixtureId
    fixture.innerHTML = `
      <img class="notebook-layout-fixture__room" src="${config.backplate}" alt="" aria-hidden="true">
      <main class="task-surface task-surface--notebook">
        <div class="surface-content task-surface__spatial-layer">
          <section class="notebook-object-surface notebook-editor-workbench task-artifact task-artifact--notebook notebook-editor-workbench--ready" aria-labelledby="notebook-surface-title">
            <h2 id="notebook-surface-title" class="sr-only">研究册</h2>
            <button class="surface-return-control notebook-editor__bookmark" type="button" aria-label="关闭任务面并返回书房" data-surface-initial-focus="true">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></svg>
              <span>返回书房</span>
            </button>
            <div
              class="scene-reference-frame notebook-editor-reference-frame"
              data-scene-coordinate-space="${config.surfaceRegistry.coordinateSpace.id}"
              data-scene-fit="${config.surfaceRegistry.coordinateSpace.fitMode}"
              style="${referenceStyle}"
            >
              <div class="notebook-editor" style="${notebookStyle}">
                <img
                  class="notebook-editor__object"
                  src="/assets/learning-room/v1/objects/study-open-notebook-v1.png"
                  data-scene-surface-base="true"
                  alt=""
                  aria-hidden="true"
                >
                <div
                  class="notebook-editor__surface notebook-editor__surface--editor"
                  data-scene-surface="${editorSurface.id}"
                  style="${surfaceStyle(editorSurface, config.surfaceRegistry.notebookBounds)}"
                >
                  <article class="notebook-editor__page notebook-editor__page--editor">
                    <div class="notebook-editor__ink notebook-editor__ink--editor" data-scene-surface-layer="ink">
                      <header class="notebook-editor__page-heading"><strong>研究册</strong><span>版本 7</span></header>
                      <label class="notebook-title-field"><span>标题</span><input value="受激辐射与增益介质" aria-label="笔记标题"></label>
                      <textarea aria-label="真实笔记内容" spellcheck="true">受激辐射发生在处于激发态的粒子受到同频光子作用时。

新产生的光子与入射光子频率、相位和传播方向一致，因此可形成相干放大。

增益介质提供粒子数反转，谐振腔让光多次往返并积累增益。</textarea>
                      <div class="selection-preview" role="status"><span>选择文字用于阅读定位；生成始终使用服务端确认的整篇版本。</span></div>
                    </div>
                    <span class="notebook-editor__material notebook-editor__material--left" data-scene-surface-layer="material" aria-hidden="true"></span>
                  </article>
                </div>
                <div
                  class="notebook-editor__surface notebook-editor__surface--actions"
                  data-scene-surface="${actionSurface.id}"
                  style="${surfaceStyle(actionSurface, config.surfaceRegistry.notebookBounds)}"
                >
                  <section class="notebook-editor__page notebook-editor__page--actions">
                    <div class="notebook-editor__ink notebook-editor__ink--actions" data-scene-surface-layer="ink">
                      <header class="notebook-editor__action-heading"><span>服务端回执</span><strong role="status">已同步</strong></header>
                      <div class="notebook-editor__source-space" aria-hidden="true"></div>
                      <p class="notebook-editor__generation-scope">Card Generation 使用服务端确认的整篇笔记版本；未提交编辑不会进入生成任务。</p>
                      <div class="notebook-actions">
                        <button type="button" class="surface-secondary" disabled>提交笔记编辑</button>
                        <button type="button" class="surface-primary"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m12 3-1.9 5.1L5 10l5.1 1.9L12 17l1.9-5.1L19 10l-5.1-1.9L12 3Z"/></svg>根据整篇笔记生成学习卡</button>
                      </div>
                    </div>
                    <span class="notebook-editor__material notebook-editor__material--right" data-scene-surface-layer="material" aria-hidden="true"></span>
                  </section>
                </div>
                <aside
                  class="notebook-editor__source-slip notebook-editor__surface"
                  data-scene-surface="${sourceSurface.id}"
                  style="${surfaceStyle(sourceSurface, config.surfaceRegistry.notebookBounds)}"
                  aria-label="笔记来源版本"
                >
                  <div class="notebook-editor__source-plane">
                    <div class="note-provenance-slip" data-scene-surface-layer="ink"><strong>来源版本</strong><p>该笔记关联了服务端来源。</p><small>整篇笔记 · 版本 7</small></div>
                    <span class="notebook-editor__source-material" data-scene-surface-layer="material" aria-hidden="true"></span>
                  </div>
                </aside>
                <span class="notebook-editor__spine" data-scene-surface-layer="occluder" aria-hidden="true"></span>
              </div>
            </div>
            <p class="prototype-note notebook-editor__provenance">布局夹具使用合成内容；真实笔记、保存回执与生成任务仍由主进程合同提供。</p>
          </section>
        </div>
      </main>
      ${config.showFixtureLabel ? '<p class="notebook-layout-fixture__label">LAYOUT FIXTURE · 非产品数据 · 非真实旅程证据</p>' : ''}
    `

    let style = document.querySelector('style[data-notebook-layout-fixture="v1"]')
    if (!(style instanceof HTMLStyleElement)) {
      style = document.createElement('style')
      style.dataset.notebookLayoutFixture = 'v1'
      style.textContent = `
        html, body, #root { width: 100%; height: 100%; margin: 0; }
        body { overflow: hidden; }
        .notebook-layout-fixture { position: relative; width: 100vw; height: 100vh; overflow: hidden; background: #261b14; }
        .notebook-layout-fixture__room { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .notebook-layout-fixture__label { position: fixed; z-index: 100; right: 10px; bottom: 8px; margin: 0; padding: 5px 8px; color: rgba(255,247,234,.8); font-size: 9px; letter-spacing: .03em; border: 1px solid rgba(255,247,234,.18); border-radius: 999px; background: rgba(35,25,19,.78); pointer-events: none; }
      `
      document.head.append(style)
    }

    const currentFixture = document.querySelector('.notebook-layout-fixture')
    if (currentFixture) currentFixture.replaceWith(fixture)
    else document.querySelector('#root')?.replaceWith(fixture)
  }, {
    ...fixtureCase,
    backplate: backplates[fixtureCase.theme],
    showFixtureLabel,
    surfaceRegistry,
  })

  await window.waitForFunction(() => [...document.querySelectorAll('.notebook-layout-fixture img')].every((image) => (
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
  const fixture = document.querySelector('.notebook-layout-fixture')
  const task = document.querySelector('.task-surface--notebook')
  const referenceFrame = document.querySelector('.notebook-editor-reference-frame')
  const notebook = document.querySelector('.notebook-editor')
  const notebookObject = document.querySelector('.notebook-editor__object')
  const editorPage = document.querySelector('.notebook-editor__surface--editor')
  const actionPage = document.querySelector('.notebook-editor__surface--actions')
  const sourceSlip = document.querySelector('.notebook-editor__source-slip')
  const titleInput = document.querySelector('.notebook-title-field input')
  const editor = document.querySelector('.notebook-editor__ink textarea')
  const primaryAction = document.querySelector('.notebook-actions .surface-primary')
  const returnButton = document.querySelector('.notebook-editor__bookmark')
  const room = document.querySelector('.notebook-layout-fixture__room')
  const registeredSurfaces = [...document.querySelectorAll('[data-scene-surface]')]
  const rect = (node) => node instanceof HTMLElement
    ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [key, node.getBoundingClientRect()[key]]))
    : null
  const hit = (node) => {
    const bounds = node?.getBoundingClientRect()
    if (!(node instanceof HTMLElement) || !bounds) return false
    return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button, input, textarea') === node
  }
  const fontSize = (selector) => {
    const node = document.querySelector(selector)
    const value = node ? Number.parseFloat(getComputedStyle(node).fontSize) : NaN
    return Number.isFinite(value) ? value : null
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
      if (!(node instanceof HTMLElement) || node instanceof HTMLTextAreaElement) return false
      const style = getComputedStyle(node)
      return node.scrollHeight > node.clientHeight + 1 && ['auto', 'scroll'].includes(style.overflowY)
    }).map((node) => node.className)
    : []
  const focusSnapshot = (node) => {
    if (!(node instanceof HTMLElement)) return { rect: null, hit: false, focus: false }
    node.focus()
    return { rect: rect(node), hit: hit(node), focus: document.activeElement === node }
  }
  const titleInputState = focusSnapshot(titleInput)
  const editorState = focusSnapshot(editor)
  const primaryActionState = focusSnapshot(primaryAction)
  const returnButtonState = focusSnapshot(returnButton)
  const returnButtonBackgroundColor = returnButton instanceof HTMLElement
    ? getComputedStyle(returnButton).backgroundColor
    : null

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
    editorPage: rect(editorPage),
    actionPage: rect(actionPage),
    sourceSlip: rect(sourceSlip),
    titleInput: titleInputState,
    editor: editorState,
    primaryAction: primaryActionState,
    returnButton: { ...returnButtonState, backgroundColor: returnButtonBackgroundColor },
    domSurfaceFills: [
      surfaceFill('.notebook-editor__page--editor'),
      surfaceFill('.notebook-editor__page--actions'),
    ],
    domControlFills: [surfaceFill('.notebook-actions .surface-secondary')],
    objectDisplay: notebookObject instanceof HTMLElement ? getComputedStyle(notebookObject).display : null,
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
      editor: fontSize('.notebook-editor__ink textarea'),
      scope: fontSize('.notebook-editor__generation-scope'),
      button: fontSize('.notebook-actions .surface-primary'),
    },
    backplate: room instanceof HTMLImageElement
      ? { source: room.getAttribute('src'), naturalWidth: room.naturalWidth, naturalHeight: room.naturalHeight }
      : null,
    rawIdentityVisible: /\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(fixture?.textContent ?? ''),
  }
})

const assertLayout = (layout, fixtureCase) => {
  const expectedIds = Object.values(surfaceRegistry.surfaces).map((surface) => surface.id).sort()
  const actualIds = layout.surfaceProjections.map((surface) => surface?.id).filter(Boolean).sort()
  if (!layout.task || !layout.referenceFrame || !layout.notebook || !layout.editorPage || !layout.actionPage || !layout.sourceSlip || !layout.editor.rect || !layout.primaryAction.rect) {
    throw new Error(`Notebook V1 fixture is incomplete: ${JSON.stringify(layout)}`)
  }
  if (layout.fixtureId !== fixtureCase.fixtureId || layout.theme !== fixtureCase.theme || layout.coordinateSpace !== surfaceRegistry.coordinateSpace.id) {
    throw new Error(`Notebook V1 fixture metadata drifted: ${JSON.stringify(layout)}`)
  }
  if (fixtureCase.cssViewportWidth && Math.abs((layout.viewport?.width ?? 0) - fixtureCase.cssViewportWidth) > 1) {
    throw new Error(`Notebook fixture did not capture the requested CSS viewport width: ${JSON.stringify(layout)}`)
  }
  if (layout.rawIdentityVisible) {
    throw new Error(`Notebook V1 fixture exposed a raw identity: ${JSON.stringify(layout)}`)
  }
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds) || layout.surfaceProjections.length !== expectedIds.length) {
    throw new Error(`Notebook fixture did not mount all three registered surfaces: ${JSON.stringify(layout)}`)
  }
  if (!layout.titleInput.hit || !layout.editor.hit || !layout.titleInput.focus || !layout.editor.focus || !layout.primaryAction.hit || !layout.primaryAction.focus || !layout.returnButton.hit || !layout.returnButton.focus) {
    throw new Error(`Notebook fixture has a broken transformed input, focus target or action: ${JSON.stringify(layout)}`)
  }
  if (layout.document.scrollWidth > layout.document.clientWidth + 1 || (layout.task.scrollWidth > layout.task.clientWidth + 1 && layout.task.overflowX !== 'hidden')) {
    throw new Error(`Notebook fixture has visible horizontal overflow: ${JSON.stringify(layout)}`)
  }
  if (layout.internalVerticalScrollers.length) {
    throw new Error(`Notebook fixture created a nested layout scroller: ${JSON.stringify(layout)}`)
  }
  if (fixtureCase.compact) {
    if (layout.surfaceProjections.some((surface) => surface?.state !== 'flat' || surface.transform !== 'none')) {
      throw new Error(`Compact Notebook did not flatten every registered surface: ${JSON.stringify(layout)}`)
    }
    if (layout.objectDisplay !== 'none' || layout.task.overflowY !== 'auto' || layout.editorPage.bottom > layout.sourceSlip.top || layout.sourceSlip.bottom > layout.actionPage.top) {
      throw new Error(`Compact Notebook did not become one ordered paper flow: ${JSON.stringify(layout)}`)
    }
    if (!layout.returnButton.backgroundColor?.startsWith('rgb(')) {
      throw new Error(`Compact Notebook return control is translucent over scrolling ink: ${JSON.stringify(layout)}`)
    }
    if (layout.returnButton.rect.width > 48 || layout.returnButton.rect.height > 48) {
      throw new Error(`Compact Notebook return control is too large for the sticky rail: ${JSON.stringify(layout)}`)
    }
    if (layout.primaryAction.rect.height < 44) {
      throw new Error(`Compact Notebook primary action is below the 44px hit target: ${JSON.stringify(layout)}`)
    }
  } else {
    if (layout.surfaceProjections.some((surface) => surface?.state !== 'projected' || !surface.transform.startsWith('matrix3d('))) {
      throw new Error(`Desktop Notebook did not project every registered surface: ${JSON.stringify(layout)}`)
    }
    if (layout.domSurfaceFills.some((surface) => !surface || surface.backgroundColor !== 'rgba(0, 0, 0, 0)' || surface.backgroundImage !== 'none')) {
      throw new Error(`Desktop Notebook still paints a duplicate DOM page surface: ${JSON.stringify(layout)}`)
    }
    if (layout.domControlFills.some((surface) => !surface || surface.backgroundColor !== 'rgba(0, 0, 0, 0)' || surface.backgroundImage !== 'none')) {
      throw new Error(`Desktop Notebook still paints a secondary control surface: ${JSON.stringify(layout)}`)
    }
    if (layout.objectDisplay === 'none' || layout.primaryAction.rect.top < 0 || layout.primaryAction.rect.bottom > layout.viewport.height) {
      throw new Error(`Desktop Notebook lost its base or clipped the primary action: ${JSON.stringify(layout)}`)
    }
  }
  if (layout.fontStatus !== 'loaded' || !layout.fontFacesReady.sans || !layout.fontFacesReady.serif) {
    throw new Error(`Notebook fixture did not resolve bundled fonts: ${JSON.stringify(layout)}`)
  }
  if ((layout.fontSizes.editor ?? 0) < 13 || (layout.fontSizes.scope ?? 0) < 9 || (layout.fontSizes.button ?? 0) < 11) {
    throw new Error(`Notebook fixture dropped copy below the readability floor: ${JSON.stringify(layout)}`)
  }
  const expectedBackplate = backplates[fixtureCase.theme]
  if (!layout.backplate || layout.backplate.source !== expectedBackplate || layout.backplate.naturalWidth !== 1672 || layout.backplate.naturalHeight !== 941) {
    throw new Error(`Notebook fixture did not use the registered ${fixtureCase.theme} backplate: ${JSON.stringify(layout)}`)
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
      await window.evaluate(() => {
        const task = document.querySelector('.task-surface--notebook')
        if (task instanceof HTMLElement) task.scrollTop = task.scrollHeight
      })
    }
    await window.waitForTimeout(250)
    const layout = await readLayout(window)
    if (fixtureCase.compact) {
      await window.evaluate(() => {
        const task = document.querySelector('.task-surface--notebook')
        if (task instanceof HTMLElement) task.scrollTop = task.scrollHeight
      })
    }
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

  const metadataPath = resolve(reviewRoot, 'layout-harness-notebook-v1.json')
  await writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    evidenceClass: 'LAYOUT_FIXTURE_ONLY',
    visualLabel: showFixtureLabel ? 'evidence' : 'notebook-preview-without-label',
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
  console.log(`Captured Notebook V1 layout fixtures and metadata in ${reviewRoot}`)
  if (assertionFailures.length) {
    throw new Error(`Notebook V1 layout assertions failed: ${JSON.stringify(assertionFailures)}`)
  }
} finally {
  await electronApp.close()
}
