/**
 * Motion presets — ready-made animations for the shapes people actually ask for.
 *
 * WHY PRESETS AT ALL. The seek contract (see `motion.ts`) makes ANY animation
 * renderable, but the quality of the output then depends entirely on the model
 * writing good motion code, and a small local model writes a title card that
 * looks like a slide. These are the answer: four scene templates that are known
 * to look right, are animated as a PURE FUNCTION OF TIME (`seek(t)` — no rAF, no
 * timers), and take the user's real data.
 *
 * Two rules every template here follows, and both are load-bearing:
 *
 *   1. NOTHING IS FETCHED. No CDN font, no chart library, no image URL. A render
 *      must work on a machine with no network, and a chart library would make the
 *      output depend on whatever version loaded that day.
 *   2. `seek(t)` is deterministic — computed from `t` and nothing else (not
 *      `Date.now()`, not a counter), so frame 120 is frame 120 on a fast machine
 *      and on a slow one.
 *
 * Templates receive the user's text verbatim, so every interpolation is escaped:
 * an `<` in a company name must not become markup.
 */

/** The available scene templates. */
export type MotionPreset = 'title-card' | 'bar-race' | 'line-reveal' | 'code-walkthrough';

export const MOTION_PRESETS: readonly MotionPreset[] = ['title-card', 'bar-race', 'line-reveal', 'code-walkthrough'];

export function isMotionPreset(name: unknown): name is MotionPreset {
  return typeof name === 'string' && (MOTION_PRESETS as readonly string[]).includes(name);
}

/** Presets that cannot do anything sensible without the caller's data. */
const DATA_PRESETS: readonly MotionPreset[] = ['bar-race', 'line-reveal', 'code-walkthrough'];

export function presetNeedsData(preset: MotionPreset): boolean {
  return DATA_PRESETS.includes(preset);
}

export interface MotionPresetParams {
  title?: string;
  subtitle?: string;
  kicker?: string;
  /** Accent colour for the moving parts. */
  accent?: string;
  background?: string;
  foreground?: string;
  /** e.g. '%', 'ms', '$' — appended to values in bar/line scenes. */
  unit?: string;
  decimals?: number;
  /** The caller's data: JSON (array of numbers / `{label,value}` / `{series}`) or CSV. */
  data?: unknown;
}

export interface MotionPresetOptions {
  durationMs: number;
  width: number;
  height: number;
}

// ─── Text + data handling ──────────────────────────────────────────────────

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface MotionDataPoint {
  label: string;
  value: number;
}

/**
 * Parse the caller's data into labelled points. Accepts the shapes a model
 * actually produces: a JSON array of numbers, of `{label, value}`, of `[label,
 * value]` pairs, a `{series}`/`{data}`/`{points}` wrapper, or CSV (header or
 * not) with the label first. Returns an empty list rather than throwing — the
 * caller decides what an unusable payload means.
 */
export function parseMotionData(raw: unknown): MotionDataPoint[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        return parseMotionData(JSON.parse(text));
      } catch {
        return [];
      }
    }
    return parseCsv(text);
  }
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (typeof first === 'number' || typeof first === 'string') {
      // A bare series: the index is the label.
      return raw
        .map((entry, index) => ({ label: String(index + 1), value: toNumber(entry) }))
        .filter((point) => Number.isFinite(point.value));
    }
    return raw
      .map((entry: unknown, index: number) => {
        if (Array.isArray(entry)) return { label: String(entry[0] ?? index + 1), value: toNumber(entry[1]) };
        if (entry && typeof entry === 'object') {
          const row = entry as Record<string, unknown>;
          const label = row.label ?? row.name ?? row.x ?? row.key ?? row.category ?? String(index + 1);
          // `value` may be spelled the domain's way (count, revenue, qty…): the
          // first numeric field that is not the label wins.
          const value = row.value ?? row.y ?? row.count ?? row.total ?? row.revenue ?? row.qty ?? firstNumeric(row);
          return { label: String(label), value: toNumber(value) };
        }
        return { label: String(index + 1), value: toNumber(entry) };
      })
      .filter((point) => Number.isFinite(point.value));
  }
  if (typeof raw === 'object') {
    const wrapper = raw as Record<string, unknown>;
    for (const key of ['series', 'data', 'points', 'values', 'rows']) {
      if (Array.isArray(wrapper[key])) return parseMotionData(wrapper[key]);
    }
  }
  return [];
}

function firstNumeric(row: Record<string, unknown>): number {
  for (const value of Object.values(row)) {
    const n = toNumber(value);
    if (Number.isFinite(n) && typeof value !== 'string') return n;
    if (Number.isFinite(n) && String(value).trim() !== '' && /^-?\d+(\.\d+)?$/.test(String(value).trim())) return n;
  }
  return Number.NaN;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const n = Number(String(value ?? '').replace(/[$,%\s]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Split one CSV line, honouring quoted cells.
 *
 * A spreadsheet export quotes any cell containing the delimiter, so
 * `Alpha,"$1,200"` is TWO cells and a naive split reads the value as `$1` — a
 * chart that quietly shows 1 instead of 1,200, which is worse than refusing the
 * data. `""` inside a quoted cell is an escaped quote.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else quoted = false;
      } else current += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',' || ch === ';' || ch === '\t') {
      cells.push(current.trim());
      current = '';
    } else current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseCsv(text: string): MotionDataPoint[] {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(splitCsvLine);
  if (rows.length === 0) return [];
  // A header row is detected rather than assumed: it is a row whose second cell
  // is not a number.
  const hasHeader = rows.length > 1 && !Number.isFinite(toNumber(rows[0][1] ?? '')) && rows[0].length > 1;
  const body = hasHeader ? rows.slice(1) : rows;
  return body
    .map((cells, index) => {
      const label = cells.length > 1 ? cells[0] : String(index + 1);
      const value = cells.length > 1 ? cells[1] : cells[0];
      return { label: label || String(index + 1), value: toNumber(value) };
    })
    .filter((point) => Number.isFinite(point.value));
}

// ─── Shared shell ──────────────────────────────────────────────────────────

interface Theme {
  accent: string;
  background: string;
  foreground: string;
  muted: string;
  width: number;
  height: number;
}

function theme(params: MotionPresetParams, opts: MotionPresetOptions): Theme {
  return {
    accent: params.accent || '#4f9cf9',
    background: params.background || '#0b1020',
    foreground: params.foreground || '#f5f7fb',
    muted: 'rgba(245,247,251,0.62)',
    width: opts.width,
    height: opts.height,
  };
}

/**
 * The page shell: theme, centring, and the timeline helpers every preset uses.
 * `seek(t)` is expected to be defined by the scene body, which is why the shell
 * also exposes `ease`/`win` there — one implementation of "how motion feels".
 */
function shell(t: Theme, opts: MotionPresetOptions, body: string, script: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${t.width}px; height: ${t.height}px; overflow: hidden; background: ${t.background}; }
  body {
    font-family: ${'"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'};
    color: ${t.foreground};
    -webkit-font-smoothing: antialiased;
  }
  .stage { position: relative; width: ${t.width}px; height: ${t.height}px; padding: ${Math.round(t.height * 0.08)}px; }
  .accent { color: ${t.accent}; }
</style></head>
<body><div class="stage">${body}</div>
<script>
(function () {
  var D = ${opts.durationMs};
  // A pure easing + window helper pair: every scene is a function of t, so the
  // same t always paints the same frame.
  function ease(p) { return p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.pow(1 - p, 3); }
  function win(t, from, span) { return ease(span <= 0 ? 1 : (t - from) / span); }
  function clamp01(p) { return p <= 0 ? 0 : p >= 1 ? 1 : p; }
  window.__motion = { duration: D, seek: function (t) { __seek(clamp01(t / D), t); } };
  function __seek(p, t) {
${script}
  }
})();
</script>
</body></html>`;
}

// ─── Preset: title card ────────────────────────────────────────────────────

function titleCard(params: MotionPresetParams, opts: MotionPresetOptions): string {
  const t = theme(params, opts);
  const title = escapeHtml(params.title || 'Untitled');
  const subtitle = escapeHtml(params.subtitle || '');
  const kicker = escapeHtml(params.kicker || '');
  const body = `
    <div style="position:absolute;left:${Math.round(t.width * 0.08)}px;top:50%;transform:translateY(-50%);max-width:${Math.round(t.width * 0.84)}px">
      ${kicker ? `<div id="kicker" style="font-size:${Math.round(t.height * 0.035)}px;letter-spacing:0.18em;text-transform:uppercase;color:${t.accent};opacity:0">${kicker}</div>` : ''}
      <div id="title" style="font-size:${Math.round(t.height * 0.115)}px;font-weight:800;line-height:1.06;letter-spacing:-0.02em;opacity:0">${title}</div>
      <div id="rule" style="height:6px;border-radius:3px;background:${t.accent};width:0;margin:${Math.round(t.height * 0.045)}px 0"></div>
      ${subtitle ? `<div id="subtitle" style="font-size:${Math.round(t.height * 0.05)}px;color:${t.muted};opacity:0">${subtitle}</div>` : ''}
    </div>`;
  const script = `    var D = window.__motion.duration;
    var kicker = document.getElementById('kicker');
    var title = document.getElementById('title');
    var rule = document.getElementById('rule');
    var subtitle = document.getElementById('subtitle');
    if (kicker) { kicker.style.opacity = win(t, 0, D * 0.16); kicker.style.transform = 'translateY(' + (1 - win(t, 0, D * 0.16)) * 18 + 'px)'; }
    var tp = win(t, D * 0.08, D * 0.34);
    title.style.opacity = tp;
    title.style.transform = 'translateY(' + (1 - tp) * 26 + 'px)';
    rule.style.width = (win(t, D * 0.3, D * 0.3) * 100) + '%';
    if (subtitle) { subtitle.style.opacity = win(t, D * 0.5, D * 0.3); subtitle.style.transform = 'translateY(' + (1 - win(t, D * 0.5, D * 0.3)) * 14 + 'px)'; }`;
  return shell(t, opts, body, script);
}

// ─── Preset: bar race ──────────────────────────────────────────────────────

function barRace(params: MotionPresetParams, opts: MotionPresetOptions): string {
  const t = theme(params, opts);
  const points = parseMotionData(params.data)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  const max = points.reduce((m, p) => Math.max(m, Math.abs(p.value)), 0) || 1;
  const decimals = Number.isFinite(params.decimals) ? Number(params.decimals) : 0;
  const unit = escapeHtml(params.unit || '');
  const title = escapeHtml(params.title || '');
  const rowHeight = Math.min(72, Math.max(28, Math.floor((t.height * 0.74) / Math.max(1, points.length))));
  const bars = points
    .map(
      (p, i) => `
      <div class="row" data-i="${i}" style="display:flex;align-items:center;gap:${Math.round(t.width * 0.014)}px;height:${rowHeight}px;opacity:0">
        <div class="lbl" style="width:${Math.round(t.width * 0.22)}px;font-size:${Math.round(rowHeight * 0.42)}px;color:${t.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.label)}</div>
        <div style="flex:1;position:relative;height:${Math.round(rowHeight * 0.62)}px;background:rgba(255,255,255,0.06);border-radius:${Math.round(rowHeight * 0.3)}px">
          <div class="bar" data-i="${i}" style="position:absolute;inset:0 auto 0 0;width:0;border-radius:${Math.round(rowHeight * 0.3)}px;background:linear-gradient(90deg, ${t.accent}, ${t.accent}aa)"></div>
        </div>
        <div class="val" data-i="${i}" style="width:${Math.round(t.width * 0.16)}px;text-align:right;font-variant-numeric:tabular-nums;font-size:${Math.round(rowHeight * 0.46)}px;font-weight:700">0</div>
      </div>`,
    )
    .join('');
  const body = `
    ${title ? `<div style="font-size:${Math.round(t.height * 0.055)}px;font-weight:700;margin-bottom:${Math.round(t.height * 0.03)}px">${title}</div>` : ''}
    <div>${bars}</div>`;
  const values = points.map((p) => Math.abs(p.value));
  const script = `    var D = window.__motion.duration;
    var max = ${max};
    var values = ${JSON.stringify(values)};
    var decimals = ${decimals};
    var unit = ${JSON.stringify(params.unit || '')};
    var rows = document.querySelectorAll('.row');
    var stagger = (D * 0.5) / Math.max(1, rows.length);
    for (var i = 0; i < rows.length; i++) {
      var start = i * stagger;
      var grow = win(t, start, D * 0.4);
      var row = rows[i];
      row.style.opacity = win(t, start, D * 0.14);
      var bar = row.querySelector('.bar');
      bar.style.width = (grow * (values[i] / max) * 100) + '%';
      var val = row.querySelector('.val');
      val.textContent = (values[i] * grow).toFixed(decimals) + unit;
    }`;
  return shell(t, opts, body, script);
}

// ─── Preset: line reveal ───────────────────────────────────────────────────

function lineReveal(params: MotionPresetParams, opts: MotionPresetOptions): string {
  const t = theme(params, opts);
  const points = parseMotionData(params.data).slice(0, 400);
  const decimals = Number.isFinite(params.decimals) ? Number(params.decimals) : 1;
  const padX = Math.round(t.width * 0.1);
  const padY = Math.round(t.height * 0.16);
  const plotW = t.width - padX * 2;
  const plotH = t.height - padY * 2;
  const values = points.map((p) => p.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = max - min || 1;
  const coords = points.map((p, i) => {
    const x = padX + (points.length <= 1 ? plotW : (i / (points.length - 1)) * plotW);
    const y = padY + plotH - ((p.value - min) / span) * plotH;
    return { x: Math.round(x), y: Math.round(y), label: p.label, value: p.value };
  });
  // Segment length is computed here rather than measured in the DOM: the dash
  // animation then cannot depend on when layout settled.
  let length = 0;
  for (let i = 1; i < coords.length; i += 1) {
    length += Math.hypot(coords[i].x - coords[i - 1].x, coords[i].y - coords[i - 1].y);
  }
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x} ${c.y}`).join(' ');
  const area = coords.length > 1 ? `${path} L${coords[coords.length - 1].x} ${padY + plotH} L${coords[0].x} ${padY + plotH} Z` : '';
  const last = coords[coords.length - 1] ?? { x: padX, y: padY, label: '', value: 0 };
  const title = escapeHtml(params.title || '');
  const unit = escapeHtml(params.unit || '');
  const body = `
    ${title ? `<div style="position:absolute;left:${padX}px;top:${Math.round(padY * 0.4)}px;font-size:${Math.round(t.height * 0.05)}px;font-weight:700">${title}</div>` : ''}
    <svg width="${t.width}" height="${t.height}" style="position:absolute;inset:0">
      ${[0, 0.25, 0.5, 0.75, 1]
        .map((g) => `<line x1="${padX}" y1="${Math.round(padY + plotH * g)}" x2="${padX + plotW}" y2="${Math.round(padY + plotH * g)}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`)
        .join('')}
      ${area ? `<path id="area" d="${area}" fill="${t.accent}" opacity="0"/>` : ''}
      <path id="line" d="${path}" fill="none" stroke="${t.accent}" stroke-width="${Math.max(3, Math.round(t.height * 0.007))}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${length}" stroke-dashoffset="${length}"/>
      <circle id="dot" cx="${last.x}" cy="${last.y}" r="${Math.max(5, Math.round(t.height * 0.011))}" fill="${t.foreground}" opacity="0"/>
    </svg>
    <div id="tip" style="position:absolute;left:${Math.min(last.x + 18, t.width - Math.round(t.width * 0.26))}px;top:${Math.max(8, last.y - Math.round(t.height * 0.09))}px;opacity:0;background:${t.accent};color:${t.background};padding:${Math.round(t.height * 0.014)}px ${Math.round(t.height * 0.022)}px;border-radius:${Math.round(t.height * 0.012)}px;font-weight:700;font-size:${Math.round(t.height * 0.038)}px;font-variant-numeric:tabular-nums">—</div>`;
  const script = `    var D = window.__motion.duration;
    var len = ${Math.round(length)};
    var draw = win(t, D * 0.08, D * 0.62);
    var line = document.getElementById('line');
    if (line) line.setAttribute('stroke-dashoffset', String(len * (1 - draw)));
    var area = document.getElementById('area');
    if (area) area.setAttribute('opacity', String(win(t, D * 0.45, D * 0.4) * 0.16));
    var dot = document.getElementById('dot');
    if (dot) dot.setAttribute('opacity', String(win(t, D * 0.62, D * 0.12)));
    var tip = document.getElementById('tip');
    if (tip) {
      var tipIn = win(t, D * 0.68, D * 0.16);
      tip.style.opacity = String(tipIn);
      tip.style.transform = 'translateY(' + ((1 - tipIn) * 10) + 'px)';
      tip.textContent = (${JSON.stringify(last.value)} * tipIn).toFixed(${decimals}) + ${JSON.stringify(params.unit || '')};
    }`;
  return shell(t, opts, body, script);
}

// ─── Preset: code walkthrough ──────────────────────────────────────────────

function codeWalkthrough(params: MotionPresetParams, opts: MotionPresetOptions): string {
  const t = theme(params, opts);
  const raw = typeof params.data === 'string' ? params.data : Array.isArray(params.data) ? params.data.join('\n') : String(params.data ?? '');
  const lines = raw.split(/\r?\n/).slice(0, 40);
  const title = escapeHtml(params.title || '');
  const fontSize = Math.min(26, Math.max(14, Math.floor((t.height * 0.72) / Math.max(1, lines.length) / 1.5)));
  const lineHeight = Math.round(fontSize * 1.6);
  const top = Math.round(t.height * 0.18);
  const body = `
    ${title ? `<div style="position:absolute;left:${Math.round(t.width * 0.06)}px;top:${Math.round(t.height * 0.05)}px;font-size:${Math.round(t.height * 0.045)}px;font-weight:700">${title}</div>` : ''}
    <div style="position:absolute;left:${Math.round(t.width * 0.06)}px;top:${top}px;right:${Math.round(t.width * 0.06)}px">
      <div id="codebox" style="position:relative;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:${Math.round(t.height * 0.02)}px;padding:${Math.round(fontSize * 0.9)}px ${Math.round(fontSize * 1.2)}px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:${fontSize}px;line-height:${lineHeight}px">
        <div id="hl" style="position:absolute;left:${Math.round(fontSize * 0.5)}px;right:${Math.round(fontSize * 0.5)}px;top:0;height:${lineHeight}px;background:${t.accent}22;border-left:3px solid ${t.accent};border-radius:6px;opacity:0"></div>
        ${lines
          .map(
            (line, i) =>
              `<div class="ln" data-i="${i}" style="position:relative;white-space:pre;opacity:0;color:${line.trimStart().startsWith('//') || line.trimStart().startsWith('#') ? t.muted : t.foreground}">${escapeHtml(line) || '&nbsp;'}</div>`,
          )
          .join('')}
      </div>
    </div>`;
  const script = `    var D = window.__motion.duration;
    var count = ${lines.length};
    var lineHeight = ${lineHeight};
    var lines = document.querySelectorAll('.ln');
    var per = (D * 0.7) / Math.max(1, count);
    for (var i = 0; i < lines.length; i++) {
      var start = D * 0.08 + i * per;
      var shown = win(t, start, per * 0.8);
      lines[i].style.opacity = String(shown);
      lines[i].style.transform = 'translateX(' + ((1 - shown) * 8) + 'px)';
    }
    var idx = Math.min(count - 1, Math.max(0, Math.floor((t - D * 0.08) / Math.max(1, per))));
    var hl = document.getElementById('hl');
    if (hl) {
      hl.style.top = (${Math.round(fontSize * 0.9)} + idx * lineHeight) + 'px';
      hl.style.opacity = String(win(t, D * 0.08, D * 0.1));
    }`;
  return shell(t, opts, body, script);
}

// ─── Entry point ───────────────────────────────────────────────────────────

/** The HTML for a preset. An unknown name falls back to a title card. */
export function presetHtml(preset: MotionPreset, params: MotionPresetParams, opts: MotionPresetOptions): string {
  switch (preset) {
    case 'bar-race':
      return barRace(params, opts);
    case 'line-reveal':
      return lineReveal(params, opts);
    case 'code-walkthrough':
      return codeWalkthrough(params, opts);
    default:
      return titleCard(params, opts);
  }
}
