/**
 * Unit tests for the Dashboard Server's in-memory DAG store.
 *
 * Tests the exported functions independently of the HTTP layer:
 * - pushDAGUpdate: initializing a pipeline with nodes and edges
 * - updateDAGNode: transitioning individual node statuses
 * - resetDAG: clearing the entire pipeline state
 *
 * These tests mock node:fs, node:os, and node:http so the DAG
 * functions can be imported without side effects from the server module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks for server imports ───────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  createReadStream: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: () => '/tmp/test-home',
}));

vi.mock('node:http', () => ({
  createServer: vi.fn(() => ({
    listen: vi.fn(),
    address: vi.fn(() => ({ port: 0 })),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  })),
  IncomingMessage: vi.fn(),
  ServerResponse: vi.fn(),
}));

vi.mock('node:path', () => ({
  join: (...args: string[]) => args.join('/'),
  extname: vi.fn(),
  dirname: vi.fn(() => '/mock/dir'),
  resolve: vi.fn(),
}));

vi.mock('node:url', () => ({
  fileURLToPath: vi.fn(() => '/mock/dir/server.js'),
}));

// Import the DAG functions after mocks
const { pushDAGUpdate, updateDAGNode, resetDAG, readDAGData } = await import('../../src/web-dashboard/server.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<{ id: string; agentType: string; status: string; description: string }> = {}) {
  return {
    id: overrides.id || 'step-1',
    agentType: overrides.agentType || 'writer',
    status: (overrides.status || 'pending') as 'pending' | 'running' | 'completed' | 'failed',
    description: overrides.description || 'Write code',
  };
}

function makeEdge(from: string, to: string) {
  return { from, to };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Dashboard Server — DAG Store', () => {
  // Reset state before each test
  beforeEach(() => {
    resetDAG();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // pushDAGUpdate
  // ═══════════════════════════════════════════════════════════════════════

  describe('pushDAGUpdate', () => {
    it('stores nodes, edges, and pipeline description when called with a pipelineId', () => {
      const nodes = [makeNode({ id: 'step-1', agentType: 'planner', description: 'Create plan' })];
      const edges: Array<{ from: string; to: string }> = [];

      pushDAGUpdate({
        pipelineId: 'test-pipeline',
        pipelineDescription: 'A test execution',
        nodes,
        edges,
      });

      const state = readDAGData();
      expect(state.nodes).toHaveLength(1);
      expect(state.nodes[0].id).toBe('step-1');
      expect(state.nodes[0].agentType).toBe('planner');
      expect(state.nodes[0].status).toBe('pending');
      expect(state.nodes[0].description).toBe('Create plan');
      expect(state.pipeline).toBe('A test execution');
      expect(state.active).toBe(true);
    });

    it('creates a pipeline with multiple nodes and edges', () => {
      const nodes = [
        makeNode({ id: 'a', agentType: 'planner', description: 'Plan' }),
        makeNode({ id: 'b', agentType: 'writer', description: 'Write' }),
        makeNode({ id: 'c', agentType: 'reviewer', description: 'Review' }),
      ];
      const edges = [
        makeEdge('a', 'b'),
        makeEdge('b', 'c'),
      ];

      pushDAGUpdate({
        pipelineId: 'multi-step',
        pipelineDescription: 'Multi-step pipeline',
        nodes,
        edges,
      });

      const state = readDAGData();
      expect(state.nodes).toHaveLength(3);
      expect(state.edges).toHaveLength(2);
      expect(state.nodes.map((n: any) => n.id)).toEqual(['a', 'b', 'c']);
      expect(state.edges).toContainEqual({ from: 'a', to: 'b' });
      expect(state.edges).toContainEqual({ from: 'b', to: 'c' });
    });

    it('replaces nodes/edges when called again with a new pipelineId', () => {
      pushDAGUpdate({
        pipelineId: 'pipeline-1',
        nodes: [makeNode({ id: 'step-a' })],
        edges: [],
      });

      pushDAGUpdate({
        pipelineId: 'pipeline-2',
        nodes: [makeNode({ id: 'step-b' })],
        edges: [],
      });

      const state = readDAGData();
      expect(state.nodes).toHaveLength(1);
      expect(state.nodes[0].id).toBe('step-b');
      expect(state.pipeline).toBe('pipeline-2');
    });

    it('does not reset nodes when pipelineId is not provided', () => {
      pushDAGUpdate({
        pipelineId: 'test',
        pipelineDescription: 'Initial',
        nodes: [makeNode({ id: 'step-1' })],
        edges: [],
      });

      updateDAGNode('step-1', { status: 'running' });

      pushDAGUpdate({
        nodes: [],
        edges: [],
      });

      // Node should still exist and be running after the no-pipelineId push
      const state = readDAGData();
      expect(state.nodes).toHaveLength(1);
      expect(state.nodes[0].status).toBe('running');
    });

    it('handles empty nodes array gracefully', () => {
      pushDAGUpdate({
        pipelineId: 'empty',
        pipelineDescription: 'Empty pipeline',
        nodes: [],
        edges: [],
      });
      const state = readDAGData();
      // When no nodes exist, readDAGData falls back to trajectory data (none here)
      expect(state.nodes).toHaveLength(0);
      expect(state.active).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // updateDAGNode
  // ═══════════════════════════════════════════════════════════════════════

  describe('updateDAGNode', () => {
    beforeEach(() => {
      pushDAGUpdate({
        pipelineId: 'test',
        pipelineDescription: 'Test pipeline',
        nodes: [
          makeNode({ id: 'step-1', agentType: 'planner', description: 'Plan' }),
          makeNode({ id: 'step-2', agentType: 'writer', description: 'Write' }),
        ],
        edges: [makeEdge('step-1', 'step-2')],
      });
    });

    function findNode(id: string): any {
      const state = readDAGData();
      return state.nodes.find((n: any) => n.id === id);
    }

    it('transitions a node from pending to running', () => {
      updateDAGNode('step-1', { status: 'running' });
      expect(findNode('step-1').status).toBe('running');
    });

    it('transitions a node from running to completed', () => {
      updateDAGNode('step-1', { status: 'running' });
      updateDAGNode('step-1', { status: 'completed', summary: 'Created plan' });
      const node = findNode('step-1');
      expect(node.status).toBe('completed');
      expect(node.summary).toBe('Created plan');
    });

    it('transitions a node from running to failed with summary', () => {
      updateDAGNode('step-1', { status: 'running' });
      updateDAGNode('step-1', { status: 'failed', summary: 'Planning error' });
      expect(findNode('step-1').status).toBe('failed');
      expect(findNode('step-1').summary).toBe('Planning error');
    });

    it('does not update unknown node IDs', () => {
      updateDAGNode('nonexistent-step', { status: 'completed' });
      // State should be unchanged — both original nodes still pending
      expect(findNode('step-1').status).toBe('pending');
      expect(findNode('step-2').status).toBe('pending');
    });

    it('stores summary on completed nodes', () => {
      updateDAGNode('step-1', { status: 'completed', summary: 'All tasks passed' });
      expect(findNode('step-1').summary).toBe('All tasks passed');
    });

    it('stores summary on failed nodes', () => {
      updateDAGNode('step-1', { status: 'failed', summary: 'Error: timeout' });
      expect(findNode('step-1').summary).toBe('Error: timeout');
    });

    it('sets startedAt when transitioning to running', () => {
      updateDAGNode('step-1', { status: 'running' });
      expect(findNode('step-1').startedAt).toBeDefined();
      expect(typeof findNode('step-1').startedAt).toBe('number');
    });

    it('sets completedAt when transitioning to completed', () => {
      updateDAGNode('step-1', { status: 'running' });
      updateDAGNode('step-1', { status: 'completed' });
      const node = findNode('step-1');
      expect(node.completedAt).toBeDefined();
      expect(typeof node.completedAt).toBe('number');
    });

    it('sets completedAt when transitioning to failed', () => {
      updateDAGNode('step-1', { status: 'failed' });
      const node = findNode('step-1');
      expect(node.completedAt).toBeDefined();
      expect(typeof node.completedAt).toBe('number');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // resetDAG
  // ═══════════════════════════════════════════════════════════════════════

  describe('resetDAG', () => {
    it('clears all stored nodes, pipeline name, and edges', () => {
      pushDAGUpdate({
        pipelineId: 'test',
        pipelineDescription: 'Test',
        nodes: [makeNode({ id: 'step-1' })],
        edges: [],
      });

      resetDAG();

      const state = readDAGData();
      expect(state.nodes).toHaveLength(0);
      expect(state.edges).toHaveLength(0);
      expect(state.pipeline).toBeNull();
      expect(state.active).toBe(false);

      // New pipeline after reset works
      pushDAGUpdate({
        pipelineId: 'new',
        pipelineDescription: 'New pipeline',
        nodes: [makeNode({ id: 'new-step' })],
        edges: [],
      });
      const state2 = readDAGData();
      expect(state2.nodes).toHaveLength(1);
      expect(state2.pipeline).toBe('New pipeline');
    });

    it('can be called when no pipeline exists', () => {
      resetDAG();
      const state = readDAGData();
      expect(state.nodes).toHaveLength(0);
      expect(state.pipeline).toBeNull();

      resetDAG(); // safe to call twice
      const state2 = readDAGData();
      expect(state2.nodes).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Integration: full lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  describe('full pipeline lifecycle', () => {
    it('handles a complete pipeline lifecycle — plan, write, test, review', () => {
      pushDAGUpdate({
        pipelineId: 'full-lifecycle',
        pipelineDescription: 'Full lifecycle test',
        nodes: [
          makeNode({ id: 'p', agentType: 'planner', description: 'Plan' }),
          makeNode({ id: 'w', agentType: 'writer', description: 'Write' }),
          makeNode({ id: 't', agentType: 'tester', description: 'Test' }),
          makeNode({ id: 'r', agentType: 'reviewer', description: 'Review' }),
        ],
        edges: [
          makeEdge('p', 'w'),
          makeEdge('w', 't'),
          makeEdge('w', 'r'),
        ],
      });

      updateDAGNode('p', { status: 'running' });
      updateDAGNode('p', { status: 'completed', summary: 'Plan approved' });
      updateDAGNode('w', { status: 'running' });
      updateDAGNode('w', { status: 'completed', summary: 'Code written' });
      updateDAGNode('t', { status: 'running' });
      updateDAGNode('t', { status: 'completed', summary: 'All tests passed' });
      updateDAGNode('r', { status: 'running' });
      updateDAGNode('r', { status: 'completed', summary: 'Reviewed' });

      const state = readDAGData();
      expect(state.nodes.every((n: any) => n.status === 'completed')).toBe(true);
      expect(state.nodes[0].summary).toBe('Plan approved');
      expect(state.nodes[3].summary).toBe('Reviewed');
      expect(state.nodes[0].startedAt).toBeDefined();
      expect(state.nodes[0].completedAt).toBeDefined();
    });

    it('handles parallel execution with mixed success/failure', () => {
      pushDAGUpdate({
        pipelineId: 'parallel',
        pipelineDescription: 'Parallel execution',
        nodes: [
          makeNode({ id: 'p', agentType: 'planner', description: 'Plan' }),
          makeNode({ id: 'w', agentType: 'writer', description: 'Write' }),
          makeNode({ id: 't1', agentType: 'tester', description: 'Test Unit' }),
          makeNode({ id: 't2', agentType: 'tester', description: 'Test Integration' }),
          makeNode({ id: 'd', agentType: 'debugger', description: 'Debug' }),
        ],
        edges: [
          makeEdge('p', 'w'),
          makeEdge('w', 't1'),
          makeEdge('w', 't2'),
          makeEdge('t1', 'd'),
          makeEdge('t2', 'd'),
        ],
      });

      updateDAGNode('p', { status: 'running' });
      updateDAGNode('p', { status: 'completed' });
      updateDAGNode('w', { status: 'running' });
      updateDAGNode('w', { status: 'completed' });
      updateDAGNode('t1', { status: 'running' });
      updateDAGNode('t2', { status: 'running' });
      updateDAGNode('t1', { status: 'completed', summary: 'Unit tests pass' });
      updateDAGNode('t2', { status: 'failed', summary: 'Integration test failed' });
      updateDAGNode('d', { status: 'running' });
      updateDAGNode('d', { status: 'completed', summary: 'Fixed integration test' });

      const state = readDAGData();
      expect(state.nodes.find((n: any) => n.id === 'p').status).toBe('completed');
      expect(state.nodes.find((n: any) => n.id === 't1').status).toBe('completed');
      expect(state.nodes.find((n: any) => n.id === 't2').status).toBe('failed');
      expect(state.nodes.find((n: any) => n.id === 't2').summary).toBe('Integration test failed');
      expect(state.nodes.find((n: any) => n.id === 'd').status).toBe('completed');
    });

    it('handles reset between consecutive pipelines', () => {
      pushDAGUpdate({
        pipelineId: 'p1',
        pipelineDescription: 'First',
        nodes: [makeNode({ id: 'a', description: 'Step A' })],
        edges: [],
      });
      updateDAGNode('a', { status: 'running' });
      updateDAGNode('a', { status: 'completed' });

      resetDAG();

      // After reset, old node 'a' is gone
      let state = readDAGData();
      expect(state.nodes).toHaveLength(0);

      pushDAGUpdate({
        pipelineId: 'p2',
        pipelineDescription: 'Second',
        nodes: [makeNode({ id: 'b', description: 'Step B' })],
        edges: [],
      });
      updateDAGNode('b', { status: 'running' });
      updateDAGNode('b', { status: 'completed' });

      state = readDAGData();
      expect(state.nodes).toHaveLength(1);
      expect(state.nodes[0].id).toBe('b');
      expect(state.nodes[0].status).toBe('completed');
    });
  });
});
