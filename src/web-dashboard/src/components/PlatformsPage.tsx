import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';
import type { PlatformConfigEntry } from '../types';
import PageHeader from './PageHeader';

const GUIDES: Record<string, { icon: string; category: string; steps: string[]; testTarget: string }> = {
  telegram: { icon: '✈️', category: 'Chat', steps: ['Open Telegram and search for @BotFather', 'Send /newbot and follow the prompts', 'Give your bot a name (e.g. "My Agent Bot")', 'Give your bot a username ending in "bot"', 'BotFather gives you a token — paste it in Step 2', 'Open your bot in Telegram and send /start'], testTarget: 'telegram:' },
  discord: { icon: '🎮', category: 'Chat', steps: ['Go to discord.com/developers/applications', 'Click "New Application" and give it a name', 'Go to Bot tab and click "Add Bot"', 'Copy the bot token', 'Enable "Message Content Intent"', 'Invite bot to your server (OAuth2 URL generator)'], testTarget: 'discord:' },
  slack: { icon: '💬', category: 'Chat', steps: ['Go to api.slack.com/apps', 'Create New App from scratch', 'Add Bot Token Scopes: chat:write, im:read, im:write', 'Install to workspace', 'Copy the Bot User OAuth Token (xoxb-...)'], testTarget: 'slack:' },
  whatsapp: { icon: '📱', category: 'Chat', steps: ['Run: buff whatsapp pair (or from Gateway tab)', 'Scan the QR code with WhatsApp', 'Pairing completes automatically'], testTarget: '' },
  whatsapp_cloud: { icon: '☁️', category: 'Chat', steps: ['Go to developers.facebook.com', 'Set up WhatsApp Cloud API', 'Copy token + Phone ID'], testTarget: 'whatsapp_cloud:' },
  email: { icon: '📧', category: 'Chat', steps: ['Get SMTP credentials (Gmail, SendGrid, etc.)', 'For Gmail: use App Password at smtp.gmail.com:587', 'Paste SMTP host + user below'], testTarget: '' },
  signal: { icon: '🔒', category: 'Chat', steps: ['Run signal-cli-rest-api Docker container', 'Register a Signal account', 'Paste account number below'], testTarget: '' },
  dingtalk: { icon: '🔔', category: 'Webhooks', steps: ['Open DingTalk and create a group', 'Add custom robot and copy webhook URL', 'Paste URL below'], testTarget: '' },
  feishu: { icon: '🐦', category: 'Webhooks', steps: ['Open Feishu and create a bot', 'Copy webhook URL and paste below'], testTarget: '' },
  wecom: { icon: '🏢', category: 'Webhooks', steps: ['Open WeCom and create a group bot', 'Copy webhook URL and paste below'], testTarget: '' },
  mattermost: { icon: '📋', category: 'Webhooks', steps: ['Open Mattermost, go to Integrations', 'Create incoming webhook and copy URL'], testTarget: '' },
  matrix: { icon: '🔗', category: 'Chat', steps: ['Get your Matrix homeserver URL', 'Create a bot user and get access token', 'Paste URL + token below'], testTarget: '' },
  webhook: { icon: '🪝', category: 'Webhooks', steps: ['Enter your webhook URL', 'The agent sends outbound webhooks to this URL'], testTarget: '' },
  bluebubbles: { icon: '💙', category: 'Chat', steps: ['Set up BlueBubbles server', 'Copy server URL + password'], testTarget: '' },
  ntfy: { icon: '📢', category: 'Notifications', steps: ['Choose an ntfy topic (or use ntfy.sh)', 'Paste the topic below'], testTarget: '' },
  teams: { icon: '👥', category: 'Webhooks', steps: ['Open Microsoft Teams, go to channel', 'Connectors, Incoming Webhook, create', 'Copy webhook URL'], testTarget: '' },
  google_chat: { icon: '💬', category: 'Webhooks', steps: ['Open Google Chat, space settings', 'Create webhook and copy URL'], testTarget: '' },
  weixin: { icon: '🔴', category: 'Chat', steps: ['Get Weixin iLink bot token', 'Paste token below'], testTarget: '' },
  sms: { icon: '📲', category: 'Chat', steps: ['Get Twilio account SID + auth token', 'Register a phone number', 'Paste credentials below'], testTarget: '' },
  irc: { icon: '💻', category: 'Chat', steps: ['Choose an IRC server (e.g. irc.libera.chat)', 'Set nickname + channel and paste below'], testTarget: '' },
  simplex: { icon: '📨', category: 'Chat', steps: ['Run local simplex-chat daemon', 'Paste WebSocket URL (ws://127.0.0.1:5225)'], testTarget: '' },
  homeassistant: { icon: '🏠', category: 'IoT', steps: ['Open Home Assistant Profile', 'Create long-lived access token and paste below'], testTarget: '' },
};

export default function PlatformsPage() {
  const [configs, setConfigs] = useState<PlatformConfigEntry[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'configured' | 'unconfigured'>('all');
  const [wizardPlatform, setWizardPlatform] = useState<PlatformConfigEntry | null>(null);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardValues, setWizardValues] = useState<Record<string, string>>({});
  const [wizardSaving, setWizardSaving] = useState(false);
  const [wizardResult, setWizardResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [wizardVerify, setWizardVerify] = useState<{ status: 'idle' | 'checking' | 'ok' | 'err'; info?: string; error?: string }>({ status: 'idle' });
  const [wizardTestTarget, setWizardTestTarget] = useState('');
  const [wizardTestMsg, setWizardTestMsg] = useState('Hello from agent-nuvira!');
  const [wizardTestSending, setWizardTestSending] = useState(false);
  const [wizardTestResult, setWizardTestResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
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

  const startWizard = (entry: PlatformConfigEntry): void => {
    setWizardPlatform(entry);
    setWizardStep(0);
    setWizardValues(Object.fromEntries(entry.envVars.map((v) => [v.varName, v.value])));
    setWizardResult(null);
    setWizardVerify({ status: 'idle' });
    const g = GUIDES[entry.platform];
    setWizardTestTarget(g?.testTarget ?? '');
    setWizardTestMsg('Hello from agent-nuvira!');
    setWizardTestResult(null);
  };

  const verifyWizard = async (): Promise<void> => {
    if (!wizardPlatform) return;
    setWizardVerify({ status: 'checking' });
    const result = await dashboardAPI.verifyPlatformConfig(wizardPlatform.platform, wizardValues);
    if (result.ok) {
      setWizardVerify({ status: 'ok', info: result.info });
      setWizardResult({ kind: 'ok', text: 'Verified! ' + (result.info ? 'Connected as ' + result.info + '.' : 'Token is valid.') });
    } else {
      setWizardVerify({ status: 'err', error: result.error });
      setWizardResult({ kind: 'err', text: result.error || 'Verification failed.' });
    }
  };

  const saveWizard = async (): Promise<void> => {
    if (!wizardPlatform) return;
    setWizardSaving(true);
    setWizardResult(null);
    const result = await dashboardAPI.setPlatformConfig(wizardPlatform.platform, wizardValues);
    setWizardSaving(false);
    if (result.ok) {
      setWizardResult({ kind: 'ok', text: 'Token saved! Verifying...' });
      void refresh();
      setWizardStep(2);
      void verifyWizard();
    } else {
      setWizardResult({ kind: 'err', text: result.error || 'Save failed.' });
    }
  };

  const sendTestMessage = async (): Promise<void> => {
    if (!wizardPlatform || !wizardTestTarget) return;
    setWizardTestSending(true);
    setWizardTestResult(null);
    const result = await dashboardAPI.sendChannelMessage(wizardTestTarget, wizardTestMsg);
    setWizardTestSending(false);
    if (result.ok) {
      setWizardTestResult({ kind: 'ok', text: 'Message sent via ' + result.platform + '! Check your ' + wizardPlatform.label + ' app.' });
    } else {
      setWizardTestResult({ kind: 'err', text: result.error || 'Send failed. Make sure the gateway is running (Gateway tab).' });
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

  function stepDotClass(step: number): string {
    return wizardStep === step ? 'wizard-step-dot active' : 'wizard-step-dot';
  }

  return (
    <div className="panel">
      <PageHeader icon="🌐" title="Platforms — Messaging Gateway Onboarding" />

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
            <button key={f} type="button" className={filter === f ? 'platforms-filter-btn active' : 'platforms-filter-btn'} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'configured' ? 'Configured' : 'Not set up'}
            </button>
          ))}
        </div>
      </div>

      <div className="platforms-grid">
        {filtered.map((p) => {
          const g = GUIDES[p.platform];
          return (
            <div key={p.platform} className={p.configured ? 'platform-card configured' : 'platform-card'}>
              <div className="platform-card-head">
                <span className="platform-card-icon">{g?.icon ?? '🔌'}</span>
                <div className="platform-card-info">
                  <span className="platform-card-name">{p.label}</span>
                  <span className="platform-card-category">{g?.category ?? 'Platform'}</span>
                </div>
                <span className={p.configured ? 'status-dot connected' : 'status-dot reconnecting'} />
              </div>
              <div className="platform-card-vars">
                {p.envVars.map((v) => (
                  <span key={v.varName} className={v.set ? 'platform-var-chip set' : 'platform-var-chip'}>
                    {v.varName} {v.set ? 'done' : '--'}
                  </span>
                ))}
              </div>
              <div className="platform-card-actions">
                {!p.configured ? (
                  <button type="button" className="wizard-start-btn" onClick={() => startWizard(p)}>Setup</button>
                ) : (
                  <span className="platform-card-badge">Active</span>
                )}
                {p.setupUrl ? (
                  <a href={p.setupUrl} target="_blank" rel="noopener noreferrer" className="admin-mini-btn platform-docs-link">Docs</a>
                ) : null}
              </div>
              {!p.configured && p.setupHint ? (
                <div className="platform-card-hint">{p.setupHint}</div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="platforms-cli-hint">
        <span className="admin-hint">Prefer the terminal? </span>
        <code>buff gateway setup telegram</code>
        <span className="admin-hint"> — same wizard from your CLI</span>
      </div>

      {wizardPlatform && guide ? (
        <div className="wizard-overlay" onClick={() => setWizardPlatform(null)}>
          <div className="wizard-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wizard-header">
              <span className="wizard-icon">{guide.icon}</span>
              <span className="wizard-title">Getting Started: {wizardPlatform.label}</span>
              <div className="wizard-steps-indicator">
                <span className={stepDotClass(0)}>1</span>
                <span className={stepDotClass(1)}>2</span>
                <span className={stepDotClass(2)}>3</span>
              </div>
              <button type="button" className="admin-mini-btn" onClick={() => setWizardPlatform(null)}>X</button>
            </div>
            <div className="wizard-body">
              {wizardStep === 0 && (
                <>
                  <p className="wizard-section-title">Step 1: Create your bot on {wizardPlatform.label}</p>
                  <ol className="wizard-steps">
                    {guide.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                  <div className="wizard-nav">
                    <button type="button" className="admin-refresh-btn" onClick={() => setWizardStep(1)}>I have my token — Step 2</button>
                    {wizardPlatform.setupUrl ? (
                      <a href={wizardPlatform.setupUrl} target="_blank" rel="noopener noreferrer" className="admin-mini-btn platform-docs-link">Open docs</a>
                    ) : null}
                  </div>
                </>
              )}

              {wizardStep === 1 && (
                <>
                  <p className="wizard-section-title">Step 2: Paste your token</p>
                  {wizardPlatform.envVars.map((v) => (
                    <label className="hub-send-target" key={v.varName}>
                      <span className="admin-hint">{v.prompt}</span>
                      <input
                        type={v.secret ? 'password' : 'text'}
                        value={wizardValues[v.varName] ?? ''}
                        onChange={(e) => setWizardValues((prev) => ({ ...prev, [v.varName]: e.target.value }))}
                        placeholder={v.secret ? 'paste your token here' : 'value'}
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                      />
                    </label>
                  ))}
                  {wizardResult ? (
                    <div className={wizardResult.kind === 'ok' ? 'admin-row-msg' : 'admin-row-msg admin-row-msg-err'}>{wizardResult.text}</div>
                  ) : null}
                  <div className="wizard-nav">
                    <button type="button" className="admin-mini-btn" onClick={() => setWizardStep(0)}>Back</button>
                    <button type="button" className="admin-refresh-btn" onClick={() => void saveWizard()} disabled={wizardSaving}>
                      {wizardSaving ? 'Saving...' : 'Save & Verify'}
                    </button>
                  </div>
                </>
              )}

              {wizardStep === 2 && (
                <>
                  <p className="wizard-section-title">Step 3: Verify and test</p>

                  {wizardVerify.status === 'checking' && (
                    <div className="wizard-verify-status">Verifying token...</div>
                  )}
                  {wizardVerify.status === 'ok' && (
                    <div className="wizard-verify-status ok">Connected as {wizardVerify.info}</div>
                  )}
                  {wizardVerify.status === 'err' && (
                    <div className="wizard-verify-status err">{wizardVerify.error}</div>
                  )}
                  {wizardVerify.status === 'idle' && wizardResult?.kind === 'ok' && (
                    <div className="wizard-verify-status ok">{wizardResult.text}</div>
                  )}

                  {wizardTestTarget && (
                    <div className="wizard-test-section">
                      <p className="wizard-section-title">Send a test message:</p>
                      <div className="wizard-test-row">
                        <input className="wizard-test-input" value={wizardTestTarget} onChange={(e) => setWizardTestTarget(e.target.value)} placeholder="telegram:YOUR_CHAT_ID" />
                      </div>
                      <div className="wizard-test-row">
                        <input className="wizard-test-input" value={wizardTestMsg} onChange={(e) => setWizardTestMsg(e.target.value)} placeholder="Hello from agent-nuvira!" />
                        <button type="button" className="admin-refresh-btn" onClick={() => void sendTestMessage()} disabled={wizardTestSending || !wizardTestTarget}>
                          {wizardTestSending ? 'Sending...' : 'Send test'}
                        </button>
                      </div>
                      {wizardTestResult ? (
                        <div className={wizardTestResult.kind === 'ok' ? 'admin-row-msg' : 'admin-row-msg admin-row-msg-err'}>{wizardTestResult.text}</div>
                      ) : null}
                    </div>
                  )}

                  <div className="wizard-nav">
                    <button type="button" className="admin-mini-btn" onClick={() => setWizardStep(1)}>Edit token</button>
                    <button type="button" className="admin-refresh-btn" onClick={() => setWizardPlatform(null)}>Done</button>
                  </div>

                  {!wizardTestTarget && (
                    <p className="wizard-hint">Token saved! Start the gateway from the Gateway tab, then send a message from your {wizardPlatform.label} app.</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
