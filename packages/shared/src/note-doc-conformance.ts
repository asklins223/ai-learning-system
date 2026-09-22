/**
 * 笔记 CRDT 形状的跨进程一致性向量（批次 4.4，字节来源在批次 C2 之后换过一次）。
 *
 * `snapshotBase64` 由**服务端那份内核**（`apps/api/src/modules/note/doc-fragment.ts`）生成一次
 * 后固定下来（可复跑的生成器：`apps/api/scripts/note-doc-vector-generate.mts`），两份实现各自
 * 解码并断言下面这组期望值：
 *  - 服务端 → 它自己的对拍用例（`apps/api/src/__tests__/note-doc-conformance.test.ts`）：
 *    写侧形状变了、或库里那份读不回来了，它就红；
 *  - 编辑器那一侧 → `apps/desktop-client/src/renderer/src/components/surfaces/
 *    note-doc-conformance.test.ts`：它走的是 `y-prosemirror` + `note-doc-schema` 那条**独立**
 *    实现（Milkdown 的 preset schema 与属性声明都在它这边），块属性改名、mark 换名、行内容
 *    从 `YXmlText` 换成字符串，红的是它。
 * 这条分叉只能靠"同一串字节两边各解一次"来发现：两边没法共用源码——同一个进程里出现两份
 * yjs 会让 `instanceof Y.XmlText` 静默判假（原因写在两份内核的文件头）。
 *
 * 主进程那份第二实现（`src/main/note-doc-fragment.ts`）已经不存在了：桌面端自 C2 起直接把
 * 编辑器绑在共享文档上，不再有"服务端 ↔ 主进程"这一对。
 *
 * 不要为了让用例变绿而重新生成这串字节——那等于把分叉重新遮回去。确实要换向量时，
 * 必须同时核对 `expectedBlocks` / `expectedTitle`，并确认两边用例都还成立。
 */
export const NOTE_DOC_CONFORMANCE = {
  /** 生成时的字节数，只用于诊断。 */
  snapshotBytes: 567,
  snapshotBase64:
    "ARHR15W9BAAHAQdjb250ZW50AwdoZWFkaW5nBwDR15W9BAAGBADR15W9BAEfIyDmoIfpopjph4znmoTkuK3mlofkuI4gRW5nbGlzaCgA0deVvQQABWxldmVsAX0Ch9HXlb0EAAMJcGFyYWdyYXBoBwDR15W9BBQGBADR15W9BBUt56ys5LiA5q6177ya5pS55LiA5aSE5LiN6K+l6aG25o6J5Y+m5LiA5aSE44CCKADR15W9BBQJc291cmNlUmVmAXYCCHNvdXJjZUlkdyQxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEJc2VnbWVudElkdyQyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjKH0deVvQQUAwpjb2RlX2Jsb2NrBwDR15W9BCYGBADR15W9BCc1Y29uc3QgYSA9IDE7CmNvbnN0IGIgPSAyOyAvLyDlpJrooYzkuI3og73ljovmiJDkuIDooYyH0deVvQQmAwVpbWFnZSgA0deVvQRNA3NyYwF3FC9hcGkvdXBsb2Fkcy9hYmMucG5nKADR15W9BE0DYWx0AXcG6YWN5Zu+KADR15W9BE0MaW1hZ2VBc3NldElkAXckMzMzMzMzMzMtMzMzMy00MzMzLTgzMzMtMzMzMzMzMzMzMzMzKAEEbWV0YQV0aXRsZQF3DOWQkemHj+agh+mimCgBBG1ldGELdGl0bGVTb3VyY2UBdwZtYW51YWwA",
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
