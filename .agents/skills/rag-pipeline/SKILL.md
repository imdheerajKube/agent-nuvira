---
name: rag-pipeline
description: Build a Retrieval-Augmented Generation pipeline: document ingestion, chunking, retrieval, answer generation, citations, and retrieval-recall tests under morphology, identifiers and passage boundaries. Use when the goal is to let an LLM answer questions from documents or a custom knowledge base. Do not claim completion on code-path tests alone.
version: 1.1.1
---

# rag-pipeline

Build a Retrieval-Augmented Generation pipeline: document ingestion, chunking, retrieval, answer generation, citations, and retrieval-recall tests under morphology, identifiers and passage boundaries. Use when the goal is to let an LLM answer questions from documents or a custom knowledge base. Do not claim completion on code-path tests alone.

## Goal pattern

RAG retrieval augmented generation vector embedding knowledge base document ingestion chunking retrieval LLM context document question answering recall morphology identifiers citations

## Parameters

(none)

## Steps

1. [context-gatherer] Map the data and the acceptance set BEFORE coding. Formats (PDF, Markdown, HTML, CSV, JSON, DOCX)? How many documents? Which LLM for answers? If an embedding/vector store is not explicitly required, lexical retrieval with no external service is a valid design. Write a small dev corpus and a recall set: (a) exact document wording, (b) morphological variants (crash/crashes, policy/policies), (c) dotted/hyphenated identifiers (9.4.0, WH-8821), (d) a reordered question with the same content words, (e) a fact two paragraphs away from the only lexical match, (f) an unanswerable question that must refuse. This set is the acceptance test.

2. [planner] Design the pipeline and its recall tests:
1. Ingestion: one parser per format, every passage carries file + line/row/page/section.
2. Chunking: keep heading context; small documents may be one chunk; use overlap; never split a fact from its heading/section.
3. Normalization: casefold, stopwords, and stem -ies/-es/-s (crashes -> crash, policies -> policy) — a bare trailing-s strip turns crashes into crashe. Keep dotted/hyphenated identifiers whole and also split them.
4. Retrieval: BM25 plus a fuzzy/trigram fallback; expand same-file neighbours at least two hops so a fact two paragraphs from the lexical match is in context.
5. Generation: only retrieved text, inline citations, refuse when the passages do not answer.
6. Evaluation: run the recall set, precision@k, and refusal correctness before declaring done. (after: step-0)

3. [runner] Implement the pipeline AND the recall tests:
1. Parsers with citable locators for every declared format.
2. Tokenizer: compound-aware regex ([a-z0-9]+(?:[._@+'-][a-z0-9]+)*); stem -ies -> y, -es -> empty, -s -> empty with ss/short-word guards; emit compound tokens whole and split.
3. Index: persisted, atomic, reloadable by a second process.
4. Retrieval: BM25 (k1=1.5, b=0.75) + trigram/fuzzy; same-file neighbour expansion to two hops with score decay; top-k bounded.
5. Answering: grounded prompt; parse BOTH citation forms the model emits in practice — `[n]` and fullwidth `【n】` — and build sources from cited ids. If the model still cites nothing after one repair, attach the top-scoring retrieved passage(s) rather than returning `sources: []`: a correct answer with no source fails the contract.
6. Tests: assert the recall set, not just imports and happy-path code: crashes/crash, policies/policy, a dotted/hyphenated identifier (9.4.0, WH-8821), two-hop boundary, refusal, and that every answerable case has a non-empty `sources` naming the expected file. A failing recall case is a bug in retrieval/citation, not a docs gap. (after: step-1)

4. [reviewer] Run the recall set before claiming completion. For every answerable case the expected file must be cited and the fact must appear in the answer; the unanswerable case must refuse with no sources. Include an identifier case (WH-8821 or 9.4.0) and assert `sources` is non-empty — a correct answer with `sources: []` fails. If any case fails, fix the tokenizer, citation parser (including `【n】`), chunking, or neighbour expansion and rerun. Report the exact command and pass/fail per case. A green unit-test suite that never asks a differently-worded question is NOT evidence of retrieval recall — do not report success on code-path tests alone. (after: step-2)
