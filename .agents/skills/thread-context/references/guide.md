# Thread Context Reference Guide

## Overview
Manage thread context: maintain conversation history, summarize long threads, extract key decisions, and track action items. Use when managing long-running conversations or complex discussions.

## # thread-context

Manage thread context: maintain conversation history, summarize long threads, extract key decisions, and track action items. Use when managing long-running conversations or complex discussions.

## Goal pattern

thread context conversation history summary decisions action items management

## Steps

0. [context-gatherer] Map the thread: how long is the conversation? What key topics discussed? What decisions made? What action items pending?

1. [planner] Design thread context management:
1. Summarization: compress long threads into key points
2. Decision tracking: extract and log decisions with rationale
3. Action items: identify and track pending tasks
4. Context window: manage token limits by summarizing old content
5. Searchability: index thread content for retrieval
6. Export: share thread summary as document (after: 'step-0')

2. [runner] Manage the thread:
1. Summarize the conversation so far
2. Extract decisions and rationale
3. List action items with owners
4. Identify open questions
5. Create thread summary document
6. Set up context for continuation (after: 'step-1')

3. [reviewer] Verify: summary is accurate, decisions captured correctly, action items complete, context enables continuation. (after: 'step-2')

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
