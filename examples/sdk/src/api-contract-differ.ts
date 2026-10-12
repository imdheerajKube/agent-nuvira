/**
 * ApiContractDifferAgent — a second complex example, built around the opposite
 * instinct to the migration guard.
 *
 * WHERE THE MODEL GOES AND WHERE IT DOES NOT. Comparing two API contracts is a
 * SET operation, and a model is the wrong tool for it: it will miss an endpoint
 * on a long list and be confident about it. So this agent uses the model only to
 * turn messy, human-written specs into a canonical endpoint list (JSON in,
 * JSON out — an extraction task models are good at), then does the diff in code
 * where it is exact, and uses one final call to phrase the human summary.
 *
 * It also demonstrates the two things that make an agent trustworthy in a plan:
 *   - a STRICT parser: fenced ```json, prose before/after, or a trailing comma
 *     are handled; anything else is a reported failure, not a silent empty diff;
 *   - `createSequentialMockLLM`-friendly structure: one call per artifact, then
 *     one to summarize — a fixed, testable call order.
 */

import {
  Agent,
  defineAgent,
  type AgentContext,
  type Artifact,
  type AgentResult,
  type LLMCallFn,
} from '@agent-nuvira/sdk';

/** One endpoint as extracted from a spec. */
export interface Endpoint {
  method: string;
  path: string;
}

/** The full comparison the agent produces. */
export interface ContractDiff {
  added: Endpoint[];
  removed: Endpoint[];
  unchanged: number;
}

/**
 * Extract the first JSON value from whatever the model wrapped it in.
 *
 * Handles ```json fences, leading prose, and a trailing comma before `]`/`}` —
 * the three shapes this actually receives. Exported because a parser this
 * opinionated deserves its own tests.
 */
export function extractJsonArray(text: string): Endpoint[] | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = (fenced ? fenced[1]! : text).trim();

  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  candidate = candidate.slice(start, end + 1);

  // A trailing comma is extremely common in generated JSON; tolerating it is
  // less brittle than failing a whole plan over a punctuation mark.
  const cleaned = candidate.replace(/,\s*([\]}])/g, '$1');
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;
    const endpoints: Endpoint[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const method = (entry as { method?: unknown }).method;
      const path = (entry as { path?: unknown }).path;
      if (typeof method === 'string' && typeof path === 'string') {
        endpoints.push({ method: method.trim().toUpperCase(), path: path.trim() });
      }
    }
    return endpoints.length > 0 ? endpoints : null;
  } catch {
    return null;
  }
}

/** Stable identity for an endpoint, so the diff is order-independent. */
function keyOf(endpoint: Endpoint): string {
  return `${endpoint.method} ${endpoint.path}`;
}

/** The deterministic half: pure code, no model. */
export function diffContracts(before: Endpoint[], after: Endpoint[]): ContractDiff {
  const beforeKeys = new Set(before.map(keyOf));
  const afterKeys = new Set(after.map(keyOf));
  return {
    added: after.filter((e) => !beforeKeys.has(keyOf(e))),
    removed: before.filter((e) => !afterKeys.has(keyOf(e))),
    unchanged: [...beforeKeys].filter((k) => afterKeys.has(k)).length,
  };
}

export class ApiContractDifferAgent extends Agent {
  readonly name = 'ApiContractDiffer';
  readonly description = 'Diffs two API specs, flags removed endpoints as breaking, and drafts a changelog entry';

  validate(context: AgentContext): true | string {
    const specs = this.pickSpecs(context);
    if (specs.before.length === 0 || specs.after.length === 0) {
      return 'ApiContractDiffer needs two non-empty spec artifacts (old and new) — pass both in context.artifacts.';
    }
    return true;
  }

  /**
   * Which artifact is "before" and which is "after".
   *
   * Explicit beats clever: an artifact description saying old/before/previous (or
   * new/after/current) decides it. Otherwise the first two are used in order,
   * which is what a plan that gathered the two files produces.
   */
  private pickSpecs(context: AgentContext): { before: Artifact[]; after: Artifact[] } {
    const usable = context.artifacts.filter((a) => a.content?.trim());
    const oldish = /old|before|previous|baseline/i;
    const newish = /new|after|current|updated/i;

    const before = usable.filter((a) => oldish.test(a.description) || oldish.test(a.path));
    const after = usable.filter((a) => newish.test(a.description) || newish.test(a.path));

    if (before.length > 0 && after.length > 0) return { before, after };
    return { before: usable.slice(0, 1), after: usable.slice(1, 2) };
  }

  private extractionPrompt(label: string, artifacts: Artifact[]): string {
    return [
      `Extract every HTTP endpoint from the ${label} API spec below.`,
      'Return ONLY a JSON array, no prose:',
      '[{"method":"GET","path":"/v1/issues"}, …]',
      'One object per endpoint. Do not merge similar paths.',
      '',
      ...artifacts.map((a) => `--- ${a.path} ---\n${a.content}`),
    ].join('\n');
  }

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    const { before, after } = this.pickSpecs(context);

    // Call 1 and 2 — fixed order, one per side. Extraction only.
    const beforeRaw = await callLLM(this.extractionPrompt('OLD', before), { temperature: 0, maxTokens: 1500 });
    const afterRaw = await callLLM(this.extractionPrompt('NEW', after), { temperature: 0, maxTokens: 1500 });

    const beforeEndpoints = extractJsonArray(beforeRaw);
    const afterEndpoints = extractJsonArray(afterRaw);

    if (!beforeEndpoints || !afterEndpoints) {
      // Naming WHICH side failed is the difference between a fixable failure and
      // a mystery. A plan step that reports "the model returned prose" is useless.
      const which = !beforeEndpoints && !afterEndpoints ? 'both sides' : !beforeEndpoints ? 'the OLD spec' : 'the NEW spec';
      return {
        success: false,
        summary: `Could not parse the endpoint list from ${which}`,
        error: `${which}: expected a JSON array of {method, path}`,
      };
    }

    // The diff is code, not a model.
    const diff = diffContracts(beforeEndpoints, afterEndpoints);
    const breaking = diff.removed.length > 0;

    // Call 3 — phrasing only. A failure here must NOT lose the diff.
    const summaryPrompt = [
      'Write a short CHANGELOG entry (markdown bullets, no heading) for this API change.',
      breaking
        ? 'REMOVED endpoints are BREAKING — call them out first and suggest the replacement if the paths suggest one.'
        : 'Nothing was removed; this is a compatible change.',
      '',
      `Added: ${diff.added.map(keyOf).join(', ') || 'none'}`,
      `Removed: ${diff.removed.map(keyOf).join(', ') || 'none'}`,
      `Unchanged: ${diff.unchanged}`,
    ].join('\n');

    let changelog: string;
    try {
      changelog = await callLLM(summaryPrompt, { temperature: 0.3, maxTokens: 400 });
    } catch (err) {
      changelog = `(summary unavailable: ${err instanceof Error ? err.message : String(err)})`;
    }

    const report = [
      breaking ? '## ⚠️ Breaking API change' : '## API change (compatible)',
      '',
      changelog.trim(),
      '',
      '### Added',
      ...(diff.added.length ? diff.added.map((e) => `- \`${keyOf(e)}\``) : ['- (none)']),
      '',
      '### Removed',
      ...(diff.removed.length ? diff.removed.map((e) => `- \`${keyOf(e)}\``) : ['- (none)']),
    ].join('\n');

    context.metadata = { ...context.metadata, contractDiff: diff, contractBreaking: breaking };
    context.fileChanges.push({
      path: 'CHANGELOG.contract.md',
      newContent: report,
      status: 'created',
    });

    return {
      success: true,
      summary: breaking
        ? `BREAKING: ${diff.removed.length} endpoint(s) removed, ${diff.added.length} added`
        : `${diff.added.length} endpoint(s) added, none removed`,
      details: report,
    };
  }
}

export const agentDescriptor = defineAgent({
  AgentClass: ApiContractDifferAgent,
  agentType: 'api-contract-differ',
  tags: 'api, diff, changelog, example',
  icon: '🔀',
});
