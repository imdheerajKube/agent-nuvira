/**
 * The HYBRID retrieval corpus — what the two-retriever design claims, made
 * falsifiable.
 *
 * WHY A SECOND CORPUS. `knowledge-corpus.ts` deliberately holds one-chunk
 * documents so its score isolates "did the right DOCUMENT win". That is the
 * right corpus for recall/MRR, and the wrong one for the two things hybrid
 * retrieval added: a document that spans MANY chunks (so a per-source cap has
 * something to cap) and a passage whose only distinguishing feature is a LITERAL
 * identifier (so the keyword half has something to win). Both are here, in one
 * small, reviewable fixture that leaves the recall gate's rationale untouched.
 *
 * THE LOAD-BEARING CASE is `ERR_KX7F_QZ2` in `service-runbook.md › Key rotation`:
 * its prose shares NO word with the code, and the code is the only thing that
 * identifies the section. A meaning-only search cannot reach it (see the
 * `stripped` helper below — the gate fits its embedder on the corpus with every
 * `ERR_*` token removed, which is exactly what an embedding model that has never
 * seen the identifier is), so if that passage comes back at all, it came back
 * from the keyword half. That is the claim, and it is asserted, not printed.
 */

import type { KnowledgeEvalCase } from '../../src/learning/knowledge-eval.js';
import type { CorpusDocument } from './knowledge-corpus.js';

export const HYBRID_CORPUS: CorpusDocument[] = [
  {
    name: 'service-runbook.md',
    // Six sections → six chunks. Every section carries a distinct error code, so
    // a query for the code has exactly one right answer and a query for a code
    // PREFIX ('ERR') matches many of them — which is how the per-source cap gets
    // something to hold back.
    content: [
      '# Service Runbook',
      '',
      '## Ingest pipeline',
      'A batch is rejected when the payload digest does not match the manifest digest, and the batch error is',
      'ERR_PAYLOAD_DIGEST_MISMATCH. Correct the manifest and replay the batch; do not edit the payload in place.',
      '',
      '## Retry policy',
      'Retries stop when the remaining deadline is shorter than the next backoff, reported as',
      'ERR_UPSTREAM_TIMEOUT_BUDGET. Raise the deadline rather than the retry count, so a slow dependency is',
      'not hammered while it recovers.',
      '',
      '## Cold start',
      'A cold start that finds no warm instance fails with ERR_WARM_POOL_EXHAUSTED. Keep one instance warm per',
      'zone during business hours so the first request after a quiet period is not the one that pays for it.',
      '',
      '## Quota',
      'When a tenant exceeds its reserved capacity, the scheduler reclaims it and reports',
      'ERR_TENANT_QUOTA_RECLAIMED. Capacity is returned on the next scheduling window, so the tenant is not',
      'starved permanently.',
      '',
      '## Storage',
      'Reading a blob whose generation has been superseded fails with ERR_BLOB_DEREFERENCE_STALE. Re-resolve the',
      'generation instead of retrying the handle, because the handle will never become valid again.',
      '',
      '## Shutdown',
      'A node that cannot finish in-flight work within the drain window ends with ERR_DRAIN_DEADLINE_EXCEEDED.',
      'Extend the drain window or shed load first; killing the node makes the failure worse.',
      '',
      '## Key rotation',
      'Rotation completes in a single pass and reports ERR_KX7F_QZ2. The identifier is the only thing that',
      'names this outcome, which is why it is the case the keyword half has to win.',
    ].join('\n'),
  },
  {
    name: 'billing-policy.md',
    content: [
      '# Billing Policy',
      '',
      '## Payment terms',
      'Invoices are payable within thirty days of receipt, and late payment accrues interest from the due date.',
    ].join('\n'),
  },
  {
    name: 'auth-design.md',
    content: [
      '# Authentication Design',
      '',
      '## Session tokens',
      'A refresh token rotates on every use, and replaying a rotated refresh token revokes the whole family.',
    ].join('\n'),
  },
];

export const HYBRID_CASES: KnowledgeEvalCase[] = [
  // ── Literal identifiers: the keyword half's job ────────────────────────────
  { question: 'ERR_TENANT_QUOTA_RECLAIMED', expectSources: ['service-runbook.md'] },
  { question: 'what does ERR_BLOB_DEREFERENCE_STALE mean?', expectSources: ['service-runbook.md'] },
  // The load-bearing one: prose shares no word with the code.
  { question: 'ERR_KX7F_QZ2', expectSources: ['service-runbook.md'] },

  // ── Prose questions: the meaning half's job, and proof the corpus is real ──
  { question: 'when are invoices payable and what happens if we pay late?', expectSources: ['billing-policy.md'] },
  { question: 'what happens if a rotated refresh token is replayed?', expectSources: ['auth-design.md'] },

  // ── Strict leak probes: nothing in this corpus shares their vocabulary ─────
  { question: 'what is the capital of France?', unrelated: true },
  { question: 'give me a recipe for a good pizza dough', unrelated: true },
];

/**
 * The corpus with every `ERR_*` token removed — the vocabulary an embedding
 * model that has never seen the identifiers would have seen. Fitting the gate's
 * vectorizer on THIS is what makes "the keyword half won it" a claim the dense
 * half provably could not have made: an out-of-vocabulary term carries no
 * evidence, so the code-only question scores exactly zero against every chunk.
 */
export function withoutIdentifiers(documents: CorpusDocument[]): string[] {
  return documents.map((doc) => doc.content.replace(/\bERR_[A-Z0-9_]+\b/g, 'operation'));
}
