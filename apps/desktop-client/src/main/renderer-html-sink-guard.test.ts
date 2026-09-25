/**
 * 打开产物 iframe **之前**必须成立的两条不变量（39d W0-4 / D4 §5.1）：
 *
 *   1. 渲染进程没有 HTML 注入点；
 *   2. preload 不在子 frame 暴露 IPC 桥。
 *
 * 第二条是加 iframe 时**静默**会长出来的洞：Electron 文档写着 "All your preloads will
 * load for every iframe"，而 `src/preload/index.ts` 的 `contextBridge.exposeInMainWorld`
 * 原先是无条件执行的——今天没有子 frame 所以从未触发，等产物 frame 落地就把两条桥暴露给
 * 一段不可信内容了。两条都钉在这里，是因为它们的共同前提是同一件事：**这块面打开之前，
 * 门必须是关着的**。
 *
 * ## 1. 渲染进程没有 HTML 注入点
 *
 * 为什么现在就要它：D4 给动态讲解选的是**允许集合解析重建**（产物被解析成受限 AST，
 * 再重建为 React 元素），而不是沙箱 iframe。这条路的全部安全性都压在一个前提上——
 * **渲染进程里不存在"把一段字符串当 HTML 插进去"的落点**。今天这个前提是成立的
 * （产品源码 0 个注入点，`companion-markdown.tsx:21` 那段注释就是它的自述），但它
 * 从来没有被钉住：谁加一个 `dangerouslySetInnerHTML`，静默生效，没有任何东西会红。
 *
 * 所以顺序是**先上锁，再开新面**：W4-1 落地重建器之前先把这条现状钉死；等重建器来了，
 * 它必须在下面 ALLOWED 名单里显式登记（而且只登记 DOMParser，不许登记 innerHTML 类）。
 *
 * 放在 main 侧的理由与 `hud-substrate-guard.test.ts` 相同：读文件要 `node:fs`。
 *
 * 正对照（`feedback-static-guards-must-prove-they-read`）：静态守卫天生是绿的，没有
 * 正对照就等于没写。下面两条用例分别喂一份"该报"和一份"不该报"的合成源码。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 被扫的范围：**产品源码**。
 * - `*.test.*` 排除：测试夹具在自己造的 DOM 上设 `innerHTML` 是常规做法，不是产品落点。
 * - `public/` 排除：里面是 vendored 的第三方产物（pixi 等），不归我们管也不该改。
 */
const SCAN_ROOTS = ["src/renderer/src", "src/preload"];
const SKIP_DIRS = new Set(["node_modules", "public", "vendor", "out", "dist"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * 注入点判据。只认**代码形状**，不认注释——
 * `companion-markdown.tsx:21` 那段"这里没有 dangerouslySetInnerHTML"的说明不能被算成违例
 * （否则第一条用例今天就会红，而这个守卫要钉的恰恰是它描述的那个现状）。
 */
const SINK_PATTERNS: ReadonlyArray<{ label: string; test: RegExp }> = [
  { label: "dangerouslySetInnerHTML", test: /dangerouslySetInnerHTML/ },
  { label: "innerHTML 赋值", test: /\.innerHTML\s*=/ },
  { label: "outerHTML 赋值", test: /\.outerHTML\s*=/ },
  { label: "insertAdjacentHTML", test: /insertAdjacentHTML\s*\(/ },
  { label: "document.write", test: /document\.write\s*\(/ },
  // DOMParser 本身不是注入点（它的产物没有浏览上下文，脚本不跑、资源不加载），
  // 但它是重建链的入口，必须只出现在登记过的文件里。
  { label: "DOMParser", test: /new\s+DOMParser\s*\(/ },
];

/**
 * 允许出现上列形状的文件（相对仓库内 `apps/desktop-client/`）。
 *
 * 空名单是**今天的真值**，不是占位：解析重建尚未实现，所以还没有任何文件该有 DOMParser。
 * W4-1 落地时把重建器路径加进来（并在这里留一行说明它为什么是唯一的）。
 */
const ALLOWED: ReadonlyArray<{ path: string; allow: readonly string[] }> = [];

/** 注释粗剥：只剥块注释与整行 `//` 注释，够用来把说明文字与代码形状分开。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** 返回这份源码里命中的注入点标签（去重、稳定排序）。 */
export function detectHtmlSinks(source: string, allowedLabels: readonly string[] = []): string[] {
  const code = stripComments(source);
  const hit = new Set<string>();
  for (const pattern of SINK_PATTERNS) {
    if (!pattern.test.test(code)) continue;
    if (allowedLabels.includes(pattern.label)) continue;
    hit.add(pattern.label);
  }
  return [...hit].sort();
}

function walk(root: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out; // 目录不存在就跳过：守卫不该因为一次目录搬迁而假红。
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = `${root}/${entry}`;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

const allowFor = (path: string): readonly string[] =>
  ALLOWED.find((entry) => path.endsWith(entry.path))?.allow ?? [];

describe("渲染进程没有 HTML 注入点（D4 §5.1）", () => {
  it("产品源码里不存在任何 HTML 注入点", () => {
    const files = SCAN_ROOTS.flatMap((root) => walk(root));
    // 阳性对照的第一半：守卫必须真的读到了文件。读不到而全绿是最坏的假绿。
    expect(files.length).toBeGreaterThan(100);

    const violations = files
      .map((file) => ({ file, hits: detectHtmlSinks(readFileSync(file, "utf8"), allowFor(file)) }))
      .filter((entry) => entry.hits.length > 0);

    expect(
      violations.map((entry) => `${entry.file}: ${entry.hits.join(", ")}`),
      "渲染进程出现了 HTML 注入点。动态讲解的产物必须走允许集合解析重建，"
        + "不许新增 innerHTML 类落点；确需 DOMParser 请登记进本文件的 ALLOWED 名单。",
    ).toEqual([]);
  });

  it("正对照：检测形状会响；负对照：注释里的同名文字与已登记项不响", () => {
    // 正对照——该报。
    expect(detectHtmlSinks('const x = <div dangerouslySetInnerHTML={{ __html: a }} />;'))
      .toEqual(["dangerouslySetInnerHTML"]);
    expect(detectHtmlSinks('el.innerHTML = html;')).toEqual(["innerHTML 赋值"]);
    expect(detectHtmlSinks('document.body.insertAdjacentHTML("beforeend", x);'))
      .toEqual(["insertAdjacentHTML"]);
    expect(detectHtmlSinks('const doc = new DOMParser().parseFromString(src, "text/html");'))
      .toEqual(["DOMParser"]);

    // 负对照——不该报：注释里的说明文字（`companion-markdown.tsx:21` 那种自述）。
    expect(detectHtmlSinks("// 这里没有 dangerouslySetInnerHTML，所以它执行不了\nconst a = 1;"))
      .toEqual([]);
    expect(detectHtmlSinks("/**\n * 不用 el.innerHTML = x 这条路\n */\nconst a = 1;"))
      .toEqual([]);

    // 负对照——已登记项放过：登记 DOMParser 不许连带放过 innerHTML 类。
    expect(detectHtmlSinks(
      'new DOMParser(); el.innerHTML = x;',
      ["DOMParser"],
    )).toEqual(["innerHTML 赋值"]);
  });
});

/**
 * 判据：**每一条 `contextBridge.exposeInMainWorld` 都必须落在 `process.isMainFrame`
 * 的真分支里。** 用括号配对扫源码，而不是查"文件里有没有出现 isMainFrame"——
 * 后者在守卫被挪到别处、或只包住其中一条 expose 时会喂出假绿。
 */
export function exposedWorldsOutsideMainFrameGuard(source: string): string[] {
  const code = stripComments(source);
  const violations: string[] = [];
  for (const match of code.matchAll(/contextBridge\.exposeInMainWorld\s*\(/g)) {
    const before = code.slice(0, match.index ?? 0);
    // 从文件开头起跟踪 isMainFrame 的 if 块：找最后一个尚未闭合的
    // `if (process.isMainFrame) {` 并把大括号配平，看这条 expose 是否落在它内部。
    const guardIndex = before.lastIndexOf("if (process.isMainFrame)");
    if (guardIndex < 0) {
      violations.push("未受 process.isMainFrame 守卫");
      continue;
    }
    const openBrace = code.indexOf("{", guardIndex);
    let depth = 0;
    let closeBrace = -1;
    for (let i = openBrace; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          closeBrace = i;
          break;
        }
      }
    }
    if (closeBrace < (match.index ?? 0)) violations.push("落在 isMainFrame 守卫之外");
  }
  return violations;
}

describe("preload 不在子 frame 暴露 IPC 桥（D4 §5.1）", () => {
  it("每一条 exposeInMainWorld 都在 process.isMainFrame 真分支里", () => {
    const source = readFileSync("src/preload/index.ts", "utf8");
    // 阳性对照的第一半：这份源码里**本来就有** expose 调用，且至少有两条。
    const exposeCount = (stripComments(source).match(/contextBridge\.exposeInMainWorld\s*\(/g) ?? []).length;
    expect(exposeCount).toBeGreaterThanOrEqual(2);

    expect(
      exposedWorldsOutsideMainFrameGuard(source),
      "preload 把桥暴露给了子 frame。Electron 的 preload 会注入每一个 iframe，"
        + "而动态讲解的产物就是一个 iframe —— 这类暴露必须整条落在 process.isMainFrame 里面。",
    ).toEqual([]);
  });

  it("正对照：守卫外的一条 expose 必须报；守卫内的一条不许报", () => {
    // 正对照——该报。
    expect(exposedWorldsOutsideMainFrameGuard(
      "contextBridge.exposeInMainWorld('a', api);",
    )).toEqual(["未受 process.isMainFrame 守卫"]);

    // 正对照——被守卫包住但写在块外，也该报（防"只查文件里有没有出现 isMainFrame"）。
    expect(exposedWorldsOutsideMainFrameGuard(
      "if (process.isMainFrame) {\n  contextBridge.exposeInMainWorld('a', api);\n}\ncontextBridge.exposeInMainWorld('b', api);",
    )).toEqual(["落在 isMainFrame 守卫之外"]);

    // 负对照——守卫内的不该报。
    expect(exposedWorldsOutsideMainFrameGuard(
      "if (process.isMainFrame) {\n  contextBridge.exposeInMainWorld('a', api);\n  contextBridge.exposeInMainWorld('b', api);\n}",
    )).toEqual([]);
  });
});
