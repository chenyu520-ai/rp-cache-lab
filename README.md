# rp-cache-lab

**How much does your prompt structure cost you?**

A small benchmark that measures how the placement of a ~30-token volatile header
changes DeepSeek's prompt cache hit rate — and therefore your bill.

Two measured results:

- **8-turn run:** moving the header cut steady-state cost by 96%.
- **30-turn run:** the same change cut the full-session cost by 93%, and revealed
  that the "minimal fix" quietly decays as conversations get longer.

📄 Write-up: [Your system prompt is silently killing your prompt cache](https://dev.to/chenyu-ai/your-system-prompt-is-silently-killing-your-prompt-cache-28oa)
📈 Curve analysis: [`curve-analysis.md`](curve-analysis.md)

---

## Why this exists

DeepSeek's context caching is enabled by default and needs no code changes.
Cached input costs **50x less** than uncached input — $0.003 vs $0.15 per million
tokens, off-peak.

But a cache hit requires a **full match** against a persisted cache prefix unit.
Prefix caching is all-or-nothing at the point of divergence: put a timestamp, a
turn counter, or a session id near the start of your `system` message, and
everything after it is new content as far as the cache is concerned. Even if
99.99% of the bytes are identical to the previous request.

Most chat and roleplay apps do exactly that, and pay for it on every turn.

## What it measures

Three variants. The stable content — character card, world book with 20 lorebook
entries, long-term memory, relationship state, roughly 20,000 tokens — is
**byte-identical across all three**. Only the placement of a small volatile
header differs:

```
Session context: local time <ISO timestamp>, turn <n>, session <uuid>, mood index <0.00>.
```

| Variant | Where the volatile header goes | Typical of |
| --- | --- | --- |
| **A — naive** | Front of the `system` message | Most first implementations |
| **B — minimal fix** | End of the `system` message | A one-line change from A |
| **C — optimized** | End of the newest `user` turn; the system message never changes | Append-only architecture |

Every number comes from the API's own `usage` fields —
`prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. Nothing is modelled.

## Results

### 30-turn run (2026-10-05)

| Variant | Cache hit rate | Total input tokens | Cumulative cost | Cost per turn | vs A |
| --- | --- | --- | --- | --- | --- |
| A | 0.0% | 539,113 | $0.081702 | $0.002723 | — |
| B | 91.4% | 536,080 | $0.009043 | $0.000301 | −88.9% |
| C | 95.9% | 552,670 | $0.005675 | $0.000189 | −93.1% |

Excluding the cold first turn:

| Variant | Cost per turn | vs A |
| --- | --- | --- |
| A | $0.002729 | — |
| B | $0.000223 | −91.8% |
| C | $0.000107 | **−96.1%** |

### How the win depends on session length

The turn-1 miss is unavoidable, so short sessions carry it disproportionately.

| Session length | A avg/turn | C avg/turn | C vs A |
| --- | --- | --- | --- |
| 1 turn | $0.002573 | $0.002575 | ~0% |
| 2 turns | $0.002584 | $0.001342 | −48.0% |
| 3 turns | $0.002590 | $0.000932 | −64.0% |
| 5 turns | $0.002602 | $0.000599 | −77.0% |
| 10 turns | $0.002625 | $0.000350 | −86.7% |
| 20 turns | $0.002673 | $0.000229 | −91.4% |
| 30 turns | $0.002723 | $0.000189 | −93.1% |

**If your sessions are 1-2 turns, this change is not worth making.** If they are
10+, you get the full effect. Details and the full per-turn tables are in
[`curve-analysis.md`](curve-analysis.md).

### B is not equivalent to C

An 8-turn run makes the "minimal fix" (B) look as good as the proper fix (C) — the
gap was 0.7 percentage points. Over 30 turns it is structural:

| | Turn 2 | Turn 30 | Change |
| --- | --- | --- | --- |
| B hit rate | 98.9% | 90.5% | decaying |
| C hit rate | 98.7% | 98.7% | flat |
| B cost/turn | $0.000104 | $0.000333 | **3.2×** |
| C cost/turn | $0.000110 | $0.000110 | flat |

B's cache-hit tokens are frozen at exactly 16,896 for all 30 turns (264 × 64 — 64
appears to be the cache granularity). Because its system message changes every
turn, only the stable block ahead of the header can be reused, and history is
permanently excluded. C's hit tokens climb from 16,896 to 19,584 because its
system message is frozen and its history is append-only.

### 8-turn run (2026-10-04)

The original run, kept because the discussion quotes it.

| Variant | Cache hit rate | Cost for 8 turns | Cost per turn | vs A |
| --- | --- | --- | --- | --- |
| A | 0.0% | $0.021006 | $0.002626 | — |
| B | 85.8% | $0.003465 | $0.000433 | −83.5% |
| C | 86.8% | $0.003326 | $0.000416 | −84.2% |

## Running it

Requires Node.js 18+ (uses the built-in `fetch`).

```bash
# See the plan and a worst-case cost estimate. Sends nothing.
node bench.js --dry-run

# Prove the three variants differ as claimed, using zero API calls.
node bench.js --self-test --dry-run

# Live run. Needs a DeepSeek API key in the environment.
export DEEPSEEK_API_KEY=sk-...
node bench.js

# Longer run (30 turns) — about $0.10
node bench.js --turns 30 --budget 1.00
```

On Windows PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = 'sk-...'
node bench.js
```

A default live run sends 24 requests (3 variants × 8 turns) and costs roughly
**$0.03**. The 30-turn run sends 90 requests and cost **$0.096**. There is a
hard budget guard that refuses to start if the worst-case estimate exceeds
`--budget` (default $0.30).

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model` | `deepseek-flash` | Also supports `deepseek-v4-pro` |
| `--prefix-tokens` | `20000` | Size of the synthetic stable block |
| `--turns` | `8` | Turns per variant |
| `--max-tokens` | `64` | Output cap per request |
| `--budget` | `0.30` | Refuse to run above this worst-case estimate (USD) |
| `--dau` | `1000` | Projection: daily active users |
| `--app-turns` | `50` | Projection: turns per user per day |
| `--thinking` | `disabled` | `disabled` or `enabled` |
| `--dry-run` | off | Estimate only, send nothing |
| `--self-test` | off | Verify prompt structure, send nothing |

## The self test

`--self-test` diffs the serialized request bodies of turn 1 and turn 2 and
reports how many bytes are identical. It costs nothing and it is the fastest way
to see the mechanism:

| Variant | Request bytes | Identical prefix | Share |
| --- | --- | --- | --- |
| A | 84,665 | **75** | **0.1%** |
| B | 84,665 | 84,493 | 99.8% |
| C | 84,665 | 84,664 | 100.0% |

75 bytes out of 84,665.

## A note on the run salt

Each run generates a random id and prepends it to every variant's stable block.
Without it, variant C would hit cache units written by variant B (they share the
same leading bytes), and a second run would hit cache left by the first. The salt
keeps the three variants independent and the cold start genuine. It also means
absolute costs are not comparable across runs — only within one.

## The other free win

**Thinking mode is enabled by default** on this model family, with effort set to
`high`, and reasoning tokens are billed as output. Chat and roleplay apps rarely
need a chain of thought.

```json
{ "thinking": { "type": "disabled" } }
```

## Caveats

1. Context caching is **best-effort**. DeepSeek documents no guarantee of a 100%
   hit rate, and repeated runs will vary.
2. A cache hit requires a full match against a persisted cache prefix unit. Units
   are persisted at request boundaries, at detected common prefixes, and at fixed
   token intervals.
3. Cache entries expire automatically, typically within hours to days.
4. The first request of any conversation is always a miss.
5. Peak pricing is twice off-peak. Peak is 01:00–04:00 and 06:00–10:00 UTC,
   Monday to Friday. Chinese public holidays are not modelled, so a holiday run
   may overstate cost.
6. The stable block is synthetic, but its structure and scale are realistic. This
   measures cache behaviour, not model quality.
7. The projection in the reports extrapolates the measured per-turn cost. Real apps
   compress history instead of letting it grow, so absolute figures will differ.
   The ratio is the finding. Note that this makes the 30-turn numbers a *pessimistic*
   case for C's benefit, since real history compression would cap the growth.
8. **One provider only.** The numbers are DeepSeek's. The mechanism — a volatile
   field above the cacheable prefix invalidating everything downstream — should
   generalise to any prefix-based cache, but that has not been measured here.

## Raw data

Full per-turn output for both runs is committed alongside this README:

- `report-2026-10-05T10-57-29.md` / `.json` — 30-turn run
- `report-2026-10-04T07-55-05.md` / `.json` — 8-turn run
- `curve-analysis.md` — the session-length analysis

## License

MIT
