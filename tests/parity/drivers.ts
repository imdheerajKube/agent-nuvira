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
  // WS2 (#24). ALL FIVE surfaces write a session debug log for a turn and read
  // it back FROM DISK with the same backend in the header — provider, model and
  // transport. Each surface opens its log at its own seam (`cli/chat.ts`,
  // `cli/loop-executor.ts` and the child runtime, with the console and the
  // gateway passing their identity down to the shared chat engine), and the
  // harness turns logging on for the whole run so "wrote a log" is an assertion
  // rather than a thing that happened to be true. Proven by 'writes a session
  // debug log whose header names the backend, on every surface'.
  'debug-log@cli-chat',
  'debug-log@dashboard-chat',
  'debug-log@gateway-chat',
  'debug-log@cli-execute',
  'debug-log@subagent',
  // WS3 (#25). ALL FIVE surfaces export a turn over OTLP when `NUVIRA_OTEL=1`,
  // with the SAME tree: `nuvira.turn` with one `nuvira.tool.<name>` child per call
  // that actually ran, one trace id, service `agent-nuvira`. Each driver boots a
  // real loopback collector and reads the request bodies it received, so the claim
  // is measured on the wire rather than on a mocked exporter; the harness turns
  // export on for the run and resets the provider between surfaces, so "this
  // surface exported" is an assertion rather than a thing that happened to be
  // true. The forked child inherits the collector endpoint through its environment
  // and exports its OWN spans from its OWN process. Proven by the `otel-export`
  // scenario case in `scenario-parity.test.ts` (the tree on all five, at-par) and
  // by the fork case that asserts the child`s remote parent is the parent`s tool
  // span and that both share one trace id.
  'otel-export@cli-chat',
  'otel-export@dashboard-chat',
  'otel-export@gateway-chat',
  'otel-export@cli-execute',
  'otel-export@subagent',
  // WS4 (#26). ALL FIVE surfaces run the operator`s declared tool hooks — a real
  // command that receives the call as JSON on stdin — and HONOUR a veto, through
  // their own seams: `src/tools/tool-loop.ts` for the four in-process surfaces
  // (each handing the loop its own label) and `src/tools/child-agent-runtime.ts`
  // for the forked child, which resolves the same declarations in its own process
  // and reports a broken hook on its own progress frame. The harness declares the
  // hooks per scenario (a real script it writes and points at a log), so "this
  // surface ran the hook" is an assertion rather than a thing that happened to be
  // true. Proven by the three WS4 scenarios in `scenario-parity.test.ts`:
  // `tool-hooks` (before+after fire on a successful call), `tool-hook-veto` (the
  // same call, with the hook denying it — the differential that shows a decision
  // that was returned is a decision that was OBEYED) and `failing-tool-call`
  // (before+failed fire, and `after` does not, for a call that ran and failed).
  'tool-hooks@cli-chat',
  'tool-hooks@dashboard-chat',
  'tool-hooks@gateway-chat',
  'tool-hooks@cli-execute',
  'tool-hooks@subagent',
  // WS5 (#27). ALL FIVE surfaces isolate a turn in a real git worktree when the
  // harness declares `NUVIRA_ISOLATE` — each in its own way: the four in-process
  // surfaces create the worktree around the turn they are about to run
  // (`cli/chat.ts` for the CLI answer, the dashboard console and the gateway,
  // `cli/loop-executor.ts` for the execute loop arm), and the SUBAGENT's worktree
  // is made by the PARENT (`tools/subagent-spawner.ts`), which forks the child into
  // it and measures the diff itself. The scenario CREATES A FILE through
  // `run_terminal` so the diff is non-empty (see the scenario's own note for why not
  // `write_file`), and the assertions are on the values: the file the turn changed,
  // removal of the directory, and the base commit sha. Proven by 'isolates the turn
  // in a git worktree and reports the diff, on every surface'.
  'isolation-worktree@cli-chat',
  'isolation-worktree@dashboard-chat',
  'isolation-worktree@gateway-chat',
  'isolation-worktree@cli-execute',
  'isolation-worktree@subagent',
  // WS5 (#27). ALL FIVE surfaces replay the unchanged steps of a resumed run
  // instead of re-paying for them. The harness runs the same ask twice — the first
  // turn writes the step record, the second replays it — and compares what the
  // second turn did NOT pay for, on every surface: the four in-process ones through
  // the shared loop (`tools/tool-loop.ts`), and the forked child through its own
  // loop and its own store (`tools/child-agent-runtime.ts`), whose per-step report
  // reaches the parent on a progress frame. The record is NAMED per surface by the
  // harness, which is both how an operator resumes a specific run and what keeps one
  // surface's probe from replaying another's record. Proven by 'replays the unchanged
  // steps of a resumed run instead of re-paying, on every surface'.
  'partial-resume@cli-chat',
  'partial-resume@dashboard-chat',
  'partial-resume@gateway-chat',
  'partial-resume@cli-execute',
  'partial-resume@subagent',
]);
