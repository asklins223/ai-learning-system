export interface GracefulShutdownOptions {
  clearTimer: () => void;
  closeServer: () => Promise<void>;
  /** 2026-08-11：server 关闭后、DB 关闭前的附加清理（如常驻 NOTIFY 连接） */
  afterClose?: () => void;
  closeDatabase: () => Promise<void>;
}

export interface GracefulShutdownController {
  isShuttingDown: () => boolean;
  shutdown: (signal: NodeJS.Signals) => Promise<void>;
}

/**
 * Build one idempotent shutdown path. Repeated SIGTERM/SIGINT notifications
 * share the same promise, the maintenance timer is cleared synchronously, and
 * the database pool is closed only after Fastify has drained active requests.
 */
export function createGracefulShutdown(
  options: GracefulShutdownOptions,
): GracefulShutdownController {
  let shutdownPromise: Promise<void> | null = null;

  return {
    isShuttingDown: () => shutdownPromise !== null,
    shutdown: (_signal) => {
      if (!shutdownPromise) {
        options.clearTimer();
        shutdownPromise = (async () => {
          let serverError: unknown;
          // 2026-08-11：closeServer 有界——Fastify 的 app.close() 等待所有
          // 连接/插件，某个挂起的 keep-alive 连接会让优雅关闭无限挂起
          //（编排器最终 SIGKILL）。10s 后继续 DB 关闭流程。
          try {
            await Promise.race([
              options.closeServer(),
              new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 10_000);
                timer.unref();
              }),
            ]);
          } catch (error) {
            serverError = error;
          }

          options.afterClose?.();
          try {
            await options.closeDatabase();
          } catch (databaseError) {
            if (serverError) {
              throw new AggregateError(
                [serverError, databaseError],
                "server and database shutdown failed",
              );
            }
            throw databaseError;
          }

          if (serverError) throw serverError;
        })();
      }
      return shutdownPromise;
    },
  };
}
