/**
 * Release credentials as a TOOL (`src/tools/credentials-tool.ts`).
 *
 * The `publish` tool can only release if a GitHub token and an npm token are
 * already reachable. Until now the only ways to supply them were an environment
 * export (gone at the next login) or the interactive `nuvira publish` prompts
 * (which a tool call may never trigger). This tool lets the agent STORE them,
 * so "release this" works on the next run without the user re-exporting
 * anything.
 *
 * Contract (same as the publish tool):
 * - NEVER throws — every failure comes back as text the model can act on.
 * - Never echoes a secret: results carry only {@link maskSecret} shapes.
 * - `store` takes the value from the USER. The model must ask via `ask_user`;
 *   inventing or guessing a token would write a wrong credential that fails
 *   later, in a place far from the mistake.
 */

import {
  RELEASE_CREDENTIAL_KEYS,
  CredentialStore,
  forgetReleaseCredential,
  isReleaseCredentialKey,
  releaseCredentialStatus,
  storeReleaseCredential,
} from '../agents/credential-store.js';
import type { ToolContext } from './registry.js';

/** Human-readable names, so the tool result explains the consequence. */
const KEY_HELP: Record<string, string> = {
  [RELEASE_CREDENTIAL_KEYS.gitToken]: 'GitHub token used for the HTTPS push',
  [RELEASE_CREDENTIAL_KEYS.gitUsername]: 'GitHub username paired with the token',
  [RELEASE_CREDENTIAL_KEYS.npmToken]: 'npm automation token used for `npm publish`',
  [RELEASE_CREDENTIAL_KEYS.npmRegistry]: 'alternative npm registry',
};

/** The `status` action: what exists, where it came from, and what is missing. */
function statusText(): string {
  const status = releaseCredentialStatus();
  const lines: string[] = ['🔑 Release credentials'];
  lines.push(`   Store: ${status.storePath}`);
  for (const row of status.rows) {
    const mark = row.set ? '✅' : '❌';
    const shape = row.masked ? ` ${row.masked}` : '';
    const origin = row.set ? ` (from ${row.origin})` : '';
    lines.push(`   ${mark} ${row.key}${shape}${origin}`);
  }
  lines.push(`   📡 git remote: ${status.git.remoteUrl || 'not configured'}`);
  lines.push(`   📦 npm registry: ${status.npm.registry}`);

  if (status.git.canPush && status.npm.canPublish) {
    lines.push('   ✅ A release can run (git push and npm publish are both credentialed).');
  } else {
    lines.push('   ⚠️  A release would be incomplete:');
    if (!status.git.canPush) {
      lines.push(`      • no git credentials — store ${RELEASE_CREDENTIAL_KEYS.gitToken} (or configure an SSH key)`);
    }
    if (!status.npm.canPublish) {
      lines.push(`      • no npm token — store ${RELEASE_CREDENTIAL_KEYS.npmToken}`);
    }
    lines.push('      Ask the user for the missing value via ask_user, then call this tool again with action=store.');
  }
  return lines.join('\n');
}

/**
 * Run the credentials tool.
 * `action` defaults to `status` in the schema, so a bare call reports only.
 */
export async function runCredentialsTool(args: unknown, _ctx: ToolContext): Promise<string> {
  const { credentialsToolSchema } = await import('./registry.js');
  const { action, key, value } = credentialsToolSchema.parse(args);

  if (action === 'status') {
    return statusText();
  }

  // `verify` checks EVERY credential, so it takes no key — it must be handled
  // before the key requirement below, or a bare `verify` would be rejected for
  // missing an argument it never needed.
  if (action === 'verify') {
    const store = new CredentialStore();
    store.initialize();
    if (!store.canPush && !store.canPublish) {
      return '❌ No credentials to verify. Ask the user for a token, then store it.';
    }
    const result = await store.verify();
    const line = (label: string, probe: { checked: boolean; ok: boolean; detail: string }): string => {
      if (probe.checked && probe.ok) return `✅ ${label}: ${probe.detail}`;
      // Unchecked is INCONCLUSIVE (offline), not a verdict on the token.
      if (probe.checked) return `❌ ${label}: ${probe.detail}`;
      return `⚠️  ${label}: ${probe.detail}`;
    };
    return ['🔍 Credential check', `   ${line('git', result.git)}`, `   ${line('npm', result.npm)}`].join('\n');
  }

  // ── store / forget both need a known key ────────────────────────────────
  const name = String(key ?? '').trim();
  if (!name) {
    return [
      `❌ action=${action} needs a key.`,
      `   One of: ${Object.keys(KEY_HELP).join(', ')}`,
    ].join('\n');
  }
  if (!isReleaseCredentialKey(name)) {
    return [
      `❌ '${name}' is not a release credential this tool stores.`,
      `   One of: ${Object.keys(KEY_HELP).join(', ')}`,
    ].join('\n');
  }

  if (action === 'forget') {
    const result = forgetReleaseCredential(name);
    if (!result.success) {
      return `❌ Could not delete ${name} (${result.reason ?? 'unknown error'}).`;
    }
    return result.removed
      ? `✅ Removed ${name} from ${result.path}.`
      : `ℹ️  ${name} was not stored — nothing to remove.`;
  }

  // ── store ───────────────────────────────────────────────────────────────
  const raw = String(value ?? '').trim();
  if (!raw) {
    return [
      `❌ action=store needs a value for ${name}.`,
      '   Ask the user for it via ask_user — never invent or guess a token.',
    ].join('\n');
  }

  const stored = storeReleaseCredential(name, raw);
  if (!stored.success) {
    return `❌ Could not store ${name} (${stored.reason ?? 'unknown error'}).`;
  }
  // Deliberately does NOT echo the value — only its masked shape.
  return [
    `✅ Stored ${name} (${KEY_HELP[name]}) in ${stored.path}.`,
    '   It is now available to the publish pipeline without an environment export.',
  ].join('\n');
}
