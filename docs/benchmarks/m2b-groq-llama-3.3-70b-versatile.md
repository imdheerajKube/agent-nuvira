---
benchmark_run: eval-1786376988714-ff59
provider: groq
model: llama-3.3-70b-versatile
date: 2026-08-10T15:49:48.714Z
suite: m2b
---
# Agent-Nuvira Evaluation: groq/llama-3.3-70b-versatile

- **Run ID:** eval-1786376988714-ff59
- **Duration:** 110.7s
- **Composite score:** 47.2%

## Reliability Metrics

| Metric | Value |
|--------|-------|
| Task completion rate | 22% |
| Test pass rate | 44% (4/9) |
| Avg time-to-fix | 24.3s |
| Edit accuracy | 78% |
| Token efficiency | 33% |
| Rollbacks | 0 |
| Dependency install success | 0% |
| Recovery rate (new approaches) | 13% |
| Total cost | $0.008220 |

## Per-Task Results

| Task | Status | Score | Time-to-fix | Deps | New ideas | Rework | Stuck |
|------|--------|-------|-------------|------|-----------|--------|-------|
| js-fizzbuzz-fix | ✅ Pass | 86% | 6.9s | — | — | — | — |
| js-closure-fix | ✅ Pass | 100% | 20.0s | — | 1x | 4 | — |
| py-fibonacci | ✅ Pass | 70% | 67.5s | — | 1x | 4 | — |
| js-queue | ❌ Fail | 16% | never | — | 1x | 4 | 🚧 |
| dep-local-module | ❌ Fail | 25% | never | — | 1x | 4 | 🚧 |
| js-anagram | ❌ Fail | 25% | never | — | 1x | 4 | 🚧 |
| js-continuation | ❌ Fail | 18% | never | — | 1x | 4 | 🚧 |
| py-multi-file | ❌ Fail | 20% | never | — | 1x | 4 | 🚧 |
| js-refactor-async | ✅ Pass | 65% | 2.7s | — | 1x | 4 | — |

## Experience Parity (stuck / rework)

| Metric | Value |
|--------|-------|
| Total rework turns | 32 |
| Avg rework turns / task | 3.6 |
| Stuck states | 5 (js-queue, dep-local-module, js-anagram, js-continuation, py-multi-file) |
