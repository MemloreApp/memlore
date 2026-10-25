import { defineConfig } from 'vitest/config';

// Mobile logic tests only (`*.test.ts`); no React Native component tests.
// happy-dom gives the editor tests a DOM to mount ProseMirror on.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'ios/**', 'android/**'],
  },
});
