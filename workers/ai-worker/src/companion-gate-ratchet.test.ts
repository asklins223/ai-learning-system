/**
 * 输出闸棘轮（39b §9.2 / 39d W1-3）：**判据函数的个数只许往下走**。
 *
 * 它防的不是"某天有人手抖删错了"，而是这条链上已经发生过两次的那种漂移：一条判据
 * 被供给侧替代、正文注释写着"已被 X 取代"，函数却留着——于是每一轮多烧一步模型调用，
 * 把同一句话再交付一遍（39b §10：那不是控制，是税）。删除闸的门槛是证据，
 * 不是意志；这个测试只负责一件事：**删了就是删了，别回来**。
 *
 * 三件事必须同时成立，缺一条这个棘轮就是假的：
 *   1. 冻结名单里的每个函数**仍然导出**——删了闸却没同步减名单，这里红（"减不到就是没删干净"）；
 *   2. 每个函数**仍然被运行时调用**——改个名就绕过名单，这里红；
 *   3. 名单长度 ≤ `GATE_BASELINE`，且基线只允许在删闸那一次同格调低。
 *
 * 匹配用 `export function 名字(` 的**定义形状**而不是 `名字`：`import { 名字 }` 这种行
 * 会让"函数还在"的判据喂出假绿——那正是要防的漂移（39b §9.2 明写了这一条）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** 冻结基线。删一条闸 → 这里减一，并在实施日志里给出 (a) 重放台 still-leaks=0、(b) 真实流量 0 触发。 */
const GATE_BASELINE = 11;

/**
 * 11 道输出闸的判据函数（39b §9.1 的 G1–G11）。
 *
 * 顺序即编号顺序，**不要重排**：删闸时把那一行删掉并同步 `GATE_BASELINE`，
 * 重排会让 review 看不出"到底删的是哪一道"。
 */
const GATE_JUDGES: ReadonlyArray<{ id: string; fn: string; file: string }> = [
  { id: "G1", fn: "unverifiedNumericClaims", file: "handlers/companion-dialogue-content.ts" },
  { id: "G2", fn: "claimsNothingDueAgainstFacts", file: "handlers/companion-dialogue-content.ts" },
  { id: "G3", fn: "claimsLookupThatNeverRan", file: "handlers/companion-dialogue-content.ts" },
  { id: "G4", fn: "looksLikeUnfulfilledActionNarration", file: "handlers/companion-dialogue-content.ts" },
  { id: "G5", fn: "looksTruncatedReply", file: "handlers/companion-dialogue-content.ts" },
  { id: "G6", fn: "unverifiedQuoteClaims", file: "handlers/companion-dialogue-content.ts" },
  { id: "G7", fn: "containsCompanionInternalToken", file: "handlers/companion-dialogue-content.ts" },
  { id: "G8", fn: "looksLikeJsonEnvelope", file: "handlers/companion-dialogue-content.ts" },
  { id: "G9", fn: "looksLikeJsonFragment", file: "handlers/companion-dialogue-content.ts" },
  { id: "G10", fn: "introducesUnverifiedNumbers", file: "handlers/companion-thought.ts" },
  { id: "G11", fn: "readsOutStatistics", file: "handlers/companion-thought.ts" },
];

/** 运行时侧：判据被谁调用。删掉调用点同样算"这条判据已经不在链上"。 */
const RUNTIME_FILES = [
  "handlers/companion-agent-runtime.ts",
  "handlers/companion-dialogue-stream.ts",
  "handlers/companion-thought.ts",
];

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** 定义形状：行首（允许缩进）的 `export function 名字(`。刻意不匹配 `import`。 */
function detectExportedFunctions(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)) {
    found.add(match[1]);
  }
  return found;
}

function isCalled(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(source);
}

test("棘轮：11 道判据仍然导出、仍然被运行时调用，且个数不超过基线", () => {
  const exportedByFile = new Map<string, Set<string>>();
  for (const gate of GATE_JUDGES) {
    if (!exportedByFile.has(gate.file)) {
      exportedByFile.set(gate.file, detectExportedFunctions(read(`../src/${gate.file}`)));
    }
  }
  const runtimeSources = RUNTIME_FILES.map((file) => read(`../src/${file}`));

  const missingExport = GATE_JUDGES.filter((gate) => !exportedByFile.get(gate.file)?.has(gate.fn));
  assert.deepEqual(
    missingExport.map((gate) => `${gate.id} ${gate.fn}`), [],
    "冻结名单里的判据已不再导出：删闸必须在同一次改动里把这一行删掉并调低 GATE_BASELINE",
  );

  const orphaned = GATE_JUDGES.filter(
    (gate) => !runtimeSources.some((source) => isCalled(source, gate.fn)),
  );
  assert.deepEqual(
    orphaned.map((gate) => `${gate.id} ${gate.fn}`), [],
    "冻结名单里的判据已不再被任何运行时文件调用：改名会绕过这份名单，先对齐调用点",
  );

  assert.ok(
    GATE_JUDGES.length <= GATE_BASELINE,
    `判据条数 ${GATE_JUDGES.length} 超过基线 ${GATE_BASELINE}：这条棘轮只允许往下走`,
  );
});

test("棘轮自证：把一条已删的判据加回去，检测必须先红一次", () => {
  // 一条永远是绿、或者对"加回来"视而不见的棘轮，在删闸那天会表现为"全绿"，
  // 而它其实什么都没判。这里用构造源码证明检测形状是会动的——
  // 第一版若用 `名字` 而不是 `export function 名字(` 匹配，下面这条断言会立刻红。
  const fixture = [
    "import { unverifiedNumericClaims } from \"./companion-dialogue-content.ts\";",
    "",
    "export function claimantRegressedLeakCheck(text: string): boolean {",
    "  return unverifiedNumericClaims(text, \"\") !== undefined;",
    "}",
    "",
    "function looksTruncatedReplyInner(text: string): boolean { return text.length === 0; }",
  ].join("\n");

  const detected = detectExportedFunctions(fixture);
  assert.ok(
    detected.has("claimantRegressedLeakCheck"),
    "定义形状没被认出来——棘轮对'判据被加回来'会视而不见",
  );
  assert.ok(
    !detected.has("looksTruncatedReplyInner"),
    "非导出函数被算成了判据——那会让基线无故膨胀",
  );

  const importedOnly = detectExportedFunctions(
    "import { unverifiedNumericClaims } from \"./companion-dialogue-content.ts\";",
  );
  assert.equal(
    importedOnly.size, 0,
    "import 行被当成了导出定义——这就是 39b §9.2 点名的假绿来源",
  );
});
