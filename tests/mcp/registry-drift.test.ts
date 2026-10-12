/**
 * MCP registry drift — the SCHEDULED/TAGGED half of the Phase 1 pin check.
 *
 * WHY IT IS NOT A PR GATE. `pin-verifier.ts` runs the same check at the install
 * boundary, where a user is present to read the refusal. Running it on every PR
 * would put a live npm lookup on the critical path of unrelated work, so a
 * registry blip (a 5xx, a rate limit, an offline runner) would fail a change
 * that has nothing to do with MCP. The plan says this explicitly:
 *
 *   "the registry-existence + deprecation check as a *scheduled/tagged* test
 *    (deliberately not a PR gate: a registry blip must not fail unrelated work)."
 *
 * HOW TO RUN IT. Opt in, so the network call is never implicit:
 *
 *   NUVIRA_REGISTRY_DRIFT=1 npx vitest run tests/mcp/registry-drift.test.ts
 *
 * A green run proves every pinned npm spec still resolves (and reports any the
 * registry has since deprecated); a RED run names the exact pin to re-cut. The
 * always-on assertions below need NO network, so the disclosure rules that keep
 * the catalog honest — including the floating `latest` Docker tag — stay pinned
 * on every normal test run.
 */

import { describe, it, expect } from 'vitest';
import { MCP_CATALOG, npmSpecsForVariant } from '../../src/mcp/catalog.js';
import { verifyNpmSpecs } from '../../src/mcp/pin-verifier.js';

/** Every exact npm spec the catalog would hand to a package runner. */
function allNpmSpecs(): string[] {
  const specs = new Set<string>();
  for (const entry of MCP_CATALOG) {
    for (const variant of entry.variants) {
      for (const spec of npmSpecsForVariant(variant)) specs.add(spec);
    }
  }
  return [...specs].sort();
}

/** Variants that run a container image rather than a package. */
function dockerVariants(): Array<{ entry: string; variant: string; image: string | null; note: string }> {
  const out: Array<{ entry: string; variant: string; image: string | null; note: string }> = [];
  for (const entry of MCP_CATALOG) {
    for (const variant of entry.variants) {
      if (variant.command !== 'docker') continue;
      // The image is the LAST non-flag argument (`docker run -i --rm <image>`).
      const image = [...(variant.args ?? [])].reverse().find((a) => !a.startsWith('-')) ?? null;
      out.push({ entry: entry.name, variant: variant.id, image, note: variant.note ?? '' });
    }
  }
  return out;
}

describe('MCP catalog pin disclosure (always on — no network)', () => {
  it('finds the pinned specs and the container variants it is meant to watch', () => {
    // Guards against a regex/scan that matches nothing and makes this vacuous.
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(6);
    expect(allNpmSpecs().length).toBeGreaterThanOrEqual(4);
    expect(dockerVariants().length).toBeGreaterThanOrEqual(1);
  });

  it('every npm spec is EXACTLY pinned (pkg@1.2.3, never a range or a dist-tag)', () => {
    // A floating spec is the thing the pin verifier cannot check, so it must not
    // exist (`latest`, `^1.0.0`, `~1.2.3` are all unpinnable claims).
    for (const spec of allNpmSpecs()) {
      expect(spec, `${spec} is not an exact pin`).toMatch(/^(@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
      expect(spec).not.toMatch(/@(?:\^|~|latest|next|beta|canary)\b/);
    }
  });

  it('every container variant DISCLOSES a floating tag instead of hiding it', () => {
    // The `mcp/fetch` image is published only as `latest`, so it cannot be
    // pinned to a version. That is a real limitation — and the one thing that
    // must never happen is the caveat quietly disappearing while the variant
    // stays unpinned. If a digest pin is ever added, drop the disclosure AND
    // this assertion together.
    for (const { entry, variant, image, note } of dockerVariants()) {
      expect(image, `${entry}/${variant} runs a docker image`).toBeTruthy();
      if (image?.endsWith(':latest') || !image?.includes(':')) {
        expect(note, `${entry}/${variant} uses a floating tag with no disclosed caveat`).toMatch(
          /latest/,
        );
      }
    }
  });
});

// Opt-in: a registry blip must never fail unrelated work. See the header.
const driftEnabled = process.env.NUVIRA_REGISTRY_DRIFT === '1';

describe.skipIf(!driftEnabled)('MCP registry drift (scheduled/tagged — needs network)', () => {
  it('every pinned npm spec still resolves, and names any that is now deprecated', async () => {
    const specs = allNpmSpecs();
    const verdicts = await verifyNpmSpecs(specs, { timeoutMs: 15_000 });
    const failures: string[] = [];
    const deprecated: string[] = [];

    for (const spec of specs) {
      const verdict = verdicts.get(spec);
      if (!verdict || !verdict.checked) {
        failures.push(`${spec}: could not be checked (${verdict?.reason ?? 'no verdict'})`);
        continue;
      }
      if (!verdict.ok) failures.push(`${spec}: ${verdict.reason}`);
      else if (verdict.deprecated) deprecated.push(`${spec}: deprecated — ${verdict.deprecated}`);
    }

    // A deprecated-but-resolving pin is reported, not failed: "it installs" and
    // "it is maintained" are different facts the maintainer decides on.
    if (deprecated.length > 0) console.warn(`⚠ ${deprecated.join('\n⚠ ')}`);
    expect(failures, `registry drift — re-cut these pins:\n${failures.join('\n')}`).toEqual([]);
  }, 60_000);
});
