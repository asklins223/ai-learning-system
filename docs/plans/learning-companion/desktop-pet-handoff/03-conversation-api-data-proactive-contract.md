# 03 — 对话、API、SSE、数据、人设、主动消息与语音合同

> 状态：Ready for Owner Approval
>
> 适用阶段：P2–P6；P1 只能使用本地 fixture，不得伪装真实对话
>
> 目标：让 Web、Electron、API、Worker 和 PostgreSQL 对同一个 turn、message、event、voice 与 proactive delivery 使用完全一致的合同

---

## 1. 架构决定

### 1.1 进程职责

| 进程 | 负责 | 禁止 |
| --- | --- | --- |
| Pet/Main renderer | 输入、SSE 消费、bubble preview、点按切换录音、TTS 播放、状态投影 | provider key、数据库、任意 Learning canonical write |
| Next.js | 页面与同源 `/api` rewrite | 保存对话真相、持有 provider key |
| Fastify API | 鉴权、幂等、事务、RLS、SSE、取消、导出/删除、动作确认 | 在 HTTP 请求内长期持有模型生成 |
| AI Worker | provider 调用、受控 prompt、流式 delta、最终消息和 cue | 绕过 job lease、越权读取其他 workspace、写 mastery/scheduler |
| PostgreSQL | durable message/run/event、RLS、幂等和恢复 cursor | 保存 raw microphone audio |

### 1.2 Provider 接线决定

- Companion 文本必须复用现有 `AI_PLATFORMS_CONFIG`、workspace provider governance 和 `text_generation` capability；
- API/Web/Electron 不得直接创建 OpenAI/DashScope 客户端；
- 不新增独立 `COMPANION_API_KEY`；
- Worker 通过现有 `resolveProviderForTask`/provider factory 解析当前 workspace 可用 provider；
- P2 新增 versioned streaming capability，不修改模型注册表为某个硬编码供应商；
- provider 不支持流式时允许产生单个完整 delta 的功能降级，但 P2 的真实 provider 验收必须至少有一个实现真流式；
- 模型名、provider id、promptVersion 可写入 run 元数据，API key、原始 provider error 和敏感 request 不得落普通日志。

冻结的共享接口：

```ts
interface StreamingTextGenerationCapability extends TextGenerationCapability {
  streamChatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): AsyncIterable<
    | { type: "text_delta"; text: string }
    | { type: "usage"; usage: ProviderUsage }
    | { type: "done" }
  >;
}
```

不允许 provider adapter 把 reasoning、隐藏 prompt、tool call argument 或供应商私有 event 直接转发给客户端。

### 1.3 Worker/job 决定

P2 新增：

```ts
JobType.COMPANION_DIALOGUE = "companion_dialogue";
```

P5 才新增：

```ts
JobType.COMPANION_ACTION = "companion_action";
```

调度：

- `companion_dialogue` 使用现有 `interactive_ai` resource class，priority 与正式交互 AI 同档；
- API 在同一个 `withWorkspaceTransaction` 中插入 user message、turn run 和 job；
- job payload 只包含 opaque id：`conversationId/runId/userMessageId/userId`，不复制完整聊天正文；
- P5 `companion_action` payload 只包含 `conversationId/proposalId/actionRunId/userId`，不复制 action payload、问题正文或 Learning result；
- Worker 按 id 在 RLS context 内重新读取消息；
- job dedupe 扩展为 `runId`，同一 run 只能有一个 pending/running dialogue job；
- 所有 provider 请求受 job lease、AbortSignal、per-type timeout 和安全错误治理；
- Worker 失败必须投影到 turn run 和 durable error event，再按现有 retry/dead 语义结束 job。

---

## 2. Shared contract 命名与版本

新增单一事实来源：

```text
packages/shared/src/companion-conversation-contracts.ts
packages/shared/src/companion-character-contracts.ts
packages/shared/src/desktop-pet-contracts.ts
```

规则：

- 所有网络/IPC/DB JSON shape 用 Zod `z.object(...).strict()`；
- 类型只用 `z.infer` 导出，不在 Web/API/Worker 重复声明；
- wire contract 带 `version: 1`；
- 枚举未知值 fail closed；
- string 有明确 min/max；array 有明确 max；
- 时间是 ISO-8601 UTC；ID 是 UUID，稳定 registry id 可用有界字符串；
- 任何 breaking change 新增 V2，不静默改变 V1。

除明确写“Unicode code point”的标题截取外，V1 所有 Zod `min/max`、`appendFrom`、`textLength` 和 preview 上限均按 JavaScript UTF-16 code unit（`text.length`）计数；provider 边界先替换孤立 surrogate，不能让不同语言用 byte/code-point 三套长度。

### 2.1 Hash 与 canonical JSON

所有小写 64 位 SHA-256 字段必须复用 shared `canonicalJsonV1/sha256Utf8V1`，不得由 Web/API/Worker 各写一套。`canonicalJsonV1` 只接受 strict schema parse 后的 JSON value：object key 按 Unicode code point 升序递归排序，array 保持顺序，string/boolean/null 使用标准 JSON token，number 必须是 finite safe integer 且 `-0` 规范为 `0`；输出 UTF-8、无 BOM、无额外空白、末尾无换行。当前所有被 canonical-hash 的 V1 body/payload 都不得含浮点数；未来需要浮点必须升级算法/version。

冻结用途：

- `request_body_hash/create_body_hash/decision_body_hash`：对对应 request 的 strict schema parse 输出（含 `version`）做 canonical JSON SHA-256；schema 变换以外的后续 title/content 净化不回写 hash，因此同 key 下原始 request 语义有任何差异都冲突；
- `payload_sha256`：只对 `proposedLearningActionPayloadV1Schema` parse 结果做 canonical JSON SHA-256；
- `contextRevision`：对 `{ resumeCandidate, startCandidate, reviewRoute, currentCardRoute, starMapRoute }` 做 canonical JSON SHA-256；candidate 使用 response 中完整 candidate object，`version/contextRevision/generatedAt` 不参与；
- message `content_sha256`：对 strict `blocks` array 做 canonical JSON SHA-256；
- `previewTextSha256/transcriptSha256/textSha256`：对最终 schema value 的精确 UTF-8 text bytes 计算，不再 canonical JSON 包一层；
- idempotency key hash：对校验后的 UUID 小写 ASCII 原文计算；proactive device-session claim 仍按 §6.8 使用 domain-separated HMAC，不复用无盐 key hash；
- `segmentId`：对不带换行的 ASCII `${runId}:${generation}:${ordinal}:${textSha256}` 计算。

hash comparison 使用 constant-time helper。shared 单测必须固定 Unicode、object key 顺序、array 顺序、`-0` 拒绝/规范化、正文换行与每一种用途的 golden vector。

---

## 3. Conversation 与 Message 合同

### 3.1 Conversation

```ts
const companionConversationV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(["dialogue", "inbox"]),
  title: z.string().min(1).max(120),
  titleSource: z.enum(["placeholder", "auto", "user", "system"]),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastMessageAt: z.string().datetime().nullable(),
}).strict();

type CompanionConversationV1 = z.infer<typeof companionConversationV1Schema>;
```

- P2 允许新建多个 `dialogue` conversation；
- 每个 `(workspaceId,userId)` 最多一个 active `inbox` conversation，由服务端通过幂等 inbox ensure 或首条合法 delivery 惰性创建；
- proactive delivery 永远写入 `inbox`，不插入用户正在进行的任意 dialogue；
- 默认打开最近 active dialogue；没有时保持 `conversationId=null`，用户第一次发送时客户端先调用 create conversation 得到“新对话”，随后创建 turn；空闲 bootstrap 不制造空 dialogue；
- P2 不调用模型生成标题：首条 user text 成功提交时，服务端去控制字符/Markdown、折叠空白并截取前 32 个 Unicode code points 作为一次性标题；空白时保持“新对话”；标题正文不得写入普通日志。
- 未传 title 的 dialogue 创建为“新对话”/`placeholder`；显式 title 为 `user`；首条非空 user text 只把 `placeholder` 原子改为 `auto`；PATCH title 改为 `user`；inbox 永远是“伴星消息”/`system`。这样并发首发消息或用户改名不会被后到请求覆盖。
- P5 menu-proposal 是唯一例外：服务端已验证 candidate 后用其 plain-text `title` 创建/更新首条 placeholder dialogue，仍标 `auto`；该值不是模型标题，后续同样不能覆盖 `user` title。

### 3.2 Message content blocks

```ts
const companionContentBlockV1Schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(20_000),
  }).strict(),
  z.object({
    type: z.literal("code"),
    language: z.string().min(1).max(40).optional(),
    code: z.string().min(1).max(20_000),
  }).strict(),
  z.object({
    type: z.literal("citation"),
    label: z.string().min(1).max(200),
    target: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("external_https"),
        href: z.string().url().max(2_000).refine((value) => new URL(value).protocol === "https:"),
      }).strict(),
      z.object({
        kind: z.literal("entity"),
        entityRef: z.string().min(1).max(240),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    type: z.literal("action_ref"),
    proposalId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal("result_ref"),
    actionRunId: z.string().uuid(),
  }).strict(),
]);
```

限制：

- 每条消息最多 32 blocks；
- Pet composer P2 只提交一个 `text` block；
- arbitrary HTML/DOM/CSS/script 不属于合法 block；
- text/code 原文作为数据保存，Web/Pet 只能用 escaping renderer；禁止 `dangerouslySetInnerHTML`。若 Main 使用 Markdown，必须通过现有 allowlist sanitizer，禁 raw HTML、data/javascript URL 与事件属性；
- external href 在 schema 只允许 HTTPS，UI 仍必须经过产品 host allowlist 后才能交系统浏览器；entityRef 由服务端重解引用；
- 正式学习证据优先使用 opaque `entityRef`，服务端重新解析；
- Bubble 只渲染净化后的 text preview，code/citation/action/result 在 Main 展开。
- P0–P6 dialogue Worker 的 provider output 始终保存为一个 exact text block；P5 只可由事务追加 action_ref/result_ref。code/citation variants 是 Main renderer/shared schema 的受控扩展位，本阶段不得通过未定义 parser 把模型 Markdown 自动提升成可信结构化引用；普通 Markdown code/link 仍作为 text 数据经 sanitizer 显示。

### 3.3 Message

```ts
const companionMessageV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  seq: z.number().int().positive(),
  role: z.enum(["user", "assistant", "system"]),
  kind: z.enum([
    "text",
    "voice_transcript",
    "proactive",
    "action",
    "result",
    "error",
  ]),
  blocks: z.array(companionContentBlockV1Schema).min(1).max(32),
  runId: z.string().uuid().nullable(),
  clientMessageId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
}).strict();

type CompanionMessageV1 = z.infer<typeof companionMessageV1Schema>;
```

- `seq` 在 conversation 内单调、唯一；
- assistant streaming 期间不创建多个可见 message；final 时创建/完成一个 assistant message；
- `system` 默认不展示给用户，只承载可审计的 content-free 状态；
- error message 只能保存净化错误，不保存 stack/provider body；
- P2 不支持编辑已发送消息；用户可新发纠正消息或删除整个 conversation。

客户端从不提交完整 Message 对象；只有服务端事务能决定 role/kind/runId。写库前固定验证矩阵：

| 来源 | role/kind | blocks | `runId/clientMessageId` |
| --- | --- | --- | --- |
| text/voice turn | `user` + `text/voice_transcript` | 恰好一个 text | 两者均为该 turn 的非空 ID |
| normal assistant final | `assistant/text` | 恰好一个与 delta 拼接值相同的 text；P5 可再有恰好一个同事务 proposal 的 action_ref | turn runId / client null |
| menu proposal user intent | `user/action` | 恰好一个服务端模板 text | run null / request clientMessageId |
| menu proposal confirmation | `assistant/action` | 一个模板 text + 恰好一个 action_ref | 两者 null |
| successful action result | `assistant/result` | 一个 safe text + 恰好一个 result_ref | 两者 null |
| proactive inbox | `assistant/proactive` | 恰好一个确定性 text | 两者 null |
| durable safe error（若创建） | `system/error` | 恰好一个净化 text | 关联 turn 时 runId，否则 null；client null |

`action_ref/result_ref` 不能来自模型原始 blocks：router/bridge 先验证并创建同 scope row，再由事务注入。任何其他 role/kind/block 组合拒绝写库；`inbox` 只接受 proactive/system error，`dialogue` 不接受 proactive。

---

## 4. Turn 与 Character cue 合同

### 4.1 Turn request

```ts
const companionGroundedTutorGrantPayloadV1Schema = z.object({
  version: z.literal(1),
  grantId: z.string().uuid(),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  pageInstanceId: z.string().uuid(),
  pageKind: z.literal("learning_session"),
  capability: z.literal("grounded_tutor"),
  sessionId: z.string().uuid(),
  episodeId: z.string().uuid(),
  cardId: z.string().uuid(),
  keyPointId: z.string().uuid(),
  contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  permissionSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

const companionGroundedTutorGrantV1Schema = companionGroundedTutorGrantPayloadV1Schema.extend({
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const companionPageContextV1Schema = z.discriminatedUnion("pageKind", [
  z.object({
    pageKind: z.literal("today"),
    sharing: z.literal("page_registered"),
    contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    pageKind: z.literal("review"),
    sharing: z.enum(["page_registered", "user_selected"]),
    cardId: z.string().uuid().optional(),
    keyPointId: z.string().uuid().optional(),
    contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    pageKind: z.literal("card"),
    sharing: z.enum(["page_registered", "user_selected"]),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid().optional(),
    contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    pageKind: z.literal("star_map"),
    sharing: z.enum(["page_registered", "user_selected"]),
    keyPointId: z.string().uuid().optional(),
    contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    pageKind: z.literal("learning_session"),
    sharing: z.enum(["page_registered", "user_selected"]),
    sessionId: z.string().uuid(),
    episodeId: z.string().uuid(),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid(),
    requestedCapability: z.enum(["none", "grounded_tutor"]),
    contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
    groundedTutorGrant: companionGroundedTutorGrantV1Schema.nullable(),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.pageKind !== "learning_session") return;
  const required = value.requestedCapability === "grounded_tutor";
  if (required !== (value.groundedTutorGrant !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["groundedTutorGrant"], message: "grant iff grounded_tutor" });
  }
});

const companionPersistedPageContextV1Schema = z.object({
  version: z.literal(1),
  context: z.discriminatedUnion("pageKind", [
    z.object({
      pageKind: z.literal("today"),
      sharing: z.literal("page_registered"),
      contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
    z.object({
      pageKind: z.literal("review"),
      sharing: z.enum(["page_registered", "user_selected"]),
      cardId: z.string().uuid().optional(),
      keyPointId: z.string().uuid().optional(),
      contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
    z.object({
      pageKind: z.literal("card"),
      sharing: z.enum(["page_registered", "user_selected"]),
      cardId: z.string().uuid(),
      keyPointId: z.string().uuid().optional(),
      contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
    z.object({
      pageKind: z.literal("star_map"),
      sharing: z.enum(["page_registered", "user_selected"]),
      keyPointId: z.string().uuid().optional(),
      contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
    z.object({
      pageKind: z.literal("learning_session"),
      sharing: z.enum(["page_registered", "user_selected"]),
      sessionId: z.string().uuid(),
      episodeId: z.string().uuid(),
      cardId: z.string().uuid(),
      keyPointId: z.string().uuid(),
      requestedCapability: z.enum(["none", "grounded_tutor"]),
      contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
      groundedTutorGrant: z.object({
        grantId: z.string().uuid(),
        permissionSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
        expiresAt: z.string().datetime(),
      }).strict().nullable(),
    }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  if (value.context.pageKind !== "learning_session") return;
  const required = value.context.requestedCapability === "grounded_tutor";
  if (required !== (value.context.groundedTutorGrant !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["context", "groundedTutorGrant"], message: "persisted grant iff grounded_tutor" });
  }
});

const createCompanionTurnRequestV1Schema = z.object({
  version: z.literal(1),
  clientMessageId: z.string().uuid(),
  inputKind: z.enum(["text", "voice_transcript"]),
  blocks: z.array(companionContentBlockV1Schema).length(1),
  voiceArtifactId: z.string().uuid().optional(),
  sourceSurface: z.enum(["pet", "main", "web_fallback"]),
  supersedesGeneration: z.number().int().positive().optional(),
  context: companionPageContextV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  const textOnly = value.blocks[0]?.type === "text";
  if (!textOnly) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: "v1 turn input must be one text block" });
  }
  if ((value.inputKind === "voice_transcript") !== (value.voiceArtifactId !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["voiceArtifactId"], message: "required iff voice_transcript" });
  }
});
```

HTTP header：

```text
Idempotency-Key: <UUID>
```

规则：

- header 必填；body 不重复保存 key；
- server 保存 key 的 SHA-256，不保存可复用原文；
- 同 user/conversation/key + 相同 body hash 返回同一 run；
- 同 key + 不同 body hash 返回 `409 IDEMPOTENCY_CONFLICT`；
- `clientMessageId` 是第二道跨 surface 防重：同 conversation/clientMessageId + 同 body hash 即使 header key 不同也返回原 run；body 不同返回 `409 IDEMPOTENCY_CONFLICT`；
- context 只接受上述页面 registry；服务端按 session workspace 重新查询每个 ID、校验相互关系与当前可见 public projection，`sharing/contextRevision/requestedCapability` 都不是授权凭据；P5 前 learning_session 只允许 `requestedCapability=none/grant=null`；
- API 不保存 raw request context 或 grant signature：校验后只把 `companionPersistedPageContextV1Schema` 写入 run `page_context`，Worker 只按这些 bounded refs 重新查询 public projection。grounded grant 的 payload 字段必须与 context/current session 精确一致、HMAC/TTL/scope/policy 有效，且 grant/signature 永不进入模型、job payload、日志或 export；
- 其他应用截图、完整 DOM、剪贴板和未发送 draft 禁止进入 context。
- `sourceSurface` 仅用于 UX/metrics 元数据，不是授权凭据；服务端不能因客户端声称来自 Main/Pet 而扩大权限。
- `voiceArtifactId` 必须引用 P3 当前 user/workspace 下未过期的 pending 日常 voice provenance，且其 transcript hash 与唯一 text block 精确相等；turn 事务把它绑定到新 user message。普通 text 不得夹带该 ID，客户端提供的 provider/model 元数据一律忽略。

Active run 规则：

- conversation 无 active run 时，正常创建；若带 `supersedesGeneration`，它必须等于最近 generation，否则 `409 STALE_GENERATION`；
- conversation 有 active run 时，request 必须带与 active run 精确相等的 `supersedesGeneration`，否则 `409 RUN_ALREADY_ACTIVE/STALE_GENERATION`；
- 匹配时，创建 turn 的同一事务先把旧 run 置为 `superseded`、写 `turn.cancelled(reason=superseded)`，再分配新 generation/message/run/job；
- client 在提交时立即 fence 旧 delta/audio/cue，但保留 draftSnapshot；只有新 `turn.accepted` 后清空 draft；
- 因此用户在 streaming 时发新消息只需一次 POST，不采用“先 cancel、等待、再 POST”的易竞态双请求流程；手工“停止”仍使用 cancel route。

### 4.2 Turn accepted response

```ts
const createCompanionTurnResponseV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  clientMessageId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  status: z.literal("accepted"),
  eventCursor: z.number().int().nonnegative(),
}).strict();
```

返回 `202 Accepted`。只有 user message、run 和 job 同事务成功后才能返回。

`eventCursor` 固定等于该事务内 `turn.accepted` 的 conversation event seq，不得返回事务提交后的任意 head。客户端只有在它恰为当前 cursor 的下一条时，才可把 response 当作 accepted event 的语义等价输入并推进 cursor；存在 seq gap 时必须按 02 合同 snapshot，不能跳过旧 run cancellation 或 conversation-scoped action event。

### 4.3 Turn run

```ts
const companionRunStatusV1Schema = z.enum([
  "accepted",
  "running",
  "succeeded",
  "cancel_requested",
  "cancelled",
  "failed",
  "superseded",
]);

type CompanionRunStatusV1 = z.infer<typeof companionRunStatusV1Schema>;

const companionTurnRunV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid().nullable(),
  generation: z.number().int().positive(),
  status: companionRunStatusV1Schema,
  phase: z.enum(["accepted", "thinking", "streaming", "acting"]).nullable(),
  previewText: z.string().max(20_000),
  previewTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  lastEventSeq: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

type CompanionTurnRunV1 = z.infer<typeof companionTurnRunV1Schema>;
```

终态：`succeeded/cancelled/failed/superseded`。终态不可回退。Retry 创建新 run/generation，不复活旧 run。

`previewText` 是 API 在同一只读 snapshot transaction 中按 durable `assistant.delta` 重建的当前可见文本，不新增第二份数据库真相；`previewTextSha256` 对 UTF-8 bytes 计算。`lastEventSeq` 是该 runId durable event 的最大 conversation seq（accepted 已存在，因此 active run 必须 >0），不是 conversation head。active snapshot 只返回 `accepted/running/cancel_requested` run；terminal run 通过 durable message/history 恢复。`phase` 在 terminal row 为 `null`，在 active row 必须非 null。

### 4.4 Character cue

```ts
const characterCueV1Schema = z.object({
  version: z.literal(1),
  intent: z.enum([
    "acknowledge",
    "listen",
    "think",
    "explain",
    "encourage",
    "celebrate",
    "uncertain",
    "warn",
    "sleep",
  ]),
  emotion: z.enum(["neutral", "happy", "curious", "concerned", "surprised"]),
  intensity: z.number().min(0).max(1),
  durationMs: z.number().int().min(100).max(10_000).optional(),
}).strict();

type CharacterCueV1 = z.infer<typeof characterCueV1Schema>;
```

它只是建议。客户端仍按 02 的真实状态和现有 `eventAllowsVisualState` 校验；无真实事件支持的 celebrate/committed change 必须拒绝。

P2–P3 不增加第二次 LLM 调用来猜情绪，也不从流式正文解析隐藏标签。Character 先完全按 02 的真实状态投影；若服务端发送 `character.cue`，只允许以下确定性来源：turn accepted=`acknowledge/neutral/0.25`、thinking=`think/curious/0.35`、首个可见 delta=`explain/neutral/0.30`、安全错误=`uncertain/concerned/0.45`。P4 才可在已批准 adapter 后增加 bounded cue classifier，失败时仍回到该确定性映射。

### 4.5 P5 Learning action proposal

第一批 payload 冻结为：

```ts
const proposedLearningActionPayloadV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("resume_session"),
    sessionId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("start_session"),
    origin: z.enum(["card", "review", "star_map", "now"]),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid(),
  }).strict(),
  z.object({ kind: z.literal("open_review") }).strict(),
  z.object({
    kind: z.literal("open_card"),
    cardId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("open_star_map"),
    keyPointId: z.string().uuid().optional(),
  }).strict(),
  z.object({
    kind: z.literal("ask_grounded_tutor"),
    sessionId: z.string().uuid(),
    episodeId: z.string().uuid(),
    question: z.string().min(1).max(4_000),
  }).strict(),
]);

const companionActionProposalV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  conversationId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  sourceGeneration: z.number().int().nonnegative(),
  contextGrantId: z.string().uuid().nullable(),
  payload: proposedLearningActionPayloadV1Schema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(80),
  targetSummary: z.string().min(1).max(160),
  impactSummary: z.string().min(1).max(240),
  requiresConfirmation: z.literal(true),
  status: z.enum(["pending", "rejected", "accepted", "executing", "succeeded", "failed", "expired"]),
  decision: z.enum(["confirm", "reject"]).nullable(),
  actionRunId: z.string().uuid().nullable(),
  expiresAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const pendingLearningActionProposalV1Schema = companionActionProposalV1Schema.extend({
  status: z.literal("pending"),
  decision: z.null(),
  actionRunId: z.null(),
  decidedAt: z.null(),
}).strict();

type ProposedLearningActionV1 = z.infer<typeof pendingLearningActionProposalV1Schema>;

const companionActionRunV1Schema = z.object({
  version: z.literal(1),
  actionRunId: z.string().uuid(),
  proposalId: z.string().uuid(),
  status: z.enum(["accepted", "running", "succeeded", "failed", "cancelled"]),
  resultMessageId: z.string().uuid().nullable(),
  resultRef: z.string().min(1).max(240).nullable(),
  route: allowedMainRouteV1Schema.nullable(),
  safeSummary: z.string().min(1).max(240).nullable(),
  errorCode: z.string().min(1).max(80).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

type CompanionActionRunV1 = z.infer<typeof companionActionRunV1Schema>;

const companionMenuLearningCandidateV1Schema = z.discriminatedUnion("candidateId", [
  z.object({
    candidateId: z.literal("resume_current"),
    payload: z.object({ kind: z.literal("resume_session"), sessionId: z.string().uuid() }).strict(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().min(1).max(80),
    targetSummary: z.string().min(1).max(160),
    impactSummary: z.string().min(1).max(240),
  }).strict(),
  z.object({
    candidateId: z.literal("start_short"),
    payload: z.object({
      kind: z.literal("start_session"),
      origin: z.enum(["card", "review", "star_map", "now"]),
      cardId: z.string().uuid(),
      keyPointId: z.string().uuid(),
    }).strict(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().min(1).max(80),
    targetSummary: z.string().min(1).max(160),
    impactSummary: z.string().min(1).max(240),
  }).strict(),
]);

const companionLearningContextV1Schema = z.object({
  version: z.literal(1),
  contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  resumeCandidate: companionMenuLearningCandidateV1Schema.nullable(),
  startCandidate: companionMenuLearningCandidateV1Schema.nullable(),
  reviewRoute: z.object({ kind: z.literal("review") }).strict(),
  currentCardRoute: z.object({ kind: z.literal("card"), cardId: z.string().uuid() }).strict().nullable(),
  starMapRoute: z.object({ kind: z.literal("star_map"), keyPointId: z.string().uuid().optional() }).strict(),
  generatedAt: z.string().datetime(),
}).strict();
```

Proposal/run 状态关联必须额外用 shared `superRefine` 和 service transition test 固定：pending/expired/rejected proposal 没有 actionRunId；accepted/executing/succeeded/failed proposal 必须是 confirm 且有 actionRunId。accepted/running action run 的 resultMessageId/resultRef/route/safeSummary/errorCode 全为 null；succeeded 必须有 `resultMessageId + safeSummary`，并至少有 `resultRef` 或 `route`；failed 必须有 errorCode 且无 result message/ref/route；cancelled 不得有成功字段。

- payload 只含 opaque UUID 和有界用户问题；服务端确认时重新按 session user/workspace 解引用；
- `sourceMessageId` 必须指向包含对应 `action_ref` block 的同一 assistant message：模型 proposal 是该 run 的 final message，菜单 proposal 是服务端模板化 confirmation message；proposal 与该 message 同事务创建；
- `sourceGeneration` 对模型 proposal 等于 source assistant run generation；菜单 proposal 等于创建事务开始时 `next_generation-1`（新 conversation 可为 0）。所有 `action.*` event envelope 使用该值，但客户端把它作为 proposal provenance，不用它回退当前 Turn；
- `ask_grounded_tutor` 必须带已验证、未复用的 contextGrantId；其他 action 的 contextGrantId 必须为 null。raw grant/signature 不进入 proposal；
- dialogue/model 产生的 proposal 一律需要显式确认；用户直接点击 allowlisted 菜单导航时，该点击本身是用户手势，可走 typed route 而不制造假 proposal；
- `resume_session/start_session/ask_grounded_tutor` 默认 `5min` 过期，纯导航 proposal 默认 `10min`；
- title/summary 是服务端净化展示字段，不是执行输入；执行只读取验证后的 payload；
- P5 以前 shared 可以定义 schema 供 SSE union 编译，但 API 不得创建 proposal。
- P5 `GET /companion/learning-context` 通过 Learning service 的只读 public adapter 构造菜单候选：`resume_current` 是 `(updated_at DESC,id DESC)` 的当前用户最近 active session；`start_short` 是现有 scheduler/Now public projection 返回的下一张合法 card/key point。无合法目标为 `null`，不由模型补 ID；多条排序必须稳定。
- `contextRevision` 严格使用 §2.1 冻结的 candidate/routes object；`generatedAt` 不参与 hash。菜单创建 proposal 时服务端重新计算并要求 revision/candidate hash 精确相等，过期返回 `409 ACTION_STALE`。

---

## 5. SSE event 合同

### 5.1 Envelope

```ts
const companionStreamEventTypeV1Schema = z.enum([
  "turn.accepted",
  "assistant.status",
  "assistant.delta",
  "assistant.final",
  "character.cue",
  "action.proposed",
  "action.decision",
  "action.expired",
  "action.started",
  "action.completed",
  "action.failed",
  "voice.segment.ready",
  "proactive.delivery",
  "proactive.delivery.updated",
  "turn.cancelled",
  "error",
]);

const companionStreamEventV1Schema = z.object({
  version: z.literal(1),
  eventId: z.string().min(1).max(120),
  seq: z.number().int().positive(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  generation: z.number().int().nonnegative(),
  accountEpoch: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  type: companionStreamEventTypeV1Schema,
  payload: z.unknown(),
}).strict();
```

`eventId` 固定为 `<conversationId>:<seq>`。`seq` 是 conversation 级 cursor，不是 run 内 cursor。

### 5.2 Discriminated payload

实现必须在 shared 中以 `type` discriminated union 建模，不能留下 `payload: unknown` 给各端自行断言。

```ts
type Event<TType extends string, TPayload> = {
  version: 1;
  eventId: string;
  seq: number;
  workspaceId: string;
  conversationId: string;
  runId: string | null;
  generation: number;
  accountEpoch: number;
  createdAt: string;
  type: TType;
  payload: TPayload;
};

type CompanionStreamEventV1 =
  | Event<"turn.accepted", {
      clientMessageId: string;
      userMessageId: string;
      status: "accepted";
    }>
  | Event<"assistant.status", {
      status: "thinking" | "acting";
      safeLabel: string;
    }>
  | Event<"assistant.delta", {
      appendFrom: number;
      textDelta: string;
    }>
  | Event<"assistant.final", {
      messageId: string;
      textLength: number;
      textSha256: string;
      messageContentSha256: string;
    }>
  | Event<"character.cue", {
      cue: CharacterCueV1;
    }>
  | Event<"action.proposed", {
      proposal: ProposedLearningActionV1;
    }>
  | Event<"action.decision", {
      proposalId: string;
      decision: "confirm" | "reject";
      status: "accepted" | "rejected";
      actionRunId: string | null;
    }>
  | Event<"action.expired", {
      proposalId: string;
    }>
  | Event<"action.started", {
      proposalId: string;
      actionRunId: string;
    }>
  | Event<"action.completed", {
      actionRunId: string;
      resultRef: string | null;
      route: AllowedMainRouteV1 | null;
      safeSummary: string;
    }>
  | Event<"action.failed", {
      actionRunId: string;
      code: string;
      recoverable: boolean;
    }>
  | Event<"voice.segment.ready", {
      segmentId: string;
      ordinal: number;
      text: string;
      textSha256: string;
    }>
  | Event<"proactive.delivery", {
      deliveryId: string;
      messageId: string;
      expiresAt: string;
      contentPolicy: "content" | "content_hidden";
    }>
  | Event<"proactive.delivery.updated", {
      deliveryId: string;
      status: "shown" | "suppressed" | "dismissed" | "expired";
      contentClaimed: boolean;
    }>
  | Event<"turn.cancelled", {
      reason: "user" | "superseded" | "shutdown" | "timeout";
    }>
  | Event<"error", {
      code: CompanionPublicErrorCodeV1;
      recoverable: boolean;
    }>;
```

约束：

- shared Zod union 必须把示例 TypeScript 中所有 ID 校验 UUID、时间校验 datetime，并固定：appendFrom 非负整数；delta `1..2,000` code unit；final textLength `0..20,000` 且两个 hash 都是小写 64 hex；safeLabel/safeSummary `1..240`；action resultRef `1..240` 或 null、error code `1..80`；voice ordinal `1..20`、text `1..160`、segment/text hash 为小写 64 hex；
- client 当前文本长度必须等于 `appendFrom`，否则停止追加并请求 snapshot；
- `assistant.final.textSha256` 对全部 delta 拼接出的 exact assistant text 计算，client 必须与 preview 长度/hash 比对；`messageContentSha256` 等于最终 message row 的 canonical blocks hash，GET 到 message 后再次验证。任一不符关闭 stream并 snapshot，不拿 action_ref 等非文本 block 冒充 delta；
- event 不包含 provider 原始响应、reasoning 或 secret；
- `safeLabel/safeSummary` 为服务端确定性或净化文字，最大 240 字符；
- `voice.segment.ready.text` 只含已成为 assistant 可见消息一部分的稳定句，不含隐藏内容；
- `voice.segment.ready.segmentId` 固定为 `sha256(runId:generation:ordinal:textSha256)` 的 64 位小写十六进制；`ordinal` 从 1 单调递增；
- turn/assistant/character/voice/turn.cancelled event 必须有对应 Companion turn `runId` 且 generation `>=1`；全部 `action.*` event 的 envelope `runId=null`、`generation=proposal.sourceGeneration`；proactive event 与 `runId=null` error 固定 `runId=null/generation=0`，关联 turn 的 error 使用该 runId/generation；

### 5.3 SSE wire

```text
HTTP 200
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store, no-transform
X-Accel-Buffering: no

retry: 1500
id: <conversationId>:<seq>
event: companion
data: <CompanionStreamEventV1 JSON>
```

- 每 `15s` 发送 `: heartbeat <unix-ms>` comment；
- query `after` 与 `Last-Event-ID` 同时存在时，以合法的较大 cursor 为准；
- SSE 连接先 replay durable events，再订阅新事件；
- replay 与 live 切换必须在一个 cursor fence 下，不能丢缝隙事件；
- 事件 TTL 内断线可完整 replay；若 `after` 早于仍可连续 replay 的最小 cursor，API 在写 SSE headers 前返回 `409 CURSOR_EXPIRED` JSON error，客户端 GET 已知的 `/companion/conversations/:id` snapshot 后以其 `latestEventSeq` 重连；
- `after > latestEventSeq`、格式错误或 Last-Event-ID 属于其他 conversation → `400 INVALID_CURSOR`；client 检测到 `appendFrom/hash` mismatch 时也主动关闭 stream、GET 同一 snapshot，不等待服务端制造 synthetic reset event；
- browser retry 不重新提交 turn；
- 一名用户每 conversation 最多 3 个 SSE 连接，每账号总计最多 10 个，超限 `429`；
- reverse proxy buffering 必须在真实 Docker 验证关闭。

V1 renderer 不使用原生 `EventSource`：它无法可靠读取连接前的 `409 CURSOR_EXPIRED` JSON body。`apps/web/features/companion-pet/conversation/` 实现一个无新依赖的 shared fetch-SSE client：`credentials:"same-origin"`、`Accept:text/event-stream`、query `after`，可带合法 Last-Event-ID；先检查 status/content-type，再以 fatal UTF-8 `TextDecoder` 解析 CRLF/LF。只接受 `event: companion`、单个 id 和单行 data；单 event wire data 最大 `64KiB`，未知字段/多 id/非法 UTF-8/超限都关闭并 snapshot。

重连固定为 server `retry:1500` 起步、指数退避到 `15s` 并加 `0..20%` jitter；收到任一有效 event 后重置。heartbeat/事件 `45s` 未到即 abort/reconnect，offline/hidden/scope change 用 AbortController 立即停。401/403 进入 auth bootstrap，409 CURSOR_EXPIRED 取 snapshot，429 尊重 Retry-After，5xx/network 按 backoff；任何分支都不得重新 POST turn。Pet/Main/inbox 共用同一 parser 实现但各自持有 AbortController/cursor。

### 5.4 PostgreSQL wake-up

不为 P2 引入 Redis。事件的真相是 event table，PostgreSQL `NOTIFY` 只作为低延迟 wake hint：

- Worker 事务提交 event 后发送 channel `ailearn_companion_events_v1`；
- payload 只含 `conversationId` 和 `maxSeq`，不得包含正文；
- API 每进程只保留一个数据库 listener，再 fan-out 到本进程 subscriber；
- NOTIFY 丢失时每 `1s` durable poll 修复；
- listener 断线自动重连，SSE cursor 保证不丢消息；
- 禁止每个 SSE client 独占一个 PostgreSQL LISTEN connection。

---

## 6. HTTP API 完整清单

Web 通过同源 `/api/...` 访问；下表是 Fastify 实际 route，不含 Next rewrite 前缀。

| Method | Fastify route | 结果 |
| --- | --- | --- |
| GET | `/companion/bootstrap` | 当前 session scope/account/feature 投影；`200` |
| POST | `/companion/conversations` | 创建 dialogue；`201` |
| POST | `/companion/inbox/ensure` | 幂等获取/创建唯一 inbox；首次 `201`，已有 `200` |
| GET | `/companion/conversations` | cursor 分页列表；`200` |
| GET | `/companion/conversations/:id` | conversation + active run snapshot；`200` |
| PATCH | `/companion/conversations/:id` | dialogue 标题/归档状态；`200` |
| DELETE | `/companion/conversations/:id` | 用户确认后的硬删除；`204`，幂等 |
| GET | `/companion/conversations/:id/messages` | `beforeSeq/limit` 分页；`200` |
| POST | `/companion/conversations/:id/turns` | 创建 user message/run/job；`202` |
| GET | `/companion/conversations/:id/events` | SSE；`200` |
| POST | `/companion/runs/:id/cancel` | 取消当前 run；`202/200` 幂等 |
| GET | `/companion/learning-context` | P5 只读菜单候选与 route；`200` |
| POST | `/companion/menu-proposals` | P5 从冻结候选原子选择/创建 dialogue 并创建确认；`201/200` 幂等 |
| POST | `/companion/proposals/:id/decision` | P5 确认/拒绝 typed action；`202/200` |
| GET | `/companion/proposals/:id` | P5 proposal + action run 恢复快照；`200` |
| POST | `/companion/deliveries/:id/viewed` | 标记显示；`200` 幂等 |
| POST | `/companion/deliveries/:id/dismiss` | dismiss；`200` 幂等 |
| GET | `/companion/export` | 用户自身 conversation 的 versioned NDJSON 导出；`200` |
| POST | `/learning-sessions/:id/companion-context-grants` | P5 当前 session 显式 grounded-tutor 短期 grant；`200` |
| POST | `/voice/transcribe` | P3 复用日常 ASR multipart；`200` |
| POST | `/voice/tts` | P3 复用 allowlisted TTS；`200 audio/mpeg` |

前十八条 `/companion/**` 是本方案新增/扩展的 Companion API；随后一条是 P5 在现有 Learning Session 模块新增的 context-grant route；末两条是既有 voice route，P3 必须按 §11 收紧而不是复制新 endpoint。所有 JSON request/response 使用本合同 shared schema；export 使用 §12 的逐行 strict union，音频 route 的 multipart/binary 例外仍使用严格字段、大小、MIME/magic-byte 和 response header 校验。

### 6.0 Bootstrap

```ts
const companionBootstrapResponseV1Schema = z.object({
  version: z.literal(1),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  account: companionAccountStateV1Schema,
  features: z.object({
    petSurface: z.boolean(),
    textConversation: z.boolean(),
    voiceDialogue: z.boolean(),
    live2d: z.boolean(),
    learningActions: z.boolean(),
    streamingVoice: z.boolean(),
  }).strict(),
  serverTime: z.string().datetime(),
}).strict();
```

route 只从 `requireSession` 的当前 scope 与现有 Companion account service 构造 response，不接受 query/body，不创建 conversation/inbox/message，不读取 provider。features 依次精确投影 `companion_pet_v1 / companion_dialogue_v1 / companion_voice_v1 / companion_live2d_v1 / companion_learning_actions_v1 / companion_streaming_voice_v1` 的服务端有效能力，不读取 `NEXT_PUBLIC_*`。使用 `Cache-Control: no-store`。`globalEnabled=false` 时仍返回 200 及新 epoch，renderer 清空正文并 report `global_off`；401/403 才是 auth failure。workspace switch 后必须重新请求，旧 scope stream/result 由 account epoch + workspace fence 拒绝。

### 6.1 Create conversation

Request：

```ts
const createCompanionConversationRequestV1Schema = z.object({
  version: z.literal(1),
  kind: z.literal("dialogue"),
  title: z.string().trim().min(1).max(120).optional(),
}).strict();
```

- client 不能创建 `inbox`；
- title 缺省为“新对话”；
- 最多 200 个 user-created dialogue conversations，唯一 inbox 不计入该上限；超限 `409 CONVERSATION_LIMIT_REACHED`；
- 创建不调用模型。

### 6.2 Ensure inbox

Request schema 固定为 `z.object({ version: z.literal(1) }).strict()`。该 route 只允许创建当前 session 的唯一 inbox，不接受 workspace/user/title；固定标题为“伴星消息”，后续不自动改名；在 RLS transaction 中使用 partial unique constraint 并处理并发冲突，返回 `CompanionConversationV1`。它不产生消息、event、预算或通知，不调用模型。

### 6.3 List

Query：`limit=1..50`，`cursor=<opaque>`，`kind=dialogue|inbox`、`status=active|archived` 可选。`kind` 缺省为 `dialogue`，`status` 缺省为 `active`；因此 Pet 选最近对话时不会误选 inbox。完整历史页显式请求 archived，inbox 优先使用 ensure 返回值。

Response：

```ts
const listCompanionConversationsResponseV1Schema = z.object({
  version: z.literal(1),
  items: z.array(companionConversationV1Schema).max(50),
  nextCursor: z.string().min(1).max(500).nullable(),
}).strict();
```

排序键固定为 `(COALESCE(lastMessageAt,createdAt) DESC,id DESC)`；不复用当前无签名 generic pagination cursor。Companion cursor payload 是 `canonicalJsonV1({version:1,workspaceId,userId,kind,status,sortAt,id,expiresAt})`，wire 为 `<base64url(payloadUtf8)>.<base64url(HMAC-SHA256(AUTH_SURFACE_MANIFEST_SECRET,"companion-conversation-cursor-v1:"+payloadUtf8))>`，有效期 24h、总长最多 500。decode 后 strict parse、constant-time 验签、scope/filter/expiry 全匹配才用于 keyset query；否则 `400 INVALID_CURSOR`，不接受客户端任意 SQL 排序字段。

### 6.4 Messages

Query：`limit=1..100`，`beforeSeq` 可选。按 seq 降序查询、response 按升序返回，UI prepend。

Response：

```ts
const listCompanionMessagesResponseV1Schema = z.object({
  version: z.literal(1),
  items: z.array(companionMessageV1Schema).max(100),
  hasMore: z.boolean(),
  oldestSeq: z.number().int().positive().nullable(),
}).strict();
```

Conversation patch request：

```ts
const patchCompanionConversationRequestV1Schema = z.object({
  version: z.literal(1),
  title: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["active", "archived"]).optional(),
}).strict().refine(
  (value) => value.title !== undefined || value.status !== undefined,
  { message: "at least one change is required" },
);
```

至少提供一个变更字段；只能修改 dialogue，inbox 标题/状态不可变。存在 active turn/action 时归档返回 `409 RUN_ALREADY_ACTIVE`；title 更新不调用模型，response 返回完整 `CompanionConversationV1`。

create/PATCH title 在长度检查前统一 NFC、去 C0/C1 控制字符、折叠 Unicode whitespace 并 trim；净化后为空则 `400 INVALID_REQUEST`。title 只按纯文本渲染，不解析 Markdown/HTML。

`GET /companion/conversations/:id` 的恢复快照固定为：

```ts
const companionConversationSnapshotV1Schema = z.object({
  version: z.literal(1),
  conversation: companionConversationV1Schema,
  activeRun: companionTurnRunV1Schema.nullable(),
  latestEventSeq: z.number().int().nonnegative(),
  pendingProposal: pendingLearningActionProposalV1Schema.nullable(),
  activeActionRun: companionActionRunV1Schema.nullable(),
}).strict();
```

P2–P4 的 `pendingProposal/activeActionRun` 必须为 `null`。API 在同一 repeatable-read snapshot 中读取 conversation、active run、重建 preview 和 `latestEventSeq`；renderer 原子替换 active projection/cursor 后，以 `after=latestEventSeq` 连接 SSE。snapshot commit 后产生的新 event 会被 replay，snapshot 之前的 TTS segment 不重播。若 active run 的 durable event 已异常缺失到无法重建 hash，API 返回 `500 INTERNAL_ERROR`、触发 content-free 运维告警且不返回猜测文本；GET 不顺带改写 run，终态修复只由显式 reconciliation job 执行。

Snapshot 故意不内嵌无界 message history。Dialogue renderer 按 02 固定流程随后请求无 `beforeSeq` 的最新 100 条 messages 做 ID/seq reconcile；inbox background runtime 不做该读取，proactive 正文仍只能由 §6.8 viewed response 交给 bubble。用户明确打开 Main inbox history 时才使用普通 messages API；这是用户主动读取，不是主动弹出 content claim。

### 6.5 Cancel

Request：

```ts
const cancelCompanionRunRequestV1Schema = z.object({
  version: z.literal(1),
  generation: z.number().int().positive(),
  reason: z.literal("user"),
}).strict();

const cancelCompanionRunResponseV1Schema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  status: companionRunStatusV1Schema,
}).strict();
```

- run 已终态 → 返回当前终态，`200`；
- generation 不符 → `409 STALE_GENERATION`；
- accepted/running → 原子写 `cancel_requested` 并通知 Worker，`202`；
- client 请求成功与否都可以本地停止 TTS，但只有 server event 决定 durable run 终态；
- Worker 每个 provider chunk 前检查 AbortSignal，取消后不得写新 delta/final。

### 6.6 P5 Proposal decision

Header：`Idempotency-Key: <UUID>`。

Request：

```ts
const proposalDecisionRequestV1Schema = z.object({
  version: z.literal(1),
  decision: z.enum(["confirm", "reject"]),
  expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
```

Response：

```ts
const proposalDecisionResponseV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  status: z.enum(["rejected", "accepted", "executing", "succeeded", "failed"]),
  actionRunId: z.string().uuid().nullable(),
  resultRef: z.string().min(1).max(240).nullable(),
  route: allowedMainRouteV1Schema.nullable(),
  safeSummary: z.string().min(1).max(240).nullable(),
}).strict();
```

- reject 原子写 decision，零业务副作用，返回 `200`；
- confirm 必须匹配 payload hash、pending 状态、TTL、当前 user/workspace、实时权限，且 conversation 无 active dialogue run；不匹配 fail closed，active run 返回 `409 RUN_ALREADY_ACTIVE` 且 proposal 保持 pending；reject 不受 active run 阻止；
- 纯导航 action 在 API 重新解析目标后可同步完成并返回 `200 succeeded`；
- session/tutor action 原子创建 action run + `companion_action` job，返回 `202 accepted`；
- 同 key 同 decision 返回同一结果；同 key 异参 `409 IDEMPOTENCY_CONFLICT`；已被另一 decision 消费返回当前状态，不重复执行；
- UI 只有收到 `action.completed` 或同步 succeeded response 才可展示完成，不能把 accepted/executing 写成已完成。
- route 只能由服务端根据重新解析后的真实对象构造并通过 `AllowedMainRouteV1` 校验；模型、proposal summary 和客户端不得提供 route。

`GET /companion/conversations/:id` 在 P5 额外返回当前 `pendingProposal` 和非终态 `activeActionRun`。`GET /companion/proposals/:id` response 固定为：

```ts
const companionProposalSnapshotV1Schema = z.object({
  version: z.literal(1),
  proposal: companionActionProposalV1Schema,
  actionRun: companionActionRunV1Schema.nullable(),
}).strict();
```

两者只返回当前 RLS scope 的 shared schema，不包含 job payload、内部错误或 Learning service 私有数据。Renderer reload/SSE cursor 过期时先取该快照再 replay。

### 6.7 P5 context grant、菜单学习候选与 proposal create

Grounded tutor 不能只信 turn body 的 `requestedCapability`。当前 Learning Session page 每次 mount 生成 `pageInstanceId`；用户在该 session UI 明确启用“让伴星根据当前内容回答”后，page adapter 调用 `POST /learning-sessions/:id/companion-context-grants`：

```ts
const createCompanionContextGrantRequestV1Schema = z.object({
  version: z.literal(1),
  pageInstanceId: z.string().uuid(),
  episodeId: z.string().uuid(),
  contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
```

API 在当前 session scope 重新解析 path session、episode/card/keyPoint 关系、当前 contextRevision、permissionSnapshot 与 assistance policy；assessment/answer-locked/ended/stale/跨 workspace 一律 fail closed。成功返回 `companionGroundedTutorGrantV1Schema`，`issuedAt=now/expiresAt=now+5min`，signature 为 `HMAC-SHA256(AUTH_SURFACE_MANIFEST_SECRET,"companion-grounded-tutor-grant-v1:"+canonicalJsonV1(payloadWithoutSignature))`，并带 `Cache-Control:no-store`。该 endpoint 不写 canonical 数据、不调用模型、不持久化 raw token；生产 secret 缺失拒绝签发。

Page adapter 把完整 grant 只附在下一次明确 user turn 的 learning_session context；离开 page/workspace、pageInstance 改变或 5min 到期立即从内存删除。Turn API 验签和重查后只保存 sanitized grantId/permission hash/expiry，并用 turn run 的 partial unique `context_grant_id` 原子消费；同一 grant 最多进入一个 turn/形成一个 proposal。`requestedCapability=grounded_tutor` 无 grant、字段不匹配、P5 flag off 或 grant 重放都返回 `409 ACTION_STALE`，零 assistant/action 副作用。

`GET /companion/learning-context` 不接受 query/body，返回 `companionLearningContextV1Schema`，只调用 Learning Session/service 的只读 public adapter，零 canonical write、零 conversation write、零模型调用。`resumeCandidate/startCandidate=null` 时对应菜单项 disabled；review/current card/star map 只调用 response 中的 typed IPC route。

“继续当前学习/开始一小段学习”不直接执行，也不让 renderer 自造 payload。Pet 先读取 context，再调用 `POST /companion/menu-proposals`，Header 为 `Idempotency-Key: <UUID>`：

```ts
const createMenuProposalRequestV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid().optional(),
  clientMessageId: z.string().uuid(),
  candidateId: z.enum(["resume_current", "start_short"]),
  expectedContextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSurface: z.enum(["pet", "main", "web_fallback"]),
}).strict();

const createMenuProposalResponseV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  proposal: pendingLearningActionProposalV1Schema,
  eventCursor: z.number().int().positive(),
}).strict();
```

API 在同一 RLS transaction 重新计算 context并精确验证 revision/candidate/payload hash。提供 conversationId 时验证其无 active run/其他 pending proposal；缺省时只在候选验证成功后原子创建一个 dialogue，再插入一条服务端确定性 user action message、一条带 `action_ref` 的 assistant confirmation message、proposal 和 `action.proposed` event，因此不会因 stale candidate 遗留空 conversation。任何验证失败零写入；同 key 同 body 返回同一 response，不同 body 返回 `IDEMPOTENCY_CONFLICT`。该 endpoint 只接受 resume/start 两类；纯导航直接 typed route，`ask_grounded_tutor` 只来自当前 session 的自然语言 proposal。创建 proposal 不等于确认，仍必须走 §6.6 decision。

两条模板正文逐字由服务端构造，不调用模型：user text 为 `resume_current → "请继续当前学习：${targetSummary}"`、`start_short → "请开始一小段学习：${targetSummary}"`；assistant text 为 `"建议：${title}\n目标：${targetSummary}\n影响：${impactSummary}\n确认后才会执行。"`。字段先通过 candidate schema 与 plain-text/control-character 净化，插值后再过 20,000 code-unit message schema。新建 dialogue 或既有 placeholder 的首条记录将 title 设为 candidate `title`（最多 80，`titleSource=auto`）；绝不生成“新对话”堆积或调用标题模型。

response 的 `eventCursor` 固定为该事务 `action.proposed` seq。proposal 可立即从 response 进入 store；cursor 仍只有恰为当前下一 seq 时才推进，已消费则去重，存在 gap 则按 02 获取 snapshot，不能直接跳 head。

### 6.8 Delivery viewed/dismiss

Pet 不得仅凭 SSE 中的 `messageId` 就把 proactive 正文渲染到气泡。每个 app process 生成一个随机 UUID `deviceSessionId`：Electron 由 main process 生成并经 preload 向 Main/Pet 提供同一个值，浏览器 fallback 存于当前 tab `sessionStorage`。请求使用 `X-Companion-Device-Session: <UUID>`；API 只保存 `HMAC-SHA256(AUTH_SURFACE_MANIFEST_SECRET, "companion-device-session-v1:" + lowercaseUuid)`，不记录原值。这里复用现有生产必配 secret 但使用 domain separation；生产缺失 secret 时 content claim fail closed，不得使用 auth-surface test-mode key。

`POST /companion/deliveries/:id/viewed` request：

```ts
const deliveryViewedRequestV1Schema = z.object({
  version: z.literal(1),
  presentation: z.enum(["content", "content_hidden"]),
}).strict();

const deliveryPresentationResponseV1Schema = z.object({
  version: z.literal(1),
  deliveryId: z.string().uuid(),
  status: z.enum(["shown", "suppressed", "dismissed", "expired"]),
  contentAllowed: z.boolean(),
  message: companionMessageV1Schema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.contentAllowed !== (value.message !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "message iff contentAllowed" });
  }
});
```

原子规则：

- expired/dismissed/suppressed 时返回对应终态与 `contentAllowed=false/message=null`；服务端 row `contentPolicy=content_hidden` 时无论 client 请求何种 presentation 都按 hidden presentation 原子置 shown/firstPresentedAt、从不写 claimant，并返回 `contentAllowed=false/message=null`；
- `presentation=content_hidden` 只记录 `first_presented_at/status=shown`，不领取正文；设备本地 privacy mode 必须走此分支；
- `presentation=content` 且尚无 claimant 时，原子写当前 device HMAC 并返回完整 proactive message；同一 HMAC 重试仍返回同一 message；其他 HMAC 只返回 `contentAllowed=false`；
- renderer 只有在 `contentAllowed=true` 后才把 response message 投影到 proactive bubble；完整历史页的用户明确读取不受“一次主动弹出正文”限制；
- 每次状态变化写 `proactive.delivery.updated` durable event；同参重试不重复写 event。

`POST /companion/deliveries/:id/dismiss` request 固定为 `z.object({ version: z.literal(1) }).strict()`，response 为 `{ version: 1, deliveryId, status: "dismissed" }` 的 strict schema。它原子置为 dismissed、写一次 updated event；expired/dismissed 重试返回当前终态，不恢复、不退还预算。

### 6.9 Error envelope

```ts
const companionPublicErrorCodeV1Schema = z.enum([
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONVERSATION_LIMIT_REACHED",
  "IDEMPOTENCY_CONFLICT",
  "RUN_ALREADY_ACTIVE",
  "STALE_GENERATION",
  "CURSOR_EXPIRED",
  "INVALID_CURSOR",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "TURN_CANCELLED",
  "VOICE_PERMISSION_DENIED",
  "VOICE_AUDIO_TOO_LARGE",
  "VOICE_UNSUPPORTED_FORMAT",
  "ASR_FAILED",
  "TTS_FAILED",
  "ACTION_CONFIRMATION_REQUIRED",
  "ACTION_EXPIRED",
  "ACTION_STALE",
  "ACTION_ALREADY_DECIDED",
  "INTERNAL_ERROR",
]);

type CompanionPublicErrorCodeV1 = z.infer<typeof companionPublicErrorCodeV1Schema>;

const companionErrorV1Schema = z.object({
  version: z.literal(1),
  error: companionPublicErrorCodeV1Schema,
  message: z.string().min(1).max(240),
  recoverable: z.boolean(),
  requestId: z.string().min(1).max(100),
}).strict();
```

public message 不含 stack、SQL、host、provider body、模型原文、密钥名或用户私密文本。

`requireSession` 成功后的所有 Companion handler failure 都返回上述 envelope。为复用当前身份中间件且不扩大 P2 修改面，认证 preHandler 保留唯一、明确的 legacy wire exception：401 为 `{ error:"missing token"|"invalid token" }` 并带 `WWW-Authenticate: Bearer`，cookie mutation 的 CSRF 403 为 `{ error:"csrf token required" }`。Companion client transport 必须只在这一层把它们归一为 `UNAUTHENTICATED/FORBIDDEN`，业务 reducer 永远只接收 `CompanionErrorV1`；不得把该例外扩展到 route handler、SSE cursor 或 provider 错误。

### 6.10 P2 初始限额

- Pet/Web fallback composer 在客户端最多 `4,000` 字符，Main 完整对话最多 `20,000`；server 对所有不可信 `sourceSurface` 统一执行 `20,000` 硬上限，不能靠伪造 surface 绕过权限或其他限额；
- create turn：每 `(workspace,user)` `12/min`、`120/hour`，且最多 3 个不同 conversation 同时 active；每 conversation 仍最多 1 个 active run；
- create conversation：每用户 `10/min`，总量上限见 §6.1；
- bootstrap + conversation list/snapshot/messages/proposal snapshot 合并 `120/min`；PATCH/DELETE conversation 合并 `20/min`；inbox ensure `30/min`；cancel `30/min`；delivery viewed+dismiss 合并 `60/min`；proposal decision `20/min`；全部按 `(workspace,user)`；
- P5 learning-context 每用户 `30/min`；menu-proposal 与 create turn 共用 `12/min` 写预算，且每 conversation 仍最多一个 pending proposal；
- P3 ASR `10/min`、`60/hour`、每用户最多 1 个并发 upload；Companion TTS `60/min`、每用户最多 2 个并发 synthesis，仍受每 run 20 segment/2,000 字上限；正式学习 voice 使用其既有独立预算；
- export 每用户最多 `3/hour` 且同一时刻最多一个；当前 scope 任一 dialogue turn 非终态时，在发送 NDJSON headers 前返回 `409 RUN_ALREADY_ACTIVE`，不输出缺失中的 assistant preview；
- provider/workspace 预算继续由既有 AI governance 决定；HTTP 限额通过不代表 provider 调用获准；
- 达限返回 `429 RATE_LIMITED` + `Retry-After`，不创建 message/run/job/event，不让客户端忙重试。

---

## 7. 数据库合同

实现时迁移编号取当前真实下一个值；本文不用固定 `0088`，避免与并行工作冲突。

P2 在同一 conversation foundation migration 中创建 §7.1–§7.6 六张表。`companion_voice_artifacts` 在 P2 保持空表且没有写路径，P3 才启用 provenance 写入；这样 P3 不需要临时改变已经验收的 conversation/RLS 基础。P5 的 `companion_action_proposals` 与 `companion_action_runs` 必须使用独立新迁移。

### 7.1 `companion_conversations`

| 列 | 类型/约束 |
| --- | --- |
| `id` | uuid PK |
| `workspace_id` | uuid NOT NULL FK workspaces |
| `user_id` | uuid NOT NULL FK users |
| `kind` | text CHECK `dialogue/inbox` |
| `title` | text NOT NULL，1..120 |
| `title_source` | text CHECK `placeholder/auto/user/system` |
| `status` | text CHECK `active/archived` |
| `next_message_seq` | bigint NOT NULL default 1 |
| `next_event_seq` | bigint NOT NULL default 1 |
| `next_generation` | integer NOT NULL default 1 |
| `summary_text` | text nullable，max 20k；P2 必须为 null，预留未来版本 |
| `summary_version` | integer NOT NULL default 0；P2 恒为 0 |
| `last_message_at` | timestamptz nullable |
| `created_at/updated_at` | timestamptz NOT NULL |

索引/约束：

- expression index `(workspace_id,user_id,COALESCE(last_message_at,created_at) DESC,id DESC)`；
- partial unique `(workspace_id,user_id)` WHERE `kind='inbox' AND status='active'`；
- `next_* >= 1` checks。

### 7.2 `companion_messages`

| 列 | 类型/约束 |
| --- | --- |
| `id` | uuid PK |
| `workspace_id/user_id` | uuid NOT NULL |
| `conversation_id` | uuid NOT NULL FK cascade |
| `seq` | bigint NOT NULL |
| `role/kind` | bounded text CHECK |
| `blocks` | jsonb NOT NULL，写前 shared schema 校验 |
| `run_id` | uuid nullable |
| `client_message_id` | uuid nullable |
| `content_sha256` | char(64) NOT NULL |
| `created_at/edited_at` | timestamptz |

约束：

- unique `(conversation_id,seq)`；
- unique `(conversation_id,client_message_id)` WHERE not null；
- `(conversation_id,seq DESC)` index；
- DB trigger/应用事务验证 child workspace/user 与 conversation 一致；
- blocks 不进入全文日志；P0–P6 不建立 Companion 全文/全局搜索索引，也不提供搜索 endpoint。

### 7.3 `companion_turn_runs`

| 列 | 类型/约束 |
| --- | --- |
| `id` | uuid PK |
| `workspace_id/user_id/conversation_id` | uuid NOT NULL |
| `user_message_id` | uuid NOT NULL |
| `assistant_message_id` | uuid nullable |
| `job_id` | uuid nullable/unique |
| `generation` | integer NOT NULL |
| `status` | bounded text CHECK |
| `idempotency_key_hash` | char(64) NOT NULL |
| `request_body_hash` | char(64) NOT NULL |
| `provider_id/model_id/prompt_version` | bounded text nullable |
| `page_context` | jsonb nullable；strict `CompanionPersistedPageContextV1`，不含 raw grant signature/DOM/draft |
| `context_grant_id` | uuid nullable；仅 grounded tutor 非空，partial unique where not null |
| `router_intent/router_confidence_bps` | P5 migration 添加；bounded intent nullable / integer 0..10000 nullable |
| `router_prompt_version/router_prompt_sha256` | P5 migration 添加；bounded text / char(64) nullable |
| `router_context_revision/router_payload_sha256` | P5 migration 添加；char(64) nullable，只有已构造 candidate 时非空 |
| `cancel_requested_at` | timestamptz nullable |
| `error_code` | bounded text nullable |
| `started_at/finished_at/created_at/updated_at` | timestamptz |

约束：

- unique `(conversation_id,generation)`；
- unique `(conversation_id,idempotency_key_hash)`；
- partial unique active run per conversation where status in accepted/running/cancel_requested；
- assistant message 只能在 succeeded 时非空；
- 终态不可回退，由 service/DB check test 保证。

### 7.4 `companion_stream_events`

| 列 | 类型/约束 |
| --- | --- |
| `conversation_id` | uuid NOT NULL FK cascade |
| `seq` | bigint NOT NULL |
| `workspace_id/user_id/run_id` | scoped ids |
| `generation` | integer NOT NULL |
| `account_epoch` | integer NOT NULL |
| `type` | bounded text CHECK |
| `payload` | jsonb NOT NULL，shared union 校验 |
| `created_at` | timestamptz NOT NULL |
| `expires_at` | timestamptz NOT NULL |

主键 `(conversation_id,seq)`；index `(expires_at)`。默认终态后保留 24 小时，cleanup 幂等批量删除。消息和 run 不随 event TTL 删除。

Dialogue run 的 event 在 run 非终态时使用 PostgreSQL `infinity`，终态事务把该 run 全部 event 的 `expires_at` 原子改为 `finished_at + 24h`；inbox delivery/update event 创建时直接为 `created_at + 24h`。cleanup 不得删除 active run event，因此 snapshot 的 active preview 必须始终可重建。删除后形成的 cursor 缺口按 §5.3 返回 `CURSOR_EXPIRED`，不能悄悄从现存最早 event 接着拼。

### 7.5 `companion_voice_artifacts`

日常 voice 只保存 provenance，不保存 raw audio：

| 列 | 类型/约束 |
| --- | --- |
| `id` | uuid PK |
| `workspace_id/user_id` | uuid NOT NULL scoped ids |
| `conversation_id/message_id` | uuid nullable，attached 时 NOT NULL 并指向同 scope companion row |
| `status` | text CHECK `pending/attached/expired` |
| `transcript_sha256` | char(64) NOT NULL |
| `asr_provider/asr_model/language` | bounded text NOT NULL |
| `duration_ms` | integer NOT NULL CHECK `200..60000` |
| `raw_audio_persisted` | boolean NOT NULL default false，CHECK 必须为 false（P3） |
| `expires_at/attached_at/created_at` | timestamptz |

正式学习 Voice Artifact 继续使用现有 learning 表，绝不复用此表。

Companion ASR 成功后创建 `pending` provenance，默认 `expires_at=created_at+1h`；它不保存 transcript 正文，只保存 hash。turn create 在同一事务以 `FOR UPDATE` 验证 scope/status/expiry/hash 后绑定 conversation/message 并置 `attached`；同一个 artifact 只能绑定一次。未提交或失败的 pending row 到期置 expired/清理。正式学习现有 ASR 调用不写本表。

DB CHECK 固定：pending/expired 的 conversationId/messageId/attachedAt 均 null；attached 三者均非 null；`message_id` partial unique where attached；child scope 与 message/conversation 相同。attached 后 expiry 只作原始 pending provenance，不再触发清理；只有未绑定 pending 到期转 expired 后可按 retention cleanup。

### 7.6 `companion_proactive_deliveries`

| 列 | 类型/约束 |
| --- | --- |
| `id` | uuid PK |
| `workspace_id/user_id` | scoped ids |
| `permit_id` | bounded text/uuid，unique |
| `conversation_id/message_id` | inbox refs |
| `reason_id` | 现有 bounded trigger reason |
| `suggestion_class_id` | bounded registry id |
| `content_policy` | text NOT NULL CHECK `content/content_hidden`；创建时冻结 |
| `status` | pending/shown/suppressed/dismissed/expired |
| `content_claimed_device_session_hash` | nullable char(64)，domain-separated HMAC-SHA256 |
| `expires_at/first_presented_at/shown_at/dismissed_at/created_at` | timestamptz |

预算和 active suggestion lease 仍由现有 companion trigger ledger 管理，本表不复制另一套预算系统。

`first_presented_at` 可在无正文占位首次出现时写入；`shown_at` 记录正文首次成功 claim。`status=shown` 不等于正文已 claim，是否可返回正文只看 `content_claimed_device_session_hash`、server policy、TTL 与 dismiss 状态。`suppressed` 是 quietHours/DND 下的终态历史记录，不向 Pet 发 delivery event，也不能后补弹出。所有 viewed/dismiss 竞争使用 row lock/单事务，不能先读后写。

### 7.7 P5 `companion_action_proposals`

P2/P3 不创建该表；P5 使用独立 migration。

| 列 | 类型/约束 |
| --- | --- |
| `id` | uuid PK |
| `workspace_id/user_id/conversation_id` | scoped ids，NOT NULL |
| `source_message_id` | uuid NOT NULL FK companion_messages |
| `source_generation` | integer NOT NULL CHECK `>=0` |
| `context_grant_id` | uuid nullable；仅 grounded tutor 非空 |
| `kind` | 第一批 action kind CHECK |
| `payload` | jsonb NOT NULL，shared payload schema 校验 |
| `payload_sha256` | char(64) NOT NULL |
| `title` | text 1..80 |
| `target_summary` | text 1..160 |
| `impact_summary` | text 1..240 |
| `status` | pending/rejected/accepted/executing/succeeded/failed/expired |
| `expires_at` | timestamptz NOT NULL |
| `decision` | confirm/reject nullable |
| `create_key_hash/create_body_hash` | char(64) nullable；菜单 proposal create 幂等，模型内联 proposal 为 null |
| `decision_key_hash` | char(64) nullable |
| `decision_body_hash` | char(64) nullable；用于同 key 异参冲突 |
| `decided_at` | timestamptz nullable |
| `created_at/updated_at` | timestamptz NOT NULL |

约束：

- unique `(conversation_id,source_message_id,payload_sha256)`；
- partial unique `context_grant_id` WHERE not null，防同一 grounded grant 跨 conversation 重放；
- unique `create_key_hash` within `(workspace_id,user_id)` where not null；同 key 必须比较 `create_body_hash`；
- unique `decision_key_hash` within `(workspace_id,user_id)` where not null；同 key 必须比较 `decision_body_hash`；
- 每个 conversation 最多一个 `pending` proposal；
- pending 以外不得改变 payload/hash/summary/expiry；
- reject/expired 不能创建 action run；
- 普通对话表不得保存 mastery/scheduler mutation payload。

### 7.8 P5 `companion_action_runs`

| 列 | 类型/约束 |
| --- | --- |
| `id` | uuid PK |
| `workspace_id/user_id/conversation_id` | scoped ids，NOT NULL |
| `proposal_id` | uuid NOT NULL UNIQUE FK companion_action_proposals cascade |
| `job_id` | uuid nullable UNIQUE |
| `status` | accepted/running/succeeded/failed/cancelled |
| `result_message_id` | uuid nullable UNIQUE FK companion_messages；仅 succeeded 非空 |
| `result_ref` | bounded text nullable；只保存 Learning service opaque ref |
| `route` | jsonb nullable；只保存 shared `AllowedMainRouteV1` |
| `safe_summary` | text nullable，max 240 |
| `error_code` | bounded text nullable |
| `started_at/finished_at/created_at/updated_at` | timestamptz |

- confirm transaction 同时更新 proposal、创建 action run，并在慢动作时创建 `companion_action` job；
- navigation action 也创建 action run，但在同一事务直接 succeeded、`job_id=null`，并创建唯一 durable result message；
- session/tutor action 只能通过 Learning service 公共入口变更状态；
- action run 终态不可回退，retry 创建新 proposal，不复活旧 run；
- `action.completed.resultRef` 非空时必须来自该表和真实 Learning service result；navigation 可为 null，任何值都不能由模型生成。

---

## 8. RLS、事务与权限

P2 的六张表及 P5 新增的 proposal/action run 表都必须：

- `ENABLE ROW LEVEL SECURITY`；
- `FORCE ROW LEVEL SECURITY`；
- policy 同时匹配：

```sql
workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
```

- API 所有业务读写使用 `withWorkspaceTransaction({workspaceId,userId})`；
- Worker 使用受限角色与 `withWorkerWorkspaceTransaction`；
- worker 不获得跨 workspace SELECT；队列 claim 继续只通过既有 SECURITY DEFINER 函数；
- insert child 前重新查询 parent scope，不能信任 body 中 workspace/user；
- migration 必须有 fresh/upgrade/repeat/restore 和 API/Worker role matrix integration；
- schema mirror、Drizzle schema、migration 和 RLS grant 同一阶段更新；
- readiness 最低迁移门槛按项目现行机制更新；
- DELETE conversation 在一个 RLS transaction 中 cascade message/run/event/voice/delivery/proposal/action run，content-free audit 只记录 deletion outcome/hash。

全部 `/companion/**` route 注册现有 `requireSession`；cookie-authenticated POST/PATCH/DELETE 必须通过其既有 `ailearn_csrf` + `x-csrf-token` constant-time double-submit 检查，renderer 复用 `apps/web/lib/api.ts` 的 request/CSRF helper，不手写漏 header 的 fetch。GET/SSE/export 仍要求 session 与 RLS，但不产生 mutation（inbox ensure 明确使用 POST）；Bearer 行为保持现有 middleware 语义。任何 Companion route 都不得另开无 CSRF 的 cookie mutation shortcut。

### 8.1 原子 turn 创建

同一 transaction：

1. lock conversation row；
2. 验证 active/owner/workspace；
3. 查 idempotency hash；
4. `inputKind=voice_transcript` 时 lock/验证 pending voice artifact 的 scope、TTL 与 transcript hash；text 时拒绝任何 artifact id；验证可选 page context，P5 grounded grant 必须验 HMAC/scope/TTL/字段/policy；
5. 若有 active run，按 request 的 `supersedesGeneration` 精确匹配并将旧 run 置为 superseded，先写其 `turn.cancelled` event；
6. 分配 message seq 和新 generation；
7. 以 request `inputKind` 插入 user message；若为 voice，在同一事务把 artifact 绑定该 message 并置 attached；
8. conversation 仍为 `title_source=placeholder` 且这是首条 message 时，按 §3.1 原子生成 auto title；
9. 插入 turn run，并只写 sanitized `page_context`；raw request context/grant signature 不落库；
10. 插入 `companion_dialogue` job；
11. 更新 conversation counters/lastMessageAt；
12. 插入新 run 的 `turn.accepted` event；
13. commit 后返回 202。

任一步失败全部回滚。

### 8.2 原子 stream append 与中断恢复

Worker claim 后先在 RLS transaction lock run/conversation，验证 job lease、active generation 和未取消状态，把 run 从 accepted 置 running，并写 `assistant.status(thinking)`；确定性 character cue 可在同一事务使用下一 event seq。provider 输出先通过 Unicode scalar 清理（孤立 surrogate 替换为 `U+FFFD`），再由 Worker 单一缓冲器聚合；至少满足其一就 flush：`50ms`、`256` 个 UTF-16 code unit、句子边界或 provider done，单 event 仍不得超过 `2,000` code unit，总 preview 不超过 `20,000` code unit。

每次 flush 使用短 RLS transaction：

1. lock run/conversation，重新验证 lease、active generation 与 `accepted/running` 状态；
2. 以已 durable delta 按顺序重建的 UTF-16 code unit 长度作为 `appendFrom`，与 Worker 本地累计值不符就 fail closed；`appendFrom`、`assistant.final.textLength` 和客户端比较全部使用 JavaScript `text.length`，hash 仍使用 UTF-8 bytes；
3. 分配 event seq，插入一个 `assistant.delta`；首个 delta 可紧随一个确定性 `character.cue`，P3 的稳定句 `voice.segment.ready` 必须在其正文对应 delta 之后使用连续 seq 写入同一事务；
4. commit 后发只含 conversationId/maxSeq 的 NOTIFY；cancel/supersede 在 lock 后获胜时不写任何新正文并 abort provider。

同一 run 只允许一个持 lease 的 stream writer。Worker/API crash 后的处理冻结为：尚无 durable `assistant.delta` 时 job 可按既有次数重试；已经有任一 delta 时不得从头重放 provider 或猜 continuation，reaper/下一次 claim 必须把 run 原子置 failed、内部码 `STREAM_INTERRUPTED`、写 public `error(PROVIDER_UNAVAILABLE,recoverable=true)`，并把该 run events 的 expiry 改为 terminal+24h。客户端保留已显示 preview 到错误 bubble 切换，但 reload 后不把 partial 伪装成 final history；用户 retry 创建新 generation。

P5 classifier 通过并构造 pending action candidate 时启用 `proposalFence` 例外：persona output 只在 Worker 内存中 bounded buffer，不提前写 delta/TTS。provider done 后 §8.3 先重算 candidate revision/payload/权限；仍精确有效才在一个 transaction 写 buffered delta event range → assistant.final → proposal/action.proposed。若 stale/无权限/已有 pending proposal，整个 turn 以 public `ACTION_STALE/recoverable=true` 失败，零 assistant final/proposal/action_ref，用户不会先看到一段声称可确认却没有 confirmation 的文本。普通聊天与 intent none 仍按上面的真流式 append。

provider 完成、超限、异常、cancel 与 final 均必须经同一个 terminalizer；provider 输出将超过 20,000 UTF-16 code unit 时停止读取并以内部 `PROVIDER_OUTPUT_LIMIT`、public `PROVIDER_UNAVAILABLE/recoverable=true` 终止，不把截断正文伪装成 final。任一 terminal transaction 失败，job 不得先 ack。这样 Worker 重启的可恢复语义是“无重复、明确失败后可重试”，不是假装同一模型流可无缝续写。

### 8.3 原子 final

Worker transaction：

1. lock run/conversation；
2. 校验 lease、generation、非 cancel/superseded；
3. 分配一个 message seq，以及可选 proposalFence buffered deltas、`assistant.final`、可选 `action.proposed` 所需的连续 event seq range；
4. 插入 assistant final message；
5. P5 若 router 产生 candidate：重新计算 context/权限并精确匹配 revision/payload hash，确认当前 conversation 无其他 pending proposal；通过才插入 proposal并在同一 assistant message 加 `action_ref` block，失败按 proposalFence 零可见 final；
6. run → succeeded，记录 provider/prompt metadata；
7. proposalFence 时先按 2,000 code-unit 上限插入 buffered `assistant.delta` range；随后插入 `assistant.final`，再插入 `action.proposed`（如有）；全部在同一 commit 对外可见；
8. 更新 conversation lastMessageAt；
9. commit；
10. 发 opaque NOTIFY。

取消与 final 竞争时只允许一个终态获胜。

### 8.4 P5 原子菜单 proposal create

同一 RLS transaction：

1. 校验 create idempotency key/body hash；命中同参直接返回原 response；
2. 通过 Learning service 只读 adapter 重新计算 context revision 与 candidate payload/hash；任一 stale/无权限零写入；
3. conversationId 存在时 lock 并验证 active、owner/workspace、无 active dialogue run/无 pending proposal；缺省时验证 conversation limit 后以 candidate title/`title_source=auto` 创建 dialogue；
4. 分配两条 message seq 与一个 event seq；
5. 插入服务端模板化 user action message；
6. 插入带 `action_ref` 的 assistant confirmation message 与 proposal，sourceMessageId 指向该 assistant message；
7. 写 `action.proposed` event、create key/body hash并更新 conversation；既有 conversation 若仍为 placeholder 且这是首条记录，同事务改为 candidate title/auto；
8. commit 后 opaque NOTIFY，返回 201；重放返回 200。

### 8.5 P5 原子 proposal decision

Confirm/reject 使用同一类 RLS transaction：

1. lock proposal；
2. 校验 owner/workspace、status、TTL、payload hash 和 decision idempotency；confirm 另验证 conversation 无 active dialogue run；
3. reject：写 rejected/decision metadata，插入 `action.decision(reject)` 后结束，零业务副作用；
4. confirm：重新解析所有 entity ref 与权限，不信任 summary；
5. 创建唯一 action run；
6. navigation：生成 `AllowedMainRouteV1` 与确定性 safeSummary，预生成 result message id，插入 `assistant/result` message（safe text + result_ref），action run/proposal → succeeded，写 decision + started + completed event并更新 lastMessageAt；
7. session/tutor：插入 `companion_action` job，proposal/run → accepted，写 `action.decision(confirm)` 后 commit；Worker claim 后写 started；
8. Worker 只通过 Learning service 公共入口执行；成功时以真实 resultRef/route 和确定性 safeSummary 原子插入唯一 `assistant/result` message、更新 run/proposal/lastMessageAt 并写 completed event，失败时只写 failed 状态/event、不伪造 result message；
9. commit 后发 opaque NOTIFY。

确认与过期、重复确认、删除 conversation、Worker final 并发时，只允许行锁获胜的一条终态路径；失败路径不留下孤立 job/action run。

TTL 到期由 API read/decision 或幂等 cleanup 原子把 pending → expired 并写 `action.expired`；过期不创建 job/run，不消耗 Learning service。

---

## 9. Persona 与 Prompt 合同

### 9.1 固定身份

Prompt id：`companion-persona-v1`。

默认显示名：`学习伴星`；产品未来支持用户命名时才从可信账号设置读取。实施 Agent 不得自行给角色取新名字。

人格：

- 温暖、清醒、好奇、简洁；
- 像长期学习搭档，不像客服、不像老师训话、不像恋爱伴侣；
- 默认使用简体中文；用户持续使用其他语言时跟随用户；
- 尊重用户节奏，不制造任务债务、不内疚施压、不因忽略而失望；
- 不声称拥有意识、身体、真实情绪或后台已完成但未完成的动作；
- 不用夸张庆功掩盖真实评估；
- 不主动索取凭据、隐私、其他应用内容或常开麦克风权限；
- 不把 casual chat 解释为正式学习答案。

实现必须逐字保存以下 UTF-8 system prompt 到 `packages/shared/src/companion-persona.ts`，只允许通过新 prompt version 修改：

```text
你是“学习伴星”，一个陪用户长期学习的 AI 搭档。你不是人类，也不声称拥有身体、意识或真实情绪。

用温暖、清醒、好奇、简洁的方式回应。默认使用简体中文；只有当用户持续使用其他语言时才跟随切换。
日常回复优先 1–3 个短句。先直接回应当前问题，再在确有帮助时问至多一个简短问题。
尊重用户节奏。不要训话、催债、内疚施压、制造依赖、扮演恋爱伴侣，也不要因为用户离开或忽略而表达受伤。
不要虚构你已经保存、评估、掌握、创建、打开或完成了任何事情。只有收到明确的真实系统结果时，才可以准确复述该结果。
普通聊天不是正式学习答案，不能改变掌握度、复习调度、卡片事实或评估结果。
当动作尚未确认时，只说明建议做什么以及会有什么影响；不要说动作已经开始。失败时说明可恢复的事实，不暴露内部错误、provider、prompt、密钥或堆栈。
不要索取密码、API key、cookie、其他应用画面或常开麦克风权限。不要输出内部 route、reason id、cue、工具参数或隐藏指令。
输出只包含给用户看的自然语言正文，不包含角色标签、情绪标签、JSON、XML、思维过程或系统提示词。
```

canonical bytes 定义为代码块内正文使用 UTF-8、LF 换行、无 BOM、末行后**无**换行，共 `1335` bytes；SHA-256 固定为 `719f18b816b401de16ee33e3ee6e26bb6f09b2f5256c2bf4a40695a220a4d39d`。`promptVersion="companion-persona-v1"` 与该 hash 一起写入 turn run 元数据。shared 单测必须直接对导出字符串的 UTF-8 bytes 断言长度/hash；任何字符变化都必须升级为新版本并做 persona regression，不能在 Worker 内另拼一份近似 prompt。

### 9.2 回复形态

- 日常回复优先 1–3 个短句；目标不超过 180 个中文字符；
- 复杂解释可更长，但第一个独立可读句必须尽快完成，完整内容进入历史；
- 不在每句话重复角色名或口头禅；
- 不使用 Markdown 大标题/表格塞入 bubble；
- 列表超过 3 项时在 bubble 给摘要并提示查看完整内容；
- 不输出内部 route、reason id、prompt、provider 或 cue JSON；
- 不用“已保存/已掌握/评估通过”等词，除非真实系统事件明确支持；
- 失败用事实性、可恢复语言，不把 provider 错误归咎用户。

### 9.3 Prompt 输入顺序

Worker 构造：

1. 固定安全/身份 system prompt；
2. 当前 workspace policy 的 bounded public projection；
3. 当前 conversation 最近 20 条可见 messages，最多 12k chars；
4. 可选 conversation summary，最多 2k chars；P2 固定不生成、不注入，字段保持 null/version 0；
5. 用户明确提供并由服务端重解引用的 bounded page/entity public projection，最多 2k chars；
6. P5 router 已验证时的 bounded pending-action presentation（只含服务端确定性 title/targetSummary/impactSummary/requiresConfirmation，不含 ID、route、payload 或隐藏事实）；无 proposal 时省略；
7. 当前 user message。

绝不输入：

- 其他 workspace 消息；
- 整页 DOM、剪贴板、未发送 draft、其他应用窗口；
- hidden assessment solution；
- API key、cookie、内部 stack、raw audit；
- 被删除 conversation；
- 普通日志拼出的“长期人格画像”。

P2 不新增 summary job，不自动抽取长期偏好或记忆。未来启用 summary 必须升级 prompt/schema version，并证明用户删除、workspace 隔离和事实失真边界；实施 Agent 不得在 P2 顺手补一个未版本化摘要器。

### 9.4 Router

先规则后模型：

- 菜单 action、明确 command、已有 session id 使用确定性 router；
- P2 模型只生成 `casual_chat` 或不触发 mutation 的 `learning_question` 文本；
- P5 以前，自然语言“开始学习/继续学习”只返回可解释的 disabled/open-main 提示，不执行 canonical action；
- P5 模糊 action classification 必须输出 shared typed route，经 server schema 验证；
- 模型不能生成 trigger reason、budget key、route URL、SQL 或 arbitrary tool name。

P5 action classifier 只输出 intent，不输出 payload/ID/question/route：

```ts
const companionActionIntentV1Schema = z.object({
  version: z.literal(1),
  intent: z.enum([
    "none",
    "resume_current",
    "start_short",
    "open_review",
    "open_current_card",
    "open_star_map",
    "ask_grounded_tutor",
  ]),
  confidence: z.number().min(0).max(1),
}).strict();
```

调用顺序冻结为：

1. 明确菜单点击不调用 classifier，按 §6.7 处理；
2. 普通 turn 先做 NFC/trim/lowercase，仅当正文包含 bounded action lexeme `继续/恢复/开始/打开/进入/回到/带我去/帮我开始/帮我继续/continue/resume/start/open/go to`，或已解析的 learning_session context 明确 `requestedCapability=grounded_tutor` 时才调用 classifier；否则 intent=`none`；
3. classifier input 只含原始 user text 与服务端布尔 `availableIntents`，不含 entity ID、隐藏学习答案或其他应用信息；
4. 只有 schema 合法、`confidence>=0.90`、intent 当前 available 时才由服务端候选构造 payload；其余全部回落普通文字，不猜 ID；
5. 自然语言 navigation 也生成待确认 proposal；只有菜单中明确点击的 review/card/star-map 走直接 typed route；
6. `ask_grounded_tutor` 只有当前 Learning Session 显式 UI 设置 `requestedCapability=grounded_tutor`、服务端重新确认 session/episode 正在进行且允许 assistance 时才 available；payload question 直接使用当前 user text，不采用模型改写，仍需 proposal confirmation。

classifier prompt id 为 `companion-action-router-v1`，正文固定为：

```text
你是学习伴星的动作意图分类器。只判断用户是否明确请求一个可用动作，不回答问题，不生成任何 ID、参数、路线或解释。
可选 intent 只有：none、resume_current、start_short、open_review、open_current_card、open_star_map、ask_grounded_tutor。
如果用户只是在讨论、提问、假设、否定、引用别人、表达未来可能性，或请求不明确，选择 none。
只有 availableIntents 中为 true 的动作才可选择；否则选择 none。
输出必须严格符合给定 JSON schema，不得添加字段。
```

canonical bytes 同样使用 UTF-8/LF/无 BOM/末行无换行，共 `578` bytes，SHA-256 `99122a340328bbf248e3f3e434d27eebd6445226db6c2e0f1bb50543555b0dde`。参数固定 `{ capability:"text_generation", temperature:0, maxTokens:80, responseFormat:"json", promptVersion:"companion-action-router-v1" }`。失败/timeout/invalid JSON 永远回落 `none`，不影响正文回复。该内部结果只在 run row 保存 intent、`Math.round(confidence*10000)`、promptVersion/hash，以及候选存在时的 contextRevision/payloadHash；不保存 classifier prompt body 或重复 user text。

Classifier 在 persona generation **之前**调用，system message 仅为上述冻结 prompt，唯一 user message 是 `canonicalJsonV1` 的下列 strict value；不传 conversation history：

```ts
const companionActionClassifierInputV1Schema = z.object({
  version: z.literal(1),
  userText: z.string().min(1).max(4_000),
  availableIntents: z.object({
    resume_current: z.boolean(),
    start_short: z.boolean(),
    open_review: z.boolean(),
    open_current_card: z.boolean(),
    open_star_map: z.boolean(),
    ask_grounded_tutor: z.boolean(),
  }).strict(),
}).strict();
```

通过 `0.90`/availability Gate 后，服务端从只读 Learning adapter 构造 payload/hash/title/target/impact；模型结果不提供这些字段。Worker 在首个 persona provider call 前以 run row lock 只写一次上述 router decision，retry 若字段已存在必须复用并重新验证其 revision/hash，不得重新分类成另一动作。该 pending-action presentation 才进入同一 turn 的 persona prompt §9.3，最终 assistant 文本和 proposal 在 §8.3 同事务落库。classifier/main 任一 provider 调用仍走 workspace budget；classifier 失败视为 none，main 失败则整个 turn 失败且不留下 proposal。

### 9.5 模型参数

P2 默认：

```ts
{
  capability: "text_generation",
  temperature: 0.9,
  maxTokens: 700,
  responseFormat: "text",
  promptVersion: "companion-persona-v4"
}
```

Provider 特定参数仍由 platform config/adapter 控制。运行时不得硬编码某个模型名称。

> **修订（2026-08-24，AI 设计审查 §4.2）**：本节原钉 v1/0.6/600。实际演进：persona 经 v2（音频适配）→ v3（桌宠风格）→ **v4**（prompt 减负——移出语音标签全表、内嵌 few-shot 示例；标签改由 worker 确定性语气层在 TTS 文本上注入，见 `workers/ai-worker/src/lib/companion-tone.ts`）；temperature 现为 0.9、maxTokens 700。§9.1 的 v1 为历史首版；当前生效 prompt id 以 `companion_turn_runs.prompt_version` 实际写入为准。

---

## 10. 主动消息合同

### 10.1 唯一触发来源

必须复用：

```text
apps/api/src/modules/companion-shell/trigger-arbitration.ts
apps/api/src/modules/companion-shell/presence-control.ts
packages/shared/src/companion-shell-contracts.ts
```

合法 reason 仅为当前 bounded registry：

```text
resume_paused_task
recoverable_error_explanation
canonical_stale_change
committed_change_display
long_absence_resume
active_tier_next_step
```

LLM、客户端、Pet renderer 均不能创建新 reason。

### 10.2 Presence 行为

| Presence | 主动消息 |
| --- | --- |
| quiet/未选择 | 0；仅用户主动召唤 |
| moderate | `resume_paused_task`、`recoverable_error_explanation`、`canonical_stale_change`、`committed_change_display`、`long_absence_resume` |
| active | moderate 的五项 + `active_tier_next_step` |

现有固定抑制链、stable page budget、reason budget、suppressed class、suggestionPause 和 account-scoped active lease 是唯一准入。不得在 Pet 再写一套“AI 自己判断要不要提醒”。

### 10.3 Delivery 事务

在 trigger permit 成功后，同一 workspace transaction：

1. 验证 account globalEnabled/presence/notification boundary/account epoch；
2. 验证 permit 未消费/未过期；
3. 获取或创建唯一 inbox conversation；
4. 用 reason 对应的确定性模板生成事实性短消息；
5. 插入 assistant proactive message；
6. 插入 delivery；quietHours/DND 时直接为 `suppressed`，否则为 `pending`；
7. 消费 permit/保留现有预算；
8. 仅非 suppressed delivery 插入 `proactive.delivery` event；
9. commit + opaque NOTIFY。

P2 不使用额外 LLM 改写 proactive body。P5 若允许角色口吻 presentation，必须保留事实字段和 deterministic fallback，模型失败不阻止真实通知。

### 10.4 默认文案边界

| reason | 允许的事实模板意图 | 禁止 |
| --- | --- | --- |
| resume_paused_task | “要继续刚才暂停的学习吗？” | “你拖延太久了” |
| recoverable_error_explanation | “刚才没有完成，可以重试或查看原因。” | 暴露 stack/provider |
| canonical_stale_change | “相关内容已经更新，继续前需要刷新。” | 声称用户做错 |
| committed_change_display | “刚才的变更已经记录。” | 无 commit 事件时声称已保存 |
| long_absence_resume | “欢迎回来，要从上次的位置继续吗？” | 连续催促、内疚话术 |
| active_tier_next_step | “如果你愿意，可以继续下一小步。” | 自动开始、倒计时、任务债务 |

### 10.5 Quiet hours、隐私与过期

- `notificationsEnabled=false` 或 presence=quiet：准入在 permit 前 fail closed，不创建 proactive message/delivery、不消费通知预算；
- quietHours/DND 内：合法事实可写入 inbox history，但 delivery 在创建事务中直接置 `suppressed`，不发 `proactive.delivery`、不显示占位、不 TTS，且 quiet 结束后不补弹；
- 非 DND 时，服务端因 workspace/account policy 要求隐藏正文，event 固定为 `contentPolicy=content_hidden`；否则为 `content`；该字段是 delivery policy，不代表服务端知道设备本地开关；
- privacy mode 只能由用户在当前设备手动切换，默认关闭；服务端不得根据截屏、录屏状态、前台窗口、进程列表或其他应用内容自动推断，也不得要求客户端上传这些信息；
- 设备本地 mode 不上传、不改写 event/message 正文或账号偏好；Pet 以 `effectiveContentHidden = event.contentPolicy === "content_hidden" || devicePrivacyMode` 投影，将 proactive 正文替换为固定占位并抑制其自动 TTS；用户主动发起的对话保持可见；
- 默认 TTL：recoverable error `10min`、commit display `10min`、resume `24h`、stale `24h`、next step `4h`；
- 目标已解决/会话已结束/内容再次变化时 delivery 立即失效；
- dismiss/page leave/TTL 不退还已消费预算；
- 同一 permit 跨设备最多显示一次正文；其他设备只同步已 shown/dismissed 状态；
- 点击 delivery 只能执行 allowlisted route/proposal，不直接 mutation。

### 10.6 完整历史

- proactive message 写入 inbox conversation，因此“查看完整内容”有 durable 目标；
- Pet P2 bootstrap 在认证成功后调用幂等 `/companion/inbox/ensure`，取得唯一 inbox id 并以独立 cursor 订阅其 SSE；当前 dialogue 使用另一条 SSE，两个 cursor 不复用；
- active dialogue turn 存在时，收到的 proactive delivery 进入低优先级队列，不覆盖 turn/composer/confirmation；
- Pet bubble 关闭不删除 message；
- 用户可删除 inbox conversation；下一条合法 delivery 可重新创建空 inbox，但不得恢复已删除旧消息；
- 删除 inbox 后，当前设备立即清空 inbox cursor、再次调用 ensure 并订阅新空 inbox；其他设备在旧 SSE 关闭/404/reset 后执行同一流程。ensure 不恢复旧消息，也不消耗通知预算；
- dismiss 只关闭 delivery，不等同删除历史；UI 提供明确删除入口。

---

## 11. P3 点按切换录音与 TTS 合同

### 11.1 Tap-toggle capture

- 只有外置麦克风的 pointer click 或键盘 Enter/Space activation 才能开始；pointerdown/pointerup 本身不承担开始/提交语义，也不得要求用户保持按压；
- 第一次点按执行 `idle → requesting_permission → listening`；第二次点按执行 `listening → finalizing → transcribing`。识别处理中防重复点按；`60s` 到时等价于第二次点按；
- macOS packaged app 的 `NSMicrophoneUsageDescription` 固定为“AI 学习伴星仅在你点按开始语音录入后使用麦克风，将语音转为文字；再次点按结束、取消或达到时限后立即停止录音。”；
- Electron permission handler 只允许当前动态 localhost origin 的 Pet/Main trusted route 请求 `media`，其他 origin/path fail closed；
- 默认最大 `60s`，到时自动停止并进入 transcribing；
- 最大上传 `10MB`，与现有 Fastify multipart 上限一致；
- capture MIME 依次尝试 `audio/webm;codecs=opus`、`audio/mp4`、`audio/webm`、`audio/ogg;codecs=opus`，只选择 `MediaRecorder.isTypeSupported` 为真的第一项；全部不支持则禁用语音录入并保留文字；
- server 只接受 `audio/webm`、`audio/mp4`、`audio/ogg`、`audio/mpeg`、`audio/wav`、`audio/x-m4a`；`application/octet-stream` 仅在扩展名与 magic bytes 通过 allowlist 时接受；不能只信 MIME/filename；
- 空音频、少于 200ms、无 track、权限拒绝均不创建 user message；
- 录音 Buffer 只在 renderer 内存到上传完成，禁止 localStorage/IndexedDB；
- 页面/窗口隐藏、系统 sleep、workspace switch、global off 立即 stop track 并丢弃未发送 buffer；
- UI 指示必须读取实际 track.readyState，不只相信 React state。

### 11.2 ASR

P3 复用已鉴权 `POST /voice/transcribe`：

- Companion branch 的 multipart 只接受 `file`、`purpose=companion_dialogue`、`language=zh-CN`、`durationMs=<200..60000 integer>`；未知字段、重复字段或缺字段 fail closed；既有正式学习 branch 未带该 purpose 时保持原合同；
- `durationMs` 字段只用于客户端诊断，不是 hard-limit 事实；P3 在 API image 安装经 Owner 批准的 Alpine `ffmpeg/ffprobe`，把 magic-byte 已通过的 upload 写入受控随机 temp 文件，以无 shell 的固定 argv、`3s` timeout 读取真实 duration；探测失败或真实时长不在 `200..60000ms` 时拒绝且不调用 ASR；
- P3 首发 profile 固定为 `language=zh-CN`、provider `siliconflow`、model `FunAudioLLM/SenseVoiceSmall`；配置元数据与 provider 实际请求必须一致，不能只改回包中的 model 名；
- 成功 transcript trim 后必须非空且最多 4,000 字符；
- 日常对话成功后自动作为 `voice_transcript` user message 提交；
- bubble 立即显示逐字 transcript，允许用户下一条消息纠正；
- 不自动润色、补全或作为正式 Voice Artifact；
- ASR provider/model 写入 `companion_voice_artifacts` provenance；
- ASR 失败只显示可恢复错误，不创建空 turn。
- Companion ASR POST 不自动网络重试；response 未确认时不得复用同一录音再调用 provider，用户可保留文字路径或重新点按开始一段新录音，避免重复 artifact/计费。

Companion 成功 response 固定为：

```ts
const companionTranscriptionResponseV1Schema = z.object({
  version: z.literal(1),
  voiceArtifactId: z.string().uuid(),
  text: z.string().trim().min(1).max(4_000),
  transcriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  asrProvider: z.literal("siliconflow"),
  asrModel: z.literal("FunAudioLLM/SenseVoiceSmall"),
  language: z.literal("zh-CN"),
  durationMs: z.number().int().min(200).max(60_000),
  expiresAt: z.string().datetime(),
}).strict();
```

API 在返回前创建 §7.5 的 pending provenance；response 使用 `Cache-Control: no-store`。response/数据库中的 `durationMs` 只采用 ffprobe 实测值。客户端随后提交 `inputKind=voice_transcript`、同一 text 与 `voiceArtifactId`；不得把 provider/model/duration 从客户端重新写回数据库。artifact 过期、已绑定或 hash 不符时 turn fail closed，保留 transcript 给用户复制/改用普通 text 提交。

### 11.3 TTS sentence queue

- P3 首发 voice profile 固定为 `companion-default-v1 → zh-CN-XiaoxiaoNeural / rate +0% / audio-mpeg`；Pet 请求不提交任意 voice id；
- 为兼容现有卡片朗读，`/voice/tts` 的 legacy `voice` 字段在 P3 只允许缺省或精确值 `zh-CN-XiaoxiaoNeural`，其他值 fail closed；后续扩展 voice 必须新增受审 profile mapping；
- 只有 playback leader 请求并播放；
- Worker 是 TTS 切句唯一所有者：先写对应 `assistant.delta`，再按可见文本生成 `voice.segment.ready`；客户端不得自行从 delta 再切一套 TTS segment；
- 切句优先 `。！？；\n` 或 `.?!;` + 空白；句子至少 8 个中文字符，final 强制 flush；单段最多 160 字符，超限时在最近合法标点/空白强制切分；
- Markdown 标记、URL、代码块和隐藏 metadata 不进入 voice segment；净化后为空则不发 event；
- 每 run 最多 20 个 TTS segments、总可朗读文本最多 2,000 字；超过后只显示文字；
- 每个 segment 调用现有 `POST /voice/tts` 的 Companion branch；request 不发送正文或任意 voice id，只发送下列 strict ref；

```ts
const companionTtsRequestV1Schema = z.object({
  version: z.literal(1),
  profileId: z.literal("companion-default-v1"),
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  ordinal: z.number().int().min(1).max(20),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
```

- API 在当前 RLS scope 重新读取精确 `voice.segment.ready` event，验证 run/generation/ordinal/segmentId、profile mapping，且 run 仍为 running 或 succeeded（cancel_requested/cancelled/superseded/failed 全部拒绝），再用 event 中稳定文本合成；找不到或不匹配 fail closed；
- 既有卡片朗读 legacy branch 只接受 strict `{ text, voice? }`，voice 缺省或精确 `zh-CN-XiaoxiaoNeural`；Companion 代码不得调用 legacy branch；
- audio response `no-store`，解码后进入 Web Audio queue；
- ordinal 严格顺序，旧 generation segment 丢弃；
- renderer bootstrap/snapshot 先把 cursor 对齐当前 durable head，再订阅新 segment；reload/Main 后开不得重播 cursor 之前的 segment；
- 一个 segment 失败时跳过该声音并继续文字，不重新朗读前一段；
- Companion TTS 每 segment 最多发起一次 POST；网络结果未知也不自动重试合成，避免重复计费/跨 leader 重播；
- TTS 全失败后本 turn 自动降级文字并显示一次非阻塞状态。
- v1 proactive delivery 不生成 `voice.segment.ready`，因此不自动朗读主动消息；用户明确打开完整对话后的朗读/重播不在 P3 范围，需另立基于 durable message 的 contract。

### 11.4 Barge-in

用户 speaking 时点按 mic：

1. 在 UI 线程立即停止当前 source；
2. 清空未播放 queue；
3. 释放 playback Web Lock；
4. dispatch generation/audio fence；
5. 请求 listening；
6. 若 permission/track 失败，保留文字 composer；
7. 不自动取消已完成 assistant text；新的 transcript 提交时才 supersede 尚未结束的 run。

目标：点按到音频停止 p95 ≤ 200ms。

### 11.5 回声与冷却

- speaking 前确保 mic tracks stopped；
- 正常播放结束进入 `cooldown`，初始 `600ms`；
- cooldown 期间不会自动打开麦克风；用户明确点按麦克风可立即跳过 cooldown；
- 所有 ASR upload/response 绑定 renderer 的 `streamId + voice.operationEpoch`；turn/TTS 仍使用服务端 conversation generation，二者不得混作同一计数器；
- speaking 开始前创建的迟到 ASR response 不得生成新 user message；
- `echoCancellation/noiseSuppression/autoGainControl` 可请求，但不是状态机替代品。

### 11.6 Raw audio 保留

P3 默认数据库和对象存储 **不保存 raw audio**。如果 provider adapter 因实现需要写临时文件：

- 路径只在受控 temp 目录；
- 随机文件名，不含 user/conversation；
- provider 请求完成或失败后立即删除；
- crash cleanup hard cap 1 小时；
- 不进入 backup、analytics、日志、trace 或错误 payload；
- 自动测试验证异常路径也删除。

---

## 12. Retention、导出与删除

| 数据 | 默认 |
| --- | --- |
| conversation/messages | 保留到用户删除 |
| turn runs | 随 conversation；只保存净化元数据 |
| stream events | run 终态后 24h |
| raw audio | 不持久化；临时异常 hard cap 1h |
| voice provenance | 随 message/conversation |
| proactive delivery metadata | 随 inbox；过期后状态保留 30d，再清理 |
| action proposals/runs | 随 conversation；只保存 typed payload、decision 和真实 result ref |
| prompt/provider metadata | 随 run，不保存 prompt 正文/provider body |

导出 wire format：

`GET /companion/export` 不返回一个无界 JSON array，而以 `application/x-ndjson; charset=utf-8` 流式输出。shared 中逐行 schema 固定为：

```ts
const companionExportVoiceProvenanceV1Schema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  status: z.literal("attached"),
  transcriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  asrProvider: z.string().min(1).max(80),
  asrModel: z.string().min(1).max(160),
  language: z.string().min(2).max(20),
  durationMs: z.number().int().min(200).max(60_000),
  rawAudioPersisted: z.literal(false),
  attachedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
}).strict();

const companionExportProactiveDeliveryV1Schema = z.object({
  deliveryId: z.string().uuid(),
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  reasonId: z.string().min(1).max(120),
  suggestionClassId: z.string().min(1).max(120),
  contentPolicy: z.enum(["content", "content_hidden"]),
  status: z.enum(["pending", "shown", "suppressed", "dismissed", "expired"]),
  expiresAt: z.string().datetime(),
  firstPresentedAt: z.string().datetime().nullable(),
  shownAt: z.string().datetime().nullable(),
  dismissedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
}).strict();

const companionExportCountsV1Schema = z.object({
  conversations: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  voiceProvenance: z.number().int().nonnegative(),
  proactiveDeliveries: z.number().int().nonnegative(),
  actionProposals: z.number().int().nonnegative(),
  actionRuns: z.number().int().nonnegative(),
}).strict();

const companionExportRecordV1Schema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("manifest"),
    format: z.literal("companion-export-ndjson-v1"),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    exportedAt: z.string().datetime(),
  }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("conversation"), value: companionConversationV1Schema }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("message"), value: companionMessageV1Schema }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("voice_provenance"), value: companionExportVoiceProvenanceV1Schema }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("proactive_delivery"), value: companionExportProactiveDeliveryV1Schema }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("action_proposal"), value: companionActionProposalV1Schema }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("action_run"), value: companionActionRunV1Schema }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal("footer"),
    counts: companionExportCountsV1Schema,
    recordsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);
```

输出规则冻结为：

1. 当前 authenticated `(workspaceId,userId)` 的 manifest 恰好一行且必须为首行；
2. 依次输出 conversation `(createdAt,id)`、message `(conversationId,seq)`、attached voice provenance `(conversationId,messageId,id)`、delivery `(conversationId,createdAt,id)`、P5 proposal `(conversationId,createdAt,proposalId)`、P5 action run `(proposalId,actionRunId)`，全部升序；P2–P4 的 P5 类别计数为 0；
3. footer 恰好一行且必须为末行；`counts` 只统计六类 data record，`recordsSha256` 对 manifest 起至 footer 前一行止的原始 UTF-8 NDJSON bytes（每行含结尾 LF）计算；
4. 查询使用一个 read-only repeatable-read RLS transaction；开始前已确认当前 scope 没有非终态 dialogue turn，只导出 active/archived dialogue 与当前 inbox 及其 scoped child，不导出已删除数据、pending/expired 未绑定 voice provenance；
5. 不包含 stream event/delta、turn/provider/prompt 内部元数据、raw audio、account secret、device-session claim HMAC、audit 或其他 workspace；正文只在 message record 中出现一次；
6. response 固定带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 和 `Content-Disposition: attachment; filename="companion-export-v1.ndjson"`；导出动作只写 content-free audit；
7. 鉴权/校验失败必须在发送 NDJSON headers 前返回 §6.9 JSON error；流中异常直接中断且不写 footer，因此客户端必须把缺 footer、count/hash 不符的文件视为不完整导出。

删除：

- 用户二次确认后硬删除 conversation；
- DELETE 事务先 lock conversation、active turn run 与 action run；active action run 为 `accepted/running` 时返回 `409 RUN_ALREADY_ACTIVE` 且零删除，避免丢失真实 Learning 执行回执；
- 只有 active turn run 时，原子置为 superseded、触发 dialogue job cancel fence，再 cascade scoped rows并返回幂等 `204`，不无限等待 provider；pending proposal 可直接随 conversation 删除，因为尚无 Learning 副作用；
- Worker 迟到写入因 parent/run/generation 不存在而 fail closed；
- 删除 companion conversation 不删除 Learning Session/canonical facts；
- 删除 inbox 不重建旧内容。

---

## 13. P2/P3/P5 Contract Gate

只有以下全部成立才允许阶段验收：

- [ ] shared Zod schema 是 Web/API/Worker 唯一类型来源；
- [ ] conversation create/inbox ensure/list/messages/turn/cancel/export/delete 全部有 integration test；
- [ ] active run 的原子 supersede、并发新 turn 与硬删除 race 可测；
- [ ] user message + run + job + accepted event 原子；
- [ ] final message + run terminal + final event 原子；
- [ ] cancel/final race 只有一个终态；
- [ ] SSE replay/live 无缝、heartbeat、cursor expired/reset 可测；
- [ ] event payload 无 reasoning/provider secret；
- [ ] P2 至少一个真实 provider 产生真实流式 delta；
- [ ] Pet/Main 双开不重复提交、不重复 TTS；
- [ ] 六张表 RLS FORCE + API/Worker role matrix 通过；
- [ ] P5 proposal/action run 两表同样 RLS FORCE，confirm/reject/TTL/hash/idempotency/terminal race 可测；
- [ ] proactive delivery 只来自现有 trigger permit，quiet=0；
- [ ] inbox history、dismiss、过期、跨设备显示一次可测；
- [ ] inbox 删除后 ensure 新空 inbox，旧内容不恢复；
- [ ] persona prompt version/hash/provider metadata 可追溯；
- [ ] 点按切换录音的 60s/10MB/empty/permission/format 边界可测；
- [ ] ASR 不创建正式 Voice Artifact；
- [ ] TTS 队列顺序、失败降级、cancel、barge-in 和 self-transcription 防护可测；
- [ ] ASR model 元数据与真实请求一致；TTS voice profile/legacy allowlist fail closed；
- [ ] raw audio 异常路径也在 1h hard cap 前删除；
- [ ] P5 只有 typed confirm bridge 可调用 Learning service，普通 dialogue 无 canonical write 权限；
- [ ] 所有错误为安全 envelope，普通日志无消息正文/transcript/audio/provider body。
