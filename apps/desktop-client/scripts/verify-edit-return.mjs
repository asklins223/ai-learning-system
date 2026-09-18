import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
const outDir = resolve('scripts/cardgen-verify')
await mkdir(outDir, { recursive: true })
const problems = []
page.on('pageerror', (e) => problems.push(String(e.message)))
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })
const report = {}

// 回到笔记页（当前在工作台 12）
await page.locator('.return-home').click()
await page.waitForTimeout(1200)
report.beforeModePage = await page.locator('.desktop-app').getAttribute('data-hud-page')

// 切到编辑模式
await page.getByRole('button', { name: '编辑这篇笔记' }).click()
await page.waitForTimeout(900)
report.editModePage = await page.locator('.desktop-app').getAttribute('data-hud-page')

// 去工作台
await page.getByRole('button', { name: /查看生成进度|审核学习卡|处理生成任务/ }).first().click()
await page.locator('.task-surface--card-generation').waitFor({ timeout: 8000 })
await page.waitForTimeout(1000)
report.workbenchPage = await page.locator('.desktop-app').getAttribute('data-hud-page')

// 返回笔记 → 应回到编辑页 (09)
await page.locator('.return-home').click()
await page.waitForTimeout(1200)
report.returnPage = await page.locator('.desktop-app').getAttribute('data-hud-page')
report.returnTitle = await page.locator('.task-title h1').textContent().catch(() => null)
report.hasEditor = await page.locator('#notebook-surface-body').count()
await page.screenshot({ path: resolve(outDir, '6-notebook-edit-return.png') })
report.problems = problems
console.log(JSON.stringify(report, null, 2))
process.exit(0)
