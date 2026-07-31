/**
 * ModelCommand — Unit tests for the `buff model explain` subcommand.
 *
 * The command is largely render-only (console output). These tests drive the
 * real Commander command with mocked console output and verify the decision
 * logic surfaces correctly:
 * 1. Detailed rendering for a single task (weights, ranked providers, winner, fallback)
 * 2. Sample walk across all 5 complexity levels when no task is given
 * 3. JSON output for a single task (scripting/CI)
 * 4. JSON output for the 5 sample complexities without a task
 * 5. --agent routing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelCommand } from '../../src/cli/model.js';

/** Run a command and capture everything written to stdout via console.log. */
function runCommand(args: string[]): string {
  const cmd = new ModelCommand().create();
  cmd.parse(args, { from: 'user' });
  return vi.mocked(console.log).mock.calls
    .map((c) => c.map((v) => String(v)).join(' '))
    .join('\n');
}

describe('ModelCommand explain', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a detailed decision for a given task', () => {
    const output = runCommand(['explain', 'implement a login form']);

    expect(output).toContain('Complexity:');
    expect(output).toContain('Dimension weights');
    expect(output).toContain('Ranked providers');
    expect(output).toContain('Decision:');
    expect(output).toContain('Fallback chain');
  });

  it('walks all five complexity levels when no task is given', () => {
    const output = runCommand(['explain']);

    for (const label of ['🟢 trivial', '🔵 simple', '🟡 moderate', '🟠 complex', '🔴 critical']) {
      expect(output).toContain(label);
    }
    // Compact decisions still name a winner provider/model
    expect(output).toContain('→');
  });

  it('outputs JSON with routing details when --json is passed', () => {
    const output = runCommand(['explain', 'implement a login form', '--json']);
    const parsed = JSON.parse(output) as Record<string, any>;

    expect(parsed.task).toBe('implement a login form');
    expect(parsed.agentType).toBe('chat');
    expect(parsed.complexity).toBeTruthy();
    expect(parsed.taskType).toBeTruthy();
    expect(parsed.weights).toBeTruthy();
    expect(parsed.winner.provider).toBeTruthy();
    expect(parsed.winner.model).toBeTruthy();
    expect(typeof parsed.winner.score).toBe('number');
    expect(parsed.ranked.length).toBeGreaterThan(0);
    expect(parsed.fallbackChain.length).toBeGreaterThan(0);
    expect(parsed.explanation.length).toBeGreaterThan(10);

    // Pricing map covers every ranked provider with override flags
    for (const r of parsed.ranked) {
      expect(parsed.pricing[r.provider]).toBeDefined();
      expect(typeof parsed.pricing[r.provider].inputPer1K).toBe('number');
      expect(typeof parsed.pricing[r.provider].outputPer1K).toBe('number');
      expect(typeof parsed.pricing[r.provider].overridden).toBe('boolean');
    }
  });

  it('JSON mode returns an array of sample decisions without a task', () => {
    const output = runCommand(['explain', '--json']);
    const parsed = JSON.parse(output) as Record<string, any>;

    expect(parsed.agentType).toBe('chat');
    expect(parsed.decisions).toHaveLength(5);
    expect(parsed.decisions[0].complexity).toBe('trivial');
    expect(parsed.decisions[4].complexity).toBe('critical');
    for (const d of parsed.decisions) {
      expect(d.winner.provider).toBeTruthy();
    }
  });

  it('routes for a specific agent type with --agent', () => {
    const output = runCommand(['explain', 'implement a login form', '--json', '--agent', 'writer']);
    const parsed = JSON.parse(output) as Record<string, any>;

    expect(parsed.agentType).toBe('writer');
  });

  it('keeps ranked providers sorted best-first in JSON', () => {
    const output = runCommand(['explain', 'deploy to production', '--json']);
    const parsed = JSON.parse(output) as Record<string, any>;

    const scores = parsed.ranked.map((r: { score: number }) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });
});
