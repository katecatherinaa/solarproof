#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

snapshot_dirs=(
  apps/contracts/snapshots
  apps/contracts/energy_token/test_snapshots
  apps/contracts/audit_registry/test_snapshots
  apps/contracts/community_governance/test_snapshots
)

if ! git diff --quiet -- "${snapshot_dirs[@]}"; then
  printf '%s\n' "Contract snapshots changed during tests. Review the behavior change and update snapshots intentionally."
  git --no-pager diff -- "${snapshot_dirs[@]}"
  exit 1
fi

untracked="$(git ls-files --others --exclude-standard -- "${snapshot_dirs[@]}")"
if [[ -n "$untracked" ]]; then
  printf '%s\n' "Tests generated untracked contract snapshots:"
  printf '%s\n' "$untracked"
  exit 1
fi