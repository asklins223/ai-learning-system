# 星环法杖恢复候选

这是根据源图法杖参考和当前角色配色绘制的独立候选层，不覆盖原 PSD，也不代表最终立绘已经批准。

## 使用方式

- 生产候选层：`live2d-layer-pack-1024-prop-restored-candidate/07-objects-restored-candidate.png`
- 原始不完整层：`live2d-layer-pack-1024-prop-restored-candidate/07-objects-incomplete-original.png`
- 透明单体：`magic-ring-wand-restored-alpha.png`
- 1024×1024 对齐层：`magic-ring-wand-restored-fullcanvas-1024.png`
- 合成 QA：`seethrough-composite-prop-restored-behind-hand-candidate.png`

导入 Cubism 时隐藏 `07-objects-incomplete-original.png`，启用恢复候选层，并将恢复候选放在手部图层之前，使手部压在法杖握柄之上。

## 限制

这是视觉恢复稿，不是源图逐像素复原。法杖的中心星、蓝宝石和环结构已补全，但仍需在 Cubism 中根据最终手部位置做一次人工遮挡和 ArtMesh 校正。
