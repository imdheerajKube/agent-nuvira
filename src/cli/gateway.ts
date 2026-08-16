/**
 * GatewayCommand — J1 multi-channel gateway CLI.
 *
 *   buff gateway status           — show configured adapters + reachable channels
 *   buff gateway send <target> <text> — send a message to an alias or platform:channelId
 *   buff gateway alias add <alias> <platform> <channelId>   — register an alias
 *   buff gateway alias remove <alias>                      — remove an alias
 *   buff gateway start [--port N] [--no-events]            — run adapters in the foreground
 *
 * Opt-in adapters: BUFF_TELEGRAM_TOKEN (long-poll) · BUFF_DISCORD_BOT_TOKEN /
 * BUFF_DISCORD_WEBHOOK_URL · BUFF_SLACK_BOT_TOKEN / BUFF_SLACK_WEBHOOK_URL ·
 * BUFF_WHATSAPP_TOKEN + BUFF_WHATSAPP_PHONE_ID. Mirrors Hermes `gateway/`.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { GatewayRegistry } from '../gateway/registry.js';
import {
  ChannelDirectory,
  PLATFORM_LABELS,
  configuredPlatforms,
  isPlatformConfigured,
} from '../gateway/channel-directory.js';
import {
  createConfiguredAdapters,
  WebhookReceiver,
  TelegramAdapter,
  DiscordAdapter,
  SlackAdapter,
  WhatsAppBridgeAdapter,
  WhatsAppCloudAdapter,
  EmailAdapter,
  SignalAdapter,
  DingTalkAdapter,
  FeishuAdapter,
  WeComAdapter,
  MattermostAdapter,
  MatrixAdapter,
  GenericWebhookAdapter,
  BlueBubblesAdapter,
  NtfyAdapter,
  TeamsAdapter,
  GoogleChatAdapter,
  WeixinAdapter,
  SmsAdapter,
  IrcAdapter,
  SimplexAdapter,
  HomeAssistantAdapter,
  type ChannelAdapter,
} from '../gateway/adapters.js';
import { DeliveryLedger } from '../gateway/delivery.js';
import { guardRbacAction } from './rbac-guard.js';

export class GatewayCommand {
  create(): Command {
    const cmd = new Command('gateway')
      .description('Multi-channel gateway — talk to the agent from Telegram/Discord/Slack/WhatsApp/Email/Signal (J1)');

    cmd
      .command('status')
      .description('Show configured adapters and reachable channels')
      .action(() => this.status());

    cmd
      .command('send <target> <text>')
      .description('Send a message to a channel alias or platform:channelId')
      .action(async (target, text) => this.send(target, text));

    cmd
      .command('send-media <target> <file>')
      .description('Send a media file (image/video/audio/document) — type from the file extension; WhatsApp/Telegram/Discord')
      .option('--caption <text>', 'Optional caption for image/video')
      .action(async (target, file, opts: { caption?: string }) => this.sendMedia(target, file, opts.caption));

    const alias = cmd.command('alias').description('Manage channel aliases');

    alias
      .command('add <alias> <platform> <channelId>')
      .description('Register an alias: buff gateway alias add ops slack C0123')
      .action(async (a, p, c) => this.aliasAdd(a, p, c));

    alias
      .command('remove <alias>')
      .description('Remove an alias')
      .action(async (a) => this.aliasRemove(a));

    cmd
      .command('delivery')
      .description('Show the delivery ledger (failed sends awaiting retry) and optionally drain it')
      .option('--flush', 'Attempt every due pending entry now (uses configured adapters)')
      .action(async (opts) => this.delivery(Boolean(opts.flush)));

    cmd
      .command('start')
      .description('Run all configured adapters in the foreground (Ctrl-C to stop)')
      .option('--port <n>', 'Webhook inbound port for Discord/Slack/WhatsApp', '8787')
      .option('--host <ip>', 'Webhook bind address (default 127.0.0.1 — use 0.0.0.0 for a public tunnel)', '127.0.0.1')
      .option('--no-events', 'Do not stream board events to channels', false)
      .action(async (opts) => this.start(Number(opts.port), opts.host, opts.events));

    cmd
      .command('stop')
      .description('Stop a running gateway gracefully (SIGTERM — from any terminal)')
      .option('--port <n>', 'Webhook port the gateway is bound to (default 8787)', '8787')
      .action(async (opts) => this.stop(Number(opts.port)));

    return cmd;
  }

  // ─── status ───────────────────────────────────────────────────────────────

  private status(): void {
    const adapters = statusAdapters();
    console.log('🌐 Gateway status');
    console.log('');
    for (const adapter of adapters) {
      const mark = adapter.configured ? '✅' : '⬜';
      console.log(`  ${mark} ${adapter.describe()}`);
    }
    console.log('');
    const configured = configuredPlatforms();
    console.log(`  ${configured.length}/${adapters.length} platforms configured`);
    console.log('');
    if (configured.length === 0) {
      console.log('No adapters configured. Set one of:');
      console.log('  BUFF_TELEGRAM_TOKEN · BUFF_DISCORD_BOT_TOKEN · BUFF_DISCORD_WEBHOOK_URL');
      console.log('  BUFF_SLACK_BOT_TOKEN · BUFF_SLACK_WEBHOOK_URL · BUFF_WHATSAPP_SESSION_DIR (bridge) · BUFF_WHATSAPP_TOKEN + PHONE_ID (cloud)');
      console.log('  BUFF_SMTP_HOST + BUFF_SMTP_USER (email) · BUFF_SIGNAL_ACCOUNT (signal)');
      console.log('  I9 webhooks: BUFF_DINGTALK_WEBHOOK_URL · BUFF_FEISHU_WEBHOOK_URL · BUFF_WECOM_WEBHOOK_URL · BUFF_MATTERMOST_WEBHOOK_URL');
      console.log('  BUFF_MATRIX_HOMESERVER + BUFF_MATRIX_ACCESS_TOKEN · BUFF_WEBHOOK_URL · BUFF_BLUEBUBBLES_URL + BUFF_BLUEBUBBLES_PASSWORD');
      console.log('  I10 send: BUFF_NTFY_TOPIC (+BUFF_NTFY_URL/BUFF_NTFY_TOKEN) · BUFF_TEAMS_WEBHOOK_URL · BUFF_GOOGLE_CHAT_WEBHOOK_URL · BUFF_WEIXIN_TOKEN');
      console.log('  I12 sms: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER (same creds as Hermes)');
      console.log('  I13 irc: IRC_SERVER (+IRC_PORT/IRC_NICKNAME/IRC_CHANNEL/IRC_USE_TLS/IRC_NICKSERV_PASSWORD — same creds as Hermes)');
      console.log('  I14 simplex: SIMPLEX_WS_URL (local simplex-chat daemon, ws://127.0.0.1:5225 — same creds as Hermes)');
      console.log('  I15 homeassistant: HASS_TOKEN (+HASS_URL, defaults to http://homeassistant.local:8123 — same creds as Hermes)');
      console.log('');
    }
    const directory = new ChannelDirectory();
    const channels = directory.reachableChannels();
    if (channels.length > 0) {
      console.log('📇 Reachable channels:');
      for (const ch of channels) {
        const mark = ch.reachable ? '✅' : '⬜';
        console.log(`  ${mark} ${PLATFORM_LABELS[ch.platform]} ${ch.channelId} (${ch.aliases.join(', ')})`);
      }
    } else {
      console.log('📇 No channel aliases registered yet. Add one:');
      console.log('  buff gateway alias add <alias> <telegram|discord|slack|whatsapp|whatsapp_cloud|email|signal|dingtalk|feishu|wecom|mattermost|matrix|webhook|bluebubbles|ntfy|teams|google_chat|weixin|sms|irc|simplex|homeassistant> <channelId>');
      console.log('  buff gateway send ops "nightly build done"');
    }
  }

  // ─── send ─────────────────────────────────────────────────────────────────

  private async send(target: string, text: string): Promise<void> {
    const registry = new GatewayRegistry({ streamEvents: false });
    const adapters = createConfiguredAdapters();
    for (const adapter of adapters) registry.register(adapter);

    const ref = registry.directory.resolve(target);
    if (!ref) {
      logger.error(`Unknown channel target '${target}' — use an alias or platform:channelId`);
      process.exitCode = 1;
      return;
    }
    const ok = await registry.sendToRef(ref, text);
    // One-shot CLI send: disconnect the live transports (e.g. the WhatsApp
    // Baileys socket) so the process exits promptly instead of hanging on the
    // open socket. Idempotent + a no-op for webhook/poll adapters.
    for (const adapter of adapters) {
      try {
        await adapter.stop();
      } catch {
        /* best-effort */
      }
    }
    if (!ok) {
      logger.error(`Send failed — adapter for '${ref.platform}' is not configured (set its env token)`);
      process.exitCode = 1;
      return;
    }
    logger.success(`Sent to ${target} (${ref.platform}:${ref.channelId})`);
  }

  // ─── send-media (P3) ─────────────────────────────────────────────────────

  private async sendMedia(target: string, file: string, caption?: string): Promise<void> {
    let data: Uint8Array;
    try {
      data = readFileSync(file);
    } catch (err) {
      logger.error(`Cannot read file '${file}': ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    if (data.length === 0) {
      logger.error(`File '${file}' is empty.`);
      process.exitCode = 1;
      return;
    }
    const ext = extname(file).toLowerCase().replace('.', '');
    const type: 'image' | 'video' | 'audio' | 'document' =
      ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) ? 'image'
      : ['mp4', 'mov', 'mkv', 'webm'].includes(ext) ? 'video'
      : ['mp3', 'm4a', 'ogg', 'wav'].includes(ext) ? 'audio'
      : 'document';

    const registry = new GatewayRegistry({ streamEvents: false });
    const adapters = createConfiguredAdapters();
    for (const adapter of adapters) registry.register(adapter);
    const ref = registry.directory.resolve(target);
    if (!ref) {
      logger.error(`Unknown channel target '${target}' — use an alias or platform:channelId`);
      process.exitCode = 1;
      return;
    }
    const ok = await registry.sendMediaToRef(ref, {
      type,
      data,
      caption,
      filename: file.split('/').pop() ?? file,
    });
    // One-shot CLI send: disconnect live transports so the process exits.
    for (const adapter of adapters) {
      try {
        await adapter.stop();
      } catch {
        /* best-effort */
      }
    }
    if (!ok) {
      logger.error(`Media send failed — '${ref.platform}' does not support send-media (WhatsApp/Telegram/Discord do) or is not configured.`);
      process.exitCode = 1;
      return;
    }
    logger.success(`Sent ${type} to ${target} (${ref.platform}:${ref.channelId})`);
  }

  // ─── delivery (I2) ────────────────────────────────────────────────────────

  private async delivery(flush: boolean): Promise<void> {
    const ledger = new DeliveryLedger();
    const entries = ledger.read();

    if (flush && entries.some((e) => e.status === 'pending')) {
      const registry = new GatewayRegistry({ streamEvents: false });
      const adapters = createConfiguredAdapters();
      for (const adapter of adapters) registry.register(adapter);
      const counts = await registry.drainDelivery();
      // One-shot flush: disconnect live transports (Baileys socket) so the
      // process exits promptly.
      for (const adapter of adapters) {
        try {
          await adapter.stop();
        } catch {
          /* best-effort */
        }
      }
      logger.success(`Drained delivery queue — ${counts.sent} sent, ${counts.failed} failed, ${counts.processed} processed`);
    } else if (flush) {
      logger.info('Delivery queue empty — nothing to flush.');
    }

    const remaining = ledger.read();
    const pending = remaining.filter((e) => e.status === 'pending');
    const sent = remaining.filter((e) => e.status === 'sent');
    const failed = remaining.filter((e) => e.status === 'failed');
    console.log('📮 Delivery ledger (guaranteed delivery — Hermes delivery.py parity)');
    console.log('');
    if (remaining.length === 0) {
      console.log('  (empty — no failed sends recorded)');
      console.log('');
      return;
    }
    for (const e of remaining.slice(0, 20)) {
      const mark = e.status === 'sent' ? '✅' : e.status === 'failed' ? '❌' : '⏳';
      const retry = e.status === 'pending' ? ` retry#${e.attempts} at ${new Date(e.nextAttemptAt).toLocaleTimeString()}` : '';
      console.log(`  ${mark} ${e.platform}:${e.channelId} (${e.target}) — ${e.text.slice(0, 60)}${retry}${e.lastError ? ` — ${e.lastError.slice(0, 60)}` : ''}`);
    }
    if (remaining.length > 20) console.log(`  …and ${remaining.length - 20} more`);
    console.log('');
    console.log(`  total: ${pending.length} pending · ${sent.length} sent · ${failed.length} failed (of ${remaining.length} retained)`);
    console.log('  Retries happen automatically while `buff gateway start` runs; `--flush` forces a drain now.');
  }

  // ─── alias ────────────────────────────────────────────────────────────────

  private async aliasAdd(alias: string, platform: string, channelId: string): Promise<void> {
    if (!guardRbacAction('gateway.manage')) return;
    const directory = new ChannelDirectory();
    try {
      const entry = directory.setAlias(alias, platform as any, channelId);
      logger.success(`Alias '${entry.alias}' → ${PLATFORM_LABELS[entry.platform]} ${entry.channelId}`);
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  }

  private async aliasRemove(alias: string): Promise<void> {
    if (!guardRbacAction('gateway.manage')) return;
    const directory = new ChannelDirectory();
    if (directory.removeAlias(alias)) {
      logger.success(`Alias '${alias}' removed`);
    } else {
      logger.warn(`No alias '${alias}' found`);
    }
  }

  // ─── stop ─────────────────────────────────────────────────────────────────

  private async stop(port: number): Promise<void> {
    if (!guardRbacAction('gateway.manage')) return;
    const { stopGateway } = await import('./process-control.js');
    const result = await stopGateway({ port });
    if (result.stopped) {
      logger.success(`Gateway stopped (PID ${result.pid})`);
    } else {
      logger.error(`Could not stop the gateway: ${result.reason ?? 'no running gateway found'}`);
      process.exitCode = 1;
    }
  }

  // ─── start ────────────────────────────────────────────────────────────────

  private async start(port: number, host: string, streamEvents: boolean): Promise<void> {
    const registry = new GatewayRegistry({ streamEvents });
    const adapters: ChannelAdapter[] = createConfiguredAdapters();
    for (const adapter of adapters) registry.register(adapter);

    if (!registry.hasConfiguredAdapter()) {
      logger.warn('No adapters configured — set BUFF_TELEGRAM_TOKEN, BUFF_DISCORD_*, BUFF_SLACK_*, BUFF_WHATSAPP_*,');
      logger.warn('  BUFF_SMTP_HOST+BUFF_SMTP_USER (email), BUFF_SIGNAL_ACCOUNT (signal), or any I9 webhook URL env var.');
      logger.warn('Add aliases with: buff gateway alias add <alias> <platform> <channelId>');
    }

    // Webhook receiver for Discord/Slack/WhatsApp inbound.
    const receiver = new WebhookReceiver();
    const receiverStarted = new Promise<boolean>((resolve) => {
      receiver
        .start(async (msg) => {
          await registry.handleInbound(msg);
        }, port, host)
        .then(() => resolve(true))
        .catch(() => resolve(false));
    });
    const receiverOk = await receiverStarted;

    await registry.start();

    if (receiverOk) {
      logger.info(`Webhook receiver listening on ${host}:${port} (POST /discord /slack /whatsapp)`);
      logger.info('  ⚠ Public exposure requires platform signature secrets (BUFF_SLACK_SIGNING_SECRET / BUFF_WHATSAPP_APP_SECRET)');
      logger.info('  ⚠ Pipeline triggers are allow-listed via BUFF_GATEWAY_ALLOW_IDS (platform:channelId, comma-separated)');
    }

    console.log('');
    console.log('🌐 Gateway running — Ctrl-C to stop');
    const shutdown = async (): Promise<void> => {
      await registry.stop();
      await receiver.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    // Keep the process alive until interrupted.
    await new Promise<void>(() => { /* never resolves */ });
  }
}

/** Adapters for status display (all platforms, configured or not). */
function statusAdapters(): ChannelAdapter[] {
  const list: ChannelAdapter[] = [];
  for (const adapter of createConfiguredAdapters()) list.push(adapter);
  // Include unconfigured adapters in status so users see what to set.
  const seen = new Set(list.map((a) => a.platform));
  if (!seen.has('telegram')) list.push(new TelegramAdapter());
  if (!seen.has('discord')) list.push(new DiscordAdapter());
  if (!seen.has('slack')) list.push(new SlackAdapter());
  if (!seen.has('whatsapp')) list.push(new WhatsAppBridgeAdapter());
  if (!seen.has('whatsapp_cloud')) list.push(new WhatsAppCloudAdapter());
  if (!seen.has('dingtalk')) list.push(new DingTalkAdapter());
  if (!seen.has('feishu')) list.push(new FeishuAdapter());
  if (!seen.has('wecom')) list.push(new WeComAdapter());
  if (!seen.has('mattermost')) list.push(new MattermostAdapter());
  if (!seen.has('matrix')) list.push(new MatrixAdapter());
  if (!seen.has('webhook')) list.push(new GenericWebhookAdapter());
  if (!seen.has('bluebubbles')) list.push(new BlueBubblesAdapter());
  if (!seen.has('ntfy')) list.push(new NtfyAdapter());
  if (!seen.has('teams')) list.push(new TeamsAdapter());
  if (!seen.has('google_chat')) list.push(new GoogleChatAdapter());
  if (!seen.has('weixin')) list.push(new WeixinAdapter());
  if (!seen.has('sms')) list.push(new SmsAdapter());
  if (!seen.has('irc')) list.push(new IrcAdapter());
  if (!seen.has('simplex')) list.push(new SimplexAdapter());
  if (!seen.has('homeassistant')) list.push(new HomeAssistantAdapter());
  if (!seen.has('email')) list.push(new EmailAdapter());
  if (!seen.has('signal')) list.push(new SignalAdapter());
  return list;
}
