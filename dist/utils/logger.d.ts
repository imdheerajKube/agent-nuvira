export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export declare function setLogLevel(level: LogLevel): void;
/** Suppress ALL logger output (use with `setSilent(false)` to restore). */
export declare function setSilent(value: boolean): void;
export declare function isSilent(): boolean;
export declare const logger: {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    success: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
    highlight: (message: string) => void;
};
//# sourceMappingURL=logger.d.ts.map