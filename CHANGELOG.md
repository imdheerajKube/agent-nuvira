# Changelog

All notable changes to **Agent-Nuvira** are documented in this file.

## v3.3.2 — the agent holds its own release tokens, runs the release, and can push the commit

> The work below was driven through `nuvira publish --patch` against this repo as a live end-to-end test of the release capability, and the pipeline itself stopped the release four phases in: the version bump was committed, tagged `v3.3.2` and pushed, and then `npm publish` could not complete because the version-pinned CLI cast was still recording 3.3.1. The commit and tag were withdrawn and the tree returned to v3.3.1; the finding it produced is fixed below, and the artifact staleness is now handled by the bump phase rather than by hand.

The hardest defect this work found was not in the release pipeline at all. Asked to release this package end to end, the pipeline the agent could reach failed its **first model call** with `Groq API error (404): The model 'gemini-3.1-flash-lite' does not exist` — a Gemini id sent to Groq, on a machine whose config pins `providers.groq.model = openai/gpt-oss-120b`. Provider ranking was working; the provider×model PAIR was never validated as a pair, and the validator written to repair exactly this ran only for an **empty** model or the literal `default`, so a real, stale-or-foreign pin went straight to the API. Two earlier fixes to the same class had landed at one call site each (chat's failover, catalog-provider substitution) and never reached a shared path, which is why `publish` walked into it. That is now a single resolver every call goes through, a substitution that is announced and recorded instead of made silently, and — new in this release — the model is TOLD which model is actually serving it.

Asked to push a commit and publish this package, the answer was no — twice over. The model-facing git tool could not push at all, and the pipeline that could ran with no credentials while reporting success. This release answers both halves: release tokens are stored in the same 0600 env file the rest of the CLI already reads, the phases of the release pipeline are mechanical rather than planned, and `git push` is now a real action on the git tool — GATED rather than absent. The safety property did not move: the agent still cannot decide on its own that someone's work should leave the machine, and the raw `git push` SHELL string stays denied. Every claim below was verified by running the documented workflow, not by reading it.

- **Added: the git tool can push — and only when the user asked it to.** `git push` was structurally unexpressible in the tool's action enum (the comment said it plainly: "pushing is a human decision, never an autonomous loop"), so a user who asked for their commit to reach GitHub had to be told no. The action now exists and carries the gate instead of the refusal, via a new `requestRequestsPush()` beside `requestRequestsCommit()`: it proceeds when the user's OWN REQUEST named the push ("commit and push this to GitHub", or a remote destination paired with a commit-shaped intent — so "get this project committed to github" counts, which is how the ask was actually phrased), and it asks through `ask_user` otherwise. The distinction between the two helpers is load-bearing and tested in both directions: "commit these changes" records work locally and does NOT authorize sending it anywhere, while "how do I push?" and "don't push yet" authorize nothing at all. Every caller-supplied ref is allow-listed (must start alphanumeric, never a leading `-`, never `..`) and passed as an argv literal, so option-injection — `remote: "--force"` — is structurally impossible rather than filtered; a model-decided push emits the same visible-write event the commit path does, so it is reported and never silent. The raw `git push` SHELL string remains denied in `run_terminal`: the structured path validates its arguments, reports what it moved and asks first, and an unstructured string gets none of that. One detail only running it reveals — a push writes everything it has to say to **stderr**, so reporting it through the stdout-only helper showed a successful push as silence; the push path captures both streams.
- **Added: `nuvira credentials` — a release token survives the session that collected it.** `CredentialStore` was explicitly session-only (its docstring said "not stored to disk"), so every release began by asking for the same two tokens again; a scripted `nuvira publish` had no way to answer, and a tool-driven one cannot prompt at all. `credentials status` shows what a release would use (masked, with the origin of each value), `credentials set <KEY> --stdin` reads a secret from stdin so it never reaches shell history or a process listing, `credentials forget <KEY>` removes it, and `credentials verify` proves a token against the live API — `api.github.com/user` for git, `/-/whoami` on the registry for npm. Only a definitive 401/403 counts as a failure: a network error reports as unchecked and never blocks a release.
- **Added: the same vocabulary as an agent tool.** A `credentials` tool (`status|store|forget|verify`) lets a chat turn answer "do I have a token?" without the model ever seeing one — it never throws and never echoes a value. It joins the `publish` toolset, because it exists for the pipeline that needs it.
- **Fixed: the publish tool ran a credentialed release with no credentials — and reported success.** `setupGitCredentials()` / `setupNpmAuth()` both `throw` unless the store is collected, and the tool (which may never prompt) called them without collecting, inside ONE shared `try/catch` — so the pair threw on every tool-driven release and the single catch hid both. The store now has a non-interactive `initialize()`, the two setups have separate catches, and the tool's result OPENS with the credentials it is about to use (`🔑 Credentials: git ✓ (ghp_**…)   npm ✓ (npm_**…)`). A release that cannot push or publish now says so on its first line instead of completing quietly.
- **Fixed: version-pinned artifacts now move with the version, in the same commit.** The pipeline bumped, committed, tagged and pushed `v3.3.2` — and then stalled, because `prepublishOnly` runs the test suite and the suite pins `docs/demos/nuvira-cli-tour.cast` to `package.json` ("cast records v3.3.1 but package.json is v3.3.2"), so the publish could never finish. The dashboard bundle bakes the version in too, so the same bump left its committed assets stale. Both are now regenerated by the version-bump phase through an explicit `release:artifacts` npm script, which means the release commit contains the artifacts for the version it declares. A project without the hook skips it cleanly, and a hook that fails FAILS the bump instead of committing a version whose artifacts are stale — the v3.3.1 release had to do this by hand, which is what made it a pipeline gap rather than a one-off.
- **Fixed: the provider×model pair is resolved and validated in ONE place (`src/inference/route-resolver.ts`).** `resolveRoute()` returns `{providerType, provider, model}` where the model was validated against **the adapter that will serve the call**, and it is now the only way a call is constructed: the orchestrator (both the base provider and the auto-routed path), the resilient failover walk, the interactive loop (pinned, chain-resolved AND mid-turn failover), chat (both paths), the failover runner, the pipeline tool, NLU and benchmark all route through it. `resolveWorkingModel` is called nowhere else. Two bugs died with the duplication: the validator's gate (`!requestedModel || requestedModel === 'default'`) meant a non-empty model was NEVER validated — the only case it was written for — and `loop-executor` used an explicit `--model` as-is, so `-p groq -m <a gemini model>` reached the API unvalidated.
- **Fixed: a substitution is announced, recorded, and once.** Every substitution prints one line (`🔀 Model substituted: groq/gemini-3.1-flash-lite → openai/gpt-oss-120b ('gemini-3.1-flash-lite' is not available on groq)`), writes a routing-history row, and attaches to the active run trace — `recordTraceEvent` can now be called without a trace id and lands on the run in progress, so a recorder deep in a provider call is no longer dropped. It fires **once per pair per process** (a live chat turn printed the same repair twice: once from the pinned repair, once from the failover walk). `NUVIRA_STRICT_MODEL=1` refuses to substitute and names both halves of the pair, and the validator's own announcement is now opt-in so a strict-mode failure cannot print a swap it did not perform.
- **Added: the model is told what is actually serving it (`src/tools/loop-route-feed.ts`).** The loop's prompt described the tool surface, the project and the contract, and never the route — so "which model are you?" could only be answered from the user's config (what the ROUTER reads, not what answered), from memory, or from an earlier step, all of which are confidently wrong after a substitution or a failover. The loop now keeps ONE route frame in the thread, re-read from the live route before **every** model call and replaced rather than appended: a mid-turn failover is visible at the next step, the replaced pair is carried as "earlier in this turn", and an unresolved route says so and forbids inventing one. Wired for the loop executor and chat; neither knows the route when nothing resolved, and that case is stated rather than filled in.
- **Added: a release preflight, because a release has exactly one cheap moment (`src/agents/release-preflight.ts`).** The live run bumped, committed, tagged and pushed before discovering it could not publish. `nuvira publish` now checks FIRST, and stops before phase 1 on a **definitive** blocker: the version is already on the registry, the tag exists locally or on the remote, the package is `private`, there is no remote, or a model-calling phase has a pair that does not exist. A check that cannot be answered (offline, no token) warns and proceeds, and the summary says in words that those warnings are **not** claims that it passed. The model check runs only when a phase will actually call a model — since the phases became deterministic that is normally zero phases, and reporting a verified route nothing uses would be a decorative check. `--force` overrides; `--no-preflight` skips. The same preflight runs in the agent's `publish` tool, where a doomed release is worse because nobody is watching.
- **Fixed: a release is resumable, not restartable (phase scopes).** A killed run left commit `2d92a2e` and tag `v3.3.2` pushed and npm unpublished; re-running would have cut 3.3.3 on top of it, because the scope was saved on every phase and **never read**. `nuvira publish` now loads the saved scope, and `adoptSavedProgress()` continues the SAME release only when the target version matches: statuses are adopted by phase id (a phase added since runs), and `running` — the mark a killed process leaves — counts as unfinished, so an interrupted phase runs again instead of being stepped over. `--from <phase>` (id or the description shown in the output), `--fresh`, and `--force`. `PhaseExecutionEngine.getNextPhase`/`executeScope` had the same defect (`running` skipped) and are fixed with it.
- **Fixed: the release's own commit will not carry a dependency change nobody made.** The git phase compares the four dependency sections against `HEAD` and refuses to tag when they differ, naming each package (`+bcrypt (dependencies)`), because the live incident had two dependencies written into `package.json` mid-release by something outside the pipeline — one `git add -A` from a tagged, published release whose code never referenced either. `NUVIRA_ALLOW_DEP_CHANGES=1` for a release that genuinely changes dependencies. The mechanism that allowed an unattended write is closed too: `run_terminal` no longer treats a command that **adds** a dependency as recoverable autonomy (`addsDependency()` — `npm install` stays recoverable, `npm install bcrypt`, `yarn add`, `cargo add`, `--save-dev <pkg>` do not), because installing what a manifest declares is setup while declaring a dependency is a supply-chain decision.
- **Added: the test suite can no longer modify the project quietly (`tests/setup/tree-guard.ts`).** A vitest global setup snapshots the dependency sections of `package.json`/`package-lock.json` and the repo's dirty path set, and compares them after the run. A dependency change FAILS the run (nothing legitimate does it, and `npm publish` packs the working tree); other newly-dirty paths are reported by name, not failed, because a guard that trips on a developer's in-flight edit is a guard people learn to ignore.
- **Fixed: the phases of a release are no longer planned by a model.** "Bump version (patch), update CHANGELOG.md with release notes" is a command with one correct outcome, and handing it to the orchestrator made it depend on plan quality and provider health. A live attempt planned something else entirely — add `standard-version` to devDependencies, write a new `scripts/release.ts` — and then failed its write steps under a rate-limited provider. Every phase `buildPublishPhases` produces now carries a deterministic runner (`src/agents/release-runner.ts`) shared by the CLI and the tool: run the suite, bump `package.json` AND the lockfile's own version fields, insert a changelog entry generated from `git log` since the last version tag, commit, tag, push branch and tag, build and publish, then create the GitHub release from that changelog section. A phase WITHOUT a runner still gets the orchestrator, so `nuvira phase` is unchanged. An author-written `## vX.Y.Z` section is left exactly as written — the generated entry is a fallback for the case where nobody wrote one, never an overwrite.
- **Fixed: a scripted `nuvira publish` died mid-pipeline instead of reporting its failure.** On a failed phase the pipeline asked "Continue with remaining phases?" through `inquirer`, which throws `ERR_USE_AFTER_CLOSE` when stdin is not a terminal — so a non-interactive release crashed at the exact moment it had something to say. It now states that stdin is not a terminal and aborts, and the failure that caused it is the one the user reads.
- **Fixed: the HTTPS git helper answered every prompt with an empty string.** The askpass script written by `setupGitCredentials()` reads `BUFF_GIT_TOKEN` while the code that wrote it exports `NUVIRA_GIT_TOKEN` — so a stored `GITHUB_TOKEN` produced a helper that echoed nothing, HTTPS auth fell back to whatever credential helper the machine happened to have, and a machine with none simply could not push. The script and the env now agree on the name, and a test pins the two together.
- **Fixed: two ESM `require()` calls that only failed in the published build.** `secret-capture.ts` and `publish-tool.ts` used inline `require('fs')`, which throws `ReferenceError: require is not defined` in `dist/` — and because both sat inside `try/catch`, the failure surfaced as a silently-empty value (a version that read as `''`) rather than as an error. Both use static imports.
- **Fixed: four tests that encoded the behaviour this release replaces — found by RUNNING the suite, not by reading it.** The suite is the only thing that runs on every change, and these four assertions were passing by asserting the old contract; each one is now pinned to the new one, in both directions.
  - `tests/federation/a2a.test.ts` pinned a **nonexistent local model** so the pipeline would "fail fast (model-not-found)". Repairing a pair means that model is now SUBSTITUTED for a real one the provider serves — on a machine whose ollama *is* running, the pipeline then genuinely executed and the protocol tests timed out at 30s (measured: 7s before this release's change, 31s after, `delegateAndWait` alone at 30.0s). The file now sets `NUVIRA_STRICT_MODEL=1`, which restores the fast, hermetic failure AND pins that strict mode refuses to substitute.
  - `tests/agents/phase-engine.test.ts` asserted "should skip failed phases too" — the exact defect #13 fixes. A `failed` phase is unfinished, so it is now the next thing to run; a second test pins that a phase left `running` by a killed process is re-run rather than stepped over.
  - `tests/agents/orchestrator.test.ts` asserted `model "auto"` resolves to `config.model || 'default'`, **encoding the sentinel leak** the WhatsApp incident was: `default` is not a model id and 404s. The assertion is now the invariant (never `auto`, never `default`) plus the pin when one exists.
  - The same file's 500-telemetry test **passed alone and failed in-file**, because the model it expects the error to be recorded against is now ROUTED AROUND first (the previous test parks groq on a 429, and a live list cached from an earlier fake provider can substitute outright). It resets the registry, the quota ledger and the model-list cache before measuring — the isolation the new pre-call validation requires.
- **Added: the git phase NAMES what it stages, and refuses a nested manifest.** `git add -A` stages the whole working tree, which is right for a release (it ships the work) but means the commit's contents must be READ, not assumed. The dependency guard reads only the ROOT manifest, so a sub-package's `package.json`/lockfile could still enter a tagged release unseen; that is now refused unless `NUVIRA_ALLOW_DEP_CHANGES=1`. And the phase reports the staged paths by name (bounded) on the success path, because "21 files changed" said nothing about the two undeclared packages one `git add -A` was away from committing (issue #14).
- **Fixed: every public surface pointed at a repository nobody could open.** The bug tracker, the manual, the README, the SDK packages and the VS Code extension all linked `github.com/imdheerajKube/agent-nuvira`, which is private — so a user who followed any of them, including from the npm package page and the Marketplace listing, got a 404 on the one page that was supposed to onboard them. `package.json` (npm metadata), `README.md`, `docs/USER_MANUAL.md`, both SDK manifests, the extension manifest and README, the image label, the A2A agent card and the workflow-template URL now point at the public documentation repository, and the generated docs bundle no longer links a private source at all. Its own README carried RELATIVE links for as long as `docs.agent-nuvira.com` did not resolve, because the absolute site URLs it started with made the published README — the entry point to every other page — dead on arrival; that workaround is gone now that the address serves. All targets were checked with a live request.
- **Fixed: `docs.agent-nuvira.com` resolves, so the documentation is reachable at the address everything advertises.** Both addresses had been dead at once: the domain did not exist, and `imdheerajkube.github.io/agent-nuvira-documentation` 301'd to it, so every path into the docs ended at a name that did not answer. The subdomain now carries a CNAME to the documentation Pages project — which was attached but sat `pending` for want of that one record — and the site is served over HTTPS from it with the custom domain `active`. The README's prose links and every documentation link on `agent-nuvira.com` point at the rendered pages instead of `blob/main/…`, so a reader lands on a page with navigation, search and anchors rather than a wall of markdown; those anchors were verified on the live site (`#13-limitations-and-roadmap`, `#run-it-at-login-optional`). Only the README's "Repository layout" table stays repo-relative, because its whole purpose is to name paths.
- **Fixed: a stylesheet change reached the server but not the browser.** `agent-nuvira.com` sits behind a zone whose four-hour Browser Cache TTL outranks anything the `_headers` file says, and this toolchain holds no purge permission — so the new docs layout shipped while anyone who had loaded the site earlier kept the previous 42,023-byte stylesheet, which contains no `.docs-toc` rules at all, and saw a docs page with no sidebar and a disaligned header even though the deployed bytes were already correct. The generator now writes each asset's own content hash into its URL (`styles.css?v=d18ee3ce5092`), so a changed sheet is a different cache key and the stale copy is simply never requested again. This is why the fix lives in the URL rather than in a header.
- **Added: the site is deployed by the documentation repository, on push.** The private repository cannot ship it — its metered Actions refuse to start jobs, which is the state every one of its workflows has ended in since 2026-09-22 — so a push there deploys nothing. Cloudflare's own Git integration is the tidier answer and a Pages project *can* be pointed at this repository and builds on demand, but pushes to `main` produce no deployment at all: a real commit produced no build, no commit status and no webhook effect, so it cannot be the thing that ships the site. An explicit upload from a workflow in the documentation repository is what fires, with the Cloudflare credentials held as repository secrets, and the deploy now happens on the same push that publishes the docs.
- **Added: the website documents the product instead of sending visitors away.** `agent-nuvira.com` ships a docs page (requirements, install, provider setup, first run, everyday commands, recipes, troubleshooting, and links into the public docs) reachable from the top nav, so the two clicks between "what is this" and a working install happen on the site. The top nav was reduced from ten entries to seven to make room — at ten, adding an eleventh overflowed the 1200px container at every desktop width (measured) — and the inline nav now collapses to the hamburger between 769px and 1000px, where it previously collided.
- **Verified:** `tsc --noEmit` clean. The full suite was run in five chunks (the runner caps a single command at 10 minutes; the suite does not fit): **6,776 passed / 345 files, 18 skipped, zero failures**, including the four regressions above. New coverage: 27 release-runner tests (version arithmetic, the changelog rules in both directions, the `release:artifacts` hook in all three states, npm error translation, a runner on every published phase, a git phase that refuses to tag without a remote or with a nested manifest, and a full stage-commit-tag-push that names its staged paths), 10 credentials-tool tests, the credential-store tests extended for persistence, `0600`, masking and forgetting, and the git-tool suite extended for the push gate in BOTH directions (a commit-only request is refused, a request that names the push proceeds, `confirm:true` after `ask_user` proceeds, a model-raised push asks), the allow-listed refs (`--force`, shell metacharacters and `..` refused), the stderr capture, and a real push to a local bare remote.
- **Verified end to end, by running it:** `nuvira publish --patch` bumped 3.3.1 → 3.3.2 with no model in the loop, committed 21 files, tagged `v3.3.2`, and pushed both to `origin/main`. The npm phase that followed is what exposed the stale-artifact gap above, and that attempt was withdrawn rather than published — the correct outcome for a pipeline that cannot verify the artifact it is about to ship. It was re-run from a clean v3.3.1 tree once the gap was fixed, and the result is recorded at the end of this entry.

## v3.3.1 — the permission model attaches to the intent, the loop keeps a trace of its own behaviour, and the model's own tool JSON stops reaching the answer

A live calculator fix was described by its own user as "like the product has a bug": eight turns of edits behind roughly one permission prompt per operation. Reading the stored session found the mechanism — authorization re-derived from the last user message at the granularity of each individual tool call — and fixing it re-based three gates, then re-based them again on a representation of the run the loop never had. One documentation surface and one answer-cleaning defect are fixed alongside. Every claim below is verified against that session's verbatim transcript and the suite; the version is a patch only in the sense that no existing command changed its contract.

Stage 2 and Stage 3 of the autonomy work. Stage 1 removed the friction (permission attaches to the intent); these give the agent something it never had — **a representation of its own run** — and finish re-basing the gates.

- **Added: the Run Trace (`src/learning/run-trace.ts`) — the loop's memory of what IT did.** The live audit's sharpest finding was not that the agent asked four times; it was that it **could not have known**. Nothing counted the questions (`permissionNudges` counts the loop's own nudges), nothing compared one question to another, and the transcript is not data anything reasons over — so the user's "why are you asking me this again and again?" had no answer available, and the turn replied with an edit plan. The trace records every question with a SHAPE (explicit targets first — backticks, file paths, command names — then significant words with the permission boilerplate stripped), every refusal with its reason, and every mutation with its target. `questionShape`/`isSameQuestion` are what make it work on real data rather than on invented examples: the four phrasings a live turn actually asked ("May I run `node -c script.js` to perform a syntax check?" … "Run a JavaScript syntax check (node -c script.js)?") collapse to ONE question, while "which runtime?" and "which database?" stay distinct. Scoped per CONVERSATION like the envelope (the session's plan store is the key, so a loop across turns is visible and the entry dies with the conversation), bounded to the last 60 entries, and deterministic — counting, never a model call.
- **Added: the REPETITION gate — never re-ask a question the user already answered.** `ask_user` now checks the trace FIRST, before the authorization suppression, because repeating is a defect on its own terms whatever the request authorized — which is precisely the case that fell through: the complaint about repeated questions was itself the message that failed to authorize. A repeat is refused with the answer the user gave, and the model is told not to ask again, to act on the answer it has, or to state plainly what blocks it. Irreversible choices are exempt ("which of these two files should I delete?" is a genuinely new decision each time it is put), and the loop gains a second bounded nudge that fires on the trace rather than on authorization — deliberately **not** saying "proceed", which would be unsafe when the answer was no.
- **Added: answering a question ABOUT the run from the run.** A user asking about the agent's own behaviour ("why are you asking me again", "stop asking every second", "you keep asking permission") is a distinct FRAME from a request, and it previously routed through the analysis path — so it was answered with planning prose. It now injects the trace's self-report (questions asked, which one repeated, what the user answered, refusals, files changed) and requires an answer about the process instead of a plan for the work.
- **Changed: the verification nudge NAMES this project's check (`verificationNudgeFor`).** The nudge already stated the right preference order (project tests → typecheck/build → a real run) and still failed live, because the model had to guess what the project HAS and reached for `node -c` — the cheapest thing available and the one that cannot count. `detectAvailableChecks` reads the workspace (package.json scripts, vitest/jest configs, pyproject/pytest, Cargo.toml, go.mod, tsconfig.json) and the nudge asks for the actual command, ranked. A project with no runnable check gets the honest instruction: a REAL RUN, or say so and do not claim the change works. Filesystem-only, never throws, and tested against an unreadable package.json.
- **Changed: the remaining gates consult the durable grant.** `run_cli` now reads the envelope — and ONLY for the intents the CLI policy itself classifies as recoverable; everything else is handed to the envelope as `destructive`, which it never covers, so irreversible intents keep the gate they had and this cannot widen what may run.
- **Added: the interruption metric, measured by BEHAVIOUR (`permission-asks per completed task`).** Completion and test-pass cannot see the reported defect: a task can pass every hidden test and still have interrupted the user four times. The loop now reports its run trace in `ToolLoopResult`, the loop executor carries it, and the eval framework records `permissionAsks` / `asksPerCompletedTask` and averages them in `EvalSummary.avgPermissionAsks` — **over the runs that reported it only**, because averaging in a pipeline arm's structural 0 would make a regression look like an improvement. It is deliberately NOT in the composite score: adding a weight would move every historical score and let an unrelated regression read as an autonomy regression. A new task ships with it — `loop-autonomy-multistep`, a fully-specified four-step job with `maxPermissionAsks: 0`, because when nothing is ambiguous the count must be zero (a vague goal would measure the model's judgment about asking, which is a different question).
- **REPLAYED, not asserted.** A new test drives the recorded turn's exact actions — the request verbatim from session `f624a182` turn 38, the four edits, the `node -c script.js` verification attempt and the four permission questions, all verbatim from the transcript — through the real gates, and counts the renders: **4 prompts before, 0 now**, with the syntax check running untouched and the envelope granted.
- **Verified:** `tsc --noEmit` clean. New coverage: 30 run-trace tests (shape matching, repeat counting, bounded storage, self-report, the process-complaint frame), 7 repetition-gate tests through the real `ask_user` tool, 8 verification-ladder tests, 6 eval-metric tests, and the 5-case replay. Full suite: **6,662 passed / 337 files** (18 skipped), zero failures, over both shards.

### fix: permission attaches to the INTENT, not to each action

A user fixing a four-file calculator approved "yes" roughly every second operation and described the result as "like the product has a bug." It was. Reading the stored session (`f624a182`, `/Users/dheeraj/Documents/cal`) found the mechanism exactly, and it was worse than the symptom. **Authorization was re-derived from the last user message on every turn, at the granularity of each individual tool call**, so the number of permission prompts equalled the number of state-changing operations — and the machinery that exists to suppress them keyed off that one per-turn boolean.

- **Fixed: a leading question de-authorized the whole turn — so complaining about the prompts caused more of them.** In turn 38 the user wrote, verbatim: *"why are you asking me this again and again ? 🤔 Apply a safe expression parser … by updating script.js"*. `requestAuthorizesWrites` opened with `const analyzing = ANALYSIS_OPENER_RE.test(text)` — whose first alternative is `why` — and returned `{ authorized: false }` **before any directive check ran**. The turn that plainly ordered a rewrite was classified unauthorized, which switched OFF the very gates that would have stopped the asking. The verdict is now judged **clause by clause**: a message may carry a question AND a directive, and only a message with no directive clause remains a question. Ten of the parser's own tests changed meaning with it, in both directions — `why is the build failing?` still does not authorize, while `Can you create the interactive book site?` still does (the polite-request carve-out is preserved by keeping the analysis-opener list free of can/could/would/do, NOT by a trailing-`?` test, which would have broken it).
- **Fixed: verb inflections were invisible.** The verb regexes anchored on base forms (`\bupdate\b`), so **"updating" — the form people actually write — matched nothing**, and the live directive above was caught only by luck of a second verb. The verb bodies now use e-dropping stems with an explicit suffix set (`updat`+`ing`, `chang`+`ing`, `cod`+`ing`, `add`+`ing`, alongside `updat`+`e`), so an inflected directive is the same evidence as its base form.
- **Added: the Intent Envelope (`src/learning/intent-envelope.ts`) — one grant, then execution.** `{ goal, scope (tools + optional path prefixes), grantedAt, expiresAt, source }`, granted by an explicit directive request or — the high-trust path — by **the user approving the plan**, and keyed to the CONVERSATION so it outlives the turn that granted it. The key is the session's own plan store, which the dashboard console already keeps one of per session and re-injects every turn, so durability across turns cost zero new plumbing and dies with the conversation (a `WeakMap`, so nothing leaks). Two properties are load-bearing: it **expires** (two hours, no renew-on-use — a grant that never ends is a permanent licence), and it **never covers `external` or `destructive`** — a plan approval is not a licence to publish, delete or spend, and those keep asking, individually and always.
- **Changed: the gates consult the grant first.** `edit_file` inside an approved intent is now EXECUTION rather than a fresh decision (the old evidence-based judgment runs unchanged when no envelope exists); `run_terminal` and the `ask_user` suppression read it too, so a permission question about approved work is settled by the policy instead of becoming a message. The suppression's audit line now names the real authorizer ("approved envelope: … (plan-approval)" reads very differently from "this message asked for files"), and its text tells the model not to ask again for the same work. **One deliberate carve-out:** a whole-file REPLACE is covered only when the envelope NAMES that path — a project-wide grant ("fix the calculator") authorizes edits but must not authorize clobbering a file the request never mentioned, because a re-run cannot recover a wholesale overwrite. **`git commit` is deliberately unchanged** and stays request-named for the same reason: an envelope for "fix the calculator" must not silently unlock committing.
- **Fixed: the cheapest verification was the one gated — which is how one turn produced four prompts for a syntax check.** `node -c script.js` was absent from `run_terminal`'s verify allowlist, so it classified `confirm`, the tool refused, and the refusal said "call ask_user, then retry" — a **read-only parse check that cannot mutate anything** generated a permission round trip every time, exactly as the verification nudge (which asks for "a check" without naming one) pushed the model toward it. `node -c` and `node --check` are now verify-class. The boundary is deliberate and pinned by test: **"parses a file" vs "runs a program"** — `node script.js` and `node -e "…"` stay confirm-class.
- **Verified:** 20 new envelope tests (grants, expiry, per-conversation isolation, tool and path scoping, the external/destructive veto, and the named-path overwrite guard), a regression test for the live turn in both directions, and 15 `write-autonomy` tests now covering the grant. `tsc --noEmit` clean; full suite **6,601 passed / 335 files** (one pre-existing timeout in `tests/agents/orchestrator.test.ts` under parallel load, which passes 92/92 in isolation and touches none of this).

### docs: the CLI demo is a reproducible artifact, and the social card shows the real thing

Nothing here changes an answer, so the fix below stays the only behavioural change in this release. What these close is a documentation and packaging surface that was either absent or already stale.

- **Added: a reproducible CLI tour, captured from the REAL binary — `scripts/generate-cli-demo.mjs` + `docs/demos/nuvira-cli-tour.cast`.** A hand-recorded video is wrong the moment a command is renamed and cannot be re-made on a build machine; an asciinema v2 cast is text (a few tens of KB), diffable, regenerable, and embeddable. **Two defects were found and fixed while verifying the artifact rather than assuming it:** the events were timestamped in **milliseconds** into a format that specifies **seconds**, so the ~45s tour declared a 44,944-second (12.5-hour) duration and a player would freeze on the first event — and the curated tour included commands that print the developer's own state (`stats`, `history list`, `trace list`, `memory list/facts`, `nlu learnings`, `gateway logs`) plus a partially-masked API key and a Twilio number, which is not something to publish from a project whose pitch is "privacy-first, no telemetry". The generator records 21 commands against the built CLI (`npm run demo:cli`, or `demo:cli:all` for every command in `docs/COMMANDS_SURFACE.md`) and obeys safety rules so it is safe on a developer's own machine AND publish-safe: **no command that spends, sends, publishes or mutates** (`chat`, `execute`, `gateway send`, `publish` and the mutating `memory`/`skill`/`config` verbs appear as their `--help` — the action never runs); **no command whose output is the developer's own prose or state** (`stats`, `history list`, `trace list`, `memory list/facts`, `nlu learnings` and `gateway logs` print real session titles, prompts, memories and message metadata, and prose cannot be reliably redacted — so those commands are kept out of the tour rather than scrubbed); **everything else passes through `redact()`**, which removes key-shaped tokens INCLUDING the CLI's own partially-masked form (`gsk_cy...S9ak` still leaks five characters each side of the mask), home directory paths, phone numbers and emails, while leaving every product name, model id, count and latency intact; and **everything runs in a throwaway cwd**, so a stray write lands where it is deleted rather than in the repo. Nothing is hand-written; every line is captured from a real process. Verified by scanning the committed cast: zero home paths, zero key fragments, zero phone numbers — while model ids, provider status and the 22-platform list stay real. Wired into `package.json` (`demo:cli`, `demo:cli:all`), linked from the README, and documented in `docs/demos/README.md` — which is whitelisted in `.gitignore` for the same reason `docs/COMMANDS.md` had to be: a tracked link to an untracked file is a 404 on every fresh clone. Two guards keep it that way and run in `npm test` (`tests/docs/cli-demo.test.ts`): `--check` runs every curated command against the BUILT CLI and fails if a newly curated command prints local state or if its redacted output still matches a secret pattern, and `--check-cast` validates the committed artifact (header, SECONDS-scale monotonic timestamps, no secrets, and a recorded `--version` matching `package.json`, which is what makes a STALE cast impossible to commit). Both live in the generator so the scrubber and the guard share ONE `SECRET_PATTERNS` list — the only way to add a pattern the guard accepts is to also redact it. `intent eval` was dropped from the tour while wiring this: it is a model-backed eval that takes >45s and prints nothing, so it stalled the recording AND made the guard wait out its entire timeout on it.
- **Fixed: the social card was the hero image, not a card.** `website/index.html` shipped `og:image` as `assets/hero.png` — a tall product screenshot that every platform cropped arbitrarily. It now points at `assets/og-cover.webp`, a purpose-built 900×600 cover, with `og:image:width`/`height` declared so a scraper lays it out without fetching it first.
- **Fixed: `npm run demo:cli` generated BOTH casts, so the documented command left an untracked 214 KB artifact behind.** The generator's default is `--only ''`, which satisfies both `!only` branches — so the curated tour AND the full sweep were written on every run, while `docs/demos/README.md` states that `demo:cli` produces the tour and that the sweep is "generated on demand, **not committed**." The sweep was not ignored either, so a regeneration surfaced it as untracked and one `git add -A` would have committed a file the README says is not in the repo. `demo:cli` now passes `--only highlight`, the sweep is explicitly ignored with the reason, and the docs and the scripts finally agree.
- **Fixed: the tool contract told the model to call a binary by an alias we lead with nowhere else.** `TOOL_CONTRACT`'s `run_cli` guidance named `buff` (one of three bin aliases) while the README, the curated command reference and the setup output all say `nuvira`, so the resolved command the model reported back did not match what the user was told to type. The contract now names `nuvira` too.

### fix: the model's own tool JSON no longer reaches the answer, and its suggestions are no longer thrown away

Found by reading a real chat rather than a test: every turn ended with raw `{"suggest_followups":[…]}` text as the last lines of the answer — **13 of 16 assistant turns in one calculator session, 16 turns across all stored sessions** — and `followups` was never captured, so no chips appeared either. **One defect in one shared helper, three separate reasons it survived.**

- **Fixed: the strip knew three shapes of the followups contract; models write a fourth.** `stripToolCallArtifacts` is the single strip called by every surface (CLI chat, `execute`, dashboard console, gateway), and it recognised the canonical `{"tool":"suggest_followups","arguments":{…}}`, the bare `{"followups":[…]}`, and the captioned array. What models actually hand-write is the tool's **ARGUMENTS keyed by the tool's own NAME** — `{"suggest_followups":[{prompt,label},…]}` — which matched none of them. The canonical shape, the one our own `TOOL_CONTRACT_JSON` shows as the example, appeared **ZERO times across 116 stored assistant turns**, so matching only that shape matched nothing in practice. `isFollowupsPayload` now accepts the name-keyed payload, which cleans chat, execute, dashboard and gateway from that one change.
- **Fixed: the recovery was gated on the shape it could not parse.** The loop's text-call recovery ran only when the content contained the literal `"tool"`, and `extractFallbackToolCalls` could not parse the name-keyed form anyway — so the JSON was delivered AND the suggestions were discarded. The gate is now the shared `TEXTUAL_TOOL_CALL_HINT`, the block becomes a REAL `suggest_followups` call, and the loop's existing sink collects it so every surface renders its chips/menu. A gate that only knows one shape is a gate that silently disables the fix for the other.
- **Fixed: sessions already in the store kept rendering the raw JSON.** The dashboard's `history()` served the transcript verbatim, so reopening a conversation (or the 15s refresh) re-rendered the stored artifact — a fix covering only new turns would leave every existing session unreadable. The read path now sanitizes; the WRITE path does not, because the transcript is the user's record (asserted by test). The same sanitized view seeds the next turn's context, so the model is no longer fed its own tool JSON back as history.
- **Fixed: a dangling `---` under every cleaned answer (pre-existing).** `stripTrailingFollowupsHeader` required the horizontal rule at the very end of the string, but its caller slices at the payload's opening brace — so `…answer\n\n---\n{payload}` handed it `…answer\n\n---\n` and the rule survived. It tolerated no trailing newline (`[ \t]*$`) where it needed to (`\s*$`).
- **Conservatism, because this helper must never delete a deliverable.** The name-keyed branch is STRICT: the tool's schema only allows `{prompt,label}` objects, so `{"suggest_followups":["alpha","beta"]}` and `{"suggest_followups": "a note"}` survive untouched, as does an unterminated code block that is not our opener. A truncated payload is consumed only where it is bounded (inside a fence) or via the loop's own extraction.
- **Verified against the real data, not a fixture:** replaying all 16 stored payload turns through loop-extraction + the surface strip gives **0 raw JSON, 16/16 recovered, 0 dangling `---`**. 5 new tests pin the shape from both sides — recovery, strip, and an end-to-end `answerOnce` assertion that the text is clean and the followups reach the caller.


## v3.3.0 — feat: an authored artifact lands on disk instead of in the reply, the loop engine leaves a reviewable trace, and a long unattended run accounts for what it cost

Three gaps left open by earlier passes, closed in the order that made them verifiable: **make the artifact land, then instrument what the run actually needed to see.**

- **Fixed: an authored deliverable was ANSWERED IN CHAT instead of being written (`G13b`).** Two live runs — a 12-page story and a web-book — composed excellent prose into the reply and wrote **nothing**: `write a 2 page story to /path/kharig-nights.md` named a destination the user never got a file at, and `write a 12 page story at /path/Mahagatha.md` was answered by the loop engine because the provider tier (not the ask) decided the engine. Two predicates now decide it, and the split is the point. `wantsAuthoredArtifact` (authored work AND the request authorized writes) routes the default path to the pipeline — the engine that plans units, keeps continuity across batches and ASSEMBLES the document — and arms the loop's own deliverable gate; `asksForAuthoredFile` is the NARROWER rule the chat-vs-task gate uses, and it needs a multi-unit magnitude OR a **named destination path**, because the gate must stay narrow: for `write a poem about rain` the text IS the deliverable. The narrow half is what the live failure needed — `2 pages` resolves to ONE unit, so the existing magnitude rule missed it and the ask fell through to the chat mapping (the engine router is never reached when an ask is called chat). The loop engine gets the backstop for an explicit `--engine loop` run: ONE bounded nudge naming the destination the request itself gave, at both turn exits, placed after the verification gate so edit turns stay byte-identical, plus an `undeliveredArtifact` honesty flag that is a function of what the turn DID — so no caller can read "the story is done" from a turn that wrote no file, whether or not the gate is enabled. **The first attempt at this was too broad and the test suite caught it in one run** (`write a poem about rain`, `write a song in Hindi`, `write an essay about my village`, `write a 1 page summary` and a bare `a book` were re-routed to the pipeline — 8 failures across four suites), because those chat asks had been pinned as deliberate decisions in earlier sessions; the split fixed all 8 without weakening the rule, and both halves are now pinned from both sides.
- **Added: the loop engine leaves a reasoning trace, and its tool calls, gate decisions and refusals are reviewable (`G18`).** The engine that runs by default was the only one with no evidence trail — an `execute` run wrote NOTHING to the trace store and `-v` never printed a tool RESULT — so "the trace store showed 0 confirmation refusals" meant *it cannot see refusals*, not *there were none*, and the audit of the confirmation gates had to be done by reading code and driving the real tools. A trace now carries LLM `steps` (with the loop's thread serialized through the SAME layer splitter the chat transport uses, so the stable layer's byte-stability is actually checkable for a loop run) AND a separate `events` list: every tool call (name, args preview, pre-decoration result preview, ok/error, wall-clock), every gate DECISION (a nudge spent, an autonomy probe proceeding, a bound reached) and every REFUSAL — classified as a confirmation decline, a loop guard, an unknown tool, an unloaded toolset or a disabled tool, because a guard is not a provider error and only the record can tell them apart. The separation from `steps` is deliberate and load-bearing: a step is an LLM call with a prompt digest, model, tokens and latency, and folding a tool call into that would corrupt every aggregate the Trace tab reports — so `getTraceStats()` counts `totalEvents` / `refusals` / `gateDecisions` on their own. The loop DESCRIBES and the surface records (`onTraceEvent` is a best-effort option, wrapped so a broken recorder can never break the turn it observes), which is the coupling that kept it invisible in the first place. `nuvira trace show` lists events and `-v` prints each tool result under its call, so a live run can distinguish "the gate applied the edit autonomously" from "the model passed `confirm:true` without asking".
- **Added: a long unattended run accounts for itself — per-batch cost and latency (`G27`).** The run reported a batch COUNT and a percentage, which answers neither question a long job raises: what did it cost, and is it slowing down. `UnattendedJob` now carries `costUsd`, `tokens` and a bounded `batchStats[]`, and `formatBatchReport()` prints the per-batch table plus a measured total on every completion path (and the gateway feeds it too, so a WhatsApp book is measurable). Three properties matter: the window is measured from the **persisted** cost ledger rather than a session counter (each batch runs through a fresh orchestrator and, after a resume, a fresh process — a per-instance counter would report zero for every batch but the first); **a failed batch is accounted** (it still burned tokens, and counting only the batches that succeeded would understate the bill of exactly the runs most likely to be expensive); and **a dash is never a fabricated 0**, so "free" and "not measured" stay distinguishable.

- **Fixed: a DECLINED tool call could read as work done.** Found on the first live verification of the trace above, and it is exactly the shape the trace exists to eliminate: the model tried an absolute path, the workspace guard refused it, and the record said `write_file ran` — because the denial carried no `Error:` prefix and the loop's success test was `!startsWith('Error:')`. The refusal is now classified (`gate: 'workspace'`, alongside the confirmation and loop-guard classes) and **the classifier is the authority for both the event kind and the success verdict**, so a refusal can never again be counted in `successfulToolCalls` or rendered as a call that ran. Anchored to the boundary phrasings rather than the bare word "denied" — a `run_terminal` that reads a log containing "Permission denied" is a successful call.
- **Fixed: progress could read 100% while units were still owed.** Writers overshoot, and a live 100-page run showed why that matters: 43,906 words against a 35,000 target by chapter **31 of 39**, so a word-only percentage saturated at 100% and the line read "chapter 31/39 complete … 100%" — with five more batches still to write. `jobProgress` now takes the **minimum** of word-completion and unit-completion, so 100% means the deliverable EXISTS (all units done) rather than "the word count ran out of road". Same class of contradiction as a listing count presented as a capability, one layer down.

## v3.2.0 — feat: the agent VERIFIES its own work, finishes long unattended jobs, and every number on the Models page means what it says

The enterprise-grade hardening pass. Four clusters, one theme: **the agent may not claim what it has not checked, may not stop while work is outstanding, and may not present a listing as a capability.**

- **Added: edit-verification guards — an edit that nothing verified can no longer be reported as done.** The calculator audit found the sharpest agent-side gap: across 99 LLM calls the loop never once ran `run_terminal`/`test`/`browser`, editing files and *asserting* they worked ("successfully fixed", "now fully operational") eight turns running while the user reported the same breakage. The existing honesty guards covered only DELIVERY claims (`gateway_send`), so a code change had no equivalent. A turn that edits files, makes a claim, and runs nothing now records `unverifiedEdit` + `unverifiedEditClaim` in the trace and gets ONE corrective nudge naming what would settle it; the CLI prints the same warning the dashboard badge shows (`src/tools/edit-verification.ts`).
- **Added: a working-state ledger for long work, and unattended execution behind it.** `src/learning/working-state.ts` records what an unfinished job still owes (deliverable class, unit/phase plan, which units are satisfied) and every surface reads it before deciding anything — so a long ask is resumed rather than re-decided, and a batch that fails at the model layer reports MEASURED progress (`14% done · 📖 chapter 1/8 · 582/7,000 words · 4/14 files`) instead of "Failed". Continuation batches skip the reasoner and planner entirely (the design is already committed, and the plan is a deterministic function of the ledger), while a first, fresh ask still runs both.
- **Added: phased plans for composite deliverables.** `src/learning/deliverable-class.ts` + `src/agents/composite-plan.ts` recognise that *"an interactive web book with voice narration"* is an authored work AND software, and plan phases (prose + site + narration script) rather than force-classifying the ask as one or the other. An idempotent writer reporting "no changes" is no longer counted as a FAILED step, and greenfield creation routes to the one-shot writer (the read→edit→verify writer has nothing to read in a directory that does not exist).
- **Added: provider output limits are learned, not assumed.** Re-running the story task, EVERY prose unit failed with the same Groq 400 — `max_tokens must be less than or equal to 512` — because `resolveMaxOutputTokens()` reads the CONTEXT WINDOW (this model advertises a large window with a 512 output cap), a caller's hard-coded `8192` beat the capability lookup, and the provider's own message naming the limit was thrown away and the mistake repeated on the next unit and the next batch. `src/learning/provider-limits.ts` parses the named limit (Groq/OpenAI-compat, Anthropic, Gemini; nested `cause`/`response.data`; camelCase normalised so one pattern set covers `max_tokens`/`maxCompletionTokens`/`maxOutputTokens`), LEARNS it per provider × model, applies it predictively, and clamps + retries once on rejection — only ever clamping DOWN, so a provider that accepted our request is never overruled. Wired at the orchestrator's single call point, so every agent gets it.
- **Added: the request's OWN authorization is an input to every confirmation gate.** A gate that is binary (confirm or refuse) has no notion of work the request already authorised, so the agent asked permission for things it had been told to do — *"Do you want me to create the full project structure…?"* — and a file the ask named was left unwritten. `src/learning/autonomy-policy.ts` derives that input from evidence (explicit confirmation, a continuation, a named destination path, a creation verb applied to a file-shaped deliverable — with an analysis opener VETOING the last two so "explain how to write a story to a file" stays a question) and `decideStateChange` resolves one question per gate, checking the never-autonomous classes FIRST so no later rule can make a `destructive` or `external` action autonomous. `write_file` applies an authorised CREATE without a round trip (overwrite still refuses), `edit_file` proceeds when the request names the path or the edit is surgical (≤50% of the file — the same preserve-vs-replace rule as overwrite, and validation now runs BEFORE the confirmation, so nobody is asked to approve an edit whose `old_string` may not match), `run_terminal` gets a narrow recoverable-workspace allowlist (rejected inside a composed command and for `-g/--global`), `run_cli` requires the request's own words to resolve to the IDENTICAL command, and `git commit` is unlocked only by the request naming a commit. A genuine decision input is still the user's: `ask_user` passes an irreversible action straight through. Every autonomous decision is REPORTED, never silent, and 37 + 9 + policy tests pin the negatives (unauthorised asks still refuse; overwrite is refused byte-for-byte).
- **Added: layered prompt tracing, and the channel/format policy moved into the stable system layer.** `src/learning/prompt-layers.ts` records a per-layer digest and size for every step (`systemDigest`/`contextDigest`/`volatileDigest`), so the stable layer's digest staying constant across steps is what PROVES the system prompt is cacheable — the flat `promptDigest` could not show that — and the full system prompt is reviewable in the trace detail view. Output-format policy no longer rides in the volatile user turn.
- **Fixed: a zero-output step is never a success.** `withTraceCapture` records an EMPTY response as a failure, so no trace step reports success for a call that produced nothing.
- **Fixed: the Models page presented a LISTING count as a capability count.** The headline read *509 available* from a live catalog probe (one provider-level credit check stamps ~400 OpenRouter ids "Available") while the agent routed 87% of a day's calls to a single model — two truths about the same models, on the same screen, with nothing connecting them. `/api/models` now reconciles through the registry's OWN `isUsable()` predicate (duplicating the staleness/park rules would recreate the divergence), reporting `routable` / `registryTotal` / `registryVerified` and a per-model verdict with the learned reason, so a model the router cannot pick no longer reads identically to the one it uses constantly.
- **Fixed: routing was frozen AND decaying.** The warmup cycle only ever considered models THIS process had already used, so a never-used model could never be verified — and could never be used; the pool was 12 verified models across 3 providers against 496 unverified ones, and the registry's own 7-day staleness rule then RETIRED models nothing re-verified (4 of the 12 were already at 142.8h). The daemon also only started from the COLD-START branch. `selectExplorationCandidates()` now offers never-verified models for a one-token spot-check — **providers with the fewest verified models first**, servable providers only, bounded per cycle and per model, self-terminating, `unref()`'d so it can start on every run without holding a CLI command open.
- **Fixed: the test suite was writing into the production store.** `local/nonexistent-fast-fail` — the largest row in "Learned from real usage" (2,110 of the log's 3,436 lines) — exists only in `tests/`. Proven by experiment: `tests/federation/a2a.test.ts` isolated its config dir but not its memory dir, so the real pipeline it drives recorded 20 real telemetry events per run plus a permanent dead-pair entry. `tests/setup/hermetic-env.ts` now gives every test file a throwaway store (wired as `setupFiles`), verified by re-running the same file and finding the real registry byte-identical.
- **Added: telemetry provenance, and cost/entitlement labels that never hide a model.** Records carry `origin` (`live` | `test`) stamped at the single write path by `telemetryOrigin()`, excluded from every "learned from real usage" number and COUNTED (`insights.synthetic`) so the exclusion is stated in the dashboard and in `nuvira models status --verbose` — the hash-chained log itself is left intact, because rewriting tamper-evident history to make a chart look nicer is the data owner's call. `src/inference/model-entitlement.ts` labels each model `free` | `metered` | `unknown` with its basis, and never filters: hiding paid models is how a user who just bought credits concludes the purchase failed. A zero catalog price is deliberately NOT read as free (Gemini carries `0/0` and its paid models 403 without billing), the `nuvira` gateway is not called free (it forwards to providers that bill), and an unusable model now says WHY — "this id does not exist on the endpoint" vs "your key cannot use this model" — instead of a flat "unavailable".
- **Added: a key change triggers a re-probe.** There is no per-model entitlement API to ask, but noticing that the KEY SET changed is cheap and was invisible: the pool only grows from a probe, and probes only ran on a cold start — so a purchase made mid-session changed nothing. `src/learning/credential-fingerprint.ts` stores a SHA-256 digest of the credential SHAPE (never a key, not even truncated), and the warmup cycle forces one `refreshModelRegistry` when it differs: once per change, with a fresh machine reported as `firstRun` rather than as a purchase. The sweep's own bounds are now configuration (`NUVIRA_WARMUP_*`) instead of source constants, so an operator can tune the budget to their plan.

## v3.1.3 — fix: the dashboard keeps the retry promise too, and a turn that ends on a plan is no longer an answer

- **Added: the DASHBOARD chat console now backs the retry offer the same way WhatsApp does — a failed turn is queued, re-run when a model frees, and pushed into the open conversation.** v3.1.1/v3.1.2 gave the messaging gateway a real mechanism behind *"Reply \*yes\* and I will keep trying until it is done"* (`src/learning/deferred-task.ts` + its drain). The dashboard, the surface where the user is most likely to be watching, still dead-ended: the bubble said a model problem had happened and the only way forward was to wait and re-send the message by hand. The queue is now SHARED (filed under `platform: 'dashboard'`) and the two drains are ownership-filtered — the gateway owns every other platform, the dashboard owns its own — so neither can claim the other's task, and the gateway can never try to deliver a chat session id to a messaging platform. New `src/web-dashboard/chat-retry.ts` (the `ChatRetryBroker`) is the dashboard's half: a failed turn queues the ask with the free-up ETA the report just quoted, `yes` confirms it (6h/40 attempts, versus 30m/4 unconfirmed) and `stop` cancels it, and a 15s drain re-runs due asks through the console's own `answer()` — the same engine, the same session, the same reply path as a first-time ask. Delivery is deliberately BOTH: the result is pushed over the app-wide `/api/sse` channel (the per-turn chat stream was torn down when the failing POST resolved, so that channel cannot carry it) AND written to the session history, because a quota wait routinely outlives the open tab and an answer that is only visible while someone is watching would not be the promise that was made. Two smaller defects fell out of the same work: the failure bubble is now the bubble HISTORY holds (`amendLastAssistantTurn`), so a reload no longer shows a failure with no explanation for a retry that is queued and running; and a turn the server is already retrying no longer also offers the client's manual `↻ Retry` (the new `retryQueued` field), which would have run the same ask a second time. The `yes`/`stop` matcher, the accepted/cancelled/abandoned/retrying lines and the task store are the SAME code the gateway uses, so the two surfaces cannot drift. Pinned by 10 broker tests, 4 real-HTTP end-to-end tests (queue → confirm → drain → SSE push → history), 3 component tests, and a live run against the built server: the failing turn returned `retryQueued: true`, the queue file held the dashboard-owned ask, the stored bubble matched the one the reader saw, `yes` was answered off the queue without a model turn, and the drain re-ran the ask and logged `dashboard: retrying failed turn (attempt 1)`.
- **Fixed: a turn that produced NO ANSWER was reported as a SUCCESS whenever a tool had run — the honest failure line was delivered as the turn's answer.** Found while verifying the dashboard end-to-end on a machine with no usable cloud keys: the bubble read *"The model wrote its own working notes instead of an answer, so there was nothing fit to send…"* while `generationFailed` was **false**. The tool loop decided that flag with `!madeProgress`, and "made progress" (a tool ran, or a previous step emitted content) is not "an answer was delivered": every consumer therefore treated a bare failure line as the finished work — the dashboard offered no retry and queued nothing, the gateway would have reported the turn as fine, and the line was eligible for the answer cache. The flag now answers the ONE question its name asks (`no answer delivered → failure`), while `madeProgress` keeps its own meaning where it belongs (deciding whether a no-model turn may be re-run through the rules' pipeline fallback). Two adjacent defects on the same path were fixed with it: `ChatCommand`'s tool-loop catch returned the sanitized failure line with no failure flag at all (so a hard failure looked like an answer on every surface), and the no-model pipeline fallback keyed off `error` instead of `success` — a pipeline that RAN and failed reports its outcome in `summary` and only sometimes sets `error`, so a failed run's summary came back as a successful turn. Pinned by a tool-loop test that runs a real tool, fails every candidate, and asserts the turn is a FAILURE with the honest line and no raw provider text (verified to fail against the previous code), plus the chat-level test that a rejected answer is never reported as a successful turn.
- **Fixed: a deferred retry abandoned mid-attempt was STRANDED FOREVER.** A retry is claimed by setting `status: 'running'` before the turn; if the process dies mid-attempt — a restart, a reboot, a crash, all normal during a quota wait — nothing ever reset it, and a `running` task is invisible to BOTH `dueTasks` and `expiredTasks`. The queued ask, and the promise attached to it, disappeared without a word. The store now self-heals on READ: a task left `running` for more than 15 minutes (well past the 5-minute ceiling on a turn) is returned to `pending`, due immediately, and the repair is persisted so the next reader sees it too — while a live attempt is never stolen. Pinned by 2 tests (a dead attempt is recovered, a live one is left alone).
- **Fixed: a turn that ENDED on a plan to go looking was delivered as the answer — captured live on the dashboard chat surface.** The failing reply was, verbatim: *"We need to find router selection logic. Let's search for \"router\" and \"model\"."* — the reader's answer was the model telling itself what it was about to do, and the turn was reported as a SUCCESS (three more variants of the same shape were caught on the subsequent runs: *"We will search."*, *"We need to read the router-bandit file."*, *"We need to search code for router logic."*). The reasoning detector missed it because its openers key on first-person SINGULAR deliberation (`Let me think …`, `My plan:`) or on narrating the CONVERSATION (`The user is asking …`); this shape is a plural/imperative intent to ACT. It is now a signal, and — because a wrong verdict burns a good answer — a deliberately narrow one: it applies only to the step that IS the answer (never to a tool-carrying step, which may legitimately narrate before acting), and only when the reply is short, unstructured, non-interrogative, carries no completion claim, and states a concrete intention to touch the codebase or system. A reply with a fenced block, a list, a heading, a quote, a URL-shaped deliverable, a question back to the reader, a claim of work done, or simply a real length is left untouched, so *"I need to find you a good restaurant near the office"* and *"We need to find the routing entry point.\n\n- `auto-router.ts` …"* are both still answers. Pinned by 5 tests including the live string, the four guards, and the tool-carrying-step exemption.
## v3.1.2 — fix: the agent keeps the promises it makes — it retries the task, audits its own reading of it, and stops offering pairs that cannot work

- **Fixed: the retry offer was a PROMISE WITH NOTHING BEHIND IT — "Reply *yes* and I will keep trying" went out to a WhatsApp sender and a yes was answered with silence.** `renderModelBreadthReport` has ended every failed turn with that offer since v3.1.1, and it was observed live (*"A model frees up in about 44s … Reply *yes* and I will keep trying until it is done"*). Nothing parsed the yes, stored the task, or re-ran it: the only reply matching on the inbound path was `matchAskUserChoice` for an `ask_user` question, and no queue existed anywhere (`src/nlu` had no learning store, `~/.nuvira` had none either). A failure the sender cannot act on is bad; telling them how to act on it and then ignoring them is worse. There is now a PERSISTED retry queue (`src/learning/deferred-task.ts`) plus the machinery that acts on it: the moment a failure report is composed in `handleInbound` (both the chat turn and the pipeline run), the ask is queued with the free-up ETA the report just quoted, and a periodic drain replays it through the **ordinary inbound path** when that wait elapses — a retry therefore gets the same authorization, the same routing verdict, the same pipeline serialization and the same reply path as a first-time ask, instead of a private second implementation that could drift from it. `yes` CONFIRMS the entry (and buys the long horizon: 6h / 40 attempts, versus 30m / 4 while unconfirmed, so nobody is enrolled in a six-hour loop they never agreed to), `stop` cancels it, the queue is bounded and pruned, and a retry that fails again re-queues ITSELF rather than being dropped. Two details that decide whether this works at all: the replay uses a FRESH transport id (the dedup ledger consumed the original, so reusing it would classify the retry as a duplicate and silently drop it — the exact "nothing happened" failure this fixes), and it does NOT re-record the ask in the conversation history (the original arrival already wrote that user turn). The sender is told before each attempt ("🔁 Trying again now (attempt 2 of at most 6) — you asked for …") because the original ask may be hours old, and an entry that runs out of road is reported rather than ghosted. The reply matcher is deliberately strict in both directions: an acceptance may only be an exact phrase or a ≤6-word message whose every other word is filler, and a decline must be ≤2 words — measured against the real risk that a loose matcher SWALLOWS a user's request ("yes I also want a website for the shop" and "no, don't send it to her — send it to my brother instead" are requests, not answers, and fall through to normal handling untouched). Verified by 13 store/matcher tests plus 9 gateway tests driving the real `handleInbound` and the real drain: the offer queues, `yes` confirms and extends, `stop` cancels, a new request is never read as the answer, the drain delivers the answer and settles the task, a retry that fails again keeps it with its attempts counted, and a task whose wait has not elapsed is left alone.
- **Added: an intent audit for a REPEATEDLY failing ask — the agent now asks the model what the request actually needed, corrects its own routing when it was wrong, and remembers the correction.** When a turn keeps failing, only one question distinguishes the world's fault (no model, no quota) from its own (it read the request wrong and worked on the wrong thing): what IS this request? Without it, a misreading is permanent — the same ask runs down the same wrong path on every future message, burning a pipeline run each time, and the user's only recourse is to rephrase. `src/nlu/intent-confirm.ts` puts that question to the model as a strict JSON contract (with the decision space spelled out and the instruction never to answer the request, so the audit cannot leak a second, contradictory answer into the conversation) and the reply is parsed defensively — an unreadable answer is NO verdict, never a guess. When it confirms the reading, the sender is told ("🧭 I double-checked what you asked for: building this is the right read, so the only problem is model availability") because "it failed" and "it failed and I checked that I understood you" are different promises; when it disagrees, the corrected route is RUN through the same `handleInbound` entry point (via a `forceKind` re-entry) so "Develop the calculator" is answered in chat and a misrouted coding ask finally gets built — the failure report is deliberately not sent in that path, because one accurate reply beats a failure notice followed by a correction. The audit runs at most ONCE per inbound message (so a misreading cannot ping-pong between the two routes), only on a REPEATED failure (one failure mostly describes the world — the test asserts a first failure never spends a model call on an audit), and only when a model is configured. Corrections are persisted as NLU LEARNINGS (`src/nlu/learnings.ts`, `~/.nuvira/nlu-learnings.json`) and applied by `resolveAskKind` — the ONE shared chat-vs-pipeline decision every surface uses — so the next identical ask routes right the first time. Matching is deliberately narrow (exact token-set, or the learned ask fully CONTAINED in the new one) because a wrong correction silently misroutes: the live object-blindness pair ("create a *project plan* to develop X" vs "create a *plan* for my kid") and a one-word SUBSTITUTION ("the *data* pipeline" vs "the *build* pipeline") both fail to match, while adding a word ("…to speak english" → "…to speak english fluently") still does. The whole loop is inspectable and reversible — `nuvira nlu learnings` lists each correction with its verbatim ask, reason, hit count and age, `--forget <id>` returns that ask to the deterministic rules, and `nuvira nlu debug` now prints the shared route plus whether a LEARNED override produced it (`Route: pipeline (LEARNED override — chat → pipeline)`) — because an override nobody can see is its own bug. A failed probe writes nothing (a `recordCall`-style outage must never become a rule), pinned by 13 tests plus 1 more gateway test proving the re-route actually runs the other engine.
- **Fixed: the failover pool offered `local/gemini-3.1-flash-lite` — a pair that cannot exist — on every walk.** Found in the live end-to-end run: the registry had already learned "model not found" for that pair (the `local` provider is an Ollama runner; a Google model id is not servable by it), and `buildModelCandidates` handed it back as a candidate anyway, so each walk spent a fallback slot and a 404 round trip that a servable sibling should have had. A model-not-found is definitive for `provider × model` — the provider itself said it does not exist — so the registry now records it as a DEAD PAIR (`ModelRegistryEntry.deadPair`), the candidate builder never offers one, and the state is self-healing in both directions: a real success clears it, and so does the provider's own model LIST (which is authoritative about what it serves — a re-listed model was not dead after all, and a bogus list just re-earns the flag on the next call). Entries written before the flag existed are honoured too, so the live bad pair is retired without waiting to fail once more. Repairable failures are explicitly NOT retired (a 403, a dead key or a quota park can all be fixed, and the walk reaches parked models on purpose), and the decision is now VISIBLE rather than silent: a dead pair is reported under "Ruled out (this model does not exist on that provider)" with no "free in ~" promise, and `nuvira models excluded` prints `🚫 … does not exist on that provider`. Verified live against the real registry: `getDeadPairs()` returns the pair, `buildModelCandidates` returns the provider's four servable models without it, and the rendered report lists it as ruled out. Pinned by 9 tests.

## v3.1.1 — fix: genuine development asks route correctly, and no surface ships the model's own reasoning

- **Added: the ORCHESTRATOR's agents get the same answer-quality treatment — one corrective retry, then the report's salvage/suppress.** The loop engine now rejects a traced reply at generation time, but the pipeline's agents do not run through the loop: each is handed its own `LLMCallFn` and calls the provider directly, so nothing on that path ever asked "is this addressed to the reader, or is this thinking?". Observed live (2026-09-21) as an agent summary that was literally *"The user wants a project plan for a … I should use the `plan_todo` tool to create a structured plan."*, threaded through the report and rendered by the gateway as `• ✅ Reasoner: The user wants …`. New `withAgentAnswerQualityGate` wraps the agent's LLM function — the ONE boundary that is reached by every agent type (planner, reasoner, writer, tester, debugger, and any strategy-selected substitute) AND narrow enough that a retry cannot mis-fire on the orchestrator's housekeeping calls (file finding, memory summarisation, JSON extraction build their own prompts and are deliberately left alone). Strictly ADDITIVE: a normal reply costs exactly one underlying call and is returned untouched; only a detected trace pays for a single retry carrying a corrective instruction that names the real failure (the reply addressed the wrong reader) rather than restating an output format. If the retry narrates again, the salvageable part behind the trace is delivered when there is one and the ORIGINAL text otherwise — never an invented placeholder, so a downstream parser sees exactly what it would have seen before. A failed retry cannot turn the task into an exception the agent never sees. Wired at both orchestrator entry points (the per-task agent function, which also covers the repair engine and the reviewer-fix strategy, and `runAgent`, which owns the reasoner/planner LLM), pinned by 8 unit tests plus a wiring contract that fails if either site loses the gate.
- **Fixed: the LOOP ENGINE shipped the model's own reasoning as the answer — `nuvira execute` and every pipeline run had no answer-quality check at all.** Captured live on 2026-09-21, in a run whose tool calls SUCCEEDED (`plan_todo` and `suggest_followups` both fired), the printed answer to *"Create a project plan to develop a multiple screen calculator and unit converter…"* was:

  ```
  The user wants a project plan for a "multiple screen calculator and unit converter" with a GUI and cross-platform support.

  I should use the `plan_todo` tool to create a structured plan.
  The plan should include: 1. Requirements Analysis & Design …
  ```

  The chat engine has refused this class since `confuseCheck` was added, but the rejection lived ONLY there, and a quality failure never throws on its own — so the loop engine's failover walk (which only reacts to provider errors) accepted the narration as the turn's answer AND reported the turn as a SUCCESS, which cached the thinking for an hour. There is now ONE shared detector (`detectAnswerQualityFailure`) and ONE error contract (`answerQualityError`) consumed by both engines: the loop executor applies it in `callModel` right after the model answers and BEFORE the success attribution, so a rejected reply never marks the model verified, and the throw lands in the existing walk — which now treats a quality failure as a CANDIDATE-level miss, not a provider outage: no ledger park, no health decay, no bandit penalty for a prompt the model answered in the wrong voice, and the pinned-provider gate is skipped so a genuine development ask reaches the next candidate instead of dying on step 1. The signal is **two-tier**: a step that carries TOOL CALLS is judged on the high-precision signs only (narrating the conversation, reciting the prompt's format rules) because an acting step may legitimately open with an action narration — measured while wiring this: the JSON-fallback transport's real lead-in `I will check.` tripped the deliberation opener, the step was rejected and its `list_dir` call was thrown away. The first-person deliberation openers were narrowed to genuine deliberation verbs (`think/plan/analyse/consider/reason`) for the same reason, and that narrowing also removes a latent false positive from the chat path. `toUserFacingGenerationError` now names this cause (`The model wrote its own working notes instead of an answer`, with the `nuvira models` pointer) instead of falling through to "the language model was unavailable" — the same misdiagnosis the tool-contract-confusion branch was added to fix. Render sites get the last line of defence: `nuvira execute` (the human print AND the `--json-events` payload, including every agent line and the pipeline summary) and the gateway's `composePipelineReply` now salvage a deliverable sitting behind a trace and otherwise say plainly that nothing usable was produced. Verified: 6 loop-level tests (a DEV ask answered with the live reasoning text is a FAILURE with the honest line, the walk logs why it moved on, contract meta-talk is treated identically, the JSON-fallback transport is gated too, an action narration keeps its tool call, and a real plan is delivered untouched), plus render-site and unit coverage.
- **Fixed: a genuine DEVELOPMENT follow-up after a plan was answered in CHAT — "Develop the calculator as per the plan created by agent-nuvira".** The immediate sequel to the `project plan` fix (`project` is a MODIFIER of `plan`), and the same object-blindness in the opposite direction: the content-artifact guard matched the word `plan` even though it names an artifact from an EARLIER turn, so the one thing the user actually asked for — the calculator — never reached the pipeline. A backward-reference clause (`as per`, `per`, `according to`, `based on`, `following`, `as described in`, …) followed by a short noun phrase whose head is a KNOWN plan/document/spec noun is now removed before the artifact test (`stripArtifactReferences`), which keeps it precise: the marker alone would eat whole sentences ("generate a report from the data" is untouched, and "Following the plan, create a worksheet" still reads as a content ask because the words after the reference are the request). The coding-object veto deliberately still reads the FULL text, so "create a plan based on the API spec" stays a dev plan. The conversation gate judges command position the same way ("Following the plan, develop the calculator" is still a coding action), and now tolerates a leading discourse marker ("Now implement the calculator", "Then fix the login bug") — both lists still require a STRONG_TASK_VERB immediately after, so a question never becomes a task. Two more findings from the same audit: the fix rule's QUESTION guard ran AFTER its verb test, so *"so, what is the fix for this error?"* classified as a fix TASK and ran the developer pipeline (the verb was used as a noun, and the guard only looked at character 0) — the guard now runs first and tolerates a discourse-marker prefix; and the bare `check`/`draft`/`compose`/`figure` deliberation openers were dropped from the reasoning detector (see above). Pinned by a new routing suite covering both halves of the plan→build sequence plus the genuine development asks (`build an api`, `write a test`, `create a test for the login function`, `create a course website`, `create a booking management API`) and the content asks (`diet plan`, `class-4 book`, `essay`, `table of contents`) that must never be starved of a direct answer.
- **Fixed: the gateway's pipeline reply double-printed the verdict and could relay a traced agent summary.** Two defects on the path taken when the pipeline throws before returning a structured result: the orchestrator's summary already starts with its own verdict, and the composer prefixed a second one — the same double-verdict defect fixed for the structured path, which survived on the catch path ("❌ Failed — Failed — …"). The verdict is now removed BEFORE sanitizing, which also makes a leak visible to the detector (whose opener check reads the FIRST line, and "Failed — The user wants …" hid it): such a summary is replaced by "the model returned its own working notes instead of a result" rather than forwarded. The structured path's per-agent lines are sanitized too — the ORCHESTRATOR's agents run their own model calls, so unlike the loop engine they are not covered by the generation-time gate, and an agent summary that was literally the model's planning prose was previously rendered as "• ✅ Reasoner: The user wants a project plan … I should use the `plan_todo` tool…". A raw `suggest_followups` payload in an agent summary is stripped there as well.
- **Fixed: `nuvira execute` printed the model's tool-call ARGUMENTS as the answer — the one surface that never stripped them.** Captured live on 2026-09-21, `nuvira execute "Create a project plan to develop a multiple screen calculator…"` delivered a complete, good plan that ended with:

  ```
  ---

  **suggest_followups**
  [
    { "prompt": "What features should the calculator include?" },
    { "prompt": "Which unit categories do you want in the converter?" }
  ]
  ```

  The gateway and the dashboard console had always applied a strip; the execute CLI wrote the loop engine's `content` verbatim, and even the shared helper could not have saved it — **it had only ever seen three artifact shapes**, and this is a fourth: the model wrote the tool's *arguments* (not a call) as a **bare JSON ARRAY** under a bold caption, while a previous run wrote the same thing as a fenced `{"followups":[…]}`, which also slipped through (no `"tool"` key). All four shapes are now handled by ONE structural pass inside `stripToolCallArtifacts`: the trailing value is **parsed**, and removed only when it really is the followups contract (an object with a `followups` list, a `tool: "suggest_followups"` call, or a non-empty array of prompts / `{prompt,label?}` entries) — so a user-requested code block that merely contains a `followups` field is untouched, as is a legitimate trailing JSON array like `[2, 3, 5, 7]`. The pass also drops the caption and the `---` the model puts in front of it, and the gateway and dashboard console now share this helper instead of each carrying a stale two-regex copy. Applied on every remaining CLI render path too (`execute` loop engine, the direct-answer path, and `printOrchestrationResult`). Verified end-to-end: the exact command that leaked now emits **zero** `followups` occurrences and closes on a real "Next Steps" list.
- **Fixed: skill evidence words were counted, not distinguished — ONE repeated word could inject an unrelated methodology.** The activation gate requires two domain words before a skill's methodology is injected into a turn, and the evidence text is `goalPattern + description`, so a word a skill repeats in BOTH fields counted twice and cleared the bar alone. Measured live 2026-09-21: *"Create a book which teaches math's devision for class 4 student"* activated `game-development`, whose only overlap with the goal is the word `create` — present in its goalPattern (`game create build …`) and again in its description ("Use when the goal asks to create, build, or develop a game"). The words are now collected into a **set**, so two DISTINCT words are required; the same goal now matches nothing, while real game intent still matches via the skill's name or genuine domain words. (This is the same class as the platform-name fix — a target platform and a repeated generic verb are both non-evidence.)
- **Changed: `ask_user` with no interactive user now DISCLOSES the question and the assumption instead of deciding silently.** A piped/headless run picked choice 1, told the MODEL to move on, and the question never reached the human — so a one-shot `nuvira execute` presented a decision the user never made ("I have selected Python/Qt") and, because the internal note read like an instruction, the model sometimes echoed it back as the answer ("no interactive user attached — defaulting to Beginner"). That is the opposite of the gateway's rule, which REPLIES with the question and states the option it is going with ("Going with 1. X — reply to change it after this turn"). The CLI now shows the question and every numbered choice on the visible output, and the result handed to the model asks it to tell the user the question it would have asked and the assumption it made — never to mention the internal note. (The interactive TTY path is unchanged: inquirer still prompts and the answer is used.)
- **Fixed: the model's own REASONING was delivered to the user as the answer — nothing in the pipeline ever asked "is this addressed to the reader, or is this thinking?"** Replaying every reply in the live inbox ledger (`~/.nuvira/gateway/inbox.json`) through today's guards shows **3 of the 4 reasoning leaks still reach the sender verbatim**: `The user said "Hi" via WhatsApp. / According to the instructions: / - Deliver answer DIRECTLY. / - No preamble. / - No meta-commentary.` (live 2026-09-15), and two travel answers that open `The user is asking for travel advice … / Options: Vietnam or Philippines. / I need to compare …` (live 2026-09-15 and 2026-09-16). The `suggest_followups` meta-talk family WAS already fixed (`looksLikeConfusedScaffoldingReply` catches all 5 of those), but reasoning narration slipped past everything, and the reason is precise: **`stripGatewayReasoning` is FORMAT-dependent** — it removes `<think>`-tagged blocks and lines carrying a known planning label behind a `*`/`1.` marker, and these traces are flat prose with neither, so a blocklist of labels cannot be completed against a model's unbounded phrasing. New `looksLikeReasoningLeakReply` keys off **structure** instead: a reasoning OPENER in the first line (`The user is/said/asked …`, `According to the instructions`, `Let me think/plan …`, `Wait, …`, `My plan:`, `Response:`) or a **recited prompt checklist** anywhere (`- No preamble.`, `- End with suggest_followups` — a deliverable never states the instruction it is following). It is wired into the tool loop's `confuseCheck`, so such a reply now **throws and drives the existing failover walk** to try the next candidate — and because it never threw before, the turn used to be a *success*, which cached the thinking for an hour. At the send site (every candidate narrated) the gateway and the dashboard console **salvage** the deliverable that sat behind the trace via `stripLeadingReasoningTrace` and suppress only when nothing deliverable survived: the two travel leaked answers are recovered in full (4804 and 4634 chars of real content), while the `Hi` trace becomes a helpful retry line. Deliberately conservative, because a wrong verdict burns a good answer: the opener must be the FIRST line (a quoted or mid-text mention is untouched), it requires an input verb (`The user table now has an index` is ordinary prose in a codebase, `The user can log in` is a deliverable), and the salvage refuses any remainder that does not OPEN on Markdown structure with a non-reasoning first line — which is also why a real answer's own conclusion (`If the user wants high-end casinos, the Philippines wins`) survives in the tail. Verified against the ledger: 3/3 real leaks caught, 12/12 legitimate answers untouched, and 2 loop-level regressions prove the turn is marked `generationFailed` (never cached, never written to history) rather than delivering the thinking.
- **Added: a failed turn now reports WHICH models were tried and why the others were parked — as an event log, not a record snapshot.** `describeRoutingExclusions` could answer *"why is this provider being skipped?"* but not *"what did you actually call?"*, because an attempt is an event rather than a record. So the only honest-sounding line available was "the language model was unavailable" — which names no cause, and cannot distinguish a genuinely empty pool from one provider that rate-limited while three others sat parked on quota. The failover walk now records every decision (called + failed with its classified kind; skipped because it was ruled out, had no credential, or reported itself unavailable) into a bounded ring buffer that a caller marks and reads back. `renderModelBreadthReport` renders both halves — each tried model with a reason (`rate limited (quota)`, `the prompt was too large for its window`, `timed out`…), each parked model with its reason AND when it frees (`— free in ~55m`) — and ends with the retry offer. The gateway prepends it to a failed chat turn and appends it to a failed pipeline run, so the sender learns WHY instead of just that it failed. Recording is telemetry only: it cannot change a routing decision, is bounded, and never throws into the routing path. Reuses `describeRoutingExclusions` — the same evaluation enforcement uses — so the report can never disagree with what routing actually did.
- **Fixed: a target platform was not the only modifier mistaken for a deliverable — "create a PROJECT PLAN to develop X" ran the coding pipeline.** The content-artifact guard vetoes on any software noun, and `projects?` is on that list, so the word "project" — a MODIFIER of the requested artifact, not the artifact — vetoed the guard and sent the ask to the multi-agent pipeline. Observed live 2026-09-21: *"Create a project plan to develop a multiple screen calculator and unit converter, it should be GUI and cross platform for Windows and Linux"* ran the developer pipeline (planner: `python+flet`) and failed **0/7 tasks**, when the sender was asking for a plan. The rule is now the artifact phrase's HEAD noun: a coding noun that only modifies a plan/document noun no longer vetoes it, so all three of this session's ambiguous asks answer in chat. A software noun in a PURPOSE clause is still a coding object — "create a plan **for** the ecommerce app", "create a test plan for the new module" and "create a **course website**" (head noun: `website`) all stay on the pipeline, so a real dev request cannot be starved by being phrased as a plan.
- **Fixed: a pipeline result reached a chat surface as the raw CLI TEXT REPORT — it contradicted itself.** Driven live through the real gateway path (*“Create a project plan to develop a multiple screen calculator and unit converter, it should be GUI and cross platform for Windows and Linux”*), the WhatsApp reply was:

  ```
  ❌ Failed — ❌ Completed 2/3 tasks with some failures in 9.6s

  Goal: Create a project plan to develop a multiple screen calculator … cross platform fo
     ... (truncated)
  Tasks: 2/3 completed

  Agent Results:
    ✅ Reasoner: Technical decisions made: python+flet on cross-platform
    ✅ Planner: Created 5 task steps
    ❌ writer: Repair budget exhausted (1 attempts)
  • Tasks: 0/5 completed
  • ✅ Reasoner: Technical decisions made: python+flet on cross-platform
  • ✅ Planner: Created 5 task steps
  • ❌ writer: Repair budget exhausted (1 attempts)
  ```

  Four defects in one message: **two** verdicts (the composer prefixed `❌ Failed — ` onto a summary that already began with its own `❌`); **two contradicting counts** (the orchestrator's `2/3` counts AGENT results while `Tasks: 0/5` counts pipeline STEPS — both labelled “Tasks”, so “Completed 2/3 tasks” and “Tasks: 0/5 completed” read as a contradiction); the **same agent list twice**; and a **machine artifact mid-sentence** (`Goal: … cross platform fo` + `... (truncated)`) where a sentence should be. The cause is that `runPipelineTool` returns the orchestrator report *formatted for the CLI* (`TextFormatter`: multi-line, goal/duration/agent breakdown), and the gateway concatenated it after a second headline. The gateway now composes its own chat-shaped reply from the **structured** result — ONE verdict from `success`, ONE labelled count pair (`0/7 steps completed · 2/3 agents ok`), agent lines taken from `agentResults` (so no duplication), and the truncation sentinel stripped — while the rich report still goes to the audit log, the board and the CLI unchanged. The catch path (the pipeline threw before returning a result) keeps the orchestrator's own sentence, minus its leading verdict and the sentinel. The same message now reads `❌ Failed — 0/7 steps completed · 2/3 agents ok` followed by the three agent lines.
- **Fixed: `ask_user` with plain-STRING choices asked the contact to pick from “1. undefined / 2. undefined”, and their reply then CRASHED the inbound path.** `ChatEngine` types the choices as `unknown[]` and both shapes are emitted in the wild — `['Book', 'PDF']` and `[{ label: 'Book' }]` — but the gateway's renderer cast the array to `{ label }[]` and read `.label` unconditionally. So a string array produced a numbered list of `undefined`, and because those same `undefined` labels were stored as the pending question's choices, the contact's reply threw `Cannot read properties of undefined (reading 'toLowerCase')` inside `matchAskUserChoice` — breaking the very turn the reply was supposed to resume, in the inbound path, on the feature built to stop the agent guessing. New `normalizeAskUserChoices` accepts strings, numbers, `{label}` / `{title}` / `{value}` and drops what cannot be rendered (rather than inventing a placeholder, so numbering still refers to real labels); a question whose choices are all unrenderable is asked with no numbered list and no instruction to pick a number it does not have; and `matchAskUserChoice` coerces defensively so it can **never** throw on a malformed question. Found by driving the real gateway with an injected engine that asks — none of the three live asks ever triggered `ask_user`, so this path had never been executed end-to-end.
- **Fixed: the ask-and-wait window lapsed SILENTLY.** The question promises “Reply with the number … — I will wait”, so applying the default after `askUserTimeoutMs` left the contact reading an answer to a question they never answered, and their later reply looked as though it had been ignored. The timeout (only a server-side `logger.warn` before) now tells the contact first — `⏳ No reply yet — going ahead with 1. <choice>.` — best-effort, so a failed send can never stop the held turn resolving.
- **Added: `gateway.askUserWait` — ask a question on a messaging channel and actually WAIT for the answer (opt-in, OFF by default).** Observed live 2026-09-21: asked *"How would you like the division book delivered?"* the gateway sent the question and immediately returned `choices[0]`, so the agent built an **Interactive game** and wrote an HTML file — the option the engine picked for the user. Their real reply arrived afterwards as an unrelated new message, with no memory that a question had been asked: the sender was asked something that could not affect the run. With `askUserWait` ON, the turn HOLDS for that contact's next message, matched by `matchAskUserChoice` (a 1-based number, `option 2`, `#2`, the label case/punctuation-insensitively, or a prefix of exactly ONE choice — prose, an out-of-range number or an ambiguous prefix is never guessed at), and the answer STEERS the model. Four safety properties, all tested: the promise always settles (a silent contact costs one bounded window — `askUserTimeoutMs`, default 2 min, clamped to 5s–10min — then the default applies and the timeout is logged); a reply that matches no choice releases the waiter with the default AND is handled as a normal message, so it is **never swallowed**; `stop()` releases every held question so a turn cannot outlive the gateway; and at most ONE waiter exists per contact (a second question releases the first with its default). Recorded in the ledger as the new `clarified` disposition. Flip it with `nuvira config gateway ask-user-wait on|off|timeout 90s|status`, or the **Contacts → Send authority** panel (`🧠 Clarifying questions`) — same surface as send authority, applied immediately (config is re-read per turn).
- **Fixed: `ConfigManager.save()` and `loadConfig()` silently DROPPED gateway settings that were not `policies`/`statusRecipients`.** Both rebuilt `config.gateway` from those two keys alone, so writing `gateway.askUserWait` printed a success line while the config file never received it — and even when present in the file it read back as absent. Every other gateway key now rides through, so adding a gateway setting no longer requires touching the merge in two places to have it work at all.
- **Repo hygiene: `dist/` is no longer committed — it was a STALE build that silently shipped old code.** `dist/` was tracked (1609 files: 456 `.js`, 382 `.d.ts`, 764 `.map`, 6 `.DS_Store`) even though `.gitignore` has listed `dist/` since line 2 (which never applies to already-tracked files). It was not the current build: `dist/tools/loop-project-context.js` still contained strings removed from `src/` long ago, and `unfulfilledPromise` / `governanceVerdict` appeared **zero** times in it — so `node dist/index.js` from a clone ran **old code**. A fresh build produces **394** modules where the committed tree held **470**: **77 modules no current build emits**. Twelve of those are true ORPHANS — `app`, `server`, `passport`, `auth-api`, `auth.test`, `file`, `routes/auth`, `routes/user`, `middleware/auth`, `config/jwt`, `config/keys`, `config/auth`, a ~250-line Express + JWT + Passport demo — whose sources exist NOWHERE: their sourcemaps record `src/routes/auth.ts` / `src/auth.test.ts`, yet `git log --diff-filter=D` is empty for those paths, so the sources were never committed (the repo's own `.gitignore` had already been listing `src/file.ts`, `src/example.ts`, `src/fresh.ts`, `src/forwarded.ts` — the stray demo sources — rather than deleting them). The cause is that **`tsc` never prunes stale output**: `dist/app.js` (Sep 10) sat beside `dist/index.js` (Sep 20) in the same commit. The other 65 are obsolete compiled dashboard modules (`src/web-dashboard` is excluded from the root tsconfig). Nothing in `src/`, `scripts/` or `tests/` reads `dist/`, and every workflow plus `prepack`/`prepublishOnly` builds it, so untracking changes nothing about the product. The 24 orphan artifacts are **preserved** in `archive/legacy-jwt-demo/` (with a README recording the provenance and confirming no live credential — the only secret-shaped strings are test fixtures and the demo's `'dev-secret-key'` placeholder) rather than discarded. New `scripts/prepare-install.mjs` back the `prepare` script so `npm install <git-url>` still builds — while **deliberately skipping** CI (every workflow builds explicitly), the `pack`/`publish` lifecycle (prepack already builds) and `NUVIRA_SKIP_PREPARE=1`, so install-time behaviour is byte-identical to before.
- **Fixed: a DANGLING PROMISE passed the honesty guard — the answer announced an action ("I will begin by scaffolding the project…", "Let me now create the files") and the turn ended having done NOTHING.** The delivery-claim detector deliberately ignores future tense (a truthful answer may say "I will send it once you confirm"), so a dropped intent was reported as nothing at all and read to the user as work in progress. The loop now spends ONE bounded extra step asking the model to carry the announced action out (`🔁 Answer announced an action but performed none`), and a residual promise is reported through a new `unfulfilledPromise` flag on every surface: the gateway and the dashboard chat console append a truthful correction, and the Trace tab shows `⚠️ unfulfilled promise — announced an action it never performed` instead of a plain 💬 answered. The detector is deliberately narrow, because crying wolf is worse than staying silent: it requires an IMMINENT first-person promise (`let me`, "I will **now** …", "I'll **start by** …") of a tool-shaped verb, excludes conditional/interrogative promises ("once you confirm", "shall I?"), ignores an answer containing a list (a plan enumerates — that is a deliverable, not a dropped intent), and only fires when NOTHING succeeded this turn, so a partially-completed turn that narrates remaining work is never misreported.
- **Docs correction: `resolvePipelineDispatch` claimed a prompt hint that does not exist.** Its docstring said the rule assessment was "the rule hint injected into the model's context (`buildToolSystemPrompt`)" — commit `4d30b7e` removed prompt-level intent steering on purpose ("give the LLM tools and let it decide") and a test guards its return. The comment was simply left stale, and a stale comment is how a routing TABLE (`resolveAskKind`) gets misread as the chat surface's actual behaviour: on `nuvira chat`, the dashboard console and the gateway chat engine the MODEL decides, and the rules act ONLY as the generation-failed fallback — it is the GATEWAY's pre-model dispatch that routes on `resolveAskKind`. Both facts are now stated in the code (and pinned by a test) instead of contradicted by it. `nuvira models excluded` also states plainly which filters are SELECTION-only (the admin max-cost cap, `minSpeed`/`minReasoning`) and therefore never appear as exclusions on a pin.
- **Fixed: a TARGET PLATFORM was treated as goal evidence, injecting irrelevant methodology.** Live 2026-09-21: *“Create a project plan to develop a multiple screen calculator and unit converter, it should be GUI and cross platform for **Windows and Linux**”* activated `wsl-setup` (tags `wsl, windows, linux, development, gpu`) and pushed WSL distribution/filesystem/GPU-passthrough methodology into a Flutter app plan. Both tag hits and both pattern hits came from the platform names alone. Host/OS names (`windows`, `linux`, `macos`, `ubuntu`, `wsl`, `android`, `ios`, `x64`, …) now contribute NO evidence on any path — “cross platform for Windows” is a constraint on the work, not a request for WSL setup — while tooling/cloud domains (`docker`, `kubernetes`, `aws`, `postgres`) stay evidence, because “deploy to AWS” genuinely IS a deployment request. There is also now ONE activation gate (`isSkillActivated`) instead of three implementations of different strength: the chat/execute loop filtered COMPILED matches but trusted hub matches raw, and the **orchestrator applied no evidence filter at all** (only the website-deploy rule) — so the pipeline was the most exposed surface. All three consume the same predicate.
- **Fixed: skill evidence matched SUBSTRINGS, not words.** `q.includes(word)` matched a skill's `kill` inside “no s**kill** covers alpaca husbandry whatsoever” — measured: `feature-flags` ranked top for that goal — and the same bug makes `mac` match “machine” and `arch` match “search”. Both the evidence gate and the hub catalog's scorer now tokenize the goal and match WHOLE WORDS, which also keeps ranking and gating consistent (`findHubSkillMatch` can no longer nominate a skill the gate then rejects). A description's prose is admissible evidence again now that it is matched by word — the earlier attempt to score prose by substring was what made matching *wider*.
- **Repo hygiene: `.freebuff/` (another product's desktop-app state) is no longer committed.** It held a SQLite DB plus `-wal`/`-shm` sidecars and a `project-id`, and had been committed twice (`v1.51.0`, `v3.0.0`). Root cause: `.gitignore` carried `*.db`, but SQLite's `-wal`/`-shm`/`-journal` sidecars and the plain `project-id` file matched no rule. `.freebuff/` and `.codebuff/` are now ignored outright and the generic `*.db-shm` / `*.db-wal` / `*.db-journal` patterns close the underlying gap for ANY database; the three tracked paths are removed from the index (the local files are untouched). No Agent-Nuvira code or script referenced the directory — it was pure runtime detritus of the tool being run in the checkout.
- **Fixed: admin governance policy was decorative on every PINNED path — an explicit pin could serve a provider the policy rules out, and a failed pinned turn would silently fall back to one.** The allow/deny lists and the PII privacy hard-gate are enforced inside `autoRouter.resolve()`, which `--provider`/`/model` bypasses entirely — so a PII-classified task whose pinned (compliant) local provider failed would continue on a low-privacy cloud provider the privacy policy forbids. A privacy policy any pin can bypass is not a policy. There is now ONE gate (`governanceVerdict`: denyProviders → allowProviders → denyModels → allowModels → the PII privacy bar, with a reason for each) consulted by the pinned chat path (chat, dashboard console, gateway), `loop-executor`'s pinned pool, and the router's audit view. A blocked turn is refused BEFORE its first network call and reports the RULE (`toUserFacingGenerationError` classifies policy blocks by name), never "the language model was unavailable". No policy configured → every verdict is permissive, so existing setups are unchanged. The admin max-cost cap is deliberately NOT re-implemented here: it needs the router's measured-cost estimate and governs SELECTION, not a hard rule about an already-chosen provider.
- **Added: `nuvira models excluded` — WHY a provider is not being tried.** A provider could sit skipped for days with a valid key and nothing anywhere said so: the record lived in a JSON file, the decision happened inside a failover walk, and the only symptom was that routing quietly used something else (diagnosing the auth-exclusion bug took forensic work on `~/.nuvira/nuvira-routing-failures.json`). The command reports every active exclusion with its kind, scope and remaining cooldown, every RECOVERED record with the reason it no longer applies (`expired` / `legacy-expired` / `credential-changed`), registry-learned blocks, and providers eliminated by the governance policy — JSON too. It is built on `evaluateFailureRecord`, the SAME function enforcement uses, so the report can never disagree with what routing actually does.
- **Fixed: an `auth` routing failure excluded a provider FOREVER — a repaired key stayed invisible across every future process.** `nuvira-routing-failures.json` recorded auth failures with `Number.MAX_SAFE_INTEGER` as their lifetime ("the key is dead, skip it always") and the loader prunes only entries whose `expiresAt` has passed, so a single 401 — a key that was missing during setup, rotated, or a quota error misclassified as auth — skipped that provider with no way back and nothing explaining WHY. Seen on disk 2026-09-21: `deepinfra → kind: auth`, expiresAt = now + MAX_SAFE_INTEGER. Three changes: (1) the auth cooldown is now **one hour** — a genuinely dead key costs at most one wasted request per hour, and a corrected key recovers on its own; (2) every record now carries a **credential fingerprint** (a SHA-256 prefix of the provider's secret material — never the secret), and a record whose fingerprint no longer matches the credential in force is discarded the moment the key changes, cooldown or not; (3) legacy forever-records are **re-anchored** to the bounded window on load, so upgrading heals the provider instead of inheriting the permanent exclusion. Session-scoped exclusions (`failure-bookkeeping`) deliberately keep their "for the rest of this session" semantics — they die with the process, and its *account* park was already key-scoped, so key rotation heals that one by construction.
- **Fixed: the pinned-provider fallback walk handed a different provider the PRIMARY's model id.** The auto path has always passed each candidate its own model, but the non-auto (pinned) path reused `session.model`, so a pinned `gemini`/`gemini-3.1-flash-lite` turn that failed tried `groq` with `model: 'gemini-3.1-flash-lite'` → 404 "model not found". Every fallback candidate then failed for a reason unrelated to the outage and the turn ended as **"the language model was unavailable"** while healthy providers were sitting right there — the dead end only the pinned surfaces hit (the dashboard console and the gateway chat engine, both `ChatCommand.answerOnce`). The fallback provider now gets its own configured/adapter-default model, and providers the user has no credential for are skipped instead of costing a full connection timeout (~25s measured) before the next candidate is tried — the same two behaviours `loop-executor`'s pinned pool already had.
- **Fixed: the router's task profiling had the same object-blindness as the NLU.** `analyzeTaskProfile` keyed off a surface word and never asked what it was ABOUT, so a diet/exercise plan was labeled `planning` (never getting the creative quality floor a content answer needs), `fix my diet plan` was labeled `debugging`, and `design a poster for the event` was labeled `architecture` — which also granted it a verification boost and a gemini escalation it has no business getting. The ask's OBJECT is now decided first, from the same `isContentArtifactAsk` predicate the NLU routes on (a one-way edge into a leaf module — no cycle): a content artifact with nothing engineering in it is `creative` whatever verb it uses, while an engineering ask keeps its label exactly as before. `for kids/children/students/class N` no longer tips a CODING ask to creative (`build an app for students` is code, not an essay).
- **Fixed: content DOCUMENTS (book, course, guide, list, table of contents) were still sent to the coding pipeline.** The non-code-artifact guard covered life/teaching *plans*, but a bare `create` verb is blind to its object for prose deliverables too: `create a book which teaches maths division for class 4 student` classified as `create`/`dev` and ran the developer pipeline, whose planner is a “senior software architect”. A second noun list (`CONTENT_DOCUMENT_RE` — books/e-books/textbooks/workbooks, guides/manuals/handbooks/tutorials/courses, articles/essays/blog posts/newsletters/reports/summaries/cheat-sheets/flash-cards/mind-maps, presentations/slideshows/slide decks, poems/poetry/songs/lyrics/stories/fables/myths, letters/e-mails/resumes/biographies/memoirs/speeches, recipes/cookbooks/shopping+grocery lists/check-lists, outlines/road-maps, tables of contents/appendices/glossaries, posters/flyers/brochures/pamphlets/invitations/puzzles/crosswords/riddles) now feeds the same `isNonCodeArtifactAsk` guard, so all three surfaces agree. Code-shaped nouns are deliberately EXCLUDED from that list — it is consulted by the verb-agnostic guard, so `create a script to back up files` must stay a coding task — and the coding-object veto was widened (`handlers`, `controllers`, `resolvers`, `middleware`, `hooks`, `wrappers`) so a content noun plus a software deliverable (`create a book management API`, `create a course website`, `make a post endpoint handler`) still runs the pipeline. Verified live on the three ambiguous asks that open with the same verb: the diet/exercise plan and the class-4 book answer in chat; the cross-platform GUI project plan runs the pipeline. `make a table of contents` (declared “should route to CHAT” by the repo's own scenario check but routing to `create`) is fixed by the same change.
- **Added: WhatsApp sends are VERIFIED — a resolved `sendMessage` is no longer taken as proof of delivery.** The Baileys bridge assumed success the moment `sendMessage` resolved, which is only a local hand-off: a mistyped/non-WhatsApp number (and a silent transport drop) reported “✅ sent” while nothing arrived. Every send now (1) confirms the recipient is a REGISTERED WhatsApp account via `onWhatsApp` — best-effort and memoized, so groups/LIDs and a failed query never block a good send, but a definitive “no such account” fails with the number named; (2) requires WhatsApp to return a real message id and rejects a stub/undeliverable result; (3) records the `messages.update` status lifecycle, so setting `NUVIRA_WHATSAPP_ACK_WAIT_MS` upgrades the verdict to a confirmed `delivered`. The result reports HOW FAR delivery was verified (`delivered` / `accepted` / `unverified`), and the failure REASON flows through `sendDetailed` → `GatewayRegistry.lastSendError` → the delivery ledger's `lastError` → `gateway_send`'s model-facing output (“…is not a WhatsApp account — the message was NOT sent”) instead of a generic “transport unreachable”. Media sends get the same checks.
- **Added: a structured, durable gateway log (`~/.nuvira/gateway/logs.jsonl`) — `nuvira gateway logs`.** The gateway kept no record of what it did: a failed send printed one `logger.warn` line to a terminal nobody was watching, so after the fact there was nothing to explain a message that never arrived (the delivery ledger is pruned). Every `send.ok`/`send.failed` (with platform, channel, target, reason, verification level, ledger id and a capped message preview), retry dispatch, refused sender, failed chat turn and pipeline outcome is now appended as one JSON record. Secret-shaped values are scrubbed (API keys, bearer tokens, `access_token=` query params) and message bodies are truncated to a 120-char preview — the full text already lives in the delivery ledger. Bounded by a single rotation generation, best-effort (a log write can never break a send), and `NUVIRA_CONFIG_DIR`-aware.
- **Fixed: the same object-blindness in the other verb-driven intent rules (audit of `create`/`build`/`fix`/`test`).** The verb lists are blind to the verb's OBJECT, so `create a test for class 4`, `make a worksheet for grade 3`, `create a maths quiz for class 5` and `fix my diet plan` were also dispatched to the coding pipeline. A second detector (`isAcademicArtifactAsk`, gated on an education frame — `class 4`, `grade 3`, `school`, `exam`, `syllabus`, … — and the ABSENCE of a coding object) now separates schoolwork from software: `create a test for class 4` is content, `create a test for the login function` is still a dev task. Both rules are consumed through one predicate (`isContentArtifactAsk`) by the create rule, the fix/debug rule, the write rule and the conversation gate, so all four surfaces agree. Two latent regex bugs found during the audit were fixed as well (`quizzes?` never matched “quiz”; `tests?` in the coding-object list was vetoing every academic test ask).
- **Fixed: a failed send could still be reported as “message sent”.** `gateway_send` never throws — a refused or unreachable transport returns a `⚠️`/`🚫` string — but the honest-answer guard and the trace outcome both inferred a delivery from the *attempted* tool NAME (`toolCalls`). So a send that never reached the recipient still suppressed the “I could not confirm that was sent” correction and made the Traces tab read **✅ action performed — message sent**. The loop now tracks what actually SUCCEEDED (`successfulToolCalls`, plus `deliveryConfirmed` for `gateway_send`), the honesty detector is judged against that list, and the trace outcome derives `delivered` from it — so a failed delivery is ⚠️ unverified claim, and an `acted` trace means a tool really executed. (Live incident 2026-09-21: a WhatsApp “send this to +918800663237” was answered “I have sent…”, the message never arrived, and the trace claimed success.)
- **Fixed: “create a plan/routine/schedule …” ran the developer pipeline.** The conversation gate's create-family verb override (`create|build|make|…` in command position) has no notion of the verb's OBJECT, and the NLU's verb-initial create rule matched any “create …”. So a WhatsApp ask — *“Can you create plan to enable my child learn spoken English”* — was dispatched to the multi-agent pipeline, whose planner (a “senior software architect”) answered with a Python SpeechRecognition/gTTS program. A non-code artifact noun (`plan`, `routine`, `schedule`, `timetable`, `curriculum`, `syllabus`, `diet`, `workout`, `budget`, `itinerary`, …) now routes to a direct chat answer, while an ask that names a software deliverable (“create a plan for the ecommerce app”) still runs the pipeline. Applied in one place (`isNonCodeArtifactAsk`) and consumed by both the gate and the intent rules, so the CLI, dashboard and gateway agree.
- **Security: gateway sends had NO authorization — any sender who could trigger the agent could direct it to message ANYONE.** A live trace showed a WhatsApp ask ("send this poem to my brother") answered with "I have sent the poem…" and the `gateway_send` call written as text; nothing was sent and the trace still read `success: true`. Two independent gates now exist: `allowedUsers` (who may TRIGGER) and the new `outboundSenders` (who may SEND to others), enforced in `gateway_send` via `ctx.origin`. Rules mirror `allowedUsers` (list = only those; `[]` = nobody; `Allow-All`/`*` = anyone; ABSENT = inherit `allowedUsers`, so existing setups don't break). An optional `requireApprovedTarget` forces recipients to be approved contacts, and a CLI/dashboard turn (no origin) stays trusted. Manage it from **Agent Hub → Permissions → Send authority**, the **Contacts page “🔐 Send authority”** section, or `nuvira config gateway send-authority add|remove|list|reset|require-target`.
- **Fixed: traces conflated "a reply was generated" with "an action happened".** A trace's `success` only ever meant the model answered, so a hallucinated "I have sent it" looked identical to a real delivery. Traces now carry an `outcome` — 💬 answered (no tool ran) / 🔧 acted / ✅ action performed (delivered) / ⚠️ unverified claim / ❌ failed / ⏹ cancelled — surfaced as a badge in the dashboard Traces tab. A new detector flags an answer that claims a delivery no delivery tool performed, and the gateway appends a truthful correction instead of leaving a false confirmation standing. `toolCalls` / `unverifiedActionClaim` now flow through `answerOnce` so every surface can see them.
- **Fixed: Agent Hub's "pending" chip was confused with a Contact's "pending" APPROVAL status.** They share a word but mean opposite things — the Agent Hub chip is an UNSAVED local edit that silently vanishes on reload. It now reads **`· unsaved`** (with the same save-reminder tooltip), and the README documents the two meanings side by side.
- **Fixed: suggested followups disappeared when the model wrote the call as TEXT.** A model that returned a step with no native tool call whose CONTENT was the raw `{"tool":"suggest_followups",…}` block produced no menu/chips AND leaked the JSON into the answer — the JSON fallback transport parsed that shape, the native path did not. The tool loop now salvages text-embedded tool calls when the provider emitted none (so the CLI, dashboard console and gateway all recover them) and strips the block from the visible answer either way. `extractFallbackToolCalls` was hardened too: it only treats a QUOTED `{"tool":"…"` block as a call (unrelated prose is untouched), strips a truncated quoted block, and removes the empty ```fence left behind. Reproduced and verified live on the CLI: answer cleaned, `➡️ Next steps:` menu rendered, and picking a number feeds it as the next message with the continuation marker. (A pre-fix cached turn can still replay its raw JSON until the cache TTL lapses.)
- **Added: batched `read_file` (`paths[]`) — reads MANY files in one call.** One step instead of N, under a shared 120K-char budget, with per-file line counts, a continuation offset on truncation, per-entry error isolation (one bad path never discards the rest), dedup, and deterministic order. The single-file form is byte-for-byte unchanged.
- **Added: transactional multi-pair `edit_file` (`replacements[]`).** Several edits to one file in a single call, applied ALL-OR-NOTHING (a failing pair writes nothing), written ATOMICALLY (temp file + rename, mode preserved, no `.tmp` left behind), and reported with a real unified diff plus per-replacement line spans. `dry_run` previews the diff without writing (no confirmation needed). The single-pair form and its message are unchanged.
- **Added: dependency-free bounded diff engine** (`src/tools/unified-diff.ts`) — a Myers O(ND) line diff + unified-hunk formatter (bounded, never throws) used by `edit_file` results; validated by a reconstruction property test.
- **Fixed: the dashboard snapshot had no git state.** The dashboard's project context shipped a file tree + symbol map but no branch/dirty/commit info, while the CLI's ambient context had it. The bounded git digest now lives in a shared leaf module (`src/tools/git-digest.ts`) used by BOTH, so the two surfaces carry identical git state.

## v3.0.1 — fix: dashboard/gateway had no auto-routing (false "no model" errors), honest failure messages, `-t` shorthand

- **Fixed: the dashboard chat and the gateway never used auto routing — the single biggest cause of false "language model was unavailable" errors.** `ChatCommand.answerOnce` enabled auto mode only when the caller passed an EXPLICIT `'auto'`; `ChatConsole.answer` (dashboard chat) and the gateway engine call it with just a message, so `applyActiveModel({})` returned `{}` and the turn silently ran on ONE concrete provider with `auto: false`. The non-auto path only walks `fallback.providers` — which ships EMPTY — so there was no failover walk at all: a single 400/429/timeout ended the turn with the canned failure line, while the CLI answered the identical prompt because the CLI resolved auto from the same config. `answerOnce` now falls back to the configured `defaultProvider` when the caller supplies neither a provider nor a model (a concrete `defaultProvider` is a deliberate pin and keeps the old path). Verified live: the same prompt that dead-ended on `groq` (400 `context_length_exceeded` over the JSON tool transport) now routes to a ranked candidate and answers.
- **Fixed: failures were misreported as "the language model was unavailable".** That line is the LAST branch of `toUserFacingGenerationError` — reached only when the error matched no known class. Four real classes were falling through to it: context-window overflow (`context_length_exceeded`), tool-contract confusion (our own loop error), a malformed step response, and a bare abort (Node's `DOMException("This operation was aborted")` carries no keyword). Each now names its actual cause, and the two loop-owned errors are matched FIRST so a class keyword inside the wrapped model reply can never shadow them.
- **Added: root-level `-t, --task <text>`.** `-t/--task` is declared on the `plan` subcommand, so the natural `nuvira -t "<task>"` died with commander's terse `error: unknown option '-t'`. The root flag now dispatches through the real chat command (identical provider resolution, failover and followups), and unrecognized flags print the usage hint after the error instead of dead-ending.
- **Fixed: irrelevant skill methodology was injected into non-engineering turns.** `hasRealGoalEvidence` excluded meta-words from `goalPattern` matching but not from TAG matching, so `technical-roadmap` (tagged `planning`) matched a travel-itinerary prompt on that one generic tag and pushed a phased-migration methodology into the turn — irrelevant context that also grew the prompt. Generic process vocabulary is now excluded from tag hits too; domain tags and name-word hits are unaffected.
- **Fixed: CLI print parity — raw tool-call artifacts leaked into printed answers.** The one-shot and interactive print paths wrote `answer.content` verbatim while the dashboard console and the gateway applied the strip, so a trailing `{"tool":"suggest_followups",…}` blob (or the empty ```json fence the fallback transport leaves behind) was shown to the user. One shared `stripToolCallArtifacts` helper now backs every surface, and it also removes the empty fence that the E3b strip used to leave behind.
- **Test suite:** new regression suites for the answerOnce auto-parity contract (auto engaged when no provider/model is given; an explicit pick is still pinned), the four new error classes, the generic-tag evidence rule and the artifact strip. All 282 root test files and the 27-file dashboard suite pass.

## v3.0.0 — fix: loop-engine mid-turn failover, model-window budgets, router decision consistency, RPM breaker

- **Fixed: the loop engine could not fail over mid-turn.** `nuvira execute` (and any strong-model run that resolves to the v4 loop engine) picked its STARTING provider from the deep failover chain but then called that provider directly on every step — a 429 on a later step killed the whole turn, and the failure was never recorded. Observed live: gemini free tier (15 RPM) dying on step 2 and the task ending with "I hit the model provider's rate limit". `loop-executor.callModel` now walks the same deep chain (primary → model-first tiered pool → router chain incl. reserve), re-issues the generation on the next candidate, and flips the active provider/model to the one that answered. Aborts never fail over, and candidates that already failed this turn are tried last (never dropped).
- **Fixed: mid-turn loop failures were invisible to routing.** Every failure now flows through the shared `recordActionFailure` composition (session exclusion → per-model ledger park → registry write-through → quota timeline → circuit breaker) and every success through `recordRegistrySuccess`, so a 429 during an execute loop is LEARNED — the model rests and the next run routes around it instead of repeating the pick.
- **Added: RPM/TPM rapid-failure breaker.** A 429 with no reset hint used to park for 10s — shorter than the minute an RPM window needs, so a tool-heavy loop re-picked the same free provider on its next step and 429ed again. The breaker counts failures per provider inside a 60s window (session-scoped, so it never leaks across runs) and, at the third, raises the park floor to a full minute. The first blip keeps the short base park, and a provider's own reset hint still wins.
- **Improved: model-window-aware budgets (the 1M-token gap).** New `resolveThreadBudgetChars` / `resolveContextFileBudget` scale the tool-loop thread budget and the writer/edit file-context caps with the served model's REAL window, and are wired into chat, the execute loop and the orchestrator. A 1M-token model now gets a ~4M-char thread budget and a 1.5M-char file budget instead of the fixed ~50K-token thread / 16K-char keyhole. Strictly additive: an unknown window resolves to the existing defaults, and the resolver can only RAISE a budget — a small-window model is never shrunk or over-sent.
- **Fixed: `models explain` disagreed with itself.** When model-first routing (or per-model learning) selected a provider different from the deterministic pick, the rationale line named the PRE-override provider (live: `Decision: gemini/gemini-3.1-flash-lite` beside a `groq/gemini-3.1-flash-lite` rationale), `decision.score` was that loser's score, and the ✅ could sit on a row ranked below #1. The final provider's entry is now promoted to `ranked[0]`, `decision.score` is its score, and the rationale is built from the final provider — the rationale, Decision line and ranked table always agree. The bandit promotion gate's A/B record is deliberately left untouched.
- **Test suite: 5,720+ root tests passing**, including a new router decision-consistency suite plus cases for the loop failover, the window-aware budgets and the RPM breaker.

## v2.7.3 — fix: one deep failover pool + per-model quota for every entry path

- **Fixed: failover was one model per provider.** `decision.fallbackChain` carried a single resolved pick per provider, so a provider's 2nd/3rd-best model was effectively unreachable — a 429 on the one listed model skipped the whole provider, even though free tiers meter PER MODEL (RPD/TPM) and the siblings were usually still usable. The chain now carries several models per provider (bounded depth), plus the reserve pool's alternates.
- **Fixed: quota was provider-scoped.** A `429` on one model parked the ENTIRE provider (`parkProvider`), dragging its healthy siblings down. Parks are now per-model (`parkModel`, `scope: 'provider' | 'model'`) with escalation to a provider park only when several DISTINCT models of the same provider are rate-limited — which is the honest signal for a genuinely shared limit (Groq's free-tier TPM is shared across all of its models). `getRouterQuotaStatus()` reports provider-scoped parks only, `getModelQuotaStatus()` reports the per-model feed, and the dashboard payload now carries `scope` so "model resting (siblings routable)" renders distinctly from "provider parked".
- **Added: one shared deep-failover pool for every entry path.** The deepest candidate list used to exist only inside the orchestrator's resilient proxy, so CLI chat, the dashboard console, the gateway and `execute` walked a shallower list and the paths could silently drift. `buildDeepFailoverPool()` is now the single source (primary → model-first tiered pool → router chain incl. reserve → ranked placeholders → config fallback) and chat/execute/orchestrator all consume it. The router's own pick is pinned FIRST so the pool's score sort can never silently override the routing decision.
- **Fixed: tiered candidates only come from credentialed providers.** The model-first layer was returning the whole model CATALOG, so walks pointlessly probed providers with no API key (measured: 23 candidate pairs, 16 of them un-credentialed). Restricting it to the router's ranked set removed the noise without losing a single reachable model.
- **Added: one shared exclusion rule.** `createFailoverExclusionFilter()` implements the orchestrator's walk-time rule — provider-wide session failures, model-scoped session failures, cross-pipeline persisted failures, and PER-ENTRY registry usability — and is now used by chat, `execute` and the orchestrator, so the rule can never drift between paths. A parked/failed model excludes only itself; its siblings stay reachable.
- **Fixed: `execute` had no failover exclusions at all.** It now applies the same filter, in two passes (excluded candidates are attempted LAST, never dropped), so "reject only when nothing is left" still holds when every candidate is marked unhealthy.
- **Improved: no redundant model repair on failover.** Chat's failover candidate for a provider now carries the registry-VERIFIED model, so a retired pinned model is never consulted on the failover leg — one fewer repair round-trip per failed turn (locked by the repair/failover E2E test).
- **Improved: model health never heals backwards.** A successful call now decays a model's error-rate EMA (floored at 0) and heals through `recordCall(ok)`, and a lapsed quota park re-admits the healed model automatically and refreshes the dashboard — a model that once hit a transient failure can no longer stay penalized forever.
- **Fixed: non-chat models could be routed.** One shared `isNonChatModel()` (classifiers, embeddings, rerankers, speech, image/video/music) is applied at every selection choke point — probe candidacy, `preferredModelsFor`, `resolveVerifiedModel`, `pickBestModel`, `topModelCandidates` and model-first cost scoring — so a content classifier marked "verified" by a probe can never serve a task.
- **Test suite: 15 new regression tests** pinning the shared pool invariants (router pick first, superset of the chain, no one-model-per-provider dead ends, credentialed-only tiered candidates) and the shared filter (model- vs provider-scoped, both map shapes, per-entry registry checks, recovery after expiry). **3,033 tests across learning / inference / agents / cli passing.**

## v2.7.0 — feat: agentic capability assessment closure (engine routing, loop skill hints, DAG telemetry, model-level gates)

- **Added: Engine-mode routing (loop vs pipeline)** — a deterministic `resolveEngine()` decides whether a goal runs on the interactive tool loop or the multi-agent pipeline, with mode-level routing config (`routing.engineMode`), a routing cache, and per-arm eval support (loop vs pipeline vs writer-tc).
- **Added: Native tool-calls protocol** — `inference/native-tools.ts` closes the blocking protocol gap for providers that speak native tool calls; adapters (Anthropic, Gemini) honor it.
- **Added: Loop-side skill match hints** — the chat and execute loops now consult the compiled SkillStore + hub catalog deterministically before every turn and inject the matched skill's methodology (bounded to ONE block, disabled-skill + activation gates honored, real-goal-evidence filter so a generic word can never trigger it).
- **Added: Engine badge + per-turn tool-call telemetry in the dashboard DAG view** — `🔁 loop` / `⬡ pipeline` badge with router explanation, per-turn telemetry card (tool calls, errors, provider/model, bounded/cancelled chips), and engine tags on every timeline run.
- **Added: Ambient project context + mechanical thread budget for the loop** — `loop-project-context.ts` and `trimThreadBudget` keep long loop turns grounded and bounded.
- **Improved: Router constraint gates evaluate the MODEL, not the provider** — `minSpeed`/`minReasoning` are refined with model-id evidence before elimination, so a provider hosting both instant and heavyweight models is no longer dropped wholesale by per-model gates.
- **Improved: Delivery-grade answer selection** — both loop exits honor longest-substantive output (a short closing line can no longer clobber the composed deliverable); think-only responses excluded.
- **Added: Behavioral delivery evals** — real `runToolLoop` + `gateway_send` scenarios (compose/send, unknown-contact recovery, transport-failure retry, JSON fallback) lock in correct agent behavior for everyday messaging tasks.
- **Improved: Engine stamps in eval reports and json-events** — parity across DAG, eval, and event telemetry surfaces.
- **Fixed: Release-sync detector** now covers the `nuvira vX.Y.x` docs-header form (was `buff`-only); `context-pruner` pins `en-US` locale formatting (en-IN grouping broke output assertions).
- **Shipped in the 2.6.x line since the last changelog entry:** `clone_repo` tool, gated `git` tool (diff cards + confirm-gated commit), `plan_todo` + `skill` chat tools, ToolCards step rendering, five first-party skills at depth (website-deploy, code-assessment, technical-roadmap, plan-create-track, test-strategy), npm-packaged skills registry that never silently 404s.
- **Test suite: ~5,190 tests across 290+ files passing**

## v1.80.0 — feat: Model-first routing, tiered failover, 1-token warmup, tool-level modality routing

- **Added: Model-first routing** — auto-router now scores INDIVIDUAL MODELS across ALL 22 providers (not provider-first). Each model scored on 6 dimensions: cost per million tokens, capability fit, health, quota availability, provider speed, verification status. Picks the BEST MODEL for the task, then finds which provider serves it cheapest.
- **Added: Per-model pricing** — 20+ model families with accurate per-million-token pricing (GPT-4o, Claude Sonnet, Gemini Flash, Llama 3.3, etc.). Replaces provider-level estimates with model-level accuracy.
- **Added: Tiered failover chain** — capability-based with quota pre-check: same model → same tier → escalate → de-escalate → local → neural response. Quota pre-check skips parked models BEFORE API call (no wasted latency).
- **Added: 1-token warmup daemon** — background service keeps frequently-used models warm. Priority scoring: recency (35%) + frequency (25%) + verification (20%) + latency (20%). Runs every 60s, throttled to 5-minute cooldown per model.
- **Added: Tool-level modality routing** — intelligent routing for image/audio/video with failover across backends. Image: ComfyUI (free) → Pollinations (free) → DALL-E (paid) → Stability (paid). TTS: NeuTTS (free) → OpenAI TTS (paid) → ElevenLabs (paid). Video: FAL (paid) → Runway (paid) → BFL (paid).
- **Added: Non-chat model filtering** — image, audio, video, research models filtered from LLM routing candidates. Only chat-capable models considered for text tasks.
- **Improved: All 22 catalog providers participate in auto-routing** — was limited to 6 built-in providers. Now includes OpenAI, Anthropic, Mistral, Cohere, Together, DeepInfra, Fireworks, Perplexity, Azure, LM Studio, Anyscale, vLLM, DeepSeek, xAI, Replicate, Bedrock.
- **Improved: resolveModel() never returns 'default'** — every provider resolves to a real curated model name (e.g., Groq → llama-3.3-70b-versatile, OpenAI → gpt-4o-mini).
- **Fixed: Model selection for complex tasks** — small models now capped at 0.20 capability fit for complex/critical tasks. Large models get 1.0. Previously all models scored equally.
- **Fixed: Dashboard quota reset time** — ModelsPanel now shows 'Resets in 2h 15m' for parked models.
- **Test suite: 5,000+ tests across 220+ files — 100% passing**

## v1.78.0 — feat: contact-centric gateway messaging, Bedrock onboarding, Telegram auto-registration

- **Added: Contact-centric outbound messaging** — the contacts store now uses friendly names (Anuj, Divya) instead of cryptic IDs. Outbound resolution supports name, phone number (flexible format: +91..., 0..., digits-only), or platform ID. `gateway_send("Anuj", "...")` resolves via contacts store.
- **Added: Contact registration system** — new Telegram users auto-register with `status: pending` on first message. Admins approve/reject via dashboard Contacts tab or CLI (`buff gateway contact approve Anuj`). Only approved contacts can receive outbound messages.
- **Added: Dashboard Contacts tab** — full CRUD management UI with status filters (all/approved/pending/rejected), approve/reject/edit/delete actions, and edit modal for name + phone.
- **Added: CLI contact commands** — `buff gateway contact list`, `approve`, `reject`, `delete`, `add`. Supports `--pending` and `--platform` filters. Auto-detects platform when omitted.
- **Added: Bedrock onboarding** — CLI setup wizard (`buff bedrock setup`), dashboard onboarding panel (`/bedrock`), and 3 API endpoints (status/setup/probe). Dynamic region resolution via `BEDROCK_REGION` env var.
- **Fixed: Bedrock inference URL** — `baseUrl` now includes `/openai/v1` so the OpenAI-compatible adapter routes correctly to `bedrock-runtime.{region}.amazonaws.com/openai/v1/chat/completions`.
- **Fixed: Telegram inbound policy** — changed from `allowedUsers: ["+918800425333"]` (phone number that never matches Telegram IDs) to `allowedUsers: ["*"]` (open inbound, contacts-gated outbound).
- **Fixed: smart error messages in gateway_send** — pending contacts get "⏳ pending admin approval" message; rejected contacts get "🚫 rejected" message instead of generic "unknown target".

## v1.77.0 — feat: dynamic model catalog, Bedrock provider, website refresh

- **Fixed: 22 catalog providers now route correctly** — the capability-fit scoring was hardcoded for 5 built-in providers, causing 0% fit penalty for Bedrock, OpenAI, Anthropic, DeepSeek, xAI, and others. Now derives chat/code tags dynamically from provider capability profiles.
- **Added: Amazon Bedrock provider** — 121 foundation models (Claude, Llama, DeepSeek, Qwen, GPT-OSS, etc.) via Bearer token auth. Configured via `AWS_BEARER_TOKEN_BEDROCK` in `~/.buff/.env`. Dashboard health check uses the foundation-models listing API.
- **Improved: dynamic model catalog** — pattern-based badge generation replaces 40+ hardcoded model names. When a provider retires a model, the system adapts automatically — no code changes needed.
- **Added: `buff models staleness` command** — shows per-model freshness status (<7d fresh, 7-30d stale, >30d+>50% error = likely removed).
- **Improved: website refresh** — removed internal "Phase 1→11" and "Architecture" sections that were developer-facing. Updated hero to show Dashboard + CLI. Fixed test count (4,864+). Added Enterprise section with RBAC, audit chain, governance, and 22-platform gateway.

## v1.76.1 — feat: Model Discovery Timeline panel

- **Added: Model Discovery Timeline** — a new `/models/timeline` dashboard panel that shows every known model's freshness status (fresh / stale / likely removed), last probed time, last verified time, last used time, error rate, and latency. Summary cards show total / fresh / stale / removed counts. Filterable by status and sortable by provider / last-seen / status. Auto-refreshes every 30 seconds.
- **Added: `/api/model-timeline` endpoint** — reads the model-registry.json mirror and returns per-model timeline data with staleness classification (<7d fresh, 7-30d stale, >30d+>50% error rate likely removed).
- **Fixed: timeline endpoint uses sync disk read** — replaced async `await import()` with synchronous `readJSON()` to avoid TypeScript errors in the non-async HTTP handler.

## v1.76.0 — feat: improved folder browser, Telegram auto-learning, and Getting Started wizards

- **Improved: folder browser redesigned** — the Browse button now shows drive roots (Windows C:/D:, Mac /Volumes), breadcrumb navigation, search/filter, auto-refresh every 5 seconds, and modified dates. No more "lame" folder picker — it now works like a proper file explorer.
- **Fixed: Telegram contact IDs** — users added phone numbers (+91XXXXXXXXXX) for Telegram contacts, but Telegram requires numeric chat IDs. Added validation that rejects phone numbers and shows a clear error message. The gateway now auto-learns the real chat ID from incoming messages and auto-creates contacts.
- **Added: Getting Started wizards** — `buff gateway setup [platform]` provides an interactive step-by-step wizard for Telegram, Discord, Slack, and Email. The dashboard Platforms page shows a 🚀 Getting Started button on unconfigured platforms with a 3-step wizard: Instructions → Token → Verify & Test.
- **Added: Platforms onboarding page** — a dedicated `/platforms` page shows all 22 messaging platforms with setup status, env var indicators, and direct links to developer portals.
- **Added: Telegram setup docs** — the dashboard Channels tab and Platforms page now show 📖 Docs links to each platform's developer portal and one-line setup hints.

## v1.75.3 — fix: dashboard project picker, Telegram setup docs, and CLI interactive mode

- **Fixed: "current dir" button shows error** — the dashboard's project picker showed a "current dir" chip that pointed to the server's `process.cwd()` (typically the npm global install path, not the user's project). Clicking it timed out trying to scan thousands of files. Fix: removed the unreliable cwd chip and renamed the label to "Select Project Folder".
- **Added: Telegram/Discord/Slack setup docs and hints** — the dashboard Channels tab now shows a 📖 Docs link per platform (linking to the platform's developer portal) and a one-line setup hint explaining exactly what to do (e.g. "Create a bot via @BotFather, paste the token, then run `buff gateway start`"). The CLI `buff gateway status` command now also shows a "Next steps" section when adapters are configured.
- **Improved: `buff gateway start` shows setup instructions** — when no adapters are configured, the gateway start command now shows platform-specific setup commands (Telegram token, Discord token, Slack token, etc.) instead of just a generic env var list.
- **Fixed: CLI chat exits after initial task** — `buff chat "do something"` showed followups but exited when the user pressed Enter without picking one. Now it falls through to an interactive chat loop where the user can keep typing messages (or type `/exit` to quit).

## v1.75.2 — fix: chat resolve loop, local fallback UX, and tool-loop step limit

- **Fixed: "No — ask the agent" button loops back to the same resolve card** — when the dashboard's intent resolver matches a user's message to a CLI command (e.g. `buff trace list`), declining the command card re-sent the same message to `chatResolve`, which found the same match and re-showed the card in an infinite loop. Fix: added a `skipResolve` flag to the send function so declined messages bypass re-resolution and go straight to the agent.
- **Improved: auto-routing local fallback UX** — when all cloud providers are blocked/unavailable and routing falls back to a local Ollama model, the progress message now includes a hint (`⚠️ local model only — run buff models or buff provider set to add a cloud provider`) so the user knows why only local is available.
- **Increased: tool-loop step limit from 8 to 16** — the chat tool loop's `maxSteps` was hardcoded to 8, which was too low for complex tasks like "assess this project and create a code map" (reading multiple files + searching patterns + writing a document easily exceeds 8 tool calls). Increased to 16 to accommodate multi-step tasks while still preventing infinite loops.

## v1.75.1 — hotfix: dashboard blank page on load (resumeSession temporal dead zone)

- **Fixed: dashboard blank page** — `resumeSession` referenced `attachProject` in its dependency array, but `attachProject` was defined after `resumeSession` in the component. This caused a `ReferenceError` at render time (temporal dead zone for `const`), crashing React and showing a black blank page. Fix: use an `attachProjectRef` to break the circular dependency.

## v1.75.0 — session resume + project-aware chat (--cwd, browse, context scoping)

- **`--cwd` option for `agent-nuvira dashboard`** — override the working directory at launch so the "📂 current dir" chip points to your project (`agent-nuvira dashboard --cwd ~/my-app`), eliminating the mismatch when launching from a different directory
- **Attached project scopes the agent's working directory** — `toolContext.cwd` now resolves to the attached project path (not `process.cwd()`), so file tools (`read_files`, `write_file`, `str_replace`) and terminal commands run in the project root, making "assess THIS project" a full working context, not just a context hint
- **Folder browser for project attach** — 🗂️ Browse button in the chat project picker opens a server-side directory navigator (`GET /api/browse`) to drill into subdirectories and select the project root, instead of typing the path manually
- **Session resume restores project context** — when you click a past conversation in the sidebar, the stored `projectPath` is auto-attached (server rebuilds the context bundle), so the agent immediately has file access in the right project directory
- **Project mismatch banner** — if a resumed session's project doesn't match the currently attached folder, a banner shows the stored path with a one-click "Attach it" / "Switch to it" button
- **Sidebar shows project per conversation** — session items display the project folder name (e.g. `📁 my-app · 5 msgs · today`) so you can identify which project each conversation belongs to at a glance

## v1.74.2 — dashboard-first: chat is the front door (Phases 1–8 delivered)

- **Chat is now the product's front door** — `/` lands on Chat (Overview moved to `/overview`); every capability (gateway, memory, models, publish, skills) is a tool the agent calls from the same window, never a new room. The CLI engine stayed byte-identical — `buff chat/execute/plan` unchanged; the dashboard calls the same engine through `/api/chat` and the same CLI through `/api/tasks`
- **Spec-complete markdown** — react-markdown + remark-gfm + rehype-highlight (tables, task lists, autolinks, syntax highlighting), code blocks with a language label + copy button, XSS-safe
- **Token streaming typewriter** — SSE `token` events stream the final answer with a blinking cursor (new opt-in `generateToolsStream` across groq / openrouter / nim / openai-compat via one shared helper; non-streaming POST stays the fallback); the live plan checklist, tool cards, and git-diff cards stream mid-turn and snapshot into the reply
- **Artifact cards (P2)** — ```` ```diff ```` blocks, test/build output, and deploy URLs written directly into the answer text render as cards (diff / ✅❌ result / 🚀 deploy, each with a copy button + roving-focus keyboard nav); the git-tool diff card gained per-file ✓/✗ accept/reject + **"Commit accepted (N)"** (the accepted subset rides the engine's accepted-subset commit contract — gated on an attached project so prose can't trigger a commit); the ⚡ Run-this-command confirm path now runs a live inline execution card (ANSI-stripped, stream-separated stdout/stderr, exit code + duration, cancel, copy-output)
- **Project context (P3)** — attach any directory: a bounded code-map snapshot (path + tree + symbol map) rides every turn, so "assess THIS project" works without describing the codebase; per-session memory auto-recall (P4)
- **Persisted sessions (P4/P8)** — smart-rail sidebar (resume any past conversation, 🔍 search, date groups, ✏️ rename / 🗑 delete), transcript resume across restarts, streaming cancel + retry on failed turns
- **Real composer (P8)** — file picker / paste-as-attachment / drag-drop (300 KB × 10 caps); attachments ride the turn as `[Attachment: name]` context; `/api/chat` gained a 1.5 MB body reader so attached documents pass the admin cap
- **Skills as a product surface (P7)** — /learn preview cards (✅ accept / ✏️ edit / ↩ reject → SkillStore), cross-skill bundles, hub-catalog frontmatter depth (platforms / toolsets / env-var gates), marketplace install/uninstall panel (quarantine + checksum-verified) — plus the bundled **docx** skill (create / read / edit Word documents)
- **Verified end-to-end** — real-HTTP E2E tests drive chat → diff extraction → accept/reject → commit against the running server with the exact modules the GUI uses; dashboard suite **263** green, root suite **4,864** green (217 files)

## v1.74.1 — chat agentic core: dashboard chat = full agent loop

- **Interactive chat loop (P0.1–P0.8)** — the dashboard chat is now the full agent loop: `ask_user` question cards, read/list/glob/code_search tools, confirmation-gated edit/write, gated `run_terminal` (deny-first, masked), a live plan checklist (`plan_todo`), step cards for tool calls, and a `skill` tool that loads reusable capability packs mid-conversation
- **Assess any project (P3a)** — `clone_repo` clones into an ephemeral cache and scopes the whole turn to the clone (your workspace is deny-gated)
- **Gated git (P3b)** — `git` tool with a per-file diff card (accept/reject), gated commit of only the accepted subset; push/reset/clean are structurally unexpressible + deny-guarded
- **Tool-fallback chain + parallel suggestion (P3c/P3d)** — when a tool errors, the model sees a concrete alternative hint; after 2+ independent gathers, a delegate tip offers parallel subagents
- **First-party skill batch (P5b)** — five bundled skills (website-deploy, code-assessment, technical-roadmap, plan-create-track, test-strategy), each at the website-deploy depth bar; row-per-skill comparison table in ASSESSMENT_CAPABILITY_GAPS.md
- **Release-sync (P5a)** — after every successful publish, website/docs release markers are diffed against the new version and gaps surfaced (offer-to-fix, never a silent drift)
- **Default skill registry resolves (P5c)** — the repo ships `.agents/skills/` (index.json + SKILL.md per bundled skill, sync-drift guard tested); a status-aware probe makes `buff skills search`/`install` surface an unreachable registry with status + fix hint instead of silently 404ing
- **4,774 root + 208 dashboard tests passing**



## v1.74.0 — Verified-contacts manager + hardened verified-list rule (gateway + dashboard)

- **Verified-list rule enforced exactly as specified** — per platform, the **Allowed users** list now has three states: entries = **only those senders** may trigger (in DMs **and** groups); **blank** = **no one** may trigger; the token **`Allow-All`** (case-insensitive, `*` works too) = **skip the verifier**, anyone may trigger. A list that was never configured keeps the legacy open default
- **Group senders now pass through the verifier** — the `allowedUsers` check previously lived in a DM-only branch, so any non-certified member of any group could trigger the agent (live incident: 8/9 group messages from random `@lid` senders got replies). The per-user allow-list now gates group authors too (group must be allowed AND sender certified, when each is configured)
- **Verified contacts manager (dashboard + API)** — add a person as **Name + Contact No** (exactly like the CLI `buff whatsapp contact add <Name> <number>`): the number goes into the platform's allow-list, the name into a new cross-platform contacts store (`~/.buff/gateway/contacts.json`). Works for **every** channel — WhatsApp numbers, Telegram ids, email addresses, group jids
- **📇 Saved contacts (validated list)** — the Permissions page now lists every saved contact (name, platform, contact) with a ✅ verified badge when its id is in the allow-list; ✕ removes it from both places. The same list is exposed by the API (`GET /api/admin/gateway/policies` → `contacts`, `PUT` persists them) and `/api/hub`
- **Add/remove from the dashboard works properly** — the policy draft is now seeded from the SAVED list, so adding or removing ONE user no longer blanks the rest of the list (previously removing a single contact hid all of them, and saving silently deleted the others)
- **Send-by-name parity** — a named WhatsApp contact added from the dashboard is also synced into the bridge contacts file, so `buff gateway send whatsapp:<Name> "…"` resolves it immediately
- **7 new tests** (contacts store unit suite, policies API contacts round-trip + malformed-contact rejection, hub-data contacts surface, Permissions UI add/remove flows) — 4,556 root + 196 dashboard tests passing

## v1.73.1 — WhatsApp inbound hotfix: first-contact LID resolution + empty-participant gate bug

- **Inbound senders now resolve through Baileys' OWN persisted LID→PN files** — the bridge only learned mappings from `lid-mapping.update` events, but Baileys stores the pairs it learns from message envelopes as `lid-mapping-<lid>_reverse.json` WITHOUT emitting an event, so a contact's FIRST message arrived as an unknown `@lid` and was silently refused by the allow-list. `LidJidMapper.resolve()` now falls back to those files (lazy, cached, persisted) — a verified contact's first message now passes the gate
- **Empty-string `key.participant` no longer blanks the sender id** — Baileys 7 delivers DMs with `key.participant: ''` (empty string, not nullish), so the adapter's `participant ?? fromJid` produced an empty `senderId` and the policy gate refused EVERY sender (live symptom: verified WhatsApp senders got no reply at all). The bridge treats `''` as absent and the adapter uses `participant || fromJid`
- **3 regression tests** — Baileys reverse-file resolution, empty-participant normalization at the bridge, and empty-participant handling at the adapter
- **4,542 tests passing across 195 files**

## v1.73.0 — WhatsApp LID fix + clean messaging output + gateway hardening

- **WhatsApp LID→phone-number resolution** — WhatsApp's privacy rollout delivers DMs as random `@lid` jids (NOT phone numbers), so verified senders and contacts silently failed the allow-list. The Baileys bridge now learns LID→PN pairs from `lid-mapping.update` events, contact sync (`lid`/`phoneNumber`) and the paired account's own `creds.me`, translates every inbound sender + group participant to its phone-number JID **before** the policy gate, and persists the mappings (`lid-mappings.json`) so restarts keep working
- **Clean messaging output (gateway)** — messaging channels now receive ONLY the final natural-language answer plus the model's suggested followups rendered as a readable `Try next:` list. No internal progress, no "routed to…", no raw `⚙ suggest_followups({…})` JSON ever reaches a sender (a 4,000-char guard drops followups, never the answer). Progress visibility in **chat / execute / dashboard console is unchanged** — it stays in the live UI and the audit logs
- **Permissions UX fixes** — removing ONE allowed contact no longer blanks the whole list (the dashboard draft now merges over the saved policy), and the policies API merges per-key so toggling a single flag (e.g. `silentDrop`) never wipes a platform's saved `allowedUsers`
- **Status-recipient display** — the dashboard resolves each recipient to a friendly label (`whatsapp:Daddy → +918178504516` via the contacts file; numbers get the country-code `+`), so a user never sees a bare alias
- **Gateway start from the dashboard never times out** — the "Start gateway" preset ran under the task console's 5-minute timeout and was silently SIGTERM'd; `timeoutMs: 0` (indefinite) is now supported end-to-end and the gateway keeps running across tab switches until you press Cancel
- **4,539 tests passing across 195 files**

## v1.72.0 — Gateway intelligence: chat answers, delivery tools, validated senders + status recipients

- **Chat answers on the gateway** — `write`/`explain`/`ask` intents from any messaging channel now run a REAL chat answer through the same engine as the dashboard console (with origin context, live progress streamed to the channel, and a non-hanging askUser that forwards clarifications back to the channel). No more "I understood" stub for a poem request — the model actually writes the poem
- **`gateway_send` tool in the agent loop** — the model can deliver to any channel/contact/group (`whatsapp:Daddy`, `email:…`, `slack:ops`…), so "write a poem and send it to Daddy" is written AND delivered in one turn. Delivery-ask detection routes pipeline intents that also ask to send (`create a report and send it to the team`) through the agent loop so build → deliver composes; pure pipeline tasks stay on the fast direct path
- **Live-bridge reuse** — `gateway_send` inside the gateway reuses the RUNNING registry + already-connected adapters instead of building a fresh one (a second WhatsApp connection stalled deliveries for 60s+). Fixed the class-vs-instance bug that broke chat answers in the live gateway (`engine.answerOnce is not a function`) with a regression test
- **Validated-sender Permissions (dashboard + API + CLI)** — per-platform `allowedUsers` / `allowedGroups` / `requireMention` / `disabled` / `silentDrop` managed from a new **Agent Hub → Channels → Permissions** page, `GET/PUT /api/admin/gateway/policies` (RBAC: admin/operator), and `buff config gateway allow/disallow/reply`. Changes apply to a RUNNING gateway immediately (policies re-read per inbound)
- **Hard silent-drop policy** — unapproved senders get NO reply and NO processing by default (they never learn a bot exists); polite `⛔` refusals are an explicit opt-in (`silentDrop: false`). Applies to EVERY message including light/help intents, across all platforms
- **Status recipients** — `gateway.statusRecipients` (CLI `buff config gateway notify add/remove/list`, dashboard **📊 Status recipients**) — chosen contacts/groups ALWAYS receive the pipeline completion summary regardless of who triggered it
- **JID normalization** — allow-lists accept `+918800604222` and match the bridge's real JID (`918800604222:13@s.whatsapp.net` / `@lid`), so your own number can actually trigger the bot; non-WhatsApp ids (telegram/slack/email) pass through untouched
- **Cross-platform parity** — IRC + SimpleX now populate `senderId`/`isGroup` so the shared per-user gate applies to them too; media sends extended to Telegram + Discord (`sendMedia`)
- **Chat reliability fixes** — the delivered answer is no longer clobbered by JSON-only tool steps, malformed follow-up blocks never leak raw JSON, and repeated `suggest_followups` calls no longer accumulate stale suggestions
- **4,531 tests passing across 195 files**

## v1.71.0 — ML task-similarity routing + promotion-gate enforcement

- **ML router (`routing.mlRouter`, opt-in)** — a ruflo neural-router analog, built zero-dependency: task text is feature-hashed (FNV-1a, 256-dim + intent/complexity tail), every real outcome is stored as a feature vector, and at resolve time the k most similar past tasks (cosine, k=8) yield per-provider win rates → a strength-clamped learned factor that nudges candidate scores. Cold start is neutral, min-samples guarded (5), never overrides a large deterministic edge
- **Promotion-gate enforcement (`routing.promotionEnforce`, opt-in)** — the bandit may always learn, but with ≥ `promotionMinDecisions` (20) diverged A/B decisions it may only steer picks if it has PROVEN itself (quality > +2%, cost < +1%, latency < +5%). A failing bandit falls back to the deterministic ranking (`routedBy: 'bandit-gated'`); the trajectory keeps recording so a future promotion re-enables it
- **Observability** — `buff model ml` shows learned state (records, per-provider win rate/factor); `buff model bandit` shows the gate verdict; dashboard Routing Insights gains an **ML Router card** (learned tasks, trusted vs still-learning providers, win-rate bars + factor chips)
- **Dependency hygiene** — npm `overrides` lifts `global-agent` to v4.1.3, removing the deprecated `boolean@3.2.0` warning from installs
- **Documentation** — DESIGN_DECISIONS #35 (ML routing + promotion enforcement) and #36 (quota as veto filter, not selector); ROUTER_COMPARISON §8 records the full assessment
- **4,467 tests passing across 194 files**

## v1.70.2 — Weak-model prompt fix: the user can finally choose

- **Weak-model decision prompt is now actually interactive** — the inquirer choices (continue / wait / abort) rendered but every keystroke was swallowed by the live pipeline board's raw-mode stdin handler, so the user could never select and the single-shot session exited on the weak-model outcome. The board is now paused before the prompt and resumed after (mirroring the rate-limit prompt's proven pattern)
- **4,454 tests passing across 193 files**

## v1.70.1 — One-command setup for new users

- **Platform setup scripts** — `scripts/setup/install-macos.sh`, `install-linux.sh` (apt/dnf/yum/pacman/apk auto-detect), `install-windows.ps1` (winget): check for required tools (Node, npm, Git, build tools, brew/winget), install anything missing with confirmation, install Agent-Nuvira (npm 11 allow-scripts handled), then offer optional native FAISS + local embeddings with plain-English yes/no prompts
- **README** — new "One-command setup for new users" section with copy-paste one-liners per OS + a "Local embeddings" tier table (local → Python → LLM)
- **4,452 tests passing across 193 files**

## v1.70.0 — Enterprise delivery: weak-model control, build-aware runner, consent-gated tool install

- **Weak-model control** — `routing.promptOnWeakModel` (opt-in): when a task can only run on a weak model, the user chooses **continue / wait / abort** instead of silent degradation
- **Reliability for weak models** — writer recovers plain code blocks via lenient inference ONLY when no stronger model exists; no-op escalation is detected and repair is bounded (never a 10-min identical-failure loop)
- **Build-aware runner** — planner plans packaging steps for deployable deliverables; runner prompts carry reference docs + written file contents; deterministic `.nvda-addon` packaging for cannot-run-here addons (live: NVDA addon builds in 11ms instead of failing 3×)
- **Consent-gated tool install** — missing system tools (zip, git, make, cmake, docker, kubectl, terraform, aws, go, java, …) are detected, recommended with OS-appropriate commands (brew/apt/dnf/winget), and installed ONLY with user approval — manual steps in non-interactive mode, never silent failures
- **4,452 tests passing across 193 files**

## v1.69.0 — Gateway platform config + chat reliability

- **Major revamp complete** — all 30 rows of the capability parity program are landed (AGENT_NUVIRA_MAJOR_REVAMP_PLAN)
- **Reliability stack** — writer surfaces unparseable output instead of masking it (repair escalates the model), reviewer-blocked verdicts route through a writer fix pass, weak-local-model pre-flight warning before long runs
- **New `buff code-map`** — project symbol map (functions/classes/methods) via the AST engine; closes the last revamp row; AST dedupe fix recovered silently-dropped top-level functions
- **Scheduled jobs** — `buff admin cron add/list/remove/run` with schema-validated args, RBAC-gated writes, channel delivery
- **Multi-channel gateway** — Telegram / Discord / Slack / WhatsApp via `buff gateway`
- **Web tools + modality packs** — `web_search`/`read_page` (SSRF-guarded) plus browser / image / voice / vision tools
- **Structured logging (K1) + runtime metrics (K2)** — JSON logs with correlation IDs; `buff doctor --enterprise` runtime metrics
- **Session recall** — chat auto-recalls per-project sessions and facts
- **4,031 tests passing across 167 files**

## v1.68.0 — WhatsApp bridge auto-reconnect (whatsmeow parity)

- **Assessment of WhatsApp bridge options (tulir/whatsmeow)**: whatsmeow ships
  first-class auto-reconnect (`EnableAutoReconnect`), while our Baileys bridge
  only recreated a dead socket on the next send/connect — so the inbound
  listener (agent tasks triggered from WhatsApp) could die silently
  mid-session.
- **The connected bridge now auto-reconnects**: when the socket dies (network
  drop, Baileys 7's 515 restart, server cycling), it is recreated from the
  persisted session with exponential backoff (2s → 30s cap), re-wiring the
  message listener on the fresh socket. `disconnect()` and a server-side
  logout (401 / device_removed) stop the watcher; a pairing flag keeps it
  from racing an in-flight `pair()`.
- So the full loop holds post-pairing: message in → agent pipeline runs
  (allow-list gated) → reply out — and it stays up across socket drops.
- Bridge tests: 26 (auto-reconnect + inbound on the new socket, 401 stops the
  watcher, disconnect stops it, 515/post-code restarts, window bound, phone-
  mode ordering, self-healing). Root suite: 4,359 tests green.

## v1.67.0 — WhatsApp pairing fix (Baileys 7 reconnects)

- **🐛 Real-world pairing was failing with `Stream Errored (restart
  required)` / `Connection Terminated`.** Baileys 7.0 closes the connection
  after a successful QR scan or pairing-code issuance — WhatsApp expects the
  client to reconnect with the freshly-saved credentials to finish. The
  bridge treated those closes as hard failures.
- **pair() now handles restart-worthy closes**: the explicit 515
  "restart required" and any server-initiated close after a QR/code was
  issued (incl. the 428/401 reconnect closes) swap in a fresh socket that
  reuses the in-memory auth state, bounded by the pairing window (the
  window — not a restart cap — is the real bound, so the code stays alive
  while you enter it on your phone).
- **Phone-number pairing fixed**: the code request now waits for the
  WebSocket handshake before calling `requestPairingCode` — the immediate
  call raced the handshake and the request never reached WhatsApp.
  Verified live: WhatsApp now issues a real 8-char code for the pairing
  number.
- **Self-healing sockets**: a bridge socket that dies (e.g. a 515 on an
  established session) is dropped so the next send/connect recreates it from
  the persisted session.
- Bridge tests: 23 (515 restart, post-code 428/401 restarts, window bound,
  phone-mode call ordering, self-healing). Root suite: 4,356 tests green.

## v1.66.0 — Live chat progress streaming + gateway ops in the GUI

- **⚡ Live working steps in the Chat tab.** The agent's tool calls and
  reasoning markers now stream into the GUI in real time while a turn runs
  (previously a static "thinking…" bubble). The tool loop's `onEvent` stream
  is wired into `ChatCommand.answerOnce` via an `onProgress` hook, the chat
  console emits per-session progress/status events, and a new SSE endpoint
  `GET /api/chat/:sessionId/events` delivers them to the page (subscribed
  BEFORE each turn so no step is missed). Completed answers keep a
  collapsible step summary.
- **🌐 Gateway ops tab.** Gateway status, delivery ledger, foreground start
  (with live event stream + Cancel), and cron management now run the real
  `buff gateway` / `buff admin cron` CLI from the GUI via a shared
  `TaskConsole` component (preset buttons + custom command line, live SSE
  console, cancel, timeout) — extracted from the Evals tab so both surfaces
  reuse one console.

## v1.65.0 — Dashboard chat console + eval runner in the GUI

- **💬 Chat tab — chat with the agent from the GUI.** Each message runs ONE
  tool-loop turn through the real agent engine in the dashboard process
  (`ChatCommand.answerOnce` — the exact engine behind `buff chat "<prompt>"`),
  with the conversation threaded server-side per session so the GUI holds a
  real back-and-forth. The model's suggested follow-ups render as clickable
  chips that send their prompt as the next message. API: `POST /api/chat`
  (`{ sessionId?, message, provider?, model? }`) + `POST /api/chat/reset`,
  admin/operator-gated. Non-TTY by construction: an injected `ask_user`
  renderer declines clarifications instead of hanging on piped stdin.
  Verified end-to-end against a real provider (content + followups returned).
- **🏆 Evals tab — run `buff eval` from the GUI.** Preset buttons
  (quick / medium / slow / M2B parity / full) plus a custom task filter, each
  running the REAL `buff eval run` as an isolated process via the task runner
  with a live SSE console and cancel; the results table auto-refreshes from
  evals.json (tasks passed, completion, composite score, cost) as runs land.
- 19 new tests (chat console unit + API, Chat page, Evals page); suite at
  4,345 root + 178 dashboard, typecheck clean.

## v1.64.0 — Dashboard command console (P1) + in-page WhatsApp pairing (P2)

- **Dashboard Tasks tab — every CLI command runnable from the GUI (P1).** The
  dashboard executes the REAL CLI (`node dist/index.js <args>`) as an isolated
  child process, so command parity is guaranteed by construction. Run any
  command (`eval run --task smoke`, `gateway status`, `skill list`, …) from a
  `🚀 Tasks` tab with a live log console (SSE), cancel (SIGTERM), timeout
  (SIGTERM→SIGKILL), and history (last 50, click to reopen). API:
  `POST/GET /api/tasks`, `GET /api/tasks/:id`, `POST …/cancel`, `GET …/events`
  — all admin/operator-gated. Verified end-to-end: the real CLI `--help` ran
  through the API (`status: done, exit: 0`, logs streamed back).
- **In-page WhatsApp pairing — QR + 8-char code live in the browser (P2).**
  The Agent Hub → Channels tab now pairs the Baileys bridge without touching a
  terminal: the QR renders as a scannable PNG `<img>` (auto-refreshing as
  WhatsApp rotates it), the `--phone` 8-char code mode streams the code the
  same way, and pair/cancel/unpair are admin/operator-gated
  (`GET/POST /api/whatsapp`, `…/pair`, `…/cancel`, `…/unpair`, `…/events` SSE).
  The bridge gained an AbortSignal path (dashboard cancel ends the socket) and
  a PNG data-URL renderer alongside the terminal QR.
- **Messaging hot-path tests + one real bug fixed.** Telegram long-poll
  (send/inbound/offset), Discord & Slack Bot-token REST sends, and WhatsApp
  Cloud send + inbound `X-Hub-Signature-256` verification (good/tampered/
  challenge) are now covered. The audit surfaced a genuine bug:
  `TelegramAdapter.send()` threw on network errors instead of returning
  `false` like every other adapter — fixed.
- **Project plan** `PROJECT_DASHBOARD_CLI_PARITY.md` tracks P3/P4 (chat
  console, eval runner, skills/marketplace/team/federation surfaces, RBAC
  audit). Suite: 4,331 root tests + 167 dashboard tests, typecheck clean.

## v1.63.1 — Fix: WhatsApp pairing renders a scannable QR again

- **`buff whatsapp pair` prints a real scannable QR.** Baileys 7.0.0-rc14
  removed `qrcode-terminal` and deprecated `printQRInTerminal` (now a silent
  no-op) — pairing previously showed only the raw payload string, so there was
  nothing to scan. The QR is now rendered in the terminal (via `qrcode`) with
  step-by-step instructions; the raw payload moved to `--debug`.
- **New `buff whatsapp pair --phone <number>` — pair with an 8-char code.**
  Uses Baileys `requestPairingCode`: enter the code under WhatsApp → Linked
  devices → Link with phone number instead. Ideal for headless/remote hosts
  where scanning is impossible. Warns when a 10-digit number looks like it's
  missing its country code (e.g. use `918800663237`, not `8800663237`).
- 3 new tests; suite at 4,283 passing.

## v1.63.0 — Messaging campaign: 22-platform multi-channel gateway

- **Multi-channel gateway — 22 platforms.** The
  `buff gateway` surface now covers the full messaging ecosystem: the
  original J1 platforms (Telegram long-poll, Discord/Slack webhooks, WhatsApp
  Cloud API) plus **18 connectors with env-var-compatible credentials** — DingTalk,
  Feishu, WeCom, Mattermost, Matrix, generic Webhook, BlueBubbles (iMessage
  bridge, macOS), ntfy, Microsoft Teams, Google Chat, Weixin (WeChat iLink bot
  API), SMS (Twilio REST), IRC (RFC 1459 over node:net/tls, byte-aware ≤510-byte
  message splitting + markdown strip), SimpleX (local daemon WebSocket), and
  Home Assistant (REST notifications). Every adapter is opt-in via the SAME env
  vars per service (`TWILIO_*`, `IRC_*`, `SIMPLEX_*`, `HASS_*`, `BUFF_*`) —
  credentials configured for those services work unchanged. Pure Node built-ins
  throughout (fetch, node:net/tls, global WebSocket) — zero new SDK deps.
- **WhatsApp personal bridge (Baileys).** `buff whatsapp pair` (QR) pairs your
  own WhatsApp number — no paid API. Two-way: the gateway relays inbound
  messages to the agent and replies back. `whatsapp_cloud` (Meta Cloud API)
  remains the paid opt-in.
- **Guaranteed delivery ledger.** Failed sends are persisted and retried
  automatically while `buff gateway start` runs; `buff gateway delivery` shows
  the queue and `--flush` forces a drain.
- **SimpleX is two-way.** Persistent inbound WS listener — contact-request
  auto-accept (`SIMPLEX_AUTO_ACCEPT`), echo filtering, contact/group
  allowlists (`SIMPLEX_ALLOWED_USERS` / `SIMPLEX_GROUP_ALLOWED`), reconnect
  with backoff — the agent listens AND replies on SimpleX.
- **IRC is two-way too (the heavy protocol).** `IrcAdapter.start()` now runs a
  persistent RFC 1459 listener socket — registration (PASS → NICK → USER →
  001), NickServ IDENTIFY + JOIN, PING/PONG keepalives, 433 nick-collision
  retry, and PRIVMSG relay with exact IRC semantics: self-echo filter,
  CTCP ACTION → `* nick text` (other CTCP dropped), channel messages only
  when addressed (`nick:`/`nick,`/`nick `), `IRC_ALLOWED_USERS`
  case-insensitive allowlist, reconnect with backoff. Send prefers the live
  listener socket (one IRC identity, 0.3s flood guard) with connect-per-send
  fallback. Wire-level walkthrough in `IRC_PROTOCOL_DEEP_DIVE.md`.
- **Dashboard channel send-test.** The Agent Hub Channels tab can send a test
  message through the same gateway the CLI uses (`POST
  /api/admin/hub/channels/send`, admin + `routing.operate` gate), with a 15s
  send bound and env-var hints per platform. `buff gateway status` now shows a
  `X/22 platforms configured` count line.
- **Security hardening across connectors.** CRLF injection rejected pre-connect
  (IRC, SimpleX), socket errors after send are failures (never silent loss),
  Twilio/HA credentials never logged (`describe()` shows only the
  non-secret parts).
- **Tests.** Full connector suites use in-process mock servers (SMTP, IRC,
  fake WebSocket, fetch spies) — no network. Full suite: **4,280 tests across
  180 files** (was 4,031).
- **Docs.** gateway integration plan (I1–I16 pillars + deferred
  heavy-bridge assessment), import design doc, `ASSESSMENT_WEBSITE_DEPLOY.md`;
  User Manual gateway section updated; website updated to v1.63.0 / 4,280 tests.

## v1.62.5 — Reviewer rate-limit recovery: eval 429s are waited out, not fatal

- **Root cause fixed (eval interference).** The reviewer's retry loop used a
  fixed 1s/2s backoff and never invoked `context.onRateLimit` — so a transient
  429 with an 18s reset hint (e.g. Groq TPM) fired all 3 attempts inside the
  reset window and the review died, killing the task. Observed: 6/9 eval tasks
  failed with "Provider interference" and the reviewer errored on an 18.165s
  reset. The reviewer now mirrors the writer/context-gatherer: long reset
  hints (>= 3s) delegate to the orchestrator's `onRateLimit` handler (decision
  #26 — silent wait for transient, silent auto-switch for exhaustion/storms,
  dashboard failover events), short hints use the hint-aware delay, and
  switch-model/skip/abort are honored. The pipeline now waits out transient
  quota blips instead of failing on them.
- **Shared retry helpers.** New `src/agents/rate-limit-retry.ts`
  (`isRateLimitError`, `calculateRetryDelay`, `parseModelName`,
  `parseRetryAfterHint`, base/threshold constants) — writer and
  context-gatherer were refactored onto it, removing their duplicated local
  copies (single source of truth, no drift).
- **Tests.** 3 new reviewer tests (wait-then-retry with fake timers verifying
  the full 18.2s hint is honored, switch-model uses the handler's LLM, abort
  path) — 168/168 files pass. Live smoke eval on groq: 100% completion, 100%
  test pass, 0 provider interference.
- **Decision #29** — "Transient quota blips must never fail a task" — full
  analysis of the eval 429 failure and the fix.

## v1.62.4 — Deliverable match check + domain reference docs + NVDA eval task

- **Deliverable match check (fixes the wrong-file success bug).** `TaskStep` gains
  `expectedFiles`; the planner now declares the exact files each writer step must
  produce, and the orchestrator **fails a writer step that claims success without
  producing its declared files** (checked before the result is recorded, so a step
  that wrote `globalPlugins/hello_anuj.py` while reporting "Create manifest.ini"
  can no longer mark itself ✅ — the exact false-success from the live NVDA run).
- **Domain reference-docs injection (fixes hallucinated APIs).** New
  `src/agents/reference-docs.ts` injects curated, verified API snippets into the
  writer prompt when the task targets a known domain — NVDA addons first
  (`globalPluginHandler` / `scriptHandler` / `addonHandler` / `ui.message`,
  `kb:NVDA+alt+1`), keyword-matched so ordinary tasks are untouched. The live run's
  `nvda.register_key_handler` hallucination is now blocked at prompt level.
- **NVDA addon eval task (`py-nvda-addon`).** New eval-framework task whose hidden
  test checks the real addon contract (manifest + `globalPlugins/*.py` with the
  NVDA+alt+1 script) and whose `referencePatterns` reject the hallucinated API
  surface — so this failure class is now caught in the eval suite, not just on a
  user's machine.
- **Decision #28** — "Where the pipeline loses to interactive execution" — a full
  comparison of agent-nuvira's stage-by-stage pipeline vs. tool-driven interactive
  execution, with seven concrete efficiency wins (parallel step fan-out, tool-based
  context gathering, structured writer output, latency-based provider failover,
  toolchain pre-flight for the runner, deterministic-first review, reference docs).

## v1.62.2 — Fix: rate-limit recovery is fully automatic (no more prompts, no more grinding)

- **Automatic recovery by default:** the orchestrator's rate-limit handler no longer
  interrupts the user. Transient hits (short reset hints, e.g. "try again in 16.5s") are
  silently waited out and retried; exhaustion (long hints, e.g. "resets in 17h 51m" —
  daily-quota caps) and storms (2+ consecutive hits in one task) silently auto-switch to
  the router's next healthy provider mid-task. The pipeline keeps building on whichever
  provider is healthy — the exact failure the user hit (gemini 503 → writer retried gemini
  3× and died, never failing over to the available groq) can no longer surface as an error.
- **Interactive prompt is now opt-in** (`routing.askOnRateLimit: true` in .buffconfig.json)
  and only ever appears on a real TTY. Non-interactive runs (CI, pipes) get the same
  silent auto-switch + auto-wait instead of grinding the same exhausted provider.
- **Threshold:** a reset hint over 60s counts as exhausted (provider is down for a while →
  switch); under 60s is transient (waiting is cheaper than switching).
- **Honest "consecutive" storm semantics:** the streak counter resets after each successful
  auto-switch (the new provider starts fresh — one transient hit after 10 successes is NOT
  a storm) and strikes more than 5 minutes apart are treated as a fresh incident, not a
  continuation (a long healthy run between them means the provider recovered).
- **Auto-mode bound-provider seed:** the storm guard never "switches" to the provider the
  agent is already on — in auto mode the task's routed provider is seeded into the
  tried-providers set, so a fresh decision that re-picks the just-rate-limited provider
  (registry park lag) is skipped in favor of the next healthy ranked provider.
- **No ping-pong / no model leak:** per-task `triedProviders` set prevents bouncing between
  two exhausted providers; the auto-switch target resolves its own best verified model
  (`model: 'default'` no-pin sentinel) so a gemini model ID can never be sent to groq.
- **Tests:** orchestrator suite updated for the silent default + new paths (first-hit
  exhausted auto-switch, non-TTY silent retry, opt-in prompt, counter reset, time-window,
  auto-mode bound-provider seed) — 168/168 files pass.

## v1.62.3 — Dashboard Failover Timeline shows auto-switches + decision #27

- **Auto-switches are now visible on the dashboard.** Every rate-limit auto-switch the
  orchestrator makes (storm or exhaustion) writes a `failover` event to the quota
  timeline (`quota-events.jsonl`) with the reason ("rate-limited 2x" / "exhausted"), so
  the dashboard's 🛟 **Failover Timeline** card shows mid-task provider swaps live — same
  store the CLI `model quota` last-20 and the audit chain read. Verified in the live
  NVDA-addon run: the "auto-switched to local" / "auto-switched to groq" events now land
  in the timeline instead of only the event bus.
- **Decision #27** — `routing.askOnRateLimit: true` documented as the explicit opt-in
  for the legacy interactive rate-limit prompt (TTY only), with the revised-auto
  rationale (default = fully automatic; opt-in for operators who want to intervene).
- **Tests:** new orchestrator regression — an auto-switch records `failover` on the
  quota ledger (82/82 orchestrator, 168/168 files).

## v1.62.1 — Fix: rate-limit no longer permanently kills cloud models

- **Registry (model-registry.ts):** a `rate-limit` failure now PARKS an entry without
  demoting it to `unavailable` (auth still demotes). Previously a 429 flipped `verified →
  unavailable`, and since `isUsable()` requires `verified`, rate-limited cloud models never
  auto-recovered — the router silently forced every agent onto the weak local model after
  one quota burst (the "chat fast, execute slow+wrong" symptom). Verified models now return
  automatically when the park window lapses.
- **Recovery path:** `markVerified` clears registry parks on real success; `syncQuota` only
  re-applies live ledger parks. Manual escape hatch unchanged: `buff models unblock <provider>`
  (release + re-probe) and `buff models refresh <provider>`.
- **Tests:** updated 8 files encoding the old demotion semantics; added a regression test
  proving a verified model is parked but auto-recovers after the window.
- **Docs:** decision #23 in DESIGN_DECISIONS.md (park, never demote).
- **Fix 2 — park for the provider's ACTUAL reset time:** a 429 that says "try again in
  16.5s" / `Retry-After: N` / `x-ratelimit-reset-*` now parks for ~that long (floored 10s,
  capped by the configured `routing.quota.<provider>.windowMs`) instead of the 24h default —
  so a per-minute/token-window quota burst re-admits the provider the moment it lifts, with
  zero manual intervention. New shared `parseRetryAfterHint`/`extractRetryAfterMs` in
  `provider-fallback.ts` (replaces 3 duplicated copies in writer/context-gatherer/edit-module).
- **Fix 3 — rate-limit STORM auto-switch (the "gemini 503 → writer died" failure):** when
  an agent hits 2+ consecutive rate limits within one task, the orchestrator now stops
  prompting and AUTO-SWITCHES to the router's next healthy provider mid-task (fresh
  auto-routing decision; pinned mode excludes the bound provider; auto mode trusts the
  fresh winner, which the hint-aware park already moved off the rate-limited provider).
  The switch uses `model: 'default'` so the new provider resolves its own best VERIFIED
  model — never leaking the rate-limited provider's model ID (a gemini ID on groq = 404).
  Falls back to the interactive prompt only when no healthy alternative exists. A per-task
  `triedProviders` set prevents ping-ponging between two exhausted providers (their short
  hint-aware parks can lapse mid-task).
  Both the quota-ledger park and the registry floor honor the hint.
- **Fix 3 — cross-provider failover for agent LLM calls ("why didn't it take another
  model?"):** the orchestrator's auto-routed LLM now walks the router's next-ranked
  candidates on a retryable failure (503 high-demand / 429 / network) instead of
  exhausting the repair budget on one provider. Auth never fails over; a user-pinned
  provider is honored as-is. A live agent-update event shows "⚠️ gemini server — failing
  over to groq" on the board. Each failed provider×model still records exactly once via
  the shared telemetry path.
- **Fix 4 — adapter errors now carry their HTTP context:** new `attachHttpContext`
  attaches status + headers (Retry-After, x-ratelimit-reset-*) to errors from ALL
  adapters (groq, gemini, anthropic, nim, ollama, openai-compat, tools), so even a
  body-less 429 parks for the provider's actual reset time.
- **Fix 5 — Gemini model IDs:** the pinned `gemini-2.0-flash-exp` (retired for new
  accounts) is replaced with `gemini-flash-latest` (verified live); catalog updated to
  2026 model IDs. Config also set `routing.quota.{groq,gemini}.windowMs = 4h` so a
  hint-less 429 parks 4h max instead of 24h.

## v1.62.0 — Revamp complete — reliability stack, code-map, scheduled jobs, gateway

- **Major revamp complete** — all 30 rows of the capability parity program are landed (AGENT_NUVIRA_MAJOR_REVAMP_PLAN)
- **Reliability stack** — writer surfaces unparseable output instead of masking it (repair escalates the model), reviewer-blocked verdicts route through a writer fix pass, weak-local-model pre-flight warning before long runs
- **New `buff code-map`** — project symbol map (functions/classes/methods) via the AST engine; closes the last revamp row; AST dedupe fix recovered silently-dropped top-level functions
- **Scheduled jobs** — `buff admin cron add/list/remove/run` with schema-validated args, RBAC-gated writes, channel delivery
- **Multi-channel gateway** — Telegram / Discord / Slack / WhatsApp via `buff gateway`
- **Web tools + modality packs** — `web_search`/`read_page` (SSRF-guarded) plus browser / image / voice / vision tools
- **Structured logging (K1) + runtime metrics (K2)** — JSON logs with correlation IDs; `buff doctor --enterprise` runtime metrics
- **Session recall** — chat auto-recalls per-project sessions and facts
- **4,031 tests passing across 167 files**

### Session 47 — post-revamp followups + last revamp row
- feat: NEW buff code-map [dir] [--json] — project symbol map (functions/classes/methods with 1-based lines) via the AST engine; closes revamp row 11 (engine-agnostic; web-tree-sitter remains the upgrade follow-up)
- fix: editing/ast.ts — duplicate pattern matches for the same declaration (explicit "function name(" + generic "name(") produced equal-end nodes that the nesting filter dropped BOTH of; top-level functions silently vanished from the structure map (pre-existing bug that also affected the edit pipeline). Same-end nodes are now excluded from nesting + deduped, and JS/TS function patterns accept an export prefix.
- fix: writer buildPrompt now surfaces a ## Goal section when context.goal differs from the step description — repair/fix-pass/alternative-approach context in the goal previously never reached the LLM (caught by the new E2E)
- fix: edit-module empty-parse parity — a genuine "no changes needed" decline is a clean no-op; a format failure keeps the parseable warning
- test: NEW tests/integration/reliability-fixes.test.ts — real Orchestrator + scripted fake LLM E2E (writer parse-failure repair recovery, loud failure, reviewer-blocked fix pass); NEW tests/cli/code-map.test.ts (3)
### Session 46 — NVDA-run reliability fixes (post-revamp)
- fix: writer no longer masks unparseable LLM output as "No files needed changes" — a genuine "no changes needed" decline stays a no-op, but a format failure (no filepath: code blocks) now FAILS the task so the repair engine escalates the model instead of silently skipping the real work (was: masked success → incomplete deliverable → reviewer loop)
- fix: reviewer "blocked" verdicts now route through a WRITER fix pass (writer applies the reviewer feedback, then the reviewer re-verifies) instead of re-running the reviewer on unchanged code until the repair budget dies
- feat: weak-local-model pre-flight warning — when auto-routing lands on a LOCAL model scoring < 0.5 (no verified cloud provider available), warn before the pipeline burns minutes on a model likely to fail complex tasks
- test: writer parse-failure surfacing (4) · orchestrator reviewer fix-pass (2) · weak-model gate (2) · updated writer-prompt suite to the new contract

### Session 45b — K1 structured logging + K2 runtime metrics (last revamp rows)
- **Structured logging (K1)** — `BUFF_LOG_JSON=1` now emits one machine-readable JSON object per log line (level/time/msg + correlation IDs), with secrets redacted BEFORE serialization. Every chat session carries ONE `sessionId`; every pipeline run carries a `runId`; every agent execution carries a `taskId` — so `buff chat` → pipeline → agent logs are correlateable end-to-end, without any parameter plumbing (AsyncLocalStorage carrier in `src/enterprise/log.ts`).
- **Runtime metrics (K2)** — dependency-free counters + latency timers persisted to `~/.buff/memory/metrics.json`: memory hits/misses, and the C1 rule-vs-LLM latency budget (`rule.parse.ms` / `rule.dispatch.ms` / `llm.answer.ms`). `buff doctor --enterprise` now surfaces a **Runtime Metrics (K2)** check. These are the last two rows of the major revamp — **all 30 rows are now Done/Baseline/skipped-by-design**.

### Session 45 — Honest stuck-scoring + plan sweep + key hygiene
- **Stuck states now exclude provider interference** — a task whose terminal failure is rate-limit / server / network (e.g. a free-tier 429 that opened the circuit breaker) is reported on a separate `Provider interference` line instead of inflating the user-visible stuck count. The S44 run re-analyzes from **5 stuck → 0 stuck, 6 interference** (all 429s, attempts=1 — the pipeline never got a chance to work). Persisted runs saved earlier re-analyze correctly, and auth/timeout failures remain genuinely stuck. `buff eval run` / `results --compare` both use the corrected counts.
- **Full-plan sweep** — the revamp plan is complete except two rows now actionable (K1 structured logging, K2 latency metrics); M3 (zod) confirmed landed inside the H1 registry.
- **Key hygiene** — `~/.buff/.env` carries real GROQ/GEMINI keys but placeholder `new-key` / `openrouter-env-key` values for NIM and OpenRouter. Replace those two lines with real keys (`NVIDIA_NIM_API_KEY=...`, `OPENROUTER_API_KEY=...`) to unlock both providers; `buff doctor` and `buff models refresh` then pick them up. Note: the configured `gemini-2.0-flash-exp` model and catalog `gemini-2.5-flash` both return 404 on this account — switch to a model `buff models list` shows as served, or use the auto router.

### Session 44 — M2b experience-parity re-run (final revamp item)
- **Post-revamp benchmark run** — `buff eval run --suite m2b --provider groq --budget 0.05` (9 tasks, $0.008, 110.7s). The instrumented `buff eval results --compare` gate shows a **win on every experience axis vs the immediately-prior run**: composite 47.2% vs 26.9%, test-pass 44% (4/9) vs 11% (1/9), completion 22% vs 0%, stuck 5 vs 8, rework 32 vs 36.
- **Honest caveats** — the composite sits below the Session 31 peak (72.2%) within the documented ±17pt free-tier Groq noise floor, and this run hit 2 circuit-breaker cooldowns (120s each) — a post-baseline failure mode that scores recoverable rate-limit pauses as "stuck". The revamp did not regress; absolute movement past noise requires a stable provider run.

### Session 43 — I2–I5 modality packs (browser / image / voice / vision)
- **New `src/tools/modality/` family** — four capability packs, every backend OPTIONAL and availability-gated (availability-gated registry pattern): `browser` (Playwright optional via `require.resolve`, SSRF guard reusing web-research's `isAllowedReadUrl`), `generate_image` (Pollinations.ai free endpoint default, local SD/ComfyUI via `BUFF_IMAGE_API_URL`), `speak`/`transcribe` (edge-tts + Piper stdin fallback; whisper.cpp/whisper-cli with transcript file read-back), `describe_image` (Ollama llava/llama3.2-vision or Gemini via the existing model router). All four registered in the H1 tool registry with availability-gated `run()` — a missing backend returns a clear "install … then retry" message, never throws. Artifacts land in `<cwd>/.buff/artifacts/<kind>` (`BUFF_ARTIFACTS_DIR` overrides).
- **Code-search race fix** — the ripgrep engine could parse pipe-buffered matches after truncating (async `kill()`), making `maxResults` flaky; the stdout handler now bails once truncated/timed-out.
- **Validation**: tsc clean · full suite 163/163 files (+modality tests) · build OK · `buff tools list` shows the new tools.

### Session 42 — J1 Multi-channel gateway
- **`buff gateway start / send / status / alias`** — talk to the agent from Telegram, Discord, Slack, or WhatsApp (multi-channel gateway surface). Dependency-free adapters (pure fetch — deliberately no grammY/discord.js/@slack/web-api SDKs): Telegram long-poll `getUpdates`, Discord/Slack incoming-webhook send, WhatsApp Meta Cloud API; all opt-in via env bot tokens.
- **`GatewayRegistry`** — inbound message → `parseRequestSync` (C3) → the SAME shared `runPipelineTool` core as `buff chat`/`execute` → reply to the originating channel; every ORCHESTRATOR/EXEC/CRON board event streams as a compact channel status line. Pipeline runs serialize so events route to the right channel.
- **Channel directory + aliases** — a channel-directory pattern: `buff gateway alias add ops slack C0123`, persisted to `~/.buff/gateway/aliases.json`, `platform:channelId` targets supported.
- **Security**: webhook receiver binds 127.0.0.1 by default (`--host 0.0.0.0` for a tunnel); Slack `X-Slack-Signature` (HMAC v0) + WhatsApp `X-Hub-Signature-256` verified when secrets configured; **pipeline triggers gated by `BUFF_GATEWAY_ALLOW_IDS`** (platform:channelId allow-list); alias writes RBAC-gated on `gateway.manage`.
- **Cron delivery**: `buff admin cron add … --channel <alias>` → job results forwarded to the channel after each run (best-effort — never fails the run).
- **Validation**: tsc clean · full suite 162/162 files (+19 tests) · build OK · live smoke.

### Session 41 — M1 Integration tests + M4 CI matrix
- **`tests/integration/` (M1)** — the three foundation systems pass as ONE hermetic unit: one temp `BUFF_CONFIG_DIR` + `BUFF_MEMORY_DIR` harness drives the REAL Vault (aes-file set→get round-trip surviving fresh instances), WorkspaceStore (recordRun → reload), and FactStore (addFact → reload) — plus a "secret never on disk in plaintext" check. A second file runs a REAL `Orchestrator.execute()` against a nonexistent local model (fast-fail, zero network) and proves the best-effort workspace `recordRun` fires even when the pipeline FAILS (❌ row) and that a second run upserts the same project row.
- **CI matrix (M4)** — `test-linux.yml` extended in place (no new pipeline file): Node 22/24/26 × ubuntu/macos + a new `bun` job (committed `bun.lock`, `bunx tsc --noEmit`, `bun run build`, `bunx vitest run`).
- **Validation**: tsc clean · full suite 160/160 files (+2 integration files) · build OK · integration suite passes under both Node and Bun.

### Session 40 — J2 Scheduled jobs (cron)
- **`buff admin cron add / list / remove / run`** — scheduled tool invocations (scheduled job runner): 5-field node-cron validation, `--dry-run` (validate + next run WITHOUT executing), persisted jobs in `~/.buff/cron/jobs.json`, `run <name>` invokes the H1 registry tool now (fresh ConfigManager — pipeline tools need one) and emits `cron:run/result/error` events for the future gateway/dashboard.
- **Safety**: job names sandboxed (`^[a-z0-9][a-z0-9-]{0,49}$`), **`--args` validated against the tool's zod schema at add time** (a typo surfaces immediately, not at 3am), all writes RBAC-gated on the new `cron.manage` action (admin + operator).
- **Validation**: tsc clean · full suite 158/158 files (+11 tests) · isolated-HOME live smoke.

### Session 39 — J3 Skills hub + sync (capability gap #10)
- **`buff skills search / install / update / list`** — community skills discovered from a configurable registry (default GitHub raw; `BUFF_SKILLS_REGISTRY` can point at a local dir for offline use) and installed into `<project>/.agents/skills/` — a community skill-registry pattern. Distinct from `buff skill` (singular), which manages internal trajectory-compiled skills.
- **Trust + safety**: sandboxed install names (`^[a-z0-9-]+$`), frontmatter `name:` cross-checked against the registry entry, SHA-256 provenance recorded in `~/.buff/skills-hub/provenance.json`, mismatched reinstall content quarantined; `buff skills update` is version-gated (never downgrades, never clobbers local edits) and RBAC-gated on `skill.remove` like `skill gc`/`clear`.
- **Validation**: tsc clean · full suite 157/157 files (+19 tests) · local-dir registry tests, no network.

### Session 38 — I1 Web research tools (capability gap #3)
- **`web_search` / `read_page` tools** — the model can now search the web (DuckDuckGo free tier by default, SearXNG opt-in) and read a page's text (Jina Reader free tier or a plain fetch) to ground its answers — a standard web-research pattern. Registered in the H1 tool registry + the safe MCP surface; `buff tools list` shows them under 🧰 Workflow.
- **SSRF guard** — `read_page` only fetches public http(s): loopback/link-local/private/metadata hosts blocked unless `BUFF_WEB_ALLOW_PRIVATE=1`; DDG redirect URLs decoded to real targets.
- **Validation**: tsc clean · full suite 156/156 files (+17 tests) · mocked-fetch tests, no network.

### Session 37 — Eval `--pace` (Decision 21's gate fix)
- **`buff eval run --pace`** stops the suite BEFORE a task would cross the user-declared daily token budget (`routing.quota.<provider>.tokensPerWindow`), so free-tier TPD exhaustion can't invalidate an M2b measurement mid-run. Resolves the budget from the config + today's quota-ledger consumption (`resolvePaceBudget`); warns when `--pace` is set but no budget is declared; works in both direct-provider and `--routing` modes alongside the existing `--budget` (USD) gate.
- **`EvalMetrics.totalTokens`** — per-task input+output token total powers the cumulative pacing check.
- **Validation**: full suite **3,908/3,908** (+6 tests) · tsc clean · live smoke (500-token cap, 84K used → stopped before task 1).

### K4 — RBAC enforcement (Session 34)
- **Enforcement everywhere**: the RBAC engine previously only gated `buff admin`. K4 adds `credential.write`/`team.manage`/`sbom.write`/`skill.remove` to the action matrix and wires a shared `guardRbacAction()` helper into every sensitive surface: `buff team` mutations (init/join/sync/share + all review actions), `buff skill gc` real removal + `buff skill clear` (dry-run stays open), `buff sbom --out`, and `buff config vault migrate`. Denied → clear message + exit code 3; legacy single-user mode remains fully permissive.
- **Single enforcement path**: `buff admin`'s private guard now delegates to the shared helper.
- **New**: `src/cli/rbac-guard.ts` + `tests/cli/rbac-guard.test.ts` (13 tests).

### M2b gate re-run + noise-floor verdict (Session 35)
- **Gate ran, verdict: measurement-integrity.** Post-K3/K4 re-run scored 26.9% composite vs the 72.2% baseline — but with **12 tokens-per-DAY 429s and 0 TPM events**: free-tier Groq's daily budget was exhausted mid-run (cost $0.0018, 8/9 tasks starved of any model response). NOT a regression — the gate's anti-coverup job.
- **Noise floor widened to ~±45pt** (72.2% / 55.0% / 26.9% across identical setups) — TPD exhaustion dominates. The Part 1.9 gate must run on a paid tier or with per-task pacing; documented in the benchmark INDEX + plan.
- **RBAC user docs**: Product_Guide v1.61.1 row + User_Manual section (enforcement everywhere, vault audit, eval compare). Dashboard parity confirmed automatic (same `roleCan` matrix).

### User-declared daily token budget (Session 36, Design Decision 21)
- **Your plan, your say** — free-tier TPD caps are invisible to us, so the USER declares their budget: `buff model quota set <provider> --tokens N --requests N --window-ms N --cost-usd N` (CLI) + a dashboard **💰 Daily Budget** panel (Admin) editing the SAME `routing.quota.*` + `governance.maxCostUsd` config. Advisory + pacing, never a product hard cap: unset = current behavior, set = the quota ledger parks the provider at the cap and auto-resumes at window rollover.
- **Backend enforcement is real** — `getRouterQuotaStatus()` derives configured-limit exhaustion and feeds the auto-router before every pick; rate-limited providers park for the declared window.
- **Fixed a latent merge bug** — ConfigManager.save shallow-merges `routing`; quota setters (CLI + `config set routing.quota.*`) now save the full merged map so sibling providers' limits are never wiped.
- **RBAC-aware** — budget fields gate `routing.operate` (admin+operator), the cost cap gates `policy.write` (admin); viewer read-only. 3,899 tests.
- **Update as and when** — `ConfigManager` live-re-reads on file change: a running chat/execute/dashboard honors a limit change from `buff model quota set` or the Daily Budget panel immediately, no restart (verified on a live instance). `save()` refreshes before merging so concurrent CLI ↔ dashboard edits never clobber each other; a partial concurrent write keeps the last good config. 3,902 tests.

### G1–G3 — Observability, dashboard & docs surfacing
- **`buff session`** (new): `list` (project + temporal filter via `--since`), `summarize <id>`, `resume` — the explicit debug surface over D1 auto-recall (a bare `continue` remains the primary path).
- **`buff doctor`** now reports a **Fact Memory** section (facts per project, B1) alongside the existing vault / workspace checks.
- **Privacy (P6 M6.2):** chat session writes (`history.json` + the semantic vector index) are now **redacted** — API keys / Bearer tokens / key=value secrets are masked before persisting; the caller's message array is never mutated.
- **Dashboard memory panel:** Facts, recall hits (total / today / this week, per project), and the backend tier are now surfaced; recall hits come from a deduped JSONL counter at the shared auto-recall choke point.

### H1 follow-up — Agent-Nuvira as an MCP server
- **`buff mcp serve`** exposes the agent's H1 tools as an MCP **server** over stdio (MCP clients / IDEs / other agents can connect). Safe surface by explicit allowlist: pipeline tools (`build` / `resume` / `repair` / `document` / `website` / `analyze` / `test`) + `code_search`; loop-internal / LLM-dependent / irreversible tools (`ask_user`, `suggest_followups`, `verify_requirement`, `delegate`, `publish`) are **excluded by default** — opt in explicitly with `--with <tools>`. Runs are headless (`board: false`), errors map to MCP `isError` results, and pre-connect output routes to stderr so the protocol owns stdout cleanly.

### M2b — Experience-parity baseline + stuck/rework breakdown
- **First real M2b baseline** (`buff eval run --suite m2b`, auto-routed to `groq/llama-3.3-70b-versatile`): 9/9 tasks in 142s for **$0.02** — composite **72.2%**, test-pass **78% (7/9)**, avg time-to-fix **9.9s**, 0 rollbacks. Report: `docs/benchmarks/m2b-groq-llama-3.3-70b-versatile.md`.
- **Stuck / rework breakdown** — the benchmark spec promised these axes; now actually measured and rendered: `computeReworkTurns()` (repairs + alternative approaches + rollbacks — NOT llmCalls, which the multi-agent pipeline makes ~4-5 of by design) and `computeStuckStates()` (crash/timeout, or 3+ rework turns, with **no working outcome**) drive new columns + an **Experience Parity** section in eval reports. Baseline: **15 rework turns (1.7/task), 2 stuck states** — Groq free-tier TPM 429 rate-limits hit 3 tasks; 2 recovered to correct code (interference, not stuckness), 1 failed.
- **Test-isolation fix** — eval-framework tests now run against a temp homedir (`vi.mock('node:os')` + hoisted temp dir); previously `afterEach(clearEvals)` wiped the real `~/.buff/memory/evals.json`.
- **`buff eval results --compare`** — one-command Part 1.9 gate: diffs two runs across the M2b axes (composite / test-pass / completion higher-better; stuck / rework / time-to-done / avg-fix / cost lower-better) with per-axis winner arrows. `selectCompareRuns()` compares against the most recent **same provider+model** run so a model switch never confounds the gate. A second identical-setup run quantified the free-tier Groq noise floor at ~±17 composite points (17 TPM 429s — 55.0% vs 72.2%) — phase-gating movement must exceed that band.

### K3 — Vault access auditing
- **Vault access log** — every credential read/write/delete is now recorded as a hash-chained, secret-scrubbed record in `~/.buff/memory/vault-access.jsonl` (**account names only, never values**). View with `buff config vault log [--limit N]`; verify integrity with `buff audit verify` / `buff doctor --enterprise`. Rotation keeps the store bounded (~5k–10k lines) with the chain re-chained intact.
- **`buff audit verify` fix** — builtin chain ids now carry the `.jsonl` extension, so `buff audit verify` verifies the REAL stores (quota-events 200 records, model-registry 2,408 records — previously every builtin silently reported as an empty bogus "legacy" chain).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.61.1] - 2026-08-08

### Added

- **`buff eval run` (non-routing) refuses placeholder-keyed providers** — if the resolved provider's configured API key is a sentinel/placeholder (e.g. the literal `openrouter-env-key`), eval aborts with a clear error instead of burning minutes producing auth-dead scores (the "consistent 25%" failure mode reported on the dev machine). Guidance points to `buff config set providers.X.apiKey <real-key>` or `defaultProvider auto`. `defaultProvider auto` already resolves through `rankAvailableProviders` (registry-verified first), so `buff eval run` now measures the best available provider, and `buff eval run --routing` measures the router's exact per-task picks.

### Changed

- **Eval guard also warns (not just aborts) when an explicit `--model` is passed with a placeholder-keyed provider** — a model override can't fix a dead key.

### Fixed

- **Hermetic test isolation** — `eval`, `orchestrator`, `injection-guardrail`, and `a2a` tests no longer depend on the dev machine's `buffconfig.json`; they pin temp `BUFF_CONFIG_DIR`s so local-model availability on the host can't flip pass/fail (the `llama2` → `gemma4:e4b` config change exposed this).

---

## [1.61.0] - 2026-08-08

### Added

- **Dynamic provider catalog (Issue 001) — ALL 17+ configured providers join routing.** A new `src/inference/provider-catalog.ts` is the single source of truth for 21 providers (id, label, env var, base URL, OpenAI-compat flag, keyless flag, api-key header, api-version query, capability profile, list pricing, context window). Routing/probing/CLI discovery are now derived at runtime from the user's credentials instead of hardcoded built-ins:
  - `ConfigManager` maps EVERY catalog env var (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `DEEPINFRA_TOKEN`, `REPLICATE_API_TOKEN`, ...) into config, and keyless catalog providers (local, nuvira, lmstudio, vllm) count as configured (reachability probed).
  - `rankAvailableProviders` + the auto-router's `getDefaultAllowedProviders` consider every catalog provider with real credentials (registry-block-aware), falling back to the built-ins only when nothing is configured — a user who sets `OPENAI_API_KEY` now sees OpenAI scored and routed to.
  - Capability profiles, list pricing, and context windows fall back to the catalog for extended providers (real metadata, never a neutral guess).
  - `OpenAICompatAdapter` (generalized from NuviraAdapter) serves every OpenAI-compatible catalog provider via metadata — baseUrl, `api-key` header + api-version query for Azure, etc.; `AnthropicAdapter` serves Anthropic's native Messages API (streaming + measured usage).
  - `buff models refresh` probes every configured provider; `buff provider list/health`, `buff models`, `buff doctor`, and the model picker list the full catalog with real env-var hints.

- **ISSUE-002 — the router now leverages the data it already gathers.** Auto routing decisions are driven by (and cite) the registry's real telemetry:
  - **Registry pre-filter strength**: a provider with ZERO verified models AND ≥3 unavailable entries is DEGRADED — excluded from candidates even when credentials exist, so a dead provider (0 verified, N unavailable) can never win a task it would fail (`ModelRegistry.getDegradedProviders` + `getProviderStats`).
  - **Bandit learning ON by default**: `routing.bandit` now defaults to enabled (opt out with `buff config set routing.bandit false`) in chat, the orchestrator, and outcome recording — the Thompson-sampling bandit actually improves routing from real results instead of collecting dust. Cold start is DETERMINISTIC (untouched Beta(1,1) priors sample the mean), so enabling it never randomizes an unlearned ranking — it only shifts routing once real outcomes accumulate.
  - **Context-window transparency**: scored providers now carry a `contextWindowSource` ('live' | 'override' | 'provider' | 'default'); estimate/default windows are flagged in the reason and preflight snapshot, so "no advertised spec" is never silently treated like a real one.
  - **Explanation transparency**: the decision explanation cites the registry counts that excluded a provider (e.g. `excluded: openrouter (0 verified models, 9 unavailable)`) via the new `registryExcluded` audit field — users can see the gathered data is driving every auto decision.

- **ISSUE-004 — invalid API keys are deleted and stale local models are purged (config hygiene).**
  - **Key auto-clear after N consecutive 401/403s**: a new `KeyHygiene` store counts consecutive auth failures per provider (`AUTH_CLEAR_THRESHOLD = 3`, persisted across restarts). At the threshold `ConfigManager.clearProviderApiKey(provider, failedKey)` removes the SPECIFIC dead credential — the primary `apiKey` or a matching `apiKeys[]` rotation entry — and the user sees `🚫 ... the invalid API key has been CLEARED ... buff config set providers.X.apiKey <real-key>`. Env-sourced keys (value equals the catalog env var) are NOT cleared from the file — the user is told to unset/fix the env var instead. The counter resets only when the key was actually handled (a throwing clear retries on the next failure); a real success also resets it so one blip never clears a valid key. Hooked into the single `recordActionFailure` auth path (covers chat/execute/plan/edit/failover) + `recordRegistrySuccess`.
  - **Stale local-model purge**: `ModelRegistry.pruneAbsentModels` removes entries for models the user deleted from the local system (e.g. `ollama rm`) — unverified/unavailable entries deleted, verified entries demoted to `unavailable` ("model deleted from local system") so a partial `listModels()` response never destroys learned telemetry. Wired into `buff models refresh` for KEYLESS runners only (local/nuvira/lmstudio/vllm — authoritative lists). Keyed providers are never pruned (remote catalogs can legitimately drop models). `RefreshResult.prunedLocal` + the refresh summary report the removed count.
  - **Dashboard surfacing**: `/api/model-registry` now carries `keyHygiene` (per-provider consecutive 401/403 counters + the auto-clear threshold) and `deletedLocal` (verified models demoted because they were removed from the machine). The Models panel shows a 🧹 **Key hygiene in progress** strip warning before the threshold and a 🗑️ **Deleted locally** stat card — the cleanup the router performs is visible, not silent.

- **ISSUE-003 — the router's full feature set now fires at EVERY action point, not just chat.** A single shared `buildAutoResolveOptions` helper assembles the complete option set chat + the orchestrator pass (bandit learning ON by default, quota-ledger status, runtime stats, cost/speed/reasoning floors, paid-model gate) and every other entry point routes through it:
  - `buff plan` — the route callback now resolves with the FULL feature set (previously only the context-hint token estimate), so a plan's ranked failover walk is driven by the same learned, quota-aware, registry-filtered ranking as chat.
  - `buff eval --routing` / `buff benchmark` / `buff model explain` — scored picks now run through bandit + quota + floors + paid gate instead of a bare runtime-stats resolve, so the measured quality reflects the real production routing path.
  - `buff edit` — NEW `--auto-route` flag (or `--provider auto` / `--model auto`) drives the edit through the shared ranked walk (`runSingleShotAuto`): auto-router primary pick, ranked failover for ALL failure classes, key rotation, session exclusion, and per-action 'edit' registry attribution. The legacy explicit-provider path is unchanged.

### Changed

- `ProviderFactory` resolves all 21 catalog ids (dedicated adapters for the built-ins, generic/native adapters for the extended set).
- NuviraAdapter is now a thin subclass of OpenAICompatAdapter (behavior contract unchanged).
- **Cold-start guard (review fix):** keyless runners BEYOND `local` (nuvira, lmstudio, vllm) only join the ROUTING candidate pool once the registry verifies them or the user configures them explicitly — a not-running localhost endpoint can never out-rank a running Ollama on a fresh machine. `buff models refresh` still probes the full configured set.
- **Azure OpenAI works out of the box (review fix):** `AZURE_OPENAI_ENDPOINT` maps into `providers.azure.baseUrl`, and the generic adapter builds the real Azure shape (`/openai/deployments/{model}/chat/completions?api-version=…`, `api-key` header, `/openai/models`).
- **CLI probe fast-path (review fix):** `buff models` and the model picker skip network availability probes for providers with no configured key (and not keyless) — no more waiting on 16 dead endpoints.

## [1.60.4] - 2026-08-07

### Added

- **Per-task repair model escalation** — the same stronger-model escalation that fixes planner failures now applies to EVERY failing agent (writer, debugger, security, tester, reviewer...). When a task fails under auto routing, the repair engine is handed a re-routed LLM at the NEXT complexity level instead of re-prompting the same weak model that just failed. The escalation climbs from the task's ROUTED complexity (captured per task id, including any escalation the router already applied) so the repair is always strictly above the tier that failed.

### Changed

- `createEscalatedLLM` is now the single shared escalation primitive (planner + per-task repair), carrying the stronger decision's routing snapshot into the reasoning trace.

## [1.60.3] - 2026-08-07

### Added

- **P0 reasoning traces** — every LLM call in a pipeline (planner, memory, per-task, repair escalation) records `{agentType, provider×model, prompt digest, response preview, tokens, latency, routing snapshot}` to a per-run trace file. New `buff trace list/show/replay/clear` CLI plus a dashboard 🔍 Reasoning Traces panel — the full per-step provenance needed to debug "why did the agent build the wrong thing" instead of just counting tokens.
- **P1 failure-lesson episodic memory** — the self-improver now distills NEGATIVE trajectories ("what didn't work") into episodic memory and injects them into future planning prompts, so past mistakes (dead-end approaches, bad model choices, ignored goals) are avoided proactively. Previously only successful runs were stored.
- **Planner goal-fidelity validation** — plans must reference the goal's significant tokens (≥2-token goals) or pass an example-copy marker check (1-token goals). Off-topic or few-shot-regurgitated plans are rejected with an actionable error and re-planned. Fixes the NVDA-addon failure where the planner copied the JWT few-shot example verbatim (including its fake `path/to/...` path).
- **Planner-repair model escalation** — when the planner fails under auto routing, repair re-routes through the Auto router at the NEXT complexity level so a STRONGER model is used instead of re-prompting the same weak one until the repair budget dies. Non-auto paths keep the explicit model and honor `repairFallbackModels`.
- **`buff trace replay <id>`** — replays a captured trace step-by-step with the routing snapshot that selected each model (dashboard and CLI parity).

### Changed

- Planner few-shot example moved from JWT-auth to a neutral domain with an explicit `CRITICAL — DO NOT COPY THE EXAMPLES` instruction.
- Orchestrator + injection-guardrail tests pinned to a hermetic `BUFF_MEMORY_DIR` so trace writes never leak into the real `~/.buff` during the suite.

## [1.60.2] - 2026-08-07

### Added

- **Live context windows for every provider that exposes one.**
  - **Ollama multi-source parsing** — the local adapter reads the advertised context length from whichever location the Ollama version uses: `details.context_length` (0.32.x+), `model_info["general.context_length"]` / `["llama.context_length"]` (mid builds), or a family-keyed `model_info["<family>.context_length"]` (e.g. `gemma4.context_length`).
  - **Bounded `/api/show` fallback** — models that `/api/tags` can't describe get a targeted `POST /api/show` lookup (capped at 8 per list, so a large local library never triggers an unbounded N+1; localhost round-trips are ~ms). Live-verified: `gemma4:e4b` (custom model, no metadata in tags) now records its 131,072-token window via the fallback.
  - **Gemini** — `models.list` `inputTokenLimit` is recorded as the live window, gated on `supportedGenerationMethods` containing `generateContent` so embedding models' input caps are never mistaken for chat context windows.
  - **NIM** — vLLM-backed deployments expose `max_model_len` in the OpenAI-compatible list (total sequence length — a slight overestimate of the input window, fine for a soft preflight estimate); TensorRT-LLM deployments omit it and fall back to the provider-level estimate.
  - **Groq** — documented in code that `/models` exposes only id/object/created/owned_by (no window) — nothing to parse; falls back to the provider-level estimate.

### Fixed

- The 1.60.1 local-adapter parser looked only at `model_info.general.context_length`/`llama.context_length`; Ollama 0.32.x actually reports the value in `details.context_length`, so no local windows were recorded until the multi-source parse. Now all real local models carry live windows (verified on this machine: gemma4:e4b → 131,072, qwen2.5:0.5b → 32,768, deepseek-coder → 16,384).

### Added

- Tests: adapter window parsing for gemini (chat vs embedding vs no-fields), nim (max_model_len present/absent), and local (all three key locations + `/api/show` fallback + bounded N+1 + graceful failure). 6 new tests; 3,404 total green.

## [1.60.1] - 2026-08-07

### Added

- **Live per-model context windows in the router's context preflight.** The model probe now records each model's provider-advertised context window into the Model Availability Registry when the list endpoint exposes it — Ollama `/api/tags` (`general.context_length`) and OpenRouter `/models` (`context_length`). `resolveContextWindow` precedence is now: user override (`routing.contextWindows`) → **live registry descriptor** → provider-level nominal window → generous default. Providers whose list endpoints don't advertise windows (Groq, NIM, Gemini) fall back to the provider-level estimate. `ModelDescriptor` and `ModelRegistryEntry` gained `contextWindowTokens`; `markListed` accepts full descriptors (legacy string-id callers unchanged) and the window survives re-verify/re-kill rebuilds and JSON-mirror reloads.

### Fixed

- The v1.60.0 comment "live model descriptors win where available" is now actually true — the static provider-level estimate is only a fallback, not the primary source, when the API exposes the real spec.

### Added

- Tests: registry descriptor roundtrip (incl. reload), probe records advertised windows, router precedence (live beats provider default; explicit override still beats live). 3 new tests; 3,398 total green.

## [1.60.0] - 2026-08-07

### Changed

- **No hardcoded model defaults — fully dynamic selection.** The agent no longer ships a hardcoded default provider or per-provider model pins. `defaultProvider` is now the routing directive `'auto'`, resolved at runtime to the best *available* provider for the user's keys + learned registry (verified → configured-with-key → zero-config local). Every provider's model pin is the `'default'` sentinel, resolved at call time to a registry-verified working model. Explicit user pins still win (health-checked).
- **New `src/learning/model-selection.ts`** is the single selection authority: `rankAvailableProviders`, `resolveDefaultProvider`, `bestAvailable`, `preferredModelsFor`, `requireAdapterModel` — all derived from the Model Availability Registry (probe → spot-check → verified/unavailable), ranked by learned health (error rate, then latency). Provider-level nominal context windows replace the static per-model map; adapters resolve their last-resort model from the registry and never invent a name (clear onboarding error instead).
- **Fallback chain derived at runtime** — `fallback.providers` defaults to empty; the chain is built from what the user actually configured + verified, never a fixed provider list.
- **`'auto'` can never reach an adapter factory** — `getProviderConfig` resolves the directive, and every `ProviderFactory.createProvider` call site (router, orchestrator, skill compile, learn extract, CI review, provider-fallback) uses the resolved type.
- **Cold-start onboarding guidance** when nothing usable is configured (`buildOnboardingGuidance`): key hints + `buff models refresh`.
- Removed static selection data: `PREFERRED_MODELS`, `MODEL_CONTEXT_WINDOWS`, `DEFAULT_AGENT_MODELS`, `TASK_TO_PROVIDER`.

### Added

- `tests/learning/model-selection.test.ts` (16 tests): no-keys → local only, verified-first health ranking, blocked-provider exclusion, capability-profile picks, adapter model resolution, guidance on empty state. Router regression: `defaultProvider 'auto'` resolves to a concrete provider. 3,395 tests green.

## [1.59.9] - 2026-08-06

### Fixed

- **`BUFF_CONFIG_DIR` honored everywhere** — the config manager, dashboard server readers (`alwaysWatchQuota`, governance policy, API-key loader, RBAC role file), and the vector store's backend picker now resolve the config dir through one shared helper (`src/config/paths.ts`) with the same precedence as the RBAC layer: explicit dir > `$BUFF_CONFIG_DIR` > `~/.buff`. Previously only rbac.ts honored the override, so a hermetic smoke run pointed at `BUFF_CONFIG_DIR` could silently read/write the real `~/.buff/buffconfig.json` (exactly the stray-governance pollution seen in the v1.59.7 release).
- **`src/enterprise/rbac.ts`** switched to the same shared resolver (removed its duplicate inline resolution).

### Added

- Tests: `ConfigManager` honors `BUFF_CONFIG_DIR` for reads and writes, explicit dir arg wins over the env var; the dashboard's `/api/routing` governance reader honors `BUFF_CONFIG_DIR` over the homedir config. 4 new tests; 3,367 total green.

## [1.59.8] - 2026-08-06

### Added

- **P6 M6.4 Nuvira Gateway (minimal slice)** — the federation server is now a token-verified gateway: `FederationConfig.authMode 'oidc'` turns `/federation/handshake` into an `Authorization: Bearer` check verified by the new dependency-free `JwtOidcAdapter` (RS256 JWT verification via `node:crypto`, enforcing sub/exp/issuer/audience). `buff federation start --auth oidc --oidc-public-key <pem>`; the PEM path persists in `federation.json` so a daemonized server reloads it. Secret-mode servers are unchanged.
- **Dashboard RBAC identity card** — Routing Insights now shows who is looking (`buff admin whoami` mirror): acting identity, role badge, the full user→role map, and the legacy single-user notice, read from the same `~/.buff/rbac.json` the CLI writes.
- **Secrets hardening** — `buff doctor --enterprise` now flags M2.3 `apiKeys` rotation arrays stored in plaintext `buffconfig.json`, not just single `apiKey` values.
- **Admin guard-coverage parity test** — every mutating `buff admin` subcommand (allow/deny/allow-model/deny-model/max-cost/pii-min/unblock/clear) is asserted blocked for a viewer role.

### Added

- **P6 M6.1 RBAC** — role-based access control over the admin surface: `src/enterprise/rbac.ts` (roles admin/operator/viewer with a permission matrix, local role file `~/.buff/rbac.json` with `BUFF_CONFIG_DIR` override, OIDC adapter interface as the token-identity seam). `buff admin role add/remove/list` + `buff admin whoami`; every policy-write and role command is gated (`policy.write` / `role.manage`); legacy single-user mode stays fully permissive until roles are assigned; a misconfigured `rbac.json` now logs a warning instead of silently downgrading.
- **Dashboard governance card** — the Routing Insights page now renders the active `routing.governance.*` policy (allow/deny provider+model lists, max-cost, pii-min, unblock) read from the same config the router enforces.
- **CLI flakiness trend** — `models status` flaky rows now tag `healing` (EMA trending down toward 0) or `worsening` (climbing) from the `partialHistory` trajectory.

### Added

- **P6 M6.5 Admin governance API** — `buff admin` promotes the M2.4 policy (already enforced as hard constraints in Auto routing) into a first-class admin surface: `admin policy [--json]`, `admin allow/deny <provider...>`, `admin allow-model/deny-model <model...>`, `admin max-cost <usd>`, `admin pii-min <0..1>`, `admin unblock on|off`, `admin clear <field>` — all writing the same `routing.governance.*` config the router reads
- **Dashboard: flakiness healing sparkline** — the registry now records each `partialRate` EMA change as a bounded trajectory (`partialHistory`, capped at 16); registry rows render a mini sparkline (trending down = healing via clean successes, green end dot; climbing = accumulating). The signal survives every rebuild path (markVerified / markListed / markUnavailable — never hard-wiped) and persists across restarts
- **Dashboard: Requests panel flakiness** — per provider × model × action rows show a violet `⏸ N` chip for mid-stream partial interruptions (excluded from the error rate — a partial is not a request failure, it's the flakiness signal)
- Tests: registry 5 (history append/decay, preserve through re-verify + availability flip, 16-cap, restart persistence), admin 10, server partial/requests assertions, dashboard sparkline 3 + chip 1; 3,328 root green

## [1.59.5] - 2026-08-06

### Added

- **Dashboard: mid-stream flakiness feeds the registry cards** — the Models page now surfaces the P4 M4.4 flakiness signal the router uses: each registry row with a `partialRate` EMA > 0 renders a violet `⏸ flaky N%` chip (mirroring the CLI's `model explain` chip), provider headers show a `⏸ N flaky` badge, and the stats grid gains a **Flaky mid-stream** card. The dashboard server passes `partialRate` through the registry payload with provider + top-level `flaky` rollups; web types mark `flaky` optional so mixed-version bundles degrade gracefully. New server assertions + 3 `FlakinessChip` unit tests

## [1.59.4] - 2026-08-06

### Added

- **P6 M6.6: Software Bill of Materials (`buff sbom`).** Generates a CycloneDX
  1.5 SBOM from `package-lock.json` — the deterministic source of truth for
  exactly-what-is-installed (resolved versions + integrity hashes), so no
  network is needed and output is reproducible (`--reproducible` pins serial
  + timestamp for byte-identical rebuilds). Subcommands:
  - `buff sbom` — print the BOM (stdout) or `--out sbom.json` to write it
  - `buff sbom verify` — compare a stored BOM against the current lockfile:
    detects added/removed/changed dependencies (drift) and hand-edited BOMs
    (tamper), exit 0 clean / 1 drift
  - `buff sbom licenses` — license audit flagging copyleft (GPL/AGPL/…) and
    unknown licenses for compliance review
  - `doctor --enterprise` gains a Supply Chain (SBOM) check that verifies a
    stored `sbom.json` against the lockfile when present (real drift
    detection) and otherwise reports the fresh-BOM license posture

## [1.59.3] - 2026-08-06

### Fixed

- **`buff config set routing.<gate>` accepts the soft-signal gate keys.** The
  routing allowlist in the config CLI was stale — `capabilityFit`, `contextFit`
  and the new `partialFlakiness` were rejected with "Unknown routing config
  key". All three boolean gates now round-trip via `config set` (the router
  always read them, but operators couldn't set them from the CLI).

## [1.59.2] - 2026-08-06

### Added

- **P4 M4.4: mid-stream flakiness now feeds the ROUTER, not just the dashboard.**
  Each registry entry carries a `partialRate` EMA (0–1): `recordPartial` bumps
  it (status never flips — a partial today may complete tomorrow), clean
  `recordCall` successes decay it (never a hard wipe; a single success can't
  erase a flaky streak). New `getProviderFlakiness()` exposes the worst
  rate across a provider's models. Auto routing applies a reliability penalty
  (capped at 40% of the dimension) gated by `routing.partialFlakiness`
  (default ON), so providers that keep starting streams that die mid-way rank
  below otherwise-identical healthy ones — and `models explain` renders a
  transparent `⏸ flaky mid-stream (N%)` chip on affected rows. Set
  `routing.partialFlakiness false` to disable.

## [1.59.1] - 2026-08-06

### Added

- **Dashboard: P4 M4.4 partial mid-stream chips surface everywhere (M3.4 presentation).**
  The "learned from real usage" per-action telemetry now surfaces `partial`
  (mid-stream interruption) events end-to-end: the scrubbable timeline renders
  a violet `⏸` segment + day-summary count + legend, per-day chips render a
  violet `⏸` variant with the streamed-chunk detail in the tooltip ("died
  after ~N chunks"), and each action card shows a `⏸ N partial` stat + a
  dedicated Partial chips section (violet border wins the card when flaky
  mid-stream providers are present). `dedupeDayEvents` orders chips
  killed → partial → verified → error so flaky mid-stream providers surface
  right after predictive skips. Registry aggregation exposes `partialModels`
  (latest per provider × model, with `streamedChunks`).

## [1.59.0] - 2026-08-06

### Added

- **P6 M6.2 — Secrets management**: central `src/enterprise/secrets.ts` redaction scrubber — `redact()` masks API keys (known prefixes, Bearer tokens, key=value + JSON-encoded fields) everywhere; wired into EVERY logger method (message + args, non-plain values like Error preserved) and the two JSONL audit writers (quota-events, model-registry-actions). Nothing sensitive reaches a log or audit record. `BUFF_NO_REDACT=1` disables (debug only).
- **P6 M6.3 — Tamper-evident audit log**: `src/enterprise/audit-chain.ts` — SHA-256 hash-chained records (`chain.hash = sha256(prevHash ‖ canonical(record))`), sidecar head state (`<file>.chain.json`), `verifyChain()` with exact tamper-line detection + legacy pre-chain compatibility, rotation-safe re-chaining, O(1) fast append for hot paths, and CEF/SIEM export. New `buff audit verify` (exit 0 ok / 1 tampered|corrupt / 2 legacy) + `buff audit export`. `doctor --enterprise` Audit Integrity checks are now hash-chain verification (tamper = FAIL with the exact line).

## [1.58.9] - 2026-08-06

### Added

- **P7 M7.4 — opt-in gateway telemetry / usage-health flags** (`routing.gatewayTelemetry.enabled` / `healthFlags`, both **OFF by default**). Privacy-preserving by construction: enabling never captures prompt content — it only reports aggregate gateway usage/health (request counts, token totals, estimated cost, per-provider parked state + reset countdown) already tracked by the quota ledger + cost tracker, surfaced via `buff doctor --enterprise`.
  - `buff config set routing.gatewayTelemetry.enabled true` turns the report on; `healthFlags true` adds per-provider detail lines.
  - Off by default: `doctor --enterprise` shows an informative "Telemetry / Usage Health OFF (privacy-preserving default)" note with the enable command — never a failure.
  - `~/.buff/.env` is now overridable via `BUFF_ENV_FILE` (mirrors `BUFF_MEMORY_DIR`) so tests isolate from a real home env file; env/config tests updated.

## [1.58.8] - 2026-08-06

### Fixed

- **PERMANENT fix for the persistent "Dashboard server unreachable / Failed
  to fetch" issue.** Root cause: macOS resolves `localhost` → `::1` (IPv6)
  BEFORE `127.0.0.1` (IPv4), but the dashboard bound IPv4-only — so browsers
  hitting `localhost:3030` intermittently refused the connection (happy-
  eyeballs timing), and the frontend-only retries from v1.58.2 merely masked
  it. The server now binds BOTH loopback families to the same handler
  (IPv4 `127.0.0.1` + IPv6 `::1` twin), and `buff dashboard` auto-opens the
  deterministic `http://127.0.0.1:<port>` URL. Regression test proves both
  families serve HTTP 200. Reported repeatedly across sessions — now fixed
  at the bind layer.

## [1.58.7] - 2026-08-06

### Added

- **M4.4 conservative compression** (`routing.compression.*`, off by default):
  lossless-for-code prose elision — fenced code blocks are preserved
  byte-identical (identifiers/strings/symbols always survive, property-tested),
  only long prose is trimmed middle-out. `config set routing.compression.enabled`
  to opt in.
- **`partial` mid-stream telemetry**: the model registry now records providers
  that STARTED streaming but died mid-stream as a distinct `partial` outcome
  (aggregated per action + in the 14-day timeline; never flips availability).
  Chat's auto-failover write-throughs the interruption.
- **`buff doctor --enterprise`** (P7 M7.1): self-check for gateway health,
  secrets backend (env vs plaintext keys), audit-trail integrity (JSONL), and
  RBAC/governance policy presence. Missing optional config is informational.
- **Upgrade guide + migration notes** (P7 M7.2) added to UPGRADE_ROADMAP.md.

## [1.58.6] - 2026-08-06

### Fixed

- **`routing.*` config was silently dropped on every reload.** `loadConfig`
  merged providers/history/fallback/pricing but NOT the routing section — so
  `buff config set routing.bandit`, `routing.quota.*`, `routing.governance.*`,
  `routing.contextWindows.*` and the new `routing.nuviraSidecar.*` keys never
  survived a restart (they worked within a session only). The routing section
  is now merged with deep-merges for the nested maps. New regression test.

## [1.58.5] - 2026-08-06

### Added

- **P5 M5.4 config keys** — `buff config set routing.nuviraSidecar.enabled <true|false>`
  (the P5 feature flag) and `routing.nuviraSidecar.image <image:tag>` (pinned
  gateway image override) are now accepted by the config schema (additive-only,
  per the roadmap cross-cutting rule). 2 new config tests.

## [1.58.4] - 2026-08-06

### Added — Nuvira-Router P5 (sidecar interop) + P4 (mid-stream resilience core)

- **P5 M5.1 — Sidecar profile + `buff doctor --nuvira` probe.**
  `docker-compose.nuvira.yml` (pinned external-gateway image, `base` profile,
  healthcheck, loopback-only port mapping) + a sample `nuvira-gateway-config.yaml`.
  `buff doctor --nuvira` probes the gateway (GET `/v1/models` → reachability +
  model count; best-effort `/version` → gateway version) via the exported,
  unit-tested `probeNuviraSidecar()`. Doctor tests use a real mock gateway.
- **P5 M5.4 — Feature flag + router universe.** `routing.nuviraSidecar.enabled`
  (default false). The auto-router now includes `nuvira` as a candidate with a
  NEUTRAL profile (never dominates, never excluded — it joins the same
  registry/bandit/quota learning), and `hasRequiredCredentials('nuvira')`
  returns true (keyless loopback gateways by design; a dead gateway is skipped
  at the availability walk, never failed into).
- **P5 M5.3 — Hermetic E2E through the gateway** (`tests/e2e/sidecar-learning.test.ts`):
  mock gateway-shaped server, real adapter + registry + router — a 429 teaches
  the block, the next pick skips, a later success re-verifies (mirrors
  `failover-learning.test.ts`).
- **P4 M4.1 — Continuation retry core** (`src/learning/continuation.ts` +
  chat wiring). `isPartialFailure()` (definitive auth/rate-limit/model-404 never
  continue), `buildContinuationNote()` (bounded, head+tail partial relay,
  prompt always included), `ContinuationBudget` (max 1 continuation per task).
  Chat's interactive auto-failover buffers streamed tokens and hands the next
  candidate a bounded "continue from here" note on a mid-stream death; the
  nuvira adapter appends it via `InferenceOptions.continuation`.
- **P4 M4.2 — Reasoning-replay cache** (`src/learning/reasoning-cache.ts` +
  SSE capture). Last `reasoning_content` per (provider, model, conversation-key
  fingerprint) persisted to `~/.buff/memory/reasoning-cache.json`;
  `streamCompletion` forwards reasoning deltas (`parseSSEReasoning`); the nuvira
  adapter caches them and re-injects via `InferenceOptions.reasoningContext` as
  a prior assistant reasoning message.
- **P4 M4.3 — Context-relay summaries.** The continuation note doubles as the
  compact "session so far" relay (prompt + partial output, budget-capped) so a
  rotated provider/key has continuity.

### Tests

- New: `tests/cli/doctor.test.ts` (4), `tests/e2e/sidecar-learning.test.ts` (3),
  `tests/learning/continuation.test.ts` (12), `tests/learning/reasoning-cache.test.ts` (4),
  +3 nuvira-adapter P4 tests. Auto-router governance tests updated for the nuvira
  universe. ~3,300 root tests passing.

## [1.58.3] - 2026-08-06

### Added — Nuvira-Router P3 (Requests panel + decision diff)

- **M3.2 — Dashboard Requests panel** (`src/web-dashboard/server.ts`,
  `src/web-dashboard/src/components/RequestsPanel.tsx`). New
  `GET /api/requests` endpoint + Requests nav item/route: a per
  provider × model × action request table built from the action-telemetry
  JSONL log — requests, failures, avg latency, p50/p95/p99 (percentiles
  render only at ≥10 samples, per the roadmap contract; the avg renders
  whenever any sample exists), last-call time, and measured spend per
  provider × model sourced from the cost ledger (adapters record cost
  without an action tag, so ledger spend is attributed at provider×model
  and the panel sums unique pairs). Also wired into `/api/all` and both
  SSE payloads.
- **M3.3 — Decision diff (`models explain --since <ref>`)** — new pure
  `src/learning/decision-diff.ts` module (`diffRoutingDecisions` +
  `formatDecisionDiff`): `models explain` now records a full
  `RoutingSnapshot` (winner, ranked scores, task type) per decision, and
  `--since @1|@2|…` compares the current decision against that earlier
  snapshot — candidate score deltas (▲ improved / ▼ regressed /
  unchanged), winner changes, and gate/latency changes. Renders in human
  output and `--json` (as `diff`).
- **Telemetry latency threading** — `ModelRegistry.recordCall` /
  `markVerified` and the shared failover runner now record measured
  latency (and cost/callId where known) into each action-telemetry entry,
  so the Requests panel has real per-call latency instead of zeros.

### Tests

- 85 root tests (decision-diff suite + explain `--since` + `/api/requests`
  server contract) and 54 dashboard component tests (RequestsPanel suite),
  all passing; typecheck clean on both sides.

## [1.58.2] - 2026-08-06

### Fixed

- **Models dashboard "Failed to fetch" repeat fix** — the Models page fetch was
  un-hardened: a single transient network hiccup (browser socket-pool
  contention with the persistent SSE feed, a slow provider probe, an
  IPv4/IPv6 race on `localhost`) rejected the bare `fetch()` calls with
  `TypeError: Failed to fetch` and left the panel stuck on an error banner.
  The panel now uses per-request `AbortController` timeouts, fetches health
  and registry independently (a failure on one never hides the other),
  auto-retries network-level failures with backoff, re-polls quickly after a
  failure (self-healing instead of waiting the 60s cadence), and shows a clear
  "Dashboard server unreachable — retrying automatically…" message only after
  retries are exhausted. 3 new component tests (total 48).

## [1.58.1] - 2026-08-06

### Added

- **Dashboard mirrors the CLI `model explain` guarantees** — the Auto Router
  preference panel now renders the v1.58.0 M2.x chips on every provider row:
  🎯 capability fit (`capabilityFit`), 📏 measured wire-token cost
  (`costSource` + `costBasis`), and ⏳ context preflight (`contextUtilization` +
  `contextWindowTokens`). `/api/routing` and `/api/all` carry the fields per
  ranked provider; rows whose gates are OFF simply omit the chip (the cost
  source always renders, exactly like the CLI). Verified live end-to-end.
- `MODELS_EXPLAIN_DEMO.md` gains a dashboard-mirroring section.

### Tests

- 3,161 root tests pass (+45 dashboard component tests): new component tests
  for the preference-table chips (measured renders, gates-OFF leaves only the
  cost chip, no chip row when fields absent) and a server assertion loop
  proving the measured/estimated cost-source contract. Also fixed a
  cold-start timeout flake in `trajectory-store.test.ts` (vector-backend
  warmup in `beforeAll` + 60s timeout on the first save test).

## [1.58.0] - 2026-08-06

> First release to ship the Nuvira-Router P2 routing work below. Also carries
> the `buff dashboard --force` + `--port` fixes staged as v1.57.0 (see that
> entry) — v1.57.0 was bumped in `package.json` but never published, so all of
> it lands here. 3,159 root tests pass (+ dashboard component tests).

### Added — Nuvira-Router P2 (capability-aware scoring + wire-token metering)

- **M2.5 — Context-length preflight** (`src/learning/auto-router.ts`,
  `src/learning/hybrid-router.ts`, `src/cli/chat.ts`, `src/cli/model.ts`,
  `src/cli/config.ts`). The genuine gap Copilot identified — the router now
  scores each provider's NOMINAL INPUT CONTEXT WINDOW against the task's
  estimated prompt size before picking. Built-in per-model + per-provider
  window tables (`MODEL_CONTEXT_WINDOWS` / `PROVIDER_CONTEXT_WINDOWS`,
  `routing.contextWindows` overrides keyed by model or provider always win),
  and the estimate comes from the caller's `contextHintTokens` when the REAL
  payload is known (chat passes the growing conversation history and the
  built full prompt) — else the task text. **Soft, estimation-only, NEVER a
  hard block**: `computeContextFit` is neutral below 50% utilization
  (normal-size tasks never shift a ranking), ramps linearly, and even a
  prompt exceeding the window only caps the penalty at 35% (models may
  exceed nominal windows). Reversible gate `routing.contextFit` (default ON,
  like capability-fit — gate-off omits the signal entirely). Surfaced per
  provider in `models explain`: a `⏳ ctx N%` chip on ranked rows, a full
  `── Context preflight ──` section (estimated tokens, basis task|hint,
  per-provider window/utilization/fit), and a JSON `context` block; fallback
  chain candidates carry `contextWindowTokens`. `buff config set
  routing.contextWindows.<model|provider> <tokens>` stores validated
  integers. A 500K-token payload flips a privacy-first local pick to gemini
  (1M window) — the long-conversation/heavy-workspace case now routes toward
  big-window providers.
  - **Followup: plan + orchestrator pass real payload estimates** (`src/cli/plan.ts`,
    `src/agents/orchestrator.ts`). `buff plan` resolves with
    `contextHintTokens: estimateTokens(prompt)` — the actual built prompt
    (task + parsed codebase context). The orchestrator sizes each per-task
    payload via `estimateTaskPayloadTokens(vault, description, contextFiles)`
    (goal + task description + stat-sized workspace context files, best-effort)
    and forwards it as `contextHintTokens` through `resolveAutoRoutingDecision`
    into the router, so multi-agent pipelines (execute/plan) get the same
    long-context awareness chat already had. Planner decision intentionally
    omits the hint (its payload isn't known at resolve time; goal-only would
    equal the router default). 3 new tests; 288 affected + full gate pass.
- **M2.4 — Governance constraints (admin policy)** (`src/config/types.ts`,
  `src/learning/auto-router.ts`, `src/cli/models.ts`, `src/cli/model.ts`,
  `src/web-dashboard/server.ts`). Admin routing policy via `routing.governance`
  — config-additive, fully permissive when unset. Provider allow/deny lists,
  model allow/deny lists (enforced against the model that will ACTUALLY be
  served: the configured pin, or the curated defaults when unpinned — a pinned
  violator is killed even if a curated default would pass), an admin per-call
  max-cost cap (the stricter of admin vs per-call wins), and a PII-domain
  block (task matches `piiPatterns` → only providers with privacy ≥
  `minPrivacyForPii`, default 1.0 = local-only). All enforcement is a HARD
  elimination in the router's constraint slot — never a score nudge.
  **Hard-gate guarantees:** when a governance rule eliminates EVERY candidate
  the router REFUSES to serve a policy violator — `PIIPolicyError` (privacy)
  / `GovernancePolicyError` (lists/admin cap), each carrying the full
  `governanceBlocked` audit trail (provider + reason); only per-call SOFT
  options (`maxCostUsd`/`minSpeed`/`minReasoning`, which never populate the
  audit) keep the benign fallback-to-ranking. `models explain` renders policy
  blocks cleanly (human audit trail + JSON error object); `buff plan`
  rethrows instead of degrading around a block. `buff models unblock` gains
  the admin gate `governance.allowUnblock: false` (refuses the escape hatch)
  and an advisory when the provider sits on an admin deny list (unblock alone
  can't restore it). Dashboard Quota panel adds the parked key-account view
  (`parkedAccounts`). `buff config set` supports `providers.<name>.apiKeys`
  and `routing.governance.*`.
- **M2.3 — Multi-account key rotation** (`src/config/types.ts`,
  `src/learning/quota-ledger.ts`, `src/cli/failover-runner.ts`). A provider
  can now carry MULTIPLE API keys (`ProviderConfig.apiKeys: string[]`, in
  addition to the primary `apiKey`). The shared failover walk
  (`runSingleShotAuto`) rotates through every non-parked key of a candidate
  BEFORE switching providers: on a rate-limit/auth failure the dead ACCOUNT
  is parked in the quota ledger (FNV-1a fingerprint via `accountIdForKey` —
  raw keys are never persisted) and the next key is tried, so a quota-exhausted
  secondary account no longer forces a provider switch. `options.apiKey`
  overrides the configured key at the adapter level (Groq, NIM, Nuvira
  gateway). Rotation is logged (`🔑 key#N …`), the next run SKIPS parked
  accounts predictively (`isAccountParked`), and `releaseProvider` /
  `releaseAccount` / `buff models unblock` clear them. Single-key and
  keyless behavior is unchanged. Account parks act as a floor — the
  config-aware `routing.quota.windowMs` window (via `recordActionFailure`)
  wins when longer. Hermetic E2E (`tests/e2e/key-rotation.test.ts`) drives
  the real adapter + runner against a mock gateway whose behavior keys on the
  Authorization header: key-1 → 429 parks, key-2 → 200 answers, next run
  skips key-1. Surfaced in `models explain` per ranked provider (`cost-source`
  column) and in the dashboard Models panel (📏 measured-token chip).

### Added — Nuvira-Router P2 (capability-aware scoring + wire-token metering)

- **M2.1 — Capability-aware scoring** (`src/learning/auto-router.ts`). A new
  soft task-type → capability signal: each task type's required model-catalog
  tags (`plan`→reasoning, `code-review`→code+reasoning, quick edit→code,
  `context-gather`→fast, …) are matched against each provider's offered tags,
  nudging equally-scored candidates toward the one whose strengths fit the
  task. Tags = static catalog ∪ tags derived from the provider's REAL
  capability profile (custom/gateway providers are scored honestly); unknown
  providers stay fully neutral (the fallback profile derives nothing) until
  real usage data exists. Applied as a clamped soft multiplier
  `min(1, score·(0.9+0.2·fit))` — it can never overturn a dimension-weight
  advantage or break the 0–1 invariant. **Reversible gate**
  `routing.capabilityFit` (default ON) — set false to revert to pure
  dimension-weight scoring. Surfaced per ranked provider in `models explain`
  (text `🎯 fit N%` + JSON `capabilityFit`); fit applies only to healthy
  candidates (quota-parked reasons stay definitive, no chip).
- **M2.2 — Wire-token cost inputs (measured cost beats the estimate)**.
  OpenAI-compatible adapters (Nuvira gateway, Groq, NIM) now capture the
  provider-reported `usage` — from the response body and from the final SSE
  chunk (include_usage convention) — and record EXACT input/output tokens
  (`recordCallMeasured`, `CostEntry.measured`). The Model Availability
  Registry stores per-model token EMAs (`recordMeasuredUsage` /
  `getMeasuredUsage`), and Auto routing's cost scoring uses MEASURED tokens
  instead of the TYPICAL 2,000/500 estimate whenever real usage exists
  (`costSource: 'measured' | 'estimated'` per ranked provider in
  `models explain`, shown as `📏 measured N→M tok`). The dashboard cost panel
  splits spend into 📏 measured (exact wire tokens) vs 📐 estimated
  (length-based), per-call and per-provider. Providers that report no usage
  fall back to estimates, flagged. Hermetic E2E
  (`tests/e2e/gateway-measured-cost.test.ts`) drives the real adapter against
  a mock OpenAI-compatible /v1 gateway and proves the full loop: measured
  usage → registry → verified → measured-cost resolve.

### Added — Nuvira-Router M0.2 (shared failover machinery, phase P0)

- **`recordActionFailure()` — one shared failure-composition for every action**
  (`src/learning/failure-bookkeeping.ts`). Every LLM-call failure now runs the
  SAME bookkeeping: classify → session exclusion (auth = rest of session,
  rate-limit = cooldown + quota-ledger park, transient = cooldown + re-verify
  marker) → per-action model-registry write-through (model-not-found →
  definitive unavailable) → quota-timeline failover event → circuit-breaker
  feed. Best-effort, never throws.
- **`runSingleShotAuto()` — one shared auto-failover walk**
  (`src/cli/failover-runner.ts`). Walks the auto-router's ranked candidates
  for ANY failure class and returns the first success; same candidate order,
  same per-attempt telemetry, same TTY-guarded prompt-on-failover, same
  last-error throw — extracted behavior-identically from chat.
- **`buff plan` now fails over like chat.** The old pick-then-`callWithFallback`
  (retryable-only) path is replaced with the shared walk: plan tries the
  picked provider first, then the auto-router's ranked alternatives, records
  every attempt through the full bookkeeping (`action: 'plan'`), and repairs
  models to live ones. Picker + auth UX preserved.
- **`buff execute` now uses the full bookkeeping.** The orchestrator's per-agent
  LLM catch (the single record point for the whole pipeline) switched from a
  bare registry write to `recordActionFailure` — a mid-pipeline 429 now parks
  the provider in the quota ledger so the next task skips it predictively.
  `resolveAutoRoutingDecision` also consults the per-pipeline failure session
  (M0.3): a provider that failed earlier in the pipeline never wins a
  subsequent task. `generateFollowUpSuggestions` (the one execute-side call
  that bypassed the orchestrator) now records through the same composition.
- **Regression gate** (`scripts/ci/regression-gate.sh`) — canonical
  no-regression gate (routing guard → hermetic failover E2E → full root suite
  → dashboard suite, hard failure exit), wired into CI as the baseline lock.

---

## [1.57.0] - 2026-08-05

### Added

- **`buff dashboard --force`** — automatically detect a STALE dashboard on the
  port (the API/SSE mismatch: `/api/model-registry` answers with SPA HTML
  instead of JSON) and offer to restart it. A new unit-testable module
  `src/cli/dashboard-restart.ts` provides `probeDashboardPortState` (classifies
  what's on the port: unreachable / not-a-dashboard / current-dashboard /
  stale-dashboard / unknown — only a stale Agent-Nuvira dashboard is ever
  touched), `findPidOnPort`, `killPid` (SIGTERM→SIGKILL, `taskkill` on
  Windows), `waitForPortFree`, and `confirmStaleRestart` (inquirer confirm;
  non-TTY `--force` runs skip the prompt). The CLI then kills the stale PID,
  waits for the port to free, and re-binds a fresh server (up to 3 attempts).

### Fixed

- **`buff dashboard --port <port>` silently ignored the port** (pre-existing
  bug) — `createDashboardServer()` bound the module-**import-time** `PORT`/
  `HOST` constants, so any non-default port still served on 3030. The server
  now resolves the bind at **call time** from explicit `{ port, host }`
  overrides (env vars → defaults as fallback), and the CLI passes them
  explicitly. This was ALSO why the `--force` restart loop failed: after
  killing the stale dashboard it kept re-binding 3030 (EADDRINUSE) instead of
  the requested port — proven fixed live end-to-end (stale detected → killed →
  fresh server re-bound on the requested port).
- The `--force` retry now gates on the port actually freeing (the
  `waitForPortFree` result is honored instead of discarded), and the restart
  promise has a rejection handler so an unexpected error can never leave the
  CLI hanging on an unsettled promise.

### Tests

- 3,032 root tests pass (+42 dashboard component tests): new
  `tests/cli/dashboard-restart.test.ts` (17 tests for the probe/kill/wait/
  prompt helpers), `--force` CLI paths (detect → restart, current-dashboard
  decline, confirm decline), and a server regression proving an explicit
  port override binds the requested port.

## [1.56.1] - 2026-08-05

### Fixed

- **Dashboard Models panel crash — "Failed to execute 'json' on 'Response':
  Unexpected token '<'"** — a STALE dashboard server (an older globally-installed
  `agent-nuvira dashboard` still running on the port) returned the SPA
  `index.html` (HTTP 200, `text/html`) for `/api/model-registry` — a route its
  older server code doesn't have — while the newer frontend bundle fetched it.
  `res.ok` was true, so `res.json()` threw on the HTML. Fixed at all three
  layers:
  - **Server** — unknown `/api/*` paths now return a parseable **JSON 404**
    (`{ error: 'Not found', path }`) instead of falling through to the SPA
    fallback, so API consumers never receive HTML. Non-API unknown paths still
    get the SPA fallback.
  - **Frontend** — all `/api/*` responses are parsed defensively through a
    shared `parseJsonOrNull()` helper (Content-Type must be JSON + try/catch
    parse; an HTML-200 logs a console hint and degrades to null).
    `ModelsPanel`'s `/api/models` non-JSON surfaces a friendly "is the
    dashboard server up to date?" error instead of an uncaught parse crash;
    the registry/telemetry sections (optional data) simply hide when the
    response isn't JSON, and `api.ts`'s `fetchAll()` (the app bootstrap)
    waits for the next SSE snapshot instead of crashing.
  - **CLI** — `buff dashboard` now listens for the `error` event on the server:
    **EADDRINUSE** (the exact stale-instance scenario) logs a clear "port
    already in use — another dashboard (possibly an older version) is running"
    message with `pkill` / alternate-port hints, closes the server, and exits 1
    instead of crashing with an unhandled error event and leaving the browser
    pointed at the stale instance.
- **Tests** — server suite flips the old contract (unknown `/api/*` → 200 HTML)
  to JSON-404 + a non-API SPA-fallback test; `dashboard.test.ts` mock is now
  EventEmitter-shaped (fires `listening` on `setImmediate`, captures `error`)
  with a new EADDRINUSE test; `ModelsPanel.test.tsx` adds two fetch-degradation
  tests (both endpoints HTML → friendly error; registry-only HTML → grid
  survives). Root suite: 3,011 tests; dashboard component tests: 42 across 6
  files.

---

## [1.56.0] - 2026-08-05

### Added

- **Scrubbable per-action telemetry timeline** — the dashboard's daily
  "learned from real usage" chart (verified vs killed vs transient per
  action over the last 14 days) now matches the Run Timeline interaction:
  drag across the bars, click a day, or use the range slider to scrub the
  caret to any day, with ▶ play/pause sweeping day-by-day. The detail panel
  under the chart shows the scrubbed day's exact chips — which provider ×
  model the action killed (predictively skipped) or verified that day.
  Day buckets in the registry's action-telemetry timeline now carry their
  raw events (provider × model × outcome × reason, deduped per combo so the
  dashboard payload stays bounded as usage grows) end-to-end from the JSONL
  log through `/api/model-registry`.

### Notes

- Test suite: 3,011 tests across 98 files. Web dashboard component tests:
  39 across 5 files (added the scrubbable-chart suite).

---

## [1.55.0] - 2026-08-05

### Added

- **`buff models unblock <provider>` escape hatch** — manually release a
  provider the Model Availability Registry has ruled out (predictive skip).
  `ModelRegistry.unblockProvider()` demotes every `unavailable` entry to
  `unverified` and clears quota parks, `getQuotaLedger().releaseProvider()`
  clears the ledger cooldown (so `syncQuota` can't instantly re-park genuine
  exhaustion), then the command re-probes the live API via
  `refreshModelRegistry` to re-learn the truth. Output shows the demote
  result, the re-probe verdict (`verified` / `unavailable` / `skipped` /
  `error`), and an honest `stillBlocked: true/false` field — with `--json`
  for CI. `--no-spot-check` skips the live probe (demote + un-park only).
- **Fixed a pre-existing `models` subcommand JSON bug** — the parent `models`
  command's `-j, --json` option shadowed the identical flag on its
  subcommands, so `models status --json` and `models refresh --json` silently
  emitted human output. New `isJsonMode()` helper resolves the flag through
  `optsWithGlobals()`, fixing both commands (and the new `unblock --json`).

### Notes

- Test suite: 3,009 tests across 98 files (added the unblock registry + CLI
  suites). VS Code extension: 213 tests across 10 files.

---

## [1.54.0] - 2026-08-05

### Added

- **VS Code extension telemetry attribution** — the extension now tags every
  real LLM call it drives with `BUFF_TELEMETRY_ACTION` at each subprocess spawn
  (`ide-chat` for the chat panel, `ide-inline` for inline suggestions,
  `ide-<command>` for execute / edit / workflow / review via the CLI manager),
  so IDE usage shows up as its own rows in the per-action "learned from real
  usage" registry log and dashboard panel instead of blending into
  terminal-driven telemetry. The CLI resolves the override centrally in
  `recordRegistryFailure` / `recordRegistrySuccess` (`resolveTelemetryAction`),
  so every write from an IDE-spawned CLI process — including developer-mode
  orchestrator calls inside a chat session — inherits the spawning action's
  tag (documented as process-wide by design).
- **Env-override tests** — `provider-fallback.test.ts` covers the override
  (IDE-tagged kill + verify writes, blank-override fallback, natural tag when
  unset) with file-level `BUFF_TELEMETRY_ACTION` isolation; `cliManager.test.ts`
  asserts the spawn env carries `ide-<command>` for execute/chat/edit.

### Notes

- Test suite: 3,002 tests across 98 files (added the env-override + spawn-env
  suites). VS Code extension: 213 tests across 10 files.

---

## [1.53.0] - 2026-08-05

### Added

- **Per-action "learned from real usage" telemetry everywhere** — every LLM call
  (chat, execute, plan, edit, skill, learn, ci, doctor) writes through to the
  Model Availability Registry WITH its action tag, so the registry learns which
  provider × model each action killed or verified from real usage — not just
  probes. `models status --verbose` prints registry-blocked providers (why
  routing skips them) plus per-action verified/killed chips; the dashboard's
  Models panel shows the same feed with a **daily timeline chart** (verified vs
  killed vs transient per action over the last 14 days). A provider killed by
  ANY action is skipped predictively by all others.
- **Recovery loop** — a later real success re-verifies a provider AND clears a
  stale learned quota-park (a real 1-token spot-check or usage success is
  direct evidence the provider serves again; `syncQuota` re-parks genuine
  exhaustion on the next routing read).
- **Hermetic E2E failover test** (`tests/e2e/failover-learning.test.ts`) — a
  real local HTTP mock returns 429, the real NIM adapter + ProviderFallback +
  ModelRegistry + AutoModelRouter are exercised over that socket, proving
  "registry learns the block, next pick skips it" (and the recovery loop) with
  zero external network / Ollama.

### Notes

- Test suite: 2,996 tests across 98 files (added E2E + registry timeline +
  `models status --verbose` coverage).

---

## [1.52.0] - 2026-08-04

### Added

- **Predictive model-availability routing** — the model registry now drives every
  pick: models with no known API key or failed health probes are skipped before
  scoring, so the router never opens a session on a dead provider (no more
  "starts with Gemini, then NIM, then local" on every chat). Registry health,
  availability, token remaining and reset windows feed the scorer directly.
- **Web dashboard — scrubbable phase timeline** for pipeline runs (plan → gather
  → write → review → test), persisted to `pipeline-runs.json` and replayed with a
  draggable caret, play/pause sweep, and run selector; scrubbing highlights the
  matching DAG node.
- **Web dashboard — routing walkthrough** "Why did the router pick this?": a
  narrated 4-step playback (request → candidates → exclusions → pick) built from
  real routing-history decisions, with a complexity-profile fallback.

### Notes

- The dashboard is rebuilt into `src/web-dashboard/public/` and ships inside the
  npm tarball, so `buff dashboard` serves the new timeline + walkthrough.

### Fixed

- **Published README version-history table completed** — the README shipped in
  the npm tarball was missing the v1.50.0 and v1.51.0 rows in the version
  history table (it stopped at v1.49.1), so consumers of the published docs
  couldn't see the two newest releases. Added both rows; the historical
  v1.45.5 entry was verified against the npm registry and CHANGELOG and left
  intact (it's a real release record, not a stale reference)

---

## [1.51.0] - 2026-08-04

### Added

- **Routing strategy super-enhancement** — Auto model selection now scores
  providers across 5 weighted dimensions (reasoning, speed, cost, privacy,
  reliability) with per-complexity weight matrices for all 5 levels (trivial →
  critical). Key enhancements:
  - **Thompson-sampling bandit** with cost-adjusted rewards per complexity
    bucket; Beta(1,1) cold start behaves deterministically until outcomes
    accumulate. State persists to `~/.buff/memory/router-bandit.json`
  - **Uncertainty-driven escalation** — when the bandit's winner has no learned
    data (α+β < default 8 samples), routing escalates to the next-ranked
    provider that HAS learned data with a ≥55% win-rate floor, so a cold-start
    winner never commits to a coin flip
  - **Per-modelId learning** (ruflo ADR-149 mirror) — both provider-level and
    model-level Beta priors track which concrete model won; cold start keeps
    the configured pin, learned models prefer the best Thompson-sampled one
  - **Promotion gate A/B** — every auto-routed task records both the
    deterministic heuristic pick and the bandit pick for the same task;
    `buff model bandit` evaluates 3 criteria (quality improvement >2%, cost
    regression ≤1%, p95 latency regression ≤5%) before promoting the bandit
  - **Routing rules** — regex/string task-pattern rules force a specific
    provider/model before scoring (first match wins); rules also note the
    forced provider for correct bandit outcome attribution
  - **Hard constraints** — `routing.maxCostUsd`, `routing.minSpeed`,
    `routing.minReasoning` eliminate violating providers with graceful fallback
    when constraints would remove everything
  - **Credential-aware filtering** — Auto routing never picks a provider
    without configured credentials (ModelRegistry fast path verifies usable
    models); explicit `allowedProviders` always win
  - **Quota-ledger integration** — exhausted providers sink below healthy ones
    like circuit-breaker cooldown, only picked when every candidate is parked
  - **Runtime stats blending** — benchmark quality scores (30%) + per-agent
    best-model stats adjust provider capability scores in real time
  - **Verification-aware escalation** — verification-heavy tasks (deploy,
    security audit) boost reasoning+reliability weights and reorder candidates
    so the strongest provider for verification is tried first
  - **Free/local-first gate** (`routing.allowPaid: false`) — keeps paid
    providers out of trivial/simple/moderate tasks; complex/critical tasks may
    still use high-capacity models

- **Orchestrator test pollution fix** — 2 flaky checkpoint-resume tests were
  failing under parallel load due to module-level `mockClear()` (which clears
  call counts but not implementations) vs `mockReset()` (which clears both).
  Changed all 3 `describe` blocks to use `mockReset()`, added cross-describe
  mock reset in auto-model resolution `beforeEach`, and restored
  `mockReturnValue()` after each reset. Full suite: 2,934 tests, 0 failures.

- **Model-registry test FAISS backend fix** — widened the expected backend
  assertion from `['json', 'faiss-ivf']` to `['json', 'faiss-ivf',
  'faiss-native']` since `@faiss-node/native` is now installed and functional
  on this machine. All 19/19 model-registry tests pass.

### Changed

- **Auto routing tests expanded** — 95 tests covering: 5 complexity levels ×
  4 preference modes, pricing overrides, runtime stats, bandit learning,
  uncertainty escalation, credential filtering, hard constraints, routing
  rules, per-model learning, and promotion gate A/B
- **Total test count** updated to 2,934 tests (96 test files) — all passing

---

## [1.50.0] - 2026-08-02

### Added

- **`buff memory backend --check` diagnostics** — new `backend` subcommand
  shows the active vector-search backend (faiss-native / faiss-ivf / json),
  why it was chosen, and (with `--check`) whether native FAISS is installed
  and usable, with install guidance when it isn't. `checkNativeFaiss()` is
  also exported from the package API.
- **Docs & website coverage for the FAISS-backed vector store** — README
  version history, Product_Guide inventory rows 93–95 + release timeline
  (v1.48.0–v1.49.1), User_Manual "Vector Search Backend" section, and a new
  FAISS feature card on agent-nuvira.com with test counts updated to 2,880+.

---

## [1.49.1] - 2026-08-02

### Fixed

- **Native FAISS tier now actually activates** — `NativeFaissBackend` was
  written against the wrong `@faiss-node/native` API (`IndexFlatIP`), so the
  load-time smoke test always failed and agent-nuvira silently ran the pure-JS
  IVF backend even when the native module was installed and built. Rewritten
  for the real v0.1.11 API (`FaissIndex` with `{ type: 'FLAT_IP', dims }`,
  async `add(Float32Array, Int32Array?)` / `search(Float32Array, k)` returning
  typed arrays, `dispose()`), with L2-normalization so FLAT_IP inner product =
  cosine similarity, a typed-array-safe smoke test (the `Array.isArray` check
  is false for `Int32Array` labels — the second silent-fallback bug), CJS/ESM
  interop normalization, and a `Math.max(0, …)` pad guard. Verified: on a
  machine with `@faiss-node/native` built, `createFaissBackend` now resolves
  to `faiss-native` and searches correctly. New mock-based native-tier tests
  (end-to-end + filter) and an updated fallback test

## [1.49.0] - 2026-08-02

### Added

- **Hermetic memory test suite** — `vector-store`, `trajectory-store`, and
  `memory-integration` tests now run against a fresh temp `BUFF_MEMORY_DIR`
  (they previously wrote to the real `~/.buff/memory`)
- **IVF-vs-exact benchmark** — new `faiss-benchmark` test compares the pure-JS
  IVF-flat ANN against the exact JSON backend on a 2,000-vector corpus:
  asserts exact recall@5 ≥ 0.99, IVF recall@5 ≥ 0.9, recall@1 ≥ 0.8, and logs
  per-query latency so the approximate-search tradeoff is measurable
- **Cross-session FAISS transparency** — the orchestrator's memory-retrieval
  step now logs the active vector backend (`faiss-native` / `faiss-ivf` /
  `json`) in verbose mode; a new integration test verifies cross-session
  trajectory memory is served through the FAISS-style backend under `auto`

### Fixed

- **Module-import path capture in trajectory/pattern stores** —
  `trajectory-store.ts` and `pattern-extractor.ts` resolved their memory-dir
  paths at module load (ignoring `BUFF_MEMORY_DIR`); they now resolve lazily
  per operation, matching `vector-store.ts`, so hermetic tests and
  `BUFF_MEMORY_DIR`-based redirects work everywhere

## [1.48.0] - 2026-08-02

### Added

- **FAISS-style vector search backend** — the JSON vector store is now a
  pluggable backend behind the same `VectorStore` interface. New
  `src/memory/faiss-backend.ts` provides a **pure-JS IVF-flat ANN** (a faithful
  TypeScript port of FAISS `IndexIVFFlat`: nlist inverted lists via
  deterministic k-means++, nprobe probe lists, cosine = inner product of
  L2-normalized vectors, filter-aware probe expansion) that is exact below the
  512-entry threshold (identical results to the JSON backend) and approximate
  above it, plus a **best-effort native tier** that uses real
  `@faiss-node/native` bindings when the user has installed+build them
  (smoke-tested at load; any failure falls back to the pure-JS tier, so
  semantic search never breaks). Backend chosen by `memory.vectorBackend`
  (`auto` default / `faiss` / `json`), the `BUFF_VECTOR_BACKEND` env var, and
  shown in `buff memory stats`. `@faiss-node/native` added as an optional
  dependency (npm skips it gracefully when it can't build). Decision
  documented: native FAISS requires cmake/OpenBLAS/libomp compilation with no
  prebuilt binaries, so it can't be a hard dependency for zero-setup
  `npx agent-nuvira` — the pure-JS IVF-flat backend provides FAISS-style
  behavior portably

### Added

- **Vector retrieval — token-efficient context** — large gathered contexts are chunked (~512 tokens, paragraph-aware, 64-token overlap), embedded locally with `bge-small-en-v1.5` via @huggingface/transformers (zero new deps, 384-dim so the vector schema is unchanged), and reduced to the top-k semantically-relevant chunks before the LLM call — saving tokens so free quotas stretch further (complements the quota ledger: retrieval SAVES, ledger MANAGES). Small contexts pass through untouched (zero overhead); any retrieval failure fails over to the full context (never breaks the LLM call). Wired into `chat --file` (chunk reduction) and `buff execute` (post-gather semantic file ranking for the writer + token-savings stats). New `buff retrieval index/query/stats/clear` CLI, `routing.retrieval` config (enabled/topK/chunkTokens/overlapTokens/thresholdTokens/model), and a dashboard 🧠 Retrieval card (tokens saved, avg reduction, repo chunks, latest hits)
- **VectorStore namespaces** — each namespace gets its own index file (`vectors.json` default, `vectors-<ns>.json` otherwise) so repo retrieval chunks never pollute memory/history vectors; entry format unchanged so existing vectors survive upgrades
- **Embedder model override** — `embed()` accepts a model param (default `all-MiniLM-L6-v2` for memory/history; `bge-small-en-v1.5` for retrieval); cache key includes the model

- **Always-on dashboard quota watcher** — new `routing.alwaysWatchQuota` config flag: when enabled, the dashboard's quota file watcher arms at server start and is **never disarmed by client count**, so the Failover Timeline is already current the moment a dashboard connects even after the server sat idle between viewing sessions (was: armed only while an SSE client was connected). Test hook `setAlwaysWatchQuota()` / `isQuotaWatcherArmed()` exported for hermetic tests
- **Single-shot Auto failover confirmation** — `routing.promptOnFailover` now also applies to one-shot Auto prompts (`buff chat "..." -m auto`): before silently hopping to the next candidate, the CLI asks (switch recommended / pick manually); choosing "manual" surfaces the original provider error instead of switching behind your back. Previously the confirmation prompt only ran in the interactive chat loop

## [1.45.5] - 2026-08-02

### Added

- **Opt-in failover confirmation** — `routing.promptOnFailover: true` makes Auto mode ASK before a mid-session provider swap: when a provider dies (expired key, exhausted quota, deprecated model), the CLI shows the next-ranked candidate and offers "switch (recommended)" or "pick a provider myself" instead of silently auto-switching. Default stays silent auto-failover (never get stuck). New unit-tested `src/cli/failover-prompt.ts`

## [1.45.4] - 2026-08-02

### Added

- **Real-time quota events over SSE** — the dashboard server now watches
  `quota-events.jsonl` / `quota-ledger.json` in the memory dir and pushes a
  dedicated `quota` SSE event the moment a failover, park, or window reset is
  written (from the CLI, chat failover, or any process sharing `BUFF_MEMORY_DIR`)
  — the Failover Timeline updates instantly instead of waiting for the next 10s
  refresh tick. The watcher is armed only while a dashboard client is connected
  and disarmed when the last one disconnects; debounced so rapid append bursts
  coalesce into a single push
- **Frontend `quota` SSE handler** — `api.ts` merges the pushed quota payload
  into `routing.quota` and notifies subscribers, so the Quota card + Failover
  Timeline re-render in real time (mirrors the existing `dag` event pattern)

## [1.45.3] - 2026-08-02

### Added

- **Quota failover timeline** — a persistent event log (`~/.buff/memory/quota-events.jsonl`, capped at 200 events) records when providers are **parked**, **re-enabled** (window reset), **released** (manual), or **failed over** mid-session (auth/rate-limit). Chat's auto-mode failover bookkeeping writes `failover` events directly; the ledger's park/release/window-roll paths write the rest (assessment item #7: "show which models were used and when failover occurred")
- **Dashboard Failover Timeline card** — the 📒 Quota Ledger panel now renders the recent event timeline (type, provider, reason, time) from `/api/routing` (`quota.events`, newest first, max 50, corrupt-line-safe)
- **CLI failover timeline** — `buff model quota` shows the last 20 events in the human output and includes them as `events` in `--json` — and renders them even when the ledger has no usage entries yet (failovers can precede any successful call)

### Fixed

- **Empty-ledger dashboard timeline** — `readQuotaData()` previously returned without the `events` field when no `quota-ledger.json` existed, hiding the failover timeline; it now always includes events

## [1.45.2] - 2026-08-02

### Added

- **`buff model quota` cost summary** — the quota CLI now renders a free/local-first
  cost section (free tokens/requests vs paid tokens/requests + an estimated $ saved
  figure) and includes the same `costSummary` in `--json` output, mirroring the
  dashboard's Quota card (assessment item #7 transparency: tokens saved / paid usage
  triggered)
- **QuotaLedger.getCostSummary()** — the ledger now exposes a shared free/paid
  classification + savings estimate (local + Gemini free tier = free; everything
  else = paid; conservative $0.0005/1K blended paid rate), window-rotated so the CLI
  summary always agrees with the status table rendered above it
- **Checkpoint CLI smoke tests** — `--checkpoint` / `--resume [id]` /
  `--checkpoint-list` option mapping is now covered in `tests/cli/execute.test.ts`
  (empty-list hint, listing with progress %, `--checkpoint-list` routing, resume-id
  round-trip, and the four `checkpointOptions()` flag combinations)

### Changed

- `src/cli/execute.ts` — checkpoint flag mapping extracted into an exported pure
  helper `checkpointOptions(checkpoint, resume)` so the option wiring is
  unit-testable and the `checkpoint: options.checkpoint || !!options.resume`
  semantics are preserved exactly (plain runs never checkpoint by default)
- `src/agents/test-module.ts` — sandboxed test runs now **skip `npm install` when
  the project declares zero dependencies**, fixing a flaky CI test caused by a
  network-bound npm install on dep-less temp projects; sandboxing is faster and
  hermetic for offline/CI environments

### Tests

- `tests/learning/quota-ledger.test.ts` — 3 new `getCostSummary()` tests (free/paid
  classification + savings math, zeroed empty ledger, unknown providers = paid)
- `tests/cli/execute.test.ts` — 5 new checkpoint CLI smoke tests

---

## [1.45.1] - 2026-08-02

### Fixed

- **`--checkpoint` no longer silently resumes a stale checkpoint** — plain
  `buff execute "<goal>" --checkpoint` (no resume intent) previously loaded any
  prior checkpoint at the auto id (goal + cwd) — including a previously
  **completed** run — and re-entered it, skipping every task and reporting
  success without doing work. The checkpoint LOAD is now gated strictly on
  resume intent (`--resume` / `resumeRequested` / explicit id); `--checkpoint`
  always starts fresh while still saving forward. A resumed run (including
  direct API callers that only set `resumeRequested`) keeps checkpointing
  forward. Regression test covers the stale-checkpoint case

## [1.45.0] - 2026-08-02

### Added

- **Checkpoint / resume** — `buff execute "<goal>" --checkpoint` saves a
  resume-able snapshot after every task batch (task plan with per-step
  statuses, artifacts, file changes, metadata) to `~/.buff/memory/checkpoints/`
  (honors `BUFF_MEMORY_DIR`). A crash / quota kill / token expiry mid-pipeline
  no longer restarts the whole plan: `buff execute "<goal>" --resume [id]`
  rehydrates the vault and continues from the first pending step, skipping
  completed steps and the planner entirely (assessment item #6: continuity
  across models). Bare `--resume` auto-finds the id for the current goal + cwd;
  `--checkpoint-list` shows saved checkpoints
- **Quota cost-transparency card** — the dashboard's 📒 Quota Ledger panel now
  splits tracked usage into **free/local tokens** (local + Gemini free tier —
  $0) vs **paid tokens** (actual spend triggered), shows the free-tier share of
  usage, and an **estimated $ saved** figure (free tokens × conservative paid
  rate). Assessment item #7: show users which models were used and how
  free/local-first routing saved money

### Tests

- New `tests/agents/checkpoint-store.test.ts` (save/load round-trip,
  deterministic auto id, listing, corrupt-file handling, function-field
  stripping)
- Orchestrator checkpoint-resume regression tests (resume skips completed steps
  + planner; fresh pipeline on missing id)

## [1.44.0] - 2026-08-02

### Added

- **Central quota ledger** — `QuotaLedger` tracks tokens/requests per provider ×
  model with calendar-aware reset windows (daily/hourly free-tier limits).
  Exhausted providers are **parked** (excluded from Auto routing) until the
  window rolls — automatic re-enable at the exact reset boundary, no timers.
  Every LLM call write-throughs usage via `CostTracker.recordCall`. Persists to
  `~/.buff/memory/quota-ledger.json` (honors `BUFF_MEMORY_DIR`); all writes
  best-effort
- **Predictive quota-aware routing** — Auto routing sinks quota-parked providers
  below healthy candidates BEFORE a call is made (previously only reactive
  failover). Wired into the AutoModelRouter, chat, and orchestrator
- **Free/local-first gate** — `routing.allowPaid: false` excludes PAID providers
  for non-complex tasks (trivial/simple/moderate) so free/local models win unless
  complexity demands otherwise; complex/critical tasks may still use paid
  high-capacity models. Falls back safely if the gate would eliminate everyone
- **Per-subtask complexity labels** — the Planner now emits a `complexity` label
  per `TaskStep` (trivial → critical); the orchestrator labels any step lacking
  a valid label and threads the label into routing as `complexityHint`, so each
  subtask routes by its OWN complexity, not the whole goal's
- **`buff model quota` CLI** — inspect the ledger (tokens/requests per
  provider × model, resets in, parked state), `--json` for scripting, and
  `reset` to clear
- **`routing.quota` config** — per-provider `tokensPerWindow` /
  `requestsPerWindow` / `windowMs` limits via `buff config set routing.quota.<provider>.*`
- **Mid-session failover persistence** — rate-limit failures now park the
  provider in the central ledger, so the exclusion survives across chat sessions
  (auth failures stay permanent, never re-enabled by a window roll)
- **Dashboard quota card + DAG complexity badges** — the web dashboard's
  🤖 Routing panel shows live quota status; DAG nodes display their complexity
  label
- **Assessment-gap roadmap** — [ASSESSMENT_OPPORTUNITIES.md](ASSESSMENT_OPPORTUNITIES.md)
  maps the coding-assessment recommendations (cost-efficient tier routing,
  quota ledger, graceful failover, cost transparency) to implementation status

### Tests

- New `tests/learning/quota-ledger.test.ts` (usage recording, window rotation
  auto re-enable, exhaustion parking, `getBestAvailable` never-empty, persistence)
- New `tests/learning/quota-routing.test.ts` (complexityHint, allowPaid gate,
  quota-sink ranking)
- Orchestrator regression test for per-step complexity labeling

## [1.43.0] - 2026-08-02

### Added

- **Startup progress feedback (first-run UX)** — `agent-nuvira` now shows a live
  spinner with phase text while starting up (`⚙️ Loading plugins…`,
  `⚙️ Initializing history & search…`, `📦 Building semantic search index…`) so a
  cold start never looks like a silent hang. Ora auto-suppresses when stdout is
  not a TTY, keeping piped output clean
- **Model-picker loading progress** — provider availability checks now show a
  spinner, print per-provider loading progress, and each `isAvailable()` /
  `listModels()` call is wrapped in a timeout so one hanging provider can't
  stall first run or `model switch`
- **Live model-list cache (60s TTL)** — `model-validator.ts` caches
  `listModels()` results for 60 seconds (was: re-fetched on every auto-routed
  chat message, a real per-message latency cost). Failures are not cached.
  `buff config set providers.*` clears the cache immediately so a new
  key/model/baseURL takes effect right away

### Fixed

- **Auto-mode failover on token expiry** — when Auto routing picked a provider
  whose API key/token expires mid-session (Gemini token-limit errors, OpenRouter
  401s, quota exhaustion), chat used to get stuck re-failing on the same
  provider. Now the session **remembers failed providers** and Auto routing
  routes around them: auth failures (expired key) exclude the provider for the
  whole session, rate-limit failures for a 120s cooldown (aligned with the
  circuit breaker), and 5xx/network errors flow through the circuit breaker
  only. In-cooldown providers are deprioritized by router scoring, the final
  fallback always prefers a non-failed provider, and the failover is
  crash-proof — a throwing re-route can't kill the interactive loop
- **Broader rate-limit classification** — `classifyFallbackError` (and the chat
  error handler) now recognize `token limit`, `resource has been exhausted`,
  and `insufficient_quota`, so these are labeled "Rate limit" (retryable)
  instead of falling through as unknown

---

## [1.42.1] - 2026-08-02

### Fixed

- **Pre-existing CI test failures (hermetic + cross-platform)** — fixed the five
  environment-dependent test failures that had kept `test-linux.yml` red since
  v1.41.1: `model.test.ts` seeds API keys so the explain JSON has a non-empty
  fallback chain in a fresh-HOME CI; `safe-execution-layer.test.ts` uses a
  hermetic `SandboxManager` stub (Docker-enabled runners);
  `inspect-module.test.ts` skips the unreadable-dir assertion on Windows (no
  POSIX chmod read bits); `history.test.ts` uses `TMPDIR || TEMP || '/tmp'`
  instead of a hardcoded `/tmp`; and the dashboard server tests pin
  `BUFF_MEMORY_DIR` before module import so the suite stays hermetic even when a
  developer exports it in their shell
- **Dashboard memory-dir consistency** — the dashboard server now honors
  `BUFF_MEMORY_DIR` (`MEMORY_DIR = BUFF_MEMORY_DIR || ~/.buff/memory`), so the
  bandit card and the promotion-gate card always read from the same directory as
  the CLI and the learning router

### Added

- **Promotion-gate verdict in the dashboard** — the 🤖 Routing panel now renders a
  live 🎖️ Promotion Gate card (ruflo ADR-150 mirror): promoted / not-promoted /
  collecting-data verdict, sufficiency progress (diverged vs. min decisions), and
  the three criteria — quality >+2%, cost <+1%, latency <+5% — with pass/fail
  chips. Unmeasured latency honestly renders a `○ neutral` chip instead of a
  misleading green pass. Backed by `readPromotionData()` on `/api/routing`
  (also wired into `/api/all` and SSE)
- **CI routing regression guard** — `test-linux.yml` runs the four learning-router
  test files (bandit / promotion gate / auto-router / tier-0) in a dedicated step
  before the full suite, so routing regressions fail fast with a clearly-labeled
  step
- **Dashboard component tests** — first frontend unit tests: the dashboard's own
  vitest + jsdom + Testing Library setup (`src/web-dashboard/vitest.config.ts`,
  `npm test`) covering `PromotionGateSection` rendering states (promoted,
  collecting-data, not-promoted, neutral latency, hidden-empty, absent data), wired
  into CI as a dedicated `Dashboard component tests` step

---

## [1.42.0] - 2026-08-02

### Added

- **Uncertainty-driven escalation (ruflo model-router mirror)** — when the
  bandit's winner has almost no accumulated samples (α+β <
  `routing.escalationMinSamples`, default 8), Auto routing **escalates to the
  next-ranked provider that HAS learned data** instead of committing to a
  cold-start guess — a strictly better cold-start policy. A sanity bound
  (`ESCALATION_WIN_RATE_FLOOR = 0.55`) ensures a learned-but-failing provider
  can never steal routing from a strong cold-start winner. Decisions record a
  `banditEscalation` flag + `| escalated: winner unlearned` explanation marker
- **Per-modelId bandit priors (ruflo ADR-149 mirror)** — the learning router now
  learns per **concrete model**, not just per provider: `modelPriors[complexity]
  [modelId] = Beta(α, β)` shadow state updated alongside provider priors
  (`recordModelOutcome`), so `llama-3.3-70b-versatile` ≠ `openai/gpt-oss-20b`
  within the SAME provider. `resolveModelWithLearning()` keeps the configured
  pin on cold start (deterministic) and picks the best Thompson-sampled
  LEARNED model once data accumulates — the model choice learns too. State file
  bumped to v2 (`router-bandit.json`), CLI shows per-model α/β heatmap
- **Promotion gate / A/B validation (ruflo router-parallel mirror)** — new
  `src/learning/router-promotion.ts` answers "is the bandit actually better than
  the heuristic?" on real trajectories. Every auto-routed task records BOTH the
  deterministic pick and the bandit pick (keyed by agentType+task, bounded at
  64 pending), and `recordOutcome()` finalizes it with the real result to
  `~/.buff/memory/router-promotion.jsonl`. `evaluate()` applies ruflo's THREE
  promotion criteria — quality ↑ > 2%, cost regression < 1%, p95 latency
  regression < 5% — over diverged decisions only, with `sufficient`/`promoted`
  verdicts. Config: `routing.promotionMinDecisions` (default 20). `buff model
  bandit` now renders the gate (human + `--json`); `bandit reset` clears the
  trajectory too

---

## [1.41.2] - 2026-08-01

### Fixed
- **Auto routing only uses working models — no more 401/404 surprises**
  - Picking **Auto** in the model picker now enables per-message routing instead of handing a literal `'auto'` to `resolveProvider()` (which silently fell back to an unconfigured default like OpenRouter with no key → 401)
  - Auto routing **only scores providers that have credentials** configured (`getDefaultAllowedProviders()` filters by `hasRequiredCredentials`), so it never picks a provider that would 401
  - `resolveProvider('auto')` now falls back to the **first provider with credentials** (groq → nim → gemini → openrouter → local) instead of the unconfigured default
- **Model health validation** — Auto routing validates the resolved model against the provider's **live model list** and repairs stale/deprecated/placeholder pins (e.g. Gemini's retired `gemini-2.0-flash-exp` → 404, NIM's `new-nim-model`) to a curated known-working default before sending a request
- **Runtime failover** — if a routed provider still fails at generate time (quota exhausted 429, deprecated model 404 — Gemini's model list can list models a key can't actually use), chat **automatically walks the ranked candidates and answers from the first working provider** instead of crashing; the orchestrator and `benchmark --routing` apply the same model-health validation

### Added
- `src/inference/model-validator.ts` — live-list model validation + curated per-provider working defaults (`resolveWorkingModel`)
- Regression tests: `tests/inference/model-validator.test.ts` (12 tests), `tests/cli/router.test.ts` (4 tests), deterministic auto-routing tests in `tests/cli/chat.test.ts`, credential-filtering tests in `tests/learning/auto-router.test.ts`

> **Note:** this release bundles the previously-unreleased routing work
> (learning bandit, tier-0 deterministic routing, routing rules/hard
> constraints, dashboard routing panels, per-provider model drill-down, VS Code
> extension updates) — everything that shipped in this published tarball.

---

## [1.41.0] - 2026-07-31

### Added
- **`buff model list --json`** — structured JSON output (`{ active, providers: [...] }`)
  for provider/status/availability listing, powering reliable parsing in the VS Code
  extension's model & provider switcher
- **`buff models --json`** — machine-readable per-provider model listing
  (`{ models: [{ provider, providerType, name, id, owner, description }] }`) with pure
  JSON on stdout (no spinner/log decoration). `providerType` is included so consumers can
  switch directly with `buff model switch <provider>/<model>`. Honors `-p` and `-s` filters

### Changed
- `src/cli/models.ts` — new `-j/--json` flag; human output (ora spinner, logger lines,
  results table) is gated behind non-JSON mode so scripting stays parseable
- `src/cli/model.ts` — `model list` gained `-j/--json` output

### Tests
- `tests/cli/models.test.ts` (7 tests) — JSON shape, `providerType` presence, `-p`/`-s`
  filters, pure-JSON stdout, empty-list and fetch-error fallbacks

---

## [1.40.0] - 2026-07-31

### Added
- **`buff eval --routing`** — evaluates the exact provider/model pairs the Auto router
  picks for each eval task (via `getAutoRouter().resolve` with runtime stats), dedupes
  distinct picks with task counts, records each decision to the routing-history store,
  runs the full Agent Evaluation framework against every pick (skipping unavailable
  providers), then ranks the picks by composite score with a 🏆 best-pick summary —
  closing the routing → **reliability** loop (not just response quality). Warns when
  `--provider`/`--model`/`--format` are ignored in routing mode
- **Routing History Store** — `src/learning/routing-history.ts`: records every Auto
  router decision (`recordRoutingDecision`) to `~/.buff/memory/routing-history.json`
  (capped at 500, best-effort writes, `BUFF_MEMORY_DIR` override for tests). Query with
  `getRoutingHistory()` / `getRoutingUsageStats()` / `clearRoutingHistory()`. Sources:
  chat (per message), orchestrator (per auto-routed task), explain (human + `--json`
  snapshots), benchmark `--routing`, eval `--routing`
- **Dashboard Routing Usage + Audit Trail** — the 🤖 Routing panel now shows:
  - **Routing Usage — actual picks over time** — totals, last-24h, per-provider pick
    counts, per-source breakdown (chat/orchestrator/explain/benchmark/eval), and most-
    picked models
  - **Audit Trail — routing decision timeline** — the 30 most recent decisions with
    source badge, winner provider/model, complexity, task, and relative time
  Backed by `readRoutingUsage()` + `readRoutingHistory()` in the `/api/routing` payload
  (also wired into `/api/all` and SSE)

### Changed
- `eval.ts` — `--routing` flag + `runEvalRouting()` (mirrors `runRoutingBenchmark`)
- `chat.ts` / `orchestrator.ts` / `benchmark.ts` / `model.ts` — record routing decisions
  to the history store (sources: chat, orchestrator, benchmark, explain)
- Dashboard frontend — `RoutingInsightsPanel` usage + audit sections; `types.ts` extended
  with `RoutingUsage` / `RoutingHistoryEntry`
- Docs — README (`eval --routing` example), User_Manual (Auto Model Routing §), Product_Guide
  (feature inventory rows 73–75 + Key Upgrades rows)

### Tests
- `tests/learning/routing-history.test.ts` (10 tests) — record/get/usage aggregation,
  clear, 500-entry cap, corruption resilience
- `tests/cli/eval.test.ts` (5 tests) — routing mode dispatch, pick dedupe, per-pick suite
  run, comparison table + best pick, unavailable-provider skip, history recording
- `tests/web-dashboard/server.test.ts` — `/api/routing` usage aggregation + audit-timeline
  ordering + missing-file grace (3 new tests)

---

## [1.39.3] - 2026-07-31

### Added
- **`buff benchmark --routing`** — benchmarks the exact provider/model pairs the Auto router
  picks for each benchmark task (via `getAutoRouter().resolve` with runtime stats), dedupes
  distinct picks with task counts, runs the filtered suite against every pick (skipping
  unavailable providers), then ranks them by measured quality with a 🏆 best-pick summary.
  Closes the routing → quality loop: results feed the router's runtime stats. Warns when
  `--provider`/`--model`/`--format` are ignored in routing mode
- **`buff model explain --json`** — machine-readable explain output for scripting and CI.
  Single task → one decision object; no task → all 5 sample complexities. Payload includes
  task, agentType, complexity, taskType, weights, winner, ranked providers (score, reason,
  dimensions, cooldown), fallback chain, and effective per-provider pricing with override flags
- **Explain command now matches production routing** — `renderRoutingDecision` resolves with
  `useRuntimeStats: true` (same as chat/orchestrator) so the displayed decision reflects
  benchmark- and agent-stats-adjusted scores
- **Tests (6)** — `tests/cli/model.test.ts`: detailed render, 5-complexity walk, single-task
  JSON, sample-array JSON, `--agent` routing, ranked best-first ordering

### Changed
- `benchmark.ts` — `--routing` flag + `runRoutingBenchmark()`; `BenchmarkRun` type import
- `model.ts` — `-j, --json` option + `buildExplainJSON()`
- Docs — README (explain `--json` + `benchmark --routing` examples), User_Manual (Auto Model
  Routing § + benchmark options), Product_Guide Key Upgrades rows

---

## [1.39.2] - 2026-07-31

### Added
- **Configurable routing pricing** — `buff config set pricing.<provider>.inputPer1K|outputPer1K`
  overrides any provider's per-1K-token cost used by the Auto router's cost dimension
  (deep-merged per provider so both fields survive sequential sets; free tiers default to $0)
- **`buff model explain [task]`** — transparency command showing why Auto routing picks a
  provider/model: detected complexity, task type, dimension weight bars, ranked provider table
  with reasons, winner, and fallback chain. With no task it walks all 5 complexity levels;
  `--agent <type>` routes for a specific agent. Powered by the new `weights` field on
  `AutoRouteResult`
- **Dashboard Routing Insights** — new `GET /api/routing` endpoint + 🤖 Routing dashboard panel
  (nav item, `/routing` route): per-provider benchmark quality (avg quality, pass rate, cost),
  best model per agent type from agent stats, and Auto-router preference across complexity
  levels. Wired into `/api/all` and SSE init/refresh payloads

### Changed
- `auto-router.ts` — `getProviderPricing()` resolves config override ?? built-in table;
  `estimateCallCostUsd` / `computeCostScore` accept optional pricing overrides
- `config/manager.ts` — `pricing` config section loaded, deep-merged, and saved
- `config.ts` — `buff config set pricing.*` + `buff config list` pricing section
- `model.ts` — `explain` subcommand registered
- `web-dashboard/server.ts` + React frontend — routing insights API, `RoutingInsightsPanel`,
  rebuilt dashboard assets
- Docs — README, User_Manual (Auto Model Routing §), Product_Guide Key Upgrades rows

### Tests
- config manager: pricing default/load/merge/save + sequential-save regression (5 tests)
- auto-router: pricing overrides (5) + result weights (2)
- dashboard server: `/api/routing` empty/fixture/malformed + `/api/all` routing field (4 tests)

---

## [1.39.1] - 2026-07-31

### Added
- **Real provider pricing in Auto routing** — `PROVIDER_PRICING_PER_1K` table with actual
  per-1K-token list prices (input/output) per provider; the cost dimension score is now derived
  from real pricing via `estimateCallCostUsd()` / `computeCostScore()` instead of static profiles.
  Free tiers (local, Gemini) score 1.0; OpenRouter priced at GPT-4o-class pass-through. Opt out
  per call with `useRealPricing: false`.
- **Runtime-stats-driven routing** — `useRuntimeStats` option blends real benchmark quality
  scores into the reasoning dimension (70% static / 30% measured) and boosts reliability + reasoning
  for the proven best model of the agent type (from agent-stats). Now enabled by default in
  `buff chat` (`routeMessageAuto`) and the orchestrator's per-task `createAutoRoutedLLM()`.

### Changed
- `auto-router.ts` — pricing table + runtime adjustment pipeline (`loadRuntimeAdjustments`,
  `adjustCapabilitiesForRuntime`)
- `chat.ts` / `orchestrator.ts` — `useRuntimeStats: true` wired into production routing calls
- `Product_Guide.md` — feature inventory row 72 + Key Upgrades entry for Auto Model Routing
- `website/index.html` — 3 new feature cards (Auto Model Routing, Real Provider Pricing,
  Benchmark-Driven Learning); providers card mentions Auto

### Tests
- `tests/learning/auto-router.test.ts` — new pricing suite (7 tests) + runtime-stats suite
  (4 tests), trivial-task expectation updated for real pricing (Gemini free tier wins)

---

## [1.39.0] - 2026-07-31

### Added
- **Auto Model Routing (`AutoModelRouter`)** — "Use the right model for the right task."
  A first-class `auto` model selection option that routes every task to the optimal
  provider/model based on **complexity, cost, latency, privacy, and reliability**:
  - **5-dimension scoring engine** — per-provider capability profiles (reasoning, speed,
    cost, privacy, reliability) weighted by detected task complexity (trivial → cost+speed
    dominate; critical → reasoning+reliability dominate)
  - **Preference modes** — balanced, `performance-first`, `cost-first`, `privacy-first`
    (routes private tasks to the local provider)
  - **Circuit-breaker awareness** — providers in cooldown are deprioritized (excluded unless
    all are in cooldown); fallback chains keep the pipeline running
  - **`buff model switch auto`** — selectable as option 1 in the model picker or via CLI;
    `buff chat` routes every message, `buff execute "<goal>" -m auto` / `--auto-route` routes
    each agent task independently, explicit `--model` always wins
  - **Exports** — `AutoModelRouter`, `getAutoRouter`, `resetAutoRouter`, `isAutoModel`,
    `isAutoProvider`, `computeWeights`, `scoreProvider` from the package index
- **Tests (55)** — `tests/learning/auto-router.test.ts` (44 tests: weights, scoring,
  complexity routing, circuit-breaker, fallback chains, model resolution, singleton) +
  `tests/cli/model-picker.test.ts` updated for the Auto option index shift (12 tests)

### Changed
- `model-picker.ts` — "Auto — Agent decides" is now option 1; model choices shift to 2+
- `chat.ts` — per-message auto routing; `/model` and error-recovery picker selections of Auto
  re-enable auto mode (with inline re-resolution so the retried message uses the routed provider)
- `orchestrator.ts` — per-task `createAutoRoutedLLM()`; `--auto-route` now uses the new engine
  instead of the legacy static agent-model map
- `execute.ts` — new `--auto-route` flag
- `README.md` + `User_Manual.md` — Auto model routing feature bullets, examples, and usage guide

---

## [1.38.1] - 2026-07-31

### Added
- **Documentation: dependency installer** — README feature bullet and User_Manual §7.9
  "Automatic Dependency Installation" (manifest detection, tool-bootstrap table, retry,
  command-based fallback, `autoInstallTools:false` opt-out, telemetry)
- **Runner tool-install tests (20)** — `installTool()` bootstrap paths for npm (no-reinstall,
  Node bootstrap, failure propagation, not-on-PATH), yarn/pnpm, pip (ensurepip, Python-first,
  failure), brew, bundler (gem/Ruby-first/failure), cargo (rustup), go (darwin/winget), dart
  (brew/apt/winget), and unknown-tool error — with `process.platform` override/restore
- **Product_Guide §3.1 rows 70–71 + §7.9 Phase 11** — Cross-Platform Execution & Dependency
  Automation feature inventory and roadmap table
- **Website feature card** — "Auto Dependency Install" added to the features grid (9 cards)

---

## [1.38.0] - 2026-07-31

### Added
- **Cross-platform dependency installer (Runner)** — `RunnerAgent` now auto-installs missing
  project dependencies and bootstrap-installs missing package managers:
  - **11 manifest types detected** — `package.json`/`pnpm-lock.yaml`/`yarn.lock` (lockfiles win),
    `requirements.txt`, `pyproject.toml`, `setup.py`, `Gemfile`, `Cargo.toml`, `go.mod`,
    `composer.json`, `pubspec.yaml`
  - **Tool bootstrapping on all platforms** — npm via brew/apt/dnf/yum/NodeSource/winget/choco/MSI;
    pip via `ensurepip` + Python install; Homebrew via official `NONINTERACTIVE=1` script;
    bundler via gem + Ruby; cargo via rustup; go via brew/apt/winget; composer via getcomposer.org
    into user-writable `$HOME/.local/bin` (no sudo, quoted, `USERPROFILE` fallback); dart via
    Homebrew / Google apt repo / winget
  - **Command-based tool detection** — when no manifest exists, missing interpreters referenced by
    the failing command (`python3`, `node`, `go`, `cargo`, etc.) are installed automatically
  - **Telemetry** — `dependencyInstallTool` / `dependencyInstallToolInstalled` on `RunResult`,
    feeding the eval framework's dependency-install success metric
- **Dashboard: Deps Installed stat** — Agent Evaluation section now shows dependency-install
  success rate alongside tests / composite / recovery / rollbacks; stat grid switched to
  `auto-fit` so both the 4-card benchmark and 5-card eval sections lay out evenly
- **Runner tests** — composer install paths ($HOME/.local/bin, PHP bootstrap, PHP-failure
  short-circuit), interpreter→tool mapping, and failed-command auto-install flow

---

## [1.37.1] - 2026-10-05

### Fixed
- **Provider crash in `buff plan`** — Running `agent-nuvira plan` with an unconfigured default
  provider (e.g., OpenRouter with no API key) crashed with a raw 401 JSON error. Now:
  - Auto-fallback via `getProviderFallback.callWithFallback()` for retryable errors
  - Interactive model picker when provider is unavailable or auth fails
  - Helpful error messages with actionable steps (set API key, run `buff model switch`, use local)
  - Correct env var names per provider (e.g., `nim` → `NVIDIA_NIM_API_KEY`)
- **Provider crash in `buff skill compile`** — Added auto-fallback to `callLLM` in `compileSkills()`
  so skill compilation doesn't crash with raw provider errors
- **Provider crash in `buff learn patterns --extract`** — Added auto-fallback to `callLLM` in
  `showPatterns()` so pattern extraction handles provider failures gracefully

### Security
- `plan.ts` now detects auth errors (401/403) and shows environment variable configuration hints
  instead of exposing raw API error JSON to the user

---

## [1.37.0] - 2026-10-05

### Added
- **Branch Automation Hooks (Pillar A4)** — Automated branch workflow with 4 trigger sources:
  - **Issue → Branch** — Auto-creates `feat/PROJ-123-description` branches from issue keys with
    configurable branch type (feat/fix/chore) and sanitized naming
  - **PR Label → Update** — Auto-commits changes and pushes to PR branch when labels like `wip`
    or `needs-work` are detected
  - **File Watch → Commit** — Background file-watch script with configurable polling interval
    (default: 60s) that auto-commits with conventional commit messages on change detection
  - **CI Status → Fix** — Analyzes CI failures from git context (recent commits, changed files)
    with LLM-powered diagnosis and actionable fix suggestions
- **Git hooks installer** — Installable post-checkout and pre-commit hooks that detect issue-based
  branches and enforce conventional commit format; hooks are self-identifying (contain 'Agent-Nuvira'
  marker) for clean removal
- **Conventional commit generator** — Rule-based commit type detection from changed files
  (test→test, docs→docs, fix→fix, feat→feat) with LLM fallback for contextual messages
- **`--auto-branch` flag** — New CLI flag for `buff execute` enabling branch automation workflows
- **Module registry** — `branch-automation` agent type registered in ModuleRegistry

### Files
| File | Change |
|---|---|
| `src/agents/agents/branch-automation-agent.ts` | **NEW** — BranchAutomationAgent (400+ lines)
| `src/agents/agents/branch-automation-hooks.ts` | **NEW** — Git hooks manager (250 lines)
| `src/agents/module-registry.ts` | **MODIFIED** — Added agent registration
| `src/cli/execute.ts` | **MODIFIED** — Added `--auto-branch` flag + `ExecuteOptions.autoBranch`

---

## [1.36.0] - 2026-10-04

### Added
- **Real-Time Token Streaming in AgentPanel (Pillar B2)** — Live streaming output with
  typewriter effect in the agent progress panel:
  - **Streaming display** — Streaming container with blinking cursor, animated live dot,
    and monospace output area appears below phase indicators when tasks run
  - **Real-time chunk emission** — `CLIManager` now emits `onStreamChunk` callbacks for
    every stdout data event, enabling token-by-token display
  - **Code block detection** — Chunks containing ``` markers are styled with specialized
    token coloring (`.token-code`, `.token-keyword`, `.token-string`, `.token-comment`,
    `.token-error`, `.token-emphasis`)
  - **Auto-scroll** — Output area auto-scrolls to show latest tokens as they arrive
  - **Completed indicator** — After streaming ends, the header label changes from
    "streaming" to "completed" in green, and content stays visible until next task
  - **Clean lifecycle** — `startStreaming()` before each task, `completeStreaming()`
    after both success and error paths, `clearAll()` resets streaming state

### Changed
- `vscode-extension/src/cliManager.ts` — Added `onStreamChunk` callback, emits chunks
  with code block detection on every stdout data event
- `vscode-extension/src/agentPanel.ts` — Added streaming container HTML/CSS/JS,
  `startStreaming()`, `updateStreaming()`, `completeStreaming()` methods
- `vscode-extension/src/commands.ts` — Wired streaming lifecycle: CLI → panel → webview

---

## [1.35.1] - 2026-10-04

### Fixed
- **Missing runtime dependency** — Moved `typescript` from `devDependencies` to `dependencies`
  in `package.json`. The `ts-adapter.ts` and `transform.ts` modules import the TypeScript
  Compiler API at runtime (`import * as ts from 'typescript'`), but it was only listed as a
  devDependency. When installed globally via `npm install -g`, devDependencies are skipped,
  causing `ERR_MODULE_NOT_FOUND`. Now correctly installed as a regular dependency.

### Dependency Audit
- Cross-referenced all `src/` imports against `package.json` — only `typescript` was
  misclassified; all other packages (commander, ora, inquirer, chalk, @huggingface/transformers)
  were correctly categorized.

---

## [1.35.0] - 2026-10-04

### Added
- **Chat Panel v2 — DAG Pipeline Visualization (Pillar B6)** — Live multi-agent pipeline
  visualization inline in chat messages for slash commands:
  - **SVG DAG renderer** — Standalone `dagRenderer.ts` ported from React DAGView to vanilla JS;
    renders colored agent nodes with icons, status badges, edge curves, step details table, and legend
  - **16 agent types** — Planned, gatherers, writers, reviewers, testers, debuggers, security, git,
    packages, releases, triage, PR review, GitLab, skills, MCP with distinct icons/colors
  - **Real-time pipeline detection** — Parses CLI output for agent markers (📋 planner, ✏️ writer,
    👁️ reviewer, 🧪 tester, ✅/❌ complete/fail) and builds DAG state incrementally
  - **Live indicator** — Animated glow for running nodes, pulsing LIVE badge, status summary bar
  - **Fade-in animations** — Smooth entry for pipeline container and node updates
  - **Empty state** — Helpful placeholder when no pipeline is active, with command suggestions
- **Issue Triage Engine (Pillar A3)** — Automated issue classification, prioritization, and labeling
  across GitHub and GitLab:
  - **LLM-based classification** — Classifies issues as bug, feature, question, docs, or chore using
    a structured JSON prompt with configurable temperature (0.2) and explicit classification guidelines
  - **Priority assignment** — Assigns critical, high, medium, or low priority with emoji indicators
  - **Difficulty estimation** — Estimates issue complexity: easy, medium, or hard
  - **Label management** — Suggests and auto-applies labels (creates missing labels on GitHub repos)
  - **Triage comments** — Posts structured markdown table comments with classification, priority,
    difficulty, reasoning, and suggested action
  - **Git blame expertise heuristic** — Infers suggested assignee from git blame on files mentioned
    in the issue body (extracts file paths from backtick references)
  - **Multiple operations**: `triage-all` (all unlabeled), `triage-specific` (#N), `classify` (#N),
    `list-unlabeled`
  - **Auto-source detection** — Detects GitHub vs GitLab from keywords, tokens, or git remote;
    auto mode tries both platforms with clear error messages
  - **Robust LLM response parsing** — Supports valid JSON, markdown-wrapped code blocks, and
    malformed responses with validation fallbacks for all classification fields
- **Module registration** — `issue-triage` agent type registered in ModuleRegistry with metadata

### Files
| File | Change |
|---|---|
| `src/agents/agents/issue-triage-agent.ts` | **NEW** — IssueTriageAgent (550 lines)
| `src/agents/module-registry.ts` | **MODIFIED** — Added agent registration
| `tests/agents/issue-triage-agent.test.ts` | **NEW** — 46 unit tests

---

## [1.34.0] - 2026-10-03

### Added
- **Code Lens Actions (Pillar B5)** — Clickable `$(sparkle) AI: <name>` lenses above functions and classes
  in VS Code. Click opens a quick pick menu with 4 agent actions:
  - **Test** — Generate unit tests for the function/class
  - **Review** — Review for bugs, security, and style issues
  - **Explain** — Explain the code in detail
  - **Quick Fix** — Fix issues in the code
- **Language support** — TypeScript, JavaScript, Python, Go, Rust, Java — with regex-based declaration
  detection and brace-counting body range extraction
- **Quick pick UX** — Single lens per declaration, menu-based action selection with descriptions
- **Error handling** — Try/catch wrapper with user-facing notification on CLI failures

### Changed
- `vscode-extension/src/extension.ts` — Registered CodeLensProvider, single `lensCommandId` handler
- `vscode-extension/package.json` — No menu additions (all interactions via CodeLens click)

### Files
| File | Change |
|---|---|
| `vscode-extension/src/codeLensProvider.ts` | **NEW** — CodeLensProvider with quick pick menu (1,243 lines)

---

## [1.33.0] - 2026-10-02

### Added
- **VS Code Chat Panel (Pillar B1)** — Multi-turn AI chat panel directly in VS Code:
  - Streaming responses via `agent-nuvira chat --stream --no-color` CLI subprocess
  - 6 slash commands: `/fix`, `/review`, `/test`, `/explain`, `/workflow`, `/help`
  - File context: "Add File" button attaches active editor content as context
  - Code block rendering with "Apply to File" button
  - Conversation history sidebar with session management (new, switch, delete)
  - Sessions persisted across restarts via `workspaceState`
  - Slash command autocomplete with arrow key navigation
  - Welcome screen with quick command buttons
  - Keybinding: `Ctrl+Shift+A C` (mac: `Cmd+Shift+A C`)
- **Diagnostic → AI Fix (Pillar B3)** — "Fix with Agent-Nuvira" in VS Code lightbulb menu:
  - Detects diagnostics (red squiggles) and groups by line
  - Captures error message, affected code range, and 3-line surrounding context
  - Sends targeted fix prompt to CLI
  - Shows diff preview with Apply/Reject workflow
  - Falls back to showing raw output as new editor document
  - Retry on failure with error notification

### Changed
- `vscode-extension/src/extension.ts` — Registered ChatPanel, DiagnosticFixProvider, CodeLensProvider
- `vscode-extension/package.json` — Added `openChat` command, `Ctrl+Shift+A C` keybinding, chat activity bar view
- Status bar now opens Chat Panel instead of old Agent Panel

### Files
| File | Change |
|---|---|
| `vscode-extension/src/chatPanel.ts` | **NEW** — Chat webview panel controller (280 lines)
| `vscode-extension/src/chatPanel.html` | **NEW** — Chat webview HTML+CSS+JS template (520 lines)
| `vscode-extension/src/chatProvider.ts` | **NEW** — Chat history provider with workspaceState persistence (260 lines)
| `vscode-extension/src/diagnosticFixer.ts` | **NEW** — Diagnostic fix CodeActionProvider (280 lines)
| `vscode-extension/src/extension.ts` | **MODIFIED** — Registered all B1+B3 components
| `vscode-extension/package.json` | **MODIFIED** — Commands, keybindings, views

---

## [1.31.0] - 2026-09-30

### Added
- **TS Compiler API Wrapper (Phase 11)** — `src/editing/ts-adapter.ts` — Proper TypeScript Compiler API
  integration with `parseSourceFile()`, `findStructuralNodes()`, `findNodeByName()`, `findNodeAtPosition()`,
  `nodeToRange()`, `getBodyRange()`, `validateTSSyntax()` (uses `parseDiagnostics`), `replaceNodeText()`, and
  `insertAt()` — provides parser-level accuracy for all TS/JS editing operations
- **Structural Transformations (Phase 11)** — `src/editing/transform.ts` — Real code transformations:
  `renameSymbol()` (regex word-boundary replacement), `extractFunction()`, `inlineFunction()`,
  `addParameter()`, `changeSignature()`, and `detectTransformType()` NLP heuristic mapper
- **Two-Tier Editing Engine (Phase 11)** — `src/editing/edit.ts` rewritten with `tryFindNodeTS()` helper:
  all 7 operations (replaceFunctionBody, addMethodToClass, insertBefore, insertAfter, deleteNode,
  performEdit, buildStructuralContext) try the TS Compiler API first, fall back to regex — giving
  TS/JS files parser-level accuracy while supporting Python/Go/Rust via regex
- **Phase 11 Unit Tests** — 66 new tests across two suites:
  - `tests/editing/ts-adapter.test.ts` (40 tests) — parsing, node finding, body ranges, validation, text manipulation
  - `tests/editing/transform.test.ts` (26 tests) — all 5 transformation operations + NLP detection

### Changed
- `src/editing/edit.ts` — Replaced all `await import()` dynamic imports with clean static imports;
  replaced fragile regex-based structural analysis with TS Compiler API tier (for TS/JS) + regex fallback
  (for Python/Go/Rust)
- Marked unused imports cleanup (nodeToRange, replaceNodeText, insertAt) in transform.ts

### Tests
- 66 new Phase 11 tests — all passing ✅
- Total module tests: ts-adapter (40) + transform (26) = **66 Phase 11 tests**

---

## [1.30.0] - 2026-09-30

### Added
- **Unit tests: CredentialStore** — 357-line test suite covering constructor auto-detection, canPush/canPublish getters, collectAll() flow, setupGitCredentials() (GIT_ASKPASS, SSH agent), setupNpmAuth() (.npmrc injection), cleanup(), and module-level helper functions
- **Unit tests: PhaseExecutionEngine** — 560-line test suite covering createScope(), getNextPhase(), getProgress(), saveScope()/loadScope(), listSavedScopes()/deleteScope(), executePhase() (success/failure/exception/edge cases), executeScope() (sequential/resume/failure/credential collection)
- **Phase 10 documentation** — README roadmap table (10.1-10.4), version history (v1.29.0), Phase-Wise Feature Summary (4 new entries)
- **Product_Guide Phase 10** — Feature inventory items 66-69, section 7.8 with detailed phase table
- **Website stats update** — Architecture highlights: 10/10 Phases Complete, 10/10 Modules Extracted

### Changed
- Updated README, Product_Guide, and website to reflect Phase 10 (Autonomous Publish & Phase-Wise Execution) progress

### Tests
- 80 new tests: 357 lines credential-store, 560 lines phase-engine — all passing ✅

---

## [1.29.0] - 2026-09-30

### Added
- **CredentialStore** — Interactive Git/npm credential collection with GIT_ASKPASS setup, SSH key passphrase handling, .npmrc token injection, and auto-detection from env vars | `src/agents/credential-store.ts`
- **PhaseExecutionEngine** — Multi-goal project scope execution with save/resume across restarts | `src/agents/phase-engine.ts`
- **Publish command** — `buff publish` — 5-phase autonomous pipeline: test verification → version bump → git commit/tag/push → npm build/publish → GitHub release | `src/cli/publish.ts`
- **Phase command** — `buff phase create/execute/resume/status/list/delete` — phase-wise project execution | `src/cli/phase.ts`
- **GitAgent: git push + tag push** — `pushToRemote()`, `createAndPushTag()`, `pushTagToRemote()`, `autoPush()` with credential-aware error messages (auth failures, missing remote, network errors)
- **PackageAgent: fullPublish pipeline** — `fullPublish()` chains version bump → build → publish with auto npm auth detection from env vars or .npmrc

### Changed
- GitAgent now supports `git push`, `git tag -a`, and `git push --tags` operations — previously only local commit was supported, no remote push capability
- PackageAgent now auto-detects npm auth via `NPM_TOKEN` env var or `.npmrc` before publishing, with clear error messages for auth failures
- CLI router registered `PublishCommand` and `PhaseCommand` as new top-level commands
- All new modules exported from `src/index.ts` for SDK access

---

## [1.28.0] - 2026-09-29

### Added
- **Phase 9 documentation** — README, Product_Guide, and User_Manual updated with SafeExecutionLayer entries
- **README roadmap table** — Added Phase 9: Safe Execution Layer (9.1 SafeExecutionLayer, 9.2 VerifyModule EventBus tests)
- **README version history** — v1.26.0 (Phase 9 SafeExecutionLayer + 32 tests) and v1.27.0 (website/SVG updates)
- **README Phase-Wise Feature Summary** — SafeExecutionLayer (Phase 9) entry with 3-domain safety system description
- **Product_Guide feature inventory** — Item 65 for SafeExecutionLayer, new section 7.7 with detailed module table
- **User_Manual Phase 6 table** — SafeExecutionLayer (Phase 9) entry added with full description

### Changed
- Product_Guide.md migration summary updated from "8 modules" to "9 modules"
- All 3 docs now consistently reference Phase 9 / SafeExecutionLayer across all section types

---

## [1.27.0] - 2026-09-29

### Added
- **Website v1.26.0 updates** — Phase progress updated to "9/9" phases and modules extracted; test count to 2,207; architecture header from Phase 1→8 to Phase 1→9
- **Migration roadmap SVG** — Added Phase 9 (SafeExecutionLayer) timeline circle, card with 3 capabilities, Row 11 comparison entry, extended metrics/footer
- OG/twitter meta descriptions updated to 2,207+ tests

---

## [1.26.0] - 2026-09-29

### Added
- **SafeExecutionLayer (Phase 9)** — `DefaultSafeExecutionLayer` unifying three safety domains:
  - **File validation** — file size guard (default: 100KB), .gitignore compliance detection, AST syntax
    validation (TS/JS/Python/Go/Rust), security scan of file content via `runAllScans()`
  - **Sandboxed execution** — Docker container isolation via `SandboxManager`, resource limits
    (CPU/memory), timeout enforcement, automatic container lifecycle (create/copy/exec/destroy)
  - **Safe LLM calls** — prompt injection guardrail (blocks injection patterns before sending),
    configurable prompt length cap (default: 128K chars), exponential backoff retry (up to 3),
    circuit breaker for auth errors (401/403), response length cap
- **EventBus events (10 new)** — `SAFE_EXEC_FILE_VALIDATED`, `SAFE_EXEC_SANDBOX_STARTING`/`CREATED`/
  `COMPLETED`/`FAILED`, `SAFE_EXEC_LLM_STARTING`/`BLOCKED`/`RETRY`/`COMPLETED`/`FAILED`
- **VerifyModule EventBus tests** — 9 new tests verifying `VERIFY_STARTING`, `VERIFY_CHECK` (all 4
  check types), and `VERIFY_COMPLETED` emissions

### Changed
- Response truncation in `DefaultSafeExecutionLayer.safeLLMCall()` now uses the `maxPromptLength`
  parameter consistently for both prompt and response capping

### Tests
- SafeExecutionLayer: 23 tests — 11 validateFile (size, gitignore, syntax, security, edge cases,
  events), 10 safeLLMCall (injection, retry, auth skip, truncation, events), 2 executeInSandbox
  (Docker unavailable, events)
- VerifyModule EventBus: 9 tests — event emissions for all verification check types

---

## [1.25.0] - 2026-09-29

### Added
- **Website v1.24.0 updates** — Hero metrics updated to 2,184 tests; Architecture section upgraded from "Phase 1→6" to "Phase 1→8", highlights updated to "8/8" phases, "8/8" modules extracted, "2,184" tests
- **README.md** — Added Phase 6 (Architecture Migration) to roadmap table with 8 sub-phases (6.1–6.8); added Phase 6 section to phase-wise feature summary with 10 module entries
- **Product_Guide.md** — Added feature inventory items 57–64 for all architecture modules; added section 7.6 with detailed 8-module migration table
- **User_Manual.md** — Added Phase 6: Architecture Migration section with 10 module entries (RecoverModule through TestModule)

### Changed
- All documentation now consistently references v1.24.0 release and 2,184+ test count

---

## [1.24.0] - 2026-09-29

### Added
- **ExecuteModule tests** — 24 new unit tests for `DefaultExecuteModule`: execute() with callLLM (happy path,
  npm test validation, command inference), execute() without callLLM (fallback), inferCommand (backtick,
  `Run:` prefix, `run <file>`, npm patterns, file extension), EventBus emissions
  (`EXECUTE_STARTING`/`EXECUTE_COMPLETED`/`EXECUTE_FAILED`)
- **TestModule tests** — 27 new unit tests for `DefaultTestModule`: runTests() with callLLM (vitest,
  jest, generic output formats), runTests() without callLLM (fallback), parseTestOutput (vitest,
  jest, generic, malformed/no match), detectFramework, detectTestCommand, EventBus emissions
  (`TEST_STARTED`/`TEST_COMPLETED`/`TEST_FAILURE`)
- **Migration roadmap SVG** — Updated to Phase 1-8 with Phase 7 (Plan+EditModule) and Phase 8
  (Execute+TestModule) timeline nodes and detail cards in second row; 10-row comparison table;
  updated metrics (8/8 phases, 150+ tests, 8 modules extracted)

### Changed
- Phase 5 badge in migration-roadmap.svg corrected from "IN PROG" to "DONE"

### Tests
- Total module tests: PlanModule (41) + EditModule (34) + ExecuteModule (24) + TestModule (27) = **126 module tests**

---

## [1.23.0] - 2026-09-29

### Added
- **ExecuteModule (Phase 8)** — `DefaultExecuteModule` extracted from `RunnerAgent`: pluggable command
  execution with 5-strategy command inference (backtick, `Run:` prefix, `run <file>`, npm patterns, file
  extension), npm test validation against `package.json`, structured `ExecuteResult` output (stdout, stderr,
  exit code, duration), EventBus integration with `EXECUTE_STARTING`/`EXECUTE_COMPLETED`/`EXECUTE_FAILED` events
- **TestModule (Phase 8)** — `DefaultTestModule` extracted from `TesterAgent`: pluggable sandboxed test
  execution with temp directory creation, project file copying (excluding `node_modules`/`.git`/etc.),
  file change application, dependency installation (npm install), multi-framework test output parsing
  (vitest, jest, generic), `TEST_STARTED`/`TEST_COMPLETED`/`TEST_FAILURE` events

### Changed
- `website/index.html` — Architecture section: `6/6` → `7/8` Phases Complete, `8 Modules Designed` →
  `5/8 Modules Extracted`, test count `2,058` → `2,133`

---

## [1.22.0] - 2026-09-28

### Added
- **PlanModule (Phase 7)** — `DefaultPlanModule` extracted from `PlannerAgent`: pluggable goal decomposition
  with prompt building (goal + file tree + memory context), 3-LLM-response parsing strategies (direct JSON,
  code block, array extraction), step normalization (numeric IDs, null dependsOn, missing fields),
  fallback plan when no `callLLM` provided, and `PLAN_STARTED`/`PLAN_STEP_CREATED`/`PLAN_COMPLETED` events
- **EditModule (Phase 7)** — `DefaultEditModule` extracted from `WriterAgent`: pluggable file change
  generation with prompt building (artifacts + goal + MCP tools), `filepath:` code block parsing,
  AST syntax validation, token-budget-aware file selection (prioritizes smaller files, max 10 files,
  16K char budget), 2-attempt retry loop with rate-limit handling (skip/abort/switch-model/retry),
  mutable `currentCallLLM` for model-switch support, and `EDIT_GENERATING`/`EDIT_WRITTEN`/`EDIT_SKIPPED` events

### Tests
- **PlanModule: 41 new tests** — plan() with/without callLLM, parsePlan (direct JSON/code block/array extraction/
  malformed responses), normalizeSteps (numeric IDs, null dependsOn, missing fields, step filtering),
  EventBus emissions (3 event types, source verification)
- **EditModule: 34 new tests** — edit() happy path (multi-file, new file, unchanged file),
  empty results, LLM errors, rate-limit handling (skip/abort/switch-model), parseFileChanges
  (filepath prefix, spaces, empty blocks), addFileChange (modified/created/identical content),
  validateChanges (valid syntax, syntax warnings, non-source files), token budget, EventBus emissions

---

## [1.21.0] - 2026-09-27

### Added
- **VerifyModule (Phase 6)** — Explicit verification pipeline with `security`, `goal-alignment`, `tests`,
  and `code-quality` check types; low/medium/high strictness levels; pass/fail scoring with configurable
  pass thresholds (0.5/0.7/0.9)
- **LLM-based file classification** — `DefaultInspectModule.classifyWithLLM()` dispatches files to
  specialized agents (debugger, reviewer, tester, mcp-agent, security-agent) based on file content analysis
- **EventBus LoggerConsumer** — Handlers for `VERIFY_STARTING`, `VERIFY_CHECK`, `VERIFY_COMPLETED` events
- **Pipeline PR summary SVG** — 14-agent pipeline flow diagram for the website
- `ROADMAP_TODO.md`, `spec.md`, `spec_roadmap.md`, `spec_upgrade.md` — roadmap and spec documentation

### Changed
- `DefaultInspectModule.scanByKeywords()` — improved walkAndScore with additive keyword scoring,
  depth-5 limit, directory-name matching, symlink skipping
- `DefaultInspectModule.parseClassifyResponse()` — robust JSON extraction with markdown-wrapped,
  malformed, and empty response fallbacks
- **Architecture migration (Phase 6)** — 8-module architecture designed (InspectModule, ReportModule,
  VerifyModule, PlanModule, EditModule, ExecuteModule, TestModule, RecoverModule) with 3 extracted;
  remaining 5 modules scheduled for future phases
- `.gitignore` — added `.DS_Store` to prevent macOS metadata clutter

### Fixed
- **Followup first-letter truncation** — broken regex `\U` (treated as literal `U`, creating range `0-U`
  that stripped letters `A`–`U`) → fixed with `\u{XXXX}` + `u` flag for proper emoji stripping
- **Followup auto-continue** — removed duplicate "What next?" prompt after followup execution;
  followup result now falls through cleanly to the main goal loop
- Redundant `printOrchestrationResult` call in followup dispatch handler (already handled by `runSingleGoal`)

### Tests
- InspectModule tests expanded from **41 → 74 tests** (event spy emissions, walkAndScore scoring,
  parseClassifyResponse edge cases, inspect error handling, symlink/symlink-permission scenarios)
- VerifyModule: **28 new tests** (all 4 check types, strictness levels, dedup, scoring)

---

## [1.20.0] - 2026-09-20

### Added
- **InspectModule (Phase 5)** — codebase scanning wrapper around ContextGathererAgent with keyword
  scoring (+3 name match, +1 path match), depth limiting (5), `.buffignore` pattern support,
  binary/symlink skipping, and LLM-based file classification
- **ReportModule (Phase 4)** — Pluggable report formatters (markdown, JSON, summary, verbose) with
  EventBus integration and 4 structured event types
- **Architecture roadmap SVG** — Visual migration timeline (Phase 1→6) for the website
- **Website provider showcase SVG** — Visual logo grid of 17+ supported AI providers

### Changed
- `DefaultInspectModule` — scanByKeywords now respects `.buffignore` patterns, depth limit (5),
  and skips binary/symlink files
- `website/index.html` — added Architecture Migration section with roadmap SVG and metric highlights
- `website/styles.css` — architecture-visual section with glow hover effects, responsive grid

### Tests
- InspectModule: 41 tests covering inspect(), scanByKeywords(), walkAndScore(),
  parseClassifyResponse(), and keyword-based file discovery

---

## [1.19.0] - 2026-09-15

### Added
- **EventBus** — Structured observability system with 37 typed events and 4 built-in consumers
  (LoggerConsumer, MetricsConsumer, AuditConsumer, MetricsBufferConsumer)
- **Architecture documentation** — `ARCHITECTURE.md` with full 8-module design, extensibility hooks,
  plug-and-play agent lifecycle, and event-driven observability
- **Mermaid architecture diagrams** — `ARCHITECTURE_DIAGRAMS.md` with 5 visual diagrams:
  Module Architecture, Extensibility, Execution Flow, Event Bus Data Flow, Migration Timeline

### Changed
- `DefaultOrchestrator` — wired to EventBus; emits 14 pipeline lifecycle events
- A2A tests — increased timeout to accommodate real Orchestrator initialization
- Documentation expanded with cross-references between ARCHITECTURE.md and all strategic docs

---

## [1.18.0] - 2026-08-29

### Added
- `PRODUCT_STRATEGY.md` — comprehensive product strategy with product thesis, competitive landscape (pricing matrix, 22-dimension feature comparison, positioning map, target user match, competitive advantages), OKR framework (5 objectives, 19 key results), and risk register
- `PITCH_DECK.md` — 10-slide investor presentation outline with talking points, architecture diagrams, traction timeline, business model (3-tier + marketplace), quarterly OKR roadmap, and partnership/investment ask
- `CONTRIBUTING.md` — quick-reference contributor guide with documentation map (12 linked docs), development setup, testing commands, contribution workflow, and area-idea table
- Cross-references to strategic docs in `README.md` (Roadmap callout box) and `Product_Guide.md` (§9 Strategy & Pitch Deck + TOC entry)
- PITCH_DECK.md references to both `README.md` and `Product_Guide.md` alongside existing PRODUCT_STRATEGY.md links

### Changed
- `README.md` — added strategic docs callout box in Roadmap section, extended with PITCH_DECK.md reference
- `Product_Guide.md` — added §9 Strategy & Pitch Deck with docs table and competitive highlights, updated TOC
- `Product_Guide.md` — fixed TOC anchor link for §9 (`strategy-pitch-deck`)

---

## [1.17.0] - 2026-08-28

### Added
- `CHANGELOG.md` — comprehensive version history from v1.0.0 to v1.17.0 following Keep a Changelog format
- Comprehensive Phase-Wise Feature Summary in README, Product Guide, and User Manual
- Version History table in README (v1.0.0 through v1.17.0)
- Agent Catalog table — 13 agent roles with type, description, and version introduced
- Release Phases overview mapping version ranges to development phases

### Changed
- **Product_Guide.md** — updated to v1.16.1 → v1.17.0 alignment, Phase 4 & 5 roadmap completed, version history extended, test counts updated (1620→1830+)
- **User_Manual.md** — updated to v1.16.1 → v1.17.0 alignment, added Phase-Wise Feature Summary, updated key concepts and glossary
- **README.md** — Phase 4 marked complete (6 items), new Phase 5 added (5 items), Version History extended through v1.17.0
- Architecture diagram updated to show all 14 agent roles
- Multi-agent pipeline section enhanced with table format and interactive dev mode documentation

### Fixed
- Product_Guide.md footer version (v1.14.6 → v1.17.0)
- Agent count consistency across all docs (10+ → 15 agent roles & management)

---

## [1.16.1] - 2026-08-27

### Added
- Interactive dev mode enhancements — failure analysis with per-agent-type recovery actions
- Follow-up suggestions — LLM-powered contextual next-step recommendations after goal execution
- `/fix` command — retry last failed goal with failure context, shows post-execution analysis
- 35 new unit tests for failure analysis, follow-up suggestions, and handlePostExecution methods
- Enhanced post-execution UX with dynamic choices (continue, switch model, history, exit, retry-fix, followup)

### Changed
- `/fix` command now shows post-execution actions (consistent with `retry-fix` behavior)
- Session history tracking via shared `handlePostExecution` method
- Comprehensive README update with Phase-Wise Feature Summary, Version History, and Agent Catalog

### Fixed
- ESM module mocking in tests — replaced `vi.spyOn` with `getProviderConfig` throw strategy
- Input validation test — fixed test data that was exceeding the 3-suggestion limit in fallback logic

---

## [1.16.0] - 2026-08-26

### Added
- Comprehensive MCP README documentation with stdio and SSE transport examples
- SSE header support for MCP — Bearer auth and custom headers for remote MCP connections

### Changed
- Firecrawl integration for web search via MCP

---

## [1.15.6] - 2026-08-25

### Added
- Firecrawl integration for web search and scraping

---

## [1.15.5] - 2026-08-24

### Added
- SSE (Server-Sent Events) header support for MCP transport
- Bearer token authentication for remote MCP servers

---

## [1.15.4] - 2026-08-23

### Added
- Search/filter bar for model discovery
- Column count toggle (3/4/5 columns) for model display
- Speech provider section in model picker

---

## [1.15.3] - 2026-08-22

### Fixed
- Accessibility fix — replaced `window.open` with native `<a>` tags in SpeechProviderSection

---

## [1.15.2] - 2026-08-21

### Fixed
- Windows compatibility fixes for runner and sandbox agents

---

## [1.15.1] - 2026-08-20

### Added
- Interactive development mode — `buff execute` without a goal launches a guided loop
- Model picker — interactive provider/model selection at dev mode start
- Session tracking — full goal history within a development session
- `/save <name>` — save development session state to disk
- `/resume <name>` — restore a previously saved session with full history
- `/suggest` — search past trajectories for similar goals

---

## [1.15.0] - 2026-08-19

### Added
- npm publishing — `npx agent-nuvira` / `npx buff` live on npm (1.3 MB package)
- Zero-setup onboarding for new users

---

## [1.14.6] - 2026-07-28

### Added
- Skill Compiler — auto-extracts reusable patterns from successful trajectories into parameterized skill scripts
- Context-Window Memory Pruner — 5 strategies (metadata strip, file collapse, conversation truncation, artifact summarize, aggressive fallback)
- Context-Preserving Model Switching — `buff model switch` changes providers mid-session without losing agent state
- Docker Compose Setup — 5-minute onboarding with multi-stage Dockerfile, health checks, persistent volume
- Project Scaffolding — `buff init` with 5 built-in templates and interactive provider selection wizard

### Technical
- Skill Store with decay scoring, garbage collection, and keyword search
- Token estimation heuristic with 1-token-per-4.5-char ratio
- 156 new tests (84 skill system + 72 context pruner), 1479 total

---

## [1.14.5] - 2026-07-22

### Fixed
- `/exit` command now actually terminates the process (no lingering "You:" prompt)
- Ctrl+C double-press logic moved from process-level to readline handler (first press shows warning, second press exits)
- Process-level SIGINT simplified to immediate exit (appropriate for API-call interruptions)

---

## [1.14.4] - 2026-07-20

### Added
- Rate-limit header parsing across all cloud providers (7+ header naming conventions)
- Green/Amber status based on real quota data (>20% = Green, ≤20% = Amber)
- New "Quota" column in dashboard models table

### Fixed
- OpenRouter models now correctly reflect rate-limit status

---

## [1.14.3] - 2026-07-18

### Added
- Interactive error recovery on API failures (retry, switch provider, cancel, exit)
- Seamless provider switching preserves all conversation history

### Fixed
- Ctrl+C single press now shows warning, second press exits

---

## [1.14.2] - 2026-07-16

### Added
- Web dashboard `/api/models` endpoint with provider health data
- Color-coded model table (Green = working, Amber = limited, Red = unavailable)
- Provider card headers with overall status
- Quota remaining indicator

---

## [1.14.1] - 2026-07-14

### Fixed
- Rename "Agent-Baba-D" to "Agent-Nuvira" in dashboard
- Windows `spawn start ENOENT` error on dashboard launch
- Cross-platform browser opening logic

---

## [1.14.0] - 2026-07-12

### Added
- Full Windows CI test suite (GitHub Actions)
- Multi-line input in interactive chat

### Fixed
- Cross-platform echo commands in runner tests

### Changed
- Published to npm as `agent-nuvira`

---

## [1.13.0] - 2026-07-10

### Added
- Hybrid model routing — complexity-based model selection with cost optimization
- Team collaboration — Git-synced shared config, memory, and review pipelines
- Agent SDK — `@agent-nuvira/sdk` npm package with scaffolding CLI
- Provider fallback routing — auto-failover with circuit breaker and configurable chain
- Security scan CLI — `buff security scan` for PII, injection, and dangerous code detection
- Feedback & rating system — `buff feedback record/list/stats/clear`
- Marketplace unified CLI — `buff marketplace browse/search/install/info`

---

## [1.12.0] - 2026-07-08

### Added
- VS Code extension — 9 commands, inline suggestions, diff viewer, agent progress panel
- Remote agent federation — multi-machine collaboration via TCP protocol
- Web UI dashboard — React dashboard with DAG, health, cost, history, benchmarks
- Shared model picker, spinner UX, model-picker tests

---

## [1.11.0] - 2026-07-06

### Added
- Skill compiler — auto-extracts reusable patterns from trajectories into runnable skills
- Context-window memory pruner — token-aware compression for long agent chains
- Context-preserving model switching — `buff model switch`
- Speech model labeling in model picker

---

## [1.10.0] - 2026-07-04

### Added
- Docker sandbox isolation — resource-limited, network-isolated containers, 8 base images
- Provider health dashboard — `buff doctor` with color-coded status and watch mode
- Human-readable model names in picker
- Categorized model selection (chat, code, vision)

---

## [1.9.0] - 2026-07-02

### Added
- Workflow template marketplace — 10 built-in templates + GitHub registry with install/publish
- Model benchmarking — 21 standardized coding tasks with scoring and A/B comparison
- Model categorization + smart picker

---

## [1.8.0] - 2026-06-30

### Added
- Native embedding support — 3-tier embedder (Xenova/Python/LLM) with LRU cache
- Vector store — cosine similarity search over embedded trajectories
- Trajectory store — few-shot example storage with quality scoring
- Memory integration — context retrieval + storage orchestration

---

## [1.7.1] - 2026-06-29

### Changed
- Rate-limit UX improvements with smart retry logic
- Better error messages for rate-limit errors

---

## [1.7.0] - 2026-06-28

### Added
- Groq LPU integration for fastest open-source model inference
- Streaming support — token-by-token output (Groq, NIM, OpenRouter)
- Plugin system — programmatic API + auto-discovery from `~/.buff/plugins/`
- Cost tracking — per-provider, per-session, monthly cost dashboards

---

## [1.6.0] - 2026-06-25

### Added
- Agent retry logic with exponential backoff (3 attempts)
- Format validation — auto-retry on malformed agent output
- Git integration — branch creation, commit with LLM-generated messages
- PR description generation from git diff

---

## [1.5.1] - 2026-06-20

### Fixed
- Windows CI pipeline fixes

---

## [1.5.0] - 2026-06-18

### Added
- TesterAgent — sandboxed test execution in isolated temp directory
- RunnerAgent — shell command execution with output capture
- DebuggerAgent — iterative test-fix loop using LLM (up to 3 iterations)
- SecurityAgent — prompt injection + secret/PII scanning

---

## [1.4.1] - 2026-06-15

### Fixed
- Bug fixes, Windows compatibility improvements

---

## [1.4.0] - 2026-06-12

### Added
- Multi-agent pipeline (`buff execute` command)
- PlannerAgent — goal decomposition and task planning
- WriterAgent — code implementation with retry logic
- ContextGathererAgent — codebase scanning and file discovery
- ReviewerAgent — code review, bug detection, style checks

---

## [1.3.0] - 2026-06-10

### Added
- Implementation plans (`buff plan` command)
- Codebase-aware plan generation with architecture impact analysis
- Structured plan output (summary, files, architecture, steps, risks, testing)

---

## [1.2.0] - 2026-06-08

### Added
- AI-assisted file editing (`buff edit` command)
- Dry-run mode for safe previews
- File context support

---

## [1.1.0] - 2026-06-05

### Added
- Model discovery — `buff models` with search/filter across all providers
- Provider-specific model listing (Groq, NIM, Gemini, OpenRouter)

---

## [1.0.0] - 2026-06-01

### Added
- Initial release
- Core CLI with 25+ commands via Commander.js
- 5 built-in inference providers (expandable to 17+ via env vars + plugin system): Groq, NVIDIA NIM, Google Gemini, OpenRouter, Local (Ollama/HuggingFace/GGML)
- Interactive chat with conversation history and `/` commands
- Configuration system — JSON config file + env vars + CLI flags priority chain
- SQLite-backed response caching with configurable TTL
- Plugin system foundation
- MIT License

---

## Agent Catalog

### Agent Roles (16)

| Agent | Type | Description | Version |
|-------|------|-------------|---------|
| **PlannerAgent** | Core | Goal decomposition, dependency-aware task planning | v1.4.0 |
| **ContextGathererAgent** | Core | Codebase scanning, file discovery, artifact identification | v1.4.0 |
| **WriterAgent** | Core | Code implementation with retry + format validation | v1.4.0 |
| **ReviewerAgent** | Core | Code review, bug detection, security + style checks | v1.4.0 |
| **RunnerAgent** | Execution | Shell command execution with output capture | v1.5.0 |
| **TesterAgent** | Testing | Sandboxed test execution (temp dir / Docker) | v1.5.0 |
| **DebuggerAgent** | Testing | Iterative test-fix loop via LLM (3 iterations) | v1.5.0 |
| **SecurityAgent** | Safety | Prompt injection, secret/PII, dangerous code scanning | v1.5.0 |
| **GitAgent** | Publishing | Branch creation, LLM commit messages, PR descriptions | v1.6.0 |
| **PackageAgent** | Publishing | Version bump, npm build, publish, changelog generation | v1.6.0 |
| **GitHubReleaseAgent** | Publishing | Tag creation, release notes, GitHub releases | v1.6.0 |
| **SkillRunnerAgent** | Learning | Execute compiled skill scripts as pre-built task plans | v1.11.0 |
| **MCPAgent** | Integration | Invoke MCP tools from connected servers (stdio/SSE) | v1.16.0 |
| **GitLabAgent** | Integration | GitLab MR management, issues, pipelines | v1.32.0 |
| **PRReviewAgent** | Review | GitHub PR review with inline comments + security scans | v1.32.0 |
| **IssueTriageAgent** | Management | Issue classification, prioritization, auto-labeling | v1.32.0 |

### Release Phases

| Phase | Versions | Description |
|-------|----------|-------------|
| **Phase 0: Foundation** | v1.0.0 – v1.3.0 | Core CLI, chat, edit, plan, 5 built-in providers (expandable to 17+) |
| **Phase 1: Quick Wins** | v1.4.0 – v1.7.0 | Multi-agent pipeline, plugins, streaming, cost tracking |
| **Phase 2: Structural Changes** | v1.8.0 – v1.10.0 | Memory system, workflows, benchmarks, Docker sandbox |
| **Phase 3: Major Upgrades** | v1.11.0 – v1.14.6 | Skills, pruner, VS Code, federation, dashboard, SDK |
| **Phase 4: Industry Standards** | v1.15.0 – v1.16.0 | MCP, A2A, CI/CD, npm publishing, error-repair |
| **Phase 5: Interactive UX** | v1.16.1 | Interactive dev mode, failure analysis, follow-up suggestions, /fix |


