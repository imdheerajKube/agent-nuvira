/**
 * SDK register/unregister — the code that rewrites `orchestrator.ts` by hand.
 *
 * WHY THIS SUITE EXISTS: these functions perform source-editing with regexes
 * against a file the user owns, and had no test at all. The failure mode is not
 * "throws" — it is "the switch case landed in the wrong place and the build
 * breaks", or worse, "unregister removed a built-in import". So the tests pin
 * both directions: what register adds, and what unregister removes (and, just
 * as importantly, what it refuses to remove without an explicit class name).
 *
 * Everything runs against a synthetic orchestrator in a temp dir, never the
 * real one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerAgent, unregisterAgent } from '../../src/agent-sdk/src/register.js';

const dirs: string[] = [];

/** A minimal orchestrator shaped like the real one register.ts expects. */
const ORCHESTRATOR = `import { Writer } from './agents/writer.js';

const AGENT_ICONS: Record<string, string> = {
  writer: '✍️',
};

function createAgent(agentType: string) {
  switch (agentType) {
    case 'writer':
      return new Writer();

    default:
      return null;
  }
}

export { createAgent };
`;

function writeOrchestrator(content: string = ORCHESTRATOR): string {
  const dir = mkdtempSync(join(tmpdir(), 'nuvira-register-'));
  dirs.push(dir);
  const path = join(dir, 'orchestrator.ts');
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('sdk registerAgent', () => {
  it('adds the import, the switch case, and the icon', () => {
    const path = writeOrchestrator();
    const result = registerAgent({
      orchestratorPath: path,
      sourceModule: './agents/my-agent.js',
      className: 'MyAgent',
      agentType: 'my-agent',
      icon: '🧩',
    });

    expect(result.success).toBe(true);
    expect(result.modifiedFiles).toEqual([path]);

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain("import { MyAgent } from './agents/my-agent.js';");
    expect(content).toContain("    case 'my-agent':\n      return new MyAgent();");
    expect(content).toContain("  'my-agent': '🧩',");
    // The original content survives.
    expect(content).toContain("import { Writer } from './agents/writer.js';");
    expect(content).toContain("case 'writer':");
  });

  it('is idempotent — registering twice reports "already registered" and writes nothing', () => {
    const path = writeOrchestrator();
    const opts = {
      orchestratorPath: path,
      sourceModule: './agents/my-agent.js',
      className: 'MyAgent',
      agentType: 'my-agent',
    };

    registerAgent(opts);
    const afterFirst = readFileSync(path, 'utf-8');
    const second = registerAgent(opts);

    expect(second.success).toBe(true);
    expect(second.message).toMatch(/already registered/i);
    expect(second.modifiedFiles).toEqual([]);
    expect(readFileSync(path, 'utf-8')).toBe(afterFirst);
  });

  it('fails cleanly when the orchestrator file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-register-'));
    dirs.push(dir);
    const result = registerAgent({
      orchestratorPath: join(dir, 'nope.ts'),
      sourceModule: './agents/my-agent.js',
      className: 'MyAgent',
      agentType: 'my-agent',
    });

    expect(result.success).toBe(false);
    expect(result.modifiedFiles).toEqual([]);
  });

  it('fails rather than corrupting a file with no import section', () => {
    const path = writeOrchestrator(`const x = 1;\n\nfunction createAgent() {\n  switch (1) {\n    default:\n      return null;\n  }\n}\n`);
    const result = registerAgent({
      orchestratorPath: path,
      sourceModule: './agents/my-agent.js',
      className: 'MyAgent',
      agentType: 'my-agent',
    });

    expect(result.success).toBe(false);
    expect(readFileSync(path, 'utf-8')).toContain('const x = 1;');
  });
});

describe('sdk unregisterAgent', () => {
  it('round-trips a registration: removes case, icon, and import', () => {
    const path = writeOrchestrator();
    registerAgent({
      orchestratorPath: path,
      sourceModule: './agents/my-agent.js',
      className: 'MyAgent',
      agentType: 'my-agent',
      icon: '🧩',
    });

    const result = unregisterAgent({ orchestratorPath: path, agentType: 'my-agent', className: 'MyAgent' });
    expect(result.success).toBe(true);

    const content = readFileSync(path, 'utf-8');
    expect(content).not.toContain('my-agent');
    expect(content).not.toContain('MyAgent');
    expect(content).not.toContain('🧩');
    // Built-in agent untouched.
    expect(content).toContain("case 'writer':");
  });

  it('without a class name, removes the case and icon but leaves the import (imports are only removed when explicitly named)', () => {
    const path = writeOrchestrator();
    registerAgent({
      orchestratorPath: path,
      sourceModule: './agents/my-agent.js',
      className: 'MyAgent',
      agentType: 'my-agent',
    });

    unregisterAgent({ orchestratorPath: path, agentType: 'my-agent' });

    const content = readFileSync(path, 'utf-8');
    expect(content).not.toContain("case 'my-agent':");
    expect(content).toContain("import { MyAgent } from './agents/my-agent.js';");
    expect(content).toContain("case 'writer':");
  });

  it('is a no-op for an agent that was never registered', () => {
    const path = writeOrchestrator();
    const before = readFileSync(path, 'utf-8');
    const result = unregisterAgent({ orchestratorPath: path, agentType: 'ghost', className: 'Ghost' });

    expect(result.success).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });
});

describe('sdk package surface', () => {
  it('exposes register/scaffold helpers from the package index', async () => {
    const sdk = await import('../../src/agent-sdk/src/index.js');
    expect(typeof sdk.registerAgent).toBe('function');
    expect(typeof sdk.unregisterAgent).toBe('function');
    expect(typeof sdk.scaffold).toBe('function');
    expect(typeof sdk.listTemplates).toBe('function');
  });
});
