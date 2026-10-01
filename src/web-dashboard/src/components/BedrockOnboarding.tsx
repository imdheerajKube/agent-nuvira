import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';
import type { BedrockStatus } from '../types';
import PageHeader from './PageHeader';

// ─── Types ──────────────────────────────────────────────────────────────────

interface BedrockProbeResult {
  modelId: string;
  status: 'accessible' | 'permission-denied' | 'not-found' | 'error';
  httpStatus?: number;
}

interface BedrockSetupResult {
  ok: boolean;
  error?: string;
  envVarsWritten?: string[];
}

interface Props {
  canWrite: boolean;
  sessionExpired: (msg?: string) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BEDROCK_REGIONS = [
  { value: 'us-east-1', label: 'us-east-1 (N. Virginia) — most models' },
  { value: 'us-west-2', label: 'us-west-2 (Oregon) — most models' },
  { value: 'eu-west-1', label: 'eu-west-1 (Ireland) — EU coverage' },
  { value: 'ap-southeast-1', label: 'ap-southeast-1 (Singapore)' },
  { value: 'ap-northeast-1', label: 'ap-northeast-1 (Tokyo)' },
];

const MODEL_FAMILIES = [
  { name: 'Anthropic Claude', models: ['claude-haiku-4.5', 'claude-sonnet-4.6', 'claude-fable-5', 'claude-opus-4.6'], checked: true },
  { name: 'Meta Llama', models: ['llama3-1-8b', 'llama3-1-70b', 'llama3-3-70b', 'llama4-scout', 'llama4-maverick'], checked: true },
  { name: 'Mistral AI', models: ['mistral-large-3', 'devstral-2', 'ministral-3'], checked: false },
  { name: 'DeepSeek', models: ['deepseek-v3.2', 'deepseek-r1'], checked: false },
  { name: 'Amazon Nova', models: ['nova-pro', 'nova-lite'], checked: false },
  { name: 'OpenAI on Bedrock', models: ['gpt-5.6-terra', 'gpt-oss-120b'], checked: false },
  { name: 'Qwen', models: ['qwen3-coder-next', 'qwen3-32b'], checked: false },
  { name: 'Google Gemma', models: ['gemma-3-12b'], checked: false },
  { name: 'xAI', models: ['grok-4.6'], checked: false },
];

// ─── Main Component ─────────────────────────────────────────────────────────

export default function BedrockOnboarding({ canWrite, sessionExpired }: Props) {
  const [status, setStatus] = useState<BedrockStatus | null>(null);
  const [probeResults, setProbeResults] = useState<BedrockProbeResult[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [step, setStep] = useState<'overview' | 'setup' | 'models' | 'test'>('overview');
  const mounted = useRef(true);

  // Setup wizard state
  const [authMethod, setAuthMethod] = useState<'bearer' | 'iam'>('bearer');
  const [apiKey, setApiKey] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [selectedFamilies, setSelectedFamilies] = useState<string[]>(
    MODEL_FAMILIES.filter(f => f.checked).map(f => f.name)
  );
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const s = await dashboardAPI.getBedrockStatus();
    if (mounted.current) setStatus(s);
  }, []);

  useEffect(() => {
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  const runProbe = async (): Promise<void> => {
    setProbing(true);
    setProbeResults(null);
    try {
      const result = await dashboardAPI.probeBedrock(status?.region || 'us-east-1');
      if (!mounted.current) return;
      if (result.ok && result.models) {
        setProbeResults(result.models as BedrockProbeResult[]);
        setStep('test');
      }
    } catch {
      // ignore
    } finally {
      if (mounted.current) setProbing(false);
    }
  };

  const saveSetup = async (): Promise<void> => {
    setSaving(true);
    setSaveResult(null);
    try {
      const envVars: Record<string, string> = { BEDROCK_REGION: region };
      if (authMethod === 'bearer' && apiKey) {
        envVars.AWS_BEARER_TOKEN = apiKey;
      } else if (authMethod === 'iam') {
        if (accessKeyId) envVars.AWS_ACCESS_KEY_ID = accessKeyId;
        if (secretAccessKey) envVars.AWS_SECRET_ACCESS_KEY = secretAccessKey;
      }

      const result = await dashboardAPI.setupBedrock(envVars);
      if (!mounted.current) return;

      if (result.ok) {
        setSaveResult({ kind: 'ok', text: '✅ Configuration saved! Running connectivity test…' });
        setStep('overview');
        await refresh();
        // Auto-probe after save
        setTimeout(() => void runProbe(), 500);
      } else {
        setSaveResult({ kind: 'err', text: result.error || 'Save failed' });
      }
    } catch {
      if (mounted.current) setSaveResult({ kind: 'err', text: 'Could not reach the dashboard server.' });
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  if (status === null) {
    return <div className="empty-state">Loading Bedrock status…</div>;
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="bedrock-onboarding">
      <PageHeader icon="🟠" title="AWS Bedrock" />
      <p className="admin-subtitle">
        Bedrock gives you access to Claude, Llama, Mistral, DeepSeek, and more — all through a single AWS account.
        Unlike other providers, Bedrock requires a <strong>region</strong>, <strong>AWS credentials</strong>, and explicit <strong>model access approval</strong>.
      </p>

      {saveResult ? (
        <div className={`admin-row-msg${saveResult.kind === 'ok' ? '' : ' admin-row-msg-err'}`}>{saveResult.text}</div>
      ) : null}

      {/* ── Status Bar ─────────────────────────────────────────────────── */}
      <div className="bedrock-status-bar">
        <div className="bedrock-status-item">
          <span className={`status-dot ${status.configured ? 'connected' : 'reconnecting'}`} />
          <span>{status.configured ? 'Configured' : 'Not configured'}</span>
        </div>
        <div className="bedrock-status-item">
          <span className="bedrock-status-label">Region:</span>
          <code>{status.region}</code>
        </div>
        <div className="bedrock-status-item">
          <span className="bedrock-status-label">Auth:</span>
          <code>{status.authMethod === 'bearer' ? 'API Key' : status.authMethod === 'iam' ? 'IAM' : 'None'}</code>
        </div>
        <div className="bedrock-status-actions">
          {canWrite ? (
            <button
              type="button"
              className="admin-refresh-btn"
              onClick={() => setStep(step === 'setup' ? 'overview' : 'setup')}
            >
              {step === 'setup' ? '✕ Cancel' : '⚙ Setup Wizard'}
            </button>
          ) : null}
          {status.configured ? (
            <button
              type="button"
              className="admin-refresh-btn"
              onClick={() => void runProbe()}
              disabled={probing}
            >
              {probing ? '⏳ Probing…' : '🔍 Test Models'}
            </button>
          ) : null}
        </div>
      </div>

      {/* ── Setup Wizard ──────────────────────────────────────────────── */}
      {step === 'setup' && (
        <div className="bedrock-setup-wizard">
          <h2 className="section-subtitle">🚀 Bedrock Setup Wizard</h2>

          {/* Step 1: Auth Method */}
          <div className="bedrock-wizard-step">
            <h4>Step 1: Authentication</h4>
            <div className="bedrock-auth-options">
              <label className={`bedrock-auth-option ${authMethod === 'bearer' ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="authMethod"
                  checked={authMethod === 'bearer'}
                  onChange={() => setAuthMethod('bearer')}
                />
                <div>
                  <strong>Bedrock API Key</strong>
                  <span>Simpler — get from Bedrock → Settings → API keys</span>
                </div>
              </label>
              <label className={`bedrock-auth-option ${authMethod === 'iam' ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="authMethod"
                  checked={authMethod === 'iam'}
                  onChange={() => setAuthMethod('iam')}
                />
                <div>
                  <strong>IAM Credentials</strong>
                  <span>Full AWS SDK auth — AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY</span>
                </div>
              </label>
            </div>

            {authMethod === 'bearer' ? (
              <div className="bedrock-wizard-fields">
                <div className="bedrock-setup-hint">
                  <strong>How to get a Bedrock API key:</strong>
                  <ol>
                    <li>Open <a href="https://console.aws.amazon.com/bedrock/" target="_blank" rel="noopener noreferrer">AWS Bedrock Console</a></li>
                    <li>Go to <strong>Settings</strong> → <strong>API keys</strong></li>
                    <li>Create a new key and paste it below</li>
                  </ol>
                </div>
                <label className="hub-send-target">
                  <span className="admin-hint">Bedrock API Key (Bearer token)</span>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="••••••••••••"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>
            ) : (
              <div className="bedrock-wizard-fields">
                <div className="bedrock-setup-hint">
                  <strong>IAM credentials</strong> give full AWS SDK access. Create an IAM user with Bedrock permissions.
                </div>
                <label className="hub-send-target">
                  <span className="admin-hint">AWS_ACCESS_KEY_ID</span>
                  <input
                    type="text"
                    value={accessKeyId}
                    onChange={(e) => setAccessKeyId(e.target.value)}
                    placeholder="AKIA..."
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="hub-send-target">
                  <span className="admin-hint">AWS_SECRET_ACCESS_KEY</span>
                  <input
                    type="password"
                    value={secretAccessKey}
                    onChange={(e) => setSecretAccessKey(e.target.value)}
                    placeholder="••••••••••••"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>
            )}
          </div>

          {/* Step 2: Region */}
          <div className="bedrock-wizard-step">
            <h4>Step 2: AWS Region</h4>
            <p className="admin-hint">
              Models vary by region. <strong>us-east-1</strong> and <strong>us-west-2</strong> have the most models.
              ⚠️ Do NOT use eu-north-1 unless models are explicitly enabled there.
            </p>
            <select
              className="bedrock-region-select"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            >
              {BEDROCK_REGIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {/* Step 3: Model Access */}
          <div className="bedrock-wizard-step">
            <h4>Step 3: Model Access</h4>
            <p className="admin-hint">
              Bedrock requires you to request access for each model family.
            </p>
            <div className="bedrock-model-access-hint">
              <a
                href={`https://console.aws.amazon.com/bedrock/home?region=${region}#/modelaccess`}
                target="_blank"
                rel="noopener noreferrer"
                className="admin-mini-btn"
              >
                📖 Open Model Access in AWS Console
              </a>
            </div>
            <div className="bedrock-family-grid">
              {MODEL_FAMILIES.map((family) => (
                <label key={family.name} className={`bedrock-family-card ${selectedFamilies.includes(family.name) ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selectedFamilies.includes(family.name)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedFamilies((prev) => [...prev, family.name]);
                      } else {
                        setSelectedFamilies((prev) => prev.filter((f) => f !== family.name));
                      }
                    }}
                  />
                  <div>
                    <strong>{family.name}</strong>
                    <span>{family.models.length} model(s)</span>
                  </div>
                </label>
              ))}
            </div>
            <p className="admin-hint" style={{ marginTop: 8 }}>
              In the AWS Console, select the families above and submit. Approval is usually instant for Anthropic and Meta models.
            </p>
          </div>

          {/* Save Button */}
          <div className="bedrock-wizard-actions">
            <button
              type="button"
              className="admin-refresh-btn"
              onClick={() => void saveSetup()}
              disabled={saving || (authMethod === 'bearer' && !apiKey) || (authMethod === 'iam' && (!accessKeyId || !secretAccessKey))}
            >
              {saving ? '⏳ Saving…' : '💾 Save & Test'}
            </button>
            <button type="button" className="admin-mini-btn" onClick={() => setStep('overview')}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Probe Results ──────────────────────────────────────────────── */}
      {step === 'test' && probeResults && (
        <div className="bedrock-probe-results">
          <h2 className="section-subtitle">🔍 Model Probe Results ({status.region})</h2>
          <div className="bedrock-probe-grid">
            {probeResults.map((r) => (
              <div key={r.modelId} className={`bedrock-probe-card bedrock-probe-${r.status}`}>
                <span className={`bedrock-probe-icon`}>
                  {r.status === 'accessible' ? '✅' : r.status === 'permission-denied' ? '🔒' : r.status === 'not-found' ? '⚫' : '❌'}
                </span>
                <span className="bedrock-probe-id">{r.modelId}</span>
                <span className="bedrock-probe-status">
                  {r.status === 'accessible' ? 'Ready' :
                   r.status === 'permission-denied' ? `Need access (HTTP ${r.httpStatus})` :
                   r.status === 'not-found' ? 'Not in this region' : 'Error'}
                </span>
              </div>
            ))}
          </div>
          {probeResults.some((r) => r.status === 'permission-denied') && (
            <div className="bedrock-probe-action">
              <p>Some models exist in {status.region} but access is not approved.</p>
              <a
                href={`https://console.aws.amazon.com/bedrock/home?region=${status.region}#/modelaccess`}
                target="_blank"
                rel="noopener noreferrer"
                className="admin-mini-btn"
              >
                🔓 Request Model Access in AWS Console →
              </a>
            </div>
          )}
          <button type="button" className="admin-mini-btn" onClick={() => setStep('overview')} style={{ marginTop: 12 }}>
            ← Back
          </button>
        </div>
      )}

      {/* ── Getting Started Guide (when not configured) ──────────────── */}
      {!status.configured && step === 'overview' && (
        <div className="bedrock-getting-started">
          <h2 className="section-subtitle">📋 Getting Started with Bedrock</h2>
          <div className="bedrock-steps">
            <div className="bedrock-step">
              <span className="bedrock-step-num">1</span>
              <div>
                <strong>Create an AWS account</strong> (or use existing)
                <span>New to AWS? Sign up at <a href="https://aws.amazon.com/" target="_blank" rel="noopener noreferrer">aws.amazon.com</a></span>
              </div>
            </div>
            <div className="bedrock-step">
              <span className="bedrock-step-num">2</span>
              <div>
                <strong>Get Bedrock API key</strong>
                <span>Bedrock → Settings → API keys → Create key</span>
              </div>
            </div>
            <div className="bedrock-step">
              <span className="bedrock-step-num">3</span>
              <div>
                <strong>Request model access</strong>
                <span>Bedrock → Model access → Select Claude, Llama, etc. → Submit</span>
              </div>
            </div>
            <div className="bedrock-step">
              <span className="bedrock-step-num">4</span>
              <div>
                <strong>Configure in this wizard</strong>
                <span>Click "Setup Wizard" above to enter your credentials</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Quick Status (when configured) ──────────────────────────── */}
      {status.configured && step === 'overview' && !probeResults && (
        <div className="bedrock-quick-status">
          <p className="admin-hint">
            Bedrock is configured. Click <strong>🔍 Test Models</strong> to verify connectivity and discover which models are accessible in {status.region}.
          </p>
        </div>
      )}
    </div>
  );
}
