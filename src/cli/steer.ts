/**
 * `nuvira steer` — the CLI surface for mid-run guidance.
 *
 * WHY IT EXISTS. The dashboard is not the only place a long run happens. A
 * detached `nuvira execute` or `nuvira resume` can run for hours in a terminal the
 * user has closed; this command joins that run through the same durable inbox the
 * dashboard uses. It never talks to the executor directly: it writes a change
 * request (or an approval decision), and the run process applies it at its next
 * safe point.
 *
 * Usage:
 *   nuvira steer                        # prompt for guidance on the active run
 *   nuvira steer <runId>                # target a specific run
 *   nuvira steer --text "use Postgres"  # non-interactive
 *   nuvira steer --new-task "build mobile app"
 *   nuvira steer --question "what is left?"
 *   nuvira steer --discuss "why is step 4 blocked?"
 *   nuvira steer --approve G-abc123
 *   nuvira steer --reject G-abc123 --note "not now"
 *   nuvira steer --defer G-abc123
 *   nuvira steer --withdraw G-abc123
 *   nuvira steer --list
 *   nuvira steer --status
 */

import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';

import { ConfigManager } from '../config/manager.js';

import {
  changeProof,
  closeSteeringRun,
  confirmInterpretation,
  createBacklogTaskPrompt,
  decideApproval,
  describeEscalations,
  discussRun,
  getGuidance,
  listBacklog,
  listSteeringRuns,
  projectRun,
  resolveSteeringRun,
  steeringEnabled,
  submitSteeringGuidance,
  triagePending,
} from '../steering/index.js';

interface SteerOptions {
  text?: string;
  question?: string;
  newTask?: string;
  discuss?: string;
  approve?: string;
  reject?: string;
  defer?: string;
  withdraw?: string;
  interpret?: string;
  as?: string;
  note?: string;
  list?: boolean;
  status?: boolean;
  stop?: boolean;
  pause?: boolean;
  close?: string;
  proof?: string;
  json?: boolean;
  cwd?: string;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function statusGlyph(status: string): string {
  switch (status) {
    case 'applied':
      return '✅';
    case 'needs_approval':
      return '🛑';
    case 'accepted':
    case 'scheduled':
      return '🕓';
    case 'rejected':
      return '⛔';
    case 'deferred':
      return '⏸';
    case 'backlog':
      return '🗂';
    case 'answer_only':
      return '💬';
    case 'stale':
    case 'failed':
      return '⚠️';
    case 'withdrawn':
      return '↩️';
    default:
      return '⏳';
  }
}

export class SteerCommand {
  create(): Command {
    const cmd = new Command('steer');
    cmd
      .description(
        'Guide a run that is already in progress. The main task stays locked; guidance is triaged and applied at the next safe point.',
      )
      .argument('[runId]', 'the run to steer (defaults to the newest active run for this directory)')
      .option('--text <text>', 'submit guidance (a change to the current task)')
      .option('--question <text>', 'ask about the run; answered without changing the plan')
      .option('--new-task <text>', 'capture separate work in the run backlog (never the current run)')
      .option('--discuss <question>', 'read-only side conversation about the run')
      .option('--approve <changeId>', 'approve a change that needs a human decision')
      .option('--reject <changeId>', 'reject a change')
      .option('--defer <changeId>', 'defer a change (visible and actionable later)')
      .option('--withdraw <changeId>', 'withdraw your own guidance')
      .option('--interpret <changeId>', 'resolve a low-confidence item: how should it be treated?')
      .option('--as <choice>', 'with --interpret: guidance, new_task or question')
      .option('--note <text>', 'reason for an approve/reject/defer decision')
      .option('--stop', 'stop the run at its next safe point (plan and queue preserved)')
      .option('--pause', 'pause the run at its next safe point (resumable)')
      .option('--close <runId>', 'close a stale run whose lease expired (refuses a live run)')
      .option('--proof <changeId>', 'show the full audit trail and executor directive for one change')
      .option('--list', 'list runs with steering state')
      .option('--status', 'show the guidance queue and plan for the run')
      .option('--json', 'machine-readable output')
      .option('--cwd <dir>', 'directory used to find the active run')
      .action(async (runId: string | undefined, options: SteerOptions) => {
        await this.execute(runId, options);
      });
    return cmd;
  }

  private async execute(runIdArg: string | undefined, options: SteerOptions): Promise<void> {
    // Read the config flag as well as the env override: an operator who enabled
    // steering with `steering.enabled: true` must not find the CLI claiming it is
    // off while the dashboard accepts guidance.
    const enabled = steeringEnabled(new ConfigManager());
    if (!enabled) {
      out(
        'Steering is disabled. Enable it with `nuvira config set steering.enabled true` or NUVIRA_STEERING=1, then start or resume a run.',
      );
      process.exitCode = 1;
      return;
    }

    if (options.list) {
      const runs = listSteeringRuns();
      if (options.json) {
        out(JSON.stringify({ runs }, null, 2));
        return;
      }
      if (runs.length === 0) {
        out('No steering runs yet. Start a run with `nuvira chat` or `nuvira execute`, then use `nuvira steer`.');
        return;
      }
      for (const run of runs) {
        const view = projectRun(run.runId);
        const flags = [
          view.counts.needsApproval > 0 ? `${view.counts.needsApproval} awaiting approval` : '',
          view.counts.open > 0 ? `${view.counts.open} open` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        out(
          `${run.status === 'running' ? '▶' : run.status === 'paused' ? '⏸' : '•'} ${run.runId}  [${run.status}]  ` +
            `plan v${view.plan?.version ?? 0}  ${run.goal.slice(0, 80)}${flags ? `  — ${flags}` : ''}` +
            (run.stale ? `  ⚠ STALE since ${run.staleSince ?? 'an unknown time'}` : ''),
        );
      }
      if (runs.some((run) => run.stale)) {
        out('');
        out(
          'Stale: the lease expired, so no process is applying guidance to that run. ' +
            'Close it with `nuvira steer --close <runId>`, or start that run again to resume it.',
        );
      }
      return;
    }

    // P3.1: an explicit close of a dead run. A live lease is refused above, so
    // this cannot terminate a run that is still working.
    if (options.close !== undefined) {
      const target =
        options.close.trim() ||
        resolveSteeringRun(undefined, options.cwd || process.cwd())?.runId ||
        '';
      if (!target) {
        out('No run to close. Pass `--close <runId>` (see `nuvira steer --list`).');
        process.exitCode = 1;
        return;
      }
      const closed = closeSteeringRun(target, 'user');
      if (!closed.ok) {
        out(`Could not close ${target}: ${closed.error ?? 'unknown error'}`);
        process.exitCode = 1;
        return;
      }
      out(`⏹ Closed stale run ${target}. Its plan and guidance queue are preserved for inspection.`);
      return;
    }

    const run = resolveSteeringRun(runIdArg, options.cwd || process.cwd());
    if (!run) {
      out(
        'No steering run found. Start a run first (the dashboard chat or `nuvira chat`), or pass its run id explicitly.',
      );
      process.exitCode = 1;
      return;
    }

    const decisionAction =
      options.approve !== undefined
        ? 'approve'
        : options.reject !== undefined
          ? 'reject'
          : options.defer !== undefined
            ? 'defer'
            : options.withdraw !== undefined
              ? 'withdraw'
              : null;
    if (decisionAction) {
      const changeId = options.approve ?? options.reject ?? options.defer ?? options.withdraw ?? '';
      const result = decideApproval({
        runId: run.runId,
        changeId,
        action: decisionAction,
        actor: 'cli',
        ...(options.note ? { note: options.note } : {}),
      });
      if (!result.ok) {
        out(`Could not ${decisionAction} ${changeId}: ${result.error ?? 'unknown error'}`);
        process.exitCode = 1;
        return;
      }
      out(`${statusGlyph(result.change?.status ?? '')} ${changeId} → ${result.change?.status ?? decisionAction}`);
      if (result.change?.decision?.reason) out(`   ${result.change.decision.reason}`);
      this.printQueue(run.runId, options.json === true);
      return;
    }

    if (options.interpret) {
      const choice = options.as;
      if (choice !== 'guidance' && choice !== 'new_task' && choice !== 'question') {
        out('Use --as guidance, --as new_task or --as question with --interpret.');
        process.exitCode = 1;
        return;
      }
      const updated = confirmInterpretation({
        runId: run.runId,
        changeId: options.interpret,
        choice,
      });
      if (!updated) {
        out(`No guidance item ${options.interpret} in ${run.runId}.`);
        process.exitCode = 1;
        return;
      }
      if (choice !== 'guidance') await triagePending({ runId: run.runId });
      out(`🧭 ${options.interpret} — interpreted as ${choice.replace(/_/g, ' ')}.`);
      this.printQueue(run.runId, options.json === true);
      return;
    }

    if (options.discuss !== undefined) {
      const answer = await discussRun({ runId: run.runId, question: options.discuss });
      if (options.json) {
        out(JSON.stringify(answer, null, 2));
        return;
      }
      out(answer.answer);
      out('');
      out('This was a read-only answer. Submit the same text with --text to make it a change request.');
      return;
    }

    if (options.status) {
      this.printQueue(run.runId, options.json === true);
      return;
    }

    // P2.1 steer-with-proof: the durable receipt → assessment → decision → plan
    // diff → exact executor directive chain for one change.
    if (options.proof) {
      const change = getGuidance(run.runId, options.proof);
      if (!change) {
        out(`No guidance item ${options.proof} in ${run.runId}.`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        out(JSON.stringify(change, null, 2));
        return;
      }
      for (const line of changeProof(change)) out(line);
      return;
    }

    // First-class control. `stop`/`pause` are control guidance, so the prefilter
    // decides them without a model and the run's safe point reports them before
    // any plan write. This is the CLI twin of the dashboard's Stop/Pause buttons.
    if (options.stop || options.pause) {
      const action = options.stop ? 'stop' : 'pause';
      const result = submitSteeringGuidance({
        runId: run.runId,
        text: action,
        source: 'cli',
        author: 'cli-user',
      });
      if (!result.ok) {
        out(`Could not ${action} the run: ${result.error ?? 'unknown error'}`);
        process.exitCode = 1;
        return;
      }
      // Controls are decidable without a model; settle the record so `--status`
      // reflects what actually happened rather than an in-flight `received`.
      await triagePending({ runId: run.runId });
      out(
        action === 'stop'
          ? `⏹ Stop requested for ${run.runId}. The turn ends at its next safe point; plan and queue are preserved.`
          : `⏸ Pause requested for ${run.runId}. It holds at the next safe point and stays resumable.`,
      );
      this.printQueue(run.runId, options.json === true);
      return;
    }

    const text =
      options.text?.trim() ||
      options.newTask?.trim() ||
      options.question?.trim() ||
      (await this.promptForGuidance(run.runId));
    if (!text) {
      out('No guidance submitted.');
      return;
    }
    const intentHint = options.newTask ? 'new_task' : options.question ? 'question' : 'guidance';
    const result = submitSteeringGuidance({
      runId: run.runId,
      text,
      source: 'cli',
      author: 'cli-user',
      intentHint,
    });
    if (!result.ok) {
      out(`Guidance refused: ${result.error ?? 'unknown error'}`);
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      out(JSON.stringify({ ok: true, change: result.change, deduped: result.deduped ?? false }, null, 2));
      return;
    }
    out(
      `📨 Received ${result.change?.id ?? ''} for ${run.runId}${result.deduped ? ' (duplicate — existing item returned)' : ''}.`,
    );
    out('   It will be assessed, then applied at the run’s next safe point. The main task stays locked.');
    if (intentHint === 'question') {
      const answered = await discussRun({ runId: run.runId, question: text });
      out('');
      out(answered.answer);
    }
    this.printQueue(run.runId, false);
  }

  private printQueue(runId: string, json: boolean): void {
    const view = projectRun(runId);
    if (json) {
      out(JSON.stringify(view, null, 2));
      return;
    }
    const plan = view.plan;
    const done = plan?.steps.filter((s) => s.status === 'done').length ?? 0;
    out('');
    out(`Plan v${plan?.version ?? 0} · ${done}/${plan?.steps.length ?? 0} steps done · run ${view.run?.status ?? 'unknown'}`);
    const open = view.changes.filter(
      (c) => c.status !== 'applied' && c.status !== 'rejected' && c.status !== 'withdrawn',
    );
    if (open.length === 0) {
      out('Guidance queue: empty.');
    } else {
      out('Guidance queue:');
      for (const change of open.slice(-12)) {
        const label = `${statusGlyph(change.status)} ${change.id} [${change.status}] ${change.rawText.replace(/\s+/g, ' ').slice(0, 80)}`;
        out(`  ${label}`);
        if (change.decision?.reason) out(`      ${change.decision.reason}`);
        if (typeof change.triageLatencyMs === 'number') {
          out(`      assessed ${change.triageLatencyMs} ms after receipt`);
        }
        if (change.decision?.escalations?.length) {
          out(`      escalated: ${describeEscalations(change.decision.escalations).join('; ')}`);
        }
        if (change.decision?.approvalEffect) out(`      ${change.decision.approvalEffect}`);
        if (change.planDiff && (change.planDiff.added.length || change.planDiff.updated.length)) {
          out(
            `      plan: +${change.planDiff.added.length} added, ${change.planDiff.updated.length} updated, ` +
              `${change.planDiff.cancelled.length} cancelled${change.planDiff.constraintsAdded.length ? `, ${change.planDiff.constraintsAdded.length} constraint(s)` : ''}`,
          );
        }
        if (change.status === 'needs_approval') {
          out(`      Decide: nuvira steer ${runId} --approve ${change.id}  |  --reject ${change.id}`);
        }
      }
    }
    const backlog = listBacklog(runId);
    if (backlog.length > 0) {
      out('');
      out('Backlog (separate tasks — never absorbed into this run):');
      for (const item of backlog.slice(-8)) {
        const action = createBacklogTaskPrompt(item);
        out(`  🗂 ${item.title} [${item.status}]`);
        out(`      ${action.command}`);
      }
    }
  }

  private async promptForGuidance(runId: string): Promise<string> {
    if (!process.stdin.isTTY) {
      out(`No guidance given. Use --text, --question or --new-task. (run ${runId})`);
      return '';
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      out(`Run ${runId}. The main task is locked; this input is guidance for the active run.`);
      const answer = await rl.question('Guidance> ');
      return answer.trim();
    } finally {
      rl.close();
    }
  }
}
