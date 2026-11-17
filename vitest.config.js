import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The request log would print a line per test request.
    env: { LOG_LEVEL: 'silent' },
  },
});
