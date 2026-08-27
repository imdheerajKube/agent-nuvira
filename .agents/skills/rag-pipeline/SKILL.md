---
name: rag-pipeline
description: Build a Retrieval-Augmented Generation pipeline: document ingestion, chunking, embedding, vector storage, retrieval, and LLM answer generation. Use when the goal is to let an LLM answer questions from a custom knowledge base.
version: 1.0.0
---

# rag-pipeline

Build a Retrieval-Augmented Generation pipeline: document ingestion, chunking, embedding, vector storage, retrieval, and LLM answer generation. Use when the goal is to let an LLM answer questions from a custom knowledge base.

## Goal pattern

RAG retrieval augmented generation vector embedding knowledge base document ingestion chunking retrieval LLM context

## Parameters

(none)

## Steps

1. [context-gatherer] Map the data: what document formats (PDF, Markdown, HTML)? How many documents? What embedding model? What vector store (Pinecone, Weaviate, ChromaDB, pgvector)? What LLM for generation?

2. [planner] Design the RAG pipeline:
1. Ingestion: parse documents, extract text, handle images/tables
2. Chunking: choose strategy (fixed-size, semantic, recursive) with overlap
3. Embedding: select model (OpenAI ada-002, Cohere, sentence-transformers)
4. Vector store: index embeddings with metadata
5. Retrieval: semantic search + hybrid (keyword + vector) + re-ranking
6. Generation: inject retrieved context into LLM prompt, cite sources
7. Evaluation: measure retrieval precision, answer accuracy, hallucination rate (after: step-0)

3. [runner] Implement the pipeline:
1. Build document parser (handle PDF, MD, HTML)
2. Implement chunking with configurable size/overlap
3. Generate embeddings and store in vector DB
4. Implement retrieval with similarity threshold
5. Build generation prompt with retrieved context
6. Add source citation and confidence scoring (after: step-1)

4. [reviewer] Evaluate: test with 20 queries, measure retrieval relevance (precision@5), answer accuracy, hallucination rate. Report results and optimize chunking/retrieval parameters. (after: step-2)
