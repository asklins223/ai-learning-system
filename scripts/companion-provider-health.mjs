/**
 * 伴星用到的每个模型槽位，现在到底会不会退化（方案 29 §6 B8 的"供应商健康度探测"）。
 *
 * 为什么要有它：这三天量下来的最难看的一类失效不在我们的代码里——
 * `tokenrhythm → litellm → qwen3.8-flash` 在交互链路上会高频返回"一两个字 + finish=stop"
 * 的半截话。修复侧已经做了（退化闸 + 修复阶梯 + 跨模型兜底），但全部是**事后**的：
 * 用户已经看到那句"你现在有"之后闸才合。§8.8 的一票否决也只能在事后从库里读出比率。
 * 这个探针是**事前**的：一次固定问句打每个槽位，看它今天会不会吐半截话。
 *
 * 三条刻意的约束：
 *  1. **必须在 worker 容器里跑**。主机上 `AI_PLATFORMS_CONFIG` 指向容器看不到的路径，
 *     解析结果会是 `provider=mock` + 一句"平台未配置"，那测不出任何真东西。
 *  2. **绝不打印 key**，也不打印带凭证的 URL。只输出 provider 名 / 模型 / 延迟 / 结论。
 *  3. 判据**复用生产同一函数**（`looksTruncatedReply`），不在这里另立一套"什么叫退化"。
 *     两套定义必然分叉，分叉之后这个探针就开始骗人。
 *
 * 用法（本项目 dev 栈）：
 *   docker exec -i -w /app ailearn-dev-worker-1 \
 *     node --import tsx --eval "$(cat scripts/companion-provider-health.mjs)"
 * 退出码：agent_turn 槽位出现任一退化 = 1（那是用户正在用的那一档）。
 */

const WORKSPACE_ID = process.env.PROBE_WORKSPACE_ID ?? "97550966-adf4-47fa-8d91-f83eae9ebfc0";
const USER_ID = process.env.PROBE_USER_ID ?? "f6c4a80e-e668-4be7-a7b3-e8ad9311079a";
const CALL_TIMEOUT_MS = 30_000;
// 交互链路真正用的是"关思考 + 整段取回"这一档（withThinkingDisabled），
// 开着思考测出来的健康度与用户无关。
const PROBE_PROMPT = "用一句完整的话说说，今天想陪我学点什么好？";
const AGENT_TURNS = Number(process.env.PROBE_ROUNDS ?? 3);

const { resolveAIGovernanceContext, resolveProviderForTask } = await import("./src/lib/governance.ts");
const { createProvider, withThinkingDisabled } = await import("./src/lib/ai-provider.ts");
const { createGovernedProvider } = await import("./src/lib/governance.ts");
const { looksTruncatedReply } = await import("./src/handlers/companion-dialogue-content.ts");

/** 生产里"活跃档"的退化线（字数），探针不必重读 pet_profiles：健康度看的是最坏情况。 */
const DEGENERATE_UNDER_CHARS = 6;

function classify(text) {
  const trimmed = String(text ?? "").trim();
  const wellEnded = /[。！？!?…～~]$/.test(trimmed);
  // looksTruncatedReply 的第二参是"这一档最少要有多少字"，与伴星退化闸同源。
  const degenerate = trimmed.length === 0
    || trimmed.length < DEGENERATE_UNDER_CHARS
    || looksTruncatedReply(trimmed, DEGENERATE_UNDER_CHARS);
  return { chars: Array.from(trimmed).length, degenerate, wellEnded, sample: trimmed.slice(0, 40) };
}

async function probe(label, provider, messages, options) {
  const startedAt = Date.now();
  try {
    const result = await provider.chatCompletion(messages, options, AbortSignal.timeout(CALL_TIMEOUT_MS));
    const verdict = classify(result.content);
    console.log(
      `  ${label.padEnd(16)} ${String(Date.now() - startedAt).padStart(6)}ms`
      + `  ${verdictMark(verdict)}  ${String(verdict.chars).padStart(3)}字  ${JSON.stringify(verdict.sample)}`,
    );
    return verdict;
  } catch (error) {
    console.log(`  ${label.padEnd(16)} ${String(Date.now() - startedAt).padStart(6)}ms  ✗失败  ${
      error?.constructor?.name ?? "Error"}: ${String(error?.message ?? error).slice(0, 90)}`);
    return { chars: 0, degenerate: true, wellEnded: false, failed: true, sample: "" };
  }
}

function verdictMark(verdict) {
  return verdict.degenerate ? "✗退化" : "✓正常";
}

const gov = await resolveAIGovernanceContext(WORKSPACE_ID, USER_ID);
if (!gov.consentOk) {
  console.error("该账号未同意 AI 外发（consentOk=false）——探针无法测真链路，先去看 user_ai_settings。");
  process.exit(2);
}

const textSlot = resolveProviderForTask(gov, "companion_agent");
console.log(`\n伴星模型槽位健康度  ${new Date().toISOString()}`);
console.log(`  槽位 provider/model：agent_turn=${textSlot.providerName}/${textSlot.providerConfig.model}`);

const plainMessages = [
  { role: "system", content: "你是一个学习伴星，说话自然、完整，一次说一整句。" },
  { role: "user", content: PROBE_PROMPT },
];
const textOptions = {
  responseFormat: "text",
  maxTokens: 200,
  temperature: 0.9,
  disableThinking: true,
};

const agentVerdicts = [];
// 与生产同构：createProvider 之后必须再过一层治理包装器，否则探针报的"健康"
// 是裸端点的健康，而真实链路每一步都要过这道门（门的形状变了探针也不会知道）。
const agentProvider = createGovernedProvider(
  createProvider(textSlot.providerName, withThinkingDisabled(textSlot.providerConfig)),
  gov, WORKSPACE_ID, { userId: USER_ID, operation: "provider_health_probe" },
);
for (let round = 1; round <= AGENT_TURNS; round += 1) {
  agentVerdicts.push(await probe(`agent_turn #${round}`, agentProvider, plainMessages, textOptions));
}

if (gov.companionFallbackProviderName && gov.companionFallbackProviderConfig) {
  const fallback = createGovernedProvider(
    createProvider(gov.companionFallbackProviderName, gov.companionFallbackProviderConfig),
    gov, WORKSPACE_ID, { userId: USER_ID, operation: "provider_health_probe" },
  );
  await probe("companion_fallback", fallback, plainMessages, textOptions);
} else {
  console.log("  companion_fallback  未配置（退化时没有可换的模型档）");
}

// 视觉槽位单独打一次：它要的是多模态消息，而治理门认得出来（sendImageContent=false 时
// 直接拒发）。这里送的是**本脚本自己生成的 1×1 像素图**，不含任何用户内容，
// 测的只是"这个端点现在还理不理人"。政策关着时把它记为"被政策拦住=健康"，
// 那不是故障。
const visionSlot = resolveProviderForTask(gov, "analyze_image");
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
try {
  // 走治理包装器（探针报的必须是真链路）。图片外发政策在 dev 是关的，这里用一份
  // **只在本次进程里存在**的政策副本把它打开：测的是"端点还理不理人"，
  // 送出去的也只有上面那 1×1 像素，不含任何用户内容，也不改数据库里那行同意记录。
  const visionProvider = createGovernedProvider(
    createProvider(visionSlot.providerName, visionSlot.providerConfig),
    { ...gov, policy: { ...gov.policy, sendImageContent: true } },
    WORKSPACE_ID,
    { userId: USER_ID, operation: "provider_health_probe" },
  );
  await probe("vision", visionProvider, [{
    role: "user",
    content: [
      { type: "text", text: "这张图有几种颜色？一句话回答。" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}` } },
    ],
  }], { responseFormat: "text", maxTokens: 60, temperature: 0.2 });
} catch (error) {
  console.log(`  vision            构造失败  ${String(error?.message ?? error).slice(0, 90)}`);
}

const degenerateCount = agentVerdicts.filter((v) => v.degenerate).length;
console.log(
  `\nagent_turn：${agentVerdicts.length - degenerateCount}/${agentVerdicts.length} 次给出完整句子`
  + (degenerateCount > 0
    ? "  ← 这一档正在退化。用户此刻看到的就是这种半截话；跨模型兜底会接住一部分，"
      + "但兜底是拿延迟换的，不是免费的。"
    : "  ← 这一档目前是健康的。"),
);
process.exit(degenerateCount > 0 ? 1 : 0);
