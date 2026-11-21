// @ts-check
/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */

// Minimum mutation score enforced in CI. Configurable via MUTATION_THRESHOLD
// (defaults to 70 per issue #756). high/low remain at 90 per issue #97.
const mutationThreshold = Number(process.env.MUTATION_THRESHOLD ?? 70);

const config = {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.config.ts' },
  mutate: [
    'src/app/api/verify/route.ts',
    'src/app/api/audit-log/route.ts',
  ],
  // high/low kept at 90 per issue #97; break is configurable via
  // MUTATION_THRESHOLD (default 70) per issue #756.
  thresholds: { high: 90, low: 90, break: mutationThreshold },
  reporters: ['html', 'progress', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  // Stable path parsed by the CI workflow to build the PR comment.
  jsonReporter: { fileName: 'reports/mutation/report.json' },
  coverageAnalysis: 'perTest',
  timeoutMS: 30000,
};
export default config;