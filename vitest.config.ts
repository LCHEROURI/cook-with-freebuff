import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    env: {
      // Keep CI retry metadata from leaking into hermetic unit tests. Tests
      // that exercise rerun behavior explicitly override this value.
      GITHUB_RUN_ATTEMPT: '1',
    },
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/.freebuff/**'],
  },
});