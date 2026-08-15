import { randomBytes } from "node:crypto";
import { and, desc, eq, asc, inArray, sql } from "drizzle-orm";
import { db, withSessionAdvisoryLock, withWorkspaceTransaction, SYSTEM_USER_ID } from "../../db/client.ts";
import { notes, noteVersions, noteBlocks } from "../../db/schema/note.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { evidences } from "../../db/schema/evidence.ts";
import { benchmarkLabels, benchmarkReports } from "../../db/schema/benchmark.ts";
import { upsertSearchDocument } from "../../lib/search-index.ts";
import { createCardGenerationRun } from "../card-generation/service.ts";
import { physicalDeleteNote, computeContentHash } from "../note/service.ts";

/**
 * 内置基准测试笔记（30 篇，覆盖技术、产品、学习、元数据干扰、
 * 长短文本以及中英混排）。
 */
export const BUILTIN_NOTES: Array<{
  file: string;
  title: string;
  blocks: Array<{ type: string; content: string }>;
}> = [
  {
    file: "note-01-distributed-system-cap",
    title: "分布式系统中的 CAP 定理",
    blocks: [
      { type: "heading", content: "分布式系统中的 CAP 定理" },
      { type: "paragraph", content: "CAP 定理是分布式系统设计中最基础的理论之一，由 Eric Brewer 在 2000 年提出。它指出，在一个分布式系统中，一致性（Consistency）、可用性（Availability）和分区容错性（Partition Tolerance）这三个属性不可能同时完全满足，最多只能选择其中两个。" },
      { type: "paragraph", content: "一致性指的是所有节点在同一时刻看到的数据是相同的。当数据被写入后，后续的读取操作必须返回最新写入的值。在强一致性模型下，如果某个节点还没有收到最新的写入，它必须拒绝读取请求，直到数据同步完成。" },
      { type: "paragraph", content: "可用性要求系统对外提供的每一个非故障节点都必须对每次请求返回非错误响应，但不保证返回的是最新数据。也就是说，系统不能因为某个节点正在同步数据就完全无法响应。" },
      { type: "paragraph", content: "分区容错性是指系统在网络分区发生时仍能继续运作。网络分区是指节点之间的网络通信中断，导致部分节点之间无法通信。在现实网络环境中，网络分区是不可避免的，因此大多数分布式系统都会选择保证 P，在 C 和 A 之间做取舍。" },
      { type: "paragraph", content: "在实践中，CP 系统选择一致性优先，例如 Zookeeper 和 etcd。当网络分区发生时，它们会拒绝部分写入请求以保证数据一致性。AP 系统选择可用性优先，例如 Cassandra 和 DynamoDB，它们允许在分区期间继续接受写入，但可能在分区恢复后需要进行冲突解决。" },
      { type: "paragraph", content: "需要注意的是，CAP 定理并不是说必须完全放弃一个属性，而是在分区发生时的取舍。当没有分区时，系统可以同时提供一致性和可用性。此外，一致性也有不同级别，从强一致性到最终一致性，系统可以根据场景选择合适的级别。" },
    ],
  },
  {
    file: "note-02-react-hooks-lifecycle",
    title: "React Hooks 与组件生命周期",
    blocks: [
      { type: "heading", content: "React Hooks 与组件生命周期" },
      { type: "paragraph", content: "React Hooks 是 React 16.8 引入的特性，允许在函数组件中使用状态和生命周期等特性。Hooks 的出现使得函数组件能够完全替代类组件，同时避免了类组件中 this 绑定、生命周期方法分散等问题。" },
      { type: "paragraph", content: "useState 是最基本的 Hook，用于在函数组件中声明状态。它返回一个数组，第一个元素是当前状态值，第二个元素是更新状态的函数。状态的更新是异步的，React 会将多次状态更新批处理以提升性能。如果新状态依赖于前一个状态，应该使用函数式更新：setCount(prev => prev + 1)。" },
      { type: "paragraph", content: "useEffect 是处理副作用的 Hook，可以看作是 componentDidMount、componentDidUpdate 和 componentWillUnmount 的组合。它接受两个参数：第一个是副作用函数，第二个是依赖数组。当依赖数组为空时，副作用函数只在组件挂载时执行一次。当依赖数组包含某些变量时，这些变量变化时会重新执行副作用函数。返回的清理函数会在组件卸载或下次副作用执行前调用。" },
      { type: "paragraph", content: "useMemo 和 useCallback 用于性能优化。useMemo 缓存计算结果，只有在依赖项变化时才重新计算。useCallback 缓存函数引用，避免因函数重新创建导致子组件不必要的重渲染。但过度使用这两个 Hook 反而会增加额外的开销，应该只用于确实存在性能问题的场景。" },
      { type: "paragraph", content: "自定义 Hook 是复用状态逻辑的重要手段。自定义 Hook 是一个以 use 开头的函数，内部可以调用其他 Hook。通过自定义 Hook，可以将组件中的状态逻辑提取出来，在不同组件间共享。自定义 Hook 不同于组件，它不需要返回 JSX，而是返回任意需要的值。" },
      { type: "paragraph", content: "使用 Hooks 时必须遵守两条规则：只在顶层调用 Hook，不要在循环、条件或嵌套函数中调用。这是因为 React 依赖 Hook 的调用顺序来关联状态，如果调用顺序变化会导致状态错乱。只在 React 函数组件或自定义 Hook 中调用 Hook，不要在普通函数中调用。" },
    ],
  },
  {
    file: "note-03-database-index-optimization",
    title: "数据库索引优化策略",
    blocks: [
      { type: "heading", content: "数据库索引优化策略" },
      { type: "paragraph", content: "数据库索引是提升查询性能的关键手段。索引本质上是一种数据结构，最常见的是 B+ 树索引，它通过维护有序的数据结构来加速查询。没有索引时，数据库需要全表扫描来查找匹配的行，时间复杂度为 O(n)。有了索引后，查询可以通过树的遍历完成，时间复杂度降低到 O(log n)。" },
      { type: "paragraph", content: "复合索引是包含多个列的索引。复合索引遵循最左前缀原则，即查询条件必须从索引的最左列开始才能使用索引。例如，对 (a, b, c) 创建复合索引，查询条件为 a 或 a AND b 或 a AND b AND c 时可以使用索引，但查询条件为 b 或 b AND c 时无法使用索引。" },
      { type: "paragraph", content: "覆盖索引是指查询所需的所有列都包含在索引中，数据库不需要回表读取数据行就能返回结果。覆盖索引可以显著减少 I/O 操作，特别是在大表上效果明显。在设计索引时，应尽量让常用查询能够使用覆盖索引。" },
      { type: "paragraph", content: "索引并非越多越好。每个索引都会占用存储空间，并且在写入操作（INSERT、UPDATE、DELETE）时需要同步更新索引，增加写入开销。因此，应该只为高频查询条件创建索引，避免为低频查询创建索引。同时，应定期使用 EXPLAIN 分析查询执行计划，确认索引是否被正确使用。" },
      { type: "paragraph", content: "在某些场景下，数据库优化器可能选择不使用索引而使用全表扫描。这种情况通常发生在表数据量很小、索引选择性别低（大量行匹配查询条件）或统计信息过期时。可以使用 ANALYZE 命令更新统计信息，帮助优化器做出更好的决策。" },
      { type: "paragraph", content: "部分索引（Partial Index）是只对满足条件的行创建索引。例如，只对状态为 active 的行创建索引。部分索引可以减少索引大小和维护开销，特别适合数据分布不均匀的场景。PostgreSQL 从 7.2 版本开始支持部分索引，使用 WHERE 子句定义索引条件。" },
    ],
  },
  {
    file: "note-04-typescript-generics",
    title: "TypeScript 泛型与类型约束",
    blocks: [
      { type: "heading", content: "TypeScript 泛型与类型约束" },
      { type: "paragraph", content: "泛型是 TypeScript 中实现代码复用和类型安全的核心机制。泛型允许在定义函数、接口或类时不预先指定具体类型，而是在使用时再指定。这样既能保证类型安全，又能避免代码重复。泛型最常见的应用场景是集合操作，例如数组的 map、filter、reduce 等方法。" },
      { type: "paragraph", content: "泛型约束（Constraints）使用 extends 关键字限制泛型参数的类型范围。例如 function getLength<T extends { length: number }>(arg: T) 限制 T 必须有 length 属性。约束使得泛型函数内部可以安全地访问约束类型的属性和方法，否则 TypeScript 无法确定泛型参数有哪些属性。" },
      { type: "paragraph", content: "条件类型是 TypeScript 2.8 引入的特性，允许根据泛型参数的类型关系选择不同的类型。条件类型的语法是 T extends U ? X : Y，表示如果 T 可以赋值给 U 则结果为 X，否则为 Y。条件类型常与 infer 关键字配合使用，从泛型参数中提取类型信息，例如提取函数的返回值类型或 Promise 的泛型参数。" },
      { type: "paragraph", content: "映射类型（Mapped Types）允许基于已有类型通过映射规则创建新类型。例如 Partial<T> 将 T 的所有属性变为可选，Readonly<T> 将所有属性变为只读。映射类型的语法是 { [K in keyof T]: NewType }，它会遍历 T 的所有键，对每个键的类型进行转换。" },
      { type: "paragraph", content: "泛型默认值允许在泛型参数未指定时使用默认类型。语法是 <T = string>，当调用时不传泛型参数则 T 为 string。泛型默认值在库的设计中特别有用，可以为常见场景提供合理的默认行为，同时保留灵活性让用户覆盖默认值。" },
    ],
  },
  {
    file: "note-05-nginx-reverse-proxy",
    title: "Nginx 反向代理与负载均衡配置",
    blocks: [
      { type: "heading", content: "Nginx 反向代理与负载均衡配置" },
      { type: "paragraph", content: "Nginx 是一款高性能的 HTTP 服务器和反向代理服务器。反向代理是指代理服务器接收客户端请求，然后将请求转发到后端服务器，再把后端服务器的响应返回给客户端。客户端不需要知道后端服务器的真实地址，这既提升了安全性，又为负载均衡提供了基础。" },
      { type: "paragraph", content: "Nginx 的负载均衡通过 upstream 模块实现。在 upstream 块中定义一组后端服务器，然后在 server 块或 location 块中使用 proxy_pass 指令将请求代理到 upstream。Nginx 默认使用轮询（Round Robin）策略，依次将请求分发到每个后端服务器。每个请求按时间顺序逐一分配到不同的后端服务器。" },
      { type: "paragraph", content: "除了轮询，Nginx 还支持加权轮询（weight）、IP 哈希（ip_hash）和最少连接（least_conn）等调度策略。加权轮询通过 weight 参数为不同服务器分配不同的权重，性能更强的服务器可以设置更高的权重。IP 哈希根据客户端 IP 计算哈希值，将同一 IP 的请求始终分配到同一服务器，实现会话保持。最少连接将请求分发到当前连接数最少的服务器。" },
      { type: "paragraph", content: "健康检查是负载均衡的重要组成部分。Nginx 开源版通过被动健康检查实现：当某个后端服务器返回错误时，Nginx 会暂时将其标记为不可用，在 max_fails 参数指定的时间内不再向其分发请求。fail_timeout 参数控制标记不可用的持续时间。Nginx Plus（商业版）支持主动健康检查，定期向后端发送健康检查请求。" },
      { type: "paragraph", content: "在配置反向代理时，需要注意请求头的传递。Nginx 默认不会将客户端的真实 IP 传递给后端服务器，后端看到的客户端 IP 是 Nginx 的 IP。通过设置 proxy_set_header X-Real-IP $remote_addr 和 proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for，可以将客户端真实 IP 传递给后端。" },
      { type: "paragraph", content: "WebSocket 支持需要额外配置。由于 WebSocket 使用 HTTP 升级机制，Nginx 需要在 location 块中设置 proxy_http_version 1.1，并通过 proxy_set_header Upgrade $http_upgrade 和 proxy_set_header Connection upgrade 将升级请求传递给后端服务器。同时应设置较长的 proxy_read_timeout 以适应 WebSocket 长连接的特性。" },
    ],
  },
  {
    file: "note-06-message-queue-reliability",
    title: "消息队列的可靠投递语义",
    blocks: [
      { type: "heading", content: "消息队列的可靠投递语义" },
      { type: "paragraph", content: "消息队列常见的投递语义包括 at most once、at least once 和 exactly once。at most once 允许消息丢失但不会重复，at least once 保证消息至少送达一次但可能重复，exactly once 需要生产、存储、消费和副作用共同配合才能成立。" },
      { type: "paragraph", content: "在大多数业务系统中，at least once 是更现实的默认选择。消费者必须具备幂等能力，例如使用业务唯一键、去重表或状态机版本号，确保重复消息不会造成重复扣款、重复发货或重复通知。" },
      { type: "paragraph", content: "确认机制决定消息是否会被重新投递。消费者应在业务处理成功后再 ack，如果处理过程中崩溃，队列可以把未确认消息重新投递。过早 ack 会把失败变成消息丢失，过晚 ack 会增加重复消费概率。" },
      { type: "paragraph", content: "死信队列用于承接多次重试仍失败的消息。进入死信队列不代表问题被解决，而是把自动重试转为人工排查或补偿任务。死信消息需要记录失败原因、重试次数和原始 payload。" },
      { type: "paragraph", content: "顺序消息通常以分区为单位保证顺序，而不是全局顺序。只要同一业务实体的消息使用同一个分区键，例如 orderId 或 accountId，就能在该实体范围内保持处理顺序。" },
    ],
  },
  {
    file: "note-07-redis-cache-invalidation",
    title: "Redis 缓存失效与一致性策略",
    blocks: [
      { type: "heading", content: "Redis 缓存失效与一致性策略" },
      { type: "paragraph", content: "缓存的核心收益是减少数据库读压力和降低响应延迟，但缓存引入了数据一致性问题。系统必须明确缓存是强一致读路径的一部分，还是允许短时间陈旧的性能优化层。" },
      { type: "paragraph", content: "Cache Aside 是最常见模式：读请求先查缓存，未命中再查数据库并回填缓存；写请求先更新数据库，再删除缓存。删除缓存通常比更新缓存更稳妥，因为缓存值可能由复杂查询或聚合计算得到。" },
      { type: "paragraph", content: "写后删除缓存仍可能出现短暂不一致。如果并发读在写入数据库前回填了旧值，写操作随后删除缓存可以清理旧值；如果删除发生在回填前，则旧值可能重新进入缓存。延迟双删可以降低这个窗口，但不能替代业务层容忍度设计。" },
      { type: "paragraph", content: "缓存穿透是指查询不存在的数据反复打到数据库。常见缓解方式包括缓存空值、布隆过滤器和请求参数校验。缓存空值要设置较短 TTL，避免真实数据创建后长期不可见。" },
      { type: "paragraph", content: "缓存雪崩通常由大量 key 同时过期引发。给 TTL 加随机抖动、对热点 key 做预热、使用多级缓存和限流降级，都可以减少雪崩时数据库被瞬间打满的风险。" },
    ],
  },
  {
    file: "note-08-oauth2-authorization-code",
    title: "OAuth 2.0 授权码流程",
    blocks: [
      { type: "heading", content: "OAuth 2.0 授权码流程" },
      { type: "paragraph", content: "OAuth 2.0 授权码流程用于让第三方应用在用户授权后访问受保护资源。它把用户认证交给授权服务器，把资源访问交给资源服务器，客户端最终拿到的是访问令牌而不是用户密码。" },
      { type: "paragraph", content: "授权码流程分两步获取令牌。第一步浏览器跳转到授权服务器，用户登录并授权后，授权服务器把 code 通过 redirect_uri 返回客户端。第二步客户端在后端用 code、client_id 和 client_secret 换取 access token。" },
      { type: "paragraph", content: "redirect_uri 必须严格匹配预注册地址，不能只校验域名或前缀。宽松匹配会让攻击者构造开放重定向，窃取授权码并换取令牌。" },
      { type: "paragraph", content: "PKCE 用 code_verifier 和 code_challenge 防止授权码被拦截后滥用。移动端和单页应用无法安全保存 client_secret，因此应该使用 PKCE 增强授权码流程。" },
      { type: "paragraph", content: "access token 通常生命周期较短，refresh token 用于换取新的 access token。refresh token 权限更高，应安全存储，并在轮换、撤销和异常检测上有更严格的策略。" },
    ],
  },
  {
    file: "note-09-vector-embeddings-rag",
    title: "向量嵌入与 RAG 检索增强生成",
    blocks: [
      { type: "heading", content: "向量嵌入与 RAG 检索增强生成" },
      { type: "paragraph", content: "向量嵌入把文本映射到高维向量空间，使语义相近的文本在距离上更接近。RAG 使用嵌入检索相关材料，再把检索结果作为上下文交给生成模型，以降低幻觉并提升领域知识覆盖。" },
      { type: "paragraph", content: "分块策略直接影响检索质量。块太短会丢失上下文，块太长会降低匹配精度并浪费上下文窗口。常见做法是按标题、段落或语义边界分块，并保留少量 overlap。" },
      { type: "paragraph", content: "召回阶段通常追求覆盖率，可以使用向量相似度、关键词检索或混合检索。排序阶段再使用 reranker 或规则权重提高精度，把最有证据价值的片段排在前面。" },
      { type: "paragraph", content: "RAG 不等于自动可信。系统需要在回答中保留引用、片段来源和命中分数，并在证据不足时明确拒答或降级，而不是让模型用猜测填补空白。" },
      { type: "paragraph", content: "评估 RAG 应同时看检索指标和回答指标。检索侧关注 recall、MRR 和 nDCG，回答侧关注事实一致性、引用准确率和用户任务完成率。" },
    ],
  },
  {
    file: "note-10-event-sourcing-cqrs",
    title: "Event Sourcing 与 CQRS",
    blocks: [
      { type: "heading", content: "Event Sourcing 与 CQRS" },
      { type: "paragraph", content: "Event Sourcing 把状态变化记录为不可变事件，而不是只保存当前状态。当前状态可以通过按顺序重放事件得到，因此系统天然拥有审计日志和时间旅行能力。" },
      { type: "paragraph", content: "CQRS 将命令模型和查询模型分离。命令侧负责校验业务规则并写入事件，查询侧根据事件异步构建适合读取的投影表。读写分离让复杂查询不污染领域写模型。" },
      { type: "paragraph", content: "事件是领域事实，命名应使用过去式，例如 OrderPaid 或 InventoryReserved。事件一旦发布就不应被修改，字段演进需要通过版本号、兼容字段或事件升级器处理。" },
      { type: "paragraph", content: "快照用于降低长事件流的重放成本。系统可以每隔固定事件数保存一次聚合状态快照，恢复时从最近快照开始重放后续事件。" },
      { type: "paragraph", content: "Event Sourcing 的代价是最终一致性和运维复杂度。查询投影可能滞后，事件修复需要补偿事件而不是直接改历史，团队必须具备较强的建模和观测能力。" },
    ],
  },
  {
    file: "note-11-product-activation-metric",
    title: "产品激活指标设计",
    blocks: [
      { type: "heading", content: "产品激活指标设计" },
      { type: "paragraph", content: "激活指标衡量用户是否第一次体验到产品核心价值。它不等同于注册、登录或完成新手引导，而应对应用户真正获得收益的关键行为。" },
      { type: "paragraph", content: "好的激活指标需要和长期留存相关。如果完成某个行为的用户在 7 天或 30 天后明显更可能回来，这个行为才有资格成为激活候选。" },
      { type: "paragraph", content: "激活事件应具备可操作性。团队看到激活率下降时，需要能定位是入口转化、任务理解、首次成功、等待时间还是价值感知出了问题。" },
      { type: "paragraph", content: "不要把过多步骤合成一个黑盒指标。可以把激活拆成漏斗，例如创建项目、导入数据、完成首次分析、分享结果。每一步都应该有清晰的用户意图。" },
      { type: "paragraph", content: "激活指标需要防止被刷。若把点击按钮定义为激活，团队可能优化出高点击低留存的虚假增长。更稳妥的指标通常包含产出、完成或回访信号。" },
    ],
  },
  {
    file: "note-12-kubernetes-deployment-rollout",
    title: "Kubernetes Deployment 滚动发布",
    blocks: [
      { type: "heading", content: "Kubernetes Deployment 滚动发布" },
      { type: "paragraph", content: "Kubernetes Deployment 管理一组 Pod 的期望状态，并通过 ReplicaSet 执行版本发布。用户更新镜像或模板后，Deployment 会创建新的 ReplicaSet，同时逐步缩小旧 ReplicaSet。" },
      { type: "paragraph", content: "滚动发布由 maxSurge 和 maxUnavailable 控制。maxSurge 决定发布时最多额外创建多少 Pod，maxUnavailable 决定最多允许多少 Pod 不可用。二者共同影响发布速度和服务容量。" },
      { type: "paragraph", content: "readinessProbe 决定 Pod 是否可以接收流量。如果新 Pod 尚未准备好，Service 不会把请求转发给它。缺少 readinessProbe 会让未初始化完成的实例过早接流量。" },
      { type: "paragraph", content: "livenessProbe 用于判断容器是否需要重启，不应承担业务依赖检查。把数据库短暂抖动放进 livenessProbe 可能导致所有 Pod 同时重启，扩大故障范围。" },
      { type: "paragraph", content: "回滚可以通过 rollout undo 回到上一个 ReplicaSet。但配置、数据库迁移和外部依赖不一定可逆，因此发布策略还需要配合向后兼容的数据变更。" },
    ],
  },
  {
    file: "note-13-clean-architecture-boundaries",
    title: "Clean Architecture 的依赖边界",
    blocks: [
      { type: "heading", content: "Clean Architecture 的依赖边界" },
      { type: "paragraph", content: "Clean Architecture 强调依赖方向从外层指向内层。领域实体和用例不依赖框架、数据库或 UI，外部技术细节通过接口适配进入系统。" },
      { type: "paragraph", content: "用例层表达业务动作，例如 CreateOrder、ApproveInvoice 或 PublishArticle。它协调实体、仓储接口和领域服务，但不应该直接处理 HTTP 请求、SQL 语句或页面状态。" },
      { type: "paragraph", content: "接口适配器负责把外部数据转换成用例需要的输入输出。Controller、Presenter、Repository 实现都属于适配器，它们可以依赖框架，但不应把框架对象传入领域层。" },
      { type: "paragraph", content: "依赖倒置让领域层定义需要什么能力，基础设施层提供具体实现。这样测试用例可以用内存仓储或假服务替代真实数据库和第三方 API。" },
      { type: "paragraph", content: "过度分层也会造成样板代码。小型项目可以保留清晰边界但减少文件数量，关键是让业务规则不要被 UI、ORM 或网络协议绑死。" },
    ],
  },
  {
    file: "note-14-observability-slo-error-budget",
    title: "可观测性、SLO 与错误预算",
    blocks: [
      { type: "heading", content: "可观测性、SLO 与错误预算" },
      { type: "paragraph", content: "可观测性依赖日志、指标和追踪三类信号。日志记录离散事件，指标描述时间序列趋势，追踪展示一次请求穿过多个服务的路径和耗时。" },
      { type: "paragraph", content: "SLI 是服务水平指标，例如请求成功率、延迟分位数或任务完成率。SLO 是对 SLI 的目标承诺，例如 99.9% 的请求在 300 毫秒内完成。" },
      { type: "paragraph", content: "错误预算等于 100% 减去 SLO。若月度可用性目标是 99.9%，团队每月有 0.1% 的失败预算。预算消耗过快时，应优先修复可靠性而不是继续发布高风险功能。" },
      { type: "paragraph", content: "告警应围绕用户影响，而不是机器内部噪音。CPU 短暂升高不一定需要叫醒工程师，但错误率持续超过 SLO burn rate 通常需要立即响应。" },
      { type: "paragraph", content: "追踪采样需要平衡成本和可诊断性。常见做法是保留错误请求、慢请求和少量随机正常请求，确保事故发生时有足够上下文。" },
    ],
  },
  {
    file: "note-15-python-asyncio-event-loop",
    title: "Python asyncio 事件循环",
    blocks: [
      { type: "heading", content: "Python asyncio 事件循环" },
      { type: "paragraph", content: "asyncio 是 Python 的异步 I/O 框架，核心是事件循环。事件循环负责调度协程、处理 I/O 就绪事件和执行回调，让单线程程序在等待 I/O 时切换到其他任务。" },
      { type: "paragraph", content: "async def 定义协程函数，调用它不会立即执行，而是返回协程对象。只有通过 await、create_task 或事件循环调度，协程才会真正运行。" },
      { type: "paragraph", content: "await 表示当前协程愿意让出控制权，等待另一个 awaitable 完成。它不是创建线程，而是在同一个事件循环内协作式切换，因此 CPU 密集任务仍会阻塞循环。" },
      { type: "paragraph", content: "create_task 会把协程包装成 Task 并立即安排执行。若创建任务后不保存引用或不等待结果，异常可能只在日志中出现，业务流程也难以确认任务是否完成。" },
      { type: "paragraph", content: "异步代码中的阻塞调用会破坏并发性。文件读写、数据库驱动和 HTTP 客户端都需要使用异步版本，或者通过线程池把阻塞操作移出事件循环。" },
    ],
  },
  {
    file: "note-16-security-threat-modeling",
    title: "威胁建模的 STRIDE 方法",
    blocks: [
      { type: "heading", content: "威胁建模的 STRIDE 方法" },
      { type: "paragraph", content: "威胁建模是在设计阶段系统性识别安全风险的方法。它不要求一次找到所有漏洞，而是帮助团队围绕资产、信任边界和攻击者能力讨论风险。" },
      { type: "paragraph", content: "STRIDE 包括 Spoofing、Tampering、Repudiation、Information Disclosure、Denial of Service 和 Elevation of Privilege 六类威胁。每一类都对应常见的安全控制。" },
      { type: "paragraph", content: "Spoofing 关注身份伪造，缓解手段包括强认证、凭证保护和会话绑定。Tampering 关注数据被篡改，通常需要完整性校验、签名和权限控制。" },
      { type: "paragraph", content: "Information Disclosure 关注敏感信息泄露。日志、错误信息、对象存储权限和调试接口都是常见泄露来源，需要最小化暴露并加密敏感数据。" },
      { type: "paragraph", content: "威胁建模输出应转化为可执行任务，例如增加 rate limit、收紧 IAM 权限、补充审计日志或引入安全测试。只有落到 backlog 的威胁才可能被真正处理。" },
    ],
  },
  {
    file: "note-17-database-transactions-isolation",
    title: "数据库事务隔离级别",
    blocks: [
      { type: "heading", content: "数据库事务隔离级别" },
      { type: "paragraph", content: "事务隔离级别定义并发事务之间能看到什么数据。隔离越强，异常越少，但锁竞争、冲突重试和性能成本通常越高。" },
      { type: "paragraph", content: "Read Committed 保证每条语句只能读到已提交数据，但同一事务内两次查询可能看到不同结果。PostgreSQL 默认使用 Read Committed。" },
      { type: "paragraph", content: "Repeatable Read 保证同一事务内多次读取同一条件的数据保持一致快照，但在某些数据库中仍可能出现幻读。PostgreSQL 的 Repeatable Read 基于 MVCC 快照，能避免普通幻读。" },
      { type: "paragraph", content: "Serializable 提供最接近串行执行的隔离效果。数据库可能通过锁或序列化冲突检测实现它，应用需要准备在冲突时重试事务。" },
      { type: "paragraph", content: "选择隔离级别要从业务不变量出发。库存扣减、账户转账和唯一资源分配通常需要更强约束，而普通列表查询可以接受较弱隔离。" },
    ],
  },
  {
    file: "note-18-css-layout-grid-flexbox",
    title: "CSS Grid 与 Flexbox 布局选择",
    blocks: [
      { type: "heading", content: "CSS Grid 与 Flexbox 布局选择" },
      { type: "paragraph", content: "Flexbox 主要解决一维布局问题，适合在一行或一列中分配空间、对齐项目和处理动态尺寸。导航栏、按钮组、表单行和卡片内部排列常用 Flexbox。" },
      { type: "paragraph", content: "CSS Grid 主要解决二维布局问题，适合同时控制行和列。仪表盘、图库、页面主体区域和复杂表单更适合用 Grid 表达结构。" },
      { type: "paragraph", content: "Flexbox 的主轴和交叉轴由 flex-direction 决定。justify-content 控制主轴分布，align-items 控制交叉轴对齐，gap 可以稳定设置项目间距。" },
      { type: "paragraph", content: "Grid 的 grid-template-columns 和 grid-template-rows 定义轨道。fr 单位按剩余空间分配，minmax 可以设置响应式边界，auto-fit 与 auto-fill 常用于自适应卡片网格。" },
      { type: "paragraph", content: "实际项目中二者经常组合使用。页面大结构用 Grid，单个区域内部用 Flexbox，可以减少嵌套 div 和脆弱的宽度计算。" },
    ],
  },
  {
    file: "note-19-learning-spaced-repetition",
    title: "间隔重复与主动回忆",
    blocks: [
      { type: "heading", content: "间隔重复与主动回忆" },
      { type: "paragraph", content: "间隔重复利用遗忘曲线安排复习时间。相比集中复习，把复习分散到多个间隔更有利于长期保持，尤其适合概念、事实和解题模式的巩固。" },
      { type: "paragraph", content: "主动回忆要求学习者在看答案前先尝试提取记忆。它比单纯重读更有效，因为提取过程本身会强化线索，并暴露哪些内容还没有真正掌握。" },
      { type: "paragraph", content: "复习间隔应根据表现动态调整。回答轻松且准确时延长间隔，回答困难、模糊或错误时缩短间隔，并回到原始材料修正理解。" },
      { type: "paragraph", content: "好的卡片应该聚焦一个可验证的知识点。过大的卡片会让复习变成泛泛重读，过小的卡片又可能失去上下文，导致只能记住碎片。" },
      { type: "paragraph", content: "间隔重复不能替代理解。对复杂主题，应该先建立结构化解释、例子和应用场景，再把关键区分点转化为复习问题。" },
    ],
  },
  {
    file: "note-20-api-rate-limiting",
    title: "API 限流算法与使用场景",
    blocks: [
      { type: "heading", content: "API 限流算法与使用场景" },
      { type: "paragraph", content: "API 限流用于保护系统容量、防止滥用并维持多租户公平。限流策略需要明确维度，例如用户、IP、组织、接口或 API key。" },
      { type: "paragraph", content: "固定窗口计数实现简单，但窗口边界会产生突刺。例如用户可以在一个窗口末尾和下一个窗口开头连续发送两倍请求，短时间超过预期容量。" },
      { type: "paragraph", content: "滑动窗口通过记录更细粒度的时间片或请求时间戳减少边界突刺。它比固定窗口更平滑，但存储和计算成本更高。" },
      { type: "paragraph", content: "令牌桶允许一定突发流量。系统按固定速率放入令牌，请求消耗令牌；桶容量决定最大突发量，填充速率决定长期平均速率。" },
      { type: "paragraph", content: "漏桶算法以固定速率处理请求，能平滑下游压力，但对短时突发不如令牌桶友好。对外部 API、写入型接口和昂贵 AI 调用，通常需要结合排队、重试和清晰的 429 响应。" },
    ],
  },
  {
    file: "note-21-release-metadata-noise",
    title: "发布说明中的元数据与有效结论",
    blocks: [
      { type: "heading", content: "Release 2.4.1 · 2026-07-18" },
      { type: "paragraph", content: "本次发布窗口为 2026 年 7 月 18 日 02:00–03:00 UTC，版本号和日期只是追溯元数据，不应被抽取为独立知识点。" },
      { type: "paragraph", content: "发布采用先 5% 再 25% 最后 100% 的分阶段放量。每一阶段都要观察错误率和 P95 延迟，任一指标超过阈值即停止扩容。" },
      { type: "paragraph", content: "回滚不依赖手工修改容器，而是重新部署上一个通过验收的镜像 digest。数据库变更必须在旧新应用间保持向前兼容。" },
    ],
  },
  {
    file: "note-22-bilingual-incident-review",
    title: "Incident Review：从超时到级联故障",
    blocks: [
      { type: "heading", content: "Incident Review / 事故复盘" },
      { type: "paragraph", content: "The trigger was a slow downstream dependency, but the outage became severe because every caller retried immediately without jitter. 当下游变慢时，同步重试放大了流量峰值。" },
      { type: "paragraph", content: "Timeouts must be shorter than the caller's remaining deadline. 如果内层超时长于外层 deadline，外层已经放弃后内层仍会消耗连接和 CPU。" },
      { type: "paragraph", content: "The remediation combined bounded exponential backoff, random jitter, a retry budget and a circuit breaker. 单独增加机器不能消除正反馈回路。" },
    ],
  },
  {
    file: "note-23-bayes-course-notes",
    title: "贝叶斯定理课程笔记",
    blocks: [
      { type: "heading", content: "贝叶斯定理" },
      { type: "paragraph", content: "贝叶斯定理写作 P(A|B)=P(B|A)P(A)/P(B)。它把观察到证据 B 之后对假设 A 的信念，与观察前的先验概率联系起来。" },
      { type: "paragraph", content: "在低基准率事件中，即使检测器灵敏度很高，阳性结果也可能包含较多假阳性。解释结果时不能忽略先验概率。" },
      { type: "paragraph", content: "似然度 P(B|A) 表示假设 A 成立时观察到 B 的可能性，它不等于后验概率 P(A|B)。把两者倒置是常见推理错误。" },
    ],
  },
  {
    file: "note-24-short-idempotency",
    title: "幂等性速记",
    blocks: [
      { type: "heading", content: "幂等性速记" },
      { type: "paragraph", content: "幂等操作重复执行多次与执行一次产生相同的可观测业务结果。幂等 key 必须与业务意图绑定，并由唯一约束或事务状态机守住。" },
    ],
  },
  {
    file: "note-25-user-research-synthesis",
    title: "用户研究与证据综合",
    blocks: [
      { type: "heading", content: "用户研究与证据综合" },
      { type: "paragraph", content: "访谈中的单个强烈意见不能直接代表整个用户群体。综合时应保留样本来源、使用场景和反例，避免只摘录支持既有方案的句子。" },
      { type: "paragraph", content: "主题编码应先记录原始观察，再归纳为模式。如果过早使用“需要更智能”这类抽象标签，会丢失用户在哪个步骤、为什么受阻的信息。" },
      { type: "paragraph", content: "研究结论应区分频率、影响和确信度。高频低影响问题与低频高影响问题需要不同的产品决策。" },
      { type: "paragraph", content: "最终报告要把每个结论链接回匿名记录或实验数据。无法追溯到证据的推荐应明确标记为假设。" },
    ],
  },
  {
    file: "note-26-code-and-explanation",
    title: "代码与解释混合笔记",
    blocks: [
      { type: "heading", content: "AbortSignal 取消传播" },
      { type: "paragraph", content: "取消信号应从任务 deadline 一直传到最底层网络请求。只在上层 Promise.race 返回超时，并不会自动停止底层请求。" },
      { type: "code", content: "const controller = new AbortController();\nfetch(url, { signal: controller.signal });\ncontroller.abort();" },
      { type: "paragraph", content: "即使网络客户端支持 AbortSignal，持久化副作用前仍要验证任务租约。取消和数据库围栏解决的是两个不同窗口。" },
    ],
  },
  {
    file: "note-27-policy-checklist",
    title: "数据保留策略检查清单",
    blocks: [
      { type: "heading", content: "数据保留策略" },
      { type: "list", content: "- 先按数据类别定义最短和最长保留期\n- 删除要覆盖主库、备份、缓存和派生索引\n- 法律保全状态下暂停自动删除" },
      { type: "paragraph", content: "保留期不应由存储成本单独决定。团队需要同时考虑业务目的、用户承诺、法律义务和事故调查需求。" },
      { type: "paragraph", content: "删除请求要生成可审计的执行记录，但记录本身不应复制已删除的敏感内容。" },
    ],
  },
  {
    file: "note-28-english-chinese-ml-evaluation",
    title: "ML Evaluation / 机器学习评估",
    blocks: [
      { type: "heading", content: "Offline metrics and online outcomes" },
      { type: "paragraph", content: "An offline benchmark is reproducible and fast, but it only approximates production behavior. 数据分布、用户行为和上下文变化都可能让离线排名失效。" },
      { type: "paragraph", content: "Precision measures how many predicted positives are correct, while recall measures how many relevant positives were found. 两者必须结合业务中假阳性和假阴性的代价解读。" },
      { type: "paragraph", content: "A stable evaluation set needs versioned inputs, immutable labels and a documented scoring script. 只保存最终百分比而没有保存样本和标注，无法比较两次模型变更。" },
    ],
  },
  {
    file: "note-29-migration-timeline",
    title: "数据库迁移时间线与兼容性",
    blocks: [
      { type: "heading", content: "Migration Plan v3 — Draft 2026-07-18" },
      { type: "paragraph", content: "T-7 天先上线可同时读取旧字段和新字段的应用版本。这一阶段不删除旧字段，以确保回滚时旧代码仍能运行。" },
      { type: "paragraph", content: "T 日执行可重入的数据回填，并持续记录未转换行数。回填完成前，写路径需要双写或使用确定的兼容转换。" },
      { type: "paragraph", content: "T+7 天只在旧版本已停用、数据校验通过且备份恢复演练成功后删除旧字段。破坏性 DDL 是最后一步，不是第一步。" },
    ],
  },
  {
    file: "note-30-deliberate-practice",
    title: "刻意练习的反馈回路",
    blocks: [
      { type: "heading", content: "刻意练习的反馈回路" },
      { type: "paragraph", content: "刻意练习不是简单重复已经熟练的动作，而是选择略高于当前能力的具体子技能，设定可观察目标并立即获得反馈。" },
      { type: "paragraph", content: "反馈必须指向可修正的差距。“做得不好”不足以指导下一次练习，而“论证缺少反例”可以直接转化为新任务。" },
      { type: "paragraph", content: "练习记录应包含任务、尝试、错误类型、修正方法和下次复习时间。只记录时长会把投入量误当成学习效果。" },
      { type: "paragraph", content: "当错误率过高时应缩小任务，当几乎不再出错时应增加难度。这种动态调整让练习始终保持在可学习区间。" },
    ],
  },
];

export interface KeyPointResult {
  ordinal: number;
  claim: string;
  quoteText: string;
  alignment: string;
  alignmentScore: number;
  alignmentMethod: string;
  blockOrdinal: number | null;
}

export interface NoteResult {
  noteFile: string;
  noteTitle: string;
  noteId: string;
  noteVersionId: string;
  cardId: string;
  cardTitle: string;
  cardSummary: string;
  keyPoints: KeyPointResult[];
  blockCount: number;
  error: string | null;
}

export interface BenchmarkMetrics {
  hardCitationPrecision: number | null;
  keyPointHardCoverage: number | null; // F-013: 无人标注时为 null，防止 AI 自评 100%
  validationExpectedPointsHardCoverage: number | null; // F-013: 无人标注时为 null
  // F-013: 标记指标是否经人工标注验证
  // false 表示指标完全依赖 AI 自报 alignment，模型可以自标 100%
  metricsVerified: boolean;
}

export interface BenchmarkReport {
  // R-010: 每次运行有唯一 runId，不再靠标题猜最新记录
  runId: string;
  // R-010: 绑定数据集版本，确保结果可追溯
  datasetVersion: string;
  timestamp: string;
  totalNotes: number;
  totalKeyPoints: number;
  metrics: BenchmarkMetrics;
  results: NoteResult[];
  hasLabels: boolean;
}

interface LabelEntry {
  ordinal: number;
  isCorrectlyAligned: boolean;
  expectedBlockOrdinal: number | null;
}

interface LabelFile {
  noteFile: string;
  keyPoints: LabelEntry[];
}

/**
 * 运行单篇笔记的全链路：创建 note → execute_card_agent_turn → align_evidence。
 */
async function runPipelineForNote(
  workspaceId: string,
  userId: string,
  noteFile: string,
  noteTitle: string,
  blocksInput: Array<{ type: string; content: string }>,
): Promise<NoteResult> {
  const result: NoteResult = {
    noteFile,
    noteTitle,
    noteId: "",
    noteVersionId: "",
    cardId: "",
    cardTitle: "",
    cardSummary: "",
    keyPoints: [],
    blockCount: blocksInput.length,
    error: null,
  };

  try {
    // QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 替代 db.transaction
    // 确保 RLS 上下文（app.workspace_id/app.user_id）在事务内可用
    const { note, version } = await withWorkspaceTransaction(
      { workspaceId, userId },
      async (tx) => {
      const [createdNote] = await tx
        .insert(notes)
        .values({
          workspaceId,
          title: noteTitle,
          titleSource: "benchmark",
          createdBy: userId,
        })
        .returning();

      const [createdVersion] = await tx
        .insert(noteVersions)
        .values({
          noteId: createdNote.id,
          workspaceId,
          versionNo: 1,
          contentJson: { blocks: blocksInput },
          contentHash: computeContentHash({ blocks: blocksInput }),
          createdBy: userId,
        })
        .returning();

      if (blocksInput.length > 0) {
        await tx.insert(noteBlocks).values(
          blocksInput.map((block, ordinal) => ({
            versionId: createdVersion.id,
            workspaceId,
            ordinal,
            type: block.type,
            content: block.content,
          })),
        );
      }

      await tx
        .update(notes)
        .set({ currentVersionId: createdVersion.id, updatedAt: new Date() })
        .where(and(eq(notes.id, createdNote.id), eq(notes.workspaceId, workspaceId)));
      return { note: createdNote, version: createdVersion };
    },
    );

    await upsertSearchDocument({
      workspaceId,
      objectType: "note",
      objectId: note.id,
      title: note.title,
      body: blocksInput.map((block) => block.content).join("\n"),
    });

    result.noteId = note.id;
    result.noteVersionId = version.id;

    // 2. 直接创建 generation run 并同步等待 worker 处理
    //    这里不走 job 队列，而是直接调用 worker handler 逻辑
    //    但 worker handler 在 ai-worker 包内，API 侧无法直接 import。
    //    所以我们走标准的 job 插入 + 轮询等待方式。
    await createCardGenerationRun(
      { workspaceId, userId },
      {
        noteVersionId: version.id,
        idempotencyKey: `benchmark:${version.id}`,
      },
    );

    // 3. 轮询等待 card 生成完成（worker 异步处理）
    const card = await waitForCard(version.id, workspaceId, userId, 60_000);
    if (!card) throw new Error("card generation timeout (60s)");

    result.cardId = card.id;
    result.cardTitle = (card.schemaJson as { title: string }).title;
    result.cardSummary = (card.schemaJson as { summary: string }).summary;

    // 4. 查询 key points
    // F11·①：key points 读取同样置于 workspace RLS executor 内。
    const kps = await withWorkspaceTransaction({ workspaceId, userId }, async (tx) =>
      tx.query.cardKeyPoints.findMany({
        where: and(
          eq(cardKeyPoints.cardId, card.id),
          eq(cardKeyPoints.workspaceId, workspaceId),
        ),
        orderBy: asc(cardKeyPoints.ordinal),
      }),
    );

    // 5. 等待 align_evidence 完成（worker 在 generation 完成后会自动排队 align_evidence）
    //    轮询等待所有 key point 的 evidence 出现
    const evidenceReady = await waitForAlignEvidence(kps.map((k) => k.id), workspaceId, userId, 60_000);
    if (!evidenceReady) throw new Error("evidence alignment timeout (60s)");

    // 6. 收集每个 key point 的 alignment 结果
    // 2026-08-11：批量查询一次拉全部 evidence，按 keyPointId 分组取"最优"
    //（此前每 kp 单独一次 findFirst，N 次往返）。
    const kpIds = kps.map((k) => k.id);
    const allEvidence = kpIds.length > 0
      ? await withWorkspaceTransaction({ workspaceId, userId }, async (tx) =>
          tx.query.evidences.findMany({
            where: and(
              inArray(evidences.keyPointId, kpIds),
              eq(evidences.workspaceId, workspaceId),
            ),
          }),
        )
      : [];
    const bestByKeyPoint = new Map<string, typeof allEvidence[number]>();
    for (const ev of allEvidence) {
      const current = bestByKeyPoint.get(ev.keyPointId);
      if (!current) {
        bestByKeyPoint.set(ev.keyPointId, ev);
        continue;
      }
      // 与查询 orderBy 相同的确定性选取：aligned 优先，score 降序，ID 升序
      const rank = (alignment: string | null) =>
        alignment === "aligned" ? 0 : alignment === "soft" ? 1 : alignment === "unaligned" ? 2 : 3;
      const better =
        rank(ev.alignment) < rank(current.alignment) ||
        (rank(ev.alignment) === rank(current.alignment) &&
          (ev.alignmentScore ?? 0) > (current.alignmentScore ?? 0)) ||
        (rank(ev.alignment) === rank(current.alignment) &&
          (ev.alignmentScore ?? 0) === (current.alignmentScore ?? 0) &&
          ev.id < current.id);
      if (better) bestByKeyPoint.set(ev.keyPointId, ev);
    }

    for (const kp of kps) {
      const ev = bestByKeyPoint.get(kp.id) ?? null;

      result.keyPoints.push({
        ordinal: kp.ordinal,
        claim: kp.claim,
        quoteText: kp.quoteText,
        alignment: ev?.alignment ?? "unaligned",
        alignmentScore: ev?.alignmentScore ?? 0,
        alignmentMethod: ev?.alignmentMethod ?? "fuzzy",
        blockOrdinal: ev?.blockOrdinal ?? null,
      });
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * 轮询等待 card 生成完成。
 * F11·①（round-4）：读取曾用裸 `db`（workspace RLS 上下文之外）。改为经
 * withWorkspaceTransaction 设置 app.workspace_id/app.user_id 后再查，确保
 * learning_cards 这类 RLS 表的 tenant 隔离（worker 以 BYPASSRLS 写入，同
 * workspace 行可被此 executor 读到）。WIT new 事务 per poll iteration 的开销
 * 可接受（benchmark 非热路径，轮询 2s 间隔）。
 */
async function waitForCard(
  noteVersionId: string,
  workspaceId: string,
  userId: string,
  timeoutMs: number,
): Promise<typeof learningCards.$inferSelect | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const card = await withWorkspaceTransaction({ workspaceId, userId }, async (tx) =>
      tx.query.learningCards.findFirst({
        where: and(
          eq(learningCards.noteVersionId, noteVersionId),
          eq(learningCards.workspaceId, workspaceId),
        ),
      }),
    );
    if (card) return card;
    await sleep(2000);
  }
  return null;
}

/**
 * 轮询等待所有 key point 的 evidence 生成完成。
 * F11·①：同 waitForCard，读取置于 workspace RLS executor 内。
 */
async function waitForAlignEvidence(
  keyPointIds: string[],
  workspaceId: string,
  userId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (keyPointIds.length === 0) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // N-008: 使用 COUNT(DISTINCT key_point_id) 确保每个 key point 至少有一条 evidence
    // 旧逻辑用 evRows.length >= keyPointIds.length，但一个 key point 可产生多条候选
    const evRows = await withWorkspaceTransaction({ workspaceId, userId }, async (tx) =>
      tx.query.evidences.findMany({
        where: and(
          eq(evidences.workspaceId, workspaceId),
          inArray(evidences.keyPointId, keyPointIds),
        ),
        columns: { keyPointId: true },
      }),
    );
    const distinctKpCount = new Set(evRows.map((ev) => ev.keyPointId)).size;
    if (distinctKpCount >= keyPointIds.length) return true;
    await sleep(2000);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 计算基准测试指标。
 */
function calculateMetrics(
  results: NoteResult[],
  labels: LabelFile[] | null,
): BenchmarkMetrics {
  const allKeyPoints = results.flatMap((r) => r.keyPoints);

  // F-013: keyPointHardCoverage 是 AI 自报指标（信任 alignment === "aligned"）
  // 模型可以把自己的输出全标为 aligned 获得 100% coverage
  // 这个指标在没有人工标注验证时不可信
  let keyPointHardCoverage: number | null = null;
  let validationExpectedPointsHardCoverage: number | null = null;
  let metricsVerified = false;

  // F-013: 只有有人工标注时才计算AI自报的指标，否则这些指标不可信
  if (labels && labels.length > 0) {
    const hardEvidenceCount = allKeyPoints.filter((kp) => kp.alignment === "aligned").length;
    keyPointHardCoverage = allKeyPoints.length > 0 ? hardEvidenceCount / allKeyPoints.length : 0;
  }

  let hardCitationPrecision: number | null = null;
  if (labels && labels.length > 0) {
    // R-010: 验证标签覆盖完整性 — 只有覆盖所有 key points 时才设 metricsVerified = true
    const labelMap = new Map<string, Map<number, LabelEntry>>();
    for (const lbl of labels) {
      const kpMap = new Map<number, LabelEntry>();
      for (const kp of lbl.keyPoints) {
        kpMap.set(kp.ordinal, kp);
      }
      labelMap.set(lbl.noteFile, kpMap);
    }

    // 检查每个 result 的 keyPoints 是否都有对应的 label
    let totalLabeledKps = 0;
    let totalExpectedKps = 0;
    for (const result of results) {
      const kpMap = labelMap.get(result.noteFile);
      for (const kp of result.keyPoints) {
        totalExpectedKps++;
        if (kpMap?.has(kp.ordinal)) totalLabeledKps++;
      }
    }
    // 退出结论要求完整数据集、零运行失败、全部 key point 均经过人工标注。
    metricsVerified =
      !results.some((result) => Boolean(result.error)) &&
      totalExpectedKps > 0 &&
      totalLabeledKps === totalExpectedKps;

    let correctCount = 0;
    let totalHardLabeled = 0;
    let expectedCount = 0;
    let expectedHardCoveredCount = 0;
    for (const result of results) {
      const kpMap = labelMap.get(result.noteFile);
      if (!kpMap) continue;
      for (const kp of result.keyPoints) {
        const label = kpMap.get(kp.ordinal);
        if (!label) continue;
        if (kp.alignment === "aligned") {
          totalHardLabeled++;
          if (label.isCorrectlyAligned) correctCount++;
        }
        if (label.expectedBlockOrdinal !== null) {
          expectedCount++;
          if (
            kp.alignment === "aligned" &&
            kp.blockOrdinal === label.expectedBlockOrdinal &&
            label.isCorrectlyAligned
          ) {
            expectedHardCoveredCount++;
          }
        }
      }
    }
    if (totalHardLabeled > 0) {
      hardCitationPrecision = correctCount / totalHardLabeled;
    }
    if (expectedCount > 0) {
      validationExpectedPointsHardCoverage = expectedHardCoveredCount / expectedCount;
    }
  }

  return {
    hardCitationPrecision,
    keyPointHardCoverage,
    validationExpectedPointsHardCoverage,
    metricsVerified,
  };
}

const BENCHMARK_REPORTS_RETENTION = 50;

async function persistBenchmarkReport(
  workspaceId: string,
  userId: string,
  report: BenchmarkReport,
  database: Pick<typeof db, "insert" | "delete" | "select"> = db,
): Promise<void> {
  await database.insert(benchmarkReports).values({
    workspaceId,
    userId,
    sampleCount: report.totalNotes,
    keyPointCount: report.totalKeyPoints,
    metricsJson: report.metrics as unknown as Record<string, unknown>,
    reportJson: report as unknown as Record<string, unknown>,
    hasLabels: report.hasLabels,
  });

  // R8（round-3 审计）：benchmark_reports 每 run/每次保存 label 都整份写 reportJson
  // （大 JSONB）+ results，此前无清理 → 无界增长。此处按 workspace 保留最新 50 条，
  // 删除更旧的（刚插入的 report 必在最新 50 内，安全）。同事务内进行，依赖既有
  // `benchmark:{workspaceId}` xact 锁避免并发交错。
  await database.delete(benchmarkReports).where(
    sql`${benchmarkReports.workspaceId} = ${workspaceId}
        AND ${benchmarkReports.id} NOT IN (
          SELECT ${benchmarkReports.id} FROM ${benchmarkReports}
          WHERE ${benchmarkReports.workspaceId} = ${workspaceId}
          ORDER BY ${benchmarkReports.createdAt} DESC, ${benchmarkReports.id} DESC
          LIMIT ${BENCHMARK_REPORTS_RETENTION}
        )`,
  );
}

async function persistBenchmarkLabels(
  workspaceId: string,
  userId: string,
  labels: LabelFile[],
  database: Pick<typeof db, "insert"> = db,
): Promise<void> {
  const rows = labels.flatMap((labelFile) =>
    labelFile.keyPoints.map((label) => ({
      workspaceId,
      noteFile: labelFile.noteFile,
      keyPointOrdinal: label.ordinal,
      isCorrectlyAligned: label.isCorrectlyAligned,
      expectedBlockOrdinal: label.expectedBlockOrdinal,
      updatedBy: userId,
      updatedAt: new Date(),
    })),
  );
  if (rows.length === 0) return;

  await database
    .insert(benchmarkLabels)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        benchmarkLabels.workspaceId,
        benchmarkLabels.noteFile,
        benchmarkLabels.keyPointOrdinal,
      ],
      set: {
        isCorrectlyAligned: sql`excluded.is_correctly_aligned`,
        expectedBlockOrdinal: sql`excluded.expected_block_ordinal`,
        updatedBy: userId,
        updatedAt: new Date(),
      },
    });
}

export async function getSavedBenchmarkLabels(workspaceId: string, userId: string): Promise<LabelFile[]> {
  // 🟠-1（round-5 审计）：benchmark_labels 表迁移（0024）已 ENABLE+FORCE ROW LEVEL SECURITY，
  // 原裸 `db.query.benchmarkLabels.findMany` 未经 workspace RLS executor，在 dev 库（RLS-off）
  // 下看似正常，生产 RLS 生效时该读会静默返回 0 行。改由 withWorkspaceTransaction 设置
  // app.workspace_id/app.user_id 上下文后分页读取，对齐 QUAL-58/SEC-26 模式。
  const rows = await withWorkspaceTransaction({ workspaceId, userId }, async (tx) =>
    tx.select().from(benchmarkLabels)
      .where(eq(benchmarkLabels.workspaceId, workspaceId))
      .orderBy(asc(benchmarkLabels.noteFile), asc(benchmarkLabels.keyPointOrdinal)),
  );

  const grouped = new Map<string, LabelEntry[]>();
  for (const row of rows) {
    const entries = grouped.get(row.noteFile) ?? [];
    entries.push({
      ordinal: row.keyPointOrdinal,
      isCorrectlyAligned: row.isCorrectlyAligned,
      expectedBlockOrdinal: row.expectedBlockOrdinal,
    });
    grouped.set(row.noteFile, entries);
  }

  return Array.from(grouped.entries()).map(([noteFile, keyPoints]) => ({ noteFile, keyPoints }));
}

export async function getLatestBenchmarkReport(
  workspaceId: string,
  database?: Pick<typeof db, "query">,
): Promise<BenchmarkReport | null> {
  // R#6-6：未传 executor 时不再裸读全局 db（无 RLS 上下文），改走 withWorkspaceTransaction 设置
  // app.workspace_id，与 B#2 一致（B#2 前瞻硬化）。调用方已持有事务连接可显式传入。
  const run = async (exec: Pick<typeof db, "query">) => {
    const row = await exec.query.benchmarkReports.findFirst({
      where: eq(benchmarkReports.workspaceId, workspaceId),
      orderBy: [desc(benchmarkReports.createdAt)],
    });
    return row ? row.reportJson as unknown as BenchmarkReport : null;
  };
  if (database) {
    return run(database);
  }
  return withWorkspaceTransaction(
    { workspaceId, userId: SYSTEM_USER_ID },
    (tx) => run(tx),
  );
}

/**
 * 清理上一次基准测试数据（按标题匹配），避免多次运行累积重复数据。
 * 复用笔记领域的级联删除路径，确保 jobs、验证/复习记录、AI artifacts
 * 和搜索投影都与普通笔记删除保持同一套语义。
 */
async function cleanupPreviousBenchmarkData(
  workspaceId: string,
  userId: string,
): Promise<void> {
  await withWorkspaceTransaction({ workspaceId, userId }, async (transaction) => {
    const benchmarkTitles = BUILTIN_NOTES.map((n) => n.title);
    // 查找所有同名笔记
    const oldNotes = await transaction.query.notes.findMany({
      where: and(
        eq(notes.workspaceId, workspaceId),
        inArray(notes.title, benchmarkTitles),
        eq(notes.titleSource, "benchmark"),
      ),
    });

    for (const oldNote of oldNotes) {
      // P1-1: 使用 physicalDeleteNote 彻底清理基准测试数据，
      // 避免 deleteNote 软删除后数据残留导致重复运行冲突。
      // CONC-07: force=true 跳过 deletedAt 检查，允许删除 active 笔记。
      // benchmark 笔记通常是 active 状态（未被软删除），不加 force 会被
      // physicalDeleteNote 的 CONC-07 守卫静默跳过，导致数据累积。
      await physicalDeleteNote(transaction, oldNote.id, workspaceId, { force: true });
    }
  });
}

/**
 * R-010: 生成唯一 runId，用于绑定 benchmark 运行与其结果。
 */
function generateRunId(): string {
  return randomBytes(8).toString("hex");
}

/** R-010: 内置数据集版本，随 BUILTIN_NOTES 内容变更递增 */
const DATASET_VERSION = "2026-07-18-v2";

/**
 * 运行完整基准测试（API 入口）。
 * 注意：此函数依赖 AI Worker 正在运行，会插入 generation run 并等待 worker 处理。
 */
async function executeBenchmark(
  workspaceId: string,
  userId: string,
): Promise<BenchmarkReport> {
  // R-010: 生成唯一 runId，绑定本次运行的所有结果
  const runId = generateRunId();
  // P2-1: 运行前先清理上一次的基准测试数据
  await cleanupPreviousBenchmarkData(workspaceId, userId);

  const results: NoteResult[] = [];

  // PERF-28/29 注释：此处串行处理是设计选择，而非遗漏。
  // 每篇笔记的 runPipelineForNote 涉及：
  //   1. 创建笔记和 noteVersion
  //   2. 触发卡片生成（涉及 AI provider 调用）
  //   3. 卡片生成可能使用 advisory lock 串行化同 workspace 的操作
  // 并行化会导致多个 AI 调用同时进行，可能触发 provider 限流，
  // 且 advisory lock 会导致部分操作被阻塞反而降低效率。
  // 如果需要并行化，应使用有限并发（如 p-limit(2)）并确保不会
  // 触发 workspace 级锁冲突。
  for (const note of BUILTIN_NOTES) {
    const result = await runPipelineForNote(
      workspaceId,
      userId,
      note.file,
      note.title,
      note.blocks,
    );
    results.push(result);
  }

  const totalKeyPoints = results.reduce((sum, r) => sum + r.keyPoints.length, 0);
  const metrics = calculateMetrics(results, null);

  const report = {
    runId,
    datasetVersion: DATASET_VERSION,
    timestamp: new Date().toISOString(),
    totalNotes: results.length,
    totalKeyPoints,
    metrics,
    results,
    hasLabels: false,
  };

  // QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 替代 db.transaction
  await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`benchmark:${workspaceId}`}, 0))`);
      await persistBenchmarkReport(workspaceId, userId, report, tx);
    },
  );
  return report;
}

export async function runBenchmark(
  workspaceId: string,
  userId: string,
): Promise<BenchmarkReport> {
  // A benchmark can hold the HTTP request for many minutes. Serialize runs for
  // one workspace across API replicas without holding an equally long DB
  // transaction; otherwise concurrent runs delete and supersede each other's
  // notes/jobs while they are still being evaluated.
  // Y13（round-3 审计）：统一为 `benchmark:{workspaceId}` 键，且 session 锁内部用
  // hashtextextended(key,0)，与 saveLabelsAndCalculate/executeBenchmark 写路径的
  // xact 锁（同键同哈希）真正互斥（session 与 xact 锁共享同一 bigint 锁空间）。
  // F11·②（round-4）：保持 session 锁贯穿整个 run。锁目的不是保护单次短写，而是
  // 阻止同一 workspace 的并发 benchmark 在"仍有 note/job 在评估"期间互删对方产物
  // （见 942-945 注释）。wait 轮询与建跑/收集交错在每 note 内（create→wait card→
  // wait evidence→collect），无法在不重写整个多 note 流水线的前提下把轮询整体挪到
  // 锁外。benchmark 为低频管理/QA 工具，单工作区串行（可能数分钟）可接受；
  // 若未来需放宽，应把每 note 的"建产"与"轮询"拆成两阶段并把轮询提出锁体。
  return withSessionAdvisoryLock(
    `benchmark:${workspaceId}`,
    () => executeBenchmark(workspaceId, userId),
  );
}

/**
 * 保存人工标注并重新计算 precision。
 */
export async function saveLabelsAndCalculate(
  workspaceId: string,
  userId: string,
  runId: string,
  labels: LabelFile[],
): Promise<BenchmarkReport | null> {
  // QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 替代 db.transaction
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // Y13（round-3 审计）：与新运行的最终写入共用同一 advisory 锁键 + 同一哈希
      // （hashtextextended(key,0)），与 runBenchmark 的 session 锁真正互斥——此前
      // run 用 session 锁 `benchmark-run:*`、此处用 xact 锁 `benchmark:*` + hashtext，
      // 双键不互斥，label 可能落到将被打断的旧 report 上（runId 不匹配兜底 409）。
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`benchmark:${workspaceId}`}, 0))`);

    // 使用报告中冻结的运行结果计算，避免重扫数据库时混入另一轮产物。
    const latestReport = await getLatestBenchmarkReport(workspaceId, tx);
    if (!latestReport || latestReport.runId !== runId) return null;
    const allResults = latestReport.results;
    const totalKeyPoints = allResults.reduce((sum, result) => sum + result.keyPoints.length, 0);
    const metrics = calculateMetrics(allResults, labels);

    const report = {
      runId,
      datasetVersion: latestReport.datasetVersion,
      timestamp: new Date().toISOString(),
      totalNotes: allResults.length,
      totalKeyPoints,
      metrics,
      results: allResults,
      hasLabels: true,
    };

    await persistBenchmarkLabels(workspaceId, userId, labels, tx);
    await persistBenchmarkReport(workspaceId, userId, report, tx);
    return report;
    },
  );
}
