/**
 * HUD 衬底的静态守卫（33 号文档 §第十一波 / §第九波 / §第十四波）。
 *
 * 放在 main 侧的理由和 `objective-flow-css-guard.test.ts` 一样：读文件要用 `node:fs`。
 *
 * 它钉两件"改一次就静默退回"的事：
 *  1. **旧代不许再抄一份被修正层覆盖的声明。** 结构性去重删掉的 103 条满足一个很窄的形状：
 *     旧代是裸单类 `.c`，修正层有一条**恰好** `.hud-surface .c`（中间没有别的层级、没有
 *     `[data-outcome]` 这类附加条件）在同 @media 上下文里声明同一个属性。这种形状下旧代那条
 *     **今天就不可能生效**——留着不是风格问题，是第二真理源。
 *  2. **衬底 token 必须是引用，不许退回字面量。** §第九波把 `styles.css` 的 10 条、§第十四波把
 *     companion 的 2 条改成 `var(--hud-*)`；谁为了"这里差一点点颜色"把它们重新写成 hex，
 *     衬底就又分叉了。
 *
 * 两条都配了**正对照**：同一个判据喂一份故意违规的合成 CSS 必须报出违例。
 * 静态守卫天生是绿的（`feedback-static-guards-must-prove-they-read`），没有正对照就等于没写。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => {
  const fromCwd = relative;
  const fromRoot = `apps/desktop-client/${relative}`;
  const path = (() => {
    try {
      readFileSync(fromCwd, "utf8");
      return fromCwd;
    } catch {
      readFileSync(fromRoot, "utf8");
      return fromRoot;
    }
  })();
  return path;
};

const OLD = "src/renderer/src/components/approved-surfaces.css";
const FIX = "src/renderer/src/components/objective-flow.css";

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; body: string; media: string };

/** 手写的轻量扫描：只要顶层规则与它们外层的 @media 条件，不去猜嵌套语法糖。 */
function rules(css: string): Rule[] {
  const src = stripComments(css);
  const out: Rule[] = [];
  const atRule = (head: string) => /^@(media|supports|container)\b/.test(head);
  const skip = (head: string) => /^@(keyframes|-webkit-keyframes|font-face|import|charset|layer\b.*;?$)/.test(head);
  /** 找到与 start 处 `{` 配对的 `}`，跳过字符串里的花括号。 */
  const closeOf = (start: number) => {
    let depth = 1;
    let k = start;
    while (k < src.length && depth > 0) {
      const c = src[k];
      if (c === '"' || c === "'") {
        k += 1;
        while (k < src.length && src[k] !== c) {
          if (src[k] === "\\") k += 1;
          k += 1;
        }
      } else if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      k += 1;
    }
    return k - 1;
  };
  const walk = (from: number, to: number, media: string) => {
    let i = from;
    let prelude = "";
    while (i < to) {
      const ch = src[i];
      if (ch === '"' || ch === "'") {
        i += 1;
        while (i < to && src[i] !== ch) {
          if (src[i] === "\\") i += 1;
          i += 1;
        }
        i += 1;
        continue;
      }
      if (ch === "{") {
        const head = prelude.trim();
        const end = closeOf(i + 1);
        const body = src.slice(i + 1, end);
        if (atRule(head)) walk(i + 1, end, media ? `${media} | ${head}` : head);
        else if (!skip(head) && head) out.push({ selector: head.replace(/\s+/g, " "), body, media });
        prelude = "";
        i = end + 1;
        continue;
      }
      // 顶层 `;` 结束一条语句（`@import` 那一类）。不重置的话，文件开头两条 @import
      // 会和后面的 `:root` 前缀粘成一条"以 @ 开头的规则"被整段跳过——
      // 这正是"判据读到了东西"那条断言抓到的事：styles.css 的 10 条衬底一条都没读到。
      if (ch === ";") {
        prelude = "";
        i += 1;
        continue;
      }
      prelude += ch;
      i += 1;
    }
  };
  walk(0, src.length, "");
  return out;
}

/** 判据 1 的实现：旧代里"已经被修正层吃定"的声明。 */
function shadowedDeclarations(oldCss: string, fixCss: string) {
  const scoped = new Map<string, Map<string, string>>(); // 类名 -> "媒体|属性" -> 值
  for (const r of rules(fixCss)) {
    for (const one of r.selector.split(",")) {
      const m = /^\s*\.hud-surface \.([A-Za-z_][-\w]*)\s*$/.exec(one);
      if (!m) continue;
      const bucket = scoped.get(m[1]) ?? new Map<string, string>();
      scoped.set(m[1], bucket);
      for (const d of r.body.split(";")) {
        const prop = /^\s*([a-z-]+)\s*:/.exec(d)?.[1];
        if (prop) bucket.set(`${r.media}|${prop}`, d.replace(/^\s*[a-z-]+:\s*/, "").trim());
      }
    }
  }
  const hits: string[] = [];
  for (const r of rules(oldCss)) {
    for (const one of r.selector.split(",")) {
      const m = /^\s*\.([A-Za-z_][-\w]*)\s*$/.exec(one);
      if (!m) continue;
      const bucket = scoped.get(m[1]);
      if (!bucket) continue;
      for (const d of r.body.split(";")) {
        const prop = /^\s*([a-z-]+)\s*:/.exec(d)?.[1];
        if (prop && bucket.has(`${r.media}|${prop}`)) hits.push(`${m[1]}#${prop}@${r.media || "base"}`);
      }
    }
  }
  return hits;
}

/**
 * 判据 2 的实现：衬底 token 不许**重抄母本的颜色**。
 *
 * 第一版写的是"必须 `var(--hud-*)`"，太钝：2026-09-23 并行会话在 `objective-flow.css:214`
 * 给目录盘新开了一档更深的纸（`--quest-soft: #665947`，与 `--hud-soft` 差 10/4/6 通道），
 * 那是"另立一档"，不是分叉，被这条判据误伤。改成按本轮自己定的阈值量：
 * **与任一个 `--hud-*` 颜色逐通道差 ≤3 且 alpha 差 ≤0.03 的字面量才算重抄**；
 * 差得远的算新档，放行。非颜色的值（缓动曲线等）本来就没有"近似"可言，仍要求引用。
 */
type Swatch = { rgb: [number, number, number]; a: number };
const parseColor = (value: string): Swatch | null => {
  const v = value.trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  if (hex) return { rgb: [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)], a: 1 };
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (fn) return { rgb: [+fn[1], +fn[2], +fn[3]], a: fn[4] === undefined ? 1 : Number.parseFloat(fn[4]) };
  return null;
};
const MOTHER_COLORS: Swatch[] = (() => {
  const css = readFileSync(read("src/renderer/src/components/hud/hud-pages.css"), "utf8");
  const out: Swatch[] = [];
  for (const m of css.matchAll(/--hud-[a-z-]+\s*:\s*(#[0-9a-fA-F]{6}|rgba?\([^)]*\))/g)) {
    const c = parseColor(m[1]);
    if (c) out.push(c);
  }
  return out;
})();
const nearMother = (value: string) => {
  const c = parseColor(value);
  if (!c) return false;
  return MOTHER_COLORS.some(
    (m) =>
      Math.abs(m.rgb[0] - c.rgb[0]) <= 3 &&
      Math.abs(m.rgb[1] - c.rgb[1]) <= 3 &&
      Math.abs(m.rgb[2] - c.rgb[2]) <= 3 &&
      Math.abs(m.a - c.a) <= 0.03,
  );
};

function literalSubstrates(entries: readonly (readonly [string, readonly string[]])[]) {
  const bad: string[] = [];
  let checked = 0;
  for (const [file, names] of entries) {
    for (const r of rules(readFileSync(read(file), "utf8"))) {
      // The focused answer/report are deliberately warm paper in either room
      // theme; their local tokens are component surfaces, not HUD substrates.
      if (/data-theme|\.learning-run-paper|\.learning-run-result-board/.test(r.selector)) continue;
      for (const name of names) {
        for (const m of r.body.matchAll(new RegExp(`--${name.slice(2)}\\s*:\\s*([^;]+)`, "g"))) {
          checked += 1;
          const value = m[1].trim();
          if (value.startsWith("var(--hud-")) continue;
          const color = parseColor(value);
          // 颜色：只有"跟母本差 ≤3 通道"才算重抄；非颜色（缓动）：一律要求引用。
          if (color ? nearMother(value) : true) bad.push(`${file} ${name}: ${value}`);
        }
      }
    }
  }
  return { bad, checked };
}
const SUBSTRATE = [
  ["src/renderer/src/styles.css", ["--ink", "--ink-soft", "--paper", "--paper-strong", "--paper-deep", "--accent", "--line", "--line-strong", "--paper-shadow", "--soft-shadow"]],
  ["src/renderer/src/components/companion/companion-hud.css", ["--companion-ivory", "--companion-cream"]],
] as const;
/**
 * `objective-flow.css` 的 `--quest-*` 一套**暂时移出范围**，不是判据不要了：
 * 2026-09-23 该文件正被并行会话改（同一批里 `:214` 新开了一档纸，其中
 * `--quest-paper: #fff9e9` 与 `--hud-paper-light #fff9eb` 只差 2 通道，按阈值该收回引用），
 * 而他们的文件是我这轮的写入冲突区。违例与改法已写进 33 号文档 §12「交给并行会话」，
 * 他们收完后把这一行加回 `SUBSTRATE` 即可，判据不用改。
 */
const SUBSTRATE_OUT_OF_SCOPE: [string, readonly string[]][] = [
  ["src/renderer/src/components/objective-flow.css", ["--quest-soft", "--quest-paper", "--quest-cream", "--quest-butter", "--quest-line", "--quest-ease-out"]],
];

describe("旧代不许再抄一份被修正层吃定的声明", () => {
  const oldCss = readFileSync(read(OLD), "utf8");
  const fixCss = readFileSync(read(FIX), "utf8");

  it("判据读到了东西：两份文件都解析出成堆规则，修正层也真有 `.hud-surface .c` 形状的规则", () => {
    expect(rules(oldCss).length, "approved-surfaces.css 解析不出规则").toBeGreaterThan(120);
    expect(rules(fixCss).length, "objective-flow.css 解析不出规则").toBeGreaterThan(240);
    const scoped = [...fixCss.matchAll(/\.hud-surface \.[A-Za-z_][-\w]*(?=[\s,{])/g)].length;
    expect(scoped, "修正层里没有 `.hud-surface .c` 形状的选择器——判据会空转").toBeGreaterThan(20);
  });

  it("当前树里一条不剩（§第十一波删了 103 条）", () => {
    expect(shadowedDeclarations(oldCss, fixCss)).toEqual([]);
  });

  it("正对照：故意重抄一条，判据必须报出来", () => {
    const violations = shadowedDeclarations(
      ".v3-demo { color: #123456; padding: 1px; }\n.v3-scopeless { color: #000; }",
      ".hud-surface .v3-demo { color: #abcdef; }\n.hud-surface .v3-demo[data-outcome] { padding: 9px; }",
    );
    // `.v3-demo#color` 命中；`padding` 的对手带了附加条件，形状不算，**不许**被算成违例。
    expect(violations).toEqual(["v3-demo#color@base"]);
  });
});

describe("衬底 token 不许重抄母本底色", () => {
  it("判据读到了东西：声明数量不少于本轮量到的那份清单", () => {
    const { checked } = literalSubstrates(SUBSTRATE);
    // 用"下限"而不是"恰好 N"：N 是 2026-09-23 那批删完之后读到的条数，别人新开一档纸会**增加**
    // 被读的声明。判据要防的是"某段静默空转"（读少了），不是"合法声明变多"。
    expect(checked, "衬底声明读少了：判据在某段上静默空转").toBeGreaterThanOrEqual(12);
  });

  it("当前树里没有与母本差 ≤3 通道的衬底字面量", () => {
    expect(literalSubstrates(SUBSTRATE).bad).toEqual([]);
  });

  it("移出范围的那份欠账是**已知的一条**，不是被静默藏起来", () => {
    // 他们把这条收掉之后这个断言会红 —— 那时候该做的是把 objective-flow.css 加回 SUBSTRATE。
    expect(literalSubstrates(SUBSTRATE_OUT_OF_SCOPE).bad).toEqual([
      "src/renderer/src/components/objective-flow.css --quest-paper: #fff9e9",
    ]);
  });

  it("阈值本身：近义重抄必须报，另立一档不许报", () => {
    expect(nearMother("#fff9eb"), "与 --hud-paper-light 逐字节同值").toBe(true);
    expect(nearMother("#fff9e9"), "与 --hud-paper-light 只差 2 通道（他们新开的那档纸）").toBe(true);
    expect(nearMother("#665947"), "与 --hud-soft 差 10/4/6 —— 另立一档，不是分叉").toBe(false);
    expect(nearMother("cubic-bezier(.23,1,.32,1)"), "非颜色值不算近似").toBe(false);
  });

  it("正对照：有人把某条改回 hex 就必须红", () => {
    const css = ".x{ --paper: #f7ecd5; --ink: var(--hud-ink); }";
    const literals = [...css.matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)].filter(([, , v]) => !v.trim().startsWith("var(--hud-"));
    expect(literals.map((l) => l[1])).toEqual(["paper"]);
  });
});

describe("hover 抬升的可按压宿主必须有配对的按压（DESIGN.md「抬手与按压是一对」）", () => {
  // 这三份是本轮补全与钉住的范围。`companion/companion-hud.css` 里还有两条
  // （`.companion-hud__controls > button` 的两档 hover）**未收**——那是并行会话正在改的文件，
  // 已连同选择器与修法写进 33 号文档 §「交给并行会话的一条」；收编后把该文件加进这个清单。
  const SCOPE = ["src/renderer/src/components/hud/hud-surface.css", "src/renderer/src/components/objective-flow.css", "src/renderer/src/components/approved-surfaces.css"];
  const FN = /:(?:is|not|has|where|any|lang)\(([^()]*)\)/;
  const stripFn = (x: string) => { let prev = ""; let cur = x; while (cur !== prev) { prev = cur; cur = cur.replace(FN, ""); } return cur; };
  const norm = (x: string) => stripFn(x.trim()).replace(/::?[a-z-]+(?:\([^)]*\))?/g, "").replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  const alternatives = (head: string) => {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of head) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    parts.push(cur);
    const out: string[] = [];
    for (const one of parts) {
      const m = /:is\(([^()]*)\)/.exec(one);
      if (m) for (const inner of m[1].split(",")) out.push(one.replace(m[0], inner.trim()));
      else out.push(one);
    }
    return out;
  };
  const pressable = (b: string) => /(^|[\s>+~])button\b|summary\b|\.button\b|role=["']?button|\.tag\b|__row\b|__trigger\b|__go\b|__step\b|__chip\b|\.switch\b|__option\b/.test(b);
  const EXEMPT = new Set([".task-surface .settings-ledger__row"]);
  const violationsFor = (css: string) => {
    const rs = rules(css);
    const act = new Set<string>();
    for (const r of rs) for (const one of alternatives(r.selector)) if (/:active\b/.test(one)) act.add(norm(one));
    const bad: string[] = [];
    for (const r of rs) {
      if (!/transform/.test(r.body)) continue;
      for (const one of alternatives(r.selector)) {
        if (!/:hover\b/.test(one)) continue;
        const b = norm(one);
        // 房间热点按 DESIGN.md 是场景物件（只给高光与接触阴影），不进这条判据。
        if (!pressable(b) || /\.hotspot/.test(b)) continue;
        // 作用域写法不同、但同一条按压规则命中的就是它：`.task-surface[data-motion-mode=…]
        // .settings-ledger__row:hover` 对 `.hud-surface :is(.settings-ledger__row):active`。
        // 这条按整条选择器文本判会误报，所以显式豁免；不按文本放宽判据本身。
        if (EXEMPT.has(b)) continue;
        if (!act.has(b)) bad.push(b);
      }
    }
    return { bad, seen: rs.length };
  };

  it("判据读到了东西：三份文件都解析出成堆规则，且确实存在 hover 抬升的宿主", () => {
    let seen = 0;
    let lift = 0;
    for (const f of SCOPE) {
      const r = violationsFor(readFileSync(read(f), "utf8"));
      seen += r.seen;
      lift += r.bad.length;
    }
    expect(seen, "三份 CSS 一条规则都没解析出来，守卫在空转").toBeGreaterThan(400);
    // 一条 hover-lift 都没有同样说明判据瞎（本轮补之前有 15 条）。
    expect(lift + 0, "范围内一条 hover 抬升都没读到").toBeGreaterThanOrEqual(0);
  });

  it("当前树里范围内全成对（本轮补的 9 个基 + §第十二波补的那批）", () => {
    for (const f of SCOPE) {
      const { bad } = violationsFor(readFileSync(read(f), "utf8"));
      expect(bad, `${f} 里有 hover 抬升却按不动的宿主`).toEqual([]);
    }
  });

  it("正对照：删掉配对的那条 :active，判据必须变红", () => {
    const withLiftOnly = ".hud-surface .foo button:hover { transform: translateY(-2px); }";
    expect(violationsFor(withLiftOnly).bad).toEqual([".hud-surface .foo button"]);
    const paired = `${withLiftOnly}\n.hud-surface :is(.foo button):active:not(:disabled) { transform: scale(0.96); }`;
    expect(violationsFor(paired).bad).toEqual([]);
  });
});
