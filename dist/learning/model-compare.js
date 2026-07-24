/**
 * ModelCompare — A/B comparison engine that connects benchmark results
 * to model routing recommendations.
 *
 * Provides:
 * - Side-by-side benchmark comparison for two models
 * - Automatic best-model recommendation per agent type
 * - Integration with the ModelRouter and AgentStats
 * - Human-readable comparison reports
 */
import { getBenchmarkRuns } from './benchmark.js';
import { getAgentStats } from './agent-stats.js';
// ─── Comparison Engine ──────────────────────────────────────────────────────
/**
 * Compare two benchmark runs and determine the winner.
 */
export function compareModelRuns(runA, runB) {
    const a = runA.summary;
    const b = runB.summary;
    const passRateA = a.totalTasks > 0 ? a.tasksPassed / a.totalTasks : 0;
    const passRateB = b.totalTasks > 0 ? b.tasksPassed / b.totalTasks : 0;
    const winners = {
        passRate: compareMetric(passRateA, passRateB, true),
        quality: compareMetric(a.avgQualityScore, b.avgQualityScore, true),
        latency: compareMetric(a.medianLatencyMs, b.medianLatencyMs, false),
        cost: compareMetric(a.totalCostUsd, b.totalCostUsd, false),
    };
    // Overall winner: weighted scoring
    const scoreA = calcOverallScore(runA);
    const scoreB = calcOverallScore(runB);
    const overallWinner = scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : 'tie';
    const recommendation = buildRecommendation(overallWinner, runA, runB, winners);
    return {
        modelA: { provider: runA.provider, model: runA.model, summary: runA.summary },
        modelB: { provider: runB.provider, model: runB.model, summary: runB.summary },
        winners,
        overallWinner,
        recommendation,
    };
}
/**
 * Compare two benchmark runs and auto-update the ModelRouter / AgentStats
 * recommendations based on the results.
 */
export async function compareAndRecommend(runA, runB, verbose = false) {
    const comparison = compareModelRuns(runA, runB);
    const updatedRoutes = [];
    // Update AgentStats with the comparison results
    const stats = getAgentStats();
    const winnerModel = comparison.overallWinner === 'A'
        ? comparison.modelA.model
        : comparison.modelB.model;
    const winnerProvider = comparison.overallWinner === 'A'
        ? comparison.modelA.provider
        : comparison.modelB.provider;
    const loserModel = comparison.overallWinner === 'A'
        ? comparison.modelB.model
        : comparison.modelA.model;
    const loserProvider = comparison.overallWinner === 'A'
        ? comparison.modelB.provider
        : comparison.modelA.provider;
    // Record a virtual run for each agent type with the winning model
    const agentTypes = ['planner', 'writer', 'reviewer', 'tester', 'debugger', 'context-gatherer'];
    for (const agentType of agentTypes) {
        stats.recordRun(agentType, true, `${winnerProvider}/${winnerModel}`);
        stats.recordRun(agentType, false, `${loserProvider}/${loserModel}`);
    }
    if (verbose) {
        // Log updated recommendations
        for (const agentType of agentTypes) {
            const bestModel = stats.getBestModel(agentType);
            if (bestModel) {
                updatedRoutes.push(`${agentType} → ${bestModel}`);
            }
        }
    }
    return { comparison, updatedRoutes };
}
/**
 * Find the best model for a specific agent type by comparing all
 * available benchmark runs.
 */
export function findBestModelForAgent(agentType) {
    const runs = getBenchmarkRuns();
    if (runs.length < 2) {
        return {
            agentType,
            currentModel: 'default',
            betterModel: null,
            qualityImprovement: null,
            confidence: 'low',
        };
    }
    // Group runs by provider/model
    const modelGroups = new Map();
    for (const run of runs) {
        const key = `${run.provider}/${run.model}`;
        if (!modelGroups.has(key))
            modelGroups.set(key, []);
        modelGroups.get(key).push(run);
    }
    // Find the best performing model group
    let bestKey = '';
    let bestScore = -1;
    let secondBestScore = -1;
    for (const [key, groupRuns] of modelGroups) {
        const avgScore = groupRuns.reduce((sum, r) => {
            return sum + calcOverallScore(r);
        }, 0) / groupRuns.length;
        if (avgScore > bestScore) {
            secondBestScore = bestScore;
            bestScore = avgScore;
            bestKey = key;
        }
        else if (avgScore > secondBestScore) {
            secondBestScore = avgScore;
        }
    }
    const qualityImprovement = secondBestScore > 0
        ? ((bestScore - secondBestScore) / secondBestScore) * 100
        : null;
    const confidence = modelGroups.size >= 3 && runs.length >= 6
        ? 'high'
        : modelGroups.size >= 2 && runs.length >= 3
            ? 'medium'
            : 'low';
    // Get current recommendation from stats
    const stats = getAgentStats();
    const currentModel = stats.getBestModel(agentType) || 'default';
    return {
        agentType,
        currentModel,
        betterModel: bestKey !== `${currentModel}` ? bestKey : null,
        qualityImprovement: qualityImprovement ? Math.round(qualityImprovement) : null,
        confidence,
    };
}
// ─── Formatting ─────────────────────────────────────────────────────────────
/**
 * Format a model comparison as a human-readable report.
 */
export function formatComparisonResult(result) {
    const lines = [
        '═'.repeat(60),
        '  ⚔️  Model Comparison',
        '═'.repeat(60),
        '',
        `  Model A: ${result.modelA.provider}/${result.modelA.model}`,
        `  Model B: ${result.modelB.provider}/${result.modelB.model}`,
        '',
        '  ┌──────────────────┬──────────────────────┬──────────────────────┐',
        '  │ Metric           │ Model A              │ Model B              │',
        '  ├──────────────────┼──────────────────────┼──────────────────────┤',
        `  │ Pass Rate        │ ${fmtPct(result.modelA.summary.tasksPassed, result.modelA.summary.totalTasks).padEnd(20)} │ ${fmtPct(result.modelB.summary.tasksPassed, result.modelB.summary.totalTasks).padEnd(20)} │ ${winnerBadge(result.winners.passRate)}`,
        `  │ Quality          │ ${fmtScore(result.modelA.summary.avgQualityScore).padEnd(20)} │ ${fmtScore(result.modelB.summary.avgQualityScore).padEnd(20)} │ ${winnerBadge(result.winners.quality)}`,
        `  │ Latency          │ ${fmtMs(result.modelA.summary.medianLatencyMs).padEnd(20)} │ ${fmtMs(result.modelB.summary.medianLatencyMs).padEnd(20)} │ ${winnerBadge(result.winners.latency)}`,
        `  │ Cost             │ $${result.modelA.summary.totalCostUsd.toFixed(6).padEnd(17)} │ $${result.modelB.summary.totalCostUsd.toFixed(6).padEnd(17)} │ ${winnerBadge(result.winners.cost)}`,
        '  └──────────────────┴──────────────────────┴──────────────────────┘',
        '',
        `  Overall winner: ${result.overallWinner === 'A' ? 'Model A' : result.overallWinner === 'B' ? 'Model B' : 'Tie'}`,
        '',
        `  Recommendation: ${result.recommendation}`,
        '',
    ];
    return lines.join('\n');
}
/**
 * Format benchmark-driven routing recommendations.
 */
export function formatBenchmarkRecommendations(recommendations) {
    const lines = [
        '═'.repeat(60),
        '  📊  Benchmark-Driven Routing Recommendations',
        '═'.repeat(60),
        '',
        '  Based on comparing benchmark runs, here are the recommended model',
        '  updates for each agent type:',
        '',
        '  ┌─────────────────────┬──────────────────────┬──────────────────────┬──────────┐',
        '  │ Agent               │ Current              │ Recommended          │ Change   │',
        '  ├─────────────────────┼──────────────────────┼──────────────────────┼──────────┤',
    ];
    for (const rec of recommendations) {
        const agent = rec.agentType.padEnd(18).slice(0, 18);
        const current = rec.currentModel.padEnd(20).slice(0, 20);
        if (rec.betterModel) {
            const better = rec.betterModel.padEnd(20).slice(0, 20);
            const change = rec.qualityImprovement !== null
                ? `+${rec.qualityImprovement}%`.padStart(8)
                : 'update'.padStart(8);
            lines.push(`  │ ${agent} │ ${current} │ ${better} │ ${change} │`);
        }
        else {
            const noChange = '─'.padStart(8);
            lines.push(`  │ ${agent} │ ${current} │ ${'(best)'.padEnd(20)} │ ${noChange} │`);
        }
    }
    lines.push('  └─────────────────────┴──────────────────────┴──────────────────────┴──────────┘');
    lines.push('');
    return lines.join('\n');
}
// ─── Helpers ────────────────────────────────────────────────────────────────
function compareMetric(aVal, bVal, higherBetter) {
    if (aVal === bVal)
        return 'tie';
    return higherBetter ? (aVal > bVal ? 'A' : 'B') : (aVal < bVal ? 'A' : 'B');
}
function calcOverallScore(run) {
    const s = run.summary;
    const passRate = s.totalTasks > 0 ? s.tasksPassed / s.totalTasks : 0;
    const quality = s.avgQualityScore;
    const latencyScore = Math.max(0, 1 - s.medianLatencyMs / 30000);
    const costScore = Math.max(0, 1 - s.totalCostUsd / 1);
    // Weighted score
    return passRate * 0.4 + quality * 0.3 + latencyScore * 0.2 + costScore * 0.1;
}
function buildRecommendation(winner, runA, runB, winners) {
    if (winner === 'tie') {
        return 'Both models perform similarly. Consider cost or latency preferences.';
    }
    const winningModel = winner === 'A' ? runA.model : runB.model;
    const losingModel = winner === 'A' ? runB.model : runA.model;
    const advantages = [];
    if ((winner === 'A' && winners.passRate === 'A') || (winner === 'B' && winners.passRate === 'B'))
        advantages.push('higher pass rate');
    if ((winner === 'A' && winners.quality === 'A') || (winner === 'B' && winners.quality === 'B'))
        advantages.push('better quality');
    if ((winner === 'A' && winners.latency === 'A') || (winner === 'B' && winners.latency === 'B'))
        advantages.push('lower latency');
    if ((winner === 'A' && winners.cost === 'A') || (winner === 'B' && winners.cost === 'B'))
        advantages.push('lower cost');
    return `${winningModel} is recommended over ${losingModel} due to ${advantages.join(', ')}.`;
}
function fmtPct(passed, total) {
    if (total === 0)
        return 'N/A';
    return `${((passed / total) * 100).toFixed(0)}%`;
}
function fmtScore(score) {
    return `${(score * 100).toFixed(1)}%`;
}
function fmtMs(ms) {
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
function winnerBadge(winner) {
    if (winner === 'tie')
        return '  ➖';
    return winner === 'A' ? '  🔵' : '  🟠';
}
//# sourceMappingURL=model-compare.js.map