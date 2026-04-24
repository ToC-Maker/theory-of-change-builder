import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Bindings come from wrangler.jsonc; add a `miniflare` override here for test-only bindings.
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      // Workerd (the runtime Cloudflare Workers tests run in) doesn't
      // expose `node:inspector/promises`, which the default `v8` provider
      // requires. Istanbul instruments source at transform time instead
      // and works cross-runtime.
      provider: 'istanbul',
      reporter: ['text', 'html'],
      include: ['worker/**/*.ts', 'shared/**/*.ts', 'src/**/*.ts', 'src/**/*.tsx'],
    },
  },
});
