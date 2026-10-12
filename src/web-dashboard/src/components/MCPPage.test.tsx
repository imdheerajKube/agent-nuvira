/**
 * MCPPage tests — the dashboard half of MCP configuration.
 *
 * The page exists so MCP can be configured WITHOUT the terminal, and it must
 * write the SAME `mcp.*` data the CLI does. So these tests drive it through the
 * real client functions (`getMcpConfig` → `sendAdminRequest('/api/mcp')`), and
 * assert the exact URL + keys it sends — that is the parity claim, checked at
 * the boundary rather than in the page's own vocabulary.
 *
 * The three things covered: the shared settings write the CLI also makes, the
 * catalog's dependency report (a missing binary vs a service that is installed
 * but DOWN — the docker case), and the role gate for a read-only viewer.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import MCPPage, { EMPTY_CUSTOM_DRAFT, draftFromServer, parseArgsList, parseEnvLines, parseHeaderLines } from './MCPPage';
import { dashboardAPI, type McpConfigView } from '../api';

const VIEW: McpConfigView = {
  ok: true,
  canWrite: true,
  configDir: '/home/u/.nuvira/mcp',
  deep: true,
  settings: {
    enabled: true,
    autoConnect: true,
    connectTimeoutMs: 8000,
    maxToolsPerServer: 12,
    maxToolsTotal: 40,
    subagentInheritance: 'conservative',
    servers: { github: { enabled: true, variant: 'npx' } },
    warnings: [],
  },
  servers: [
    {
      name: 'github',
      transport: 'stdio',
      enabled: true,
      variant: 'npx',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github@0.6.2'],
      url: null,
      runtime: null,
      envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
      headerKeys: [],
      origin: 'catalog',
      connected: true,
      toolCount: 5,
    },
    {
      // A server nobody curated — the "configuration, not code" case the page
      // must be able to create and edit.
      name: 'notion-lite',
      transport: 'sse',
      enabled: true,
      variant: null,
      command: null,
      args: [],
      url: 'https://mcp.notion.example/sse',
      runtime: null,
      envKeys: [],
      headerKeys: ['Authorization'],
      origin: 'custom',
      connected: false,
      toolCount: 0,
    },
  ],
  catalog: [
    {
      name: 'fetch',
      description: 'Fetch a URL and return its contents as markdown.',
      offers: ['read a web page', 'read a PDF'],
      supersedes: null,
      installed: false,
      variants: [
        {
          id: 'uvx',
          label: 'uvx (mcp-server-fetch)',
          transport: 'stdio',
          command: 'uvx',
          args: ['mcp-server-fetch'],
          url: null,
          trust: 'vendor',
          optIn: false,
          note: null,
          requires: [{ kind: 'command', name: 'uvx', minVersion: null, hint: 'Install uv: https://docs.astral.sh/uv/' }],
          status: { ok: true, problems: [], unverified: [], needsDeep: false },
        },
        {
          id: 'docker',
          label: 'docker (mcp/fetch image)',
          transport: 'stdio',
          command: 'docker',
          args: ['run', '-i', '--rm', 'mcp/fetch'],
          url: null,
          trust: 'vendor',
          optIn: false,
          note: 'The publisher tags this image `latest` only.',
          requires: [
            { kind: 'service', name: 'docker', minVersion: null, hint: 'START the Docker daemon' },
          ],
          // The live 2026-10-12 state: the CLI is installed, the daemon is down.
          status: {
            ok: false,
            problems: [
              "'docker' is installed (/opt/homebrew/bin/docker) but not running: " +
                "failed to connect to the docker API … no such file or directory — START the Docker daemon",
            ],
            unverified: [],
            needsDeep: false,
          },
        },
      ],
    },
  ],
};

/** Route each `/api/mcp*` request to a canned reply, like the server would. */
function mockServer(overrides: Partial<{ canWrite: boolean }> = {}) {
  const view = { ...structuredClone(VIEW), canWrite: overrides.canWrite ?? true };
  const spy = vi.spyOn(dashboardAPI, 'sendAdminRequest').mockImplementation(async (path, method, body) => {
    if (path.startsWith('/api/mcp?deep=1') || path === '/api/mcp') return { status: 200, data: view };
    if (path === '/api/mcp/settings') {
      const patch = (body as { patch: Array<{ key: string; value: string }> }).patch;
      const settings = structuredClone(view.settings);
      for (const { key, value } of patch) {
        if (key === 'mcp.maxToolsTotal') settings.maxToolsTotal = Number(value);
      }
      return { status: 200, data: { ok: true, settings } };
    }
    if (path === '/api/mcp/install') {
      return { status: 200, data: { ok: true, variantId: 'uvx', path: '/home/u/.nuvira/mcp/fetch.json' } };
    }
    if (path === '/api/mcp/servers') {
      const named = (body as { name?: string }).name ?? 'server';
      return {
        status: 200,
        data: { ok: true, path: `/home/u/.nuvira/mcp/${named}.json`, overwrote: (body as { overwrite?: boolean }).overwrite === true },
      };
    }
    if (path === '/api/mcp/uninstall') {
      return { status: 200, data: { ok: true } };
    }
    return { status: 404, data: null };
  });
  return { view, spy };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MCPPage', () => {
  it('reads the shared mcp config on load and names the config directory', async () => {
    mockServer();
    render(<MCPPage />);

    expect(await screen.findByText('/home/u/.nuvira/mcp')).toBeDefined();
    // Settings, configured servers and the catalog all come from ONE view.
    expect(screen.getByDisplayValue('40')).toBeDefined();
    expect(screen.getByText('github')).toBeDefined();
    // Credentials are reported by KEY NAME only — never the value.
    expect(screen.getByText(/credentials: GITHUB_PERSONAL_ACCESS_TOKEN/)).toBeDefined();
  });

  it('saves a setting through /api/mcp/settings with the SAME key the CLI uses', async () => {
    const { spy } = mockServer();
    render(<MCPPage />);

    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '55' } });
    fireEvent.click(within(input.parentElement as HTMLElement).getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/mcp/settings', 'POST', {
        patch: [{ key: 'mcp.maxToolsTotal', value: '55' }],
      }),
    );
    // The reply is what the page shows — one source, not a local optimistic value.
    expect(await screen.findByDisplayValue('55')).toBeDefined();
  });

  it('reports a dependency that is missing differently from a service that is DOWN', async () => {
    mockServer();
    render(<MCPPage />);

    // The docker variant: the binary is present and its daemon is down.
    const problem = await screen.findByText(/installed \(\/opt\/homebrew\/bin\/docker\) but not running/);
    expect(problem.textContent).toMatch(/START the Docker daemon/);
    // It must NOT tell the user to install something they already have.
    expect(problem.textContent).not.toMatch(/not found on PATH/);
  });

  it('installs through /api/mcp/install and sends only the selected variant', async () => {
    const { spy } = mockServer();
    render(<MCPPage />);

    const entry = (await screen.findByText('fetch')).closest('.mcp-variant') as HTMLElement;
    fireEvent.click(within(entry).getByText('docker'));
    fireEvent.click(within(entry).getByRole('button', { name: /^install/i }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/mcp/install', 'POST', { name: 'fetch', variant: 'docker' }),
    );
  });

  it('disables every write control for a viewer, through the canWrite flag', async () => {
    mockServer({ canWrite: false });
    render(<MCPPage />);

    const input = await screen.findByDisplayValue('40');
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: /^install/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // …including the custom-server form, which is a config write like any other.
    expect((screen.getByPlaceholderText('my-server') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^add server$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('labels a configured server with where it came from', async () => {
    mockServer();
    render(<MCPPage />);

    // The catalog install shows its variant; the hand-written one shows none.
    expect(await screen.findByText('variant npx')).toBeDefined();
    const custom = screen.getByText('notion-lite').closest('.mcp-variant') as HTMLElement;
    expect(within(custom).queryByText(/variant/)).toBeNull();
    // A remote server's credential IS a header, reported by NAME only.
    expect(within(custom).getByText(/headers: Authorization/)).toBeDefined();
  });

  it('adds a stdio server through /api/mcp/servers — no catalog entry required', async () => {
    const { spy } = mockServer();
    render(<MCPPage />);

    fireEvent.change(await screen.findByPlaceholderText('my-server'), {
      target: { value: 'my-private-server' },
    });
    fireEvent.change(screen.getByPlaceholderText('npx'), { target: { value: 'node' } });
    fireEvent.change(screen.getByPlaceholderText(/^-y, @modelcontextprotocol/), {
      target: { value: '/opt/servers/mine.mjs, --stdio' },
    });
    fireEvent.change(screen.getByPlaceholderText(/TOKEN=/), {
      target: { value: 'TOKEN=abc123\n\n# a comment\nOTHER=xyz' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^add server$/i }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/mcp/servers', 'POST', {
        name: 'my-private-server',
        transport: 'stdio',
        command: 'node',
        args: ['/opt/servers/mine.mjs', '--stdio'],
        // Blank lines and comments are skipped, not written as empty values.
        env: { TOKEN: 'abc123', OTHER: 'xyz' },
      }),
    );
    expect(await screen.findByText(/Added my-private-server/)).toBeDefined();
  });

  it('adds a remote server with headers and sends no command', async () => {
    const { spy } = mockServer();
    render(<MCPPage />);

    fireEvent.click(await screen.findByLabelText(/remote \(Streamable HTTP\)/));
    fireEvent.change(screen.getByPlaceholderText('my-server'), { target: { value: 'vendor-remote' } });
    fireEvent.change(screen.getByPlaceholderText('https://example.com/mcp'), {
      target: { value: 'https://mcp.vendor.example/http' },
    });
    fireEvent.change(screen.getByPlaceholderText('Authorization: Bearer …'), {
      target: { value: 'Authorization: Bearer sk-live\nX-Org: acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^add server$/i }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/mcp/servers', 'POST', {
        name: 'vendor-remote',
        transport: 'sse',
        url: 'https://mcp.vendor.example/http',
        headers: { Authorization: 'Bearer sk-live', 'X-Org': 'acme' },
      }),
    );
  });

  it('edits an existing server: prefills it, keeps its secrets, and sends overwrite', async () => {
    const { spy } = mockServer();
    render(<MCPPage />);

    const custom = (await screen.findByText('notion-lite')).closest('.mcp-variant') as HTMLElement;
    fireEvent.click(within(custom).getByRole('button', { name: /^edit$/i }));

    // Prefilled from what the API is allowed to return: the header NAME with no
    // value, and overwrite on (this is a replacement of the same name).
    expect((screen.getByPlaceholderText('my-server') as HTMLInputElement).value).toBe('notion-lite');
    expect((screen.getByPlaceholderText('https://example.com/mcp') as HTMLInputElement).value).toBe(
      'https://mcp.notion.example/sse',
    );
    expect((screen.getByPlaceholderText('Authorization: Bearer …') as HTMLTextAreaElement).value).toBe(
      'Authorization: ',
    );
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /^save server$/i }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/mcp/servers', 'POST', {
        name: 'notion-lite',
        transport: 'sse',
        url: 'https://mcp.notion.example/sse',
        // The blank header value is omitted entirely, so the server keeps the
        // one it already has instead of blanking it.
        headers: {},
        overwrite: true,
      }),
    );
    expect(await screen.findByText(/Updated notion-lite/)).toBeDefined();
  });

  it('shows a refusal from the server instead of pretending it saved', async () => {
    mockServer();
    vi.spyOn(dashboardAPI, 'sendAdminRequest').mockImplementation(async (path) => {
      if (path.startsWith('/api/mcp')) {
        if (path === '/api/mcp/servers') {
          return { status: 400, data: { ok: false, error: "'../evil' is not a usable server name." } };
        }
        return { status: 200, data: structuredClone(VIEW) };
      }
      return { status: 404, data: null };
    });
    render(<MCPPage />);

    fireEvent.change(await screen.findByPlaceholderText('my-server'), { target: { value: '../evil' } });
    fireEvent.change(screen.getByPlaceholderText('npx'), { target: { value: 'node' } });
    fireEvent.click(screen.getByRole('button', { name: /^add server$/i }));

    expect(await screen.findByText(/not a usable server name/)).toBeDefined();
  });
});

describe('MCPPage custom-server parsing', () => {
  it('parses env lines, skipping blanks, comments and valueless keys', () => {
    expect(parseEnvLines('A=1\n\n B = 2 \n# comment\nNOEQUALS\nC=\n')).toEqual({ A: '1', B: '2' });
    expect(parseEnvLines('')).toEqual({});
  });

  it('parses header lines on the FIRST colon, so a URL value survives', () => {
    expect(parseHeaderLines('Authorization: Bearer a:b:c\nX-Org: acme\nBare: \n')).toEqual({
      Authorization: 'Bearer a:b:c',
      'X-Org': 'acme',
    });
  });

  it('splits arguments on commas and keeps quoted runs intact', () => {
    expect(parseArgsList('-y, @modelcontextprotocol/server-filesystem, /path with spaces')).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/path with spaces',
    ]);
    expect(parseArgsList('   ')).toEqual([]);
  });

  it('prefills a draft with credential NAMES only — never a value', () => {
    const draft = draftFromServer({
      name: 'x',
      transport: 'stdio',
      enabled: true,
      variant: null,
      command: 'npx',
      args: ['-y', 'pkg'],
      url: null,
      runtime: null,
      envKeys: ['TOKEN'],
      headerKeys: [],
      origin: 'custom',
      connected: false,
      toolCount: 0,
    });
    expect(draft.name).toBe('x');
    expect(draft.args).toBe('-y, pkg');
    expect(draft.env).toBe('TOKEN=');
    expect(draft.overwrite).toBe(true);
    expect(EMPTY_CUSTOM_DRAFT.name).toBe('');
    expect(EMPTY_CUSTOM_DRAFT.overwrite).toBe(false);
  });
});
