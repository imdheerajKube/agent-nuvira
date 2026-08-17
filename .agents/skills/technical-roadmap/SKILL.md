---
name: technical-roadmap
description: Build a phased technical roadmap from the current state to a target state: capture the current architecture, define the target, then produce ordered phases with dependencies, effort, risk, and success criteria. Use when the goal asks for a roadmap, migration plan, technical plan, or phased upgrade path.
version: 1.0.0
---

# technical-roadmap

Build a phased technical roadmap from the current state to a target state: capture the current architecture, define the target, then produce ordered phases with dependencies, effort, risk, and success criteria. Use when the goal asks for a roadmap, migration plan, technical plan, or phased upgrade path.

## Goal pattern

roadmap migration plan technical plan phased upgrade path target state current state phases dependencies milestones

## Parameters

- target (file-path [default: .]): Path or scope for the roadmap (default: the whole project)
- horizon (string [default: 6 months]): Roadmap horizon, e.g. "6 months" or "this quarter" (default: 6 months)

## Steps

1. [context-gatherer] Establish the CURRENT state with evidence: read the architecture-relevant files (entry points, config, module boundaries, package manifests), and note the stack, key flows, and known constraints (legacy pieces, hard dependencies, team-visible risk). Keep it factual — cite files.

2. [writer] Define the TARGET state as concrete outcomes, not slogans: for each area (stack, architecture, quality, operations) state what changes and what the measurable success criterion is (e.g. "typecheck passes with noEmit", "deploys are under 5 minutes"). (after: step-0)

3. [planner] Design the PHASES between current and target. Each phase must have:
- a clear outcome and exit criteria
- dependencies on other phases (explicit dependsOn)
- effort estimate (S/M/L) and risk (low/medium/high)
- what is explicitly OUT of scope (so phases stay small and shippable)
Order them so each phase leaves the system working (never a long broken window). Typically 3–5 phases. (after: step-1)

4. [writer] Produce the roadmap artifact: current state (cited) → target state (measurable) → phases (each with outcome, dependencies, effort, risk, out-of-scope), plus a critical-path note (which phases gate everything else) and a first-step recommendation. (after: step-2)
