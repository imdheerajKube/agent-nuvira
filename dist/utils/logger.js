import chalk from 'chalk';
import { applyRedaction, redactValue } from '../enterprise/secrets.js';
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
/**
 * Redact a log line (message + any extra args) before it reaches the console
 * (P6 M6.2). Never throws: if redaction fails for any reason, the original
 * line is logged unchanged (logging must never break).
 */
function scrub(line, args) {
    try {
        return {
            line: applyRedaction(line),
            args: args.map((a) => redactValue(a)),
        };
    }
    catch {
        return { line, args };
    }
}
export const logger = {
    debug: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('debug')) {
            const s = scrub(message, args);
            console.log(chalk.gray(`[debug] ${s.line}`), ...s.args);
        }
    },
    info: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('info')) {
            const s = scrub(message, args);
            console.log(chalk.blue(`ℹ ${s.line}`), ...s.args);
        }
    },
    success: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('info')) {
            const s = scrub(message, args);
            console.log(chalk.green(`✔ ${s.line}`), ...s.args);
        }
    },
    warn: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('warn')) {
            const s = scrub(message, args);
            console.log(chalk.yellow(`⚠ ${s.line}`), ...s.args);
        }
    },
    error: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('error')) {
            const s = scrub(message, args);
            console.error(chalk.red(`✖ ${s.line}`), ...s.args);
        }
    },
    highlight: (message) => {
        if (silent)
            return;
        console.log(chalk.cyan(applyRedaction(message)));
    },
};
//# sourceMappingURL=logger.js.map