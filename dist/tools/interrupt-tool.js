/**
 * Interrupt Tool — Global interrupt for all agent operations.
 *
 * Hermes equivalent: interrupt.py (113 lines)
 *
 * Provides:
 * - Global interrupt flag that propagates to all running tools
 * - Per-task interrupt with graceful shutdown
 * - Interrupt history tracking
 */
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
// ─── Interrupt Manager ────────────────────────────────────────────────────
export class InterruptManager extends EventEmitter {
    state = {
        globalInterrupt: false,
        taskInterrupts: new Map(),
        history: [],
    };
    /**
     * Trigger a global interrupt — stops all running operations.
     */
    interruptGlobal(reason, source = 'user') {
        const event = {
            id: `interrupt-${Date.now()}`,
            type: 'global',
            reason,
            timestamp: Date.now(),
            source,
        };
        this.state.globalInterrupt = true;
        this.state.lastInterruptAt = Date.now();
        this.state.history.push(event);
        logger.warn(`[interrupt] GLOBAL interrupt triggered: ${reason}`);
        this.emit('interrupt:global', event);
        return event;
    }
    /**
     * Interrupt a specific task.
     */
    interruptTask(taskId, reason, source = 'user') {
        const event = {
            id: `interrupt-${taskId}-${Date.now()}`,
            taskId,
            type: 'task',
            reason,
            timestamp: Date.now(),
            source,
        };
        this.state.taskInterrupts.set(taskId, true);
        this.state.lastInterruptAt = Date.now();
        this.state.history.push(event);
        logger.warn(`[interrupt] Task ${taskId} interrupted: ${reason}`);
        this.emit('interrupt:task', event);
        return event;
    }
    /**
     * Check if a specific task should be interrupted.
     */
    isInterrupted(taskId) {
        if (this.state.globalInterrupt)
            return true;
        if (taskId && this.state.taskInterrupts.get(taskId))
            return true;
        return false;
    }
    /**
     * Clear a task interrupt (after handling).
     */
    clearTaskInterrupt(taskId) {
        this.state.taskInterrupts.delete(taskId);
    }
    /**
     * Clear global interrupt.
     */
    clearGlobal() {
        this.state.globalInterrupt = false;
        logger.info('[interrupt] Global interrupt cleared');
    }
    /**
     * Get current state.
     */
    getState() {
        return { ...this.state, taskInterrupts: new Map(this.state.taskInterrupts) };
    }
    /**
     * Get interrupt history.
     */
    getHistory(limit = 50) {
        return this.state.history.slice(-limit);
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _interruptManager = null;
export function getInterruptManager() {
    if (!_interruptManager)
        _interruptManager = new InterruptManager();
    return _interruptManager;
}
export function resetInterruptManager() {
    _interruptManager = null;
}
//# sourceMappingURL=interrupt-tool.js.map