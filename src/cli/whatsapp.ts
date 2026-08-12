/**
 * WhatsAppCommand — I8 WhatsApp bridge CLI (Hermes `hermes whatsapp` parity).
 *
 *   buff whatsapp pair    — QR-pair a personal number (Baileys bridge, no paid API)
 *   buff whatsapp status  — show the bridge session + pairing state
 *
 * The default `whatsapp` platform is the personal Baileys bridge; the paid
 * Meta Business API stays available as the separate `whatsapp_cloud` platform
 * (`buff gateway send whatsapp_cloud:+1555… …`), exactly like Hermes keeps
 * `whatsapp` and `whatsapp_cloud` as distinct platform entries.
 */

import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { BaileysBridge } from '../gateway/whatsapp/baileys-bridge.js';
import { whatsappSessionDir, hasWhatsAppSession } from '../gateway/whatsapp/session.js';
import { guardRbacAction } from './rbac-guard.js';

export class WhatsAppCommand {
  create(): Command {
    const cmd = new Command('whatsapp')
      .description('WhatsApp bridge (Baileys) — pair a personal number via QR and check status (I8)');

    cmd
      .command('pair')
      .description('Pair WhatsApp via QR code (personal number — no Meta Business account, no paid API)')
      .option('--timeout <seconds>', 'Pairing window in seconds', '90')
      .action(async (opts: { timeout?: string }) => {
        // Pairing writes a session under ~/.buff/whatsapp/session — treat it
        // like other secret-material writes (skill.remove-class gate).
        if (!guardRbacAction('skill.remove')) return;
        const dir = whatsappSessionDir();
        const timeoutMs = Math.max(15, parseInt(opts.timeout ?? '90', 10) || 90) * 1000;
        if (hasWhatsAppSession(dir)) {
          logger.warn(`A paired session already exists at ${dir} — pairing again will replace it.`);
        }
        const bridge = new BaileysBridge(dir);
        logger.info('Scan the QR code with your phone: WhatsApp → Linked devices → Link a device.');
        logger.info(`Session will be stored at: ${dir}`);
        const result = await bridge.pair(
          (qr) => logger.info(`QR payload: ${qr}`),
          timeoutMs,
        );
        if (result.ok) {
          logger.success('✅ Paired — the WhatsApp bridge is ready. Run `buff whatsapp status` to confirm.');
        } else {
          logger.error(`❌ ${result.reason}`);
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
        logger.info('  cloud:   Meta Business API is a separate platform — `buff gateway status` shows it under whatsapp_cloud.');
      });

    return cmd;
  }
}
