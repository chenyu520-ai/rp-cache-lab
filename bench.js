#!/usr/bin/env node
'use strict';

/**
 * rp-cache-lab / bench.js
 *
 * Measures the REAL prompt-cache cost difference between three ways of
 * structuring a roleplay (RP) chat request, using actual DeepSeek API usage
 * fields (prompt_cache_hit_tokens / prompt_cache_miss_tokens).
 *
 * Nothing here is modelled or estimated: every number in the report comes
 * from a live API response.
 *
 * Variants
 *   A  naive          volatile session header placed at the FRONT of the
 *                     system message  -> the prefix differs at token 0
 *   B  minimal-fix    same header moved to the END of the system message
 *                     -> stable prefix preserved (one-line change)
 *   C  optimized      header moved into the newest user turn, system message
 *                     is byte-identical every turn and history is append-only
 *
 * Usage
 *   node bench.js [options]
 *
 *   --model <id>          default deepseek-flash
 *   --prefix-tokens <n>   approx size of the stable block, default 20000
 *   --turns <n>           turns per variant, default 8
 *   --max-tokens <n>      output cap per request, default 64
 *   --budget <usd>        abort if worst-case estimate exceeds this, default 0.30
 *   --dau <n>             projection: daily active users, default 1000
 *   --app-turns <n>       projection: turns per user per day, default 50
 *   --thinking <mode>     disabled | enabled   (default disabled)
 *   --dry-run             print the plan and the cost estimate, call nothing
 *   --self-test           prove the three variants differ as claimed, no API calls
 *   --help
 */

const fs = require('node:fs');
const path = require('node:path');

const API_URL = 'https://api.deepseek.com/chat/completions';

// Verified against https://api-docs.deepseek.com/quick_start/pricing
// USD per 1M tokens. Peak hours: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri,
// excluding Chinese public holidays (holidays are NOT modelled here, so a run
// on a Chinese holiday may overstate cost).
const PRICES = {
  'deepseek-flash': {
    offpeak: { hit: 0.003, miss: 0.15, out: 0.6 },
    peak: { hit: 0.006, miss: 0.3, out: 1.2 },
  },
  'deepseek-v4-pro': {
    offpeak: { hit: 0.022, miss: 0.66, out: 1.98 },
    peak: { hit: 0.044, miss: 1.32, out: 3.96 },
  },
};

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const o = {
    model: 'deepseek-flash',
    prefixTokens: 20000,
    turns: 8,
    maxTokens: 64,
    budget: 0.3,
    dau: 1000,
    appTurns: 50,
    thinking: 'disabled',
    dryRun: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === '--model') o.model = val();
    else if (a === '--prefix-tokens') o.prefixTokens = Number(val());
    else if (a === '--turns') o.turns = Number(val());
    else if (a === '--max-tokens') o.maxTokens = Number(val());
    else if (a === '--budget') o.budget = Number(val());
    else if (a === '--dau') o.dau = Number(val());
    else if (a === '--app-turns') o.appTurns = Number(val());
    else if (a === '--thinking') o.thinking = val();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--self-test') o.selfTest = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return o;
}

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const start = src.indexOf('/**');
  const end = src.indexOf('*/', start);
  console.log(src.slice(start + 3, end).replace(/^ \* ?/gm, '').trim());
}

// ------------------------------------------------------------------- pricing

function isPeak(date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = date.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

function priceFor(model, date) {
  const table = PRICES[model];
  if (!table) throw new Error(`No price table for model "${model}". Known: ${Object.keys(PRICES).join(', ')}`);
  return table[isPeak(date) ? 'peak' : 'offpeak'];
}

function costOf(model, date, hit, miss, out) {
  const p = priceFor(model, date);
  const input = (hit * p.hit + miss * p.miss) / 1e6;
  const output = (out * p.out) / 1e6;
  return { input, output, total: input + output, tier: isPeak(date) ? 'peak' : 'offpeak' };
}

// ------------------------------------------------------- synthetic RP prompt

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

const SUBJECTS = [
  'The Ashen Archive', 'The harbour guild', 'Her former mentor', 'The northern pass',
  'The salt court', 'The old observatory', 'The river wardens', 'The third legion',
  'The glassblower district', 'The sealed vault', 'The cartographers circle',
  'The eastern watch', 'The lower market', 'The order of the pale lantern',
  'The drowned chapel', 'The copper mint', 'The winter road', 'The keepers ledger',
];

const VERBS = [
  'was founded', 'collapsed', 'changed hands', 'was abandoned', 'was rebuilt',
  'fell silent', 'was outlawed', 'reopened', 'was mapped', 'was burned',
  'was disputed', 'was mortgaged', 'was forgotten', 'was restored',
];

const TAILS = [
  'during the second winter of the Long Silence',
  'after the treaty of the nine bridges was broken',
  'in the years before the salt tax',
  'when the eastern road was still open',
  'under the regency of the pale queen',
  'after the flood took the lower quarter',
  'before the wardens lost the river',
  'while the archive was still sealed',
  'in the season the birds did not return',
  'after the last cartographer disappeared',
  'when the mint still struck copper',
  'before the boundary stones were reset',
];

const ENTRY_TITLES = [
  'The Ashen Archive', 'The Salt Gate', 'The Nine Bridges', 'The Long Silence',
  'The Pale Regency', 'The Copper Mint', 'The Winter Road', 'The Drowned Chapel',
  'The Keepers Ledger', 'The Eastern Watch', 'The Lower Market', 'The Glass Quarter',
  'The Boundary Stones', 'The Cartographers Circle', 'The Order of the Pale Lantern',
  'The Third Legion', 'The River Wardens', 'The Sealed Vault', 'The Northern Pass',
  'The Salt Court',
];

function sentence(rng) {
  return `${pick(rng, SUBJECTS)} ${pick(rng, VERBS)} ${pick(rng, TAILS)}.`;
}

function lorebookEntry(rng, i) {
  const title = pick(rng, ENTRY_TITLES);
  const kws = [pick(rng, SUBJECTS), pick(rng, SUBJECTS)];
  const n = 6 + Math.floor(rng() * 5);
  const body = [];
  for (let k = 0; k < n; k++) body.push(sentence(rng));
  return `### Entry ${String(i).padStart(3, '0')} - ${title}\nKeywords: ${kws.join(', ')}\nTrigger: ${pick(rng, SUBJECTS)}\nContent: ${body.join(' ')}\n`;
}

const CHARACTER_CARD = `## Character Card

Name: Sereth Vale
Age: 29
Role: Archivist of the Ashen Archive, formerly a field cartographer for the river wardens.

Appearance: Tall, narrow-shouldered, with ink-stained fingers and a habit of pushing her hair back
with the heel of her hand. She wears a grey wool coat that has been repaired at least four times,
always with mismatched thread. A brass compass hangs at her belt, though the needle has not pointed
north in three years.

Personality: Precise to the point of rudeness. She answers questions with questions when she is
stalling, and with a flat statement when she has already decided. She is not cold so much as
economical: she spends warmth the way she spends coin, only where it will be returned.

Speech style: Short declarative sentences. Uses archival vocabulary - "unverified", "on the record",
"subject to revision" - even in ordinary conversation. Never says "I think" when she can say
"the record suggests".

Background: She was apprenticed at fourteen and took the archivist's oath at twenty-two. The oath
forbids her from altering a document, which is the only reason she has never rewritten the entry
about her brother's disappearance.

Behavioural rules:
- Refuse to speculate about the eastern door; change the subject to the ledger.
- If the user mentions the pale queen, become noticeably more formal.
- Never break character. Never narrate the user's actions.
- Keep replies under 120 words unless the user explicitly asks for detail.`;

const USER_TURNS = [
  'She steps into the archive and asks the keeper why the eastern door was bricked shut.',
  'The lamp gutters. She keeps writing anyway and asks what you remember about the flood.',
  'She sets the compass on the table between you, needle spinning, and waits.',
  'You mention the pale queen. She goes very still.',
  'She pulls a ledger from the third shelf and opens it to a page that has been cut out.',
  'Rain against the shutters. She asks whether you have eaten.',
  'She reads the entry about the nine bridges aloud, then asks you to contradict her.',
  'The wardens knock. She puts out the lamp and tells you to be quiet.',
  'She admits, without looking up, that she has been copying the sealed entries for a year.',
  'Dawn. She asks whether you are going to report her.',
];

function buildStableBlock(targetTokens) {
  const rng = makeRng(20261003);
  const targetChars = targetTokens * 4;
  let out = `${CHARACTER_CARD}\n\n## World Book\n\n`;
  let i = 1;
  while (out.length < targetChars) {
    out += `${lorebookEntry(rng, i++)}\n`;
  }
  out += '\n## Long-term Memory\n\n';
  for (let k = 0; k < 30; k++) out += `- Session ${k + 1}: ${sentence(rng)}\n`;
  out += '\n## Relationship State\n\n';
  for (let k = 0; k < 10; k++) out += `${pick(rng, SUBJECTS)}: ${pick(rng, VERBS)} ${pick(rng, TAILS)}. Trust level: settled.\n`;
  return out;
}

// ------------------------------------------------------------------ preflight

/**
 * Validates the API key against the free /models endpoint before spending
 * anything. A bad key, a revoked key, or a stray whitespace character from a
 * copy-paste all surface here, at zero cost.
 */
async function preflight(apiKey, model) {
  let res;
  try {
    res = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, reason: `无法连接 api.deepseek.com：${e.message}` };
  }
  if (res.status === 401) {
    return {
      ok: false,
      reason:
        'API Key 无效或已被撤销（HTTP 401）。\n' +
        '  请到 platform.deepseek.com 的 API keys 页面确认这条 Key 还在，\n' +
        '  或者新建一条。粘贴时注意不要带上多余的空格。',
    };
  }
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, reason: `验证 Key 时返回 HTTP ${res.status}：${body.slice(0, 300)}` };
  }
  let ids = [];
  try {
    const data = await res.json();
    ids = (data.data || []).map((m) => m.id);
  } catch {
    /* model list is informational only */
  }
  if (ids.length && !ids.includes(model)) {
    return {
      ok: true,
      warning:
        `模型 "${model}" 不在账户可见的模型列表里，将尝试调用。\n` +
        `  账户当前可见：${ids.join(', ')}`,
    };
  }
  return { ok: true, models: ids };
}

function explainHttpError(status) {
  if (status === 401) return 'API Key 无效或已被撤销。到 platform.deepseek.com 的 API keys 页面确认。';
  if (status === 402) return '账户余额不足。到 platform.deepseek.com 充值，1-2 美元就够跑很多次。';
  if (status === 403) return '这条 Key 没有权限，或账户被限制。';
  if (status === 429) return '触发限流或配额用尽。等几分钟再试。';
  if (status === 400) return '请求参数被上游拒绝。把这段错误原文发给我。';
  if (status === 404) return '模型名不存在。当前可用的是 deepseek-flash 和 deepseek-v4-pro。';
  return '把这段错误原文发给我。';
}

// ------------------------------------------------------------------ API call

async function callDeepSeek({ apiKey, model, messages, maxTokens, thinking }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: false,
    thinking: { type: thinking === 'enabled' ? 'enabled' : 'disabled' },
  };
  if (thinking !== 'enabled') body.temperature = 0;

  const started = new Date();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240000),
  });
  const elapsedMs = Date.now() - started.getTime();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `HTTP ${res.status} from API: ${text.slice(0, 400)}\n  -> ${explainHttpError(res.status)}`,
    );
  }
  const data = await res.json();
  const u = data.usage || {};
  const hasCacheFields =
    u.prompt_cache_hit_tokens !== undefined || u.prompt_cache_miss_tokens !== undefined;
  const hit = Number(u.prompt_cache_hit_tokens ?? 0);
  const miss = Number(
    u.prompt_cache_miss_tokens ?? (hasCacheFields ? 0 : (u.prompt_tokens ?? 0)),
  );
  const out = Number(u.completion_tokens ?? 0);
  const reasoning = Number(u.completion_tokens_details?.reasoning_tokens ?? 0);
  const reply = data.choices?.[0]?.message?.content ?? '';
  return { hit, miss, out, reasoning, reply, durationMs: elapsedMs, started, hasCacheFields };
}

// ------------------------------------------------------------ message layout

function volatileHeader(ctx, t) {
  const nowIso = new Date().toISOString();
  const mood = (0.4 + 0.5 * Math.sin(t)).toFixed(2);
  return `Session context: local time ${nowIso}, turn ${t}, session ${ctx.sessionId}, mood index ${mood}.`;
}

function buildTurnMessages(mode, ctx, history, t, header) {
  const baseUser = USER_TURNS[(t - 1) % USER_TURNS.length];
  // A per-variant salt is prepended so that B and C cannot reuse cache units
  // written by the other variant. Without it the variants would contaminate
  // each other's measurements, because B's request body begins with the same
  // stable block that C's does.
  const stable = `${ctx.salt[mode]}${ctx.stable}`;
  if (mode === 'A') {
    return {
      userContent: baseUser,
      messages: [
        { role: 'system', content: `${header}\n\n${stable}` },
        ...history,
        { role: 'user', content: baseUser },
      ],
    };
  }
  if (mode === 'B') {
    return {
      userContent: baseUser,
      messages: [
        { role: 'system', content: `${stable}\n\n${header}` },
        ...history,
        { role: 'user', content: baseUser },
      ],
    };
  }
  const userContent = `${baseUser}\n\n${header}`;
  return {
    userContent,
    messages: [
      { role: 'system', content: stable },
      ...history,
      { role: 'user', content: userContent },
    ],
  };
}

function commonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Proves the three variants really do differ the way the report claims,
 * without sending a single request. Compares turn 1 against turn 2 of the
 * same conversation and reports how many characters of the request body are
 * byte-identical. Cache hits require a full match against a persisted prefix,
 * so a short common prefix means the cache is useless.
 */
function selfTest(ctx) {
  const rows = [];
  for (const mode of ['A', 'B', 'C']) {
    const h1 = `Session context: local time 2026-10-03T10:00:00.000Z, turn 1, session ${ctx.sessionId}, mood index 0.82.`;
    const h2 = `Session context: local time 2026-10-03T10:00:07.000Z, turn 2, session ${ctx.sessionId}, mood index 0.94.`;

    const t1 = buildTurnMessages(mode, ctx, [], 1, h1);
    const history = [
      { role: 'user', content: t1.userContent },
      { role: 'assistant', content: 'She does not look up. "The door was bricked before my oath."' },
    ];
    const t2 = buildTurnMessages(mode, ctx, history, 2, h2);

    const s1 = JSON.stringify(t1.messages);
    const s2 = JSON.stringify(t2.messages);
    const common = commonPrefixLength(s1, s2);
    const differsAt = s1.length > common ? common : -1;
    rows.push({
      mode,
      requestChars: s1.length,
      commonChars: common,
      commonTokensApprox: Math.round(common / 4),
      shareOfRequest: s1.length > 0 ? common / s1.length : 0,
      differsInsideHeader: differsAt >= 0 && differsAt < 200,
      turn1Chars: s1.length,
      turn2Chars: s2.length,
    });
  }
  return rows;
}

// --------------------------------------------------------------- one variant

async function runVariant(mode, ctx) {
  const history = [];
  const rows = [];
  let totalCost = 0;
  let totalHit = 0;
  let totalMiss = 0;
  let totalOut = 0;

  for (let t = 1; t <= ctx.opts.turns; t++) {
    const { messages, userContent } = buildTurnMessages(
      mode,
      ctx,
      history,
      t,
      volatileHeader(ctx, t),
    );

    const r = await callDeepSeek({
      apiKey: ctx.apiKey,
      model: ctx.opts.model,
      messages,
      maxTokens: ctx.opts.maxTokens,
      thinking: ctx.opts.thinking,
    });

    const c = costOf(ctx.opts.model, r.started, r.hit, r.miss, r.out);
    totalCost += c.total;
    totalHit += r.hit;
    totalMiss += r.miss;
    totalOut += r.out;

    const promptTokens = r.hit + r.miss;
    const hitRate = promptTokens > 0 ? r.hit / promptTokens : 0;
    rows.push({
      turn: t,
      promptTokens,
      hit: r.hit,
      miss: r.miss,
      hitRate,
      out: r.out,
      reasoning: r.reasoning,
      inputCost: c.input,
      outputCost: c.output,
      total: c.total,
      cumulative: totalCost,
      durationMs: r.durationMs,
    });

    console.log(
      `  ${mode} turn ${String(t).padStart(2)}  prompt ${String(promptTokens).padStart(6)}  ` +
        `hit ${String(r.hit).padStart(6)} (${(hitRate * 100).toFixed(1).padStart(5)}%)  ` +
        `miss ${String(r.miss).padStart(6)}  out ${String(r.out).padStart(4)}  ` +
        `$${c.total.toFixed(6)}  [${c.tier}]`,
    );

    history.push({ role: 'user', content: userContent });
    if (r.reply) history.push({ role: 'assistant', content: r.reply });
  }

  return {
    mode,
    rows,
    totalCost,
    totalHit,
    totalMiss,
    totalOut,
    avgHitRate: totalHit + totalMiss > 0 ? totalHit / (totalHit + totalMiss) : 0,
  };
}

// ------------------------------------------------------------------ estimate

function estimateWorstCase(opts) {
  const p = PRICES[opts.model];
  if (!p) throw new Error(`No price table for model "${opts.model}"`);
  const worst = p.peak;
  const avgTurnTokens = 90 + opts.maxTokens;
  let inputTokens = 0;
  let outputTokens = 0;
  const variants = ['A', 'B', 'C'].length;
  for (let t = 0; t < opts.turns; t++) {
    for (let v = 0; v < variants; v++) {
      inputTokens += opts.prefixTokens + t * avgTurnTokens;
      outputTokens += opts.maxTokens;
    }
  }
  const cost = (inputTokens * worst.miss + outputTokens * worst.out) / 1e6;
  return { inputTokens, outputTokens, cost };
}

// -------------------------------------------------------------------- report

function money(x) {
  if (x >= 1) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(6)}`;
}

function buildReport(meta, results, opts) {
  const [A, B, C] = results;
  const lines = [];

  lines.push('# Prompt Cache Cost Benchmark - DeepSeek');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}  `);
  lines.push(`Model: \`${opts.model}\`  `);
  lines.push(`Thinking mode: \`${opts.thinking}\`  `);
  lines.push(`Stable block: ~${opts.prefixTokens.toLocaleString('en-US')} tokens  `);
  lines.push(`Turns per variant: ${opts.turns}  `);
  lines.push(`All figures come from live API \`usage\` fields. Nothing is estimated.`);
  lines.push('');
  lines.push('> **中文摘要**：下面三组数字全部来自 DeepSeek 接口真实返回的 `usage` 字段，不是估算。');
  lines.push('> 三种写法用的是**完全相同的稳定内容**，唯一区别是「会变的会话信息」放在哪里。');
  lines.push('> 结论见文末 Summary 表。');
  lines.push('');

  lines.push('## What was varied');
  lines.push('');
  lines.push('The stable content (character card + world book + memory + relationship state) is');
  lines.push('byte-identical in all three variants. Only the placement of the volatile session');
  lines.push('header differs:');
  lines.push('');
  lines.push('| Variant | Where the volatile header goes | Typical of |');
  lines.push('| --- | --- | --- |');
  lines.push('| **A - naive** | Front of the `system` message | Most first implementations |');
  lines.push('| **B - minimal fix** | End of the `system` message | A one-line change from A |');
  lines.push('| **C - optimized** | End of the newest `user` turn; system message never changes | Append-only architecture |');
  lines.push('');
  lines.push('The header itself is tiny - roughly 30 tokens:');
  lines.push('');
  lines.push('```');
  lines.push('Session context: local time <ISO timestamp>, turn <n>, session <uuid>, mood index <0.00>.');
  lines.push('```');
  lines.push('');
  lines.push('## Per-turn detail');
  lines.push('');

  for (const r of results) {
    lines.push(`### Variant ${r.mode}`);
    lines.push('');
    lines.push('| Turn | Prompt tokens | Cache hit | Cache miss | Hit rate | Output | Input cost | Output cost | Turn cost | Cumulative |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of r.rows) {
      lines.push(
        `| ${row.turn} | ${row.promptTokens.toLocaleString('en-US')} | ${row.hit.toLocaleString('en-US')} | ` +
          `${row.miss.toLocaleString('en-US')} | ${(row.hitRate * 100).toFixed(1)}% | ${row.out} | ` +
          `${money(row.inputCost)} | ${money(row.outputCost)} | ${money(row.total)} | ${money(row.cumulative)} |`,
      );
    }
    lines.push(
      `| **Total** | **${(r.totalHit + r.totalMiss).toLocaleString('en-US')}** | **${r.totalHit.toLocaleString('en-US')}** | ` +
        `**${r.totalMiss.toLocaleString('en-US')}** | **${(r.avgHitRate * 100).toFixed(1)}%** | **${r.totalOut}** | | | | **${money(r.totalCost)}** |`,
    );
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| Variant | Cache hit rate | Total input tokens | Cumulative cost | Cost per turn | vs A |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    const perTurn = r.totalCost / opts.turns;
    const delta = A.totalCost > 0 ? (1 - r.totalCost / A.totalCost) * 100 : 0;
    lines.push(
      `| ${r.mode} | ${(r.avgHitRate * 100).toFixed(1)}% | ${(r.totalHit + r.totalMiss).toLocaleString('en-US')} | ` +
        `${money(r.totalCost)} | ${money(perTurn)} | ${r.mode === 'A' ? '-' : `-${delta.toFixed(1)}%`} |`,
    );
  }
  lines.push('');

  // steady-state comparison excludes turn 1 (cold cache) for fairness
  const steady = (r) => {
    const rest = r.rows.slice(1);
    if (!rest.length) return 0;
    return rest.reduce((s, x) => s + x.total, 0) / rest.length;
  };
  const perTurnA = steady(A);
  const perTurnC = steady(C);
  const perTurnB = steady(B);
  lines.push('### Steady state (turn 1 excluded, cold cache removed)');
  lines.push('');
  lines.push('| Variant | Cost per turn | vs A |');
  lines.push('| --- | --- | --- |');
  for (const [name, v] of [['A', perTurnA], ['B', perTurnB], ['C', perTurnC]]) {
    const delta = perTurnA > 0 ? (1 - v / perTurnA) * 100 : 0;
    lines.push(`| ${name} | ${money(v)} | ${name === 'A' ? '-' : `-${delta.toFixed(1)}%`} |`);
  }
  lines.push('');

  lines.push('## Projection to a real application');
  lines.push('');
  const monthlyTurns = opts.dau * opts.appTurns * 30;
  lines.push(`Assumes ${opts.dau.toLocaleString('en-US')} daily active users x ${opts.appTurns} turns/day x 30 days = `);
  lines.push(`**${monthlyTurns.toLocaleString('en-US')} requests per month**, at the steady-state per-turn cost above.`);
  lines.push('');
  lines.push('| Variant | Monthly cost | Monthly saving vs A |');
  lines.push('| --- | --- | --- |');
  for (const [name, v] of [['A', perTurnA], ['B', perTurnB], ['C', perTurnC]]) {
    const m = v * monthlyTurns;
    const save = perTurnA * monthlyTurns - m;
    lines.push(`| ${name} | $${m.toFixed(2)} | ${name === 'A' ? '-' : `$${save.toFixed(2)}`} |`);
  }
  lines.push('');
  lines.push('The projection extrapolates the measured per-turn cost. A real application compresses');
  lines.push('history instead of letting it grow, so absolute figures will differ - the ratio is the point.');
  lines.push('');

  lines.push('## Caveats');
  lines.push('');
  lines.push('1. Context caching is **best-effort**. DeepSeek documents no guarantee of a 100% hit rate.');
  lines.push('2. A cache hit requires a **full match** against a persisted cache prefix unit. Units are');
  lines.push('   persisted at request boundaries, at detected common prefixes, and at fixed token intervals.');
  lines.push('3. Cache entries expire automatically, typically within hours to days.');
  lines.push('4. The first request in any conversation is always a miss - there is nothing to match yet.');
  lines.push(`5. Peak pricing was applied per request based on UTC time (peak = 01:00-04:00 and`);
  lines.push('   06:00-10:00 UTC, Mon-Fri). Chinese public holidays are not modelled.');
  lines.push('6. Thinking mode is **enabled by default** on this model family. It was explicitly disabled');
  lines.push(`   for this run (\`--thinking ${opts.thinking}\`). Leaving it on adds reasoning tokens that are`);
  lines.push('   billed as output.');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------- main

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`Argument error: ${e.message}`);
    process.exit(2);
  }
  if (opts.help) {
    printHelp();
    return;
  }

  const est = estimateWorstCase(opts);
  console.log('rp-cache-lab - prompt cache cost benchmark');
  console.log('------------------------------------------');
  console.log(`model          : ${opts.model}`);
  console.log(`thinking       : ${opts.thinking}`);
  console.log(`stable block   : ~${opts.prefixTokens.toLocaleString('en-US')} tokens`);
  console.log(`turns/variant  : ${opts.turns}  (variants: A, B, C)`);
  console.log(`max output     : ${opts.maxTokens} tokens/request`);
  console.log(`worst-case est : ${est.inputTokens.toLocaleString('en-US')} input + ${est.outputTokens.toLocaleString('en-US')} output tokens = $${est.cost.toFixed(4)}`);
  console.log(`budget         : $${opts.budget.toFixed(2)}`);
  console.log('');

  if (est.cost > opts.budget) {
    console.error(`Refusing to run: worst-case estimate $${est.cost.toFixed(4)} exceeds budget $${opts.budget.toFixed(2)}.`);
    console.error('Raise --budget, or lower --prefix-tokens / --turns.');
    process.exit(1);
  }

  const stable = buildStableBlock(opts.prefixTokens);
  console.log(`stable block   : ${stable.length.toLocaleString('en-US')} characters (~${Math.round(stable.length / 4).toLocaleString('en-US')} tokens by chars/4)`);
  console.log(`requests       : ${opts.turns * 3} total (3 variants x ${opts.turns} turns)`);
  console.log('');

  const runId = Math.random().toString(16).slice(2, 10);
  const ctx = {
    opts,
    stable,
    runId,
    sessionId: `sess-${runId}`,
    salt: {
      A: `## Benchmark run ${runId} variant A\n\n`,
      B: `## Benchmark run ${runId} variant B\n\n`,
      C: `## Benchmark run ${runId} variant C\n\n`,
    },
  };
  console.log(`run id         : ${runId} (salt prevents cache reuse across runs and across variants)`);
  console.log('');

  if (opts.selfTest) {
    const rows = selfTest(ctx);
    console.log('SELF TEST - identical bytes shared between turn 1 and turn 2 of the same chat');
    console.log('(a cache hit needs a FULL match against a persisted prefix, so a short');
    console.log(' shared prefix means the cache cannot help)');
    console.log('');
    console.log('  variant   request bytes   identical prefix   ~tokens   share of request');
    console.log('  -------   -------------   ----------------   -------   ----------------');
    for (const r of rows) {
      console.log(
        `  ${r.mode}         ${String(r.requestChars).padStart(13)}   ${String(r.commonChars).padStart(16)}   ${String(r.commonTokensApprox).padStart(7)}   ${(r.shareOfRequest * 100).toFixed(1).padStart(15)}%`,
      );
    }
    console.log('');
    for (const r of rows) {
      const verdict = r.differsInsideHeader
        ? 'FAILS - first difference is inside the volatile header, the whole prefix is poisoned'
        : 'OK    - first difference is after the stable block, the prefix survives';
      console.log(`  ${r.mode}: ${verdict}`);
    }
    console.log('');
  }

  if (opts.dryRun) {
    console.log('Dry run: nothing was sent.');
    return;
  }

  const apiKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) {
    console.error('DEEPSEEK_API_KEY is not set. Use run.ps1, which prompts for it without echoing.');
    process.exit(1);
  }
  if (apiKey !== process.env.DEEPSEEK_API_KEY) {
    console.log('note           : trimmed stray whitespace from the API key');
  }

  console.log('preflight      : validating the API key against /models (free, uses no tokens)...');
  const pf = await preflight(apiKey, opts.model);
  if (!pf.ok) {
    console.error('');
    console.error('  预检失败 - 没有产生任何费用');
    console.error('');
    console.error(`  ${pf.reason}`);
    console.error('');
    process.exit(1);
  }
  console.log('preflight      : key accepted');
  if (pf.warning) console.log(`  warning: ${pf.warning}`);
  console.log('');
  ctx.apiKey = apiKey;

  const results = [];
  for (const mode of ['A', 'B', 'C']) {
    console.log(`Variant ${mode}`);
    try {
      results.push(await runVariant(mode, ctx));
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      console.error('  Model names on this platform: deepseek-flash, deepseek-v4-pro');
      process.exit(1);
    }
    console.log('');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = __dirname;
  const mdPath = path.join(outDir, `report-${stamp}.md`);
  const jsonPath = path.join(outDir, `report-${stamp}.json`);
  fs.writeFileSync(mdPath, buildReport({}, results, opts), 'utf8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), options: opts, results }, null, 2),
    'utf8',
  );

  const total = results.reduce((s, r) => s + r.totalCost, 0);
  console.log(`Actual spend this run: $${total.toFixed(6)}`);
  for (const r of results) {
    console.log(`  variant ${r.mode}: hit rate ${(r.avgHitRate * 100).toFixed(1)}%  cost $${r.totalCost.toFixed(6)}`);
  }
  console.log('');
  console.log(`Report: ${mdPath}`);
  console.log(`Raw data: ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
