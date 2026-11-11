# Phase 11 — Stage 1 Plan

## The stage seam, and a 12-packet single-machine proof

| Field | Value |
|---|---|
| Status | Build plan for Stage 1 |
| Duration | 10 working days (2 weeks elapsed) |
| Scope | One machine, two worker processes, no network federation |
| Gate | The 14 checks in §5; no Stage 2 work starts until all pass |
| Depends on | Phase 5 stage seam (O1), mandatory worktree isolation (O2), F1/F2 fixes |

---

## 1. Why Stage 1 is single-machine

The risk in Phase 11 is not the network. It is the **contracts**: whether a packet can be specified tightly enough to be executed by something that has no context, and whether a gate can be evaluated from evidence alone.

A network adds latency, partition, and authentication to that problem, and makes each contract bug four times harder to reproduce. So Stage 1 runs two worker processes on one machine, communicating through the same broker and artifact store the network stages will use. If the contracts are wrong, we find out in hours instead of weeks.

The rule: **Stage 1 must not contain the word "node" in any new interface.** Workers are processes with ids. The grid vocabulary arrives in Stage 2, when it is earned.

---

## 2. The stage seam

### 2.1 Requirement

A worker must be stoppable at two places by Prime, without forking the pipeline:

- **`after:plan`** — Prime reviews the worker's plan before any file is touched. This is where a wrong decomposition is cheap to catch.
- **`after:verify`** — Prime checks the evidence before the worker declares success. This is where false success dies.

Additionally **`before:edit`**, which is where a path-ownership conflict is caught before the write rather than after.

### 2.2 Interface

```ts
export type SeamId = 'after:plan' | 'before:edit' | 'after:verify';

export interface SeamContext {
  runId: string;
  packetId: string;
  workerId: string;
  seam: SeamId;
  /** Immutable snapshot — a seam may never mutate the plan or the workspace. */
  plan?: Readonly<PlanOutput>;
  diff?: Readonly<PatchArtifact>;
  evidence: ReadonlyArray<EvidenceRef>;
  deadlineMs: number;
}

export type SeamVerdict =
  | { allow: true; notes?: string[] }
  | { allow: false; gate: string; reason: string; evidence: EvidenceRef[]; retriable: boolean };

export interface LifecycleSeam {
  id: string;
  seams: SeamId[];
  evaluate(ctx: SeamContext): Promise<SeamVerdict>;
}
```

Injection point: `PipelineConfig.seams?: LifecycleSeam[]`, evaluated in array order at each seam.

### 2.3 Semantics (these are the design)

| Property | Rule | Reason |
|---|---|---|
| Fail-closed | A seam that throws, times out, or returns malformed output is a **block** | A seam that fails open is worse than no seam |
| No mutation | `SeamContext` is readonly; the pipeline rejects a seam that attempts to change plan or workspace | A reviewer that edits the artifact is a producer |
| First block wins | Evaluation stops at the first `allow:false` | Deterministic, explainable |
| Evidence required | A block must cite at least one evidence ref or state `evidence: []` with `reason: 'policy'` | Prevents "I didn't like it" |
| Audited | Every seam evaluation writes `{seam, verdict, durationMs, gate?}` to the pipeline audit and the program ledger | Reconstructability |
| Bounded | Per-seam timeout (default 5 min), total seam budget per packet (default 15 min) | A seam cannot become the run |
| Retriable flag | `retriable: false` means re-running the packet unchanged will fail the same way | Prevents wasted retries |

### 2.4 What this is not

It is not a plugin system. Seams are constructed by the caller (Prime) and passed in; there is no discovery, no dynamic import, and no way for a packet to install one. That is deliberate: the seam is an authority boundary, and authority is not discoverable.

### 2.5 Minimal implementation sketch

```ts
// pipeline: after plan
for (const seam of seamsFor('after:plan')) {
  const v = await withTimeout(seam.evaluate(ctx), seamTimeoutMs);
  audit.seam(seam.id, v, ms);
  if (!v.allow) return blockResult(v);   // no inspect, no edit
}

// pipeline: before edit
//   path-lock check happens here, using the packet's declared paths vs in-flight locks

// pipeline: after verify
//   evidence check: every claimed artifact exists, hashes match, tests ran under this packet
```

The three seams are ~150 lines of pipeline code plus the ledger write. The expensive part is not the seam; it is the evidence schema it consumes.

---

## 3. The 12-packet program

A deliberately small, real program: **a "notes" feature** in a small TypeScript service — create/list/delete notes with a title, body, and timestamps, tested, documented, and released. It is chosen because 12 packets is enough to exercise every edge (contract freeze, parallel implementation, review, conflict, integration) and small enough that a human can verify the whole result by hand in ten minutes.

| # | Packet | Dept | Depends on | Paths | Risk |
|---|---|---|---|---|---|
| 1 | Freeze contract: `Note` type, endpoints, error codes | architecture | — | `src/types/note.ts`, `docs/api/notes.md` | high |
| 2 | Program integration suite (from acceptance criteria) | qa | 1 | `tests/integration/notes.test.ts` | high |
| 3 | Schema + migration | data | 1 | `src/db/migrations/003_notes.sql` | medium |
| 4 | Repository layer (create/list/delete) | impl:backend | 1, 3 | `src/repo/notes.ts` | medium |
| 5 | HTTP handlers + validation | impl:backend | 1, 4 | `src/http/notes.ts` | medium |
| 6 | Handler unit tests | qa | 1, 5 | `tests/unit/http-notes.test.ts` | low |
| 7 | Repository unit tests | qa | 1, 4 | `tests/unit/repo-notes.test.ts` | low |
| 8 | UI list + create form | impl:frontend | 1 | `src/ui/notes/` | medium |
| 9 | Security review of handlers + input validation | security | 5 | — | high |
| 10 | Runbook + rollback note | sre | 3, 5 | `docs/runbooks/notes.md` | low |
| 11 | User documentation | docs | 1, 8 | `docs/user/notes.md` | low |
| 12 | Release candidate + evidence bundle | release | 2, 6, 7, 9, 10, 11 | — | high |

Twelve packets, five capability tags, two deliberate conflicts, one deliberate failure. The plan is small on purpose; the checks are not.

---

## 4. What the demo must prove

### 4.1 Contract freeze actually blocks

Packet 4 is *submitted* before packet 1 is accepted. Expected: the broker does not admit it; the queue shows `blocked: dependency pending`, not a run that fails after ten minutes.

### 4.2 Path conflict is caught before the write

Packets 5 and 8 both declare `src/http/notes.ts` in a deliberately corrupted variant of the fixture. Expected: packet 8 is refused at `before:edit` with `path-lock conflict`, and the message names the holder and the expiry. The live tree is untouched.

### 4.3 Review independence is not a slogan

Packet 5's review is requested from the worker that produced it. Expected: the token presented for review has no `review` scope for that packet's producer; the request fails at the authorization layer, not at a prompt.

### 4.4 False success is caught

The mock provider is configured to return "all tests pass" for packet 7 while writing no test file. Expected: the `after:verify` seam blocks with `evidence: missing artifact`, the packet is marked `failed:unverified`, and the ledger records the claim and the absence side by side.

### 4.5 Lease expiry reissues without duplicating

One worker is paused (SIGSTOP) mid-packet. Expected: heartbeat stops, lease expires, the packet is reissued to the other worker, the first worker's late artifact is rejected with `stale lease` (fencing token), and exactly one artifact is accepted.

### 4.6 Integration suite catches a real break

Packet 4 is modified to return `null` for a missing note while packet 5 assumes a 404. Both unit suites are green; packet 2's integration suite fails at the first merge that includes both. Expected: the merge is blocked, the failing assertion names the contract clause, and the ledger attributes the defect to the pair.

### 4.7 The evidence bundle is complete

Expected: 12 packets, 12 artifacts with hashes, 9 gate results, 1 waiver (see §4.8), 1 quarantine event, cost reconciled within 5%, and a bundle that verifies with `nuvira grid verify`.

### 4.8 A waiver is visible, not silent

The security review (packet 9) is deliberately failed once. Expected: the program halts at the security gate; the operator grants a *scoped* waiver naming the finding, and the bundle shows `waived_by`, `reason`, `expiry`, and the finding it covers — and no other packet can inherit it.

---

## 5. Acceptance checks

| # | Check | Pass condition |
|---|---|---|
| A1 | Contract freeze | Packet 4 cannot start before packet 1 is `accepted` |
| A2 | Path lock | Conflicting packet refused at `before:edit`, live tree unchanged |
| A3 | Review independence | Producer cannot review own packet (authorization denial) |
| A4 | False success | Claimed pass with no artifact is blocked and `unverified` |
| A5 | Lease fencing | Exactly one artifact accepted after expiry + reissue |
| A6 | Integration gate | Cross-packet break blocks merge; assertion names contract clause |
| A7 | Patch cap | A 401-line patch is rejected with a split suggestion, not reviewed |
| A8 | Worktree base | A worker with a stale base is refused (`base != packet.baseCommit`) |
| A9 | Waiver scope | Waiver covers one finding, one packet, with expiry |
| A10 | Resume | Kill Prime mid-program; resume completes without re-running accepted packets |
| A11 | Admission | Third concurrent packet on a 2-slot worker gets `429` + retry hint (F2) |
| A12 | False-success polling | F1 path returns `unknown`, never `success` without a result |
| A13 | Audit | Every seam evaluation, gate, lease, and merge is in the ledger and verifies |
| A14 | Human check | A reviewer reads the 12 artifacts and finds no unexplained green tick |

A14 is subjective on purpose. If a human cannot reconcile the board with the artifacts, the board is lying, whatever the other thirteen checks say.

---

## 6. Ten-day plan

| Day | Work | Exit |
|---|---|---|
| 1 | Seam interface + injection into the pipeline; audit write; fail-closed tests | A seam can block a run at `after:plan` |
| 2 | Evidence schema; artifact hash + existence verification; `after:verify` seam | False-success fixture is blocked |
| 3 | Broker v0 (SQLite, WAL): packets, attempts, leases, fencing tokens | Lease expiry + reissue works with one worker |
| 4 | Worktree base pinning + stale-base refusal; patch artifact capture | A stale worker is refused |
| 5 | Two-process harness: worker bootstrap, capability token, slot enforcement (F2) | Third packet gets `429` |
| 6 | Path locks + `before:edit` seam; conflict fixture | Conflict refused, tree untouched |
| 7 | Review tokens + independence check; review record schema | Producer review denied |
| 8 | Merge coordinator v0 (serialized, integration suite, fencing) | A6 and A10 pass |
| 9 | Evidence bundle + `grid verify`; cost ledger; waiver artifact | Bundle verifies end to end |
| 10 | Run the 12-packet program three times; record variance; write the report | 14/14 checks, twice consecutively |

Day 10's "three times" matters: a demo that passes once is a coincidence. The report records packet cycle time, seam latency, retries, conflicts, and the false-success detections.

---

## 7. Risks specific to Stage 1

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Phase 5 seam does not exist yet (C1) | medium | blocks day 1 | Build the seam against the pipeline's existing step boundary; do not wait for a general seam framework |
| Evidence schema churns | high | rework in days 2, 7, 9 | Freeze the evidence schema at end of day 2; additions are additive only |
| SQLite write contention with two workers | low | test flake | WAL + batch commits; single writer for state transitions |
| The fixture is too easy and proves nothing | medium | false confidence | The deliberate conflicts and the mock false-success are part of the fixture, not an afterthought |
| Scope creep into Stage 2 ("just add a third process over HTTP") | high | loses the contract focus | Stage 1's exit criterion is the 14 checks, not a demo that looks distributed |

---

## 8. What Stage 1 deliberately defers

- The **M6 improvement ledger (v1)** — hash chain, signatures, promotion gate. Stage 1 ships the append-only observation stream it will be built from, because the data cannot be collected retroactively (D16; `./PHASE11_SELF_IMPROVEMENT.md` §13.6).
- Any network transport (Stage 2).
- Real model diversity across workers (Stage 2; Stage 1 uses one provider with two model settings).
- Node enrollment, trust tiers, quarantine (Stage 2–3).
- Capacity forecasting and the program board's fleet views (Stage 3).
- Classification ceilings beyond a single flag (Stage 4).

The seam, the broker, the patch artifact, the fencing token, and the evidence bundle are the five things every later stage depends on. They are all in Stage 1, and none of them is deferred.

---

## 9. Definition of done

Stage 1 is done when:

1. all 14 acceptance checks pass on two consecutive runs;
2. the 12-packet program's artifacts can be reviewed by a human in under fifteen minutes;
3. the Stage 1 **evidence** ledger verifies independently of the dashboard (this is not the M6 improvement ledger, which is Phase 12 — D16);
4. a worker process killed with `SIGKILL` mid-packet produces a reissued packet and exactly one accepted artifact;
5. no packet was executed in the live working tree at any point;
6. the report names every place the contracts were too loose, with the packet that exposed it.

Point 6 is the actual deliverable. Stage 2 exists to test the contracts against a network; if Stage 1 did not find contract weaknesses, it was not run hard enough.
