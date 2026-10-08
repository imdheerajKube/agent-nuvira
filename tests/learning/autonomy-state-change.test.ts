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
  EDIT_SURGICAL_MAX_FRACTION,
} from '../../src/learning/autonomy-policy.js';
import {
  CLI_INTENT_EFFECTS,
  declaredCliIntents,
  cliIntentGateFacts,
} from '../../src/learning/cli-intent-effects.js';

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
    // Read from the DECLARATIONS, not a list this test keeps in step by hand — the
    // property under test is "every intent declared irreversible is gated", which
    // must hold for intents added later without editing this test.
    const localIrreversible = CLI_INTENT_EFFECTS.filter(
      (e) => !e.reversible && e.grantCategory !== 'external',
    );
    expect(localIrreversible.length).toBeGreaterThan(0);
    for (const { intent } of localIrreversible) {
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

  it('the off-machine intents are exactly the ones declaring the external grant', () => {
    const external = CLI_INTENT_EFFECTS.filter((e) => e.grantCategory === 'external').map((e) => e.intent);
    expect(external).toEqual(['publish']);
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

  it('an UNCLASSIFIED gated intent falls back to asking (the safe default)', () => {
    const verdict = decideCliIntentConfirmation({ intent: 'something.new', namedByRequest: true });
    expect(verdict.action).toBe('ask');
    expect(verdict.reason).toMatch(/no declared effect/);
  });

  it('REPORTS the decision text plainly — no raw unicode escapes leak into the reason', () => {
    // The reason is user-facing prose; an escape that survives into the string
    // would be visible garbage in the transcript.
    const verdict = decideCliIntentConfirmation({ intent: 'publish', namedByRequest: true });
    expect(verdict.reason).not.toMatch(/\\u[0-9a-f]{4}/i);
    expect(verdict.reason).toContain('\u2019');
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

    const declared = declaredCliIntents();

    // EVERY gated intent has a declaration — a newly gated command cannot ship
    // without an effect, so it can never quietly inherit an unclassified default.
    expect(gated.filter((i) => !declared.includes(i))).toEqual([]);

    // …and every declaration corresponds to a real gate — a removed command
    // cannot leave a ghost behind.
    expect(declared.filter((i) => !gated.includes(i))).toEqual([]);

    // No duplicates, and no intent claiming two effects at once.
    expect(new Set(declared).size).toBe(declared.length);
    expect(CLI_INTENT_EFFECTS.filter((e) => !e.why.trim()).map((e) => e.intent)).toEqual([]);
  });

  it('a resolution-only gate is covered — the trap this guard exists for', () => {
    // `contacts.remove` is gated ONLY through `resolutions[].confirmation`, so a
    // check that reads the intent's own flag alone calls it a ghost. Pin that the
    // guard sees both forms AND that the declaration exists.
    const manifest = JSON.parse(
      readFileSync(new URL('../../src/resources/command-manifest.json', import.meta.url), 'utf-8'),
    ) as {
      intents: Array<{
        intent: string;
        confirmation?: boolean;
        resolutions?: Array<{ confirmation?: boolean }>;
      }>;
    };
    const entry = manifest.intents.find((i) => i.intent === 'contacts.remove')!;
    expect(entry).toBeDefined();
    expect(entry.confirmation).not.toBe(true);
    expect((entry.resolutions ?? []).some((r) => r.confirmation === true)).toBe(true);
    expect(declaredCliIntents()).toContain('contacts.remove');
  });
});

describe('cliIntentGateFacts — the derived view run_cli reads', () => {
  it('matches what the three retired sets used to say, intent for intent', () => {
    // The refactor's contract: a structural move, not a policy change. The OLD
    // membership is written down here once, so a future edit to the declarations
    // has to change behaviour CONSCIOUSLY rather than drift into it.
    const wasRecoverable = [
      'dashboard.stop',
      'gateway.stop',
      'health.selfheal',
      'memory.optimize',
      'cache.clear',
      'skills.uninstall',
      'contacts.remove',
      'permissions.disallow',
      'platform.remove',
      'cron.remove',
    ];
    for (const intent of wasRecoverable) {
      const facts = cliIntentGateFacts(intent);
      expect(facts.recoverable, intent).toBe(true);
      expect(facts.external, intent).toBe(false);
      expect(facts.grantCategory, intent).toBe('terminal');
    }

    for (const intent of ['history.clear', 'memory.prune', 'stats.cost.clear']) {
      const facts = cliIntentGateFacts(intent);
      expect(facts.recoverable, intent).toBe(false);
      // An irreversible local intent offers NO grant category, so no grant can be
      // offered for it at the friction point.
      expect(facts.grantCategory, intent).toBeUndefined();
    }

    const publish = cliIntentGateFacts('publish');
    expect(publish.external).toBe(true);
    expect(publish.grantCategory).toBe('external');
    // Off-machine is NEVER "recoverable" — that is what keeps a blanket request
    // from ever reaching it.
    expect(publish.recoverable).toBe(false);
  });

  it('treats an undeclared intent as ungrantable and unrecoverable', () => {
    expect(cliIntentGateFacts('something.new')).toEqual({ recoverable: false, external: false });
  });
});
