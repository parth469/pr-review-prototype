import { type Logger as PinoLogger, pino } from "pino";

export type Logger = PinoLogger;

export function createLogger(level: string): Logger {
  // Pretty output for a person at a terminal; JSON lines when running as a background service.
  if (process.stdout.isTTY) {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
      },
    });
  }
  return pino({ level });
}
