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
export interface InterruptState {
    /** Whether global interrupt is active */
    globalInterrupt: boolean;
    /** Per-task interrupts */
    taskInterrupts: Map<string, boolean>;
    /** Interrupt history */
    history: InterruptEvent[];
    /** Timestamp of last interrupt */
    lastInterruptAt?: number;
}
export interface InterruptEvent {
    id: string;
    taskId?: string;
    type: 'global' | 'task';
    reason: string;
    timestamp: number;
    source: string;
}
export declare class InterruptManager extends EventEmitter {
    private state;
    /**
     * Trigger a global interrupt — stops all running operations.
     */
    interruptGlobal(reason: string, source?: string): InterruptEvent;
    /**
     * Interrupt a specific task.
     */
    interruptTask(taskId: string, reason: string, source?: string): InterruptEvent;
    /**
     * Check if a specific task should be interrupted.
     */
    isInterrupted(taskId?: string): boolean;
    /**
     * Clear a task interrupt (after handling).
     */
    clearTaskInterrupt(taskId: string): void;
    /**
     * Clear global interrupt.
     */
    clearGlobal(): void;
    /**
     * Get current state.
     */
    getState(): InterruptState;
    /**
     * Get interrupt history.
     */
    getHistory(limit?: number): InterruptEvent[];
}
export declare function getInterruptManager(): InterruptManager;
export declare function resetInterruptManager(): void;
//# sourceMappingURL=interrupt-tool.d.ts.map