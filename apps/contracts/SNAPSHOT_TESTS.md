# Contract Snapshot Tests

The `energy_token`, `audit_registry`, and `community_governance` test suites
record Soroban ledger and authorization snapshots under each contract's
`test_snapshots/` directory. Contract CI runs all tests and fails if a test
changes, deletes, or adds a snapshot without a corresponding reviewed change.

## Event schema snapshots

In addition to the ledger/authorization snapshots, every contract event schema
has a serialised XDR snapshot committed under `apps/contracts/snapshots/`. These
snapshots pin the exact XDR encoding of each event's topics and data so that any
change to an event's shape or field ordering is caught in review.

The snapshots are organised per contract crate:

```
apps/contracts/snapshots/
  energy_token/
    MinterUpdated.xdr
    Transfer.xdr
    Approval.xdr
    Paused.xdr
  community_governance/
    ProposalCreated.xdr
    Voted.xdr
    ProposalFinalized.xdr
  audit_registry/
    Anchored.xdr
```

### Covered events

| Contract              | Event               |
| --------------------- | ------------------- |
| `energy_token`        | `MinterUpdated`     |
| `energy_token`        | `Transfer`          |
| `energy_token`        | `Approval`          |
| `energy_token`        | `Paused`            |
| `community_governance`| `ProposalCreated`   |
| `community_governance`| `Voted`             |
| `community_governance`| `ProposalFinalized` |
| `audit_registry`      | `Anchored`          |

Each contract crate contains a `snapshot_tests` module with one test per event.
Each test emits the event through the contract, serialises the emitted topics
and data to XDR, and compares the result against the committed snapshot file
`apps/contracts/snapshots/<contract>/<event>.xdr`.

### How the tests behave

- If the snapshot file is missing, the test writes it and passes (so the first
  run bootstraps the snapshot). The generated file must be reviewed and
  committed.
- If the snapshot file exists and the serialised XDR matches, the test passes.
- If the snapshot file exists and the serialised XDR diverges, the test fails,
  causing CI to fail. This is the intended guard against unreviewed event
  schema changes.
- Setting the `UPDATE_SNAPSHOTS` environment variable (to any value) rewrites
  the snapshot file with the current XDR and passes, allowing intentional
  updates to be regenerated.

## Updating snapshots

1. Run `cargo test --all` from `apps/contracts` to identify snapshot changes.
2. Review each changed snapshot alongside the Rust test and intended contract
   behavior. Do not accept snapshot changes solely to make CI pass.
3. Include intentional updates in the same change as the behavior they reflect.
4. Re-run `cargo test --all` and `bash scripts/check-contract-snapshots.sh` from
   the repository root. The check must pass with the reviewed snapshots committed.

### Regenerating event schema snapshots

To intentionally update an event schema snapshot:

1. Run the relevant test with `UPDATE_SNAPSHOTS=1`, e.g.
   `UPDATE_SNAPSHOTS=1 cargo test -p energy_token snapshot_tests`.
2. Review the regenerated `.xdr` files under `apps/contracts/snapshots/`.
3. Commit the updated snapshots together with the contract change that caused
   them.

New public entry points must have focused tests that exercise their behavior;
the resulting snapshots should be committed with those tests. New events must
add a corresponding entry to the covered events table above and a committed
snapshot under `apps/contracts/snapshots/`.