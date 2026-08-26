import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const workspaceRoot = resolve(appRoot, '../..')
const evidenceRoot = resolve(workspaceRoot, '.impeccable/evidence')
const captureInputPath = resolve(evidenceRoot, 'capture-manifest.input.json')
const packagedInputPath = resolve(evidenceRoot, 'packaged-manifest.input.json')
const packagedOutputPath = resolve(evidenceRoot, 'packaged-manifest.json')
const smokePath = resolve(evidenceRoot, 'package-smoke.json')
const ownerSmokePath = resolve(evidenceRoot, 'package-smoke-owner.json')
const memberSmokePath = resolve(evidenceRoot, 'package-smoke-member.json')

function workspacePath(path) {
  return relative(workspaceRoot, path).split('\\').join('/')
}

async function digestFile(path) {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`Packaged artifact is not a regular file: ${path}`)
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function packagedArtifactPath() {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return resolve(appRoot, 'release/AI Learn-0.1.0-mac-arm64.zip')
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return resolve(appRoot, 'release/AI Learn-0.1.0-win-x64.nsis.zip')
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return resolve(appRoot, 'release/AI Learn-0.1.0-linux-x64.AppImage')
  }
  throw new Error(`No packaged artifact mapping for ${process.platform}/${process.arch}`)
}

const captureManifest = JSON.parse(await readFile(captureInputPath, 'utf8'))
const smokeInfo = JSON.parse(await readFile(smokePath, 'utf8'))
let ownerSmokeInfo = null
try {
  ownerSmokeInfo = JSON.parse(await readFile(ownerSmokePath, 'utf8'))
} catch {
  // The generic smoke file remains a compatibility fallback for older runs.
}
let memberSmokeInfo = null
try {
  memberSmokeInfo = JSON.parse(await readFile(memberSmokePath, 'utf8'))
} catch {
  // Member packaged evidence is an additive role branch; Owner-only local
  // evidence remains valid when no Member fixture is available.
}
const ownerEvidence = ownerSmokeInfo?.authMode === 'owner'
  ? ownerSmokeInfo
  : smokeInfo.authMode === 'owner'
    ? smokeInfo
    : null
const memberEvidence = memberSmokeInfo?.authMode === 'member'
  ? memberSmokeInfo
  : smokeInfo.authMode === 'member'
    ? smokeInfo
    : null
const packagedArtifact = packagedArtifactPath()
const packageArtifactSha256 = await digestFile(packagedArtifact)
const packagedOwnerJourneyPassed = ownerEvidence?.ownerJourney?.authenticated === true
  && ownerEvidence.ownerJourney?.cardGeneration === true
  && ownerEvidence.ownerJourney?.cardActivation === true
  && ownerEvidence.ownerJourney?.note === true
const packagedMemberJourneyPassed = memberEvidence?.memberJourney?.authenticated === true
  && memberEvidence.memberJourney?.reviewQueue === true
  && memberEvidence.memberJourney?.learningRun === true
  && memberEvidence.memberJourney?.result === true
  && memberEvidence.memberJourney?.returned === true
  && memberEvidence.memberJourney?.note === true
const packagedRestartRecoveryPassed = packagedOwnerJourneyPassed
  && packagedMemberJourneyPassed
  && ownerEvidence?.apiRestartRecovery === true
  && ownerEvidence?.responseLossRecovery === true
  && ownerEvidence?.learningRunResponseLossRecovery === 'not_applicable'
  && ownerEvidence?.markerRestartRecovery === true
  && ownerEvidence?.offlineStartRecovery === true
  && ownerEvidence?.formalGuardRuntime === 'not_applicable'
  && memberEvidence?.apiRestartRecovery === true
  && memberEvidence?.responseLossRecovery === true
  && memberEvidence?.learningRunResponseLossRecovery === true
  && ['draft', 'action', 'submit'].every((operation) => memberEvidence?.learningRunResponseLossOperations?.includes(operation))
  && memberEvidence?.markerRestartRecovery === true
  && memberEvidence?.offlineStartRecovery === true
  && memberEvidence?.formalGuardRuntime === true

for (const key of ['electronVersion', 'chromiumVersion', 'nodeVersion']) {
  if (smokeInfo.runtime?.[key] !== captureManifest.environment?.[key]) {
    throw new Error(`Packaged smoke runtime drifted for ${key}: capture=${captureManifest.environment?.[key]} smoke=${smokeInfo.runtime?.[key]}`)
  }
}

const packagedManifest = {
  ...captureManifest,
  environment: {
    ...captureManifest.environment,
    artifactSha256: packageArtifactSha256,
  },
  gates: captureManifest.gates.map((gate) => gate.id === 'EVIDENCE-INFRA-01'
    ? {
        ...gate,
        evidenceFiles: [
          ...gate.evidenceFiles,
          { path: workspacePath(smokePath), sha256: 'auto' },
          ...(ownerEvidence ? [{ path: workspacePath(ownerSmokePath), sha256: 'auto' }] : []),
          ...(memberEvidence ? [{ path: workspacePath(memberSmokePath), sha256: 'auto' }] : []),
        ],
        reason: packagedOwnerJourneyPassed && packagedMemberJourneyPassed && packagedRestartRecoveryPassed
          ? 'Component capture, Owner and Member journeys, Owner Card Generation activation receipt, Member LearningRun draft + action + submit response-loss → resync, offline/API/marker recovery, FormalAssessmentGuard runtime, packaged smoke and strict manifest validation are runnable; approval remains a separate blocking gate.'
          : packagedOwnerJourneyPassed && packagedMemberJourneyPassed
            ? 'Component capture, authenticated Owner and Member renderer journeys and packaged artifact smoke are runnable; API restart/response-loss and persisted return-marker recovery evidence remain incomplete, and approval remains a separate blocking gate.'
          : packagedOwnerJourneyPassed
            ? 'Component capture, authenticated Owner renderer journey including Card Generation activation, authenticated packaged Owner journey, packaged artifact smoke and strict manifest validation are runnable; Member journey and approval remain separate blocking gates.'
            : 'Component capture, local renderer journey, packaged artifact smoke and strict manifest validation are runnable; real API/Owner journey and approval remain separate blocking gates.',
      }
    : gate),
  knownIssues: [
    ...captureManifest.knownIssues.filter((issue) => issue.id !== 'PACKAGED-SMOKE-PENDING' && issue.id !== 'PACKAGED-RECOVERY-EVIDENCE-PENDING'),
    ...(packagedRestartRecoveryPassed ? [] : [{ id: 'PACKAGED-RECOVERY-EVIDENCE-PENDING', severity: 'P1', owner: 'Engineering' }]),
  ],
}

for (const [label, evidence] of [['Owner', ownerEvidence], ['Member', memberEvidence]]) {
  if (!evidence) continue
  if (evidence.boundary?.protocol !== 'ailearn-app:' || !evidence.boundary?.hasDesktopPreload || !evidence.boundary?.hasM2Preload || !evidence.boundary?.hasRoomDom) {
    throw new Error(`Packaged ${label} smoke boundary evidence is incomplete: ${JSON.stringify(evidence.boundary)}`)
  }
}
if (ownerEvidence && !packagedOwnerJourneyPassed) {
  throw new Error(`Packaged Owner journey evidence is incomplete: ${JSON.stringify(ownerEvidence.ownerJourney)}`)
}
if (memberEvidence && !packagedMemberJourneyPassed) {
  throw new Error(`Packaged Member journey evidence is incomplete: ${JSON.stringify(memberEvidence.memberJourney)}`)
}

await mkdir(evidenceRoot, { recursive: true })
await writeFile(packagedInputPath, `${JSON.stringify(packagedManifest, null, 2)}\n`, 'utf8')
await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    resolve(appRoot, 'scripts/evidence-manifest.ts'),
    '--input',
    packagedInputPath,
    '--output',
    packagedOutputPath,
    '--root',
    workspaceRoot,
  ], { cwd: appRoot, env: process.env, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) resolvePromise()
    else reject(new Error(`evidence-manifest.ts exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
  })
})

console.log(`Packaged evidence manifest written to ${packagedOutputPath}`)
