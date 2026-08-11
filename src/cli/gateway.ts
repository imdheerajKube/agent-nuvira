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
  WhatsAppAdapter,
  type ChannelAdapter,
} from '../gateway/adapters.js';
import { guardRbacAction } from './rbac-guard.js';

export class GatewayCommand {
  create(): Command {
    const cmd = new Command('gateway')
      .description('Multi-channel gateway — talk to the agent from Telegram/Discord/Slack/WhatsApp (J1)');

    cmd
      .command('status')
      .description('Show configured adapters and reachable channels')
      .action(() => this.status());

    cmd
      .command('send <target> <text>')
      .description('Send a message to a channel alias or platform:channelId')
      .action(async (target, text) => this.send(target, text));

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
      .command('start')
      .description('Run all configured adapters in the foreground (Ctrl-C to stop)')
      .option('--port <n>', 'Webhook inbound port for Discord/Slack/WhatsApp', '8787')
      .option('--host <ip>', 'Webhook bind address (default 127.0.0.1 — use 0.0.0.0 for a public tunnel)', '127.0.0.1')
      .option('--no-events', 'Do not stream board events to channels', false)
      .action(async (opts) => this.start(Number(opts.port), opts.host, opts.events));

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
    if (configured.length === 0) {
      console.log('No adapters configured. Set one of:');
      console.log('  BUFF_TELEGRAM_TOKEN · BUFF_DISCORD_BOT_TOKEN · BUFF_DISCORD_WEBHOOK_URL');
      console.log('  BUFF_SLACK_BOT_TOKEN · BUFF_SLACK_WEBHOOK_URL · BUFF_WHATSAPP_TOKEN + PHONE_ID');
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
      console.log('  buff gateway alias add <alias> <telegram|discord|slack|whatsapp> <channelId>');
      console.log('  buff gateway send ops "nightly build done"');
    }
  }

  // ─── send ─────────────────────────────────────────────────────────────────

  private async send(target: string, text: string): Promise<void> {
    const registry = new GatewayRegistry({ streamEvents: false });
    for (const adapter of createConfiguredAdapters()) registry.register(adapter);

    const ref = registry.directory.resolve(target);
    if (!ref) {
      logger.error(`Unknown channel target '${target}' — use an alias or platform:channelId`);
      process.exitCode = 1;
      return;
    }
    const ok = await registry.sendToRef(ref, text);
    if (!ok) {
      logger.error(`Send failed — adapter for '${ref.platform}' is not configured (set its env token)`);
      process.exitCode = 1;
      return;
    }
    logger.success(`Sent to ${target} (${ref.platform}:${ref.channelId})`);
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

  // ─── start ────────────────────────────────────────────────────────────────

  private async start(port: number, host: string, streamEvents: boolean): Promise<void> {
    const registry = new GatewayRegistry({ streamEvents });
    const adapters: ChannelAdapter[] = createConfiguredAdapters();
    for (const adapter of adapters) registry.register(adapter);

    if (!registry.hasConfiguredAdapter()) {
      logger.warn('No adapters configured — set BUFF_TELEGRAM_TOKEN, BUFF_DISCORD_*, BUFF_SLACK_*, or BUFF_WHATSAPP_* env vars.');
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
  if (!seen.has('whatsapp')) list.push(new WhatsAppAdapter());
  return list;
}
