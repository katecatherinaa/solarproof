# Mutation Testing

Mutation testing verifies that the test suite actually catches bugs, not just that it executes code. A mutant is a small code change (e.g. flipping `>` to `>=`, removing a `return Err`). If no test fails, the mutant "survives" — indicating a gap in test quality.

## Tools

| Layer | Tool | Config |
|---|---|---|
| Rust contracts | [cargo-mutants](https://mutants.rs) | `apps/contracts/.cargo-mutants.toml` |
| TypeScript (`packages/stellar`) | [Stryker](https://stryker-mutator.io) | `packages/stellar/stryker.config.mjs` |

## Thresholds

Critical modules (reading verification, signature validation, token minting)
are held to a **< 10% surviving mutants** standard (≥ 90 % mutation score).
The CI job fails if the score drops below this.

| Score | Meaning |
|---|---|
| ≥ 90% | High — required for critical modules |
| 80–89% | Acceptable — investigate survivors |
| < 90% | Break — CI fails for critical modules |

### CI gate (`MUTATION_THRESHOLD`)

The TypeScript (Stryker) CI job enforces a **minimum mutation score of 70%** by
default. The gate is configurable via the `MUTATION_THRESHOLD` environment
variable (or the `mutation_threshold` workflow input), expressed as a percentage
(e.g. `70`). If the overall mutation score falls below the threshold, the job
fails.

To adjust the gate, set `MUTATION_THRESHOLD` in the workflow env or pass it when
triggering the workflow manually. Keep it at or above 70% for `packages/stellar`
unless there is a documented reason to relax it.

## Running Locally

### Rust (cargo-mutants)

```bash
# Install once
cargo install cargo-mutants --locked --version 24.11.0

# Run against the two critical contracts
cd apps/contracts
cargo mutants --package audit_registry --package energy_token
```

Results are written to `apps/contracts/mutants-out/`. Open `mutants-out/outcomes.json` or the text summary to see surviving mutants.

### TypeScript (Stryker)

```bash
cd packages/stellar
pnpm install
pnpm test:mutation
```

HTML report: `packages/stellar/reports/mutation/index.html`

JSON report: `packages/stellar/reports/mutation/mutation-report.json` — Stryker's
`json` reporter is enabled in `packages/stellar/stryker.config.mjs`. This file is
consumed by CI to compute the mutation score and list surviving mutants.

## CI Schedule

Mutation testing runs on a **weekly schedule** (Sunday 02:00 UTC) via `.github/workflows/mutation-testing.yml`. It is not run on every PR due to the time cost.

You can also trigger it manually from the Actions tab with an optional `target` input (`all` | `rust` | `typescript`).

Artifacts (reports) are retained for 30 days.

### PR comment summary

When the workflow runs against a pull request, CI parses
`packages/stellar/reports/mutation/mutation-report.json` and posts a summary
comment on the PR containing:

- the overall **mutation score** and whether it meets `MUTATION_THRESHOLD`
  (default 70%),
- the count of **surviving mutants** and their locations,
- a link to the uploaded report artifact.

The comment is updated in place on re-runs (matched by a hidden marker) rather
than posting duplicates, so the PR always shows the latest result.

## Scope

### Rust — targeted contracts

- `audit_registry` — immutable anchor of signed meter readings (critical path)
- `energy_token` — SEP-41 certificate token, mint/burn/transfer logic

`community_governance` is excluded from the initial scope (lower risk, less critical).

Excluded from mutation (trivial getters with no logic):
- `get_version`, `admin`, `api_signer` (audit_registry)
- `name`, `symbol`, `decimals`, `admin` (energy_token)

### TypeScript — `packages/stellar`

Mutates `src/**/*.ts` (excluding test files). Key targets:
- `kwhToStroops` / `stroopsToKwh` — unit conversion used in every mint
- `NETWORKS` / `CONTRACT_IDS` — network configuration

## Interpreting Results

A **surviving mutant** means a code change went undetected by tests. For each survivor:

1. Read the mutant diff in the report.
2. Decide if it represents a real bug scenario.
3. If yes, add a test that kills it.
4. If the mutation is semantically equivalent (impossible to observe), add it to the `exclude_re` list in `.cargo-mutants.toml` or Stryker's `mutate` excludes.

## Tracking Over Time

Stryker JSON reports (`packages/stellar/reports/mutation/mutation-report.json`) and cargo-mutants `outcomes.json` are uploaded as GitHub Actions artifacts on every run. Compare scores across runs to track trends. The same JSON report drives the PR comment summary and the `MUTATION_THRESHOLD` gate.
