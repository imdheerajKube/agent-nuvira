# Design — Skill & Plugin Ecosystem (import, plugins, leverage review)

**Status:** DRAFT · analysis only
**Decisions pending:** §3 (marketplace import), §6 (plugin consumption model)
**Date:** 2026-10-06

This document exists to answer four questions that came out of a product review:

1. Can we import skills from GitHub / marketplaces instead of only from disk? (§3)
2. Can we consume third-party **plugins** (Claude Code, Hermes, …) if the user wants them? (§4–6)
3. Which well-known ecosystem plugins should we leverage, and are they free or paid? (§7)
4. What would it take to do the above **safely**? (§2, §5, §8)

---

## 1. Current state — what nuvira has today

| Capability | Where |
|---|---|
| A `skill` tool the model can load by name | `src/tools/` (skill tool) |
| Skill files discovered from `.agents/skills/` | repo-local + installed |
| Local import / install | `npx skills add <owner/repo> --skill <name>` (documented flow) |
| Per-skill secrets | Skill Environment Variables page + `required_environment_variables` |
| Enable/disable surface | Dashboard → Agent Hub |
| Tool allow-listing | `src/tools/toolsets.ts` (one toolset per tool) |

So the **runtime** already exists: a skill is discovered, loaded by relevance, and can declare env vars. What is missing is a **source layer** (where skills come from) and a **trust layer** (what happens between "fetch" and "enable"). Both assessments below are really about adding those two layers.

---

## 2. The two layers we are actually missing

```
                      ┌───────────── missing ─────────────┐
  source ──► fetch ──► │ provenance → quarantine → review │ ──► install (local store) ──► existing runtime
                      └───────────────────────────────────┘
```

Everything downstream of *install* already works. That is the key leverage point: **the local store is the single install target**, so a resolver that fetches into it needs no changes to validation, env vars, or Agent Hub toggles.

---

## 3. Assessment 1 — Marketplace / GitHub skill import  *(DECISION PENDING)*

### 3.1 The ecosystem has converged on one format

**Agent Skills** is an open, markdown-based format: a folder with `SKILL.md` (frontmatter: name, description) plus optional scripts/resources. It is adopted by Anthropic (Claude Code / Platform), OpenAI (Codex/Copilot), Microsoft, GitHub and VS Code. Critically, the same skill runs in several agents — Hermes skills are explicitly described as also running in Claude Code.

**Consequence:** we do **not** need one importer per vendor. One format-compatible importer serves all of them.

### 3.2 Sources, ranked by value → risk

| # | Source | Mechanism | Notes |
|---|---|---|---|
| 1 | **GitHub repo / subpath** | tarball API or `git clone --depth 1` | `owner/repo`, `owner/repo/skills/x`, or a tree URL |
| 2 | **Marketplace index** | fetch `marketplace.json` from a repo | Claude Code's `/plugin marketplace add <owner/repo>` model |
| 3 | **Direct URL / zip** | HTTP fetch + unpack | lowest trust, still useful |

### 3.3 What makes this hard (and why it is not just "download a folder")

A skill is **instructions plus executable scripts**. That is a *package*, and it must be handled like one:

| Risk | Mitigation |
|---|---|
| Untrusted code | **Quarantine on import**; never auto-enable; require an explicit enable in Agent Hub |
| Silent drift | **Pin** to a ref/commit; record `source`, `ref`, `sha`, `fetchedAt` |
| Malicious install hooks | **Never auto-run** install hooks; no postinstall |
| Prompt injection via fetched text | Treat skill text as untrusted; skills cannot escalate tool permissions |
| Supply-chain swap | Verify the digest on update; `skills update` shows a **diff** |
| Name collisions | Namespace by source (`github:owner/repo/skill`) + documented precedence |
| Credential exfiltration | Skills never receive provider credentials (this guard already exists and must hold) |

### 3.4 Options

- **A. Local only (today).** Zero risk, zero reach.
- **B. GitHub-only import.** Highest reach/effort ratio; covers most of the ecosystem.
- **C. GitHub + one curated registry.** Adds discovery; needs an index format and a trust policy.
- **D. Full marketplace (publish + install).** Out of scope until B/C exist.

### 3.5 Recommendation

**Adopt B now, design for C.** Concretely:

1. A `SkillSource` resolver interface: `resolve(ref) → { files, provenance }`.
2. Three implementations: `github`, `url`, `local` (today's path becomes one resolver).
3. One install sink: the existing local skill store.
4. A **provenance record** per installed skill; `provenance` shown in Agent Hub.
5. `nuvira skills list|add|remove|update|diff` (update = explicit, with diff).
6. Default `trusted: false` on everything fetched; enabling is a user action.

**Why not D:** publishing is a policy/commerce surface; install is a capability. Ship the capability first.

---

## 4. Assessment 2 — Plugin ≠ Skill

The vocabulary matters, because the two ecosystems use it differently:

| Concept | Meaning | nuvira analogue |
|---|---|---|
| **Skill** | instructions + optional resources, loaded on relevance | the `skill` tool |
| **Plugin / bundle** | a *metapackage*: skills + commands + subagents + hooks + MCP servers | a manifest that **fans out** across several nuvira subsystems |
| **MCP server** | a tool provider over a protocol | tools in `toolsets.ts` |
| **Hook** | lifecycle callback (session start, pre-tool) | nuvira's orchestration seams |

**Conclusion:** "consume a plugin" is not one feature — it is a **manifest that maps onto our existing subsystems**. A plugin's skills go to the skill store; its MCP servers go to tools; its hooks have no direct equivalent (see §5.2); its commands map to CLI/prompt shortcuts.

---

## 5. Consuming third-party plugins — what nuvira would need

### 5.1 What maps cleanly

- **Skills** → skill store (§3).
- **MCP servers** → tools, gated per toolset.
- **Commands/subagents** → prompt templates / agent profiles.
- **Declared env vars** → the skill env-var page (already exists).

### 5.2 What does NOT map cleanly

Third-party plugins assume **Claude Code's hook contract** (`SessionStart`, `PreToolUse`, …). Two concrete examples from §7 make the point:

- **Ponytail** works by a `SessionStart` hook that injects a ruleset; its Claude Code/Codex plugins run Node lifecycle hooks.
- **RTK** works by a `PreToolUse`/Bash hook that **rewrites commands**.

nuvira has no user-pluggable hook API. Options: (a) **don't** run their hooks — import only the *content* (the ruleset, the compression config) and wire it to our own seams; (b) add a hook API (large, security-sensitive). **Recommend (a)** for now.

### 5.3 The user-choice model

"Consume plugins if the user wants, as per their choice" implies:

1. **Opt-in per plugin**, nothing on by default.
2. **Per-source trust** — a user can trust `github:known-org/*` without trusting everything.
3. **Capability declaration** — a plugin must declare `network`, `exec`, `mcp`, `write`. Agent Hub shows it and gates it.
4. **Revocation** — uninstall removes store entries + tool registrations + env vars it introduced.
5. **Visible provenance** in the UI.

---

## 6. Decision pending — plugin consumption model

Three viable models; **no decision taken**:

| Model | Description | Pros | Cons |
|---|---|---|---|
| **A. Content-only import** | Import skills/commands; ignore hooks and MCP; user wires behaviour via nuvira config | Safe, small, ships fast | Plugins lose their "magic" (the hook *is* the product for Ponytail/RTK) |
| **B. Full plugin runtime** | Implement a hook API + MCP host + marketplace | Maximum leverage/parity | Large; a hook API is a remote-code-execution surface |
| **C. Hybrid** | Content-only by default; a small, audited **allow-list of hook kinds** (e.g. prompt-injection-at-session-start) implementable natively | Gets most value, bounded risk | Needs per-plugin porting work |

**Recommendation to evaluate later: C**, starting from A. Do not build B before a trust model (§8) exists.

---

## 7. Ecosystem leverage review — the named plugins

> **Honesty note:** these were **not** evaluated earlier because the earlier work was on nuvira's *own* loop (model routing, repair, docs), and these are Claude Code-ecosystem third-party artifacts — contents a future importer would consume, not nuvira capabilities. They were also **not** in scope of anything nuvira executes. This section is that evaluation.
>
> One name could not be identified — see "Unidentified" below. I have not invented a product for it.

| Plugin | What it actually is | Free / paid | Pros | Cons / risk |
|---|---|---|---|---|
| **Strix** | Autonomous AI **penetration-testing** framework; ships official agent skills so a coding agent can run pentests and remediate findings | The **skill wrapper is free/open** (a `SKILL.md` repo); **Strix itself is a vendor product** — verify licence/pricing for the runtime | Real offensive-security capability; validates findings, not just pattern-matches | Needs a runtime + network + a target; **dual-use** (never auto-enable); cost is per-run; out of scope for a coding loop |
| **Ponytail** | A **YAGNI / anti-over-engineering** ruleset (`dietrichgebert/ponytail`) that pushes the agent toward less code; described as "routing/orchestration" by the reviewer — it is **not** routing | **Free / open source** | Small, high leverage on code *volume*; can reduce over-built output | Reviews are mixed; advertised "80–94% less code" is a line-count claim, not a quality claim; runs as a hook (≠ our contract) |
| **Graphify** | Builds a **knowledge graph** of a repo (code + docs + PDFs) so the agent queries the graph instead of skimming files; claims large token savings | **Mixed** — the GitHub skill/tool exists and some material is free; the polished product/site is commercial. Verify current terms | Directly attacks nuvira's context cost; complements our vector store | Headline "71x/70x" numbers come from large repos and are disputed for small ones; adds an index + a dependency |
| **RTK** | A CLI **proxy that compresses command output** before it reaches the model; Claude Code hook rewrites commands (`cat` → rtk …) | **Free / open source** | 60–90% token savings reported on noisy command output | **A reported issue states the hook *increased* costs by 18%** (#582) — i.e. the gain is workload-dependent; hook-based, so it needs porting; changes command semantics |
| **UI/UX Pro Max** | A **design-intelligence** skill: searchable local guidance (styles, palettes, reasoning profiles) | **Free / open source** (`nextlevelbuilder/ui-ux-pro-max-skill`) | Genuinely improves UI output; pure content → imports cleanly with zero runtime risk | Benchmarks show it is **slow** (~18 min vs a lighter alternative); opinionated; token-heavy |
| **"API Key Git Repo"** | Not a single product. It resolves to a **category**: API-key / secret handling skills distributed as git repos. See **§7.1** for the full assessment (three distinct capabilities, free-vs-paid, and a recommendation) | mixed — see §7.1 | Real overlap with what nuvira already does; see §7.2 | Scanners need their own binary (`ggshield`/`gitleaks`); interceptors need a hook API nuvira does not have |

### 7.1 Assessment — "API Key Git Repo" (secret / API-key handling skills)

**What it is.** The name matches a **category**, not one product. Three genuinely
different capabilities ship under it, and conflating them is the main risk:

| Capability | Representative artifacts | What it does |
|---|---|---|
| **A. Secret SCANNING** | `GitGuardian/agent-skills` (via `ggshield`); the Gitleaks-based *Secrets Detection* skill | Finds leaked API keys/tokens in code **and git history**, before they ship |
| **B. Runtime INTERCEPTION** | `quinnjr/claude-plugin-keypass` (keys → OS password store); `sensitive-canary` (local pre-API interceptor); `maccydee/scrub-transcripts` | Stops key-shaped strings leaving the machine / reaching the model |
| **C. Key PROVISIONING / management** | marketplace `secrets-management` skills; "bring your own key" plugins | Guides key creation, storage, rotation |

**Free vs paid.**

| Artifact | Verdict |
|---|---|
| `GitGuardian/agent-skills` | Skills are **open on GitHub**; `ggshield` is free for individuals, **paid for teams** (GitGuardian is a commercial platform) — verify current terms |
| Gitleaks-based skills | **Free / open source** (Gitleaks is MIT) — fully local |
| keypass · sensitive-canary · scrub-transcripts | **Free / open source** (community) |
| `secrets-management` marketplace skills | **Free** |

**What nuvira already has (this is the important part).** Secret handling is
*not* a gap: `redact()` (G3 privacy) already strips secret-shaped content before
anything reaches `history.json`; credentials live in a `0600` env file plus a
vault/keyring path; the Skill Environment Variables page **refuses** to hand
provider credentials to skills. So a scanner is a **complement**, not a missing
capability — and capability **C** is largely already covered.

**Pros.**
- Directly useful for nuvira's own job: it *writes code and commits*. "Did I just
  stage a key?" is a real, recurring failure mode in that loop.
- Capability **A** is a **tool**, not a hook — it plugs into the existing tool
  model without touching the orchestration seams (§5.2).
- Local-first options exist (Gitleaks), so the default path needs no vendor and
  no network.

**Cons / risks.**
- Scanning **git history** is slow on large repos; it must be opt-in or bounded.
- Vendor-backed scanners (`ggshield`) send data to a third party — needs an
  explicit capability declaration (§8) and must never be default-on.
- Capability **B** (interception) depends on a hook contract nuvira lacks; §5.2
  applies, and it is the same reason Ponytail/RTK are not directly installable.
- Any scanner needs its **own binary** installed — which is exactly the
  self-install path nuvira already handles, but its own failure mode.

**Recommendation (for the later decision, not now).**
1. Adopt capability **A** as an **on-demand tool** ("scan this repo / this staged
   diff for secrets"), default **Gitleaks-local**, with a declared network
   capability reserved for the vendor variant.
2. Skip capability **B** until a hook API exists (model C, §6).
3. Treat capability **C** as already covered by the existing env/vault surfaces;
   only add what is missing (e.g. rotation guidance).
4. Do **not** ship any of it default-on: a scanner that reads every file is a
   privacy decision the user must make.

> **Still open:** the exact artifact the reviewer meant. If it is a specific
> repo, name it and this row is replaced with a product-level assessment. If it
> is the *category* above, the recommendation stands as written.

### 7.2 Why the other named plugins were not "leveraged" in nuvira

Three distinct reasons — they are not the same kind of thing:

1. **Process plugins (Ponytail, RTK)** — their value lives in **hooks**. nuvira has no pluggable hook API (§5.2), so adopting them means *porting their content to our seams*, not installing them.
2. **Content skills (UI/UX Pro Max)** — genuinely portable today, but the *source layer* (§3) has to exist first; there is no importer to carry them.
3. **External runtimes (Strix, Graphify)** — these are **products with their own runtime and cost**, invoked by the agent as tools. They are integrations, not skills, and belong behind a capability declaration (§5.3).

**Bottom line:** none were "ignored" out of preference; there is simply no pipeline to receive them yet. §3 builds that pipeline; §6 decides how much of a plugin's *behaviour* (vs its content) we execute.

---

## 8. Trust & safety model (a prerequisite, not a phase)

1. **Quarantine on import** — nothing fetched is enabled automatically.
2. **Provenance** — source, ref, digest, fetched-at, and who enabled it.
3. **Capability declaration** — `network` / `exec` / `write` / `mcp`; shown and gated.
4. **No credentials to skills** — the existing rule (`provider-credential` refusal) must hold across all sources.
5. **Deterministic, relevance-based loading** — with hundreds of skills available, discovery is by metadata and loading happens on match; never inject wholesale.
6. **Explicit update with diff** — no silent upgrades.
7. **Revocation** — uninstall fully reverses an install.

---

## 9. Phased roadmap

| Phase | Deliverable | Risk |
|---|---|---|
| 1 | `SkillSource` interface + GitHub resolver + provenance record; local path becomes one resolver | Low |
| 2 | Quarantine + Agent Hub provenance/capability UI; `skills list/add/remove` | Low |
| 3 | `skills update` with diff; registry index (source C) | Medium |
| 4 | Plugin manifest fan-out (skills + MCP + commands); **content-only** (model A) | Medium |
| 5 | *Decision point:* hook kinds allow-list (model C) | High — needs §8 in place |

---

## 10. Open questions (decisions)

1. **§3:** GitHub-only first, or GitHub + a curated registry?
2. **§6:** content-only (A) vs hybrid (C)? **Recommend A then C; not B.**
3. **§7:** name the "API Keys Git Repo" artifact so it can be assessed.
4. Do we want a **publish** path (model D) at all, or only consume?
5. Where does the trust policy live — per-repo, per-org, or per-user?

---

## References

- Agent Skills (open format): `code.claude.com/docs/en/skills`, `platform.claude.com/docs/en/agents-and-tools/agent-skills/overview`
- Claude Code plugin marketplaces: `/plugin marketplace add <owner/repo>`
- Hermes Agent skill/plugin catalogs: `hermes-agent.nousresearch.com/docs/plugins`
- Strix: `docs.strix.ai/integrations/coding-agents`
- Ponytail: `github.com/dietrichgebert/ponytail`
- Graphify: `github.com/Graphify-Labs/graphify`
- RTK: `github.com/rtk-ai/rtk` (see issue #582 on hook cost)
- UI/UX Pro Max: `github.com/nextlevelbuilder/ui-ux-pro-max-skill`
