/**
 * Session command — Debug surface for project-scoped session continuity (G1).
 *
 * The PRIMARY path is D1 auto-recall (a bare `continue` resumes everything);
 * this command is the explicit/scriptable surface for the same machinery:
 *
 *   nuvira session list [--project <id>] [--since "last week"] [--limit N]
 *       — Recent sessions, optionally filtered by project + temporal phrase
 *   nuvira session summarize <id>
 *       — Metadata + summary for one session (not raw messages — use
 *         `nuvira history show` for the transcript)
 *   nuvira session resume [--project <id>]
 *       — Run D1 autoRecall and print the recall card (facts + checkpoint +
 *         last goal) for the project
 *
 * Everything reuses the D1 modules (searchSessions, autoRecall, recallCard,
 * textRangeToEpoch) — this is a debug/scripting surface, never a second
 * implementation of recall.
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class SessionCommand extends BaseCommand {
    create(): Command;
    private listSessions;
    private summarizeSession;
    private resumeProject;
    private resolveProjectId;
}
//# sourceMappingURL=session.d.ts.map