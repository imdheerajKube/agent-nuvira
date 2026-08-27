# Rag Pipeline Reference Guide

## Overview
Build a Retrieval-Augmented Generation pipeline: document ingestion, chunking, embedding, vector storage, retrieval, and LLM answer generation. Use when the goal is to let an LLM answer questions from a custom knowledge base.

## # rag-pipeline

Build a Retrieval-Augmented Generation pipeline: document ingestion, chunking, embedding, vector storage, retrieval, and LLM answer generation. Use when the goal is to let an LLM answer questions from a custom knowledge base.

## Goal pattern

RAG retrieval augmented generation vector embedding knowledge base document ingestion chunking retrieval LLM context

## Steps

0. [context-gatherer] Map the data: what document formats (PDF, Markdown, HTML)? How many documents? What embedding model? What vector store (Pinecone, Weaviate, ChromaDB, pgvector)? What LLM for generation?

1. [planner] Design the RAG pipeline:
1. Ingestion: parse documents, extract text, handle images/tables
2. Chunking: choose strategy (fixed-size, semantic, recursive) with overlap
3. Embedding: select model (OpenAI ada-002, Cohere, sentence-transformers)
4. Vector store: index embeddings with metadata
5. Retrieval: semantic search + hybrid (keyword + vector) + re-ranking
6. Generation: inject retrieved context into LLM prompt, cite sources
7. Evaluation: measure retrieval precision, answer accuracy, hallucination rate (after: 'step-0')

2. [runner] Implement the pipeline:
1. Build document parser (handle PDF, MD, HTML)
2. Implement chunking with configurable size/overlap
3. Generate embeddings and store in vector DB
4. Implement retrieval with similarity threshold
5. Build generation prompt with retrieved context
6. Add source citation and confidence scoring (after: 'step-1')

3. [reviewer] Evaluate: test with 20 queries, measure retrieval relevance (precision@5), answer accuracy, hallucination rate. Report results and optimize chunking/retrieval parameters. (after: 'step-2')

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
