# 图片上传与支持 Runbook

> Status: v0.5 实现<br>
> Owner: Platform Owner<br>
> Related: ADR-0003（RLS 租户隔离）、ADR-0007（备份基础设施）

## 概述

本 runbook 描述笔记图片上传、用户头像上传功能的基础设施依赖、日常运维和故障排查。

## 基础设施依赖

### MinIO 对象存储

- **端点**：`STORAGE_ENDPOINT` 环境变量（默认 `http://minio:9000`）
- **凭据**：复用 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`（与 MinIO 服务共用）
- **Bucket**：`S3_BUCKET` 环境变量（默认 `ailearn-workspaces`）
- **启动**：`docker compose --profile storage up -d`（dev 环境）

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `STORAGE_ENDPOINT` | 否 | `http://minio:9000` | MinIO/S3 端点 |
| `MINIO_ROOT_USER` | 是 | — | MinIO access key |
| `MINIO_ROOT_PASSWORD` | 是 | — | MinIO secret key |
| `S3_BUCKET` | 否 | `ailearn-workspaces` | bucket 名称 |
| `S3_REGION` | 否 | `us-east-1` | S3 region |

### Docker Compose

dev 环境通过 `docker-compose.dev.yml` 的 `storage` profile 启动 MinIO。生产环境通过 `docker-compose.yml` 配置。

## 存储路径约定

| 类型 | objectKey 格式 | URL 格式 |
|------|---------------|----------|
| 笔记图片 | `{workspaceId}/notes/{noteId}/{uuid}.{ext}` | `/api/uploads/{workspaceId}/notes/{noteId}/{uuid}.{ext}` |
| 用户头像 | `avatars/{userId}/{uuid}.{ext}` | `/api/uploads/avatars/{userId}/{uuid}.{ext}` |

## 文件上传限制

| 限制 | 笔记图片 | 用户头像 |
|------|---------|---------|
| 文件大小 | 10MB | 2MB |
| 文件类型 | PNG / JPEG / GIF / WebP | PNG / JPEG / GIF / WebP |
| SVG | ❌ 不支持（XSS 风险） | ❌ 不支持 |
| 校验方式 | MIME type + magic bytes 双重校验 | 同左 |

## 日常运维

### 检查存储是否就绪

API 启动时 `isStorageConfigured()` 检查 `MINIO_ROOT_USER` 和 `MINIO_ROOT_PASSWORD` 是否存在。如果缺失，上传端点返回 503。

```bash
# 检查 MinIO 是否运行
docker compose ps minio

# 检查 bucket 是否存在
docker compose exec minio mc ls minio/ailearn-workspaces
```

### 孤儿图片清理

v0.5 采用宽松策略，不主动清理版本切换产生的孤儿图片（保留版本恢复能力）。孤儿图片的累积情况可通过以下方式监控：

```bash
# 统计 note_blocks 中 image 类型的数量
psql -c "SELECT count(*) FROM note_blocks WHERE type = 'image'"

# 统计对象存储中的对象数量（需要 mc 客户端）
docker compose exec minio mc ls --recursive minio/ailearn-workspaces | wc -l
```

v0.6 将补充后台 GC 任务定期扫描未引用的对象。

### 头像旧文件清理

用户上传新头像时，`updateUserProfile()` 会异步删除旧头像文件（`deleteObject`）。清理失败仅记录 warning 日志，不阻塞操作。

## 故障排查

### 上传失败（503）

1. 检查 MinIO 服务是否运行：`docker compose ps minio`
2. 检查 `STORAGE_ENDPOINT` 是否正确配置
3. 检查 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` 是否设置
4. 检查 API 日志中的 S3 错误信息

### 上传失败（415）

文件类型不被支持或 magic bytes 不匹配。确认上传的文件是真实的 PNG/JPEG/GIF/WebP 格式。

### 上传失败（413）

文件超过大小限制。笔记图片限制 10MB，头像限制 2MB。

### 图片无法显示（404）

1. 检查 URL 中的 workspaceId / userId 是否匹配当前 session
2. 检查 objectKey 是否存在于 MinIO 中
3. 检查下载路由的认证是否通过

### 图片无法显示（CSP 错误）

`next.config.mjs` 已配置 `img-src 'self' data: blob: https:`，站内上传图片（`'self'`）和外部 HTTPS URL（`https:`）均可正常显示。如仍有 CSP 错误，检查 CSP 配置是否被修改。

## 安全注意事项

1. **租户隔离**：笔记图片下载时校验 `workspaceId` 匹配当前 session
2. **用户隔离**：头像下载时校验 `userId` 匹配当前 session
3. **文件类型校验**：双重校验（MIME type + magic bytes），防止可执行文件伪装为图片
4. **SVG 不支持**：SVG 可内嵌 `<script>` 导致 XSS，v0.5 不允许上传
5. **avatarUrl 路径收紧**：仅允许 `/api/uploads/avatars/` 前缀和 HTTPS URL
6. **AI 隐私**：图片 URL 不会发送给外部 AI provider，仅 alt text 以 `（图片：...）` 格式发送

## 相关文件

| 文件 | 说明 |
|------|------|
| `apps/api/src/lib/object-storage.ts` | MinIO/S3 客户端封装 |
| `apps/api/src/lib/file-validation.ts` | magic bytes 校验 |
| `apps/api/src/lib/markdown-image.ts` | Markdown 图片 objectKey 提取 |
| `apps/api/src/modules/upload/routes.ts` | 上传/下载路由 |
| `apps/web/components/account/AvatarUploader.tsx` | 头像上传组件 |
