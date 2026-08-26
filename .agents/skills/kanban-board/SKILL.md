---
name: kanban-board
description: Build a Kanban board: drag-and-drop columns, WIP limits, swimlanes, and workflow automation. Use when creating a visual project management tool.
version: 1.0.0
---

# kanban-board

Build a Kanban board: drag-and-drop columns, WIP limits, swimlanes, and workflow automation. Use when creating a visual project management tool.

## Goal pattern

kanban board drag drop columns WIP limits workflow project management task tracking

## Steps

0. [context-gatherer] Map the board: what columns (Backlog, Todo, In Progress, Review, Done)? What WIP limits? What swimlanes? What automation rules?

1. [planner] Design the Kanban board:
1. Data model: boards, columns, cards, labels, assignees
2. UI: drag-and-drop (dnd-kit, react-beautiful-dnd)
3. WIP limits: visual indicators, prevent exceeding limits
4. Swimlanes: grouping by team, priority, or category
5. Automation: move card when status changes, auto-assign
6. Persistence: database or local storage (after: 'step-0')

2. [runner] Build the Kanban board:
1. Create data model and API
2. Build drag-and-drop UI
3. Implement WIP limits
4. Add swimlanes
5. Set up automation rules
6. Test with sample data (after: 'step-1')

3. [reviewer] Verify: drag-and-drop works, WIP limits enforced, automation triggers, data persists, responsive on mobile. (after: 'step-2')
