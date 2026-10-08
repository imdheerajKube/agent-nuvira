/**
 * Machine facts tests.
 *
 * Detection takes an injectable probe, so every assertion here is deterministic
 * and spawns nothing: the OS mapping, the presence-only package-manager list,
 * shell resolution, and the discoverable capability.
 */

import { describe, it, expect } from 'vitest';
import {
  detectMachineFacts,
  buildMachineFactsBlock,
  machineFactsCapability,
} from '../../src/learning/machine-facts.js';
import { capabilityIndex } from '../../src/tools/capability-registry.js';

describe('detectMachineFacts', () => {
  it('normalizes the OS for each platform', () => {
    expect(detectMachineFacts({ platform: 'win32', binary: () => false, env: {} }).os).toBe('windows');
    expect(detectMachineFacts({ platform: 'darwin', binary: () => false, env: {} }).os).toBe('macos');
    expect(detectMachineFacts({ platform: 'linux', binary: () => false, env: {} }).os).toBe('linux');
  });

  it('lists only present package managers, OS-native first', () => {
    const present = new Set(['npm', 'brew', 'cargo']);
    const facts = detectMachineFacts({ platform: 'darwin', binary: (n) => present.has(n), env: {} });
    expect(facts.packageManagers).toEqual(['brew', 'npm', 'cargo']);
  });

  it('does not invent a manager the machine does not have', () => {
    const facts = detectMachineFacts({ platform: 'linux', binary: (n) => n === 'dnf', env: {} });
    expect(facts.packageManagers).toEqual(['dnf']);
    expect(facts.packageManagers).not.toContain('apt');
  });

  it('resolves the shell from the environment (unix and windows)', () => {
    const sh = detectMachineFacts({ platform: 'linux', binary: () => false, env: { SHELL: '/bin/zsh' } });
    expect(sh.shell).toBe('/bin/zsh');
    expect(sh.shellName).toBe('zsh');

    const win = detectMachineFacts({
      platform: 'win32',
      binary: () => false,
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(win.shellName).toBe('cmd');
  });

  it('treats a probe failure as not-present, never as an error', () => {
    const facts = detectMachineFacts({
      platform: 'linux',
      binary: () => {
        throw new Error('boom');
      },
      env: {},
    });
    expect(facts.packageManagers).toEqual([]);
  });

  it('reports the architecture', () => {
    expect(typeof detectMachineFacts({ platform: 'linux', binary: () => false, env: {} }).arch).toBe('string');
  });
});

describe('buildMachineFactsBlock', () => {
  it('states the machine and warns against assuming an OS', () => {
    const facts = detectMachineFacts({ platform: 'darwin', binary: (n) => n === 'brew', env: { SHELL: '/bin/bash' } });
    const block = buildMachineFactsBlock(facts);
    expect(block).toContain('## This machine');
    expect(block).toContain('brew');
    expect(block).toContain('bash');
    expect(block).toContain('not installed');
  });

  it('says so honestly when nothing is detected', () => {
    const facts = detectMachineFacts({ platform: 'linux', binary: () => false, env: {} });
    expect(buildMachineFactsBlock(facts)).toContain('(none detected)');
  });
});

describe('machineFactsCapability', () => {
  it('is a read-only, grantless discoverable capability carrying the facts', () => {
    const facts = detectMachineFacts({ platform: 'linux', binary: (n) => n === 'apt', env: {} });
    const cap = machineFactsCapability(facts);
    expect(cap.id).toBe('action:machine-facts');
    expect(cap.kind).toBe('action');
    expect(cap.effectClass).toBe('read');
    expect(cap.grantCategory).toBeUndefined();
    expect(cap.tags).toContain('apt');
    expect(cap.tags).toContain('linux');
  });

  it('is included in the capability index the model searches', async () => {
    const index = await capabilityIndex([], { includeSkills: false, includeMcp: false });
    expect(index.some((c) => c.id === 'action:machine-facts')).toBe(true);
  });
});
