/**
 * 任务 07-9：反馈文案规则 纯逻辑（§11.3 / §11.4，冻结记录 01-9）。
 *
 * 本文件无 React / 无 DOM / 无网络，负责游戏感来源与反馈文案规则：
 * - **允许表达集合（§11.3）**：选择目的地和路线 / 预测决定后果 / 操作变化 /
 *   修复光路 / 可信理解变化显现 / 问题得到回答 / 回看理解变化；
 * - **禁止表达集合（§11.3 禁止清单 + §11.4 文案）**：XP / 等级 / 金币 / 连击 /
 *   宝箱；streak / 断签宽限 / 保住火焰；每日清空 / 自动追加 / 无限下一题；
 *   排行榜 / 分享成绩 / 跨用户比较；失败扣分 / 掉级羞辱 / 倒计时；
 *   随机奖励 / 内容锁 / 体力墙；伴星失望 / 焦虑 / 拟人依赖催促；
 * - **具体、可行动、非身份化校验**：`validateFeedbackCopy` 拒绝身份化表述
 *   （"你落后了""欠了 N 项""你不适合"）与伪精确掌握度（"完全掌握 92%"）；
 * - **合规文案构造**：`buildSpecificFeedback` 生成
 *   「这次你已经能重建前三个步骤，边界条件还没独立验证。」式文案。
 *
 * 不变量：
 * - `validateFeedbackCopy` 的 ok 只取决于禁止集合（机制 / 身份化 / 伪精确）；
 * - 禁止表达的正则独立、可扩展；合规文案保证不含任何禁止表达；
 * - 全部函数纯同步、无外部依赖。
 */

// ─── 1. 允许表达集合（§11.3）────────────────────────────────────────────

export const ALLOWED_FEEDBACK_EXPRESSIONS = [
  "choose_destination_and_route",  // 允许选择目的地和路线
  "predict_consequences",          // 能预测决定后果
  "visible_operational_change",    // 通过操作看到系统/因果/条件变化
  "repair_path",                   // 修复错误光路 / 让星重新清晰
  "trusted_change_reveal",         // 可信理解变化在知识世界显现
  "question_answered",             // 主动保存的问题得到回答/转化/安静归档
  "review_understanding_change",   // 回看理解变化（practice 航迹默认不作长期显著资产）
] as const;

export type AllowedFeedbackExpression = (typeof ALLOWED_FEEDBACK_EXPRESSIONS)[number];

export function isAllowedExpression(
  expression: string,
): expression is AllowedFeedbackExpression {
  return (ALLOWED_FEEDBACK_EXPRESSIONS as readonly string[]).includes(expression);
}

// ─── 2. 禁止表达集合（§11.3 禁止清单 + §11.4 文案）────────────────────

export const FORBIDDEN_FEEDBACK_MECHANICS = [
  "xp",                      // XP
  "levels",                  // 等级
  "coins",                   // 金币
  "combo",                   // 连击
  "chest",                   // 宝箱
  "streak",                  // streak / 连签 / 连续记录
  "grace_days",              // 断签宽限 / 补签
  "keep_flame",              // 保住火焰
  "daily_reset",             // 每日清空
  "auto_append",             // 自动追加
  "unlimited_next",          // 无限下一题
  "leaderboard",             // 排行榜
  "share_score",             // 分享成绩
  "cross_user_compare",      // 跨用户比较
  "failure_penalty",         // 失败扣分
  "level_down_shame",        // 掉级羞辱
  "countdown",               // 倒计时
  "random_reward",           // 随机奖励
  "content_lock",            // 内容锁
  "energy_wall",             // 体力墙
  "disappointment_urging",   // 伴星失望 / 焦虑 / 拟人依赖催促
] as const;

export type ForbiddenFeedbackMechanic = (typeof FORBIDDEN_FEEDBACK_MECHANICS)[number];

export function isForbiddenMechanic(mechanic: string): mechanic is ForbiddenFeedbackMechanic {
  return (FORBIDDEN_FEEDBACK_MECHANICS as readonly string[]).includes(mechanic);
}

/** 禁止机制 → 检测正则（独立可扩展；i 忽略大小写） */
export const FORBIDDEN_MECHANIC_PATTERNS: Record<ForbiddenFeedbackMechanic, RegExp> = {
  xp: /\b(xp|经验值|经验分)\b/i,
  levels: /(等级|级别|升级|升到?\s*\d+\s*级)/,
  coins: /(金币|积分奖励)/,
  combo: /连击/,
  chest: /宝箱/,
  streak: /\bstreak\b|连签|连学|连续记录/,
  grace_days: /(断签|补签|宽限天数|宽限)/,
  keep_flame: /保住火焰|火焰/,
  daily_reset: /每日清空|当天清零/,
  auto_append: /自动追加/,
  unlimited_next: /无限下一题|无限练习/,
  leaderboard: /排行榜|排名榜|分数榜/,
  share_score: /分享成绩|晒成绩/,
  cross_user_compare: /(超过了?|胜过).{0,6}(同学|同伴|别人|其他人)/,
  failure_penalty: /失败扣分|答错扣|扣分/,
  level_down_shame: /掉级|降级/,
  countdown: /倒计时|红色倒计时/,
  random_reward: /随机奖励|抽奖|随机掉落/,
  content_lock: /内容锁|解锁下一关|解锁需要/,
  energy_wall: /体力墙|体力不足|能量不足|没体力了/,
  disappointment_urging: /让我失望|会让我失望|你让我|失望了|再加把劲才能|必须继续学/,
};

// ─── 3. 身份化与伪精确表达（§11.4）────────────────────────────────────

/** 身份化表述（§11.4 禁止文案：你落后了 / 欠了 N 项 / 你不适合 / 你太慢…） */
export const IDENTITY_LABELING_PATTERNS = [
  /你(总是|从来)?(落后|不行|太慢|没天分|不适合)/,
  /你欠/,
  /欠了?\s*\d+\s*项/,
  /再来一题保住|保住进度/,
  /(记不住|学不会|做不到)(的人|的话|的样子)/,
] as const;

/** 伪精确掌握度（§11.4：你已经完全掌握 92% / 掌握度 87% / 完全掌握） */
export const PSEUDO_PRECISION_PATTERNS = [
  /(掌握|掌握度)\s*\d+(\.\d+)?\s*%/,
  /完全掌握/,
  /掌握\s*了?\s*(9[0-9]|8[0-9])\s*%/,
] as const;

// ─── 4. 校验（具体、可行动、非身份化）──────────────────────────────────

export interface CopyValidationResult {
  ok: boolean;
  /** 命中哪些禁止机制（按机制名列出） */
  forbiddenMechanisms: readonly ForbiddenFeedbackMechanic[];
  /** 是否含身份化表述 */
  identityLabeling: boolean;
  /** 是否含伪精确掌握度 */
  pseudoPrecision: boolean;
  /** 违规说明（每条一句，可展示给写作者） */
  violations: readonly string[];
}

/**
 * 校验一段反馈文案（§11.4）：
 * - 禁止机制（XP/streak/排行榜/债务/扣分/随机奖励/内容锁/体力墙/催促）；
 * - 身份化表述（"你落后了""欠了 N 项""你不适合"）；
 * - 伪精确掌握度（"完全掌握 92%"）。
 * 任一命中 → `ok=false`。
 */
export function validateFeedbackCopy(text: string): CopyValidationResult {
  const forbiddenMechanisms: ForbiddenFeedbackMechanic[] = [];
  const violations: string[] = [];
  for (const mechanic of FORBIDDEN_FEEDBACK_MECHANICS) {
    if (FORBIDDEN_MECHANIC_PATTERNS[mechanic].test(text)) {
      forbiddenMechanisms.push(mechanic);
      violations.push(`包含禁止机制：${mechanic}`);
    }
  }
  const identityLabeling = IDENTITY_LABELING_PATTERNS.some((pattern) => pattern.test(text));
  if (identityLabeling) violations.push("包含身份化表述（不评价人，只描述具体事实与下一步）");
  const pseudoPrecision = PSEUDO_PRECISION_PATTERNS.some((pattern) => pattern.test(text));
  if (pseudoPrecision) violations.push("包含伪精确掌握度（不展示未经事件依据的百分比掌握度）");

  return {
    ok: forbiddenMechanisms.length === 0 && !identityLabeling && !pseudoPrecision,
    forbiddenMechanisms,
    identityLabeling,
    pseudoPrecision,
    violations,
  };
}

/** 快速判定：是否合规（= validateFeedbackCopy.ok） */
export function isCompliantFeedbackCopy(text: string): boolean {
  return validateFeedbackCopy(text).ok;
}

/**
 * 是否具体可行动（§11.4）：
 * 文案应给出立即可执行的下一步，而非评价或催促。
 * 宽松规则：含行动指示词（可以/先/试试/尝试/下一步/从…开始/独立验证）。
 */
export function isActionableSpecific(text: string): boolean {
  return /(可以|先|试试|尝试|下一步|从.{1,20}开始|独立验证|重试|换一(个|条)|稍后再来|自由漫游)/.test(text);
}

// ─── 5. 合规文案构造（§11.4 示例式）────────────────────────────────────

export interface SpecificFeedbackInput {
  /** 这次已经能做的具体事情（例：重建前三个步骤） */
  done: readonly string[];
  /** 还没独立验证的边界条件（例：边界条件） */
  notYet: readonly string[];
}

/**
 * 生成具体、可行动、非身份化的反馈文案（§11.4 示例风格）：
 * - 「这次你已经能{done}；{notYet} 还没独立验证。」→ 再接一条可行动建议；
 * - 无 notYet 时以「可以试着独立验证一遍」作为下一步；
 * - 输出保证通过 `validateFeedbackCopy`（不含禁止表达）。
 */
export function buildSpecificFeedback(input: SpecificFeedbackInput): string {
  const doneText = input.done.join("、");
  let text = `这次你已经能${doneText}。`;
  if (input.notYet.length > 0) {
    text = `这次你已经能${doneText}；${input.notYet.join("、")} 还没独立验证。可以试着独立验证一遍。`;
  } else {
    text = `这次你已经能${doneText}。可以试着独立验证一遍，确认自己站稳了。`;
  }
  return text;
}
