/**
 * rbac-guard.ts — K4: shared RBAC enforcement for sensitive CLI commands.
 *
 * The RBAC engine (enterprise/rbac.ts) has always been able to DENY — but only
 * `nuvira admin` wired it. K4 extends enforcement to every sensitive surface:
 * config vault migrate, team writes, sbom file writes, and skill gc.
 *
 * Semantics (identical across every guarded command):
 * - Legacy single-user mode (no role file / no users) → fully permissive,
 *   exactly as before — enabling RBAC never locks anyone out.
 * - Once roles are assigned: `guardRbacAction(action)` DENIES with a clear
 *   message and sets exit code 3 (plan K4 spec). Returns true to proceed.
 *
 * A fresh RbacManager is constructed per call so tests can inject a temp role
 * file; CLI processes construct one per invocation anyway.
 */
import { RbacManager, RbacError } from '../enterprise/rbac.js';
import { logger } from '../utils/logger.js';
/**
 * Enforce `action` for the current identity (BUFF_ACT_AS / OS user). Returns
 * true to proceed; false (after logging + setting exit code 3) when denied.
 * Legacy single-user mode short-circuits to permissive.
 */
export function guardRbacAction(action, rbac = new RbacManager()) {
    if (rbac.isLegacyMode())
        return true;
    try {
        rbac.requireCan(action);
        return true;
    }
    catch (err) {
        if (err instanceof RbacError) {
            logger.error(`⛔ ${err.message}`);
            logger.error('   Run `nuvira admin role add <you> admin` once as the initial admin.');
        }
        process.exitCode = 3;
        return false;
    }
}
//# sourceMappingURL=rbac-guard.js.map