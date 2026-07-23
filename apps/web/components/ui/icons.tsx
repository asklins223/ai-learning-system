/**
 * 内联 SVG 图标（描边风格，统一 1.6 stroke，活泼而不重）。
 * 替换 Sidebar / 各种空状态 / 状态点。
 * 命名：icon + 用途，所有图标 size 默认 16。
 */
import { SVGProps } from "react";

const base: SVGProps<SVGSVGElement> = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
};

export const Icon = {
  Compass: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="9" />
      <polygon points="16 8 13 13 8 16 11 11 16 8" />
    </svg>
  ),
  Notepad: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 9h6M9 13h6M9 17h4" />
      <path d="M8 4v3M12 4v3M16 4v3" />
    </svg>
  ),
  Card: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M7 15h6" />
    </svg>
  ),
  Review: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M21 12a9 9 0 1 1-3.2-6.9" />
      <path d="M21 4v5h-5" />
      <path d="M9 12l3 3 4-5" />
    </svg>
  ),
  StarMap: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="6" cy="7" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="15" cy="17" r="2" />
      <circle cx="8" cy="18" r="2" />
      <path d="M8 7L18 6M8 18L15 17M8 7L8 18M18 6L15 17" />
    </svg>
  ),
  Timeline: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M4 7h12M4 12h8M4 17h14" />
      <circle cx="3" cy="7" r="1" />
      <circle cx="3" cy="12" r="1" />
      <circle cx="3" cy="17" r="1" />
    </svg>
  ),
  Inbox: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M3 13l3-9h12l3 9" />
      <path d="M3 13v6a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6" />
      <path d="M3 13h6l1 2h4l1-2h6" />
    </svg>
  ),
  Archive: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
      <path d="M9 13h6M12 11v5M10 14l2 2 2-2" />
    </svg>
  ),
  Search: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.5-4.5" />
    </svg>
  ),
  Sun: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2M12 19.5v2M4.4 4.4l1.4 1.4M18.2 18.2l1.4 1.4M2.5 12h2M19.5 12h2M4.4 19.6l1.4-1.4M18.2 5.8l1.4-1.4" />
    </svg>
  ),
  Moon: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M20.7 15.2A8.6 8.6 0 0 1 8.8 3.3 8.8 8.8 0 1 0 20.7 15.2Z" />
    </svg>
  ),
  Appearance: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17V3.5Z" fill="currentColor" stroke="none" opacity="0.18" />
      <path d="M12 3.5v17" />
      <circle cx="12" cy="12" r="2.1" />
    </svg>
  ),
  Settings: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h9M17 18h3" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="15" cy="18" r="2" />
    </svg>
  ),
  Plus: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  Close: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  Chevron: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  Arrow: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  Sparkle: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
      <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" />
    </svg>
  ),
  Folder: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  ),
  GripVertical: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  Quote: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M3 12c0-3 2-6 5-7M11 12c0-3 2-6 5-7M3 18c0-3 2-6 5-7M11 18c0-3 2-6 5-7" />
    </svg>
  ),
  Link: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.5-1.5" />
    </svg>
  ),
  Pin: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M12 17v5" />
      <path d="M9 4h6l-1 8 3 3H7l3-3-1-8z" />
    </svg>
  ),
  Check: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  ),
  Warn: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M12 3l10 18H2L12 3z" />
      <path d="M12 10v5M12 18v.5" />
    </svg>
  ),
  Trash: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
    </svg>
  ),
  Refresh: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M4 12a8 8 0 1 1 2.34 5.66" />
      <path d="M4 19v-5h5" />
    </svg>
  ),
  Bolt: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" />
    </svg>
  ),
  Open: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M14 3h7v7" />
      <path d="M10 14L21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  ),
  Download: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  ),
  Upload: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M5 20h14" />
    </svg>
  ),
  FileText: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h4M9 13h6M9 17h5" />
    </svg>
  ),
  Lock: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  Bell: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  ),
  Filter: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M3 5h18l-7 9v6l-4-2v-4z" />
    </svg>
  ),
  Image: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 17l-5-5-9 9" />
    </svg>
  ),
  More: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18" cy="12" r="1.2" />
    </svg>
  ),
  Highlighter: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M9 11l-4 4 2 2 4-4" />
      <path d="M11 9l6-6 4 4-6 6" />
      <path d="M15 5l4 4" />
      <path d="M3 21h12" />
    </svg>
  ),
  Target: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" />
    </svg>
  ),
  Flame: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M12 3c1 3 4 4 4 8a4 4 0 1 1-8 0c0-2 2-3 2-5" />
      <path d="M9 16a3 3 0 0 0 6 0" />
    </svg>
  ),
  Play: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M7 5l12 7-12 7V5z" />
    </svg>
  ),
  Sparkle2: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M12 2l2.5 7L22 12l-7.5 3L12 22l-2.5-7L2 12l7.5-3L12 2z" />
    </svg>
  ),
  // 富文本工具条专用图标（更细致）
  Bold: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p} fill="currentColor" stroke="none">
      <path d="M7 4h5.5a3.5 3.5 0 0 1 0 7H7V4zM7 11h6a3.5 3.5 0 0 1 0 7H7v-7z" />
    </svg>
  ),
  Italic: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <line x1="19" y1="4" x2="10" y2="4" />
      <line x1="14" y1="20" x2="5" y2="20" />
      <line x1="15" y1="4" x2="9" y2="20" />
    </svg>
  ),
  H1: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M5 5v14M13 5v14M5 12h8" />
    </svg>
  ),
  H2: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M5 5v14M5 12h8M15 9a2 2 0 1 1 4 0c0 2-4 4-4 7h4" />
    </svg>
  ),
  H3: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M5 5v14M5 12h8M15 8h5l-4 4a3 3 0 1 1-1 4" />
    </svg>
  ),
  List: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </svg>
  ),
  QuoteMark: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M6 8a3 3 0 0 1 3 3v6H3v-6a3 3 0 0 1 3-3zM14 8a3 3 0 0 1 3 3v6h-6v-6a3 3 0 0 1 3-3z" />
    </svg>
  ),
  Code: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14" />
    </svg>
  ),
  LinkOut: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.5-1.5" />
    </svg>
  ),
  Divider: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M4 12h16" />
      <path d="M5 9l-2 3 2 3M19 9l2 3-2 3" />
    </svg>
  ),
  Eye: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  SplitView: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="3" y="5" width="8" height="14" rx="1.5" />
      <rect x="13" y="5" width="8" height="14" rx="1.5" />
    </svg>
  ),
  Pencil: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M4 20h4l11-11-4-4L4 16v4z" />
      <path d="M14 6l4 4" />
    </svg>
  ),
  Undo: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M4 10h12a4 4 0 0 1 0 8h-3" />
      <path d="M8 6l-4 4 4 4" />
    </svg>
  ),
  Redo: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M20 10H8a4 4 0 0 0 0 8h3" />
      <path d="M16 6l4 4-4 4" />
    </svg>
  ),
  Logout: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  ),
  User: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
    </svg>
  ),
  Keyboard: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h0M10 10h0M14 10h0M18 10h0M6 14h0M10 14h0M14 14h0" />
    </svg>
  ),
  X: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  AlertCircle: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16v.5" />
    </svg>
  ),
  ChevronRight: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  Switch: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M16 3l4 4-4 4" />
      <path d="M20 7H4" />
      <path d="M8 21l-4-4 4-4" />
      <path d="M4 17h16" />
    </svg>
  ),
  Layers: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M12 2l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </svg>
  ),
  Edit: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  Fullscreen: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M3 9V5a2 2 0 0 1 2-2h4M15 3h4a2 2 0 0 1 2 2v4M21 15v4a2 2 0 0 1-2 2h-4M9 21H5a2 2 0 0 1-2-2v-4" />
    </svg>
  ),
  WideView: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
    </svg>
  ),
  Columns: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </svg>
  ),
};
