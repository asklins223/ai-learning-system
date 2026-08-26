import { existsSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const appRoot = resolve(import.meta.dirname, '..')
const runtimeRoot = resolve(appRoot, 'src/renderer/public/assets/learning-room/v1')
const rendererOut = resolve(appRoot, 'out/renderer')
const rejectedRuntimeMedia = [
  'graph-entry-fog-v1.mp4',
  'validation-ink-bloom-v1.mp4',
  'companion-wake-v1.webm',
  'companion-confirm-v1.webm',
]
const releaseExcludedOutPrefixes = [
  'assets/3d/',
  'assets/companion/live2d-v1/',
  'assets/companion/vendor/',
]

function listFiles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

describe('runtime asset containment', () => {
  it('keeps all rejected media out of runtime source and renderer out', () => {
    const boundaryFiles = [...listFiles(runtimeRoot), ...listFiles(rendererOut)]
    for (const rejectedName of rejectedRuntimeMedia) {
      expect(boundaryFiles.some((file) => file.endsWith(`/${rejectedName}`))).toBe(false)
    }
  })

  it('keeps migration and unlicensed companion archives out of renderer out', () => {
    const outFiles = listFiles(rendererOut).map((file) => relative(rendererOut, file).split(sep).join('/'))
    for (const prefix of releaseExcludedOutPrefixes) {
      expect(outFiles.some((file) => file.startsWith(prefix))).toBe(false)
    }
    expect(outFiles).toContain('assets/learning-room/v1/objects/companion-orb.webp')
  })
})
