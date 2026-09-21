/**
 * 真机验证脚本：学习卡生成工作台两状态页 + 笔记页状态同步。
 * 附连运行中的 dev 客户端（CDP 9222），走完整业务主线：
 * 笔记页 → 生成学习卡 → 工作台(12) → 返回笔记 → 查看生成进度 → 工作台(12)。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'

loadDotenv({ path: resolve(import.meta.dirname, '../../.env'), override: false })

const outDir = resolve(import.meta.dirname, 'cardgen-verify')
await mkdir(outDir, { recursive: true })

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]

const problems = []
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`)
})

const report = {}
const shot = async (name) => {
  await page.waitForTimeout(700)
  await page.screenshot({ path: resolve(outDir, `${name}.png`) })
}
const hudPage = () => page.locator('.desktop-app').getAttribute('data-hud-page')
const title = () => page.locator('.task-title h1').textContent().catch(() => null)

// 1. 登录（凭据已保存则直接进入书房）
const gate = page.locator('.desktop-access-gate')
if (await gate.count()) {
  const passwordInput = gate.locator('input[type="password"]')
  await passwordInput.fill(process.env.OWNER_PASSWORD ?? '')
  await passwordInput.press('Enter')
  await page.waitForTimeout(1500)
}
const firstSpace = page.locator('.first-space')
if (await firstSpace.count()) {
  await firstSpace.locator('.space-choice .button.primary').first().click()
  await page.waitForTimeout(1500)
}

// 2. 打开一篇笔记：rail「笔记」→ 笔记库第一篇
await page.locator('.nav-chip[aria-label="笔记"]').click()
await page.waitForTimeout(1200)
// 书架主卡现在是整卡可点（.current-note__open），索引行仍是标题按钮（.note-open）；
// 两个入口都接受，但只点可见的那一个，否则会等到 0x0 的隐藏节点上超时。
const noteOpen = page.locator('.current-note__open:visible, .note-open:visible').first()
await noteOpen.waitFor({ timeout: 8000 })
await noteOpen.click()
await page.waitForTimeout(1200)
report.notebookPage = await hudPage()
report.notebookTitle = await title()
report.readActions = await page.locator('.notebook-actions button, .notebook-actions .tag').allTextContents()
await shot('1-notebook-before')

// 3. 点击「生成学习卡」→ 工作台生成页（12）
await page.getByRole('button', { name: '生成学习卡' }).click()
await page.locator('.task-surface--card-generation').waitFor({ timeout: 8000 })
await page.waitForTimeout(1500)
report.workbenchPage = await hudPage()
report.workbenchTitle = await title()
report.returnPill = await page.locator('.return-home span').textContent().catch(() => null)
report.pressStages = await page.locator('.press-stage').allTextContents()
report.workbenchFooter = await page.locator('.card-generation-board__footer').textContent().catch(() => null)
await shot('2-workbench-generating')

// 4. 从工作台返回笔记（胶囊）
await page.locator('.return-home').click()
await page.waitForTimeout(1200)
report.backPage = await hudPage()
report.backTitle = await title()
report.backActions = await page.locator('.notebook-actions button, .notebook-actions .tag').allTextContents()
report.liveStatus = await page.locator('.notebook-generation-live').textContent().catch(() => null)
await shot('3-notebook-during-generation')

// 5. 从笔记页「查看生成进度」回工作台
const progress = page.getByRole('button', { name: /查看生成进度|审核学习卡|处理生成任务|查看激活进度/ }).first()
await progress.click()
await page.locator('.task-surface--card-generation').waitFor({ timeout: 8000 })
await page.waitForTimeout(1500)
report.reentryPage = await hudPage()
report.reentryTitle = await title()
await shot('4-workbench-reentry')

report.problems = problems
await writeFile(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(0)
