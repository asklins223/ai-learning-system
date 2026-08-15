// F4：KaTeX CSS 由根 layout 的全局静态 import 改为 MarkdownPreview 内的
// 按需 dynamic import（`import("katex/dist/katex.min.css")`）。该 CSS 是纯
// 副作用模块（打包时由 webpack 注入 <style>），此处声明其类型以通过 tsc。
declare module "katex/dist/katex.min.css";
