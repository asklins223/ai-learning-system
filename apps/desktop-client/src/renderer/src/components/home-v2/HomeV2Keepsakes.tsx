import type {
  CompanionDecorIdV1,
  CompanionRoomSlotV1,
} from "@ailearn/shared/companion-home-contracts";
import { useCompanionHomeProjection } from "../../app/companion-home-projection";

const SLOT_TRANSFORMS: Readonly<Record<CompanionRoomSlotV1, string>> = Object.freeze({
  desk: "translate(770 306) scale(.82)",
  shelf: "translate(347 143) scale(.68)",
  window: "translate(1118 276) scale(.8)",
  rest: "translate(1500 611) scale(.86)",
});

function KeepsakeShape({ id }: { readonly id: CompanionDecorIdV1 }) {
  if (id === "keepsake.first-note") {
    return (
      <g className="home-v2-keepsake__shape home-v2-keepsake__shape--note">
        <path d="M-22 -37 H18 L27 -28 V0 H-22 Z" />
        <path className="home-v2-keepsake__paper-fold" d="M18 -37 V-28 H27" />
        <path className="home-v2-keepsake__ink" d="M-13 -25 H10 M-13 -17 H17 M-13 -9 H5" />
        <circle className="home-v2-keepsake__seal" cx="13" cy="-5" r="6" />
      </g>
    );
  }
  if (id === "keepsake.first-goal") {
    return (
      <g className="home-v2-keepsake__shape home-v2-keepsake__shape--compass">
        <circle cx="0" cy="-18" r="22" />
        <circle className="home-v2-keepsake__compass-face" cx="0" cy="-18" r="15" />
        <path className="home-v2-keepsake__compass-needle" d="M-4 -12 L2 -30 L5 -17 Z" />
      </g>
    );
  }
  if (id === "keepsake.first-review") {
    return (
      <g className="home-v2-keepsake__shape home-v2-keepsake__shape--calendar">
        <path d="M-22 -36 H22 V0 H-22 Z" />
        <path className="home-v2-keepsake__calendar-top" d="M-22 -36 H22 V-25 H-22 Z" />
        <path className="home-v2-keepsake__ink" d="M-12 -18 H12 M-12 -10 H5" />
        <path className="home-v2-keepsake__ring" d="M-11 -41 V-31 M11 -41 V-31" />
      </g>
    );
  }
  return (
    <g className="home-v2-keepsake__shape home-v2-keepsake__shape--memory">
      <rect x="-22" y="-38" width="44" height="38" rx="2" />
      <rect className="home-v2-keepsake__memory-paper" x="-15" y="-31" width="30" height="24" />
      <path className="home-v2-keepsake__leaf" d="M0 -12 C-11 -17 -10 -26 2 -28 C11 -23 9 -15 0 -12 Z M0 -12 V-27" />
    </g>
  );
}

export function HomeV2Keepsakes() {
  const { projection } = useCompanionHomeProjection();
  const equipment = projection?.roomProfile.equippedDecorBySlot;
  if (!equipment) return null;

  const entries = Object.entries(equipment) as Array<[CompanionRoomSlotV1, CompanionDecorIdV1 | null]>;
  const equipped = entries.filter((entry): entry is [CompanionRoomSlotV1, CompanionDecorIdV1] => Boolean(entry[1]));
  if (!equipped.length) return null;

  return (
    <svg
      className="home-v2-keepsakes"
      viewBox="0 0 1672 941"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {equipped.map(([slot, id]) => (
        <g key={slot} className="home-v2-keepsake" data-slot={slot} data-decor-id={id} transform={SLOT_TRANSFORMS[slot]}>
          <ellipse className="home-v2-keepsake__contact" cx="0" cy="2" rx="25" ry="5" />
          <KeepsakeShape id={id} />
        </g>
      ))}
    </svg>
  );
}
