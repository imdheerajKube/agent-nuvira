# ACCEPTANCE — the label workflow, end to end

Everything nuvira knows about whether a turn was *good* is either **derived** (a
tool ran, a check passed, an honesty flag fired) or **labelled** (a person said
so). The derived signals can only ever produce NEGATIVES: a user who says nothing
is not a user who is happy, so silence can never supply the positive class a
`P(accepted | features)` fit needs. This document is the end-to-end workflow for
supplying and using that label.

> **Doctrine, in one line:** the harness never invents a label. Recording the label
> and *using* it are separate decisions, and nothing routes on it.

---

## 1. The four label sources

| Tier | Source | Class supplied | How |
|---|---|---|---|
| 1 — derived | the correction signal | negatives only | automatic (a "still broken" next message) |
| 2 — **explicit** | you | **both** (the only source of `accepted`) | `nuvira rate`, or the dashboard Trace 👍/👎 |
| 3 — behavioural | inferred from what you did | both, weaker | automatic (`source: 'derived'`) |
| 4 — model-as-judge | an LLM | both, a prior | not built |

Every label carries its **provenance** (`cli` / `dashboard` / `derived`), so a fit
can weigh a human judgement above an inference.

## 2. Rate a turn (tier 2 — the one you give)

After a turn you liked or disliked:

```bash
nuvira rate good                  # the last turn was what you wanted
nuvira rate bad                   # it was not
nuvira rate bad -t trace-123      # rate a specific turn (see `nuvira trace list`)
```

The verdict lands on the turn's reasoning trace (`userVerdict`) and, when the turn
delivered an authored file, on that exact row of the quality corpus. In the
dashboard, the **Trace tab** shows the same control — a 👍/👎 under each trace.

## 3. Or don't — the behavioural tier (tier 3, inferred)

When you do not rate, three behaviours are read (`learning/behavioural-labels.ts`):

- **re-ask** — the next ask is near-verbatim the same (token-set Jaccard ≥ 0.9) → `rejected`
- **hand-edit** — the delivered file changed after the turn made it → `rejected`
- **unchanged-referenced** — the file is untouched AND your next message names it
  AND you did not report a regression → `accepted` (weak)

An untouched artifact **alone** is NOT a label. Raw silence stays `null` — the
same rule as an unrated turn.

## 4. See where you stand

```bash
nuvira rate --stats
```

prints the labelled count, the class balance, the provenance breakdown, the
per-pair record, and whether the fit can train yet. The dashboard's **Trace tab**
shows the same card (it renders the identical `acceptanceSummary`, so the two
cannot disagree). `nuvira doctor` also reports it as an advisory check:

```
Name: Acceptance / quality fit
not ready — 0 labelled turn(s); needs 20 with ≥5 of each class
```

It is a WARN until the floor is cleared — a product with no labels is working
correctly, it just has no measured quality signal yet.

## 5. Fit

`nuvira model explain "<task>"` prints a **read-only** `Acceptance` section: the
decision pair's own rated record and the harness-level fit.

- **Floor:** at least **20 labelled turns** with **≥ 5 of each class**. Below that
  it prints the reason instead of a number — an underfit probability shown as
  evidence is worse than showing nothing.
- **Deterministic:** the same corpus always yields the same coefficients.
- **Read-only:** nothing in the router imports it. A fitted number that moved a
  routing decision would be the exact defect this programme removes.

## 6. Export — ship the corpus

```bash
nuvira rate --export corpus.json        # full structure
nuvira rate --export corpus.csv         # flat, one column per feature
nuvira rate --export                    # no path → stdout, to pipe
```

The export is the SAME rows a fit here reads. In the dashboard, the Trace tab's
card has **Export JSON / Export CSV**.

## 7. Import / merge — join a corpus back

```bash
nuvira rate --import corpus.json        # plain union, deduped by trace
nuvira rate --merge  corpus.json        # reconcile against LOCAL labels (keeps local on conflict)
nuvira rate --merge  corpus.json --replace   # the incoming label wins on a conflict
```

`--import` stores the rows in an imported-labels store, read by the fit alongside
your own; a LOCAL label for the same trace wins. `--merge` additionally **reports
conflicts** (a trace the local record labels differently) and, with `--replace`,
lets the import win. The dashboard card has **Import…** (it reads the file and
posts its text).

## 8. Fit offline

```bash
npm run build:cli                       # once
node scripts/fit-acceptance.mjs corpus.csv
```

Runs the identical deterministic fit on an exported file — no live store, no
network, no model.

## 9. A worked run (measured)

```
$ nuvira rate --export corpus.csv
✔ Exported 24 labelled turn(s) to corpus.csv (csv).

$ nuvira rate --import corpus.json          # into a fresh store
✔ Imported 24 row(s) from corpus.json: 24 new, 0 already present.

$ nuvira rate --stats
   labelled turns: 24 (👍 12 / 👎 12)
   by pair:
      groq/m1: 👍 12 / 👎 12 (50%, n=24)
   fit: TRAINED — P(accepted | features) n=24 (12👍/12👎)
        verified   +2.27
        unverified -1.99
        flag       -1.99
        delivered  +0.00
        bias       +0.82
   read-only: nothing routes on this and no score is derived from it

$ node scripts/fit-acceptance.mjs corpus.csv
corpus: corpus.csv — 24 labelled turn(s)
fit: P(accepted | features) n=24 (12👍/12👎)
   verified   +2.27
   unverified -1.99
   flag       -1.99
   delivered  +0.00
   bias       +0.82
```

The live fit and the offline fit are byte-identical by construction.

## 10. What each command writes

| Action | Writes to |
|---|---|
| `nuvira rate <good\|bad>` | the turn's trace (`userVerdict`) + the matching corpus row |
| behavioural tiers | the same two places, `source: 'derived'` |
| `--export` | nothing — reads `collectLabelledTurns()` to a file/stdout |
| `--import` / `--merge` | `<memory>/acceptance-labels.jsonl` (`--replace` also rewrites local traces/corpus rows) |
| fit (`model explain`, `--stats`, doctor) | nothing — pure read |

## 11. Honest limits

- **Nothing routes on this.** It is a dataset and a read-only fit; no score moves
  a decision.
- **A few hundred rows with both classes** are what make the fit meaningful; the
  20/5 floor is only where it becomes *trainable*.
- **Labels are yours.** The harness never rates a turn on your behalf — the
  behavioural tier infers from what you DID, never from silence alone.
- **The feature set is small on purpose** (`verified` / `unverified` / `flag` /
  `delivered`) — measured flags, not vocabulary, so the fit cannot become the
  phrase-list defect one layer up.

See also `docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md` §8 for the design and
`docs/COMMANDS.md` §12.15 for the command reference.
