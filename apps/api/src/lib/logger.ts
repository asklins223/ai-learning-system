import pino from "pino";

export const loggerOptions =
  process.env.NODE_ENV === "production"
    ? { level: process.env.LOG_LEVEL ?? "info" }
    : {
        level: process.env.LOG_LEVEL ?? "info",
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
      };

export const logger = pino(loggerOptions);