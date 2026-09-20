/**
 * Skill env-var inventory — the data behind the dashboard's environment
 * variable editor.
 *
 * The editor (`web-dashboard/src/components/EnvVarEditor.tsx`) was written
 * against exactly this shape (`name`, `value`, `isSet`, `requiredBy`,
 * `description`, `isProviderCredential`) and had no producer: the write
 * endpoint existed for skill secrets, but nothing ever reported which vars are
 * wanted, which are set, or which rows are provider credentials. So the panel
 * was unreachable and the credential boundary it draws was unenforced.
 *
 * ## The domain boundary (this is the supersede-or-extend decision)
 *
 * Three dashboard surfaces touch credentials and they do NOT overlap:
 *
 *   - `AdminPanel` / provider setup → **provider** credentials
 *     (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …). Writing one there is what
 *     makes the router see the provider as credentialed.
 *   - `PlatformsPage` / `PlatformConfigSection` → **platform** credentials
 *     (Twilio/SMTP/…), sourced from `PLATFORM_ENV_VARS`.
 *   - **this module** → **skill** env vars: the vars a skill declares it needs,
 *     which are injected into a skill execution and nothing else.
 *
 * The boundary is enforced, not advisory: a provider credential is reported
 * here with `isProviderCredential: true` (so the user understands why the row
 * is locked) and `saveEnvValue` refuses to write it through the skill path.
 * Platform-owned vars are excluded entirely — they are editable in the surface
 * that owns their semantics.
 */

import { loadEnvFile, isEnvVarPersisted, getEnvVarValue } from './secret-capture.js';
import { readHubCatalog } from '../learning/hub-skill-catalog.js';
import { isProviderEnvBlocked } from '../config/provider-env.js';
import { PLATFORM_ENV_VARS } from '../gateway/channel-directory.js';

/** One row of the env-var editor. Structurally the component's `EnvVar`. */
export interface SkillEnvVarRow {
  /** Variable name. */
  name: string;
  /** Masked value when set ('' when unset — a real value never leaves here). */
  value: string;
  /** Whether a non-empty value is persisted or present in the environment. */
  isSet: boolean;
  /** Installed skill that declares this var (absent for a hand-set secret). */
  requiredBy?: string;
  /** Skill description, used as the row's help text. */
  description?: string;
  /** True for provider credentials — shown 🔒 and not editable in this editor. */
  isProviderCredential?: boolean;
}

/** Every env var claimed by a messaging platform (owned by PlatformsPage). */
function platformOwnedVars(): Set<string> {
  const out = new Set<string>();
  for (const vars of Object.values(PLATFORM_ENV_VARS)) {
    for (const v of vars) out.add(v);
  }
  return out;
}

/**
 * Mask a secret for display. Mirrors `redactValue`'s intent (first/last 4) but
 * is deliberately stricter here: the dashboard only ever needs to prove a value
 * EXISTS, and a 4-char prefix of an API key is already meaningful.
 */
function maskValue(value: string): string {
  if (value.length === 0) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 3)}••••${value.slice(-2)}`;
}

export interface SkillEnvInventoryOptions {
  /** Project root to scan for `.agents/skills` (defaults to cwd). */
  projectRoot?: string;
  /** Home dir to scan for `~/.nuvira/skills` (defaults to the real home). */
  home?: string;
}

/**
 * Build the editor's row set:
 *
 *   1. Every var REQUIRED by an installed hub skill (set or not) — these are
 *      the rows a user needs to act on, so an unset one must appear as ❌.
 *   2. Every persisted .env var that is not a provider credential and not
 *      platform-owned — hand-set skill secrets, which would otherwise be
 *      invisible once written.
 *   3. Provider credentials that are present in the file, flagged so the user
 *      sees the boundary instead of silently wondering where the key went.
 *
 * Never throws: a missing skills root or unreadable .env simply contributes
 * nothing, because a broken inventory must not blank the page.
 */
export function readSkillEnvInventory(
  opts: SkillEnvInventoryOptions = {},
): SkillEnvVarRow[] {
  const rows = new Map<string, SkillEnvVarRow>();
  const platformOwned = platformOwnedVars();

  const put = (row: SkillEnvVarRow): void => {
    // First writer wins so a provider-credential flag survives a later skill
    // row for the same name (the skill row carries no flag).
    if (rows.has(row.name)) {
      const existing = rows.get(row.name)!;
      existing.requiredBy ??= row.requiredBy;
      existing.description ??= row.description;
      existing.isProviderCredential ||= row.isProviderCredential;
      return;
    }
    rows.set(row.name, row);
  };

  // ── 1. Declared by installed skills ──────────────────────────────────────
  try {
    const catalog = readHubCatalog(opts.projectRoot ?? process.cwd(), opts.home);
    for (const skill of catalog) {
      for (const name of skill.requiredEnvVars ?? []) {
        const isSet = isEnvVarPersisted(name);
        put({
          name,
          value: isSet ? maskValue(getEnvVarValue(name)) : '',
          isSet,
          requiredBy: skill.name,
          description: skill.description,
          isProviderCredential: isProviderEnvBlocked(name) || undefined,
        });
      }
    }
  } catch {
    // Best-effort — an unreadable catalog contributes nothing.
  }

  // ── 2 + 3. What is actually in the env file ─────────────────────────────
  try {
    for (const [name, rawValue] of Object.entries(loadEnvFile())) {
      if (platformOwned.has(name)) continue; // owned by PlatformsPage
      if (isProviderEnvBlocked(name)) {
        put({
          name,
          value: maskValue(rawValue),
          isSet: rawValue.length > 0,
          description: 'Provider credential — manage this in provider setup, not here.',
          isProviderCredential: true,
        });
        continue;
      }
      // `put` (not an unconditional set) so a skill-declared row keeps its
      // `requiredBy` attribution.
      put({
        name,
        value: maskValue(rawValue),
        isSet: rawValue.length > 0,
      });
    }
  } catch {
    // Best-effort.
  }

  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Can a SKILL actually consume this variable right now?
 *
 * This is what the editor's "🧪 Test" button asks — not "is this API key
 * valid" (which would need a paid provider call per keystroke), but the
 * question the panel can answer truthfully: *will a skill run see this value?*
 * That is exactly the set of conditions `skill-tool` checks before executing,
 * so the verdict matches what execution will really do.
 */
export function probeSkillEnvVar(name: string): { usable: boolean; detail: string } {
  if (isProviderEnvBlocked(name)) {
    return {
      usable: false,
      detail:
        `${name} is a provider credential and is blocked from skill execution by design. ` +
        'Configure it in provider setup — skills never receive it.',
    };
  }
  if (platformOwnedVars().has(name)) {
    return {
      usable: false,
      detail: `${name} is a platform credential — configure it on the Platforms page.`,
    };
  }
  if (!isEnvVarPersisted(name)) {
    return {
      usable: false,
      detail: `${name} is not set. Add a value to make it available to skills.`,
    };
  }
  return {
    usable: true,
    detail: `${name} is set and will be passed to skill executions that require it.`,
  };
}
