/**
 * G16 — the generalized state-change gate.
 *
 * The audit found FOUR confirmation-gated tools whose gate could not tell "the
 * user already ordered this" apart from "this would be a surprise": `edit_file`,
 * `run_terminal` (confirm class), `run_cli` (confirmation intents) and
 * `git commit`. Each had grown its own refusal text and its own notion of what
 * needed approving. This pins the single rule table they now share, and the
 * evidence helpers each one measures with.
 *
 * The two properties that must never drift:
 *   - the safety floor is UNCHANGED: nothing irreversible or external is ever
 *     decided autonomously, whatever the request says;
 *   - every confirmation-gated CLI intent is classified ON PURPOSE, so a new
 *     one cannot silently inherit either behaviour.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  decideStateChange,
  decideCliIntentConfirmation,
  isSurgicalEdit,
  requestNamesPath,
  requestRequestsCommit,
  requestRequestsPush,
  IRREVERSIBLE_CLI_INTENTS,
  RECOVERABLE_CLI_INTENTS,
  EXTERNAL_CLI_INTENTS,
  EDIT_SURGICAL_MAX_FRACTION,
} from '../../src/learning/autonomy-policy.js';

describe('decideStateChange — the shared rule table', () => {
  const base = { tool: 't', action: 'doing the thing' };

  it('NEVER proceeds on a destructive change, even when the request names it', () => {
    const verdict = decideStateChange({
      ...base,
      changeClass: 'destructive',
      namedByRequest: true,
      recoverable: true,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('ask');
    expect(verdict.reason).toMatch(/permanent|user’s call/);
  });

  it('NEVER proceeds on an external effect, even when the request names it', () => {
    const verdict = decideStateChange({
      ...base,
      changeClass: 'external',
      namedByRequest: true,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('ask');
    expect(verdict.reason).toMatch(/outside this machine/);
  });

  it('asks when the request authorized neither the work nor the action', () => {
    const verdict = decideStateChange({ ...base, changeClass: 'modify', recoverable: true });
    expect(verdict.action).toBe('ask');
    expect(verdict.reason).toMatch(/surprise/);
  });

  it('proceeds when the request itself names the action', () => {
    const verdict = decideStateChange({
      ...base,
      changeClass: 'local-state',
      namedByRequest: true,
      authorizedByRequest: false,
    });
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toMatch(/names this action/);
  });

  it('proceeds on authorized work when the change is measurably recoverable', () => {
    const verdict = decideStateChange({
      ...base,
      changeClass: 'modify',
      recoverable: true,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toMatch(/recoverable/);
  });

  it('asks when the work was authorized but the change is neither named nor recoverable', () => {
    const verdict = decideStateChange({
      ...base,
      changeClass: 'modify',
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('ask');
    expect(verdict.reason).toMatch(/replaces too much/);
  });
});

describe('requestRequestsCommit', () => {
  it('recognises a request for a commit', () => {
    for (const request of [
      'commit these changes',
      'commit the work with a good message',
      'please commit it',
      'check in the changes',
    ]) {
      expect(requestRequestsCommit(request), request).toBe(true);
    }
  });

  it('does NOT treat unrelated or withheld asks as a commit request', () => {
    for (const request of [
      'write a 12 page story',
      'show me the diff',
      "don't commit yet, I want to review",
      'never commit without asking me',
      'how do I commit in this repo?',
      '',
    ]) {
      expect(requestRequestsCommit(request), request).toBe(false);
    }
  });
});

describe('requestRequestsPush — the outbound half of the commit rule', () => {
  it('recognises a request that names a push', () => {
    for (const request of [
      'push this to origin',
      'commit and push these changes',
      'push the branch to github',
      'push it',
    ]) {
      expect(requestRequestsPush(request), request).toBe(true);
    }
  });

  it('recognises a remote DESTINATION plus a commit-shaped intent, even without the word push', () => {
    // The live phrasing: the user asks for the work to land on GitHub and never
    // says "push" once.
    expect(requestRequestsPush('get this project committed to github')).toBe(true);
    expect(requestRequestsPush('commit this to the remote')).toBe(true);
    expect(requestRequestsPush('ship it to github.com')).toBe(true);
  });

  it('does NOT treat a LOCAL-ONLY commit request as push authorization', () => {
    // The load-bearing distinction: the user asked to record work, not to send
    // it anywhere — so no push may be inferred from it.
    for (const request of [
      'commit these changes',
      'commit it with a good message',
      'check in the changes',
      'write a 12 page story',
      'show me the diff',
      '',
    ]) {
      expect(requestRequestsPush(request), request).toBe(false);
    }
  });

  it('does NOT treat a withheld or merely-asked-about push as a request', () => {
    for (const request of [
      "don't push yet, I want to review",
      'never push without asking me',
      'do not push this anywhere',
      'how do I push to github?',
      'which remote should I push to?',
    ]) {
      expect(requestRequestsPush(request), request).toBe(false);
    }
  });
});

describe('isSurgicalEdit — the measurable line between a fix and a rewrite', () => {
  it('a small replacement inside a large file is surgical', () => {
    expect(isSurgicalEdit(2000, 40, 45)).toBe(true);
  });

  it('replacing most of a file is not', () => {
    expect(isSurgicalEdit(600, 400, 400)).toBe(false);
  });

  it('sits exactly on the documented fraction at the boundary', () => {
    const file = 1000;
    expect(isSurgicalEdit(file, file * EDIT_SURGICAL_MAX_FRACTION, 10)).toBe(true);
    expect(isSurgicalEdit(file, file * EDIT_SURGICAL_MAX_FRACTION + 1, 10)).toBe(false);
  });

  it('an empty file can never make an edit "surgical"', () => {
    expect(isSurgicalEdit(0, 10, 10)).toBe(false);
  });
});

describe('requestNamesPath — the evidence an edit gate measures', () => {
  it('recognises the basename, and the path', () => {
    expect(requestNamesPath('fix the bug in calc.ts', 'src/lib/calc.ts')).toBe(true);
    expect(requestNamesPath('update src/lib/calc.ts please', 'src/lib/calc.ts')).toBe(true);
    expect(requestNamesPath('the README.md is wrong', 'README.md')).toBe(true);
  });

  it('does not claim a file the request never mentioned', () => {
    expect(requestNamesPath('write a 12 page story', 'src/lib/calc.ts')).toBe(false);
    expect(requestNamesPath('', 'calc.ts')).toBe(false);
  });

  it('is literal — a fuzzy stem must not claim a file (that would turn a create into an overwrite)', () => {
    expect(requestNamesPath('write a story about a lamp', 'story.md')).toBe(false);
  });
});

describe('decideCliIntentConfirmation — which gated intents may be decided', () => {
  it('an irreversible LOCAL intent stays gated however the request is phrased', () => {
    for (const intent of IRREVERSIBLE_CLI_INTENTS) {
      // `publish` is the one documented exception: a request that RESOLVES to
      // the publish is the user's own decision (like a named git push), so it
      // proceeds. The local, irreversible intents stay gated.
      if (intent === 'publish') continue;
      const verdict = decideCliIntentConfirmation({ intent, namedByRequest: true });
      expect(verdict.action, intent).toBe('ask');
    }
  });

  it('a NAMED publish proceeds (the request is the decision), reported not silent', () => {
    const verdict = decideCliIntentConfirmation({ intent: 'publish', namedByRequest: true });
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toMatch(/manual cadence/);
  });

  it('a publish the MODEL chose still asks', () => {
    const verdict = decideCliIntentConfirmation({ intent: 'publish', namedByRequest: false });
    expect(verdict.action).toBe('ask');
  });

  it('the off-machine intents are exactly the publish-class ones', () => {
    expect([...EXTERNAL_CLI_INTENTS]).toEqual(['publish']);
  });

  it('a recoverable intent the user asked for is decided', () => {
    const verdict = decideCliIntentConfirmation({ intent: 'dashboard.stop', namedByRequest: true });
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toMatch(/manual cadence/);
  });

  it('a recoverable intent the MODEL chose still asks', () => {
    const verdict = decideCliIntentConfirmation({ intent: 'dashboard.stop', namedByRequest: false });
    expect(verdict.action).toBe('ask');
    expect(verdict.reason).toMatch(/agent's own initiative/);
  });

  it('an unclassified gated intent falls back to asking (the safe default)', () => {
    const verdict = decideCliIntentConfirmation({ intent: 'something.new', namedByRequest: true });
    expect(verdict.action).toBe('ask');
    expect(verdict.reason).toMatch(/not classified/);
  });
});

describe('manifest coverage — no gated intent inherits a behaviour by accident', () => {
  it('every confirmation-gated CLI intent is classified in exactly one table', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../src/resources/command-manifest.json', import.meta.url), 'utf-8'),
    ) as {
      intents: Array<{ intent: string; confirmation?: boolean; resolutions?: Array<{ confirmation?: boolean }> }>;
    };

    const gated = manifest.intents
      .filter(
        (i) =>
          i.confirmation === true || (i.resolutions ?? []).some((r) => r.confirmation === true),
      )
      .map((i) => i.intent);

    // The manifest is the gate's source of truth, so it must actually be gating
    // something — otherwise this test would pass vacuously.
    expect(gated.length).toBeGreaterThan(0);

    const irreversible = [...IRREVERSIBLE_CLI_INTENTS];
    const recoverable = [...RECOVERABLE_CLI_INTENTS];

    // No intent may appear in both tables, and none may be in neither.
    const both = irreversible.filter((i) => recoverable.includes(i));
    expect(both).toEqual([]);
    expect(gated.filter((i) => !irreversible.includes(i) && !recoverable.includes(i))).toEqual([]);

    // …and no table may claim an intent the manifest does not actually gate.
    expect(irreversible.filter((i) => !gated.includes(i))).toEqual([]);
    expect(recoverable.filter((i) => !gated.includes(i))).toEqual([]);
  });
});
