# Issue #19: Session Management and TOTP Design Blockers

Status: implementation deferred pending agreement on the authentication design.

The settings page cannot safely provide the requested session revocation and
two-factor controls on its own. Those controls must be backed by changes to
token issuance, refresh, and authentication enforcement.

## Current implementation gaps

- The login and refresh routes return access and refresh tokens in JSON. There
  is no settings-facing session API or session-aware client flow.
- The `operator_sessions` table is not used by the login, refresh, or logout
  routes. It stores a refresh token directly and has no device, IP, or
  last-seen metadata.
- Logout revokes only the current access-token JTI. There is no operation for
  listing or revoking another session, and no corresponding authorization
  policy for managing a user's sessions.
- No Supabase MFA enroll, challenge, verify, or unenroll flow is currently
  wired into the application. A settings toggle without login-time MFA
  enforcement would not provide two-factor protection.

## Work needed before the UI

1. Agree on a server-managed session model, including session identifiers,
   hashed refresh-token storage, expiry and last-seen updates, and how trusted
   proxy headers will be used to derive IP metadata.
2. Integrate session creation and rotation with login and refresh. Add
   authenticated endpoints that list only the caller's sessions and revoke a
   selected session, including invalidating its refresh and access tokens.
3. Define the Supabase TOTP enrollment, challenge, verification, disable, and
   recovery process. Enforce the required assurance level during login and
   sensitive operations before exposing an enable/disable control.
4. Once those contracts exist, add the session list, per-session revoke
   confirmation, and TOTP setup/disable UI with API and component tests.

This draft intentionally does not add a UI that would imply session revocation
or MFA protection that the backend does not yet enforce. Please confirm the
session model and MFA flow before implementing the acceptance criteria.