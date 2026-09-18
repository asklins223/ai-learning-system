import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_IMAGE_MAX_BYTES,
  SOURCE_IMAGE_UPLOAD_PREFIX,
  sourceImageGetRequestV1Schema,
  sourceImageGetResultV1Schema,
  sourceImageObjectKeyFromUrl,
} from "./source-image-contracts.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const noteId = "33333333-3333-4333-8333-333333333333";
const imageId = "44444444-4444-4444-8444-444444444444";
const sourceObjectKey = `${workspaceId}/sources/${sourceId}/${imageId}.png`;
const noteObjectKey = `${workspaceId}/notes/${noteId}/${imageId}.webp`;

test("sourceImageObjectKeyFromUrl 只认站内上传路径", () => {
  assert.equal(sourceImageObjectKeyFromUrl(`${SOURCE_IMAGE_UPLOAD_PREFIX}${sourceObjectKey}`), sourceObjectKey);
  assert.equal(sourceImageObjectKeyFromUrl(`${SOURCE_IMAGE_UPLOAD_PREFIX}${noteObjectKey}`), noteObjectKey);
  assert.equal(
    sourceImageObjectKeyFromUrl(`  ${SOURCE_IMAGE_UPLOAD_PREFIX}${sourceObjectKey}  `),
    sourceObjectKey,
  );
});

test("sourceImageObjectKeyFromUrl 拒绝外链、data URI 与非登记形状", () => {
  // 外链仍然是渲染层直接渲染的地址，不走这条通道。
  assert.equal(sourceImageObjectKeyFromUrl("https://i0.hdslb.com/bfs/article/a.png"), null);
  assert.equal(sourceImageObjectKeyFromUrl("//i0.hdslb.com/bfs/article/a.png"), null);
  assert.equal(sourceImageObjectKeyFromUrl("data:image/png;base64,iVBORw0KGgo="), null);
  assert.equal(sourceImageObjectKeyFromUrl(""), null);
  // 形状不符即拒绝：段落数不够、目录名不在下载路由的白名单里、扩展名不受支持、
  // 以及带查询串的地址。
  assert.equal(sourceImageObjectKeyFromUrl(`${SOURCE_IMAGE_UPLOAD_PREFIX}${workspaceId}/${imageId}.png`), null);
  assert.equal(
    sourceImageObjectKeyFromUrl(`${SOURCE_IMAGE_UPLOAD_PREFIX}${workspaceId}/secrets/${sourceId}/${imageId}.png`),
    null,
  );
  assert.equal(
    sourceImageObjectKeyFromUrl(`${SOURCE_IMAGE_UPLOAD_PREFIX}${workspaceId}/sources/${sourceId}/${imageId}.svg`),
    null,
  );
  assert.equal(
    sourceImageObjectKeyFromUrl(`${SOURCE_IMAGE_UPLOAD_PREFIX}${sourceObjectKey}?token=leak`),
    null,
  );
  // 路径遍历与绝对路径都不会被当成站内键。
  assert.equal(
    sourceImageObjectKeyFromUrl(`${SOURCE_IMAGE_UPLOAD_PREFIX}${workspaceId}/sources/../../etc/passwd`),
    null,
  );
});

test("SourceImageGetRequestV1 只接受受形状约束的对象键", () => {
  const request = { version: 1 as const, objectKey: sourceObjectKey };
  assert.deepEqual(sourceImageGetRequestV1Schema.parse(request), request);
  assert.throws(() => sourceImageGetRequestV1Schema.parse({ version: 1, objectKey: "" }));
  assert.throws(() => sourceImageGetRequestV1Schema.parse({ version: 1, objectKey: "a/b/c/d.png" }));
  assert.throws(() =>
    sourceImageGetRequestV1Schema.parse({
      version: 1,
      objectKey: `${workspaceId}/sources/${sourceId}/${imageId}.png`,
      absolutePath: "/data/ailearn",
    }));
  assert.throws(() => sourceImageGetRequestV1Schema.parse({ ...request, version: 2 }));
});

test("SourceImageGetResultV1 只接受受上限约束的四种图片字节", () => {
  const result = {
    version: 1 as const,
    mimeType: "image/png" as const,
    // "iVBORw0KGgo=" 是 PNG 文件头的 base64：示例保持 base64 与 byteLength 自洽。
    imageBase64: "iVBORw0KGgo=",
    byteLength: 8,
  };
  assert.deepEqual(sourceImageGetResultV1Schema.parse(result), result);
  assert.throws(() => sourceImageGetResultV1Schema.parse({ ...result, mimeType: "image/svg+xml" }));
  assert.throws(() => sourceImageGetResultV1Schema.parse({ ...result, mimeType: "application/json" }));
  assert.throws(() => sourceImageGetResultV1Schema.parse({ ...result, imageBase64: "" }));
  assert.throws(() => sourceImageGetResultV1Schema.parse({ ...result, byteLength: 0 }));
  assert.throws(() => sourceImageGetResultV1Schema.parse({ ...result, byteLength: 1.5 }));
  assert.throws(() =>
    sourceImageGetResultV1Schema.parse({ ...result, byteLength: SOURCE_IMAGE_MAX_BYTES + 1 }));
  assert.throws(() =>
    sourceImageGetResultV1Schema.parse({ ...result, objectKey: sourceObjectKey }));
});
