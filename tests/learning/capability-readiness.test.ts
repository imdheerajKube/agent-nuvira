/**
 * Capability readiness read-model tests.
 *
 * Everything is derived from the curated capability declarations + a PATH probe,
 * so these assert STRUCTURE and the DERIVED facts that do not depend on which
 * tools this machine happens to have: it reports all nine curated verbs, the
 * aggregation groups the same executable once, and the per-OS command resolves
 * for the platform asked for.
 */

import { describe, it, expect } from 'vitest';
import { capabilityReadiness } from '../../src/learning/capability-readiness.js';
import { actionCapabilities } from '../../src/tools/capability-registry.js';

describe('capabilityReadiness', () => {
  it('reports every curated verb with a readiness verdict', () => {
    const view = capabilityReadiness();
    const expected = actionCapabilities().map((c) => c.ref).sort();
    expect(view.verbs.map((v) => v.ref).sort()).toEqual(expected);
    for (const verb of view.verbs) {
      expect(verb.id.startsWith('action:')).toBe(true);
      expect(typeof verb.ready).toBe('boolean');
      expect(Array.isArray(verb.gaps)).toBe(true);
      expect(Array.isArray(verb.ask)).toBe(true);
    }
    expect(view.readyCount + view.blockedCount).toBe(view.verbs.length);
  });

  it('aggregates a shared executable once, naming every verb that needs it', () => {
    const view = capabilityReadiness();
    for (const m of view.missingExecutables) {
      expect(m.anyOf.length).toBeGreaterThan(0);
      expect(m.forRefs.length).toBeGreaterThan(0);
      // No duplicate executable rows (the map keys on the anyOf set).
      expect(view.missingExecutables.filter((x) => x.anyOf.join('|') === m.anyOf.join('|'))).toHaveLength(1);
    }
  });

  it('resolves the per-OS command for the platform asked for, where the OS decides it', () => {
    const win = capabilityReadiness('win32').verbs.find((v) => v.ref === 'install-system-tool');
    const mac = capabilityReadiness('darwin').verbs.find((v) => v.ref === 'install-system-tool');
    const linux = capabilityReadiness('linux').verbs.find((v) => v.ref === 'install-system-tool');
    expect(win?.onThisMachine?.command).toContain('winget');
    expect(mac?.onThisMachine?.command).toContain('brew');
    expect(linux?.onThisMachine?.command).toContain('apt-get');
    // Every declared map is carried whole, so the page can show the others too.
    expect(Object.keys(win?.platforms ?? {}).sort()).toEqual(['darwin', 'linux', 'win32']);
  });

  it('does not invent a per-OS command for the OS-neutral verbs', () => {
    const view = capabilityReadiness();
    for (const ref of ['install-package', 'add-dependency', 'deploy-app', 'publish-package', 'push-git']) {
      const verb = view.verbs.find((v) => v.ref === ref);
      expect(verb?.platforms).toBeUndefined();
      expect(verb?.onThisMachine).toBeUndefined();
    }
  });

  it('credential gaps are reported but never block', () => {
    // Any verb whose ONLY gap is a credential must still read ready.
    const view = capabilityReadiness();
    for (const verb of view.verbs) {
      const hasBinaryGap = verb.gaps.some((g) => g.startsWith('missing executable:'));
      if (!hasBinaryGap) expect(verb.ready).toBe(true);
    }
  });
});
