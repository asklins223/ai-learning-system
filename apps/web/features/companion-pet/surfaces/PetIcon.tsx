import type { SVGProps } from "react";

export type PetIconNameV1 =
  | "sparkles"
  | "message"
  | "microphone"
  | "study"
  | "more"
  | "history"
  | "volume"
  | "shield"
  | "lock"
  | "pin"
  | "hide"
  | "settings"
  | "power"
  | "back"
  | "send"
  | "stop"
  | "close"
  | "drag"
  | "chevron"
  | "alert"
  | "check"
  | "clock"
  | "spinner"
  | "card"
  | "review"
  | "plus"
  | "trash";

export function PetIcon({ name, ...props }: { name: PetIconNameV1 } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {iconPath(name)}
    </svg>
  );
}

function iconPath(name: PetIconNameV1): React.ReactNode {
  switch (name) {
    case "sparkles":
      return <><path d="m12 3 1.25 3.25L16.5 7.5l-3.25 1.25L12 12l-1.25-3.25L7.5 7.5l3.25-1.25L12 3Z" /><path d="m18.5 13 .75 2.25L21.5 16l-2.25.75L18.5 19l-.75-2.25L15.5 16l2.25-.75L18.5 13Z" /><path d="m5 13 .6 1.4L7 15l-1.4.6L5 17l-.6-1.4L3 15l1.4-.6L5 13Z" /></>;
    case "message":
      return <><path d="M5 5.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10l-4.5 3v-3H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" /><path d="M7.5 10.8h9" /></>;
    case "microphone":
      return <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6" /></>;
    case "study":
      return <><path d="m3 7 9-4 9 4-9 4-9-4Z" /><path d="M6 9.2V15c3.6 2.5 8.4 2.5 12 0V9.2M21 7v6" /></>;
    case "more":
      return <><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" /></>;
    case "history":
      return <><path d="M4 5v5h5" /><path d="M5.3 15.7A8 8 0 1 0 4 10" /><path d="M12 7.5V12l3 2" /></>;
    case "volume":
      return <><path d="M4 10v4h4l5 4V6L8 10H4Z" /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" /></>;
    case "shield":
      return <><path d="M12 3 5 6v5c0 4.8 2.8 8 7 10 4.2-2 7-5.2 7-10V6l-7-3Z" /><path d="m9.5 12 1.7 1.7 3.5-3.7" /></>;
    case "lock":
      return <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>;
    case "pin":
      return <><path d="m9 4 6 0 1 5 3 3H5l3-3 1-5Z" /><path d="M12 12v9" /></>;
    case "hide":
      return <><path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" /><path d="m4 4 16 16M9.8 9.8a3 3 0 0 0 4.2 4.2" /></>;
    case "settings":
      return <><circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7L10.5 2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7 2-.7Z" transform="translate(2 0) scale(.83)" /></>;
    case "power":
      return <><path d="M12 3v9" /><path d="M7.1 6.3a8 8 0 1 0 9.8 0" /></>;
    case "back":
      return <><path d="m15 18-6-6 6-6" /></>;
    case "send":
      return <><path d="m3 4 18 8-18 8 3-8-3-8Z" /><path d="M6 12h15" /></>;
    case "stop":
      return <rect x="6" y="6" width="12" height="12" rx="2" />;
    case "close":
      return <><path d="m6 6 12 12M18 6 6 18" /></>;
    case "drag":
      return <><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" strokeWidth="3" /></>;
    case "chevron":
      return <path d="m9 18 6-6-6-6" />;
    case "alert":
      return <><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5M12 17.5h.01" /></>;
    case "check":
      return <path d="m5 12 4.2 4.2L19 6.5" />;
    case "clock":
      return <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>;
    case "spinner":
      return <><circle cx="12" cy="12" r="8.5" opacity="0.25" /><path d="M20.5 12a8.5 8.5 0 0 0-8.5-8.5" /></>;
    case "card":
      return <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h6" /></>;
    case "review":
      return <><path d="M4 6h11a4 4 0 0 1 4 4v8" /><path d="m15 14 4 4 4-4" /><path d="M9 18H7a3 3 0 0 1-3-3V6" /></>;
    case "plus":
      return <path d="M12 5v14M5 12h14" />;
    case "trash":
      return <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6.5 7l1 13h9l1-13" /><path d="M10 11v6M14 11v6" /></>;
  }
}
