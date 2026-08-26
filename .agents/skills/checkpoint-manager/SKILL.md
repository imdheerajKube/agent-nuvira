---
name: checkpoint-manager
description: Manage code checkpoints: save progress snapshots, rollback to checkpoints, compare versions, and restore state. Use when building safety nets for complex refactoring or migration tasks.
version: 1.0.0
---

# checkpoint-manager

Manage code checkpoints: save progress snapshots, rollback to checkpoints, compare versions, and restore state. Use when building safety nets for complex refactoring or migration tasks.

## Goal pattern

checkpoint save snapshot rollback restore version compare safety net refactoring

## Steps

0. [context-gatherer] Map the checkpoint needs: what state to save (files, database, config)? How many checkpoints? Comparison needs? Rollback granularity?

1. [planner] Design the checkpoint system:
1. Save: capture file state, database state, config state
2. Store: git branches, tar archives, or database snapshots
3. Restore: selective or full rollback
4. Compare: diff between checkpoints
5. Naming: descriptive checkpoint names with timestamps
6. Cleanup: auto-expire old checkpoints (after: 'step-0')

2. [runner] Implement checkpoint management:
1. Create save function (capture current state)
2. Implement restore function
3. Add comparison (diff between checkpoints)
4. Set up auto-cleanup
5. Test save/restore cycle
6. Test rollback with data preservation (after: 'step-1')

3. [reviewer] Verify: checkpoints save correctly, restore works, comparison shows differences, cleanup runs, no data loss. (after: 'step-2')
