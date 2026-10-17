/**
 * Motion — the animated videos this workspace has rendered.
 *
 * WHY THIS PAGE EXISTS. The renderer was real and the artifacts were real, and
 * the only way to see either was to remember that a chat turn could make one and
 * then find the file. A capability with no visible output is, for most users,
 * not a capability. So this page answers the two questions a person actually
 * has, in that order:
 *
 *   1. "What has been made here?" — every render, playable inline (through
 *      `/api/motion-file`, which resolves an ID through our own manifest store,
 *      never a path from the query), with its length, size, frame and source.
 *   2. "How do I make one?" — the three real entry points, printed on the page
 *      rather than buried in a README: a chat ask, a one-line CLI render (no
 *      model in the loop), and `doctor` for a machine that cannot render yet.
 *
 * Read-only by design. Authoring an animation is the agent's job (a preset plus
 * the user's data is the deterministic case; hand-written HTML is the flexible
 * one), and this page is the place the result lands.
 */

import { useEffect, useState } from 'react';

import { dashboardAPI } from '../api';
import type { MotionData, MotionRenderInfo } from '../types';
import PageHeader from './PageHeader';

/** `2.5s` / `1m 05s`. Short renders keep a decimal — rounding 2.5s to "3s"
 * would misreport the file under review. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) {
    const short = seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, '') : String(Math.round(seconds));
    return `${short}s`;
  }
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(createdAt: number): string {
  try {
    return new Date(createdAt).toLocaleString();
  } catch {
    return '—';
  }
}

/** What the render WAS, in the words a user would use for it. */
function sourceLabel(render: MotionRenderInfo): string {
  if (render.preset) return render.preset;
  // An encoded frame sequence came from the agent's OWN renderer (python/PIL,
  // Manim, Blender, Three.js) — not from an authored page, and calling it
  // "hand-written animation" would hide the more interesting of the two.
  return render.source === 'frames' ? 'your own renderer' : 'hand-written animation';
}

/** The heading of a card: the title it was given, else the scene it used. */
function cardTitle(render: MotionRenderInfo): string {
  return render.title || sourceLabel(render);
}

function Meta({ render }: { render: MotionRenderInfo }) {
  const parts = [
    formatDuration(render.durationMs),
    `${render.width}×${render.height}`,
    `${render.fps} fps`,
    render.format,
    formatBytes(render.bytes),
    sourceLabel(render),
    ...(render.revisions > 0 ? [`revised ${render.revisions}×`] : []),
    ...(render.captions ? ['captions'] : []),
  ];
  return (
    <p className="motion-meta" data-testid={`motion-meta-${render.id}`}>
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 ? ' · ' : ''}
          {part}
        </span>
      ))}
    </p>
  );
}

/** A render, with its video played from the id-resolved file endpoint. */
function RenderCard({ render }: { render: MotionRenderInfo }) {
  return (
    <li className="motion-card" data-testid="motion-render">
      <h3 className="motion-card-title">{cardTitle(render)}</h3>
      {/* preload=metadata: a list of ten 20-second videos must not download
          ten videos to render a page. */}
      <video
        className="motion-video"
        data-testid={`motion-video-${render.id}`}
        controls
        preload="metadata"
        playsInline
        src={`/api/motion-file?id=${encodeURIComponent(render.id)}`}
        aria-label={`Animated video: ${cardTitle(render)}`}
      />
      <Meta render={render} />
      <p className="motion-when">{formatWhen(render.createdAt)}</p>
      <p className="motion-path" title={render.path}>
        {render.file}
      </p>
    </li>
  );
}

/** How to make one — shown empty or not, because that is the discoverability. */
function MakeOne() {
  return (
    <section className="motion-howto" data-testid="motion-howto">
      <h2 className="section-title">Make one</h2>
      <ul className="motion-howto-list">
        <li>
          <strong>Ask the agent.</strong> In Chat, say what it should show:{' '}
          <code>&quot;turn README.md into a 20s animated explainer with captions, 9:16&quot;</code>.
          It storyboards, renders and reports the file.
        </li>
        <li>
          <strong>Render from your data, no model involved.</strong>{' '}
          <code>nuvira motion render --preset bar-race --data numbers.csv --aspect 9:16</code>
        </li>
        <li>
          <strong>See the ready-made scenes.</strong> <code>nuvira motion presets</code> — a title card, a
          bar race, a line reveal, or a code walkthrough.
        </li>
        <li>
          <strong>Nothing renders?</strong> <code>nuvira motion doctor</code> names the missing piece
          (chromium for frames, ffmpeg to encode) and the command that installs it.
        </li>
      </ul>
    </section>
  );
}

export default function MotionPage() {
  const [data, setData] = useState<MotionData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    dashboardAPI
      .fetchMotion()
      .then((next) => {
        if (!live) return;
        setData(next);
        setLoading(false);
      })
      .catch(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const renders = data?.renders ?? [];

  return (
    <div className="page" data-testid="motion-page">
      <PageHeader
        icon="🎬"
        title="Motion"
        description="Animated videos this workspace has rendered — code-authored and frame-accurate, so the same source always renders the same file."
      />

      {loading ? (
        <p className="muted" data-testid="motion-loading">
          Loading renders…
        </p>
      ) : data === null ? (
        <p className="muted" data-testid="motion-unavailable">
          Could not read the render history from the dashboard server. The videos are still on disk;
          run <code>nuvira motion list</code> to see their paths.
        </p>
      ) : renders.length === 0 ? (
        <section className="panel" data-testid="motion-empty">
          <h2 className="section-title">Nothing rendered in this workspace yet</h2>
          <p>
            Ask the agent for an animation, or render one directly — a preset plus your data does not
            need a model. Renders are kept in <code>{data.home}</code> and appear here.
          </p>
        </section>
      ) : (
        <>
          <p className="muted" data-testid="motion-count">
            {renders.length} render{renders.length === 1 ? '' : 's'} · kept in <code>{data.home}</code>
          </p>
          <ul className="motion-grid" aria-label="Rendered animations">
            {renders.map((render) => (
              <RenderCard key={render.id} render={render} />
            ))}
          </ul>
        </>
      )}

      <MakeOne />
    </div>
  );
}
