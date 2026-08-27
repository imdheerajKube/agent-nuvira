# Memory Tool Reference Guide

## Overview
Manage agent memory: store and retrieve facts, preferences, and context across sessions. Covers short-term (working memory) and long-term (persistent) memory with semantic search. Use when the agent needs to remember information across interactions.

## # memory-tool

Manage agent memory: store and retrieve facts, preferences, and context across sessions. Covers short-term (working memory) and long-term (persistent) memory with semantic search. Use when the agent needs to remember information across interactions.

## Goal pattern

memory tool agent memory store retrieve facts preferences context session persistent semantic

## Steps

0. [context-gatherer] Map the memory needs: what facts to remember? What preferences? How long to retain? What search capabilities?

1. [planner] Design the memory system:
1. Working memory: current session context, recent interactions
2. Long-term memory: persistent facts, user preferences
3. Storage: key-value store with embeddings for semantic search
4. Retrieval: keyword + semantic search
5. Forgetting: automatic decay, manual removal
6. Privacy: user controls over what is remembered (after: 'step-0')

2. [runner] Implement memory management:
1. Create storage layer (file or database)
2. Implement store/retrieve functions
3. Add semantic search with embeddings
4. Build decay/forgetting mechanism
5. Add privacy controls
6. Test with sample data (after: 'step-1')

3. [reviewer] Verify: memories persist across sessions, search returns relevant results, forgetting works, privacy controls effective. (after: 'step-2')

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
