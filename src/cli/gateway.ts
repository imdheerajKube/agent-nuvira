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
 * BUFF_WHATSAPP_TOKEN + BUFF_WHATSAPP_PHONE_ID.
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
import { maskSenderId } from '../utils/mask.js';
import { guardRbacAction } from './rbac-guard.js';
import { getCliName } from './commands.js';

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

    // ── contact subcommands (name-centric outbound contacts) ──
    const contact = cmd.command('contact').description('Manage contacts for outbound messaging (name → platform:id resolution)');

    contact
      .command('list')
      .description('List all contacts with status, platform, and ID')
      .option('--pending', 'Show only pending contacts')
      .option('--platform <platform>', 'Filter by platform (telegram, whatsapp, etc.)')
      .action(async (opts) => this.contactList(opts));

    contact
      .command('approve <nameOrId>')
      .description('Approve a contact for outbound messaging')
      .option('--platform <platform>', 'Platform to approve on (auto-detected if omitted)')
      .action(async (nameOrId, opts) => this.contactApprove(nameOrId, opts));

    contact
      .command('reject <nameOrId>')
      .description('Reject a contact (block outbound messages)')
      .option('--platform <platform>', 'Platform to reject on (auto-detected if omitted)')
      .action(async (nameOrId, opts) => this.contactReject(nameOrId, opts));

    contact
      .command('delete <nameOrId>')
      .description('Delete a contact permanently')
      .option('--platform <platform>', 'Platform to delete from (auto-detected if omitted)')
      .action(async (nameOrId, opts) => this.contactDelete(nameOrId, opts));

    contact
      .command('add <name> <platform> <id>')
      .description('Manually add a contact (e.g. buff gateway contact add Anuj telegram 616825477)')
      .option('--phone <number>', 'Optional phone number for flexible lookup')
      .action(async (name, platform, id, opts) => this.contactAdd(name, platform, id, opts));

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
      .action(async (opts) => this.start(Number(opts.port), opts.host, opts.events));    cmd
      .command('stop')
      .description('Stop a running gateway gracefully (SIGTERM — from any terminal)')
      .option('--port <n>', 'Webhook port the gateway is bound to (default 8787)', '8787')
      .action(async (opts) => this.stop(Number(opts.port)));

    cmd
      .command('setup [platform]')
      .description('Interactive setup wizard for a messaging platform (e.g. buff gateway setup telegram)')
      .action(async (platform) => this.setup(platform));

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
      console.log('  I12 sms: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER');
      console.log('  I13 irc: IRC_SERVER (+IRC_PORT/IRC_NICKNAME/IRC_CHANNEL/IRC_USE_TLS/IRC_NICKSERV_PASSWORD)');
      console.log('  I14 simplex: SIMPLEX_WS_URL (local simplex-chat daemon, ws://127.0.0.1:5225)');
      console.log('  I15 homeassistant: HASS_TOKEN (+HASS_URL, defaults to http://homeassistant.local:8123)');
      console.log('');
    }
    const directory = new ChannelDirectory();
    const channels = directory.reachableChannels();
    if (channels.length > 0) {
      console.log('📇 Reachable channels:');
      for (const ch of channels) {
        const mark = ch.reachable ? '✅' : '⬜';
        // Sender/channel ids are masked (privacy) — aliases stay readable.
        console.log(`  ${mark} ${PLATFORM_LABELS[ch.platform]} ${maskSenderId(ch.channelId)} (${ch.aliases.join(', ')})`);
      }
    } else {
      console.log('📇 No channel aliases registered yet. Add one:');
      console.log('  buff gateway alias add <alias> <telegram|discord|slack|whatsapp|whatsapp_cloud|email|signal|dingtalk|feishu|wecom|mattermost|matrix|webhook|bluebubbles|ntfy|teams|google_chat|weixin|sms|irc|simplex|homeassistant> <channelId>');
      console.log('  buff gateway send ops "nightly build done"');
    }
    console.log('');
    if (configured.length > 0) {
      console.log('🚀 Next steps:');
      console.log('  1. Start the gateway:  buff gateway start');
      console.log('  2. Send a test message: buff gateway send <platform>:<chatId> "Hello from agent-nuvira!"');
      console.log('  3. Or set up an alias:  buff gateway alias add myteam ' + configured[0] + ' <your-chat-id>');
      console.log('');
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
    for (const a of adapters) {
      try {
        await a.stop();
      } catch {
        /* best-effort */
      }
    }
    if (!ok) {
      logger.error(`Send to ${ref.platform}:${maskSenderId(ref.channelId)} failed.`);
      logger.info(`  → Check that the platform token is set in ~/.buff/.env and the chat ID is valid.`);
      logger.info(`  → Run '${getCliName()} gateway status' to verify the adapter is configured.`);
      logger.info(`  → The message has been queued for retry (buff gateway delivery).`);
      process.exitCode = 1;
      return;
    }
    logger.success(`Sent to ${target} (${ref.platform}:${maskSenderId(ref.channelId)})`);
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
    logger.success(`Sent ${type} to ${target} (${ref.platform}:${maskSenderId(ref.channelId)})`);
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
    console.log('📮 Delivery ledger (guaranteed delivery with auto-retry)');
    console.log('');
    if (remaining.length === 0) {
      console.log('  (empty — no failed sends recorded)');
      console.log('');
      return;
    }
    for (const e of remaining.slice(0, 20)) {
      const mark = e.status === 'sent' ? '✅' : e.status === 'failed' ? '❌' : '⏳';
      const retry = e.status === 'pending' ? ` retry#${e.attempts} at ${new Date(e.nextAttemptAt).toLocaleTimeString()}` : '';
      console.log(`  ${mark} ${e.platform}:${maskSenderId(e.channelId)} (${e.target}) — ${e.text.slice(0, 60)}${retry}${e.lastError ? ` — ${e.lastError.slice(0, 60)}` : ''}`);
    }
    if (remaining.length > 20) console.log(`  …and ${remaining.length - 20} more`);
    console.log('');
    console.log(`  total: ${pending.length} pending · ${sent.length} sent · ${failed.length} failed (of ${remaining.length} retained)`);
    console.log('  Retries happen automatically while `${getCliName()} gateway start` runs; `--flush` forces a drain now.');
  }

  // ─── alias ────────────────────────────────────────────────────────────────

  private async aliasAdd(alias: string, platform: string, channelId: string): Promise<void> {
    if (!guardRbacAction('gateway.manage')) return;
    const { validateContactId } = await import('../gateway/contacts.js');
    const err = validateContactId(platform as any, channelId);
    if (err) {
      logger.error(err);
      process.exitCode = 1;
      return;
    }
    const directory = new ChannelDirectory();
    try {
      const entry = directory.setAlias(alias, platform as any, channelId);
      logger.success(`Alias '${entry.alias}' → ${PLATFORM_LABELS[entry.platform]} ${maskSenderId(entry.channelId)}`);
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

  // ─── contact ───────────────────────────────────────────────────────────────

  private async contactList(opts: { pending?: boolean; platform?: string }): Promise<void> {
    if (!guardRbacAction('routing.operate')) return;
    const { readGatewayContacts } = await import('../gateway/contacts.js');
    const contacts = readGatewayContacts();
    const filtered = contacts.filter((c) => {
      if (opts.pending && c.status !== 'pending') return false;
      if (opts.platform && c.platform !== opts.platform) return false;
      return true;
    });
    if (filtered.length === 0) {
      logger.info('No contacts found.');
      return;
    }
    console.log(`📇 Contacts (${filtered.length}):`);
    console.log('');
    for (const c of filtered) {
      const status = c.status === 'approved' ? '✅' : c.status === 'pending' ? '⏳' : '🚫';
      const phone = c.phone ? ` · 📱 ${c.phone}` : '';
      const registered = c.registeredAt ? ` · since ${new Date(c.registeredAt).toLocaleDateString()}` : '';
      console.log(`  ${status} ${c.name} — ${c.platform}:${c.id}${phone}${registered}`);
    }
    console.log('');
    const pending = contacts.filter((c) => c.status === 'pending').length;
    if (pending > 0) console.log(`  ${pending} contact(s) pending approval — run '${getCliName()} gateway contact approve <name>'`);
  }

  private async contactApprove(nameOrId: string, opts: { platform?: string }): Promise<void> {
    if (!guardRbacAction('routing.operate')) return;
    const { readGatewayContacts, setContactStatus } = await import('../gateway/contacts.js');
    if (opts.platform) {
      const ok = setContactStatus(opts.platform as never, nameOrId, 'approved');
      if (ok) { logger.success(`✅ Contact '${nameOrId}' approved on ${opts.platform}`); } else { logger.error(`Contact '${nameOrId}' not found on ${opts.platform}`); process.exitCode = 1; }
      return;
    }
    // Auto-detect: find the contact across all platforms
    const contacts = readGatewayContacts();
    const hits = contacts.filter((c) => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id === nameOrId);
    if (hits.length === 0) { logger.error(`Contact '${nameOrId}' not found.`); process.exitCode = 1; return; }
    for (const c of hits) { setContactStatus(c.platform, c.name, 'approved'); }
    logger.success(`✅ Contact '${hits[0].name}' approved on ${hits.map((c) => c.platform).join(', ')}`);
  }

  private async contactReject(nameOrId: string, opts: { platform?: string }): Promise<void> {
    if (!guardRbacAction('routing.operate')) return;
    const { readGatewayContacts, setContactStatus } = await import('../gateway/contacts.js');
    if (opts.platform) {
      const ok = setContactStatus(opts.platform as never, nameOrId, 'rejected');
      if (ok) { logger.success(`🚫 Contact '${nameOrId}' rejected on ${opts.platform}`); } else { logger.error(`Contact '${nameOrId}' not found on ${opts.platform}`); process.exitCode = 1; }
      return;
    }
    const contacts = readGatewayContacts();
    const hits = contacts.filter((c) => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id === nameOrId);
    if (hits.length === 0) { logger.error(`Contact '${nameOrId}' not found.`); process.exitCode = 1; return; }
    for (const c of hits) { setContactStatus(c.platform, c.name, 'rejected'); }
    logger.success(`🚫 Contact '${hits[0].name}' rejected on ${hits.map((c) => c.platform).join(', ')}`);
  }

  private async contactDelete(nameOrId: string, opts: { platform?: string }): Promise<void> {
    if (!guardRbacAction('routing.operate')) return;
    const { removeGatewayContact } = await import('../gateway/contacts.js');
    if (opts.platform) {
      const ok = removeGatewayContact(opts.platform as never, nameOrId);
      if (ok) { logger.success(`🗑️ Contact '${nameOrId}' deleted from ${opts.platform}`); } else { logger.error(`Contact '${nameOrId}' not found on ${opts.platform}`); process.exitCode = 1; }
      return;
    }
    // Delete across all platforms
    let deleted = false;
    for (const p of ['telegram', 'whatsapp', 'whatsapp_cloud', 'email', 'slack', 'discord']) {
      if (removeGatewayContact(p as never, nameOrId)) deleted = true;
    }
    if (deleted) { logger.success(`🗑️ Contact '${nameOrId}' deleted.`); } else { logger.error(`Contact '${nameOrId}' not found.`); process.exitCode = 1; }
  }

  private async contactAdd(name: string, platform: string, id: string, opts: { phone?: string }): Promise<void> {
    if (!guardRbacAction('routing.operate')) return;
    const { upsertGatewayContact } = await import('../gateway/contacts.js');
    const { contact, added } = upsertGatewayContact({ name, platform: platform as never, id, phone: opts.phone, status: 'approved', registeredAt: Date.now() });
    if (added) {
      logger.success(`📇 Contact '${contact.name}' added: ${contact.platform}:${contact.id}${contact.phone ? ' (📱 ' + contact.phone + ')' : ''}`);
    } else {
      logger.info(`📇 Contact '${contact.name}' updated: ${contact.platform}:${contact.id}`);
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

  // ─── setup (Getting Started wizard) ──────────────────────────────────────

  private async setup(platformArg: string | undefined): Promise<void> {
    if (!guardRbacAction('gateway.manage')) return;
    const inquirer = (await import('inquirer')).default;
    const { writeEnvFile, applyEnvToProcess, platformEnvVarMeta } = await import('../gateway/platform-config.js');
    const { PLATFORM_LABELS } = await import('../gateway/channel-directory.js');

    // Platform-specific setup guides.
    const GUIDES: Record<string, {
      name: string;
      steps: string[];
      vars: Array<{ varName: string; prompt: string; secret: boolean }>;
      verify?: (values: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
      postSetup: string[];
    }> = {
      telegram: {
        name: 'Telegram',
        steps: [
          'Open Telegram and search for @BotFather',
          'Send /newbot to BotFather and follow the prompts',
          'Give your bot a name (e.g. "My Agent Bot")',
          'Give your bot a username (must end with "bot", e.g. "my_agent_bot")',
          'BotFather will give you a token — copy it below',
          'Open your bot in Telegram and send it a message (e.g. /start)',
        ],
        vars: platformEnvVarMeta('telegram'),
        verify: async (values) => {
          const token = values.BUFF_TELEGRAM_TOKEN;
          if (!token) return { ok: false, error: 'No token provided.' };
          try {
            const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
            const data = await res.json() as { ok?: boolean; result?: { username?: string } };
            if (data.ok && data.result?.username) {
              return { ok: true };
            }
            return { ok: false, error: `Telegram API rejected the token. Response: ${JSON.stringify(data)}` };
          } catch (err) {
            return { ok: false, error: `Could not reach Telegram API: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
        postSetup: [
          'Start the gateway:  buff gateway start',
          'Open your bot in Telegram and send a message',
          'The agent will reply automatically!',
          'The gateway auto-learns your chat ID from the first message',
          'Optional: add an alias:  buff gateway alias add support telegram <your-chat-id>',
        ],
      },
      discord: {
        name: 'Discord',
        steps: [
          'Go to https://discord.com/developers/applications',
          'Click "New Application" → give it a name → Create',
          'Go to "Bot" in the left sidebar → click "Add Bot"',
          'Under "Token", click "Copy" to copy the bot token',
          'Enable "Message Content Intent" under Privileged Gateway Intents',
          'Invite the bot to your server with the OAuth2 URL generator (bot scope + Send Messages permission)',
        ],
        vars: platformEnvVarMeta('discord'),
        postSetup: [
          'Start the gateway:  buff gateway start',
          'Mention the bot in a Discord channel or send it a DM',
          'The agent will reply automatically!',
        ],
      },
      slack: {
        name: 'Slack',
        steps: [
          'Go to https://api.slack.com/apps',
          'Click "Create New App" → "From scratch"',
          'Add Bot Token Scopes: chat:write, im:read, im:write, channels:history, groups:history',
          'Install the app to your workspace',
          'Copy the Bot User OAuth Token (starts with xoxb-)',
        ],
        vars: platformEnvVarMeta('slack'),
        postSetup: [
          'Start the gateway:  buff gateway start',
          'DM the bot or mention it in a channel',
          'The agent will reply automatically!',
        ],
      },
      email: {
        name: 'Email (SMTP)',
        steps: [
          'You need an SMTP relay (Gmail, SendGrid, Mailgun, etc.)',
          'For Gmail: use smtp.gmail.com:587 with an App Password (not your regular password)',
          'For SendGrid/Mailgun: get SMTP credentials from their dashboard',
        ],
        vars: platformEnvVarMeta('email'),
        postSetup: [
          'Start the gateway:  buff gateway start',
          'Send an email to the configured address',
          'The agent will reply via email!',
        ],
      },
    };

    // If no platform specified, show a picker.
    let platform = platformArg?.toLowerCase();
    if (!platform || !GUIDES[platform]) {
      const choices = Object.entries(GUIDES).map(([key, g]) => ({
        name: `${g.name}${isPlatformConfigured(key as any) ? ' ✅ (already configured)' : ''}`,
        value: key,
      }));
      const { picked } = await inquirer.prompt<{ picked: string }>([{
        type: 'list',
        name: 'picked',
        message: 'Which platform do you want to set up?',
        choices,
      }]);
      platform = picked;
    }

    const guide = GUIDES[platform!];
    if (!guide) {
      logger.error(`Unknown platform '${platform}'. Supported: ${Object.keys(GUIDES).join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log('');
    logger.highlight(`🚀 Getting Started: ${guide.name}`);
    console.log('');

    // Show steps.
    for (let i = 0; i < guide.steps.length; i++) {
      console.log(`  ${i + 1}. ${guide.steps[i]}`);
    }
    console.log('');

    // Prompt for each env var.
    const values: Record<string, string> = {};
    for (const v of guide.vars) {
      const existing = process.env[v.varName] ?? '';
      const { value } = await inquirer.prompt<{ value: string }>([{
        type: v.secret ? 'password' : 'input',
        name: 'value',
        message: `${v.prompt}:`,
        default: existing || undefined,
        mask: v.secret ? '*' : undefined,
      }]);
      if (value.trim()) {
        values[v.varName] = value.trim();
      }
    }

    if (Object.keys(values).length === 0) {
      logger.info('No values entered — nothing was saved.');
      return;
    }

    // Save to ~/.buff/.env.
    const { wrote } = writeEnvFile(values);
    applyEnvToProcess(values);
    console.log('');
    logger.success(`Saved to ~/.buff/.env: ${wrote.join(', ')}`);

    // Verify if the guide has a verify step.
    if (guide.verify) {
      console.log('');
      logger.info('Verifying connection...');
      const result = await guide.verify(values);
      if (result.ok) {
        logger.success('✅ Connection verified — the token is valid!');
      } else {
        logger.warn(`⚠️  Verification failed: ${result.error}`);
        logger.info('You can still proceed — the token may work once the gateway starts.');
      }
    }

    // Show next steps.
    console.log('');
    logger.highlight('📋 Next steps:');
    console.log('');
    for (const step of guide.postSetup) {
      console.log(`  → ${step}`);
    }
    console.log('');
  }

  // ─── start ────────────────────────────────────────────────────────────────

  private async start(port: number, host: string, streamEvents: boolean): Promise<void> {
    const registry = new GatewayRegistry({ streamEvents });
    const adapters: ChannelAdapter[] = createConfiguredAdapters();
    for (const adapter of adapters) registry.register(adapter);

    if (!registry.hasConfiguredAdapter()) {
      logger.warn('No adapters configured — set one or more platform tokens:');
      console.log('');
      console.log('  Telegram:   BUFF_TELEGRAM_TOKEN=your-token   (get from @BotFather on Telegram)');
      console.log('  Discord:    BUFF_DISCORD_BOT_TOKEN=your-token  (from Discord Developer Portal)');
      console.log('  Slack:      BUFF_SLACK_BOT_TOKEN=your-token    (from Slack API → Your Apps)');
      console.log('  WhatsApp:   buff whatsapp pair                  (scan QR code)');
      console.log('  Email:      BUFF_SMTP_HOST + BUFF_SMTP_USER     (any SMTP relay)');
      console.log('  Signal:     BUFF_SIGNAL_ACCOUNT=your-number     (via signal-cli-rest-api)');
      console.log('');
      console.log('  Tokens are saved to ~/.buff/.env — use the dashboard Channels tab or:');
      console.log('    buff config gateway <platform>                  (interactive wizard)');
      console.log('');
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
