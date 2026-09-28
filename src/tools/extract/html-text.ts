/**
 * Structure-preserving HTML → text, plus the entity decoding the XML formats share.
 *
 * This is deliberately NOT `replace(/<[^>]+>/g, ' ')`. Flattening tags to spaces
 * (what `extractHTML` used to do) throws away the row/column structure — the one
 * thing a table-shaped document is made of. A lab report read that way gives the
 * model every value with no idea which reference range it belongs to, and an
 * agent asked to assess it is left guessing at the pairing.
 *
 * So cells stay on one line separated by ` | `, rows become lines, paragraphs
 * become lines, and entities are decoded. Lossy in layout terms, faithful in
 * value-to-value terms — which is the pairing that matters.
 */

/** Named entities that actually appear in document XML/HTML. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
};

/**
 * Decode XML/HTML entities: named, decimal (`&#65;`) and hex (`&#x41;`).
 * Exported because the PPTX reader needs the same decoding for `<a:t>` runs.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith('#')) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/**
 * Convert an HTML fragment to text, keeping tabular structure.
 *
 * Block-level closes emit a newline; cell closes emit a column separator; `<li>`
 * becomes a bullet. Runs of spaces are collapsed (tags leave gaps behind) and
 * blank lines are collapsed to at most one.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Structural replacements, most specific first.
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|section|article|header|footer|figcaption)\s*>/gi, '\n');

  // Everything else is markup; drop it.
  s = s.replace(/<[^>]+>/g, '');

  // Decode AFTER tag removal so an encoded `&lt;b&gt;` in the document is not
  // mistaken for markup.
  s = decodeEntities(s);

  // A block INSIDE a cell (mammoth emits `<td><p>Glucose</p></td>`) leaves the cell
  // separator on the following line. Pull it back up, so the cell's text and its
  // separator stay on one line — otherwise every table row reads as its cells on
  // separate lines and the value/column pairing is lost.
  s = s
    .replace(/\n[ \t]*\|/g, ' | ')   // newline before a separator
    .replace(/\|[ \t]*\n/g, ' |\n'); // separator before a newline (row end)

  return s
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
