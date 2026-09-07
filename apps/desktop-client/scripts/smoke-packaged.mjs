import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const workspaceRoot = resolve(appRoot, '../..')
const devComposeFile = resolve(workspaceRoot, 'docker-compose.dev.yml')
const evidenceRoot = resolve(appRoot, '../../.impeccable/evidence')
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const { extractFile, listPackage } = require('@electron/asar')
const rejectedRuntimeMedia = [
  'graph-entry-fog-v1.mp4',
  'validation-ink-bloom-v1.mp4',
  'companion-wake-v1.webm',
  'companion-confirm-v1.webm',
  'review-card-tray-v1.png',
  'review-card-stand-v2.png',
]
const packageExcludedPrefixes = [
  'out/renderer/assets/3d/',
  'out/renderer/assets/companion/live2d-v1/',
  'out/renderer/assets/companion/vendor/',
]
const packagedManifestEntry = 'out/renderer/assets/learning-room/v1/manifest.json'
const runtimeManifestPath = resolve(appRoot, 'src/renderer/public/assets/learning-room/v1/manifest.json')
const outManifestPath = resolve(appRoot, 'out/renderer/assets/learning-room/v1/manifest.json')

function candidateExecutables() {
  if (process.platform === 'darwin') {
    return [resolve(appRoot, 'release/mac-arm64/AI Learn.app/Contents/MacOS/AI Learn')]
  }
  if (process.platform === 'win32') {
    return [resolve(appRoot, 'release/win-unpacked/AI Learn.exe')]
  }
  return [resolve(appRoot, 'release/linux-unpacked/AI Learn')]
}

function packagedExecutable() {
  const configured = process.env.AILEARN_PACKAGED_APP?.trim()
  if (configured && existsSync(configured)) return configured
  const found = candidateExecutables().find((candidate) => existsSync(candidate))
  if (found) return found
  throw new Error('No packaged Electron executable found. Set AILEARN_PACKAGED_APP after npm run dist.')
}

const executablePath = packagedExecutable()

function packagedAsarPath(executable) {
  const candidates = process.platform === 'darwin'
    ? [resolve(executable, '../../Resources/app.asar')]
    : [resolve(executable, '../resources/app.asar'), resolve(executable, '../Resources/app.asar')]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  throw new Error(`Packaged app.asar is unavailable for containment inspection: ${candidates.join(', ')}`)
}

async function listFiles(root) {
  const files = []
  const visit = async (entryPath) => {
    const entryStat = await stat(entryPath)
    if (entryStat.isFile()) {
      files.push({ path: entryPath, mtimeMs: entryStat.mtimeMs })
      return
    }
    if (!entryStat.isDirectory()) throw new Error(`Unsupported freshness input: ${entryPath}`)
    for (const entry of await readdir(entryPath, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isFile()) throw new Error(`Unsupported freshness entry: ${resolve(entryPath, entry.name)}`)
      await visit(resolve(entryPath, entry.name))
    }
  }
  await visit(root)
  return files
}

async function newestFile(paths, label) {
  const files = []
  for (const candidate of paths) {
    if (!existsSync(candidate)) throw new Error(`${label} freshness input is missing: ${candidate}`)
    files.push(...await listFiles(candidate))
  }
  if (files.length === 0) throw new Error(`${label} freshness inputs contained no files`)
  return files.reduce((latest, entry) => entry.mtimeMs > latest.mtimeMs ? entry : latest)
}

function normalizeArchiveEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '')
}

function collectManifestAssetPaths(value, assets = new Set()) {
  if (typeof value === 'string' && /\.(?:avif|m4a|mp4|png|svg|vtt|webp)$/i.test(value)) {
    assets.add(value)
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectManifestAssetPaths(entry, assets))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectManifestAssetPaths(entry, assets))
  }
  return assets
}

async function inspectPackagedArtifact(executable) {
  const asarPath = packagedAsarPath(executable)
  const sourceNewest = await newestFile([
    resolve(appRoot, 'src/main'),
    resolve(appRoot, 'src/preload'),
    resolve(appRoot, 'src/renderer/src'),
    resolve(appRoot, 'src/renderer/index.html'),
    resolve(appRoot, 'src/renderer/public/assets/fonts'),
    resolve(appRoot, 'src/renderer/public/assets/learning-room'),
    resolve(workspaceRoot, 'packages/shared/src'),
    resolve(appRoot, 'electron.vite.config.ts'),
    resolve(appRoot, 'electron-builder.yml'),
    resolve(appRoot, 'package.json'),
  ], 'source')
  const buildNewest = await newestFile([
    resolve(appRoot, 'out/main'),
    resolve(appRoot, 'out/preload'),
    resolve(appRoot, 'out/renderer'),
  ], 'build')
  const asarStat = await stat(asarPath)
  const timestampToleranceMs = 1_000
  if (buildNewest.mtimeMs + timestampToleranceMs < sourceNewest.mtimeMs) {
    throw new Error(`Packaged smoke refused a stale build: newest build ${buildNewest.path} predates source ${sourceNewest.path}. Run npm run dist.`)
  }
  if (asarStat.mtimeMs + timestampToleranceMs < buildNewest.mtimeMs) {
    throw new Error(`Packaged smoke refused a stale artifact: ${asarPath} predates build output ${buildNewest.path}. Run npm run dist.`)
  }

  const [runtimeManifest, outManifest] = await Promise.all([
    readFile(runtimeManifestPath),
    readFile(outManifestPath),
  ])
  if (!runtimeManifest.equals(outManifest)) {
    throw new Error('Renderer out manifest is not byte-identical to the runtime source manifest')
  }

  const archiveEntries = listPackage(asarPath).map(normalizeArchiveEntry)
  const archiveEntrySet = new Set(archiveEntries)
  if (!archiveEntrySet.has(packagedManifestEntry)) {
    throw new Error(`Packaged manifest is missing from app.asar: ${packagedManifestEntry}`)
  }
  const packagedManifest = extractFile(asarPath, packagedManifestEntry)
  if (!runtimeManifest.equals(packagedManifest)) {
    throw new Error('Packaged manifest is not byte-identical to the runtime source and fresh renderer out manifests')
  }

  const manifestJson = JSON.parse(packagedManifest.toString('utf8'))
  if (manifestJson.id !== 'ailearn-learning-room-v1' || manifestJson.canonicalMode !== '2d') {
    throw new Error('Packaged learning-room manifest identity or canonical mode drifted')
  }
  const manifestText = packagedManifest.toString('utf8')
  const rejectedManifestMedia = rejectedRuntimeMedia.filter((name) => manifestText.includes(name))
  const rejectedArchiveMedia = archiveEntries.filter((entry) => rejectedRuntimeMedia.some((name) => entry.endsWith(`/${name}`) || entry === name))
  if (rejectedManifestMedia.length || rejectedArchiveMedia.length) {
    throw new Error(`Rejected runtime media entered packaged evidence: ${JSON.stringify({ rejectedManifestMedia, rejectedArchiveMedia })}`)
  }

  const excludedArchiveEntries = archiveEntries.filter((entry) => packageExcludedPrefixes.some((prefix) => entry === prefix.slice(0, -1) || entry.startsWith(prefix)))
  if (excludedArchiveEntries.length) {
    throw new Error(`Reference-only or unlicensed archives entered app.asar: ${excludedArchiveEntries.slice(0, 12).join(', ')}`)
  }
  const requiredOrb = 'out/renderer/assets/learning-room/v1/objects/companion-orb.webp'
  if (!archiveEntrySet.has(requiredOrb)) throw new Error(`Packaged legal orb fallback is missing: ${requiredOrb}`)

  const manifestAssetPaths = [...collectManifestAssetPaths(manifestJson)]
  const missingPackagedAssets = manifestAssetPaths.filter((assetPath) => (
    !archiveEntrySet.has(`out/renderer/assets/learning-room/v1/${assetPath}`)
  ))
  if (missingPackagedAssets.length) {
    throw new Error(`Packaged manifest references missing runtime assets: ${missingPackagedAssets.join(', ')}`)
  }

  const outFiles = await listFiles(resolve(appRoot, 'out/renderer'))
  const outRelativePaths = outFiles.map((entry) => relative(appRoot, entry.path).split(sep).join('/'))
  const rejectedOutMedia = outRelativePaths.filter((entry) => rejectedRuntimeMedia.some((name) => entry.endsWith(`/${name}`)))
  const excludedOutEntries = outRelativePaths.filter((entry) => packageExcludedPrefixes.some((prefix) => entry === prefix.slice(0, -1) || entry.startsWith(prefix)))
  if (rejectedOutMedia.length || excludedOutEntries.length) {
    throw new Error(`Fresh renderer out failed containment: ${JSON.stringify({ rejectedOutMedia, excludedOutEntries: excludedOutEntries.slice(0, 12) })}`)
  }

  return {
    asar: relative(appRoot, asarPath).split(sep).join('/'),
    sourceNewest: { path: relative(appRoot, sourceNewest.path).split(sep).join('/'), mtime: new Date(sourceNewest.mtimeMs).toISOString() },
    buildNewest: { path: relative(appRoot, buildNewest.path).split(sep).join('/'), mtime: new Date(buildNewest.mtimeMs).toISOString() },
    artifactMtime: new Date(asarStat.mtimeMs).toISOString(),
    manifestByteIdentical: true,
    manifestSha256: createHash('sha256').update(packagedManifest).digest('hex'),
    manifestAssetCount: manifestAssetPaths.length,
    rejectedMediaAbsent: rejectedRuntimeMedia,
    excludedArchivesAbsent: packageExcludedPrefixes,
    orbFallbackPresent: true,
  }
}

const packageContainment = await inspectPackagedArtifact(executablePath)
if (process.env.AILEARN_PACKAGED_PREFLIGHT_ONLY === '1') {
  process.stdout.write(`${JSON.stringify(packageContainment, null, 2)}\n`)
  process.exit(0)
}
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-packaged-smoke-'))
const errors = []
const ownerCredentialsAvailable = Boolean(process.env.OWNER_EMAIL?.trim() && process.env.OWNER_PASSWORD)
const memberCredentialsAvailable = Boolean(process.env.MEMBER_EMAIL?.trim() && process.env.MEMBER_PASSWORD)
const smokeRole = ownerCredentialsAvailable ? 'owner' : memberCredentialsAvailable ? 'member' : 'anonymous'
const learningRunResponseLossOperations = smokeRole === 'member' ? ['draft', 'action', 'submit'] : []
const learningRunResponseLossExpected = learningRunResponseLossOperations.length > 0
const smokeAppEnv = {
  ...process.env,
  AILEARN_PACKAGED_EVIDENCE: '1',
  ...(learningRunResponseLossExpected ? { AILEARN_PACKAGED_LEARNING_RUN_RESPONSE_LOSS: learningRunResponseLossOperations.join(',') } : {}),
}
const ownerJourney = {
  attempted: ownerCredentialsAvailable,
  authenticated: false,
  cardGeneration: false,
  cardActivation: false,
  note: false,
  learningRun: false,
  returned: false,
}
const memberJourney = {
  attempted: memberCredentialsAvailable,
  authenticated: false,
  reviewQueue: false,
  learningRun: false,
  result: false,
  returned: false,
  note: false,
}
let electronApp
let currentWindow
let apiRestartRecovery = false
let responseLossRecovery = false
const learningRunResponseLossRecoveries = []
let markerRestartRecovery = false
let offlineStartRecovery = false
let offlineAccessGateBoundary = null
let formalGuardRuntime = false
let formalGuardActiveObserved = false
let formalGuardReleasedObserved = false

async function waitForLearningRunPlayer(window, label, timeout = 60_000) {
  await window.locator('.run-player').waitFor({ state: 'visible', timeout: 15_000 })
  try {
    await window.waitForFunction(
      () => Boolean(document.querySelector('.run-player:not(.run-player--loading)')) || Boolean(document.querySelector('.run-player--error')),
      undefined,
      { timeout },
    )
  } catch (error) {
    const diagnostics = await window.evaluate(() => ({
      playerClass: document.querySelector('.run-player')?.className ?? null,
      playerText: document.querySelector('.run-player')?.textContent?.slice(0, 500) ?? null,
      taskSurface: document.querySelector('.task-surface')?.textContent?.slice(0, 500) ?? null,
      headings: [...document.querySelectorAll('h1,h2,h3')].map((node) => node.textContent?.trim()).filter(Boolean).slice(0, 8),
    }))
    throw new Error(`${label} did not leave loading state: ${JSON.stringify(diagnostics)} (${error.message})`)
  }
}

function attachWindowDiagnostics(window) {
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  window.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
}

async function waitForPackagedWindow(window, label) {
  await window.waitForLoadState('domcontentloaded')
  await window.locator('.desktop-app').waitFor({ state: 'visible', timeout: 15_000 })
  await window.waitForFunction(() => window.location.protocol === 'ailearn-app:')
  const boundary = await window.evaluate(() => ({
    protocol: window.location.protocol,
    hasDesktopPreload: typeof window.ailearnDesktop?.platform === 'string',
    hasM2Preload: typeof window.ailearn?.contract?.version === 'number',
    hasAccessGate: document.querySelector('.desktop-access-gate') !== null,
    hasRoomDom: document.querySelector('.scene-stage') !== null,
    hasActionRail: document.querySelector('.action-rail') !== null,
    hasOnboarding: document.querySelector('.onboarding-card') !== null,
  }))
  if (
    boundary.protocol !== 'ailearn-app:'
    || !boundary.hasDesktopPreload
    || !boundary.hasM2Preload
    || (!boundary.hasAccessGate && !boundary.hasRoomDom)
  ) {
    throw new Error(`${label} packaged boundary contract failed: ${JSON.stringify(boundary)}`)
  }
  return boundary
}

async function readAccessGateBoundary(window) {
  return window.evaluate(() => {
    const gate = document.querySelector('.desktop-access-gate')
    return {
      present: gate instanceof HTMLElement,
      phase: gate?.querySelector('.desktop-access-gate__form')
        ? 'auth'
        : gate?.querySelector('.desktop-access-gate__workspace-list')
          ? 'workspace'
          : gate?.querySelector('.desktop-access-gate__notice')
            ? 'blocked'
            : 'loading',
      heading: gate?.querySelector('h1')?.textContent?.trim() ?? null,
      detail: gate?.querySelector('#desktop-gate-detail')?.textContent?.trim() ?? null,
      hasRoomDom: document.querySelector('.scene-stage') !== null,
      hasActionRail: document.querySelector('.action-rail') !== null,
      hasOnboarding: document.querySelector('.onboarding-card') !== null,
    }
  })
}

async function assertFailClosedAccessGate(window, label) {
  await window.locator('.desktop-access-gate').waitFor({ state: 'visible', timeout: 20_000 })
  await window.waitForFunction(
    () => !document.querySelector('.desktop-access-gate__loading'),
    undefined,
    { timeout: 20_000 },
  ).catch(() => undefined)
  const boundary = await readAccessGateBoundary(window)
  if (!boundary.present || boundary.hasRoomDom || boundary.hasActionRail || boundary.hasOnboarding) {
    throw new Error(`${label} did not stop at the fail-closed DesktopAccessGate: ${JSON.stringify(boundary)}`)
  }
  return boundary
}

async function authenticateThroughAccessGate(window, { email, password, expectedRole, label }) {
  await window.waitForFunction(
    () => Boolean(document.querySelector('.action-rail')) || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator('.action-rail').count() === 0) {
    await window.locator('.desktop-access-gate input[type="email"]').fill(email)
    await window.locator('.desktop-access-gate input[type="password"]').fill(password)
    await window.getByRole('button', { name: '登录', exact: true }).click()
  }

  const deadline = Date.now() + 30_000
  let workspaceChosen = false
  while (Date.now() < deadline && await window.locator('.action-rail').count() === 0) {
    const formError = window.locator('.desktop-access-gate__form-error')
    if (await formError.count()) throw new Error(`${label} Gate login failed: ${await formError.innerText()}`)
    const workspaceButtons = window.locator('.desktop-access-gate__workspace-list button')
    if (!workspaceChosen && await workspaceButtons.count()) {
      const roleLabel = expectedRole === 'owner' ? '所有者' : '成员'
      const roleWorkspace = workspaceButtons.filter({ hasText: roleLabel }).first()
      await (await roleWorkspace.count() ? roleWorkspace : workspaceButtons.first()).click()
      workspaceChosen = true
    }
    const blockedNotice = window.locator('.desktop-access-gate__notice')
    if (await blockedNotice.count()) {
      throw new Error(`${label} Gate stopped before Room ready: ${JSON.stringify(await readAccessGateBoundary(window))}`)
    }
    await window.waitForTimeout(250)
  }
  await window.locator('.action-rail').waitFor({ state: 'visible', timeout: 1_000 })

  const session = await window.evaluate(async () => {
    const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const response = await window.ailearn.auth.getState({
      meta: {
        version: 1,
        contractVersion: window.ailearn.contract.contractVersion,
        requestId: opaqueId('packaged-session-request'),
        correlationId: opaqueId('packaged-session-correlation'),
        clientStartedAt: new Date().toISOString(),
      },
    })
    return response.ok
      ? { ok: true, status: response.data.status, role: response.data.membership?.role ?? null }
      : { ok: false, errorCode: response.error.code }
  })
  if (!session.ok || session.status !== 'authenticated' || session.role !== expectedRole) {
    throw new Error(`${label} Gate did not reach an authenticated ${expectedRole} Room: ${JSON.stringify(session)}`)
  }

  await window.waitForTimeout(700)
  if (await window.locator('.onboarding-card').count()) {
    await window.getByRole('button', { name: '无声进入' }).click()
  }
}

async function waitForStudyObjectSurface(window, label) {
  await window.waitForFunction(
    () => Boolean(document.querySelector('.study-workbench.study-workbench--ready'))
      || Boolean(document.querySelector('.study-boundary:is([role="alert"]), .study-workbench--empty, .study-workbench--error')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator('.study-workbench.study-workbench--ready').count() !== 1) {
    const boundary = await window.locator('.study-boundary').first().innerText().catch(() => 'missing Study boundary')
    throw new Error(`${label} did not reach the real Study object surface: ${boundary}`)
  }
}

async function readCardGenerationDiagnostics(window) {
  return window.evaluate(() => ({
    runMeta: document.querySelector('.card-generation-meta')?.textContent?.trim() ?? null,
    error: document.querySelector('.card-generation-state--error')?.textContent?.trim() ?? null,
    candidates: [...document.querySelectorAll('.card-generation-candidate')].map((node) => ({
      text: node.textContent?.trim() ?? '',
      keepButtons: [...node.querySelectorAll('button')]
        .filter((button) => button.textContent?.trim() === '保留')
        .map((button) => ({ disabled: button.disabled })),
      selectedInputs: node.querySelectorAll('.card-generation-select input[type="checkbox"]').length,
    })).slice(0, 5),
    buttons: [...document.querySelectorAll('button')]
      .map((button) => button.textContent?.trim() || button.getAttribute('aria-label'))
      .filter(Boolean)
      .slice(-16),
  }))
}

async function waitForCardGenerationSurface(window) {
  const heading = window.getByRole('heading', { name: '整理学习卡' })
  try {
    await heading.waitFor({ state: 'visible', timeout: 30_000 })
    return
  } catch (error) {
    // A successful start can race with renderer navigation after a transport
    // reconnect. If the room already exposes the server recovery route, enter
    // through that explicit contract before failing the packaged journey.
    const recoveryButton = window.getByRole('button', { name: /查看恢复状态|恢复候选审核/ })
    if (await recoveryButton.count()) {
      await recoveryButton.first().click()
      await heading.waitFor({ state: 'visible', timeout: 30_000 })
      return
    }
    const diagnostics = await window.evaluate(() => ({
      route: window.location.href,
      roomText: document.querySelector('.scene-stage')?.textContent?.slice(0, 600) ?? null,
      buttons: [...document.querySelectorAll('button')].map((button) => button.textContent?.trim() || button.getAttribute('aria-label')).filter(Boolean).slice(-16),
    }))
    throw new Error(`Packaged Card Generation surface did not open: ${JSON.stringify(diagnostics)} (${error.message})`)
  }
}

async function packagedTransportProbe(window, kind) {
  return window.evaluate(async (probeKind) => {
    const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const meta = () => ({
      version: 1,
      contractVersion: window.ailearn.contract.contractVersion,
      requestId: opaqueId(`packaged-${probeKind}-request`),
      correlationId: opaqueId(`packaged-${probeKind}-correlation`),
      clientStartedAt: new Date().toISOString(),
    })
    try {
      const response = probeKind === 'room'
        ? await window.ailearn.room.getProjection({ meta: meta() })
        : await window.ailearn.runtime.getHealth({ meta: meta() })
      return response.ok
        ? { ok: true, kind: probeKind, dataKind: probeKind === 'health' ? response.data.kind : 'projection' }
        : { ok: false, kind: probeKind, code: response.error.code }
    } catch {
      return { ok: false, kind: probeKind, code: 'invoke_failed' }
    }
  }, kind)
}

async function readFormalGuardEvidence() {
  if (!electronApp) return null
  return electronApp.evaluate(() => {
    const hook = globalThis.__ailearnFormalAssessmentGuardEvidence
    if (!hook) return null
    const snapshot = hook.getSnapshot()
    const decisions = ['prompt', 'proposal', 'voice'].map((kind) => {
      const decision = hook.authorizeCompanionDelivery(kind)
      return { kind, allowed: decision.allowed, reason: decision.allowed ? null : decision.reason }
    })
    return {
      state: snapshot.state,
      reason: snapshot.reason,
      hasRunKey: snapshot.runId !== null && snapshot.runtimeEpoch !== null,
      decisions,
    }
  }).catch(() => null)
}

async function assertFormalGuardActive(label) {
  const evidence = await readFormalGuardEvidence()
  if (!evidence || evidence.state !== 'active' || evidence.decisions.some((decision) => decision.allowed || decision.reason !== 'formal_assessment_silence')) {
    throw new Error(`${label} FormalAssessmentGuard did not enter active silent state: ${JSON.stringify(evidence)}`)
  }
  formalGuardActiveObserved = true
}

async function assertFormalGuardReleased(label) {
  const evidence = await readFormalGuardEvidence()
  if (!evidence || evidence.state !== 'inactive' || evidence.decisions.some((decision) => !decision.allowed)) {
    throw new Error(`${label} FormalAssessmentGuard did not release after renderer cleanup: ${JSON.stringify(evidence)}`)
  }
  formalGuardReleasedObserved = true
}

async function waitForLocalApiReady(timeout = 120_000) {
  const origin = (process.env.DESKTOP_API_ORIGIN || `http://127.0.0.1:${process.env.PORT || '4000'}`).replace(/\/+$/, '')
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(2_500) })
      if (response.ok) {
        const body = await response.json()
        if (body?.status === 'ready') return
      }
    } catch {
      // The compose service can be running before its dependency checks pass.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  }
  throw new Error('Local API did not become ready after packaged offline startup probe')
}

async function runOfflineStartupRecovery() {
  const offlineUserDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-packaged-offline-'))
  let offlineElectronApp
  try {
    await execFileAsync('docker', ['compose', '-f', devComposeFile, 'stop', 'api'], {
      cwd: workspaceRoot,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    offlineElectronApp = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${offlineUserDataDir}`],
      env: smokeAppEnv,
    })
    const offlineWindow = await offlineElectronApp.firstWindow()
    attachWindowDiagnostics(offlineWindow)
    const boundary = await waitForPackagedWindow(offlineWindow, 'Offline cold start')
    const accessGate = await assertFailClosedAccessGate(offlineWindow, 'Packaged offline cold start')
    offlineAccessGateBoundary = accessGate
    const shell = await offlineWindow.evaluate(() => ({
      hasAccessGate: Boolean(document.querySelector('.desktop-access-gate')),
      hasRoomDom: Boolean(document.querySelector('.scene-stage')),
      hasOnboarding: Boolean(document.querySelector('.onboarding-card')),
      hasActionRail: Boolean(document.querySelector('.action-rail')),
    }))
    if (!boundary.hasAccessGate || !shell.hasAccessGate || shell.hasRoomDom || shell.hasOnboarding || shell.hasActionRail) {
      throw new Error(`Packaged offline startup did not isolate Room behind the access Gate: ${JSON.stringify({ boundary, accessGate, shell })}`)
    }
    const health = await packagedTransportProbe(offlineWindow, 'health')
    const room = await packagedTransportProbe(offlineWindow, 'room')
    const unavailableCodes = ['api_unavailable', 'network_timeout', 'invoke_failed']
    if (health.ok || !unavailableCodes.includes(health.code) || room.ok || !unavailableCodes.includes(room.code)) {
      throw new Error(`Packaged offline startup did not fail closed at the API boundary: ${JSON.stringify({ health, room })}`)
    }
    const retry = await offlineWindow.evaluate(async () => {
      const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const response = await window.ailearn.runtime.retryApiConnection({
        meta: {
          version: 1,
          contractVersion: window.ailearn.contract.contractVersion,
          requestId: opaqueId('packaged-offline-retry-request'),
          correlationId: opaqueId('packaged-offline-retry-correlation'),
          clientStartedAt: new Date().toISOString(),
        },
      }).catch(() => null)
      return response?.ok ? { ok: true, kind: response.data.kind } : { ok: false, code: response?.error?.code ?? 'invoke_failed' }
    })
    if (retry.ok || !unavailableCodes.includes(retry.code)) {
      throw new Error(`Packaged offline retry did not remain fail closed: ${JSON.stringify(retry)}`)
    }
    offlineStartRecovery = true
  } finally {
    await offlineElectronApp?.close()
    await rm(offlineUserDataDir, { recursive: true, force: true })
    await execFileAsync('docker', ['compose', '-f', devComposeFile, 'up', '-d', 'api'], {
      cwd: workspaceRoot,
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    await waitForLocalApiReady()
  }
}

async function restartApiForPackagedRecovery() {
  await execFileAsync('docker', ['compose', '-f', devComposeFile, 'stop', 'api'], {
    cwd: workspaceRoot,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  try {
    let unavailable = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      unavailable = await packagedTransportProbe(currentWindow, 'health')
      if (!unavailable.ok && ['api_unavailable', 'network_timeout', 'invoke_failed'].includes(unavailable.code)) break
      await currentWindow.waitForTimeout(500)
    }
    if (!unavailable || unavailable.ok || !['api_unavailable', 'network_timeout', 'invoke_failed'].includes(unavailable.code)) {
      throw new Error(`Packaged API restart did not expose a fail-closed unavailable state: ${JSON.stringify(unavailable)}`)
    }
    const lostProjection = await packagedTransportProbe(currentWindow, 'room')
    if (lostProjection.ok || !['api_unavailable', 'network_timeout', 'invoke_failed'].includes(lostProjection.code)) {
      throw new Error(`Packaged response-loss probe did not fail closed: ${JSON.stringify(lostProjection)}`)
    }
    responseLossRecovery = true
  } finally {
    await execFileAsync('docker', ['compose', '-f', devComposeFile, 'up', '-d', 'api'], {
      cwd: workspaceRoot,
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    })
  }

  let recovered = null
  for (let attempt = 0; attempt < 36; attempt += 1) {
    recovered = await currentWindow.evaluate(async () => {
      const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const meta = () => ({
        version: 1,
        contractVersion: window.ailearn.contract.contractVersion,
        requestId: opaqueId('packaged-restart-request'),
        correlationId: opaqueId('packaged-restart-correlation'),
        clientStartedAt: new Date().toISOString(),
      })
      const response = await window.ailearn.runtime.retryApiConnection({ meta: meta() })
      return response.ok ? { ok: true, kind: response.data.kind } : { ok: false, code: response.error.code }
    }).catch(() => ({ ok: false, code: 'invoke_failed' }))
    if (recovered.ok && recovered.kind === 'ready') break
    await currentWindow.waitForTimeout(1_000)
  }
  if (!recovered?.ok || recovered.kind !== 'ready') throw new Error(`Packaged API did not recover after restart: ${JSON.stringify(recovered)}`)
  const healthy = await packagedTransportProbe(currentWindow, 'health')
  if (!healthy.ok) throw new Error(`Packaged API health did not recover after restart: ${JSON.stringify(healthy)}`)
  await currentWindow.locator('.action-rail').waitFor({ state: 'visible', timeout: 20_000 })
  apiRestartRecovery = true
}

async function prepareRestartMarker(window) {
  return window.evaluate(async () => {
    const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const meta = (workspaceEpoch) => ({
      version: 1,
      contractVersion: window.ailearn.contract.contractVersion,
      requestId: opaqueId('packaged-marker-request'),
      correlationId: opaqueId('packaged-marker-correlation'),
      ...(workspaceEpoch > 0 ? { workspaceEpoch } : {}),
      clientStartedAt: new Date().toISOString(),
    })
    const sessionResponse = await window.ailearn.auth.getState({ meta: meta(0) })
    if (!sessionResponse.ok || sessionResponse.data.status !== 'authenticated' || !sessionResponse.data.user || !sessionResponse.data.workspace) {
      throw new Error(`Packaged marker recovery requires an authenticated session: ${JSON.stringify(sessionResponse)}`)
    }
    const epoch = sessionResponse.data.workspaceEpoch
    const projectionResponse = await window.ailearn.room.getProjection({ meta: meta(epoch) })
    if (!projectionResponse.ok) throw new Error(`Packaged marker recovery room read failed: ${JSON.stringify(projectionResponse)}`)
    const focus = projectionResponse.data.primaryFocus
    const objective = focus.state === 'data' ? focus.data.objective : null
    const cardId = objective?.content.presentation.cardId ?? null
    let resolvedOrigin = cardId && objective
      ? { kind: 'card', cardId, objectiveId: objective.objectiveId }
      : null
    if (!resolvedOrigin) {
      const queueResponse = await window.ailearn.review.getQueue({ meta: meta(epoch), limit: 20 })
      if (!queueResponse.ok) throw new Error(`Packaged marker recovery queue read failed: ${JSON.stringify(queueResponse)}`)
      const item = queueResponse.data.items.find((candidate) => candidate.startability.kind === 'ready')
      if (!item) throw new Error('Packaged marker recovery requires a card origin or one ready review item')
      resolvedOrigin = {
        kind: 'review',
        scheduleId: item.scheduleId,
        objectiveId: item.objectiveId,
        scheduleGeneration: item.scheduleGeneration,
      }
    }
    const runResponse = await window.ailearn.learningRun.start({
      meta: meta(epoch),
      commandId: `packaged-marker-start-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      request: {
        version: 2,
        originV2: resolvedOrigin,
        goal: 'stabilize',
        requestedTimeBudgetSeconds: 180,
        responsePreference: 'text',
      },
    })
    if (!runResponse.ok) throw new Error(`Packaged marker recovery run start failed: ${JSON.stringify(runResponse)}`)
    return {
      subjectId: sessionResponse.data.user.userId,
      workspaceId: sessionResponse.data.workspace.workspaceId,
      runId: runResponse.data.runId,
      originV2: runResponse.data.originV2,
    }
  })
}

async function restartPackagedWindow(email, password) {
  await electronApp?.close()
  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: smokeAppEnv,
  })
  currentWindow = await electronApp.firstWindow()
  attachWindowDiagnostics(currentWindow)
  await waitForPackagedWindow(currentWindow, 'Restarted')
  await authenticateThroughAccessGate(currentWindow, {
    email,
    password,
    expectedRole: smokeRole,
    label: 'Packaged restart',
  })
}

async function runPackagedRestartRecovery(email, password) {
  const marker = await prepareRestartMarker(currentWindow)
  const markerPath = resolve(userDataDir, 'pending-return-markers-v2.json')
  await writeFile(markerPath, JSON.stringify({
    version: 1,
    entries: [{
      subjectId: marker.subjectId,
      workspaceId: marker.workspaceId,
      marker: {
        version: 2,
        runId: marker.runId,
        originV2: marker.originV2,
        checkedAt: new Date().toISOString(),
      },
    }],
  }), { mode: 0o600 })
  await restartPackagedWindow(email, password)
  const persisted = JSON.parse(await readFile(markerPath, 'utf8'))
  const remaining = persisted.entries?.filter((entry) => entry.subjectId === marker.subjectId && entry.workspaceId === marker.workspaceId) ?? []
  if (remaining.length !== 0) throw new Error(`Packaged marker was not cleared after restart recovery: ${JSON.stringify(remaining)}`)
  markerRestartRecovery = true
}

async function runOwnerJourney(window) {
  if (!ownerCredentialsAvailable) return
  await authenticateThroughAccessGate(window, {
    email: process.env.OWNER_EMAIL,
    password: process.env.OWNER_PASSWORD,
    expectedRole: 'owner',
    label: 'Packaged Owner',
  })
  ownerJourney.authenticated = true

  const generationRecoveryButton = window.getByRole('button', { name: /查看恢复状态|恢复候选审核/ })
  if (await generationRecoveryButton.count()) {
    await generationRecoveryButton.first().click()
    await window.getByRole('heading', { name: '整理学习卡' }).waitFor()
    await window.waitForFunction(
      () => Boolean(document.querySelector('.card-generation-meta')) || Boolean(document.querySelector('.card-generation-state--error')),
      undefined,
      { timeout: 15_000 },
    )
    if (await window.locator('.card-generation-state--error').count()) {
      throw new Error(`Packaged Owner Card Generation recovery failed: ${await window.locator('.card-generation-state--error').innerText()}`)
    }
    const generationContract = await window.evaluate(() => ({
      runMetaVisible: Boolean(document.querySelector('.card-generation-meta')),
      candidateListVisible: Boolean(document.querySelector('.card-generation-list')),
      terminalStateVisible: Boolean(document.querySelector('.card-generation-state--inline, .card-generation-empty')),
      localSuccessControls: [...document.querySelectorAll('button')].filter((button) => /本机候选|自动激活|生成完成/.test(button.textContent ?? '')).length,
    }))
    if (!generationContract.runMetaVisible || (!generationContract.candidateListVisible && !generationContract.terminalStateVisible) || generationContract.localSuccessControls !== 0) {
      throw new Error(`Packaged Owner Card Generation contract failed: ${JSON.stringify(generationContract)}`)
    }
    ownerJourney.cardGeneration = true
    await window.getByRole('button', { name: '关闭学习卡生成并返回房间' }).click()
  }

  await window.getByTestId('action-continue').click()
  await waitForStudyObjectSurface(window, 'Packaged Owner Study')
  await window.getByRole('button', { name: '进入研究册' }).click()
  await window.locator('.notebook-editor-workbench').waitFor({ state: 'visible', timeout: 15_000 })
  await window.waitForFunction(
    () => Boolean(document.querySelector('.notebook-readonly, textarea[aria-label="真实笔记内容"]')) || Boolean(document.querySelector('.notebook-state--error')),
    undefined,
    { timeout: 15_000 },
  )
  if (await window.locator('.notebook-state--error').count()) {
    throw new Error(`Packaged Owner Note projection failed: ${await window.locator('.notebook-state--error').innerText()}`)
  }
  if (await window.locator('.notebook-readonly, textarea[aria-label="真实笔记内容"]').count() !== 1) {
    throw new Error('Packaged Owner Note projection did not expose real note content')
  }
  ownerJourney.note = true

  const startCardGeneration = async () => {
    const generateCardsButton = window.getByRole('button', { name: '根据整篇笔记生成学习卡' })
    await generateCardsButton.waitFor({ state: 'visible', timeout: 15_000 })
    if (await generateCardsButton.isDisabled()) throw new Error('Packaged Owner Card Generation action is unavailable')
    await generateCardsButton.click()
    await waitForCardGenerationSurface(window)
  }
  await startCardGeneration()
  let selectedCandidate = false
  let lastKeepAttempt = null
  for (let generationAttempt = 0; generationAttempt < 3 && !selectedCandidate; generationAttempt += 1) {
    if (generationAttempt > 0) {
      const returnToNote = window.getByRole('button', { name: '回研究册' })
      if (await returnToNote.count() === 0) break
      await returnToNote.click()
      await window.locator('.notebook-editor-workbench').waitFor({ state: 'visible', timeout: 15_000 })
      await startCardGeneration()
    }
    lastKeepAttempt = null
    for (let attempt = 0; attempt < 5 && !selectedCandidate; attempt += 1) {
    const cardGenerationDeadline = Date.now() + (attempt === 0 ? 180_000 : 60_000)
    while (Date.now() < cardGenerationDeadline) {
      if (await window.locator('.card-generation-state--error').count()) break
      if (await window.getByRole('button', { name: '保留', exact: true }).count()) break
      const refreshButton = window.getByRole('button', { name: '重新读取生成任务' })
      if (await refreshButton.count()) await refreshButton.click().catch(() => {})
      await window.waitForTimeout(2_000)
    }
    if (await window.locator('.card-generation-state--error').count()) {
      const resyncButton = window.getByRole('button', { name: '重新同步' })
      if (await resyncButton.count()) await resyncButton.click().catch(() => {})
      await window.waitForFunction(
        () => !document.querySelector('.card-generation-state--error'),
        undefined,
        { timeout: 10_000 },
      ).catch(() => {})
      await window.waitForTimeout(1_000)
      continue
    }
    if (await window.getByRole('button', { name: '保留', exact: true }).count() === 0) {
      lastKeepAttempt = { attempt: attempt + 1, reason: 'review_ready_not_reached_before_deadline', diagnostics: await readCardGenerationDiagnostics(window) }
      const refreshButton = window.getByRole('button', { name: '重新读取生成任务' })
      if (await refreshButton.count()) await refreshButton.click().catch(() => {})
      await window.waitForTimeout(1_000)
      continue
    }
    // The worker can replace a failed candidate with a bounded-repair revision
    // between two refreshes. Scope the click to one rendered candidate and
    // require the same DOM snapshot to survive a short settling window so the
    // action carries the latest revision/hash pair from React state.
    const reviewCandidate = window.locator('.card-generation-candidate').filter({
      has: window.locator('button').filter({ hasText: /^保留$/ }),
    }).first()
    await reviewCandidate.waitFor({ state: 'visible', timeout: 5_000 })
    const firstSnapshot = await reviewCandidate.innerText()
    await window.waitForTimeout(350)
    const secondSnapshot = await reviewCandidate.innerText()
    if (firstSnapshot !== secondSnapshot) {
      lastKeepAttempt = { attempt: attempt + 1, reason: 'candidate_dom_changed_before_click', diagnostics: await readCardGenerationDiagnostics(window) }
      continue
    }
    const keepButton = reviewCandidate.getByRole('button', { name: '保留', exact: true })
    await keepButton.scrollIntoViewIfNeeded()
    await keepButton.click()
    const reviewCommitDeadline = Date.now() + 45_000
    while (Date.now() < reviewCommitDeadline) {
      if (await window.locator('.card-generation-select input[type="checkbox"]').count()) {
        selectedCandidate = true
        break
      }
      if (await window.locator('.card-generation-state--error').count()) {
        lastKeepAttempt = { attempt: attempt + 1, reason: 'review_request_rejected', diagnostics: await readCardGenerationDiagnostics(window) }
        break
      }
      await window.waitForTimeout(1_000)
    }
    if (!selectedCandidate) {
      if (!lastKeepAttempt || lastKeepAttempt.attempt !== attempt + 1) {
        lastKeepAttempt = { attempt: attempt + 1, reason: 'review_commit_timeout', diagnostics: await readCardGenerationDiagnostics(window) }
      }
      const resyncButton = window.getByRole('button', { name: '重新同步' })
      if (await resyncButton.count()) await resyncButton.click().catch(() => {})
      const refreshButton = window.getByRole('button', { name: '重新读取生成任务' })
      if (await refreshButton.count()) await refreshButton.click().catch(() => {})
      await window.waitForFunction(
        () => !document.querySelector('.card-generation-state--error'),
        undefined,
        { timeout: 10_000 },
      ).catch(() => {})
      await window.waitForTimeout(1_000)
    }
    }
    if (!selectedCandidate && generationAttempt < 2 && lastKeepAttempt?.reason === 'review_ready_not_reached_before_deadline') {
      // Provider output is intentionally not part of the UI contract. A
      // needs_attention run is a valid server terminal for that run, so use a
      // bounded fresh run attempt rather than clicking forbidden controls or
      // treating the failed quality gate as success.
      continue
    }
    break
  }
  if (!selectedCandidate) {
    const diagnostics = { lastKeepAttempt, final: await readCardGenerationDiagnostics(window) }
    throw new Error(`Packaged Owner Card Generation could not commit a stable keep decision: ${JSON.stringify(diagnostics)}`)
  }
  const selectCandidate = window.locator('.card-generation-select input[type="checkbox"]').first()
  await selectCandidate.waitFor({ state: 'visible', timeout: 15_000 })
  await selectCandidate.check()
  const activateButton = window.getByRole('button', { name: /^激活选中的目标/ })
  await activateButton.waitFor({ state: 'visible', timeout: 15_000 })
  await activateButton.click()
  await window.getByText('服务端激活回执已确认', { exact: false }).waitFor({ state: 'visible', timeout: 30_000 })
  ownerJourney.cardGeneration = true
  ownerJourney.cardActivation = true
  await window.getByLabel('关闭学习卡生成并返回房间').click()

  // GS-01A ends at the strict CardActivationReceiptV2. The Owner branch must
  // not auto-start a same-session formal LearningRun; that is the Member
  // branch's responsibility in GS-01B.
}

async function runMemberJourney(window) {
  if (!memberCredentialsAvailable || ownerCredentialsAvailable) return
  await authenticateThroughAccessGate(window, {
    email: process.env.MEMBER_EMAIL,
    password: process.env.MEMBER_PASSWORD,
    expectedRole: 'member',
    label: 'Packaged Member',
  })
  memberJourney.authenticated = true

  if (await window.getByRole('button', { name: /查看恢复状态|恢复候选审核/ }).count()) {
    throw new Error('Packaged Member session exposed the Owner-only Card Generation recovery action')
  }

  await window.getByTestId('action-review').click()
  await window.getByRole('heading', { name: '今日复习' }).waitFor()
  await window.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="review-queue"]'))
      || Boolean(document.querySelector('.review-scene-state--empty, .review-scene-state--error')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator('.review-scene-state--error').count()) {
    throw new Error(`Packaged Member review queue failed: ${await window.locator('.review-scene-state--error').innerText()}`)
  }
  if (await window.locator('.review-scene-state--empty').count()) {
    throw new Error('Packaged Member review journey requires at least one due ReviewQueueV2 fixture item')
  }
  const reviewStart = window.getByRole('button', { name: /^开始三分钟巩固/ }).first()
  await reviewStart.waitFor({ state: 'visible', timeout: 15_000 })
  if (await reviewStart.isDisabled()) throw new Error('Packaged Member review item is not startable')
  memberJourney.reviewQueue = true
  await reviewStart.click()

  await window.getByRole('heading', { name: '三分钟学习旅程' }).waitFor()
  await waitForLearningRunPlayer(window, 'Packaged Member LearningRun')
  if (await window.locator('.run-player--error').count()) {
    throw new Error(`Packaged Member LearningRun failed: ${await window.locator('.run-player--error').innerText()}`)
  }
  await assertFormalGuardActive('Packaged Member LearningRun')
  memberJourney.learningRun = true
  await window.locator('.task-surface[data-transition="entered"]').waitFor({ state: 'visible', timeout: 15_000 })

  if (learningRunResponseLossOperations.includes('draft')) {
    const textEditor = window.locator('.run-text-editor textarea').first()
    await textEditor.waitFor({ state: 'visible', timeout: 15_000 })
    await textEditor.fill('这是一条用于确认草稿回执的临时回答。')
    const draftResyncAlert = window.locator('.run-resync').filter({ hasText: '草稿版本需要同步' })
    await draftResyncAlert.waitFor({ state: 'visible', timeout: 15_000 })
    await draftResyncAlert.getByRole('button', { name: '同步当前状态' }).click()
    learningRunResponseLossRecoveries.push('draft')
  }

  if (learningRunResponseLossOperations.includes('action')) {
    const hintButton = window.getByRole('button', { name: /给我一点提示|查看第 \d+ 级提示/ }).first()
    await hintButton.waitFor({ state: 'visible', timeout: 15_000 })
    await hintButton.click()
    const resyncAlert = window.locator('.run-resync').filter({ hasText: '上一动作结果需要确认' })
    await resyncAlert.waitFor({ state: 'visible', timeout: 15_000 })
    await resyncAlert.getByRole('button', { name: '同步当前状态' }).click()
    learningRunResponseLossRecoveries.push('action')
  }

  const unableButton = window.getByRole('button', { name: '我暂时不会' })
  await unableButton.waitFor({ state: 'visible', timeout: 15_000 })
  await unableButton.click()
  if (learningRunResponseLossOperations.includes('submit')) {
    const resyncAlert = window.locator('.run-resync').filter({ hasText: '上一动作结果需要确认' })
    await resyncAlert.waitFor({ state: 'visible', timeout: 15_000 })
    const syncButton = resyncAlert.getByRole('button', { name: '同步当前状态' })
    await syncButton.click()
    learningRunResponseLossRecoveries.push('submit')
  }
  await window.waitForFunction(
    () => Boolean(document.querySelector('.run-result, .run-result--terminal')) || Boolean(document.querySelector('.run-player--error')),
    undefined,
    { timeout: 35_000 },
  )
  if (await window.locator('.run-player--error').count()) {
    throw new Error(`Packaged Member LearningRun result failed: ${await window.locator('.run-player--error').innerText()}`)
  }
  if (await window.locator('.run-result, .run-result--terminal').count() !== 1) {
    throw new Error('Packaged Member LearningRun did not expose a server result or terminal result')
  }
  memberJourney.result = true

  const resultReturn = window.getByRole('button', { name: /返回(?:并刷新复习|复习队列)/ }).first()
  await resultReturn.waitFor({ state: 'visible', timeout: 15_000 })
  await resultReturn.click()
  await window.getByRole('heading', { name: '今日复习' }).waitFor()
  await window.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="review-queue"]'))
      || Boolean(document.querySelector('.review-scene-state--empty, .review-scene-state--error')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator('.review-scene-state--error').count()) {
    throw new Error(`Packaged Member review return failed: ${await window.locator('.review-scene-state--error').innerText()}`)
  }
  await assertFormalGuardReleased('Packaged Member LearningRun')
  memberJourney.returned = true

  await window.getByLabel('关闭任务面并返回房间').click()
  await window.getByTestId('action-continue').click()
  await waitForStudyObjectSurface(window, 'Packaged Member Study')
  const notebookButton = window.getByRole('button', { name: '进入研究册' })
  await notebookButton.waitFor({ state: 'visible', timeout: 15_000 })
  await notebookButton.click()
  await window.locator('.notebook-editor-workbench').waitFor({ state: 'visible', timeout: 15_000 })
  await window.waitForFunction(
    () => Boolean(document.querySelector('.notebook-readonly')) || Boolean(document.querySelector('.notebook-state--error')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator('.notebook-state--error').count()) {
    throw new Error(`Packaged Member Note projection failed: ${await window.locator('.notebook-state--error').innerText()}`)
  }
  if (await window.locator('.notebook-readonly').count() !== 1 || await window.locator('textarea[aria-label="真实笔记内容"]').count() !== 0) {
    throw new Error('Packaged Member Note projection is not read-only')
  }
  if (await window.getByRole('button', { name: /根据整篇笔记生成学习卡/ }).count() !== 0) {
    throw new Error('Packaged Member Note still exposes the Owner-only Card Generation action')
  }
  memberJourney.note = true
  await window.getByLabel('关闭任务面并返回房间').click()
}

try {
  await runOfflineStartupRecovery()
  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: smokeAppEnv,
  })
  currentWindow = await electronApp.firstWindow()
  attachWindowDiagnostics(currentWindow)
  const boundary = await waitForPackagedWindow(currentWindow, 'Initial')
  const runtime = await electronApp.evaluate(() => ({
    electronVersion: process.versions.electron ?? 'unknown',
    chromiumVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
  }))

  if (boundary.protocol !== 'ailearn-app:' || !boundary.hasDesktopPreload || !boundary.hasM2Preload) {
    throw new Error(`Packaged boundary contract failed: ${JSON.stringify(boundary)}`)
  }
  const anonymousAccessGate = smokeRole === 'anonymous'
    ? await assertFailClosedAccessGate(currentWindow, 'Packaged anonymous startup')
    : null
  await runOwnerJourney(currentWindow)
  await runMemberJourney(currentWindow)
  if (errors.length > 0) throw new Error(`Packaged renderer emitted errors: ${errors.join('; ')}`)
  if (process.env.AILEARN_PACKAGED_API_RESTART === '1') {
    await restartApiForPackagedRecovery()
    const restartCredentials = smokeRole === 'owner'
      ? { email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD }
      : { email: process.env.MEMBER_EMAIL, password: process.env.MEMBER_PASSWORD }
    if (!restartCredentials.email || !restartCredentials.password) throw new Error(`Packaged ${smokeRole} restart recovery credentials are unavailable`)
    await runPackagedRestartRecovery(restartCredentials.email, restartCredentials.password)
  }
  if (errors.length > 0) throw new Error(`Packaged renderer emitted errors: ${errors.join('; ')}`)
  if (smokeRole === 'member') {
    formalGuardRuntime = formalGuardActiveObserved && formalGuardReleasedObserved
    if (!formalGuardRuntime) throw new Error('Packaged FormalAssessmentGuard runtime evidence is incomplete')
  } else {
    formalGuardRuntime = 'not_applicable'
  }
  await mkdir(evidenceRoot, { recursive: true })
  const smokeEvidence = {
    schemaVersion: 1,
    kind: 'packaged-smoke',
    artifact: process.env.AILEARN_PACKAGED_APP?.trim() ? 'configured-external' : relative(appRoot, executablePath).split('\\').join('/'),
    packageContainment,
    runtime,
    boundary,
    authMode: smokeRole,
    ownerJourney,
    memberJourney,
    apiRestartRecovery,
    responseLossRecovery,
    learningRunResponseLossRecovery: smokeRole === 'member' ? learningRunResponseLossRecoveries.length === learningRunResponseLossOperations.length : 'not_applicable',
    learningRunResponseLossOperations: smokeRole === 'member' ? learningRunResponseLossRecoveries : 'not_applicable',
    markerRestartRecovery,
    offlineStartRecovery,
    offlineAccessGateBoundary,
    anonymousAccessGate,
    formalGuardRuntime,
    errors,
  }
  await writeFile(resolve(evidenceRoot, 'package-smoke.json'), `${JSON.stringify(smokeEvidence, null, 2)}\n`, 'utf8')
  await writeFile(resolve(evidenceRoot, `package-smoke-${smokeRole}.json`), `${JSON.stringify(smokeEvidence, null, 2)}\n`, 'utf8')
  process.stdout.write('packaged smoke passed\n')
} finally {
  await electronApp?.close()
  await rm(userDataDir, { recursive: true, force: true })
}
