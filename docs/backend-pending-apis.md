# 后端待实现 API 文档

> 本文档记录前端已接入但后端尚未实现的 API，供下一阶段开发参考。
> 更新时间：2026-07-09

---

## 1. Source CRUD API

### 背景
`sources` 和 `source_segments` 表已在数据库 schema 中定义（`apps/api/src/db/schema/evidence.ts`），但尚未有对应的路由。

前端 `sources` 页面目前使用 localStorage 保存来源草稿，后端实现后需要迁移到真实 API。

### 需要实现的端点

```
GET    /sources                  — 列出当前 workspace 的所有来源
POST   /sources                  — 创建来源（接受 url + title + rawText）
GET    /sources/:id              — 获取来源详情（含 segments）
PATCH  /sources/:id              — 更新来源元信息
DELETE /sources/:id              — 删除来源
GET    /sources/:id/segments     — 列出来源的解析片段
```

### POST /sources 请求体
```json
{
  "url": "string (可选)",
  "title": "string",
  "rawText": "string (可选，有正文时触发 parse_source job)"
}
```

### 需要新增的 JobType
```typescript
PARSE_SOURCE: "parse_source"        // 解析来源正文，生成 source_segments
GENERATE_NOTE_DRAFT: "generate_note_draft"  // 从来源片段生成笔记草稿
```

### Worker 处理逻辑
- `parse_source`: 将 rawText 按段落/Markdown 结构拆分为 source_segments
- `generate_note_draft`: 基于 segments + 向量检索生成可编辑笔记草稿

---

## 2. 全文搜索 API

### 背景
搜索页面目前在前端实时搜索 notes 和 cards 的标题/摘要。后端需要实现基于 `search_documents` 投影表的全文搜索。

### 需要实现的端点

```
GET /search?q=keyword&type=note|card|evidence&limit=20
```

### 返回结构
```json
{
  "items": [
    {
      "type": "note" | "card" | "evidence" | "segment",
      "id": "string",
      "title": "string",
      "snippet": "string (高亮匹配片段)",
      "href": "string (前端路由)"
    }
  ],
  "total": 0
}
```

### 实现方案
1. 创建 `search_documents` 物化视图或触发器更新的投影表
2. 将 notes.title、noteBlocks.content、learningCards.schemaJson、sourceSegments.content 写入投影表
3. 使用 PostgreSQL `tsvector` + `tsquery` 实现中文全文搜索
4. 可选：接入 pgvector 做语义搜索

---

## 3. Understanding Events API

### 背景
`understanding_events` 表已定义但无 API。首页和今日变化页面需要展示理解状态变化事件。

### 需要实现的端点

```
GET /understanding-events              — 列出当前 workspace 的事件
GET /understanding-events?cardId=xxx   — 按学习卡过滤
GET /understanding-events?limit=20     — 限制数量
```

### 返回结构
```json
{
  "items": [
    {
      "id": "string",
      "cardId": "string",
      "eventType": "validation" | "review" | "evidence_aligned" | "misunderstanding_detected",
      "payload": {},
      "createdAt": "string"
    }
  ]
}
```

### 数据来源
- validation_events 完成时写入
- review_schedules 完成时写入
- evidences 对齐时写入
- AI 检测到误解时写入

---

## 4. Knowledge Graph API

### 背景
理解星图页面目前按学习卡状态分组展示。后端需要实现概念级关系图。

### 需要实现的端点

```
GET /graph                    — 返回当前 workspace 的知识图谱
GET /graph?cardId=xxx         — 以某张学习卡为中心的关系子图
```

### 返回结构
```json
{
  "nodes": [
    {
      "id": "string",
      "type": "card" | "concept" | "note",
      "label": "string",
      "status": "active" | "pending" | "unverified",
      "categoryId": "string | null"
    }
  ],
  "edges": [
    {
      "from": "string",
      "to": "string",
      "type": "prerequisite" | "derived_from" | "evidence_of" | "related_to"
    }
  ]
}
```

### 需要新增的表
```sql
CREATE TABLE concept_prerequisites (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  concept_id UUID NOT NULL,
  prerequisite_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 5. Card 状态更新 API

### 背景
当前学习卡只能通过 AI 生成，无法手动更新状态或编辑内容。

### 需要实现的端点

```
PATCH /cards/:id              — 更新学习卡元信息或状态
DELETE /cards/:id             — 删除学习卡
POST   /cards/:id/regenerate  — 重新生成学习卡（基于最新 noteVersion）
```

### PATCH 请求体
```json
{
  "status": "active" | "draft" | "archived",
  "schemaJson": { "title": "string", "summary": "string" }
}
```

---

## 6. Note 删除 API

### 背景
当前笔记只能创建和更新，无法删除。

### 需要实现的端点

```
DELETE /notes/:id             — 软删除笔记（标记 deleted_at）
```

### 实现注意
- 软删除而非物理删除，保留数据可恢复
- 删除笔记时检查是否有关联的学习卡，有则提示用户

---

## 7. Dashboard 聚合 API

### 背景
首页和今日变化页面目前分别调用 4 个 API（notes、cards、reviews、jobs）然后前端聚合。后端可以提供聚合接口减少请求数。

### 需要实现的端点

```
GET /dashboard                — 返回首页所需的聚合数据
GET /dashboard/today          — 返回今日变化所需的聚合数据
```

### 返回结构（/dashboard）
```json
{
  "stats": {
    "noteCount": 0,
    "cardCount": 0,
    "pendingReviewCount": 0,
    "activeJobCount": 0
  },
  "recentNotes": [],
  "recentCards": [],
  "pendingReviews": [],
  "activeJobs": []
}
```

---

## 8. 已实现但前端待接入的 API

以下后端 API 已实现且前端 `api.ts` 中已有对应方法，但部分页面尚未完整接入：

| API | 前端方法 | 状态 |
|-----|---------|------|
| `POST /cards/:cardId/validate` | `api.submitValidation()` | ✅ 学习卡详情页已接入 |
| `GET /cards/:cardId/validations` | `api.listValidations()` | ✅ 学习卡详情页已接入 |
| `GET /validations/:id` | `api.getValidation()` | ✅ 学习卡详情页已接入 |
| `GET /reviews` | `api.listReviews()` | ✅ 复习页已接入 |
| `POST /reviews/:id/complete` | `api.completeReview()` | ✅ 复习页已接入 |
| `POST /reviews/:id/dismiss` | `api.dismissReview()` | ✅ 复习页已接入 |
| `POST /evidences/:id/override` | `api.overrideEvidence()` | ✅ 学习卡详情页已接入 |

---

## 优先级建议

| 优先级 | API | 理由 |
|--------|-----|------|
| P0 | Source CRUD + parse_source job | 来源是理解流水线的入口，目前只能用 localStorage |
| P0 | Note 删除 API | 基础 CRUD 完整性 |
| P1 | 全文搜索 API | 前端实时搜索已可用，后端搜索可覆盖更多内容 |
| P1 | Card 状态更新 API | 用户需要手动管理学习卡状态 |
| P2 | Dashboard 聚合 API | 性能优化，减少前端请求数 |
| P2 | Understanding Events API | 丰富今日变化页面的事件来源 |
| P3 | Knowledge Graph API | 概念级关系图，需要 AI 辅助构建 |
