import { describe, expect, it } from "vitest";
import {
  COMPANION_REVEAL_FIRST_AUDIO_SILENCE_MS,
  COMPANION_REVEAL_GAP_SILENCE_MS,
  COMPANION_REVEAL_MAX_DRIFT_CHARS,
  COMPANION_REVEAL_LEAD_CHARS,
  createCompanionRevealDriver,
  type CompanionRevealDriver,
} from "./companion-reveal-driver";

/** 假时钟：所有推进都由测试显式 `advance`，不依赖真实定时器。 */
function harness(): { driver: CompanionRevealDriver; advance: (ms: number) => void; revealed: number[] } {
  let at = 0;
  const revealed: number[] = [];
  const driver = createCompanionRevealDriver({
    now: () => at,
    onReveal: (value) => revealed.push(value),
  });
  return {
    driver,
    advance: (ms: number) => {
      at += ms;
    },
    revealed,
  };
}

describe("companion-reveal-driver", () => {
  it("文本到齐也不推进显现——这是「整块先出完再念」的正解", () => {
    const { driver } = harness();
    driver.noteSession("voice");
    driver.noteArrived(40);
    // 音频还没出声：只放行提前量，且必须靠 tick 才会落。
    driver.tick();
    expect(driver.revealed).toBe(COMPANION_REVEAL_LEAD_CHARS);
    expect(driver.arrived).toBe(40);
  });

  it("音频进度是唯一权威：字跟着声音走，并带一点提前量", () => {
    const { driver } = harness();
    driver.noteSession("voice");
    driver.noteArrived(40);
    driver.noteAudioProgress(4);
    expect(driver.revealed).toBe(4 + COMPANION_REVEAL_LEAD_CHARS);
    driver.noteAudioProgress(18);
    expect(driver.revealed).toBe(18 + COMPANION_REVEAL_LEAD_CHARS);
    // 音频进度落后（段间重播/抖动）不回退。
    driver.noteAudioProgress(2);
    expect(driver.revealed).toBe(18 + COMPANION_REVEAL_LEAD_CHARS);
  });

  it("提前量不会把字推到还没到的文本上", () => {
    const { driver } = harness();
    driver.noteSession("voice");
    driver.noteArrived(3);
    driver.noteAudioProgress(3);
    expect(driver.revealed).toBe(3);
  });

  it("播不了音频（silent）时退到阅读钟，按 60ms 一个字推进", () => {
    const { driver, advance } = harness();
    driver.noteSession("silent");
    driver.noteArrived(40);
    driver.tick();
    expect(driver.revealed).toBe(0);
    advance(600);
    driver.tick();
    expect(driver.revealed).toBe(10);
    advance(300);
    driver.tick();
    expect(driver.revealed).toBe(15);
  });

  it("voice 模式下第一段音频迟迟不来：看门狗到点交给阅读钟，不冻住气泡", () => {
    const { driver, advance } = harness();
    driver.noteSession("voice");
    driver.noteArrived(40);
    advance(COMPANION_REVEAL_FIRST_AUDIO_SILENCE_MS - 1);
    driver.tick();
    expect(driver.revealed).toBe(COMPANION_REVEAL_LEAD_CHARS);
    advance(1);
    driver.tick();
    advance(600);
    driver.tick();
    // 从降级那一刻起算的阅读节奏，而不是把等待的时间一次性补上。
    expect(driver.revealed).toBe(COMPANION_REVEAL_LEAD_CHARS + 10);
  });

  it("音频在说话时阅读钟停摆，不会偷偷把后面的字补出来", () => {
    const { driver, advance } = harness();
    driver.noteSession("voice");
    driver.noteArrived(40);
    driver.noteAudioProgress(5);
    advance(3_000);
    driver.tick();
    expect(driver.revealed).toBe(5 + COMPANION_REVEAL_LEAD_CHARS);
  });

  it("段间等待超过 GAP 上限就交给阅读钟，音频回来后重新接管", () => {
    const { driver, advance } = harness();
    driver.noteSession("voice");
    driver.noteArrived(40);
    driver.noteAudioProgress(5);
    advance(COMPANION_REVEAL_GAP_SILENCE_MS + 600);
    driver.tick();
    // 这一拍只是让钟起算，不把等待的时间一次性补出来。
    expect(driver.revealed).toBe(5 + COMPANION_REVEAL_LEAD_CHARS);
    advance(600);
    driver.tick();
    expect(driver.revealed).toBe(5 + COMPANION_REVEAL_LEAD_CHARS + 10);
    driver.noteAudioProgress(20);
    expect(driver.revealed).toBe(20 + COMPANION_REVEAL_LEAD_CHARS);
  });

  // 方案 29 §14.11 修复 ②：段间静音原来要等满 2 秒才把文字交回阅读钟，于是任何
  // <2s 的段间等待都是"文字和声音一起冻住"（用户报的"内容和读音都卡住"）。
  // 现在出声之后按 800ms 判定，文字最多冻 0.8 秒。
  it("段间静音只有 0.9 秒时文字也要继续走，不再冻满两秒", () => {
    const { driver, advance } = harness();
    driver.noteSession("voice");
    driver.noteArrived(40);
    driver.noteAudioProgress(5);
    expect(COMPANION_REVEAL_GAP_SILENCE_MS).toBeLessThan(COMPANION_REVEAL_FIRST_AUDIO_SILENCE_MS);
    advance(COMPANION_REVEAL_GAP_SILENCE_MS + 100);
    driver.tick();          // 钟起算
    advance(600);
    driver.tick();          // 走了 10 个字
    expect(driver.revealed).toBe(5 + COMPANION_REVEAL_LEAD_CHARS + 10);
  });

  // 2026-09-22 用户报"文字太快、气泡里的展示对不上"：阅读钟 60ms/字 ≈ 16.7 字/秒，
  // 而 TTS 只有约 4.6 字/秒——快 2.6 倍，而 revealed 只增不减，所以钟接管一次就永久
  // 领先。下面三条把"领先有上限"钉住。
  it("段间静音时文字最多领先音频 lead+drift 个字，不跟着阅读钟跑掉", () => {
    const { driver, advance } = harness();
    driver.noteSession("voice");
    driver.noteArrived(400);
    driver.noteAudioProgress(100);
    // 静音远超 GAP 判定：钟接管，但只许走到 ceiling + lead + drift 就停住。
    advance(COMPANION_REVEAL_GAP_SILENCE_MS + 5_000);
    driver.tick();
    advance(5_000);
    driver.tick();
    expect(driver.revealed).toBe(100 + COMPANION_REVEAL_LEAD_CHARS + COMPANION_REVEAL_MAX_DRIFT_CHARS);
    // 音频回来：立刻重新对齐到音频位置 + 提前量（不倒退、也不再继续跑）。
    driver.noteAudioProgress(104);
    expect(driver.revealed).toBe(100 + COMPANION_REVEAL_LEAD_CHARS + COMPANION_REVEAL_MAX_DRIFT_CHARS);
    driver.noteAudioProgress(140);
    expect(driver.revealed).toBe(140 + COMPANION_REVEAL_LEAD_CHARS);
  });

  it("第一段音频迟迟不来：文字先被钉在 lead+drift，等满两倍看门狗才放行", () => {
    const { driver, advance } = harness();
    driver.noteSession("voice");
    driver.noteArrived(400);
    driver.tick();
    expect(driver.revealed).toBe(COMPANION_REVEAL_LEAD_CHARS);   // 看门狗没到：只放行提前量
    advance(COMPANION_REVEAL_FIRST_AUDIO_SILENCE_MS);
    driver.tick();                                                // 看门狗到点，钟起算
    advance(1_500);                                               // 还在"等音频"窗口内
    driver.tick();
    // 钟想走 25 个字，但一次都没出过声（ceiling=0）→ 最多 lead + drift。
    expect(driver.revealed).toBe(COMPANION_REVEAL_LEAD_CHARS + COMPANION_REVEAL_MAX_DRIFT_CHARS);
    // 等满两倍看门狗：认定这一轮不会出声，放行给阅读钟——否则一段永远不来的音频
    // 会把文字永久钉在这里，气泡再也收不了尾。
    advance(COMPANION_REVEAL_FIRST_AUDIO_SILENCE_MS);
    driver.tick();
    expect(driver.revealed).toBeGreaterThan(COMPANION_REVEAL_LEAD_CHARS + COMPANION_REVEAL_MAX_DRIFT_CHARS);
  });

  it("音频真的没了（被停/念完）时上限取消：文字仍按阅读钟走完", () => {
    const { driver, advance } = harness();
    driver.noteSession("voice");
    driver.noteArrived(400);
    driver.noteAudioProgress(100);
    driver.noteAudioStopped();
    advance(600);
    driver.tick();
    expect(driver.revealed).toBe(100 + COMPANION_REVEAL_LEAD_CHARS + 10);   // 钟从停的那一刻起算，按 60ms/字
    driver.finish();
    expect(driver.revealed).toBe(400);        // 用户点开全文：立刻到底
  });

  it("音频失败/被停：立刻交回阅读钟", () => {
    const { driver, advance } = harness();
    driver.noteSession("voice");
    driver.noteArrived(30);
    driver.noteAudioProgress(3);
    driver.noteAudioStopped();
    advance(600);
    driver.tick();
    expect(driver.revealed).toBe(3 + COMPANION_REVEAL_LEAD_CHARS + 10);
  });

  it("文本长度回退（服务端回写）不会把已经显现的字收回去", () => {
    const { driver } = harness();
    driver.noteSession("voice");
    driver.noteArrived(40);
    driver.noteAudioProgress(30);
    expect(driver.revealed).toBe(30 + COMPANION_REVEAL_LEAD_CHARS);
    // 草稿被服务端改写而变短：arrived 是"已知最大值"，显示端按当前文本切片，不会露多余的尾巴。
    driver.noteArrived(12);
    expect(driver.revealed).toBe(30 + COMPANION_REVEAL_LEAD_CHARS);
    expect(driver.arrived).toBe(40);
  });

  it("收尾只在「音频念完」或「钟走完全文」时发生，且只发生一次", () => {
    const { driver, advance } = harness();
    let completions = 0;
    driver.onComplete(() => { completions += 1; });
    driver.noteSession("voice");
    driver.noteArrived(20);
    // 还没 final：钟走完也不收尾（否则会在生成中途把气泡收掉）。
    // 2026-09-22 起，"一次都没出过声"要等满两倍第一段看门狗才认为这一轮不出声了
    // （在那之前阅读钟被钉在 lead+drift，免得文字跑到声音前面），所以这里要走过那一段。
    advance(2_000);
    driver.tick();
    advance(4_500);
    driver.tick();
    expect(driver.revealed).toBe(20);
    expect(completions).toBe(0);
    driver.noteTurnFinal();
    expect(completions).toBe(1);
    advance(5_000);
    driver.tick();
    expect(completions).toBe(1);
  });

  it("音频 finished 直接补满并收尾", () => {
    const { driver } = harness();
    let completions = 0;
    driver.onComplete(() => { completions += 1; });
    driver.noteSession("voice");
    driver.noteArrived(64);
    driver.noteAudioProgress(20);
    driver.noteTurnFinal();
    expect(completions).toBe(0);
    driver.noteAudioFinished();
    expect(driver.revealed).toBe(64);
    expect(completions).toBe(1);
  });

  it("用户点气泡看全文：finish 立刻补满", () => {
    const { driver } = harness();
    driver.noteSession("voice");
    driver.noteArrived(50);
    driver.noteTurnFinal();
    driver.finish();
    expect(driver.revealed).toBe(50);
  });

  it("空回复（没有正文）在 final 时立刻收尾，不留下一个不收的气泡", () => {
    const { driver } = harness();
    let completions = 0;
    driver.onComplete(() => { completions += 1; });
    driver.noteSession("unavailable");
    driver.noteTurnFinal();
    expect(completions).toBe(1);
  });

  it("已经收过尾之后再挂订阅，会立刻补一次（effect 重跑不会把气泡留在屏幕上）", () => {
    const { driver } = harness();
    driver.noteSession("unavailable");
    driver.noteTurnFinal();
    let completions = 0;
    const off = driver.onComplete(() => { completions += 1; });
    expect(completions).toBe(1);
    off();
    expect(completions).toBe(1);
  });

  it("换轮 reset 会把一切归零并通知订阅者", () => {
    const { driver } = harness();
    driver.noteArrived(40);
    driver.noteAudioProgress(20);
    driver.reset();
    expect(driver.revealed).toBe(0);
    expect(driver.arrived).toBe(0);
  });

  it("没有会话（unavailable）时按阅读钟推进，不看门", () => {
    const { driver, advance } = harness();
    driver.noteArrived(40);
    driver.tick();
    advance(600);
    driver.tick();
    expect(driver.revealed).toBe(10);
  });
});
