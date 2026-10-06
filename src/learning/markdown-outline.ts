/**
 * Markdown outline (`src/learning/markdown-outline.ts`) — heading structure for
 * document retrieval.
 *
 * WHY THIS EXISTS. Paragraph chunking treats a design document as a bag of
 * paragraphs, which loses the one thing that makes a document navigable: the
 * section a passage belongs to. A passage inside "Token refresh > Failure modes"
 * is a different claim from the same words appearing in an unrelated appendix,
 * and a reader asking "what does the spec say about token refresh?" needs the
 * section, not a floating 512-token block.
 *
 * Two consumers, one parse:
 *   - CHUNKING tags every chunk with its heading path, so retrieval can rank on
 *     structure and a citation can name the section;
 *   - the whole-document read (`readKnowledgeDocument`) walks the same outline to
 *     serve one section verbatim.
 *
 * THE BREADCRUMB TRICK. A chunk is EMBEDDED with its heading path prepended but
 * STORED without it. The path is context that belongs in the vector (a passage
 * under "Refunds" should answer refund questions even when it never repeats the
 * word), but it is not part of the passage, and storing it would corrupt both the
 * citation and any faithful quote of the document.
 *
 * WHAT THIS DOES NOT DO. Setext headings (`Title\n=====`) and headings implied by
 * layout in extracted PDF text are not detected — there is no reliable signal for
 * either, and guessing would invent structure the document does not have. Text
 * without `#` headings yields exactly one section and chunks exactly as before,
 * so a non-Markdown document is unaffected.
 */

import { chunkText, DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS } from './retrieval.js';

/** `## Heading`, optional trailing hashes. */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export interface OutlineSection {
  /** Heading text alone, or `(preamble)` for content before the first heading. */
  title: string;
  /**
   * The full ancestor chain, ` > `-joined, EXCLUDING the section's own heading —
   * e.g. `Auth Design > Token refresh` for a section titled `Failure modes`.
   * Empty for a preamble or an unheaded document.
   */
  headingPath: string;
  /** Heading depth (1–6), or 0 for a preamble. */
  level: number;
  /** The section's text, heading line included when it has one. */
  text: string;
}

/**
 * Split Markdown into heading-delimited sections, tracking the ancestor chain.
 * Deterministic and total: every character of the input lands in exactly one
 * section, and a document with no headings comes back as one section.
 */
export function parseMarkdownOutline(text: string): OutlineSection[] {
  const lines = text.split('\n');
  const sections: OutlineSection[] = [];

  /** Ancestors by level; index = level - 1. */
  const trail: string[] = [];
  // The section currently being accumulated. It starts as the preamble, which
  // only survives if any content actually precedes the first heading.
  let title = '(preamble)';
  let headingPath = '';
  let level = 0;
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join('\n');
    // A preamble with no content is not a section; every later section is, even
    // an empty one (a heading with nothing under it is still a section).
    if (sections.length > 0 || body.trim()) {
      sections.push({ title, headingPath, level, text: body });
    }
    buffer = [];
  };

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (!match) {
      buffer.push(line);
      continue;
    }
    flush();
    level = match[1].length;
    title = match[2].trim();
    // Everything at or below this level is no longer an ancestor.
    trail.length = Math.max(0, level - 1);
    headingPath = trail.filter(Boolean).join(' > ');
    trail[level - 1] = title;
    buffer = [line];
  }
  flush();

  // A document with no headings at all is not "all preamble" — it simply has no
  // structure, and saying so is more honest than implying something came before
  // a heading that does not exist.
  if (sections.length === 1 && sections[0].level === 0) {
    return [{ ...sections[0], title: '(document)' }];
  }
  return sections.length > 0 ? sections : [{ title: '(document)', headingPath: '', level: 0, text }];
}

export interface StructuredChunk {
  /** `<label>#<i>` — sequential across the WHOLE document, so re-ingest overwrites. */
  id: string;
  chunkIndex: number;
  /** The passage as it appears in the document — what gets stored and quoted. */
  text: string;
  /** What gets EMBEDDED: the heading breadcrumb, then the passage. */
  embedText: string;
  /** Ancestor chain, ` > `-joined (may be empty). */
  headingPath: string;
  /** The section's own title, when the chunk came from a titled section. */
  title: string;
  tokenCount: number;
}

/** A chunk's heading label: the section title, prefixed by its ancestors. */
function crumb(section: OutlineSection): string {
  if (!section.title || section.title === '(preamble)' || section.title === '(document)') {
    return section.headingPath;
  }
  return section.headingPath ? `${section.headingPath} > ${section.title}` : section.title;
}

/**
 * Chunk a document along its heading structure.
 *
 * Each section is chunked on its own (so a passage never straddles two headings),
 * and every chunk carries the section's heading path. Numbering is global and
 * sequential because the ids are the overwrite/delete keys: a per-section index
 * would collide across sections and break the retired-tail delete on re-ingest.
 */
export function chunkMarkdown(
  text: string,
  label: string,
  chunkTokens: number = DEFAULT_CHUNK_TOKENS,
  overlapTokens: number = DEFAULT_OVERLAP_TOKENS,
): StructuredChunk[] {
  const sections = parseMarkdownOutline(text);
  const chunks: StructuredChunk[] = [];

  sections.forEach((section, sectionIndex) => {
    const headingLabel = crumb(section);
    const body = section.text.trim();
    if (!body) return;
    // Per-section labels keep `chunkText`'s ids unique within the call; they are
    // replaced with the document-wide index below.
    const parts = chunkText(body, `${label}~s${sectionIndex}`, chunkTokens, overlapTokens);
    for (const part of parts) {
      const chunkIndex = chunks.length;
      chunks.push({
        id: `${label}#${chunkIndex}`,
        chunkIndex,
        text: part.text,
        embedText: headingLabel ? `${headingLabel}\n\n${part.text}` : part.text,
        headingPath: headingLabel,
        title: section.title,
        tokenCount: part.tokenCount,
      });
    }
  });

  // An empty document still needs its one (empty) chunk, so a re-ingest of a
  // blanked file deletes the previous content rather than leaving the tail.
  if (chunks.length === 0) {
    chunks.push({
      id: `${label}#0`,
      chunkIndex: 0,
      text: '',
      embedText: '',
      headingPath: '',
      title: '(empty)',
      tokenCount: 0,
    });
  }
  return chunks;
}
