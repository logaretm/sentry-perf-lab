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

```bash
npm install
npm run build:matrix      # builds all four configs (production, minified, sourcemaps on)
```

Then any of the three reports:

```bash
# 1. Bundle layering — deterministic, zero-variance detector of per-layer cost
npm run matrix

# 2. Bundle delta + WHERE Sentry lives (minified bytes, from source maps)
#    + optional Lighthouse scripting join:  -- --lh <lighthouse.json>
npm run analyze                                   # no-sentry vs tracing-replay (default)
node analyze.mjs --base dist/no-sentry --sentry dist/errors-only   # any pair

# 3. Per-config LCP/score/TBT — REAL DevTools throttling (Slow 4G + 4x CPU), median of 5
npm run lighthouse                                # use -- --runs 20 for tighter CIs
```

`npm run bench` is an alternative runtime runner (Playwright + CDP, FCP/LCP/longtask via
the User Timing API) across CPU-only and Slow-4G profiles.

## Why this measures correctly

- **Build-time isolation** — the SDK is compiled in or fully out; the A/B delta *is* Sentry's cost.
- **Real (DevTools) throttling, not lantern** — metrics are measured, not modeled, so there are
  no impossible deltas. Run multiple times and take the median.
- **Minified-byte attribution** — `analyze.mjs` decodes the source-map mappings and cross-checks
  against the A/B delta, so "where is Sentry" reflects shipped bytes, not comment-heavy source.
