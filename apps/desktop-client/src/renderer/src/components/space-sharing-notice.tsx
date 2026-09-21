import { useRoomStore } from "../app/room-store";

/**
 * 「放进共享空间即视为可外发」这句明示，放在放入的那一步，而不是只写在设置页。
 *
 * 产品裁决（2026-09-20）：AI 使用同意是账号级的，管不了"资料进了共享空间会被
 * 别人的伴星读到"这件事——那一步发生在放入时，由放的人决定。所以三个入口
 * （采集、写笔记、批量导入）都要在这里说清楚，不软化语气也不省略信息量。
 *
 * 个人空间不显示：那时空间里只有你自己，说了是噪音。
 */
export function SpaceSharingNotice({ testId = "space-sharing-notice" }: { readonly testId?: string }) {
  const identity = useRoomStore((state) => state.spaceIdentity);
  if (identity === null || identity.isPersonal) return null;
  return (
    <p className="space-sharing-notice" data-testid={testId}>
      这是协作空间，<b>放进来的资料整个空间的人都能看到</b>；他们的伴星也会读到这份资料，
      能不能发给模型由他们各自的 AI 使用同意决定。不想共享的材料，先别放进来。
    </p>
  );
}
