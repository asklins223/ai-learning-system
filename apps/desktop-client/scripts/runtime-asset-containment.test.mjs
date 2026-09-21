import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const appRoot = resolve(import.meta.dirname, '..')
const runtimeRoot = resolve(appRoot, 'src/renderer/public/assets/learning-room/v1')
const rendererOut = resolve(appRoot, 'out/renderer')
// 2026-09-20 多形态裁决：运行时模型 = live2d-v1/mao-pro + live2d-v2/seethrough
// （纹理由用户 2026-09-20 恢复，哈希与 2026-09-15 导出一致）+ live2d-v3/whale。
// `window-live2d-contract.ts` 的 WINDOW_LIVE2D_MODEL_REGISTRY 是唯一真话。
const activeLive2dModels = [
  {
    sourceRoot: resolve(appRoot, 'src/renderer/public/assets/companion/live2d-v1/mao-pro/runtime'),
    outRoot: resolve(rendererOut, 'assets/companion/live2d-v1/mao-pro/runtime'),
    modelFile: 'mao_pro.model3.json',
  },
  {
    sourceRoot: resolve(appRoot, 'src/renderer/public/assets/companion/live2d-v2/seethrough'),
    outRoot: resolve(rendererOut, 'assets/companion/live2d-v2/seethrough'),
    modelFile: 'seethrough_output.model3.json',
  },
  {
    sourceRoot: resolve(appRoot, 'src/renderer/public/assets/companion/live2d-v3/whale'),
    outRoot: resolve(rendererOut, 'assets/companion/live2d-v3/whale'),
    modelFile: 'c_0120.model3.json',
  },
]
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
    // 三个在役模型的源资产必须都在（v2/v3 是本会话新增，out 侧等下次构建同步）。
    for (const model of activeLive2dModels) {
      expect(existsSync(resolve(model.sourceRoot, model.modelFile))).toBe(true)
    }
    expect(outFiles).toContain('assets/companion/live2d-v1/mao-pro/runtime/mao_pro.model3.json')
    expect(outFiles).toContain('assets/companion/vendor/pixi.min.js')
  })

  it('keeps every active Live2D model reference present in source', () => {
    for (const model of activeLive2dModels) {
      const sourceModel = JSON.parse(readFileSync(resolve(model.sourceRoot, model.modelFile), 'utf8'))
      expect(sourceModel.Version).toBe(3)

      const references = [
        sourceModel.FileReferences.Moc,
        ...sourceModel.FileReferences.Textures,
        ...(sourceModel.FileReferences.Physics ? [sourceModel.FileReferences.Physics] : []),
        ...(sourceModel.FileReferences.Pose ? [sourceModel.FileReferences.Pose] : []),
        ...(sourceModel.FileReferences.DisplayInfo ? [sourceModel.FileReferences.DisplayInfo] : []),
        ...(sourceModel.FileReferences.Expressions ?? []).map((expression) => expression.File),
        ...Object.values(sourceModel.FileReferences.Motions ?? {}).flat().map((motion) => motion.File),
      ]
      expect(references.filter((reference) => !existsSync(resolve(model.sourceRoot, reference)))).toEqual([])
    }
  })

  it('keeps the bundled mao-pro runtime identical between source and renderer out', () => {
    const mao = activeLive2dModels[0]
    const sourceModel = JSON.parse(readFileSync(resolve(mao.sourceRoot, mao.modelFile), 'utf8'))
    const outputModel = JSON.parse(readFileSync(resolve(mao.outRoot, mao.modelFile), 'utf8'))
    expect(outputModel).toEqual(sourceModel)
    expect(sourceModel.Groups).toEqual(expect.arrayContaining([
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamA'] },
    ]))
    expect(Object.keys(sourceModel.FileReferences.Motions)).toEqual(expect.arrayContaining([
      'Idle',
    ]))

    const references = [
      sourceModel.FileReferences.Moc,
      ...sourceModel.FileReferences.Textures,
      sourceModel.FileReferences.Physics,
      sourceModel.FileReferences.Pose,
      sourceModel.FileReferences.DisplayInfo,
      ...(sourceModel.FileReferences.Expressions ?? []).map((expression) => expression.File),
      ...Object.values(sourceModel.FileReferences.Motions).flat().map((motion) => motion.File),
    ]
    expect(references.filter((reference) => !existsSync(resolve(mao.sourceRoot, reference)))).toEqual([])
    expect(references.filter((reference) => !existsSync(resolve(mao.outRoot, reference)))).toEqual([])
  })

  it('declares the whale runtime groups the driver relies on', () => {
    const whaleRoot = activeLive2dModels.find((model) => model.modelFile === 'c_0120.model3.json').sourceRoot
    const whale = JSON.parse(readFileSync(resolve(whaleRoot, 'c_0120.model3.json'), 'utf8'))
    expect(whale.Groups).toEqual(expect.arrayContaining([
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    ]))
    expect(Object.keys(whale.FileReferences.Motions)).toContain('Idle')
    // 情绪表现走 pixi-live2d 的表情接口：注册表里的别名必须都能在 model3.json 找到。
    const names = (whale.FileReferences.Expressions ?? []).map((expression) => expression.Name)
    for (const alias of ['happy', 'starstruck', 'heart-eyes', 'surprised', 'blush', 'mischievous', 'question', 'dizzy', 'angry', 'sad', 'cry']) {
      expect(names).toContain(alias)
    }
  })
})
