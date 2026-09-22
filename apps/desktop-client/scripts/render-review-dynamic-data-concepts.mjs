import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '../..')
const conceptRoot = resolve(repoRoot, '.impeccable/review/dynamic-data-concepts')
const assetRoot = resolve(conceptRoot, 'assets')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

const backgrounds = {
  ledger: resolve(assetRoot, 'review-ledger-blank-v1.png'),
  tape: resolve(assetRoot, 'review-tape-blank-v1.png'),
  rail: resolve(assetRoot, 'review-rail-blank-v1.png'),
}

const visibleStatus = (item) => item.startability.kind === 'ready' ? '可开始' : '仍在冷却期'
const item = (index, dueAt, ready) => ({
  version: 2,
  reviewId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  scheduleId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  objectiveId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  scheduleGeneration: 1 + ((index - 1) % 3),
  dueAt,
  startability: ready ? { kind: 'ready' } : { kind: 'blocked', reason: 'cooldown' },
})

const oneItems = [item(1, '2026-08-25T16:30:00+08:00', true)]
const eightTimes = ['08:20', '09:05', '10:15', '11:40', '13:10', '14:25', '16:00', '18:05']
const eightReady = [true, false, true, true, false, true, false, true]
const eightItems = eightTimes.map((time, index) => item(index + 1, `2026-08-25T${time}:00+08:00`, eightReady[index]))
const twentyRows = [
  ['2026-08-24T09:10:00+08:00', true], ['2026-08-24T10:30:00+08:00', false],
  ['2026-08-24T13:20:00+08:00', true], ['2026-08-24T15:45:00+08:00', true],
  ['2026-08-24T18:00:00+08:00', false], ['2026-08-24T20:15:00+08:00', true],
  ['2026-08-25T07:40:00+08:00', true], ['2026-08-25T08:15:00+08:00', false],
  ['2026-08-25T09:05:00+08:00', true], ['2026-08-25T09:50:00+08:00', true],
  ['2026-08-25T10:35:00+08:00', false], ['2026-08-25T11:20:00+08:00', true],
  ['2026-08-25T12:10:00+08:00', true], ['2026-08-25T13:00:00+08:00', false],
  ['2026-08-25T13:50:00+08:00', true], ['2026-08-25T14:40:00+08:00', true],
  ['2026-08-25T15:30:00+08:00', false], ['2026-08-25T16:20:00+08:00', true],
  ['2026-08-25T17:10:00+08:00', false], ['2026-08-25T18:05:00+08:00', true],
]
const twentyItems = twentyRows.map(([dueAt, ready], index) => item(index + 1, dueAt, ready))

const datasets = {
  one: { items: oneItems, nextCursor: null, selectedIndex: 0 },
  eight: { items: eightItems, nextCursor: null, selectedIndex: 2 },
  twenty: { items: twentyItems, nextCursor: '20', selectedIndex: 17 },
}

const dueParts = (dueAt) => {
  const match = dueAt.match(/-(\d{2})-(\d{2})T(\d{2}:\d{2})/)
  return { date: `${Number(match[1])}月${Number(match[2])}日`, time: match[3] }
}

const summary = (queue) => {
  const readyCount = queue.items.filter((entry) => entry.startability.kind === 'ready').length
  return queue.nextCursor
    ? `已载入 ${queue.items.length} 项 · ${readyCount} 项可开始`
    : `${queue.items.length} 项待复习 · ${readyCount} 项可开始`
}

const detailMarkup = (selected) => {
  const { date, time } = dueParts(selected.dueAt)
  const ready = selected.startability.kind === 'ready'
  return `
    <article class="review-detail" aria-label="当前选中的复习项目">
      <div class="review-detail__meta"><span>第 ${selected.index} 项</span><time datetime="${selected.dueAt}">${date} ${time}</time></div>
      <div class="review-detail__heading"><h2>${ready ? '三分钟巩固' : '这项还不能开始'}</h2><strong>${ready ? '现在可以开始' : '仍在冷却期'}</strong></div>
      <p class="review-detail__description">学习内容会在开始后显示，先完成一次不受提示干扰的独立回忆。</p>
      <footer><p>${ready ? '准备好后再开始，过程不会提前揭示目标。' : '到达允许时间后，这一项会自动变为可开始。'}</p>${ready ? '<button type="button">开始三分钟巩固 <span aria-hidden="true">→</span></button>' : ''}</footer>
    </article>
  `
}

const headingMarkup = (queue) => `
  <header class="scene-heading">
    <time datetime="2026-08-25T20:00:00+08:00">8月25日周二</time>
    <h1>今日复习</h1>
    <p>${summary(queue)}</p>
    ${queue.nextCursor ? '<small>当前队列还有更多到期项</small>' : ''}
  </header>
`

const returnMarkup = '<button class="return-control" type="button"><span aria-hidden="true">←</span><span>返回学习空间</span></button>'

const enrich = (queue) => ({
  ...queue,
  items: queue.items.map((entry, index) => ({ ...entry, index: index + 1 })),
})

const ledgerMarkup = (rawQueue) => {
  const queue = enrich(rawQueue)
  const pageSize = 4
  const selectedPage = Math.floor(queue.selectedIndex / pageSize)
  const pageCount = Math.max(1, Math.ceil(queue.items.length / pageSize))
  const visible = queue.items.slice(selectedPage * pageSize, selectedPage * pageSize + pageSize)
  const selected = queue.items[queue.selectedIndex]
  const rows = visible.map((entry) => {
    const { date, time } = dueParts(entry.dueAt)
    const selectedClass = entry.index === selected.index ? ' is-selected' : ''
    const readyClass = entry.startability.kind === 'ready' ? ' is-ready' : ' is-blocked'
    return `<li><button type="button" class="queue-line${selectedClass}${readyClass}" aria-selected="${entry.index === selected.index}"><span class="queue-line__index">${String(entry.index).padStart(2, '0')}</span><time datetime="${entry.dueAt}"><small>${date}</small>${time}</time><strong>${visibleStatus(entry)}</strong></button></li>`
  }).join('')
  return `
    ${returnMarkup}
    <section class="ledger-left" aria-label="复习队列">
      <header><div><time>8月25日周二</time><h1>今日复习</h1></div><p>${summary(queue)}</p></header>
      <ol>${rows}</ol>
      <footer><button type="button" ${selectedPage === 0 ? 'disabled' : ''}>← 上一页</button><span>第 ${selectedPage + 1} / ${pageCount} 页</span><button type="button" ${selectedPage === pageCount - 1 && !queue.nextCursor ? 'disabled' : ''}>${queue.nextCursor && selectedPage === pageCount - 1 ? '读取更多 →' : '下一页 →'}</button></footer>
    </section>
    <section class="ledger-right">${detailMarkup(selected)}</section>
    <p class="concept-label">CONCEPT FIXTURE · 合同字段数据 · 非实时账号旅程</p>
  `
}

const tapeMarkup = (rawQueue) => {
  const queue = enrich(rawQueue)
  const windowSize = 6
  const start = queue.items.length <= windowSize ? 0 : Math.min(Math.max(queue.selectedIndex - 3, 0), queue.items.length - windowSize)
  const visible = queue.items.slice(start, start + windowSize)
  const selected = queue.items[queue.selectedIndex]
  const rows = visible.map((entry) => {
    const { time } = dueParts(entry.dueAt)
    const selectedClass = entry.index === selected.index ? ' is-selected' : ''
    const stateClass = entry.startability.kind === 'ready' ? ' is-ready' : ' is-blocked'
    return `<li><button type="button" class="tape-line${selectedClass}${stateClass}" aria-selected="${entry.index === selected.index}"><span>${String(entry.index).padStart(2, '0')}</span><time datetime="${entry.dueAt}">${time}</time><strong>${visibleStatus(entry)}</strong></button></li>`
  }).join('')
  return `
    ${returnMarkup}${headingMarkup(queue)}
    <section class="tape-window" aria-label="复习队列">
      <div class="tape-window__position">${start + 1}–${start + visible.length} / 已载入 ${queue.items.length} 项</div>
      <ol>${rows}</ol>
      <footer>${queue.nextCursor && start + visible.length === queue.items.length ? '<button type="button">继续读取到期项 ↓</button>' : '<span>转动卷轴浏览队列</span>'}</footer>
    </section>
    <section class="notebook-detail notebook-detail--tape">${detailMarkup(selected)}</section>
    <p class="concept-label">CONCEPT FIXTURE · 合同字段数据 · 非实时账号旅程</p>
  `
}

const railMarkup = (rawQueue) => {
  const queue = enrich(rawQueue)
  const windowSize = 5
  const start = queue.items.length <= windowSize ? 0 : Math.min(Math.max(queue.selectedIndex - 2, 0), queue.items.length - windowSize)
  const visible = queue.items.slice(start, start + windowSize)
  const selected = queue.items[queue.selectedIndex]
  const rows = visible.map((entry) => {
    const { date, time } = dueParts(entry.dueAt)
    const selectedClass = entry.index === selected.index ? ' is-selected' : ''
    const stateClass = entry.startability.kind === 'ready' ? ' is-ready' : ' is-blocked'
    return `<li><button type="button" class="rail-stop${selectedClass}${stateClass}" aria-selected="${entry.index === selected.index}"><span>第 ${entry.index} 项</span><time datetime="${entry.dueAt}"><small>${date}</small>${time}</time><strong>${visibleStatus(entry)}</strong></button></li>`
  }).join('')
  return `
    ${returnMarkup}${headingMarkup(queue)}
    <section class="rail-window" aria-label="复习队列">
      <button class="rail-window__nav rail-window__nav--previous" type="button" ${start === 0 ? 'disabled' : ''} aria-label="上一组">←</button>
      <ol>${rows}</ol>
      <button class="rail-window__nav rail-window__nav--next" type="button" aria-label="下一组">→</button>
      <p>${start + 1}–${start + visible.length} / 已载入 ${queue.items.length} 项</p>
      ${queue.nextCursor && start + visible.length === queue.items.length ? '<button class="rail-window__more" type="button">读取更多</button>' : ''}
    </section>
    <section class="notebook-detail notebook-detail--rail">${detailMarkup(selected)}</section>
    <p class="concept-label">CONCEPT FIXTURE · 合同字段数据 · 非实时账号旅程</p>
  `
}

const styles = `
  :root { font-family: "Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: #34251b; text-rendering: optimizeLegibility; }
  * { box-sizing: border-box; }
  html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  body { background: #241811; }
  button { color: inherit; font: inherit; }
  button:focus-visible { outline: 3px solid #8f3518; outline-offset: 3px; }
  button:disabled { opacity: .38; }
  .concept { position: relative; width: 100vw; height: 100vh; overflow: hidden; isolation: isolate; }
  .concept__room { position: absolute; z-index: -2; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .concept::after { content: ""; position: absolute; z-index: -1; inset: 0; pointer-events: none; background: linear-gradient(90deg, rgba(40,25,16,.07), transparent 34%, transparent 80%, rgba(40,25,16,.025)); }
  .return-control { position: absolute; z-index: 20; top: 44px; left: 52px; display: inline-flex; align-items: center; gap: 9px; min-width: 126px; min-height: 46px; padding: 0 16px; color: #fff8ec; font-size: 14px; font-weight: 700; border: 1px solid rgba(255,248,236,.22); border-radius: 4px; background: rgba(48,32,23,.9); box-shadow: 0 12px 28px rgba(38,23,14,.22), 0 2px 7px rgba(38,23,14,.2); }
  .return-control > span:first-child { font-size: 18px; }
  .scene-heading { position: absolute; top: 270px; left: 205px; width: 300px; color: #35241a; text-shadow: 0 1px 0 rgba(255,245,222,.62), 0 4px 16px rgba(255,240,210,.3); }
  .scene-heading time { color: #93462a; font-size: 14px; font-weight: 760; letter-spacing: .035em; }
  .scene-heading h1 { margin: 4px 0 8px; font-family: "Noto Serif SC Variable", "Songti SC", serif; font-size: 44px; line-height: 1.08; letter-spacing: -.035em; }
  .scene-heading p { margin: 0; color: #4d392c; font-size: 14px; font-weight: 720; }
  .scene-heading small { display: block; margin-top: 5px; color: #745644; font-size: 12px; font-weight: 620; }
  .review-detail { color: #3f2e22; text-shadow: 0 1px rgba(255,255,255,.28); }
  .review-detail__meta { display: flex; align-items: center; justify-content: space-between; color: #6b4b36; font-size: 12px; font-weight: 740; font-variant-numeric: tabular-nums; }
  .review-detail__heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-top: 5px; }
  .review-detail__heading h2 { margin: 0; font-family: "Noto Serif SC Variable", "Songti SC", serif; font-size: 25px; line-height: 1.18; letter-spacing: -.025em; }
  .review-detail__heading strong { color: #416640; font-size: 12px; white-space: nowrap; }
  .review-detail__heading strong::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #557954; vertical-align: 1px; }
  .review-detail__description { margin: 7px 0 9px; color: #513d31; font-size: 12.5px; font-weight: 520; line-height: 1.5; }
  .review-detail footer { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 14px; padding-top: 8px; border-top: 1px solid rgba(78,53,36,.2); }
  .review-detail footer p { margin: 0; color: #6b5140; font-size: 11px; line-height: 1.45; }
  .review-detail footer button { min-height: 44px; padding: 0 15px; color: #fff8ed; font-size: 13px; font-weight: 760; white-space: nowrap; border: 1px solid rgba(103,42,20,.35); border-radius: 3px; background: #a94825; box-shadow: 0 9px 20px rgba(91,43,23,.23), 0 2px 5px rgba(91,43,23,.18); }
  .concept-label { position: absolute; right: 10px; bottom: 8px; margin: 0; padding: 4px 8px; color: rgba(255,247,234,.78); font-size: 9px; letter-spacing: .035em; border: 1px solid rgba(255,247,234,.17); border-radius: 999px; background: rgba(35,25,19,.76); }

  .concept--ledger .return-control { top: 44px; left: 52px; }
  .ledger-left { position: absolute; left: 300px; top: 552px; width: 378px; height: 181px; padding: 4px 16px 2px 18px; transform: rotate(.2deg); color: #3d2d22; }
  .ledger-left > header { display: flex; align-items: end; justify-content: space-between; gap: 12px; padding: 0 4px 7px 0; border-bottom: 1px solid rgba(79,56,39,.23); }
  .ledger-left > header div { display: flex; align-items: baseline; gap: 9px; }
  .ledger-left > header time { color: #944a2d; font-size: 10px; font-weight: 760; }
  .ledger-left > header h1 { margin: 0; font-family: "Noto Serif SC Variable", "Songti SC", serif; font-size: 25px; line-height: 1; }
  .ledger-left > header p { margin: 0; color: #654b3a; font-size: 9.5px; font-weight: 680; white-space: nowrap; }
  .ledger-left ol { display: grid; margin: 0; padding: 1px 0 0; list-style: none; }
  .ledger-left li { border-bottom: 1px solid rgba(77,54,37,.17); }
  .queue-line { display: grid; grid-template-columns: 28px 1fr 74px; align-items: center; width: 100%; min-height: 27px; padding: 0 4px 0 1px; text-align: left; border: 0; background: transparent; box-shadow: none; }
  .queue-line__index { color: #7a5c47; font-family: "Noto Serif SC Variable", "Songti SC", serif; font-size: 11px; font-weight: 760; font-variant-numeric: tabular-nums; }
  .queue-line time { display: flex; align-items: baseline; gap: 7px; color: #3f3025; font-size: 12px; font-weight: 720; font-variant-numeric: tabular-nums; }
  .queue-line time small { color: #745b49; font-size: 9px; font-weight: 620; }
  .queue-line strong { justify-self: end; color: #486a47; font-size: 10px; }
  .queue-line.is-blocked strong { color: #8d513b; }
  .queue-line.is-selected { transform: translateX(4px); }
  .queue-line.is-selected::before { content: ""; position: absolute; left: 8px; width: 3px; height: 20px; border-radius: 3px; background: #a94b29; }
  .ledger-left > footer { display: flex; align-items: center; justify-content: space-between; padding-top: 2px; color: #715744; font-size: 9.5px; }
  .ledger-left > footer button { min-height: 22px; padding: 0 4px; border: 0; background: transparent; font-size: 9.5px; font-weight: 700; }
  .ledger-right { position: absolute; left: 708px; top: 572px; width: 392px; height: 164px; padding: 6px 18px 4px 15px; transform: rotate(-.15deg); }

  .tape-window { position: absolute; left: 903px; top: 366px; width: 216px; height: 366px; padding: 8px 14px 5px; transform: rotate(.55deg); color: #3d2d22; }
  .tape-window__position { padding: 0 3px 6px; color: #745643; font-size: 9.5px; font-weight: 680; text-align: center; border-bottom: 1px solid rgba(83,56,37,.2); }
  .tape-window ol { display: grid; margin: 0; padding: 2px 0 0; list-style: none; }
  .tape-window li { border-bottom: 1px solid rgba(81,57,39,.16); }
  .tape-line { display: grid; grid-template-columns: 25px 1fr 74px; align-items: center; width: 100%; min-height: 43px; padding: 0 2px; text-align: left; border: 0; background: transparent; box-shadow: none; }
  .tape-line span { color: #7a5b46; font-family: "Noto Serif SC Variable", "Songti SC", serif; font-size: 11px; font-weight: 760; }
  .tape-line time { color: #35281f; font-size: 13px; font-weight: 760; font-variant-numeric: tabular-nums; }
  .tape-line strong { justify-self: end; color: #476947; font-size: 10px; white-space: nowrap; }
  .tape-line.is-blocked strong { color: #8b4d37; }
  .tape-line.is-selected { transform: translateX(4px); }
  .tape-line.is-selected::before { content: ""; position: absolute; left: 7px; width: 3px; height: 25px; border-radius: 3px; background: #a64a29; }
  .tape-window > footer { display: flex; justify-content: center; padding-top: 7px; color: #725744; font-size: 9.5px; }
  .tape-window > footer button { min-height: 30px; padding: 0 6px; color: #8c3f23; font-weight: 760; border: 0; background: transparent; }
  .notebook-detail { position: absolute; }
  .notebook-detail--tape { left: 291px; top: 576px; width: 390px; height: 146px; padding: 8px 17px 6px 21px; transform: rotate(.2deg); }
  .notebook-detail--tape .review-detail__heading h2 { font-size: 23px; }
  .notebook-detail--tape .review-detail__description { margin-block: 5px 6px; font-size: 12px; }
  .notebook-detail--tape .review-detail footer { padding-top: 5px; }
  .notebook-detail--rail { left: 226px; top: 580px; width: 381px; height: 142px; padding: 7px 15px 5px 17px; transform: rotate(.35deg); }
  .notebook-detail--rail .review-detail__heading h2 { font-size: 23px; }
  .notebook-detail--rail .review-detail__description { margin-block: 5px 6px; font-size: 12px; }
  .notebook-detail--rail .review-detail footer { padding-top: 5px; }

  .rail-window { position: absolute; left: 630px; top: 531px; width: 642px; height: 210px; }
  .rail-window ol { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; height: 135px; margin: 0; padding: 0 29px; list-style: none; }
  .rail-stop { position: relative; display: grid; place-items: center; align-content: end; gap: 2px; width: 100%; height: 116px; padding: 0 1px 11px; text-align: center; border: 0; background: transparent; box-shadow: none; text-shadow: 0 1px rgba(255,238,204,.7), 0 3px 9px rgba(70,42,20,.18); }
  .rail-stop::after { content: ""; position: absolute; bottom: -22px; width: 1px; height: 29px; background: rgba(83,50,25,.58); }
  .rail-stop span { color: #6d4e39; font-size: 10px; font-weight: 700; }
  .rail-stop time { display: grid; color: #33251c; font-family: "Noto Serif SC Variable", "Songti SC", serif; font-size: 17px; font-weight: 760; line-height: 1.05; font-variant-numeric: tabular-nums; }
  .rail-stop time small { margin-bottom: 2px; color: #755844; font-family: "Noto Sans SC Variable", "PingFang SC", sans-serif; font-size: 9px; font-weight: 680; }
  .rail-stop strong { color: #456845; font-size: 10px; }
  .rail-stop.is-blocked strong { color: #8b4d37; }
  .rail-stop.is-selected { transform: translateY(-8px); }
  .rail-stop.is-selected::after { bottom: -30px; height: 39px; width: 3px; border-radius: 3px; background: #a64b29; }
  .rail-window__nav { position: absolute; top: 98px; width: 44px; height: 44px; color: #fff5e4; font-size: 18px; border: 1px solid rgba(255,245,228,.19); border-radius: 50%; background: rgba(59,38,24,.86); box-shadow: 0 7px 16px rgba(42,25,15,.2); }
  .rail-window__nav--previous { left: -28px; }
  .rail-window__nav--next { right: -28px; }
  .rail-window > p { position: absolute; left: 50%; top: 160px; margin: 0; transform: translateX(-50%); color: #634735; font-size: 10.5px; font-weight: 690; text-shadow: 0 1px rgba(255,238,204,.7); }
  .rail-window__more { position: absolute; right: 44px; top: 158px; min-height: 32px; padding: 0 8px; color: #8d3e22; font-size: 10.5px; font-weight: 760; border: 0; background: transparent; }
`

const markupByScheme = { ledger: ledgerMarkup, tape: tapeMarkup, rail: railMarkup }

await mkdir(conceptRoot, { recursive: true })
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-review-dynamic-concepts-'))
const electronApp = await electron.launch({ args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`], cwd: appRoot, executablePath })

const toDataUrl = async (path) => `data:image/png;base64,${(await readFile(path)).toString('base64')}`
const manifest = { schemaVersion: 1, evidenceClass: 'CONCEPT_FIXTURE_ONLY', productData: false, realJourneyEvidence: false, frozenClock: '2026-08-25T20:00:00+08:00', renders: [] }

try {
  const window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0]
    target?.setMinimumSize(1, 1)
    target?.setContentSize(1440, 810)
    target?.center()
  })

  for (const [scheme, backgroundPath] of Object.entries(backgrounds)) {
    const backgroundUrl = await toDataUrl(backgroundPath)
    for (const [state, queue] of Object.entries(datasets)) {
      const markup = markupByScheme[scheme](queue)
      await window.evaluate(({ scheme, backgroundUrl, markup, styles }) => {
        document.documentElement.lang = 'zh-CN'
        const style = document.createElement('style')
        style.textContent = styles
        const fixture = document.createElement('main')
        fixture.id = 'root'
        fixture.className = `concept concept--${scheme}`
        fixture.innerHTML = `<img class="concept__room" src="${backgroundUrl}" alt="">${markup}`
        document.head.replaceChildren(style)
        document.body.replaceChildren(fixture)
      }, { scheme, backgroundUrl, markup, styles })
      await window.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))
      await window.evaluate(() => document.fonts?.ready)
      const filename = `review-${scheme}-${state}-data-v1.png`
      await window.screenshot({ path: resolve(conceptRoot, filename) })
      const layout = await window.evaluate(() => ({
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, clientHeight: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight },
        visibleText: document.body.innerText,
        buttons: [...document.querySelectorAll('button')].map((button) => ({ text: button.innerText, disabled: button.disabled, rect: Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [key, button.getBoundingClientRect()[key]])) })),
      }))
      const readyCount = queue.items.filter((entry) => entry.startability.kind === 'ready').length
      manifest.renders.push({ scheme, state, filename, itemCount: queue.items.length, readyCount, nextCursor: queue.nextCursor, selectedIndex: queue.selectedIndex + 1, layout })
    }
  }
  await writeFile(resolve(conceptRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`Rendered dynamic Review data concepts in ${conceptRoot}`)
} finally {
  await electronApp.close()
}
