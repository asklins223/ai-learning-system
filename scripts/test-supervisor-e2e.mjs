#!/usr/bin/env node
/**
 * Supervisor Agent v1 端到端流程测试（综合版）
 *
 * 验证修复后的 Supervisor Agent 完整管道：
 * 1. Supervisor 不再陷入循环
 * 2. text_extractor 正确调用工具
 * 3. Critic 正确提交 Quality Report
 * 4. Deck Draft 正确生成
 * 5. 最终成功发布卡片
 *
 * 测试场景覆盖：
 * - 场景 A: 短笔记（光合作用），overview 密度
 * - 场景 B: 中等长度笔记（计算机网络），standard 密度
 * - 场景 C: 多段笔记（线性代数），overview 密度
 * - 场景 D: 包含代码的笔记（Python 基础），standard 密度
 * - 场景 E: 极短笔记（单段无标题），overview 密度 — 边缘 case
 * - 场景 F: 长笔记（微观经济学，多章节），complete 密度 — 压力测试
 * - 场景 G: 包含数学公式的笔记（微积分），standard 密度
 * - 场景 H: 中英混合内容笔记（机器学习基础），standard 密度
 *
 * 每个场景验证：
 * - Supervisor 推进流程（manifest → bundles → delegate → deck → critic → verify）
 * - 最终状态为 succeeded 或 partial_ready
 * - 生成了至少 1 张卡片
 * - Agent events 序列合理
 * - 无循环（manifest 调用 ≤ 3 次）
 * - 子 Agent 正确调用工具或触发自动回退
 */

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const TEST_EMAIL = process.env.RC_TEST_EMAIL ?? "rc-test@example.test";
const TEST_PASSWORD = process.env.RC_TEST_PASSWORD ?? "rc_test_password_2026";

// ─── 辅助函数 ─────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

async function apiWithRetry(path, options = {}, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await api(path, options);
    } catch (err) {
      lastErr = err;
      if (i < maxRetries - 1) {
        console.log(`  [retry ${i + 1}/${maxRetries}] ${err.message}`);
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

async function login() {
  let res = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });

  if (res.ok) {
    return {
      token: res.body.token,
      userId: res.body.ctx.userId,
      workspaceId: res.body.ctx.workspaceId,
    };
  }

  console.log("Login failed, attempting register...");
  // /auth/register 已 410 关闭（明文邀请码路径移除），测试脚本改走 register-v2
  res = await api("/auth/register-v2", {
    method: "POST",
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      displayName: "RC Test User",
    }),
  });

  if (!res.ok) {
    throw new Error(`Register failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  res = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });

  if (!res.ok) {
    throw new Error(`Login after register failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  return {
    token: res.body.token,
    userId: res.body.ctx.userId,
    workspaceId: res.body.ctx.workspaceId,
  };
}

async function createNote(token, title, blocks) {
  const res = await apiWithRetry("/notes", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, blocks }),
  });
  if (!res.ok) {
    throw new Error(`Create note failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function createCardGenRun(token, noteVersionId, density = "overview") {
  const res = await apiWithRetry("/card-generation-runs", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      noteVersionId,
      idempotencyKey: `e2e-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      density,
    }),
  });
  if (!res.ok) {
    throw new Error(`Create card gen run failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function getRun(token, runId) {
  const res = await apiWithRetry(`/card-generation-runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Get run failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function getRunEvents(token, runId) {
  const res = await apiWithRetry(`/card-generation-runs/${runId}/agent-events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) {
    const body = res.body;
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.events)) return body.events;
    if (Array.isArray(body?.data)) return body.data;
    return [];
  }
  return [];
}

const TERMINAL = new Set(["succeeded", "needs_attention", "partial_ready", "cancelled", "superseded"]);

// P1-14: Artifact 输出目录
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? "./e2e-artifacts";

/**
 * P1-14: 查询卡片的证据对齐状态。
 *
 * 审计发现 36/36 published evidence 为 unaligned，但 E2E 未检测到此问题。
 * 通过 GET /cards/:cardId/evidence 查询每张卡片的证据对齐状态。
 */
async function getCardEvidence(token, cardId) {
  const res = await apiWithRetry(`/cards/${cardId}/evidence`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return res.body;
  return null;
}

/**
 * P1-14: 收集所有卡片的证据对齐状态。
 *
 * 返回 { totalEvidence, alignedCount, unalignedCount, autoVerifiedCount, details }
 */
async function collectEvidenceAlignment(token, cards) {
  const details = [];
  let totalEvidence = 0;
  let alignedCount = 0;
  let unalignedCount = 0;
  let softCount = 0;
  let autoVerifiedCount = 0;

  for (const card of cards) {
    if (!card.cardId) continue;
    const evidenceData = await getCardEvidence(token, card.cardId);
    if (!evidenceData) continue;

    // API returns an array of { keyPoint, evidences } objects.
    // Also handle { keyPoints: [...] } format for compatibility.
    const keyPointEntries = Array.isArray(evidenceData)
      ? evidenceData
      : (Array.isArray(evidenceData.keyPoints) ? evidenceData.keyPoints : []);

    for (const kp of keyPointEntries) {
      // Handle both { keyPoint: {...}, evidences: [...] } and { ..., evidences: [...] } formats
      const keyPointInfo = kp.keyPoint ?? kp;
      const evidences = kp.evidences;
      if (!evidences) continue;
      for (const ev of evidences) {
        totalEvidence++;
        const alignment = ev.alignment ?? "unaligned";
        if (alignment === "aligned") alignedCount++;
        else if (alignment === "soft") softCount++;
        else unalignedCount++;

        // P1-14: 检查 autoVerified 标记
        if (ev.autoVerified === true || ev.alignmentMethod === "auto_verified") {
          autoVerifiedCount++;
        }

        details.push({
          cardId: card.cardId,
          keyPointId: keyPointInfo.id,
          evidenceId: ev.id,
          alignment,
          autoVerified: ev.autoVerified === true || ev.alignmentMethod === "auto_verified",
        });
      }
    }
  }

  return { totalEvidence, alignedCount, unalignedCount, softCount, autoVerifiedCount, details };
}

/**
 * P1-14: 保存完整 artifact 到文件。
 *
 * 审计要求 E2E 查询并保存完整 Draft、Candidates、Evidence、Quality Report、
 * fallback events 和 published cards。
 */
async function saveArtifact(scenarioName, runId, data) {
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const safeName = scenarioName.replace(/[^a-zA-Z0-9-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${safeName}_${runId.slice(0, 8)}_${timestamp}.json`;
    const filepath = resolve(ARTIFACT_DIR, filename);
    mkdirSync(dirname(filepath), { recursive: true });
    writeFileSync(filepath, JSON.stringify(data, null, 2), "utf8");
    console.log(`     artifact 已保存: ${filepath}`);
  } catch (err) {
    console.log(`     ⚠️ artifact 保存失败: ${err.message}`);
  }
}

// ─── 测试场景定义 ─────────────────────────────────────────────────────────

const TEST_SCENARIOS = [
  {
    name: "A: 光合作用（短笔记，overview）",
    title: "光合作用基础",
    density: "overview",
    blocks: [
      { ordinal: 0, type: "heading", content: "光合作用" },
      { ordinal: 1, type: "paragraph", content: "光合作用是植物、藻类和某些细菌利用光能将二氧化碳和水转化为有机物的过程。光合作用分为光反应和暗反应两个阶段。光反应发生在类囊体膜上，产生 ATP 和 NADPH；暗反应（卡尔文循环）发生在基质中，利用 ATP 和 NADPH 固定二氧化碳。" },
      { ordinal: 2, type: "paragraph", content: "光合作用的总反应式为：6CO₂ + 6H₂O + 光能 → C₆H₁₂O₆ + 6O₂。光合作用是地球上最重要的生物化学反应之一，它是几乎所有生命体的能量来源。" },
    ],
  },
  {
    name: "B: 计算机网络（中等笔记，standard）",
    title: "计算机网络基础",
    density: "standard",
    blocks: [
      { ordinal: 0, type: "heading", content: "计算机网络概述" },
      { ordinal: 1, type: "paragraph", content: "计算机网络是将地理位置不同的具有独立功能的多台计算机及其外部设备，通过通信线路连接起来，在网络操作系统和通信协议的管理下，实现资源共享和信息传递的系统。" },
      { ordinal: 2, type: "heading", content: "OSI 七层模型" },
      { ordinal: 3, type: "paragraph", content: "OSI（Open Systems Interconnection）参考模型将网络分为七层：物理层、数据链路层、网络层、传输层、会话层、表示层和应用层。每一层负责不同的功能，下层为上层提供服务。" },
      { ordinal: 4, type: "paragraph", content: "物理层负责传输比特流，数据链路层负责帧的传输和错误检测，网络层负责路由选择，传输层提供端到端的可靠传输，会话层管理会话，表示层处理数据格式，应用层提供网络服务。" },
      { ordinal: 5, type: "heading", content: "TCP/IP 协议" },
      { ordinal: 6, type: "paragraph", content: "TCP/IP 是互联网的基础协议，分为四层：网络接口层、网际层、传输层和应用层。TCP 提供面向连接的可靠传输，UDP 提供无连接的不可靠传输。IP 协议负责数据包的路由和转发。" },
    ],
  },
  {
    name: "C: 线性代数（多段笔记，overview）",
    title: "线性代数基础",
    density: "overview",
    blocks: [
      { ordinal: 0, type: "heading", content: "线性代数" },
      { ordinal: 1, type: "paragraph", content: "线性代数是研究向量空间、线性变换和线性方程组的数学分支。它是现代数学的基础之一，广泛应用于物理学、计算机科学、工程学等领域。" },
      { ordinal: 2, type: "heading", content: "向量" },
      { ordinal: 3, type: "paragraph", content: "向量是具有大小和方向的量，可以用有序的数字数组表示。向量的基本运算包括加法、减法和数乘。点积（内积）和叉积（外积）是两种重要的向量乘法运算。" },
      { ordinal: 4, type: "heading", content: "矩阵" },
      { ordinal: 5, type: "paragraph", content: "矩阵是按行列排列的数字表格，用于表示线性变换。矩阵的运算包括加法、乘法、转置和求逆。行列式是矩阵对应的一个标量值，用于判断矩阵是否可逆。" },
      { ordinal: 6, type: "heading", content: "特征值与特征向量" },
      { ordinal: 7, type: "paragraph", content: "对于方阵 A，如果存在非零向量 v 和标量 λ 使得 Av = λv，则称 λ 为特征值，v 为特征向量。特征值和特征向量在数据降维（PCA）、图像压缩等领域有重要应用。" },
    ],
  },
  {
    name: "D: Python 基础（含代码，standard）",
    title: "Python 编程基础",
    density: "standard",
    blocks: [
      { ordinal: 0, type: "heading", content: "Python 简介" },
      { ordinal: 1, type: "paragraph", content: "Python 是一种高级、解释型、通用型编程语言。它以简洁的语法和丰富的标准库著称，广泛应用于数据科学、人工智能、Web 开发等领域。" },
      { ordinal: 2, type: "heading", content: "变量与数据类型" },
      { ordinal: 3, type: "paragraph", content: "Python 是动态类型语言，变量不需要声明类型。基本数据类型包括整数（int）、浮点数（float）、字符串（str）、布尔值（bool）和空值（None）。列表（list）、元组（tuple）、字典（dict）和集合（set）是常用的容器类型。" },
      { ordinal: 4, type: "paragraph", content: "列表是可变有序序列，使用方括号 [] 创建。元组是不可变有序序列，使用圆括号 () 创建。字典是键值对的无序集合，使用花括号 {} 创建。集合是无序不重复元素的集合。" },
      { ordinal: 5, type: "heading", content: "控制流" },
      { ordinal: 6, type: "paragraph", content: "Python 使用 if-elif-else 进行条件判断，使用 for 和 while 进行循环。for 循环常与 range() 函数配合使用。break 和 continue 用于控制循环流程。" },
      { ordinal: 7, type: "paragraph", content: "列表推导式是 Python 的特色语法，可以用一行代码生成列表：[x*2 for x in range(10) if x % 2 == 0] 生成 [0, 4, 8, 12, 16]。" },
    ],
  },
  {
    name: "E: 极短笔记（单段无标题，overview）",
    title: "摩尔定律",
    density: "overview",
    blocks: [
      { ordinal: 0, type: "paragraph", content: "摩尔定律是由英特尔创始人之一戈登·摩尔提出的经验法则：集成电路上可容纳的晶体管数目约每隔 18 个月便会增加一倍，性能也将提升一倍。这一定律推动了半导体行业数十年的快速发展，但近年来随着制程接近物理极限，摩尔定律的效力逐渐减弱。" },
    ],
  },
  {
    name: "F: 微观经济学（长笔记，complete）",
    title: "微观经济学原理",
    density: "complete",
    blocks: [
      { ordinal: 0, type: "heading", content: "微观经济学概述" },
      { ordinal: 1, type: "paragraph", content: "微观经济学是研究个体经济单位（如家庭、企业）决策行为的经济学分支。它关注资源配置、价格形成和市场均衡等问题，是现代经济学的基础。" },
      { ordinal: 2, type: "heading", content: "需求与供给" },
      { ordinal: 3, type: "paragraph", content: "需求定律指出，在其他条件不变的情况下，商品价格上升时需求量减少，价格下降时需求量增加。供给定律则相反：价格上升时供给量增加，价格下降时供给量减少。市场均衡出现在需求量等于供给量的价格点上。" },
      { ordinal: 4, type: "paragraph", content: "需求弹性衡量需求量对价格变化的敏感程度。如果弹性大于 1，称为富有弹性；小于 1，称为缺乏弹性。奢侈品通常富有弹性，必需品通常缺乏弹性。" },
      { ordinal: 5, type: "heading", content: "消费者行为理论" },
      { ordinal: 6, type: "paragraph", content: "效用是消费者从消费商品中获得的满足程度。边际效用递减规律指出，随着消费量增加，每增加一单位商品带来的额外效用递减。消费者在预算约束下最大化总效用的条件是：每单位货币在不同商品上带来的边际效用相等。" },
      { ordinal: 7, type: "paragraph", content: "无差异曲线表示给消费者带来相同效用的商品组合。预算线表示消费者在给定收入和价格下能负担的商品组合。最优消费选择在无差异曲线与预算线的切点处。" },
      { ordinal: 8, type: "heading", content: "生产与成本" },
      { ordinal: 9, type: "paragraph", content: "生产函数描述投入与产出之间的关系。短期生产中至少有一种投入固定，长期生产中所有投入可变。边际报酬递减规律：在固定投入不变时，连续增加可变投入，边际产量最终递减。" },
      { ordinal: 10, type: "paragraph", content: "成本分为固定成本和可变成本。平均固定成本随产量增加而递减，平均可变成本呈 U 形。边际成本曲线穿过平均总成本曲线和平均可变成本曲线的最低点。" },
      { ordinal: 11, type: "heading", content: "市场结构" },
      { ordinal: 12, type: "paragraph", content: "完全竞争市场的特征：大量买卖双方、产品同质、自由进出、信息完全。在完全竞争中，企业是价格接受者，长期均衡时经济利润为零。" },
      { ordinal: 13, type: "paragraph", content: "垄断市场只有一个卖方。垄断者通过限制产量提高价格来最大化利润。垄断造成无谓损失，需要政府监管或反垄断法干预。" },
      { ordinal: 14, type: "paragraph", content: "寡头市场由少数几家大企业主导，企业之间存在策略互动。古诺模型描述产量竞争，伯特兰模型描述价格竞争。卡特尔是企业间勾结定价的协议，在大多数国家非法。" },
    ],
  },
  {
    name: "G: 微积分（含数学公式，standard）",
    title: "微积分基础",
    density: "standard",
    blocks: [
      { ordinal: 0, type: "heading", content: "微积分简介" },
      { ordinal: 1, type: "paragraph", content: "微积分是研究变化率和累积量的数学分支，由牛顿和莱布尼茨独立发明。微分学研究函数的变化率（导数），积分学研究函数的累积量（积分）。微积分基本定理将微分和积分联系起来。" },
      { ordinal: 2, type: "heading", content: "导数" },
      { ordinal: 3, type: "paragraph", content: "函数 f(x) 在点 x 处的导数定义为 f'(x) = lim[h→0] (f(x+h) - f(x)) / h。导数表示函数在该点的瞬时变化率，几何意义是切线的斜率。基本求导法则：(x^n)' = nx^(n-1)，(sin x)' = cos x，(cos x)' = -sin x，(e^x)' = e^x，(ln x)' = 1/x。" },
      { ordinal: 4, type: "paragraph", content: "链式法则：(f(g(x)))' = f'(g(x)) · g'(x)。乘法法则：(f·g)' = f'·g + f·g'。除法法则：(f/g)' = (f'·g - f·g') / g²。" },
      { ordinal: 5, type: "heading", content: "积分" },
      { ordinal: 6, type: "paragraph", content: "不定积分是导数的逆运算：如果 F'(x) = f(x)，则 ∫f(x)dx = F(x) + C。定积分 ∫[a,b] f(x)dx 表示函数 f(x) 在区间 [a,b] 上的曲线下面积。" },
      { ordinal: 7, type: "paragraph", content: "微积分基本定理：∫[a,b] f(x)dx = F(b) - F(a)，其中 F 是 f 的原函数。这个定理将微分和积分这两个看似不同的概念统一起来。" },
    ],
  },
  {
    name: "H: 机器学习（中英混合，standard）",
    title: "Machine Learning 机器学习基础",
    density: "standard",
    blocks: [
      { ordinal: 0, type: "heading", content: "机器学习概述 Machine Learning Overview" },
      { ordinal: 1, type: "paragraph", content: "机器学习（Machine Learning, ML）是人工智能的一个分支，通过算法让计算机从数据中学习模式，无需显式编程。主要分为监督学习（Supervised Learning）、无监督学习（Unsupervised Learning）和强化学习（Reinforcement Learning）三大类。" },
      { ordinal: 2, type: "heading", content: "监督学习 Supervised Learning" },
      { ordinal: 3, type: "paragraph", content: "监督学习使用标注数据（labeled data）训练模型。分类（Classification）预测离散标签，回归（Regression）预测连续值。常见算法包括线性回归（Linear Regression）、逻辑回归（Logistic Regression）、决策树（Decision Tree）和支持向量机（SVM, Support Vector Machine）。" },
      { ordinal: 4, type: "paragraph", content: "过拟合（Overfitting）是模型在训练集上表现好但泛化能力差的现象。解决方法包括正则化（Regularization）、交叉验证（Cross-Validation）和 Dropout 等。" },
      { ordinal: 5, type: "heading", content: "无监督学习 Unsupervised Learning" },
      { ordinal: 6, type: "paragraph", content: "无监督学习从无标签数据中发现隐藏结构。聚类（Clustering）将相似数据分组，如 K-Means 算法。降维（Dimensionality Reduction）减少特征数量，如主成分分析（PCA, Principal Component Analysis）和 t-SNE。" },
      { ordinal: 7, type: "heading", content: "神经网络 Neural Networks" },
      { ordinal: 8, type: "paragraph", content: "神经网络（Neural Network）模仿生物神经元结构，由输入层、隐藏层和输出层组成。深度学习（Deep Learning）使用多层神经网络。反向传播（Backpropagation）算法通过链式法则计算梯度，更新权重。激活函数（Activation Function）如 ReLU 和 Sigmoid 引入非线性。" },
    ],
  },
];

// ─── 单场景测试 ───────────────────────────────────────────────────────────

async function runScenario(auth, scenario, scenarioIndex) {
  const label = `场景 ${scenario.name}`;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${label}`);
  console.log(`${"=".repeat(60)}`);

  // 1. 创建笔记
  console.log("  1. 创建笔记...");
  const noteResult = await createNote(auth.token, scenario.title, scenario.blocks);
  const noteId = noteResult.note.id;
  const noteVersionId = noteResult.version.id;
  console.log(`     noteId: ${noteId}`);
  console.log(`     noteVersionId: ${noteVersionId}`);

  // 2. 发起 card generation run
  console.log(`  2. 发起 card-generation run (density: ${scenario.density})...`);
  const run = await createCardGenRun(auth.token, noteVersionId, scenario.density);
  const runId = run.runId ?? run.id;
  console.log(`     runId: ${runId}`);
  console.log(`     initial status: ${run.status}`);

  // 3. 轮询状态
  console.log("  3. 轮询 run 状态...");
  const startTime = Date.now();
  const timeoutMs = 360_000; // 6 分钟
  let lastEventCount = 0;
  let pollCount = 0;
  const allEvents = [];

  while (Date.now() - startTime < timeoutMs) {
    let currentRun;
    try {
      currentRun = await getRun(auth.token, runId);
    } catch (err) {
      console.log(`     [poll ${pollCount}] getRun error: ${err.message}, retrying...`);
      await new Promise(r => setTimeout(r, 3000));
      pollCount++;
      continue;
    }
    const status = currentRun.status;
    pollCount++;

    // 获取 events
    let events;
    try {
      events = await getRunEvents(auth.token, runId);
    } catch {
      events = [];
    }
    const newEvents = events.slice(lastEventCount);

    if (newEvents.length > 0) {
      for (const e of newEvents) {
        const turn = e.turnNo ?? "?";
        const tool = e.toolName ?? "—";
        const type = e.eventType ?? e.type ?? "—";
        const role = e.agentRole ?? "—";
        console.log(`     [turn ${turn}] ${role} → ${tool} (${type})`);
      }
      lastEventCount = events.length;
      allEvents.push(...newEvents);
    }

    if (TERMINAL.has(status)) {
      console.log(`\n  4. Run 到达终态: ${status}`);
      console.log(`     总轮询次数: ${pollCount}`);
      console.log(`     总耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      console.log(`     总 event 数: ${events.length}`);

      // 分析 Agent 行为
      console.log("\n  === Agent 行为分析 ===");

      // 统计工具调用
      const toolResults = events.filter(e =>
        e.eventType === "tool_result" &&
        e.agentRole === "generation_supervisor"
      );
      const toolNames = toolResults.map(e => e.toolName).filter(Boolean);
      const toolCounts = {};
      for (const name of toolNames) {
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      }

      console.log("\n  Supervisor 工具调用统计:");
      for (const [name, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
        const marker = name === "get_run_manifest" && count > 2 ? " ⚠️ 重复调用" : "";
        console.log(`     ${name}: ${count}${marker}`);
      }

      // 各角色工具调用统计
      const roles = [...new Set(events.map(e => e.agentRole).filter(Boolean))];
      for (const role of roles) {
        const roleTools = events
          .filter(e => e.agentRole === role && e.eventType === "tool_result" && e.toolName)
          .map(e => e.toolName);
        if (roleTools.length > 0) {
          const roleCounts = {};
          for (const name of roleTools) {
            roleCounts[name] = (roleCounts[name] ?? 0) + 1;
          }
          console.log(`\n  ${role} 工具调用:`);
          for (const [name, count] of Object.entries(roleCounts).sort((a, b) => b[1] - a[1])) {
            console.log(`     ${name}: ${count}`);
          }
        }
      }

      // 关键检查
      const hasManifest = toolNames.includes("get_run_manifest");
      const hasGetBundles = toolNames.includes("get_next_unassigned_bundles");
      const hasDelegate = toolNames.includes("delegate_specialist");
      const hasDeckDraft = toolNames.includes("submit_deck_draft");
      const hasCritic = toolNames.includes("request_grounding_review");
      const hasVerify = toolNames.includes("request_verification");
      const manifestCount = toolCounts["get_run_manifest"] ?? 0;

      // 检查子 Agent 工具调用
      const extractorTools = events
        .filter(e => (e.agentRole === "text_extractor" || e.agentRole === "code_extractor") &&
          e.eventType === "tool_result" && e.toolName)
        .map(e => e.toolName);
      const hasExtractorRecord = extractorTools.includes("record_extraction_decisions");
      const hasExtractorComplete = extractorTools.includes("complete_agent_task");

      const criticTools = events
        .filter(e => e.agentRole === "grounding_critic" && e.eventType === "tool_result" && e.toolName)
        .map(e => e.toolName);
      const hasCriticReport = criticTools.includes("submit_quality_report");

      // 检查自动回退
      // P1-14 fix: Only flag semantic fallbacks as failures.
      // Pure scheduling fallbacks (request_verification, request_grounding_review, validate_draft)
      // are legitimate and should not cause test failure.
      // autoCompleted=true events are also legitimate (task completion after results submitted).
      const SEMANTIC_FALLBACK_TOOLS = new Set([
        "delegate_specialist",    // semantic: choosing role
        "submit_deck_draft",      // semantic: generating title/summary
        "apply_draft_patch",      // semantic: generating patch content
      ]);
      const autoEvents = events.filter(e =>
        e.safePayload?.autoGenerated === true ||
        e.safePayload?.autoCompleted === true
      );
      // Only semantic fallbacks are failures
      const semanticAutoEvents = autoEvents.filter(e =>
        e.safePayload?.autoGenerated === true && SEMANTIC_FALLBACK_TOOLS.has(e.toolName ?? "")
      );
      const hasAutoFallback = semanticAutoEvents.length > 0;
      const autoDetails = autoEvents.map(e => ({
        role: e.agentRole ?? "?",
        tool: e.toolName ?? "?",
        autoGenerated: e.safePayload?.autoGenerated ?? false,
        autoCompleted: e.safePayload?.autoCompleted ?? false,
      }));

      console.log("\n  关键检查:");
      console.log(`     get_run_manifest 调用次数: ${manifestCount} ${manifestCount > 2 ? "⚠️ 重复" : "✅"}`);
      console.log(`     领取 bundles: ${hasGetBundles ? "✅ 是" : "❌ 否"}`);
      console.log(`     委派 specialist: ${hasDelegate ? "✅ 是" : "❌ 否"}`);
      console.log(`     Extractor 调用 record_extraction_decisions: ${hasExtractorRecord ? "✅ 是" : "❌ 否"}`);
      console.log(`     Extractor 调用 complete_agent_task: ${hasExtractorComplete ? "✅ 是" : "❌ 否"}`);
      console.log(`     提交 Deck Draft: ${hasDeckDraft ? "✅ 是" : "❌ 否"}`);
      console.log(`     请求 Critic: ${hasCritic ? "✅ 是" : "❌ 否"}`);
      console.log(`     Critic 提交 Quality Report: ${hasCriticReport ? "✅ 是" : "❌ 否"}`);
      console.log(`     请求 Verification: ${hasVerify ? "✅ 是" : "❌ 否"}`);
      console.log(`     自动回退触发: ${hasAutoFallback ? "⚠️ 是" : "✅ 无需回退"}`);
      if (hasAutoFallback) {
        for (const d of autoDetails) {
          console.log(`       - ${d.role}/${d.tool} (autoGenerated=${d.autoGenerated}, autoCompleted=${d.autoCompleted})`);
        }
      }

      // 输出卡片：从 cardSetId 获取
      const cardSetId = currentRun.result?.cardSetId;
      let cards = [];
      if (cardSetId) {
        try {
          const csRes = await apiWithRetry(`/card-sets/${cardSetId}`, {
            headers: { Authorization: `Bearer ${auth.token}` },
          });
          if (csRes.ok && csRes.body?.cards) {
            cards = csRes.body.cards.map((c) => {
              const card = c.card ?? c;
              // P1-14 修复：卡片标题和摘要在 schemaJson 中，不是顶层字段。
              // 原代码使用 card.title ?? "untitled"，但 publish-phase.ts
              // 将 title/summary 存入 schemaJson，导致所有卡片显示为 untitled。
              const sj = card.schemaJson ?? card.schema ?? {};
              return {
                cardId: card.id,
                title: card.title ?? sj.title ?? card.cardTitle ?? "untitled",
                summary: card.summary ?? sj.summary ?? card.answer ?? card.front ?? "",
                scope: card.scope ?? null,
                keyPoints: (c.keyPoints ?? []).map(kp => ({
                  id: kp.id,
                  claim: kp.claim?.slice(0, 100),
                  quoteText: kp.quoteText?.slice(0, 100),
                })),
              };
            });
          }
        } catch {
          // 忽略卡片获取失败
        }
      }

      // P1-14: 查询所有卡片的证据对齐状态
      // 审计发现 36/36 published evidence 为 unaligned，但 E2E 未检测到此问题。
      const evidenceResult = await collectEvidenceAlignment(auth.token, cards);
      if (cards.length > 0) {
        console.log(`\n  生成的卡片 (${cards.length} 张):`);
        for (const card of cards) {
          const title = card.title ?? card.cardTitle ?? "untitled";
          const summary = (card.summary ?? card.answer ?? "").slice(0, 80);
          console.log(`     - ${title}: ${summary}...`);
        }
      } else {
        console.log("\n  ⚠️ 未生成卡片");
      }

      // 最终判定
      // P1-14 修复：E2E 不得仅按状态通过；必须执行硬门禁检查。
      const passed = status === "succeeded" || status === "partial_ready";
      const noLoop = manifestCount <= 3;
      const pipelineComplete = hasDelegate && hasDeckDraft && hasCritic;

      // P1-14 硬门禁：语义 autoGenerated 必须为 0
      const noAutoFallback = !hasAutoFallback;

      // P1-14 硬门禁：必须有 Critic Report（非空 verdict）
      const hasCriticVerdict = hasCriticReport;

      // P1-14 硬门禁：必须有 Verify 步骤
      const hasVerifyStep = hasVerify;

      // P1-14 硬门禁：卡片数 > 0
      const hasCards = cards.length > 0;

      // P1-14 硬门禁：标题与摘要不得完全相同
      const noTitleSummaryIdentical = cards.every(c =>
        (c.title ?? "untitled") !== (c.summary ?? "")
      );

      // P1-14 硬门禁：标题不得为 untitled（说明解析失败）
      const noUntitled = cards.every(c =>
        c.title && c.title !== "untitled" && c.title.trim().length > 0
      );

      // P1-14 硬门禁：不得有机械截断片段成为标题
      const noTruncated = cards.every(c =>
        !c.title?.includes("...") && !c.title?.includes("...(truncated")
      );

      // P1-14 硬门禁：provider capability fingerprint 必须存在且非 mock
      // 防止 Mock 成功被误当成真模型成功
      const fingerprint = currentRun.providerCapabilityFingerprint ?? null;
      const hasRealProvider = fingerprint !== null && !fingerprint.includes("mock");
      const isMockProvider = fingerprint !== null && fingerprint.includes("mock");

      // P1-14 硬门禁：coverage report 前四层必须为 100%
      const covReport = currentRun.coverageReport ?? {};
      const physCov = typeof covReport.sourcePhysicalCoverage === "number" ? covReport.sourcePhysicalCoverage : 0;
      const assignCov = typeof covReport.bundleAssignmentCoverage === "number" ? covReport.bundleAssignmentCoverage : 0;
      const decisionCov = typeof covReport.explicitDecisionCoverage === "number" ? covReport.explicitDecisionCoverage : 0;
      const survivalCov = typeof covReport.candidateSurvivalCoverage === "number" ? covReport.candidateSurvivalCoverage : 0;
      const coverageComplete = physCov >= 1.0 && assignCov >= 1.0 && decisionCov >= 1.0 && survivalCov >= 1.0;

      // P1-14 硬门禁：所有已发布证据必须为 aligned（非 unaligned）
      // 审计发现 36/36 published evidence 为 unaligned
      const noUnalignedEvidence = evidenceResult.totalEvidence === 0 || evidenceResult.unalignedCount === 0;

      // P1-14 硬门禁：不得有 auto_verified 证据
      const noAutoVerified = evidenceResult.autoVerifiedCount === 0;

      // P1-14 硬门禁：每张卡片至少有一条 aligned hard evidence
      // 审计要求 Key point 具有 aligned hard evidence：100%
      const allCardsHaveAlignedEvidence = cards.length > 0 && cards.every(card => {
        const cardEvidence = evidenceResult.details.filter(d => d.cardId === card.cardId);
        return cardEvidence.some(d => d.alignment === "aligned");
      });

      // 综合判定
      const hardGatesPassed = noAutoFallback && hasCriticVerdict && hasVerifyStep && hasCards && noTitleSummaryIdentical && noUntitled && noTruncated && hasRealProvider && coverageComplete && noUnalignedEvidence && noAutoVerified && allCardsHaveAlignedEvidence;
      const overallPassed = passed && hardGatesPassed;

      console.log("\n  === 硬门禁检查（P1-14） ===");
      console.log(`  ${noAutoFallback ? '✅' : '❌'} 语义 autoGenerated = 0 (实际: ${hasAutoFallback ? '>0' : '0'})`);
      console.log(`  ${hasCriticVerdict ? '✅' : '❌'} Critic Report 存在`);
      console.log(`  ${hasVerifyStep ? '✅' : '❌'} Verify 步骤存在`);
      console.log(`  ${hasCards ? '✅' : '❌'} 卡片数 > 0 (${cards.length})`);
      console.log(`  ${noTitleSummaryIdentical ? '✅' : '❌'} 标题与摘要不完全相同`);
      console.log(`  ${noUntitled ? '✅' : '❌'} 无 untitled 卡片`);
      console.log(`  ${noTruncated ? '✅' : '❌'} 无机械截断标题`);
      console.log(`  ${hasRealProvider ? '✅' : '❌'} Provider 非Mock (fingerprint: ${fingerprint ?? "null"})`);
      if (isMockProvider) {
        console.log(`  ⚠️  Provider 为 Mock，结果不可作为质量证据`);
      }
      console.log(`  ${coverageComplete ? '✅' : '❌'} Coverage 前四层=100% (phys=${physCov}, assign=${assignCov}, decision=${decisionCov}, survival=${survivalCov})`);
      console.log(`  ${noUnalignedEvidence ? '✅' : '❌'} 无 unaligned 证据 (总=${evidenceResult.totalEvidence}, aligned=${evidenceResult.alignedCount}, unaligned=${evidenceResult.unalignedCount}, soft=${evidenceResult.softCount})`);
      console.log(`  ${noAutoVerified ? '✅' : '❌'} 无 auto_verified 证据 (count=${evidenceResult.autoVerifiedCount})`);
      console.log(`  ${allCardsHaveAlignedEvidence ? '✅' : '❌'} 每张卡至少 1 条 aligned evidence`);

      console.log("\n  === 最终判定 ===");
      if (overallPassed) {
        console.log(`  ✅ 场景通过: status=${status}, 卡片数=${cards.length}, 硬门禁全部通过`);
      } else if (passed && !hardGatesPassed) {
        console.log(`  ❌ 场景失败: status=${status} 但硬门禁未通过`);
      } else if (pipelineComplete && noLoop) {
        console.log(`  ⚠️ 场景部分通过: 管道完整但最终状态为 ${status}`);
      } else if (manifestCount > 3) {
        console.log(`  ❌ 场景失败: Supervisor 陷入循环 (manifest 调用 ${manifestCount} 次)`);
      } else {
        console.log(`  ⚠️ 场景未完全通过: status=${status}, 管道可能不完整`);
      }

      // P1-14: 保存完整 artifact（审计要求保存 Draft、Candidates、Evidence、Quality Report、fallback events）
      await saveArtifact(scenario.name, runId, {
        scenario: scenario.name,
        runId,
        status,
        runView: {
          status: currentRun.status,
          engineMode: currentRun.engineMode,
          shellStage: currentRun.shellStage,
          coverageReport: currentRun.coverageReport,
          providerCapabilityFingerprint: currentRun.providerCapabilityFingerprint,
          result: currentRun.result,
          error: currentRun.error,
        },
        events: allEvents.map(e => ({
          turnNo: e.turnNo,
          agentRole: e.agentRole,
          toolName: e.toolName,
          eventType: e.eventType ?? e.type,
          autoGenerated: e.safePayload?.autoGenerated ?? false,
          autoCompleted: e.safePayload?.autoCompleted ?? false,
        })),
        cards: cards.map(c => ({
          cardId: c.cardId,
          title: c.title,
          summary: c.summary,
          scope: c.scope,
          keyPoints: c.keyPoints,
        })),
        evidence: evidenceResult,
        hardGates: {
          noAutoFallback,
          hasCriticVerdict,
          hasVerifyStep,
          hasCards,
          noTitleSummaryIdentical,
          noUntitled,
          noTruncated,
          hasRealProvider,
          coverageComplete,
          noUnalignedEvidence,
          noAutoVerified,
          allCardsHaveAlignedEvidence,
          hardGatesPassed,
          overallPassed,
        },
        toolCounts,
        manifestCount,
        duration: (Date.now() - startTime) / 1000,
      });

      return {
        scenario: scenario.name,
        status,
        passed: overallPassed,
        noLoop,
        pipelineComplete,
        cardCount: cards.length,
        eventCount: events.length,
        duration: (Date.now() - startTime) / 1000,
        manifestCount,
        hasDelegate,
        hasDeckDraft,
        hasCritic,
        hasVerify,
        hasExtractorRecord,
        hasCriticReport,
        hasAutoFallback,
        // P1-14: 新增硬门禁指标
        hardGatesPassed,
        noAutoFallback,
        noTitleSummaryIdentical,
        noUntitled,
        noTruncated,
        // P1-14: 新增证据对齐指标
        noUnalignedEvidence,
        noAutoVerified,
        allCardsHaveAlignedEvidence,
        evidenceTotal: evidenceResult.totalEvidence,
        evidenceAligned: evidenceResult.alignedCount,
        evidenceUnaligned: evidenceResult.unalignedCount,
      };
    }

    // 每 3 秒轮询一次
    await new Promise(r => setTimeout(r, 3000));
  }

  // 超时
  console.log(`\n  ⏱️ 超时：Run 在 ${timeoutMs / 1000}s 内未到达终态`);
  let finalRun;
  try {
    finalRun = await getRun(auth.token, runId);
  } catch {
    finalRun = { status: "unknown" };
  }
  console.log(`     最终状态: ${finalRun.status}`);

  const events = await getRunEvents(auth.token, runId);
  const toolNames = events
    .filter(e => e.agentRole === "generation_supervisor" && e.eventType === "tool_result" && e.toolName)
    .map(e => e.toolName);
  const toolCounts = {};
  for (const name of toolNames) {
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;
  }
  console.log("  Supervisor 工具调用统计:");
  for (const [name, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
    const marker = name === "get_run_manifest" && count > 2 ? " ⚠️ 重复调用" : "";
    console.log(`     ${name}: ${count}${marker}`);
  }

  return {
    scenario: scenario.name,
    status: finalRun.status,
    passed: false,
    noLoop: (toolCounts["get_run_manifest"] ?? 0) <= 3,
    pipelineComplete: false,
    cardCount: 0,
    eventCount: events.length,
    duration: (Date.now() - startTime) / 1000,
    manifestCount: toolCounts["get_run_manifest"] ?? 0,
    hasDelegate: toolNames.includes("delegate_specialist"),
    hasDeckDraft: toolNames.includes("submit_deck_draft"),
    hasCritic: toolNames.includes("request_grounding_review"),
    hasVerify: toolNames.includes("request_verification"),
    hasExtractorRecord: false,
    hasCriticReport: false,
    hasAutoFallback: false,
    // P1-14: 证据对齐指标
    hardGatesPassed: false,
    noAutoFallback: true,
    noUnalignedEvidence: false,
    noAutoVerified: true,
    allCardsHaveAlignedEvidence: false,
    evidenceTotal: 0,
    evidenceAligned: 0,
    evidenceUnaligned: 0,
  };
}

// ─── 主逻辑 ───────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Supervisor Agent v1 综合端到端测试 ===");
  console.log(`测试场景数: ${TEST_SCENARIOS.length}`);
  console.log(`API: ${API_BASE}`);
  console.log();

  // 选择运行哪些场景
  const scenarioArg = process.argv[2];
  let scenarios;
  if (scenarioArg) {
    // 支持 "A" 或 "A,B" 或 "1,2" 格式
    const indices = scenarioArg.split(",").map(s => s.trim());
    scenarios = TEST_SCENARIOS.filter((_, i) => {
      const letter = String.fromCharCode(65 + i); // A, B, C, D
      return indices.includes(letter) || indices.includes(String(i + 1));
    });
    if (scenarios.length === 0) {
      console.log(`未找到匹配的场景: ${scenarioArg}`);
      console.log(`可用场景: A, B, C, D, E, F, G, H 或 1, 2, 3, 4, 5, 6, 7, 8`);
      process.exit(1);
    }
  } else {
    scenarios = TEST_SCENARIOS;
  }

  console.log(`将运行 ${scenarios.length} 个场景\n`);

  // 登录
  console.log("登录...");
  const auth = await login();
  console.log(`  userId: ${auth.userId}`);
  console.log(`  workspaceId: ${auth.workspaceId}\n`);

  // 运行场景
  const results = [];
  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    try {
      const result = await runScenario(auth, scenario, i);
      results.push(result);
    } catch (err) {
      console.error(`\n  ❌ 场景 ${scenario.name} 异常: ${err.message}`);
      results.push({
        scenario: scenario.name,
        status: "error",
        passed: false,
        noLoop: false,
        pipelineComplete: false,
        cardCount: 0,
        eventCount: 0,
        duration: 0,
        manifestCount: 0,
        hasDelegate: false,
        hasDeckDraft: false,
        hasCritic: false,
        hasVerify: false,
        hasExtractorRecord: false,
        hasCriticReport: false,
        hasAutoFallback: false,
        // P1-14: 证据对齐指标
        hardGatesPassed: false,
        noAutoFallback: true,
        noUnalignedEvidence: false,
        noAutoVerified: true,
        allCardsHaveAlignedEvidence: false,
        evidenceTotal: 0,
        evidenceAligned: 0,
        evidenceUnaligned: 0,
      });
    }

    // 场景间隔 5 秒，避免资源竞争
    if (i < scenarios.length - 1) {
      console.log("\n  场景间等待 5 秒...");
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // 汇总报告
  console.log("\n\n" + "=".repeat(60));
  console.log("=== 综合测试报告 ===");
  console.log("=".repeat(60));

  const summary = results.map(r => ({
    场景: r.scenario,
    状态: r.status,
    通过: r.passed ? "✅" : "❌",
    硬门禁: r.hardGatesPassed ? "✅" : "❌",
    无循环: r.noLoop ? "✅" : "❌",
    管道完整: r.pipelineComplete ? "✅" : "❌",
    卡片数: r.cardCount,
    证据总数: r.evidenceTotal ?? 0,
    对齐: r.evidenceAligned ?? 0,
    未对齐: r.evidenceUnaligned ?? 0,
    自动验证: r.noAutoVerified ? "—" : "⚠️",
    耗时s: r.duration.toFixed(1),
    Critic报告: r.hasCriticReport ? "✅" : "❌",
    自动回退: r.hasAutoFallback ? "⚠️" : "—",
  }));

  console.table(summary);

  const passedCount = results.filter(r => r.passed).length;
  const noLoopCount = results.filter(r => r.noLoop).length;
  const pipelineCount = results.filter(r => r.pipelineComplete).length;

  console.log(`\n通过: ${passedCount}/${results.length}`);
  console.log(`无循环: ${noLoopCount}/${results.length}`);
  console.log(`管道完整: ${pipelineCount}/${results.length}`);

  // P1-14 修复：移除 Fail-Open 退出路径。
  // 原逻辑在"管道完整但硬门禁未通过"时仍 exit(0)，导致质量假象。
  // 现在：只有所有场景的 overallPassed（含硬门禁）全部通过才 exit(0)。
  const hardGatesPassedCount = results.filter(r => r.hardGatesPassed).length;

  console.log(`硬门禁通过: ${hardGatesPassedCount}/${results.length}`);

  if (passedCount === results.length) {
    console.log("\n✅ 全部场景通过（状态+硬门禁）！");
    process.exit(0);
  } else {
    console.log(`\n❌ 有场景未通过 (通过: ${passedCount}/${results.length}, 管道完整: ${pipelineCount}/${results.length}, 硬门禁: ${hardGatesPassedCount}/${results.length})`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("测试失败:", err);
  process.exit(1);
});
