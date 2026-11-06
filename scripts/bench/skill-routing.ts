/**
 * P0 — Skill routing baseline (`npx tsx scripts/bench/skill-routing.ts`).
 *
 * Answers one question with a number: **does the text the model is given
 * actually contain the signal needed to pick the right skill?**
 *
 * It is deliberately MODEL-FREE. It does not ask an LLM, because an LLM answer
 * moves whenever a provider or temperature moves, and this number exists to
 * judge a HARNESS change (what text surfaces carry). What it measures instead:
 *
 *   1. VISIBILITY — is the correct skill's name in the surface at all?
 *   2. LEXICAL RECALL@3 — ranking every skill by content-word overlap between
 *      the prompt and the text the surface exposes for it, does the gold skill
 *      land in the top 3? This is the signal ceiling: a model cannot do better
 *      than the words it can see, and it can only do worse.
 *   3. TOOL_SEARCH RECALL@3 — the REAL `searchCapabilities` over the REAL
 *      capability index, with the current one-liner (trigger clause) versus the
 *      pre-change one (first sentence of the description).
 *   4. FALSE POSITIVES on the null cases — prompts where NO skill should fire.
 *      A surface that ranks something confidently for "review this blood test
 *      report" is worse than one that ranks nothing.
 *
 * Limitations, stated up front: lexical overlap is a proxy, not a model. A
 * better number requires a live model run (a later phase); this one is free,
 * hermetic, and moves only when the visible text moves — which is exactly the
 * thing under test.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { readHubCatalog } from '../../src/learning/hub-skill-catalog.js';
import { triggerLine } from '../../src/learning/skill-index.js';
import { capabilityFromSkill, searchCapabilities } from '../../src/tools/capability-registry.js';
import type { Capability } from '../../src/learning/capability-types.js';

// ─── Fixture ────────────────────────────────────────────────────────────────

interface EvalCase {
  prompt: string;
  gold: string | null;
  note?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures', 'skill-routing-eval.json'), 'utf-8'),
) as { cases: EvalCase[] };

const cases = fixture.cases;
const goldCases = cases.filter((c) => c.gold !== null);
const nullCases = cases.filter((c) => c.gold === null);

// ─── Text helpers ───────────────────────────────────────────────────────────

const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'these', 'those', 'from', 'into', 'your', 'our',
  'you', 'are', 'was', 'were', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should',
  'them', 'they', 'then', 'than', 'there', 'here', 'what', 'when', 'where', 'which', 'who',
  'not', 'but', 'any', 'all', 'each', 'use', 'using', 'used', 'how', 'why', 'its', 'it',
  'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'is', 'be', 'as', 'so', 'if', 'my',
]);

function tokens(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * IDF weights over the catalog. Without them a prompt containing "update" ranks
 * `dep-update` above `kubernetes` for a Kubernetes question, because unweighted
 * overlap counts a common word and a rare one identically — which made the
 * metric under-report every surface in the first run (see the report's history).
 * The weights are computed ONCE over `name + full description` and used for
 * every surface, so no surface is favoured.
 */
function buildIdf(skills: Array<{ name: string; description: string }>): (w: string) => number {
  const df = new Map<string, number>();
  for (const s of skills) {
    for (const w of new Set(tokens(`${s.name} ${s.description}`))) {
      df.set(w, (df.get(w) ?? 0) + 1);
    }
  }
  const n = Math.max(1, skills.length);
  return (w: string) => Math.log(1 + n / (df.get(w) ?? 1));
}

/** Assigned once the catalog is read (see the Run section). */
let idf: (w: string) => number = () => 1;

/** Rank skills by IDF-weighted overlap with the prompt (name + surface text). */
function rank(
  prompt: string,
  skills: Array<{ id: string; name: string; description: string }>,
  textFor: (s: { id: string; name: string; description: string }) => string,
  showsNames: boolean,
): Array<{ id: string; score: number }> {
  if (!showsNames) return skills.map((s) => ({ id: s.id, score: 0 }));
  const q = new Set(tokens(prompt));
  return skills
    .map((s) => {
      const body = new Set(tokens(`${s.name} ${textFor(s)}`));
      let score = 0;
      for (const w of q) if (body.has(w)) score += idf(w);
      return { id: s.id, score };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// ─── Surfaces ───────────────────────────────────────────────────────────────

interface Surface {
  id: string;
  label: string;
  /** Text exposed for one skill (beyond its name, which every surface but `pointer` shows). */
  textFor: (s: { id: string; name: string; description: string }) => string;
  /** True when skill NAMES are visible at all. */
  showsNames: boolean;
}

const SURFACES: Surface[] = [
  {
    id: 'pointer',
    label: 'pointer (pre-change default)',
    textFor: () => '',
    showsNames: false,
  },
  {
    id: 'index',
    label: 'index (new default)',
    textFor: (s) => triggerLine(s.description, 90),
    showsNames: true,
  },
  {
    id: 'names',
    label: 'names only (the `names` mode)',
    textFor: () => '',
    showsNames: true,
  },
  {
    id: 'catalog140',
    label: 'catalog @140 chars (old opt-in)',
    textFor: (s) => s.description.slice(0, 140),
    showsNames: true,
  },
  {
    id: 'full',
    label: 'full descriptions (reference ceiling)',
    textFor: (s) => s.description,
    showsNames: true,
  },
];

// ─── Run ────────────────────────────────────────────────────────────────────

const catalog = readHubCatalog();
const skills = catalog.map((s) => ({ id: s.id, name: s.name, description: s.description }));
idf = buildIdf(skills);

function firstSentence(text: string): string {
  return String(text ?? '').split(/\.\s/)[0]?.trim() ?? '';
}

/** The capability index as it was BEFORE the one-liner fix. */
function oldCapabilityIndex(): Capability[] {
  return skills.map((s) => {
    const cap = capabilityFromSkill(s);
    return { ...cap, oneLiner: firstSentence(s.description) || `The ${s.name} skill.` };
  });
}

const newCapabilityIndex = skills.map((s) => capabilityFromSkill(s));

interface SurfaceResult {
  surface: Surface;
  visible: number;
  recallAt3: number;
  charsPerSkill: number;
  totalChars: number;
  forcedOnNull: number;
  misses: Array<{ prompt: string; gold: string; top3: string[] }>;
}

const surfaceResults: SurfaceResult[] = SURFACES.map((surface) => {
  const lines = skills.map((s) => `  - ${s.name}: ${surface.textFor(s)}`);
  const totalChars = surface.showsNames ? lines.join('\n').length : 0;
  let visible = 0;
  let hits = 0;
  const misses: SurfaceResult['misses'] = [];
  for (const c of goldCases) {
    if (surface.showsNames) visible += 1;
    const ranked = rank(c.prompt, skills, surface.textFor, surface.showsNames);
    const top3 = ranked.slice(0, 3).map((r) => r.id);
    if (top3.includes(c.gold as string)) hits += 1;
    else misses.push({ prompt: c.prompt, gold: c.gold as string, top3 });
  }
  let forcedOnNull = 0;
  for (const c of nullCases) {
    const ranked = rank(c.prompt, skills, surface.textFor, surface.showsNames);
    // "Confident" = IDF-weighted overlap worth ~2 rare words (or several common
    // ones) with the best skill. Calibrated on the equipped surfaces only.
    if (ranked[0] && ranked[0].score >= 3) forcedOnNull += 1;
  }
  return {
    surface,
    visible,
    recallAt3: goldCases.length > 0 ? hits / goldCases.length : 0,
    charsPerSkill: skills.length > 0 ? Math.round(lines.join('\n').length / skills.length) : 0,
    totalChars,
    forcedOnNull,
    misses,
  };
});

interface SearchResult {
  label: string;
  recallAt3: number;
  misses: Array<{ prompt: string; gold: string; top3: string[] }>;
}

function runSearch(index: Capability[], label: string): SearchResult {
  let hits = 0;
  const misses: SearchResult['misses'] = [];
  for (const c of goldCases) {
    const top3 = searchCapabilities(index, c.prompt, 3).map((h) => h.capability.ref);
    if (top3.includes(c.gold as string)) hits += 1;
    else misses.push({ prompt: c.prompt, gold: c.gold as string, top3 });
  }
  return { label, recallAt3: goldCases.length > 0 ? hits / goldCases.length : 0, misses };
}

const searchNew = runSearch(newCapabilityIndex, 'tool_search — trigger clause (now)');
const searchOld = runSearch(oldCapabilityIndex(), 'tool_search — first sentence (before)');

// ─── Report ─────────────────────────────────────────────────────────────────

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const lines: string[] = [];
const push = (l = ''): void => void lines.push(l);

push('# Skill routing baseline — 2026-11-02');
push('');
push(`Generated by \`scripts/bench/skill-routing.ts\` (model-free; see its header for method and limits).`);
push('');
push(`**Catalog:** ${skills.length} skills from \`.agents/skills\` · **Eval set:** ${cases.length} prompts ` +
  `(${goldCases.length} with a gold skill, ${nullCases.length} where none should fire).`);
push('');
push('## Results');
push('');
push('| Surface | Names visible | Recall@3 | Chars/skill | Total chars | Null prompts it would fire on |');
push('|---|---|---|---|---|---|');
for (const r of surfaceResults) {
  push(
    `| ${r.surface.label} | ${r.surface.showsNames ? 'yes' : '**no**'} | ${pct(r.recallAt3)} | ` +
    `${r.charsPerSkill} | ${r.totalChars} | ${r.forcedOnNull}/${nullCases.length} |`,
  );
}
push('');
push('| Discovery path | Recall@3 |');
push('|---|---|');
push(`| ${searchNew.label} | ${pct(searchNew.recallAt3)} |`);
push(`| ${searchOld.label} | ${pct(searchOld.recallAt3)} |`);
push('');
push('## Reading it');
push('');
const pointer = surfaceResults.find((r) => r.surface.id === 'pointer')!;
const index = surfaceResults.find((r) => r.surface.id === 'index')!;
push(
  `- The pre-change default (\`pointer\`) exposed **no skill names at all**, so its recall is ` +
  `${pct(pointer.recallAt3)} by construction — the model had to already suspect a skill existed before it could read anything about one.`,
);
const catalog140 = surfaceResults.find((r) => r.surface.id === 'catalog140')!;
const namesOnly = surfaceResults.find((r) => r.surface.id === 'names')!;
push(
  `- The index costs ${index.totalChars.toLocaleString()} chars (${index.charsPerSkill}/skill) and scores ` +
  `${pct(index.recallAt3)}. The full-description reference ceiling is ` +
  `${pct(surfaceResults.find((r) => r.surface.id === 'full')!.recallAt3)} at ` +
  `${surfaceResults.find((r) => r.surface.id === 'full')!.totalChars.toLocaleString()} chars.`,
);
push(
  `- Against the nearest competitor, the old 140-char catalog: ` +
  `${(index.recallAt3 * 100 - catalog140.recallAt3 * 100).toFixed(1)} points of lexical recall ` +
  `for ${Math.round((1 - index.totalChars / catalog140.totalChars) * 100)}% fewer characters. ` +
  `That is a trade, not a free win — stated as one.`,
);
push(
  `- Against NAMES ONLY (what the old \`names\` mode showed, and the closest thing to a bare list): ` +
  `+${(index.recallAt3 * 100 - namesOnly.recallAt3 * 100).toFixed(1)} points for ` +
  `${index.totalChars - namesOnly.totalChars} extra chars. The trigger clause is what that pays for.`,
);
push(
  `- \`tool_search\` recall moved from ${pct(searchOld.recallAt3)} to ${pct(searchNew.recallAt3)} ` +
  `purely by keeping the activation clause instead of the first sentence.`,
);
push(
  `- The ${nullCases.length} null prompts are the other half of the test: routing that fires on ` +
  `"review this blood test report" is worse than routing that stays quiet.`,
);
push('');
push('## Misses on the index surface');
push('');
if (index.misses.length === 0) {
  push('None — every gold skill landed in the top 3 from the index lines alone.');
} else {
  for (const m of index.misses) {
    push(`- **${m.gold}** ← "${m.prompt}" (got: ${m.top3.join(', ')})`);
  }
}
push('');
push('## What this does NOT prove');
push('');
push('Lexical overlap is a signal ceiling, not a model simulation: a real model can route');
push('correctly from a weaker surface (by knowing that "PR" means pull request) and can');
push('miss from a stronger one. This number moves only when the visible text moves, which');
push('is exactly the harness property under test. A live-model recall run is the next');
push('phase; until then, no claim of improved model behaviour is made here.');
push('');

const report = lines.join('\n');
const outPath = join(repoRoot, 'docs', 'BENCH_SKILL_ROUTING_2026-11-02.md');
writeFileSync(outPath, report, 'utf-8');

console.log(report);
console.log(`\n[skill-routing] wrote ${relative(process.cwd(), outPath)}`);
