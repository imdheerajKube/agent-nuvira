/**
 * WS1 (#23) — `finding`: the model states a CLAIM, the gate decides the VERDICT.
 *
 * WHY A TOOL, AND WHY IT DOES NOT ACCEPT A VERDICT. `src/findings/verdicts.ts`
 * is the vocabulary and the gate; it deliberately does not decide who may
 * produce a finding (`intent-confirm` produces one for a routing decision). This
 * is the producer for an ORDINARY turn on every surface, and the one design rule
 * that matters is here: the model may supply the claim, the outcome and the
 * evidence, and must NOT be able to supply the verdict. A tool argument called
 * `verdict` would be the exact bypass the gate exists to refuse — the model
 * typing "CONFIRMED" is the false-success defect with a nicer name — so the
 * parameter does not exist. `confirmFinding` promotes to CONFIRMED only when at
 * least one non-blank evidence reference was supplied, and refuses otherwise
 * with the reason attached. When the loop supplies its action ledger
 * (`ctx.executedActions`), a second gate checks that a `command`/`file`
 * reference corresponds to something the turn actually did
 * (`enforceEvidenceProvenance`), demoting a citation that never happened to
 * PLAUSIBLE rather than letting it pass as fact.
 * with the reason attached.
 *
 * WHAT THE MODEL SEES BACK is the rendered finding (`describeFinding`), including
 * the honest line for a PLAUSIBLE one ("no evidence — reported as PLAUSIBLE, not
 * verified"). That is the point of returning the render rather than a summary: a
 * model that states a claim with no evidence is told, in the tool result it must
 * act on, that the claim was recorded as unverified rather than as fact.
 *
 * THE STRUCTURED COPY travels to the surface on the context bus as
 * `finding:recorded` (the same mechanism `plan_todo` uses for `plan:changed`),
 * so every surface reports the SAME wire form — which is what
 * `findings-verdicts@<surface>` is proved against.
 *
 * A CALL THAT RECORDED NOTHING IS A FAILURE. A blank claim or a blank outcome
 * returns `Error:` (the loop's own accounting is `ok: !startsWith('Error:')`),
 * because a finding with no claim is not a finding — and reporting one as a
 * successful call would be this repository's recurring defect in miniature.
 */

import { z } from 'zod';

import {
  confirmFinding,
  describeFinding,
  enforceEvidenceProvenance,
  plausibleFinding,
  toWire,
  type Evidence,
  type Finding,
} from '../findings/verdicts.js';
import type { Tool, ToolContext } from './registry.js';

/** The registry name — one place, so the toolset/core lists and the tests agree. */
export const FINDING_TOOL_NAME = 'finding';

/**
 * The bus event carrying the structured wire finding.
 *
 * Named `finding:recorded` (past tense) on purpose: the event is emitted AFTER
 * the gate has decided, so a listener never sees a claim whose verdict is still
 * being computed — the same convention `plan:changed` follows.
 */
export const FINDING_EVENT = 'finding:recorded';

/** The evidence kinds the model may cite (the closed set the gate normalises to). */
const EVIDENCE_KINDS = ['quote', 'command', 'file', 'observation'] as const;

/** `finding` args. There is deliberately no `verdict` field — see the header. */
export const findingSchema = z.object({
  claim: z
    .string()
    .describe(
      'What is being asserted, in the words the reader will see — e.g. "the login endpoint rejects an expired token".',
    ),
  outcome: z
    .string()
    .describe(
      'What BECAME of the claim: verified, corrected, dropped, still open. A finding with no outcome is a status report, not a finding.',
    ),
  evidence: z
    .array(
      z.object({
        kind: z.enum(EVIDENCE_KINDS).describe('The sort of check that was performed.'),
        ref: z
          .string()
          .describe(
            'The evidence ITSELF — a verbatim quote from the input, the exact command line, the path that was read, or a value a probe returned. A restatement of the claim is not evidence, and a blank reference is not a check.',
          ),
        detail: z.string().optional().describe('Optional context: the command output, the surrounding line, why it matters.'),
      }),
    )
    .optional()
    .describe(
      'The checks actually performed. Supply this and the finding is recorded CONFIRMED; omit it (or leave a reference blank) and it is recorded PLAUSIBLE, unverified — which is an honest, useful result, not an error.',
    ),
});

export type FindingToolArgs = z.infer<typeof findingSchema>;

/**
 * Record one finding: build it PLAUSIBLE, let the gate decide, report it.
 *
 * Split out from the `Tool` wrapper so the behaviour is testable without the
 * registry, and so a caller that already has a context (the child process) can
 * reuse it.
 */
export function recordFinding(
  args: FindingToolArgs,
  ctx?: Pick<ToolContext, 'emit' | 'executedActions'>,
): { finding: Finding; text: string } | { error: string } {
  const claim = String(args?.claim ?? '').trim();
  const outcome = String(args?.outcome ?? '').trim();
  if (!claim) {
    return {
      error:
        "Error: finding needs a 'claim' — what is being asserted, in the words the user will read. " +
        'A finding with no claim records nothing.',
    };
  }
  if (!outcome) {
    return {
      error:
        "Error: finding needs an 'outcome' — what became of the claim (verified, corrected, dropped, still open). " +
        'A finding with no outcome is a status report, not a finding.',
    };
  }

  const evidence = (args.evidence ?? []) as Evidence[];
  // The gate, not the caller, decides. `confirmFinding` returns the finding
  // STILL PLAUSIBLE (with the reason) when no usable evidence was supplied; that
  // refusal is a normal outcome, so it is recorded in the outcome line rather
  // than thrown.
  const promotion = confirmFinding(
    plausibleFinding({ claim, outcome, source: 'agent', evidence }),
    [],
    { outcome },
  );
  let finding = promotion.promoted
    ? promotion.finding
    : promotion.reason
      ? { ...promotion.finding, outcome: `${outcome} — ${promotion.reason}` }
      : promotion.finding;

  // PROVENANCE, not just presence. `confirmFinding` promotes on the PRESENCE of
  // a non-blank reference; this checks the reference against what the turn
  // actually did. Run only when the loop supplied its action ledger — a direct
  // call or a bare test context cannot distinguish "nothing ran" from "no
  // ledger", so it must not demote on the strength of an empty list.
  if (ctx?.executedActions) {
    finding = enforceEvidenceProvenance(finding, ctx.executedActions).finding;
  }

  // Best-effort: a listener that is not there (a direct tool call, a test) must
  // never break the tool, exactly like `plan_todo`'s snapshot emit.
  try {
    ctx?.emit?.(FINDING_EVENT, toWire(finding));
  } catch {
    /* best-effort */
  }

  return { finding, text: describeFinding(finding) };
}

/** The `finding` tool as the registry takes it. */
export function createFindingTool(): Tool {
  return {
    name: FINDING_TOOL_NAME,
    description:
      'Record one finding — a claim about the world, with a verdict you do NOT set. Supply `claim` + `outcome`, and `evidence` for anything you actually CHECKED (a command and its real output, a path you read, a quote from the request, a value a probe returned): usable evidence records the finding CONFIRMED, and no usable evidence records it PLAUSIBLE (an honest, useful result — never a failure). Use it whenever your answer asserts something a second party could check, so the user can tell what was verified from what is a reasoned guess.',
    category: 'experience',
    inputSchema: findingSchema,
    endsAgentStep: false,
    run: async (args, ctx) => {
      const parsed = findingSchema.parse(args) as FindingToolArgs;
      const result = recordFinding(parsed, ctx);
      if ('error' in result) return result.error;
      return result.text;
    },
  };
}
