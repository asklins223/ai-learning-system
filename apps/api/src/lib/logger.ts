import pino from "pino";

const usePrettyTransport =
  process.env.NODE_ENV !== "production" &&
  process.env.NODE_TEST_CONTEXT === undefined;

export const loggerOptions =
  usePrettyTransport
    ? {
        level: process.env.LOG_LEVEL ?? "info",
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
      }
    : { level: process.env.LOG_LEVEL ?? "info" };

export const logger = pino(loggerOptions);
