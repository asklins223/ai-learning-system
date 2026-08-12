# 缺失部件恢复候选 QA

- 日期：2026-08-10
- 状态：`candidate_only`
- 方式：内置 `imagegen` 绘制候选 + 本地色键去背 + 坐标对齐

## 已恢复

1. **星环法杖**：补回完整环、四枚蓝宝石、中心金色星和木质握柄；已放置到 1024×1024 全画布，并将候选层放到手部之前。
2. **星尾**：补出独立可摆动尾巴层，去掉了不属于原设定的根部金属边。
3. **去尾衣服层**：在原 `topwear` 上做保守遮罩，移除嵌入式尾巴，同时保留衣服本体，避免新旧尾巴重叠。

## QA

- 星环、星尾、去尾衣服、合成预览均为 RGBA。
- 全透明像素的隐藏 RGB 已清零。
- 恢复候选合成预览已检查：没有双尾，手部位于法杖握柄之上，透明背景边缘可用。
- 原始 PSD、原始 24 层包和之前版本压缩包均保留。

## 交付物

- 候选包：[live2d-layer-pack-1024-prop-tail-restored-candidate.zip](live2d-layer-pack-1024-prop-tail-restored-candidate.zip)
- 重组 RGBA PSD：`seethrough-restored-candidate-live2d-v2.psd`
- PSD 交接说明：`live2d-restored-psd-README.md`
- Cubism 导入规格：`cubism-import-handoff-v2.md`
- 候选 profile：`cubism-candidate-profile-v2.json`
- Cubism 锚点图：`cubism-anchor-map-v2.png`
- 锚点坐标清单：`cubism-anchor-map-v2.json`
- 合成 QA：`seethrough-composite-prop-tail-masked-checkerboard.png`
- 星环透明单体：`magic-ring-wand-restored-alpha.png`
- 星尾透明单体：`tail-restored-v2-alpha.png`
- 去尾衣服层：`topwear-tail-masked-candidate.png`
- 使用说明：`prop-tail-restored-candidate-README.md`
- 机器清单：`prop-tail-restored-candidate-manifest.json`

这些是恢复候选，不是最终 Cubism 资产。进入 Cubism 后仍需检查尾根遮挡、法杖握持位置、ArtMesh、参数和物理摆动。
