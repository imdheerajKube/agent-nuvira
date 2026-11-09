# Attachment retrieval — exercise record and decision log

**Date:** 2026-11-09
**Status:** lexical upgrades implemented and benchmarked; real-query validation pending
**Scope:** `attachment_search` retrieval quality. Ingestion, extraction, prompting, and chat UI are out of scope.
**Measured evidence:** [BENCH_ATTACHMENT_RETRIEVAL_2026-11-09.md](BENCH_ATTACHMENT_RETRIEVAL_2026-11-09.md)

## 1. Why this was done

When a user asks a question about an attached document, the answer is only useful if retrieval puts the passage containing it in the top results. The shipped keyword path had a concrete defect, and the obvious next question was whether semantic embeddings were worth their cost.

The exercise was deliberately ordered cheapest-first:

1. Fix the keyword stopword/no-content bug.
2. Measure retrieval on a realistic attachment benchmark.
3. Try cheaper lexical upgrades — identifier-aware tokenization and fuzzy/trigram matching — before adding embeddings.
4. Reconsider semantic retrieval only if real questions still show paraphrase or typo failures that lexical retrieval cannot handle.

No embedding index or hybrid fusion was added.

## 2. The original defect

`attachment-search` keyword scoring kept short function words such as `is`, `of`, `at`, and `who`. Those terms carried no topic signal and could match inside ordinary words, so an unrelated question could score almost every chunk. A question made entirely of function words, such as “Who is it?”, had no useful content at all.

The fix is in `src/web-dashboard/attachment-store.ts`:

- `queryTerms()` now uses the shared `STOPWORDS` set from `src/learning/lexical-search.ts`.
- A query with no content terms returns zero hits instead of ranking arbitrary chunks.
- Two-character identifier pieces such as `v3` still survive because they are not stopwords.

Regression tests cover both “What is the capital of France?” and “who is it”.

## 3. What changed

| File | Change |
|---|---|
| `src/web-dashboard/attachment-store.ts` | Shared stopword filtering and a no-content guard for keyword search. |
| `src/learning/lexical-search.ts` | Opt-in `identifierAware` tokenization, opt-in `fuzzy` fallback, and `fuzzyThreshold`. |
| `tests/web-dashboard/attachment-store.test.ts` | No-content and unrelated-question regression tests. |
| `tests/learning/lexical-search.test.ts` | Identifier tokenization, fuzzy similarity, typo recovery, and no-leak tests. |
| `scripts/bench/attachment-retrieval.ts` | Six-arm benchmark, `--fixture`, `--report`, `--no-semantic`, and real/synthetic dataset labels. |
| `scripts/bench/fixtures/attachment-retrieval.json` | 24 synthetic cases over five fixture documents. |
| `scripts/bench/fixtures/attachments/` | Five synthetic attachments used by the fixture. |
| `docs/BENCH_ATTACHMENT_RETRIEVAL_2026-11-09.md` | Generated benchmark report. |

### Identifier-aware tokenization

`identifierTokens()` emits a dotted, hyphenated, underscored, or otherwise compound identifier **both whole and split**. For example, `v3.5.15`, `WH-8821`, and `ERR_DB_POOL_EXHAUSTED` remain findable by their exact form and by the words or segments inside them.

The baseline `contentTokens()` path is unchanged, so the original BM25 behavior remains available for comparison.

### Fuzzy typo fallback

When a query term has no exact posting and is at least four characters long, BM25 can score the closest vocabulary term. Similarity is the maximum of:

- character-trigram Dice similarity, and
- normalized Levenshtein similarity.

The default threshold is `0.75`. The fallback only considers candidates that:

- have the same first character, and
- differ in length by at most three characters.

Those guards are a latency and false-positive trade-off. They deliberately miss first-letter typos and very large insertions; if real data shows those are common, the guards must be revisited and measured again.

## 4. Benchmark design

The benchmark asks one narrow question: **does the arm put the passage containing the answer in the top k?**

Six arms run over the same chunks:

| Arm | What it measures |
|---|---|
| `keyword (shipped)` | The existing attachment keyword scorer. |
| `bm25` | The repository BM25 ranker without embeddings. |
| `bm25-id` | BM25 with identifier-aware tokenization. |
| `bm25-id+fuzzy` | `bm25-id` plus the typo fallback. |
| `semantic (bge-small)` | `Xenova/bge-small-en-v1.5` over child windows. |
| `hybrid (bm25 + semantic)` | Reciprocal-rank fusion of BM25 and semantic results. |

Semantic retrieval embeds 1,800-character child windows with 200-character overlap and maps each window back to its parent chunk. This avoids the embedder's 2,000-character truncation while keeping the scored unit large enough to contain an answer.

The synthetic corpus is five documents, 13 chunks, and 26 child windows. The fixture has 24 cases:

- 6 exact
- 6 paraphrase
- 4 typo
- 4 structure
- 3 unanswerable
- 1 adjacent

Twenty cases are answerable. Leak rate is computed over the three unrelated questions. The adjacent question is reported separately because domain-adjacent vocabulary can legitimately match.

The semantic floor is the production knowledge-base default, `0.5`, not a value tuned on this fixture.

## 5. Results

Synthetic fixture, one run. Mean query times for lexical arms are sub-millisecond and round to zero in this table.

| Retriever | Recall@1 | Recall@5 | MRR | Leak rate | Adjacent retrieved | Mean query ms |
|---|---:|---:|---:|---:|---:|---:|
| keyword (shipped) | 65% | 85% | 0.73 | 0% | 100% | <1 |
| bm25 | 65% | 80% | 0.70 | 0% | 100% | <1 |
| bm25-id | 75% | 85% | 0.78 | 0% | 100% | <1 |
| **bm25-id+fuzzy** | **80%** | **95%** | **0.85** | **0%** | **100%** | **<1** |
| semantic (bge-small) | 85% | 95% | 0.89 | 0% | 100% | ~100 |
| hybrid (bm25 + semantic) | 80% | 95% | 0.86 | 0% | 100% | ~100 |

Cold ingestion took 12 ms. The cold semantic index build took 3,979 ms for 26 child windows, including model load. A deployed process would warm the model and precompute embeddings at ingest, so the cold number is not a steady-state query cost; the ~100 ms mean query cost is the more relevant comparison.

### What moved

- **Stopword fix:** unrelated-question leakage fell to 0 of 3. Removing accidental matches also cost keyword recall; the prior higher keyword number was partly an artifact of function words matching inside ordinary words.
- **Identifier-aware tokenization:** BM25 moved from 80% to 85% recall@5 and from 0.70 to 0.78 MRR by recovering dotted and hyphenated identifiers without a model.
- **Fuzzy fallback:** `bm25-id+fuzzy` reached 95% recall@5, 0.85 MRR, and 4 of 4 typo cases with no embeddings.
- **Semantic:** 95% recall@5 and 0.89 MRR. It gains five points of recall@1 and 0.04 MRR over the best lexical arm, at roughly 100× the query time on this corpus.
- **Hybrid:** 95% recall@5 and 0.86 MRR. It did not beat semantic and adds a second retrieval system, so reciprocal-rank fusion is not justified by this evidence.

### The remaining miss

Every arm missed the same paraphrase question: **“Who gets woken?”** The expected passage is `page the on-call engineer`. Semantic retrieval did not solve it either. That is evidence that “add embeddings” is not a general paraphrase fix.

## 6. Decisions

### D1 — Fix the keyword leak immediately

The stopword/no-content behavior was a defect, not a tuning choice. It is fixed and covered by regression tests.

### D2 — Keep the lexical upgrades opt-in

`identifierAware` and `fuzzy` are options on `bm25Search`, not defaults. This keeps the baseline comparable and avoids silently changing every BM25 caller, including the knowledge base.

### D3 — Do not add embeddings on synthetic evidence

The synthetic run does not justify an embedding index. Semantic does not beat the best lexical arm on recall@5, its MRR advantage is small, and it costs roughly two orders of magnitude more per query.

### D4 — Do not choose hybrid

Hybrid did not improve recall@5 over semantic and did not beat the best lexical arm on MRR. Fusion should only be reconsidered if real data shows complementary misses.

### D5 — Real questions are the shipping gate

Synthetic labels are authored and one query per case is not a user sample. Neither the lexical upgrade nor semantic retrieval should ship on this fixture alone. Real questions must be captured before the shipping decision.

## 7. Future action and revisit triggers

This section is the part to read before changing attachment retrieval again.

### P0 — Capture a real fixture

Collect real attachment questions and the passage each answer requires. Capture the question **before** retrieval runs, and label the expected passage from the document, not from whatever retrieval returned. Do not author paraphrases and label them real.

Minimum useful set before making a shipping decision:

- at least 20 answerable questions,
- at least 3 unanswerable questions,
- at least 5 paraphrase cases,
- at least 5 typo cases,
- at least 2 document types.

If fewer are available, run the benchmark and label the result directional; do not use it as a release gate.

### P1 — Run the real benchmark when the fixture exists

```bash
npm run bench:attachments -- \
  --fixture=/path/to/real-fixture.json \
  --report=docs/BENCH_ATTACHMENT_RETRIEVAL_REAL.md
```

Use `--no-semantic` for a lexical-only run, or when the embedder is unavailable.

Pre-register the decision rule before seeing results. A proposed rule:

- **Keep `bm25-id+fuzzy`** if semantic improves recall@5 by less than 10 percentage points and MRR by less than 0.05, with no increase in leak rate.
- **Make semantic-only the candidate** only if it wins by at least 10 percentage points recall@5 or at least 0.05 MRR, wins at least two cases, and does not increase leakage. Measure p95 latency on the real corpus before accepting the cost.
- **Reconsider hybrid** only if lexical and semantic miss at least three different cases and fusion beats both by at least 10 percentage points recall@5. Otherwise do not add it.
- **If neither materially beats the lexical arm, ship the lexical arm.**

These thresholds are a starting point, not a statistical guarantee. With small sets, one or two cases move the percentages substantially.

### P2 — Ship the lexical upgrade if the real run supports it

If the real run shows no material semantic advantage, make `identifierAware` plus `fuzzy` the shipped attachment-search path. Keep the old keyword scorer only as a regression baseline or remove it in a separate, reviewed change.

Before shipping, measure p95 query latency on a large attachment corpus. The fuzzy fallback iterates the vocabulary only for terms with no exact posting, and the first-character/length guards bound that work, but the bound has not been measured on production-sized attachments.

### P3 — If semantic wins, design semantic-only

Do not ship hybrid by default.

A semantic-only design would need:

- embedding at ingest, not on every query,
- a model-load and warm-up path,
- storage for child-window vectors,
- a fallback to lexical retrieval when the embedder is unavailable,
- privacy review for sending attachment text to an embedding model,
- a re-embedding path when the model changes.

The benchmark's child-window design is the starting point: 1,800-character windows with 200-character overlap, mapped back to parent chunks.

### P4 — Re-run when retrieval inputs change

Run the benchmark again after any of these:

- a change to attachment chunking or extraction,
- a change to `identifierTokens`, `contentTokens`, BM25 parameters, or the fuzzy threshold,
- a change to the embedding model, floor, or window size,
- a change to the attachment store's search scoring,
- a new document type in the real fixture,
- enough new real questions to change the fixture's balance.

Do not reuse this report after the code it measured has changed.

## 8. Real-fixture format

The benchmark accepts a JSON file. `attachmentsDir` is resolved relative to the fixture file and defaults to `attachments`.

```json
{
  "description": "Questions captured from attachment turns.",
  "source": "real",
  "attachmentsDir": "attachments",
  "k": 5,
  "documents": ["incident-report.md", "contract.md"],
  "cases": [
    {
      "id": "incident-p99",
      "document": "incident-report.md",
      "question": "What was the latency at the start?",
      "kind": "typo",
      "expect": "p99 latency alert"
    },
    {
      "id": "unrelated-payroll",
      "document": "contract.md",
      "question": "What is the capital of France?",
      "kind": "unanswerable",
      "expect": null
    }
  ]
}
```

Rules:

- `source` must be `"real"` only when the questions came from actual users.
- `documents` must name files under `attachmentsDir`.
- `expect` is a case-insensitive substring match after whitespace normalization. It must be an exact passage marker from the document.
- `kind` is one of `exact`, `paraphrase`, `typo`, `structure`, `unanswerable`, or `adjacent`.
- `unanswerable` cases must expect `null` and must retrieve nothing.
- `adjacent` cases are reported separately and are not counted as leaks.

## 9. Verification at the time of this record

- `npx vitest run tests/learning/lexical-search.test.ts tests/web-dashboard/attachment-store.test.ts` — 26 tests passed.
- `npm run bench:attachments` — passed; generated the report linked at the top.
- `npx tsc --noEmit` — passed.
- Fixture integrity check — 24 cases, 20 answerable, all expected passages present in their documents.
- An earlier focused run hit the existing same-millisecond ordering flake in the attachment retention test once; it passed on rerun, and that code path was not changed by this exercise.

No commit was made as part of the exercise. `requests/` is an unrelated untracked Python Requests checkout and must stay out of commits.

## 10. Known limits

- The measured fixture is synthetic, with authored labels and one query per case.
- Five documents and 20 answerable cases are enough to rank the arms directionally, not to estimate production accuracy.
- The semantic floor was not tuned on the fixture.
- The cold index time includes model load and is not a steady-state query cost.
- The real attachment store and real user questions were not present in this checkout, so no real-query result exists yet.
- The fuzzy first-character and length guards are deliberate; first-letter typos and large insertions are out of scope until real data says otherwise.
- The benchmark measures retrieval, not whether the final answer is correct or whether the model uses the retrieved passage well.

## 11. Open questions

1. How often do real attachment questions contain paraphrases with no shared vocabulary?
2. How often are typos first-letter errors rather than internal substitutions?
3. What is the p95 query latency on attachments near the ingest limit?
4. Is the ~100 ms semantic query cost acceptable for the product's interaction budget once the model is warm?
5. Does sending attachment text to an embedding model satisfy the product's privacy expectations?
6. Do users ask questions across multiple attachments, a case this fixture does not cover?
