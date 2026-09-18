type HomeRoomDepthProps = Readonly<{
  dayPoster: string;
  nightPoster: string;
  notebookState: "syncing" | "attention" | "active" | "ready" | "empty";
  reviewState: "syncing" | "unknown" | "due" | "clear";
  shelfState: "syncing" | "unknown" | "filled";
  dueCount: number | null;
}>;

function DepthObjects({ poster, theme }: { poster: string; theme: "day" | "night" }) {
  return (
    <g className={`home-room-depth__theme home-room-depth__theme--${theme}`}>
      <image className="home-room-depth__object home-room-depth__object--review" href={poster} width="1672" height="941" preserveAspectRatio="none" mask="url(#home-depth-review-mask)" />
      <image className="home-room-depth__object home-room-depth__object--notebook" href={poster} width="1672" height="941" preserveAspectRatio="none" mask="url(#home-depth-notebook-mask)" />
      <image className="home-room-depth__object home-room-depth__object--lamp" href={poster} width="1672" height="941" preserveAspectRatio="none" mask="url(#home-depth-lamp-mask)" />
      <image className="home-room-depth__object home-room-depth__object--shelf" href={poster} width="1672" height="941" preserveAspectRatio="none" mask="url(#home-depth-shelf-mask)" />
    </g>
  );
}

/**
 * Exact-pixel object accents cut from the canonical room posters. They only
 * appear on intent, so the resting room stays registered and motionless.
 */
export function HomeRoomDepth({
  dayPoster,
  nightPoster,
  notebookState,
  reviewState,
  shelfState,
  dueCount,
}: HomeRoomDepthProps) {
  const reviewCountLabel = reviewState === "due" && dueCount !== null
    ? dueCount > 99 ? "99+" : String(dueCount)
    : "";

  return (
    <svg
      className="home-room-depth"
      viewBox="0 0 1672 941"
      preserveAspectRatio="none"
      data-home-depth-response="local-pointer"
      data-notebook-state={notebookState}
      data-review-state={reviewState}
      data-shelf-state={shelfState}
    >
      <defs>
        <filter id="home-depth-mask-soft" x="-12%" y="-12%" width="124%" height="124%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <mask id="home-depth-review-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1672" height="941">
          <path d="M538 466 L670 467 L724 493 L710 538 L550 532 L520 501 Z" fill="white" filter="url(#home-depth-mask-soft)" />
          <ellipse cx="715" cy="487" rx="35" ry="43" fill="white" filter="url(#home-depth-mask-soft)" />
        </mask>
        <mask id="home-depth-notebook-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1672" height="941">
          <path d="M686 501 C730 482 774 486 811 507 C847 487 894 492 934 511 L905 557 C867 569 829 561 805 548 C771 561 724 554 683 531 Z" fill="white" filter="url(#home-depth-mask-soft)" />
        </mask>
        <mask id="home-depth-lamp-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1672" height="941">
          <path d="M965 348 C977 314 1026 291 1054 307 L1085 324 L1119 359 L1091 372 L1067 345 C1042 371 1004 384 971 369 Z M1081 333 L1120 360 L1112 482 L1090 518 L1063 510 L1083 477 L1090 370 Z" fill="white" filter="url(#home-depth-mask-soft)" />
        </mask>
        <mask id="home-depth-shelf-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1672" height="941">
          <ellipse cx="350" cy="327" rx="68" ry="70" fill="white" filter="url(#home-depth-mask-soft)" />
          <path d="M331 380 L371 380 L384 405 L316 405 Z" fill="white" filter="url(#home-depth-mask-soft)" />
        </mask>
      </defs>

      <g className="home-room-depth__contacts">
        <ellipse className="home-room-depth__contact home-room-depth__contact--review" cx="625" cy="530" rx="91" ry="15" transform="rotate(3 625 530)" />
        <ellipse className="home-room-depth__contact home-room-depth__contact--notebook" cx="811" cy="552" rx="116" ry="17" transform="rotate(2 811 552)" />
        <ellipse className="home-room-depth__contact home-room-depth__contact--shelf" cx="350" cy="404" rx="54" ry="8" />
      </g>
      <g className="home-room-depth__signals" aria-hidden="true">
        <ellipse className="home-room-depth__notebook-halo" cx="811" cy="548" rx="134" ry="27" transform="rotate(2 811 548)" />
        <path className="home-room-depth__notebook-thread" d="M748 558 C783 566 838 567 874 557" />
        <path className="home-room-depth__shelf-glint" d="M318 328 C340 301 378 306 391 335" />
      </g>
      <DepthObjects poster={dayPoster} theme="day" />
      <DepthObjects poster={nightPoster} theme="night" />
      <g className="home-room-depth__markers" aria-hidden="true">
        <g className="home-room-depth__review-marker" transform="rotate(3 658 489)">
          <path d="M637 473 H678 V501 H637 L631 487 Z" />
          {reviewCountLabel ? <text x="657" y="493" textAnchor="middle">{reviewCountLabel}</text> : null}
          {reviewState === "clear" ? <path className="home-room-depth__review-check" d="M648 487 L655 493 L668 480" /> : null}
          {reviewState === "syncing" ? (
            <g className="home-room-depth__review-dots">
              <circle cx="649" cy="488" r="2" />
              <circle cx="657" cy="488" r="2" />
              <circle cx="665" cy="488" r="2" />
            </g>
          ) : null}
        </g>
      </g>
    </svg>
  );
}
