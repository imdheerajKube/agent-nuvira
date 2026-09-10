/**
 * SessionExtraction — Extract facts from buffered turns at session end.
 *
 * Distills conversation turns into durable facts, patterns, and lessons.
 * Uses rules + optional LLM for extraction.
 *
 * Features:
 * - Rule-based extraction (no LLM required)
 * - LLM-enhanced extraction (optional)
 * - Pattern detection
 * - Lesson extraction
 * - Confidence scoring
 */
import { type MemoryStore } from '../tools/memory-tools.js';
interface ExtractedFact {
    content: string;
    type: 'fact' | 'preference' | 'lesson' | 'observation' | 'pattern';
    confidence: number;
    source: string;
    tags: string[];
}
interface ExtractionResult {
    facts: ExtractedFact[];
    patterns: string[];
    lessons: string[];
    statistics: {
        turnsProcessed: number;
        factsExtracted: number;
        patternsDetected: number;
        lessonsLearned: number;
    };
}
export declare class SessionExtractionManager {
    private memoryStore;
    private bufferedTurns;
    private maxBufferedTurns;
    constructor(memoryStore?: MemoryStore);
    /**
     * Buffer a conversation turn.
     */
    bufferTurn(userText: string, assistantText: string): void;
    /**
     * Extract facts from buffered turns at session end.
     */
    extractAtSessionEnd(): Promise<ExtractionResult>;
    /**
     * Extract facts from a single turn.
     */
    private extractFromTurn;
    /**
     * Extract preference from user text.
     */
    private extractPreference;
    /**
     * Extract project fact from conversation.
     */
    private extractProjectFact;
    /**
     * Extract lesson from assistant text.
     */
    private extractLesson;
    /**
     * Check if this is a repeated action.
     */
    private isRepeatedAction;
    /**
     * Extract pattern from turn.
     */
    private extractPattern;
    /**
     * Extract topic from text.
     */
    private extractTopic;
    /**
     * Extract observation from text.
     */
    private extractObservation;
    /**
     * Detect cross-turn patterns.
     */
    private detectCrossTurnPatterns;
    /**
     * Get buffered turn count.
     */
    getBufferedTurnCount(): number;
    /**
     * Clear buffer.
     */
    clearBuffer(): void;
}
export declare function getSessionExtractionManager(): SessionExtractionManager;
export {};
//# sourceMappingURL=session-extraction.d.ts.map