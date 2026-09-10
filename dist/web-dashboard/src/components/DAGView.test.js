"use strict";
/**
 * Tests for DAGView's Run Timeline integration.
 *
 * Regression coverage for the reviewer-flagged bug: the scrubbable phase
 * timeline must remain reachable for HISTORICAL runs even when no pipeline is
 * live — previously the empty-state early return hid every persisted run the
 * moment no DAG was active, defeating the whole point of persisting runs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const DAGView_1 = __importDefault(require("./DAGView"));
const makeRun = () => ({
    id: 'run-1',
    goal: 'Refactor the router',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_030_000,
    success: true,
    totalDurationMs: 30_000,
    phases: [
        { id: 'a', agentType: 'planner', status: 'completed', description: 'Plan the refactor', durationMs: 10_000 },
        { id: 'b', agentType: 'writer', status: 'completed', description: 'Apply the refactor', durationMs: 20_000 },
    ],
});
const makeData = (partial) => ({ cost: {}, history: {}, benchmarks: {}, memory: {}, health: {}, serverTime: Date.now(), ...partial });
(0, vitest_1.describe)('DAGView Run Timeline', () => {
    (0, vitest_1.it)('shows the timeline for historical runs even with no live DAG (regression)', () => {
        (0, react_1.render)(<DAGView_1.default data={makeData({ pipelineRuns: { total: 1, runs: [makeRun()] } })}/>);
        // Timeline + run goal render instead of the empty state
        (0, vitest_1.expect)(react_1.screen.getByText(/run timeline/i)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('Refactor the router')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('Plan the refactor')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.queryByText('No Active Pipeline')).toBeNull();
    });
    (0, vitest_1.it)('falls back to the empty state when there are neither runs nor a live DAG', () => {
        (0, react_1.render)(<DAGView_1.default data={makeData({})}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('No Active Pipeline')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.queryByText(/run timeline/i)).toBeNull();
    });
    (0, vitest_1.it)('renders both the live DAG and the timeline when a pipeline is active', () => {
        (0, react_1.render)(<DAGView_1.default data={makeData({
                dag: {
                    pipeline: 'Fix the auth bug',
                    nodes: [
                        { id: 'n1', agentType: 'planner', status: 'completed', description: 'Plan the fix', startedAt: 100, completedAt: 500 },
                        { id: 'n2', agentType: 'writer', status: 'running', description: 'Write the fix', startedAt: 500 },
                    ],
                    edges: [{ from: 'n1', to: 'n2' }],
                    timestamp: 600,
                    active: true,
                },
                pipelineRuns: { total: 0, runs: [] },
            })}/>);
        // Appears in the status bar AND the timeline run chip
        (0, vitest_1.expect)(react_1.screen.getAllByText('Fix the auth bug').length).toBeGreaterThan(0);
        // Live DAG status bar meta (badge includes the ▶ glyph)
        (0, vitest_1.expect)(react_1.screen.getByText(/1 running/)).toBeTruthy();
        // Timeline renders for the live run too
        (0, vitest_1.expect)(react_1.screen.getByText(/run timeline/i)).toBeTruthy();
    });
    // ─── Phase 4 (AGENTIC_CAPABILITY_ASSESSMENT Addendum v4) — engine badge +
    // loop-turn telemetry card.
    (0, vitest_1.it)('Phase 4 — badges the pipeline engine in the status bar', () => {
        (0, react_1.render)(<DAGView_1.default data={makeData({
                dag: {
                    pipeline: 'CI run',
                    nodes: [{ id: 'n1', agentType: 'planner', status: 'completed', description: 'Plan' }],
                    edges: [],
                    timestamp: 1,
                    active: false,
                    engine: 'pipeline',
                    engineExplanation: 'CI pins the orchestrator',
                },
                pipelineRuns: { total: 0, runs: [] },
            })}/>);
        const badge = react_1.screen.getByTestId('dag-engine-badge');
        (0, vitest_1.expect)(badge.textContent).toContain('pipeline');
    });
    (0, vitest_1.it)('Phase 4 — renders the loop-turn telemetry card even with no DAG nodes', () => {
        (0, react_1.render)(<DAGView_1.default data={makeData({
                dag: {
                    pipeline: null,
                    nodes: [],
                    edges: [],
                    timestamp: 1,
                    active: true,
                    engine: 'loop',
                    loopTurn: {
                        turnId: 'turn-1',
                        title: 'assess the code quality',
                        startedAt: Date.now() - 5_000,
                        active: true,
                        toolCallCount: 3,
                        erroredToolCount: 1,
                        provider: 'groq',
                        model: 'llama-3.3-70b',
                        toolCalls: [
                            { tool: 'read_file', ok: true, durationMs: 12 },
                            { tool: 'code_search', ok: true, durationMs: 30 },
                            { tool: 'edit_file', ok: false, error: 'match not found' },
                        ],
                    },
                },
                pipelineRuns: { total: 0, runs: [] },
            })}/>);
        // The turn card renders (not the empty state) — per-tool telemetry visible
        (0, vitest_1.expect)(react_1.screen.getByTestId('dag-loop-turn-card')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/assess the code quality/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/3 tool calls/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/1 errored/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('✓ read_file')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('❌ edit_file')).toBeTruthy();
        // Provider chip
        (0, vitest_1.expect)(react_1.screen.getByText(/groq · llama-3.3-70b/)).toBeTruthy();
    });
    (0, vitest_1.it)('Phase 4 — the loop-turn card shows bounded / generation-failed chips', () => {
        (0, react_1.render)(<DAGView_1.default data={makeData({
                dag: {
                    pipeline: null,
                    nodes: [],
                    edges: [],
                    timestamp: 1,
                    active: false,
                    engine: 'loop',
                    loopTurn: {
                        turnId: 'turn-2',
                        title: 'huge refactor',
                        startedAt: Date.now() - 60_000,
                        endedAt: Date.now(),
                        active: false,
                        toolCallCount: 17,
                        erroredToolCount: 0,
                        bounded: true,
                        toolCalls: [],
                    },
                },
                pipelineRuns: { total: 0, runs: [] },
            })}/>);
        (0, vitest_1.expect)(react_1.screen.getByTestId('dag-loop-turn-card')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/bounded/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/17 tool calls/)).toBeTruthy();
    });
});
