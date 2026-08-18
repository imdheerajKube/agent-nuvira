/**
 * P2 — artifact extraction from an agent answer's markdown text.
 *
 * The live `plan` / `diff` / `tool` / `skill_draft` SSE events render their own
 * cards during the turn and are snapshotted into the reply. This module covers
 * the OTHER path: structured blocks the model wrote DIRECTLY into the answer
 * text (a ```diff fenced block, test-runner output, a deploy URL) that never
 * went through an event. Without it those render as plain markdown code — the
 * Phase-2 gap (plan → 📋, code change → diff card, build/test → result card,
 * deploy → 🚀 card with URL).
 *
 * Everything here is PURE (string in, plain objects out) so it unit-tests
 * without React or a server. Best-effort: content without recognizable blocks
 * yields an empty result and the reply renders as today.
 */

/** One file section of a unified diff (mirrors the engine's GitDiffPayload). */
export interface DiffArtifactFile {
  path: string;
  body: string;
}

/** A diff artifact parsed from a ```diff fenced block. */
export interface DiffArtifact {
  files: DiffArtifactFile[];
  summary: string;
}

/** A test/build result artifact parsed from a fenced output block. */
export interface ResultArtifact {
  verdict: 'pass' | 'fail' | 'unknown';
  /** Short headline, e.g. the first meaningful line of the block. */
  title: string;
  body: string;
}

/** A deploy artifact: a URL the answer presents as a live deployment. */
export interface DeployArtifact {
  url: string;
  /** The surrounding line, truncated — used as the card's caption. */
  title: string;
}

export interface ExtractedArtifacts {
  diffs: DiffArtifact[];
  results: ResultArtifact[];
  deploys: DeployArtifact[];
}

const FENCED_BLOCK = /```([\w+-]*)\n([\s\S]*?)```/g;

/** Split a unified diff into per-file sections (git-tool parity). */
export function parseDiffSections(diff: string): DiffArtifactFile[] {
  if (!diff.trim()) return [];
  const sections: DiffArtifactFile[] = [];
  let current: DiffArtifactFile | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current);
      // "diff --git a/foo.ts b/foo.ts" → the b-side path (may be /dev/null).
      const b = line.split(' b/').slice(1).join(' b/');
      current = { path: b.replace(/^b\//, ''), body: line };
    } else if (current) {
      current.body += `\n${line}`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** Does this fenced block look like test/build output worth a result card? */
function looksLikeResultBlock(body: string): boolean {
  return (
    /(^|\n)\s*(PASS|FAIL|✅|❌|✗|✓|\bok\b)/i.test(body) ||
    /\b\d+\s+(passed|failed)\b/i.test(body) ||
    /(tests?|build|suite|checks?)\s+(passed|failed|complete|green|red|ok)/i.test(body) ||
    /(exit code|process exited|finished with)/i.test(body)
  );
}

/** The verdict for a result block: any fail marker wins; pass needs a pass marker. */
function resultVerdict(body: string): ResultArtifact['verdict'] {
  if (/(^|\n)\s*(FAIL|❌|✗)/i.test(body) || /\bfailed\b/i.test(body)) return 'fail';
  if (/(^|\n)\s*(PASS|✅|✓)/i.test(body) || /\bpassed\b/i.test(body)) return 'pass';
  return 'unknown';
}

/** First non-empty line as a short headline (fallback for unnamed output). */
function blockTitle(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t) return t.length > 80 ? `${t.slice(0, 77)}…` : t;
  }
  return 'Command output';
}

const URL_RE = /https?:\/\/[^\s)\]}"'<>]+/i;
const DEPLOY_CONTEXT = /(🚀|deploy(?:ed|ment|ing)?|live at|published|available at|open the)/i;

function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, '');
}

/**
 * Extract deploy URLs: lines (or line pairs) that carry a deploy signal AND a
 * URL. Dedupes by URL (first caption wins).
 */
export function extractDeployUrls(content: string): DeployArtifact[] {
  const lines = content.split('\n');
  const out: DeployArtifact[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let m = line.match(DEPLOY_CONTEXT);
    // A "Deployed to:" line followed by a bare URL on the next line counts too.
    if (!m && i + 1 < lines.length && /deploy(?:ed|ment|ing)?:\s*$/i.test(line.trim())) {
      m = lines[i + 1].match(DEPLOY_CONTEXT);
    }
    const u = line.match(URL_RE) || (i + 1 < lines.length ? lines[i + 1].match(URL_RE) : null);
    if (!m || !u) continue;
    const url = cleanUrl(u[0]);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: line.trim().slice(0, 80) || 'Deployment' });
  }
  return out;
}

/**
 * Scan an agent answer's markdown for structured artifacts:
 *   - ```diff fenced blocks → DiffArtifact (per-file sections)
 *   - fenced output blocks that read like test/build results → ResultArtifact
 *   - deploy-context URLs → DeployArtifact
 * Ordering follows the text (diffs first, then results, then deploys).
 */
export function extractArtifacts(content: string): ExtractedArtifacts {
  const diffs: DiffArtifact[] = [];
  const results: ResultArtifact[] = [];
  const deploys: DeployArtifact[] = [];

  FENCED_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCED_BLOCK.exec(content)) !== null) {
    const lang = (match[1] || '').toLowerCase();
    const body = match[2];
    if (lang === 'diff' || body.includes('diff --git ')) {
      const files = parseDiffSections(body);
      if (files.length > 0) {
        diffs.push({ files, summary: `${files.length} file${files.length === 1 ? '' : 's'} changed` });
      }
    } else if (looksLikeResultBlock(body)) {
      results.push({ verdict: resultVerdict(body), title: blockTitle(body), body });
    }
  }

  for (const d of extractDeployUrls(content)) deploys.push(d);

  return { diffs, results, deploys };
}
