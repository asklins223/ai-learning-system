import { configure } from '@testing-library/react'

/**
 * 放宽 Testing Library 的异步等待上限（默认 1000ms）。
 *
 * 这只影响"轮询等 UI 更新"的等待时长，不影响任何断言内容：真正没渲染出来的东西
 * 照样会失败，只是晚几秒。放宽的原因见 `vitest.config.ts`——全量并行跑时机器负载高，
 * 默认 1s 会让**单跑通过**的用例随机变红。
 */
configure({ asyncUtilTimeout: 5_000 })
