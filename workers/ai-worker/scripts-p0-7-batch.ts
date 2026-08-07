/**
 * P0-7 三假设实验批量采集(剩余项第 4 项)。
 *
 * 在本地 postgres + 真实 provider 上顺序跑 14 个补充分层样本(037-050),
 * 与既有 031-036 合计 ≥20 样本,产出延迟/成本/质量统计,支撑三假设验证与 SLO 草案。
 *
 * 用法:
 *   NODE_ENV=development DATABASE_URL_WORKER=... DATABASE_URL=... \
 *     node --import tsx workers/ai-worker/scripts-p0-7-batch.ts
 */

import postgres from "postgres";
import "./src/lib/ai-provider.ts";

const adminUrl = process.env.CARD_GENERATION_TEST_ADMIN_URL ?? process.env.DATABASE_URL;
if (!adminUrl) throw new Error("DATABASE_URL required");
const admin = postgres(adminUrl, { max: 4 });

const USER_ID = "10000000-0000-4000-8000-000000000042";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000042";

interface Sample {
  id: string;
  density: "overview" | "standard" | "complete";
  title: string;
  content: string;
}

const SAMPLES: Sample[] = [
  { id: "037", density: "overview", title: "微积分基础", content: [
    "极限是微积分的基石，描述函数在自变量趋近某值时因变量的变化趋势。",
    "导数衡量函数在某点的瞬时变化率，几何意义是切线的斜率。",
    "微分法则包括乘积法则、商法则和链式法则，链式法则用于复合函数求导。",
    "不定积分是导数的逆运算，定积分计算曲线与坐标轴围成的面积。",
    "微积分基本定理建立了微分与积分之间的联系，是微积分的核心定理。",
    "洛必达法则用于求解 0/0 或无穷大/无穷大型的不定式极限。",
  ].join("\n") },
  { id: "038", density: "standard", title: "化学反应原理", content: [
    "化学反应遵循质量守恒定律，反应前后原子种类和数目不变。",
    "化学平衡是正逆反应速率相等时的动态平衡状态，可用平衡常数 K 描述。",
    "勒夏特列原理指出，改变条件时平衡向减弱该改变的方向移动。",
    "活化能是反应物分子达到活化状态所需的最低能量，决定反应速率。",
    "催化剂通过降低活化能加快反应速率，但自身不参与最终产物。",
    "酸碱中和反应中，pH 值反映溶液氢离子浓度，pH 越低酸性越强。",
    "氧化还原反应伴随电子转移，氧化剂被还原，还原剂被氧化。",
  ].join("\n") },
  { id: "039", density: "overview", title: "细胞生物学", content: [
    "细胞是生命活动的基本单位，原核细胞无细胞核，真核细胞有细胞核。",
    "细胞膜由磷脂双分子层和蛋白质组成，具有选择透过性。",
    "线粒体是有氧呼吸的主要场所，被称为细胞的能量工厂。",
    "细胞周期包括间期和分裂期，间期进行 DNA 复制和蛋白质合成。",
    "有丝分裂保证遗传物质平均分配，产生两个遗传相同的子细胞。",
    "细胞分化是基因选择性表达的结果，使细胞形态功能特化。",
  ].join("\n") },
  { id: "040", density: "standard", title: "第一次工业革命", content: [
    "第一次工业革命始于 18 世纪下半叶的英国，以蒸汽动力为核心。",
    "珍妮纺纱机提高了纺织效率，是工业革命的早期标志性发明。",
    "瓦特改良的蒸汽机为工厂提供稳定动力，推动交通运输业发展。",
    "铁路与轮船的出现大幅降低运输成本，加速商品流通与市场形成。",
    "工业革命带来城市化进程加快，同时也产生环境污染和劳资矛盾。",
    "工厂制度取代手工工场，确立资本主义生产方式的统治地位。",
  ].join("\n") },
  { id: "041", density: "complete", title: "电磁学", content: [
    "库仑定律描述点电荷间的静电力与电荷量乘积成正比，与距离平方成反比。",
    "电场线从正电荷出发指向负电荷，电场强度反映电场的强弱和方向。",
    "电势是标量，两点间电势差等于单位电荷移动时电场力做的功。",
    "欧姆定律表明通过导体的电流与两端电压成正比，与电阻成反比。",
    "安培定律描述电流产生磁场的规律，右手定则判断磁场方向。",
    "电磁感应定律指出磁通量变化时导体中产生感应电动势，法拉第实验证明磁能生电。",
    "楞次定律判断感应电流方向：感应电流总是阻碍引起它的磁通量变化。",
    "麦克斯韦方程组统一了电、磁和光，预言电磁波的存在。",
    "交流电通过变压器改变电压，实现电力的远距离高效传输。",
  ].join("\n") },
  { id: "042", density: "overview", title: "经济学基础", content: [
    "需求定理表明价格上升时需求量下降，价格与需求量呈反向变动。",
    "供给曲线向右上方倾斜，表示价格上升时生产者愿意供给更多。",
    "市场均衡是需求与供给相等的价格，此时无超额需求或超额供给。",
    "机会成本是选择一项决策时放弃的其他选择的最高价值。",
    "弹性衡量变量对价格变化的反应程度，需求价格弹性影响收益。",
    "市场失灵包括外部性、公共物品和信息不对称等情形。",
  ].join("\n") },
  { id: "043", density: "standard", title: "文学修辞手法", content: [
    "比喻是根据事物相似性，用一事物说明另一事物的修辞手法。",
    "拟人赋予非人事物以人的动作、情感和品格，增强表达感染力。",
    "排比是三个或以上结构相似、内容相关的语句连续排列。",
    "对偶要求字数相等、结构相同、意义相关的两个语句成对出现。",
    "夸张是故意放大或缩小事物特征，突出强调表达效果。",
    "反问以疑问形式表达肯定或否定判断，加强语气。",
    "借代不直接说出事物名称，而用相关事物代替，如用'红领巾'代少先队员。",
  ].join("\n") },
  { id: "044", density: "complete", title: "板块构造学说", content: [
    "板块构造学说认为岩石圈分为六大板块，漂浮在软流圈之上缓慢移动。",
    "板块交界处是地壳活跃地带，地震和火山多集中于此。",
    "碰撞带中大陆板块相互挤压，形成褶皱山脉，如喜马拉雅山脉。",
    "张裂带中板块相互分离，形成裂谷和海洋，如东非大裂谷。",
    "海底扩张说认为大洋中脊岩浆上涌，推动洋底向两侧扩张。",
    "转换断层处板块水平错动，不产生消亡或新生地壳。",
    "板块运动由地幔对流驱动，是地球内部热能的释放过程。",
    "地震波传播速度突变揭示地球内部圈层结构，支持板块理论。",
  ].join("\n") },
  { id: "045", density: "overview", title: "免疫系统", content: [
    "免疫系统由免疫器官、免疫细胞和免疫分子组成，识别并清除病原体。",
    "非特异性免疫是第一道防线，包括皮肤屏障和吞噬细胞。",
    "特异性免疫通过淋巴细胞识别特定抗原，产生免疫记忆。",
    "B 细胞产生抗体中和病原体，T 细胞直接攻击被感染的细胞。",
    "疫苗通过注入灭活或减毒病原体，诱导机体产生免疫记忆。",
    "自身免疫病是免疫系统错误攻击自身组织导致的疾病。",
  ].join("\n") },
  { id: "046", density: "standard", title: "认识论哲学", content: [
    "认识论研究知识的来源、本质、范围与确证方式。",
    "经验主义主张一切知识源于感官经验，洛克提出白板说。",
    "理性主义认为理性推理是可靠知识的来源，笛卡尔以'我思故我在'为起点。",
    "怀疑论质疑知识的可能性，认为任何信念都缺乏确定依据。",
    "康德综合两者，认为知识由感性直观与知性范畴共同构成。",
    "实用主义以行动后果检验信念真理性，詹姆斯是其代表。",
    "知识的可靠性问题涉及基础主义与融贯主义之争。",
  ].join("\n") },
  { id: "047", density: "complete", title: "软件设计原则", content: [
    "单一职责原则要求一个类只有一个变更理由，职责分离降低耦合。",
    "开闭原则主张对扩展开放、对修改关闭，通过抽象实现行为扩展。",
    "里氏替换原则规定子类必须能替换父类而不破坏程序正确性。",
    "接口隔离原则要求客户端不应依赖其不需要的接口方法。",
    "依赖倒置原则让高层模块依赖抽象而非具体实现。",
    "依赖注入通过外部传入依赖对象，解耦模块间的直接创建关系。",
    "领域驱动设计强调以业务领域为核心建模，区分实体与值对象。",
    "测试驱动开发先写失败测试再实现，保证代码可验证性。",
    "微服务架构将系统拆分为独立部署的小服务，各自拥有数据存储。",
  ].join("\n") },
  { id: "048", density: "overview", title: "绘画构图原理", content: [
    "三分法则将画面纵横分为九格，把主体放在交叉点增强平衡感。",
    "黄金比例约 1:1.618，在古典绘画中用于确定画面分割位置。",
    "对称构图给人稳定庄严感，非对称构图更具动态张力。",
    "引导线利用道路、河流等线条引导视线聚焦主体。",
    "留白给予画面呼吸空间，突出主体并营造意境。",
    "色彩冷暖对比能强化空间层次与情绪表达。",
  ].join("\n") },
  { id: "049", density: "standard", title: "合同法基础", content: [
    "合同是平等主体之间设立、变更、终止民事权利义务的协议。",
    "合同成立需要要约与承诺两个意思表示一致。",
    "合同生效要件包括当事人具有行为能力、意思表示真实、内容合法。",
    "要约可以撤回，撤回通知须先于或同时到达受要约人。",
    "可撤销合同包括重大误解、欺诈、胁迫和显失公平情形。",
    "违约责任包括继续履行、赔偿损失和支付违约金。",
    "情势变更原则允许合同履行显失公平时变更或解除合同。",
  ].join("\n") },
  { id: "050", density: "complete", title: "恒星演化", content: [
    "恒星由星际气体和尘埃在引力坍缩下形成，主序阶段由氢聚变维持。",
    "恒星质量决定其寿命：质量越大，燃烧越快，寿命越短。",
    "红巨星阶段氢耗尽后，核心收缩升温，外壳膨胀变冷变红。",
    "白矮星是低质量恒星的最终归宿，由电子简并压支撑。",
    "中子星由超新星爆炸后的核心坍缩形成，密度极高。",
    "超新星爆发是恒星生命末期剧烈的能量释放，抛射重元素。",
    "黑洞是质量超过奥本海默极限的恒星坍缩形成，引力场极强。",
    "赫罗图以光度为纵轴、温度为横轴，描绘恒星演化轨迹。",
    "恒星的金属丰度影响行星形成，第一代恒星几乎不含重元素。",
  ].join("\n") },
];

async function seedSample(s: Sample): Promise<{ runId: string; versionId: string }> {
  const runId = `50000000-0000-4000-8000-0000000000${s.id}`;
  const noteId = `30000000-0000-4000-8000-0000000000${s.id}`;
  const versionId = `40000000-0000-4000-8000-0000000000${s.id}`;
  await admin.begin(async (tx) => {
    await tx`DELETE FROM jobs WHERE generation_run_id = ${runId}`;
    await tx`DELETE FROM card_generation_runs WHERE id = ${runId}`;
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'p07-batch@example.invalid', 'unused') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'P0-7 batch', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${noteId}, ${WORKSPACE_ID}, ${s.title}, ${USER_ID}, 1)
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${noteId}, ${WORKSPACE_ID}, 1,
        ${tx.json({ blocks: s.content.split("\n").map((line, i) => ({ id: `blk-${s.id}-${i}`, ordinal: i, type: "paragraph", content: line })) })},
        ${`p07-${s.id}-hash`}, ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
      VALUES (${versionId}, ${WORKSPACE_ID}, 0, 'paragraph', ${s.content})
      ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO card_generation_runs (
        id, workspace_id, note_id, note_version_id, requested_by,
        request_idempotency_key, generation_fingerprint, generation_epoch,
        title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
        block_manifest, asset_manifest, status, stage, state_version,
        next_event_sequence, retryable, required_units, budget_snapshot
      ) VALUES (
        ${runId}, ${WORKSPACE_ID}, ${noteId}, ${versionId}, ${USER_ID},
        ${`p07-batch-${s.id}`}, ${`p07-fp-${s.id}`}, 1,
        ${s.title}, ${`p07-${s.id}-src`}, 'block-hash', 'asset-hash',
        '[]'::jsonb, '[]'::jsonb, 'queued', 'queued', 1, 1, true, 1,
        ${tx.json({
          roles: {},
          maxProviderCalls: 60,
          maxInputTokens: 2_000_000,
          maxOutputTokens: 500_000,
          maxEmbeddingTokens: 200_000,
          maxParallelTasks: 0,
          runDeadline: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
          costCap: 0,
        })}
      ) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO jobs (
        id, type, workspace_id, requested_by, payload, status,
        generation_run_id, generation_unit_id, stage, priority,
        attempts, max_attempts, available_after, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), 'execute_card_agent_turn', ${WORKSPACE_ID}, ${USER_ID},
        ${tx.json({ generationRunId: runId, agentUnitId: null, turnNo: 1 })},
        'pending', ${runId}, null, 'queued', 0, 0, 3, now(), now(), now()
      ) ON CONFLICT DO NOTHING`;
  });
  return { runId, versionId };
}

async function main(): Promise<void> {
  console.log(`P0-7 批量采集: ${SAMPLES.length} 个样本(037-050),启动 worker 顺序处理`);
  const seeded = [];
  for (const s of SAMPLES) {
    const r = await seedSample(s);
    seeded.push({ sampleId: s.id, density: s.density, title: s.title, ...r });
    console.log(`seeded ${s.id} (${s.density}) ${s.title}`);
  }

  // worker autostart(index.ts)会 claim 并处理全部 jobs;本脚本轮询完成
  // (worker 由外部启动:在 NODE_ENV=development 下 npm 启动 worker 或由调用方 import)
  const deadline = Date.now() + 25 * 60 * 1000;
  const results = [];
  while (Date.now() < deadline) {
    const done = await admin`SELECT r.id, r.status, r.execution_mode, r.usage_summary, r.error_code
      FROM card_generation_runs r WHERE r.id = ANY(${seeded.map((s) => s.runId)})`;
    const finished = done.filter((r) => ["succeeded", "failed", "needs_attention", "cancelled"].includes(r.status));
    if (finished.length === done.length) {
      console.log(`\n全部 ${done.length} 个样本完成:\n`);
      for (const r of done) {
        console.log(JSON.stringify({
          runId: r.id,
          status: r.status,
          executionMode: r.execution_mode,
          errorCode: r.error_code ?? null,
          usage: r.usage_summary,
        }));
      }
      await admin.end({ timeout: 5 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  console.error("超时:未全部完成");
  process.exitCode = 1;
  await admin.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  admin.end({ timeout: 5 }).catch(() => {});
});
