"use client";

import { Icon } from "@/components/ui/icons";
import { StatusChip } from "@/components/ui/StatusChip";
import { statusMap } from "@/lib/status-map";

/**
 * AIJobIndicator — 后台 AI 任务状态指示器。
 *
 * - 只展示 pending/running 状态
 * - 不得根据 type 猜关联对象
 * - loading 有文字或读屏提示
 */

interface JobItem {
  id: string;
  type: string;
  status: string;
}

interface AIJobIndicatorProps {
  /** 任务列表 */
  jobs: JobItem[];
  /** 加载失败标记 */
  error?: boolean;
  /** 最多显示条数，默认 5 */
  max?: number;
  /** 额外 className */
  className?: string;
}

const JOB_TYPE_LABELS: Record<string, string> = {
  parse_source: "解析来源",
  generate_card: "生成学习卡",
  validate_card: "验证学习卡",
  align_evidence: "对齐证据",
  run_benchmark: "运行评测",
};

function jobLabel(type: string): string {
  return JOB_TYPE_LABELS[type] ?? type;
}

export function AIJobIndicator({
  jobs,
  error = false,
  max = 5,
  className = "",
}: AIJobIndicatorProps) {
  if (!error && jobs.length === 0) return null;

  return (
    <div className={`ai-job-indicator ${className}`} data-ui="ai-job-indicator">
      <div className="ai-job-indicator__header">
        <Icon.Bolt className="h-4 w-4" />
        <h3 className="ai-job-indicator__title">AI 任务</h3>
      </div>
      {error ? (
        <div className="ai-job-indicator__error">
          <Icon.Warn className="h-4 w-4" />
          <span>AI 任务加载失败</span>
        </div>
      ) : (
        <div className="ai-job-indicator__list">
          {jobs.slice(0, max).map((job) => {
            const pres = statusMap.jobStatus(job.status);
            return (
              <div key={job.id} className="ai-job-indicator__item">
                <span className="status-dot" data-tone={pres.tone} />
                <span className="ai-job-indicator__type">{jobLabel(job.type)}</span>
                <StatusChip tone={pres.tone} size="sm">{pres.label}</StatusChip>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
