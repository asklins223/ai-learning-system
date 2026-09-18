/**
 * The approved desktop-pages-v3 mockups are the spatial contract for every
 * business page. This registry is the single source of truth for the shell that
 * wraps a page body: its number, heading, room plate, companion seat and the one
 * line the companion says while that page is open.
 *
 * Page numbers match `.impeccable/review/desktop-pages-v3/effects/<NN>-*.png`.
 */
export type HudPageId =
  | "home"
  | "login"
  | "register"
  | "space"
  | "sources"
  | "source-detail"
  | "notes"
  | "note-read"
  | "note-edit"
  | "goals"
  | "goal-detail"
  | "generating"
  | "candidate"
  | "today"
  | "queue"
  | "assessment"
  | "result"
  | "search"
  | "graph"
  | "companion"
  | "settings"
  | "drawer";

export type HudPlate =
  | "home"
  | "library"
  | "writing"
  | "workshop"
  | "review"
  | "system"
  | "observatory";

export type HudCompanionSeat = "left" | "right" | "none";

export type HudPageDefinition = {
  readonly id: HudPageId;
  readonly number: string;
  readonly title: string;
  readonly subtitle: string;
  readonly plate: HudPlate;
  readonly seat: HudCompanionSeat;
  /** A full-width paper that owns the room, e.g. the LearningRun assessment. */
  readonly wide?: boolean;
  /** The companion speaks only when the mockup gives that page a line. */
  readonly bubble?: string;
};

export const HUD_PAGES: Readonly<Record<HudPageId, HudPageDefinition>> = {
  home: {
    id: "home",
    number: "01",
    title: "首页",
    subtitle: "沿用当前 Home V2，只校准固定半身伴星与今日下一步",
    plate: "home",
    seat: "right",
    // "今天先完成 6 张到期复习" was a hard-coded count that had no relation to the
    // workspace it was spoken in.
    bubble: "今天的学习从到期复习开始。",
  },
  login: {
    id: "login",
    number: "02",
    title: "登录",
    subtitle: "进入理解书房",
    plate: "home",
    seat: "none",
  },
  register: {
    id: "register",
    number: "03",
    title: "注册",
    subtitle: "创建你的学习空间",
    plate: "home",
    seat: "none",
  },
  space: {
    id: "space",
    number: "04",
    title: "学习空间",
    subtitle: "首次进入时在当前首页完成选择",
    plate: "home",
    seat: "right",
    bubble: "选定空间后，我才读取对应的学习进度。",
  },
  sources: {
    id: "sources",
    number: "05",
    title: "来源库",
    subtitle: "采集、搜索、解析与待处理材料在同一张资料索引上",
    plate: "library",
    seat: "right",
    bubble: "粘贴、拖入或填一个地址都能采集；也可以直接搜索已有来源。",
  },
  "source-detail": {
    id: "source-detail",
    number: "06",
    title: "来源详情",
    // The source contract exposes parsed fragments and linked notes, not a
    // source-level evidence projection, so the plate names what the page shows.
    subtitle: "进入即阅读原文、核对解析结构并开始写笔记",
    plate: "library",
    seat: "left",
    bubble: "正文已经按片段整理好，可以直接开始写笔记。",
  },
  notes: {
    id: "notes",
    number: "07",
    title: "笔记库",
    subtitle: "继续写作优先，其余笔记以真实册本呈现",
    plate: "writing",
    seat: "right",
    // A page-level line cannot see the records behind it, so it may not claim
    // anything about them. This one used to promise the top note "已经关联了
    // 来源和证据" on a page that also renders 未关联来源.
    bubble: "书架按最近更新排在最前面。",
  },
  "note-read": {
    id: "note-read",
    number: "08",
    title: "笔记详情",
    subtitle: "正文是主角，来源与版本收在页边",
    plate: "writing",
    seat: "left",
    bubble: "正文按不可变版本保存，来源和版本都在页边。",
  },
  "note-edit": {
    id: "note-edit",
    number: "09",
    title: "笔记编辑",
    subtitle: "纯文本块专注写作；标题与正文都由服务端版本记录",
    plate: "writing",
    // Reading and writing are one page in two modes, so they share a seat: the
    // clips hang over the right edge in both, and flipping the seat moved the
    // whole paper ~277px the instant the mode changed.
    seat: "left",
    bubble: "我先保持安静，你专心写。",
  },
  goals: {
    id: "goals",
    number: "10",
    title: "理解目标",
    subtitle: "目标不是列表，而是一张正在推进的理解路线",
    plate: "workshop",
    seat: "right",
    bubble: "先补上还没有证据覆盖的那一段，再进入验证会更稳。",
  },
  "goal-detail": {
    id: "goal-detail",
    number: "11",
    title: "理解目标详情",
    subtitle: "围绕一个主张查看证据、血缘、版本和验证入口",
    plate: "workshop",
    seat: "left",
    bubble: "定义已有证据，但真实应用情境仍然空缺。",
  },
  generating: {
    id: "generating",
    number: "12",
    title: "学习卡生成中",
    subtitle: "来源到候选卡的真实阶段与恢复点",
    plate: "workshop",
    seat: "right",
    bubble: "每一步都来自服务端确认的阶段，离开本页不会中断。",
  },
  candidate: {
    id: "candidate",
    number: "13",
    title: "候选卡审核",
    subtitle: "一次只判断一张卡；答案与来源证据按需展开",
    plate: "workshop",
    seat: "right",
    bubble: "保留与否由你确认；需要时先看答案和来源证据。",
  },
  today: {
    id: "today",
    number: "14",
    title: "今日学习",
    subtitle: "今天的操作按时间倒序排开，异常事务就在同页可追溯",
    plate: "review",
    seat: "right",
    // 这一页已经在 2026-09-18 从"三张票的推荐位"改成操作日志流，文案跟着走：
    // 不再提"三件事"（页面上没有票了），也不再承诺按认知负荷排序（服务端
    // 不发布时长）。气泡只说这一页真正兑现的事：记真实发生的操作 + 可追溯。
    bubble: "这一页记的是你今天真实做过的事；有卡住的事务，点它就跳回现场。",
  },
  queue: {
    id: "queue",
    number: "15",
    title: "复习队列",
    subtitle: "到期顺序像一叠待复习卡，下一张始终清楚",
    plate: "review",
    seat: "left",
    // 队列按 nextReviewAt 升序，也就是最逾期的在最前；「遗忘风险最高」是一个
    // 系统里不存在的模型，「影响更多目标」也不是排序依据。
    bubble: "最逾期的一张排在最前，卡面上的理由条写着它为什么在这里。",
  },
  assessment: {
    id: "assessment",
    number: "16",
    title: "理解练习",
    subtitle: "问题怎么问，桌面就提供怎样的作答工具",
    plate: "review",
    seat: "none",
    wide: true,
  },
  result: {
    id: "result",
    number: "17",
    title: "练习结果",
    subtitle: "把已证明的理解、仍有缺口和下一步放在一起",
    plate: "review",
    seat: "none",
    wide: true,
  },
  search: {
    id: "search",
    number: "18",
    title: "全局搜索",
    subtitle: "来源、笔记与目标共用一张检索台，右侧直接预览",
    plate: "library",
    seat: "right",
    bubble: "我把来源、笔记和理解目标放在同一组结果里。",
  },
  graph: {
    id: "graph",
    number: "19",
    title: "理解星图",
    subtitle: "把来源、笔记、理解目标与证据画成一片可漫游的知识宇宙",
    plate: "observatory",
    seat: "left",
    bubble: "这片星空全是真的：拖一拖，点一颗星，我陪你看它从哪来。",
  },
  companion: {
    id: "companion",
    number: "20",
    title: "伴星中心",
    subtitle: "目录栏、共同记录与记忆星轨同时可见",
    plate: "observatory",
    seat: "right",
    bubble: "今晚想回看哪段学习经历？记忆写入前会先确认。",
  },
  settings: {
    id: "settings",
    number: "21",
    title: "设置中心",
    subtitle: "用柔软 HUD 卡片承载账户、权限、主题、语音与数据",
    plate: "system",
    seat: "right",
    bubble: "这里没有虚构的模型选择或 BYOK 选项。",
  },
  drawer: {
    id: "drawer",
    number: "22",
    title: "实时对话",
    subtitle: "覆盖当前笔记的伴星通信状态，不成为独立页面",
    plate: "writing",
    seat: "left",
    bubble: "建议已经整理好；确认前不会写入笔记。",
  },
};

/** Room plate per page, used for the scoped `bg-*` class on the HUD scope. */
export function hudPlateClass(plate: HudPlate): string {
  return `bg-${plate}`;
}
