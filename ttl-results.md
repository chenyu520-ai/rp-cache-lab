# How long does DeepSeek's prompt cache survive between turns?

Measured 2026-10-05 16:49 UTC. Model `deepseek-flash`, ~16,000 tokens per
request. Total cost of the sweep: **$0.009966**.

## Why this exists

A reader raised the obvious hole in the 30-turn benchmark: those turns are sent
seconds apart, so nothing ever expires. A real session can have the same turn
count spread across hours. If the cache dies between turns, every variant pays
the cold price and the saving goes to zero for *all three* — not just for B.

The documentation says entries are cleared "usually within a few hours to a few
days", which is a wide enough range to be useless for planning. So this measures
the eviction curve directly instead of inferring it.

## Method

Send a request to prime the cache, wait a fixed interval, then send the
**byte-identical** request again and read `usage.prompt_cache_hit_tokens`.

Each interval gets its own freshly primed prefix, so no probe can be warmed by
an earlier one. **Every prime came back as a full miss** (`hit 0`), which is
what establishes that independence rather than assuming it.

## Results

| Gap | Hit tokens | Miss tokens | Hit rate |
| --- | --- | --- | --- |
| 2 minutes | 15,872 | 146 | 99.1% |
| 15 minutes | 15,872 | 146 | 99.1% |
| 1 hour | 15,872 | 146 | 99.1% |
| 3 hours | 15,872 | 146 | 99.1% |

No decay at any interval tested. The cache is still fully warm three hours after
the priming request.

## What this means

1. **Within three hours, eviction is not the variable that matters.** The prefix
   survives intact, so for a session where the user returns within a few hours
   the analysis in the 30-turn post holds as written.

2. **It does not cover the regime that actually worries people.** Three hours is
   not the documented ceiling. If your sessions are spread across days, this
   measurement says nothing about them, and a cliff may exist somewhere past
   where this stopped.

3. **It is provider-specific.** A reader reported that Anthropic's default cache
   lifetime is 5 minutes (1 hour at a higher write price), which is a completely
   different regime. Treat this number as DeepSeek's, not as a general property
   of prefix caching.

## Known limitations

Stated rather than left for someone else to find:

1. **The four probes ended up sharing almost identical body content.** The first
   published version of the script hashed a string salt with `seed >>> 0`, which
   coerces a non-numeric string to `0` — so every probe generated the same text
   and only the leading marker line differed. The result is still valid (each
   prime was a cold miss, which is what proves independence), but the bodies
   were not as distinct as the method intends. Fixed in `ttl-probe.js` in this
   repository; the numbers above have not been re-run with the fix.

2. **The stable block came out smaller than designed** — 16,018 tokens against a
   20,000 target, because the synthetic text runs under the assumed chars/token
   ratio. The comparison is unaffected, but the label in the first version of the
   report was wrong and has been corrected here.

3. **Single provider, single model, no concurrency.** DeepSeek only, `flash`
   only, one request at a time. Whether eviction behaves differently under load
   is untested.

4. **Cache storage is shared per account.** A busy account may evict sooner than
   an idle one; this ran on a near-idle account.

## Reproduce it

```bash
node ttl-probe.js --dry-run              # prints the timeline, sends nothing
node ttl-probe.js --gaps 2,15,60,180     # ~4h20m wall clock, about a cent
node ttl-probe.js --gaps 5,60,360,1440   # push past three hours
```

Raw output for the run above: `TTL测试结果.json` (Chinese keys, values are
language-neutral). The sweep is mostly waiting — CPU and bandwidth use are
negligible, but the machine must not sleep.
