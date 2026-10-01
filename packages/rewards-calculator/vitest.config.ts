import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.ts'],
    exclude: [...configDefaults.exclude, 'test/setup.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
