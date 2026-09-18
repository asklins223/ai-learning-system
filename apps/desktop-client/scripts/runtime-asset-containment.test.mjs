import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const appRoot = resolve(import.meta.dirname, '..')
const runtimeRoot = resolve(appRoot, 'src/renderer/public/assets/learning-room/v1')
const rendererOut = resolve(appRoot, 'out/renderer')
const activeLive2dSourceRoot = resolve(appRoot, 'src/renderer/public/assets/companion/live2d-v2/seethrough')
const activeLive2dOutRoot = resolve(rendererOut, 'assets/companion/live2d-v2/seethrough')
const activeLive2dModel = 'seethrough_output.model3.json'
const rejectedRuntimeMedia = [
  'graph-entry-fog-v1.mp4',
  'validation-ink-bloom-v1.mp4',
  'companion-wake-v1.webm',
  'companion-confirm-v1.webm',
]
const releaseExcludedOutPrefixes = [
  'assets/3d/',
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

  it('keeps migration archives out while shipping the bundled Live2D runtimes', () => {
    const outFiles = listFiles(rendererOut).map((file) => relative(rendererOut, file).split(sep).join('/'))
    for (const prefix of releaseExcludedOutPrefixes) {
      expect(outFiles.some((file) => file.startsWith(prefix))).toBe(false)
    }
    // 2026-09-16 裁决移除 orb：它不得再进入 runtime 产物。
    expect(outFiles).not.toContain('assets/learning-room/v1/objects/companion-orb.webp')
    expect(outFiles).toContain('assets/companion/live2d-v2/seethrough/seethrough_output.model3.json')
    expect(outFiles).toContain('assets/companion/live2d-v1/mao-pro/runtime/mao_pro.model3.json')
    expect(outFiles).toContain('assets/companion/vendor/pixi.min.js')
  })

  it('keeps every active PSD2Live model reference present in source and output', () => {
    const sourceModel = JSON.parse(readFileSync(resolve(activeLive2dSourceRoot, activeLive2dModel), 'utf8'))
    const outputModel = JSON.parse(readFileSync(resolve(activeLive2dOutRoot, activeLive2dModel), 'utf8'))
    expect(outputModel).toEqual(sourceModel)
    expect(sourceModel.Version).toBe(3)
    expect(sourceModel.Groups).toEqual(expect.arrayContaining([
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    ]))
    expect(Object.keys(sourceModel.FileReferences.Motions)).toEqual(expect.arrayContaining([
      'Idle', 'Blink', 'Nod', 'Shake', 'Think', 'Happy', 'Surprised', 'Sleepy',
    ]))

    const displayInfo = JSON.parse(readFileSync(resolve(activeLive2dSourceRoot, 'seethrough_output.cdi3.json'), 'utf8'))
    expect(displayInfo.Parameters.map((parameter) => parameter.Id)).toEqual(expect.arrayContaining([
      'ParamArmL', 'ParamArmR', 'ParamLegL', 'ParamLegR',
    ]))

    for (const motionName of ['idle', 'think', 'happy', 'surprised', 'sleepy']) {
      const motionFile = `seethrough_output.${motionName}.motion3.json`
      const motion = JSON.parse(readFileSync(resolve(activeLive2dSourceRoot, motionFile), 'utf8'))
      expect(motion.Curves.map((curve) => curve.Id)).toEqual(expect.arrayContaining([
        'ParamArmL',
        'ParamArmR',
      ]))
    }

    const references = [
      sourceModel.FileReferences.Moc,
      ...sourceModel.FileReferences.Textures,
      sourceModel.FileReferences.Physics,
      sourceModel.FileReferences.DisplayInfo,
      ...Object.values(sourceModel.FileReferences.Motions).flat().map((motion) => motion.File),
    ]
    expect(references.filter((reference) => !existsSync(resolve(activeLive2dSourceRoot, reference)))).toEqual([])
    expect(references.filter((reference) => !existsSync(resolve(activeLive2dOutRoot, reference)))).toEqual([])
  })
})
