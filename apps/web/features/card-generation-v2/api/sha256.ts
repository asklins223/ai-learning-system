/**
 * 客户端安全 SHA-256（浏览器 bundle 专用）。
 *
 * 服务端的 `@ailearn/shared/card-generation-v2-hashing` 依赖 node:crypto，
 * 按约定不入客户端 bundle（见 shared/index.ts 注释）。§17.5 的
 * clientReviewHash 需要在浏览器提交激活请求时计算，这里用 WebCrypto 提供
 * 等价的 sha256 原语；域/排序语义由调用方按 §9.5 约定拼接。
 */

/** 标准 SHA-256 hex（WebCrypto，仅浏览器/worker 环境）。 */
export async function sha256Hex(input: string): Promise<string> {
  // WebCrypto 在测试环境的 node 中通过 globalThis.crypto.subtle 可用。
  const cryptoImpl = globalThis.crypto;
  if (!cryptoImpl?.subtle) {
    throw new Error("WebCrypto 不可用，无法计算客户端 review hash。");
  }
  const data = new TextEncoder().encode(input);
  const digest = await cryptoImpl.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
