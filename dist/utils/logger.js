import chalk from 'chalk';
let currentLogLevel = 'info';
/**
 * When true, the logger emits nothing at all (not even errors).
 * Used by machine-readable modes (e.g. `buff execute --json-events`) so the
 * NDJSON stdout stream stays pure — the human-readable event echo (LoggerConsumer)
 * and incidental warn/info lines all flow through the logger, so one switch
 * keeps stdout clean for CI/scripts while the JSON events carry the detail.
 */
let silent = false;
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
export function setLogLevel(level) {
    currentLogLevel = level;
}
/** Suppress ALL logger output (use with `setSilent(false)` to restore). */
export function setSilent(value) {
    silent = value;
}
export function isSilent() {
    return silent;
}
function shouldLog(level) {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}
export const logger = {
    debug: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('debug')) {
            console.log(chalk.gray(`[debug] ${message}`), ...args);
        }
    },
    info: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('info')) {
            console.log(chalk.blue(`ℹ ${message}`), ...args);
        }
    },
    success: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('info')) {
            console.log(chalk.green(`✔ ${message}`), ...args);
        }
    },
    warn: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('warn')) {
            console.log(chalk.yellow(`⚠ ${message}`), ...args);
        }
    },
    error: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('error')) {
            console.error(chalk.red(`✖ ${message}`), ...args);
        }
    },
    highlight: (message) => {
        if (silent)
            return;
        console.log(chalk.cyan(message));
    },
};
//# sourceMappingURL=logger.js.map