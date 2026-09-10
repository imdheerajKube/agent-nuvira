import type { ConfigManager } from '../config/manager.js';
export interface BackgroundDutiesOptions {
    /** Bypass the throttle (explicit invocation). */
    force?: boolean;
    /** Suppress logger output (machine-readable modes). */
    silent?: boolean;
    /** Throttle window override (tests). */
    throttleMs?: number;
}
export interface BackgroundDutiesResult {
    ran: boolean;
    healthLine?: string;
    modelsLine?: string;
}
/**
 * Run the throttled session-start duties. Never throws; never blocks long —
 * every source is a fast local read wrapped in best-effort try/catch.
 */
export declare function maybeRunBackgroundDuties(configManager: ConfigManager, opts?: BackgroundDutiesOptions): Promise<BackgroundDutiesResult>;
//# sourceMappingURL=duties.d.ts.map