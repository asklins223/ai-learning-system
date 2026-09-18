import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

type HomeRoomLifeProps = Readonly<{
  active: boolean;
  motionMode: "full" | "lite" | "off";
}>;

/**
 * Low-frequency room life that can pause without changing product state.
 * The canonical poster stays fixed; only light, air and steam move.
 */
export function HomeRoomLife({ active, motionMode }: HomeRoomLifeProps) {
  const rootRef = useRef<SVGSVGElement>(null);

  useGSAP(() => {
    const root = rootRef.current;
    if (!root) return;

    const steam = gsap.utils.toArray<SVGPathElement>(".home-room-life__steam", root);
    const motes = gsap.utils.toArray<SVGCircleElement>(".home-room-life__mote", root);
    const stars = gsap.utils.toArray<SVGCircleElement>(".home-room-life__stars circle", root);
    const sheen = root.querySelector<SVGRectElement>(".home-room-life__window-sheen");

    gsap.killTweensOf([...steam, ...motes, ...stars, sheen].filter(Boolean));

    if (!active || motionMode !== "full") {
      gsap.set(steam, { opacity: 0, y: 0, scale: 1 });
      gsap.set(motes, { opacity: active ? 0.22 : 0, x: 0, y: 0 });
      gsap.set(stars, { opacity: active ? 0.64 : 0, scale: 1, transformOrigin: "50% 50%" });
      if (sheen) gsap.set(sheen, { opacity: active ? 0.08 : 0, x: 0 });
      return;
    }

    gsap.set(steam, { transformOrigin: "50% 100%", strokeDasharray: 42, strokeDashoffset: 42 });
    steam.forEach((path, index) => {
      gsap.fromTo(
        path,
        { opacity: 0, y: 7, scale: 0.9, strokeDashoffset: 42 },
        {
          opacity: 0,
          y: -15,
          scale: 1.05,
          strokeDashoffset: 0,
          duration: 3.8 + index * 0.45,
          delay: index * 1.15,
          repeat: -1,
          repeatDelay: 0.55,
          ease: "sine.inOut",
          keyframes: [
            { opacity: 0, duration: 0.15 },
            { opacity: 0.42, duration: 0.55 },
            { opacity: 0.2, duration: 0.55 },
            { opacity: 0, duration: 0.35 },
          ],
        },
      );
    });

    motes.forEach((mote, index) => {
      const direction = index % 2 === 0 ? 1 : -1;
      gsap.fromTo(
        mote,
        { opacity: 0.08, x: 0, y: 5 },
        {
          opacity: 0.46,
          x: direction * (5 + index * 0.7),
          y: -10 - index * 1.8,
          duration: 5.4 + index * 0.7,
          delay: index * 0.62,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
        },
      );
    });

    stars.forEach((star, index) => {
      gsap.fromTo(
        star,
        { opacity: 0.34 + index * 0.06, scale: 0.72, transformOrigin: "50% 50%" },
        {
          opacity: 1,
          scale: 1.34,
          duration: 1.45 + index * 0.34,
          delay: index * 0.42,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
        },
      );
    });

    if (sheen) {
      gsap.fromTo(
        sheen,
        { x: -230, opacity: 0 },
        {
          x: 330,
          opacity: 0,
          duration: 8.8,
          repeat: -1,
          repeatDelay: 4.2,
          ease: "sine.inOut",
          keyframes: [
            { opacity: 0, duration: 0.12 },
            { opacity: 0.11, duration: 0.38 },
            { opacity: 0.05, duration: 0.34 },
            { opacity: 0, duration: 0.16 },
          ],
        },
      );
    }
  }, { scope: rootRef, dependencies: [active, motionMode], revertOnUpdate: true });

  return (
    <svg
      ref={rootRef}
      className="home-room-life"
      viewBox="0 0 1672 941"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-home-room-life={active ? "active" : "quiet"}
    >
      <defs>
        <filter id="home-life-soft" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        <filter id="home-life-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <linearGradient id="home-life-sheen" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff8d9" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff8d9" stopOpacity="0.92" />
          <stop offset="1" stopColor="#fff8d9" stopOpacity="0" />
        </linearGradient>
        <clipPath id="home-life-window-panes">
          <path d="M1168 61 L1269 61 L1266 236 L1167 238 Z M1288 58 L1390 55 L1396 233 L1291 235 Z M1167 253 L1266 252 L1264 416 L1167 413 Z M1291 250 L1397 247 L1400 414 L1293 414 Z" />
        </clipPath>
      </defs>

      <g className="home-room-life__window" clipPath="url(#home-life-window-panes)">
        <rect className="home-room-life__window-wash" x="1158" y="48" width="252" height="380" />
        <rect className="home-room-life__window-sheen" x="1110" y="20" width="68" height="450" fill="url(#home-life-sheen)" transform="rotate(13 1144 245)" />
        <g className="home-room-life__stars">
          <circle cx="1202" cy="116" r="1.4" />
          <circle cx="1334" cy="145" r="1.1" />
          <circle cx="1244" cy="311" r="1.2" />
          <circle cx="1368" cy="282" r="1.5" />
        </g>
      </g>

      <g className="home-room-life__air" filter="url(#home-life-soft)">
        <circle className="home-room-life__mote" cx="1110" cy="320" r="1.7" />
        <circle className="home-room-life__mote" cx="1046" cy="395" r="1.25" />
        <circle className="home-room-life__mote" cx="1168" cy="445" r="1.5" />
        <circle className="home-room-life__mote" cx="956" cy="492" r="1.2" />
        <circle className="home-room-life__mote" cx="1260" cy="525" r="1.1" />
      </g>

      <g className="home-room-life__cup-steam" filter="url(#home-life-soft)">
        <path className="home-room-life__steam" d="M708 472 C697 462 717 453 707 442 C699 433 710 425 706 416" />
        <path className="home-room-life__steam" d="M720 470 C732 459 713 451 723 439 C731 430 721 421 726 412" />
        <path className="home-room-life__steam" d="M715 474 C710 463 725 454 717 444 C711 436 719 429 716 421" />
      </g>

      <g className="home-room-life__object-cues">
        <ellipse className="home-room-life__cue home-room-life__cue--shelf" cx="350" cy="278" rx="64" ry="74" />
        <ellipse className="home-room-life__cue home-room-life__cue--lamp" cx="1068" cy="404" rx="103" ry="78" />
        <path className="home-room-life__cue home-room-life__cue--graph" d="M1168 61 L1269 61 L1266 236 L1167 238 Z M1288 58 L1390 55 L1396 233 L1291 235 Z M1167 253 L1266 252 L1264 416 L1167 413 Z M1291 250 L1397 247 L1400 414 L1293 414 Z" />
      </g>

      <ellipse className="home-room-life__lamp-core" cx="1021" cy="375" rx="48" ry="25" filter="url(#home-life-glow)" />
    </svg>
  );
}
