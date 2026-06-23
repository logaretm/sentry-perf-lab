# Sentry browser SDK perf isolation lab

An A/B benchmark for the **load-time cost of the Sentry browser SDK** on a realistic,
client-rendered profile page (banner + avatar + bio + tabs + 100-post feed with real
lazy-loaded images, plus a 17-call API burst over `fetch` + `XHR` on mount).

Pinned to `@sentry/react@10.58.0` (change the one line in `package.json` to test another
version or a local tarball).

## Config matrix

Each mode is a separate production build where the SDK is tree-shaken down to exactly
that config — so bundle deltas are real, not runtime flags.

| Mode | Sentry config |
|---|---|
| `no-sentry` | SDK fully tree-shaken out (baseline) |
| `errors-only` | `init()` + `browserApiErrorsIntegration` + `thirdPartyErrorFilterIntegration` |
| `tracing` | errors-only + `browserTracingIntegration` |
| `tracing-replay` | tracing + `replayIntegration` |

## Run it

Requires [pnpm](https://pnpm.io) 10 (pinned via `packageManager`).

```bash
pnpm install
pnpm build:matrix         # builds all four configs (production, minified, sourcemaps on)
```

Then any of the three reports:

```bash
# 1. Bundle layering — deterministic, zero-variance detector of per-layer cost
pnpm matrix

# 2. Bundle delta + WHERE Sentry lives (minified bytes, from source maps)
#    + optional Lighthouse scripting join:  --lh <lighthouse.json>
pnpm analyze                                      # no-sentry vs tracing-replay (default)
node analyze.mjs --base dist/no-sentry --sentry dist/errors-only   # any pair

# 3. Per-config LCP/score/TBT — REAL DevTools throttling (Slow 4G + 4x CPU), median of 5
pnpm lighthouse                                   # use --runs 20 for tighter CIs
```

`pnpm bench` is an alternative runtime runner (Playwright + CDP, FCP/LCP/longtask via
the User Timing API) across CPU-only and Slow-4G profiles.

## Ship Lighthouse results to Sentry as metrics

`pnpm lighthouse` can emit each scenario's median LCP/TBT/score to Sentry as
[trace metrics](https://docs.sentry.io) via `@sentry/node`'s `Sentry.metrics` API
(on by default in SDK v10 — no flag). It's a no-op unless `SENTRY_DSN` is set, so
local runs stay offline:

```bash
SENTRY_DSN="https://…@oXXXX.ingest.us.sentry.io/XXXX" \
  SENTRY_ENV=ci SENTRY_RELEASE=$(git rev-parse --short HEAD) \
  pnpm lighthouse
```

It writes one metric series **per scenario** so they chart independently:

| Metric | Type | Unit |
|---|---|---|
| `lighthouse.<mode>.lcp` | distribution | millisecond |
| `lighthouse.<mode>.tbt` | distribution | millisecond |
| `lighthouse.<mode>.performance_score` | gauge | none |

Each carries a `config:<mode>` attribute for filtering. Note Sentry normalizes `-`→`_`
in metric names, so `tracing-replay` is stored as `tracing_replay` (the script emits the
normalized form directly).

Query one from the [`sentry` CLI](https://cli.sentry.dev):

```bash
sentry explore <org>/<project> -m lighthouse.tracing.lcp --agg avg --dataset metrics --period 1h
```

Dashboard widgets use the `tracemetrics` dataset and require the full aggregate form
`agg(value,<metric>,<type>,<unit>)` (the `func:field` shorthand is rejected here):

```bash
sentry dashboard widget add <org>/<project> "<dashboard>" "LCP by scenario (ms)" \
  --dataset tracemetrics --display bar \
  --query "avg(value,lighthouse.no_sentry.lcp,distribution,millisecond)" \
  --query "avg(value,lighthouse.tracing_replay.lcp,distribution,millisecond)"
```

## Why this measures correctly

- **Build-time isolation** — the SDK is compiled in or fully out; the A/B delta *is* Sentry's cost.
- **Real (DevTools) throttling, not lantern** — metrics are measured, not modeled, so there are
  no impossible deltas. Run multiple times and take the median.
- **Minified-byte attribution** — `analyze.mjs` decodes the source-map mappings and cross-checks
  against the A/B delta, so "where is Sentry" reflects shipped bytes, not comment-heavy source.
