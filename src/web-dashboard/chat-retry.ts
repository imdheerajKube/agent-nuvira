/**
 * Dashboard chat retries — the GUI twin of the gateway's deferred retry loop.
 *
 * WHY THIS EXISTS. A failed turn in the dashboard used to be a dead end: the
 * bubble said a model problem had happened, and the only way forward was for the
 * user to wait and re-send the same message themselves. The gateway already
 * keeps the promise it makes ("Reply *yes* and I will keep trying"); a chat
 * console that does not is a worse product on the surface where the user is
 * most likely to be watching.
 *
 * The queue is the SAME persisted store the gateway uses (`deferred-task.ts`),
 * scoped by platform: dashboard tasks carry `platform: 'dashboard'` and the
 * drains are ownership-filtered, so two processes can never fight over one
 * ask (the gateway would otherwise pick up a dashboard session id and try to
 * send it to a messaging platform).
 *
 * DELIVERY. A dashboard retry runs in the server process and pushes its result
 * to the browser over the persistent `/api/sse` channel, so the answer appears
 * in the open conversation without a refresh. It is ALSO appended to the
 * session's own history, so closing the tab — or coming back tomorrow — still
 * shows the answer that was promised. Both, deliberately: a push that is only
 * visible while the tab is open would break the promise for anyone who walked
 * away, which is the normal case for a quota wait.
 */

import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';
import {
  abandonedLine,
  acceptedLine,
  cancelTasksFor,
  confirmTask,
  deferTask,
  dueTasks,
  expiredTasks,
  getPendingTask,
  isRetryAcceptance,
  isRetryDecline,
  removeDeferredTask,
  retryingLine,
  updateDeferredTask,
  type DeferredTask,
} from '../learning/deferred-task.js';
import {
  markFailoverAttempts,
  modelBreadthReport,
  renderModelBreadthReport,
  type ModelBreadthReport,
} from '../learning/resilient-call.js';

/** The platform every dashboard task is filed under. */
export const DASHBOARD_PLATFORM = 'dashboard';

/** One turn's outcome, as much of it as the broker needs. */
export interface ChatRetryTurnResult {
  ok: boolean;
  content?: string;
  generationFailed?: boolean;
}

/**
 * What the browser is told when a retry runs BEHIND the request that started it.
 *
 * Only these kinds are broadcast. A `yes`/`stop` reply is answered by the HTTP
 * response to the tab that sent it, so broadcasting that line too would render
 * the same confirmation twice in the acting tab. A background retry has no
 * response to ride on — it happens minutes later, to a connection that has long
 * since closed — so this channel exists precisely for the cases HTTP cannot
 * cover.
 */
export interface ChatRetryEvent {
  sessionId: string;
  kind: 'answer' | 'failed' | 'abandoned';
  /** The bubble to render (a completed retry, a fresh failure report, or a stop). */
  content: string;
  /** How many attempts have run, for the "attempt N" framing. */
  attempts?: number;
  taskId?: string;
}

export interface ChatRetryDeps {
  /**
   * Run one turn for a session — the console's own `answer()`, called with
   * history writing DISABLED (the console's `recordTurn: false`). This broker
   * owns the thread for a retry: the ask is already recorded from the attempt
   * that failed, and the outcome is written once by `publish`.
   */
  answer: (sessionId: string, text: string) => Promise<ChatRetryTurnResult>;
  /** Publish an update to the browser (SSE). Must never throw. */
  notify?: (event: ChatRetryEvent) => void;
  /**
   * Append a completed exchange to the session history so a reload keeps it.
   * `user` is null when the ask is already in the history (the retry case).
   */
  persistTurn?: (sessionId: string, user: string | null, assistant: string) => void;
  /** The failover report builder — injectable so tests need no routing state. */
  breadth?: (mark: number, configManager?: ConfigManager) => ModelBreadthReport;
  /** Marks the failover log before a turn; injectable for tests. */
  markAttempts?: () => number;
  /** Is this session mid-turn? A retry waits rather than colliding. */
  isBusy?: (sessionId: string) => boolean;
  configManager?: ConfigManager;
  now?: () => number;
}

/**
 * The dashboard half of the retry loop.
 *
 * Deliberately NOT a global: one per server process, constructed with the
 * server's own console + SSE broadcaster so tests can drive it with fakes.
 */
export class ChatRetryBroker {
  constructor(private readonly deps: ChatRetryDeps) {}

  /**
   * A turn failed: queue the ask so the offer the user is about to read is
   * actually enforced, and return the report to show.
   *
   * Returns undefined when there is nothing concrete to report — in which case
   * NO offer was made, so nothing may be queued either. That symmetry is the
   * whole point: queueing without showing the offer would retry silently, and
   * showing the offer without queueing is the bug this class exists to fix.
   *
   * `mark` MUST be the failover-log mark taken BEFORE the turn (see the gateway's
   * `attemptMark`): the report is "what was tried during this turn", and asking
   * for the mark here would read it after the attempts had already landed —
   * an empty "0 models" report that silently drops the offer AND the queue
   * entry. Omitted only by callers that have no turn of their own to attribute.
   */
  onFailure(sessionId: string, text: string, mark?: number): string | undefined {
    try {
      const report = (this.deps.breadth ?? modelBreadthReport)(mark ?? this.mark(), this.deps.configManager);
      const rendered = renderModelBreadthReport(report, { task: text });
      if (!rendered) return undefined;
      deferTask({
        platform: DASHBOARD_PLATFORM,
        channelId: sessionId,
        text,
        kind: 'chat',
        ...(report.nextFreeInMs !== undefined ? { nextFreeInMs: report.nextFreeInMs } : {}),
        lastError: rendered.split('\n')[0] ?? '',
      });
      return rendered;
    } catch (err) {
      // A queue write must never cost the user the failure reply they are owed.
      logger.warn(`dashboard: could not queue the failed turn for retry: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Resolve a message against a pending retry offer.
   *
   * Returns the reply to send INSTEAD of running a new turn, or null to let the
   * message be handled normally. Failing open (null) is the invariant: a message
   * that is not clearly yes/no is never swallowed, and the queued task simply
   * keeps its place.
   */
  consumeAnswer(sessionId: string, text: string): string | null {
    const task = getPendingTask(DASHBOARD_PLATFORM, sessionId);
    if (!task) return null;

    // Both branches are delivered by the ROUTE's own HTTP response (which sends
    // this line back as the turn's content) and recorded in history here, so the
    // thread stays coherent on a reload. No broadcast: the acting tab already
    // renders the response, and pushing it too would show it twice.
    if (isRetryDecline(text)) {
      const cancelled = cancelTasksFor(DASHBOARD_PLATFORM, sessionId);
      logger.info(`dashboard: retry offer declined — ${cancelled} queued task(s) cancelled`);
      const line = "👍 Okay — I've stopped retrying that. Ask me anything else whenever you're ready.";
      this.persist(sessionId, text, line);
      return line;
    }

    if (!isRetryAcceptance(text)) return null;

    const confirmed = confirmTask(task.id) ?? task;
    const line = acceptedLine(confirmed);
    logger.info(
      `dashboard: retry offer accepted (attempt ${confirmed.attempts}, next in ${Math.max(0, confirmed.notBefore - this.now())}ms)`,
    );
    this.persist(sessionId, text, line);
    return line;
  }

  /** The live task for a session, for status surfaces. */
  pending(sessionId: string): DeferredTask | undefined {
    return getPendingTask(DASHBOARD_PLATFORM, sessionId);
  }

  /**
   * Run every dashboard retry whose wait is over, and report the ones that ran
   * out of road.
   *
   * Serialized by the caller (one tick at a time) and skips a busy session — a
   * retry that collided with a live turn would be rejected by the console
   * anyway, and losing the task would be worse than waiting one tick.
   */
  async drain(): Promise<void> {
    for (const task of expiredTasks(this.now(), ownsDashboard)) {
      removeDeferredTask(task.id);
      this.publish({
        sessionId: task.channelId,
        kind: 'abandoned',
        content: abandonedLine(task),
        attempts: task.attempts,
        taskId: task.id,
      });
    }

    for (const task of dueTasks(this.now(), ownsDashboard)) {
      await this.runOne(task);
    }
  }

  /** Run one queued ask: re-run the turn and report what happened. */
  private async runOne(task: DeferredTask): Promise<void> {
    const sessionId = task.channelId;
    if (this.deps.isBusy?.(sessionId)) return; // try again next tick — nothing lost
    const attempt = task.attempts + 1;
    updateDeferredTask(task.id, { status: 'running', attempts: attempt, lastAttemptAt: this.now() });

    // The header explains an answer that arrives unprompted — the ask itself may
    // be hours old, and without it the bubble reads as a non-sequitur.
    const startLine = retryingLine({ ...task, attempts: attempt });
    logger.info(`dashboard: retrying failed turn (attempt ${attempt}) for session ${sessionId}`);

    // Marked BEFORE the re-run for the same reason as the first attempt: a
    // retry that fails again must report the models THIS attempt called.
    const mark = this.mark();
    let result: ChatRetryTurnResult;
    try {
      result = await this.deps.answer(sessionId, task.text);
    } catch (err) {
      logger.warn(`dashboard: deferred retry threw: ${err instanceof Error ? err.message : String(err)}`);
      updateDeferredTask(task.id, { status: 'pending', notBefore: this.now() + 60_000 });
      return;
    }

    if (result.generationFailed) {
      // Still down. Queue it again with whatever the fresh report now says, and
      // tell the browser so the reader is not left wondering.
      const report = this.onFailure(sessionId, task.text, mark);
      const body = report
        ? `${startLine}\n\n${report}`
        : `${startLine}\n\n😔 Still no model available — I'll keep checking.`;
      this.publish({ sessionId, kind: 'failed', content: body, attempts: attempt, taskId: task.id });
      return;
    }

    const content = (result.content ?? '').trim() || '(the agent produced no text — try rephrasing)';
    removeDeferredTask(task.id);
    this.publish({
      sessionId,
      kind: 'answer',
      content: `${startLine}\n\n${content}`,
      attempts: attempt,
      taskId: task.id,
    });
  }

  /**
   * Push to the browser AND record in history — both, deliberately.
   *
   * The push only exists while a tab is open; the promise the user accepted was
   * to "keep checking and let you know", and a quota wait routinely outlives the
   * tab. History is what makes the result survive that.
   *
   * The retry turn runs with `recordTurn: false` (see `ChatRetryDeps.answer`), so
   * this is the ONLY writer for a retry outcome — exactly one bubble, carrying
   * the "Trying again now" header that explains why it appeared unprompted.
   */
  private publish(event: ChatRetryEvent): void {
    this.persist(event.sessionId, null, event.content);
    try {
      this.deps.notify?.(event);
    } catch {
      /* the browser picks it up from history on the next load */
    }
  }

  /** Best-effort history write — a convenience, never a blocker. */
  private persist(sessionId: string, user: string | null, assistant: string): void {
    try {
      this.deps.persistTurn?.(sessionId, user, assistant);
    } catch {
      /* ignore */
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private mark(): number {
    return (this.deps.markAttempts ?? markFailoverAttempts)();
  }
}

/** Only the dashboard's own tasks — the gateway owns every other platform. */
function ownsDashboard(task: DeferredTask): boolean {
  return task.platform === DASHBOARD_PLATFORM;
}
