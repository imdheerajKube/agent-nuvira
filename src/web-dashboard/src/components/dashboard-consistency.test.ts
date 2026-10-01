/**
 * Every routed page wears the same header.
 *
 * WHAT WENT WRONG WITHOUT THIS. Each page invented its own title: most used
 * `<h2 className="section-title">`, `ContactsPage`/`EvalsPage`/`GatewayPage` used
 * a bare `<h2>`, `TasksPage` used `.panel-title`, `ExecutionHistory` used an
 * `<h3>`, and `TracePanel` inlined `style={{ fontSize: 15, … }}`. Five sizes,
 * six margins — and NO PAGE IN THE DASHBOARD HAD AN `<h1>`, so a screen-reader
 * user navigating by heading found the page title at level 2, the same level as
 * the sidebar's "Agent Management", and could not tell the page from its chrome.
 *
 * WHY STATIC AND NOT RENDERED. Rendering all 20 routes needs a fetch mock, an
 * SSE mock and a router per page, and several only reach their header after
 * data arrives — so a rendered check would be a mock harness testing itself,
 * not the pages. This reads the route table out of `App.tsx` (so a new page is
 * covered the moment it is routed) and checks the source, which is the thing
 * that actually drifted. It cannot see a page that renders a SECOND heading
 * above the header; `PageHeader.test.tsx` covers the level, and the browser
 * smoke walks the real pages.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

/** Component names in `element={<Name …>}` from the route table. */
function routedPages(): string[] {
  const names = [...APP.matchAll(/element=\{<([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]);
  return [...new Set(names)].filter((name) => name !== 'Navigate');
}

const PAGES = routedPages();
const pagePath = (name: string) => resolve(process.cwd(), 'src', 'components', `${name}.tsx`);

/**
 * Source with string contents blanked out.
 *
 * Not cosmetic: `AgentHub` builds a standalone HTML EXPORT inside a template
 * literal, and that document legitimately has its own `<h1>` and `<style>`. It
 * is a file a user downloads, not page markup, so counting it would be a false
 * positive — and one that pushed toward "fixing" a correct export.
 *
 * LIMIT: this pairs backticks blindly, so a template literal nested inside
 * another (`a ${`b`} c`) mis-pairs and can blank real code. That is why the
 * `<PageHeader` check below does NOT use this — it counts the tag in the raw
 * source. Only the `<h1` scan relies on it, where a blanked region can only hide
 * a violation, never invent one.
 */
function withoutStrings(source: string): string {
  return source
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

describe('every routed page uses the shared page header', () => {
  it('found the route table', () => {
    // A regex that matched nothing would make everything below vacuous.
    expect(PAGES.length).toBeGreaterThanOrEqual(18);
    expect(PAGES).toContain('Overview');
    expect(PAGES).toContain('ChatPage');
  });

  it('renders PageHeader, so the page title is an h1 with one set of metrics', () => {
    // A JSX TAG, not the word: an import alone would satisfy `includes` and
    // render nothing. (TypeScript's noUnusedLocals would catch that import, but
    // this test should not depend on a compiler flag to mean what it says.)
    const missing = PAGES.filter(
      (name) => !/<PageHeader[\s/>]/.test(readFileSync(pagePath(name), 'utf8')),
    );
    expect(missing, `routed pages with no PageHeader: ${missing.join(', ')}`).toEqual([]);
  });

  it('builds no h1 by hand', () => {
    // One owner of the document's single h1. A page that writes its own gets a
    // second h1 the moment it also renders a header.
    const handwritten = PAGES.filter((name) =>
      /<h1[\s>]/.test(withoutStrings(readFileSync(pagePath(name), 'utf8'))),
    );
    expect(handwritten, `pages rendering their own h1: ${handwritten.join(', ')}`).toEqual([]);
  });

  it('never skips a heading level: sections are h2 under the page h1', () => {
    // `.section-subtitle` was an h3 in 45 places and an h2 in 8 — harmless while
    // the page title was ALSO an h2 (h2 → h3 never skipped), and a real defect
    // the moment the title became an h1: h1 → h3 is a skipped level, which is
    // exactly the navigation cue a screen-reader user relies on. So sections are
    // h2, always, and this is what keeps them there.
    const skipped = PAGES.filter((name) =>
      /<h3 className="section-subtitle"/.test(readFileSync(pagePath(name), 'utf8')),
    );
    expect(skipped, `pages skipping h1 -> h3: ${skipped.join(', ')}`).toEqual([]);
  });

  it('every page component file exists', () => {
    const absent = PAGES.filter((name) => !existsSync(pagePath(name)));
    expect(absent).toEqual([]);
  });
});
