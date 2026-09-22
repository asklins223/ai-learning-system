/**
 * 笔记 CRDT 形状的跨进程一致性向量（批次 4.4）。
 *
 * `snapshotBase64` 由**服务端**那份内核生成一次后固定下来，两份实现各自解码并断言投影结果：
 *  - 服务端那份改坏了 → 它的对拍用例红；
 *  - 主进程那份改坏了（字段改名、`content` 从 `Y.Text` 换成字符串、块形状变了）→
 *    它的用例红。
 * 这是"两份实现悄悄分叉"唯一能被机器发现的地方：两边没法共用源码，因为同一个进程里
 * 出现两份 yjs 会让 `instanceof Y.Text` 静默判假（原因写在那两份内核的文件头）。
 *
 * **这一串字节是 `Y.XmlFragment` 那一版的形状**（批次 C 之后），而且是由**主进程那份**
 * 内核产的：服务端解它必须得到 `expectedBlocks`，两边各自断言一次。哪一份实现改坏了
 * （字段、属性、块容器、行内标记的序列化），它那一条用例就红——比"两边各自生成一次
 * 再看像不像"强，因为字节是同一份。
 *
 * 不要为了让用例变绿而重新生成这串字节——那等于把分叉重新遮回去。确实要换向量时，
 * 必须同时改 `expectedBlocks` / `expectedTitle`，并确认两边用例都还成立。
 */
export const NOTE_DOC_CONFORMANCE = {
  /** 生成时的字节数，只用于诊断。 */
  snapshotBytes: 567,
  snapshotBase64:
    "ARH2lLCjCgAoAQRtZXRhBXRpdGxlAXcM5ZCR6YeP5qCH6aKYKAEEbWV0YQt0aXRsZVNvdXJjZQF3Bm1hbnVhbAcBB2NvbnRlbnQDB2hlYWRpbmcHAPaUsKMKAgYEAPaUsKMKAx8jIOagh+mimOmHjOeahOS4reaWh+S4jiBFbmdsaXNoKAD2lLCjCgIFbGV2ZWwBfQKH9pSwowoCAwlwYXJhZ3JhcGgHAPaUsKMKFgYEAPaUsKMKFy3nrKzkuIDmrrXvvJrmlLnkuIDlpITkuI3or6Xpobbmjonlj6bkuIDlpITjgIIoAPaUsKMKFglzb3VyY2VSZWYBdgIIc291cmNlSWR3JDExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMQlzZWdtZW50SWR3JDIyMjIyMjIyLTIyMjItNDIyMi04MjIyLTIyMjIyMjIyMjIyMof2lLCjChYDCmNvZGVfYmxvY2sHAPaUsKMKKAYEAPaUsKMKKTVjb25zdCBhID0gMTsKY29uc3QgYiA9IDI7IC8vIOWkmuihjOS4jeiDveWOi+aIkOS4gOihjIf2lLCjCigDBWltYWdlKAD2lLCjCk8Dc3JjAXcUL2FwaS91cGxvYWRzL2FiYy5wbmcoAPaUsKMKTwNhbHQBdwbphY3lm74oAPaUsKMKTwxpbWFnZUFzc2V0SWQBdyQzMzMzMzMzMy0zMzMzLTQzMzMtODMzMy0zMzMzMzMzMzMzMzMA",
  expectedBlocks: [
    {
      "ordinal": 0,
      "type": "heading",
      "content": "# 标题里的中文与 English"
    },
    {
      "ordinal": 1,
      "type": "paragraph",
      "content": "第一段：改一处不该顶掉另一处。",
      "sourceRef": {
        "sourceId": "11111111-1111-4111-8111-111111111111",
        "segmentId": "22222222-2222-4222-8222-222222222222"
      }
    },
    {
      "ordinal": 2,
      "type": "code",
      "content": "const a = 1;\nconst b = 2; // 多行不能压成一行"
    },
    {
      "ordinal": 3,
      "type": "image",
      "content": "![配图](/api/uploads/abc.png)",
      "imageAssetId": "33333333-3333-4333-8333-333333333333"
    }
  ],
  expectedTitle: {"title":"向量标题","titleSource":"manual"},
} as const;
