// @ts-check
/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.config.ts' },
  mutate: [
    'src/app/api/verify/route.ts',
    'src/app/api/audit-log/route.ts',
  ],
  // Thresholds raised from 70/50/40 to 90/90/90 per issue #97.
  // Goal: < 10% surviving mutants across critical modules
  // (verify API route, audit-log route).
  thresholds: { high: 90, low: 90, break: 90 },
  reporters: ['html', 'progress', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/report.json' },
  coverageAnalysis: 'perTest',
  timeoutMS: 30000,
};
export default config;
