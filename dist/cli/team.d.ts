/**
 * Team command — Team collaboration with shared memory, config, and review workflow.
 *
 * Usage:
 *   buff team init [name]                       — Initialize team config in working directory
 *   buff team init --repo <url>                 — Init with remote team repository
 *   buff team join <repo-url>                   — Clone and join an existing team repo
 *   buff team sync                              — Sync team memory with remote (pull + push)
 *   buff team status                            — Show team configuration and memory status
 *   buff team share                             — Share local trajectories with team
 *   buff team review list                       — List all review bundles
 *   buff team review show <id>                  — Show a specific review bundle
 *   buff team review approve <id>               — Approve a review
 *   buff team review reject <id> [reason]       — Reject a review
 *   buff team review merge <id>                 — Merge an approved review into working dir
 *   buff team review create <title> <goal>      — Create a review bundle from files
 *
 * The team system enables multiple developers to:
 *   - Share agent execution trajectories via git
 *   - Use project-level .buffconfig.json for shared provider defaults
 *   - Review agent-generated changes before applying them
 *   - Collaborate on workflow templates and coding patterns
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class TeamCommand extends BaseCommand {
    create(): Command;
    private handleInit;
    private handleJoin;
    private handleSync;
    private handleStatus;
    private handleShare;
    private handleReviewList;
    private handleReviewShow;
    private handleReviewApprove;
    private handleReviewRequestChanges;
    private handleReviewReject;
    private handleReviewMerge;
    private handleReviewCreate;
    private reviewStatusIcon;
}
//# sourceMappingURL=team.d.ts.map