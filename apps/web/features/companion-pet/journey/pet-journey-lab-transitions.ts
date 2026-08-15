import type { PetJourneyUiIntentV2 } from "./pet-journey-contracts";

export interface PetJourneyLabReceipt {
  title: string;
  detail: string;
  returnFrameId?: string;
  returnLabel?: string;
}

export interface PetJourneyLabTransition {
  targetFrameId?: string;
  receipt?: PetJourneyLabReceipt;
}

/**
 * Story-lab navigation only. Every simulated intent either advances to a
 * concrete UI frame or returns an honest preview receipt; it never claims a
 * runtime action, persistence write, notification, or route actually ran.
 */
export function getPetJourneyLabTransition(
  intent: PetJourneyUiIntentV2,
  currentFrameId: string,
): PetJourneyLabTransition {
  switch (intent.kind) {
    case "choose_invitation":
      if (intent.branch === "own_material") return { targetFrameId: "goal-preference" };
      if (intent.branch === "sample") return { targetFrameId: "run-proposal" };
      return {
        receipt: {
          title: "首次邀请在这里结束",
          detail: "真实产品会关闭引导并进入工作区；本故事页没有接工作区导航，也不会写入偏好。",
          returnFrameId: "first-invitation",
          returnLabel: "返回首邀",
        },
      };
    case "defer_invitation":
      return {
        receipt: {
          title: "已演示“稍后”反馈",
          detail: "真实延期许可、频控和再次投递尚未接线；本页不会创建提醒。",
          returnFrameId: "first-invitation",
          returnLabel: "返回首邀",
        },
      };
    case "set_preference":
    case "skip_preference":
      if (currentFrameId === "goal-preference") return { targetFrameId: "intervention-preference" };
      if (currentFrameId === "intervention-preference") return { targetFrameId: "response-preference" };
      if (currentFrameId === "response-preference") return { targetFrameId: "source-waiting" };
      return {};
    case "progress_action":
      if (intent.action === "retry") {
        return {
          targetFrameId: "source-processing",
          receipt: {
            title: "切换到重试中的 UI 画面",
            detail: "这只是故事帧切换；没有发送真实重试请求，也不代表资料已经重新排队。",
            returnFrameId: "source-failed",
            returnLabel: "返回失败状态",
          },
        };
      }
      if (intent.action === "open_source") {
        return {
          receipt: {
            title: "资料页导航尚未接线",
            detail: "按钮与回执样式已验证；本 UI 预览不会打开真实资料，也不会提前进入 Run。",
            returnFrameId: currentFrameId === "source-ready" ? "run-proposal" : "source-failed",
            returnLabel: currentFrameId === "source-ready" ? "继续看 Run 提议" : "返回失败状态",
          },
        };
      }
      return {
        receipt: {
          title: "离开与通知仅完成 UI 反馈",
          detail: "本故事页没有后台任务或持久通知；真实投递链路留待 Pet runtime 实现。",
          returnFrameId: currentFrameId,
          returnLabel: "返回当前状态",
        },
      };
    case "open_run_proposal": return { targetFrameId: "run-confirmation" };
    case "reject_run_proposal":
      return {
        receipt: {
          title: "本次提议已在 UI 中关闭",
          detail: "真实拒绝回执与建议频控尚未接线；没有创建 LearningRun。",
          returnFrameId: "run-proposal",
          returnLabel: "重新查看提议",
        },
      };
    case "confirm_action": return { targetFrameId: "run-executing" };
    case "reject_action": return { targetFrameId: "run-proposal" };
    case "leave_execution": return { targetFrameId: "formal-answer-silence" };
    case "retry_recovery":
      return {
        receipt: {
          title: "重试意图已在 UI 中确认",
          detail: "本故事页不会调用评估服务；真实重试、去重与结果投递留待 runtime 接线。",
          returnFrameId: "real-result",
          returnLabel: "查看成功结果样式",
        },
      };
    case "dismiss_recovery":
      return {
        receipt: {
          title: "恢复卡已演示“先离开”",
          detail: "本页不会创建后台恢复通知；真实恢复入口和对话投递尚未接线。",
          returnFrameId: "recoverable-error",
          returnLabel: "返回恢复卡",
        },
      };
    case "result_action":
      return {
        receipt: {
          title: "目标页导航尚未接线",
          detail: "按钮只演示返回学习卡、星图变化或证据查看的 UI 意图，没有读取或修改真实学习记录。",
          returnFrameId: "run-proposal",
          returnLabel: "返回 Run 提议",
        },
      };
    case "dismiss":
      return {
        receipt: {
          title: "当前呈现已在 UI 中关闭",
          detail: "本故事页没有写入真实 dismissal 或对话历史。",
          returnFrameId: currentFrameId,
        },
      };
  }
}
