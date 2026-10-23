import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'infra',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
