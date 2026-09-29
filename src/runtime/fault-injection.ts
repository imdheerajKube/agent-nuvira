/**
 * WS6 (#28) — fault injection.
 *
 * WHY THIS IS TEST INFRASTRUCTURE AND NOT A MATRIX ROW. `src/parity/matrix.ts`
 * says it in one line: fault injection is not a capability a surface can have, so
 * it has no cells and no parity verdict of its own. What it DOES have is a job —
 * make a dependency fail ON PURPOSE, deterministically, on every surface, so the
 * honest answer to a failure can be measured instead of assumed. The whole
 * truthfulness workstream exists because a failure reported as success is the one
 * defect an agent cannot recover from, and nothing measures that shape as well as
 * a fault that is declared in advance and cannot be confused with a real outage.
 *
 * TWO HALVES, and keeping them apart is the design:
 *
 *   1. THE WIRE (no production code involved). A parity scenario declares
 *      `fault: { site: 'provider', kind: 'error', times: Infinity }` and the
 *      harness's own loopback stub answers 500 / malformed JSON / 503. The REAL
 *      adapter's error mapping runs, the model call still happens (so the
 *      harness's "the turn must have reached a model" rule holds), and every
 *      surface must report the same failure. This is where a provider fault is
 *      proven, because the adapter — not this module — is what a user's real
 *      outage exercises.
 *
 *   2. THE SEAM (this module). `NUVIRA_INJECT_FAULT=provider:error:2` or
 *      `tool:error:list_dir` makes the running agent fail one of its own
 *      dependencies, in-process, for a live run, a demo, or a test that wants a
 *      fault without a stub server. OFF BY DEFAULT AND FREE WHEN OFF: with the
 *      variable unset, `activeFaultInjector()` returns null and nothing is
 *      wrapped — `ProviderFactory.createProvider` hands back the very same object
 *      it always did, so no run that did not ask for a fault is affected.
 *
 * THE ONE RULE THAT MAKES IT USEFUL: an injected fault must never look like a
 * real one. Every message this module produces says, in the text the model and
 * the operator both read, that the failure was declared and where the declaration
 * came from. A fault that could be mistaken for a genuine outage would corrupt
 * exactly the evidence it was injected to gather.
 *
 * A TYPO IS NOT A SILENT NO-OP. A declaration that cannot be parsed THROWS. The
 * alternative — ignoring it and running the turn unfaulted — would let a demo or
 * a test "prove" failure handling while nothing ever failed, which is the same
 * class of lie this repo has spent a workstream removing.
 */

import type { InferenceProvider } from '../inference/interface.js';

/** The environment variable that declares a fault. Unset (the default) = no fault. */
export const FAULT_ENV = 'NUVIRA_INJECT_FAULT';

/**
 * Where a fault is injected.
 *
 *  - `provider` — the model call itself (a request that fails, or a response that
 *                 cannot be parsed).
 *  - `tool`     — one tool call (`match` names it; absent = the next call).
 *  - `ipc`      — the child process boundary (the child exits before it works).
 */
export type FaultSite = 'provider' | 'tool' | 'ipc';

/**
 * What kind of failure to inject.
 *
 *  - `error`       — the call fails outright (HTTP 500 / a thrown provider error).
 *  - `malformed`   — the call "succeeds" with a body nothing can parse.
 *  - `unavailable` — the backend reports itself temporarily unavailable (503).
 */
export type FaultKind = 'error' | 'malformed' | 'unavailable';

/** A declared fault: what to break, and how many times. */
export interface FaultPlan {
  site: FaultSite;
  kind: FaultKind;
  /**
   * How many matching calls to fail. `1` is the default a bare declaration means,
   * `Infinity` fails every matching call (what a parity row wants: a turn that
   * recovers from a transient fault and one that reports it are both honest, and a
   * row that cannot tell which happened measures neither).
   */
  times: number;
  /** The tool name to match (`site: 'tool'`). Absent = every tool call. */
  match?: string;
}

/** One fault that actually fired. */
export interface FaultFiring {
  site: FaultSite;
  kind: FaultKind;
  /** What was about to run: a provider method, a tool name, or `child`. */
  subject: string;
  /** The text every consumer reads. Names the declaration, so it cannot be mistaken for a real outage. */
  message: string;
}

const SITES: readonly FaultSite[] = ['provider', 'tool', 'ipc'];
const KINDS: readonly FaultKind[] = ['error', 'malformed', 'unavailable'];

function isSite(value: string): value is FaultSite {
  return (SITES as readonly string[]).includes(value);
}

function isKind(value: string): value is FaultKind {
  return (KINDS as readonly string[]).includes(value);
}

/**
 * Render a plan back to the declaration form the environment carries.
 *
 * The round trip matters: the harness declares a scenario's fault by writing this
 * string into the environment, and a failure report shows the same string, so an
 * operator can copy it straight into a shell.
 */
export function formatFaultPlan(plan: FaultPlan): string {
  const parts: string[] = [plan.site, plan.kind];
  const finite = Number.isFinite(plan.times) ? plan.times : Number.POSITIVE_INFINITY;
  // Only spelled out when it is not the bare default, so `tool:error` stays short.
  if (finite !== 1 || plan.match) parts.push(finite === Number.POSITIVE_INFINITY ? 'all' : String(finite));
  if (plan.match) parts.push(plan.match);
  return parts.join(':');
}

/**
 * Parse `site:kind[:times|all[:match]]`.
 *
 * Accepts `off`/`none`/`0` as "no fault" (an easy way for a script to switch one
 * off without unsetting the variable). Anything else that does not parse THROWS —
 * see the header: a declaration that silently injects nothing is worse than no
 * declaration at all.
 */
export function parseFaultPlan(raw: string | undefined | null): FaultPlan | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (lowered === 'off' || lowered === 'none' || lowered === '0') return null;

  const parts = text.split(':').map((part) => part.trim());
  const [siteRaw, kindRaw, third, fourth] = parts;
  if (!siteRaw || !kindRaw || !isSite(siteRaw) || !isKind(kindRaw)) {
    throw new Error(
      `Invalid ${FAULT_ENV} declaration ${JSON.stringify(text)}: expected ` +
        `<site>:<kind>[:<times|all>[:<match>]] where site is one of ${SITES.join(', ')} ` +
        `and kind is one of ${KINDS.join(', ')}. Use \`off\` to disable.`,
    );
  }

  let times = 1;
  let match: string | undefined;
  if (third !== undefined && third !== '') {
    // ORDER MATTERS, and it was measured: `all` has to be recognised as a COUNT
    // before the "not a number, so it must be a tool name" rule runs, because
    // `Number('all')` is NaN — the first version of this parser read
    // `tool:error:all:read_file` as "one call, matching the tool named `all`".
    const parsed = Number(third);
    if (third.toLowerCase() === 'all' || third === '*') {
      times = Number.POSITIVE_INFINITY;
    } else if (!Number.isNaN(parsed)) {
      if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
        throw new Error(
          `Invalid ${FAULT_ENV} declaration ${JSON.stringify(text)}: times must be a positive ` +
            `integer or \`all\` (got ${JSON.stringify(third)}).`,
        );
      }
      times = parsed;
    } else if (siteRaw === 'tool') {
      match = third;
    } else {
      throw new Error(
        `Invalid ${FAULT_ENV} declaration ${JSON.stringify(text)}: times must be a positive ` +
          `integer or \`all\` (got ${JSON.stringify(third)}).`,
      );
    }
  }
  if (fourth !== undefined && fourth !== '') {
    if (siteRaw !== 'tool') {
      throw new Error(
        `Invalid ${FAULT_ENV} declaration ${JSON.stringify(text)}: only \`tool\` faults take a ` +
          `tool name to match (got ${JSON.stringify(fourth)} on a \`${siteRaw}\` fault).`,
      );
    }
    match = fourth;
  }

  return match ? { site: siteRaw, kind: kindRaw, times, match } : { site: siteRaw, kind: kindRaw, times };
}

/** The declared fault for this process, or null. Throws on a malformed declaration. */
export function faultPlanFromEnv(env: Record<string, string | undefined> = process.env): FaultPlan | null {
  return parseFaultPlan(env[FAULT_ENV]);
}

/**
 * The message a fired fault carries into the tool result / provider error.
 *
 * Names the declaration and the subject, and says PLAINLY that it was injected —
 * every consumer of this text (the model included) must be able to tell a
 * declared fault from a real failure.
 */
export function faultMessage(plan: FaultPlan, subject: string): string {
  const what =
    plan.kind === 'malformed'
      ? `returned a response nothing could parse`
      : plan.kind === 'unavailable'
        ? `reported itself unavailable`
        : `failed`;
  return (
    `injected ${plan.site} fault: ${subject} was made to ${what} ON PURPOSE ` +
    `(${FAULT_ENV}=${formatFaultPlan(plan)}). This is a declared fault, not a real ${plan.site} failure.`
  );
}

/**
 * A counting injector for one declaration.
 *
 * `at()` is the whole API: it answers "should this call fail?", and returns null
 * once the declaration's allowance is spent. Counting (rather than a boolean) is
 * what makes `times` mean anything — and it is also the evidence a caller needs:
 * a declared fault that never fired is a fault that measured nothing.
 */
export class FaultInjector {
  private remaining: number;
  private readonly firings: FaultFiring[] = [];

  constructor(readonly plan: FaultPlan) {
    this.remaining = plan.times;
  }

  /** How many times this injector has fired so far. */
  get fired(): number {
    return this.firings.length;
  }

  /** What fired, in order — for a report or an assertion. */
  get history(): readonly FaultFiring[] {
    return [...this.firings];
  }

  /** True when the declaration's allowance is spent. */
  get exhausted(): boolean {
    return this.remaining <= 0;
  }

  /**
   * Ask whether the call about to run should fail instead.
   *
   * Consumes one firing when it answers yes. A site that does not match — or a
   * tool name that does not match — is never consumed, so `tool:error:read_file`
   * does not spend its allowance on the writes around it.
   */
  at(site: FaultSite, subject: string): FaultFiring | null {
    if (site !== this.plan.site) return null;
    if (this.plan.match !== undefined && this.plan.match !== subject) return null;
    if (this.remaining <= 0) return null;
    this.remaining -= 1;
    const firing: FaultFiring = {
      site,
      kind: this.plan.kind,
      subject,
      message: faultMessage(this.plan, subject),
    };
    this.firings.push(firing);
    return firing;
  }
}

/** Build an injector for a plan. Off (null) when there is no plan. */
export function createFaultInjector(plan: FaultPlan | null | undefined): FaultInjector | null {
  return plan ? new FaultInjector(plan) : null;
}

let cached: { raw: string | undefined; injector: FaultInjector | null } | null = null;

/**
 * The injector for the CURRENT declaration, rebuilt when the declaration changes.
 *
 * Cached so one declaration's `times` is spent across the whole turn rather than
 * reset per call, and keyed on the raw string so a caller that re-declares a fault
 * (the parity harness does, once per surface) gets a fresh allowance without
 * having to know this cache exists.
 */
export function activeFaultInjector(env: Record<string, string | undefined> = process.env): FaultInjector | null {
  const raw = env[FAULT_ENV];
  if (cached && cached.raw === raw) return cached.injector;
  cached = { raw, injector: createFaultInjector(faultPlanFromEnv(env)) };
  return cached.injector;
}

/** Forget the cached injector — call after changing the declaration (tests, the harness). */
export function resetFaultInjector(): void {
  cached = null;
}

/** Should the call about to run fail? The one-liner the seams call. */
export function faultAt(site: FaultSite, subject: string): FaultFiring | null {
  return activeFaultInjector()?.at(site, subject) ?? null;
}

/**
 * Wrap a provider so declared `provider` faults fail its model calls.
 *
 * TWO PROPERTIES, and both are load-bearing:
 *
 *   - ONLY WHEN A DECLARATION EXISTS. With no `NUVIRA_INJECT_FAULT`, the provider
 *     is returned UNCHANGED — same object, not a transparent copy — so a run that
 *     asked for nothing cannot be affected by this module.
 *   - ONLY THE METHODS THAT EXIST. `generateTools` is optional (`InferenceProvider`)
 *     and its PRESENCE is how the loop picks the native transport over the JSON
 *     fallback (`child-agent-runtime.ts:181`). Adding it to a provider that lacks
 *     it would silently change the transport a run was measured on, so an absent
 *     method stays absent.
 */
export function withFaultInjection(
  provider: InferenceProvider,
  injector: FaultInjector | null = activeFaultInjector(),
): InferenceProvider {
  if (!injector || injector.plan.site !== 'provider') return provider;

  const modelMethods = ['generate', 'generateTools', 'generateToolsStream'] as const;
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && (modelMethods as readonly string[]).includes(prop)) {
        const original = Reflect.get(target, prop, target) as unknown;
        if (typeof original !== 'function') return original;
        return async (...args: unknown[]): Promise<unknown> => {
          const firing = injector.at('provider', prop);
          if (firing) throw new Error(firing.message);
          return (original as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** What the seam can inject, for the CLI's `parity faults` listing. */
export function describeFaultProtocol(): string[] {
  return [
    `Declaration: ${FAULT_ENV}=<site>:<kind>[:<times|all>[:<tool name>]]`,
    `  sites: ${SITES.join(', ')}   kinds: ${KINDS.join(', ')}   times: 1 (default), N, or all`,
    '',
    '  provider:error           the next model call fails (HTTP 500 / a thrown provider error)',
    '  provider:malformed:all   every model call returns a body nothing can parse',
    '  provider:unavailable     the backend reports itself temporarily unavailable (503)',
    '  tool:error:list_dir      the next list_dir call fails, and reports why',
    '  tool:error:2             the next two tool calls fail',
    '  ipc:error                the forked child exits before it does any work',
    '  off                      no fault (the default when the variable is unset)',
    '',
    'A declaration that cannot be parsed THROWS rather than running unfaulted, and every',
    'message names the declaration, so an injected fault can never be mistaken for a real one.',
  ];
}
