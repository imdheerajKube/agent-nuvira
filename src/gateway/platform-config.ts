/**
 * Platform transport configuration — the `nuvira config gateway` surface.
 *
 * Gateway platform tokens live in env vars (the `config.py` map, see
 * channel-directory.ts). This module adds a GUIDED way to manage them: a
 * `~/.nuvira/.env` file (NUVIRA_ENV_FILE overrides it — same path `loadEnv()` in
 * src/utils/env.ts already reads at CLI + dashboard startup) that both the CLI
 * wizard and the dashboard Channels tab write to, with a line-preserving merge
 * so comments and unrelated keys survive.
 *
 * `whatsapp` (the personal Baileys bridge) is deliberately excluded: its
 * transport is a PAIRED SESSION on disk, configured through `nuvira whatsapp
 * pair` / the WhatsApp panel — not an env token.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveNuviraEnvFile } from '../config/paths.js';
import { join } from 'node:path';

import {
  PLATFORM_ENV_VARS,
  PLATFORM_LABELS,
  PLATFORM_TRANSPORT_ENV_VARS,
  platformConfigVars,
  type Platform,
} from './channel-directory.js';

/** Per-var metadata for guided setup (prompt + whether the value is a secret). */
export interface PlatformEnvVarMeta {
  varName: string;
  /** Short prompt shown in the wizard / form label. */
  prompt: string;
  /** Secrets (tokens, passwords, keys) are prompted masked + displayed redacted. */
  secret: boolean;
  /**
   * True for an ADDITIONAL transport mode (see PLATFORM_TRANSPORT_ENV_VARS) —
   * not needed to use the platform, so the prompt says so and `--set` mode does
   * not demand it.
   */
  optional: boolean;
}

const SECRET_HINT = /TOKEN|PASSWORD|PASS|SECRET|KEY|AUTH|CRED/i;

const PROMPTS: Record<string, string> = {
  NUVIRA_TELEGRAM_TOKEN: 'Telegram bot token (from @BotFather)',
  NUVIRA_DISCORD_BOT_TOKEN: 'Discord bot token',
  NUVIRA_SLACK_BOT_TOKEN: 'Slack bot token',
  NUVIRA_SLACK_APP_TOKEN: 'Slack app-level token (xapp-…, Socket Mode inbound)',
  NUVIRA_SLACK_WEBHOOK_URL: 'Slack incoming-webhook URL (outbound without a bot token)',
  NUVIRA_SLACK_SIGNING_SECRET: 'Slack signing secret (Events API signature verification)',
  NUVIRA_DISCORD_WEBHOOK_URL: 'Discord incoming-webhook URL (instead of / alongside a bot token)',
  NUVIRA_WHATSAPP_SESSION_DIR: 'WhatsApp session dir (leave default unless moved)',
  NUVIRA_WHATSAPP_TOKEN: 'Meta Cloud API token',
  NUVIRA_DINGTALK_WEBHOOK_URL: 'DingTalk robot webhook URL',
  NUVIRA_FEISHU_WEBHOOK_URL: 'Feishu bot webhook URL',
  NUVIRA_WECOM_WEBHOOK_URL: 'WeCom group-bot webhook URL',
  NUVIRA_MATTERMOST_WEBHOOK_URL: 'Mattermost incoming-webhook URL',
  NUVIRA_MATRIX_HOMESERVER: 'Matrix homeserver base URL (e.g. https://matrix.org)',
  NUVIRA_MATRIX_ACCESS_TOKEN: 'Matrix access token',
  NUVIRA_WEBHOOK_URL: 'Generic webhook URL',
  NUVIRA_BLUEBUBBLES_URL: 'BlueBubbles server URL',
  NUVIRA_BLUEBUBBLES_PASSWORD: 'BlueBubbles password',
  NUVIRA_NTFY_TOPIC: 'ntfy topic (defaults to https://ntfy.sh)',
  NUVIRA_TEAMS_WEBHOOK_URL: 'Teams incoming-webhook URL',
  NUVIRA_GOOGLE_CHAT_WEBHOOK_URL: 'Google Chat space webhook URL',
  NUVIRA_WEIXIN_TOKEN: 'Weixin iLink bot token',
  TWILIO_ACCOUNT_SID: 'Twilio account SID',
  TWILIO_AUTH_TOKEN: 'Twilio auth token',
  TWILIO_PHONE_NUMBER: 'Twilio sender phone number (E.164)',
  IRC_SERVER: 'IRC server host (e.g. irc.libera.chat)',
  SIMPLEX_WS_URL: 'SimpleX daemon WebSocket URL (ws://127.0.0.1:5225)',
  HASS_TOKEN: 'Home Assistant long-lived access token',
  NUVIRA_SMTP_HOST: 'SMTP relay host (e.g. smtp.gmail.com:587)',
  NUVIRA_SMTP_USER: 'SMTP auth user',
  NUVIRA_SIGNAL_ACCOUNT: 'Signal account number (registered with signal-cli-rest-api)',
};

export function platformEnvVarMeta(platform: Platform): PlatformEnvVarMeta[] {
  const required = new Set(PLATFORM_ENV_VARS[platform]);
  return platformConfigVars(platform).map((varName) => {
    const optional = !required.has(varName);
    return {
      varName,
      // The marker lives in the prompt rather than in each renderer: this string
      // is what the CLI wizard, `config gateway list` and the dashboard form all
      // label the field with, so one place keeps them from disagreeing about
      // which keys are required.
      prompt: `${PROMPTS[varName] ?? varName}${optional ? ' (optional)' : ''}`,
      secret: SECRET_HINT.test(varName),
      optional,
    };
  });
}

/** Platforms manageable through the config surface (excludes whatsapp/mock). */
export function configurablePlatforms(): Platform[] {
  return (Object.keys(PLATFORM_ENV_VARS) as Platform[]).filter(
    (p) => p !== 'whatsapp' && p !== 'mock',
  );
}

// ─── Credential .env read/write (line-preserving merge) ──────────────────────

/**
 * The `.env` that holds platform credentials. Delegates to the shared resolver
 * so writes land in the ACTIVE config dir (`NUVIRA_CONFIG_DIR` aware) and never
 * mutate the real profile's credential file from an isolated process.
 */
export function envFilePath(): string {
  return resolveNuviraEnvFile();
}

export interface EnvVarState {
  varName: string;
  /** True when a value is currently effective (env file or process env). */
  set: boolean;
  /** Current effective value (empty when unset). */
  value: string;
}

/** Per-var current state — env file first, then process.env (file wins like loadEnv). */
export function envVarState(varName: string): EnvVarState {
  const fileValue = readEnvFileValue(varName);
  const value = fileValue !== null && fileValue !== '' ? fileValue : (process.env[varName] ?? '');
  return { varName, set: value.length > 0, value };
}

/** Platform status with per-var values (for the CLI table + dashboard form). */
export interface PlatformConfigStatus {
  platform: Platform;
  label: string;
  /** Every REQUIRED var is set — the platform is usable (see platformConfigVars). */
  configured: boolean;
  envVars: EnvVarState[];
  /**
   * Vars in {@link envVars} that are additional transport modes rather than
   * requirements — an unset one here means "that way of talking to the platform
   * is off", NOT "the platform is unusable". Surfaced so the CLI/dashboard can
   * say which is which instead of leaving the operator to guess.
   */
  extraVars: string[];
}

export function platformConfigStatus(platform: Platform): PlatformConfigStatus {
  // Every managed var is LISTED (so the key Socket Mode needs is visible and
  // writable), but `configured` is judged on the required ones only — an
  // outbound-only Slack app is configured, it just cannot receive yet.
  const required = new Set(PLATFORM_ENV_VARS[platform]);
  const envVars = platformConfigVars(platform).map(envVarState);
  return {
    platform,
    label: PLATFORM_LABELS[platform],
    // The env FILE counts as effective too (loadEnv() merges it at startup) —
    // so a token written to ~/.nuvira/.env shows as configured even before the
    // next process restart.
    configured: envVars.filter((v) => required.has(v.varName)).every((v) => v.set),
    envVars,
    extraVars: PLATFORM_TRANSPORT_ENV_VARS[platform] ?? [],
  };
}

function readEnvFileValue(varName: string): string | null {
  try {
    const path = envFilePath();
    if (!existsSync(path)) return null;
    for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const bare = line.startsWith('export ') ? line.slice(7).trimStart() : line;
      const eq = bare.indexOf('=');
      if (eq === -1) continue;
      if (bare.slice(0, eq).trim() !== varName) continue;
      // Strip inline comment + surrounding quotes, mirroring loadEnv().
      let value = bare.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

const ENV_LINE_RE = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function quoteValue(value: string): string {
  const cleaned = value.replace(/[\r\n]/g, '');
  return /[\s#"']/.test(cleaned) ? `"${cleaned.replace(/"/g, '\\"')}"` : cleaned;
}

/**
 * Merge `updates` into the env file (in-place line replacement for existing
 * keys, appended at the end for new ones) and drop any `removes` keys.
 * Preserves comments, ordering, and unrelated keys. Never throws.
 */
export function writeEnvFile(
  updates: Record<string, string>,
  removes: string[] = [],
): { wrote: string[]; removed: string[] } {
  const path = envFilePath();
  const pending = { ...updates };
  const removeSet = new Set(removes);
  const lines: string[] = [];
  const wrote: string[] = [];
  if (existsSync(path)) {
    for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/)) {
      const m = rawLine.match(ENV_LINE_RE);
      if (m) {
        const key = m[2];
        if (removeSet.has(key)) continue;
        if (key in pending) {
          const exportPrefix = m[1] ? 'export ' : '';
          lines.push(`${exportPrefix}${key}=${quoteValue(pending[key])}`);
          wrote.push(key);
          delete pending[key];
          continue;
        }
      }
      lines.push(rawLine);
    }
  }
  for (const [key, value] of Object.entries(pending)) {
    lines.push(`${key}=${quoteValue(value)}`);
    wrote.push(key);
  }
  const removed = removes.filter((k) => readEnvFileValue(k) !== null || process.env[k]);
  try {
    mkdirSync(path.slice(0, path.lastIndexOf('/')) || '.', { recursive: true });
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  } catch {
    /* best-effort — the caller surfaces a friendly error */
  }
  return { wrote, removed };
}

/** Apply written values to the running process (dashboard hot-pickup). */
export function applyEnvToProcess(updates: Record<string, string>, removes: string[] = []): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value) process.env[key] = value;
  }
  for (const key of removes) {
    delete process.env[key];
  }
}

/** Redact a value for display: show first 4 chars + '…' (or '<unset>'). */
export function redactValue(value: string): string {
  if (!value) return '<unset>';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${'•'.repeat(4)}`;
}
