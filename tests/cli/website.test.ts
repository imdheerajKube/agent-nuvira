/**
 * Website command — tests for src/cli/website.ts.
 *
 * The command's job is discoverability: a user who just installed the CLI can
 * reach the site (capabilities, commands, docs, setup) in one step. These tests
 * pin the parts that must not silently break — the URLs and the `--url` headless
 * fallback — without launching a real browser.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Never spawn a real browser in the suite; record the call instead.
const openCalls = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('../../src/utils/open-url.js', () => ({
  openInBrowser: (url: string) => {
    openCalls.urls.push(url);
    return true;
  },
}));

import { WebsiteCommand, WEBSITE_URL, DOCS_URL } from '../../src/cli/website.js';

/** Run the command's action through commander without exiting the process. */
async function run(args: string[]): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  const cmd = new WebsiteCommand().create();
  cmd.exitOverride();
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    spy.mockRestore();
  }
  return out.join('\n');
}

beforeEach(() => {
  openCalls.urls.length = 0;
});

describe('WebsiteCommand', () => {
  it('registers a `website` command with an optional target and a --url flag', () => {
    const cmd = new WebsiteCommand().create();
    expect(cmd.name()).toBe('website');
    expect(cmd.options.map((o) => o.long)).toContain('--url');
  });

  it('opens the site URL in the browser by default', async () => {
    await run([]);
    expect(openCalls.urls).toEqual([WEBSITE_URL]);
    expect(WEBSITE_URL).toBe('https://www.agent-nuvira.com');
  });

  it('opens the docs URL for the `docs` target', async () => {
    await run(['docs']);
    expect(openCalls.urls).toEqual([DOCS_URL]);
  });

  it('--url prints the URL and opens nothing (headless)', async () => {
    const output = await run(['--url']);
    expect(output).toContain(WEBSITE_URL);
    expect(openCalls.urls).toEqual([]);
  });

  it('--url with the docs target prints the docs URL', async () => {
    const output = await run(['docs', '--url']);
    expect(output).toContain(DOCS_URL);
    expect(openCalls.urls).toEqual([]);
  });
});