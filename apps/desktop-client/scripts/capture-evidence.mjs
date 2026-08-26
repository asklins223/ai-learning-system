import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const workspaceRoot = resolve(appRoot, '../..')
const reviewRoot = resolve(workspaceRoot, '.impeccable/review')
const evidenceRoot = resolve(workspaceRoot, '.impeccable/evidence')
const inputPath = resolve(evidenceRoot, 'capture-manifest.input.json')
const outputPath = resolve(evidenceRoot, 'capture-manifest.json')

await mkdir(evidenceRoot, { recursive: true })

function workspacePath(path) {
  return relative(workspaceRoot, path).split('\\').join('/')
}

function digestBuffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function digestPath(path) {
  const info = await stat(path)
  if (info.isFile()) return digestBuffer(await readFile(path))
  if (!info.isDirectory()) throw new Error(`Cannot hash non-file evidence path: ${path}`)
  const entries = await readdir(path, { withFileTypes: true })
  const chunks = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childDigest = await digestPath(resolve(path, entry.name))
    chunks.push(Buffer.from(`${entry.name}\0${childDigest}\n`, 'utf8'))
  }
  return digestBuffer(Buffer.concat(chunks))
}

function runNodeScript(scriptName) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(appRoot, 'scripts', scriptName)], {
      cwd: appRoot,
      env: { ...process.env, TZ: 'Asia/Shanghai', LANG: 'zh_CN.UTF-8' },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${scriptName} exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
    })
  })
}

function osName(platform) {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  throw new Error(`Unsupported capture platform: ${platform}`)
}

function archName(arch) {
  if (arch === 'arm64' || arch === 'x64') return arch
  throw new Error(`Unsupported capture architecture: ${arch}`)
}

function requireRuntimeValue(runtime, key) {
  const value = runtime[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Capture runtime is missing ${key}`)
  return value
}

const captureStartedAt = Date.now()
await mkdir(reviewRoot, { recursive: true })

// Keep generated evidence run-scoped. In particular, an anonymous capture
// must not leave a previous authenticated Owner screenshot beside the current
// safe-boundary evidence where a human reviewer could mistake it for proof of
// the current run.
const runScopedEvidenceNames = [
  'desktop-learning-run-owner.png',
  'desktop-card-generation-owner.png',
  'desktop-notebook-owner.png',
]
await Promise.all(runScopedEvidenceNames.map((name) => rm(resolve(reviewRoot, name), { force: true })))

await runNodeScript('capture-island.mjs')
await runNodeScript('capture-scene.mjs')

const capturedEntries = await readdir(reviewRoot, { withFileTypes: true })
const capturedPngs = await Promise.all(
  capturedEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map(async (entry) => ({ name: entry.name, modifiedAt: (await stat(resolve(reviewRoot, entry.name))).mtimeMs })),
)
const pngNames = capturedPngs
  .filter((entry) => entry.modifiedAt >= captureStartedAt)
  .map((entry) => entry.name)
  .sort()
const runtimeStat = await stat(resolve(reviewRoot, 'capture-runtime.json'))
if (
  runtimeStat.mtimeMs < captureStartedAt
  || !pngNames.includes('global-island-actions.png')
  || !pngNames.includes('desktop.png')
) {
  throw new Error('Capture harness did not produce both component and real-journey PNG evidence')
}

const runtime = JSON.parse(await readFile(resolve(reviewRoot, 'capture-runtime.json'), 'utf8'))
const fontManifestPath = resolve(reviewRoot, 'capture-font-manifest.json')
const fontManifest = JSON.parse(await readFile(fontManifestPath, 'utf8'))
const assetManifestPath = resolve(appRoot, 'src/renderer/public/assets/learning-room/v1/manifest.json')
const artifactPath = resolve(appRoot, 'out')
const runtimeEvidence = ['capture-runtime.json', 'capture-font-manifest.json']
const evidenceFiles = [
  ...pngNames.map((name) => ({ path: workspacePath(resolve(reviewRoot, name)), sha256: 'auto' })),
  ...runtimeEvidence.map((name) => ({ path: workspacePath(resolve(reviewRoot, name)), sha256: 'auto' })),
]
const knownIssues = [
  ...(runtime.authMode === 'owner' ? [] : [{ id: 'OWNER-API-HAPPY-PATH-PENDING', severity: 'P1', owner: 'Owner' }]),
  ...(fontManifest.fontEntries?.some((entry) => entry.status === 'loaded' && entry.family === 'Noto Sans SC Variable')
    && fontManifest.fontEntries?.some((entry) => entry.status === 'loaded' && entry.family === 'Noto Serif SC Variable')
    ? []
    : [{ id: 'FONT-FALLBACK-NOT-BUNDLED', severity: 'P1', owner: 'Owner' }]),
  { id: 'OWNER-BASELINE-APPROVAL-PENDING', severity: 'P1', owner: 'Owner' },
]
if (runtime.mediaMode === 'poster-only') {
  knownIssues.push({ id: 'CAPTURE-MEDIA-POSTER-ONLY', severity: 'P2', owner: 'Owner' })
}

const manifest = {
  schemaVersion: 1,
  suiteRevision: 'desktop-evidence-infra-v1',
  environment: {
    schemaVersion: 1,
    gitCommit: '0000000',
    artifactSha256: await digestPath(artifactPath),
    electronVersion: requireRuntimeValue(runtime, 'electronVersion'),
    chromiumVersion: requireRuntimeValue(runtime, 'chromiumVersion'),
    nodeVersion: requireRuntimeValue(runtime, 'nodeVersion'),
    os: osName(requireRuntimeValue(runtime, 'platform')),
    osVersion: requireRuntimeValue(runtime, 'osVersion'),
    arch: archName(requireRuntimeValue(runtime, 'arch')),
    viewport: runtime.viewport,
    deviceScaleFactor: runtime.deviceScaleFactor,
    zoomFactor: runtime.zoomFactor,
    locale: runtime.locale,
    timezone: runtime.timezone,
    theme: runtime.theme,
    motionMode: runtime.motionMode,
    mediaMode: runtime.mediaMode,
    fontManifestSha256: await digestPath(fontManifestPath),
    assetManifestSha256: await digestPath(assetManifestPath),
    seedRevision: 'desktop-room-projection-boundary-v1',
    apiBuildRevision: 'renderer-desktop-contract-boundary-v1',
    domainSchemaRevision: 'shared-contracts-v1',
  },
  gates: [
    {
      id: 'EVIDENCE-INFRA-01',
      status: 'advisory_passed',
      evidenceFiles,
      reason: runtime.authMode === 'owner'
        ? 'Manifest validation, component capture, authenticated Owner RoomProjection/Note/LearningRun journey and packaged artifact smoke are runnable.'
        : 'Manifest validation, component capture, local renderer journey and packaged artifact smoke are runnable; real API/Owner journey remains a separate blocking gate.',
    },
  ],
  visualBaselines: [
    workspacePath(resolve(reviewRoot, 'global-island-actions.png')),
    workspacePath(resolve(reviewRoot, 'desktop.png')),
  ],
  knownIssues,
  redactionsApplied: [
    'No user content, token, cookie, pairing key or absolute user directory is written to the capture manifest.',
  ],
}

await writeFile(inputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    resolve(appRoot, 'scripts/evidence-manifest.ts'),
    '--input',
    inputPath,
    '--output',
    outputPath,
    '--root',
    workspaceRoot,
  ], { cwd: appRoot, env: process.env, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) resolvePromise()
    else reject(new Error(`evidence-manifest.ts exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
  })
})

console.log(`Capture evidence manifest written to ${outputPath}`)
