/**
 * WhatsAppCommand — I8 WhatsApp bridge CLI.
 *
 *   nuvira whatsapp pair              — QR-pair a personal number (Baileys bridge, no paid API)
 *   nuvira whatsapp pair --phone 91…  — pair by entering an 8-char code on the phone instead
 *   nuvira whatsapp status            — show the bridge session + pairing state
 *
 * The default `whatsapp` platform is the personal Baileys bridge; the paid
 * Meta Business API stays available as the separate `whatsapp_cloud` platform
 * (`nuvira gateway send whatsapp_cloud:+1555… …`), exactly as
 * `whatsapp` and `whatsapp_cloud` as distinct platform entries.
 */
import { Command } from 'commander';
export declare class WhatsAppCommand {
    create(): Command;
}
//# sourceMappingURL=whatsapp.d.ts.map