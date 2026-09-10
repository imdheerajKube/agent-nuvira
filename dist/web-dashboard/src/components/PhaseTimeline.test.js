"use strict";
/**
 * Unit tests for the scrubbable PhaseTimeline component (llm-viz-inspired).
 *
 * Covers the empty state, run rendering (phase blocks + meta), scrub-to-phase
 * via block click (the jsdom-safe path — no getBoundingClientRect needed),
 * run switching, play/pause toggling, and the dagToPipelineRun /
 * collectPipelineRuns helpers that derive runs from the live DAG + persisted
 * pipeline-runs.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const PhaseTimeline_1 = __importStar(require("./PhaseTimeline"));
// ─── Fixtures ───────────────────────────────────────────────────────────────
const makeRun = (overrides = {}) => ({
    id: 'run-1',
    goal: 'Implement JWT auth middleware',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    success: true,
    totalDurationMs: 60_000,
    phases: [
        {
            id: 'p1',
            agentType: 'planner',
            status: 'completed',
            description: 'Break the goal into tasks',
            complexity: 'moderate',
            summary: 'Planned 4 steps',
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_010_000,
            durationMs: 10_000,
        },
        {
            id: 'p2',
            agentType: 'writer',
            status: 'completed',
            description: 'Write the middleware',
            complexity: 'simple',
            summary: 'Wrote src/middleware/auth.ts',
            startedAt: 1_700_000_010_000,
            completedAt: 1_700_000_040_000,
            durationMs: 30_000,
        },
        {
            id: 'p3',
            agentType: 'tester',
            status: 'failed',
            description: 'Run the test suite',
            complexity: 'simple',
            startedAt: 1_700_000_040_000,
            completedAt: 1_700_000_060_000,
            durationMs: 20_000,
        },
    ],
    ...overrides,
});
// ─── Component behavior ─────────────────────────────────────────────────────
(0, vitest_1.describe)('PhaseTimeline — Phase 4 engine chips', () => {
    (0, vitest_1.it)('badges a loop-engine run chip with the loop glyph and the telemetry meta', () => {
        const run = makeRun({
            id: 'loop-turn-1',
            goal: 'assess the code quality',
            engine: 'loop',
            turnTelemetry: { toolCallCount: 4, erroredToolCount: 1, provider: 'groq', model: 'llama-3.3-70b' },
        });
        (0, react_1.render)(<PhaseTimeline_1.default runs={[run]}/>);
        // Engine badge in the meta row
        (0, vitest_1.expect)(react_1.screen.getByText('🔁 loop')).toBeTruthy();
        // Per-turn telemetry chip (🔧 count + errored parenthetical)
        (0, vitest_1.expect)(react_1.screen.getByText(/🔧 4/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/\(1 err\)/)).toBeTruthy();
    });
    (0, vitest_1.it)('badges a pipeline run with the pipeline glyph and no telemetry chip', () => {
        const run = makeRun({ id: 'pipe-1', engine: 'pipeline' });
        (0, react_1.render)(<PhaseTimeline_1.default runs={[run]}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('⬡ pipeline')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.queryByText(/🔧/)).toBeNull();
    });
    (0, vitest_1.it)('shows no engine badge for legacy runs without one', () => {
        (0, react_1.render)(<PhaseTimeline_1.default runs={[makeRun()]}/>);
        (0, vitest_1.expect)(react_1.screen.queryByText(/🔁 loop/)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText(/⬡ pipeline/)).toBeNull();
    });
});
(0, vitest_1.describe)('PhaseTimeline', () => {
    (0, vitest_1.it)('renders the empty state when there are no runs', () => {
        (0, react_1.render)(<PhaseTimeline_1.default runs={[]}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/no pipeline runs yet/i)).toBeTruthy();
    });
    (0, vitest_1.it)('renders phase blocks, step meta, and the run goal', () => {
        (0, react_1.render)(<PhaseTimeline_1.default runs={[makeRun()]}/>);
        // Run chip with goal
        (0, vitest_1.expect)(react_1.screen.getByText('Implement JWT auth middleware')).toBeTruthy();
        // Meta: 3 steps, 2 done, 1 failed, total duration
        (0, vitest_1.expect)(react_1.screen.getByText('3 steps')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('✅ 2')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('❌ 1')).toBeTruthy();
        // Phase labels on blocks (also appear in the detail panel — use *AllBy*)
        (0, vitest_1.expect)(react_1.screen.getAllByText('Planner').length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getAllByText('Writer').length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getAllByText('Tester').length).toBeGreaterThan(0);
        // Default detail panel shows the first phase under the caret
        (0, vitest_1.expect)(react_1.screen.getByText('Break the goal into tasks')).toBeTruthy();
    });
    (0, vitest_1.it)('scrubs to a phase on block click and notifies the parent via onScrub', () => {
        const onScrub = vitest_1.vi.fn();
        (0, react_1.render)(<PhaseTimeline_1.default runs={[makeRun()]} onScrub={onScrub}/>);
        const testerBlock = react_1.screen.getByText('Tester').closest('button');
        react_1.fireEvent.click(testerBlock);
        (0, vitest_1.expect)(onScrub).toHaveBeenCalledWith('p3');
        // Detail panel now describes the scrubbed phase
        (0, vitest_1.expect)(react_1.screen.getByText('Run the test suite')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('❌ Failed')).toBeTruthy();
    });
    (0, vitest_1.it)('switches runs via the selector chips and resets the caret', () => {
        const second = makeRun({ id: 'run-2', goal: 'Fix flaky test', phases: [
                { id: 'q1', agentType: 'reviewer', status: 'completed', description: 'Review the diff', durationMs: 5_000 },
            ] });
        const onSelectRun = vitest_1.vi.fn();
        (0, react_1.render)(<PhaseTimeline_1.default runs={[makeRun(), second]} onSelectRun={onSelectRun}/>);
        react_1.fireEvent.click(react_1.screen.getByText('Fix flaky test'));
        (0, vitest_1.expect)(onSelectRun).toHaveBeenCalledWith('run-2');
        (0, vitest_1.expect)(react_1.screen.getByText('Review the diff')).toBeTruthy();
    });
    (0, vitest_1.it)('toggles play/pause on the scrub button', () => {
        (0, react_1.render)(<PhaseTimeline_1.default runs={[makeRun()]}/>);
        const playBtn = react_1.screen.getByRole('button', { name: 'Play scrub' });
        react_1.fireEvent.click(playBtn);
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: 'Pause scrub' })).toBeTruthy();
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: 'Pause scrub' }));
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: 'Play scrub' })).toBeTruthy();
    });
});
// ─── Run derivation helpers ─────────────────────────────────────────────────
(0, vitest_1.describe)('dagToPipelineRun', () => {
    (0, vitest_1.it)('returns null for empty/missing DAGs', () => {
        (0, vitest_1.expect)((0, PhaseTimeline_1.dagToPipelineRun)(null)).toBeNull();
        (0, vitest_1.expect)((0, PhaseTimeline_1.dagToPipelineRun)(undefined)).toBeNull();
        (0, vitest_1.expect)((0, PhaseTimeline_1.dagToPipelineRun)({ nodes: [] })).toBeNull();
    });
    (0, vitest_1.it)('derives a run with proportional phases from live DAG nodes', () => {
        const dag = {
            pipeline: 'Refactor router',
            nodes: [
                { id: 'a', agentType: 'planner', status: 'completed', description: 'Plan', startedAt: 100, completedAt: 400 },
                { id: 'b', agentType: 'writer', status: 'completed', description: 'Write', startedAt: 400, completedAt: 700 },
            ],
            edges: [{ from: 'a', to: 'b' }],
            timestamp: 700,
            active: false,
        };
        const run = (0, PhaseTimeline_1.dagToPipelineRun)(dag);
        (0, vitest_1.expect)(run.id).toMatch(/^live-/);
        (0, vitest_1.expect)(run.goal).toBe('Refactor router');
        (0, vitest_1.expect)(run.phases).toHaveLength(2);
        (0, vitest_1.expect)(run.phases[0].durationMs).toBe(300);
        (0, vitest_1.expect)(run.totalDurationMs).toBe(600);
        (0, vitest_1.expect)(run.success).toBe(true);
    });
    (0, vitest_1.it)('marks a run failed when any node failed', () => {
        const dag = {
            pipeline: 'X',
            nodes: [
                { id: 'a', agentType: 'planner', status: 'completed', description: 'Plan', startedAt: 100, completedAt: 200 },
                { id: 'b', agentType: 'tester', status: 'failed', description: 'Test', startedAt: 200, completedAt: 300 },
            ],
            edges: [],
            timestamp: 300,
            active: false,
        };
        (0, vitest_1.expect)((0, PhaseTimeline_1.dagToPipelineRun)(dag).success).toBe(false);
    });
});
(0, vitest_1.describe)('collectPipelineRuns', () => {
    (0, vitest_1.it)('places the live run first and de-duplicates by id', () => {
        // Live-run id is derived from the DAG start time (live-<startedAt>).
        const dag = {
            pipeline: 'Live run',
            nodes: [
                { id: 'a', agentType: 'planner', status: 'completed', description: 'Plan', startedAt: 100, completedAt: 400 },
            ],
            edges: [],
            timestamp: 400,
            active: false,
        };
        const storedRun = makeRun({ id: 'run-9' });
        const runs = (0, PhaseTimeline_1.collectPipelineRuns)(dag, { total: 2, runs: [storedRun, makeRun({ id: 'live-100', goal: 'duplicate' })] });
        (0, vitest_1.expect)(runs.map((r) => r.id)).toEqual(['live-100', 'run-9']);
    });
    (0, vitest_1.it)('falls back to stored runs only when there is no live DAG', () => {
        const storedRun = makeRun();
        const runs = (0, PhaseTimeline_1.collectPipelineRuns)(null, { total: 1, runs: [storedRun] });
        (0, vitest_1.expect)(runs).toHaveLength(1);
        (0, vitest_1.expect)(runs[0].id).toBe('run-1');
    });
    (0, vitest_1.it)('returns an empty list when both inputs are empty', () => {
        (0, vitest_1.expect)((0, PhaseTimeline_1.collectPipelineRuns)(null, undefined)).toEqual([]);
    });
});
