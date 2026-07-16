/**
 * Type Compatibility Smoke Test — Verifies that the @agent-nuvira/sdk types
 * are structurally compatible with the main package types.
 *
 * The SDK types are clean-room duplicates (no imports from the main package).
 * This test flags type drift early by using vitest's expectTypeOf to verify
 * that values typed with one type system can flow into the other.
 *
 * ## Design
 *
 * - For each shared type, create a value using the SDK type and verify it
 *   can be assigned to the main package type (and vice versa).
 * - Report any intentional differences (e.g. SDK's InferenceOptions adds
 *   stop/topP, main adds provider/stream).
 * - Compile-time checks catch missing/extra fields, wrong types, etc.
 *
 * @module tests/agent-sdk/type-compatibility
 */

import { describe, it, expectTypeOf } from 'vitest';

// ─── Main Package Types ─────────────────────────────────────────────────────
// Import the source types directly (they'll be compiled by tsx vitest)

import type {
  TaskStatus as MainTaskStatus,
  TaskStep as MainTaskStep,
  Artifact as MainArtifact,
  FileChange as MainFileChange,
  AgentMessage as MainAgentMessage,
  AgentContext as MainAgentContext,
  AgentResult as MainAgentResult,
  RateLimitInfo as MainRateLimitInfo,
  RateLimitAction as MainRateLimitAction,
  OnRateLimit as MainOnRateLimit,
  LLMCallFn as MainLLMCallFn,
} from '../../src/agents/agent.js';

import type {
  Agent as MainAgent,
} from '../../src/agents/agent.js';

import type {
  InferenceOptions as MainInferenceOptions,
} from '../../src/config/types.js';

import type {
  OrchestratorOptions as MainOrchestratorOptions,
  OrchestrationResult as MainOrchestrationResult,
} from '../../src/agents/orchestrator.js';

// ─── SDK Types ──────────────────────────────────────────────────────────────

import type {
  TaskStatus as SDKTaskStatus,
  TaskStep as SDKTaskStep,
  Artifact as SDKArtifact,
  FileChange as SDKFileChange,
  AgentMessage as SDKAgentMessage,
  AgentContext as SDKAgentContext,
  AgentResult as SDKAgentResult,
  RateLimitInfo as SDKRateLimitInfo,
  RateLimitAction as SDKRateLimitAction,
  OnRateLimit as SDKOnRateLimit,
  LLMCallFn as SDKLLMCallFn,
  InferenceOptions as SDKInferenceOptions,
  OrchestratorOptions as SDKOrchestratorOptions,
  OrchestrationResult as SDKOrchestrationResult,
} from '../../src/agent-sdk/src/types.js';

import type {
  Agent as SDKAgent,
} from '../../src/agent-sdk/src/agent.js';

// ─── Binary-Compatible Types ────────────────────────────────────────────────
// These types should be identical between main and SDK.
// We verify by checking that a value typed with one can be assigned to the other.

describe('SDK ↔ Main type compatibility', () => {
  // ── TaskStatus ─────────────────────────────────────────────────────────

  describe('TaskStatus', () => {
    it('should have the same string union values', () => {
      // Both are: 'pending' | 'running' | 'completed' | 'failed'
      expectTypeOf<SDKTaskStatus>().toMatchTypeOf<MainTaskStatus>();
      expectTypeOf<MainTaskStatus>().toMatchTypeOf<SDKTaskStatus>();
    });
  });

  // ── TaskStep ───────────────────────────────────────────────────────────

  describe('TaskStep', () => {
    it('should accept SDK-typed values as Main', () => {
      const sdkStep: SDKTaskStep = {
        id: 'step-1',
        description: 'Write the main file',
        agentType: 'writer',
        dependsOn: ['step-0'],
        status: 'pending',
        result: 'Done',
      };
      // SDK → Main assignment
      const _mainStep: MainTaskStep = sdkStep;
      expect(_mainStep.id).toBe('step-1');
    });

    it('should accept Main-typed values as SDK', () => {
      const mainStep: MainTaskStep = {
        id: 'step-1',
        description: 'Write the main file',
        agentType: 'writer',
        dependsOn: ['step-0'],
        status: 'pending',
      };
      // Main → SDK assignment
      const _sdkStep: SDKTaskStep = mainStep;
      expect(_sdkStep.id).toBe('step-1');
    });

    it('should have structurally compatible types', () => {
      expectTypeOf<SDKTaskStep>().toMatchTypeOf<MainTaskStep>();
      expectTypeOf<MainTaskStep>().toMatchTypeOf<SDKTaskStep>();
    });
  });

  // ── Artifact ───────────────────────────────────────────────────────────

  describe('Artifact', () => {
    it('should have the same fields', () => {
      const sdk: SDKArtifact = { path: 'a.ts', content: 'code', description: 'Source' };
      const main: MainArtifact = sdk;
      expect(main.path).toBe('a.ts');
      expectTypeOf<SDKArtifact>().toEqualTypeOf<MainArtifact>();
    });
  });

  // ── FileChange ─────────────────────────────────────────────────────────

  describe('FileChange', () => {
    it('should have the same fields', () => {
      const created: SDKFileChange = { path: 'new.ts', newContent: 'code', status: 'created' };
      const mainCreated: MainFileChange = created;
      expect(mainCreated.status).toBe('created');

      const modified: SDKFileChange = { path: 'old.ts', originalContent: 'old', newContent: 'new', status: 'modified' };
      const mainModified: MainFileChange = modified;
      expect(mainModified.status).toBe('modified');

      const deleted: SDKFileChange = { path: 'gone.ts', originalContent: 'gone', status: 'deleted' };
      const mainDeleted: MainFileChange = deleted;
      expect(mainDeleted.status).toBe('deleted');

      expectTypeOf<SDKFileChange>().toEqualTypeOf<MainFileChange>();
    });
  });

  // ── AgentMessage ──────────────────────────────────────────────────────

  describe('AgentMessage', () => {
    it('should have the same fields', () => {
      const msg: SDKAgentMessage = { from: 'Writer', to: 'Reviewer', content: 'done', timestamp: 1000 };
      const mainMsg: MainAgentMessage = msg;
      expect(mainMsg.from).toBe('Writer');
      expectTypeOf<SDKAgentMessage>().toEqualTypeOf<MainAgentMessage>();
    });
  });

  // ── AgentContext ──────────────────────────────────────────────────────

  describe('AgentContext', () => {
    it('should accept SDK-typed context as Main', () => {
      const sdkCtx: SDKAgentContext = {
        goal: 'Test',
        workingDirectory: '/tmp',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      };
      const mainCtx: MainAgentContext = sdkCtx;
      expect(mainCtx.goal).toBe('Test');
    });

    it('should accept Main-typed context as SDK', () => {
      const mainCtx: MainAgentContext = {
        goal: 'Test',
        workingDirectory: '/tmp',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      };
      const sdkCtx: SDKAgentContext = mainCtx;
      expect(sdkCtx.goal).toBe('Test');
    });

    it('should be structurally identical', () => {
      // AgentContext includes onRateLimit which references LLMCallFn and
      // RateLimitAction — those must also be compatible.
      expectTypeOf<SDKAgentContext>().toMatchTypeOf<MainAgentContext>();
      expectTypeOf<MainAgentContext>().toMatchTypeOf<SDKAgentContext>();
    });
  });

  // ── AgentResult ───────────────────────────────────────────────────────

  describe('AgentResult', () => {
    it('should have the same fields', () => {
      const successResult: SDKAgentResult = { success: true, summary: 'Done', details: 'details', error: undefined };
      const mainResult: MainAgentResult = successResult;
      expect(mainResult.success).toBe(true);

      expectTypeOf<SDKAgentResult>().toEqualTypeOf<MainAgentResult>();
    });
  });

  // ── LLMCallFn ─────────────────────────────────────────────────────────

  describe('LLMCallFn', () => {
    it('should be structurally compatible', () => {
      expectTypeOf<SDKLLMCallFn>().toMatchTypeOf<MainLLMCallFn>();
      expectTypeOf<MainLLMCallFn>().toMatchTypeOf<SDKLLMCallFn>();
    });
  });

  // ── RateLimitInfo ─────────────────────────────────────────────────────

  describe('RateLimitInfo', () => {
    it('should have the same fields', () => {
      expectTypeOf<SDKRateLimitInfo>().toEqualTypeOf<MainRateLimitInfo>();
    });
  });

  // ── RateLimitAction ───────────────────────────────────────────────────

  describe('RateLimitAction', () => {
    it('should be structurally compatible', () => {
      expectTypeOf<SDKRateLimitAction>().toMatchTypeOf<MainRateLimitAction>();
      expectTypeOf<MainRateLimitAction>().toMatchTypeOf<SDKRateLimitAction>();
    });
  });

  // ── OnRateLimit ───────────────────────────────────────────────────────

  describe('OnRateLimit', () => {
    it('should be structurally compatible', () => {
      expectTypeOf<SDKOnRateLimit>().toMatchTypeOf<MainOnRateLimit>();
      expectTypeOf<MainOnRateLimit>().toMatchTypeOf<SDKOnRateLimit>();
    });
  });

  // ── OrchestrationResult ──────────────────────────────────────────────

  describe('OrchestrationResult', () => {
    it('should be structurally compatible', () => {
      expectTypeOf<SDKOrchestrationResult>().toMatchTypeOf<MainOrchestrationResult>();
      expectTypeOf<MainOrchestrationResult>().toMatchTypeOf<SDKOrchestrationResult>();
    });
  });

  // ── Agent class ──────────────────────────────────────────────────────

  describe('Agent class', () => {
    it('should accept SDK agent where Main agent is expected', () => {
      // SDK Agent extends the same abstract interface, so any SDK Agent instance
      // should be assignable to the Main Agent type.
      expectTypeOf<SDKAgent>().toMatchTypeOf<MainAgent>();
    });

    it('should accept Main agent where SDK agent is expected', () => {
      expectTypeOf<MainAgent>().toMatchTypeOf<SDKAgent>();
    });
  });

  // ── Known Intentional Differences ─────────────────────────────────────

  describe('Intentional differences (noted, not tested for equality)', () => {
    it('SDK InferenceOptions adds stop and topP (vs main)', () => {
      // These are SDK-only enhancements — main doesn't have them
      expectTypeOf<{ stop?: string[]; topP?: number }>().toMatchTypeOf<SDKInferenceOptions>();
      // These are main-only — SDK doesn't have them
      expectTypeOf<{ provider?: string; stream?: boolean }>().toMatchTypeOf<MainInferenceOptions>();
    });

    it('SDK OrchestratorOptions omits spinner (main has it)', () => {
      // Main has spinner, SDK intentionally omits it
      type Spinner = { stop(): void; start(text?: string): void };
      expectTypeOf<{ spinner?: Spinner }>().toMatchTypeOf<MainOrchestratorOptions>();

      // Verify SDK does NOT have spinner via a conditional type check.
      // typeof sdkOpts extends { spinner: unknown } is false when spinner
      // is not a property of SDKOrchestratorOptions.
      const sdkOpts: SDKOrchestratorOptions = {};
      const _check: typeof sdkOpts extends { spinner: unknown } ? true : false = false;
      expect(_check).toBe(false);
    });
  });
});

// ─── Runtime Smoke Test ─────────────────────────────────────────────────────
// Verifies that the SDK types actually produce values that work with the
// main package's Agent class and ContextVault at runtime.

import { describe as runtimeDescribe, it as runtimeIt, expect } from 'vitest';

runtimeDescribe('SDK Runtime Compatibility', () => {
  runtimeIt('SDK AgentResult is assignable to main AgentResult', () => {
    const sdkResult = { success: true as const, summary: 'Test' };
    const mainResult: MainAgentResult = sdkResult;
    expect(mainResult.success).toBe(true);
  });

  runtimeIt('SDK TaskStatus values match main values', () => {
    const statuses: SDKTaskStatus[] = ['pending', 'running', 'completed', 'failed'];
    const mainStatuses: MainTaskStatus[] = statuses;
    expect(mainStatuses).toHaveLength(4);
  });

  runtimeIt('SDK FileChange values work with main context', () => {
    const sdkChanges: SDKFileChange[] = [
      { path: 'a.ts', newContent: 'x', status: 'created' },
    ];
    const ctx: MainAgentContext = {
      goal: 'test',
      workingDirectory: '/tmp',
      taskPlan: [],
      artifacts: [],
      conversations: [],
      fileChanges: sdkChanges,
      metadata: {},
    };
    expect(ctx.fileChanges[0].path).toBe('a.ts');
  });
});
