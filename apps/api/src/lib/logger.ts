import pino from "pino";
import { safeErrorSerializer } from "@ailearn/shared";

const usePrettyTransport =
  process.env.NODE_ENV !== "production" &&
  process.env.NODE_TEST_CONTEXT === undefined;

const serializers = {
  err: safeErrorSerializer,
  error: safeErrorSerializer,
  cause: safeErrorSerializer,
};

export const loggerOptions: pino.LoggerOptions =
  usePrettyTransport
    ? {
        level: process.env.LOG_LEVEL ?? "info",
        serializers,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
      }
    : { level: process.env.LOG_LEVEL ?? "info", serializers };

export const logger = pino(loggerOptions);
