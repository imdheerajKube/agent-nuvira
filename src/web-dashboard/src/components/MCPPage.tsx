/**
 * MCP — the dashboard half of MCP configuration (2026-10-12).
 *
 * WHY IT EXISTS. MCP was the one capability whose configuration lived ONLY in
 * the CLI (`nuvira mcp install …`, `nuvira config set mcp.*`). That made the
 * dashboard describe a system a user could not configure from it — and Claude
 * Desktop / Cursor make MCP a settings screen.
 *
 * ONE SOURCE OF TRUTH. Every control here writes the same `mcp.*` section of
 * `buffconfig.json`, through the same server-side parser the CLI uses
 * (`/api/mcp/settings` → `parseMcpSetting`/`mergeMcpSetting`), so a value cannot
 * be accepted here and rejected in the terminal, and nothing is stored twice.
 *
 * WHAT IT SHOWS, and why each part is on the same screen:
 *   1. the settings that apply to every server (master switch, auto-connect,
 *      connect budget, per-server + total tool caps, and the subagent rule);
 *   2. the servers already configured — including hand-written ones — with
 *      enable/disable, the runtime/command overrides, and uninstall;
 *   3. the catalog: each capability's OFFERS and every way it can run here, with
 *      the exact dependency that is missing (or the service that is down, which
 *      is a different fix) — so installing is a decision, not a guess.
 *
 * "Check dependencies" re-reads with `?deep=1`, which actually probes services
 * (e.g. `docker info`). A plain load stays cheap and says which checks it
 * skipped rather than implying they passed.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  addMcpServer,
  getMcpConfig,
  installMcpServer,
  saveMcpSettings,
  uninstallMcpServer,
  type McpCatalogEntryView,
  type McpConfigView,
  type McpConfiguredServer,
} from '../api';
import PageHeader from './PageHeader';

// ─── The "add any server" form's pure helpers ───────────────────────────────
//
// Exported so they can be tested directly: parsing is where a mistyped paste
// goes wrong, and the form should never be the only thing that knows the rules.
// Each one SKIPS blank lines rather than writing an empty value — that is what
// lets an edit keep a credential the page was never allowed to display.

/** `KEY=value` per line → a map. Blank lines and blank keys are skipped. */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

/** `Name: value` per line → a map. A bare `Name:` is skipped (nothing to set). */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!name || !value) continue;
    out[name] = value;
  }
  return out;
}

/** Comma-separated arguments → a list, quoted runs preserved verbatim. */
export function parseArgsList(text: string): string[] {
  return text
    .split(',')
    .map((arg) => arg.trim())
    .filter(Boolean);
}

/** The draft behind the "add a server" form. Empty = nothing typed yet. */
export interface CustomServerDraft {
  name: string;
  transport: 'stdio' | 'sse';
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
  overwrite: boolean;
}

export const EMPTY_CUSTOM_DRAFT: CustomServerDraft = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: '',
  headers: '',
  overwrite: false,
};

/** Prefill the form from a configured server, for the Edit affordance. */
export function draftFromServer(server: McpConfiguredServer): CustomServerDraft {
  return {
    name: server.name,
    transport: server.transport === 'sse' ? 'sse' : 'stdio',
    command: server.command ?? '',
    args: server.args.join(', '),
    url: server.url ?? '',
    // KEY NAMES only — the API never returns values, so these are left blank and
    // the server preserves them unless a value is typed over them.
    env: server.envKeys.map((key) => `${key}=`).join('\n'),
    headers: server.headerKeys.map((key) => `${key}: `).join('\n'),
    overwrite: true,
  };
}

/** One editable setting row (text input + Save), used for every scalar key. */
function SettingRow({
  label,
  hint,
  value,
  onSave,
  disabled,
}: {
  label: string;
  hint: string;
  value: string;
  onSave: (next: string) => Promise<string | null>;
  disabled: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(value), [value]);

  const commit = async () => {
    setBusy(true);
    const failure = await onSave(draft);
    setBusy(false);
    setError(failure);
  };

  return (
    <div className="mcp-setting-row">
      <div className="mcp-setting-main">
        <label className="mcp-setting-label">{label}</label>
        <span className="mcp-setting-hint">{hint}</span>
      </div>
      <input
        className="mcp-input"
        value={draft}
        disabled={disabled || busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft !== value) void commit();
        }}
      />
      <button
        className="mcp-btn"
        disabled={disabled || busy || draft === value}
        onClick={() => void commit()}
      >
        {busy ? '…' : 'Save'}
      </button>
      {error && <div className="mcp-error">{error}</div>}

      <style>{`
        .mcp-setting-row { display: grid; grid-template-columns: 1fr 180px 72px; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-light); }
        .mcp-setting-main { display: flex; flex-direction: column; }
        .mcp-setting-label { font-weight: 600; font-size: 13px; }
        .mcp-setting-hint { font-size: 11px; color: var(--text-muted); }
        .mcp-input { background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-light); border-radius: 6px; padding: 6px 8px; font-size: 13px; }
        .mcp-btn { background: var(--accent-blue); color: var(--text-on-accent); border: 0; border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
        .mcp-btn:disabled { opacity: .4; cursor: not-allowed; }
        .mcp-btn.secondary { background: transparent; border: 1px solid var(--border-light); color: var(--text-primary); }
        .mcp-error { grid-column: 1 / -1; color: var(--accent-red); font-size: 12px; white-space: pre-wrap; }
        .mcp-card { border: 1px solid var(--border-light); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
        .mcp-card h3 { margin: 0 0 4px; font-size: 14px; }
        .mcp-muted { color: var(--text-muted); font-size: 12px; }
        .mcp-variant { border-top: 1px dashed var(--border-light); padding: 8px 0; font-size: 12px; }
        .mcp-badge { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 6px; border: 1px solid var(--border-light); }
        .mcp-badge.ok { color: var(--accent-green); }
        .mcp-badge.bad { color: var(--accent-red); }
        .mcp-problem { color: var(--accent-yellow); }
        .mcp-offers { margin: 4px 0 8px 16px; padding: 0; font-size: 12px; }
      `}</style>
    </div>
  );
}

export default function MCPPage(): JSX.Element {
  const [data, setData] = useState<McpConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Env values typed for the install form, keyed by server name. */
  const [installEnv, setInstallEnv] = useState<Record<string, string>>({});
  const [installVariant, setInstallVariant] = useState<Record<string, string>>({});
  const [installRuntime, setInstallRuntime] = useState<Record<string, string>>({});
  /** The "add any server" form — the dashboard half of `nuvira mcp add`. */
  const [draft, setDraft] = useState<CustomServerDraft>(EMPTY_CUSTOM_DRAFT);

  const load = useCallback(async (deep = false) => {
    const view = await getMcpConfig(deep);
    if (!view) {
      setError('Could not reach the dashboard server, or the MCP API is unavailable (an older server?).');
      setLoading(false);
      return;
    }
    setData(view);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const save = async (key: string, value: string): Promise<string | null> => {
    const result = await saveMcpSettings([{ key, value }]);
    if (!result.ok) {
      setError(result.error ?? 'The server refused that value.');
      return result.error ?? 'refused';
    }
    setData((prev) => (prev && result.settings ? { ...prev, settings: result.settings } : prev));
    setNotice(`Saved ${key}`);
    setError(null);
    return null;
  };

  const doInstall = async (entry: McpCatalogEntryView) => {
    const variant = installVariant[entry.name];
    const block = entry.variants.find((v) => v.id === (variant ?? ''));
    const requiredEnv = (block ?? entry.variants.find((v) => !v.optIn) ?? entry.variants[0]).requires.filter(
      (r) => r.kind === 'env',
    );
    const env: Record<string, string> = {};
    for (const req of requiredEnv) {
      const typed = installEnv[`${entry.name}:${req.name}`];
      if (typed && typed.trim()) env[req.name] = typed.trim();
    }
    setBusy(entry.name);
    const result = await installMcpServer({
      name: entry.name,
      ...(variant ? { variant } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(installRuntime[entry.name]?.trim() ? { runtime: installRuntime[entry.name].trim() } : {}),
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.reason ?? result.error ?? 'Install refused.');
      setNotice(null);
      return;
    }
    // Secrets are consumed by the server; drop them from component state.
    setInstallEnv((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) if (key.startsWith(`${entry.name}:`)) delete next[key];
      return next;
    });
    setNotice(`Installed ${entry.name} (${result.variantId}) → ${result.path}`);
    setError(null);
    await load(data?.deep === true);
  };

  const doAddServer = async () => {
    const name = draft.name.trim();
    if (!name) {
      setError('A server name is required — it becomes the config filename.');
      return;
    }
    setBusy('__custom__');
    const result = await addMcpServer({
      name,
      transport: draft.transport,
      ...(draft.transport === 'stdio'
        ? {
            ...(draft.command.trim() ? { command: draft.command.trim() } : {}),
            args: parseArgsList(draft.args),
            env: parseEnvLines(draft.env),
          }
        : {
            ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
            headers: parseHeaderLines(draft.headers),
          }),
      ...(draft.overwrite ? { overwrite: true } : {}),
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.reason ?? result.error ?? 'Could not save that server.');
      setNotice(null);
      return;
    }
    setNotice(
      `${result.overwrote ? 'Updated' : 'Added'} ${name}${result.path ? ` → ${result.path}` : ''}` +
        (result.warnings?.length ? `\n${result.warnings.join('\n')}` : ''),
    );
    setError(null);
    setDraft(EMPTY_CUSTOM_DRAFT);
    await load(data?.deep === true);
  };

  const doUninstall = async (name: string) => {
    setBusy(name);
    const result = await uninstallMcpServer(name);
    setBusy(null);
    if (!result.ok) {
      setError(result.reason ?? 'Could not remove that server.');
      return;
    }
    setNotice(`Removed ${name}`);
    await load(data?.deep === true);
  };

  const canWrite = data?.canWrite ?? false;
  const servers: McpConfiguredServer[] = data?.servers ?? [];

  return (
    <div className="page">
      <PageHeader
        icon="🔌"
        title="MCP"
        description="External MCP servers — configured once here and used by the agent on every surface. These controls write the same mcp.* config the CLI does."
      />

      <div className="mcp-card">
        <div className="mcp-muted">
          Config file: <code>{data?.configDir ?? '…'}</code> — these controls write the same{' '}
          <code>mcp.*</code> keys as <code>nuvira config set mcp.*</code>, so the terminal and this
          page can never disagree.
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="mcp-btn secondary" onClick={() => void load(true)} disabled={loading}>
            Check dependencies
          </button>
          <span className="mcp-muted" style={{ marginLeft: 8 }}>
            {data?.deep
              ? 'service checks ran (e.g. docker daemon)'
              : 'service checks skipped on page load — press to probe them'}
          </span>
        </div>
      </div>

      {error && <div className="mcp-card mcp-problem" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
      {notice && <div className="mcp-card mcp-muted">{notice}</div>}
      {loading && <div className="mcp-card mcp-muted">Loading MCP configuration…</div>}

      {data && (
        <>
          <div className="mcp-card">
            <h3>Settings</h3>
            <div className="mcp-muted">Applies to every MCP server on every surface.</div>
            <SettingRow
              label="Enabled"
              hint="Master switch — false makes MCP inert everywhere (true/false)"
              value={String(data.settings.enabled)}
              disabled={!canWrite}
              onSave={(v) => save('mcp.enabled', v)}
            />
            <SettingRow
              label="Auto-connect"
              hint="Connect configured servers at the start of a turn (bounded, never fatal)"
              value={String(data.settings.autoConnect)}
              disabled={!canWrite}
              onSave={(v) => save('mcp.autoConnect', v)}
            />
            <SettingRow
              label="Connect timeout (ms)"
              hint="Wall-clock budget for the connect step; exceeding it proceeds without MCP"
              value={String(data.settings.connectTimeoutMs)}
              disabled={!canWrite}
              onSave={(v) => save('mcp.connectTimeoutMs', v)}
            />
            <SettingRow
              label="Tools per server"
              hint="Per-server eager-schema cap — stored and reported; enforcement is not wired yet (nothing is truncated today)"
              value={String(data.settings.maxToolsPerServer)}
              disabled={!canWrite}
              onSave={(v) => save('mcp.maxToolsPerServer', v)}
            />
            <SettingRow
              label="Tools in total"
              hint="Cross-server ceiling — stored and reported; enforcement is not wired yet (nothing is truncated today)"
              value={String(data.settings.maxToolsTotal)}
              disabled={!canWrite}
              onSave={(v) => save('mcp.maxToolsTotal', v)}
            />
            <SettingRow
              label="Subagents inherit"
              hint="conservative = only when the parent had MCP AND the child's allowance covers it; full = pass the parent's whole MCP set down (reach, never approval)"
              value={data.settings.subagentInheritance}
              disabled={!canWrite}
              onSave={(v) => save('mcp.subagent.inherit', v)}
            />
            {data.settings.warnings?.length > 0 && (
              <div className="mcp-error">{data.settings.warnings.join('\n')}</div>
            )}
          </div>

          <div className="mcp-card">
            <h3>Configured servers ({servers.length})</h3>
            {servers.length === 0 && (
              <div className="mcp-muted">
                None yet. Add one by hand below (any server), install one from the catalog, or drop a
                JSON file into the config directory.
              </div>
            )}
            {servers.map((s) => {
              const override = data.settings.servers[s.name] ?? {};
              return (
                <div className="mcp-variant" key={s.name}>
                  <div>
                    <strong>{s.name}</strong>
                    <span className="mcp-badge">{s.transport}</span>
                    {s.variant && <span className="mcp-badge">variant {s.variant}</span>}
                    <span className={`mcp-badge ${s.enabled ? 'ok' : 'bad'}`}>
                      {s.enabled ? 'enabled' : 'disabled'}
                    </span>
                    {s.connected && <span className="mcp-badge ok">connected</span>}
                  </div>
                  <div className="mcp-muted">
                    {s.command ? `${s.command} ${s.args.join(' ')}` : s.url}
                    {s.runtime ? `  (runtime: ${[s.runtime.command, ...(s.runtime.args ?? [])].join(' ')})` : ''}
                    {s.envKeys.length > 0 ? `  · credentials: ${s.envKeys.join(', ')}` : ''}
                    {s.headerKeys.length > 0 ? `  · headers: ${s.headerKeys.join(', ')}` : ''}
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="mcp-btn secondary"
                      disabled={!canWrite}
                      onClick={() => setDraft(draftFromServer(s))}
                    >
                      Edit
                    </button>
                    <button
                      className="mcp-btn secondary"
                      disabled={!canWrite || busy === s.name}
                      onClick={() => void save(`mcp.servers.${s.name}.enabled`, s.enabled ? 'false' : 'true')}
                    >
                      {s.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <input
                      className="mcp-input"
                      style={{ minWidth: 260 }}
                      placeholder="runtime override, e.g. /opt/node20/bin/node /usr/local/bin/npx"
                      defaultValue={override.runtime ? [override.runtime.command, ...(override.runtime.args ?? [])].join(' ') : ''}
                      disabled={!canWrite}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void save(`mcp.servers.${s.name}.runtime.command`, (e.target as HTMLInputElement).value);
                      }}
                    />
                    <button
                      className="mcp-btn secondary"
                      disabled={!canWrite}
                      onClick={() => void save(`mcp.servers.${s.name}.runtime.command`, '')}
                    >
                      Clear runtime
                    </button>
                    <button
                      className="mcp-btn secondary"
                      disabled={!canWrite || busy === s.name}
                      onClick={() => void doUninstall(s.name)}
                    >
                      Uninstall
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mcp-card">
            <h3>Add a server</h3>
            <div className="mcp-muted">
              Any MCP server — a local command or a remote endpoint — not only the ones in the catalog
              below. This writes <code>{data.configDir}/&lt;name&gt;.json</code>, the same file{' '}
              <code>nuvira mcp add</code> writes, so the agent uses it on the next turn: no code, no
              release. Use <strong>Edit</strong> on a configured server to change it.
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '180px 1fr',
                gap: 10,
                alignItems: 'center',
                marginTop: 10,
              }}
            >
              <label className="mcp-setting-label">Name</label>
              <input
                className="mcp-input"
                placeholder="my-server"
                value={draft.name}
                disabled={!canWrite || busy === '__custom__'}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />

              <label className="mcp-setting-label">Transport</label>
              <div>
                <label className="mcp-muted" style={{ marginRight: 12 }}>
                  <input
                    type="radio"
                    name="custom-transport"
                    checked={draft.transport === 'stdio'}
                    disabled={!canWrite}
                    onChange={() => setDraft({ ...draft, transport: 'stdio' })}
                  />{' '}
                  stdio (a local process)
                </label>
                <label className="mcp-muted">
                  <input
                    type="radio"
                    name="custom-transport"
                    checked={draft.transport === 'sse'}
                    disabled={!canWrite}
                    onChange={() => setDraft({ ...draft, transport: 'sse' })}
                  />{' '}
                  remote (Streamable HTTP)
                </label>
              </div>

              {draft.transport === 'stdio' ? (
                <>
                  <label className="mcp-setting-label">Command</label>
                  <input
                    className="mcp-input"
                    placeholder="npx"
                    value={draft.command}
                    disabled={!canWrite || busy === '__custom__'}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  />
                  <label className="mcp-setting-label">Arguments</label>
                  <input
                    className="mcp-input"
                    placeholder="-y, @modelcontextprotocol/server-filesystem, /path/to/dir"
                    value={draft.args}
                    disabled={!canWrite || busy === '__custom__'}
                    onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                  />
                  <label className="mcp-setting-label">Environment</label>
                  <textarea
                    className="mcp-input"
                    rows={3}
                    placeholder={'TOKEN=…\nANOTHER=…'}
                    value={draft.env}
                    disabled={!canWrite || busy === '__custom__'}
                    onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                  />
                </>
              ) : (
                <>
                  <label className="mcp-setting-label">URL</label>
                  <input
                    className="mcp-input"
                    placeholder="https://example.com/mcp"
                    value={draft.url}
                    disabled={!canWrite || busy === '__custom__'}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  />
                  <label className="mcp-setting-label">Headers</label>
                  <textarea
                    className="mcp-input"
                    rows={3}
                    placeholder={'Authorization: Bearer …'}
                    value={draft.headers}
                    disabled={!canWrite || busy === '__custom__'}
                    onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
                  />
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <label className="mcp-muted">
                <input
                  type="checkbox"
                  checked={draft.overwrite}
                  disabled={!canWrite || busy === '__custom__'}
                  onChange={(e) => setDraft({ ...draft, overwrite: e.target.checked })}
                />{' '}
                Replace the existing config for this name
              </label>
              <button
                className="mcp-btn"
                disabled={!canWrite || busy === '__custom__'}
                onClick={() => void doAddServer()}
              >
                {busy === '__custom__' ? 'Saving…' : draft.overwrite ? 'Save server' : 'Add server'}
              </button>
              <button
                className="mcp-btn secondary"
                disabled={busy === '__custom__'}
                onClick={() => setDraft(EMPTY_CUSTOM_DRAFT)}
              >
                Clear
              </button>
            </div>
            <div className="mcp-muted" style={{ marginTop: 8 }}>
              Credentials typed here go into the config file (mode 0600) and are never sent back to this
              page — editing an existing server keeps the secrets it already has unless you type a new
              value over them.
            </div>
          </div>

          <div className="mcp-card">
            <h3>Catalog ({data.catalog.length} capabilities)</h3>
            <div className="mcp-muted">
              Each capability lists every way it can run on THIS machine, what that way needs, and
              what you get. A dependency that is missing (install it) is different from a service
              that is down (start it).
            </div>
            {data.catalog.map((entry) => (
              <div className="mcp-variant" key={entry.name}>
                <div>
                  <strong>{entry.name}</strong>
                  {entry.installed && <span className="mcp-badge ok">installed</span>}
                  <span className="mcp-muted"> — {entry.description}</span>
                </div>
                <ul className="mcp-offers">
                  {entry.offers.map((offer) => (
                    <li key={offer}>{offer}</li>
                  ))}
                </ul>
                {entry.supersedes && (
                  <div className="mcp-muted">supersedes: {entry.supersedes}</div>
                )}
                {entry.variants.map((v) => (
                  <div key={v.id} className="mcp-muted" style={{ marginLeft: 12 }}>
                    <label>
                      <input
                        type="radio"
                        name={`variant-${entry.name}`}
                        checked={(installVariant[entry.name] ?? '') === v.id}
                        disabled={v.optIn === false && installVariant[entry.name] !== v.id ? false : !canWrite}
                        onChange={() => setInstallVariant((prev) => ({ ...prev, [entry.name]: v.id }))}
                      />{' '}
                      <strong>{v.id}</strong> — {v.label}{' '}
                      <span className={`mcp-badge ${v.status.ok ? 'ok' : 'bad'}`}>
                        {v.status.ok ? 'runnable' : 'cannot run yet'}
                      </span>
                      {v.optIn && <span className="mcp-badge">opt-in</span>}
                      <span className="mcp-badge">{v.trust}</span>
                    </label>
                    <div>
                      {v.command ? `${v.command} ${v.args.join(' ')}` : v.url}
                    </div>
                    {v.status.problems.map((problem) => (
                      <div key={problem} className="mcp-problem">
                        ⚠ {problem}
                      </div>
                    ))}
                    {v.status.unverified.map((note) => (
                      <div key={note}>note: {note}</div>
                    ))}
                    {v.note && <div>caveat: {v.note}</div>}
                  </div>
                ))}
                <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {(() => {
                    const selected =
                      entry.variants.find((v) => v.id === installVariant[entry.name]) ??
                      entry.variants.find((v) => !v.optIn) ??
                      entry.variants[0];
                    return selected.requires
                      .filter((r) => r.kind === 'env')
                      .map((r) => (
                        <input
                          key={r.name}
                          className="mcp-input"
                          style={{ minWidth: 280 }}
                          type="password"
                          placeholder={`${r.name} (${r.hint})`}
                          disabled={!canWrite}
                          value={installEnv[`${entry.name}:${r.name}`] ?? ''}
                          onChange={(e) =>
                            setInstallEnv((prev) => ({ ...prev, [`${entry.name}:${r.name}`]: e.target.value }))
                          }
                        />
                      ));
                  })()}
                  <input
                    className="mcp-input"
                    placeholder="runtime override (optional)"
                    disabled={!canWrite}
                    value={installRuntime[entry.name] ?? ''}
                    onChange={(e) => setInstallRuntime((prev) => ({ ...prev, [entry.name]: e.target.value }))}
                  />
                  <button
                    className="mcp-btn"
                    disabled={!canWrite || busy === entry.name || entry.installed}
                    onClick={() => void doInstall(entry)}
                  >
                    {busy === entry.name ? 'Installing…' : entry.installed ? 'Installed' : 'Install'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
