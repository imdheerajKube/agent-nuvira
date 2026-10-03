# Capability Ledger — what is real, what is approximate, what is not built

> **Honest status ledger.** Modeled on claw-code's `PARITY.md`: every capability
> is stated with its real depth, and anything that is a stub or an approximation
> is named as such. The point is that a reader never mistakes an ambition for a
> working feature — the failure this repo's truthfulness workstream exists to
> remove.
>
> **Legend:** ✅ real (works end-to-end) · 🟡 partial (works, with named limits) ·
> ⚪ approximation (registry/model-level, not end-to-end) · ⛔ not built
>
> **Last updated:** 2026-10-03

---

## 1. Core loop & delivery

| Capability | Depth | Evidence / limit |
|---|---|---|
| Tool loop (native + JSON-fallback transport) | ✅ | `src/tools/tool-loop.ts`; transport attributed per step |
| Multi-agent orchestrator (planner→writer→reviewer→runner) | ✅ | `src/agents/orchestrator.ts` (4.4K LOC), 22 agent classes |
| Dependency-respecting execution + live fan-out | ✅ | `fanout-scheduler.ts` wired into orchestrator |
| Checkpoint / resume of a pipeline | ✅ | `checkpoint-store.ts` (save/load/reconcile) |
| Persistent session store (survive process death) | ✅ | `learning/session-store.ts`, default ON with opt-out |
| Artifact verification from DISK (not the model's word) | ✅ | `artifact-verification.ts` |
| Error repair / retry with model escalation | ✅ | `learning/error-repair.ts`, `rate-limit-retry.ts` |
| Long-form / composite deliverables | ✅ | `long-form-plan.ts`, `composite-plan.ts` |
| False-success prevention (completion derives from facts) | ✅ | `docs/ISSUE_false-success_model-vs-framework.md` |

## 2. Tools & governance

| Capability | Depth | Evidence / limit |
|---|---|---|
| Registered tool surface | ✅ | **112** tools in 24 toolsets (`tools/registry.ts`) |
| Toolset enable/disable (schema + execution gate) | ✅ | `tools/toolsets.ts` — both enforcement points real |
| Tiered tool exposure (token ceiling) | ✅ | measured 4.6× cut; `CORE_TOOL_NAMES` |
| Terminal command classification (deny/confirm/verify) | ✅ | `run-terminal.ts` — `rm -rf` / `sudo` / substitution denied |
| Permission/RBAC gating on sensitive actions | ✅ | `guardRbacAction`, admin policy |
| LSP-backed code intelligence (hover/definition/diagnostics) | ⛔ | not implemented; `code_search` (ripgrep) is the substitute |
| Notebook edit (Jupyter cells) | ⛔ | not implemented |

## 3. Skills & market sourcing

| Capability | Depth | Evidence / limit |
|---|---|---|
| Bundled first-party skills (executable step DAGs) | ✅ | ~250 (`bundled-skills*`), progressive disclosure |
| Skill execution engine | ✅ | `skill-executor.ts`, `sandbox-executor.ts` |
| Skill approval / audit / secret capture | ✅ | `execution-approval.ts`, `execution-audit.ts`, `secret-capture.ts` |
| Skill provenance + lock/quarantine | ✅ | `skill-provenance.ts`, `tools/skills-hub.ts` |
| Skill market sources | ✅ | 4 kinds: `github-raw`, `local-dir`, `browse-sh`, `git-repo` |
| Workflow-template registry + marketplace | ✅ | `workflow/registry.ts`, `cli/marketplace.ts` |
| Skill sync (safe update, skip user-customized) | ✅ | `tools/skills-sync.ts` |

## 4. Surfaces, gateway & integrations

| Capability | Depth | Evidence / limit |
|---|---|---|
| CLI (chat/execute/plan/…) | ✅ | `cli/cli-program.ts`, 308 command sections |
| Web dashboard | ✅ | `web-dashboard/` (72 routes) |
| Multi-channel gateway | ✅ | `gateway/` (16 modules, WhatsApp bridge) |
| Surface-parity harness (5 surfaces) | ✅ | `parity/` + `nuvira parity` |
| MCP servers (client) | 🟡 | connect/call/install/serve work; long-tail servers vary |
| MCP as a server (expose tools) | 🟡 | `mcp serve` works; ACP/Zed JSON-RPC not built (⛔) |
| VS Code extension | 🟡 | 13 commands; not full feature parity with CLI |
| Desktop app | ⛔ | planned (`docs/DESKTOP_APP_PLAN.md`), not built |
| Federation / A2A | 🟡 | local + remote-agent + A2A discovery; no cross-vendor auth matrix |

## 5. Verification & guarantees

| Capability | Depth | Evidence / limit |
|---|---|---|
| Unit/component suite | ✅ | 458 test files; ~5,516 passing (root) + ~1,015 (dashboard) |
| Golden provider-wire fixtures (REQUEST-side drift) | ✅ | `src/parity/wire-fixtures.ts` + `tests/fixtures/provider-wire/` |
| Command-surface drift guard | ✅ | `docs:commands:check` in CI |
| Deterministic mock/loopback provider | ✅ | `parity/drivers.ts` stub + wire recorder |
| CI green on every commit | 🟡 | linux/mac/windows workflows exist; not independently confirmed green at every commit |

---

## Known approximations (named honestly)

- **MCP end-to-end depth** varies by server; the client path is exercised, but
  the long tail of transports/auth is not verified.
- **ACP/Zed** is a discoverability alias, not a real JSON-RPC daemon.
- **Federation/A2A** covers discovery + local remote-agent runs; a full
  cross-vendor auth/skill matrix is not built.
- **Desktop app** is a plan, not a product.
- **LSP / notebook editing** are genuinely absent — not stubbed, simply not
  implemented.

## How to keep this honest

- When a capability moves from 🟡/⚪ to ✅, update its row with the evidence.
- When something is deliberately NOT built, add it to §"Known approximations"
  rather than leaving a reader to infer it from missing code.
- The provider-wire fixtures (`npm run docs:wire:check`) and the command-surface
  guard (`npm run docs:commands:check`) are the two mechanical checks that back
  the ✅ claims in §1 and §5.
