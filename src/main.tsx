import {
  browserApiErrorsIntegration,
  browserTracingIntegration,
  init,
  replayIntegration,
  thirdPartyErrorFilterIntegration,
} from '@sentry/react';
import { createRoot } from 'react-dom/client';
import Profile from './Profile';

declare global {
  interface Window {
    __perf: { fcp: number | null; lcp: number | null; longTasks: { start: number; dur: number }[] };
  }
}

const DSN = 'https://0123456789abcdef0123456789abcdef@localhost:9980/1';
const errorsIntegrations = () => [
  browserApiErrorsIntegration({ eventTarget: false }),
  thirdPartyErrorFilterIntegration({ filterKeys: ['profile-lab'], behaviour: 'drop-error-if-exclusively-contains-third-party-frames' }),
];

function boot(opts: Parameters<typeof init>[0]): void {
  performance.mark('init:start');
  init(opts);
  performance.mark('init:end');
  performance.measure('sentry.init', 'init:start', 'init:end');
}

// One explicit branch per config so Rollup tree-shakes each build down to exactly
// the integrations that mode imports — that's what makes the bundle layering real.
const M = import.meta.env.MODE;
if (M === 'errors-only') {
  boot({ dsn: DSN, sampleRate: 1, integrations: errorsIntegrations() });
} else if (M === 'tracing') {
  boot({ dsn: DSN, sampleRate: 1, tracesSampleRate: 1, integrations: [...errorsIntegrations(), browserTracingIntegration()] });
} else if (M === 'tracing-replay') {
  boot({
    dsn: DSN,
    sampleRate: 1,
    tracesSampleRate: 1,
    replaysSessionSampleRate: 1,
    integrations: [...errorsIntegrations(), browserTracingIntegration(), replayIntegration()],
  });
}
// 'no-sentry' / 'baseline': @sentry/react is fully tree-shaken out.

createRoot(document.getElementById('root')!).render(<Profile />);
requestAnimationFrame(() => performance.mark('boot:rendered'));
