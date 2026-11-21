#!/usr/bin/env bash
#
# check-migration-rollback.sh
#
# Verifies that every forward migration in supabase/migrations/ has a
# corresponding rollback script in supabase/migrations/rollbacks/ and that
# applying the forward migrations followed by the rollback scripts (in reverse
# order) returns the database schema to its previous state.
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/check-migration-rollback.sh
#
# Options:
#   -h, --help    Show this help message and exit.
#
# Requirements:
#   - psql
#   - pg_dump
#   - diff
#   - DATABASE_URL environment variable pointing at a disposable database
#
# Exit codes:
#   0  All migrations applied and rolled back cleanly with matching schemas.
#   1  A migration or rollback failed, or a schema mismatch was detected.
#   2  Missing prerequisites or invalid invocation.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/supabase/migrations"
ROLLBACKS_DIR="${MIGRATIONS_DIR}/rollbacks"

# ---------------------------------------------------------------------------
# Colors / logging helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  COLOR_RESET="\033[0m"
  COLOR_INFO="\033[1;34m"
  COLOR_WARN="\033[1;33m"
  COLOR_ERROR="\033[1;31m"
  COLOR_OK="\033[1;32m"
else
  COLOR_RESET=""
  COLOR_INFO=""
  COLOR_WARN=""
  COLOR_ERROR=""
  COLOR_OK=""
fi

info()  { printf "${COLOR_INFO}[info]${COLOR_RESET}  %s\n" "$*"; }
warn()  { printf "${COLOR_WARN}[warn]${COLOR_RESET}  %s\n" "$*" >&2; }
error() { printf "${COLOR_ERROR}[error]${COLOR_RESET} %s\n" "$*" >&2; }
ok()    { printf "${COLOR_OK}[ok]${COLOR_RESET}    %s\n" "$*"; }

usage() {
  cat <<'EOF'
Usage: check-migration-rollback.sh [--help]

Applies all forward migrations in supabase/migrations/ (sorted
lexicographically), then applies the corresponding rollback scripts in
supabase/migrations/rollbacks/ in reverse order, verifying after each rollback
that the schema matches the snapshot taken before the migration was applied.

Environment:
  DATABASE_URL   Postgres connection string for a disposable database.

Exit codes:
  0  Success
  1  Migration/rollback failure or schema mismatch
  2  Missing prerequisites or invalid invocation
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "${arg}" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "Unknown argument: ${arg}"
      usage >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
if [[ -z "${DATABASE_URL:-}" ]]; then
  error "DATABASE_URL is not set. Point it at a disposable Postgres database."
  exit 2
fi

for cmd in psql pg_dump diff; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    error "Required command not found: ${cmd}"
    exit 2
  fi
done

if [[ ! -d "${MIGRATIONS_DIR}" ]]; then
  error "Migrations directory not found: ${MIGRATIONS_DIR}"
  exit 2
fi

if [[ ! -d "${ROLLBACKS_DIR}" ]]; then
  error "Rollbacks directory not found: ${ROLLBACKS_DIR}"
  exit 2
fi

# ---------------------------------------------------------------------------
# Temp workspace
# ---------------------------------------------------------------------------
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/migration-rollback.XXXXXX")"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
run_sql_file() {
  local file="$1"
  psql "${DATABASE_URL}" \
    --no-psqlrc \
    --quiet \
    --set ON_ERROR_STOP=1 \
    --file "${file}"
}

snapshot_schema() {
  local out_file="$1"
  pg_dump "${DATABASE_URL}" \
    --schema-only \
    --no-owner \
    --no-privileges \
    --no-comments \
    > "${out_file}"
}

# ---------------------------------------------------------------------------
# Collect forward migrations (exclude rollbacks/ subdirectory)
# ---------------------------------------------------------------------------
mapfile -t MIGRATIONS < <(
  find "${MIGRATIONS_DIR}" -maxdepth 1 -type f -name '*.sql' -print \
    | sort
)

if [[ ${#MIGRATIONS[@]} -eq 0 ]]; then
  warn "No forward migrations found in ${MIGRATIONS_DIR}"
  exit 0
fi

info "Found ${#MIGRATIONS[@]} forward migration(s)."

# ---------------------------------------------------------------------------
# Apply forward migrations, capturing a schema snapshot before each one.
# ---------------------------------------------------------------------------
declare -a MIGRATION_NAMES=()
declare -a SNAPSHOT_BEFORE=()

info "Capturing baseline schema snapshot..."
BASELINE_SNAPSHOT="${TMP_DIR}/snapshot-baseline.sql"
if ! snapshot_schema "${BASELINE_SNAPSHOT}"; then
  error "Failed to capture baseline schema snapshot."
  exit 1
fi

for migration in "${MIGRATIONS[@]}"; do
  name="$(basename "${migration}" .sql)"
  info "Applying forward migration: ${name}"

  before_snapshot="${TMP_DIR}/snapshot-before-${name}.sql"
  cp "${BASELINE_SNAPSHOT}" "${before_snapshot}"

  if ! run_sql_file "${migration}"; then
    error "Failed to apply forward migration: ${name}"
    exit 1
  fi

  MIGRATION_NAMES+=("${name}")
  SNAPSHOT_BEFORE+=("${before_snapshot}")

  # Update baseline for the next iteration.
  if ! snapshot_schema "${BASELINE_SNAPSHOT}"; then
    error "Failed to capture schema snapshot after migration: ${name}"
    exit 1
  fi
done

ok "All forward migrations applied successfully."

# ---------------------------------------------------------------------------
# Apply rollbacks in reverse order, verifying schema after each.
# ---------------------------------------------------------------------------
info "Applying rollbacks in reverse order..."

FAILURES=0

for (( i=${#MIGRATION_NAMES[@]}-1; i>=0; i-- )); do
  name="${MIGRATION_NAMES[$i]}"
  before_snapshot="${SNAPSHOT_BEFORE[$i]}"
  rollback_file="${ROLLBACKS_DIR}/${name}.sql"

  if [[ ! -f "${rollback_file}" ]]; then
    error "Missing rollback script for migration: ${name} (expected ${rollback_file})"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  info "Applying rollback: ${name}"

  if ! run_sql_file "${rollback_file}"; then
    error "Failed to apply rollback: ${name}"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  after_snapshot="${TMP_DIR}/snapshot-after-rollback-${name}.sql"
  if ! snapshot_schema "${after_snapshot}"; then
    error "Failed to capture schema snapshot after rollback: ${name}"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  if ! diff -u "${before_snapshot}" "${after_snapshot}" > "${TMP_DIR}/diff-${name}.txt"; then
    error "Schema mismatch after rolling back: ${name}"
    warn "Diff (before migration vs. after rollback):"
    sed 's/^/    /' "${TMP_DIR}/diff-${name}.txt" >&2 || true
    FAILURES=$((FAILURES + 1))
    continue
  fi

  ok "Rollback verified: ${name}"
done

# ---------------------------------------------------------------------------
# Final result
# ---------------------------------------------------------------------------
if [[ ${FAILURES} -ne 0 ]]; then
  error "Migration rollback check failed with ${FAILURES} error(s)."
  exit 1
fi

ok "All migrations rolled back cleanly; schema matches pre-migration state."
exit 0