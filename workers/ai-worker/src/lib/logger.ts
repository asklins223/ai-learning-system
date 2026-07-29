import pino from "pino";
import { safeErrorSerializer } from "@ailearn/shared";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    err: safeErrorSerializer,
    error: safeErrorSerializer,
    aiError: safeErrorSerializer,
    repairError: safeErrorSerializer,
    fetchError: safeErrorSerializer,
  },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
});
