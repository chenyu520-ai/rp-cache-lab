// ttl-probe.js
//
// Measures how long DeepSeek's disk cache survives between two identical
// requests. This is the question a reader raised on the second write-up: the
// 30-turn benchmark sends turns seconds apart, so nothing ever expires. Real
// sessions can be spread across hours.
//
// Method, per gap:
//   1. send a request to prime the cache
//   2. wait GAP
//   3. send the byte-identical request again
//   4. read usage.prompt_cache_hit_tokens
//
// Each gap gets its own unique prefix, so no probe can warm another one.
//
// Usage:  node ttl-probe.js [--gaps 2,15,60,180] [--prefix-tokens 20000] [--budget 1.00]
const fs = require('node:fs');
const path = require('node:path');

const API_URL = 'https://api.deepseek.com/chat/completions';
const PRICES = {
  'deepseek-flash': {
    offpeak: { hit: 0.003, miss: 0.15, out: 0.6 },
    peak: { hit: 0.006, miss: 0.3, out: 1.2 },
  },
};

function parseArgs(argv) {
  const o = { gaps: [2, 15, 60, 180], prefixTokens: 20000, model: 'deepseek-flash', budget: 1.0, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--gaps') o.gaps = val().split(',').map(Number).filter((n) => n >= 0);
    else if (a === '--prefix-tokens') o.prefixTokens = Number(val());
    else if (a === '--model') o.model = val();
    else if (a === '--budget') o.budget = Number(val());
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return o;
}

function isPeak(d) {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

// ------------------------------------------------------------ synthetic block
// NOTE: the first published run passed a *string* salt straight into the RNG,
// where `seed >>> 0` coerced it to 0 — so every probe generated identical body
// content and only the leading marker differed. The result was still valid
// (each prime came back as a full miss, which is what proves the probes were
// independent of each other), but the bodies were not as distinct as intended.
// Fixed by hashing the salt into a numeric seed.
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed) {
  let s = (typeof seed === 'number' ? seed >>> 0 : hashSeed(String(seed))) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const S = ['The Ashen Archive', 'The harbour guild', 'Her former mentor', 'The northern pass', 'The salt court', 'The old observatory'];
const V = ['was founded', 'collapsed', 'changed hands', 'was abandoned', 'was rebuilt', 'fell silent'];
const T = ['during the second winter of the Long Silence', 'after the treaty of the nine bridges was broken', 'in the years before the salt tax', 'while the archive was still sealed'];

function buildBlock(targetTokens, salt) {
  const rng = makeRng(salt);
  const targetChars = targetTokens * 4;
  let out = `## Character Card\nName: Sereth Vale\nRole: Archivist.\n\n## World Book\n\n`;
  let i = 1;
  while (out.length < targetChars) {
    const n = 6 + Math.floor(rng() * 4);
    let body = '';
    for (let k = 0; k < n; k++) body += `${S[Math.floor(rng() * S.length)]} ${V[Math.floor(rng() * V.length)]} ${T[Math.floor(rng() * T.length)]}. `;
    out += `### Entry ${i} - ${S[Math.floor(rng() * S.length)]}\nContent: ${body}\n`;
    i++;
  }
  return `## Probe ${salt}\n\n${out}`;
}

// ------------------------------------------------------------------ api call
async function call(apiKey, model, messages) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 16,
      stream: false,
      thinking: { type: 'disabled' },
      temperature: 0,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const u = data.usage || {};
  return {
    hit: Number(u.prompt_cache_hit_tokens ?? 0),
    miss: Number(u.prompt_cache_miss_tokens ?? u.prompt_tokens ?? 0),
    out: Number(u.completion_tokens ?? 0),
    started: new Date(),
  };
}

function cost(model, when, hit, miss, out) {
  const p = PRICES[model][isPeak(when) ? 'peak' : 'offpeak'];
  return (hit * p.hit + miss * p.miss + out * p.out) / 1e6;
}

function money(x) {
  return x >= 0.01 ? `$${x.toFixed(5)}` : `$${x.toFixed(6)}`;
}

function minutes(n) {
  if (n < 60) return `${n} 分钟`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const apiKey = (process.env.DEEPSEEK_API_KEY || '').trim();

  const totalWait = opts.gaps.reduce((a, b) => a + b, 0);
  console.log('DeepSeek 缓存存活时间探测');
  console.log('-----------------------------------------');
  console.log(`模型        : ${opts.model}`);
  console.log(`稳定块      : ~${opts.prefixTokens.toLocaleString('en-US')} token`);
  console.log(`探测间隔    : ${opts.gaps.map(minutes).join(' → ')}`);
  console.log(`总等待时间  : 约 ${minutes(totalWait)}`);
  console.log(`请求数      : ${opts.gaps.length * 2}`);
  console.log('');

  if (opts.dryRun) {
    console.log('Dry run：不会发任何请求。');
    console.log('');
    console.log('预计时间线：');
    let clock = 0;
    for (const g of opts.gaps) {
      console.log(`  ${String(clock).padStart(4)} 分钟  预热 + 等待 ${minutes(g)} + 重发`);
      clock += g;
    }
    console.log(`  ${String(clock).padStart(4)} 分钟  结束`);
    return;
  }

  if (!apiKey) {
    console.error('DEEPSEEK_API_KEY not set. Use run-ttl.ps1, which prompts for it without echoing.');
    process.exit(1);
  }

  const rows = [];
  let spend = 0;

  for (const gap of opts.gaps) {
    const salt = `${Date.now()}-${gap}`;
    const block = buildBlock(opts.prefixTokens, salt);
    const messages = [
      { role: 'system', content: block },
      { role: 'user', content: 'Continue the scene in one sentence.' },
    ];

    // 1. prime
    const p = await call(apiKey, opts.model, messages);
    spend += cost(opts.model, p.started, p.hit, p.miss, p.out);
    console.log(`[${minutes(gap)}] 预热完成  prompt ${(p.hit + p.miss).toLocaleString('en-US')}  hit ${p.hit}  miss ${p.miss}`);

    if (spend > opts.budget) {
      console.error(`预算超了 (${money(spend)})，停止。`);
      break;
    }

    if (gap === 0) {
      const second = await call(apiKey, opts.model, messages);
      spend += cost(opts.model, second.started, second.hit, second.miss, second.out);
      rows.push({ gap, hit: second.hit, miss: second.miss, prompt: second.hit + second.miss });
      console.log(`[${minutes(gap)}] 立刻重发  hit ${second.hit}  miss ${second.miss}`);
      continue;
    }

    // 2. wait
    const wake = Date.now() + gap * 60_000;
    const started = Date.now();
    while (Date.now() < wake) {
      const left = wake - Date.now();
      await new Promise((r) => setTimeout(r, Math.min(left, 30000)));
      const done = Math.round(((Date.now() - started) / 1000 / 60) * 10) / 10;
      process.stdout.write(`\r[${minutes(gap)}] 等待中... 已过 ${done}/${gap} 分钟   `);
    }
    process.stdout.write('\r' + ' '.repeat(60) + '\r');

    // 3. identical request
    const second = await call(apiKey, opts.model, messages);
    spend += cost(opts.model, second.started, second.hit, second.miss, second.out);
    const prompt = second.hit + second.miss;
    const rate = prompt > 0 ? second.hit / prompt : 0;
    rows.push({ gap, hit: second.hit, miss: second.miss, prompt, rate });
    console.log(`[${minutes(gap)}] 重发结果  hit ${second.hit.toLocaleString('en-US')}  miss ${second.miss.toLocaleString('en-US')}  命中率 ${(rate * 100).toFixed(1)}%`);
  }

  // ------------------------------------------------------------------ report
  const lines = [];
  lines.push('# DeepSeek 缓存能存活多久？');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  lines.push(`模型 \`${opts.model}\`，稳定块约 ${opts.prefixTokens.toLocaleString('en-US')} token。`);
  lines.push('');
  lines.push('## 方法');
  lines.push('');
  lines.push('同一个请求发两次，中间等待不同的时间，看第二次还能不能命中缓存。');
  lines.push('每个间隔用**独立的前缀**，所以探测之间不会互相预热。');
  lines.push('');
  lines.push('## 结果');
  lines.push('');
  lines.push('| 间隔 | 第二次命中 token | 未命中 token | 命中率 | 判断 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const rate = r.prompt > 0 ? r.hit / r.prompt : 0;
    let verdict = '❓ 未测';
    if (rate > 0.95) verdict = '✅ 缓存仍然有效';
    else if (rate > 0.5) verdict = '⚠️ 部分失效';
    else if (rate > 0.02) verdict = '⚠️ 大部分失效';
    else verdict = '❌ 缓存已清空';
    lines.push(
      `| ${minutes(r.gap)} | ${r.hit.toLocaleString('en-US')} | ${r.miss.toLocaleString('en-US')} | ${(rate * 100).toFixed(1)}% | ${verdict} |`,
    );
  }
  lines.push('');
  lines.push(`总花费：${money(spend)}`);
  lines.push('');
  lines.push('## 这意味着什么');
  lines.push('');
  lines.push('（跑完之后，这一节需要根据实际结果来写）');
  lines.push('');
  lines.push('- 如果**长时间间隔后仍然命中** → 活跃会话的结论成立，之前那篇 30 轮的分析可以用');
  lines.push('- 如果**几个小时后失效** → 说明省钱效果只在连续活跃的会话里成立，两轮之间的间隔越长，收益越少');
  lines.push('- 这也直接回答了读者提的问题：**缓存淘汰是真实存在的变量，不是理论上的担心**');
  lines.push('');

  const out = path.join(__dirname, 'TTL测试结果.md');
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  fs.writeFileSync(
    path.join(__dirname, 'TTL测试结果.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), options: opts, rows, spend }, null, 2),
    'utf8',
  );

  console.log('');
  console.log(`总花费：${money(spend)}`);
  console.log(`结果：${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
