/**
 * ConventionalCommitAgent — example custom agent built with @agent-nuvira/sdk.
 *
 * It drafts a [Conventional Commits](https://www.conventionalcommits.org) message
 * from a change description (`context.goal`) and/or the file artifacts the
 * orchestrator gathered (typically a diff).
 *
 * The example is deliberately complete rather than minimal — it demonstrates the
 * three things a real agent does:
 *   1. `validate()` refuses to run without the minimum input it needs;
 *   2. `execute()` calls the injected LLM through the provided `callLLM`;
 *   3. the result is validated, so a model that returns prose is reported as a
 *      failure instead of silently producing a bad commit message.
 */

import {
  Agent,
  defineAgent,
  type AgentContext,
  type AgentResult,
  type LLMCallFn,
} from '@agent-nuvira/sdk';

/** Conventional Commits types this agent will accept. */
export const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

/** `<type>(<optional scope>)?!?: <subject>` */
export const CONVENTIONAL_SUBJECT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+$/;

export class ConventionalCommitAgent extends Agent {
  readonly name = 'ConventionalCommit';
  readonly description = 'Drafts a Conventional Commits message from a change description or diff';

  /** Refuse to run with nothing to summarize — a real precondition, not a guess. */
  validate(context: AgentContext): true | string {
    const hasGoal = Boolean(context.goal && context.goal.trim());
    const hasDiff = context.artifacts.some((a) => a.content && a.content.trim());
    if (!hasGoal && !hasDiff) {
      return 'Provide a change description (goal) or at least one non-empty artifact (diff).';
    }
    return true;
  }

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    const diffs = context.artifacts
      .filter((a) => a.content && a.content.trim())
      .map((a) => `--- ${a.path} ---\n${a.content}`)
      .join('\n\n');

    const prompt = [
      'You write Conventional Commits messages.',
      'Rules:',
      '- The FIRST line is the subject: "<type>(<scope>)?: <subject>".',
      '- Subject is imperative mood, no trailing period, at most 72 characters.',
      `- Allowed types: ${COMMIT_TYPES.join(', ')}.`,
      '- You may add a blank line and a short body after the subject.',
      '',
      'Change description:',
      context.goal.trim() || '(none provided)',
      '',
      diffs ? `Diff:\n${diffs}` : 'Diff: (none provided)',
    ].join('\n');

    const raw = await callLLM(prompt, { temperature: 0.2, maxTokens: 200 });
    const message = (raw ?? '').trim();

    if (!message) {
      return { success: false, summary: 'The model returned an empty message' };
    }

    const subject = message.split('\n')[0].trim();
    if (!CONVENTIONAL_SUBJECT_RE.test(subject)) {
      return {
        success: false,
        summary: 'Model output is not a valid Conventional Commits subject',
        error: `Invalid subject: "${subject}"`,
      };
    }

    return { success: true, summary: subject, details: message };
  }
}

/**
 * Descriptor for registration. `defineAgent` reads `name`/`description` off the
 * class and validates the derived `agentType` at definition time.
 */
export const agentDescriptor = defineAgent({
  AgentClass: ConventionalCommitAgent,
  agentType: 'conventional-commit',
  tags: 'git, commit, example',
});
