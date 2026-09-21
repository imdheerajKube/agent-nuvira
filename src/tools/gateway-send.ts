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

import { readFileSync } from 'fs';
import { extname } from 'path';
import type { ToolContext } from './registry.js';
import { readGatewayContacts, resolveContact } from '../gateway/contacts.js';

/**
 * Detect media type from file extension.
 */
function mediaTypeFromExt(ext: string): 'image' | 'video' | 'audio' | 'document' {
  const e = ext.toLowerCase().replace('.', '');
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(e)) return 'image';
  if (['mp4', 'mov', 'mkv', 'webm'].includes(e)) return 'video';
  if (['mp3', 'm4a', 'ogg', 'wav'].includes(e)) return 'audio';
  return 'document';
}

/**
 * Check if a target matches a pending or rejected contact and return a
 * specific error message. Returns the generic "unknown target" message
 * if the target is not a known contact.
 */
function unknownTargetMessage(target: string): string {
  try {
    const contacts = readGatewayContacts();
    for (const platform of ['telegram', 'whatsapp', 'whatsapp_cloud', 'email', 'slack', 'discord']) {
      const hit = resolveContact(contacts, platform as never, target);
      if (hit) {
        if (hit.status === 'pending') {
          return `gateway_send: ⏳ '${hit.name}' (${platform}:${hit.id}) is registered but pending admin approval. Ask the admin to approve them from the dashboard Contacts tab or run 'nuvira gateway contact approve ${hit.name}'`;
        }
        if (hit.status === 'rejected') {
          return `gateway_send: 🚫 '${hit.name}' (${platform}:${hit.id}) was rejected by the administrator. Contact the admin to request access.`;
        }
      }
    }
  } catch {
    /* contacts module unavailable — fall through */
  }
  return (
    `gateway_send: unknown channel target '${target}'. Use a registered alias ` +
    `(e.g. 'ops') or platform:channelId — e.g. whatsapp:Alex, ` +
    `whatsapp:+15551234567, telegram:123456, slack:C0123, email:team@example.com.`
  );
}

/**
 * Send an image (or media file) through the gateway. Tries the injected
 * live gateway first, then falls back to a fresh registry.
 */
async function sendMediaViaGateway(
  target: string,
  filePath: string,
  caption: string | undefined,
  liveGateway: ToolContext['gateway'] | null,
): Promise<string> {
  let data: Uint8Array;
  try {
    data = readFileSync(filePath) as unknown as Uint8Array;
  } catch (err) {
    return `gateway_send: cannot read image file '${filePath}': ${err instanceof Error ? err.message : String(err)}`;
  }
  if (data.length === 0) {
    return `gateway_send: image file '${filePath}' is empty.`;
  }

  const ext = extname(filePath);
  const type = mediaTypeFromExt(ext);
  const media = {
    type,
    data,
    caption,
    filename: filePath.split('/').pop() ?? filePath,
  };

  if (liveGateway?.sendMedia) {
    const ref = liveGateway.directory.resolve(target);
    if (!ref) {
      return unknownTargetMessage(target);
    }
    const ok = await liveGateway.sendMedia(target, media);
    return ok
      ? `gateway_send: ✅ sent ${type} to ${target} (${ref.platform}:${ref.channelId}) — image delivered.`
      : `gateway_send: ⚠️ media send to ${target} (${ref.platform}:${ref.channelId}) failed — the adapter does not support sendMedia or is not configured.`;
  }

  // Deferred imports: registry/adapters pull the whole gateway; the tools
  // module must stay import-light (STANDING RULE).
  const { GatewayRegistry } = await import('../gateway/registry.js');
  const { createConfiguredAdapters } = await import('../gateway/adapters.js');

  const fresh = new GatewayRegistry({ streamEvents: false });
  const adapters = createConfiguredAdapters();
  for (const adapter of adapters) fresh.register(adapter);

  const ref = fresh.directory.resolve(target);
  if (!ref) {
    return unknownTargetMessage(target);
  }

  const ok = await fresh.sendMediaToRef(ref, media);
  // Disconnect adapters so the process can exit cleanly (one-shot path).
  for (const adapter of adapters) {
    try { await adapter.stop(); } catch { /* best-effort */ }
  }
  if (ok) {
    return `gateway_send: ✅ sent ${type} to ${target} (${ref.platform}:${ref.channelId}) — image delivered.`;
  }
  return (
    `gateway_send: ⚠️ media send to ${target} (${ref.platform}:${ref.channelId}) failed — the adapter ` +
    `does not support media or is not configured (WhatsApp/Telegram/Discord support media). ` +
    `The message was queued in the delivery ledger and will be retried.`
  );
}

/**
 * OUTBOUND AUTHORIZATION (the second gate — see `authorizeOutboundSend`).
 *
 * `allowedUsers` decides who may TRIGGER the agent. This decides who may then
 * direct it to deliver to SOMEONE ELSE. Applied ONLY to gateway-triggered turns
 * (`ctx.gateway.origin` set): a CLI/dashboard turn is the operator at the
 * keyboard and is trusted by construction.
 *
 * Reading the policy is deferred-imported so the tools module stays
 * import-light, and it NEVER throws — a policy read failure must not brick
 * sending; it falls through to the (legacy) inherit behaviour.
 */
async function authorizeGatewaySend(
  origin: { platform: string; channelId: string },
  target: string,
  ctx: ToolContext,
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const { envPolicies, authorizeOutboundSend, normalizeSenderId } = await import('../gateway/registry.js');
    const { ConfigManager } = await import('../config/manager.js');
    type Pol = import('../gateway/channel-directory.js').ChannelPolicy;
    const cfg = new ConfigManager().getAll() as { gateway?: { policies?: Record<string, Pol> } };
    const platform = origin.platform;
    // Same merge order the running gateway uses: env < config.
    const policy: Pol = {
      ...((envPolicies() as Record<string, Pol>)[platform] ?? {}),
      ...((cfg.gateway?.policies?.[platform] as Pol | undefined) ?? {}),
    };
    const ref = ctx.gateway?.directory?.resolve(target) ?? null;
    const originNorm = normalizeSenderId(origin.channelId);
    const ownConversation =
      !!ref &&
      ref.platform === platform &&
      originNorm.length > 0 &&
      normalizeSenderId(ref.channelId) === originNorm;
    const decision = authorizeOutboundSend({
      policy,
      senderId: origin.channelId,
      ownConversation,
    });
    if (!decision.allowed) {
      return { allowed: false, reason: decision.reason ?? 'not authorised to send to others.' };
    }
    // Optional target-approval: the recipient must be an APPROVED contact.
    if (policy.requireApprovedTarget && !ownConversation && ref) {
      const contacts = readGatewayContacts();
      const hit =
        resolveContact(contacts, ref.platform as never, ref.channelId) ??
        resolveContact(contacts, ref.platform as never, target);
      if (!hit || hit.status !== 'approved') {
        return {
          allowed: false,
          reason:
            `'${target}' is not an approved contact, and this platform requires approved recipients ` +
            `(dashboard → Contacts → approve the person, or ask the admin to turn off 'require approved recipients').`,
        };
      }
    }
    return { allowed: true };
  } catch {
    // Policy unavailable — never let an auth-read failure block a legitimate send.
    return { allowed: true };
  }
}

/**
 * Run the gateway send tool — returns model-feedable text (never throws).
 * The input schema lives in the registry (single source, never hand-kept).
 */
export async function runGatewaySendTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { gatewaySendSchema } = await import('./registry.js');
  let target = '';
  let text = '';
  let image_path: string | undefined;
  let caption: string | undefined;
  try {
    const parsed = gatewaySendSchema.parse(args);
    target = parsed.target;
    text = parsed.text;
    image_path = parsed.image_path;
    caption = parsed.caption;
  } catch (err) {
    return `gateway_send: missing/invalid arguments — expected { target, text, image_path? }. ${err instanceof Error ? err.message.split('\n')[0] : ''}`.trim();
  }

  // ── OUTBOUND AUTHORIZATION ── only for gateway-triggered turns (a remote
  // sender asked the agent to message someone else). A CLI/dashboard turn has
  // no origin and is the operator at the keyboard — always allowed.
  const origin = ctx.gateway?.origin;
  if (origin?.platform) {
    const auth = await authorizeGatewaySend(origin, target, ctx);
    if (!auth.allowed) {
      return `gateway_send: 🚫 ${auth.reason ?? 'not authorised to send to others.'}`;
    }
  }

  // Image/media send path: read the file and send via sendMedia.
  if (image_path) {
    // The caption is: explicit caption → text (when text is provided) → undefined
    const effectiveCaption = caption || (text && text !== '—' ? text : undefined);
    return sendMediaViaGateway(target, image_path, effectiveCaption, ctx.gateway ?? null);
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
      return unknownTargetMessage(target);
    }
    // `sendToRef` (not `send`) so the VERIFIED failure reason — e.g. "not a
    // WhatsApp account" — can be reported instead of a generic "unreachable".
    const ok = registry.sendToRef
      ? await registry.sendToRef(ref, text, target)
      : await registry.send(target, text);
    if (ok) {
      return `gateway_send: ✅ sent to ${target} (${ref.platform}:${ref.channelId}) — message delivered.`;
    }
    const why = registry.lastSendError?.(ref);
    return (
      `gateway_send: ⚠️ send to ${target} (${ref.platform}:${ref.channelId}) failed` +
      (why
        ? ` — ${why}`
        : ' — the adapter is not configured or the transport is unreachable') +
      '. The message was queued in the delivery ledger for retry.'
    );
  }

  // Deferred imports: registry/adapters pull the whole gateway; the tools
  // module must stay import-light (STANDING RULE).
  const { GatewayRegistry } = await import('../gateway/registry.js');
  const { createConfiguredAdapters } = await import('../gateway/adapters.js');

  const fresh = new GatewayRegistry({ streamEvents: false });
  for (const adapter of createConfiguredAdapters()) fresh.register(adapter);

  const ref = fresh.directory.resolve(target);
  if (!ref) {
    return unknownTargetMessage(target);
  }

  const ok = await fresh.sendToRef(ref, text, target);
  if (ok) {
    return `gateway_send: ✅ sent to ${target} (${ref.platform}:${ref.channelId}) — message delivered.`;
  }
  return (
    `gateway_send: ⚠️ send to ${target} (${ref.platform}:${ref.channelId}) failed — the adapter is ` +
    `not configured or the transport is unreachable (WhatsApp: is the number paired? ` +
    `Run 'nuvira whatsapp status'). The message was queued in the delivery ledger and will ` +
    `be retried while 'nuvira gateway start' runs.`
  );
}
