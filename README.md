# rp-cache-lab

**How much does your prompt structure cost you?**

A small benchmark that measures how the placement of a ~30-token volatile header
changes DeepSeek's prompt cache hit rate — and therefore your bill.

**One run: moving the header cut steady-state cost by 96%.**

📄 Write-up: [Your system prompt is silently killing your prompt cache](https://dev.to/chenyu-ai/your-system-prompt-is-silently-killing-your-prompt-cache-28oa)

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

Measured on `deepseek-flash` with thinking disabled, 8 turns per variant.

| Variant | Cache hit rate | Total input tokens | Cost for 8 turns | Cost per turn | vs A |
| --- | --- | --- | --- | --- | --- |
| A | 0.0% | 138,237 | $0.021006 | $0.002626 | — |
| B | 85.8% | 137,788 | $0.003465 | $0.000433 | −83.5% |
| C | 86.8% | 138,987 | $0.003326 | $0.000416 | −84.2% |

Turn 1 is always a miss in every variant — the cache is cold. Excluding that
cold start:

| Variant | Cost per turn | vs A |
| --- | --- | --- |
| A | $0.002633 | — |
| B | $0.000127 | **−95.2%** |
| C | $0.000107 | **−95.9%** |

Variant A never had a single cache hit. The entire ~17,000-token prefix was
reprocessed at full price every turn, because the first ~30 tokens differed.

Worth noting: B flatlines at exactly 16,896 cache-hit tokens per turn
(264 × 64 — 64 appears to be the cache granularity), while C keeps climbing as
history accumulates. Over a long session, C pulls further ahead.

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
```

On Windows PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = 'sk-...'
node bench.js
```

A default live run sends 24 requests (3 variants × 8 turns), costs roughly
**$0.03**, and has a hard-coded $0.30 budget guard that refuses to start if the
worst-case estimate exceeds it.

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
7. The projection in the report extrapolates the measured per-turn cost. Real apps
   compress history instead of letting it grow, so absolute figures will differ.
   The ratio is the finding.

## Raw data

The full per-turn output of the run quoted above is committed alongside this
README:

- `report-2026-10-04T07-55-05.md` — human-readable report
- `report-2026-10-04T07-55-05.json` — every request's `usage` payload

## License

MIT
