/**
 * 方案 20 §23.1 — 语料扩充批次 A（2026-09-18）：**中长文本 / 多卡** 14 条。
 *
 * ## 为什么要扩
 * 上一轮质量验收把 validation + holdout 里的多卡样本也基本用完了（只剩 0–4 条），
 * 而多卡是最容易被"提速"改坏的一类（合并语义、卡数区间、跨卡泄漏）。本批次补充
 * 未见过的新样本，使"调参看 dev、验收看 validation+holdout"的纪律能继续执行。
 *
 * ## 标注口径（与既有批次一致）
 * - 卡数区间取"合格标注者都会同意"的宽度（3–5 这类），不是精确复刻某一次输出；
 * - `requiredLearningObjectives` 写**可判分的知识目标**，不写"读懂这段"这类无法判分的；
 * - `mustNotCard` 是"不该单独成卡"的内容（背景/铺垫/总述句）；
 * - `forbiddenFrontLeaks` 只写**判分依赖的关键术语或结论**，不写主题词
 *   （正面必须圈定主题，否则卡片无法定位）。
 *
 * ## 语料自洽：为什么这些笔记必须 >500 字
 * 本语料按长度自我定义（见 `corpus-validation.test.ts`）：≤500 字是 micro-note，
 * >500 字才是中长文本。而产品的 micro-note 策略是**硬上限 2 张卡**
 * （`MICRO_NOTE_MAX_CARDS`，planner 侧就截断并记账 `omit_over_budget`）。
 * 因此"micro 长度 + gold 3–5"是**自相矛盾**的标注：它测的不是卡片质量，而是一个
 * 结构上限，任何实现都必然不达标。本批次初稿正是踩了这个坑（350 字左右却标 3–5），
 * 已按语料自身的长度定义扩充为真正的中长笔记——**保留 gold 3–5，把内容补足**，
 * 而不是把 gold 改成 2 去迎合实现（那是"先有箭再画靶"）。
 */

import type { CardGenerationFixtureV2 } from "../fixture-schema.ts";

export const EXPANSION_V19_MEDIUM: CardGenerationFixtureV2[] = [
  {
    fixtureId: "medium-git-workflow-deep",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "Git 协作工作流",
      content: `主干开发与特性分支是两种常见的协作方式。主干开发要求所有改动频繁合入 main，靠特性开关控制可见性；特性分支则让每个需求在自己的分支上开发，合并前经过评审。\n\n变基与合并的区别在于历史形状：变基把当前分支的提交逐个复制到目标分支顶端，得到线性历史，但会重写提交哈希；合并产生一个合并提交，保留两条支线的真实拓扑。已经推送并被他人拉取的分支不要变基，否则他人的提交会被重写。\n\n冲突解决的本质是三方合并：Git 用共同祖先、当前分支、待合入分支三份内容计算差异。理解这一点就能解释为什么冲突标记里会同时出现两边的内容，而不只是"谁覆盖了谁"。\n\n提交粒度上，一个提交应该只做一件事，且能独立回滚。把重构与行为变更放在同一个提交里，会让回滚时无法分离两者。

评审成本也随分支存活时间上升：分支开得越久，主干前进得越多，合并冲突与语义冲突（两边都改对了、但合起来不成立）的概率越高。控制分支存活时间比控制分支数量更有效。小步合并要求每次合并都是可发布的，因此特性开关是主干开发的前置条件：没有开关，未完成的功能就会随主干一起上线。开关本身也有代价——长期不清理的开关会让代码路径成倍增长，需要定期收敛。判断该用哪种方式可以先看发布节奏：一天多次发版、且每次都要能独立回滚，主干开发更合适；发版周期长、需求之间依赖重、评审需要整体看，特性分支更省事。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "git-workflow-compare", description: "对比主干开发与特性分支的协作方式差异", priority: "critical" },
      { id: "git-rebase-vs-merge", description: "说明变基与合并在历史形状与提交哈希上的区别", priority: "critical" },
      { id: "git-rebase-safety", description: "说出已推送分支为什么不应变基", priority: "important" },
      { id: "git-conflict-三方", description: "解释冲突的三方合并来源（共同祖先与两侧）", priority: "important" },
      { id: "git-commit-granularity", description: "说明提交粒度与可回滚性的关系", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["主干开发与特性分支是两种常见的协作方式"],
    acceptableTransformations: ["contrast", "mechanism", "boundary"],
    forbiddenFrontLeaks: ["提交哈希", "共同祖先"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-db-lock-deep",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "数据库锁与隔离",
      content: `行锁在事务提交或回滚时释放，这是最基本的约定。但在可重复读隔离级别下，范围查询会加间隙锁，锁住的不只是命中的行，还包括行与行之间的空隙，目的是阻止其他事务在范围内插入新行。\n\n死锁的产生需要两个事务各持有一把锁并互相等待对方释放。数据库的通常做法是检测等待图中的环，选中一个事务回滚来打破循环，被回滚的事务会收到死锁错误。因此应用层必须准备重试逻辑。\n\n锁等待超时与死锁不同：超时是等不到锁主动放弃，往往意味着某个事务持有锁太久；死锁是循环等待，与持有时长无关。排查时前者看慢事务，后者看加锁顺序。\n\n减少死锁的常用手段是统一加锁顺序：让所有事务按同一顺序访问多张表或多行，循环等待就无法形成。

持有锁的时间同样关键：事务里做远程调用或等待用户输入，会把锁持有时间从毫秒级拉到秒级，锁等待随之扩散。正确做法是把这类操作移到事务之外，先在事务里做完数据变更再发起外部调用。

乐观锁是另一条路线：不加锁，读取时记下版本，写入时用版本号做条件更新，冲突则重试。它适合冲突概率低的场景，省掉了加锁开销；冲突频繁时重试成本会超过加锁成本，此时悲观锁更划算。无论走哪条路线，都要能观测到锁的表现：等待时长、超时次数与死锁次数是三个最该被监控的指标，它们上升往往早于用户可感知的故障。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "db-gap-lock", description: "说明间隙锁锁住什么以及它阻止的操作", priority: "critical" },
      { id: "db-deadlock-detect", description: "说明数据库如何检测并打破死锁循环", priority: "critical" },
      { id: "db-timeout-vs-deadlock", description: "区分锁等待超时与死锁的成因", priority: "important" },
      { id: "db-lock-order", description: "说出统一加锁顺序为什么能减少死锁", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["行锁在事务提交或回滚时释放"],
    acceptableTransformations: ["mechanism", "contrast", "boundary"],
    forbiddenFrontLeaks: ["间隙锁", "等待图"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-http-cache-deep",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "HTTP 缓存",
      content: `强制缓存与协商缓存在行为上完全不同：强制缓存在有效期内直接用本地副本，根本不发请求；协商缓存每次都要问服务器，由服务器决定是 304 继续用副本还是返回新内容。\n\nCache-Control 的 max-age 表示副本在多少秒内新鲜，no-store 表示完全不缓存，no-cache 不是"不缓存"而是"每次都要验证"——这个名字是历史遗留，很容易记反。\n\nETag 与 Last-Modified 都是协商缓存的校验器。ETag 是内容指纹，精度更高；Last-Modified 只到秒，如果内容在一秒内多次变化就无法区分。两者同时存在时，服务器通常优先比较 ETag。\n\n验证失败返回 200 并带上新内容，验证成功返回 304 且不带正文，只带新的缓存头。分片缓存命中率低时，先检查是否因为 URL 带了频繁变化的查询参数导致键不稳定。

缓存可以分层存在：浏览器本地缓存、中间的共享缓存与源站缓存各自独立判断。共享缓存默认更容易被绕过，因为同一份响应要服务多个用户；带用户私有信息的响应必须显式声明只能被浏览器私有缓存，否则会被中间层错误复用。

Vary 头决定缓存的键除了 URL 还包括哪些请求头。按 Accept-Language 变体返回不同内容的接口如果不声明 Vary，中间层会把一种语言的结果发给请求另一种语言的用户——这是缓存最典型的正确性事故。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "http-cache-strong-vs-negotiated", description: "对比强制缓存与协商缓存是否发起请求", priority: "critical" },
      { id: "http-cache-control-semantics", description: "区分 no-store、no-cache 与 max-age 的含义", priority: "critical" },
      { id: "http-etag-vs-lastmodified", description: "说明 ETag 相对 Last-Modified 的精度优势", priority: "important" },
      { id: "http-304-response", description: "说明 304 与 200 在响应内容上的差别", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["强制缓存与协商缓存在行为上完全不同"],
    acceptableTransformations: ["contrast", "boundary", "mechanism"],
    forbiddenFrontLeaks: ["304", "ETag"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-distributed-consensus-deep",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "共识与复制",
      content: `共识协议解决的是多个节点对同一个值达成一致，并且这个一致结论在部分节点故障后仍然成立。多数派是常见实现基础：任何决议都要获得超过半数节点的同意，因此任意两个多数派必然相交，不会出现两个互相矛盾的决定同时成立。\n\n领导者选举把"谁来提议"这件事收敛到单个节点，避免提议冲突。任期号单调递增，节点只接受不比自己旧的任期；一旦发现更高任期，就立即降级为跟随者。这个单调性是安全性的关键。\n\n日志复制的前提是"领导者日志一定比跟随者完整"这条选举约束：候选人只有在自己日志足够新时才能赢得选举，从而保证已提交的日志不会被覆盖。\n\n网络分区时，少数派一侧无法凑齐多数派，因此无法产生新的提交，只能在分区恢复后由领导者补发缺失日志追平。这就是共识协议在网络不可靠时保安全、舍可用的取舍。

共识不是免费的：一次提交至少要一轮网络往返，跨地域部署时这轮往返就是几十毫秒。因此高吞吐系统常把共识用在"选主"与"配置变更"这类低频但要求强一致的操作上，数据面则改用副本复制。

读操作也有一致性分档：线性一致读要走一次共识或读主，延迟高但不会读到旧值；最终一致读可以从任意副本读，延迟低但可能读到尚未追平的旧值。选择取决于业务能否容忍读到旧值——余额不能，点赞数可以。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "consensus-majority-intersect", description: "解释多数派为什么保证不会出现互相矛盾的决定", priority: "critical" },
      { id: "consensus-term-monotonic", description: "说明任期号单调递增与节点降级规则", priority: "important" },
      { id: "consensus-election-log-constraint", description: "说明选举对日志新旧的约束及其作用", priority: "critical" },
      { id: "consensus-partition-tradeoff", description: "说明网络分区时少数派的行为与整体取舍", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["共识协议解决的是多个节点对同一个值达成一致"],
    acceptableTransformations: ["mechanism", "boundary", "contrast"],
    forbiddenFrontLeaks: ["多数派", "任期"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-frontend-bundle-deep",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "前端构建产物优化",
      content: `代码分割把产物拆成多个入口，让首屏不必下载全部代码。路由级分割是最容易见效的一刀：每个页面一个 chunk，用户只下载当前路径需要的部分。\n\nTree shaking 依赖静态结构：只有 ES 模块的具名导入才能被安全摇掉，CommonJS 的动态 require 无法在构建期确定，通常整包保留。这就是"同一个库换一种引入方式体积差很多"的原因。\n\n副作用标记是 Tree shaking 的另一半：如果包声明了 sideEffects，构建工具才敢删除未被引用的模块；否则即使某个模块的导出没人用，也可能因为"它可能有副作用"而保留。\n\n预加载策略上，preload 用于当前页面马上要用的资源，prefetch 用于将来可能用到的资源。把首屏关键资源标成 prefetch 会降低优先级，反而拖慢首屏。\n\n体积分析应从依赖树入手而不是只盯总量：先定位最大的依赖，再判断它是构建期依赖还是运行时依赖，最后才考虑替换。

产物文件名应该带内容哈希：内容不变则文件名不变，因此可以设置很长的强缓存；内容一变文件名就变，天然绕过缓存。用固定文件名配短缓存会让每次发版都产生一轮全量回源。

懒加载还要配合加载态与错误边界，否则网络慢时用户看到的是空白，加载失败时整页崩掉。分割粒度也不是越细越好——每个 chunk 都有一次请求开销，切得过碎会把一次大请求变成几十次小请求。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "bundle-code-splitting", description: "说明代码分割与按路由分割的作用", priority: "critical" },
      { id: "bundle-treeshaking-condition", description: "说明 Tree shaking 为什么依赖 ES 模块与副作用标记", priority: "critical" },
      { id: "bundle-preload-vs-prefetch", description: "区分 preload 与 prefetch 的适用场景", priority: "important" },
      { id: "bundle-analysis-order", description: "说明体积分析的排查顺序", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["代码分割把产物拆成多个入口"],
    acceptableTransformations: ["mechanism", "contrast", "procedure"],
    forbiddenFrontLeaks: ["Tree shaking", "sideEffects"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-observability-trace-deep",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "分布式追踪",
      content: `追踪的基本单位是 span，一次请求链路由若干 span 组成树形结构，每个 span 记录开始结束时间与操作名。Trace ID 在整个链路中保持不变，Span ID 标识当前节点，父子关系由 Parent Span ID 表达。\n\n采样决定哪些链路被完整记录。头部采样在请求入口就决定，成本可控但可能漏掉慢请求；尾部采样在链路结束后依据耗时或错误决定保留，能留住异常样本，代价是每个服务都要先缓存数据。\n\n上下文传播是追踪能否连起来的关键：跨进程时必须把 Trace 上下文放进请求头随调用传递，跨线程时要用上下文对象而不是线程局部变量，否则异步分支会丢上下文，链路断成两截。\n\n排查时先看最慢的 span 是不是自身耗时还是等待下游：自身耗时高说明该服务内部有问题，等待下游高则要继续往下钻。仅看总时长无法区分这两种情况。

采样率需要按流量分级：高流量接口可以只采 1% 也能拿到足够样本，低流量关键接口应当全采，否则出错时恰好没采到。动态调高采样率是排障时的常用手段，但要有上限，避免故障期间把存储打满。

排查时把 trace 与日志、指标对齐：trace 给出这次调用慢在哪一跳，日志给出那一跳内部的细节，指标给出这种情况影响的请求比例。三者缺一，结论就只覆盖单次请求，无法判断是普遍问题还是个案。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "trace-span-structure", description: "说明 Trace ID、Span ID 与父子关系的作用", priority: "critical" },
      { id: "trace-head-vs-tail-sampling", description: "对比头部采样与尾部采样的取舍", priority: "important" },
      { id: "trace-context-propagation", description: "说明跨进程与跨线程为什么容易丢上下文", priority: "critical" },
      { id: "trace-latency-diagnosis", description: "说明如何区分自身耗时与等待下游", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["追踪的基本单位是 span"],
    acceptableTransformations: ["mechanism", "contrast", "application"],
    forbiddenFrontLeaks: ["尾部采样", "Parent Span ID"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-k8s-probe-deep",
    language: "zh",
    modality: "text",
    split: "holdout",
    source: {
      title: "Kubernetes 探针与调度",
      content: `存活探针与就绪探针的后果不同：存活探针失败会重启容器，就绪探针失败只是把 Pod 从 Service 后端摘掉，不重启。把启动慢的应用配成存活探针，会在启动阶段被反复重启，正确做法是配置启动探针或用更长的 initialDelaySeconds。\n\n资源请求与限制在调度中角色不同：requests 参与调度决策，决定 Pod 能落在哪个节点；limits 是运行时的上限，超过内存限制会被杀掉，超过 CPU 限制则被限流。requests 与 limits 差距过大，会让节点超卖，故障时互相影响。\n\n服务质量等级由 requests/limits 的设置方式决定：两者相等且都设置是最高的保证等级，完全不设置是最低等级，最先被驱逐。\n\n优雅退出依赖两个动作配合：容器收到终止信号后开始收尾，同时从 Service 摘除；如果摘除与收尾之间存在时间差，就会出现请求打到正在关闭的实例。preStop 钩子正是用来填补这段时间。

探针参数比探针类型更容易配错：探测周期太短会放大瞬时抖动，失败阈值太低会把偶发超时当成故障，超时时间设得比探测周期还长则会让探测排队、结论失真。三个参数要一起看，单独调某一个通常只是把问题挪个地方。

就绪探针还要覆盖"依赖尚未就绪"这类情况：应用进程活着但数据库连接池还没建好时，应当报告未就绪而不是急着接流量。把依赖检查塞进存活探针是常见误用——数据库抖动会引起整批 Pod 重启，把小故障放大成大故障。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "k8s-liveness-vs-readiness", description: "区分存活探针与就绪探针失败后的后果", priority: "critical" },
      { id: "k8s-requests-vs-limits", description: "说明 requests 与 limits 在调度和运行时的作用差异", priority: "critical" },
      { id: "k8s-qos-class", description: "说明服务质量等级由什么决定以及谁先被驱逐", priority: "important" },
      { id: "k8s-graceful-shutdown", description: "解释优雅退出为什么需要 preStop 配合", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["存活探针与就绪探针的后果不同"],
    acceptableTransformations: ["contrast", "mechanism", "boundary"],
    forbiddenFrontLeaks: ["存活探针", "requests"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-auth-session-deep",
    language: "zh",
    modality: "text",
    split: "holdout",
    source: {
      title: "会话与令牌",
      content: `基于服务端会话的认证把状态放在服务端：浏览器只拿一个不透明会话 ID，服务端查表得到用户身份。优点是吊销即时生效，缺点是服务端要有共享存储，否则多实例之间无法识别彼此的会话。\n\n基于令牌的认证把身份与签名放在令牌里，服务端验签即可，天然无状态、易横向扩展。代价是吊销困难：令牌在过期前一直有效，要做到即时吊销就必须引入黑名单，又把状态加回来了。\n\n刷新的常见做法是短有效期访问令牌配长有效期刷新令牌。刷新令牌一旦泄露危害更大，因此要绑定设备、允许单次使用并检测重复使用——同一刷新令牌被用两次，通常意味着已经泄露，应当整条会话失效。\n\nCSRF 与会话认证的关系：会话依赖浏览器自动携带 Cookie，因此需要 CSRF 防护；令牌放在请求头里手动携带时不受 CSRF 影响，但更容易被 XSS 窃取。这是两种方案风险面的差别，而不是谁绝对更安全。

令牌的存放位置决定了它的暴露途径：存在可被脚本读取的存储里，任何一次 XSS 都能直接取走令牌；存在仅随请求自动携带、脚本不可读的位置，XSS 仍然可以冒用请求，但无法把令牌带走长期使用。两种选择都不消除 XSS 的危害，只是改变了危害的持续时间。

过期与续期策略要成对设计：访问令牌短到分钟级可以限制泄露窗口，但会放大刷新频率，因此需要把刷新做成并发安全的一次性操作，避免同一时刻多个请求各自触发刷新、把一次性刷新令牌用废。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "auth-session-vs-token", description: "对比服务端会话与令牌在状态存放与扩展性上的差异", priority: "critical" },
      { id: "auth-revocation-difficulty", description: "说明令牌吊销为什么需要额外机制", priority: "critical" },
      { id: "auth-refresh-token-safety", description: "说明刷新令牌的单次使用与重复使用检测", priority: "important" },
      { id: "auth-csrf-xss-tradeoff", description: "说明两种方案在 CSRF 与 XSS 风险上的差别", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["基于服务端会话的认证把状态放在服务端"],
    acceptableTransformations: ["contrast", "boundary", "mechanism"],
    forbiddenFrontLeaks: ["刷新令牌", "CSRF"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-stream-processing-deep",
    language: "zh",
    modality: "text",
    split: "holdout",
    source: {
      title: "流式处理语义",
      content: `流处理要回答三个问题：事件时间还是处理时间、窗口怎么切、结果什么时候算最终。\n\n事件时间是事件真正发生的时间，处理时间是系统收到它的时间。两者在网络延迟或重放场景下会差很多，按处理时间聚合会得到和真实业务不一致的结果。\n\n水位线用来表达"我认为某时刻之前的事件都到齐了"。它是对延迟的假设，不是精确断言：水位线设得保守，结果准确但延迟高；设得激进，结果出得快但可能漏算晚到事件。\n\n迟到事件的处理策略决定语义强弱：直接丢弃是最省事的近似；允许重算并覆盖结果叫至少一次，可能重复；只有在重算时能覆盖旧结果、对外表现为单一答案才叫恰好一次。恰好一次说的是结果语义，不是"事件只处理一次"。\n\n会话窗口按活跃间隔切分而不是固定长度，适合用户行为分析这类间隔不规则的场景。

有状态算子需要状态后端配合：计数、去重、连接这类算子必须在故障恢复后还能接上，因此要把状态周期性做检查点。检查点间隔越短，恢复后重放的数据越少、恢复越快，但运行时开销越大。无状态算子不需要这一层，这也是尽量把逻辑写成无状态的原因。

乱序是常态而不是异常：同一个用户的两条事件可能因为不同分区、不同网络路径而乱序到达。按事件时间处理并允许水位线等待，是用延迟换正确性的做法；完全不等待则会得到"先处理后发生的事件"这类反直觉结果。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "stream-event-vs-processing-time", description: "区分事件时间与处理时间以及混用的后果", priority: "critical" },
      { id: "stream-watermark-meaning", description: "说明水位线表达的含义与宽容度的取舍", priority: "critical" },
      { id: "stream-delivery-semantics", description: "说明至少一次与恰好一次在结果语义上的差别", priority: "important" },
      { id: "stream-session-window", description: "说明会话窗口的切分依据与适用场景", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["流处理要回答三个问题"],
    acceptableTransformations: ["contrast", "mechanism", "boundary"],
    forbiddenFrontLeaks: ["水位线", "恰好一次"],
    evidenceExpectations: [],
  },
  {
    // ID 与既有 dev 样本 `medium-test-pyramid-deep` 区分：那条是"测试金字塔深入笔记"
    // （六小节、gold 2–4），本条是另一篇关于测试分层取舍的短笔记（gold 3–5）。
    // 主题相邻但笔记不同，不构成"同一笔记的同义改写"，分属 validation/dev 是允许的。
    fixtureId: "medium-test-layers-deep",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "测试分层",
      content: `单元测试、集成测试与端到端测试的差别不只是范围，还有反馈速度与失败定位成本。单元测试毫秒级、失败直接指向一个函数；端到端测试分钟级、失败时要知道是环境、数据还是代码的问题。\n\n测试金字塔的用意不是"单元测试越多越好"，而是让反馈成本与失败定位成本最低的那一层承担最多的验证。反过来的冰淇淋甜筒（大量端到端、少量单元）会让每次失败都变成一次排查。\n\n测试替身有不同强度：桩提供预设返回值，验证的是被测对象在给定输入下的输出；mock 断言"某个调用发生过"，会把实现细节写进测试，重构时大面积失败。优先用桩，只有在"调用本身就是需求"时才用 mock。\n\n判定测试好坏的一个实用标准是：它对实现改动是否敏感、对行为改动是否敏感。好的测试只对后者敏感。

测试数据与隔离同样决定可维护性：共享一份长期存在的测试数据会让用例之间产生隐式依赖，改一处数据就崩一片。每个用例自建数据、用完清理（或包在事务里回滚）能让失败原因保持局部。

分层的比例也不是教条：组件边界清晰、契约稳定的系统可以把更多验证放在集成层；交互复杂、外部依赖多的系统需要更多端到端覆盖。关键是明确每一层负责回答什么问题，而不是记住一个固定配比。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "test-layer-tradeoff", description: "对比不同测试层级在反馈速度与失败定位上的差别", priority: "critical" },
      { id: "test-pyramid-purpose", description: "说明测试金字塔的用意与反模式的问题", priority: "critical" },
      { id: "test-stub-vs-mock", description: "区分桩与 mock 验证的内容及选用原则", priority: "important" },
      { id: "test-change-sensitivity", description: "说明好测试应对什么改动敏感", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["单元测试、集成测试与端到端测试的差别不只是范围"],
    acceptableTransformations: ["contrast", "boundary", "application"],
    forbiddenFrontLeaks: ["测试金字塔", "mock"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-rate-limit-deep",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "限流与熔断",
      content: `固定窗口计数最简单，但在窗口切换的瞬间可能放过接近两倍的流量：前一秒末尾和后一秒开头的突发叠加。滑动窗口用更细的粒度统计，代价是需要保存更多计数。\n\n令牌桶允许一定程度的突发：桶里积累的令牌可以一次性用掉，因此它限的是平均速率而不是瞬时速率。漏桶相反，以恒定速率放行，出流量平稳，突发会被排队或丢弃。选择哪一个取决于下游能接受突发还是需要平稳。\n\n熔断器有三个状态：关闭时正常放行，失败率超过阈值进入打开，直接快速失败不再调用下游；打开一段时间后进入半开，放少量请求试探，成功则恢复关闭，失败则继续保持打开。\n\n限流保护的是自己不被上游打垮，熔断保护的是自己不被下游拖垮，两者的保护对象不同。超时则是最后一道兜底：没有超时，被拖住的连接会耗尽资源，把局部故障放大成整体故障。

多实例部署下限流要考虑全局额度：每个实例各自限流会让总流量变成实例数倍的配额，因此要么集中计数，要么按实例数分摊配额并允许少量偏差。集中计数引入了一次远程调用，又需要给这次调用本身设超时与降级，否则限流器会成为新的故障点。

阈值不能凭感觉定：先从容量测试得到单实例能承受的请求量，再按"正常峰值的若干倍"留出余量。阈值设得比容量还高等于没有限流，设得太低则会在正常高峰误伤用户——两种错误都会让限流失去意义。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "ratelimit-fixed-window-flaw", description: "说明固定窗口在边界处的放量问题", priority: "important" },
      { id: "ratelimit-token-vs-leaky", description: "对比令牌桶与漏桶对突发的处理", priority: "critical" },
      { id: "ratelimit-circuit-states", description: "说明熔断器三个状态的迁移条件", priority: "critical" },
      { id: "ratelimit-protection-targets", description: "区分限流、熔断与超时各自保护的对象", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["固定窗口计数最简单"],
    acceptableTransformations: ["contrast", "mechanism", "boundary"],
    forbiddenFrontLeaks: ["令牌桶", "半开"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-log-design-deep",
    language: "zh",
    modality: "text",
    split: "holdout",
    source: {
      title: "日志设计",
      content: `日志级别不是严重程度排序，而是"谁该被叫起来"的排序：error 表示需要人介入，warn 表示系统自己处理了但值得关注，info 记录状态变化，debug 只在排查时打开。把可预期的业务失败记成 error，会让真正的问题淹没在噪声里。\n\n结构化日志把字段写成键值而不是拼进字符串。拼接字符串在检索时要靠正则匹配，字段化之后可以直接按 user_id 过滤，也能安全地聚合统计。\n\n每条日志都应带请求标识，让一次请求的多条日志能被串起来；跨服务时这个标识要随调用传递，否则分布式场景下无法关联。\n\n日志与指标的职责不同：指标是聚合后的数字，适合做告警与趋势；日志是离散事件，适合做归因。用日志做告警要么延迟高，要么成本高。\n\n敏感信息必须脱敏后再落盘，包括手机号、身份证、令牌与密码。脱敏要在写入点做，靠事后清理既不可靠也不合规。

日志量需要治理：同一条错误在高并发下会重复几十万次，把存储写满的同时也降低检索效率。常用做法是聚合相同的错误并计数，只保留首条与末条样本，同时把计数暴露成指标。

保留期与成本直接相关，但也受合规约束：安全审计类日志往往有最短保留期要求，而调试日志保留过久只会增加泄露面与成本。因此日志要按类别设置保留策略，而不是全局一个天数。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "log-level-semantics", description: "说明日志级别应按什么标准划分", priority: "critical" },
      { id: "log-structured-benefit", description: "说明结构化日志相比拼接字符串的优势", priority: "important" },
      { id: "log-request-correlation", description: "说明请求标识在跨服务关联中的作用", priority: "important" },
      { id: "log-vs-metric", description: "区分日志与指标各自适合的用途", priority: "critical" },
      { id: "log-redaction-point", description: "说明脱敏为什么必须在写入点完成", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["日志级别不是严重程度排序"],
    acceptableTransformations: ["contrast", "boundary", "application"],
    forbiddenFrontLeaks: ["结构化日志", "脱敏"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "medium-idempotency-deep",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "接口幂等",
      content: `幂等指同一个请求执行多次与执行一次的结果相同。HTTP 方法里 GET、PUT、DELETE 按语义是幂等的，POST 不是，所以支付、下单这类接口需要额外机制。\n\n最常用的做法是幂等键：客户端为一次业务操作生成唯一键，服务端把键与结果一起保存。相同键再次到达时直接返回上次结果，而不是重复执行。键必须由客户端生成，因为服务端无法区分"两次真实下单"与"一次下单重试"。\n\n保存键与结果的写入要和业务写入在同一个事务里，否则会出现"业务成功但键没记下"，重试时又执行一次。这是幂等实现里最容易漏的一环。\n\n幂等与去重不同：去重是对一段时间内的重复内容做归并，幂等是对同一个请求标识做结果复用。前者依赖内容相似度，后者依赖标识，可靠性不在一个量级。

幂等记录的存储要有唯一约束：靠"先查再写"在并发下不成立——两个请求可能同时查到"没记录"然后各写一次。用请求标识上的唯一索引让数据库来保证互斥，并发的第二个请求会因冲突失败，此时再读取已有结果返回。

幂等记录不能永久保留，否则存储会无限增长。保留期应当覆盖客户端的最长重试窗口：短于它，用户重试时会真的重复执行；长于它，只是多占空间。过期清理要按时间批量删除，不要在请求路径上做同步删除。`,
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "deep" },
    acceptableCardCountRange: { min: 3, max: 5 },
    requiredLearningObjectives: [
      { id: "idempotency-method-semantics", description: "说明哪些 HTTP 方法按语义幂等及原因", priority: "important" },
      { id: "idempotency-key-mechanism", description: "说明幂等键如何复用上次结果", priority: "critical" },
      { id: "idempotency-key-ownership", description: "说明幂等键为什么必须由客户端生成", priority: "important" },
      { id: "idempotency-transaction", description: "说明键与业务写入为什么必须同事务", priority: "critical" },
      { id: "idempotency-vs-dedup", description: "区分幂等与去重的依据", priority: "important" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["幂等指同一个请求执行多次与执行一次的结果相同"],
    acceptableTransformations: ["mechanism", "contrast", "application"],
    forbiddenFrontLeaks: ["幂等键", "同一个事务"],
    evidenceExpectations: [],
  },
];
