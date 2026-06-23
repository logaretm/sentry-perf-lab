// A/B perf runner. Starts the three preview servers, drives headless Chrome via
// Playwright + CDP (4x CPU, optional Slow 4G, cache disabled), reloads each mode
// N times, reads ground-truth Performance entries, and prints median ± stddev
// tables + deltas vs baseline.
//
//   node runner.mjs [--runs 20] [--warmup 3] [--profile cpu4x|slow4g|all]
//
// Requires: npm run build:all  (dist/<mode> must exist), and Playwright chromium.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const RUNS = Number(arg('runs', 20));
const WARMUP = Number(arg('warmup', 3));
const WHICH = arg('profile', 'all');

const MODES = [
  { key: 'baseline', port: 4190 },
  { key: 'sentry', port: 4191 },
  { key: 'sentry-eager', port: 4192 },
];

// Decimal-Mbps Slow 4G: 1.6 down / 0.75 up / 150ms RTT (bytes/s, ms).
const PROFILES = {
  cpu4x: { label: 'CPU 4x (no network throttle)', cpu: 4, net: null },
  slow4g: {
    label: 'CPU 4x + Slow 4G (1.6/0.75 Mbps, 150ms RTT)',
    cpu: 4,
    net: { offline: false, downloadThroughput: (1.6 * 1e6) / 8, uploadThroughput: (0.75 * 1e6) / 8, latency: 150 },
  },
};
const SELECTED = WHICH === 'all' ? Object.keys(PROFILES) : [WHICH];

// Runs in the page. Returns one sample of ground-truth metrics.
const READER = () => {
  const p = window.__perf || {};
  const lt = p.longTasks || [];
  const res = performance.getEntriesByType('resource');
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const meas = n => {
    const e = performance.getEntriesByName(n)[0];
    return e ? Math.round(e.duration * 10) / 10 : null;
  };
  return {
    fcp: p.fcp != null ? Math.round(p.fcp) : null,
    lcp: p.lcp != null ? Math.round(p.lcp) : null,
    load: Math.round(nav.loadEventEnd || 0),
    apiBatch: meas('api.batch'),
    initExec: meas('sentry.init'),
    longTasks: lt.length,
    jsKB: Math.round(res.filter(r => r.name.endsWith('.js')).reduce((a, r) => a + (r.encodedBodySize || 0), 0) / 1024),
  };
};

const METRICS = [
  ['fcp', 'FCP (ms)'],
  ['lcp', 'LCP (ms)'],
  ['apiBatch', 'API burst (ms)'],
  ['initExec', 'init() exec (ms)'],
  ['jsKB', 'JS transferred (KB)'],
  ['longTasks', 'long tasks'],
];

function median(xs) {
  const v = xs.filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function stddev(xs) {
  const v = xs.filter(x => x != null);
  if (v.length < 2) return 0;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
}
const fmt = (m, s) => (m == null ? '—' : `${m} ± ${Math.round(s)}`);

function startServer({ key, port }) {
  if (!existsSync(`dist/${key}/index.html`)) {
    throw new Error(`dist/${key} missing — run: npm run build:all`);
  }
  const child = spawn('npx', ['vite', 'preview', '--outDir', `dist/${key}`, '--port', String(port), '--strictPort'], {
    stdio: 'ignore',
  });
  return child;
}
async function waitForPort(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server on :${port} never came up`);
}

async function measureMode(browser, mode, profile) {
  const page = await browser.newPage();
  const client = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  if (profile.net) await client.send('Network.emulateNetworkConditions', profile.net);

  const samples = [];
  for (let i = 0; i < WARMUP + RUNS; i++) {
    await page.goto(`http://localhost:${mode.port}/`, { waitUntil: 'load', timeout: 60000 });
    // Wait until the on-mount API burst has fully settled (api.batch measure exists).
    await page.waitForFunction(() => performance.getEntriesByName('api.batch').length > 0, { timeout: 40000 }).catch(() => {});
    await sleep(profile.net ? 800 : 400); // let LCP / deferred idle callback settle
    const m = await page.evaluate(READER);
    if (i >= WARMUP) samples.push(m);
    process.stdout.write('.');
  }
  await page.close();

  const agg = {};
  for (const [key] of METRICS) {
    const xs = samples.map(s => s[key]);
    agg[key] = { m: median(xs), s: stddev(xs) };
  }
  return agg;
}

function printTable(profileLabel, results) {
  console.log(`\n## ${profileLabel}  (median ± stddev, n=${RUNS})\n`);
  const header = ['Metric', ...MODES.map(m => m.key)];
  const rows = METRICS.map(([key, label]) => [label, ...MODES.map(m => fmt(results[m.key][key].m, results[m.key][key].s))]);
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map(r => String(r[c]).length)));
  const line = cells => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  rows.forEach(r => console.log(line(r)));

  // Deltas vs baseline.
  const base = results.baseline;
  console.log('\n  Δ vs baseline (median):');
  for (const m of MODES.slice(1)) {
    const parts = METRICS.filter(([k]) => k !== 'longTasks').map(([k, label]) => {
      const d = results[m.key][k].m != null && base[k].m != null ? results[m.key][k].m - base[k].m : null;
      return `${label.replace(/ \(.*/, '')} ${d == null ? '—' : (d >= 0 ? '+' : '') + d}`;
    });
    console.log(`    ${m.key}: ${parts.join(', ')}`);
  }
}

async function main() {
  console.log(`Profile-page Sentry overhead — runs=${RUNS}, warmup=${WARMUP}, profiles=${SELECTED.join(',')}`);
  const servers = MODES.map(startServer);
  try {
    await Promise.all(MODES.map(m => waitForPort(m.port)));
    for (const profKey of SELECTED) {
      const profile = PROFILES[profKey];
      const browser = await chromium.launch({ headless: true });
      const results = {};
      for (const mode of MODES) {
        process.stdout.write(`\n[${profKey}] ${mode.key} `);
        results[mode.key] = await measureMode(browser, mode, profile);
      }
      await browser.close();
      console.log();
      printTable(profile.label, results);
    }
  } finally {
    servers.forEach(s => s.kill());
  }
}

main().then(
  () => process.exit(0),
  err => {
    console.error('\n' + (err.stack || err.message));
    process.exit(1);
  },
);
