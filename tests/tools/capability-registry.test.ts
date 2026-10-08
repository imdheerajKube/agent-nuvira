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
    // The display is RENDERED from the checkable form — one source, so they cannot
    // drift. `anyOf` is what the pre-flight probes; `' or '` is what a reader sees.
    expect(
      describeRequires({
        credentials: [{ anyOf: ['NPM_TOKEN', 'GITHUB_TOKEN'] }],
        binaries: [{ anyOf: ['npm', 'gh'] }],
      }),
    ).toBe('needs NPM_TOKEN or GITHUB_TOKEN; runs npm or gh');
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
    expect(cap.requires.credentials?.[0]?.anyOf.length).toBeGreaterThan(0);
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
    expect(publish.requires.credentials?.[0]?.anyOf).toEqual(['NPM_TOKEN', 'GITHUB_TOKEN']);
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
    expect(publish.requires).toMatchObject({ credentials: [{ anyOf: ['NPM_TOKEN', 'GITHUB_TOKEN'] }] });
    expect(publish.undo).toBeUndefined();
  });

  it('marks an undoable capability with how to undo it', async () => {
    const raw = await getTool('tool_search')!.run({ action: 'search', query: 'write file' }, ctx);
    const parsed = JSON.parse(String(raw)) as { capabilities: Array<Record<string, unknown>> };
    const write = parsed.capabilities.find((c) => c.id === 'tool:write_file')!;
    expect(write.effect).toBe('local-write');
    expect(String(write.undo)).toContain('git revert');
  });

  it('PRE-FLIGHTS each hit: a capability with requirements carries a check', async () => {
    const raw = await getTool('tool_search')!.run({ action: 'search', query: 'publish the package to npm' }, ctx);
    const parsed = JSON.parse(String(raw)) as { capabilities: Array<Record<string, any>> };
    const publish = parsed.capabilities.find((c) => c.id === 'action:publish-package')!;
    // Probed at discovery time, so what is missing is known before the work starts.
    expect(publish.check).toBeDefined();
    expect(typeof publish.check.ready).toBe('boolean');
    expect(publish.check.ask).toContain('bump type');

    // A capability that declares nothing gets no empty check — absence is the
    // signal, so the model never has to interpret a meaningless one.
    const readRaw = await getTool('tool_search')!.run({ action: 'search', query: 'read file' }, ctx);
    const read = (JSON.parse(String(readRaw)) as { capabilities: Array<Record<string, any>> }).capabilities.find(
      (c) => c.id === 'tool:read_file',
    )!;
    expect(read.check).toBeUndefined();
  });
});

// ─── Bundle 44: readiness, the deliberate pre-flight ─────────────────────────

describe('tool_search — the readiness action', () => {
  it('reports a pre-flight for a described task', async () => {
    const raw = await getTool('tool_search')!.run(
      { action: 'readiness', query: 'publish this package to npm' },
      ctx,
    );
    const parsed = JSON.parse(String(raw)) as {
      checked: number; blocked: number; summary: string; capabilities: Array<Record<string, any>>;
    };
    expect(parsed.checked).toBeGreaterThan(0);
    expect(typeof parsed.summary).toBe('string');
    expect(parsed.summary.length).toBeGreaterThan(0);
    const publish = parsed.capabilities.find((c) => c.id === 'action:publish-package')!;
    expect(publish.check).toBeDefined();
  });

  it('with NO query it checks the curated verbs, which are the ones that declare needs', async () => {
    const raw = await getTool('tool_search')!.run({ action: 'readiness' }, ctx);
    const parsed = JSON.parse(String(raw)) as { checked: number; capabilities: Array<Record<string, any>> };
    expect(parsed.checked).toBeGreaterThanOrEqual(9);
    // Every curated action declares a requirement, so every one is probed.
    for (const cap of parsed.capabilities) expect(cap.check).toBeDefined();
  });
});

// ─── Bundle 47: per-platform commands, declared only where the OS decides ─────

describe('platform variants — declared exactly where the OS determines the command', () => {
  const actions = actionCapabilities();
  const byRef = (ref: string) => actions.find((a) => a.ref === ref)!;
  const OSES = ['win32', 'darwin', 'linux'] as const;

  it('an OS-determined verb declares a command for every OS', () => {
    for (const ref of ['install-system-tool', 'store-credential']) {
      const platforms = byRef(ref).platforms!;
      expect(platforms, ref).toBeDefined();
      for (const os of OSES) {
        expect(platforms[os], `${ref} on ${os}`).toBeDefined();
        expect(platforms[os]!.command.length).toBeGreaterThan(0);
      }
    }
  });

  it('every platform binary is one the capability ALSO declares it needs', () => {
    // The guard that stops a platform hint naming a tool the requirement pre-flight
    // never checked for — the two halves are the same fact and must agree.
    for (const cap of actions) {
      if (!cap.platforms) continue;
      const declared = new Set((cap.requires.binaries ?? []).flatMap((b) => b.anyOf));
      for (const [os, variant] of Object.entries(cap.platforms)) {
        if (!variant?.binary) continue;
        expect(declared.has(variant.binary), `${cap.ref} on ${os} runs '${variant.binary}'`).toBe(true);
      }
    }
  });

  it('a command that runs through nuvira itself claims NO PATH binary', () => {
    const platforms = byRef('store-credential').platforms!;
    // The OS decides WHERE the secret lives, not what to run — so naming a PATH
    // binary would be a false fact, and the type makes it optional for this reason.
    for (const os of OSES) expect(platforms[os]!.binary).toBeUndefined();
    // …but the note, which IS the OS-determined part, is present everywhere.
    for (const os of OSES) expect(platforms[os]!.note).toBeTruthy();
  });

  it('declares NO platforms where the OS is irrelevant — pinned so it stays that way', () => {
    // `npm install` is the same command on every OS, and npm-vs-pnpm is a user
    // preference rather than an OS affordance; deploy targets are a platform
    // CHOICE, not an OS one. Inventing a per-OS map for these would fabricate a
    // mapping that does not exist, so absence is the assertion.
    for (const ref of ['install-package', 'add-dependency', 'deploy-app', 'publish-package', 'push-git']) {
      expect(byRef(ref).platforms, ref).toBeUndefined();
    }
  });

  it('tool_search resolves the hint for THIS machine', async () => {
    const raw = await getTool('tool_search')!.run(
      { action: 'search', query: 'install a system tool' },
      ctx,
    );
    const parsed = JSON.parse(String(raw)) as { capabilities: Array<Record<string, any>> };
    const cap = parsed.capabilities.find((c) => c.id === 'action:install-system-tool')!;
    expect(cap.onThisMachine).toBeDefined();
    expect(cap.onThisMachine.command).toContain('install');
    // …and the map for the other OSes rides along, so the model can see the whole
    // picture rather than only its own.
    expect(Object.keys(cap.platforms).sort()).toEqual(['darwin', 'linux', 'win32']);
  });
});
