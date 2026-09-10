/**
 * Skills Sync Client — Low-level sync layer for push/pull.
 *
 * Hermes equivalent: skills_sync_client.py (2,187 lines)
 *
 * Provides:
 * - Content-addressed objects (blob/tree/commit)
 * - Push/pull with sync plane
 * - Three-way merge on conflicts
 * - Sync manifest management
 * - Access gate (admin-only)
 */
export type ObjectType = 'blob' | 'tree' | 'commit';
export interface SyncObject {
    kind: ObjectType;
    hash: string;
    size: number;
    data?: string | Buffer;
}
export interface TreeEntry {
    name: string;
    mode: 'file' | 'exec' | 'dir';
    hash: string;
}
export interface CommitObject {
    tree: string;
    parents: string[];
    message: string;
    timestamp: number;
    author: string;
}
export interface SyncStatus {
    local: {
        head?: string;
        ahead: number;
        behind: number;
    };
    remote: {
        head?: string;
    };
    needsSync: boolean;
}
export declare class ContentAddressedStore {
    private storeDir;
    constructor(storeDir: string);
    /**
     * Store a blob.
     */
    storeBlob(data: string | Buffer): string;
    /**
     * Retrieve a blob.
     */
    getBlob(hash: string): Buffer | null;
    /**
     * Store a tree.
     */
    storeTree(entries: TreeEntry[]): string;
    /**
     * Retrieve a tree.
     */
    getTree(hash: string): TreeEntry[] | null;
    /**
     * Store a commit.
     */
    storeCommit(commit: CommitObject): string;
    /**
     * Retrieve a commit.
     */
    getCommit(hash: string): CommitObject | null;
}
export declare class SkillsSyncClient {
    private store;
    private syncDir;
    private remoteUrl?;
    private accessToken?;
    constructor(options?: {
        syncDir?: string;
        remoteUrl?: string;
        accessToken?: string;
    });
    /**
     * Build a tree from a skills directory.
     */
    buildTree(skillsDir: string): TreeEntry[];
    /**
     * Create a commit from current state.
     */
    commit(skillsDir: string, message: string, author?: string): string;
    /**
     * Get current HEAD.
     */
    getHead(): string | null;
    /**
     * Set HEAD.
     */
    private setHead;
    /**
     * Push local state to remote.
     */
    push(): Promise<{
        success: boolean;
        pushed: number;
        error?: string;
    }>;
    /**
     * Pull remote state.
     */
    pull(): Promise<{
        success: boolean;
        pulled: number;
        error?: string;
    }>;
    /**
     * Get sync status.
     */
    getStatus(): SyncStatus;
    private getAllObjects;
}
export declare function getSkillsSyncClient(options?: {
    remoteUrl?: string;
    accessToken?: string;
}): SkillsSyncClient;
export declare function resetSkillsSyncClient(): void;
//# sourceMappingURL=skills-sync-client.d.ts.map