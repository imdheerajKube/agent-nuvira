/**
 * MotionPage tests — the page that makes rendered videos findable.
 *
 * The failure this guards is not cosmetic: before this page, a render reached a
 * user only as a file path in a chat transcript, so "make me a video" produced
 * something most people could not open. So the tests assert the three things
 * that fix it — a render PLAYS (the video points at the id-resolved endpoint,
 * not a filesystem path), the facts a reviewer needs are shown, and the page
 * teaches the entry points when there is nothing to show yet.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

import MotionPage from './MotionPage';
import { dashboardAPI } from '../api';
import type { MotionData, MotionRenderInfo } from '../types';

const RENDER: MotionRenderInfo = {
  id: 'motion-20261017-mxtjwd',
  createdAt: Date.UTC(2026, 9, 17, 9, 30),
  source: 'preset',
  preset: 'title-card',
  title: 'Motion, from the CLI',
  durationMs: 2500,
  fps: 30,
  width: 640,
  height: 360,
  format: 'mp4',
  bytes: 14 * 1024,
  revisions: 2,
  captions: true,
  path: '/tmp/project/.nuvira/artifacts/motion/cli-smoke-mvbzamxm.mp4',
  file: 'cli-smoke-mvbzamxm.mp4',
};

function stub(data: MotionData | null): void {
  vi.spyOn(dashboardAPI, 'fetchMotion').mockResolvedValue(data);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MotionPage — renders are playable, not just present', () => {
  it('plays a render through the id-resolved endpoint, never a filesystem path', async () => {
    stub({ ok: true, home: '/tmp/project/.nuvira/motion', renders: [RENDER] });
    render(<MotionPage />);

    const video = await screen.findByTestId(`motion-video-${RENDER.id}`);
    expect(video.getAttribute('src')).toBe(`/api/motion-file?id=${encodeURIComponent(RENDER.id)}`);
    // The absolute path is shown as text (a user may want the file), but must
    // never be the stream source — the endpoint resolves ids, not paths.
    expect(video.getAttribute('src')).not.toContain('/.nuvira/');
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(screen.getByText(RENDER.file)).toBeTruthy();
  });

  it('shows the facts a reviewer needs, and the title the render was given', async () => {
    stub({ ok: true, home: '/tmp/project/.nuvira/motion', renders: [RENDER] });
    render(<MotionPage />);

    expect(await screen.findByText('Motion, from the CLI')).toBeTruthy();
    const meta = screen.getByTestId(`motion-meta-${RENDER.id}`).textContent ?? '';
    expect(meta).toContain('640×360');
    expect(meta).toContain('30 fps');
    expect(meta).toContain('14.0 KB');
    expect(meta).toContain('revised 2×');
    expect(meta).toContain('captions');
  });

  it('falls back to the scene name when a render was not given a title', async () => {
    stub({
      ok: true,
      home: '/tmp/project/.nuvira/motion',
      renders: [{ ...RENDER, title: null, preset: null }],
    });
    render(<MotionPage />);
    expect(await screen.findByText('hand-written animation')).toBeTruthy();
  });
});

describe('MotionPage — an empty workspace teaches instead of shrugging', () => {
  it('names the three entry points when nothing has been rendered', async () => {
    stub({ ok: true, home: '/tmp/project/.nuvira/motion', renders: [] });
    render(<MotionPage />);

    expect(await screen.findByTestId('motion-empty')).toBeTruthy();
    const howto = screen.getByTestId('motion-howto').textContent ?? '';
    expect(howto).toContain('nuvira motion render --preset bar-race --data numbers.csv');
    expect(howto).toContain('nuvira motion presets');
    expect(howto).toContain('nuvira motion doctor');
    expect(howto).toContain('turn README.md into a 20s animated explainer');
  });

  it('says the files still exist when the server cannot be read', async () => {
    stub(null);
    render(<MotionPage />);
    const unavailable = await screen.findByTestId('motion-unavailable');
    expect(unavailable.textContent).toContain('nuvira motion list');
  });

  it('waits for the fetch instead of claiming the workspace is empty', () => {
    stub({ ok: true, home: '/tmp', renders: [] });
    render(<MotionPage />);
    expect(screen.getByTestId('motion-loading')).toBeTruthy();
  });
});
