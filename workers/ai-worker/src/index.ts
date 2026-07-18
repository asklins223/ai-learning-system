import { logger } from "./lib/logger.ts";
import { closeDatabase } from "./db.ts";
import { runGenerateCard, runAlignEvidence, runEvaluateValidation } from "./handlers/index.ts";
import { runParseSource } from "./handlers/parse-source.ts";
import { runWithAbortTimeout } from "./lib/handler-timeout.ts";
import {
  claimJobs,
  markJobFailed,
  markJobSucceeded,
  markUnknownJobFailed,
  reapStaleJobs,
} from "./queue.ts";

const HANDLERS = {
  generate_card: runGenerateCard,
  align_evidence: runAlignEvidence,
  evaluate_validation: runEvaluateValidation,
  parse_source: runParseSource,
} as const;

const POLL_MS = 1500;
const MODEL_TIMEOUT_MS = 90_000; // F-010: 模型调用超时 90 秒

// F-010: 优雅关停标志
let shuttingDown = false;
function setupGracefulShutdown() {
  const handler = () => {
    if (!shuttingDown) {
      shuttingDown = true;
      logger.info("received shutdown signal, finishing current job…");
    }
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
setupGracefulShutdown();

async function tick() {
  // F-010: 先回收悬挂作业
  const reaped = await reapStaleJobs();
  if (reaped.total > 0) {
    logger.warn(
      {
        count: reaped.total,
        pending: reaped.pending,
        dead: reaped.dead,
        ids: reaped.ids,
      },
      "reaped stale running jobs",
    );
  }

  // F-010: 优雅关停时不认领新作业
  if (shuttingDown) return;

  const candidates = await claimJobs();

  for (const job of candidates) {
    const handler = HANDLERS[job.type as keyof typeof HANDLERS];
    if (!handler) {
      const unknownUpdated = await markUnknownJobFailed(job);
      if (!unknownUpdated) {
        logger.warn({ jobId: job.id }, "unknown job lease was already reaped; status left unchanged");
      }
      continue;
    }

    try {
      // F-010: 为 handler 添加超时保护
      // R-007: 超时会中止 provider；leaseToken 继续保护迟到 handler 的业务提交。
      await runWithAbortTimeout(
        (signal) => handler({
            id: job.id,
            payload: job.payload,
            workspaceId: job.workspaceId,
            requestedBy: job.requestedBy,
            leaseToken: job.leaseToken,
            signal,
          }),
        MODEL_TIMEOUT_MS,
        (lateError) => logger.warn(
          { jobId: job.id, err: lateError },
          "timed-out handler settled after its lease was released",
        ),
      );

      // G-001: 原子条件 UPDATE — 只有 status=running 且 lease_token 与 claim 时相同才提交 succeeded。
      // 如果 job 被 reaper 回收并重新 claim，lease_token 会不同，UPDATE 影响 0 行。
      const successUpdated = await markJobSucceeded(job);
      if (!successUpdated) {
        logger.warn(
          { jobId: job.id },
          "job was reaped or re-claimed during execution — skipping result commit to avoid duplicate side effects",
        );
        continue;
      }
      logger.info({ jobId: job.id, type: job.type }, "job ok");
    } catch (err) {
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      // G-001: 失败时也使用原子条件 UPDATE，避免覆盖 reaper 的状态
      const failure = await markJobFailed(job, message);
      if (!failure.updated) {
        logger.warn(
          { jobId: job.id },
          "job was reaped during execution — skipping failure update to avoid double-counting",
        );
        continue;
      }
      logger.error(
        {
          jobId: job.id,
          error: message,
          attempts: failure.attempts,
          backoffMs: failure.backoffMs,
        },
        "job failed",
      );
    }
  }
}

async function main() {
  logger.info("AI worker started, polling for jobs…");
  try {
    while (true) {
      try {
        await tick();
      } catch (err) {
        logger.error({ err }, "tick failed");
      }
      // F-010: 优雅关停 — 当前作业结束后退出。
      if (shuttingDown) {
        logger.info("shutdown complete, exiting");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  logger.error({ err }, "AI worker stopped unexpectedly");
  process.exitCode = 1;
});
