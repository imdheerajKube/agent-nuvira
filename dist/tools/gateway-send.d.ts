/**
 * E3g — Gateway message delivery as a TOOL (`src/tools/gateway-send.ts`).
 *
 * Lets the agent (chat / execute / any model-driven loop) deliver a result to
 * ANY gateway channel — WhatsApp by contact name or number, Telegram, Slack,
 * Discord, email, an alias, etc. The user can ask "write a poem and send it
 * to Alex on whatsapp" and the model calls:
 *
 *   gateway_send({ target: "whatsapp:Alex", text: "<the poem>" })
 *
 * For images (e.g. after generate_image), the model calls:
 *
 *   gateway_send({ target: "whatsapp:Alex", text: "", image_path: "/path/to/image.png" })
 *
 * Rides the SAME GatewayRegistry + adapters as `nuvira gateway send` (one
 * delivery path, zero divergence). A failed send is persisted to the delivery
 * ledger for retry while the gateway runs — never silently dropped.
 *
 * Non-interactive: no TTY prompts; the send is attempted immediately. When
 * the transport is unconfigured, the tool reports it back so the model can
 * tell the user what env/session is missing.
 */
import type { ToolContext } from './registry.js';
/**
 * Run the gateway send tool — returns model-feedable text (never throws).
 * The input schema lives in the registry (single source, never hand-kept).
 */
export declare function runGatewaySendTool(args: unknown, ctx: ToolContext): Promise<string>;
//# sourceMappingURL=gateway-send.d.ts.map