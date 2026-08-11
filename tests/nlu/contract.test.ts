/**
 * Session 20 — RequestContract layer tests.
 *
 * Coverage:
 * - Rule path: contract shape, target/scope from deterministic entities,
 *   action-derived acceptance criteria, risk flags, constraints.
 * - LLM enrichment: below-threshold requests enrich via the SAME C2 verify
 *   call (no extra model call); confident requests never call the model.
 * - renderContractCard: the 🧠 Understood card contents.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRequestContract,
  buildRequestContractSync,
  renderContractCard,
} from '../../src/nlu/contract.js';
import type { LLMCallFn } from '../../src/agents/agent.js';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildRequestContractSync (rule path — zero cost)', () => {
  it('resolves a create request into a structured contract', () => {
    const c = buildRequestContractSync(
      'create a JWT auth middleware in src/auth/middleware.ts using express',
    );

    expect(c.intent).toBe('create');
    expect(c.action).toBe('build');
    expect(c.actionLabel).toBe('create');
    expect(c.mode).toBe('dev');
    expect(c.confidence).toBeGreaterThanOrEqual(0.8);
    expect(c.target).toContain('src/auth/middleware.ts');
    expect(c.scope).toContain('jwt');
    expect(c.scope).toContain('express');
    // Action-derived acceptance criteria — the contract always carries them.
    expect(c.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(c.acceptanceCriteria.join(' ')).toMatch(/created as described/i);
  });

  it('derives fix criteria and risk flags for a repair request', () => {
    const c = buildRequestContractSync(
      'fix the login bug, delete the old utils file and commit the fix',
    );

    expect(c.intent).toBe('fix');
    expect(c.action).toBe('repair');
    expect(c.actionLabel).toBe('fix');
    expect(c.acceptanceCriteria.join(' ')).toMatch(/problem is resolved/i);
    // Destructive + git-history risk flags from the keyword scan.
    expect(c.riskFlags).toContain('deletes or removes files');
    expect(c.riskFlags).toContain('writes to git history or publishes');
  });

  it('extracts explicit guardrail constraints from the text', () => {
    const c = buildRequestContractSync(
      "fix the parser but don't touch the tests or the docs",
    );

    expect(c.constraints.length).toBeGreaterThan(0);
    expect(c.constraints.some((x) => /do not touch the tests/i.test(x))).toBe(true);
  });

  it('flags credential-sensitive requests', () => {
    const c = buildRequestContractSync(
      'add an API key vault integration storing the secret in the keyring',
    );

    expect(c.riskFlags).toContain('touches credentials or secrets');
  });

  it('unknown intents carry no criteria and fall to chat mode', () => {
    const c = buildRequestContractSync('maybe something like whatever');

    expect(c.intent).toBe('unknown');
    expect(c.acceptanceCriteria).toEqual([]);
  });
});

describe('buildRequestContract (LLM enrichment — below threshold only)', () => {
  it('enriches a below-threshold request using the shared C2 verify call', async () => {
    const callLLM: LLMCallFn = vi.fn().mockResolvedValue(JSON.stringify({
      intent: 'create',
      confidence: 0.9,
      entities: {
        files: ['src/widget.tsx'],
        frameworks: ['react'],
        keywords: ['dashboard'],
      },
      memoryHint: 'which dashboard components matter',
    }));

    // 'random gibberish 42' matches no rule → confidence 0 (< 0.8) → the C2
    // verify runs ONCE and the contract enriches from its result.
    const c = await buildRequestContract('random gibberish 42', { callLLM });

    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(c.source).toBe('llm');
    expect(c.intent).toBe('create');
    expect(c.confidence).toBe(0.9);
    expect(c.target).toContain('src/widget.tsx');
    expect(c.scope).toContain('react');
  });

  it('never calls the model for a confident request (zero-cost parity)', async () => {
    const callLLM: LLMCallFn = vi.fn(async () => {
      throw new Error('should not be called');
    });

    const c = await buildRequestContract('build a new CLI tool', { callLLM });

    expect(callLLM).not.toHaveBeenCalled();
    expect(c.source).toBe('rule');
    expect(c.action).toBe('build');
  });

  it('falls back to the rule contract when the LLM verify fails', async () => {
    const callLLM: LLMCallFn = vi.fn(async () => {
      throw new Error('provider down');
    });

    const c = await buildRequestContract('some completely ambiguous vague thing', { callLLM });

    expect(c.source).toBe('rule-fallback');
    expect(c.goal).toBe('some completely ambiguous vague thing');
  });
});

describe('renderContractCard', () => {
  it('renders the 🧠 Understood headline with action, confidence and criteria', async () => {
    const c = await buildRequestContract(
      'create a JWT auth middleware in src/auth/middleware.ts',
    );
    const card = renderContractCard(c);

    expect(card).toContain('🧠 Understood');
    expect(card).toContain('create');
    expect(card).toContain('src/auth/middleware.ts');
    expect(card).toContain('criteria');
    expect(card).toContain('risks:   none');
  });

  it('surfaces risk flags on the card', () => {
    const card = renderContractCard(
      buildRequestContractSync('delete the old config and overwrite .env.example'),
    );
    expect(card).toContain('deletes or removes files');
    expect(card).toContain('overwrites existing files');
  });

  it('honors a footer override (e.g. plan shows a plan-only contract)', () => {
    const card = renderContractCard(buildRequestContractSync('create a CLI tool'), {
      footer: '→ Generating an implementation plan — no files are changed until you execute it.',
    });
    expect(card).toContain('no files are changed until you execute it');
    // The override REPLACES the default pipeline claim entirely.
    expect(card).not.toContain('checkpoints keep it resumable');
  });

  it('drops the resumability claim when checkpointing is not enabled', () => {
    const contract = buildRequestContractSync('create a CLI tool');
    // resumable: false → the card must not overpromise resumability.
    expect(renderContractCard(contract, { resumable: false }))
      .not.toContain('checkpoints keep it resumable');
    // default (and resumable: true) → the claim stays.
    expect(renderContractCard(contract, { resumable: true }))
      .toContain('checkpoints keep it resumable');
  });
});

describe('cross-command parity — the 🧠 card before every entry surface', () => {
  const executeSrc = readFileSync(join(process.cwd(), 'src/cli/execute.ts'), 'utf-8');
  const planSrc = readFileSync(join(process.cwd(), 'src/cli/plan.ts'), 'utf-8');
  const editSrc = readFileSync(join(process.cwd(), 'src/cli/edit.ts'), 'utf-8');
  const pipelineToolSrc = readFileSync(join(process.cwd(), 'src/tools/pipeline-tool.ts'), 'utf-8');

  it('execute builds the contract from its own parse and shows the card BEFORE the board', () => {
    // Zero-reparse: the contract reuses the parse already made for dispatch.
    expect(executeSrc).toContain('const contract = contractFromParsed(goal, parsedGoal);');
    // The card prints before the live board takes over the screen.
    const cardPrint = executeSrc.indexOf('renderContractCard(contract');
    const boardStart = executeSrc.indexOf('board.start(goal)');
    expect(cardPrint).toBeGreaterThan(-1);
    expect(boardStart).toBeGreaterThan(cardPrint);
  });

  it('execute passes the contract criteria to the orchestrator (spec→verify) and keeps NDJSON pure', () => {
    expect(executeSrc).toContain('acceptanceCriteria: contract.acceptanceCriteria,');
    // --json-events consumers must not get the human card mixed into stdout.
    expect(executeSrc).toContain('if (!options.jsonEvents)');
  });

  it('plan shows the card before the board with a plan-only footer and a single parse', () => {
    // Card before the plan board.
    const cardPrint = planSrc.indexOf('renderContractCard(contract');
    const boardStart = planSrc.indexOf('board.start(`Plan: ${task}`)');
    expect(cardPrint).toBeGreaterThan(-1);
    expect(boardStart).toBeGreaterThan(cardPrint);
    // Plan never modifies files — the footer states the plan-only contract.
    expect(planSrc).toContain('no files are changed until you execute it');
    // Zero-reparse: ONE hoisted parse feeds both the card and the D1 recall check.
    const hoisted = planSrc.indexOf('const parsedTask = parseRequestSync(task);');
    expect(hoisted).toBeGreaterThan(-1);
    expect(planSrc.indexOf('const parsedTask = parseRequestSync(task);', hoisted + 1)).toBe(-1);
    expect(planSrc.indexOf("parsedTask.intent === 'continue'")).toBeGreaterThan(hoisted);
  });

  it('edit shows the card before routing, with a direct-edit footer (Session 22)', () => {
    // Card built from the instruction and printed before any provider call.
    const cardPrint = editSrc.indexOf('renderContractCard(contract');
    const autoRouteGate = editSrc.indexOf('options?.autoRoute || isAutoProvider');
    expect(cardPrint).toBeGreaterThan(-1);
    expect(autoRouteGate).toBeGreaterThan(cardPrint);
    // Edit is a direct file edit — no pipeline claim in the footer.
    expect(editSrc).toContain('→ Editing the file directly — no pipeline run.');
  });

  it('chat pipeline runs (pipeline-tool) also show the card and pass criteria (Session 20)', () => {
    expect(pipelineToolSrc).toContain('const contract = contractFromParsed(goal, parsed);');
    expect(pipelineToolSrc).toContain('renderContractCard(contract)');
    expect(pipelineToolSrc).toContain('acceptanceCriteria: contract.acceptanceCriteria,');
  });
});
