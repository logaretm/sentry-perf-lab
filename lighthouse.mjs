// Reproduces the per-config LCP table with REAL (DevTools) throttling, median of N.
// Serves each built config, runs Lighthouse N times, prints median LCP/score/TBT.
//
//   npm run build:matrix && node lighthouse.mjs [--runs 5]
//
// Uses Lighthouse's default mobile profile (Slow 4G + 4x CPU) via --throttling-method=devtools,
// which MEASURES metrics under real throttling instead of modeling them (lantern).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as Sentry from '@sentry/node';

// Send results to Sentry as metrics when a DSN is configured. No-op without one,
// so local runs stay offline unless you opt in via SENTRY_DSN.
const SENTRY_ON = Boolean(process.env.SENTRY_DSN);
if (SENTRY_ON) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENV || 'perf-lab',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0,
  });
}

// Spawn the vite binary directly (not via npm/npx) so killing the PID actually
// stops the server — `npm run` would orphan its vite child and leak the port.
const VITE = resolve('node_modules/.bin/vite');

const RUNS = Number((process.argv[process.argv.indexOf('--runs') + 1]) || 5);
const MODES = [
  { mode: 'no-sentry', port: 4190 },
  { mode: 'errors-only', port: 4191 },
  { mode: 'tracing', port: 4192 },
  { mode: 'tracing-replay', port: 4193 },
];

const median = xs => { const v = [...xs].sort((a, b) => a - b); const m = v.length >> 1; return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); };

// Raw TCP probe — same thing curl does. (Node's fetch can't reach the dev server
// here; a socket connect is the reliable, env-agnostic readiness check.)
function canConnect(port) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => { s.destroy(); res(false); });
  });
}
async function waitForPort(port) {
  for (let i = 0; i < 80; i++) { if (await canConnect(port)) return true; await sleep(500); }
  return false;
}

const servers = [];
for (const { mode, port } of MODES) {
  if (!existsSync(`dist/${mode}/index.html`)) throw new Error(`dist/${mode} missing — run: npm run build:matrix`);
  servers.push(spawn(VITE, ['preview', '--outDir', `dist/${mode}`, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' }));
}

try {
  for (const { port } of MODES) if (!(await waitForPort(port))) throw new Error(`server on :${port} did not start`);
  console.log(`Lighthouse · real DevTools throttling (Slow 4G + 4x CPU) · median of ${RUNS}\n`);
  console.log('config'.padEnd(18) + 'LCP'.padStart(9) + 'score'.padStart(8) + 'TBT'.padStart(8) + '   Δ LCP vs no-sentry');
  console.log('-'.repeat(60));
  let baseLcp = null;
  for (const { mode, port } of MODES) {
    const lcps = [], scores = [], tbts = [];
    for (let r = 0; r < RUNS; r++) {
      // Lighthouse can exit non-zero on warnings while still writing valid JSON — tolerate it.
      try {
        execFileSync('npx', ['lighthouse', `http://127.0.0.1:${port}/`, '--only-categories=performance',
          '--throttling-method=devtools', '--output=json', '--output-path=/tmp/lh-lab.json',
          '--chrome-flags=--headless=new --no-sandbox', '--quiet'], { stdio: 'ignore' });
      } catch {}
      const lhr = JSON.parse(readFileSync('/tmp/lh-lab.json', 'utf8'));
      if (lhr.runtimeError) throw new Error(`Lighthouse: ${lhr.runtimeError.code}`);
      lcps.push(Math.round(lhr.audits['largest-contentful-paint'].numericValue));
      scores.push(Math.round(lhr.categories.performance.score * 100));
      tbts.push(Math.round(lhr.audits['total-blocking-time'].numericValue));
    }
    const mLcp = median(lcps);
    const mScore = median(scores);
    const mTbt = median(tbts);
    if (baseLcp == null) baseLcp = mLcp;
    if (SENTRY_ON) {
      // One metric series per scenario so each config charts independently and
      // can be compared side by side. `config` attribute kept for filtering too.
      // Sentry normalizes `-` to `_` in metric names, so emit the normalized form
      // directly — keeps the queryable name identical to what's written here.
      const key = mode.replace(/-/g, '_');
      const attributes = { config: mode };
      Sentry.metrics.distribution(`lighthouse.${key}.lcp`, mLcp, { unit: 'millisecond', attributes });
      Sentry.metrics.distribution(`lighthouse.${key}.tbt`, mTbt, { unit: 'millisecond', attributes });
      Sentry.metrics.gauge(`lighthouse.${key}.performance_score`, mScore, { attributes });
    }
    console.log(
      mode.padEnd(18) + `${mLcp}ms`.padStart(9) + String(mScore).padStart(8) + `${mTbt}ms`.padStart(8) +
      (mLcp === baseLcp ? '   —' : `   +${mLcp - baseLcp}ms`),
    );
  }
} finally {
  servers.forEach(s => s.kill());
  if (SENTRY_ON) await Sentry.flush(5000);
}
