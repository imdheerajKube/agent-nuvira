/**
 * Intent confirmation — the self-correction half of routing.
 *
 * THE PROBLEM. When a turn fails, the agent has exactly one reliable way to
 * find out whether the failure was the WORLD's fault (no model, no quota) or its
 * OWN (it read the request wrong and worked on the wrong thing): ask the model
 * what the request actually is. Without that, a misreading is permanent — the
 * same ask runs down the same wrong path on every future message, burning a
 * pipeline run each time, and the user's only recourse is to rephrase.
 *
 * The rules it corrects are deterministic and cheap, which is why they are worth
 * keeping, and blind to the object of a verb, which is why they need this. So the
 * design is: keep the rules on the hot path, and let a CONFIRMED correction
 * override them from then on (`learnings.ts`).
 *
 * THREE DELIBERATE RESTRAINTS
 *  1. It runs only on a REPEATED failure. A single failure mostly says something
 *     about the world; probing on every one would spend a quota-limited model to
 *     audit a routing decision that was probably fine.
 *  2. It is asked to answer with JSON and nothing else, but the reply is parsed
 *     defensively — a model that ignores the format yields NO correction rather
 *     than a guessed one.
 *  3. Any error (no model, unparseable answer) means "no correction". Teaching
 *     the NLU from a failed probe would encode an outage as a rule, which is the
 *     worst possible outcome: the router would get worse exactly when the pool
 *     is down.
 *
 * AND IT NOW CARRIES A VERDICT, because restraint 3 was only half the promise.
 * `learnings.ts` says a learning is written only when a misreading has been
 * CONFIRMED — but "confirmed" meant the model said so, with nothing recorded that
 * a second party could check, so a correction nobody could justify was persisted
 * and silently re-routed every later ask that matched. The decision is now a
 * `Finding` (`src/findings/verdicts.ts`): the model's stated reason is the
 * evidence, and only a CONFIRMED verdict is TAUGHT. A correction with no reason
 * is still ACTED ON — the turn takes the better route — it is just not written
 * down as a rule, which is the difference between a decision and a permanent
 * change to the router.
 */

import { confirmFinding, plausibleFinding, type Evidence, type Finding } from '../findings/verdicts.js';
import { recordLearning, type NluLearning } from './learnings.js';
import type { AskKind } from './conversation-gate.js';

/** What one confirmation established. */
export interface IntentConfirmResult {
  /** The kind to act on now — the corrected one, or the routed one unchanged. */
  kind: AskKind;
  /** True when the model agreed with the original reading (or gave no verdict). */
  agreed: boolean;
  /** The model's one-line reason, when it gave one. */
  reason?: string;
  /** The learning written, when the reading was corrected AND confirmed. */
  learning?: NluLearning;
  /** True when the probe could not run (no model / unreadable answer). */
  failed?: boolean;
  /**
   * The verdict this decision carries, with its evidence.
   *
   * Always present, including when the probe failed: "we could not establish a
   * reading" is itself a fact about the turn, and a caller composing a report
   * (`src/findings/verdicts.ts` `describeFinding`) should be able to print the
   * decision and see that it was a guess rather than infer it from a missing
   * field.
   */
  finding: Finding;
}

/** The claim a confirmation asserts: which kind serves the ask. */
function claimFor(ask: string, reading: AskKind): string {
  const shown = ask.length > 120 ? `${ask.slice(0, 120)}…` : ask;
  const as = reading === 'pipeline' ? 'the coding pipeline' : 'a direct written answer';
  return `the ask "${shown}" is best served by ${as}`;
}

/**
 * The model's stated reason, as evidence.
 *
 * This is the whole bar, and it is a deliberately modest one: a routing probe
 * cannot run a test or read a file, so the only check available to it is that the
 * model can say WHY. A correction the model could not justify is not promoted,
 * and therefore is not persisted into a rule that outlives the conversation.
 */
function reasonEvidence(reason: string | undefined): Evidence[] {
  const ref = String(reason ?? '').trim();
  return ref ? [{ kind: 'observation', ref, detail: 'stated reason from the probe model' }] : [];
}

/**
 * The finding for one decision: PLAUSIBLE unless the probe justified it.
 *
 * `outcome` is required and always says what BECAME of the finding, because an
 * outcome is what separates a finding from a status line — "the route was
 * corrected" and "no verdict: the answer did not state a reading" are different
 * facts and must not both render as silence.
 */
function decisionFinding(input: {
  ask: string;
  reading: AskKind;
  outcome: string;
  reason?: string;
  now?: number;
}): Finding {
  return confirmFinding(
    plausibleFinding({
      claim: claimFor(input.ask, input.reading),
      outcome: input.outcome,
      source: 'intent-confirm',
      ...(input.now !== undefined ? { at: input.now } : {}),
    }),
    reasonEvidence(input.reason),
    { outcome: input.outcome },
  ).finding;
}

/**
 * The audit prompt. Kept to a JSON contract with the decision space spelled out,
 * because the model is being asked to judge a routing decision — not to answer
 * the request. Answering it here would leak a second, contradictory answer into
 * the conversation.
 */
export function buildIntentConfirmPrompt(ask: string, routed: AskKind): string {
  return [
    'You are auditing ONE routing decision. Do not answer the request, do not explain the topic, do not add prose.',
    '',
    `The request was: """${ask.slice(0, 800)}"""`,
    `It was routed as: ${routed === 'pipeline' ? '"coding-task" (the developer pipeline builds software)' : '"chat" (a direct written answer is produced)'}`,
    '',
    'Decide which one genuinely serves the sender:',
    '- "chat": the sender wants knowledge, advice, content or an explanation delivered as text — a plan, routine, schedule, diet, story, lesson, letter, explanation, comparison, or ANY question. Producing a software project for this would be wrong.',
    '- "coding-task": the sender wants software built or changed in a codebase — an app, script, API, test, fix, refactor, deploy.',
    '',
    'Reply with JSON only, exactly this shape:',
    '{"intent":"chat"|"coding-task","reason":"<max 12 words>"}',
  ].join('\n');
}

/** Phrases that mean "the developer pipeline". */
const PIPELINE_TOKENS = ['coding-task', 'coding task', 'coding_task', 'pipeline', 'developer', 'software', 'code-task'];
/** Phrases that mean "answer it directly". */
const CHAT_TOKENS = ['"chat"', 'chat', 'answer', 'direct', 'prose', 'content'];

/**
 * Read a verdict out of the model's reply.
 *
 * Order matters: an explicit JSON `intent` field is authoritative, then a bare
 * quoted token, then keyword scanning. Anything ambiguous returns no verdict
 * (`understood: false`) so the caller keeps the route it had.
 */
export function parseIntentConfirmReply(raw: string): { kind?: AskKind; reason?: string; understood: boolean } {
  const text = String(raw ?? '');
  if (!text.trim()) return { understood: false };

  // 1. An explicit JSON intent field.
  const jsonMatch = /"intent"\s*:\s*"([^"]+)"/i.exec(text);
  const reasonMatch = /"reason"\s*:\s*"([^"]*)"/i.exec(text);
  const reason = reasonMatch?.[1]?.trim().slice(0, 200) || undefined;
  if (jsonMatch) {
    const value = jsonMatch[1]!.toLowerCase();
    if (PIPELINE_TOKENS.includes(value) || /coding|code|pipeline|developer/.test(value)) {
      return { kind: 'pipeline', reason, understood: true };
    }
    if (CHAT_TOKENS.includes(value) || /chat|answer/.test(value)) {
      return { kind: 'chat', reason, understood: true };
    }
    return { understood: false, ...(reason ? { reason } : {}) };
  }

  // 2. A bare token, which is what a truncated or prose answer usually leaves.
  const lower = text.toLowerCase();
  const hasPipeline = /\bcoding[- _]?task\b|\bpipeline\b|\bdeveloper\b/.test(lower);
  const hasChat = /(^|\W)chat(\W|$)|direct answer|answer directly|prose/.test(lower);
  if (hasPipeline && !hasChat) return { kind: 'pipeline', reason, understood: true };
  if (hasChat && !hasPipeline) return { kind: 'chat', reason, understood: true };
  return { understood: false, ...(reason ? { reason } : {}) };
}

/**
 * Ask the model what this ask really needs, and record the correction when it
 * disagrees with the route that just failed.
 *
 * @param callLLM A one-shot model call. Injected so the caller owns routing and
 *   tests stay deterministic — and so a probe never piggy-backs on the failover
 *   state of the turn that just died.
 */
export async function confirmRoutedIntent(input: {
  ask: string;
  routed: AskKind;
  callLLM: (prompt: string) => Promise<string>;
  /** Record the correction as a learning (default: true). */
  record?: boolean;
  now?: number;
}): Promise<IntentConfirmResult> {
  let raw = '';
  try {
    raw = await input.callLLM(buildIntentConfirmPrompt(input.ask, input.routed));
  } catch {
    // The probe is best-effort by contract: a failure means "no verdict".
    return {
      kind: input.routed,
      agreed: true,
      failed: true,
      finding: decisionFinding({
        ask: input.ask,
        reading: input.routed,
        outcome: 'no verdict — the probe could not run, so the reading stands unexamined',
        ...(input.now !== undefined ? { now: input.now } : {}),
      }),
    };
  }

  const parsed = parseIntentConfirmReply(raw);
  if (!parsed.understood || !parsed.kind || parsed.kind === input.routed) {
    return {
      kind: input.routed,
      agreed: true,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(parsed.understood ? {} : { failed: true }),
      finding: decisionFinding({
        ask: input.ask,
        reading: input.routed,
        outcome: parsed.understood
          ? 'the reading was not changed'
          : 'no verdict — the answer did not state a reading',
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      }),
    };
  }

  // The corrected reading — the one that can turn into a rule. It is ACTED ON
  // whatever its verdict (the turn takes the better route), and TAUGHT only when
  // the model justified it, which is the gate: see the header.
  const finding = decisionFinding({
    ask: input.ask,
    reading: parsed.kind,
    outcome: `the route was corrected from ${input.routed} to ${parsed.kind}`,
    ...(parsed.reason ? { reason: parsed.reason } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  const result: IntentConfirmResult = {
    kind: parsed.kind,
    agreed: false,
    finding,
    ...(parsed.reason ? { reason: parsed.reason } : {}),
  };
  const confirmed = finding.verdict === 'CONFIRMED' && finding.evidence.length > 0;
  if (confirmed && input.record !== false) {
    const learning = recordLearning({
      text: input.ask,
      from: input.routed,
      to: parsed.kind,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (learning) result.learning = learning;
  }
  if (!confirmed) {
    result.finding = {
      ...finding,
      outcome: `${finding.outcome} — not learned: nothing the model could be checked against`,
    };
  }
  return result;
}

/** The line a sender sees when the audit CONFIRMS the reading. */
export function intentConfirmedNote(routed: AskKind): string {
  return routed === 'pipeline'
    ? '🧭 I double-checked what you asked for: building this is the right read, so the only problem is model availability.'
    : '🧭 I double-checked what you asked for: this is a question to answer, not code to write, so the only problem is model availability.';
}

/** The line a sender sees when the audit CORRECTED the reading. */
export function intentCorrectedNote(to: AskKind, reason?: string): string {
  const why = reason ? ` (${reason})` : '';
  return to === 'pipeline'
    ? `🧭 I re-read your request${why} — that one needs the build pipeline, not a written answer. Running it now.`
    : `🧭 I re-read your request${why} — that's a question to answer, not code to write. Answering it directly now.`;
}
