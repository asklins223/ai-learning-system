import { api } from "@/lib/api";
import type { CompanionOverview } from "./contracts";

export const companionClient = {
  /** signal 透传：调用方可在卸载/取消时 abort 在途请求。 */
  getOverview(signal?: AbortSignal): Promise<CompanionOverview> {
    return api.getCompanionOverview(signal);
  },
};
