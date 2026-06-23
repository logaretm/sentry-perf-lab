import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    // Match a typical prod app: minified, modern target.
    target: 'es2020',
    // Source maps let the analyzer attribute minified bytes back to @sentry/* modules.
    // They don't affect runtime (the .map is only fetched when DevTools is open).
    sourcemap: true,
  },
});
