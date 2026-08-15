/**
 * E3g — Gateway message delivery as a TOOL (`src/tools/gateway-send.ts`).
 *
 * Lets the agent (chat / execute / any model-driven loop) deliver a result to
 * ANY gateway channel — WhatsApp by contact name or number, Telegram, Slack,
 * Discord, email, an alias, etc. The user can ask "write a poem and send it
 * to Daddy on whatsapp" and the model calls:
 *
 *   gateway_send({ target: "whatsapp:Daddy", text: "<the poem>" })
 *
 * Rides the SAME GatewayRegistry + adapters as `buff gateway send` (one
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
export async function runGatewaySendTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { gatewaySendSchema } = await import('./registry.js');
  let target = '';
  let text = '';
  try {
    const parsed = gatewaySendSchema.parse(args);
    target = parsed.target;
    text = parsed.text;
  } catch (err) {
    return `gateway_send: missing/invalid arguments — expected { target, text }. ${err instanceof Error ? err.message.split('\n')[0] : ''}`.trim();
  }

  // Reuse the LIVE gateway when one is injected (a gateway-triggered chat
  // answer): its adapters are already connected, so sending does NOT open a
  // second WhatsApp/Telegram connection (a fresh registry would stall on
  // WhatsApp's single-session handshake). CLI chat/execute (no injected
  // gateway) builds its own registry as before.
  const registry = ctx.gateway ?? null;
  if (registry) {
    const ref = registry.directory.resolve(target);
    if (!ref) {
      return (
        `gateway_send: unknown channel target '${target}'. Use a registered alias ` +
        `(e.g. 'ops') or platform:channelId — e.g. whatsapp:Daddy, ` +
        `whatsapp:+15551234567, telegram:123456, slack:C0123, email:team@example.com.`
      );
    }
    const ok = await registry.send(target, text);
    return ok
      ? `gateway_send: ✅ sent to ${target} (${ref.platform}:${ref.channelId}) — message delivered.`
      : `gateway_send: ⚠️ send to ${target} (${ref.platform}:${ref.channelId}) failed — the adapter is not configured or the transport is unreachable. The message was queued in the delivery ledger for retry.`;
  }

  // Deferred imports: registry/adapters pull the whole gateway; the tools
  // module must stay import-light (STANDING RULE).
  const { GatewayRegistry } = await import('../gateway/registry.js');
  const { createConfiguredAdapters } = await import('../gateway/adapters.js');

  const fresh = new GatewayRegistry({ streamEvents: false });
  for (const adapter of createConfiguredAdapters()) fresh.register(adapter);

  const ref = fresh.directory.resolve(target);
  if (!ref) {
    return (
      `gateway_send: unknown channel target '${target}'. Use a registered alias ` +
      `(e.g. 'ops') or platform:channelId — e.g. whatsapp:Daddy, ` +
      `whatsapp:+15551234567, telegram:123456, slack:C0123, email:team@example.com.`
    );
  }

  const ok = await fresh.sendToRef(ref, text, target);
  if (ok) {
    return `gateway_send: ✅ sent to ${target} (${ref.platform}:${ref.channelId}) — message delivered.`;
  }
  return (
    `gateway_send: ⚠️ send to ${target} (${ref.platform}:${ref.channelId}) failed — the adapter is ` +
    `not configured or the transport is unreachable (WhatsApp: is the number paired? ` +
    `Run 'buff whatsapp status'). The message was queued in the delivery ledger and will ` +
    `be retried while 'buff gateway start' runs.`
  );
}
