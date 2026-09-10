"use strict";
/**
 * Unit tests for the PromotionGateSection rendered by RoutingInsightsPanel.
 *
 * Covers the three verdict states (promoted / not-promoted / collecting data),
 * the honest neutral latency chip when latency is unmeasured, and the
 * hidden-when-empty behavior. Rendered through the default RoutingInsightsPanel
 * export so the `hasPromotion` wiring and empty-state gating are exercised too.
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
const RoutingInsightsPanel_1 = __importStar(require("./RoutingInsightsPanel"));
// ─── Helpers ────────────────────────────────────────────────────────────────
function makeData(promotion) {
    return {
        routing: {
            providers: [],
            bestModels: [],
            preference: [],
            promotion,
            updatedAt: Date.now(),
        },
    };
}
// ─── Governance card helpers (P6 M6.5) ─────────────────────────────────────
function makeGovernanceData(governance) {
    return {
        routing: {
            providers: [],
            bestModels: [],
            preference: [],
            governance,
            updatedAt: Date.now(),
        },
    };
}
const basePromotion = {
    decisionCount: 30,
    divergedCount: 22,
    minDecisions: 20,
    qualityDelta: 0.05,
    costDelta: 0.005,
    latencyDelta: 0.02,
    latencyMeasured: true,
    criteria: { quality: true, cost: true, latency: true },
    sufficient: true,
    promoted: true,
};
// ─── Tests ──────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('PromotionGateSection (via RoutingInsightsPanel)', () => {
    (0, vitest_1.it)('renders the promoted verdict when all criteria pass with sufficient data', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData(basePromotion)}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('Promoted — the bandit beats the heuristic')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('Quality ↑')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('Cost ↓')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('Latency ↓')).toBeTruthy();
        // All three criteria pass
        (0, vitest_1.expect)(react_1.screen.getAllByText('✓ pass')).toHaveLength(3);
        (0, vitest_1.expect)(react_1.screen.queryByText('✗ fail')).toBeNull();
    });
    (0, vitest_1.it)('shows the collecting-data state when there are not enough diverged decisions', () => {
        const promo = {
            ...basePromotion,
            divergedCount: 5,
            sufficient: false,
            promoted: false,
        };
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData(promo)}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('Collecting data — need more diverged decisions')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('5 diverged decisions')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('need 20 for a verdict')).toBeTruthy();
        // Not enough data → no promotion claim
        (0, vitest_1.expect)(react_1.screen.queryByText('Promoted — the bandit beats the heuristic')).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText('Not promoted — the bandit is not (yet) better')).toBeNull();
    });
    (0, vitest_1.it)('shows the not-promoted verdict when sufficient but a criterion fails', () => {
        const promo = {
            ...basePromotion,
            criteria: { quality: false, cost: true, latency: true },
            promoted: false,
        };
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData(promo)}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('Not promoted — the bandit is not (yet) better')).toBeTruthy();
        // Quality fails, cost + latency pass
        (0, vitest_1.expect)(react_1.screen.getByText('✗ fail')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getAllByText('✓ pass')).toHaveLength(2);
    });
    (0, vitest_1.it)('renders a neutral latency chip when latency is unmeasured — never a green pass', () => {
        const promo = {
            ...basePromotion,
            latencyMeasured: false,
        };
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData(promo)}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('○ neutral')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('no latency measurements yet')).toBeTruthy();
        // Measured criteria (quality + cost) still show green — only latency is neutral
        (0, vitest_1.expect)(react_1.screen.getAllByText('✓ pass')).toHaveLength(2);
        (0, vitest_1.expect)(react_1.screen.getAllByText('○ neutral')).toHaveLength(1);
        (0, vitest_1.expect)(react_1.screen.queryByText('✗ fail')).toBeNull();
    });
    (0, vitest_1.it)('hides the promotion card entirely when there are no decisions yet', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData({ ...basePromotion, decisionCount: 0 })}/>);
        (0, vitest_1.expect)(react_1.screen.queryByText('Promotion Gate — is the bandit better than the heuristic?')).toBeNull();
    });
    (0, vitest_1.it)('renders nothing promotion-related when routing data is absent', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={null}/>);
        (0, vitest_1.expect)(react_1.screen.queryByText('Promotion Gate — is the bandit better than the heuristic?')).toBeNull();
    });
});
// ─── v1.58.0 M2.x chips on the preference table ─────────────────────────────
(0, vitest_1.describe)('PreferenceSection M2.x chips (v1.58.0)', () => {
    (0, vitest_1.it)('renders 🎯 fit / 📏 measured / ⏳ ctx chips on provider rows when data is present', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makePreferenceData({
                provider: 'gemini',
                score: 0.87,
                reason: 'strong reasoning',
                capabilityFit: 85,
                costSource: 'measured',
                costBasis: { inputTokens: 12480, outputTokens: 3110 },
                contextUtilization: 3,
                contextWindowTokens: 1048576,
            })}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('Auto Router — What the agent would pick')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('🎯 fit 85%')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('📏 measured 12,480→3,110 tok')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('⏳ ctx 3% (1,048,576 tok)')).toBeTruthy();
    });
    (0, vitest_1.it)('shows 📐 estimated when no measured wire usage exists and omits 🎯/⏳ chips when their fields are absent (gates OFF)', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makePreferenceData({
                provider: 'groq',
                score: 0.7,
                reason: 'fast + free',
                // costSource present (always sent by the server); capabilityFit / context
                // fields intentionally absent → gates OFF leaves only the cost chip.
                costSource: 'estimated',
            })}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('📐 estimated')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.queryByText(/🎯 fit/)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText(/⏳ ctx/)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText(/📏 measured/)).toBeNull();
    });
    (0, vitest_1.it)('renders no chip row at all when every chip field is absent (hand-built data)', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makePreferenceData({
                provider: 'groq',
                score: 0.7,
                reason: 'fast + free',
            })}/>);
        (0, vitest_1.expect)(react_1.screen.queryByText(/📐 estimated/)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText(/📏 measured/)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText(/🎯 fit/)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText(/⏳ ctx/)).toBeNull();
    });
});
// Build routing data with a single preference entry whose providers carry the
// given (partial) chip fields.
function makePreferenceData(prov) {
    return {
        routing: {
            providers: [],
            bestModels: [],
            preference: [{
                    complexity: 'moderate',
                    winner: `${prov.provider || 'gemini'}/${prov.provider || 'gemini'}-model`,
                    score: prov.score ?? 0.87,
                    providers: [{
                            provider: prov.provider || 'gemini',
                            score: prov.score ?? 0.87,
                            reason: prov.reason || 'reason',
                            ...(prov.capabilityFit !== undefined ? { capabilityFit: prov.capabilityFit } : {}),
                            ...(prov.costSource ? { costSource: prov.costSource } : {}),
                            ...(prov.costBasis ? { costBasis: prov.costBasis } : {}),
                            ...(prov.contextUtilization !== undefined ? { contextUtilization: prov.contextUtilization } : {}),
                            ...(prov.contextWindowTokens !== undefined ? { contextWindowTokens: prov.contextWindowTokens } : {}),
                        }],
                }],
            updatedAt: Date.now(),
        },
    };
}
// ─── Governance card (P6 M6.5) ─────────────────────────────────────────────
// The policy card mirrors `buff admin policy`: permissive empty state, rule
// chips for allow/deny lists + caps, and the hard-constraint enforcement note.
(0, vitest_1.describe)('GovernanceSection (via RoutingInsightsPanel)', () => {
    (0, vitest_1.it)('shows the fully-permissive state when no policy is configured', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeGovernanceData({ enabled: false, updatedAt: Date.now() })}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/Fully permissive/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/buff admin allow/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/Admin Governance Policy/)).toBeTruthy();
    });
    (0, vitest_1.it)('renders allow/deny rule chips and cap extras when a policy is active', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeGovernanceData({
                enabled: true,
                allowProviders: ['groq', 'local'],
                denyProviders: ['gemini'],
                denyModels: ['gemini-2.5-pro'],
                maxCostUsd: 0.01,
                piiPatterns: ['api[_-]?key'],
                allowUnblock: false,
                updatedAt: Date.now(),
            })}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/allow providers: groq, local/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/deny providers: gemini/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/deny models: gemini-2.5-pro/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/max cost \$0.01/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/PII guard/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/unblock admin-hard/)).toBeTruthy();
        // Hard-constraint enforcement note.
        (0, vitest_1.expect)(react_1.screen.getByText(/violating providers are eliminated/)).toBeTruthy();
    });
});
// ─── RBAC identity card (P6 M6.1) ──────────────────────────────────────────
function makeRbacData(rbac) {
    return {
        routing: {
            providers: [],
            bestModels: [],
            preference: [],
            rbac,
            updatedAt: Date.now(),
        },
    };
}
(0, vitest_1.describe)('RbacSection (P6 M6.1)', () => {
    (0, vitest_1.it)('renders the acting identity, role, and user→role map', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.RbacSection rbac={{
                legacy: false,
                identity: 'alice',
                role: 'admin',
                users: [
                    { user: 'alice', role: 'admin' },
                    { user: 'bob', role: 'viewer' },
                ],
                updatedAt: Date.now(),
            }}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/You are/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('alice')).toBeTruthy();
        // 'admin' appears in the role badge AND the "writes require admin" hint.
        (0, vitest_1.expect)(react_1.screen.getAllByText('admin').length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getByText(/bob · viewer/)).toBeTruthy();
        // The em/code tags split the hint text into separate nodes — match on textContent.
        (0, vitest_1.expect)(react_1.screen.getAllByText((_, el) => !!el?.textContent?.includes('Policy writes require admin')).length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('renders the legacy permissive notice when no roles are assigned', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.RbacSection rbac={{ legacy: true, identity: 'dheeraj', role: null, users: [], updatedAt: Date.now() }}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/Legacy single-user mode/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/policy writes are/)).toBeTruthy();
    });
    (0, vitest_1.it)('renders an unassigned role honestly (null role)', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.RbacSection rbac={{ legacy: false, identity: 'mallory', role: null, users: [{ user: 'alice', role: 'admin' }], updatedAt: Date.now() }}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/unassigned/)).toBeTruthy();
    });
    (0, vitest_1.it)('renders through the panel when routing.rbac is present', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeRbacData({
                legacy: false,
                identity: 'alice',
                role: 'admin',
                users: [{ user: 'alice', role: 'admin' }],
                updatedAt: Date.now(),
            })}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/RBAC Identity/)).toBeTruthy();
    });
});
// ─── v1.71.0 ML task-similarity router card ─────────────────────────────────
(0, vitest_1.describe)('MlSection (via RoutingInsightsPanel)', () => {
    function makeMlData(ml) {
        return {
            routing: {
                providers: [],
                bestModels: [],
                preference: [],
                ml,
                updatedAt: Date.now(),
            },
        };
    }
    (0, vitest_1.it)('renders learned state — record count, trusted vs learning providers, win rates', () => {
        const ml = {
            enabled: true,
            recordCount: 42,
            providers: [
                { provider: 'groq', samples: 18, winRate: 0.85, factor: 1.175, trusted: true, model: 'llama-3.3-70b' },
                { provider: 'gemini', samples: 3, winRate: 0.4, factor: 0.95, trusted: false, model: 'gemini-2.0-flash' },
            ],
            updatedAt: Date.now(),
        };
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeMlData(ml)}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('ML Router — learned from similar tasks')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('42')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('learned tasks')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('trusted providers')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('still learning')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/trusted · 18 samples/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/3\/5 samples/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/85%/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/1\.1\d×/)).toBeTruthy(); // 0.85 winRate → factor 1.175 → "1.18×"
    });
    (0, vitest_1.it)('hides the ML card entirely when there are no learned records', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeMlData({ enabled: false, recordCount: 0, providers: [], updatedAt: Date.now() })}/>);
        (0, vitest_1.expect)(react_1.screen.queryByText('ML Router — learned from similar tasks')).toBeNull();
    });
    (0, vitest_1.it)('hides the ML card when the server predates the feature (no ml field)', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData(undefined)}/>);
        (0, vitest_1.expect)(react_1.screen.queryByText('ML Router — learned from similar tasks')).toBeNull();
    });
});
