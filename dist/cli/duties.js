/**
 * D2 — Auto-run background duties.
 *
 * At session start the agent runs a few cheap, LOCAL checks itself instead of
 * asking the user to: config + vault + workspace health, and a one-line model
 * status (registry + quota state — sub-ms in-memory reads, no live probing).
 * Results are one-liners via logger; the full interactive report stays behind
 * `nuvira doctor`. NOTE (scoped): `nuvira eval` is NOT auto-run here — a full eval
 * suite at session start would be heavy and burn quota; eval surfaces via its
 * own commands and later E2 board lanes. Only the cheap local checks run.
 *
 * Throttled (default: once per 12h per machine, tracked in
 * `~/.nuvira/duties-last-run.json`) so single-shot commands never spam; silent
 * in `--json-events` mode so stdout stays pure NDJSON. Best-effort — a
 * failure never breaks session start.
 *
 * Cross-command parity (STANDING RULE): chat / execute / plan / run all call
 * `maybeRunBackgroundDuties` from their session-start path.
 */ import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNuviraHome } from '../config/paths.js';
import { resolveBuffConfigDir } from '../config/paths.js';
import { logger } from '../utils/logger.js';
import { getModelRegistry } from '../learning/model-registry.js';
// ─── Throttle state ─────────────────────────────────────────────────────────
const DEFAULT_THROTTLE_MS = 12 * 60 * 60 * 1000;
function statePath() {
    // Scoped to the ACTIVE config dir (honors NUVIRA_CONFIG_DIR) so separate
    // config dirs / CI runs never share one throttle state file.
    return join(resolveBuffConfigDir(), 'duties-last-run.json');
}
function shouldRun(throttleMs) {
    try {
        const now = Date.now();
        if (!existsSync(statePath()))
            return true;
        const state = JSON.parse(readFileSync(statePath(), 'utf-8'));
        return now - (state.lastRunAt || 0) >= throttleMs;
    }
    catch {
        // Corrupt/missing state → run (safe default).
        return true;
    }
}
function markRun() {
    try {
        const dir = resolveNuviraHome();
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        writeFileSync(statePath(), JSON.stringify({ lastRunAt: Date.now() }), 'utf-8');
    }
    catch { /* best-effort */ }
}
/**
 * Run the throttled session-start duties. Never throws; never blocks long —
 * every source is a fast local read wrapped in best-effort try/catch.
 */
export async function maybeRunBackgroundDuties(configManager, opts = {}) {
    if (!opts.force && !shouldRun(opts.throttleMs ?? DEFAULT_THROTTLE_MS)) {
        return { ran: false };
    }
    markRun();
    // ── Health line (config + vault + workspace — all local, fast) ─────────
    // Each source is individually best-effort (a failing source drops only its
    // own segment, never the whole line).
    let healthLine;
    const parts = [];
    try {
        const all = configManager.getAll();
        const providers = all?.providers ?? {};
        const configured = Object.values(providers).filter((c) => !!c && typeof c === 'object').length;
        parts.push(`${configured} provider(s) configured`);
    }
    catch { /* config read must never break */ }
    try {
        const vault = configManager.getVault();
        if (vault) {
            const vs = vault.status();
            parts.push(`vault: ${vs.tier ?? 'ok'}`);
        }
    }
    catch { /* vault must never break */ }
    try {
        const ws = configManager.getWorkspaceStore().status(process.cwd());
        parts.push(`workspace: ${ws.backend} (${ws.projectCount} project(s))`);
    }
    catch { /* workspace must never break */ }
    if (parts.length > 0)
        healthLine = `🩺 ${parts.join(' · ')}`;
    // ── Models line (registry + quota state — sub-ms, no network) ───────────
    let modelsLine;
    try {
        const s = await getModelRegistry().getStatus();
        const bits = [`${s.verified ?? 0} verified model(s)`];
        if ((s.unavailable ?? 0) > 0)
            bits.push(`${s.unavailable} blocked`);
        if ((s.parked ?? 0) > 0)
            bits.push(`${s.parked} quota-parked`);
        modelsLine = `🤖 ${bits.join(' · ')}`;
    }
    catch { /* models must never break */ }
    if (!opts.silent) {
        if (healthLine)
            logger.info(healthLine);
        if (modelsLine)
            logger.info(modelsLine);
    }
    return { ran: true, healthLine, modelsLine };
}
//# sourceMappingURL=duties.js.map