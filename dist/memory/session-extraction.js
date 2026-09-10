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
import { getMemoryStore } from '../tools/memory-tools.js';
// ─── Session Extraction Manager ─────────────────────────────────────────────
export class SessionExtractionManager {
    memoryStore;
    bufferedTurns = [];
    maxBufferedTurns = 50;
    constructor(memoryStore) {
        this.memoryStore = memoryStore || getMemoryStore();
    }
    /**
     * Buffer a conversation turn.
     */
    bufferTurn(userText, assistantText) {
        this.bufferedTurns.push({
            userText,
            assistantText,
            timestamp: Date.now(),
        });
        // Keep buffer bounded
        if (this.bufferedTurns.length > this.maxBufferedTurns) {
            this.bufferedTurns = this.bufferedTurns.slice(-this.maxBufferedTurns);
        }
    }
    /**
     * Extract facts from buffered turns at session end.
     */
    async extractAtSessionEnd() {
        const turns = [...this.bufferedTurns];
        this.bufferedTurns = [];
        const facts = [];
        const patterns = [];
        const lessons = [];
        // Rule-based extraction
        for (const turn of turns) {
            const extracted = this.extractFromTurn(turn);
            facts.push(...extracted.facts);
            patterns.push(...extracted.patterns);
            lessons.push(...extracted.lessons);
        }
        // Detect cross-turn patterns
        const crossTurnPatterns = this.detectCrossTurnPatterns(turns);
        patterns.push(...crossTurnPatterns);
        // Store extracted facts
        for (const fact of facts) {
            this.memoryStore.add({
                content: fact.content,
                type: fact.type,
                tags: fact.tags,
                source: fact.source,
            });
        }
        return {
            facts,
            patterns,
            lessons,
            statistics: {
                turnsProcessed: turns.length,
                factsExtracted: facts.length,
                patternsDetected: patterns.length,
                lessonsLearned: lessons.length,
            },
        };
    }
    /**
     * Extract facts from a single turn.
     */
    extractFromTurn(turn) {
        const facts = [];
        const patterns = [];
        const lessons = [];
        const userText = turn.userText.toLowerCase();
        const assistantText = turn.assistantText.toLowerCase();
        // Extract preferences
        if (userText.includes('prefer') || userText.includes('like') || userText.includes('want')) {
            facts.push({
                content: this.extractPreference(turn.userText),
                type: 'preference',
                confidence: 0.8,
                source: 'user-statement',
                tags: ['preference', 'user'],
            });
        }
        // Extract facts about the project
        if (userText.includes('project') || userText.includes('code') || userText.includes('file')) {
            const fact = this.extractProjectFact(turn.userText, turn.assistantText);
            if (fact) {
                facts.push(fact);
            }
        }
        // Extract lessons from errors
        if (assistantText.includes('error') || assistantText.includes('failed') || assistantText.includes('fix')) {
            const lesson = this.extractLesson(turn.assistantText);
            if (lesson) {
                lessons.push(lesson);
                facts.push({
                    content: lesson,
                    type: 'lesson',
                    confidence: 0.9,
                    source: 'error-resolution',
                    tags: ['lesson', 'error', 'fix'],
                });
            }
        }
        // Extract patterns from repeated actions
        if (this.isRepeatedAction(turn)) {
            patterns.push(this.extractPattern(turn));
        }
        // Extract observations about the environment
        if (userText.includes('environment') || userText.includes('setup') || userText.includes('config')) {
            facts.push({
                content: this.extractObservation(turn.userText),
                type: 'observation',
                confidence: 0.7,
                source: 'environment',
                tags: ['observation', 'environment'],
            });
        }
        return {
            facts,
            patterns,
            lessons,
            statistics: {
                turnsProcessed: 1,
                factsExtracted: facts.length,
                patternsDetected: patterns.length,
                lessonsLearned: lessons.length,
            },
        };
    }
    /**
     * Extract preference from user text.
     */
    extractPreference(text) {
        // Simple extraction - find preference statement
        const patterns = [
            /(?:prefer|like|want|need)\s+(.+?)(?:\.|$)/i,
            /(?:please|kindly)\s+(.+?)(?:\.|$)/i,
            /(?:don't|do not)\s+(?:want|like)\s+(.+?)(?:\.|$)/i,
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                return `User preference: ${match[1].trim()}`;
            }
        }
        return `User stated: ${text.slice(0, 200)}`;
    }
    /**
     * Extract project fact from conversation.
     */
    extractProjectFact(userText, assistantText) {
        // Look for factual statements about the project
        const patterns = [
            /(?:this project|the codebase|our app)\s+(?:is|uses|has|runs)\s+(.+?)(?:\.|$)/i,
            /(?:we|I)\s+(?:use|are using|have)\s+(.+?)(?:\s+for|\s+to|\s+in|\s+on|\s+\.)/i,
        ];
        for (const pattern of patterns) {
            const match = userText.match(pattern);
            if (match) {
                return {
                    content: `Project fact: ${match[1].trim()}`,
                    type: 'fact',
                    confidence: 0.8,
                    source: 'user-statement',
                    tags: ['fact', 'project'],
                };
            }
        }
        return null;
    }
    /**
     * Extract lesson from assistant text.
     */
    extractLesson(text) {
        // Look for lesson patterns
        const patterns = [
            /(?:the issue|the problem|the error)\s+(?:was|is)\s+(.+?)(?:\.|$)/i,
            /(?:to fix|to resolve|to solve)\s+(?:this|the)\s+(?:issue|problem|error),?\s+(.+?)(?:\.|$)/i,
            /(?:the solution|the fix)\s+(?:is|was)\s+(.+?)(?:\.|$)/i,
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                return `Lesson learned: ${match[1].trim()}`;
            }
        }
        return null;
    }
    /**
     * Check if this is a repeated action.
     */
    isRepeatedAction(turn) {
        // Simple heuristic - check for similar patterns
        const recentTurns = this.bufferedTurns.slice(-5);
        const userWords = turn.userText.toLowerCase().split(/\s+/);
        let similarCount = 0;
        for (const recent of recentTurns) {
            const recentWords = recent.userText.toLowerCase().split(/\s+/);
            const overlap = userWords.filter((w) => recentWords.includes(w)).length;
            if (overlap > userWords.length * 0.5) {
                similarCount++;
            }
        }
        return similarCount >= 2;
    }
    /**
     * Extract pattern from turn.
     */
    extractPattern(turn) {
        return `Repeated pattern: User asked about ${this.extractTopic(turn.userText)}`;
    }
    /**
     * Extract topic from text.
     */
    extractTopic(text) {
        // Simple topic extraction
        const words = text.toLowerCase().split(/\s+/);
        const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'i', 'you', 'we', 'they', 'it']);
        const meaningfulWords = words.filter((w) => !stopWords.has(w) && w.length > 3);
        return meaningfulWords.slice(0, 3).join(' ') || 'unknown topic';
    }
    /**
     * Extract observation from text.
     */
    extractObservation(text) {
        return `Observation: ${text.slice(0, 200)}`;
    }
    /**
     * Detect cross-turn patterns.
     */
    detectCrossTurnPatterns(turns) {
        const patterns = [];
        // Detect topic clustering
        const topicCounts = new Map();
        for (const turn of turns) {
            const topic = this.extractTopic(turn.userText);
            topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
        }
        for (const [topic, count] of topicCounts) {
            if (count >= 3) {
                patterns.push(`Frequent topic: ${topic} (${count} times)`);
            }
        }
        // Detect time-based patterns
        if (turns.length >= 5) {
            const timeGaps = [];
            for (let i = 1; i < turns.length; i++) {
                timeGaps.push(turns[i].timestamp - turns[i - 1].timestamp);
            }
            const avgGap = timeGaps.reduce((a, b) => a + b, 0) / timeGaps.length;
            if (avgGap < 60_000) {
                patterns.push('Rapid-fire conversation pattern detected');
            }
        }
        return patterns;
    }
    /**
     * Get buffered turn count.
     */
    getBufferedTurnCount() {
        return this.bufferedTurns.length;
    }
    /**
     * Clear buffer.
     */
    clearBuffer() {
        this.bufferedTurns = [];
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getSessionExtractionManager() {
    if (!_instance)
        _instance = new SessionExtractionManager();
    return _instance;
}
//# sourceMappingURL=session-extraction.js.map