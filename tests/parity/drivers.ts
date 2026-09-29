/**
 * WS0 (#22) — the test-side ledger over the parity harness.
 *
 * THE DRIVERS MOVED INTO `src/parity/drivers.ts`. They used to live here and
 * reached the stub through `vi.spyOn` on the real engine, which made the harness
 * a test-only thing and left "is every surface at par?" a question CI alone
 * could answer. `nuvira parity run` needs to drive the same surfaces, so the
 * drivers became a `src` module and BOTH the CLI and this suite use the one
 * implementation — no second copy to drift.
 *
 * What stays here is the thing that is genuinely about the TESTS: `VERIFIED_CELLS`,
 * the set of capability × surface cells the cases below actually prove. It is
 * kept beside the tests that assert it, so a cell cannot be claimed here without
 * a case that makes it true.
 */

export {
  DRIVER_DEPTH,
  PARITY_PROVIDER_TYPE,
  PARITY_MODEL,
  PARITY_DRIVER_SURFACES,
  blockedDriver,
  createParityHarness,
  type ParityHarness,
} from '../../src/parity/drivers.js';

/**
 * The matrix cells the parity cases in this directory actually PROVE.
 *
 * Read by `capability-matrix.test.ts`, which asserts the matrix's unverified debt
 * equals everything else, and made true by `scenario-parity.test.ts`. Adding a
 * name here without a case that proves it turns the matrix into the thing WS0
 * exists to prevent.
 */
export const VERIFIED_CELLS: ReadonlySet<string> = new Set([
  // Proven by 'answers the same message the same way, and attributes it the same
  // way': every surface runs the real provider against the stub server at
  // transport depth and agrees on status, answer and the provider that served the
  // turn. The gateway reaches the engine through its own registry handler (no
  // engine injected), so its lazy import of the real ChatCommand is exercised too.
  'turn-parity@cli-chat',
  'turn-parity@dashboard-chat',
  'turn-parity@gateway-chat',
  // Proven by the same case, which asserts the FULL attribution triple agrees:
  // provider, model and transport. Each surface's driver reads the triple from
  // THAT SURFACE's own report (the engine's return, the console's result, the
  // command's result, the gateway's `inbound.chat` log record), so the claim is
  // about the surface handing the attribution on, not about the engine knowing.
  'run-attribution@cli-chat',
  'run-attribution@dashboard-chat',
  'run-attribution@gateway-chat',
  // Proven by the same case on the FIFTH surface: the driver drives the COMMAND's
  // own single-goal path (`runSingleGoal`) with the provider served by the shared
  // factory, so the same message produces the same status, answer, provider,
  // model and transport as the chat surfaces' loop turns.
  'turn-parity@cli-execute',
  'run-attribution@cli-execute',
  // Proven by the mixed run: with the child driven on the SAME provider id and
  // transport as the in-process surfaces, the comparison of all five surfaces is
  // at-par — status, answer, provider, model, transport and the ordered tool
  // calls, all agreeing.
  'turn-parity@subagent',
  // Proven by 'drives the real forked subagent and reads the identity the child
  // reported': the child announces provider/model/transport before it can fail
  // and the manager records them on the run, so the surface genuinely reports the
  // triple it was served by.
  'run-attribution@subagent',
  // ALL FIVE surfaces report the executed call and its outcome, through their own
  // seams: the CLI through the engine's onToolCall, the dashboard through the
  // console event stream, the gateway through its `inbound.chat` log, the command
  // through the loop's per-call `{ tool, ok }` outcomes, and the child through its
  // `tool_call` → `tool_result` progress frames. Proven by 'reports the same tool
  // call, with the same outcome, on every surface'.
  'tool-call-lifecycle@cli-chat',
  'tool-call-lifecycle@dashboard-chat',
  'tool-call-lifecycle@gateway-chat',
  'tool-call-lifecycle@cli-execute',
  'tool-call-lifecycle@subagent',
  // ALL FIVE surfaces report a finding their turn recorded — the claim, the
  // outcome, the evidence and the verdict the GATE computed — through their own
  // seams: the CLI result + `onFinding`, the command's own result, the console's
  // result, the gateway's `inbound.chat` record, and the child's `finding`
  // progress frame. Proven by the pair of WS1 scenarios in
  // `scenario-parity.test.ts`: 'finding-confirmed' (usable evidence ⇒ CONFIRMED,
  // with the evidence carried) and 'finding-refused' (a blank reference ⇒ the
  // promotion is refused, so every surface must report PLAUSIBLE). The second is
  // the load-bearing one: a surface agreeing on a CONFIRMED verdict that no
  // evidence earned is exactly the false-success shape this workstream closes.
  'findings-verdicts@cli-chat',
  'findings-verdicts@dashboard-chat',
  'findings-verdicts@gateway-chat',
  'findings-verdicts@cli-execute',
  'findings-verdicts@subagent',
]);
