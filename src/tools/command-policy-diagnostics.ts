/**
 * Diagnostics for the USER command policy — what `nuvira doctor` reports.
 *
 * WHY THIS EXISTS. A policy file can be syntactically valid and still do
 * nothing the user expects:
 *
 *   - `allow: ["git push"]` still ASKS, because `allow` cannot silence a
 *     built-in floor command (the entry is valid, its effect is not "no ask");
 *   - an entry duplicated across lists is silently outranked;
 *   - `allow: ["git push"]` next to `deny: ["git"]` never applies — the broader
 *     deny wins;
 *   - `allow: ["npm"]` turns the ask off for EVERY npm subcommand, including
 *     `npm publish`;
 *   - a non-string / blank / multi-line entry is dropped by the reader.
 *
 * None of those are errors the classifier can report per command — by the time
 * a command is classified the entry is simply absent. Doctor is where the user
 * finds out before an autonomous turn discovers it for them.
 *
 * This module imports BOTH the policy reader and the classifier, so it must stay
 * OUT of `command-policy.ts` (which the classifier imports): that would be a
 * cycle. It is the only place that needs both sides.
 */

import { readFileSync } from 'node:fs';
import {
  commandPolicyFile,
  commandPolicyStatus,
  matchCommandPolicy,
  normalizeCommandForPolicy,
  type CommandPolicy,
  type CommandPolicyKind,
} from './command-policy.js';
import { describeDenial } from './run-terminal.js';

export type PolicyDiagnosticLevel = 'pass' | 'warn' | 'fail';

export interface PolicyFinding {
  level: PolicyDiagnosticLevel;
  message: string;
  detail?: string;
  fix?: string;
}

export interface CommandPolicyDiagnosis {
  file: string;
  exists: boolean;
  level: PolicyDiagnosticLevel;
  /** One line for doctor's `message`. */
  summary: string;
  findings: PolicyFinding[];
  policy: CommandPolicy;
}

/**
 * Bare interpreters/runners whose `allow` entry covers far more than the user
 * is picturing. Keyed by the command token, valued with the concrete risk.
 */
const BROAD_ALLOW: Record<string, string> = {
  npm: 'including `npm publish`',
  npx: 'including any package it downloads and runs',
  yarn: 'including `yarn publish`',
  pnpm: 'including `pnpm publish`',
  node: 'including any script you point it at',
  python: 'including any script you point it at',
  python3: 'including any script you point it at',
  pip: 'including `pip install` from any index',
  git: 'including `git status`, but a floor command such as `git push` still asks',
  docker: 'including `docker push` and `docker compose down -v`',
  kubectl: 'including `kubectl delete`',
  aws: 'including any AWS mutation',
  gcloud: 'including any GCP mutation',
  terraform: 'including `terraform apply`',
  make: 'including whatever the Makefile runs',
  cargo: 'including `cargo publish`',
  go: 'including `go run` of any file',
  bash: 'including any script; prefer the actual command',
  sh: 'including any script; prefer the actual command',
  zsh: 'including any script; prefer the actual command',
};

/** Entries the reader would drop — detected from the RAW file, not the cleaned policy. */
function ignoredEntryFindings(file: string): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return findings; // the parse failure is already a finding
  }
  for (const kind of ['allow', 'approve', 'deny'] as const) {
    const list = raw[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      findings.push({
        level: 'warn',
        message: `"${kind}" is not an array — the whole list is ignored.`,
        fix: `Rewrite the file with "nuvira config policy ${kind} \\"<command>\\"".`,
      });
      continue;
    }
    for (const entry of list) {
      if (typeof entry !== 'string' || !normalizeCommandForPolicy(entry) || normalizeCommandForPolicy(entry).length > 200) {
        findings.push({
          level: 'warn',
          message: `An entry in "${kind}" is ignored (${JSON.stringify(entry)}) — it cannot match any command.`,
          fix: 'Remove it, then add a real command prefix with `nuvira config policy`.',
        });
      }
    }
  }
  return findings;
}

export function diagnoseCommandPolicy(): CommandPolicyDiagnosis {
  const file = commandPolicyFile();
  const status = commandPolicyStatus();
  const findings: PolicyFinding[] = [];

  if (!status.exists) {
    return {
      file,
      exists: false,
      level: 'pass',
      summary: 'No user overrides — the built-in floor applies',
      policy: status.policy,
      findings: [
        {
          level: 'pass',
          message: 'No policy file. Every command is classified by the built-in floor.',
          detail: file,
          fix: 'Override a command with `nuvira config policy allow|approve|deny "<command>"`, or the dashboard Command Policy page.',
        },
      ],
    };
  }

  if (status.error) {
    return {
      file,
      exists: true,
      level: 'fail',
      summary: 'Policy file is unreadable — the built-in floor applies',
      policy: status.policy,
      findings: [
        {
          level: 'fail',
          message: `The file does not parse: ${status.error}`,
          detail: `${file} is ignored until it parses. It never silently becomes permissive.`,
          fix: 'Fix the JSON, or run `nuvira config policy clear --yes` to go back to the defaults.',
        },
      ],
    };
  }

  const policy = status.policy;
  findings.push(...ignoredEntryFindings(file));

  // A prefix in more than one list is valid JSON but only ONE can ever apply.
  const byPrefix = new Map<string, CommandPolicyKind[]>();
  for (const kind of ['deny', 'approve', 'allow'] as const) {
    for (const prefix of policy[kind]) {
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), kind]);
    }
  }
  for (const [prefix, kinds] of byPrefix) {
    if (kinds.length > 1) {
      findings.push({
        level: 'warn',
        message: `"${prefix}" appears in ${kinds.join(' and ')} — only "${kinds[0]}" can ever apply.`,
        fix: `Remove it from all but one list: nuvira config policy remove "${prefix}", then add it to the one you want.`,
      });
    }
  }

  // A permission shadowed by a broader deny never takes effect.
  for (const kind of ['allow', 'approve'] as const) {
    for (const prefix of policy[kind]) {
      const match = matchCommandPolicy(prefix);
      if (match?.kind === 'deny' && match.prefix !== prefix) {
        findings.push({
          level: 'warn',
          message: `${kind} "${prefix}" is shadowed by deny "${match.prefix}" — the deny wins for every command the two both match.`,
          fix: `Narrow the deny, or remove "${prefix}" from ${kind}.`,
        });
      }
    }
  }

  // `allow` on a floor command is the most common misunderstanding: it still asks.
  for (const prefix of policy.allow) {
    const rule = describeDenial(prefix);
    if (rule) {
      findings.push({
        level: 'warn',
        message: `allow "${prefix}" still ASKS once — the built-in floor refuses it (${rule}).`,
        detail: '`allow` cannot make a floor command silent. The entry is not broken; its effect is just weaker than "no ask".',
        fix: `Use approve if that is what you meant: nuvira config policy approve "${prefix}".`,
      });
    }
  }

  // A one-token allow entry is a wide grant — say what it actually covers.
  for (const prefix of policy.allow) {
    if (prefix.includes(' ')) continue;
    const risk = BROAD_ALLOW[prefix];
    if (risk) {
      findings.push({
        level: 'warn',
        message: `allow "${prefix}" covers every ${prefix} subcommand, ${risk}.`,
        fix: `Narrow it to the exact commands you use (e.g. allow "npm run build"), and remove the broad entry.`,
      });
    }
  }

  const counts = `${policy.allow.length} allow / ${policy.approve.length} approve / ${policy.deny.length} deny`;
  const warns = findings.filter((f) => f.level === 'warn').length;
  const level: PolicyDiagnosticLevel = warns > 0 ? 'warn' : 'pass';

  if (findings.length === 0) {
    findings.push({
      level: 'pass',
      message: `Valid policy: ${counts}.`,
      detail: 'Every entry can take effect; no entry is shadowed or silently ignored.',
    });
  }

  return {
    file,
    exists: true,
    level,
    summary:
      warns > 0
        ? `${counts} — ${warns} entr${warns === 1 ? 'y' : 'ies'} may not do what you expect`
        : `${counts} — valid, no shadowed or ignored entries`,
    findings,
    policy,
  };
}
