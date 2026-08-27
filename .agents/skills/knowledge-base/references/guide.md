# Knowledge Base Reference Guide

## Overview
Build a knowledge base system: document ingestion, search, versioning, and collaborative editing. Use when the goal is to create a searchable knowledge repository for a team or product.

## # knowledge-base

Build a knowledge base system: document ingestion, search, versioning, and collaborative editing. Use when the goal is to create a searchable knowledge repository for a team or product.

## Goal pattern

knowledge base wiki documentation search versioning collaborative editing docs

## Steps

0. [context-gatherer] Map the knowledge base: what content types (markdown, HTML, PDF)? What search requirements? Version control needed? Access control?

1. [planner] Design the knowledge base:
1. Storage: markdown files in git or database-backed
2. Search: full-text search (Meilisearch, Typesense, Algolia)
3. Versioning: git-based or database revisions
4. Editing: WYSIWYG or markdown editor
5. Navigation: categories, tags, related articles
6. Access control: public, team-only, role-based (after: 'step-0')

2. [runner] Build the knowledge base:
1. Create content storage layer
2. Implement search indexing
3. Build the editor interface
4. Add navigation and categorization
5. Implement access control
6. Seed with initial content (after: 'step-1')

3. [reviewer] Verify: create/edit articles, search functionality, version history, access control, navigation works. (after: 'step-2')

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
