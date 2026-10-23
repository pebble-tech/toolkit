import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const infra = (file: string) => fileURLToPath(new URL(`../packages/infra/src/${file}`, import.meta.url));

export default defineConfig({
  // Tests run the infra source: its own pack test rebuilds dist/ while this project runs.
  resolve: {
    alias: [
      { find: /^@pebbletech\/infra\/testing$/, replacement: infra('testing.ts') },
      { find: /^@pebbletech\/infra$/, replacement: infra('index.ts') },
    ],
  },
  test: {
    name: 'bootstrap',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
