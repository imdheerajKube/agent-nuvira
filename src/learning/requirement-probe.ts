/**
 * Requirement pre-flight — what is missing BEFORE a run starts.
 *
 * A capability declares what it needs (`CapabilityRequires`). This probes those
 * declarations against the machine, so the agent can say "this needs `gh` and it
 * is not installed" at the START of a task instead of abandoning it halfway
 * through — the failure mode where the run has already written files and the
 * user has to work out what went wrong.
 *
 * ASYMMETRY ON PURPOSE, and it is the whole honesty of this module:
 *
 *   - A missing BINARY is a FACT. `which`/`where` is the same resolver the shell
 *     uses, so its verdict is authoritative and a binary gap BLOCKS.
 *   - A credential that is not in `process.env` is NOT the same as absent. It may
 *     live in the credential vault, a `gh auth login` profile, an SSH agent, or
 *     an AWS profile file. So a credential gap is reported as "not visible in the
 *     environment" and NEVER blocks on its own.
 *
 * Reporting a credential as definitively missing when it merely is not an env var
 * would be the exact class of false claim this workstream exists to remove, so it
 * is framed as an observation, not a verdict.
 *
 * Everything is derived from the DECLARATION — no phrase list, no guessing.
 */

import { binaryOnPath } from '../utils/binary-probe.js';
import type { CapabilityRequires } from './capability-types.js';

export type RequirementGapKind = 'binary' | 'credential';

export interface RequirementGap {
  kind: RequirementGapKind;
  /** Satisfied when ANY of these is present. */
  anyOf: string[];
  /** One sentence: what to do about it. */
  remedy: string;
}

export interface Readiness {
  /** True when nothing HARD is missing — only binaries can make this false. */
  ready: boolean;
  gaps: RequirementGap[];
  /** Inputs the model must still decide. Never probed — they are not facts. */
  ask: string[];
}

/** The two facts a probe can establish. Injectable so tests need no real PATH. */
export interface RequirementProbe {
  binary: (name: string) => boolean;
  /** True when the named env var is set and non-empty. */
  credential: (name: string) => boolean;
}

/** The real probe: the OS resolver for binaries, `process.env` for credentials. */
export function defaultRequirementProbe(env: NodeJS.ProcessEnv = process.env): RequirementProbe {
  return {
    binary: (name) => binaryOnPath(name),
    credential: (name) => {
      const value = env[name];
      return typeof value === 'string' && value.trim().length > 0;
    },
  };
}

/** Probe a declaration against the machine. */
export function probeRequirements(
  requires: CapabilityRequires,
  probe: RequirementProbe = defaultRequirementProbe(),
): Readiness {
  const gaps: RequirementGap[] = [];

  for (const need of requires.binaries ?? []) {
    if (!need.anyOf.some((bin) => probe.binary(bin))) {
      gaps.push({
        kind: 'binary',
        anyOf: need.anyOf,
        remedy: need.note ?? `install one of: ${need.anyOf.join(', ')}`,
      });
    }
  }

  for (const need of requires.credentials ?? []) {
    if (!need.anyOf.some((name) => probe.credential(name))) {
      gaps.push({
        kind: 'credential',
        anyOf: need.anyOf,
        remedy: need.note ?? `set one of: ${need.anyOf.join(', ')}`,
      });
    }
  }

  return {
    // Only a binary gap is a blocker — see the asymmetry note above.
    ready: !gaps.some((g) => g.kind === 'binary'),
    gaps,
    ask: requires.inputs ?? [],
  };
}

/** One line a model can act on. The two kinds are worded differently on purpose. */
export function describeGap(gap: RequirementGap): string {
  const names = gap.anyOf.join(' or ');
  return gap.kind === 'binary'
    ? `missing executable: ${names} — ${gap.remedy}`
    : `credential not visible in the environment: ${names} — ${gap.remedy}`;
}

/** A short summary of a readiness result, or '' when there is nothing to say. */
export function describeReadiness(readiness: Readiness): string {
  if (readiness.gaps.length === 0) return '';
  return readiness.gaps.map(describeGap).join('; ');
}
