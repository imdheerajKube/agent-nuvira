# Background duties and the daemon question

> Status: **design + what is already shipped.** Phase 0 (duty leases) is in the
> tree. Phases 1–4 are proposals with explicit entry criteria, cost, and a
> "what this buys" statement — no phase is a prerequisite for the product
> working, which is the property that lets them land one at a time.

## The question this answers

> *Today there is no daemon between CLI runs. Does that design cover process
> management, PID files, service registration, restart handling and crash
> recovery — and could it carry a persistent model registry, long-lived caches,
> agent task queues, background indexing, file watching, shared model sessions
> and project workspace state?*

Short answer:

* **Process management / PID files / service registration** — partially exist
  already (`nuvira gateway start --supervise`, `nuvira dashboard stop`, port +
  command-line PID discovery in `src/cli/process-control.ts`, and an in-process
  `DaemonPool`). What was genuinely missing for *duties* is **ownership**: which
  process is allowed to do this work right now. That is Phase 0, and it is
  shipped.
* **Restart handling / crash recovery** — the lease's **steal-after-stale** is
  the crash recovery primitive (a dead holder's lease expires and is taken, and
  the take is *reported*). A supervisor adds restart *of a long-lived process*,
  which only matters once a process exists that is worth restarting.
* **The workload list** — most of it does **not** need a daemon, and one item
  (shared model sessions) should be **refused** rather than built. The per-item
  verdict, with what already exists, is in
  [§ Workload by workload](#workload-by-workload).

## The design principle

Five rules, in priority order. Everything below follows from them, and a
proposal that breaks one is rejected rather than scheduled.

1. **State lives on disk; processes are disposable.** Every consumer reads the
   same files it reads today. A daemon is an *optimization for cadence*, never a
   dependency for correctness. This is what makes `nuvira` work with no daemon
   at all, and what lets the phases below land independently.
2. **One writer per duty, enforced by the filesystem, not by convention.**
   `open(path, 'wx')` is the primitive: exactly one caller anywhere wins it.
   Staleness (mtime) is what expires a dead holder's claim; a pid is
   *diagnostics*, never a correctness input (pid reuse makes "is it alive"
   unsafe).
3. **A daemon is a cadence, not a warehouse.** Only work that needs *continuous
   time* gets a process. Anything that is a pure read, a cache, or a
   request/reply gets a file — a daemon would add a dependency and remove
   nothing.
4. **Freeze/thaw, not live sessions.** A conversation is state on disk. Two
   processes sharing one live conversation needs conflict semantics the project
   does not have; the failure mode (two agents editing one workspace) is worse
   than the cost it removes.
5. **Every duty must be safe to run twice and safe to never run.** Idempotent +
   bounded, so losing a race or a holder never produces a wrong answer — at
   worst a duty happens later.

## What already exists (measured, not assumed)

| Capability | Where | Honest state |
|---|---|---|
| Supervisor for a long-lived foreground process | `nuvira gateway start --supervise`, `src/cli/gateway.ts` | **Exists.** Parent restarts the child; SIGTERM is forwarded. |
| PID discovery | `src/cli/process-control.ts` — port probe (`findPidOnPort`) + `ps`/`wmic`/PowerShell command-line match | **Exists.** Not a pid *file*: it re-derives the pid, which is robust to a stale file. |
| Stop / grace / SIGKILL escalation | `stopProcess()`, `nuvira gateway stop`, dashboard Shutdown button | **Exists.** |
| Spawn + auto-restart + health check | `src/tools/daemon-pool.ts` (`DaemonPool`) | **Exists, in-process.** The pool is the parent's; it dies with the parent and does not survive a terminal close. |
| Process bookkeeping for spawned children | `src/tools/process-registry.ts`, `src/tools/subagent-spawner.ts`, `src/mcp/mcp-watchdog.ts` | **Exists.** |
| Throttled session-start duties | `src/cli/duties.ts` (`~/.nuvira/duties-last-run.json`) | **Exists**, single-machine throttle. |
| Cadence loops | `startWarmupDaemon` (`model-warmup.ts`), `startRegistryWatcher` (`model-probe.ts`), gateway `cron.ts`, deferred-task drain | **Exists**, each owned by whichever process is alive. |
| Persisted work queues | `src/learning/deferred-task.ts`, `src/learning/unattended-job.ts` | **Exists** as JSON + a drain loop; the *drain owner* is "whoever happens to be running". |
| SQLite (WAL) shared state | `src/config/workspace.ts` — `node:sqlite` `DatabaseSync`, `PRAGMA journal_mode = WAL`, JSON fallback tier when unavailable | **Exists.** Zero new dependencies: `node:sqlite` is a builtin (Node ≥ 22.5). |
| Directory watching | dashboard server watches the memory dir (`watch(MEMORY_DIR, …)`) | **Exists** for one directory. |
| Cross-process duty ownership | `src/learning/duty-lease.ts` | **Phase 0 — shipped in this change.** |

`src/tools/async-delegation.ts` advertises "daemon executor … crash recovery via
SQLite" in its header; the implementation persists nothing (no `node:sqlite`,
no file store). Treat that header as stale documentation, not as capability.

## Phase 0 — duty leases (shipped)

`src/learning/duty-lease.ts` + `NUVIRA_DUTY_DIR`/`NUVIRA_DUTY_LEASE_STALE_MS`.

* One exclusive-create lease per named duty, in `<memory dir>/duties/`.
* **Steal after stale**: an un-renewed lease older than the window is broken and
  re-taken, reported as `stole: true`.
* **Renewal** for a duty that legitimately outlives the window (a warmup cycle
  can be 20 real generations); `renewDutyLease` refuses if the lease is no
  longer ours, so a stolen-from process stops rather than racing.
* **Release refuses a foreign lease** — a process whose lease was stolen cannot
  delete the new holder's on the way out.
* Wired into the two duties where the waste was measured: the warmup sweep
  (`runWarmupCycle`, all four callers) and the session-start checks
  (`maybeRunBackgroundDuties`). The throttle is only marked *after* the lease is
  won, so a losing process does not spend the window for everyone else.
* `nuvira models warm` — the **manual trigger** that makes the cadence
  user-drivable instead of something you wait for, and it goes through the same
  lease (so it can never double-spend against a background cycle).

Why this is the right first step and not a daemon: it is the smallest thing that
removes the measured waste (two processes sweeping the same candidate list, on
the user's free tier, is the exact traffic that turns warmup into 429s), it
needs no supervisor, and it is the piece a supervisor would need first.

## Phase 1 — one supervisor, `nuvira daemon`

**Entry criteria.** A duty exists whose value depends on running *while no user
process is alive* (the deferred queue is the first candidate, see Phase 2), or a
measured complaint that a duty's cadence is unreliable.

What it adds on top of `DaemonPool`:

* **PID file** at `<config dir>/daemon.pid` — written by the daemon itself
  *after* it has bound everything it needs, and validated on read by comparing
  the pid to a live process whose command line matches. A pid file that is only
  written is a licence to kill the wrong process.
* **Heartbeat** — a `<memory>/daemon-heartbeat.json` updated once per tick with
  the duty it is on. `nuvira daemon status` reads it and reports the age; a
  heartbeat older than N ticks is *stale*, which is a fact the user can act on.
* **Service registration** — an *explicit, opt-in* `nuvira daemon install`
  that writes a launchd plist (macOS) / systemd user unit (Linux) / Task
  Scheduler entry (Windows). Never automatic: registering a login item is a
  system-wide change and is the user's decision, not ours.
* **Restart handling** — reuse `--supervise`'s shape (parent restarts child,
  forwards SIGTERM), with a restart budget and backoff so a crash loop is
  visible rather than a spin.
* **Logs** — the existing gateway log path and rotation, one file for the
  daemon; `nuvira daemon logs` tails it.

**What it explicitly does NOT do.** It is not a warehouse: it holds no state a
reader needs. `nuvira models status`, the dashboard and the router keep reading
files, so the daemon being down degrades *freshness*, never correctness.

## Phase 2 — the queues get a guaranteed drainer

The deferred-retry queue and the unattended-job queue are already persisted and
already drain. Their weakness is that the drain runs in whichever process
happens to be alive — for a messaging turn that is the gateway, which is the
normal case only because the gateway is usually up.

* The supervisor ticks the drains (and takes each drain's duty lease).
* A drain that a foreground process also triggers is unchanged: the lease makes
  the second one a no-op instead of a double-run.
* **Exit criteria:** a queued task survives "user closes every terminal", and
  `nuvira daemon status` says when each queue was last drained and what is due.

This is the phase where the daemon earns its keep — it is the first workload
whose *definition* includes "runs when nothing else is".

## Phase 3 — SQLite (WAL) as the shared state store, still no daemon

Several JSON files are written by more than one process today (registry mirror,
quota ledger, routing history, bandit state, cost ledger, action telemetry).
`atomic-store.ts` makes a single write atomic, and the registry re-loads before
it flushes, but the failure mode a multi-process system always has — *lost
update* — is still reachable.

The project already has the answer, in `src/config/workspace.ts`: `node:sqlite`
`DatabaseSync` with `PRAGMA journal_mode = WAL` and a JSON fallback tier when
the builtin is unavailable. WAL is exactly right here: many readers, one writer
at a time, no reader blocked by the writer.

* Move the hot, multi-writer stores behind a small DAL with the same
  read-through shape they have now (`getEntry`, `recordCall`, `preferredModelsFor`
  keep their signatures).
* Keep the JSON tier as the fallback, so a Node without `node:sqlite` behaves
  exactly as today.
* **Not a daemon.** A daemon would make every read a round trip and every
  outage fatal; a WAL file makes them correct.

## Phase 4 — background indexing and project file watching

Both need *an owner that outlives a turn*, and both are resumable work, which is
what makes them daemon-shaped:

* **Watching**: reuse the dashboard's `watch()` pattern, but per *project
  workspace* rather than the memory dir, with debounce, the existing ignore
  machinery, and a hard cap on watched directories. A watcher storm on a large
  repo is the failure mode to design against, not an afterthought.
* **Indexing**: checkpoint progress in the WAL store (§Phase 3) so a killed
  daemon resumes instead of re-embedding a whole tree. Bounded per tick, and it
  must never hold the routing path's writer lock.
* **Exit criteria:** closing the terminal does not lose indexing progress, and
  the watcher's CPU cost is capped and reported in `daemon status`.

## Workload by workload

| Workload | Verdict | Why |
|---|---|---|
| **Persistent model registry** | **Already done without a daemon** | It is a disk mirror (`model-registry.json`) re-read per call, with a JSONL action log and a vector mirror. "Persistent" is the file; the *cadence* (probe/spot-check) is `models refresh` / `models watch` / the warmup sweep — the warmup part is now lease-guarded and manually drivable (`models warm`). |
| **Long-lived caches** (context, reasoning, response, routing, embeddings) | **Do it in Phase 3, no daemon** | The win is a cache *shared across processes*, not a cache in a process. That is a shared store problem: WAL SQLite with mtime/schema invalidation. A daemon would add a network hop and a new way to fail. |
| **Agent task queues** | **The real case for a minimal daemon** | `deferred-task.ts` and `unattended-job.ts` already persist the work and drain it; what is missing is a guaranteed owner while no terminal is open. Phase 2. |
| **Background indexing** | **Daemon, Phase 4** | Long, CPU/IO-heavy, resumable, and it must not block a foreground turn. It is the clearest "needs time of its own" workload — and the clearest reason checkpointing is a requirement, not a nicety. |
| **File watching** | **Daemon, Phase 4** | A per-project watcher must outlive the turn that started it. Cost control (debounce, ignore rules, directory cap) is the design work; the process is trivial. |
| **Shared model sessions** | **Refuse** | A session is a conversation: mutable context with no conflict semantics. Two processes sharing one would need ownership/merge/rollback that do not exist, and the failure mode — two agents editing the same workspace from the same history — is worse than the problem. What users actually want from this is already here: the response/reasoning caches (no live model needed) and the workspace store's project continuity (`getProjectForCwd`, `recordRun`). |
| **Project workspace state** | **Already solved, and multi-process safe** | `workspace.ts` uses `node:sqlite` + WAL with a JSON fallback, so concurrent readers are safe and the writer is serialized *by the database*, not by a daemon. |
| **Process management / PID files** | **Exists; Phase 1 adds a file only where it helps** | PID discovery is already port + command-line based, which is more robust than a pid file. Phase 1 adds `daemon.pid` *and validates it* (pid + command-line match + heartbeat age) rather than trusting it. |
| **Service registration** | **Phase 1, opt-in only** | launchd/systemd/Task Scheduler, written by `nuvira daemon install`. Registering a login item is a system change: explicitly requested, never implied. |
| **Restart handling / crash recovery** | **Shipped for duties; Phase 1 for a process** | `steal-after-stale` + renewal is the crash recovery for duties (bounded by the stale window, and reported when it fires). A supervisor's restart budget covers the long-lived process. |

## Achievability, honestly

| Phase | Cost | Risk | Verdict |
|---|---|---|---|
| 0 — duty leases | **Done** (1 module, 2 call sites, 1 command, 24 new tests + 11 affected suites re-run green) | Low. Worst case is a duty running late by `staleMs`. | Ship. |
| 1 — supervisor + pid/heartbeat/install | Medium: one command surface, three platform installers, log handling | A background process that is *running and wrong* is the new failure mode; heartbeat + bounded restarts are the mitigation. Platform installers are the fiddly part. | Do it when Phase 2's entry criteria are met. |
| 2 — guarded drains | Small, given Phase 1 | Near-zero: the drains already exist and are idempotent; this only adds an owner. | Highest value per unit of risk. |
| 3 — WAL store | Large refactor (registry, ledger, history, bandit, cost, telemetry), mechanical but touching the routing read path | Data migration and a fallback tier to keep; the read path must stay synchronous and fast. | Worth it, but only with the JSON tier kept. |
| 4 — watching + indexing | Medium; the *policy* (ignore rules, caps, debounce) is most of the work | Watcher storms, lock contention with foreground writes. | Last, and only with caps. |

## Remaining limitations (unchanged, honest)

* **The lease window is a delay, not a guarantee.** A crashed holder blocks its
  duty for at most `staleMs` (default 5 min for duties; the warmup sweep sizes
  its own from the interval). Clock skew between machines sharing a memory dir
  shifts that window; it cannot make exclusion unsafe.
* **Two processes can still both *try*.** Exclusion is on the take, not on the
  sense of timing — a duty that starts before another's lease is visible can do
  a redundant tick. Idempotence is why that is acceptable.
* **No daemon means no cross-process cancellation.** Stopping a duty means
  waiting for it (or killing the process). A daemon would give a stop signal;
  nothing in the workload list needs one yet.
* **Phase 0 does not make duties run.** It makes them run *once*. If no process
  is alive, nothing sweeps — that is exactly what Phase 2 exists to change.
* **`async-delegation.ts`'s header overstates its storage.** It claims SQLite
  crash recovery and persists nothing. Either it gets a real store (Phase 3) or
  the header should be corrected.

## See also

* `src/learning/duty-lease.ts` — the shipped primitive.
* `src/learning/model-warmup.ts` — the first leased duty, with renewal.
* `src/cli/duties.ts` — the session-start duty and the lease-vs-throttle ordering.
* `src/config/workspace.ts` — the existing WAL SQLite store and its JSON fallback
  tier, which Phase 3 generalizes.
* `src/learning/deferred-task.ts`, `src/learning/unattended-job.ts` — the
  persisted queues Phase 2 gives a guaranteed drainer.
* `src/cli/process-control.ts`, `src/tools/daemon-pool.ts` — what process
  management already does, and the shape Phase 1 builds on.
