import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

type HomeRoomForegroundProps = Readonly<{
  assetUrl: string;
  active: boolean;
  motionMode: "full" | "lite" | "off";
}>;

/** A single near-camera layer makes the room read as a space, not a poster. */
export function HomeRoomForeground({ assetUrl, active, motionMode }: HomeRoomForegroundProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const foliageRef = useRef<HTMLImageElement>(null);

  useGSAP(() => {
    const foliage = foliageRef.current;
    if (!foliage) return;
    gsap.killTweensOf(foliage);

    if (!active || motionMode !== "full") {
      gsap.set(foliage, {
        x: 0,
        y: 4,
        rotation: 0,
        scale: 0.56,
        opacity: active ? 0.62 : 0.24,
      });
      return;
    }

    gsap.fromTo(
      foliage,
      { x: 2.8, y: 3.2, rotation: -0.18, scale: 0.56, opacity: 0.63 },
      {
        x: 5.2,
        y: 5.1,
        rotation: 0.28,
        scale: 0.564,
        opacity: 0.7,
        duration: 7.8,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
        force3D: true,
      },
    );
  }, { scope: rootRef, dependencies: [active, motionMode], revertOnUpdate: true });

  return (
    <div ref={rootRef} className="home-room-foreground" data-home-foreground={active ? "alive" : "quiet"}>
      <img ref={foliageRef} src={assetUrl} alt="" draggable="false" />
    </div>
  );
}
