import React, { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';
import type { PlatformConfigEntry } from '../types';

interface Props {
  canWrite: boolean;
  sessionExpired: (msg?: string) => void;
  /** 'grid' = current card layout (default), 'table' = consolidated row layout */
  mode?: 'grid' | 'table';
}

/**
 * Platform transport configuration — GUI parity with `buff config gateway`.
 * Lists every env-configurable platform with an expandable form per platform
 * (fields prefilled from the current values; secrets are password inputs).
 * Save/Remove write ~/.buff/.env through the same module the CLI uses, and
 * the server applies the values to its own process.env so the send-test picks
 * them up immediately.
 */
export function PlatformConfigSection({ canWrite, sessionExpired, mode = 'grid' }: Props) {
  const [configs, setConfigs] = useState<PlatformConfigEntry[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Getting Started wizard state.
  const [wizardPlatform, setWizardPlatform] = useState<PlatformConfigEntry | null>(null);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardValues, setWizardValues] = useState<Record<string, string>>({});
  const [wizardSaving, setWizardSaving] = useState(false);
  const [wizardResult, setWizardResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
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

  // Getting Started wizard guides per platform.
  const WIZARD_GUIDES: Record<string, { steps: string[]; postSetup: string[] }> = {
    telegram: {
      steps: [
        'Open Telegram and search for @BotFather',
        'Send /newbot to BotFather and follow the prompts',
        'Give your bot a name (e.g. "My Agent Bot")',
        'Give your bot a username (must end with "bot", e.g. "my_agent_bot")',
        'BotFather will give you a token — paste it in the field below',
        'Open your bot in Telegram and send it a message (e.g. /start)',
      ],
      postSetup: [
        'Start the gateway: buff gateway start (or from the Gateway tab)',
        'Open your bot in Telegram and send a message — the agent replies!',
      ],
    },
    discord: {
      steps: [
        'Go to https://discord.com/developers/applications',
        'Click "New Application" → give it a name → Create',
        'Go to "Bot" in the left sidebar → click "Add Bot"',
        'Under "Token", click "Copy" to copy the bot token',
        'Enable "Message Content Intent" under Privileged Gateway Intents',
        'Invite the bot to your server with the OAuth2 URL generator',
      ],
      postSetup: [
        'Start the gateway: buff gateway start',
        'Mention the bot in a Discord channel or send it a DM',
        'The agent will reply automatically!',
      ],
    },
    slack: {
      steps: [
        'Go to https://api.slack.com/apps',
        'Click "Create New App" → "From scratch"',
        'Add Bot Token Scopes: chat:write, im:read, im:write',
        'Install the app to your workspace',
        'Copy the Bot User OAuth Token (starts with xoxb-)',
      ],
      postSetup: [
        'Start the gateway: buff gateway start',
        'DM the bot or mention it in a channel',
        'The agent will reply automatically!',
      ],
    },
    email: {
      steps: [
        'You need an SMTP relay (Gmail, SendGrid, Mailgun, etc.)',
        'For Gmail: use smtp.gmail.com:587 with an App Password',
        'For SendGrid/Mailgun: get SMTP credentials from their dashboard',
      ],
      postSetup: [
        'Start the gateway: buff gateway start',
        'Send an email to the configured address',
        'The agent will reply via email!',
      ],
    },
  };

  const startWizard = (entry: PlatformConfigEntry): void => {
    // Write action: the wizard ends in setPlatformConfig, which persists a
    // transport credential. A disabled button is presentation; this is the
    // boundary — a viewer must not reach the wizard at all.
    if (!canWrite) return;
    setWizardPlatform(entry);
    setWizardStep(0);
    setWizardValues(Object.fromEntries(entry.envVars.map((v) => [v.varName, v.value])));
    setWizardResult(null);
  };

  const saveWizard = async (): Promise<void> => {
    if (!wizardPlatform || !canWrite) return;
    setWizardSaving(true);
    setWizardResult(null);
    const result = await dashboardAPI.setPlatformConfig(wizardPlatform.platform, wizardValues);
    setWizardSaving(false);
    if (result.unauthorized || result.forbidden) {
      sessionExpired(result.error);
      return;
    }
    if (result.ok) {
      setWizardResult({ kind: 'ok', text: '✅ Token saved! The transport is now active.' });
      void refresh();
    } else {
      setWizardResult({ kind: 'err', text: result.error || 'Save failed.' });
    }
  };

  if (configs === null) {
    return <div className="empty-state">Loading platform transports…</div>;
  }

  const guide = wizardPlatform ? WIZARD_GUIDES[wizardPlatform.platform] : null;

  // ── Table mode: consolidated row layout ──
  if (mode === 'table') {
    return (
      <>
      {wizardPlatform && guide ? (
        <div className="wizard-overlay" onClick={() => setWizardPlatform(null)}>
          <div className="wizard-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wizard-header">
              <span className="wizard-icon">🚀</span>
              <span className="wizard-title">Getting Started: {wizardPlatform.label}</span>
              <button type="button" className="admin-mini-btn" onClick={() => setWizardPlatform(null)}>✕</button>
            </div>
            <div className="wizard-body">
              {wizardStep === 0 ? (
                <>
                  <p className="wizard-section-title">📋 Steps to create your bot:</p>
                  <ol className="wizard-steps">
                    {guide.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                  <div className="wizard-nav">
                    <button type="button" className="admin-refresh-btn" onClick={() => setWizardStep(1)}>I have my token →</button>
                    {wizardPlatform.setupUrl ? (
                      <a href={wizardPlatform.setupUrl} target="_blank" rel="noopener noreferrer" className="admin-mini-btn platform-docs-link">📖 Docs</a>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <p className="wizard-section-title">🔑 Paste your token:</p>
                  {wizardPlatform.envVars.map((v) => (
                    <label className="hub-send-target" key={v.varName}>
                      <span className="admin-hint">{v.prompt}</span>
                      <input type={v.secret ? 'password' : 'text'} value={wizardValues[v.varName] ?? ''} onChange={(e) => setWizardValues((prev) => ({ ...prev, [v.varName]: e.target.value }))} placeholder={v.secret ? '••••••••' : 'value'} autoComplete="off" spellCheck={false} autoFocus />
                    </label>
                  ))}
                  {wizardResult ? (<div className={`admin-row-msg${wizardResult.kind === 'ok' ? '' : ' admin-row-msg-err'}`}>{wizardResult.text}</div>) : null}
                  <div className="wizard-nav">
                    <button type="button" className="admin-mini-btn" onClick={() => setWizardStep(0)}>← Back</button>
                    <button type="button" className="admin-refresh-btn" onClick={() => void saveWizard()} disabled={wizardSaving || !canWrite}>{wizardSaving ? '⏳ Saving…' : '💾 Save token'}</button>
                  </div>
                  {wizardResult?.kind === 'ok' ? (<><p className="wizard-section-title">📋 Next steps:</p><ol className="wizard-steps">{guide.postSetup.map((s, i) => <li key={i}>{s}</li>)}</ol></>) : null}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {msg ? (<div className={`admin-row-msg${msg.kind === 'ok' ? '' : ' admin-row-msg-err'}`}>{msg.text}</div>) : null}
      <div className="platform-config-table-wrapper">
        <table className="platform-config-table">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Status</th>
              <th>Configuration</th>
              <th>CLI Command</th>
            </tr>
          </thead>
          <tbody>
            {configs.map((p) => (
              <React.Fragment key={p.platform}>
                <tr className={`platform-config-row ${p.configured ? 'configured' : ''}`}>
                  <td className="platform-config-name">
                    <span className="hub-platform-label">{p.label}</span>
                    <span className="hub-card-id">{p.platform}</span>
                  </td>
                  <td>
                    <span className={`status-dot ${p.configured ? 'connected' : 'reconnecting'}`} />
                    <span className="platform-config-status-text">{p.configured ? 'Active' : 'Not configured'}</span>
                  </td>
                  <td className="platform-config-actions">
                    {!p.configured ? (
                      <button type="button" className="wizard-start-btn" onClick={() => startWizard(p)} disabled={!canWrite}>🚀 Getting Started</button>
                    ) : null}
                    {p.setupUrl ? (
                      <a href={p.setupUrl} target="_blank" rel="noopener noreferrer" className="admin-mini-btn platform-docs-link">📖 Docs</a>
                    ) : null}
                    <button type="button" className="admin-refresh-btn" onClick={() => setExpanded(expanded === p.platform ? null : p.platform)} disabled={!canWrite}>
                      {expanded === p.platform ? '▴ Close' : p.configured ? '✎ Edit' : '⚙ Configure'}
                    </button>
                    {p.configured ? (
                      <button type="button" className="admin-mini-btn contact-delete-btn" onClick={() => void remove(p.platform)} disabled={!canWrite}>🗑️</button>
                    ) : null}
                  </td>
                  <td className="platform-config-cli">
                    <code>buff gateway setup {p.platform}</code>
                  </td>
                </tr>
                {expanded === p.platform ? (
                  <tr className="platform-config-expanded">
                    <td colSpan={4}>
                      <div className="platform-config-form">
                        {p.envVars.map((v) => (
                          <label className="hub-send-target" key={v.varName}>
                            <span className="admin-hint">{v.prompt}</span>
                            <input type={v.secret ? 'password' : 'text'} value={v.value} readOnly className="platform-config-readonly" placeholder={v.secret ? '••••••••' : 'value'} />
                          </label>
                        ))}
                        <p className="admin-hint">Tokens are in <code>~/.buff/.env</code> — edit there or use the wizard above.</p>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      </>
    );
  }

  // ── Grid mode: current card layout ──
  return (
    <>
    {wizardPlatform && guide ? (
      <div className="wizard-overlay" onClick={() => setWizardPlatform(null)}>
        <div className="wizard-modal" onClick={(e) => e.stopPropagation()}>
          <div className="wizard-header">
            <span className="wizard-icon">🚀</span>
            <span className="wizard-title">Getting Started: {wizardPlatform.label}</span>
            <button type="button" className="admin-mini-btn" onClick={() => setWizardPlatform(null)}>✕</button>
          </div>
          <div className="wizard-body">
            {wizardStep === 0 ? (
              <>
                <p className="wizard-section-title">📋 Steps to create your bot:</p>
                <ol className="wizard-steps">
                  {guide.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
                <div className="wizard-nav">
                  <button type="button" className="admin-refresh-btn" onClick={() => setWizardStep(1)}>
                    I have my token →
                  </button>
                  {wizardPlatform.setupUrl ? (
                    <a href={wizardPlatform.setupUrl} target="_blank" rel="noopener noreferrer" className="admin-mini-btn platform-docs-link">
                      📖 Open docs in new tab
                    </a>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <p className="wizard-section-title">🔑 Paste your token:</p>
                {wizardPlatform.envVars.map((v) => (
                  <label className="hub-send-target" key={v.varName}>
                    <span className="admin-hint">{v.prompt}</span>
                    <input
                      type={v.secret ? 'password' : 'text'}
                      value={wizardValues[v.varName] ?? ''}
                      onChange={(e) => setWizardValues((prev) => ({ ...prev, [v.varName]: e.target.value }))}
                      placeholder={v.secret ? '••••••••' : 'value'}
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                    />
                  </label>
                ))}
                {wizardResult ? (
                  <div className={`admin-row-msg${wizardResult.kind === 'ok' ? '' : ' admin-row-msg-err'}`}>{wizardResult.text}</div>
                ) : null}
                <div className="wizard-nav">
                  <button type="button" className="admin-mini-btn" onClick={() => setWizardStep(0)}>← Back</button>
                  <button type="button" className="admin-refresh-btn" onClick={() => void saveWizard()} disabled={wizardSaving || !canWrite}>
                    {wizardSaving ? '⏳ Saving…' : '💾 Save token'}
                  </button>
                </div>
                {wizardResult?.kind === 'ok' ? (
                  <>
                    <p className="wizard-section-title">📋 Next steps:</p>
                    <ol className="wizard-steps">
                      {guide.postSetup.map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    ) : null}
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
            onStartWizard={() => startWizard(p)}
          />
        ))}
      </div>
      <p className="admin-hint">
        Tokens are written to <code>~/.buff/.env</code> (loaded by both the CLI and this dashboard at
        startup) — no env vars to hand-export. The WhatsApp personal bridge is configured separately
        above via QR/code pairing.
      </p>
    </div>
    </>
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
  onStartWizard: () => void;
}) {
  const { entry, canWrite, busy, expanded, onToggle, onSave, onRemove, onStartWizard } = props;
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
        {!entry.configured ? (
          <button type="button" className="wizard-start-btn" onClick={onStartWizard} disabled={!canWrite} title="Step-by-step setup wizard">
            🚀 Getting Started
          </button>
        ) : null}
        {entry.setupUrl ? (
          <a href={entry.setupUrl} target="_blank" rel="noopener noreferrer" className="admin-mini-btn platform-docs-link" title="Setup documentation">
            📖 Docs
          </a>
        ) : null}
        <button
          type="button"
          className="admin-refresh-btn"
          onClick={onToggle}
          disabled={!canWrite}
        >
          {expanded ? '▴ Collapse' : entry.configured ? '✎ Edit' : '⚙ Configure'}
        </button>
      </div>
      {!expanded && entry.setupHint && !entry.configured ? (
        <div className="platform-setup-hint">{entry.setupHint}</div>
      ) : null}
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
          {entry.setupHint ? (
            <div className="platform-setup-hint">{entry.setupHint}</div>
          ) : null}
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
              disabled={busy || !canWrite}
            >
              {busy ? '⏳ Saving…' : '💾 Save'}
            </button>
            {entry.configured ? (
              <button type="button" className="hub-remove-btn" onClick={onRemove} disabled={busy || !canWrite}>
                🗑 Remove
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
