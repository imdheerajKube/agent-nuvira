import chalk from 'chalk';
let currentLogLevel = 'info';
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
export function setLogLevel(level) {
    currentLogLevel = level;
}
function shouldLog(level) {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}
export const logger = {
    debug: (message, ...args) => {
        if (shouldLog('debug')) {
            console.log(chalk.gray(`[debug] ${message}`), ...args);
        }
    },
    info: (message, ...args) => {
        if (shouldLog('info')) {
            console.log(chalk.blue(`ℹ ${message}`), ...args);
        }
    },
    success: (message, ...args) => {
        if (shouldLog('info')) {
            console.log(chalk.green(`✔ ${message}`), ...args);
        }
    },
    warn: (message, ...args) => {
        if (shouldLog('warn')) {
            console.log(chalk.yellow(`⚠ ${message}`), ...args);
        }
    },
    error: (message, ...args) => {
        if (shouldLog('error')) {
            console.error(chalk.red(`✖ ${message}`), ...args);
        }
    },
    highlight: (message) => {
        console.log(chalk.cyan(message));
    },
};
//# sourceMappingURL=logger.js.map