/**
 * Bundle 41 Phase 1 — the capability registry.
 *
 * One descriptor for everything the agent can DO. These tests pin the three
 * properties the rest of the capability layer will lean on:
 *
 *   1. NORMALIZATION — a tool, a skill and a curated action all produce the same
 *      `Capability` shape (effect class, reversibility, requirements, grant).
 *   2. CONSERVATIVE DEFAULT — a tool nobody described is treated as a local-state
 *      change that NO grant may cover. It is never silently labelled `read`.
 *   3. DISCOVERY — a paraphrase finds the capability, ranked, and it is still
 *      just a CANDIDATE (nothing here decides what runs).
 */

import { describe, it, expect } from 'vitest';

import {
  capabilityFromTool,
  capabilityFromSkill,
  actionCapabilities,
  capabilityIndex,
  searchCapabilities,
  describeRequires,
} from '../../src/tools/capability-registry.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';

const ctx = {} as ToolContext;

describe('describeRequires', () => {
  it('summarizes credentials, binaries and inputs', () => {
    expect(describeRequires({})).toBe('');
    expect(describeRequires({ credentials: ['NPM_TOKEN'], binaries: ['npm'] })).toBe(
      'needs NPM_TOKEN; runs npm',
    );
    expect(describeRequires({ inputs: ['bump type'] })).toBe('ask for bump type');
  });
});

describe('capabilityFromTool', () => {
  it('normalizes a read-only tool', () => {
    const cap = capabilityFromTool({
      name: 'read_file',
      description: 'Read a file from the workspace. Never changes it.',
    });
    expect(cap).toMatchObject({
      id: 'tool:read_file',
      kind: 'tool',
      ref: 'read_file',
      effectClass: 'read',
      reversible: true,
    });
    // The one-liner is the FIRST sentence — what it does, not how to call it.
    expect(cap.oneLiner).toBe('Read a file from the workspace.');
    expect(cap.grantCategory).toBeUndefined();
  });

  it('marks a workspace write as local-write with the write grant and an undo', () => {
    const cap = capabilityFromTool({ name: 'write_file', description: 'Write a file.' });
    expect(cap.effectClass).toBe('local-write');
    expect(cap.grantCategory).toBe('write');
    expect(cap.reversible).toBe(true);
    expect(cap.reversibleHow).toContain('git revert');
  });

  it('marks a terminal command as local-state covered by the terminal grant', () => {
    const cap = capabilityFromTool({ name: 'run_terminal', description: 'Run a command.' });
    expect(cap.effectClass).toBe('local-state');
    expect(cap.grantCategory).toBe('terminal');
  });

  it('marks an off-machine action as external, metered, and NEVER reversible by default', () => {
    const cap = capabilityFromTool({ name: 'publish', description: 'Publish a release.' });
    expect(cap.effectClass).toBe('external');
    expect(cap.reversible).toBe(false);
    expect(cap.grantCategory).toBe('external');
    expect(cap.requires.credentials?.length).toBeGreaterThan(0);
  });

  it('DEFAULTS an undescribed tool to a local-state change that no grant may cover', () => {
    // The dangerous default would be `read` (a mutation hidden as inspection) or a
    // grant category (a user's grant silently unlocking an undeclared action).
    const cap = capabilityFromTool({ name: 'some_future_tool', description: 'Does a thing.' });
    expect(cap.effectClass).not.toBe('read');
    expect(cap.effectClass).toBe('local-state');
    expect(cap.grantCategory).toBeUndefined();
    expect(cap.oneLiner).toBe('Does a thing.');
  });

  it('still produces a usable one-liner when the tool has no description', () => {
    const cap = capabilityFromTool({ name: 'mystery' });
    expect(cap.oneLiner).toBe('The mystery tool.');
    expect(cap.tags).toContain('mystery');
  });

  it('never labels a consequential registry tool as read', () => {
    for (const name of ['write_file', 'edit_file', 'run_terminal', 'run_cli', 'publish', 'git']) {
      expect(capabilityFromTool({ name }).effectClass).not.toBe('read');
    }
  });
});

describe('capabilityFromSkill', () => {
  it('normalizes a skill as a kind:skill capability with a slugged id', () => {
    const cap = capabilityFromSkill({ name: 'Deploy to Vercel', description: 'Ship a site. Then verify.' });
    expect(cap).toMatchObject({
      id: 'skill:deploy-to-vercel',
      kind: 'skill',
      ref: 'deploy-to-vercel',
      effectClass: 'local-state',
    });
    expect(cap.oneLiner).toBe('Ship a site.');
    expect(cap.tags).toContain('Deploy to Vercel');
  });

  it('prefers an explicit skill id over the slug', () => {
    expect(capabilityFromSkill({ id: 'ship-it', name: 'Deploy to Vercel' }).ref).toBe('ship-it');
  });
});

describe('actionCapabilities — the curated high-level verbs', () => {
  const actions = actionCapabilities();

  it('covers the verbs that used to live only in prose', () => {
    const refs = actions.map((a) => a.ref);
    for (const key of [
      'install-package',
      'add-dependency',
      'install-system-tool',
      'uninstall-package',
      'publish-package',
      'publish-website',
      'deploy-app',
      'push-git',
      'store-credential',
    ]) {
      expect(refs).toContain(key);
    }
  });

  it('gives every action a unique id and a stated requirement', () => {
    const ids = actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of actions) {
      expect(a.kind).toBe('action');
      expect(a.oneLiner.length).toBeGreaterThan(10);
      expect(Object.keys(a.requires).length).toBeGreaterThan(0);
    }
  });

  it('routes off-machine actions to the external grant, and marks them irreversible', () => {
    const publish = actions.find((a) => a.ref === 'publish-package')!;
    expect(publish.effectClass).toBe('external');
    expect(publish.reversible).toBe(false);
    expect(publish.grantCategory).toBe('external');
    expect(publish.requires.credentials).toContain('NPM_TOKEN or a GitHub token');
    expect(publish.requires.inputs).toContain('bump type');
  });

  it('keeps a git push reversible (the remote keeps history) while a system install is not', () => {
    expect(actions.find((a) => a.ref === 'push-git')!.reversible).toBe(true);
    expect(actions.find((a) => a.ref === 'install-system-tool')!.reversible).toBe(false);
  });
});

describe('searchCapabilities — discovery, never a decision', () => {
  const index = [
    ...['read_file', 'write_file', 'run_terminal', 'publish', 'git'].map((name) =>
      capabilityFromTool({ name, description: `${name} tool.` }),
    ),
    ...actionCapabilities(),
  ];

  it('finds the publish action from a paraphrase of the user request', () => {
    const hits = searchCapabilities(index, 'publish my package to npm');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.capability.id).toBe('action:publish-package');
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(hits[0]!.matched).toContain('publish');
  });

  it('finds a SYSTEM tool install, not just a project dependency install', () => {
    const hits = searchCapabilities(index, 'install ripgrep system wide');
    expect(hits[0]!.capability.ref).toBe('install-system-tool');
  });

  it('finds a deploy action for a website', () => {
    const hits = searchCapabilities(index, 'deploy the website to a host');
    expect(hits.map((h) => h.capability.ref)).toContain('publish-website');
  });

  it('ranks a name match above a description-only match', () => {
    const synthetic = [
      capabilityFromTool({ name: 'zzz_other', description: 'push push push' }),
      capabilityFromTool({ name: 'push', description: 'Send commits.' }),
    ];
    const hits = searchCapabilities(synthetic, 'push');
    expect(hits[0]!.capability.ref).toBe('push');
  });

  it('reports the tokens that matched, so a rank is inspectable', () => {
    const hits = searchCapabilities(index, 'run a terminal command');
    const runTerminal = hits.find((h) => h.capability.ref === 'run_terminal')!;
    expect(runTerminal.matched).toContain('run');
    expect(runTerminal.matched).toContain('terminal');
  });

  it('respects the limit and returns nothing for an empty query', () => {
    expect(searchCapabilities(index, 'install', 2).length).toBeLessThanOrEqual(2);
    expect(searchCapabilities(index, '   ')).toEqual([]);
    expect(searchCapabilities(index, '')).toEqual([]);
  });
});

describe('capabilityIndex', () => {
  it('unions tools, curated actions and (optionally) skills', async () => {
    const tools = [{ name: 'read_file', description: 'Read a file.' }];
    const withActions = await capabilityIndex(tools, { includeSkills: false });
    expect(withActions.map((c) => c.kind)).toContain('tool');
    expect(withActions.map((c) => c.kind)).toContain('action');
    expect(withActions.some((c) => c.kind === 'skill')).toBe(false);
    expect(withActions.length).toBe(tools.length + actionCapabilities().length);
  });
});

describe('tool_search — the search action surfaces capabilities', () => {
  it('returns the tool hits AND the capability descriptors', async () => {
    const raw = await getTool('tool_search')!.run(
      { action: 'search', query: 'publish the package to npm' },
      ctx,
    );
    const parsed = JSON.parse(String(raw)) as {
      tools: unknown;
      capabilities: Array<Record<string, unknown>>;
    };
    // The pre-existing tool finder still answers…
    expect(parsed).toHaveProperty('tools');
    // …and every hit now carries what it DOES, not just its name.
    expect(Array.isArray(parsed.capabilities)).toBe(true);
    const publish = parsed.capabilities.find((c) => c.id === 'action:publish-package')!;
    expect(publish).toBeTruthy();
    expect(publish.effect).toBe('external');
    expect(publish.reversible).toBe(false);
    expect(publish.grantable).toBe('external');
    expect(publish.requires).toMatchObject({ credentials: ['NPM_TOKEN or a GitHub token'] });
    expect(publish.undo).toBeUndefined();
  });

  it('marks an undoable capability with how to undo it', async () => {
    const raw = await getTool('tool_search')!.run({ action: 'search', query: 'write file' }, ctx);
    const parsed = JSON.parse(String(raw)) as { capabilities: Array<Record<string, unknown>> };
    const write = parsed.capabilities.find((c) => c.id === 'tool:write_file')!;
    expect(write.effect).toBe('local-write');
    expect(String(write.undo)).toContain('git revert');
  });
});
