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
 * - A single-shot agent has no equivalent step; the extra layer is this
 *   design's architectural advantage
 * - The decision document replaces generic "create a game" with
 *   "Create a Python+tkinter snake-and-ladder game, single file,
 *    package with pyinstaller, produce .exe for Windows"
 */

import { Agent, type AgentContext, type AgentResult, type LLMCallFn } from '../agent.js';
import { assessProject, type ProjectAssessment } from '../prompt-assembly.js';
import {
  authoredDeliverableGuidance,
  classifyDeliverable,
  deliverableClassLabel,
  type DeliverableClass,
} from '../../learning/deliverable-class.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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
  /**
   * G7 — what KIND of thing the user asked for. Assigned deterministically by
   * `classifyDeliverable` (see deliverable-class.ts), never by the model: a
   * weak model that reads "write a story" as a software project must not be
   * able to reintroduce the category error that killed the story task.
   */
  deliverableClass: DeliverableClass;
  /** Whether this is a greenfield (from-scratch) project */
  isGreenfield: boolean;
  /** Confidence in the decisions (0-1) */
  confidence: number;
  /** Reasoning for each decision */
  reasoning: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const REASONER_SYSTEM_PROMPT = [
  'You are a senior software architect. Your job is to analyze a user goal and make',
  'technical decisions BEFORE planning implementation.',
  '',
  'You must decide:',
  '1. Language: What programming language to use (python, typescript, csharp, go, rust, etc.)',
  '2. Framework: What framework/library to use (tkinter, pygame, electron, express, etc.)',
  '3. Platform: What platform to target (windows-gui, web, cli, cross-platform, etc.)',
  '4. Architecture: How to structure the code (single-file, multi-file, module, etc.)',
  '5. Dependencies: What packages need to be installed',
  '6. Build: How to produce the deliverable (pyinstaller, dotnet publish, npm build, etc.)',
  '7. Deliverable: What the final output should be (executable, web-app, library, etc.)',
  '8. Constraints: What must be true about the solution',
  '9. Deliverable class: code | document | creative | data | research — the KIND of',
  '   thing requested. Use "creative" for stories/novels/poems and "document" for',
  '   reports/essays/articles: for those, the artifact is WRITTEN CONTENT and the',
  '   language is "none". You must NEVER answer such a request with a script or',
  '   program that would produce the content — writing it IS the task.',
  '',
  'Rules:',
  '- Be SPECIFIC: "Python+tkinter" not "a language"',
  '- Be REALISTIC: use tools that actually exist and work',
  '- Be PRACTICAL: choose the simplest solution that meets the goal',
  '- Consider the working directory: if it already has code, use the same stack',
  '- If the goal is greenfield (from scratch), choose the best stack for the task',
  '- If the goal modifies existing code, use the existing stack',
  '',
  'Return ONLY a valid JSON object matching this schema:',
  '{',
  '  "language": "string",',
  '  "framework": "string",',
  '  "platform": "string",',
  '  "architecture": "string",',
  '  "dependencies": ["string"],',
  '  "buildCommand": "string (optional)",',
  '  "deliverable": "string",',
  '  "deliverableClass": "code | document | creative | data | research",',
  '  "constraints": ["string"],',
  '  "isGreenfield": boolean,',
  '  "confidence": number (0-1),',
  '  "reasoning": "string"',
  '}',
  '',
  'No markdown, no explanations — just the JSON.',
].join('\n');

// ─── Agent ──────────────────────────────────────────────────────────────────

/**
 * ReasonerAgent — Technical decision layer.
 *
 * Runs BEFORE the planner to make high-level technical decisions about
 * the goal. These decisions are injected into the planner's context so
 * it can create better, more specific steps.
 */
export class ReasonerAgent extends Agent {
  readonly name = 'Reasoner';
  readonly description = 'Makes technical decisions before planning';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      this.report(context, 'analyzing', 'Analyzing goal and making technical decisions…');

      // Assess the project to understand what exists
      let assessment: ProjectAssessment | undefined;
      try {
        assessment = assessProject(context.workingDirectory);
      } catch {
        // Best-effort — assessment must never break the reasoner
      }

      // ── Deliverable class (deterministic, before any LLM sees the goal) ──
      // For an authored ask this is reported to the model as already DECIDED,
      // with the consequences spelled out — the live failure was the model
      // choosing "python + a Python script is the most efficient way" for a
      // request to write a novel.
      const verdict = classifyDeliverable(context.goal);
      context.metadata.deliverableClass = verdict.class;
      context.metadata.deliverableAuthored = verdict.authored;

      // Build the prompt
      const promptParts: string[] = [
        REASONER_SYSTEM_PROMPT,
        '',
        '## User Goal',
        context.goal,
        '',
        '## Working Directory',
        context.workingDirectory,
      ];

      // G12 — the guidance is substrate-aware: a hybrid ask (web-based book with
      // narration) must be told that the presentation layer is required BUT a
      // Python service is optional, or the reasoner re-frames the whole thing as
      // software and the prose never gets written.
      const authoredGuidance = verdict.authored
        ? authoredDeliverableGuidance(verdict.class, verdict.substrates)
        : '';
      if (authoredGuidance) promptParts.push(authoredGuidance);

      // Inject project assessment if available
      if (assessment) {
        const assessmentLines: string[] = ['', '## Current Project State'];
        if (assessment.language) assessmentLines.push(`Language: ${assessment.language}`);
        if (assessment.framework) assessmentLines.push(`Framework: ${assessment.framework}`);
        if (assessment.packageManager) assessmentLines.push(`Package manager: ${assessment.packageManager}`);
        assessmentLines.push(`Is greenfield: ${assessment.isGreenfield}`);
        assessmentLines.push(`Has tests: ${assessment.hasTests}`);
        if (assessment.keyFiles.length > 0) {
          assessmentLines.push(`Key files: ${assessment.keyFiles.join(', ')}`);
        }
        promptParts.push(...assessmentLines);

        // The cross-session memory block (recent asks in this project, composed
        // by the SAME composer the loop engine uses). Advisory history, already
        // self-labelled as such — the reasoner must not read it as a status.
        if (assessment.crossSessionMemory) {
          promptParts.push('', assessment.crossSessionMemory);
        }
      }

      // Inject file tree if available
      const fileTree = context.metadata.projectFileTree as string | undefined;
      if (fileTree) {
        promptParts.push('', '## Project Structure', fileTree);
      }

      promptParts.push('', 'Analyze the goal and make technical decisions. Return ONLY a valid JSON object.');

      const prompt = promptParts.join('\n');

      // Call the LLM
      const response = await callLLM(prompt, {
        temperature: 0.2, // Low temperature for deterministic decisions
        maxTokens: 2048,
      });

      // Parse the response
      const decision = this.parseDecision(response);

      if (!decision) {
        return {
          success: false,
          error: 'Could not parse technical decisions from LLM response',
          summary: 'Reasoning failed — planner will use defaults',
        };
      }

      // ── ENFORCE the authored class (G7) ────────────────────────────────
      // The classifier decided this before the model was called. If the model
      // still answered with a programming stack — exactly what happened live
      // ("language":"python", framework "none", reasoning "a Python script is
      // the most efficient way") — the decision is corrected here rather than
      // passed downstream, because the PLANNER consumes this document and would
      // faithfully turn it into a code plan.
      if (verdict.authored) {
        decision.deliverableClass = verdict.class === 'document' ? 'document' : 'creative';
        decision.language = 'none';
        decision.framework = 'none';
        decision.platform = 'document';
        decision.architecture = 'sections';
        decision.dependencies = [];
        decision.buildCommand = undefined;
        if (!decision.deliverable || decision.deliverable === 'unknown' || /script|program|app$/i.test(decision.deliverable)) {
          decision.deliverable = 'markdown_file';
        }
      } else {
        decision.deliverableClass = verdict.class;
      }

      // Store the decision in the vault for the planner to use
      context.metadata.technicalDecision = decision;

      this.report(context, 'decided',
        `Technical decisions: ${deliverableClassLabel(decision.deliverableClass)} → ` +
        `${decision.language}+${decision.framework} → ${decision.platform} → ${decision.deliverable}`
      );

      return {
        success: true,
        summary:
          `Technical decisions made: ${deliverableClassLabel(decision.deliverableClass)} — ` +
          `${decision.language}+${decision.framework} on ${decision.platform}`,
      };
    } catch (err) {
      return {
        success: false,
        error: `Reasoning failed: ${err}`,
        summary: 'Reasoning failed — planner will use defaults',
      };
    }
  }

  /**
   * Parse the LLM response into a TechnicalDecision.
   */
  private parseDecision(response: string): TechnicalDecision | null {
    try {
      // Extract JSON from the response (handle markdown code blocks)
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();

      // Try to find the JSON object in the response
      const objMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (!objMatch) return null;

      const parsed = JSON.parse(objMatch[0]);

      // Validate required fields
      if (!parsed.language || !parsed.framework || !parsed.platform) {
        return null;
      }

      const VALID_CLASSES: DeliverableClass[] = ['code', 'document', 'creative', 'data', 'research'];
      const cls = VALID_CLASSES.includes(parsed.deliverableClass) ? parsed.deliverableClass : 'code';

      return {
        language: String(parsed.language),
        framework: String(parsed.framework),
        platform: String(parsed.platform),
        architecture: String(parsed.architecture || 'single-file'),
        dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
        buildCommand: parsed.buildCommand ? String(parsed.buildCommand) : undefined,
        deliverable: String(parsed.deliverable || 'unknown'),
        deliverableClass: cls,
        constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
        isGreenfield: Boolean(parsed.isGreenfield),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        reasoning: String(parsed.reasoning || ''),
      };
    } catch {
      return null;
    }
  }
}
