export interface GracefulShutdownOptions {
  clearTimer: () => void;
  closeServer: () => Promise<void>;
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
          try {
            await options.closeServer();
          } catch (error) {
            serverError = error;
          }

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
