import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'cms',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
