// Two-project Vitest configuration.
//
// Project "workerd": runs everything under `tests/worker/**`, `tests/client/**`,
// `tests/shared/**`, and the top-level `tests/*.test.ts` files inside the
// Cloudflare Workers runtime via `@cloudflare/vitest-pool-workers`. These
// tests exercise Worker bindings and shared helpers that need the workerd
// environment.
//
// Project "frontend": runs `tests/frontend/**` in jsdom for React/RTL
// component and hook tests. This is the redesign's first jsdom-env project;
// PR 23 introduced `tests/client/` and `tests/shared/` but those run in
// workerd because they don't need a DOM.
//
// Coverage stays at the top level so a single `vitest --coverage` run reports
// combined output across both projects.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      // Workerd (the runtime Cloudflare Workers tests run in) doesn't
      // expose `node:inspector/promises`, which the default `v8` provider
      // requires. Istanbul instruments source at transform time instead
      // and works cross-runtime.
      provider: 'istanbul',
      reporter: ['text', 'html'],
      include: ['worker/**/*.ts', 'shared/**/*.ts', 'src/**/*.ts', 'src/**/*.tsx'],
    },
    projects: [
      {
        plugins: [
          // Bindings come from wrangler.jsonc; add a `miniflare` override
          // here for test-only bindings.
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'workerd',
          include: [
            'tests/worker/**/*.test.ts',
            'tests/client/**/*.test.ts',
            'tests/shared/**/*.test.ts',
            'tests/*.test.ts',
          ],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['tests/frontend/**/*.test.{ts,tsx}'],
          // `@testing-library/jest-dom/vitest` extends Vitest's expect with
          // matchers like `toBeInTheDocument()` and registers cleanup hooks
          // that unmount RTL trees after each test.
          setupFiles: ['@testing-library/jest-dom/vitest'],
        },
      },
    ],
  },
});
