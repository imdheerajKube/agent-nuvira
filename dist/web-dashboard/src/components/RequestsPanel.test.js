"use strict";
/**
 * Unit tests for the Requests Panel (Nuvira-Router P3-M3.2).
 * Covers: empty state (no data / older server), stats cards, row rendering,
 * the ≥3-samples latency percentile gate, and the action/search filters.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const RequestsPanel_1 = __importDefault(require("./RequestsPanel"));
const makeRequests = (overrides = {}) => ({
    enabled: true,
    total: 3,
    rows: [
        {
            provider: 'groq', model: 'llama-3.3-70b-versatile', action: 'chat',
            requests: 10, errorRate: 0, partials: 3, costUsd: 0.00012, costCalls: 10,
            latency: { avg: 420, samples: 5, p50: 400, p95: 620, p99: 700 },
            callIds: ['call-1', 'call-2'], lastAt: 1750000000000,
        },
        {
            provider: 'gemini', model: 'gemini-2.0-flash', action: 'execute',
            requests: 4, errorRate: 0.25, partials: 0, costUsd: 0.0008, costCalls: 4,
            latency: { avg: 900, samples: 2 }, // < 3 samples → percentiles hidden
            callIds: [], lastAt: 1749990000000,
        },
        {
            provider: 'nim', model: 'llama-3.1-8b-instruct', action: 'plan',
            requests: 2, errorRate: 0.5, partials: 0, costCalls: 0,
            latency: undefined, callIds: [], lastAt: 1749980000000,
        },
    ],
    updatedAt: Date.now(),
    ...overrides,
});
const makeData = (requests) => ({
    cost: { totalRequests: 0, totalCost: 0, totalTokens: 0, byProvider: {}, byModel: {}, byProviderMeasured: {}, measuredCalls: 0, estimatedCalls: 0, measuredCost: 0, estimatedCost: 0, recent: [] },
    history: { total: 0, recent: [] },
    benchmarks: { totalRuns: 0, latest: null, runs: [] },
    memory: { total: 0, avgScore: 0, byFingerprint: {} },
    health: { patterns: 0, feedback: 0, vectors: 0, agentStats: null, memoryDir: '' },
    requests,
    serverTime: Date.now(),
});
(0, vitest_1.describe)('RequestsPanel', () => {
    (0, vitest_1.afterEach)(() => {
        (0, react_1.cleanup)();
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)('shows the empty state when the server sends no requests data (older server)', () => {
        (0, react_1.render)(<RequestsPanel_1.default data={makeData(undefined)}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/No request telemetry yet/i)).toBeTruthy();
    });
    (0, vitest_1.it)('renders stats cards and per provider × model × action rows', () => {
        (0, react_1.render)(<RequestsPanel_1.default data={makeData(makeRequests())}/>);
        // Stats: 10 + 4 + 2 = 16 requests.
        (0, vitest_1.expect)(react_1.screen.getByText('16')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('3')).toBeTruthy(); // groups
        // Rows (action chips render as "💬 chat" — match on the substring; the
        // action <select> also lists the action names, so assert multiplicity).
        (0, vitest_1.expect)(react_1.screen.getByText('groq')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('gemini')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('nim')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getAllByText((c) => c.includes('chat')).length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getAllByText((c) => c.includes('execute')).length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getAllByText((c) => c.includes('plan')).length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('shows percentile columns only when ≥3 latency samples exist, else —', () => {
        (0, react_1.render)(<RequestsPanel_1.default data={makeData(makeRequests())}/>);
        // groq row has 5 samples → p95 = 620ms shown.
        (0, vitest_1.expect)(react_1.screen.getByText('620ms')).toBeTruthy();
        // gemini row has 2 samples → its p50 is a dash.
        (0, vitest_1.expect)(react_1.screen.getAllByText('—').length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('shows a violet ⏸ partial chip on rows with mid-stream interruptions (P4 M4.4)', () => {
        (0, react_1.render)(<RequestsPanel_1.default data={makeData(makeRequests())}/>);
        // groq row has 3 partials → the ⏸ 3 chip renders with the flaky tooltip.
        (0, vitest_1.expect)(react_1.screen.getByText(/⏸ 3/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByTitle(/mid-stream interruption\(s\)/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByTitle(/deprioritizes flaky providers/)).toBeTruthy();
    });
    (0, vitest_1.it)('filters by action via the select', () => {
        (0, react_1.render)(<RequestsPanel_1.default data={makeData(makeRequests())}/>);
        react_1.fireEvent.change(react_1.screen.getByLabelText('Filter by action'), { target: { value: 'execute' } });
        (0, vitest_1.expect)(react_1.screen.queryByText('groq')).toBeNull();
        (0, vitest_1.expect)(react_1.screen.getByText('gemini')).toBeTruthy();
    });
    (0, vitest_1.it)('filters by search query across provider/model/action', () => {
        (0, react_1.render)(<RequestsPanel_1.default data={makeData(makeRequests())}/>);
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('Search provider, model or action...'), { target: { value: 'gemini' } });
        (0, vitest_1.expect)(react_1.screen.getByText('gemini')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.queryByText('groq')).toBeNull();
    });
    (0, vitest_1.it)('renders empty-state text when no rows match the filter', () => {
        (0, react_1.render)(<RequestsPanel_1.default data={makeData(makeRequests())}/>);
        react_1.fireEvent.change(react_1.screen.getByLabelText('Filter by action'), { target: { value: 'chat' } });
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('Search provider, model or action...'), { target: { value: 'nim' } });
        (0, vitest_1.expect)(react_1.screen.getByText(/No request groups match your filter/i)).toBeTruthy();
    });
});
