import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';
import type { PlatformConfigEntry } from '../types';

/**
 * PlatformsPage — dedicated onboarding page for all 22 messaging platforms.
 * Shows a grid of platform cards with configuration status, quick setup
 * buttons, docs links, and a Getting Started wizard for each.
 */
export default function PlatformsPage() {
  const [configs, setConfigs] = useState<PlatformConfigEntry[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'configured' | 'unconfigured'>('all');
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
  }, []);

  useEffect(() => {
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  // Platform-specific setup guides.
  const GUIDES: Record<string, { icon: string; category: string; steps: string[]; postSetup: string[] }> = {
    telegram: { icon: '✈️', category: 'Chat', steps: ['Open Telegram → search @BotFather', 'Send /newbot → follow prompts', 'Copy the bot token → paste below', 'Open your bot → send /start'], postSetup: ['Start gateway: buff gateway start', 'Message your bot — it replies!'] },
    discord: { icon: '🎮', category: 'Chat', steps: ['Go to discord.com/developers/applications', 'New Application → Bot → Add Bot', 'Copy bot token → paste below', 'Enable Message Content Intent', 'Invite bot to your server'], postSetup: ['Start gateway: buff gateway start', 'Mention the bot in a channel'] },
    slack: { icon: '💬', category: 'Chat', steps: ['Go to api.slack.com/apps', 'Create New App → From scratch', 'Add scopes: chat:write, im:read, im:write', 'Install to workspace → copy Bot Token'], postSetup: ['Start gateway: buff gateway start', 'DM or mention the bot'] },
    whatsapp: { icon: '📱', category: 'Chat', steps: ['Run: buff whatsapp pair', 'Scan the QR code with WhatsApp', 'Wait for pairing to complete'], postSetup: ['Start gateway: buff gateway start', 'Send a message from WhatsApp'] },
    whatsapp_cloud: { icon: '☁️', category: 'Chat', steps: ['Go to developers.facebook.com', 'Set up WhatsApp Cloud API', 'Copy token + Phone ID → paste below'], postSetup: ['Start gateway: buff gateway start', 'Send a WhatsApp message'] },
    email: { icon: '📧', category: 'Chat', steps: ['Get SMTP credentials (Gmail, SendGrid, etc.)', 'For Gmail: use App Password + smtp.gmail.com:587', 'Paste SMTP host + user below'], postSetup: ['Start gateway: buff gateway start', 'Send an email to the configured address'] },
    signal: { icon: '🔒', category: 'Chat', steps: ['Run signal-cli-rest-api Docker container', 'Register a Signal account', 'Paste the account number below'], postSetup: ['Start gateway: buff gateway start', 'Send a Signal message'] },
    dingtalk: { icon: '🔔', category: 'Webhooks', steps: ['Open DingTalk → create a group', 'Add custom robot → copy webhook URL', 'Paste the URL below'], postSetup: ['Start gateway: buff gateway start'] },
    feishu: { icon: '🐦', category: 'Webhooks', steps: ['Open Feishu → create a bot', 'Copy the webhook URL → paste below'], postSetup: ['Start gateway: buff gateway start'] },
    wecom: { icon: '🏢', category: 'Webhooks', steps: ['Open WeCom → create a group bot', 'Copy webhook URL → paste below'], postSetup: ['Start gateway: buff gateway start'] },
    mattermost: { icon: '📋', category: 'Webhooks', steps: ['Open Mattermost → Integrations', 'Create incoming webhook → copy URL'], postSetup: ['Start gateway: buff gateway start'] },
    matrix: { icon: '🔗', category: 'Chat', steps: ['Get your Matrix homeserver URL', 'Create a bot user → get access token', 'Paste URL + token below'], postSetup: ['Start gateway: buff gateway start'] },
    webhook: { icon: '🪝', category: 'Webhooks', steps: ['Enter your webhook URL', 'The agent sends outbound webhooks to this URL'], postSetup: ['Start gateway: buff gateway start'] },
    bluebubbles: { icon: '💙', category: 'Chat', steps: ['Set up BlueBubbles server', 'Copy server URL + password → paste below'], postSetup: ['Start gateway: buff gateway start'] },
    ntfy: { icon: '📢', category: 'Notifications', steps: ['Choose an ntfy topic (or use ntfy.sh)', 'Paste the topic below'], postSetup: ['Start gateway: buff gateway start'] },
    teams: { icon: '👥', category: 'Webhooks', steps: ['Open Microsoft Teams → channel', 'Connectors → Incoming Webhook → create', 'Copy webhook URL → paste below'], postSetup: ['Start gateway: buff gateway start'] },
    google_chat: { icon: '💬', category: 'Webhooks', steps: ['Open Google Chat → space settings', 'Create webhook → copy URL → paste below'], postSetup: ['Start gateway: buff gateway start'] },
    weixin: { icon: '🔴', category: 'Chat', steps: ['Get Weixin iLink bot token', 'Paste the token below'], postSetup: ['Start gateway: buff gateway start'] },
    sms: { icon: '📲', category: 'Chat', steps: ['Get Twilio account SID + auth token', 'Register a phone number', 'Paste credentials below'], postSetup: ['Start gateway: buff gateway start'] },
    irc: { icon: '💻', category: 'Chat', steps: ['Choose an IRC server (e.g. irc.libera.chat)', 'Set nickname + channel → paste below'], postSetup: ['Start gateway: buff gateway start'] },
    simplex: { icon: '📨', category: 'Chat', steps: ['Run local simplex-chat daemon', 'Paste WebSocket URL (ws://127.0.0.1:5225)'], postSetup: ['Start gateway: buff gateway start'] },
    homeassistant: { icon: '🏠', category: 'IoT', steps: ['Open Home Assistant → Profile', 'Create long-lived access token → paste below'], postSetup: ['Start gateway: buff gateway start'] },
  };

  const startWizard = (entry: PlatformConfigEntry): void => {
    setWizardPlatform(entry);
    setWizardStep(0);
    setWizardValues(Object.fromEntries(entry.envVars.map((v) => [v.varName, v.value])));
    setWizardResult(null);
  };

  const saveWizard = async (): Promise<void> => {
    if (!wizardPlatform) return;
    setWizardSaving(true);
    setWizardResult(null);
    const result = await dashboardAPI.setPlatformConfig(wizardPlatform.platform, wizardValues);
    setWizardSaving(false);
    if (result.ok) {
      setWizardResult({ kind: 'ok', text: 'Token saved! The transport is now active.' });
      void refresh();
    } else {
      setWizardResult({ kind: 'err', text: result.error || 'Save failed.' });
    }
  };

  if (configs === null) {
    return <div className="empty-state">Loading platforms...</div>;
  }

  const configuredCount = configs.filter((c) => c.configured).length;
  const filtered = configs.filter((c) => {
    if (filter === 'configured') return c.configured;
    if (filter === 'unconfigured') return !c.configured;
    return true;
  });

  const guide = wizardPlatform ? GUIDES[wizardPlatform.platform] : null;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Platforms — Messaging Gateway Onboarding</h2>
      </div>

      {/* Summary bar */}
      <div className="platforms-summary">
        <div className="platforms-summary-stat">
          <span className="platforms-summary-number">{configuredCount}</span>
          <span className="platforms-summary-label">configured</span>
        </div>
        <div className="platforms-summary-stat">
          <span className="platforms-summary-number">{configs.length - configuredCount}</span>
          <span className="platforms-summary-label">available</span>
        </div>
        <div className="platforms-summary-filters">
          {(['all', 'configured', 'unconfigured'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`platforms-filter-btn${filter === f ? ' active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'configured' ? 'Configured' : 'Not set up'}
            </button>
          ))}
        </div>
      </div>

      {/* Platform grid */}
      <div className="platforms-grid">
        {filtered.map((p) => {
          const g = GUIDES[p.platform];
          return (
            <div key={p.platform} className={`platform-card${p.configured ? ' configured' : ''}`}>
              <div className="platform-card-head">
                <span className="platform-card-icon">{g?.icon ?? '🔌'}</span>
                <div className="platform-card-info">
                  <span className="platform-card-name">{p.label}</span>
                  <span className="platform-card-category">{g?.category ?? 'Platform'}</span>
                </div>
                <span className={`status-dot ${p.configured ? 'connected' : 'reconnecting'}`} />
              </div>
              <div className="platform-card-vars">
                {p.envVars.map((v) => (
                  <span key={v.varName} className={`platform-var-chip${v.set ? ' set' : ''}`}>
                    {v.varName} {v.set ? 'done' : '--'}
                  </span>
                ))}
              </div>
              <div className="platform-card-actions">
                {!p.configured ? (
                  <button type="button" className="wizard-start-btn" onClick={() => startWizard(p)}>
                    Setup
                  </button>
                ) : (
                  <span className="platform-card-badge">Active</span>
                )}
                {p.setupUrl ? (
                  <a href={p.setupUrl} target="_blank" rel="noopener noreferrer" className="admin-mini-btn platform-docs-link">
                    Docs
                  </a>
                ) : null}
              </div>
              {!p.configured && p.setupHint ? (
                <div className="platform-card-hint">{p.setupHint}</div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* CLI hint */}
      <div className="platforms-cli-hint">
        <span className="admin-hint">CLI alternative: </span>
        <code>buff gateway setup telegram</code>
        <span className="admin-hint"> — interactive wizard from your terminal</span>
      </div>

      {/* Getting Started wizard modal */}
      {wizardPlatform && guide ? (
        <div className="wizard-overlay" onClick={() => setWizardPlatform(null)}>
          <div className="wizard-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wizard-header">
              <span className="wizard-icon">{guide.icon}</span>
              <span className="wizard-title">Getting Started: {wizardPlatform.label}</span>
              <button type="button" className="admin-mini-btn" onClick={() => setWizardPlatform(null)}>X</button>
            </div>
            <div className="wizard-body">
              {wizardStep === 0 ? (
                <>
                  <p className="wizard-section-title">Steps to set up {wizardPlatform.label}:</p>
                  <ol className="wizard-steps">
                    {guide.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                  <div className="wizard-nav">
                    <button type="button" className="admin-refresh-btn" onClick={() => setWizardStep(1)}>
                      I have my token
                    </button>
                    {wizardPlatform.setupUrl ? (
                      <a href={wizardPlatform.setupUrl} target="_blank" rel="noopener noreferrer" className="admin-mini-btn platform-docs-link">
                        Open docs
                      </a>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <p className="wizard-section-title">Paste your token:</p>
                  {wizardPlatform.envVars.map((v) => (
                    <label className="hub-send-target" key={v.varName}>
                      <span className="admin-hint">{v.prompt}</span>
                      <input
                        type={v.secret ? 'password' : 'text'}
                        value={wizardValues[v.varName] ?? ''}
                        onChange={(e) => setWizardValues((prev) => ({ ...prev, [v.varName]: e.target.value }))}
                        placeholder={v.secret ? 'secret' : 'value'}
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
                    <button type="button" className="admin-mini-btn" onClick={() => setWizardStep(0)}>Back</button>
                    <button type="button" className="admin-refresh-btn" onClick={() => void saveWizard()} disabled={wizardSaving}>
                      {wizardSaving ? 'Saving...' : 'Save token'}
                    </button>
                  </div>
                  {wizardResult?.kind === 'ok' ? (
                    <>
                      <p className="wizard-section-title">Next steps:</p>
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
    </div>
  );
}
