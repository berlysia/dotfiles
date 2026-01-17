# Renovate GitHub Action Usage (Self-hosted only)

Use this file only when running Renovate via GitHub Actions (self-hosted).
If you install the Renovate GitHub App (hosted), do **not** add a Renovate workflow.
In that case, only add `.github/renovate.json5`.

## Core pattern (GitHub App token)

- Create a token with `actions/create-github-app-token`.
- Pass the token to `renovatebot/github-action`.
- Point Renovate to `.github/renovate.json5` via `configurationFile`.

## Key inputs

- `token`: GitHub App token or PAT for Renovate.
- `configurationFile`: path to Renovate config (e.g., `.github/renovate.json5`).
- `repositories`: optional list of `owner/repo` to restrict scope.

## Notes

- If using the `github-actions` manager to update workflow files, the token must have workflow permissions.
- Prefer major version pinning for the Renovate action (e.g., `@v44`).
