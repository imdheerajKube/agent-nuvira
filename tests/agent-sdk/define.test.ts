/**
 * SDK defineAgent — the descriptor helper that replaces a hand-written object.
 *
 * The value here is the validation: a typo'd `agentType` or a missing
 * description normally surfaces only when the orchestrator fails to match a plan
 * step — far from the code that caused it. These tests pin that it fails at the
 * call site instead, and that it derives the defaults it promises.
 */

import { describe, it, expect } from 'vitest';

import { Agent } from '../../src/agent-sdk/src/agent.js';
import { defineAgent, toKebabCase } from '../../src/agent-sdk/src/define.js';
import type { AgentContext, AgentResult, LLMCallFn } from '../../src/agent-sdk/src/types.js';

class GoodAgent extends Agent {
  readonly name = 'CodeFormatter';
  readonly description = 'Formats source code';
  async execute(_c: AgentContext, _l: LLMCallFn): Promise<AgentResult> {
    return { success: true, summary: 'done' };
  }
}

class Nameless extends Agent {
  readonly name = '';
  readonly description = 'no name';
  async execute(): Promise<AgentResult> {
    return { success: true, summary: 'done' };
  }
}

class Explodes extends Agent {
  readonly name = 'Explodes';
  readonly description = 'throws in constructor';
  constructor() {
    super();
    throw new Error('boom');
  }
  async execute(): Promise<AgentResult> {
    return { success: true, summary: 'done' };
  }
}

describe('toKebabCase', () => {
  it('splits camel, Pascal, and acronym boundaries', () => {
    expect(toKebabCase('CodeFormatter')).toBe('code-formatter');
    expect(toKebabCase('HTTPClient')).toBe('http-client');
    expect(toKebabCase('MyAgent2')).toBe('my-agent2');
  });
});

describe('defineAgent', () => {
  it('reads name and description from the agent and derives a kebab-case agentType', () => {
    const descriptor = defineAgent({ AgentClass: GoodAgent });
    expect(descriptor.name).toBe('CodeFormatter');
    expect(descriptor.description).toBe('Formats source code');
    expect(descriptor.agentType).toBe('code-formatter');
    expect(descriptor.AgentClass).toBe(GoodAgent);
  });

  it('honours explicit overrides', () => {
    const descriptor = defineAgent({
      AgentClass: GoodAgent,
      name: 'Formatter',
      description: 'Custom description',
      agentType: 'fmt',
      tags: 'code',
      icon: '🎨',
    });
    expect(descriptor.name).toBe('Formatter');
    expect(descriptor.description).toBe('Custom description');
    expect(descriptor.agentType).toBe('fmt');
    expect(descriptor.tags).toBe('code');
    expect(descriptor.icon).toBe('🎨');
  });

  it('rejects a missing AgentClass', () => {
    // @ts-expect-error — deliberately wrong input
    expect(() => defineAgent({})).toThrow(/AgentClass/);
  });

  it('rejects an agent with no name', () => {
    expect(() => defineAgent({ AgentClass: Nameless })).toThrow(/name/);
  });

  it('rejects a non-kebab-case agentType', () => {
    expect(() => defineAgent({ AgentClass: GoodAgent, agentType: 'Code Formatter' }))
      .toThrow(/kebab-case/);
  });

  it('surfaces a constructor failure instead of crashing opaquely', () => {
    expect(() => defineAgent({ AgentClass: Explodes })).toThrow(/Explodes/);
  });
});
