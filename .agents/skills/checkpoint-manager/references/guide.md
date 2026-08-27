# Checkpoint Manager Reference Guide

## Overview
Manage code checkpoints: save progress snapshots, rollback to checkpoints, compare versions, and restore state. Use when building safety nets for complex refactoring or migration tasks.

## # checkpoint-manager

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

## Best Practices

- Follow the skill's methodology step by step
- Verify each step before proceeding to the next
- Use the appropriate tools for each task
- Document any deviations from the standard approach

## Common Patterns

- Start with context gathering to understand the current state
- Plan the implementation before writing code
- Test changes before committing
- Review for security and performance implications

## Troubleshooting

- If the skill fails, check the prerequisites first
- Verify environment variables are set correctly
- Check for conflicting configurations
- Review logs for detailed error messages

## Further Reading

- Refer to the main SKILL.md for complete methodology
- Check official documentation for the specific technology
- Review related skills in the registry for complementary approaches
