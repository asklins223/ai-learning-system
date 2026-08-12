# Live2D layer pack

该目录由 `seethrough_output.psd` 导出，所有 PNG 都是 1024×1024 全画布 RGBA，保持 PSD 中的坐标和图层顺序。

建议导入 Cubism 前先完成：

1. 以 `back hair`、`topwear`、`face` 等大层为基础，补齐被前景遮挡的头发、脸、袖口和服装区域。
2. 将 `objects` 拆成法杖、星环、宝石等独立可动部件；将左右手和鞋子继续细分为需要摆动的部件。
3. 在 Cubism 中重新绘制/生成 ArtMesh，建立眼睛、嘴、头部、身体、头发和尾部参数。
4. 完成物理、表情和透明背景边缘 QA 后，再决定是否进入正式运行时。

本包是候选源素材，不包含 `.cmo3`、`.model3.json`、物理文件或运行时注册信息。
