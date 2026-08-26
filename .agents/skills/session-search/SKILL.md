---
name: session-search
description: Search and retrieve past coding sessions: find previous conversations, code changes, and decisions. Covers session storage, full-text search, and context retrieval. Use when the goal is to find information from past interactions.
version: 1.0.0
---

# session-search

Search and retrieve past coding sessions: find previous conversations, code changes, and decisions. Covers session storage, full-text search, and context retrieval. Use when the goal is to find information from past interactions.

## Goal pattern

session search past conversation history code changes decisions context retrieval

## Steps

0. [context-gatherer] Map the search: what are we looking for? What session data exists? What search capabilities available?

1. [planner] Design session search:
1. Storage: session history in files or database
2. Indexing: full-text search index (FTS5, Meilisearch)
3. Query: keyword search, date range, file filter
4. Results: ranked by relevance, with context
5. Retrieval: fetch full session details
6. Privacy: search only within allowed scope (after: 'step-0')

2. [runner] Implement session search:
1. Build search index from session data
2. Implement query parser
3. Create search function with ranking
4. Add context retrieval for results
5. Test with sample sessions
6. Optimize for performance (after: 'step-1')

3. [reviewer] Verify: search returns relevant results, ranking is accurate, context is sufficient, performance is acceptable. (after: 'step-2')
