/**
 * Bench scoring — turn two audit reports into comparable NUMBERS.
 *
 * WHY THIS EXISTS (2026-10-25). The head-to-head that produced the current plan
 * was scored by hand: sections counted, `[F]` tags counted, 32 defects reconciled
 * against the source by a human, and a cost computed from ledger rows. That is
 * fine once and impossible to repeat every release, so the release gate had
 * nothing to gate. This module is the repeatable part: everything that can be
 * counted deterministically is counted here, and only "is this claim TRUE" stays
 * with a reviewer (via `fixtures/audit-ground-truth.json`, which records the
 * defects that were independently verified).
 *
 * WHAT IT DOES NOT DO: judge quality. A report can score high on tags and still be
 * wrong; that is what the ground-truth recall and the reviewer's `verified` flags
 * are for. The numbers here are a REGRESSION signal, not a verdict.
 */

/** A finding line: `BUG-01 - CRITICAL - title`, `### High — title`, `- **[Medium]** title`. */
const ID_FINDING = /^\s*\**\s*(?:BUG|FINDING|ISSUE|DEFECT|VULN(?:ERABILITY)?)[-\s]*(?:#|no\.?)?\s*[\w.]{0,8}\s*[-—:.)\]]*\s*\(?\[?\**\s*(CRITICAL|BLOCKER|HIGH|MEDIUM|MODERATE|LOW|INFO(?:RMATIONAL)?)\b/i;
const SEVERITY_FINDING = /^\s*\**\s*\(?\[?\**\s*(CRITICAL|BLOCKER|HIGH|MEDIUM|MODERATE|LOW|INFO(?:RMATIONAL)?)\b/i;
const HEADING = /^#{1,6}\s+(.*\S)\s*$/gm;
const CITATION = /\b[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:py|ts|tsx|js|jsx|go|rs|rb|java|kt|cs|swift|php|c|cc|cpp|h|hpp|sh):\d{1,6}\b/g;

/** Strip a leading block marker so headings, bullets and ids are read uniformly. */
function stripMarker(line) {
  return String(line ?? '').replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').trim();
}

/** Every line that reads as a finding, with its severity. */
export function findingLines(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = stripMarker(raw);
    if (!line) continue;
    const id = ID_FINDING.exec(line);
    const sev = id ? id[1] : SEVERITY_FINDING.exec(line)?.[1];
    if (!sev) continue;
    out.push({ severity: sev.toUpperCase(), title: line.slice(0, 400) });
  }
  return out;
}

/** Counts the evidence discipline the task asked for. */
export function countTags(text) {
  const s = String(text ?? '');
  const count = (re) => (s.match(re) ?? []).length;
  return {
    facts: count(/\[F\]/g),
    inferences: count(/\[I\]/g),
    speculation: count(/\[S\]/g),
  };
}

export function countCitations(text) {
  return (String(text ?? '').match(CITATION) ?? []).length;
}

/** How many of the task's required sections are present (by heading text). */
export function sectionsDelivered(text, required = []) {
  const headings = [...String(text ?? '').matchAll(HEADING)].map((m) => stripMarker(m[1]).toLowerCase());
  const present = required.filter((name) => {
    const needle = String(name).toLowerCase();
    return headings.some((h) => h.includes(needle));
  });
  return { delivered: present.length, required: required.length, missing: required.filter((n) => !present.includes(n)) };
}

/**
 * Ground-truth recall.
 *
 * An entry counts as FOUND when a finding line carries one of its `keywords`
 * (case-insensitive). Keywords are chosen to be specific ("rmtree", "wx.App",
 * "allow_pickle"), because a keyword that appears in every report measures
 * nothing. `file`, when present, is a cross-check the reviewer can use — it is not
 * required for the match, since a correct report may name the same defect from a
 * different file.
 */
export function matchGroundTruth(text, groundTruth) {
  const findings = findingLines(text);
  const haystack = findings.map((f) => f.title.toLowerCase());
  const matched = [];
  const missed = [];
  for (const entry of groundTruth?.defects ?? []) {
    const keywords = (entry.keywords ?? []).map((k) => String(k).toLowerCase()).filter(Boolean);
    const hit = keywords.some((k) => haystack.some((title) => title.includes(k)));
    if (hit) matched.push(entry.id);
    else missed.push(entry.id);
  }
  return {
    matched,
    missed,
    recall: groundTruth?.defects?.length ? matched.length / groundTruth.defects.length : 0,
  };
}

/**
 * Token / cache / cost figures from a run log.
 *
 * Tolerant on purpose: the nuvira event log and Cline's `--json` stream do not
 * share a shape, and a bench that only reads one of them cannot compare them.
 * Every `prompt_tokens`-like field is summed with its cache figure when present.
 */
export function parseUsage(logText) {
  const text = String(logText ?? '');
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = obj?.usage ?? obj?.message?.usage ?? (obj?.prompt_tokens !== undefined ? obj : null);
    if (!usage) continue;
    const prompt = number(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? 0);
    if (prompt <= 0) continue;
    calls += 1;
    inputTokens += prompt;
    outputTokens += number(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? 0);
    cachedInputTokens += number(
      usage.prompt_cache_hit_tokens ??
        usage.cached_tokens ??
        usage.prompt_tokens_details?.cached_tokens ??
        usage.cache_read_input_tokens ??
        0,
    );
  }
  return {
    calls,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    cacheShare: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
  };
}

/** Everything a run can be scored on without a human. */
export function scoreRun({ report, groundTruth, requiredSections = [], usage = null, wallClockMs = null }) {
  const findings = findingLines(report);
  const tags = countTags(report);
  const sections = sectionsDelivered(report, requiredSections);
  const truth = matchGroundTruth(report, groundTruth);
  const tokens = usage ?? { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheShare: 0 };
  return {
    findings: findings.length,
    bySeverity: findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {}),
    tags,
    citations: countCitations(report),
    sections,
    recall: truth.recall,
    matched: truth.matched,
    missed: truth.missed,
    bytes: String(report ?? '').length,
    /**
     * Did the run leave a deliverable at all?
     *
     * Distinct from "the numbers are bad": a run that timed out at the cap scores
     * zero on every metric for the trivial reason that there was nothing to score,
     * and a gate that called that a pass (measured 2026-10-25: a 25-minute timeout
     * reported "Gate: ✅ pass") is worse than no gate. Reported here so the caller
     * can fail on it explicitly.
     */
    deliverable: String(report ?? '').length > 0,
    wallClockMs,
    ...tokens,
    callsPerFinding: findings.length > 0 && tokens.calls > 0 ? tokens.calls / findings.length : null,
    verifiedPerDollar: null, // filled by the caller when a priced figure exists
  };
}

/**
 * The release gate.
 *
 * Each threshold is a number this study measured, with the failing side named so a
 * regression reads as a sentence rather than a bare boolean.
 */
export function releaseGate(metrics, baseline = {}) {
  const failures = [];
  const minCacheShare = baseline.minCacheShare ?? 0.85;
  const maxCallsPerFinding = baseline.maxCallsPerFinding ?? 3;
  const minRecall = baseline.minRecall ?? null;
  const runCompleted = baseline.runCompleted ?? true;
  const requireDeliverable = baseline.requireDeliverable ?? true;

  // The two failures that make every other number meaningless come first, and
  // they are not "thresholds": a run that produced no report has not measured
  // anything, and reporting it as a pass is how a timeout reads as a win.
  if (!runCompleted) {
    failures.push('the run did not complete (timed out at the cap, or exited non-zero) — nothing was measured');
  } else if (requireDeliverable && metrics.deliverable === false) {
    failures.push('no deliverable was produced — the run wrote no report, so every metric below is zero rather than bad');
  }
  if (runCompleted && metrics.calls > 0 && metrics.findings === 0) {
    failures.push(`made ${metrics.calls} model call(s) and reported no findings — the turn spent round-trips without a result`);
  }

  if (metrics.calls > 0 && metrics.cacheShare < minCacheShare) {
    failures.push(
      `cache share ${(metrics.cacheShare * 100).toFixed(1)}% is below ${(minCacheShare * 100).toFixed(0)}% — ` +
        'the prompt prefix is being rewritten (see learning/prompt-cache.ts)',
    );
  }
  if (metrics.callsPerFinding !== null && metrics.callsPerFinding > maxCallsPerFinding) {
    failures.push(
      `${metrics.callsPerFinding.toFixed(2)} model calls per finding exceeds ${maxCallsPerFinding} — ` +
        'the turn is spending round-trips rather than reading',
    );
  }
  if (minRecall !== null && metrics.recall < minRecall) {
    failures.push(
      `verified recall ${(metrics.recall * 100).toFixed(0)}% is below the recorded baseline ` +
        `${(minRecall * 100).toFixed(0)}%`,
    );
  }
  return { ok: failures.length === 0, failures };
}
