/**
 * MigrationGuardAgent — a complex example of a custom agent.
 *
 * WHAT IT MODELS. A schema change is where an agent can do irreversible damage,
 * so the interesting agent is not the one that writes SQL — it is the one that
 * REFUSES to let a dangerous migration through quietly. This agent:
 *
 *   1. `validate()` refuses to run with no migration artifacts (a real
 *      precondition, so the plan reports "cannot run" instead of inventing work);
 *   2. classifies each artifact in CODE first (regex, deterministic and free),
 *      then asks the model only about the files that actually look risky — the
 *      LLM is for judgement, not for parsing;
 *   3. writes to THREE parts of the context bus: an agent-to-agent message
 *      (`conversations`), a proposed review file (`fileChanges`) and a machine
 *      -readable finding list (`metadata`) that a later step can act on;
 *   4. honours the rate-limit CONTRACT instead of silently retrying: on a 429 it
 *      asks `context.onRateLimit` what to do and obeys retry / switch-model /
 *      skip / abort;
 *   5. implements `cleanup()` so nothing it buffered outlives the step.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never writes to disk and never runs a
 * command. A custom agent has the context bus and the model — the harness owns
 * the filesystem. `fileChanges` is a PROPOSAL that the writer/apply stage
 * performs, which is exactly why an agent can be aggressive about what it
 * recommends and still be safe.
 */

import {
  Agent,
  defineAgent,
  type AgentContext,
  type AgentResult,
  type FileChange,
  type LLMCallFn,
  type RateLimitAction,
} from '@agent-nuvira/sdk';

/** One classified statement in a migration file. */
export interface MigrationFinding {
  /** The artifact the statement came from. */
  path: string;
  /** Which pattern matched, e.g. 'DROP TABLE'. */
  kind: string;
  /** The statement (trimmed, single line). */
  statement: string;
  /** `destructive` cannot be undone; `review` depends on the deployment. */
  verdict: 'destructive' | 'review';
  /** Filled in by the model for `destructive`/`review` findings. */
  rationale?: string;
}

/**
 * Patterns that warrant attention, worst first. Deliberately conservative: a
 * false positive costs one line in a review note, a false negative costs a
 * production table.
 */
const RISKY_PATTERNS: Array<{ kind: string; re: RegExp; verdict: MigrationFinding['verdict'] }> = [
  { kind: 'DROP TABLE', re: /\bdrop\s+table\b/i, verdict: 'destructive' },
  { kind: 'DROP COLUMN', re: /\bdrop\s+column\b/i, verdict: 'destructive' },
  { kind: 'TRUNCATE', re: /\btruncate\b/i, verdict: 'destructive' },
  { kind: 'DELETE without WHERE', re: /\bdelete\s+from\b(?![^;]*\bwhere\b)/i, verdict: 'destructive' },
  { kind: 'ALTER COLUMN TYPE', re: /\balter\s+column\b[^;]*\btype\b/i, verdict: 'review' },
  { kind: 'RENAME', re: /\brename\s+(table|column)\b/i, verdict: 'review' },
  { kind: 'NOT NULL without DEFAULT', re: /\bnot\s+null\b(?![^;]*\bdefault\b)/i, verdict: 'review' },
];

/** Files worth reviewing: migrations by path, or anything with SQL in it. */
function looksLikeMigration(path: string, content: string): boolean {
  if (/\.(sql)$/i.test(path)) return true;
  if (/migrat/i.test(path)) return true;
  return /\b(alter|create|drop)\s+table\b/i.test(content);
}

/** Pull the model's rationale lines out of whatever prose it returned. */
export function parseRationale(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    // Tolerates the several shapes models actually produce:
    //   "0001.sql: DROP TABLE users — removes the table"
    //   "- 0001.sql | DROP TABLE users | removes the table"
    // The leading strip is list markers only. A class that also ate digits and
    // dots swallowed the `0007.` of the filename itself, leaving no second `.sql`
    // in the rest of the line, so nothing ever matched.
    const match = line.match(/^[\s\-*]*(?:\d+[.)]\s*)?(.+?\.sql)\s*[:|]\s*(.+?)\s*[:|\u2014-]\s*(.+)$/);
    if (match) out.set(`${match[1]!.trim()}|${match[2]!.trim()}`, match[3]!.trim());
  }
  return out;
}

/** A rate limit we decided to give up on, so `execute` can report it as failure. */
class RateLimitAbort extends Error {}

export class MigrationGuardAgent extends Agent {
  readonly name = 'MigrationGuard';
  readonly description = 'Classifies SQL migrations for destructive or review-worthy statements before they run';

  /** Buffered across the step, released in `cleanup()`. */
  private findings: MigrationFinding[] = [];

  validate(context: AgentContext): true | string {
    const candidates = context.artifacts.filter((a) => a.content?.trim());
    if (candidates.length === 0) {
      return 'MigrationGuard needs at least one non-empty artifact (a migration file or diff).';
    }
    if (!candidates.some((a) => looksLikeMigration(a.path, a.content))) {
      return 'None of the artifacts look like SQL migrations — point this step at a migration directory.';
    }
    return true;
  }

  /**
   * Call the model, obeying the rate-limit contract.
   *
   * Returns `null` when the caller told us to SKIP this step — a soft success,
   * which is what a user asking to skip actually wants. Throws
   * {@link RateLimitAbort} for `abort`.
   */
  private async callWithRateLimitPolicy(
    context: AgentContext,
    callLLM: LLMCallFn,
    prompt: string,
  ): Promise<string | null> {
    try {
      return await callLLM(prompt, { temperature: 0.1, maxTokens: 700 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = /\b429\b|rate.?limit|too many requests|quota exceeded/i.test(message);
      if (!isRateLimit || !context.onRateLimit) throw err;

      const action: RateLimitAction = await context.onRateLimit({
        retryAfterMs: 2000,
        agentName: this.name,
        errorMessage: message,
      });

      switch (action.action) {
        case 'skip':
          return null;
        case 'abort':
          throw new RateLimitAbort(message);
        case 'switch-model':
          // The orchestrator hands back a callLLM already bound to the new model.
          return action.callLLM(prompt, { temperature: 0.1, maxTokens: 700 });
        case 'retry':
        default:
          return callLLM(prompt, { temperature: 0.1, maxTokens: 700 });
      }
    }
  }

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    this.findings = [];

    // ── 1. Deterministic classification (no model, no cost) ────────────────
    for (const artifact of context.artifacts) {
      if (!artifact.content?.trim() || !looksLikeMigration(artifact.path, artifact.content)) continue;
      for (const statement of artifact.content.split(';')) {
        const line = statement.replace(/\s+/g, ' ').trim();
        if (!line) continue;
        for (const pattern of RISKY_PATTERNS) {
          if (pattern.re.test(line)) {
            this.findings.push({
              path: artifact.path,
              kind: pattern.kind,
              statement: line.slice(0, 160),
              verdict: pattern.verdict,
            });
            break; // worst match per statement is enough
          }
        }
      }
    }

    if (this.findings.length === 0) {
      return { success: true, summary: 'No destructive statements found in the migrations' };
    }

    // ── 2. Ask the model only about what is actually risky ────────────────
    const prompt = [
      'You review database migrations for irreversible risk.',
      'For EACH line below, answer on one line as:',
      '  <file>.sql: <STATEMENT KIND> — <one-sentence consequence if this runs>',
      'Do not add other commentary.',
      '',
      ...this.findings.map((f) => `${f.path}: ${f.kind} — ${f.statement}`),
    ].join('\n');

    let rationale: string | null;
    try {
      rationale = await this.callWithRateLimitPolicy(context, callLLM, prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: 'Migration review could not reach a model',
        error: message,
      };
    }

    if (rationale === null) {
      return {
        success: true,
        summary: `Skipped at the rate-limit prompt — ${this.findings.length} risky statement(s) were NOT reviewed`,
        details: this.renderReport(context.goal),
      };
    }

    const parsed = parseRationale(rationale);
    for (const finding of this.findings) {
      finding.rationale = parsed.get(`${finding.path}|${finding.kind}`);
    }

    const destructive = this.findings.filter((f) => f.verdict === 'destructive');

    // ── 3. Write to the context bus ───────────────────────────────────────
    const report = this.renderReport(context.goal);

    // (a) machine-readable, for a later plan step to gate on
    context.metadata = {
      ...context.metadata,
      migrationFindings: this.findings,
      migrationDestructiveCount: destructive.length,
    };

    // (b) agent-to-agent: the writer will see this before applying anything
    context.conversations.push({
      from: this.name,
      to: 'writer',
      content:
        `Do not apply ${destructive.length} destructive statement(s) without an explicit approval. ` +
        `Review note: ${this.reportPath()}`,
      timestamp: Date.now(),
    });

    // (c) a PROPOSED file — the harness applies it, this agent never touches disk
    const change: FileChange = {
      path: this.reportPath(),
      newContent: report,
      status: 'created',
    };
    context.fileChanges.push(change);

    return {
      success: true,
      summary:
        destructive.length > 0
          ? `${destructive.length} destructive statement(s) need approval before this migration runs`
          : `${this.findings.length} statement(s) to review, none destructive`,
      details: report,
    };
  }

  /** Where the review note should live. Kept in one place for the message + the change. */
  private reportPath(): string {
    return 'docs/migration-review.md';
  }

  private renderReport(goal: string): string {
    const rows = this.findings
      .map(
        (f) =>
          `| ${f.path} | ${f.kind} | ${f.verdict} | ${f.rationale ?? '(not reviewed)'} |`,
      )
      .join('\n');
    return [
      '# Migration review',
      '',
      `Goal: ${goal}`,
      '',
      '| File | Statement | Verdict | Consequence |',
      '|---|---|---|---|',
      rows,
      '',
      'Destructive statements require an explicit approval before they are applied.',
    ].join('\n');
  }

  cleanup(): void {
    // The findings lived in metadata + a proposed file; the instance buffer does
    // not outlive the step. A real agent would close a handle or a temp dir here.
    this.findings = [];
  }
}

/** Descriptor: `defineAgent` derives `agentType` from the class name. */
export const agentDescriptor = defineAgent({
  AgentClass: MigrationGuardAgent,
  agentType: 'migration-guard',
  tags: 'database, migration, safety, example',
  icon: '🛡️',
});
