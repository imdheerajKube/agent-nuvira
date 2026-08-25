/**
 * H2 — Sub-agent delegation tests (`src/agents/tools/delegation.ts`).
 *
 * Covers the agent-delegation layer:
 * single spawn, parallel fan-out with aggregation, delegation:spawn/result/error
 * event emission, budget guard (max sub-agents per turn), timeout kill, and
 * AbortSignal kill-switch. All tests are hermetic — a fake agent registered in
 * a fresh ModuleRegistry, never a real LLM or the global event bus.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent, type AgentContext, type AgentResult, type TaskStep } from '../../../src/agents/agent.js';
import { ModuleRegistry } from '../../../src/agents/module-registry.js';
import { spawnSubagent, spawnSubagents, type SubagentRequest } from '../../../src/agents/tools/delegation.js';
import { DelegateAgent } from '../../../src/agents/agents/delegate-agent.js';
import { EventNames } from '../../../src/observability/event-bus.js';
import { getTool } from '../../../src/tools/registry.js';

// ─── Fake agents ─────────────────────────────────────────────────────────────

/** A sub-agent that succeeds after reading its context goal. */
class FakeWorkerAgent extends Agent {
  readonly name = 'FakeWorker';
  readonly description = 'Fake sub-agent that succeeds';
  readonly results: AgentResult;

  constructor(result: AgentResult = { success: true, summary: 'fake worker done' }) {
    super();
    this.results = result;
  }

  async execute(context: AgentContext, _callLLM: (p: string) => Promise<string>): Promise<AgentResult> {
    context.onAgentUpdate?.({
      agentType: this.name,
      stage: 'working',
      message: `working on: ${context.goal.slice(0, 40)}`,
    });
    if (context.goal.includes('DELAY')) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return this.results;
  }
}

/** A sub-agent that throws — the delegation:error path. */
class ThrowingAgent extends Agent {
  readonly name = 'Throwing';
  readonly description = 'Fake sub-agent that throws';

  async execute(): Promise<AgentResult> {
    throw new Error('exploded');
  }
}

/** A sub-agent that never resolves — for timeout tests. */
class HangingAgent extends Agent {
  readonly name = 'Hanging';
  readonly description = 'Fake sub-agent that never resolves';

  async execute(): Promise<AgentResult> {
    await new Promise(() => {
      /* never resolves */
    });
    return { success: true, summary: 'unreachable' };
  }
}

function makeRegistry(): { registry: ModuleRegistry; cleanup: () => void } {
  const registry = new ModuleRegistry();
  registry.register('fake-worker', () => new FakeWorkerAgent(), {
    name: 'FakeWorker',
    description: 'Fake sub-agent',
    icon: '🤖',
  });
  registry.register('fake-fail', () => new FakeWorkerAgent({ success: false, summary: 'fake failure', error: 'boom' }), {
    name: 'FakeFail',
    description: 'Fake failing sub-agent',
    icon: '💥',
  });
  registry.register('throwing', () => new ThrowingAgent(), {
    name: 'Throwing',
    description: 'Throws on execute',
    icon: '💥',
  });
  registry.register('hanging', () => new HangingAgent(), {
    name: 'Hanging',
    description: 'Never resolves',
    icon: '⏳',
  });
  return { registry, cleanup: () => undefined };
}

/** Collect emitted events like a test EventBus subscription would. */
function makeEmitRecorder() {
  const events: Array<{ event: string; data: any }> = [];
  const emit = (event: string, data: unknown): void => {
    events.push({ event, data });
  };
  return { events, emit };
}

const callLLM = vi.fn(async (p: string) => `llm(${p.slice(0, 20)})`);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('delegation — single sub-agent spawn', () => {
  it('runs the agent and emits delegation:spawn then delegation:result', async () => {
    const { registry } = makeRegistry();
    const { events, emit } = makeEmitRecorder();

    const result = await spawnSubagent(
      { agentType: 'fake-worker', prompt: 'gather context about the API layer' },
      { registry, callLLM, emit },
    );

    expect(result.success).toBe(true);
    expect(result.summary).toBe('fake worker done');
    expect(result.agentType).toBe('fake-worker');
    expect(typeof result.durationMs).toBe('number');

    // The first delegation event is the spawn; the last is the result. The
    // child's thinking updates (orchestrator:agent-update) may interleave.
    const delegationEvents = events.filter((e) => e.event.startsWith('delegation:'));
    expect(delegationEvents.map((e) => e.event)).toEqual([
      EventNames.DELEGATION_SPAWN,
      EventNames.DELEGATION_RESULT,
    ]);
    expect(events[0].data).toMatchObject({ agentType: 'fake-worker' });
    expect(events[0].data.id).toBeTruthy();
    const resultEvent = delegationEvents[1];
    expect(resultEvent.data).toMatchObject({ success: true, summary: 'fake worker done' });
    expect(resultEvent.data.id).toBe(events[0].data.id);
  });

  it('streams the sub-agent thinking updates to the bus', async () => {
    const { registry } = makeRegistry();
    const { events, emit } = makeEmitRecorder();

    await spawnSubagent(
      { agentType: 'fake-worker', prompt: 'review the auth module' },
      { registry, callLLM, emit },
    );

    const updates = events.filter((e) => e.event === EventNames.ORCHESTRATOR_AGENT_UPDATE);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0].data.message).toContain('working on:');
  });

  it('resolves to a failed result via delegation:result when the agent returns success:false', async () => {
    // An agent that RAN but reported failure is a normal result, not an error.
    const { registry } = makeRegistry();
    const { events, emit } = makeEmitRecorder();

    const result = await spawnSubagent(
      { agentType: 'fake-fail', prompt: 'do the thing' },
      { registry, callLLM, emit },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    const delegationEvents = events.filter((e) => e.event.startsWith('delegation:'));
    expect(delegationEvents.map((e) => e.event)).toEqual([
      EventNames.DELEGATION_SPAWN,
      EventNames.DELEGATION_RESULT,
    ]);
    expect(delegationEvents[1].data.success).toBe(false);
  });

  it('emits delegation:error when the agent throws', async () => {
    const { registry } = makeRegistry();
    const { events, emit } = makeEmitRecorder();

    const result = await spawnSubagent(
      { agentType: 'throwing', prompt: 'do the thing' },
      { registry, callLLM, emit },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('exploded');
    const delegationEvents = events.filter((e) => e.event.startsWith('delegation:'));
    expect(delegationEvents.map((e) => e.event)).toEqual([
      EventNames.DELEGATION_SPAWN,
      EventNames.DELEGATION_ERROR,
    ]);
  });

  it('resolves to an error result (never throws) for an unknown agent type', async () => {
    const { registry } = makeRegistry();
    const { events, emit } = makeEmitRecorder();

    const result = await spawnSubagent(
      { agentType: 'no-such-agent', prompt: 'x' },
      { registry, callLLM, emit },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no-such-agent');
    expect(events[events.length - 1].event).toBe(EventNames.DELEGATION_ERROR);
  });
});

describe('delegation — parallel fan-out', () => {
  it('spawns N sub-agents in parallel and aggregates summary results', async () => {
    const { registry } = makeRegistry();
    const { events, emit } = makeEmitRecorder();

    const requests: SubagentRequest[] = [
      { agentType: 'fake-worker', prompt: 'task one' },
      { agentType: 'fake-worker', prompt: 'task two' },
      { agentType: 'fake-worker', prompt: 'task three' },
    ];

    const results = await spawnSubagents(requests, { registry, callLLM, emit });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    // Each sub-agent gets its own lane id.
    const spawnIds = events.filter((e) => e.event === EventNames.DELEGATION_SPAWN).map((e) => e.data.id);
    expect(new Set(spawnIds).size).toBe(3);
    expect(events.filter((e) => e.event === EventNames.DELEGATION_RESULT)).toHaveLength(3);
  });

  it('enforces the maxSubagents budget guard — extra requests resolve as skipped', async () => {
    const { registry } = makeRegistry();
    const { events, emit } = makeEmitRecorder();

    const requests: SubagentRequest[] = Array.from({ length: 5 }, (_, i) => ({
      agentType: 'fake-worker',
      prompt: `task ${i}`,
    }));

    const results = await spawnSubagents(requests, { registry, callLLM, emit, maxSubagents: 2 });

    expect(results).toHaveLength(5);
    const ran = results.filter((r) => !r.skipped);
    const skipped = results.filter((r) => r.skipped);
    expect(ran).toHaveLength(2);
    expect(skipped).toHaveLength(3);
    expect(skipped.every((r) => r.summary.includes('budget'))).toBe(true);
    // Only 2 spawn events fired — the skipped ones never touched the bus.
    expect(events.filter((e) => e.event === EventNames.DELEGATION_SPAWN)).toHaveLength(2);
  });
});

describe('delegation — timeout + kill guards', () => {
  it('kills a hanging sub-agent via the per-sub-agent timeout', async () => {
    const { registry } = makeRegistry();
    const { events, emit } = makeEmitRecorder();

    const result = await spawnSubagent(
      { agentType: 'hanging', prompt: 'never finish' },
      { registry, callLLM, emit, timeoutMs: 50 },
    );

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.summary).toBe('Timed out');
    const errorEvent = events[events.length - 1];
    expect(errorEvent.event).toBe(EventNames.DELEGATION_ERROR);
    expect(errorEvent.data.timedOut).toBe(true);
  });

  it('kills in-flight sub-agents when the AbortSignal fires', async () => {
    const { registry } = makeRegistry();
    const { events, emit } = makeEmitRecorder();
    const controller = new AbortController();

    const resultPromise = spawnSubagent(
      { agentType: 'hanging', prompt: 'never finish' },
      { registry, callLLM, emit, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.killed).toBe(true);
    const errorEvent = events[events.length - 1];
    expect(errorEvent.event).toBe(EventNames.DELEGATION_ERROR);
    expect(errorEvent.data.killed).toBe(true);
  });

  it('resolves immediately as killed when the signal is already aborted', async () => {
    const { registry } = makeRegistry();
    const { events, emit } = makeEmitRecorder();
    const controller = new AbortController();
    controller.abort();

    const result = await spawnSubagent(
      { agentType: 'fake-worker', prompt: 'x' },
      { registry, callLLM, emit, signal: controller.signal },
    );

    expect(result.success).toBe(false);
    expect(result.killed).toBe(true);
    // No spawn event — the sub-agent never started.
    expect(events).toHaveLength(0);
  });
});

describe('delegation — context isolation + files', () => {
  it('gives the sub-agent a FRESH isolated context (empty plan, no shared state)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delegation-test-'));
    const filePath = join(dir, 'sample.ts');
    writeFileSync(filePath, 'export const x = 1;', 'utf-8');

    // The sub-agent captures the context it was given so the test can assert
    // the isolation contract directly.
    let captured: AgentContext | undefined;
    const registry = new ModuleRegistry();
    registry.register(
      'context-probe',
      () =>
        new (class extends Agent {
          readonly name = 'ContextProbe';
          readonly description = 'captures its context';
          async execute(context: AgentContext): Promise<AgentResult> {
            captured = context;
            return { success: true, summary: 'captured' };
          }
        })(),
      { name: 'ContextProbe', description: 'captures context', icon: '🔍' },
    );

    const result = await spawnSubagent(
      { agentType: 'context-probe', prompt: 'read the file', files: ['sample.ts'] },
      { registry, callLLM, cwd: dir },
    );

    expect(result.success).toBe(true);
    // Isolation contract: goal = prompt, EMPTY plan/state, one artifact from
    // the delegated file — nothing shared from any parent vault.
    expect(captured!.goal).toBe('read the file');
    expect(captured!.taskPlan).toEqual([]);
    expect(captured!.fileChanges).toEqual([]);
    expect(captured!.conversations).toEqual([]);
    expect(captured!.artifacts).toHaveLength(1);
    expect(captured!.artifacts[0].content).toBe('export const x = 1;');
    rmSync(dir, { recursive: true, force: true });
  });

  it('caps oversized delegated files so they cannot blow the sub-agent context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delegation-test-'));
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(50_000), 'utf-8');

    let seenContent = '';
    let seenDescription = '';
    const registry = new ModuleRegistry();
    registry.register(
      'big-reader',
      () =>
        new (class extends Agent {
          readonly name = 'BigReader';
          readonly description = 'reads big files';
          async execute(context: AgentContext): Promise<AgentResult> {
            seenContent = context.artifacts[0]?.content || '';
            seenDescription = context.artifacts[0]?.description || '';
            return { success: true, summary: 'read' };
          }
        })(),
      { name: 'BigReader', description: 'reads big files', icon: '📄' },
    );

    await spawnSubagent(
      { agentType: 'big-reader', prompt: 'read big.txt', files: ['big.txt'] },
      { registry, callLLM, cwd: dir },
    );

    expect(seenDescription).toContain('truncated');
    expect(seenContent.length).toBeLessThan(20_000);
    expect(seenContent).toContain('omitted');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads delegated files into the sub-agent artifacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delegation-test-'));
    writeFileSync(join(dir, 'data.txt'), 'hello world', 'utf-8');

    let seenArtifacts: string[] = [];
    const registry = new ModuleRegistry();
    registry.register(
      'file-reader',
      () =>
        new (class extends Agent {
          readonly name = 'FileReader';
          readonly description = 'reads files';
          async execute(context: AgentContext): Promise<AgentResult> {
            seenArtifacts = context.artifacts.map((a) => a.content);
            return { success: true, summary: `read ${seenArtifacts.length} file(s)` };
          }
        })(),
      { name: 'FileReader', description: 'reads files', icon: '📄' },
    );

    const result = await spawnSubagent(
      { agentType: 'file-reader', prompt: 'read data.txt', files: ['data.txt'] },
      { registry, callLLM, cwd: dir },
    );

    expect(result.success).toBe(true);
    expect(seenArtifacts).toEqual(['hello world']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('delegation — registry integration', () => {
  it('registers the delegate tool so `nuvira tools list` shows delegation', () => {
    const tool = getTool('delegate');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('workflow');
    expect(tool!.endsAgentStep).toBe(false);
    expect(tool!.description.toLowerCase()).toContain('sub-agent');
  });
});

describe('delegation — DelegateAgent (plan step can delegate)', () => {
  /** Build a delegate agent context whose current task carries delegation specs. */
  function makeDelegateContext(
    delegation: TaskStep['delegation'],
    opts: { registry: ModuleRegistry },
  ): AgentContext {
    const step: TaskStep = {
      id: 'step-delegate',
      description: 'Run independent checks in parallel',
      agentType: 'delegate',
      dependsOn: [],
      status: 'running',
      delegation,
    };
    return {
      goal: 'triple-check the module',
      workingDirectory: process.cwd(),
      taskPlan: [step],
      artifacts: [],
      conversations: [],
      fileChanges: [],
      metadata: {},
    };
  }

  /** A DelegateAgent wired the way the orchestrator wires it (instance fields). */
  function makeDelegateAgent(opts: { registry: ModuleRegistry }): DelegateAgent {
    const agent = new DelegateAgent();
    // Race-free path: the per-INSTANCE currentTaskId + delegationRegistry
    // (the shared vault metadata would be overwritten by concurrent tasks).
    agent.currentTaskId = 'step-delegate';
    agent.delegationRegistry = opts.registry;
    return agent;
  }

  it('fans out the delegation specs in parallel and aggregates a success summary', async () => {
    const { registry } = makeRegistry();
    const agent = makeDelegateAgent({ registry });

    const result = await agent.execute(
      makeDelegateContext(
        [
          { agentType: 'fake-worker', prompt: 'check one' },
          { agentType: 'fake-worker', prompt: 'check two' },
          { agentType: 'fake-worker', prompt: 'check three' },
        ],
        { registry },
      ),
      callLLM,
    );

    expect(result.success).toBe(true);
    expect(result.summary).toContain('3/3');
    expect(result.details).toContain('fake-worker');
  });

  it('reports soft-success when SOME sub-agents fail, listing the failures', async () => {
    const { registry } = makeRegistry();
    const agent = makeDelegateAgent({ registry });

    const result = await agent.execute(
      makeDelegateContext(
        [
          { agentType: 'fake-worker', prompt: 'ok task' },
          { agentType: 'fake-fail', prompt: 'failing task' },
        ],
        { registry },
      ),
      callLLM,
    );

    expect(result.success).toBe(true); // soft-success: 1/2 delivered
    expect(result.summary).toContain('1/2');
    expect(result.error).toContain('1 delegated sub-agent(s) failed');
  });

  it('fails when every sub-agent fails', async () => {
    const { registry } = makeRegistry();
    const agent = makeDelegateAgent({ registry });

    const result = await agent.execute(
      makeDelegateContext(
        [
          { agentType: 'fake-fail', prompt: 'a' },
          { agentType: 'fake-fail', prompt: 'b' },
        ],
        { registry },
      ),
      callLLM,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('All delegated sub-agents failed');
  });

  it('fails loudly when the step has no delegation specs', async () => {
    const { registry } = makeRegistry();
    const agent = makeDelegateAgent({ registry });

    const result = await agent.execute(makeDelegateContext(undefined, { registry }), callLLM);

    expect(result.success).toBe(false);
    expect(result.error).toContain('no delegation');
  });

  it('is registered as the `delegate` module the orchestrator looks up', () => {
    const registry = ModuleRegistry.createWithBuiltins();
    const module = registry.getModule('delegate');
    expect(module).toBeInstanceOf(DelegateAgent);
    expect(registry.getIcon('delegate')).toBe('🧑🔧');
  });
});
