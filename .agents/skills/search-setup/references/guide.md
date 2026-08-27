# Search Setup Reference Guide

## Overview
Set up full-text search for a web application using Algolia, Meilisearch, Typesense, or Elasticsearch. Includes indexing pipeline, query optimization, and autocomplete. Use when the goal asks to add search, indexing, or autocomplete to an app.

## # search-setup

Set up full-text search for a web application using Algolia, Meilisearch, Typesense, or Elasticsearch. Includes indexing pipeline, query optimization, and autocomplete. Use when the goal asks to add search, indexing, or autocomplete to an app.

## Goal pattern

search indexing autocomplete algolia meilisearch elasticsearch typesense full-text search

## Parameters

- engine (choice [default: auto]): Search engine

## Steps

1. [analyst] Choose the search engine based on data volume, latency requirements, and budget. Set up the service (local Docker or hosted).

2. [analyst] Design the index schema: define searchable fields, filters, sorting attributes, and ranking rules. Configure synonyms and stopwords. (after: step-1)

3. [analyst] Build the indexing pipeline: write a script or webhook to sync data from the primary source (DB, CMS, API) to the search index. Handle creates, updates, and deletes. (after: step-2)

4. [analyst] Implement the search UI: add a search input with debounced queries, autocomplete dropdown, faceted filters, and pagination. Handle empty and error states. (after: step-3)

5. [analyst] Test and optimize: verify query relevance (hit quality), response times (< 100ms), and index freshness. Write analytics hooks to track popular queries. (after: step-4)

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
