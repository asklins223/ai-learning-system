import { configure } from '@testing-library/react'

/**
 * 放宽 Testing Library 的异步等待上限（默认 1000ms）。
 *
 * 这只影响"轮询等 UI 更新"的等待时长，不影响任何断言内容：真正没渲染出来的东西
 * 照样会失败，只是晚几秒。放宽的原因见 `vitest.config.ts`——全量并行跑时机器负载高，
 * 默认 1s 会让**单跑通过**的用例随机变红。
 */
configure({ asyncUtilTimeout: 5_000 })

/**
 * jsdom 没实现 `HTMLMediaElement` 的 `play()/load()`，而 `play()` 返回的是 `undefined`
 * ——于是生产代码里那句 `element.play().catch(...)` 在测试环境抛
 * `Cannot read properties of undefined`。它作为**未捕获异常**落在用例结束之后：
 * vitest 在摘要里记 `Errors 2`，**exit code 却还是 0**，所以"全绿"里一直藏着两条。
 *
 * 补的是真浏览器的语义（返回一个 Promise），不是往生产代码里塞可选链兜底：
 * 那种写法会让"媒体 API 永远返回 Promise"这个真实合同在代码里消失。
 * 用例自己往实例上赋 `play` 的（试听与"放不出来"那两条）不受影响——实例属性优先于原型。
 */
if (typeof HTMLMediaElement !== "undefined") {
  HTMLMediaElement.prototype.load = () => undefined
  HTMLMediaElement.prototype.play = () => Promise.resolve()
}

/**
 * jsdom 没实现 `Range.prototype.getClientRects`，而 ProseMirror 的
 * `EditorView.scrollToSelection` 会对选区那个 Range 调它（`singleRect`）——
 * 报出来的是**未捕获异常** `target.getClientRects is not a function`：用例照样通过、
 * exit code 照样 0，只在摘要里留一个 `Errors` 段（同上面媒体那条的形状）。
 *
 * 补的是真浏览器的语义（返回一个 DOMRectList 形状），不是往生产代码里塞可选链：
 * 那条路的产物只是滚动位置，jsdom 里没有布局可量。
 */
if (typeof Range !== "undefined") {
  const emptyRectList = () => {
    const list: DOMRect[] = []
    return Object.assign(list, { item: (index: number) => list[index] ?? null }) as unknown as DOMRectList
  }
  Range.prototype.getClientRects = emptyRectList as unknown as Range["getClientRects"]
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}
