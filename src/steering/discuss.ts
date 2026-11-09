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
  const lines = [
    `RUN: ${redact(view.run.goal).slice(0, 800)}`,
    `STATUS: ${view.run.status} · engine ${view.run.engine} · plan v${plan?.version ?? 0} · ${done}/${total} steps done`,
    '',
    'PLAN:',
    ...(plan?.steps.slice(0, 40).map((s, i) => `${i + 1}. [${s.id}] (${s.status}) ${s.description}`) ?? [
      '(no plan version yet)',
    ]),
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
  return [
    `The run is ${view.run.status}, on plan v${plan?.version ?? 0} (${done}/${total} steps done).`,
    `${view.changes.length} guidance item(s) received: ${applied} applied, ${awaiting} awaiting your approval, ${pending} queued.`,
    view.backlog.length > 0 ? `${view.backlog.length} separate task(s) are in the backlog.` : '',
    awaiting > 0 ? 'Approve or reject the pending item to unblock that change.' : '',
    `Your question — “${redact(question).slice(0, 200)}” — was not used to change the plan. Use “Promote to guidance” to make it a change request.`,
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
    return { answer: 'Ask a question about the run — status, what changed, or why a step is taking long.', context };
  }
  if (input.generate) {
    try {
      const answer = await input.generate([
        {
          role: 'system',
          content: [
            'You answer questions about a running autonomous coding agent.',
            'Use ONLY the supplied run context. You cannot change the plan, approve anything, run tools,',
            'or claim to have done so. Be brief and specific. If the context does not answer the',
            'question, say what is not known rather than guessing.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `[Run context]\n${context}\n\n[Question]\n${redact(question)}`,
        },
      ]);
      const trimmed = String(answer ?? '').trim();
      if (trimmed) return { answer: trimmed, context, promotedPrompt: question };
    } catch {
      // Fall through to the deterministic answer.
    }
  }
  return { answer: deterministicAnswer(input.runId, question), context, promotedPrompt: question };
}
