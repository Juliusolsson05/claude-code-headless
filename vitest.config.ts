import { defineConfig } from 'vitest/config'

// Test harness unified with agent-code's conventions (vitest, colocated
// src/**/*.test.ts) — replaces the earlier ad-hoc `tsx scripts/test-*.ts`
// pattern so headless-library regressions run under the same runner and
// CI shape as the app that consumes them.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.system.test.ts', 'src/**/*.live.test.ts'],
        },
      },
      {
        test: {
          name: 'system',
          environment: 'node',
          include: ['src/**/*.system.test.ts'],
          passWithNoTests: true,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // WHY this denominator is explicit: imported-files-only coverage can
      // increase when an untested source module is added because that module is
      // omitted entirely. Every production TypeScript file must count even
      // before it gains its first focused test.
      include: ['src/**/*.ts'],
      // WHY these start at the measured honest baseline rather than an
      // aspirational number: the first gate must prevent regression without
      // making unrelated fixes responsible for years of uncovered behavior.
      // Raise the numbers in the same PR that adds durable coverage.
      thresholds: { statements: 17, branches: 18, functions: 13, lines: 18 },
    },
  },
})
