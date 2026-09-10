/**
 * ReasonerAgent — Technical decision layer between orchestrator and planner.
 *
 * Makes high-level technical decisions BEFORE the planner creates steps:
 * - Language/framework selection (Python+tkinter vs C# vs JavaScript)
 * - Platform detection (Windows GUI, web browser, CLI, cross-platform)
 * - Architecture decisions (single-file vs multi-file, module structure)
 * - Dependency identification (what packages need installation)
 * - Build/packaging strategy (pyinstaller, Electron, dotnet publish)
 * - Constraint extraction (must produce .exe, must use GUI, etc.)
 * - Greenfield vs existing project assessment
 *
 * This agent does NOT create the plan (planner's job) or write code (writer's job).
 * It produces a TechnicalDecision document that the planner uses to create
 * better, more specific steps.
 *
 * Reference:
 * - Enterprise agents use a "reasoning layer" between goal and plan
 * - Freebuff/Hermes don't have this — it's an architectural advantage
 * - The decision document replaces generic "create a game" with
 *   "Create a Python+tkinter snake-and-ladder game, single file,
 *    package with pyinstaller, produce .exe for Windows"
 */
import { Agent, type AgentContext, type AgentResult, type LLMCallFn } from '../agent.js';
/** Technical decisions made by the reasoner */
export interface TechnicalDecision {
    /** Detected or decided language (python, typescript, csharp, go, etc.) */
    language: string;
    /** Detected or decided framework (tkinter, pygame, electron, express, etc.) */
    framework: string;
    /** Target platform (windows-gui, web, cli, cross-platform, etc.) */
    platform: string;
    /** Architecture pattern (single-file, multi-file, module, etc.) */
    architecture: string;
    /** Dependencies that need to be installed */
    dependencies: string[];
    /** Build/packaging command (pyinstaller, dotnet publish, etc.) */
    buildCommand?: string;
    /** Expected deliverable (executable, web-app, library, etc.) */
    deliverable: string;
    /** Constraints that must be satisfied */
    constraints: string[];
    /** Whether this is a greenfield (from-scratch) project */
    isGreenfield: boolean;
    /** Confidence in the decisions (0-1) */
    confidence: number;
    /** Reasoning for each decision */
    reasoning: string;
}
/**
 * ReasonerAgent — Technical decision layer.
 *
 * Runs BEFORE the planner to make high-level technical decisions about
 * the goal. These decisions are injected into the planner's context so
 * it can create better, more specific steps.
 */
export declare class ReasonerAgent extends Agent {
    readonly name = "Reasoner";
    readonly description = "Makes technical decisions before planning";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Parse the LLM response into a TechnicalDecision.
     */
    private parseDecision;
}
//# sourceMappingURL=reasoner.d.ts.map