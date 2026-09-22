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
 * **这一串字节是 `Y.Array<Y.Map>` 那一版的形状**（批次 C 之前的内核产的）。服务端换到
 * `Y.XmlFragment` 之后，正文那一半对不上了：用新内核解它会得到 0 块，而"解出 0 块"正是
 * 两边被混在同一条路上读的信号，所以用例现在把这件事**当断言写出来**而不是改掉期望值。
 * 重新生成向量的条件是两端都在 fragment 上（批次 C2 之后），届时 `expectedBlocks` 与
 * `snapshotBase64` 一起换。
 *
 * 不要为了让用例变绿而重新生成这串字节——那等于把分叉重新遮回去。确实要换向量时，
 * 必须同时改 `expectedBlocks` / `expectedTitle`，并确认两边用例都还成立。
 */
export const NOTE_DOC_CONFORMANCE = {
  /** 生成时的字节数，只用于诊断。 */
  snapshotBytes: 588,
  snapshotBase64:
    "ARO8wcHeBQAHAQZibG9ja3MBKAC8wcHeBQAEdHlwZQF3B2hlYWRpbmcnALzBwd4FAAdjb250ZW50AgQAvMHB3gUCHyMg5qCH6aKY6YeM55qE5Lit5paH5LiOIEVuZ2xpc2iHvMHB3gUAASgAvMHB3gUUBHR5cGUBdwlwYXJhZ3JhcGgnALzBwd4FFAdjb250ZW50AgQAvMHB3gUWLeesrOS4gOaute+8muaUueS4gOWkhOS4jeivpemhtuaOieWPpuS4gOWkhOOAgigAvMHB3gUUCXNvdXJjZVJlZgF2Aghzb3VyY2VJZHckMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExCXNlZ21lbnRJZHckMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyh7zBwd4FFAEoALzBwd4FJwR0eXBlAXcEY29kZScAvMHB3gUnB2NvbnRlbnQCBAC8wcHeBSk1Y29uc3QgYSA9IDE7CmNvbnN0IGIgPSAyOyAvLyDlpJrooYzkuI3og73ljovmiJDkuIDooYyHvMHB3gUnASgAvMHB3gVPBHR5cGUBdwVpbWFnZScAvMHB3gVPB2NvbnRlbnQCKAC8wcHeBU8MaW1hZ2VBc3NldElkAXckMzMzMzMzMzMtMzMzMy00MzMzLTgzMzMtMzMzMzMzMzMzMzMzKAEEbWV0YQV0aXRsZQF3DOWQkemHj+agh+mimCgBBG1ldGELdGl0bGVTb3VyY2UBdwZtYW51YWwA",
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
      "content": "",
      "imageAssetId": "33333333-3333-4333-8333-333333333333"
    }
  ],
  expectedTitle: {"title":"向量标题","titleSource":"manual"},
} as const;
