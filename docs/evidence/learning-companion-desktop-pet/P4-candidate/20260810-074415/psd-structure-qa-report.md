# See-Through PSD 分层验收

- 日期：2026-08-10
- 输入：`seethrough_output.psd`
- SHA-256：`703db17bac84b2171405cc37bb2f2ac5a7439bc7d2b731d143b255da27def5e0`
- 画布：1024×1024，RGBA，8-bit
- 顶层图层：24 个
- 状态：`candidate_only`

## 已确认

- 24 个图层全部是可见的像素图层，没有空层、隐藏层或分组层。
- 每个图层都有透明通道和有效像素；导出的逐层 PNG 均为 1024×1024 RGBA。
- 逐层 PNG 的全透明像素已清零 RGB，未检测到隐藏颜色导致的额外透明边缘风险。
- 已生成透明合成预览和棋盘格预览，角色轮廓、发丝、衣服、面部五官、饰品和鞋子均能正确合成。

## 与源图的视觉差异

- 该 PSD 是 See-Through 的重建结果，不是源图的逐像素拆层：画布从源图的 1024×1536 变为 1024×1024，角色重新缩放并构图。
- 源图左侧的大型星环法杖在 `objects` 层中没有被完整保留，预览里主要剩下小型星杖/饰品；如果要做 Live2D，这部分需要补回或重新拆分。
- 因此当前分层适合作为 Cubism 起始稿，不应直接视为最终立绘或最终可动道具资产。

## 图层顺序

`back hair` → `legwear` → `handwear-r` → `footwear` → `handwear-l` → `neck` → `topwear` → `objects` → `ears-l` → `ears-r` → `face` → `nose` → `mouth` → `eyewhite-r` → `eyewhite-l` → `irides-l` → `irides-r` → `eyebrow-l` → `eyewear` → `eyebrow-r` → `eyelash-r` → `eyelash-l` → `front hair` → `headwear`

## 交付物

- 原始分层 PSD：`seethrough-output-source-clean-1024-s42-tblr.psd`
- 透明合成：`seethrough-composite-rgba.png`
- 棋盘格边缘 QA：`seethrough-composite-checkerboard.png`
- 24 层联系表：`seethrough-layer-contact-sheet.png`
- 源图/PSD 对照：`source-vs-seethrough-comparison.png`
- 星环法杖参考裁切：`source-prop-reference-crop.png`（仅参考，不是生产层）
- Live2D 逐层 PNG：`live2d-layer-pack-1024/`
- 逐层坐标与透明度清单：`live2d-layer-pack-manifest.json`
- 逐层包 QA：24/24 PNG 均为 1024×1024 RGBA，校验结果 `PASS`
- 缺失部件恢复报告：`restoration-qa-report.md`
- 法杖/星尾恢复候选包：`live2d-layer-pack-1024-prop-tail-restored-candidate.zip`
- 重组 RGBA Live2D 候选 PSD：`seethrough-restored-candidate-live2d-v2.psd`（25 个活动图层，重新读取验证通过）
- Cubism 交接规格：`cubism-import-handoff-v2.md`
- 候选 profile：`cubism-candidate-profile-v2.json`

## Live2D 结论

这份 PSD 已经可以作为 Cubism 的分层起始素材，但它还不是 Cubism 工程，也不是可直接驱动的 Live2D 模型。下一阶段仍需人工补画被遮挡区域、拆分可变形部位、建立 ArtMesh、绑定参数与物理，并在 Cubism 中做眨眼、嘴型、头部转向和衣发摆动验收。

当前不将它复制到正式宠物运行时，也不宣称 P4 或 Live2D 发布许可已通过。
