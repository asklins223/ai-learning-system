# ModelScope 正确源图分层运行记录

- 日期：2026-08-10
- 输入：`source-clean.png`
- 输入 SHA-256：`9c61395dc6c6db7a409fb91b6e24f8e6accfd3d4eee79bf33bac9d3afb4ff8f4`
- 服务：`https://modelscope.cn/studios/ljsabc/See-Through`
- 参数：resolution=1024，seed=42，tblr_split=true
- 状态：`candidate_generated`

## 结果

在已登录的 ModelScope 外层 Studio 会话中重新上传并运行成功。页面确认输入控件出现 `Remove Image`，随后完成推理并显示：

- PSD：`seethrough_output.psd`
- PSD 页面显示大小：约 6.6 MB
- 语义预览层数：24
- 预览层名：back hair、bottomwear、ears、earwear、eyebrow、eyelash、eyewear、eyewhite、face、footwear、front hair、handwear、head、headwear、irides、legwear、mouth、neck、neckwear、nose、objects、tail、topwear、wings

页面截图中输入角色与 `source-clean.png` 的正面角色一致，未见白底抠图造成的明显外扩毛边；ModelScope 页面自身的水印不属于角色资产。

## 产物交接

PSD 已留在当前 ModelScope Studio 页面，可通过页面中的 `6.6 MB` 下载入口取得。命令行直接访问临时 URL 会被服务端以 403 拒绝，浏览器会话内的下载动作已触发，但本地工作区未捕获到 PSD 文件，因此本记录不伪造本地 PSD 路径或哈希。

本次仍是 P4 candidate：没有复制到正式运行时目录，没有生成 Cubism 工程、模型文件、物理参数或 Live2D 导出物。
