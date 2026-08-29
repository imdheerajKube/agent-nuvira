import chalk from 'chalk';
import { applyRedaction, redactValue } from '../enterprise/secrets.js';
import { isJsonLogMode, jsonLogLine } from '../enterprise/log.js';
let currentLogLevel = 'info';
/**
 * When true, the logger emits nothing at all (not even errors).
 * Used by machine-readable modes (e.g. `nuvira execute --json-events`) so the
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
/**
 * Emit a line — JSON mode (K1) when BUFF_LOG_JSON=1, else chalk text.
 * `success` is a display-only level (info-weight): the JSON record uses the
 * canonical `info` level so consumers see one of the four LogLevel values.
 */
function emit(level, message, args) {
    if (isJsonLogMode()) {
        const line = jsonLogLine(level === 'success' ? 'info' : level, message, args);
        if (level === 'error') {
            console.error(line);
        }
        else {
            console.log(line);
        }
        return;
    }
    if (level === 'error') {
        console.error(chalk.red(`✖ ${message}`), ...args);
        return;
    }
    const prefix = level === 'debug' ? chalk.gray('[debug]') :
        level === 'warn' ? chalk.yellow('⚠') :
            level === 'success' ? chalk.green('✔') :
                chalk.blue('ℹ');
    console.log(`${prefix} ${message}`, ...args);
}
export const logger = {
    debug: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('debug')) {
            const s = scrub(message, args);
            emit('debug', s.line, s.args);
        }
    },
    info: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('info')) {
            const s = scrub(message, args);
            emit('info', s.line, s.args);
        }
    },
    success: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('info')) {
            const s = scrub(message, args);
            emit('success', s.line, s.args);
        }
    },
    warn: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('warn')) {
            const s = scrub(message, args);
            emit('warn', s.line, s.args);
        }
    },
    error: (message, ...args) => {
        if (silent)
            return;
        if (shouldLog('error')) {
            const s = scrub(message, args);
            emit('error', s.line, s.args);
        }
    },
    highlight: (message) => {
        if (silent)
            return;
        console.log(chalk.cyan(applyRedaction(message)));
    },
};
//# sourceMappingURL=logger.js.map