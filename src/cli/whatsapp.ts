/**
 * WhatsAppCommand — I8 WhatsApp bridge CLI (Hermes `hermes whatsapp` parity).
 *
 *   buff whatsapp pair              — QR-pair a personal number (Baileys bridge, no paid API)
 *   buff whatsapp pair --phone 91…  — pair by entering an 8-char code on the phone instead
 *   buff whatsapp status            — show the bridge session + pairing state
 *
 * The default `whatsapp` platform is the personal Baileys bridge; the paid
 * Meta Business API stays available as the separate `whatsapp_cloud` platform
 * (`buff gateway send whatsapp_cloud:+1555… …`), exactly like Hermes keeps
 * `whatsapp` and `whatsapp_cloud` as distinct platform entries.
 */

import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { BaileysBridge, isSelfChatEnabled, normalizePairingPhone } from '../gateway/whatsapp/baileys-bridge.js';
import { whatsappSessionDir, hasWhatsAppSession } from '../gateway/whatsapp/session.js';
import { guardRbacAction } from './rbac-guard.js';

export class WhatsAppCommand {
  create(): Command {
    const cmd = new Command('whatsapp')
      .description('WhatsApp bridge (Baileys) — pair a personal number via QR and check status (I8)');

    cmd
      .command('pair')
      .description('Pair WhatsApp (personal number — no Meta Business account, no paid API)')
      .option(
        '--phone <number>',
        'Pair via phone number instead of a QR: enter the 8-char code under WhatsApp → Linked devices → Link with phone number instead (full international format, no +, e.g. 918800663237)',
      )
      .option('--timeout <seconds>', 'Pairing window in seconds', '90')
      .action(async (opts: { phone?: string; timeout?: string }) => {
        // Pairing writes a session under ~/.buff/whatsapp/session — treat it
        // like other secret-material writes (skill.remove-class gate).
        if (!guardRbacAction('skill.remove')) return;
        const dir = whatsappSessionDir();
        const timeoutMs = Math.max(15, parseInt(opts.timeout ?? '90', 10) || 90) * 1000;
        const phone = opts.phone ? normalizePairingPhone(opts.phone) : '';
        if (opts.phone && !phone) {
          logger.error(
            `Invalid phone number '${opts.phone}' — use full international format with country code (no + or spaces), e.g. 918800663237`,
          );
          return;
        }
        if (phone && phone.length === 10) {
          logger.warn(
            `'${phone}' looks like a local number without its country code — WhatsApp needs the full international format (e.g. 91${phone} for India). Proceeding with '${phone}' as-is; re-run with --phone 91${phone} if pairing fails.`,
          );
        }
        if (hasWhatsAppSession(dir)) {
          logger.warn(`A paired session already exists at ${dir} — pairing again will replace it.`);
        }
        const bridge = new BaileysBridge(dir);
        if (phone) {
          logger.info('Pairing by phone number. On the phone with that WhatsApp number:');
          logger.info('  1. WhatsApp → Linked devices → Link a device');
          logger.info('  2. Tap "Link with phone number instead"');
          logger.info('  3. Enter the 8-character code shown below');
        } else {
          logger.info('Scan the QR code below with your phone:');
          logger.info('  WhatsApp → Linked devices → Link a device → scan the QR');
          logger.info('The QR refreshes automatically — scan it within the pairing window.');
        }
        logger.info(`Session will be stored at: ${dir}`);
        const result = await bridge.pair({
          phoneNumber: phone || undefined,
          timeoutMs,
          // Raw payload at debug — some people feed it into external QR tools.
          onQr: (qr) => logger.debug(`QR payload: ${qr}`),
          // The scannable QR must print raw (no logger prefix/redaction) or
          // scanning breaks.
          onQrRendered: (rendered) => console.log(`\n${rendered}\n`),
          onPairingCode: (code) => console.log(`\n🔑 Pairing code: ${code}\n`),
        });
        if (result.ok) {
          logger.success('Paired — the WhatsApp bridge is ready. Run `buff whatsapp status` to confirm.');
        } else {
          logger.error(result.reason);
        }
      });

    cmd
      .command('status')
      .description('Show bridge session path + pairing state')
      .action(() => {
        const bridge = new BaileysBridge();
        logger.info('WhatsApp bridge (Baileys, personal number — I8)');
        logger.info(`  session: ${whatsappSessionDir()}`);
        logger.info(`  paired:  ${bridge.paired ? 'yes' : 'no — run `buff whatsapp pair` to scan a QR'}`);
        logger.info(`  ${bridge.describe()}`);
        logger.info(`  self-chat: ${isSelfChatEnabled() ? 'on (BUFF_WHATSAPP_SELF_CHAT=1 — messages to yourself are processed)' : 'off (drop fromMe echoes; set BUFF_WHATSAPP_SELF_CHAT=1 to enable)'}`);
        logger.info('  cloud:   Meta Business API is a separate platform — `buff gateway status` shows it under whatsapp_cloud.');
      });

    cmd
      .command('contacts')
      .description('List resolvable contacts (mapping file + learned) — connects briefly to learn names from live traffic')
      .option('--timeout <seconds>', 'How long to wait for live contact learning', '5')
      .action(async (opts: { timeout?: string }) => {
        const bridge = new BaileysBridge();
        // File mappings resolve without a connection; live learning is best-effort.
        if (bridge.paired) {
          const waitMs = Math.max(1, parseInt(opts.timeout ?? '5', 10) || 5) * 1000;
          await bridge.connect(() => {});
          try {
            const start = Date.now();
            while (Date.now() - start < waitMs) {
              if (bridge.contactCount > 0) break;
              await new Promise((r) => setTimeout(r, 200));
            }
          } finally {
            await bridge.disconnect();
          }
        }
        const names = bridge.contactNames();
        if (names.length === 0) {
          logger.info('No resolvable contacts yet.');
          logger.info('Map a contact once:  buff whatsapp contact add <Name> <number>  (e.g. Daddy 919876543210)');
          logger.info('Then send by name:    buff gateway send whatsapp:Daddy "message"');
          return;
        }
        logger.info(`${names.length} resolvable contact(s) — send by name: buff gateway send whatsapp:<Name> "message"`);
        for (const c of names) console.log(`  ${c.name} → ${c.jid}`);
        logger.info('Add more with: buff whatsapp contact add <Name> <number>');
        console.log('');
        logger.info('⚠  These are SEND-BY-NAME mappings ONLY — they do NOT let these numbers');
        logger.info('    trigger the agent. To let a number trigger the agent (inbound), add it to');
        logger.info('    the verified list:  buff config gateway allow whatsapp user <number>');
      });

    const contact = cmd.command('contact').description('Manage the WhatsApp contact-name mapping (send by name: buff gateway send whatsapp:<Name> "message")');

    contact
      .command('add <name> <number>')
      .description('Map a display name to a number (E.164, no +): buff whatsapp contact add Daddy 919876543210')
      .action(async (name: string, number: string) => {
        if (!guardRbacAction('skill.remove')) return;
        const bridge = new BaileysBridge();
        if (!bridge.addContact(name, number)) {
          logger.error(`Could not add '${name}' — name and a valid number (digits) are required.`);
          return;
        }
        const digits = number.replace(/\D+/g, '');
        logger.success(`Saved contact '${name}' → ${digits}. Send with: buff gateway send whatsapp:${name} "message"`);
        console.log('');
        logger.info('ℹ  This is a SEND-BY-NAME mapping only — it does NOT let this number trigger');
        logger.info('    the agent when they message you. To grant inbound access (verified list):');
        logger.info(`      buff config gateway allow whatsapp user ${digits}`);
      });

    contact
      .command('remove <name>')
      .description('Remove a mapped contact name')
      .action(async (name: string) => {
        if (!guardRbacAction('skill.remove')) return;
        const bridge = new BaileysBridge();
        if (bridge.removeContact(name)) {
          logger.success(`Removed contact '${name}'.`);
        } else {
          logger.warn(`No mapped contact '${name}' found.`);
        }
      });

    return cmd;
  }
}
