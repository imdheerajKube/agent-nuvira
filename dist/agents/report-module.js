/**
 * ReportModule — Produces structured summaries of what happened, what changed,
 * and what's next. Phase 4 of the architecture migration: extract from
 * Orchestrator's buildResult() into a pluggable module with multiple output formats.
 *
 * @see ARCHITECTURE.md §3.7 — Report Module specification
 */
import { getEventBus, EventNames } from '../observability/event-bus.js';
/**
 * TextFormatter — Produces a compact, human-readable text report.
 * Used as the default output format for CLI display.
 */
class TextFormatter {
    format(report) {
        const { details, meta } = report;
        const lines = [];
        // Title line
        const statusIcon = report.success ? '✅' : '❌';
        lines.push(`${statusIcon} ${report.summary}`);
        lines.push('');
        // Goal
        if (details.goal) {
            lines.push(`Goal: ${details.goal.slice(0, 120)}`);
            if (details.goal.length > 120)
                lines.push('   ... (truncated)');
        }
        // Duration
        lines.push(`Duration: ${details.duration}`);
        lines.push(`Tasks: ${details.tasksCompleted}/${details.tasksTotal} completed`);
        // Error
        if (details.error) {
            lines.push('');
            lines.push(`Error: ${details.error.slice(0, 300)}`);
        }
        // Agent breakdown
        if (details.agentBreakdown.length > 0) {
            lines.push('');
            lines.push('Agent Results:');
            for (const agent of details.agentBreakdown) {
                const icon = agent.status === 'passed' ? '✅' : agent.status === 'failed' ? '❌' : '⏭️';
                lines.push(`  ${icon} ${agent.agent}: ${agent.summary.slice(0, 120)}`);
            }
        }
        // File changes
        if (details.fileChanges.length > 0) {
            lines.push('');
            lines.push('File Changes:');
            for (const fc of details.fileChanges) {
                const icon = fc.status === 'created' ? '🆕' : fc.status === 'modified' ? '✏️' : fc.status === 'deleted' ? '🗑️' : '➖';
                lines.push(`  ${icon} ${fc.path}`);
            }
        }
        // Test summary
        if (details.testSummary) {
            lines.push('');
            lines.push(`Tests: ${details.testSummary}`);
        }
        // Verification score
        if (details.verificationScore !== undefined) {
            const scoreBar = generateScoreBar(details.verificationScore);
            lines.push('');
            lines.push(`Verification: ${scoreBar} ${(details.verificationScore * 100).toFixed(0)}%`);
        }
        // Meta
        if (meta) {
            if (meta.trajectoryId) {
                lines.push('');
                lines.push(`Trajectory: ${meta.trajectoryId}`);
            }
            if (meta.reviewId) {
                lines.push(`Review: ${meta.reviewId}`);
            }
        }
        return lines.join('\n');
    }
}
/**
 * MarkdownFormatter — Produces a Markdown-formatted report.
 * Suitable for writing to files, GitHub comments, or PR descriptions.
 */
class MarkdownFormatter {
    format(report) {
        const { details, meta } = report;
        const lines = [];
        // Title
        const statusIcon = report.success ? '✅' : '❌';
        lines.push(`# ${statusIcon} Execution Report`);
        lines.push('');
        lines.push(`**${report.summary}**`);
        lines.push('');
        // Summary table
        lines.push('## Summary');
        lines.push('');
        lines.push('| Metric | Value |');
        lines.push('|---|---|');
        lines.push(`| **Goal** | ${details.goal.slice(0, 100)} |`);
        lines.push(`| **Status** | ${report.success ? '✅ Passed' : '❌ Failed'} |`);
        lines.push(`| **Duration** | ${details.duration} |`);
        lines.push(`| **Tasks** | ${details.tasksCompleted}/${details.tasksTotal} |`);
        if (details.verificationScore !== undefined) {
            lines.push(`| **Verification** | ${(details.verificationScore * 100).toFixed(0)}% |`);
        }
        if (details.error) {
            lines.push(`| **Error** | ${details.error.slice(0, 200)} |`);
        }
        lines.push('');
        // Agent breakdown
        if (details.agentBreakdown.length > 0) {
            lines.push('## Agent Results');
            lines.push('');
            lines.push('| Agent | Status | Summary |');
            lines.push('|---|---|---|');
            for (const agent of details.agentBreakdown) {
                const statusIcon = agent.status === 'passed' ? '✅' : agent.status === 'failed' ? '❌' : '⏭️';
                lines.push(`| **${agent.agent}** | ${statusIcon} | ${agent.summary.slice(0, 100)} |`);
            }
            lines.push('');
        }
        // File changes
        if (details.fileChanges.length > 0) {
            lines.push('## File Changes');
            lines.push('');
            lines.push('| File | Status |');
            lines.push('|---|---|');
            for (const fc of details.fileChanges) {
                const icon = fc.status === 'created' ? '🆕' : fc.status === 'modified' ? '✏️' : fc.status === 'deleted' ? '🗑️' : '➖';
                lines.push(`| \`${fc.path}\` | ${icon} ${fc.status} |`);
            }
            lines.push('');
        }
        // Test summary
        if (details.testSummary) {
            lines.push('## Test Results');
            lines.push('');
            lines.push(details.testSummary);
            lines.push('');
        }
        // Follow-up
        if (report.followUp && report.followUp.suggestedActions.length > 0) {
            lines.push('## Suggested Next Steps');
            lines.push('');
            for (let i = 0; i < report.followUp.suggestedActions.length; i++) {
                lines.push(`${i + 1}. ${report.followUp.suggestedActions[i]}`);
            }
            lines.push('');
        }
        // Metadata
        if (meta) {
            lines.push('---');
            lines.push('');
            if (meta.trajectoryId) {
                lines.push(`**Trajectory ID:** \`${meta.trajectoryId}\``);
            }
            if (meta.reviewId) {
                lines.push(`**Review ID:** \`${meta.reviewId}\``);
            }
            if (meta.durationMs) {
                lines.push(`**Duration:** ${meta.durationMs}ms`);
            }
        }
        return lines.join('\n');
    }
}
/**
 * JsonFormatter — Produces a structured JSON report.
 * Useful for programmatic consumption (CI pipelines, web dashboard, API responses).
 */
class JsonFormatter {
    format(report) {
        return JSON.stringify(report, null, 2);
    }
}
/**
 * GitHubActionsFormatter — Produces GitHub Actions workflow command annotations.
 * https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
 */
class GitHubActionsFormatter {
    format(report) {
        const lines = [];
        // Summary annotation
        const summary = report.summary.replace(/"/g, '\\"');
        const status = report.success ? 'notice' : 'error';
        lines.push(`::${status} title=Agent-Nuvira Execution::${summary}`);
        // Per-agent annotations
        for (const agent of report.details.agentBreakdown) {
            if (agent.status === 'failed') {
                const msg = agent.summary.replace(/"/g, '\\"').replace(/\n/g, '%0A');
                lines.push(`::error file=agent-${agent.agent}.log,title=${agent.agent} failed::${msg}`);
            }
        }
        // File change annotations
        for (const fc of report.details.fileChanges) {
            const file = fc.path.replace(/"/g, '\\"');
            if (fc.status === 'modified' || fc.status === 'created') {
                lines.push(`::notice file=${file},title=${fc.status}::File was ${fc.status}`);
            }
        }
        // Output summary as a step summary
        const summaryText = report.details.agentBreakdown.map((a) => `${a.status === 'passed' ? '✅' : a.status === 'failed' ? '❌' : '⏭️'} ${a.agent}: ${a.summary.slice(0, 80)}`).join('\n');
        // Write summary to GITHUB_STEP_SUMMARY if available
        lines.push('');
        lines.push(`## Agent-Nuvira Execution ${report.success ? '✅' : '❌'}`);
        lines.push('');
        lines.push(`**Goal:** ${report.details.goal.slice(0, 80)}`);
        lines.push(`**Duration:** ${report.details.duration}`);
        lines.push(`**Tasks:** ${report.details.tasksCompleted}/${report.details.tasksTotal}`);
        lines.push('');
        lines.push('### Agent Results');
        lines.push('');
        lines.push(summaryText);
        lines.push('');
        lines.push(`::set-output name=execution_status::${report.success ? 'success' : 'failure'}`);
        lines.push(`::set-output name=tasks_completed::${report.details.tasksCompleted}`);
        lines.push(`::set-output name=tasks_total::${report.details.tasksTotal}`);
        return lines.join('\n');
    }
}
// ─── Formatter Registry ─────────────────────────────────────────────────────
/** Map of format name to formatter instance */
const FORMATTERS = {
    text: new TextFormatter(),
    json: new JsonFormatter(),
    markdown: new MarkdownFormatter(),
    'github-annotation': new GitHubActionsFormatter(),
};
// ─── Default ReportModule ───────────────────────────────────────────────────
/**
 * DefaultReportModule — Built-in report module implementation.
 *
 * Transforms pipeline execution data into structured ExecutionReport and
 * supports multiple output formats (text, json, markdown, github-annotation).
 */
export class DefaultReportModule {
    /** The event bus for emitting observability events */
    eventBus;
    constructor(eventBus) {
        this.eventBus = eventBus ?? getEventBus();
    }
    /**
     * Generate an ExecutionReport from pipeline execution data.
     */
    async generate(params) {
        const { goal, agentResults, fileChanges, hasFailures, durationMs, testSummary, runOutput, error, trajectoryId, reviewId, verificationScore, } = params;
        // Build agent breakdown with status mapping
        const agentBreakdown = agentResults.map((r) => ({
            agent: r.agent,
            status: r.success ? 'passed' : 'failed',
            summary: r.summary,
        }));
        // Build file changes summary
        const reportFileChanges = fileChanges.map((fc) => ({
            path: fc.path,
            status: fc.status,
        }));
        const tasksCompleted = agentResults.filter((r) => r.success).length;
        const tasksTotal = agentResults.length;
        // Build summary
        const elapsedSec = (durationMs / 1000).toFixed(1);
        const summaryLine = hasFailures
            ? `Completed ${tasksCompleted}/${tasksTotal} tasks with some failures in ${elapsedSec}s`
            : `Completed all ${tasksCompleted} tasks successfully in ${elapsedSec}s`;
        // Format duration
        const duration = formatDuration(durationMs);
        // Build the report (without followUp yet — depends on the assembled data)
        const report = {
            success: !hasFailures,
            summary: summaryLine,
            details: {
                goal,
                tasksCompleted,
                tasksTotal,
                duration,
                agentBreakdown,
                fileChanges: reportFileChanges,
                testSummary,
                verificationScore,
                error,
            },
            meta: {
                durationMs,
                trajectoryId,
                reviewId,
                runOutput,
            },
        };
        // Generate follow-up suggestions from the assembled report
        report.followUp = this.generateFollowUp(report);
        // Emit report:generated event
        this.eventBus.emit(EventNames.REPORT_GENERATED, {
            success: !hasFailures,
            tasksCompleted,
            tasksTotal,
            duration,
        }, 'report-module');
        return report;
    }
    /**
     * Format an ExecutionReport into the requested output format.
     */
    format(report, format) {
        const formatter = FORMATTERS[format];
        if (!formatter) {
            // Fallback to JSON for unknown formats
            return FORMATTERS.json.format(report);
        }
        return formatter.format(report);
    }
    /**
     * Generate follow-up suggestions based on the report content.
     */
    generateFollowUp(report) {
        const actions = [];
        const { details, meta } = report;
        if (!report.success) {
            if (details.error) {
                actions.push(`Review the error: ${details.error.slice(0, 100)}`);
            }
            actions.push('Re-run with --verbose for detailed logs');
            if (meta?.trajectoryId) {
                actions.push(`Review memory trajectory: buff memory show ${meta.trajectoryId}`);
            }
        }
        if (details.fileChanges.length > 0) {
            actions.push('Review the file changes listed above');
        }
        if (details.verificationScore !== undefined && details.verificationScore < 0.7) {
            actions.push('Manual review recommended — verification score is below threshold');
        }
        if (meta?.reviewId) {
            actions.push(`Approve and merge review bundle: buff team review approve ${meta.reviewId}`);
        }
        return actions.length > 0
            ? { suggestedActions: actions, confidence: actions.length <= 3 ? 'high' : 'medium' }
            : undefined;
    }
}
// ─── Helpers ────────────────────────────────────────────────────────────────
/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m ${seconds % 60}s`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    if (seconds > 0) {
        return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
    }
    return `${ms}ms`;
}
/**
 * Generate a visual score bar (e.g. [█████░░░░░] 50%).
 */
function generateScoreBar(score, width = 10) {
    const filled = Math.round(score * width);
    const empty = width - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}
//# sourceMappingURL=report-module.js.map