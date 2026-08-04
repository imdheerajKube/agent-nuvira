import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let currentLogLevel: LogLevel = 'info';

/**
 * When true, the logger emits nothing at all (not even errors).
 * Used by machine-readable modes (e.g. `buff execute --json-events`) so the
 * NDJSON stdout stream stays pure — the human-readable event echo (LoggerConsumer)
 * and incidental warn/info lines all flow through the logger, so one switch
 * keeps stdout clean for CI/scripts while the JSON events carry the detail.
 */
let silent = false;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/** Suppress ALL logger output (use with `setSilent(false)` to restore). */
export function setSilent(value: boolean): void {
  silent = value;
}

export function isSilent(): boolean {
  return silent;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

export const logger = {
  debug: (message: string, ...args: unknown[]) => {
    if (silent) return;
    if (shouldLog('debug')) {
      console.log(chalk.gray(`[debug] ${message}`), ...args);
    }
  },

  info: (message: string, ...args: unknown[]) => {
    if (silent) return;
    if (shouldLog('info')) {
      console.log(chalk.blue(`ℹ ${message}`), ...args);
    }
  },

  success: (message: string, ...args: unknown[]) => {
    if (silent) return;
    if (shouldLog('info')) {
      console.log(chalk.green(`✔ ${message}`), ...args);
    }
  },

  warn: (message: string, ...args: unknown[]) => {
    if (silent) return;
    if (shouldLog('warn')) {
      console.log(chalk.yellow(`⚠ ${message}`), ...args);
    }
  },

  error: (message: string, ...args: unknown[]) => {
    if (silent) return;
    if (shouldLog('error')) {
      console.error(chalk.red(`✖ ${message}`), ...args);
    }
  },

  highlight: (message: string) => {
    if (silent) return;
    console.log(chalk.cyan(message));
  },
};
