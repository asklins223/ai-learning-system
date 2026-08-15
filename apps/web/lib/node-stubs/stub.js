// 2026-08-15（R36+ 桌面打包放行）：浏览器 bundle 的 node 内置模块存根。
// @ailearn/shared 部分模块（platform-config/fingerprint/content-hash/
// card-generation-v2-hashing）顶层 import node:*，但按惰性约定浏览器运行时
// 不会实际调用（createRequire === null 分支 / 服务端专用）。webpack 客户端
// 构建时把 node: 前缀模块重定向到本存根，避免 UnhandledSchemeError。
module.exports = {};
