/**
 * Team Memory — Git-synced shared memory for team collaboration.
 *
 * The team memory is stored in a git repository at `~/.buff/team/` (or a
 * configurable path). It contains:
 *
 *   trajectories/  — Shared agent execution trajectories (JSON)
 *   patterns/      — Project-level coding patterns (JSON)
 *   templates/     — Team workflow templates (JSON)
 *
 * Commands:
 *   buff team join <repo-url>  — Clone the team repo
 *   buff team sync             — Pull latest + push local changes
 *   buff team share            — Share local trajectories with team
 *
 * The sync operation:
 *   1. Pull latest from remote
 *   2. Apply local changes on top
 *   3. Commit new trajectories/patterns
 *   4. Push to remote
 *
 * Authentication is via Git credentials (SSH key or git-credential helper).
 */
export interface TeamMemoryStats {
    /** Number of shared trajectories */
    trajectoryCount: number;
    /** Number of shared patterns */
    patternCount: number;
    /** Number of shared workflow templates */
    templateCount: number;
    /** Whether git is configured */
    gitConfigured: boolean;
    /** Current git branch */
    branch: string;
    /** Uncommitted changes count */
    uncommittedChanges: number;
    /** Last sync time */
    lastSync: string | null;
}
export interface SyncResult {
    pulled: number;
    pushed: number;
    conflicts: string[];
    errors: string[];
}
/**
 * Initialize the team memory directory as a git repository.
 * Called by `buff team join` or `buff team init`.
 */
export declare function initTeamMemory(repoUrl?: string, cwd?: string): Promise<void>;
/**
 * Sync team memory with remote: pull latest, push local changes.
 */
export declare function syncTeamMemory(cwd?: string): Promise<SyncResult>;
/**
 * Share local trajectories with the team by copying them to the team memory directory.
 */
export declare function shareTrajectories(cwd?: string): Promise<number>;
/**
 * Get team memory statistics.
 */
export declare function getTeamMemoryStats(cwd?: string): TeamMemoryStats;
//# sourceMappingURL=memory.d.ts.map