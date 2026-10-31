import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'examples/*', 'bootstrap', 'cluster-operators'],
  },
});
