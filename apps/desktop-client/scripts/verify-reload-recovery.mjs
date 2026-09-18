import { chromium } from '@playwright/test'
import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'
loadDotenv({ path: resolve(import.meta.dirname, '../../.env'), override: false })
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
const problems = []
page.on('pageerror', (e) => problems.push(String(e.message)))
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })
const report = {}

// 登录 + 选空间
const gate = page.locator('.desktop-access-gate')
await gate.locator('input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
await gate.locator('input[type="password"]').press('Enter')
await page.waitForTimeout(1800)
const firstSpace = page.locator('.first-space')
if (await firstSpace.count()) {
  await firstSpace.locator('.space-choice .button.primary').first().click()
  await page.waitForTimeout(1800)
}

// 首页恢复条（RunRecoveryNotice）应列出学习卡任务
report.recovery = await page.locator('.home-recovery').textContent().catch(() => null)

// 打开笔记页 → 应显示"查看生成进度"（服务端 run 仍在）
await page.locator('.nav-chip[aria-label="笔记"]').click()
await page.waitForTimeout(1200)
await page.locator('.note-open').first().click()
await page.waitForTimeout(1500)
report.notebookPage = await page.locator('.desktop-app').getAttribute('data-hud-page')
report.noteActions = await page.locator('.notebook-actions button, .notebook-actions .tag').allTextContents()
report.liveStatus = await page.locator('.notebook-generation-live').textContent().catch(() => null)

// 去工作台 → 可能已是候选页（13）或生成页（12）
await page.getByRole('button', { name: /查看生成进度|审核学习卡|处理生成任务/ }).first().click()
await page.locator('.task-surface--card-generation').waitFor({ timeout: 8000 })
await page.waitForTimeout(1500)
report.workbenchPage = await page.locator('.desktop-app').getAttribute('data-hud-page')
report.workbenchTitle = await page.locator('.task-title h1').textContent().catch(() => null)
report.boardTag = await page.locator('.card-generation-board .tag').first().textContent().catch(() => null)
report.candidateQuestion = await page.locator('.candidate-study-card h2').textContent().catch(() => null)
await page.screenshot({ path: resolve('scripts/cardgen-verify', '7-after-reload-workbench.png') })
report.problems = problems
console.log(JSON.stringify(report, null, 2))
process.exit(0)
