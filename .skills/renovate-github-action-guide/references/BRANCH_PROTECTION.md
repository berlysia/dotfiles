# Branch Protection Configuration Guide

This guide provides concrete examples for configuring branch protection rules to work with Renovate auto-merge.

## Core Concept: The `status-check` Job Pattern

**Why use a dedicated status-check job?**

```yaml
# ❌ Bad: Setting individual jobs as required checks
# Branch protection requires: [typescript-check, shell-check, json-validation]
#
# Problem: If typescript-check fails and you re-run only that job,
# the other jobs are skipped. Branch protection sees all checks "passed"
# (because they exist from the previous run) and allows merge.

# ✅ Good: Single status-check job that depends on all required jobs
# Branch protection requires: [status-check]
#
# Benefit: status-check ALWAYS runs and checks ALL dependencies.
# If you re-run a failed job, status-check re-evaluates everything.
```

## Example: Unified Workflow with status-check

See `assets/workflows/ci-unified-example.yml` for a complete example.

**Key components:**

1. **Path filter job**: Determines which checks to run
2. **Individual check jobs**: Conditional execution based on path filter
3. **status-check job**:
   - `needs:` all required jobs
   - `if: always()` to run even if dependencies fail/skip
   - Fails if any dependency failed or was cancelled

## Configuring Branch Protection

### Using gh CLI

**Basic configuration (personal project):**

```bash
# Enable branch protection with required status checks
gh api -X PUT repos/$OWNER/$REPO/branches/$BRANCH/protection \
  --input - <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["status-check"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

**With PR requirement (personal project):**

```bash
gh api -X PUT repos/$OWNER/$REPO/branches/$BRANCH/protection \
  --input - <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["status-check"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

**Team project (with reviews):**

```bash
gh api -X PUT repos/$OWNER/$REPO/branches/$BRANCH/protection \
  --input - <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["status-check"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

### Using GitHub UI

1. Go to **Settings** → **Branches** → **Add rule** (or edit existing)

2. **Branch name pattern**: `master` (or your default branch)

3. Enable these settings:
   - ✅ **Require a pull request before merging**
     - (Optional) Require approvals: 1
     - ✅ Dismiss stale pull request approvals when new commits are pushed
     - ✅ Require review from Code Owners
     - ✅ Require approval of the most recent reviewable push

   - ✅ **Require status checks to pass before merging**
     - ✅ Require branches to be up to date before merging
     - Search and add: `status-check`

   - ✅ **Do not allow bypassing the above settings**

4. Click **Create** or **Save changes**

## Team Project: Renovate Branch Protection

For team projects, add dedicated protection for Renovate branches:

```bash
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
  "allow_force_pushes": {
    "enabled": true
  },
  "allow_deletions": {
    "enabled": true
  },
  "block_creations": {
    "enabled": false
  },
  "required_linear_history": {
    "enabled": false
  },
  "required_signatures": {
    "enabled": false
  }
}
EOF
```

**Key settings:**
- `restrictions`: Only Renovate app can push to `renovate/*` branches
- `allow_force_pushes`: Renovate needs this to rebase/amend commits
- `allow_deletions`: Allow branch cleanup after merge

## Verification

**Check current branch protection:**

```bash
gh api repos/$OWNER/$REPO/branches/$BRANCH/protection | jq '{
  required_status_checks,
  required_pull_request_reviews,
  enforce_admins,
  allow_force_pushes,
  allow_deletions
}'
```

**Expected output for personal project:**

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["status-check"]
  },
  "required_pull_request_reviews": {
    "required_approving_review_count": 0
  },
  "enforce_admins": {
    "enabled": true
  },
  "allow_force_pushes": {
    "enabled": false
  },
  "allow_deletions": {
    "enabled": false
  }
}
```

## Migration Strategy

**If you have existing workflows with individual required checks:**

### Step 1: Add status-check job to existing workflows

Don't unify workflows immediately. First, add the status-check pattern:

```yaml
# Add to EACH existing workflow
jobs:
  # ... existing jobs ...

  status-check-typescript:  # Unique name per workflow
    runs-on: ubuntu-latest
    needs: [check]  # Depends on jobs in THIS workflow
    if: always()
    steps:
      - name: Check job status
        run: |
          if [[ "${{ contains(needs.*.result, 'failure') }}" == "true" ]]; then
            exit 1
          fi
```

### Step 2: Update branch protection

```bash
# Add new status-check jobs to required checks
gh api -X PATCH repos/$OWNER/$REPO/branches/$BRANCH/protection/required_status_checks \
  --input - <<EOF
{
  "strict": true,
  "contexts": [
    "status-check-typescript",
    "status-check-shell",
    "status-check-json"
  ]
}
EOF
```

### Step 3: Monitor for one sprint/week

Ensure all PRs pass with the new pattern.

### Step 4: Unify workflows (optional)

Once confident, consolidate into a single workflow with paths-filter.
See `assets/workflows/ci-unified-example.yml`.

### Step 5: Simplify branch protection

```bash
# Now only require the single status-check
gh api -X PATCH repos/$OWNER/$REPO/branches/$BRANCH/protection/required_status_checks \
  --input - <<EOF
{
  "strict": true,
  "contexts": ["status-check"]
}
EOF
```

## Common Issues

### Issue: status-check job is skipped

**Cause:** Missing `if: always()`

**Solution:**
```yaml
status-check:
  needs: [job1, job2]
  if: always()  # ← Required!
```

### Issue: PR merges despite failed checks

**Cause:** Old check results from previous commits still exist

**Solution:**
- Ensure `strict: true` in required_status_checks
- This forces checks to run on the latest commit after merge

### Issue: Can't push to renovate/* branches

**Cause:** Branch protection blocking Renovate bot

**Solution:** Add dedicated branch protection rule for `renovate/*` with restrictions allowing only Renovate app

## Workflow Organization Best Practices

### Keep actionlint in a Separate Workflow

**Why separate actionlint from main CI workflow?**

```yaml
# ❌ Bad: actionlint in main CI workflow
# .github/workflows/ci.yml
jobs:
  actionlint:
    # If THIS workflow has a syntax error, actionlint can't run!
    # You won't get feedback about the broken workflow.

  typescript-check:
    # Other checks...

# ✅ Good: actionlint in its own workflow
# .github/workflows/lint-actions.yml
jobs:
  actionlint:
    # This workflow can check OTHER workflows
    # Even if ci.yml is broken, this can still run and report the error
```

**Implementation:**

```yaml
# .github/workflows/lint-actions.yml
name: Lint GitHub Actions
on:
  push:
    branches: [master, main]
    paths:
      - '.github/workflows/**'
  pull_request:
    branches: [master, main]
    paths:
      - '.github/workflows/**'

jobs:
  actionlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run actionlint
        uses: reviewdog/action-actionlint@v1
```

**Key point:** Don't include actionlint in the status-check dependencies of the main CI workflow. It should be independent.

## Best Practices

1. **Keep status-check separate from auto-merge/approval jobs**
   - status-check: Validates CI results
   - auto-merge: Enables GitHub auto-merge feature
   - approval: Adds review approval
   - These are different concerns - don't combine them

2. **Keep actionlint in its own workflow**
   - Prevents circular dependency (workflow can't check itself)
   - Ensures workflow syntax errors are caught
   - Don't add to main workflow's status-check dependencies

3. **Always use `if: always()` on status-check job**
   - Ensures it runs even when dependencies fail

4. **List ALL required jobs in `needs:`**
   - Missing a job means it won't be validated

5. **Use single status-check in branch protection**
   - Not individual job names
   - Prevents the re-run bypass issue

6. **Consider workflow consolidation carefully**
   - Multiple focused workflows: Easier to understand, parallel execution
   - Single unified workflow: One status-check, simpler branch protection
   - Use paths-filter for conditional execution in unified workflows

7. **Test with a real PR before enabling auto-merge**
   - Create a test PR
   - Verify status-check job runs
   - Verify it fails when a dependency fails
   - Verify branch protection blocks merge
