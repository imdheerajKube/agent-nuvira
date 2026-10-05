# Assessment — User-Built Capability Ingestion, Tag-Scoped Knowledge, and Data Privacy

**Date:** 2026-10-05
**Author:** Dheeraj Sharma <imdheeraj@gmail.com>
**Status:** Assessment (design + evidence). No feature code in this document.
**Scope:** (a) whether users can extend agent-nuvira with their own skills / workflows / pipelines without modifying the base code; (b) whether skills can be imported from the internet or from arbitrary directories; (c) how to make tag-scoped "bring your own documents → answer by hashtag" knowledge first-class; (d) confirmation that a user's local test data (a personal health report and its tag) is not shipped in any commit or npm package; (e) advice on adding DeepSeek v4.1 Flash and running a parity comparison.

---

## TL;DR

1. **Privacy is clean.** The personal health report and the `Dheeraj_Health_report`-style tag appear **nowhere** in the tracked repository or the npm tarball. User data lives in `~/.nuvira/`, which is outside the repo. The one habit to avoid: a personal skill placed at `<repo>/.agents/skills/…` **is** committed and published (that directory ships by design).
2. **Capability ingestion already exists** through four extension points (skills, workflow templates, agent plugins, provider plugins) — but every discovery root is a **fixed directory**, not "any directory". Internet import works via `nuvira skills install` (4 source kinds) and the `npx skills add` convention.
3. **Tag-scoped document knowledge is not yet a first-class feature.** The pieces exist (embedder, vector store, chunking, tagged memory) but there is no document→tag→vector pipeline and no agent-invocable "query by tag" tool. Section 6 specifies the first-class design.
4. **A concrete defect was found and fixed** in the skills-hub manager: installing a skill wrote only the frontmatter and discarded the SKILL.md body (the methodology). See §5.
5. **DeepSeek v4.1 Flash is the right call for parity testing**, because free-tier substitution is what makes the current numbers unattributable. Pin it, refuse substitution, then run the same tasks on both sides.

---

## 1. Privacy — is the health report or its tag in the product?

**No.** Verified by direct inspection on 2026-10-05:

| Check | Command | Result |
|---|---|---|
| Tracked files mentioning the data | `git grep -in "dheeraj\|health_report\|LDL"` | Only unrelated hits: the author email in docs, and a **generic** bundled skill. No health report, no tag. |
| Working tree / ignored files | `git status --porcelain --ignored \| grep -i health` | Only `.agents/skills/health-data/` — a generic HealthKit/Fitbit skill. |
| npm tarball contents | `npm pack --dry-run` | Ships `dist/`, `src/web-dashboard/public/`, `README.md`, `LICENSE`, `.agents/skills/` only. |

- **Where user data actually lives:** `~/.nuvira/` (`memory/`, `sessions/`, `debug-logs/`, vector indexes, reasoning traces, plans). `~/.nuvira` is a home-directory path and is **never inside the repository** (`~/Documents/AI_development/Freebuff_replacement`), so it can never be committed or published from this repo.
- **The one risk to keep in mind:** `package.json` `files` includes `.agents/skills/`, and `.npmignore` re-includes `.agents/skills/**` and `.agents/skills/**/SKILL.md` (the packaged registry). So a skill dropped at `<repo>/.agents/skills/<name>/SKILL.md` **will** be committed (git tracks that directory) and published. `.gitignore` ignores `*.md` broadly, but `.agents/skills/**/SKILL.md` is explicitly un-ignored, so the ignore rule is not a safety net here.
- **Rule of thumb:** personal or machine-specific skills and data belong at the **user-level root** — `~/.nuvira/skills/<name>/SKILL.md` and `~/.nuvira/memory/**` — never under the repo's `.agents/skills/`.

---

## 2. What "user-built capability" ingestion supports today

agent-nuvira already implements the "extend it without touching core code" model. There are four extension surfaces, each with a **fixed discovery root**:

| Capability | Discovered in | Arbitrary dir? | Loaded at runtime by |
|---|---|---|---|
| **Skills** (`SKILL.md`) | `<project>/.agents/skills/<name>/` **or** `~/.nuvira/skills/<name>/` | ❌ | `src/learning/hub-skill-catalog.ts` (`listMatchableHubSkills`) → orchestrator skill-match + the `skill` tool (`src/tools/skill-tool.ts`) |
| **Workflow / pipeline templates** | `~/.nuvira/workflows/*.json` | ❌ | `src/plugins/agent-plugin.ts` (`discoverWorkflowPlugins`) → WorkflowEngine pre-fills the plan |
| **Agent plugins** (`.js`) | `~/.nuvira/agents/*.js` | ❌ | `discoverAgentPlugins()` at startup |
| **Provider plugins** (`.js`) | `~/.nuvira/plugins/*.js` | ❌ | `discoverProviderPlugins()` at startup |

Consequences:

- **Yes, users can add skills, pipelines, agents, and providers with zero base-code changes** — by dropping the artifact in the fixed root. The orchestrator picks up a hub `SKILL.md` immediately, with no recompilation (`hub-skill-catalog.ts` header: "a `nuvira skills install` result is immediately matchable + injectable").
- **No, "paste it in any directory" does not work.** Only the roots above are scanned.
- **Skill names are sandboxed** to `^[a-z0-9-]+$`. A directory named `Dheeraj_Health_report` (uppercase + underscore) is **silently skipped** by the catalog and refused by the installer. Use `dheeraj-health-report`.
- **Workflow YAML is not parsed.** `agent-plugin.ts` logs "YAML workflow files not yet supported … Use .json format instead." Only `.json` templates load.

## 3. Can it import skills from the internet?

**Yes.** `nuvira skills install <name>` resolves across configured registries with four source kinds (`src/learning/skills-registry.ts`, `detectSourceKind`):

- `github-raw` — a GitHub raw URL / repo;
- `local-dir` — a local registry directory (offline);
- `browse-sh` — the browse.sh API;
- `git-repo` — shallow-clones **any** repo and auto-detects `skills/`, `.claude/skills/`, `.agents/skills/` roots.

Installs land in `<project>/.agents/skills/<name>/`, record provenance + SHA-256 in `~/.nuvira/skills-hub/provenance.json`, and quarantine on checksum mismatch (`src/learning/skills-hub.ts`). The `npx skills add` convention targets the same `.agents/skills/` directory, so market skills work **provided the agent's working directory is that project**. The default registry is the packaged `.agents/skills/index.json` (offline, private-repo-independent), with the GitHub raw URL as fallback.

## 4. Known defect (fixed): hub install dropped the SKILL.md body

`SkillsHubManager.install` in `src/tools/skills-hub.ts` fetched a skill and then wrote SKILL.md as **frontmatter only**:

```ts
writeFileSync(join(skillDir, 'SKILL.md'),
  `---\nname: ${manifest.name}\nversion: ${manifest.version}\ndescription: ${manifest.description}\n---\n\n`);
```

`SkillManifest` carried no body, so every installed skill was an empty shell (name + description, no methodology) — the exact opposite of what the skill catalog is supposed to inject. This is the `skills_hub` tool's install path (`src/tools/registry.ts` → `getSkillsHubManager().install(...)`).

**Fix:** `SkillManifest` now carries `content` (the raw SKILL.md), both source adapters (`GitHubSource`, `LocalSource`) set it, and `install()` writes the full source verbatim (frontmatter **and** body), keeping the frontmatter-stub only as a defensive fallback. Regression test: `tests/tools/skills-hub-manager.test.ts`.

This defect is separate from `src/learning/skills-hub.ts` (`installHubSkill`), which already wrote the real content.

## 5. Tag-scoped document knowledge — why not, and the first-class design

### Why file reading is expensive, and why vectors are the answer

Today, if the model needs an answer from a document, the document is read and injected into the prompt **on every turn** (`read_extract` → context). Cost scales with document size × turns, and latency is paid repeatedly. Vectorizing once and retrieving only the top-k chunks collapses both: the document is read and embedded **a single time**, and each turn embeds a short query and pulls back ~5 chunks.

### What exists (the primitives)

- **Embedding:** `src/memory/embedder.ts` — 384-dim, tier-1 local `@huggingface/transformers` model (default `Xenova/all-MiniLM-L6-v2`; retrieval model `Xenova/bge-small-en-v1.5`), with Python and LLM fallbacks.
- **Vector store:** `src/memory/vector-store.ts` — `{ id, vector, metadata }` entries, **one file per namespace** (`vectors.json`, `vectors-<ns>.json`), backends `json` / `faiss` / `auto`; `search(queryVector, k, filterFn)` supports a metadata predicate.
- **Chunking + retrieval:** `src/learning/retrieval.ts` — `chunkText`, `indexFile(s)`, `retrieve`, `assembleContext`. The current index is a **repo** namespace (`kind: 'repo-chunk'`, keyed by file path) and exists for token reduction — **it has no tag concept**.
- **Tagged memory (the closest thing today):** `src/tools/memory-tools.ts` writes `~/.nuvira/memory/memory-index.json` entries with `type` + `tags[]`; `search_memory` filters by tag; `fact-store.ts` adds a semantic half. These are **facts**, not whole tagged documents, and there is no per-tag vector index or document scoping.

### Gap

There is **no** first-class "ingest a document under a tag, retrieve by that tag, combine the retrieved data with generic model/web knowledge" pipeline. The behavior is reachable today only as user glue (a custom skill that reads tagged facts and calls `web-research`), and there is no multi-user/ACL scoping.

### First-class design (proposed)

Make tags first-class by giving each tag its own vector namespace and an agent-invocable tool:

1. **Storage model.** Namespace-per-tag: `knowledge-<tag>`, reusing the existing `VectorStore` and embedder. Entries carry `{ kind: 'knowledge-chunk', tag, sourcePath, chunkIndex, text, tokenCount, addedAt }`. No new store — just a new namespace convention, so it survives backend switches and upgrades for free.
2. **Ingestion (write path).** `knowledge.add(tag, paths[])`: extract text (reuse `read_extract` for PDF/docx/xlsx/images), `chunkText`, embed once, insert idempotently by `tag + sourcePath + chunkIndex` (re-index overwrites, never duplicates). Record a small manifest (`~/.nuvira/memory/knowledge-index.json`) of tags → documents → chunk counts for listing/removal.
3. **Retrieval (read path).** `knowledge.query(tag, question)`: embed the question, `store.search(qvec, k, e => e.metadata.tag === tag)`, return the top-k chunks with source filenames and similarity. Cheap and tag-scoped.
4. **Agent-invocable tool.** Register a `knowledge` tool in `src/tools/registry.ts` with actions `add | query | list | forget | stats`, so the model can invoke the pipeline itself mid-task ("answer questions from the `dheeraj-health-report` knowledge base").
5. **CLI.** `nuvira knowledge add <tag> <paths…>` / `query <tag> "<question>"` / `list` / `forget <tag>` — mirrors `nuvira retrieval` and `nuvira memory`.
6. **Hybrid answering (the "LDL + how to reduce it" pattern).** The retrieval returns the **data**; the model supplies the **generic** half. The `knowledge` tool's returned text should label provenance (`[from your data: <file>]`) so the model can state which part is user data and which is model/web knowledge. The existing `web-research` tool supplies the net-based half for current recommendations.
7. **Safety defaults.** Tags are validated (`^[a-z0-9-]+$`); namespaces are local-only under `~/.nuvira/`; ingestion never writes into the repo.

This directly answers "why can't the agent invoke a pipeline?": with the tool in step 4, it can — and because retrieval is vectorized, the cost is paid once, not per turn.

## 6. DeepSeek v4.1 Flash and parity testing

**Recommendation: yes, add it — for parity testing specifically.** The reason the free-tier numbers are unusable is substitution, not model quality: the WS7 run showed circuit-breaker cooldowns and a fallback to `qwen2.5:0.5b`, and the M2b noise floor is ±45 pt because a request is frequently served by a different model than requested. A paid, stable model removes that variable.

Before trusting the numbers:

- **Pin the model** and set `NUVIRA_STRICT_MODEL=1` so a substitution is refused rather than performed silently; then confirm in the trace that **served == requested**.
- **Ignore the dashboard picker's band.** `src/learning/model-capability.ts` `estimateModelCapability` is a **name heuristic** (`flash` → FAST_TIER 0.75), documented as existing only to prevent a silent downgrade — not a measurement.
- **Run the same tasks on both sides:** the WS7 seeded 7-task suite + an M2b pass, plus a few real tasks.

**On "Buffy vs agent-nuvira":** Buffy/Codebuff is itself running on **DeepSeek V4.1 Flash**. So a fair harness comparison requires agent-nuvira to be on the *same* pinned model — otherwise the result measures model choice, not the harness (routing, consent gate, tool loop, retrieval).

## 7. Open items

| # | Item | Notes |
|---|---|---|
| K1 | First-class tag-scoped knowledge pipeline | §5 design: namespace-per-tag + `knowledge` tool + CLI + hybrid answer labeling |
| K2 | Skill-name gate is silent | An invalid directory name in a scanned root is skipped with no warning; consider surfacing it in `nuvira doctor` |
| K3 | YAML workflow templates unsupported | Only `.json`; either parse YAML or document the limitation prominently |
| K4 | `.agents/skills/` ships | Personal skills must live at `~/.nuvira/skills/` — worth a docs warning |
| K5 | Retrieval is repo-only | `knowledge-<tag>` namespaces generalize it without replacing the repo index |

---

*Everything above was verified by reading the cited modules and running the checks listed in §1 on 2026-10-05. No personal data is included in this document.*
