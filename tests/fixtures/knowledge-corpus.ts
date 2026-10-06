/**
 * The retrieval eval corpus and its questions.
 *
 * A FIXED, REVIEWABLE CORPUS is the whole point: "retrieval got better" is not a
 * claim anyone can check against a user's private documents, and a corpus that
 * changes with every run makes recall@k meaningless. Five documents with
 * deliberately DIFFERENT vocabulary (billing, auth, onboarding, kubernetes,
 * incident response), two questions each whose right answer is unambiguous, and
 * five questions with NO answer anywhere in the corpus.
 *
 * The unrelated set is not decoration — it is the leak probe. A question like
 * "what is the capital of France" must reach the floor and come back empty; if
 * it does not, the floor is too loose to protect any real ask.
 *
 * Documents are kept to roughly one chunk each on purpose. Multi-chunk ingest
 * (including the retired-tail delete) has its own tests; this corpus isolates
 * the RETRIEVAL question — did the right document win — so a chunking change
 * cannot move the score without also changing what the score means.
 */

import type { KnowledgeEvalCase } from '../../src/learning/knowledge-eval.js';

export interface CorpusDocument {
  /** Basename recorded in the manifest — the identity `expectSources` matches. */
  name: string;
  content: string;
}

export const KNOWLEDGE_CORPUS: CorpusDocument[] = [
  {
    name: 'billing-policy.md',
    content: [
      '# Billing Policy',
      '',
      '## Payment terms',
      'Invoices are issued on the first business day of each month and are payable within 30 days of receipt.',
      'Late payments accrue interest at 1.5% per month, compounded monthly, calculated from the due date until the',
      'outstanding balance is settled in full. Customers on an annual plan are invoiced once, in advance, and may',
      'request quarterly instalments by written agreement with the billing team.',
      '',
      '## Currency and tax',
      'All invoices are denominated in US dollars unless the contract specifies a local currency. Value added tax,',
      'goods and services tax and any equivalent sales tax are added at the rate applicable on the invoice date.',
      'Where a customer supplies a valid exemption certificate, tax is not charged on subsequent invoices.',
      '',
      '## Refunds and credits',
      'A refund is issued to the original payment method within ten business days of approval. Service credits are',
      'preferred to cash refunds for partial outages, and are applied against the next invoice. Disputed line items',
      'must be raised within the payment term; undisputed amounts remain payable on the original due date.',
    ].join('\n'),
  },
  {
    name: 'auth-design.md',
    content: [
      '# Authentication Design',
      '',
      '## Session tokens',
      'Every session is represented by a short-lived access token and a long-lived refresh token. The access token',
      'expires after fifteen minutes; the refresh token after thirty days of inactivity. Access tokens are validated',
      'locally by signature check, so a revoked refresh token cannot be used to mint a new access token.',
      '',
      '## Rotation and revocation',
      'Refresh tokens rotate on every use: the presented token is invalidated and a replacement issued in the same',
      'response. Presenting an already-rotated token is treated as theft, and the whole token family is revoked',
      'immediately. An operator can revoke a single session or every session for a user from the admin console.',
      '',
      '## Scopes and consent',
      'Authorization uses OAuth 2.0 with PKCE for public clients. Scopes are requested explicitly and granted',
      'per-application, so a calendar integration cannot read mail. Consent is recorded with the granted scopes and',
      'the timestamp, and a user can withdraw consent at any time, which revokes the associated tokens.',
    ].join('\n'),
  },
  {
    name: 'onboarding-runbook.md',
    content: [
      '# New Hire Onboarding Runbook',
      '',
      '## Before the first day',
      'The hiring manager raises a laptop request and a directory account request at least five business days before',
      'the start date. Payroll needs the signed contract and bank details on file before the first payslip runs.',
      '',
      '## First week',
      'Day one is badge collection, laptop handover and a buddy introduction. The new joiner completes security',
      'awareness training and accepts the acceptable use policy. By the end of the first week they should have',
      'joined their team standup and shipped one small change to a non-production environment.',
      '',
      '## Thirty day check-in',
      'The manager holds a structured check-in at thirty days covering tooling access, team rituals and whether the',
      'role matches what was described in the interview. Missing equipment or unfulfilled access requests are',
      'escalated to workplace operations the same day. Probation paperwork is filed by the people team afterwards.',
    ].join('\n'),
  },
  {
    name: 'kubernetes-migration.md',
    content: [
      '# Kubernetes Migration Plan',
      '',
      '## Target cluster topology',
      'Workloads move from virtual machines to a managed cluster with three availability zones. Each zone runs a',
      'pool of worker nodes; the control plane is managed. Stateless services run as deployments with a horizontal',
      'pod autoscaler, stateful services as statefulsets with persistent volume claims pinned to a zone.',
      '',
      '## Ingress and traffic',
      'Ingress is handled by a controller that terminates TLS and routes by host name. Blue-green rollout is used',
      'for customer-facing services: the new version receives ten percent of traffic, and the load balancer shifts',
      'the remainder once error budget and latency thresholds hold for thirty minutes.',
      '',
      '## Rollback and observability',
      'Every deployment keeps the previous replica set so a rollout can be rolled back with a single command.',
      'Container logs stream to the existing log pipeline, and node-level metrics are scraped by the same Prometheus',
      'instance. Alerts fire on pod restart loops, node disk pressure and persistent volume saturation.',
    ].join('\n'),
  },
  {
    name: 'incident-response.md',
    content: [
      '# Security Incident Response',
      '',
      '## Detection and triage',
      'Alerts from the intrusion detection system, unusual credential use and customer reports all open a',
      'triage ticket. The on-call engineer assigns a severity: a confirmed data breach is severity one, a suspected',
      'compromise of a single account is severity three. Severity one pages the incident commander immediately.',
      '',
      '## Containment',
      'Containment is limited to the smallest blast radius that stops the spread: revoke credentials, isolate the',
      'affected host from the network, and preserve a forensic image before rebuilding. Do not power off a host you',
      'intend to analyse, because volatile memory holds evidence the disk copy will not.',
      '',
      '## Notification and postmortem',
      'Regulatory notification deadlines are measured from the moment the breach is confirmed, not from discovery.',
      'Legal counsel drafts the customer notification; communications must not speculate about cause or scope. A',
      'blameless postmortem is scheduled within five business days and its actions are tracked to completion.',
    ].join('\n'),
  },
];

export const KNOWLEDGE_EVAL_CASES: KnowledgeEvalCase[] = [
  // ── Relevant: the right document is unambiguous by vocabulary ──────────────
  { question: 'when are invoices payable and what happens if we pay late?', expectSources: ['billing-policy.md'] },
  { question: 'do you charge value added tax and can we claim an exemption?', expectSources: ['billing-policy.md'] },
  { question: 'how long does the access token last before it expires?', expectSources: ['auth-design.md'] },
  { question: 'what happens if a rotated refresh token is replayed?', expectSources: ['auth-design.md'] },
  { question: 'what equipment and accounts must be ready before the first day?', expectSources: ['onboarding-runbook.md'] },
  { question: 'what is covered in the thirty day probation check-in?', expectSources: ['onboarding-runbook.md'] },
  { question: 'how is ingress traffic shifted during a blue-green rollout?', expectSources: ['kubernetes-migration.md'] },
  { question: 'how do we roll back a failed deployment on the cluster?', expectSources: ['kubernetes-migration.md'] },
  { question: 'what should be preserved before rebuilding an affected host?', expectSources: ['incident-response.md'] },
  { question: 'when does the notification deadline clock start for a breach?', expectSources: ['incident-response.md'] },

  // ── Strict leak probes: nothing in this corpus can answer these, and nothing
  // in it shares their vocabulary either. Returning ANY passage is a leak.
  { question: 'what is the capital of France?', unrelated: true },
  { question: 'give me a recipe for a good pizza dough', unrelated: true },
  { question: 'how tall is Mount Everest in metres?', unrelated: true },
  { question: 'which planet has the most moons?', unrelated: true },

  // ── Adjacent probes: each borrows ONE domain word while asking something the
  // corpus does not cover. Retrieving the adjacent section is defensible rather
  // than a bug — "how much tax do I owe on my salary?" really is closest to the
  // "Currency and tax" section — so these are MEASURED and reported, and what
  // keeps the answer honest is the grounding policy, not the floor.
  { question: 'how much tax do I owe on my salary in Ireland?', adjacent: true },
  { question: 'which laptop should I buy for gaming at home?', adjacent: true },
  { question: 'how do I deploy a static website to a CDN?', adjacent: true },
  { question: 'where can I get my car serviced this weekend?', adjacent: true },
];
