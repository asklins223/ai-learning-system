# ModelScope see-through 候选运行记录

- 日期：2026-08-10
- 输入：`source-clean.png`
- 输入 SHA-256：`9c61395dc6c6db7a409fb91b6e24f8e6accfd3d4eee79bf33bac9d3afb4ff8f4`
- 服务：`https://modelscope.cn/studios/ljsabc/See-Through`
- 实际运行页：`https://ljsabc-see-through.ms.show/`
- 输入方式：浏览器会话剪贴板粘贴；未执行背景扣除，保留 RGBA Alpha
- 参数：resolution=1024，seed=42，tblr_split=true

## 结果

图片已成功进入 Studio 的输入控件；点击“开始运行”后，服务端返回：

> 请登录后再使用xGPU创空间。

因此本次没有生成 PSD 或图层预览，结果为 `blocked-auth-required`。没有把 token 写入仓库、证据文件或运行时环境，也没有向正式应用目录复制任何产物。

## 继续条件

需要在 ModelScope 登录态下重新点击“开始运行”。登录完成后沿用本记录的输入和参数复跑，并对 PSD 层数、图层命名、透明边缘和角色完整性做离线 QA；即使成功，也只作为 P4 candidate，不直接生成或接入 Live2D 运行时。
