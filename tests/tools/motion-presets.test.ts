/**
 * Motion presets — the four ready-made scenes.
 *
 * Two rules are tested as rules, not as implementation details, because both are
 * the difference between a render and an accident:
 *
 *   SELF-CONTAINED — no CDN font, no chart library, no image URL. A render has to
 *   work with no network, and a fetched library would make the output depend on
 *   whatever version happened to load.
 *   A FUNCTION OF TIME — the templates may not read the clock or hold a counter,
 *   or the same source would render differently on a slower machine.
 *
 * Plus the data handling a model actually produces (JSON in three shapes, CSV
 * with and without a header) and the escaping that keeps a company name from
 * becoming markup.
 */

import { describe, expect, it } from 'vitest';

import {
  MOTION_PRESETS,
  escapeHtml,
  isMotionPreset,
  parseMotionData,
  presetHtml,
  presetNeedsData,
} from '../../src/tools/modality/motion-presets.js';

const opts = { durationMs: 4_000, width: 640, height: 360 };

describe('data the caller actually passes', () => {
  it('reads a bare series', () => {
    expect(parseMotionData([3, 5, 8]).map((p) => p.value)).toEqual([3, 5, 8]);
    expect(parseMotionData([3, 5])[0].label).toBe('1');
  });

  it('reads label/value objects and pairs', () => {
    expect(parseMotionData([{ label: 'A', value: 2 }])).toEqual([{ label: 'A', value: 2 }]);
    expect(parseMotionData([['A', 2], ['B', 9]])).toEqual([
      { label: 'A', value: 2 },
      { label: 'B', value: 9 },
    ]);
  });

  it('accepts the other spellings a model reaches for', () => {
    expect(parseMotionData([{ name: 'Q1', count: 12 }])).toEqual([{ label: 'Q1', value: 12 }]);
    expect(parseMotionData({ series: [1, 2, 3] })).toHaveLength(3);
    expect(parseMotionData('{"data":[{"label":"x","value":4}]}')).toEqual([{ label: 'x', value: 4 }]);
  });

  it('reads CSV with a header, without one, with semicolons, and with tidy values', () => {
    expect(parseMotionData('label,value\nAlpha,10\nBeta,25')).toEqual([
      { label: 'Alpha', value: 10 },
      { label: 'Beta', value: 25 },
    ]);
    expect(parseMotionData('Alpha,10\nBeta,25')).toEqual([
      { label: 'Alpha', value: 10 },
      { label: 'Beta', value: 25 },
    ]);
    expect(parseMotionData('Alpha;10\nBeta;25')).toHaveLength(2);
    expect(parseMotionData('Alpha,"$1,200"\nBeta,95%')).toEqual([
      { label: 'Alpha', value: 1200 },
      { label: 'Beta', value: 95 },
    ]);
    // One column: the index is the label, the cell is the value.
    expect(parseMotionData('4\n8')).toEqual([
      { label: '1', value: 4 },
      { label: '2', value: 8 },
    ]);
  });

  it('returns nothing rather than throwing on data it cannot read', () => {
    for (const junk of [undefined, null, '', '   ', 'not,csv\nok', '{oops', [true], { hello: 'world' }]) {
      expect(parseMotionData(junk as never)).toEqual([]);
    }
  });
});

describe('caller text is escaped', () => {
  it('an angle bracket in a name is text, not markup', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`Tom & "Jerry"`)).toBe('Tom &amp; &quot;Jerry&quot;');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('a hostile title reaches the page escaped', () => {
    const html = presetHtml('title-card', { title: '<img src=x onerror=alert(1)>' }, opts);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});

describe('every preset is self-contained and seekable', () => {
  const params = {
    title: 'Quarterly revenue',
    subtitle: 'FY2026',
    data: [{ label: 'Alpha', value: 12 }, { label: 'Beta', value: 30 }],
  };

  it('exposes the seek hook and a duration, and animates from t', () => {
    for (const preset of MOTION_PRESETS) {
      const html = presetHtml(preset, { ...params, data: preset === 'code-walkthrough' ? 'const a = 1;\nconsole.log(a);' : params.data }, opts);
      expect(html, preset).toContain('window.__motion');
      expect(html, preset).toContain('seek: function (t)');
      expect(html, preset).toContain('window.__motion.duration');
    }
  });

  it('never fetches anything', () => {
    for (const preset of MOTION_PRESETS) {
      const html = presetHtml(preset, { ...params, data: 'a,b\n1,2' }, opts);
      expect(html, preset).not.toMatch(/https?:\/\//);
      expect(html, preset).not.toMatch(/src\s*=\s*["']\/\//);
      expect(html, preset).not.toMatch(/@import/);
    }
  });

  it('never reads the clock — the same t must paint the same frame', () => {
    for (const preset of MOTION_PRESETS) {
      const html = presetHtml(preset, { ...params, data: 'a,b\n1,2' }, opts);
      expect(html, preset).not.toMatch(/Date\.now\s*\(/);
      expect(html, preset).not.toMatch(/performance\.now\s*\(/);
      expect(html, preset).not.toMatch(/Math\.random\s*\(/);
    }
  });

  it('renders the caller data into the scene', () => {
    const bars = presetHtml('bar-race', { ...params, data: 'label,value\nAlpha,10\nBeta,25' }, opts);
    expect(bars).toContain('Alpha');
    expect(bars).toContain('Beta');
    // Ranked: the biggest bar is first, and only the top ten are drawn.
    expect(bars.indexOf('Beta')).toBeLessThan(bars.indexOf('Alpha'));
    const many = parseMotionData(Array.from({ length: 14 }, (_, i) => `S${i},${i}`).join('\n'));
    expect(many).toHaveLength(14);
  });

  it('the scene is sized from the requested frame size', () => {
    const html = presetHtml('title-card', { title: 'x' }, { durationMs: 2_000, width: 1_080, height: 1_920 });
    expect(html).toContain('width: 1080px');
    expect(html).toContain('height: 1920px');
  });

  it('an unknown name falls back to a title card rather than rendering nothing', () => {
    expect(presetHtml('nope' as never, { title: 'fallback' }, opts)).toContain('fallback');
  });
});

describe('which presets need data', () => {
  it('charts and code do; a title card does not', () => {
    expect(presetNeedsData('bar-race')).toBe(true);
    expect(presetNeedsData('line-reveal')).toBe(true);
    expect(presetNeedsData('code-walkthrough')).toBe(true);
    expect(presetNeedsData('title-card')).toBe(false);
  });

  it('recognises only the presets that exist', () => {
    for (const preset of MOTION_PRESETS) expect(isMotionPreset(preset)).toBe(true);
    expect(isMotionPreset('bar-racee')).toBe(false);
    expect(isMotionPreset(undefined)).toBe(false);
  });
});
