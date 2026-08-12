# Live2D 前处理规格（候选）

状态：`candidate_only`。本规格约束下一步 Cubism 手工处理，不代表已经生成 `.cmo3` 或完成运行时模型。

## 建议分组

| Cubism 组 | 当前素材 | 处理结论 |
|---|---|---|
| `G_back_hair` | `back hair` | 可作为后发底层；需要补齐被头部、衣领和身体遮住的区域 |
| `G_front_hair` | `front hair`、`headwear` | 可拆为刘海、侧发、发饰；头发摆动前先补画发丝背面 |
| `G_head` | `face`、`ears-l`、`ears-r`、`neck` | 面部可用；需要建立头部转向时的边缘补画 |
| `G_eyes` | `eyewhite-*`、`irides-*`、`eyelash-*`、`eyebrow-*`、`eyewear` | 已具备眨眼、瞳孔和眉毛的基础拆分 |
| `G_body` | `topwear`、`legwear`、`footwear` | `topwear` 目前把衣服和蓝色尾部合在一起，必须先拆尾巴 |
| `G_arms` | `handwear-r`、`handwear-l` | 可做左右袖口/手臂摆动；手指和袖子仍需进一步独立 |
| `G_prop` | `objects` | 当前只保留小型星杖/饰品，没有完整星环；不可直接作为最终道具层 |

## 必须补画

1. `topwear` 内的尾部独立层，以及尾部被衣服遮住的连接区域。
2. 头发在脸、耳朵、肩膀和衣领后面的隐藏区域，保证 `AngleX/Y` 变形时不露空。
3. 外套前襟、袖口和手臂交界处的背面，避免手臂摆动出现透明缺口。
4. 大型星环法杖：源图参考已单独保存为 `source-prop-reference-crop.png`，该文件仅供重绘参考，不放入生产层包。
5. 眼镜和发饰的遮挡边界，避免头部转动时镜框与脸部脱离。

## 建议参数

| 参数 | 范围 | 主要驱动 |
|---|---:|---|
| `ParamAngleX` | -30…30 | 头部、刘海、眼镜、耳朵、尾部偏移 |
| `ParamAngleY` | -20…20 | 头部上下、眼睛纵向、衣领和尾部 |
| `ParamAngleZ` | -15…15 | 头部倾斜、双肩和长发重心 |
| `ParamEyeLOpen` / `ParamEyeROpen` | 0…1 | 左右眼睑、睫毛、眼白遮罩 |
| `ParamEyeBallX` / `ParamEyeBallY` | -1…1 | 瞳孔在眼白内移动 |
| `ParamBrowLY` / `ParamBrowRY` | -1…1 | 左右眉毛表情 |
| `ParamMouthOpenY` / `ParamMouthForm` | 0…1 / -1…1 | 嘴巴开合和微笑 |
| `ParamBreath` | 0…1 | 肩膀、衣服、尾部的轻微呼吸 |

建议额外自定义 `ParamHairSway`、`ParamTailSway`、`ParamPropSwing`，再通过物理设置驱动长发、尾巴和法杖挂件。

## 导入与验收顺序

1. 以原始 PSD 或 `live2d-layer-pack-1024/` 导入，保留当前坐标和图层顺序。
2. 先处理隐藏区域和尾部/星环拆分，再创建 ArtMesh；不要先绑定参数。
3. 先做 `AngleX/Y/Z`、眨眼、嘴型，再做头发、尾部、挂件物理。
4. 在透明背景、深色背景和浅色背景分别检查发丝、衣摆和尾部边缘。
5. 通过源图一致性、动作完整性、授权确认后，才允许进入正式宠物运行时。

## 当前阻塞

- See-Through 输出是重建稿，和源图不是逐像素一致；画布从 1024×1536 变为 1024×1024。
- 大型星环法杖没有进入当前生产候选层包。
- 尚无 Cubism 工程、ArtMesh、变形器、物理文件、模型导出文件和发布授权确认。
