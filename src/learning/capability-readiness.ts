/**
 * Capability readiness — the dashboard's one view of what the agent can DO here.
 *
 * This is the read-model behind `GET /api/capabilities`. It answers the question
 * a user actually has before asking the agent for something ("will this work on
 * my machine?") by probing the curated high-level verbs' declared requirements
 * against the host:
 *
 *   - each verb's READINESS (a missing executable blocks; a credential that is
 *     not an env var is reported but never blocks — see requirement-probe.ts);
 *   - the MISSING EXECUTABLES aggregated across the verbs, so the same `gh` is
 *     one row naming every verb that needs it rather than nine;
 *   - the per-OS command, where the OS genuinely decides it (`onThisMachine`).
 *
 * It is the SAME `actionCapabilities()` the capability search serves and the SAME
 * `probeRequirements` the `tool_search` pre-flight runs, so the dashboard cannot
 * disagree with what a run actually sees. Live session grants are served by the
 * existing `/api/session-grants` (one source), so this module stays about
 * capability, not consent.
 *
 * No phrase lists, no guessing: everything is derived from the declarations.
 */

import { actionCapabilities } from '../tools/capability-registry.js';
import { probeRequirements, describeGap } from './requirement-probe.js';
import type { CapabilityRequires, PlatformCommand, PlatformKey } from './capability-types.js';

/** One curated verb as the dashboard shows it. */
export interface CapabilityReadinessRow {
  id: string;
  ref: string;
  name: string;
  does: string;
  effect: string;
  reversible: boolean;
  undo?: string;
  grantable?: string;
  requires?: CapabilityRequires;
  /** True when nothing HARD is missing (only a binary gap can make this false). */
  ready: boolean;
  /** Human lines: an executable that is missing, or a credential not in the env. */
  gaps: string[];
  /** Inputs the model must still decide (never probed — not facts). */
  ask: string[];
  /** The command for the machine this server runs on, where the OS decides it. */
  onThisMachine?: PlatformCommand;
  /** Every declared per-OS command, where the OS genuinely decides it. */
  platforms?: Partial<Record<PlatformKey, PlatformCommand>>;
}

/** An executable the curated verbs need that is not on PATH. */
export interface MissingExecutable {
  /** The verbs (refs) that need it. */
  forRefs: string[];
  anyOf: string[];
  remedy: string;
}

export interface CapabilityReadiness {
  verbs: CapabilityReadinessRow[];
  missingExecutables: MissingExecutable[];
  readyCount: number;
  blockedCount: number;
}

/**
 * Build the readiness view. `platform` is injectable so a test can prove the
 * per-OS resolution without the host's real platform.
 */
export function capabilityReadiness(platform: string = process.platform): CapabilityReadiness {
  const verbs: CapabilityReadinessRow[] = [];
  const missing = new Map<string, MissingExecutable>();

  for (const cap of actionCapabilities()) {
    const requires =
      cap.requires && Object.keys(cap.requires).length > 0 ? cap.requires : undefined;
    const readiness = requires
      ? probeRequirements(requires)
      : { ready: true, gaps: [] as ReturnType<typeof probeRequirements>['gaps'], ask: [] as string[] };

    // Aggregate the executable gaps: the same `gh` is one row naming every verb
    // that needs it, not one row per verb.
    for (const gap of readiness.gaps) {
      if (gap.kind !== 'binary') continue;
      const key = gap.anyOf.join('|');
      const existing = missing.get(key) ?? { forRefs: [], anyOf: gap.anyOf, remedy: gap.remedy };
      if (!existing.forRefs.includes(cap.ref)) existing.forRefs.push(cap.ref);
      missing.set(key, existing);
    }

    const onThisMachine = cap.platforms ? cap.platforms[platform as PlatformKey] : undefined;
    verbs.push({
      id: cap.id,
      ref: cap.ref,
      name: cap.name,
      does: cap.oneLiner,
      effect: cap.effectClass,
      reversible: cap.reversible,
      ...(cap.reversibleHow ? { undo: cap.reversibleHow } : {}),
      ...(cap.grantCategory ? { grantable: cap.grantCategory } : {}),
      ...(requires ? { requires } : {}),
      ready: readiness.ready,
      gaps: readiness.gaps.map(describeGap),
      ask: readiness.ask,
      ...(onThisMachine ? { onThisMachine } : {}),
      ...(cap.platforms ? { platforms: cap.platforms } : {}),
    });
  }

  const readyCount = verbs.filter((v) => v.ready).length;
  return {
    verbs,
    missingExecutables: [...missing.values()],
    readyCount,
    blockedCount: verbs.length - readyCount,
  };
}
