import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '../..')
const outputRoot = resolve(repoRoot, '.impeccable/review/data-concepts')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

const backgrounds = {
  dial: '/Users/asklins/.codex/generated_images/01a03404-6464-7973-aa77-e2df37283358/exec-eb583ecb-b9ab-404f-9105-324fea1c6581.png',
  abacus: '/Users/asklins/.codex/generated_images/01a03404-6464-7973-aa77-e2df37283358/exec-36b98142-d330-4e6f-8600-b5a9922aaae3.png',
  stamps: '/Users/asklins/.codex/generated_images/01a03404-6464-7973-aa77-e2df37283358/exec-a63fe92d-a174-4fdb-b05e-f1b961510fef.png',
}

const toDataUrl = async (path) => `data:image/png;base64,${(await readFile(path)).toString('base64')}`

await mkdir(outputRoot, { recursive: true })
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-review-data-concepts-'))
const electronApp = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

const sharedMarkup = `
  <button class="return-control" type="button"><span aria-hidden="true">←</span><span>返回书房</span></button>
  <header class="scene-heading">
    <time datetime="2026-08-25T18:30:00+08:00">8月25日周二</time>
    <h1>今日复习</h1>
    <p><strong>3</strong> 项待复习 <span aria-hidden="true">·</span> <strong>2</strong> 项可开始</p>
  </header>
  <article class="notebook-detail" aria-label="当前选中的复习项目">
    <div class="notebook-detail__identity"><span>第 1 项</span><time datetime="2026-08-25T16:30:00+08:00">8月25日 16:30</time></div>
    <h2>三分钟巩固</h2>
    <p class="notebook-detail__state">现在可以开始</p>
    <p class="notebook-detail__description">学习内容会在开始后显示，先完成一次不受提示干扰的独立回忆。</p>
    <footer><p>准备好后再开始，过程不会提前揭示目标。</p><button type="button">开始三分钟巩固 <span aria-hidden="true">→</span></button></footer>
  </article>
`

const queueMarkup = {
  dial: `
    <ol class="dial-queue" aria-label="待复习项目">
      <li class="dial-item dial-item--one is-selected"><span class="item-index">第 1 项</span><time><small>8月25日</small>16:30</time><strong>可开始</strong></li>
      <li class="dial-item dial-item--two"><span class="item-index">第 2 项</span><time><small>8月25日</small>17:15</time><strong>仍在冷却期</strong></li>
      <li class="dial-item dial-item--three"><span class="item-index">第 3 项</span><time><small>8月25日</small>18:05</time><strong>可开始</strong></li>
    </ol>
    <p class="object-hint">转动时刻盘选择到期项</p>
  `,
  abacus: `
    <ol class="abacus-queue" aria-label="待复习项目">
      <li class="abacus-item abacus-item--one is-selected"><span>第 1 项</span><time>8月25日 16:30</time><strong>可开始</strong></li>
      <li class="abacus-item abacus-item--two"><span>第 2 项</span><time>8月25日 17:15</time><strong>仍在冷却期</strong></li>
      <li class="abacus-item abacus-item--three"><span>第 3 项</span><time>8月25日 18:05</time><strong>可开始</strong></li>
    </ol>
    <p class="object-hint">按下铜珠选择复习项</p>
  `,
  stamps: `
    <ol class="stamp-queue" aria-label="待复习项目">
      <li class="stamp-item stamp-item--one is-selected"><span>第 1 项</span><time><small>8月25日</small>16:30</time><strong>可开始</strong></li>
      <li class="stamp-item stamp-item--two"><span>第 2 项</span><time><small>8月25日</small>17:15</time><strong>仍在冷却期</strong></li>
      <li class="stamp-item stamp-item--three"><span>第 3 项</span><time><small>8月25日</small>18:05</time><strong>可开始</strong></li>
    </ol>
    <p class="object-hint">选择印章查看到期项</p>
  `,
}

const styles = `
  :root { font-family: "Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: #34251b; text-rendering: optimizeLegibility; }
  * { box-sizing: border-box; }
  html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  body { background: #241811; }
  button { font: inherit; }
  .concept { position: relative; width: 100vw; height: 100vh; overflow: hidden; isolation: isolate; }
  .concept__room { position: absolute; z-index: -2; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .concept::after { content: ""; position: absolute; z-index: -1; inset: 0; pointer-events: none; background: linear-gradient(90deg, rgba(38,24,16,.06), transparent 36%, transparent 78%, rgba(38,24,16,.03)); }
  .return-control { position: absolute; top: 46px; left: 54px; display: inline-flex; align-items: center; gap: 9px; min-height: 44px; padding: 0 15px; color: #fff8ec; font-size: 13px; font-weight: 680; border: 1px solid rgba(255,248,236,.22); border-radius: 4px; background: rgba(48,32,23,.88); box-shadow: 0 12px 28px rgba(38,23,14,.22), 0 2px 7px rgba(38,23,14,.2); }
  .return-control > span:first-child { font-size: 17px; }
  .scene-heading { position: absolute; top: 288px; left: 205px; width: 270px; color: #39271b; text-shadow: 0 1px 0 rgba(255,245,222,.5), 0 4px 16px rgba(255,240,210,.24); }
  .scene-heading time { color: #8c4328; font-size: 13px; font-weight: 760; letter-spacing: .045em; }
  .scene-heading h1 { margin: 4px 0 8px; font-family: "Noto Serif SC Variable", "Songti SC", serif; font-size: 43px; line-height: 1.1; letter-spacing: -.035em; }
  .scene-heading p { margin: 0; color: #5c4637; font-size: 13px; font-weight: 620; }
  .scene-heading p strong { color: #34251b; font-size: 17px; font-variant-numeric: tabular-nums; }
  .scene-heading p span { margin: 0 6px; color: #9b654b; }
  .notebook-detail { position: absolute; left: 289px; top: 585px; width: 391px; height: 151px; padding: 12px 17px 10px 20px; transform: rotate(.25deg); color: #403023; text-shadow: 0 1px rgba(255,255,255,.28); }
  .notebook-detail__identity { display: flex; align-items: center; justify-content: space-between; width: 100%; padding-right: 7px; color: #6f4b36; font-size: 11px; font-weight: 740; letter-spacing: .02em; font-variant-numeric: tabular-nums; }
  .notebook-detail h2 { margin: 4px 0 1px; font-family: "Noto Serif SC Variable", "Songti SC", serif; font-size: 23px; line-height: 1.16; letter-spacing: -.025em; }
  .notebook-detail__state { position: absolute; top: 38px; right: 22px; margin: 0; color: #3f6240; font-size: 11.5px; font-weight: 780; }
  .notebook-detail__state::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: #587b55; vertical-align: 1px; }
  .notebook-detail__description { width: 100%; margin: 4px 0 7px; color: #513d31; font-size: 11.5px; font-weight: 520; line-height: 1.45; }
  .notebook-detail footer { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 11px; padding-top: 6px; border-top: 1px solid rgba(78,53,36,.19); }
  .notebook-detail footer p { max-width: 190px; margin: 0; color: #6c5241; font-size: 9.5px; font-weight: 560; line-height: 1.4; }
  .notebook-detail footer button { min-height: 37px; padding: 0 12px; color: #fff8ed; font-size: 11px; font-weight: 740; border: 1px solid rgba(103,42,20,.35); border-radius: 3px; background: #a94825; box-shadow: 0 8px 18px rgba(91,43,23,.22), 0 2px 5px rgba(91,43,23,.18); }
  ol { margin: 0; padding: 0; list-style: none; }
  .dial-item, .stamp-item { position: absolute; display: grid; gap: 2px; color: #39271c; text-align: center; text-shadow: 0 1px 0 rgba(255,239,204,.75), 0 2px 7px rgba(70,42,20,.18); }
  .dial-item span, .stamp-item span { color: #63432f; font-size: 10.5px; font-weight: 760; }
  .dial-item time, .stamp-item time { display: grid; font-family: "Noto Serif SC Variable", "Songti SC", serif; font-size: 18px; font-weight: 740; line-height: 1.05; font-variant-numeric: tabular-nums; }
  .dial-item time small, .stamp-item time small { margin-bottom: 2px; font-family: "Noto Sans SC Variable", "PingFang SC", sans-serif; font-size: 8.5px; font-weight: 700; letter-spacing: .02em; }
  .dial-item strong, .stamp-item strong { color: #416840; font-size: 10.5px; font-weight: 780; }
  .dial-item--two strong, .stamp-item--two strong { color: #8d4f37; }
  .dial-item.is-selected time, .stamp-item.is-selected time { color: #8c3d20; }
  .dial-item.is-selected::after, .stamp-item.is-selected::after { content: ""; justify-self: center; width: 32px; height: 2px; margin-top: 2px; background: #aa4b28; box-shadow: 0 1px 0 rgba(255,232,191,.6); }
  .dial-item--one { left: 707px; top: 619px; width: 128px; transform: rotate(-5deg); }
  .dial-item--two { left: 953px; top: 617px; width: 137px; transform: rotate(5deg); }
  .dial-item--three { left: 815px; top: 525px; width: 135px; }
  .object-hint { position: absolute; margin: 0; color: rgba(67,45,30,.72); font-size: 9.5px; font-weight: 650; letter-spacing: .02em; text-shadow: 0 1px rgba(255,242,215,.65); }
  .concept--dial .object-hint { left: 828px; top: 724px; }
  .abacus-queue { position: absolute; left: 709px; top: 489px; width: 361px; height: 173px; }
  .abacus-item { position: absolute; left: 18px; display: grid; grid-template-columns: 49px 1fr 73px; align-items: center; width: 324px; height: 38px; padding: 0 8px; color: #fff0d2; font-size: 10px; font-weight: 700; text-shadow: 0 2px 4px rgba(42,24,14,.82); }
  .abacus-item span { color: #ead29d; }
  .abacus-item time { font-family: "Noto Serif SC Variable", "Songti SC", serif; font-size: 11.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .abacus-item strong { justify-self: end; color: #e1eccd; font-size: 9.5px; white-space: nowrap; }
  .abacus-item--two strong { color: #f1c0a3; }
  .abacus-item--one { top: 13px; }
  .abacus-item--two { top: 57px; }
  .abacus-item--three { top: 101px; }
  .abacus-item.is-selected { background: linear-gradient(90deg, rgba(191,92,42,.31), transparent 74%); }
  .concept--abacus .object-hint { left: 811px; top: 684px; }
  .stamp-item--one { left: 751px; top: 429px; width: 105px; }
  .stamp-item--two { left: 840px; top: 418px; width: 115px; }
  .stamp-item--three { left: 936px; top: 428px; width: 105px; }
  .concept--stamps .object-hint { left: 839px; top: 720px; }
  .concept--stamps .notebook-detail footer button { background: #8e3e23; }
  .concept-label { position: absolute; right: 10px; bottom: 8px; margin: 0; padding: 4px 7px; color: rgba(255,247,234,.76); font-size: 8px; letter-spacing: .04em; border: 1px solid rgba(255,247,234,.16); border-radius: 999px; background: rgba(35,25,19,.72); }
`

try {
  const window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0]
    target?.setMinimumSize(1, 1)
    target?.setContentSize(1440, 810)
    target?.center()
  })

  for (const [variant, backgroundPath] of Object.entries(backgrounds)) {
    const backgroundUrl = await toDataUrl(backgroundPath)
    await window.evaluate(({ variant, backgroundUrl, sharedMarkup, queueMarkup, styles }) => {
      document.documentElement.lang = 'zh-CN'
      document.head.querySelectorAll('[data-review-concept]').forEach((node) => node.remove())
      const style = document.createElement('style')
      style.dataset.reviewConcept = 'true'
      style.textContent = styles
      document.head.append(style)
      const fixture = document.createElement('main')
      fixture.id = 'root'
      fixture.className = `concept concept--${variant}`
      fixture.innerHTML = `<img class="concept__room" src="${backgroundUrl}" alt="">${sharedMarkup}${queueMarkup[variant]}<p class="concept-label">DATA COMPOSITION CONCEPT · 真实字段排版预览</p>`
      document.body.replaceChildren(fixture)
    }, { variant, backgroundUrl, sharedMarkup, queueMarkup, styles })
    await window.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))
    await window.evaluate(() => document.fonts?.ready)
    await window.screenshot({ path: resolve(outputRoot, `review-data-${variant}-v1.png`) })
  }

  console.log(`Rendered Review data concepts in ${outputRoot}`)
} finally {
  await electronApp.close()
}
