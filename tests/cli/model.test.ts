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

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ModelCommand } from '../../src/cli/model.js';
import { getRouterBandit, resetRouterBandit } from '../../src/learning/router-bandit.js';

// ─── Isolate routing-history writes (explain records decisions) ────────────
// The explain command now records routing decisions to the history store, which
// writes to ~/.buff by default. Redirect it to a temp dir so tests stay hermetic.
const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const tmpMemoryDir = mkdtempSync(join(TMP_BASE, 'buff-model-test-'));
beforeAll(() => {
  process.env.BUFF_MEMORY_DIR = join(tmpMemoryDir, '.buff', 'memory');
  // Seed fake API keys so the router sees MULTIPLE usable providers. Without
  // them (fresh ~/.buff in CI), only 'local' has credentials → the explain
  // decision has a winner but an EMPTY fallback chain, and the JSON assertions
  // below (fallbackChain.length > 0) fail. With a couple of keys set, the
  // router ranks groq/gemini/local and the fallback chain is non-empty.
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
});

afterAll(() => {
  delete process.env.BUFF_MEMORY_DIR;
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  rmSync(tmpMemoryDir, { recursive: true, force: true });
});

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
    // M2.1: the capability-fit chip renders on the default (gate-ON) path.
    expect(output).toContain('fit');
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
      // M2.1: capability-fit is surfaced per ranked provider on the default
      // path (gate-OFF leaves it undefined — omitted from JSON, locked at the
      // resolve level in auto-router.test.ts).
      expect(typeof r.capabilityFit).toBe('number');
      // M2.2: cost source is always flagged (measured | estimated); basis only
      // when measured wire tokens exist.
      expect(['measured', 'estimated']).toContain(r.costSource);
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

  it('surfaces governance-eliminated providers in JSON (M2.4)', () => {
    const cmd = new ModelCommand();
    (cmd as any).configManager = {
      getAll: vi.fn(() => ({
        pricing: {},
        routing: { governance: { denyProviders: ['openrouter'] } },
      })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn(() => ({ config: {} })),
    };
    cmd.create().parse(['explain', 'implement a login form', '--json'], { from: 'user' });
    const output = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');
    const parsed = JSON.parse(output) as Record<string, any>;

    // openrouter was eliminated by the admin deny-list and the audit trail shows why.
    expect(parsed.ranked.some((r: { provider: string }) => r.provider === 'openrouter')).toBe(false);
    expect(parsed.governanceBlocked).toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: 'openrouter', reason: expect.stringContaining('denyProviders') })]),
    );
  });

  it('renders the governance-eliminated section in human output (M2.4)', () => {
    const cmd = new ModelCommand();
    (cmd as any).configManager = {
      getAll: vi.fn(() => ({
        pricing: {},
        routing: { governance: { denyProviders: ['openrouter'] } },
      })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn(() => ({ config: {} })),
    };
    cmd.create().parse(['explain', 'implement a login form'], { from: 'user' });
    const output = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');

    expect(output).toContain('Governance policy');
    expect(output).toContain('openrouter');
    expect(output).toContain('denyProviders');
  });

  it('JSON explain emits a policy error object (not a crash) when governance eliminates every provider (M2.4 hard gate)', () => {
    const cmd = new ModelCommand();
    (cmd as any).configManager = {
      getAll: vi.fn(() => ({
        pricing: {},
        routing: { governance: { allowProviders: ['nonexistent-provider'] } },
      })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn(() => ({ config: {} })),
    };
    cmd.create().parse(['explain', 'implement a login form', '--json'], { from: 'user' });
    const output = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');
    const parsed = JSON.parse(output) as Record<string, any>;

    // The router refused to serve a policy violator; explain surfaces the
    // block as a machine-readable error (never a raw stack trace).
    expect(parsed.error).toContain('Governance');
    expect(parsed.governanceBlocked.length).toBeGreaterThan(0);
  });

  it('surfaces the M2.5 context preflight in JSON (default gate ON)', () => {
    const output = runCommand(['explain', 'implement a login form', '--json']);
    const parsed = JSON.parse(output) as Record<string, any>;

    expect(parsed.context).toBeDefined();
    expect(parsed.context.estimatedPromptTokens).toBeGreaterThan(0);
    expect(parsed.context.basis).toBe('task');
    expect(parsed.context.providers.length).toBeGreaterThan(0);
    for (const p of parsed.context.providers) {
      expect(p.contextWindowTokens).toBeGreaterThan(0);
      expect(typeof p.utilization).toBe('number');
      expect(typeof p.fit).toBe('number');
    }
  });

  it('renders the M2.5 context preflight section in human output', () => {
    const output = runCommand(['explain', 'implement a login form']);
    expect(output).toContain('Context preflight');
    expect(output).toContain('Estimated prompt');
    expect(output).toContain('utilization');
  });

  it('renders the v1.58.0 chips (🎯 fit / 📏·📐 cost / ⏳ ctx) on ranked rows (M2.1 + M2.2 + M2.5)', () => {
    const output = runCommand(['explain', 'implement a login form']);
    // M2.1: capability-fit chip on ranked rows (gate ON by default).
    expect(output).toContain('🎯 fit');
    // M2.2: cost source is flagged on every ranked row — measured or estimated.
    // (Hermetic env has no measured wire usage yet → estimated is guaranteed,
    // measured appears once the registry holds real token EMAs.)
    expect(output).toMatch(/📏 measured|📐 estimated/);
    // M2.5: context-utilization chip with the nominal window on ranked rows.
    expect(output).toMatch(/⏳ ctx \d+%/);
  });

  it('chips follow the gates: capabilityFit OFF drops 🎯, contextFit OFF drops ⏳', () => {
    const cmd = new ModelCommand();
    (cmd as any).configManager = {
      getAll: vi.fn(() => ({
        pricing: {},
        routing: { capabilityFit: false, contextFit: false },
      })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn(() => ({ config: {} })),
    };
    cmd.create().parse(['explain', 'implement a login form'], { from: 'user' });
    const output = vi.mocked(console.log).mock.calls.map((c) => c.map((v) => String(v)).join(' ')).join('\n');

    expect(output).not.toContain('🎯 fit');
    expect(output).not.toContain('⏳ ctx');
    // Cost source stays on ranked rows even with both gates off.
    expect(output).toMatch(/📏 measured|📐 estimated/);
  });

  it('gate OFF (routing.contextFit: false) omits the context preflight entirely', () => {
    const cmd = new ModelCommand();
    (cmd as any).configManager = {
      getAll: vi.fn(() => ({
        pricing: {},
        routing: { contextFit: false },
      })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn(() => ({ config: {} })),
    };
    cmd.create().parse(['explain', 'implement a login form', '--json'], { from: 'user' });
    const output = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');
    const parsed = JSON.parse(output) as Record<string, any>;

    expect(parsed.context).toBeUndefined();
  });

  it('human explain renders the audit trail when governance eliminates every provider (M2.4 hard gate)', () => {
    const cmd = new ModelCommand();
    (cmd as any).configManager = {
      getAll: vi.fn(() => ({
        pricing: {},
        routing: { governance: { allowProviders: ['nonexistent-provider'] } },
      })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn(() => ({ config: {} })),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cmd.create().parse(['explain', 'implement a login form'], { from: 'user' });
    const errOut = errorSpy.mock.calls.map((c) => c.map((v) => String(v)).join(' ')).join('\n');
    const out = vi.mocked(console.log).mock.calls.map((c) => c.map((v) => String(v)).join(' ')).join('\n');
    errorSpy.mockRestore();

    expect(errOut).toContain('Governance policy');
    expect(out).toContain('allowProviders');
  });
});

// ─── ModelCommand bandit ────────────────────────────────────────────────────

describe('ModelCommand bandit', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Fresh singleton per test so state never leaks between assertions
    resetRouterBandit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRouterBandit();
  });

  it('JSON mode reports empty state when no learning data exists', () => {
    const output = runCommand(['bandit', '--json']);
    const parsed = JSON.parse(output) as Record<string, any>;
    // v2 = per-modelId modelPriors (ruflo ADR-149 mirror)
    expect(parsed.version).toBe(2);
    // `enabled` reflects the user's routing.bandit config — just verify the field exists
    expect(typeof parsed.enabled).toBe('boolean');
    expect(parsed.priors).toEqual({});
    expect(Array.isArray(parsed.learningHistory)).toBe(true);
  });

  it('reset clears the persisted bandit state', () => {
    getRouterBandit().recordOutcome('groq', 'implement a login form', 'success', 1.0);
    getRouterBandit().recordOutcome('gemini', 'implement a login form', 'failure');

    runCommand(['bandit', 'reset']);
    // The runCommand helper accumulates ALL console.log calls since the test started,
    // so clear the reset command's success message before capturing the JSON output.
    vi.mocked(console.log).mockClear();

    const output = runCommand(['bandit', '--json']);
    const parsed = JSON.parse(output) as Record<string, any>;
    expect(parsed.priors).toEqual({});
    expect(parsed.learningHistory).toEqual([]);
  });

  it('renders the human table with provider rows', () => {
    getRouterBandit().recordOutcome('groq', 'implement a login form', 'success', 1.0);

    const output = runCommand(['bandit']);
    expect(output).toContain('groq');
    expect(output).toContain('Bandit');
  });

  it('rejects unknown actions with a helpful error', () => {
    // logger.error writes to console.error, not console.log — capture both
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runCommand(['bandit', 'nonsense']);
    const errOut = errorSpy.mock.calls.map((c) => c.map((v) => String(v)).join(' ')).join('\n');
    expect(errOut).toContain('Unknown bandit action');
    errorSpy.mockRestore();
  });
});
