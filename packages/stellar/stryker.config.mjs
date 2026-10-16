// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
  },
  mutate: ['src/**/*.ts', '!src/**/*.test.ts'],
  coverageAnalysis: 'perTest',
  // Thresholds raised from 70/70/80 to 90/90/90 per issue #97.
  // Goal: < 10% surviving mutants across critical modules
  // (kwhToStroops, stroopsToKwh, NETWORKS, CONTRACT_IDS).
  thresholds: {
    high: 90,
    low: 90,
    break: 90,
  },
  reporters: ['html', 'clear-text', 'progress', 'json'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  jsonReporter: {
    fileName: 'reports/mutation/mutation-report.json',
  },
  timeoutMS: 30000,
  concurrency: 2,
}

export default config
