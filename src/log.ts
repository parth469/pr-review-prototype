import { resolve } from "node:path";
import { type Logger as PinoLogger, pino, type TransportTargetOptions, transport } from "pino";

export type Logger = PinoLogger;

export interface LoggerOptions {
  /** Folder for rotating log files. Omit to log to the console only (tests, one-off tools). */
  logDir?: string;
  fileName?: string;
}

export function createLogger(
  level: string,
  { logDir, fileName = "proxy-reviewer.log" }: LoggerOptions = {},
): Logger {
  const targets: TransportTargetOptions[] = [];
  if (logDir) {
    targets.push({
      target: "pino-roll",
      level,
      options: {
        file: resolve(logDir, fileName),
        frequency: "daily",
        dateFormat: "yyyy-MM-dd",
        size: "10m",
        limit: { count: 7, removeOtherLogFiles: true },
        mkdir: true,
      },
    });
  }
  if (process.stdout.isTTY) {
    // Pretty output for a person at a terminal.
    targets.push({
      target: "pino-pretty",
      level,
      options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
    });
  } else if (!logDir) {
    targets.push({ target: "pino/file", level, options: { destination: 1 } });
  }
  return pino({ level }, transport({ targets }));
}
