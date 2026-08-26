---
name: prompt-engineering
description: Design, test, and optimize prompts for LLMs. Covers chain-of-thought, few-shot, system prompts, prompt chaining, evals, and A/B testing. Use when the goal is to improve LLM output quality or build prompt-driven features.
version: 1.0.0
---

# prompt-engineering

Design, test, and optimize prompts for LLMs. Covers chain-of-thought, few-shot, system prompts, prompt chaining, evals, and A/B testing. Use when the goal is to improve LLM output quality or build prompt-driven features.

## Goal pattern

prompt engineering chain-of-thought few-shot system prompt optimization eval A/B testing LLM prompt design

## Steps

0. [context-gatherer] Understand the task: what LLM is being used? What is the desired output format? What are the failure modes of the current prompt? What constraints exist (latency, cost, token limits)?

1. [planner] Design the prompt strategy:
1. Choose technique: zero-shot, few-shot, chain-of-thought, ReAct, tree-of-thoughts
2. Structure: system prompt → context → instructions → examples → output format
3. Add guardrails: "if not sure, say I don't know", format validation, output schemas
4. Plan evaluation: define metrics (accuracy, relevance, format compliance, hallucination rate)
5. Plan iteration: A/B test variants, track prompt versions (after: 'step-0')

2. [runner] Implement and test:
1. Write the initial prompt with clear instructions
2. Add few-shot examples for consistency
3. Test with 10-20 diverse inputs
4. Measure output quality against criteria
5. Iterate: identify failure patterns, adjust prompt, re-test
6. Version the prompt and log results (after: 'step-1')

3. [reviewer] Evaluate the final prompt: run against the full test set, report accuracy/quality metrics, document edge cases, and provide the optimized prompt with version history. (after: 'step-2')
