// Sentry bundle + scripting isolation report.
//
//   node analyze.mjs [--base dist/baseline] [--sentry dist/sentry] [--lh lh.json]
//
// 1. BUNDLE DELTA  — exact gzip/raw bytes Sentry adds (baseline vs sentry build).
// 2. WHERE         — which output chunk(s) contain @sentry/* modules + their MINIFIED byte
//                    share, by decoding each chunk's source-map mappings.
// 3. CONNECTION    — if a Lighthouse JSON is passed, join each chunk's `bootup-time`
//                    (script-evaluation ms) to its Sentry share → estimated Sentry scripting ms.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'dist/no-sentry');
const SENTRY = arg('sentry', 'dist/tracing-replay');
const LH = arg('lh', null);

const kb = b => (b / 1024).toFixed(1) + 'KB';
const isSentry = p => /[/@](sentry|sentry-internal)[/-]/.test(p);
const jsFiles = dir => {
  const a = existsSync(join(dir, 'assets')) ? join(dir, 'assets') : dir;
  return readdirSync(a).filter(f => f.endsWith('.js')).map(f => join(a, f));
};
const gz = f => gzipSync(readFileSync(f)).length;
const raw = f => readFileSync(f).length;
const sum = xs => xs.reduce((a, b) => a + b, 0);

// VLQ-decode source-map mappings → minified bytes attributed per source module.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeVLQ(str) {
  const out = []; let shift = 0, value = 0;
  for (const c of str) {
    let d = B64.indexOf(c); const cont = d & 32; d &= 31;
    value += d << shift;
    if (cont) shift += 5;
    else { out.push(value & 1 ? -(value >> 1) : value >> 1); value = 0; shift = 0; }
  }
  return out;
}
function attributeMinifiedBytes(map, jsText) {
  const genLineLens = jsText.split('\n').map(l => l.length);
  const bytes = new Array((map.sources || []).length).fill(0);
  let srcIdx = 0; // source index persists (delta-encoded) across the whole mappings string
  (map.mappings || '').split(';').forEach((lineStr, gl) => {
    const lineLen = genLineLens[gl] ?? 0;
    if (!lineStr) return;
    let genCol = 0; const points = [];
    for (const seg of lineStr.split(',')) {
      const d = decodeVLQ(seg); genCol += d[0] || 0;
      if (d.length >= 4) { srcIdx += d[1]; points.push([genCol, srcIdx]); } else points.push([genCol, -1]);
    }
    for (let i = 0; i < points.length; i++) {
      const [col, si] = points[i];
      const next = i + 1 < points.length ? points[i + 1][0] : lineLen;
      if (si >= 0) bytes[si] += Math.max(0, next - col);
    }
  });
  return bytes;
}

// ---- 1. BUNDLE DELTA ----
const baseJs = jsFiles(BASE), sentryJs = jsFiles(SENTRY);
const baseGz = sum(baseJs.map(gz)), sentryGz = sum(sentryJs.map(gz));
const baseRaw = sum(baseJs.map(raw)), sentryRaw = sum(sentryJs.map(raw));
console.log('═══ 1. BUNDLE DELTA (what Sentry adds) ═══');
console.log(`  baseline JS : ${kb(baseRaw)} raw · ${kb(baseGz)} gzip  (${baseJs.length} chunks)`);
console.log(`  sentry   JS : ${kb(sentryRaw)} raw · ${kb(sentryGz)} gzip  (${sentryJs.length} chunks)`);
console.log(`  Δ Sentry    : +${kb(sentryRaw - baseRaw)} raw · +${kb(sentryGz - baseGz)} gzip  (+${(100 * (sentryGz - baseGz) / baseGz).toFixed(0)}%)`);

// ---- 2. WHERE IS SENTRY (per chunk, minified bytes from source maps) ----
console.log('\n═══ 2. WHERE IS SENTRY (per chunk, minified bytes) ═══');
const chunkShare = {};
for (const js of sentryJs) {
  const mapPath = js + '.map';
  if (!existsSync(mapPath)) { console.log(`  ${basename(js)}: (no source map)`); continue; }
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const bytes = attributeMinifiedBytes(map, readFileSync(js, 'utf8'));
  let total = 0, sentry = 0; const pkgs = {};
  bytes.forEach((b, i) => {
    total += b; const s = map.sources[i] || '';
    if (isSentry(s)) {
      sentry += b;
      const pkg = (s.match(/(@sentry(?:-internal)?[/+][^/]+)/) || [])[1]?.replace('+', '/') || '@sentry';
      pkgs[pkg] = (pkgs[pkg] || 0) + b;
    }
  });
  chunkShare[basename(js)] = { share: total ? sentry / total : 0, sentry };
  console.log(`  ${basename(js)}: ${sentry > 0 ? `Sentry ${kb(sentry)} / ${kb(total)} minified (${(100 * sentry / total).toFixed(1)}%)` : 'no Sentry'}`);
  Object.entries(pkgs).sort((a, b) => b[1] - a[1]).forEach(([p, b]) => console.log(`        ${p.padEnd(34)} ${kb(b)}`));
}

// ---- 3. CONNECT TO LIGHTHOUSE ----
if (LH && existsSync(LH)) {
  const lhr = JSON.parse(readFileSync(LH, 'utf8')); const A = lhr.audits; const ms = v => Math.round(v) + 'ms';
  console.log('\n═══ 3. LIGHTHOUSE (sentry build) + SENTRY SCRIPTING SHARE ═══');
  console.log('  score:', Math.round(lhr.categories.performance.score * 100),
    '| LCP', ms(A['largest-contentful-paint'].numericValue),
    '| TBT', ms(A['total-blocking-time'].numericValue),
    '| TTI', ms(A['interactive'].numericValue));
  const boot = A['bootup-time']?.details?.items || [];
  let totalEval = 0, sentryEval = 0;
  for (const it of boot) {
    const name = basename((it.url || '').split('?')[0]);
    const evalMs = it.scripting || 0; totalEval += evalMs;
    const share = chunkShare[name]?.share || 0; sentryEval += evalMs * share;
    if (evalMs > 5) console.log(`    ${ms(evalMs).padStart(7)} eval | ${(100 * share).toFixed(1).padStart(5)}% Sentry → ${ms(evalMs * share).padStart(6)} | ${name}`);
  }
  console.log('  ───');
  console.log(`  total Script Evaluation: ${ms(totalEval)}`);
  console.log(`  estimated SENTRY Script Evaluation: ${ms(sentryEval)}  (${(100 * sentryEval / totalEval || 0).toFixed(1)}% of all eval)`);
} else {
  console.log('\n(no --lh <lighthouse.json> given; skipping scripting connection)');
}
