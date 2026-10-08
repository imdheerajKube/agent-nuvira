/**
 * Machine facts — what THIS machine is, detected once per run.
 *
 * WHY. The agent reasons about "how do I do X here" constantly, and the honest
 * inputs to that reasoning are facts about the host: which OS and release, which
 * architecture, which shell, and — the one that actually decides the command —
 * WHICH PACKAGE MANAGERS ARE INSTALLED. A model that assumes `apt` on a machine
 * that only has `dnf`, or `brew` on Windows, produces a command that cannot run.
 * The harness should hand it the facts once rather than let it guess per turn.
 *
 * THE ASYMMETRY WITH THE PER-OS COMMAND MAP (Bundle 47). That map declares the
 * command for the two verbs where the OS DETERMINES it and a wrong guess is
 * expensive. This module is the opposite side: it detects what is PRESENT on the
 * host, from the same `which`/`where` resolver the shell uses (`binary-probe`).
 * Presence is a fact, not a declaration, so it cannot drift — and it is the input
 * that lets the model derive a command for anything the map does not cover,
 * instead of the map having to enumerate the world.
 *
 * DETECTED ONCE. The whole result is memoized for the process (OS and installed
 * tools cannot change mid-run), and `binary-probe` is memoized a second time per
 * name, so the ~25 lookups are paid once. `resetMachineFactsCache()` exists for
 * test isolation.
 *
 * INPUTS ARE INJECTABLE. A test can pass a platform and a fake `binary` probe;
 * the real call uses `process.platform`, `process.env` and `binaryOnPath`.
 */

import * as os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

import { binaryOnPath } from '../utils/binary-probe.js';
import type { Capability } from './capability-types.js';

/** The OS vocabulary shared with the per-OS command map. */
export type NormalizedOs = 'windows' | 'macos' | 'linux' | 'other';

export interface MachineFacts {
  /** When the facts were detected (ms epoch). */
  detectedAt: number;
  /** Raw `process.platform` (win32 | darwin | linux | …). */
  platform: NodeJS.Platform;
  /** Normalized OS name. */
  os: NormalizedOs;
  /** Human label: "Windows 10.0.22631", "macOS (Darwin 23.5.0)", "Ubuntu 22.04". */
  osName: string;
  /** Linux distro id from /etc/os-release (e.g. "ubuntu"), else null. */
  distro: string | null;
  /** `process.arch` (x64 | arm64 | …). */
  arch: string;
  /** Full shell path, when the environment declares one. */
  shell: string | null;
  /** Shell's short name (zsh | bash | powershell | cmd). */
  shellName: string | null;
  /** Package managers/toolchain binaries actually present, in preference order. */
  packageManagers: string[];
}

/**
 * The catalog we probe, grouped by ecosystem. Not a per-OS mapping — a union,
 * probed for presence on whatever host this is, because presence is the fact.
 * The ORDER decides suggestion order: the OS-native managers first, then the
 * JS/Python/build ecosystems.
 */
const NATIVE_BY_OS: Record<NormalizedOs, string[]> = {
  windows: ['winget', 'choco', 'scoop'],
  macos: ['brew', 'port'],
  linux: ['apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'snap', 'flatpak'],
  other: [],
};
const ECOSYSTEM_MANAGERS = [
  // JS
  'bun', 'pnpm', 'yarn', 'npm',
  // Python
  'uv', 'poetry', 'pip3', 'pip',
  // Build / language
  'cargo', 'go', 'gem', 'composer', 'dotnet',
];

/** Options for a deterministic test (the real call passes none). */
export interface MachineFactsProbe {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  binary?: (name: string) => boolean;
}

let cached: MachineFacts | null = null;

/** Clear the memo (test isolation). */
export function resetMachineFactsCache(): void {
  cached = null;
}

/** Best-effort Linux distro from /etc/os-release. Never throws. */
function readLinuxDistro(): { id: string | null; pretty: string | null } {
  try {
    if (!existsSync('/etc/os-release')) return { id: null, pretty: null };
    const text = readFileSync('/etc/os-release', 'utf-8');
    const id = /^ID="?([^"\n]+)"?/m.exec(text)?.[1]?.trim() ?? null;
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text)?.[1]?.trim() ?? null;
    return { id, pretty };
  } catch {
    return { id: null, pretty: null };
  }
}

function osLabel(platform: NodeJS.Platform): { os: NormalizedOs; osName: string; distro: string | null } {
  if (platform === 'win32') return { os: 'windows', osName: `Windows ${os.release()}`, distro: null };
  if (platform === 'darwin') return { os: 'macos', osName: `macOS (Darwin ${os.release()})`, distro: null };
  if (platform === 'linux') {
    const d = readLinuxDistro();
    return { os: 'linux', osName: d.pretty ?? `Linux ${os.release()}`, distro: d.id };
  }
  return { os: 'other', osName: `${os.type()} ${os.release()}`, distro: null };
}

function resolveShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { shell: string | null; shellName: string | null } {
  const shellPath = platform === 'win32'
    ? env.ComSpec ?? env.COMSPEC ?? null
    : env.SHELL ?? null;
  if (!shellPath) return { shell: null, shellName: null };
  // Split on BOTH separators: a Windows path must basename correctly even when
  // this code runs on POSIX (the platform is injectable, and `dirname`/`basename`
  // follow the HOST's rules, not the injected platform's).
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath;
  return { shell: shellPath, shellName: base.replace(/\.exe$/i, '') };
}

/**
 * Detect this machine's facts. Memoized for the process when called with no
 * overrides (the real path); an override call (a test) always computes fresh.
 */
export function detectMachineFacts(probe: MachineFactsProbe = {}): MachineFacts {
  if (!probe.platform && !probe.binary && !probe.env && cached) return cached;

  const platform = probe.platform ?? process.platform;
  const env = probe.env ?? process.env;
  const isBinary = probe.binary ?? binaryOnPath;
  const { os: osNameKey, osName, distro } = osLabel(platform);
  const { shell, shellName } = resolveShell(platform, env);

  const ordered = [...NATIVE_BY_OS[osNameKey], ...ECOSYSTEM_MANAGERS];
  const seen = new Set<string>();
  const packageManagers: string[] = [];
  for (const name of ordered) {
    if (seen.has(name)) continue;
    seen.add(name);
    try {
      if (isBinary(name)) packageManagers.push(name);
    } catch {
      // A probe failure is "unknown", and unknown is not "present".
    }
  }

  const facts: MachineFacts = {
    detectedAt: Date.now(),
    platform,
    os: osNameKey,
    osName,
    distro,
    arch: os.arch(),
    shell,
    shellName,
    packageManagers,
  };
  if (!probe.platform && !probe.binary && !probe.env) cached = facts;
  return facts;
}

/** One bounded line the model reads — the machine, stated, not assumed. */
export function buildMachineFactsBlock(facts: MachineFacts = detectMachineFacts()): string {
  const present = facts.packageManagers.length > 0 ? facts.packageManagers.join(', ') : '(none detected)';
  return [
    '',
    '## This machine',
    `OS: ${facts.osName} · arch ${facts.arch} · shell ${facts.shellName ?? 'unknown'}`,
    `Package managers / toolchains present: ${present}`,
    'Choose commands for THIS machine from these facts. A tool not listed is not installed — do not assume one, and do not hardcode the OS it "usually" is.',
  ].join('\n');
}

/**
 * The machine facts as a discoverable capability, so the SAME facts the prompt
 * carries are reachable through a capability search (and so readiness can reason
 * about what is present). Read-only, no requirements, no grant.
 */
export function machineFactsCapability(facts: MachineFacts = detectMachineFacts()): Capability {
  const pms = facts.packageManagers;
  return {
    id: 'action:machine-facts',
    kind: 'action',
    ref: 'machine-facts',
    name: 'This machine',
    oneLiner: `${facts.osName} · arch ${facts.arch} · shell ${facts.shellName ?? 'unknown'} · present: ${pms.length > 0 ? pms.join(', ') : 'none detected'}`,
    effectClass: 'read',
    reversible: true,
    requires: {},
    tags: ['machine', 'environment', 'os', 'platform', 'arch', facts.os, facts.arch, ...pms],
  };
}
