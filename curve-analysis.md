# Cache hit rate and cost as a function of conversation length

Measured on `deepseek-flash`, thinking disabled, ~20,000-token stable block, 30 turns
per variant. Raw per-turn data: `report-2026-10-05T10-57-29.md` / `.json`.

This exists to answer a question a reader raised on the write-up:

> The amortization depends heavily on session length: if most of your sessions are
> only 2-3 turns, the cold turn-1 miss dominates and the win shrinks fast. Did you
> look at the hit-rate curve as a function of conversation length? That distribution
> is what decides whether this is a 95% win or a rounding error for a given app.

## Amortised cost per turn

If a session only runs N turns, what does each turn actually cost on average?
The turn-1 miss is unavoidable and gets spread across the rest of the session, so
short sessions carry it disproportionately.

| Session length | A (avg/turn) | B (avg/turn) | C (avg/turn) | C vs A |
| --- | --- | --- | --- | --- |
| 1 turn | $0.002573 | $0.002574 | $0.002575 | ~0% |
| 2 turns | $0.002584 | $0.001339 | $0.001342 | −48.0% |
| 3 turns | $0.002590 | $0.000930 | $0.000932 | −64.0% |
| 5 turns | $0.002602 | $0.000609 | $0.000599 | −77.0% |
| 10 turns | $0.002625 | $0.000383 | $0.000350 | −86.7% |
| 20 turns | $0.002673 | $0.000301 | $0.000229 | −91.4% |
| 30 turns | $0.002723 | $0.000301 | $0.000189 | −93.1% |

**At 1 turn there is no saving at all.** C's prompt is marginally longer (the volatile
header rides in the user turn), so it is fractionally *more* expensive. There is no
history to amortise the cold miss over.

**At 2-3 turns the win is real but partial** — 48% and 64%. An app where users
routinely stop after two messages gets roughly half the headline number.

**By 10 turns it is ~87%, and it asymptotes in the low 90s.**

## The mechanism, and why B and C diverge

The aggregate numbers hide the more interesting result, which is visible in the raw
cache-hit token counts:

| Turn | B hit tokens | C hit tokens |
| --- | --- | --- |
| 2 | 16,896 | 16,896 |
| 5 | 16,896 | 17,280 |
| 10 | 16,896 | 17,664 |
| 15 | 16,896 | 18,176 |
| 20 | 16,896 | 18,688 |
| 25 | 16,896 | 19,200 |
| 30 | 16,896 | 19,584 |

**B never moves.** 16,896 = 264 × 64, and 64 looks like the cache granularity. Because
B's system message changes every turn, only the stable block ahead of the header can
ever be reused — conversation history is permanently excluded from the cache.

**C keeps climbing**, because its system message is frozen and its history is
append-only, so each turn's cached prefix includes everything before it.

The consequence shows up in per-turn cost:

| | Turn 2 | Turn 30 | Change |
| --- | --- | --- | --- |
| B hit rate | 98.9% | 90.5% | decaying |
| C hit rate | 98.7% | 98.7% | flat |
| B cost/turn | $0.000104 | $0.000333 | **3.2×** |
| C cost/turn | $0.000110 | $0.000110 | flat |

So B and C are not near-equivalent, which an 8-turn run makes them look. B's advantage
*decays* as the conversation grows. At 8 turns the gap between them was 0.7 percentage
points and indistinguishable from noise; at 30 turns it is structural.

## Full-run totals

| Variant | Cache hit rate | Total input tokens | Cumulative cost | Cost per turn | vs A |
| --- | --- | --- | --- | --- | --- |
| A | 0.0% | 539,113 | $0.081702 | $0.002723 | — |
| B | 91.4% | 536,080 | $0.009043 | $0.000301 | −88.9% |
| C | 95.9% | 552,670 | $0.005675 | $0.000189 | −93.1% |

Excluding the cold first turn (steady state):

| Variant | Cost per turn | vs A |
| --- | --- | --- |
| A | $0.002729 | — |
| B | $0.000223 | −91.8% |
| C | $0.000107 | **−96.1%** |

The whole 30-turn × 3-variant run cost **$0.09642**.

## What this means for a given app

The headline "96% cheaper" is the steady-state figure and only holds once sessions
are long enough for the prefix to dominate. The honest decision rule:

- **Sessions of 1-2 turns**: not worth restructuring for. There is nothing to amortise.
- **Sessions of 3-10 turns**: real, in the 64-87% range. Worth doing, don't quote 96%.
- **Sessions of 10+ turns**: the full effect, ~90%+.

Which is exactly the reader's point, and the reason this benchmark exists rather than
a single headline number.
