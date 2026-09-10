/**
 * Phase 4 loop-turn telemetry sink (`src/web-dashboard/loop-turn-telemetry.ts`)
 * — AGENTIC_CAPABILITY_ASSESSMENT Addendum v4 Phase 4.
 *
 * The chat console records every real turn into the DAG store (engine badge +
 * per-turn tool-call telemetry) WITHOUT importing the server module directly
 * (a static import would be circular: server.ts constructs ChatConsole).
 *
 * This sink indirection loads `server.ts` lazily the first time a REAL turn
 * begins and binds the store's begin/record functions. Unit tests inject a
 * fake engine into ChatConsole, so in tests this module never loads and the
 * calls are clean no-ops (the `?.` guards) — the DAG store itself is tested
 * directly in tests/web-dashboard/dag-store.test.ts plus the new Phase 4
 * assertions there.
 */
import type { LoopToolCallTelemetry } from './server.js';
/**
 * Begin a loop turn's telemetry window. No-op until the sink has loaded (and
 * forever in unit tests, where the server module is never imported).
 */
export declare function beginLoopTurn(turnId: string, title: string, provider?: string, model?: string): void;
/**
 * Record one tool call of the active loop turn. No-op when the sink has not
 * loaded or no turn is active.
 */
export declare function recordLoopToolCall(call: LoopToolCallTelemetry): void;
//# sourceMappingURL=loop-turn-telemetry.d.ts.map