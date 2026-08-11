---
benchmark_run: eval-1786379410595-6ipq
provider: gemini
model: gemini-2.5-flash
date: 2026-08-10T16:30:10.595Z
suite: m2b
---
# Agent-Nuvira Evaluation: gemini/gemini-2.5-flash

- **Run ID:** eval-1786379410595-6ipq
- **Duration:** 36.7s
- **Composite score:** 23.6%

## Reliability Metrics

| Metric | Value |
|--------|-------|
| Task completion rate | 0% |
| Test pass rate | 11% (1/9) |
| Avg time-to-fix | 3.9s |
| Edit accuracy | 61% |
| Token efficiency | 0% |
| Rollbacks | 0 |
| Dependency install success | 0% |
| Recovery rate (new approaches) | 0% |
| Total cost | $0.000000 |

## Per-Task Results

| Task | Status | Score | Time-to-fix | Deps | New ideas | Rework | Stuck |
|------|--------|-------|-------------|------|-----------|--------|-------|
| js-fizzbuzz-fix | ❌ Fail | 14% | never | — | 1x | 3 | 🚧 |
| js-closure-fix | ❌ Fail | 10% | never | — | 1x | 3 | 🚧 |
| py-fibonacci | ❌ Fail | 20% | never | — | 1x | 3 | 🚧 |
| js-queue | ❌ Fail | 16% | never | — | 1x | 4 | — |
| dep-local-module | ❌ Fail | 25% | never | — | 1x | 4 | — |
| js-anagram | ❌ Fail | 25% | never | — | 1x | 4 | — |
| js-continuation | ❌ Fail | 18% | never | — | 1x | 4 | — |
| py-multi-file | ❌ Fail | 20% | never | — | 1x | 4 | — |
| js-refactor-async | ✅ Pass | 65% | 3.9s | — | 1x | 4 | — |

## Experience Parity (stuck / rework)

| Metric | Value |
|--------|-------|
| Total rework turns | 33 |
| Avg rework turns / task | 3.7 |
| Stuck states | 3 (js-fizzbuzz-fix, js-closure-fix, py-fibonacci) |
| Provider interference (429/5xx/network — not stuck) | 6 (js-queue, dep-local-module, js-anagram, js-continuation, py-multi-file, js-refactor-async) |
