# Changelog

## 1.1.0 — emailed and expiring invites, members, roles, rename, invite list and revoke (story 2.8)

- Migration `0002_invite_email_expiry.sql`: `mw_invites` gains nullable `email` (stored lower-cased) and `expires_at`
  (ISO-8601, UTC). Existing invites stay open and never expire.
- `POST /workspaces/:id/invites` takes an optional `email` and an optional `expiresInSeconds` (60 seconds to 90 days;
  no expiry by default), and answers them back as `email` and `expiresAt`.
- Accept refuses an expired invite (410 `INVITE_EXPIRED`) and an emailed invite whose address is not the caller's
  verified email, ignoring case (403 `INVITE_EMAIL_MISMATCH`). It still never changes an existing member's role
  (409 `ALREADY_MEMBER`).
- New routes, with the same auth (API keys refused) and rank rules: `GET /workspaces/:id/members`, `PATCH
  /workspaces/:id` (rename; admin or owner), `PATCH /workspaces/:id/members/:userId` (set a role; the caller must rank
  strictly above the old and the new role, so no owner is made or unmade), `GET /workspaces/:id/invites` (unused
  invites, expired ones flagged; admin or owner), `DELETE /workspaces/:id/invites/:token` (admin or owner) and
  `GET /workspaces/invites/mine` (pending, unexpired invites addressed to the caller's email). Writes on a suspended
  workspace are refused.
- The routes no longer read change counts: accept, member removal and the delete fence read their outcome back. The
  same SQL then works when `mw_*` are views over an app's own tables (docs/adopting-existing-tables.md).

## 1.0.0 — initial versioned release
