# Profile-page Sentry overhead lab

A/B benchmark for the **load-time cost of `@sentry/react`** on a realistic,
request-heavy profile page (banner + avatar + bio + tabs + 100-post feed with
real lazy-loaded images, plus a 17-call API burst over `fetch` + `XHR` on mount).

Uses the **published `@sentry/react` from npm** (pinned to `10.55.0` — bump in
`package.json` to test another version) and the customer's exact logged-out init.

## Modes

| Mode | What it is |
|---|---|
| `baseline` | No Sentry (tree-shaken out entirely) |
| `sentry` | Customer's config: errors-only at init (`browserApiErrorsIntegration({eventTarget:false})` + `thirdPartyErrorFilterIntegration`), tracing + `breadcrumbs({fetch,history})` **deferred** to `requestIdleCallback` |
| `sentry-eager` | Same, but tracing + breadcrumbs installed **in `init()`** — fetch/XHR wrapped during the load burst (upper bound) |

## Run

```bash
npm install
npm run build:all          # generates assets + builds all three modes
npm run preview:baseline   # :4190
npm run preview:sentry     # :4191
npm run preview:sentry-eager  # :4192
```

## Measure

The page installs `PerformanceObserver`s (FCP/LCP/longtask) in `index.html` and
`performance.measure`s for `sentry.init`, `sentry.defer`, and `api.batch`. Read
them from a throttled headless Chrome (DevTools 4× CPU / Slow 4G, cache off) via:

```js
performance.getEntriesByName('sentry.init')[0].duration   // init exec
performance.getEntriesByName('api.batch')[0].duration      // the API burst
window.__perf                                              // { fcp, lcp, longTasks }
```

A/B the deltas across modes. Report median of N≥20 runs; never a single number.
