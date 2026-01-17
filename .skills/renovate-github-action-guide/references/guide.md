# Guide Summary (GitHub Actions and Renovate)

This file captures concrete settings and phrasing from the guide. Use it to configure repo settings.

## Branch protection: default branch (baseline)

- "Require a pull request before merging"
- "Require status checks to pass before merging"
- Required status checks: `status-check`

## Dedicated `status-check` job

- Add a job named `status-check` that depends on all other required jobs.
- Configure branch protection to require only `status-check`.
- Do **not** merge `status-check` with auto-merge/approval jobs.
  - If a required job fails and you re-run only that job, the combined job can be skipped and the PR may merge unexpectedly.

## One workflow for `pull_request`

- Merge all `pull_request` workflows into one workflow that always runs.
- Use `dorny/paths-filter` to run downstream jobs conditionally.
- Keep `actionlint` in its own workflow.
  - If the main workflow becomes invalid, `actionlint` in the same workflow cannot run.

## Auto-merge guidance

- Use GitHub auto-merge.
- `platformAutomerge` only applies to the initial PR and does not respect workflow results.
- Enable auto-merge by GitHub Actions with a GitHub App token, not `GITHUB_TOKEN`.
  - `GITHUB_TOKEN` does not trigger other workflows.
- Dependency updates must be tested by CI to safely enable auto-merge.

## Settings: personal project

- Repository setting: allow auto-merge.
- Branch protection (default branch):
  - "Require a pull request before merging"
  - "Require status checks to pass before merging"
  - Required status checks: `status-check`
  - "Do not allow bypassing the above settings"
- GitHub App (Renovate) permissions:
  - `contents: write` (push commits, enable auto-merge)
  - `pull-requests: write` (enable auto-merge, approve PRs)
- Workflows:
  - `test` workflow (includes `status-check` job)
  - `actionlint` workflow (separate)

## Settings: team development

### Default branch protection (review enforcement)

- "Require a pull request before merging"
- "Require approvals" (1)
- "Dismiss stale pull request approvals when new commits are pushed"
- "Require review from Code Owners"
- "Require approval of the most recent reviewable push"
- "Require status checks to pass before merging"
- Required status checks: `status-check`
- "Do not allow bypassing the above settings"

### Renovate branch protection (`renovate/*`)

- "Require a pull request before merging"
- "Do not allow bypassing the above settings"
- "Restrict who can push to matching branches"
  - Allow only `renovate` and the dedicated GitHub App
- "Restrict pushes that create matching branches"
  - Allow only `renovate` and the dedicated GitHub App
- "Allow deletions"
- "Allow force pushes"
  - "Specify who can force push": `renovate`

### Dedicated GitHub App and secrets

- Use a **dedicated GitHub App** for pushing commits to Renovate PRs.
- Use it only in workflows triggered by Renovate PRs.
- Store the App private key in a GitHub Environment (e.g., `renovate`) and restrict deployment branches.
- Environment secrets (example names used in the guide):
  - `APP_ID`
  - `APP_PRIVATE_KEY`
  - `GH_TOKEN_APPROVE_RENOVATE_PR`

### Approving Renovate PRs via workflow

- Use a fine-grained PAT with `pull-requests: write`.
- Use it in workflows to approve Renovate PRs.

### Optional update-branch workflow

- Triggered by `issue_comment`.
- Requires default branch access to the App private key because `issue_comment` runs on the default branch.

## Public repository (single maintainer)

- Support pull requests from forks.
- You can skip:
  - PAT for approvals
  - Dedicated GitHub App for pushing commits to Renovate PRs
  - GitHub Environment for Renovate
  - Renovate GitHub Actions workflow (hosted Renovate App is enough)

## Fork PR conditions

The guide uses this pattern:

```
if: |
  github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork
```

Non-fork case:

```
if: |
  github.event_name != 'pull_request' || ! github.event.pull_request.head.repo.fork
```

## Cost note

- Consider self-hosted runners if additional jobs increase billing.
- Examples of additional jobs: `status-check`, `paths-filter`, `approve-and-enable-automerge-renovate`.
