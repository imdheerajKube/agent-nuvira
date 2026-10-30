/**
 * PROJECT-ASSESSMENT PROTOCOL — the evidence rules for "assess this codebase"
 * asks (audit / code review / "find the bugs").
 *
 * WHY THIS EXISTS (the side-by-side audit, 2026-10-16). Two agents on the SAME
 * model (DeepSeek V4.1 Flash), the same prompt, the same small project
 * (`/Users/dheeraj/Documents/cal`, 12 files, ~276 LOC), told not to change
 * anything. One ran the project's own modules and the real page in a browser;
 * the other — this CLI — reasoned over what it had read, re-created the engine
 * by hand inside `code_execution`, and published the copy's output as the app's
 * behaviour. The comparison isolates four defects that are NOT about model
 * quality, because the model was identical:
 *
 *   1. A COPY WAS REPORTED AS THE ARTIFACT. Its top-severity finding said
 *      "typing `alert(1)` into the display and pressing `=` runs the code",
 *      "verified" against a hand-copied engine — while the shipped display
 *      input is `disabled`, the keyboard filter drops every letter, and no
 *      button emits one, so that input cannot be produced at all. The sink is
 *      real and LATENT; the reachability claim was false. Worse, its remediation
 *      ("reject identifiers in the whitelist") does not close the sink, because
 *      a char-code `Function(...)` escape needs only letters, digits, commas and
 *      parens — measured against the real module.
 *   2. NO MEASUREMENT. "`999999999!` hangs the tab indefinitely" — measured on
 *      the real engine it is ~31 s (3.09 s at n=1e8, linear), and the indefinite
 *      case needs more digits than that. A magnitude nobody measured is a
 *      guess wearing a severity label.
 *   3. GREEN TESTS READ AS COVERAGE. The project's 10 tests all pass, and all 10
 *      drive `evaluateExpression` — while the UI buttons call
 *      `evaluateScientific`, which is missing cases for 8 of the 14 buttons. The
 *      tested path is not the shipped path; that gap IS the root cause, and the
 *      audit that stopped at "tests pass" could not see it.
 *   4. THE ANSWER STOPPED MID-SENTENCE. Its report forward-referenced a
 *      "dead code — noted at the end" section, ran out of output budget two
 *      findings later, and ended inside a word. A dangling forward reference in a
 *      truncated answer costs the reader the whole tail of the report.
 *
 * WHAT THIS MODULE IS. A deterministic, LLM-free classifier plus one block of
 * text. It changes what the agent must be able to SHOW for a finding, not the
 * shape of the report: the strengths that run already had — severity labels,
 * exact `file:line`, mechanism, a fix recipe, the artifact-inheritance check
 * (does the built bundle carry the same bug?), and finishing in seconds — are
 * kept and are named in the block as the format to keep.
 *
 * ROUND TWO (the head-to-head audit, 2026-10-16). A second side-by-side run —
 * same model, same prompt, same snapshot, this time on a Python desktop app
 * (`/Users/dheeraj/Documents/anuj_voice`, 60 modules) — scored this CLI's audit
 * against another agent's. It found six defects the five rules above did not
 * cover, and every one is a SHAPE OF CHECK rather than a missing fact:
 *
 *   6. IT READ THE MODULES AND NOT THE SEAMS. The three findings it missed all
 *      lived in the joins: a constant compared against the wrong version
 *      (`_MIN_APP_VERSION = '0.1.0'` gating every real add-on out), a manifest
 *      field parsed and consumed nowhere (`dependencies`), and a recursive
 *      merge that silently drops nested defaults when the file is partial.
 *   7. IT DID NOT RUN THE PROJECT'S OWN TOOLING. The tree shipped
 *      `tools/dead_code_audit.py` and a packaging validator, its plan NAMED the
 *      tools directory, and it ran neither — while a shipped checker was the
 *      artifact that reported the release defect. See `self-check-discovery.ts`.
 *   8. IT CITED A FILE IN THE REPO AS EVIDENCE. It repeated a claim from a
 *      prior `ASSESSMENT.md` sitting in the tree without resolving that file's
 *      own `file:line` references — which were, on measurement, pointing at the
 *      accelerator table rather than the code the claim described.
 *   9. IT ASSERTED A MEASUREMENT IT HAD NOT TAKEN. Its plan reported
 *      `14 failed / 422 passed` before any command in the transcript had run,
 *      and its appendix documented a command that does not reproduce those
 *      numbers. Both are provenance failures, not the model being wrong.
 *  10. IT ASKED A USER WHO WAS NOT THERE for permission to run a read-only
 *      probe, and self-answered only because the run was unattended.
 *  11. IT LEFT ITS SCRATCH FILES IN THE TREE IT WAS AUDITING.
 *
 * Rules 6-11 are the mechanical half of that gap: four of them are checks the
 * agent can perform on its own output before delivering it.
 *
 * NARROWNESS IS THE DESIGN. The block is injected ONLY for an assessment ask: a
 * change request ("fix the bug", "add tests") must be byte-identical to a build
 * without this feature, which is why {@link isProjectAssessmentGoal} requires an
 * explicit finding/audit shape rather than the word "review" on its own. An
 * authored ask is excluded via the existing deliverable taxonomy, so "write a
 * review of this novel" never gets a bug-hunting protocol.
 */

import { isLongFormAuthoredGoal } from './deliverable-class.js';

/**
 * Verbs that ask for judgement ABOUT the code rather than a change TO it.
 * `analyse`/`analyze` are here because "analyse the codebase" is the same ask.
 */
const ASSESS_VERBS = /\b(assess|audit|review|critique|inspect|analyse|analyze|evaluate)\b/i;

/**
 * The thing being judged. Required alongside a bare verb so "review this
 * sentence" cannot pull a code-audit protocol into the turn.
 */
const CODE_TARGETS =
  /\b(code\s*-?\s*base|project|repo(?:sitory)?|source\s+tree|files?|modules?|packages?|app(?:lication)?|backend|frontend|api|scripts?|src)\b/i;

/** "find the bugs", "identify issues", "list defects", "spot the risks" … */
const FIND_FLAWS =
  /\b(find|finding|identify|list|spot|locate|uncover|report|surface|hunt\s+for|look\s+for)\b[^.!?]{0,60}\b(bugs?|issues?|defects?|problems?|flaws?|vulnerabilit(?:y|ies)|smells?|errors?|risks?|weaknesses?|bugs?\s+and)\b/i;

/** "what's wrong with this project", "what is broken in the code" … */
const WHATS_WRONG =
  /\bwhat(?:'s| is| are| s)\s+(?:wrong|broken|missing|bad|the\s+(?:bugs?|issues?|problems?|risks?|defects?))\b/i;

/**
 * Verbs that ask for something to be DELIVERED. A goal containing one is a change
 * to the code, so it cannot be judgement about it, however many code nouns the
 * requirements happen to name.
 *
 * WHY THIS EXISTS. Measured 2026-10-26 on the Ultimate Agent Benchmark (a SaaS
 * platform task): the prompt opens "1. Analyse requirements." and then requires a
 * "Node.js backend", a "Next.js frontend" and an "AI Assistant API". `analyse` +
 * `backend` satisfied the verb branch below, so a BUILD was classified as an
 * audit. The visible cost was the wrong protocol block; the measurable one was
 * the budget: the assessment cap is sized by the SOURCE FILES ALREADY PRESENT
 * (`assessmentExtensionCap`), and a greenfield turn starts with none, so the run
 * was granted 2 extensions (115 steps) instead of the build default of 8 — and
 * stopped at 69 files, 0 test files, versus 117 files and 14 test files for the
 * identical prompt on the same model with the build cap. A cap keyed to ``how
 * big is the tree`` cannot govern the turn that is supposed to create it.
 */
const BUILD_VERBS =
  /\b(build|implement|scaffold|bootstrap|create|develop|deliver|ship|migrate|port)\b/i;

/**
 * The block's rules, written as one message. Kept deterministic (an array of
 * lines joined here) so tests assert on the rules rather than on prose
 * formatting, and so a truncated edit cannot silently drop a rule.
 */
export const ASSESSMENT_PROTOCOL_RULES: readonly string[] = [
  '1. MEASURE THE ARTIFACT, NOT A COPY.',
  '   Run the project\'s own code: import the real module, call the real function,',
  '   drive the real page, endpoint or CLI. Never paste a copy of the logic into a',
  '   scratch script and present its output as the app\'s behaviour — a copy can',
  '   differ from the shipped code, and that gap is where wrong findings come from.',
  '   If you did reason from a copy, tag the finding `REASONED` instead of `MEASURED`.',
  '   MEASURE THE CONSEQUENCE TOO: when the impact is data loss or corruption, run',
  '   the path against a temp copy and report the observed end state, not a guess.',
  '',
  '2. REACHABILITY BEFORE SEVERITY.',
  '   Before a UI / endpoint / input defect is called real, show that a user can',
  '   produce the triggering input: name the handler, the filter, the disabled',
  '   field, the route. A sink with no reachable input is LATENT — say "latent" and',
  '   name the path that would make it live. Never describe an unreachable path as',
  '   something the user can type.',
  '',
  '3. QUANTIFY RESOURCE CLAIMS.',
  '   Every hang / freeze / leak / DoS / slow-path claim needs a number you',
  '   measured (use the real code and say what you ran: "3.09 s at n=1e8, linear"),',
  '   and anything you did not measure must be labelled an extrapolation.',
  '   If you cannot measure it, tag the finding `UNMEASURED` and say which command',
  '   would produce the number — an admitted gap is honest, a magnitude you never',
  '   measured reads as a fact and is not one.',
  '',
  '4. GREEN TESTS ARE NOT COVERAGE.',
  '   Say what the tests actually call and whether that is the path users take.',
  '   When a tested function and the shipped dispatch differ, name which one is',
  '   tested and which one runs — that gap is usually the root cause of the bug',
  '   you just found, and it survives every green test run.',
  '',
  '5. FINISH WHAT YOU REFERENCE.',
  '   Never forward-reference a section you might not deliver ("noted at the end",',
  '   "see below"): write it where you reference it. If you are near your output',
  '   limit, cut SCOPE, not the end of a sentence — close the finding you are in,',
  '   then add a final `## Not covered` list. An answer that stops mid-sentence is',
  '   a failed answer, however good the part before it was.',
  '',
  '6. CHECK THE SEAMS, NOT ONLY THE MODULES. For every CONSTANT, ask what it is',
  '   compared against (a version gate against a hardcoded floor disables the',
  '   feature it guards); for every PARSED FIELD, find its consumer (an unread',
  '   config or manifest key is a capability that does not exist); for every',
  '   recursive MERGE or default table, feed it PARTIAL input and see which',
  '   defaults survive.',
  '',
  '7. RUN WHAT THE PROJECT ALREADY SHIPS. Run the self-checks below and any you',
  '   find (a `tools/` auditor, a validator, a CI script) before concluding — a',
  '   shipped checker is the highest-provenance evidence there is, and cannot be',
  '   a hallucination. Give a delegate the EXACT file or suite to run, and read',
  '   its "not found" as nothing tested. Skipping one? Name it as a gap, never',
  '   silently.',
  '',
  '8. A FILE IN THE REPO IS A CLAIM, NOT A FACT. A prior report, notes file or',
  '   README is evidence of what someone asserted, not of what the code does.',
  '   Resolve its `file:line` references yourself first, saying which you checked.',
  '',
  '9. NEVER CLAIM A MEASUREMENT YOU HAVE NOT TAKEN. A number belongs in the',
  '   answer only after the command that produced it ran IN THIS TURN; never mark',
  '   a step done on a result you have not seen, and re-run every command you cite',
  '   to confirm it prints the numbers beside it. An unreproducible command',
  '   invalidates its finding.',
  '',
  '10. DECIDE; DO NOT ASK FOR WHAT YOU MAY ALREADY DO. Reading, listing, searching',
  '    and running read-only probes are yours. Ask only where the answer is the',
  '    user\'s call and cannot be inferred; with nobody there, record the choice',
  '    you made, never a question.',
  '',
  '11. LEAVE THE TREE AS YOU FOUND IT. Keep scratch files, probes and reports',
  '    OUTSIDE the audited repository (a temp dir) and say where; if a deliverable',
  '    must land in the tree, name every file you added and what to delete.',
  '',
  '12. WRITE THE DELIVERABLE FIRST, THEN IMPROVE IT. If the ask names a file,',
  '    create it with every required heading early, append findings as they are',
  '    verified, and stat it afterwards: a step bound or a truncated write that',
  '    leaves a 0-byte file loses the whole turn.',
  '',
  '13. NO "HARMLESS" UNTIL YOU HAVE READ THE CONSUMER. A branch that never runs is',
  '    only LOW once the code that READS what it would have produced is shown to',
  '    tolerate the absence; quote that reader. Measured: a downloader branch that',
  '    never created per-voice directories was filed as harmless dead code, while',
  '    the reader it fed looked for files in a directory that therefore never',
  '    existed — a Critical, not a Low.',
  '',  '14. PROOF DECIDES SEVERITY, NOT EXISTENCE. A Critical needs the SMALLEST',
  '    fixture that reaches it, run against the REAL module, with the output',
  '    quoted — and never raise a severity on a mechanism you did not run. But a',
  '    defect you read straight out of the source is STILL REPORTED, tagged',
  '    `[I]` with the command that would prove it; never delete it because no',
  '    fixture came together. After the sweep, walk each top-level module asking',
  '    what its inputs are supposed to change: a no-op control or a disabled',
  '    escape button costs the user the same whether or not you had time to run it.',
  '',
  '15. "SAFE" IS A CLAIM: NAME THE SEARCH. Every "no X found" line states the',
  '    pattern and the paths it covered, and includes the SYNONYMS — "pickle"',
  '    covers `np.load(allow_pickle=True)`, `torch.load`, `yaml.load`, `dill`;',
  '    "no shell injection" covers `shell=True`, `os.system`, `eval`, `exec`.',
  '    A grep with an exclude, or one directory searched, is not proof of',
  '    absence — and a false "safe" is worse than a missing finding.',
];

/**
 * The injected block. Returns '' for every non-assessment ask (the caller then
 * injects nothing, so the turn is byte-identical to one from a build without
 * this module).
 *
 * It deliberately does NOT prescribe a report template: the findings format from
 * a normal run — severity, `file:line`, mechanism, fix — is named as the thing to
 * KEEP, so the protocol adds evidence discipline without flattening the answer.
 */
export function assessmentProtocolBlock(
  goal: string,
  opts: { selfChecks?: string } = {},
): string {
  if (!isProjectAssessmentGoal(goal)) return '';
  const parts = [
    '## ⚠️ TASK PROTOCOL: PROJECT ASSESSMENT (findings, not changes)',
    'Keep the report shape you already use — severity-labelled findings, exact',
    '`file:line`, the mechanism, a fix, and which artifacts inherit the bug. Add',
    'these evidence rules on top; a finding that breaks one is not yet a finding:',
    '',
    ...ASSESSMENT_PROTOCOL_RULES,
    '',
    '## SEAM SWEEP — answer every line before the report is finished',
    'Each line is "safe" (with the file:line that proves it), "defect" (file:line,',
    'severity), or "N/A" (why). An answer from memory is not an answer; a sweep',
    'line left blank is an unexamined seam, and the missing findings live there.',
    '- A. user text → path → delete/overwrite: the sanitizer, the join, the rmtree.',
    '     Name the inputs that survive sanitising — a project/folder NAME that is',
    '     only dots (`.`, `..`, `...`) has no separator to reject and joins above',
    '     the root. Trace it to the delete/overwrite call.',
    '- B. transfer → disk: status code (200 vs 206), resume/append, any size or',
    '     digest check. Name the retry cases: a server ignoring `Range` (200 onto',
    '     an appended `.part`) and an ALREADY-COMPLETE `.part` whose next request',
    '     gets 416 — does the user recover, or is the download bricked?',
    '- C. version or capability gates: the constant compared against, and what a',
    '     realistic CURRENT value does to the feature it guards.',
    '- D. every parsed config/manifest field: name its consumer, or it is a',
    '     capability that does not exist.',
    '- E. cancellation / pause / error: does the work stop before the NEXT unit?',
    '- F. duplicate singletons and posted-but-unbound events: two app objects, an',
    '     event nobody binds, a cache keyed on nothing.',
    '- G. every function you are about to call dead/unreachable: grep its callers',
    '     AND the code that reads the output it would have produced. A reader that',
    '     expects that output makes it a LIVE defect, not dead code — grade it so.',
    '- H. every input that should change output — a control, a flag, a setting, a',
    '     catalog field: follow it to the sink; read-and-never-applied does nothing.',
    '- I. platform-specific APIs (accessibility, AppKit/wx, Windows shell): unguarded',
    '     they crash or silently disable the feature off-platform; count app objects.',
    '- J. every gate that blocks the user: is the ESCAPE (Disagree, Skip, Cancel)',
    '     enabled in every reachable state, or must the user satisfy the gate first?',
    '- K. code-executing input (`pickle`, `np.load(allow_pickle=True)`, `eval`) and',
    '     every zip/tar extraction: entry count, entry size, path containment.',
    '- L. resume/per-run state: files rewritten from scratch each run, and values',
    '     computed then overwritten before use (an index, an offset written late).',
    '',
    '',
    '## MODULE PASS — one line per top-level module, before the report ends',
    'Format: `module/ — the behaviour a user gets from it — class checked — finding',
    '| safe (file:line)`. The classes below are the ones a seam sweep does not',
    'reach, because they need the module read in order rather than a join traced:',
    '- audio/DSP: a control value read, then never applied (rate, pitch, volume).',
    '- dialogs: an action disabled until the user satisfies what it is meant to skip.',
    '- persistence: a file rewritten from scratch each run that the resume path needs.',
    '- singletons: two app objects, two settings objects, an event with no binder.',
    '- pause/cancel: does the in-flight unit stop before the NEXT one starts?',
    '- metadata: a page, index or offset assigned then overwritten or written late.',
    '- version constants: the release bumped one and not the one the gate compares.',
    '- CLI/worker flags: parsed, then never used.',
    '- dependencies: declared in a manifest, never installed by the installer.',
    '- naming: two entities can share a name and one silently replaces the other.',
    '',
    'Also: read the whole tree in as FEW passes as possible (one call listing many',
    'paths beats one call per file) BEFORE you start verifying, and record the exact',
    'command and observed output next to each finding so it can be re-run by someone',
    'who was not there.',
  ];
  // The project's own checks (see `self-check-discovery.ts`) are appended only
  // when the caller found some, so a project that declares none produces the
  // exact block a build without that module produces.
  const selfChecks = (opts.selfChecks || '').trim();
  if (selfChecks) parts.push('', selfChecks);
  return parts.join('\n');
}

/**
 * Is this goal a PROJECT ASSESSMENT — a request for findings about existing code,
 * rather than a change to it or an authored document?
 *
 * Two shapes qualify, and nothing else does:
 *   - an explicit finding request ("identify the bugs in the project", "what's
 *     broken here") — the shape the side-by-side audit took;
 *   - an assessment verb aimed at code ("assess the project at …", "review the
 *     codebase", "audit this API").
 *
 * The exclusions are as load-bearing as the matches: requiring a code target keeps
 * "review this sentence" and "review my notes" out, and a LONG-FORM authored ask is
 * excluded so "write a 20 page review of this codebase" stays a document task.
 *
 * The authored exclusion is deliberately the NARROW one (`isLongFormAuthoredGoal`,
 * not `isAuthoredGoal`): the broad predicate is claimed by the word "report", and
 * the verbatim audit goal ends "…report the file and line … this is an assessment
 * only" — a broad guard silently drops exactly the ask this module exists for. The
 * code-target requirement already keeps prose asks that never mention code out.
 */
export function isProjectAssessmentGoal(goal: string): boolean {
  const g = (goal || '').trim();
  if (!g) return false;
  // A long-form authored deliverable wins: the prose IS the deliverable here.
  if (isLongFormAuthoredGoal(g)) return false;
  if (FIND_FLAWS.test(g) || WHATS_WRONG.test(g)) return true;
  // An explicit delivery ask is a change request, not a judgement: see BUILD_VERBS.
  // Only the verb branch is vetoed — "find the bugs in this repo" stays an audit
  // even when the same prompt also asks for the fix, because the finding shape is
  // the explicit part of that ask.
  if (BUILD_VERBS.test(g)) return false;
  return ASSESS_VERBS.test(g) && CODE_TARGETS.test(g);
}
