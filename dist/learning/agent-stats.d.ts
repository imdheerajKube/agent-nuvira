/**
 * AgentStats — Tracks per-agent performance metrics to enable
 * data-driven improvements in agent execution.\n *
 * What it tracks:
 * - Success/failure counts per agent type
 * - Which models perform best for each agent type
 * - Average task duration (optional, for future use)
 * - Total runs count
 *
 * Data is stored as JSON at ~/.buff/memory/agent-stats.json
 * and updated after each orchestration run.
 */
export interface AgentPerformance {
    /** Total attempts */
    totalRuns: number;
    /** Successful completions */
    successfulRuns: number;
    /** Failed completions */
    failedRuns: number;
    /** Success rate (0–1) */
    successRate: number;
    /** Which models have been used and with what success */
    modelPerformance: Record<string, {
        runs: number;
        successes: number;
    }>;
    /** Last time this agent was run */
    lastRun: number;
}
export interface AgentStatsData {
    /** Per-agent stats keyed by agent type (e.g., 'writer', 'planner') */
    agents: Record<string, AgentPerformance>;
    /** Total orchestration runs recorded */
    totalRuns: number;
    /** Overall success rate across all agents */
    overallSuccessRate: number;
    /** When stats were last updated */
    lastUpdated: number;
    /** Schema version */
    version: number;
}
export declare class AgentStats {
    private data;
    constructor();
    /**
     * Record a single agent execution result.
     * Updates per-agent stats and recalculates rates.
     */
    recordRun(agentType: string, success: boolean, model?: string): void;
    /**
     * Record multiple agent runs from an orchestration result.
     */
    recordRuns(runs: Array<{
        agent: string;
        success: boolean;
    }>, modelMap?: Record<string, string>): void;
    /**
     * Get stats for a specific agent type.
     */
    getAgentStats(agentType: string): AgentPerformance | undefined;
    /**
     * Get all agent stats.
     */
    getAllAgents(): Record<string, AgentPerformance>;
    /**
     * Get the best-performing model for a given agent type.
     * Returns undefined if no data is available.
     */
    getBestModel(agentType: string): string | undefined;
    /**
     * Get agents sorted by success rate (ascending — worst performers first).
     * Useful for identifying which agents need attention.
     */
    getWorstPerformers(limit?: number): Array<{
        agentType: string;
        stats: AgentPerformance;
    }>;
    /**
     * Get agents sorted by success rate (descending — best performers first).
     */
    getBestPerformers(limit?: number): Array<{
        agentType: string;
        stats: AgentPerformance;
    }>;
    /**
     * Format stats as a human-readable string.
     */
    formatStats(): string;
    /**
     * Format best model recommendations as a string.
     */
    formatModelRecommendations(): string;
    /**
     * Clear all stats.
     */
    clear(): void;
    /**
     * Get raw data for inspection.
     */
    getRaw(): AgentStatsData;
    private createEmpty;
    private createFresh;
    private recalculateOverallRate;
    private load;
    private save;
    private ensureDir;
}
export declare function getAgentStats(): AgentStats;
//# sourceMappingURL=agent-stats.d.ts.map