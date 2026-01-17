---
name: renovate-github-action-guide
description: Apply the "GitHub Actions and Renovate Guide" to configure repo settings, branch protection, GitHub App/PAT secrets, and renovate.json5 for personal or team GitHub projects. Use when asked to introduce Renovate, enable dependency auto-updates, or align settings with the guide.
---

# Renovate GitHub Actions Guide

## Prerequisites

**Required:**
- GitHub CLI installed and authenticated: `gh auth login`
- Repository admin access
- Token scopes: `repo`, `admin:org` (for org repos), `workflow`

**Quick verification:**
```bash
# Check admin access and required scopes
gh auth status
gh api repos/$OWNER/$REPO | jq -e '.permissions.admin == true' || echo "Need admin access"
```

**If setup fails:** See `references/GH_CLI_SETUP.md` for detailed authentication troubleshooting and permission requirements.

## Quick Start

**1. Check existing setup:**
```bash
ls -la renovate.json* .github/renovate.json* .renovaterc* 2>/dev/null
gh pr list --author "renovate[bot]" --limit 5
```

**2. Identify project type:**
- Personal: Single maintainer
- Team: Multiple maintainers, requires reviews
- Public (single maintainer): Can use hosted Renovate App → Skip to Step 3

**3. Collect inputs:**
- Repo: owner/name, default branch
- CI: workflow names
- Schedule: timezone, auto-merge policy

**4. Follow workflow steps below**

## Public Repository (Single Maintainer) - Simplified Setup

If your repository is public with a single maintainer, you can use a much simpler setup:

**What you can skip:**
- GitHub App setup (use hosted Renovate App instead)
- Fine-grained PAT for approvals
- GitHub Environment for secrets
- Renovate GitHub Actions workflow
- Complex branch protection rules

**Minimal setup steps:**
1. Enable auto-merge in repository settings
2. Install the [Renovate GitHub App](https://github.com/apps/renovate)
3. Add `.github/renovate.json5` or `renovate.json` to your repository
4. (Optional) Configure basic branch protection for required status checks

**IMPORTANT: Support Fork PRs**

If accepting contributions from forks, add fork-aware conditions to workflows:

```yaml
jobs:
  # Jobs that need secrets (should NOT run on fork PRs)
  auto-merge:
    if: |
      github.event_name != 'pull_request' ||
      ! github.event.pull_request.head.repo.fork
    steps:
      # Uses secrets - safe from fork access

  # Jobs that don't need secrets (SHOULD run on fork PRs)
  tests:
    # No condition - runs on all PRs including forks
    steps:
      # No secrets used - safe for forks
```

**Why this matters:**
- Fork PRs can't access repository secrets (security feature)
- Workflows with secrets will fail on fork PRs
- Tests and checks should run on forks
- Auto-merge and approval jobs should skip forks

See `references/guide.md` "Fork PR conditions" section for complete patterns.

See `references/guide.md` "Public repository (single maintainer)" section for complete details.

## Workflow

Copy this checklist and track your progress:

```
Renovate Setup Progress:
- [ ] Prerequisites: gh CLI authenticated, admin access verified
- [ ] Step 1: Repository settings + status-check job + branch protection
- [ ] Step 2: GitHub App setup + secrets (or use hosted app)
- [ ] Step 3: Add renovate.json5 (choose preset)
- [ ] Step 4: (Optional) Self-hosted workflow
- [ ] Step 5: Validation + test PR
```

### Step 1: Apply repository settings and branch protection rules

**Required permissions:**
- Repository: Admin access
- Scope: `repo` (full control)
- Organization: "Repository" → "Administration" permission

**Verify before proceeding:**
```bash
# Must return true
gh api repos/$OWNER/$REPO | jq '.permissions.admin'
```

**CRITICAL: Implement `status-check` job pattern first**

Before configuring branch protection, you MUST add a `status-check` job to your CI workflows:

1. **Why it's required:**
   - Prevents accidental merges when re-running failed jobs
   - Provides a single, reliable status check for branch protection
   - Ensures ALL required checks pass before merge

2. **Implementation options:**

   **Option A: Unified workflow (recommended for new projects)**
   - Use `assets/workflows/ci-unified-example.yml` as template
   - Consolidates all CI checks into one workflow
   - Uses `dorny/paths-filter` for conditional execution
   - Single `status-check` job depends on all checks

   **Option B: Add status-check to existing workflows (easier migration)**
   - Keep existing workflow files
   - Add a status-check job to each workflow
   - See `references/BRANCH_PROTECTION.md` "Migration Strategy"

3. **See complete implementation guide:**
   - `references/BRANCH_PROTECTION.md` for detailed examples and patterns
   - `assets/workflows/ci-unified-example.yml` for working example

**Repository settings:**
```bash
# Enable auto-merge (requires admin access)
gh api -X PATCH repos/$OWNER/$REPO -f allow_auto_merge=true
# If error 403: Need repository admin access
# If error 404: Repository not found or no access
```

**Branch protection for default branch:**

After implementing status-check job:

```bash
# Personal project (basic)
# Requires: admin access, repo scope
gh api -X PUT repos/$OWNER/$REPO/branches/$BRANCH/protection \
  --input - <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["status-check"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

For team projects with reviews, see `references/BRANCH_PROTECTION.md`.

**For team projects only:**
Add dedicated branch protection for `renovate/*` branches:

```bash
# Requires: admin access, repo scope
gh api -X PUT repos/$OWNER/$REPO/branches/renovate%2F*/protection \
  --input - <<EOF
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": {
    "users": [],
    "teams": [],
    "apps": ["renovate"]
  },
  "allow_force_pushes": {"enabled": true},
  "allow_deletions": {"enabled": true}
}
EOF
```

**Validation:**
```bash
# Verify auto-merge is enabled
gh api repos/$OWNER/$REPO | jq '.allow_auto_merge'

# Check branch protection
gh api repos/$OWNER/$REPO/branches/$BRANCH/protection | jq '{required_status_checks, enforce_admins}'

# Verify status-check is the required check
gh api repos/$OWNER/$REPO/branches/$BRANCH/protection | jq '.required_status_checks.contexts'
# Expected: ["status-check"]
```

### Step 2: Set up GitHub App and secrets

**Choose authentication method:**

1. **Hosted Renovate App** (simplest):
   - Install [Renovate GitHub App](https://github.com/apps/renovate)
   - Select repositories → Done
   - Skip to Step 3

2. **Self-hosted with GitHub App** (full control):

   **Quick setup:**
   a. Create app: https://github.com/settings/apps/new
      - Name: `renovate-bot-<username>` (globally unique)
      - Permissions: `contents: write`, `pull-requests: write`, `workflows: write` (optional)
      - Webhook: Disabled

   b. Generate private key → Download `.pem` file

   c. Install app to repositories

   d. Store secrets:
   ```bash
   # Personal project
   gh secret set RENOVATE_APP_ID --body "<app-id>"
   gh secret set RENOVATE_APP_PRIVATE_KEY < private-key.pem

   # Team project (environment) - protects secrets with branch policy
   gh api -X PUT repos/$OWNER/$REPO/environments/renovate --input - <<EOF
   {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   EOF
   gh secret set RENOVATE_APP_ID --env renovate --body "<app-id>"
   gh secret set RENOVATE_APP_PRIVATE_KEY --env renovate < private-key.pem
   ```

   e. Configure bot username in renovate.json5:
   ```json5
   {"username": "renovate-bot-<your-username>[bot]"}
   ```

   Find exact username after first run:
   ```bash
   gh pr list --author "renovate" --json author --jq '.[0].author.login'
   ```

**Detailed guide:** See `references/GITHUB_APP_SETUP.md` for troubleshooting, permission details, and alternative setups.

### Step 3: Add and customize renovate.json5

**Check for existing configuration first:**
```bash
# Check for existing Renovate config
if [ -f renovate.json ] || [ -f .github/renovate.json5 ] || [ -f .renovaterc ]; then
  echo "Renovate config already exists. Validating..."
  # Skip to validation step
else
  echo "No Renovate config found. Creating new configuration..."
fi
```

If configuration already exists, validate it with Step 5 and skip the rest of this step.

**Choose configuration preset:**
- `assets/renovate.json5` - Minimal (extends external config)
- `assets/renovate-conservative.json5` - Conservative updates (stable dependencies)
- `assets/renovate-aggressive.json5` - Aggressive updates (latest versions quickly)

**Place config file:**
```bash
# Copy chosen preset to your repository
cp assets/renovate-conservative.json5 .github/renovate.json5
```

**Customize as needed:**
- Schedule: Adjust timezone and frequency
- Labels: Add project-specific labels
- Auto-merge: Configure which update types to auto-merge
- Bot username: Set when using GitHub App (see guide)

**Validation:**
```bash
# Validate JSON5 syntax
npx -p renovate renovate-config-validator .github/renovate.json5
```

### Step 4: (Optional) Add Renovate GitHub Actions workflow

**When to use:**
- Self-hosting Renovate (not using hosted Renovate App)
- Need custom runner or private registry access

**Setup:**
```bash
# Copy workflow template
mkdir -p .github/workflows
cp assets/workflows/renovate.yml .github/workflows/renovate.yml
```

**Configure workflow:**
- Update secret names to match Step 2
- Adjust schedule (default: daily at 2 AM)
- Set `repositories` parameter if managing multiple repos

See `references/renovate-action.md` for action inputs and GitHub App token usage.

**Validation:**
```bash
# Check workflow syntax
actionlint .github/workflows/renovate.yml

# Trigger manual run to test
gh workflow run renovate.yml
```

### Step 5: Validate configuration

**Check Renovate config:**
```bash
npx -p renovate renovate-config-validator .github/renovate.json5
```

**Verify GitHub settings:**
```bash
# Repository settings
gh api repos/$OWNER/$REPO | jq '{allow_auto_merge, default_branch}'

# Branch protection
gh api repos/$OWNER/$REPO/branches/$BRANCH/protection | jq '{required_status_checks, required_pull_request_reviews}'

# Secrets are configured
gh api repos/$OWNER/$REPO/actions/secrets | jq '.secrets[].name'
```

**Test with dry-run** (if self-hosting):
```bash
# Add --dry-run to workflow for testing
# Or run locally:
npx renovate --dry-run --token=$GITHUB_TOKEN $OWNER/$REPO
```

## Decision Notes

- If using the `github-actions` manager, ensure the token has workflow permissions.
- Ask before enabling auto-merge and agree on which updates are safe to merge automatically.

## Assets

- `assets/renovate.json5`: starter Renovate config (minimal).
- `assets/renovate-conservative.json5`: conservative update strategy preset.
- `assets/renovate-aggressive.json5`: aggressive update strategy preset.
- `assets/workflows/renovate.yml`: Renovate GitHub Actions workflow template (self-hosting only).
- `assets/workflows/ci-unified-example.yml`: **unified CI workflow with status-check job pattern**.

## References

- `references/guide.md`: summarized settings from the guide (personal vs team).
- `references/renovate-action.md`: Renovate GitHub Action usage details.
- `references/VALIDATION.md`: validation commands and troubleshooting guide.
- `references/BRANCH_PROTECTION.md`: **status-check job pattern and branch protection configuration**.
- `references/GITHUB_APP_SETUP.md`: **complete GitHub App creation and configuration guide**.
- `references/GH_CLI_SETUP.md`: **GitHub CLI authentication, required scopes, and permission requirements**.
