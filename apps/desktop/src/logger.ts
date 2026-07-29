import log from "electron-log";
import { app } from "electron";
import * as path from "node:path";

const logDir = app
  ? path.join(app.getPath("userData"), "logs")
  : process.cwd();

log.transports.file.level = "info";
log.transports.file.resolvePathFn = () => path.join(logDir, "main.log");
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB
log.transports.console.level = process.env.NODE_ENV === "development" ? "debug" : "info";

export const logger = log;
