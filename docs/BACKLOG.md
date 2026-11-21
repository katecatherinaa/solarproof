# Backlog

## Multi-cooperative support (#608)

- Description: Add support for multi-cooperative setups where multiple cooperative organizations can operate under the SolarProof platform. This includes data partitioning, governance scopes, and UI flows to switch or manage cooperatives.
- Acceptance Criteria:
  - Backlog entry created and prioritized for planning
  - High-level technical notes and potential impact areas identified (database, contracts, UI, governance)
  - Link to issue: #608

### Notes

- Considerations: multi-tenant data isolation, cooperative-specific governance, permissions and roles, UI for cooperative selection and onboarding.
- Potential follow-ups: design doc, database schema changes, contract updates, UI/UX mockups.

## Real-time certificate alerts

- Description: Add real-time alerts when certificate status changes (e.g. issuance, verification failure, expiry, retirement).
- Acceptance Criteria:
  - Backlog entry created for planning
  - High-level scope identified (notification channels, event sources, delivery guarantees)
- Notes:
  - Recreated without labels after earlier label errors.

## STRIDE threat model mitigations (#779)

The following entries schedule mitigations for the high/critical threats identified during the STRIDE review of the current architecture. See `docs/THREAT_MODEL.md` for the full analysis, ratings, and component mapping.

### TM-01: Enforce authorization on certificate state transitions (Critical)

- Description: STRIDE (Elevation of Privilege) review found that certificate state transitions (issuance, verification, retirement) can be invoked without consistent role/ownership checks across API and contract layers. Enforce a single authorization policy for all state-changing operations.
- Acceptance Criteria:
  - Centralized authorization checks applied to all certificate state-transition endpoints and contract entry points
  - Negative tests covering unauthorized and cross-cooperative transition attempts
  - Audit log entry emitted for every state transition with actor identity
  - Link to issue: #780

### TM-02: Harden event/notification pipeline against spoofing and replay (High)

- Description: STRIDE (Spoofing, Tampering) review found that certificate status events feeding the real-time alert pipeline lack origin authentication and replay protection, allowing forged or replayed status changes to trigger alerts.
- Acceptance Criteria:
  - Event payloads signed and verified at ingestion
  - Replay protection via monotonic sequence numbers or nonce tracking
  - Alert delivery tests covering forged and replayed events
  - Link to issue: #781

### TM-03: Prevent sensitive data disclosure in logs and error responses (High)

- Description: STRIDE (Information Disclosure) review found that error responses and application logs may include certificate holder PII and internal identifiers. Introduce redaction and structured error handling.
- Acceptance Criteria:
  - Redaction rules applied to logs and error responses for PII and secrets
  - Error responses return generic messages with correlation IDs
  - Tests asserting no sensitive fields appear in logs or API errors
  - Link to issue: #782

### TM-04: Rate-limit and abuse-protect verification endpoints (High)

- Description: STRIDE (Denial of Service) review found that public certificate verification endpoints are unthrottled, enabling enumeration and resource exhaustion.
- Acceptance Criteria:
  - Per-client rate limits applied to verification and lookup endpoints
  - Enumeration-resistant responses (uniform timing/response shape)
  - Load tests validating throttling behavior under abuse scenarios
  - Link to issue: #783

### TM-05: Tamper-evident audit trail for governance actions (High)

- Description: STRIDE (Repudiation) review found that governance and administrative actions lack a tamper-evident audit trail, making it difficult to attribute or dispute changes.
- Acceptance Criteria:
  - Append-only, tamper-evident audit log for governance and admin actions
  - Integrity verification job and alerting on detected tampering
  - Documentation of retention and access controls for audit records
  - Link to issue: #784

### Notes

- Threat IDs (TM-01..TM-05) map to entries in `docs/THREAT_MODEL.md`.
- Review performed by at least 2 engineers as required by #779.
- Follow-up: re-run STRIDE review after mitigations land and update `docs/THREAT_MODEL.md` with a new date.