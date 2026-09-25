/**
 * Credentials that grant a REAL, outward action — and the rule that they must
 * never reach a test process.
 *
 * WHY THIS EXISTS. It is the reason agent-nuvira could not publish its own
 * release, and the reason the failure looked inexplicable for three attempts.
 *
 * The release pipeline spawns `npm test` with its own environment, and the
 * credential store loads that environment from `~/.nuvira/.env` — so the test
 * process inherited the operator's LIVE provider keys (GROQ, GEMINI, NVIDIA NIM,
 * OPENROUTER) along with Twilio / Slack / Telegram tokens and AWS/Bedrock
 * credentials. Tests that are conditioned on a key being present — correctly, so
 * that someone with a key can exercise the real path — then woke up and took a
 * real network path. MEASURED: the same 350 files that are green in a shell
 * without those keys (349 passed, 99-133s, twice) produced 7 failed files with
 * 25 x `Test timed out in 15000ms` when run with the release's environment
 * (363s). Phase 1 therefore failed every release attempt on an environment
 * difference that left no trace in its own output.
 *
 * The fix is deliberately at BOTH ends:
 *   - the SUITE strips these keys (`tests/setup/hermetic-env.ts`) so no test can
 *     reach a live provider or send a real message, no matter who starts it; and
 *   - the PIPELINE spawns the suite without them (`runTestsPhase`), because
 *     handing live credentials to a process whose job is to not use them is the
 *     pipeline's own bug.
 * A test that genuinely needs a key sets one itself, as the credential tests
 * already do.
 *
 * The release's OWN git/npm credentials are stripped from the suite as well, and
 * the measurement is the reason. `IssueTriageAgent.detectSource` infers `github`
 * from the presence of a GitHub token, so `should detect auto when no keyword
 * matches` returned `github` and failed — under the release, which must hold
 * `GITHUB_TOKEN` to push, that is EVERY release. A test that needs a token now
 * provides its own: the credential tests already set and delete these in their
 * `beforeEach` (see tests/agents/credential-store.test.ts), so nothing depends on
 * inheriting them.
 */

import { PROVIDER_CATALOG } from '../inference/provider-catalog.js';

/** Provider keys that are not in the catalog (legacy or bespoke). */
const EXTRA_PROVIDER_ENV_KEYS = ['TOKENRA_API_KEY', 'AZURE_OPENAI_ENDPOINT'];

/**
 * The release's own credentials. Not "side effects" in the same sense — they are
 * how the release pushes and publishes — but a test process must not inherit
 * them either: their mere PRESENCE changes behaviour (see the note above).
 */
const RELEASE_CREDENTIAL_ENV_KEYS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_API_KEY',
  'GIT_USERNAME',
  'NPM_TOKEN',
];

/** Credentials that can cause an outward action: send a message, spend money. */
const SIDE_EFFECT_ENV_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'SLACK_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_TOKEN',
  'WHATSAPP_SELF_CHAT',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN',
  'BEDROCK_REGION',
];

/**
 * Every provider API key the catalog knows about, derived rather than copied —
 * a hardcoded list here would silently fall behind the providers being added.
 */
export const PROVIDER_CREDENTIAL_ENV_KEYS: string[] = [
  ...new Set([
    ...Object.values(PROVIDER_CATALOG)
      .map((provider) => provider.envVar)
      .filter((name): name is string => Boolean(name)),
    ...EXTRA_PROVIDER_ENV_KEYS,
  ]),
].sort();

/** {@link SIDE_EFFECT_ENV_KEYS}, exported for the tests that pin the list. */
export const SIDE_EFFECT_CREDENTIAL_ENV_KEYS: string[] = [...SIDE_EFFECT_ENV_KEYS];

/**
 * One base key plus the `NUVIRA_` / `BUFF_` spellings the resolvers accept:
 * `TELEGRAM_TOKEN` is also read as `NUVIRA_TELEGRAM_TOKEN`, and a split pair
 * (one spelling stripped, the other kept) would leave the live key reachable.
 */
function withPrefixedAliases(keys: string[]): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    out.add(key);
    out.add(`NUVIRA_${key}`);
    out.add(`BUFF_${key}`);
  }
  return [...out];
}

/** The keys {@link stripTestUnsafeEnv} removes, sorted. */
export const TEST_UNSAFE_ENV_KEYS: string[] = withPrefixedAliases([
  ...PROVIDER_CREDENTIAL_ENV_KEYS,
  ...SIDE_EFFECT_ENV_KEYS,
  ...RELEASE_CREDENTIAL_ENV_KEYS,
]).sort();

/**
 * A COPY of `env` without the credentials above — for spawning a child (the
 * release spawns the suite) without mutating this process's own environment.
 */
export function stripTestUnsafeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of TEST_UNSAFE_ENV_KEYS) delete copy[key];
  return copy;
}

/**
 * Remove the credentials above from `env` IN PLACE, returning the names that were
 * actually present — so a suite can report what it closed rather than assuming.
 */
export function deleteTestUnsafeEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const key of TEST_UNSAFE_ENV_KEYS) {
    if (env[key] !== undefined) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}
