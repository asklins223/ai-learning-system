# Cubism 导入交接规格 v2

输入文件：`seethrough-restored-candidate-live2d-v2.psd`。这是候选源 PSD，不是已绑定的 Cubism 工程。

锚点和命中区可视化：`cubism-anchor-map-v2.png`；机器清单：`cubism-anchor-map-v2.json`。

## 导入顺序

PSD 内已按下面的活动顺序组装，直接导入后保留图层名和坐标：

1. `back hair`
2. `legwear`
3. `objects-restored-candidate`
4. `handwear-r`
5. `footwear`
6. `handwear-l`
7. `neck`
8. `topwear-tail-masked-candidate`
9. `tail-restored-candidate`
10. `ears-l`
11. `ears-r`
12. `face`
13. `nose`
14. `mouth`
15. `eyewhite-r`
16. `eyewhite-l`
17. `irides-l`
18. `irides-r`
19. `eyebrow-l`
20. `eyewear`
21. `eyebrow-r`
22. `eyelash-r`
23. `eyelash-l`
24. `front hair`
25. `headwear`

## 首轮 ArtMesh

- `face`：脸部基础网格，先保持中心稳定，再绑定头部 XYZ。
- `front hair` / `back hair`：分别建立头发网格，前发不与脸部共用顶点。
- `tail-restored-candidate`：单独网格，根部顶点固定，末端允许物理摆动。
- `objects-restored-candidate`：环、中心星和握柄分区；环与握柄建议分成独立 ArtMesh。
- `topwear-tail-masked-candidate`：衣服主体网格；尾根处先做遮挡测试。
- 眼睛组：眼白、虹彩、睫毛、眉毛和眼镜分别建网格，眼镜不绑定眼白顶点。

## 参数草案

| 参数 | 范围 | 驱动对象 |
|---|---:|---|
| `ParamAngleX` | -30…30 | 脸、耳、前发、眼镜、法杖环的横向偏移 |
| `ParamAngleY` | -20…20 | 脸、刘海、衣领、尾根纵向变化 |
| `ParamAngleZ` | -15…15 | 头部倾斜、双肩、长发重心 |
| `ParamEyeLOpen` / `ParamEyeROpen` | 0…1 | 左右眼睑、睫毛、眼白遮罩 |
| `ParamEyeBallX` / `ParamEyeBallY` | -1…1 | 左右瞳孔在眼白内移动 |
| `ParamBrowLY` / `ParamBrowRY` | -1…1 | 左右眉形和高度 |
| `ParamMouthOpenY` | 0…1 | 嘴巴开合 |
| `ParamMouthForm` | -1…1 | 微笑、平静、轻微担忧 |
| `ParamBreath` | 0…1 | 肩膀、衣摆、尾根的轻微呼吸 |
| `ParamHairSway` | -1…1 | 前发、后发 |
| `ParamTailSway` | -1…1 | 独立星尾 |
| `ParamPropSwing` | -1…1 | 星环和握柄的轻微摆动 |

## 物理与命中区

- 物理组：`hair_front`、`hair_back`、`tail`、`prop_hanging`。
- 头发和尾巴的根部固定，末端响应 `ParamAngleX/Y/Z` 和 `ParamBreath`。
- 命中区建议：`head`、`body`、`eye_left`、`eye_right`、`tail`、`prop`。
- 法杖与手部必须检查遮挡，不允许握柄穿过手掌或环穿过袖口。

## 必做 QA

1. 透明背景、黑底、浅底各检查一次边缘。
2. `AngleX/Y/Z` 全范围检查头发、眼镜、衣服和尾根是否露空。
3. 左右眼分别眨眼，确认睫毛和眼白不穿帮。
4. 嘴型开合不改变脸部轮廓，不露出脸层外的空洞。
5. 法杖与星尾分别摆动，确认没有旧 `objects` 或旧嵌入尾巴叠加。
6. 导出前确认角色授权、Cubism SDK 使用范围和模型再分发权。

当前仍未生成 `.cmo3`、`.moc3`、`.model3.json`、物理文件或正式 runtime 注册；这些必须在 Cubism Editor 人工绑定与授权 Gate 通过后再产生。
