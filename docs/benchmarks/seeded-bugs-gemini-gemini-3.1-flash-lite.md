# Seeded-bug benchmark

- **Provider / model:** `gemini/gemini-3.1-flash-lite`
- **Date:** 2026-10-05
- **Duration:** 355.9s
- **Composite:** 60% — 40% found + 40% fixed + 20% for touching nothing else (the last only counts when the task was actually fixed)

## Results

| Task | Axis | Difficulty | Found | Fixed | Touched nothing else | Composite |
|---|---|---|---|---|---|---|
| `seed-range-off-by-one` | boundary | easy | no | no | yes | 0% |
| `seed-top-scores-lexical-sort` | comparator | easy | no | no | yes | 0% |
| `seed-sum-async-for-each` | async | medium | no | yes | yes | 60% |
| `seed-format-amount-falsy-zero` | truthiness | easy | yes (falsy) | yes | yes | 100% |
| `seed-clone-config-shallow` | aliasing | medium | yes (shallow) | yes | yes | 100% |
| `seed-add-tag-mutates-input` | mutation | easy | yes (mutat) | yes | yes | 100% |
| `seed-average-filtered-denominator` | aggregation | medium | no | yes | yes | 60% |

## Summary

- Found the defect: **3/7**
- Fixed it: **5/7**
- Fixed it without touching anything else: **5/7**
- Claimed success without fixing it (false success): **2/7** (29% of claims)
- Time to green (median across fixed tasks): **56.3s**

## How to read this

- **Found** is read from what the run REPORTED, matched against the diagnostic
  vocabulary declared with the defect. An agent can fix a defect it never explained, and
  explain one it never fixed,
  which is why the two columns are separate.
- **Fixed** is ground truth: the same checks that failed before the run passed after it.
- **False success** is the run's own success flag against ground truth: a run that declared itself
  finished while its checks still failed. The denominator is the runs that CLAIMED success, not
  every task — a run that reported failure cannot produce a false success.
- **Time to green** is the median wall-clock from a task starting to its checks passing, over the
  tasks that were actually fixed. A task that was never fixed contributes no green time.
- **Touched nothing else** diffs every seeded file against its original content and lists files
  the seed never had, so a fix that rewrites unrelated code cannot look like a clean one. It
  is scored as a modifier on a FIX, not as credit of its own — a run that changed nothing
  satisfies "changed nothing it should not have" trivially, and earns 0.
- Every task is verified BEFORE it is scored — a seed that already passes its checks aborts the
  run rather than contributing a number.
