import { defineConfig } from 'vitest/config';
import { workspaceSources } from '../../vitest.sources';

export default defineConfig({
  resolve: { alias: workspaceSources() },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
