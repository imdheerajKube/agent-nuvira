/**
 * Discuss mode — a READ-ONLY side conversation about the run.
 *
 * The user wants to think out loud without changing the plan. This module answers
 * from the run's durable facts (status, plan, guidance queue, backlog) and has no
 * tool access and no mutation path. The answer may be promoted to a change request
 * by submitting the same text through the inbox; that is an explicit user action,
 * not a side effect of talking.
 */

import type { ToolMessage } from '../inference/interface.js';
import { redact } from '../enterprise/secrets.js';
import { projectRun } from './projection.js';
import type { DiscussAnswer } from './types.js';

export type DiscussGenerate = (messages: ToolMessage[]) => Promise<string>;

/** Build the bounded, redacted context the discuss answer may use. */
export function discussContext(runId: string): string {
  const view = projectRun(runId);
  if (!view.run) return 'No steering run exists for this id.';
  const plan = view.plan;
  const done = plan?.steps.filter((s) => s.status === 'done').length ?? 0;
  const total = plan?.steps.length ?? 0;
  const open = view.changes.filter(
    (c) => c.status !== 'applied' && c.status !== 'rejected' && c.status !== 'withdrawn',
  );
  // The step NOTE is where the engine records what it actually did ("wired into
  // all surfaces"). Leaving it out made a completed plan look silent about
  // coverage, so discuss answered "not known from the context" to a question
  // the run had already answered. Acceptance criteria and constraints get the
  // same treatment: they are user-facing facts, not internal metadata.
  const recent = view.changes.slice(-6).reverse();
  const lines = [
    `RUN: ${redact(view.run.goal).slice(0, 800)}`,
    `STATUS: ${view.run.status} · engine ${view.run.engine} · plan v${plan?.version ?? 0} · ${done}/${total} steps done`,
    '',
    'PLAN:',
    ...(plan?.steps.slice(0, 40).flatMap((s, i) => [
      `${i + 1}. [${s.id}] (${s.status}) ${s.description}`,
      ...(s.acceptanceCriteria.length
        ? [`   acceptance: ${s.acceptanceCriteria.join('; ')}`]
        : []),
      ...(s.note ? [`   note: ${redact(s.note).slice(0, 500)}`] : []),
    ]) ?? ['(no plan version yet)']),
    ...(plan?.constraints.length
      ? ['', 'CONSTRAINTS:', ...plan.constraints.map((c) => `- ${c}`)]
      : []),
    '',
    'RECENT GUIDANCE (most recent first):',
    ...(recent.length
      ? recent.map((c) => `- ${c.id} [${c.status}] ${redact(c.rawText).slice(0, 240)}`)
      : ['(none)']),
    '',
    'OPEN GUIDANCE:',
    ...(open.length
      ? open.map((c) => `- ${c.id} [${c.status}] ${redact(c.rawText).slice(0, 240)}`)
      : ['(none)']),
    '',
    'BACKLOG:',
    ...(view.backlog.length ? view.backlog.slice(0, 10).map((b) => `- ${b.title}`) : ['(none)']),
  ];
  return lines.join('\n');
}

function deterministicAnswer(runId: string, question: string): string {
  const view = projectRun(runId);
  if (!view.run) return 'There is no active steering run with that id.';
  const plan = view.plan;
  const done = plan?.steps.filter((s) => s.status === 'done').length ?? 0;
  const total = plan?.steps.length ?? 0;
  const awaiting = view.changes.filter((c) => c.status === 'needs_approval').length;
  const applied = view.changes.filter((c) => c.status === 'applied').length;
  const pending = view.changes.filter((c) => c.status === 'received' || c.status === 'triaged').length;
  const lastDoneNote = [...(plan?.steps ?? [])]
    .reverse()
    .find((step) => step.status === 'done' && step.note)?.note;
  return [
    `The run is ${view.run.status}, on plan v${plan?.version ?? 0} (${done}/${total} steps done).`,
    `${view.changes.length} guidance item(s) received: ${applied} applied, ${awaiting} awaiting your approval, ${pending} queued.`,
    lastDoneNote ? `Latest completed step note: ${redact(lastDoneNote).slice(0, 300)}` : '',
    view.backlog.length > 0 ? `${view.backlog.length} separate task(s) are in the backlog.` : '',
    awaiting > 0 ? 'Approve or reject the pending item to unblock that change.' : '',
    `This is a read-only answer to “${redact(question).slice(0, 200)}”; the plan is unchanged. Use “Promote to guidance” to make it a change request.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Answer a question about the run. No plan mutation, no tools, no approval.
 * A model answer is constrained to the supplied context; a provider failure falls
 * back to the deterministic summary rather than showing an error.
 */
export async function discussRun(input: {
  runId: string;
  question: string;
  generate?: DiscussGenerate;
}): Promise<DiscussAnswer> {
  const context = discussContext(input.runId);
  const question = String(input.question ?? '').trim();
  if (!question) {
    return {
      answer: 'Ask a question about the run — status, what changed, or why a step is taking long.',
      context,
      source: 'deterministic',
    };
  }
  if (input.generate) {
    try {
      const answer = await input.generate([
        {
          role: 'system',
          content: [
            'You answer questions about an autonomous coding agent run (running, paused or finished).',
            'Use ONLY the supplied run context: the goal, plan steps, acceptance criteria, step notes,',
            'constraints, guidance history and backlog. The step notes are the engine\'s own record of',
            'what it did — quote them when they answer the question. Be brief and specific (at most',
            '120 words). If a fact is absent, name that specific fact; never say you lack access to',
            'the chat or the run, because the supplied context IS the run. You cannot change the plan,',
            'approve anything, run tools, or claim to have done so.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `[Run context]\n${context}\n\n[Question]\n${redact(question)}`,
        },
      ]);
      const trimmed = String(answer ?? '').trim();
      if (trimmed) return { answer: trimmed, context, promotedPrompt: question, source: 'model' };
    } catch {
      // Fall through to the deterministic answer.
    }
  }
  return {
    answer: deterministicAnswer(input.runId, question),
    context,
    promotedPrompt: question,
    source: 'deterministic',
  };
}
