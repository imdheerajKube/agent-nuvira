/**
 * SDK scaffold — the generator behind `nuvira sdk scaffold`.
 *
 * WHY THIS SUITE EXISTS: scaffold had NO test at all, and it is the one part of
 * the SDK that writes a developer's files for them. A template regression does
 * not fail a typecheck or a build — it silently ships a broken starter project.
 * That is exactly what had happened: the `agent create` path pinned
 * `@agent-baba-d/sdk`, a package that does not exist, so every generated project
 * failed on `npm install`. These tests pin the *published* package name in the
 * generated output, not just the shape of the files.
 *
 * Output goes to a fresh temp dir, never the repo — the suite's tree-guard
 * global setup fails the run if a test dirties the project.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scaffold, listTemplates } from '../../src/agent-sdk/src/scaffold.js';

const dirs: string[] = [];

/** A non-existent output path inside a throwaway temp dir. */
function freshOutDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'nuvira-scaffold-'));
  dirs.push(root);
  return join(root, 'my-agent');
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('sdk scaffold — output targets the published SDK', () => {
  it('pins @agent-nuvira/sdk (not the dead @agent-baba-d name) in package.json', () => {
    const out = freshOutDir();
    scaffold({ outDir: out, agentName: 'CodeFormatter', description: 'Formats code' });

    const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toHaveProperty('@agent-nuvira/sdk');
    expect(pkg.dependencies).not.toHaveProperty('@agent-baba-d/sdk');
  });

  it('generates an agent and a test that both import the published SDK', () => {
    const out = freshOutDir();
    scaffold({ outDir: out, agentName: 'CodeFormatter', description: 'Formats code' });

    const agentSrc = readFileSync(join(out, 'src', 'codeFormatter.ts'), 'utf-8');
    const testSrc = readFileSync(join(out, 'tests', 'codeFormatter.test.ts'), 'utf-8');

    expect(agentSrc).toContain("from '@agent-nuvira/sdk'");
    expect(testSrc).toContain("from '@agent-nuvira/sdk/testing'");
    expect(agentSrc).not.toContain('agent-baba-d');
    expect(testSrc).not.toContain('agent-baba-d');
  });

  it('derives a kebab-case agentType for the descriptor unless one is given', () => {
    const out = freshOutDir();
    scaffold({ outDir: out, agentName: 'CodeFormatter', description: 'Formats code' });

    const agentSrc = readFileSync(join(out, 'src', 'codeFormatter.ts'), 'utf-8');
    expect(agentSrc).toContain("agentType: 'code-formatter'");
  });

  it('honours an explicit agentType override', () => {
    const out = freshOutDir();
    scaffold({
      outDir: out,
      agentName: 'CodeFormatter',
      description: 'Formats code',
      agentType: 'fmt',
    });

    const agentSrc = readFileSync(join(out, 'src', 'codeFormatter.ts'), 'utf-8');
    expect(agentSrc).toContain("agentType: 'fmt'");
  });
});

describe('sdk scaffold — templates', () => {
  it('full-agent (default) writes config, source, and tests', () => {
    const out = freshOutDir();
    const files = scaffold({ outDir: out, agentName: 'MyAgent', description: 'Does things' });

    for (const rel of ['package.json', 'tsconfig.json', 'vitest.config.ts', 'src/myAgent.ts', 'src/index.ts', 'tests/myAgent.test.ts']) {
      expect(existsSync(join(out, rel)), `missing ${rel}`).toBe(true);
    }
    expect(files).toHaveLength(6);
  });

  it('basic-agent omits the test runner and unit tests', () => {
    const out = freshOutDir();
    scaffold({ outDir: out, agentName: 'MyAgent', description: 'Does things', template: 'basic-agent' });

    expect(existsSync(join(out, 'src/myAgent.ts'))).toBe(true);
    expect(existsSync(join(out, 'vitest.config.ts'))).toBe(false);
    expect(existsSync(join(out, 'tests'))).toBe(false);
  });

  it('agent-pack lays out a multi-agent package skeleton', () => {
    const out = freshOutDir();
    scaffold({ outDir: out, agentName: 'AgentPack', description: 'A pack', template: 'agent-pack' });

    expect(readFileSync(join(out, 'src', 'index.ts'), 'utf-8')).toContain('Re-export your custom agents');
  });

  it('listTemplates names every template the scaffold command accepts', () => {
    const names = listTemplates().map((t) => t.name);
    expect(names).toEqual(['basic-agent', 'full-agent', 'agent-pack']);
  });
});

describe('sdk scaffold — guards', () => {
  it('rejects a non-PascalCase agent name instead of writing a broken class', () => {
    const out = freshOutDir();
    expect(() => scaffold({ outDir: out, agentName: 'codeFormatter', description: 'x' }))
      .toThrow(/PascalCase/);
  });

  it('refuses to overwrite an existing directory', () => {
    const out = freshOutDir();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'do not delete me', 'utf-8');

    expect(() => scaffold({ outDir: out, agentName: 'MyAgent', description: 'x' }))
      .toThrow(/already exists/);
    expect(readFileSync(join(out, 'keep.txt'), 'utf-8')).toBe('do not delete me');
  });
});
