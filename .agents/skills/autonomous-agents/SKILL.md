---
name: autonomous-agents
description: Design, build, and deploy autonomous AI agents with tool use, memory, planning loops, and self-correction. Use when the goal is to create an agent that can reason, act, and iterate without constant human oversight.
version: 1.0.0
---

# autonomous-agents

Design, build, and deploy autonomous AI agents with tool use, memory, planning loops, and self-correction. Use when the goal is to create an agent that can reason, act, and iterate without constant human oversight.

## Goal pattern

autonomous agent AI agent tool use memory planning loop self-correction agent framework

## Steps

0. [context-gatherer] Map the agent requirements: what tools does the agent need? What memory stores (short-term, long-term)? What planning strategy (ReAct, Plan-and-Execute, Tree of Thoughts)? What guardrails (approval gates, budget limits, time limits)? What orchestration (single agent vs multi-agent)?

1. [planner] Design the agent architecture:
1. Choose the loop pattern: ReAct (reason→act→observe) for simple tasks, Plan-and-Execute for complex multi-step tasks
2. Define the tool interface: each tool needs a name, description, input schema, and execution function
3. Design memory: working memory (current context), episodic memory (past interactions), semantic memory (knowledge base)
4. Define guardrails: max iterations, budget caps, approval for destructive actions, output validation
5. Plan the observability: trace logging, decision recording, error reporting (after: 'step-0')

2. [runner] Implement the agent core:
1. Agent loop: while not done → observe → think → act → observe result
2. Tool registry: register tools with schemas, validate inputs, handle errors
3. Memory manager: store and retrieve context, compress long histories
4. Planner: decompose goals into steps, re-plan on failure
5. Guardrails: check before each action, block disallowed operations
6. Start with a minimal agent (2-3 tools) and expand incrementally (after: 'step-1')

3. [reviewer] Verify the agent works end-to-end: run it on 3 progressively complex tasks, verify it reasons correctly, uses tools appropriately, recovers from errors, and respects guardrails. Log the full trace for review. (after: 'step-2')
