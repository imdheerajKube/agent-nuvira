/**
 * GatewayCommand — J1 multi-channel gateway CLI.
 *
 *   nuvira gateway status           — show configured adapters + reachable channels
 *   nuvira gateway send <target> <text> — send a message to an alias or platform:channelId
 *   nuvira gateway alias add <alias> <platform> <channelId>   — register an alias
 *   nuvira gateway alias remove <alias>                      — remove an alias
 *   nuvira gateway start [--port N] [--no-events]            — run adapters in the foreground
 *
 * Opt-in adapters: BUFF_TELEGRAM_TOKEN (long-poll) · BUFF_DISCORD_BOT_TOKEN /
 * BUFF_DISCORD_WEBHOOK_URL · BUFF_SLACK_BOT_TOKEN / BUFF_SLACK_WEBHOOK_URL ·
 * BUFF_WHATSAPP_TOKEN + BUFF_WHATSAPP_PHONE_ID.
 */
import { Command } from 'commander';
export declare class GatewayCommand {
    create(): Command;
    private status;
    private send;
    private sendMedia;
    private historyList;
    private historyShow;
    private historyClear;
    private historyPrune;
    private delivery;
    private aliasAdd;
    private aliasRemove;
    private contactList;
    private contactApprove;
    private contactReject;
    private contactDelete;
    private contactAdd;
    private stop;
    private setup;
    /**
     * `gateway start --supervise`: run the gateway as a CHILD process and bring
     * it back if it exits.
     *
     * Why: the gateway runs in the foreground, so a crash (or the machine
     * sleeping, or the launching shell being killed) leaves every channel
     * silently dead — observed live: no gateway process existed while
     * `gateway status` reported the platforms as configured, and senders kept
     * messaging a bridge nobody was listening to. A supervisor turns "the
     * gateway is up" from a hope into an invariant.
     *
     * Backoff: 5s doubling to 60s between restarts. A genuine CRASH LOOP (more
     * than 10 exits in 10 minutes) stops the supervisor and says why, so a bad
     * credential cannot spin forever in the background.
     */
    private supervise;
    private start;
}
//# sourceMappingURL=gateway.d.ts.map