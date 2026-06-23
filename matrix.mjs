// Layered config matrix: the DETERMINISTIC detector of per-layer Sentry cost.
// Bundle bytes have ~zero variance, so the no-sentry < errors < tracing < replay
// layering is unambiguous — unlike LCP, where the per-layer signal hides under noise.
//
//   node matrix.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const ORDER = ['no-sentry', 'errors-only', 'tracing', 'tracing-replay'];
const kb = b => (b / 1024).toFixed(1);
const jsBytes = dir => {
  const a = join('dist', dir, 'assets');
  if (!existsSync(a)) return null;
  const files = readdirSync(a).filter(f => f.endsWith('.js')).map(f => readFileSync(join(a, f)));
  return { raw: files.reduce((s, b) => s + b.length, 0), gz: files.reduce((s, b) => s + gzipSync(b).length, 0) };
};

const rows = ORDER.map(m => ({ mode: m, ...jsBytes(m) })).filter(r => r.raw != null);
const base = rows[0];
console.log('mode'.padEnd(16) + 'gzip'.padStart(9) + 'raw'.padStart(10) + 'Δ vs none'.padStart(12) + 'Δ vs prev'.padStart(12));
console.log('-'.repeat(59));
rows.forEach((r, i) => {
  const dNone = r.gz - base.gz;
  const dPrev = i ? r.gz - rows[i - 1].gz : 0;
  console.log(
    r.mode.padEnd(16) +
    `${kb(r.gz)}KB`.padStart(9) +
    `${kb(r.raw)}KB`.padStart(10) +
    (i ? `+${kb(dNone)}KB`.padStart(12) : '—'.padStart(12)) +
    (i ? `+${kb(dPrev)}KB`.padStart(12) : '—'.padStart(12)),
  );
});
console.log('\n(gzip is what ships; deltas are exact and reproduce identically every run)');
