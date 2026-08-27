---
name: knowledge-base
description: Build a knowledge base system: document ingestion, search, versioning, and collaborative editing. Use when the goal is to create a searchable knowledge repository for a team or product.
version: 1.0.0
---

# knowledge-base

Build a knowledge base system: document ingestion, search, versioning, and collaborative editing. Use when the goal is to create a searchable knowledge repository for a team or product.

## Goal pattern

knowledge base wiki documentation search versioning collaborative editing docs

## Parameters

(none)

## Steps

1. [context-gatherer] Map the knowledge base: what content types (markdown, HTML, PDF)? What search requirements? Version control needed? Access control?

2. [planner] Design the knowledge base:
1. Storage: markdown files in git or database-backed
2. Search: full-text search (Meilisearch, Typesense, Algolia)
3. Versioning: git-based or database revisions
4. Editing: WYSIWYG or markdown editor
5. Navigation: categories, tags, related articles
6. Access control: public, team-only, role-based (after: step-0)

3. [runner] Build the knowledge base:
1. Create content storage layer
2. Implement search indexing
3. Build the editor interface
4. Add navigation and categorization
5. Implement access control
6. Seed with initial content (after: step-1)

4. [reviewer] Verify: create/edit articles, search functionality, version history, access control, navigation works. (after: step-2)
