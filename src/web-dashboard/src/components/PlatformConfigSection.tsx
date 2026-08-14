import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';
import type { PlatformConfigEntry } from '../types';

interface Props {
  canWrite: boolean;
  sessionExpired: (msg?: string) => void;
}

/**
 * Platform transport configuration — GUI parity with `buff config gateway`.
 * Lists every env-configurable platform with an expandable form per platform
 * (fields prefilled from the current values; secrets are password inputs).
 * Save/Remove write ~/.buff/.env through the same module the CLI uses, and
 * the server applies the values to its own process.env so the send-test picks
 * them up immediately.
 */
export function PlatformConfigSection({ canWrite, sessionExpired }: Props) {
  const [configs, setConfigs] = useState<PlatformConfigEntry[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const list = await dashboardAPI.getPlatformConfigs();
    if (!mounted.current) return;
    setConfigs(list);
    // An EMPTY list is legitimate (no platforms configured yet) — it must NOT
    // be treated as a session failure (that would log the user out on first
    // visit). Auth failures surface through the save/remove paths instead.
  }, [sessionExpired]);

  useEffect(() => {
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const save = async (platform: string, values: Record<string, string>): Promise<void> => {
    setBusy(platform);
    setMsg(null);
    const result = await dashboardAPI.setPlatformConfig(platform, values);
    if (!mounted.current) return;
    setBusy(null);
    if (result.unauthorized || result.forbidden) {
      sessionExpired(result.error);
      return;
    }
    setMsg({ kind: result.ok ? 'ok' : 'err', text: result.ok ? 'Saved — transport active.' : result.error || 'Save failed.' });
    if (result.ok) {
      setExpanded(null);
      void refresh();
    }
  };

  const remove = async (platform: string): Promise<void> => {
    if (!window.confirm(`Remove ${platform} transport config? Tokens will be deleted from ~/.buff/.env.`)) return;
    setBusy(platform);
    setMsg(null);
    const result = await dashboardAPI.removePlatformConfig(platform);
    if (!mounted.current) return;
    setBusy(null);
    if (result.unauthorized || result.forbidden) {
      sessionExpired(result.error);
      return;
    }
    setMsg({ kind: result.ok ? 'ok' : 'err', text: result.ok ? 'Removed.' : result.error || 'Remove failed.' });
    if (result.ok) void refresh();
  };

  if (configs === null) {
    return <div className="empty-state">Loading platform transports…</div>;
  }

  return (
    <div className="platform-config">
      <h3 className="section-subtitle">⚙️ Platform transports (buff config gateway)</h3>
      {msg ? (
        <div className={`admin-row-msg${msg.kind === 'ok' ? '' : ' admin-row-msg-err'}`}>{msg.text}</div>
      ) : null}
      <div className="hub-platform-grid">
        {configs.map((p) => (
          <PlatformConfigCard
            key={p.platform}
            entry={p}
            canWrite={canWrite}
            busy={busy === p.platform}
            expanded={expanded === p.platform}
            onToggle={() => setExpanded(expanded === p.platform ? null : p.platform)}
            onSave={(values) => void save(p.platform, values)}
            onRemove={() => void remove(p.platform)}
          />
        ))}
      </div>
      <p className="admin-hint">
        Tokens are written to <code>~/.buff/.env</code> (loaded by both the CLI and this dashboard at
        startup) — no env vars to hand-export. The WhatsApp personal bridge is configured separately
        above via QR/code pairing.
      </p>
    </div>
  );
}

function PlatformConfigCard(props: {
  entry: PlatformConfigEntry;
  canWrite: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSave: (values: Record<string, string>) => void;
  onRemove: () => void;
}) {
  const { entry, canWrite, busy, expanded, onToggle, onSave, onRemove } = props;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(entry.envVars.map((v) => [v.varName, v.value])),
  );

  const set = (varName: string, value: string): void => {
    setValues((prev) => ({ ...prev, [varName]: value }));
  };

  return (
    <div className={`hub-platform${entry.configured ? ' configured' : ''}`}>
      <div className="hub-platform-head">
        <span className={`status-dot ${entry.configured ? 'connected' : 'reconnecting'}`} />
        <span className="hub-platform-label">{entry.label}</span>
        <span className="hub-card-id">{entry.platform}</span>
        <button
          type="button"
          className="admin-refresh-btn"
          onClick={onToggle}
          disabled={!canWrite}
        >
          {expanded ? '▴ Collapse' : entry.configured ? '✎ Edit' : '⚙ Configure'}
        </button>
      </div>
      {!expanded ? (
        <div className="hub-platform-env">
          {entry.envVars.map((v) => (
            <div key={v.varName}>
              <code>{v.varName}</code> {v.set ? '✓ set' : '— unset'}
            </div>
          ))}
        </div>
      ) : (
        <div className="platform-config-form">
          {entry.envVars.map((v) => (
            <label className="hub-send-target" key={v.varName}>
              <span className="admin-hint">{v.prompt}</span>
              <input
                type={v.secret ? 'password' : 'text'}
                value={values[v.varName] ?? ''}
                onChange={(e) => set(v.varName, e.target.value)}
                placeholder={v.secret ? '••••••••' : 'value'}
                autoComplete="off"
                spellCheck={false}
                maxLength={512}
              />
            </label>
          ))}
          <div className="platform-config-actions">
            <button
              type="button"
              className="admin-refresh-btn"
              onClick={() => onSave(values)}
              disabled={busy}
            >
              {busy ? '⏳ Saving…' : '💾 Save'}
            </button>
            {entry.configured ? (
              <button type="button" className="hub-remove-btn" onClick={onRemove} disabled={busy}>
                🗑 Remove
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
