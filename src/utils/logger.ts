import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let currentLogLevel: LogLevel = 'info';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

export const logger = {
  debug: (message: string, ...args: unknown[]) => {
    if (shouldLog('debug')) {
      console.log(chalk.gray(`[debug] ${message}`), ...args);
    }
  },

  info: (message: string, ...args: unknown[]) => {
    if (shouldLog('info')) {
      console.log(chalk.blue(`ℹ ${message}`), ...args);
    }
  },

  success: (message: string, ...args: unknown[]) => {
    if (shouldLog('info')) {
      console.log(chalk.green(`✔ ${message}`), ...args);
    }
  },

  warn: (message: string, ...args: unknown[]) => {
    if (shouldLog('warn')) {
      console.log(chalk.yellow(`⚠ ${message}`), ...args);
    }
  },

  error: (message: string, ...args: unknown[]) => {
    if (shouldLog('error')) {
      console.error(chalk.red(`✖ ${message}`), ...args);
    }
  },

  highlight: (message: string) => {
    console.log(chalk.cyan(message));
  },
};
