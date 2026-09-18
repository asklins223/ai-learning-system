/**
 * 真机复现：把真实的桌面客户端跑起来（真实 React 树 + 真实房间场景），只替换
 * window.ailearn 这个网关桩，然后像读者一样把最上面那张牌拖走，看会不会黑屏。
 */
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const appRoot = resolve(import.meta.dirname, '..')
const installed = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspace = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${await mkdtemp(resolve(tmpdir(), 'ailearn-realdrag-'))}`],
  cwd: appRoot,
  executablePath: existsSync(installed) ? installed : workspace,
})
const window = await app.firstWindow()
const problems = []
window.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
window.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`) })
window.on('crash', () => problems.push('crash: page crashed'))

await window.addInitScript(() => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    version: 2,
    reviewId: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    scheduleId: `${String(index + 1).padStart(8, '0')}-2222-4222-8222-222222222222`,
    objectiveId: `objective-${index + 1}`,
    scheduleGeneration: index + 1,
    dueAt: new Date(Date.now() - 3_600_000).toISOString(),
    startability: { kind: 'ready' },
  }))
  const page = (cursor, size) => {
    const start = cursor ? Number(cursor) : 0
    const slice = items.slice(start, start + size)
    return { version: 2, items: slice, total: items.length, nextCursor: start + size < items.length ? String(start + size) : null }
  }
  const objective = (objectiveId) => ({
    objectiveId,
    content: { conceptLabel: `理解目标 ${objectiveId.replace('objective-', '')}`, publicSummary: '公开摘要', sourceLabel: null },
    sources: { primaryNote: null },
  })
  const real = {
    auth: { getState: async () => ({ ok: true, workspaceEpoch: 1, data: { status: 'authenticated', workspace: { workspaceId: 'workspace-1' } } }) },
    review: {
      getQueue: async (input) => ({ ok: true, workspaceEpoch: 1, data: page(input?.cursor, input?.limit ?? 20) }),
      defer: async (input) => ({ ok: true, workspaceEpoch: 1, data: { version: 2, scheduleId: input.request.scheduleId, scheduleGeneration: input.request.scheduleGeneration, userDeferredUntil: new Date(Date.now() + 86_400_000).toISOString(), officialNextReviewAt: new Date(Date.now() - 3_600_000).toISOString() } }),
    },
    objective: { get: async ({ objectiveId }) => ({ ok: true, workspaceEpoch: 1, data: objective(objectiveId) }) },
    learningRun: { start: async () => ({ ok: true, workspaceEpoch: 1, data: { runId: 'run-1', status: 'running' } }) },
  }
  const empty = () => ({ ok: true, workspaceEpoch: 1, data: {} })
  const make = (name) => new Proxy(real[name] ?? {}, {
    get: (target, key) => (key in target ? target[key] : async () => empty()),
    has: () => true,
  })
  window.ailearn = new Proxy(real, {
    get: (target, key) => (key in target ? make(key) : async () => empty()),
    has: () => true,
  })
})

await window.reload()
await window.waitForLoadState('domcontentloaded')
await window.waitForTimeout(2500)
await app.evaluate(({ BrowserWindow }) => {
  const target = BrowserWindow.getAllWindows()[0]
  target?.setMinimumSize(1, 1)
  target?.webContents.setZoomFactor(1)
  target?.setContentSize(1440, 810)
})
await window.waitForTimeout(800)

// 走到复习页：rail 上的「复习」chip
await window.evaluate(() => {
  const chip = [...document.querySelectorAll('.hud-rail .nav-chip')]
    .find((node) => (node.getAttribute('aria-label') ?? '') === '复习' || (node.textContent ?? '').includes('复习'))
  chip?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
})
await window.waitForTimeout(1800)
const state = await window.evaluate(() => ({
  page: document.querySelector('.desktop-app')?.getAttribute('data-hud-page') ?? null,
  rootChildren: document.getElementById('root')?.childElementCount ?? -1,
  cards: document.querySelectorAll('.deck-card').length,
  deck: Boolean(document.querySelector('.card-deck')),
}))
console.log('进入复习页:', JSON.stringify(state))
const dom = await window.evaluate(() => ({
  text: (document.body.innerText || '').slice(0, 400),
  chips: [...document.querySelectorAll('.nav-chip, .hud-rail button, [role="tab"]')].map((node) => ({
    tag: node.tagName.toLowerCase(),
    cls: node.className,
    label: node.getAttribute('aria-label'),
    text: (node.textContent || '').trim().slice(0, 24),
  })).slice(0, 20),
  page: document.querySelector('.desktop-app')?.outerHTML.slice(0, 200) ?? null,
}))
console.log('DOM:', JSON.stringify(dom, null, 1).slice(0, 2000))
if (!state.deck) {
  await window.screenshot({ path: resolve(tmpdir(), 'probe-real-drag-no-deck.png') })
  console.log('问题:', problems.slice(0, 8))
  await app.close()
  process.exit(0)
}

const box = await window.evaluate(() => {
  const deck = document.querySelector('.card-deck')
  const rect = deck.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})
await window.mouse.move(box.x, box.y)
await window.mouse.down()
for (let step = 1; step <= 10; step += 1) {
  await window.mouse.move(box.x - step * 30, box.y + step * 2)
  await window.waitForTimeout(16)
  const health = await window.evaluate(() => ({
    root: document.getElementById('root')?.childElementCount ?? -1,
    cards: document.querySelectorAll('.deck-card').length,
  })).catch(() => null)
  if (!health) { problems.push(`拖到第 ${step} 步时页面已经不响应`); break }
  if (health.root === 0) { problems.push(`拖到第 ${step} 步时 React 树被卸载（黑屏）`); break }
}
await window.mouse.up()
await window.waitForTimeout(600)
const after = await window.evaluate(() => ({
  root: document.getElementById('root')?.childElementCount ?? -1,
  cards: document.querySelectorAll('.deck-card').length,
  decks: document.querySelectorAll('.card-deck').length,
  front: document.querySelector('.deck-card.front')?.getAttribute('data-depth') ?? null,
})).catch((error) => ({ error: String(error) }))
console.log('拖拽之后:', JSON.stringify(after))
await window.screenshot({ path: resolve(tmpdir(), 'probe-real-drag-after.png') })
console.log('问题:', problems.length ? problems.slice(0, 10) : '（无）')
await app.close()
