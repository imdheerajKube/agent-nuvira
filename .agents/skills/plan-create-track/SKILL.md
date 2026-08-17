---
name: plan-create-track
description: Plan and track a multi-step job: break the goal into ordered, verifiable steps, declare them with plan_todo, work through them updating status (running → done, or blocked with a note), and finish with a summary. Use for any job with 2+ steps where progress visibility matters.
version: 1.0.0
---

# plan-create-track

Plan and track a multi-step job: break the goal into ordered, verifiable steps, declare them with plan_todo, work through them updating status (running → done, or blocked with a note), and finish with a summary. Use for any job with 2+ steps where progress visibility matters.

## Goal pattern

plan create track steps todo checklist progress multi-step job execute work through order

## Parameters

- goal (string (required)): The goal to plan and execute

## Steps

1. [planner] Break the goal into 3–7 ordered steps. Each step must be:
- independently verifiable (you will know it is done by running/reading something)
- small enough to complete in one working session
- ordered so dependencies come first (but no stricter than necessary)
Give each step a short stable id (reproduce, fix, verify) and a one-line description. Declare them with the plan_todo tool (action: create, goal + steps).

2. [runner] Work the steps IN ORDER, updating plan_todo (action: update, id + status) at each transition:
- mark the current step running before starting it
- mark it done only after its exit criterion is verified (a test passed, a file reads correctly, a command succeeded)
- if a step is blocked (an external dependency, a failure you cannot fix now), mark it blocked and CONTINUE with the next step — never stall the whole plan on one step
Use the coding tools (read_file / edit_file / run_terminal) to actually do the work — the plan is a map, not the work itself. (after: step-0)

3. [reviewer] Close the loop: confirm every step is done or explicitly blocked, re-check the exit criteria for the done steps (run the final verification once more if cheap), and write a closing summary: what was completed, what is blocked (if anything), and the natural next step. (after: step-1)
