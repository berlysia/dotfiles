# Renovate Configuration Validation

This document provides validation steps and troubleshooting guidance for Renovate setup.

## Quick Validation Checklist

Run these commands to verify your Renovate setup:

```bash
# 1. Repository settings
gh api repos/$OWNER/$REPO | jq '{allow_auto_merge, default_branch}'

# 2. Branch protection
gh api repos/$OWNER/$REPO/branches/$BRANCH/protection | jq '{required_status_checks, required_pull_request_reviews}'

# 3. Secrets configured
gh api repos/$OWNER/$REPO/actions/secrets | jq '.secrets[].name'

# 4. Renovate config validation
npx -p renovate renovate-config-validator .github/renovate.json5

# 5. (If self-hosting) Workflow syntax
actionlint .github/workflows/renovate.yml
```

## Detailed Validation

### Repository Settings

**Check auto-merge is enabled:**
```bash
gh api repos/$OWNER/$REPO | jq '.allow_auto_merge'
# Expected: true
```

**If disabled, enable it:**
```bash
gh api -X PATCH repos/$OWNER/$REPO -f allow_auto_merge=true
```

### Branch Protection

**Check default branch protection:**
```bash
gh api repos/$OWNER/$REPO/branches/$BRANCH/protection
```

**Expected output includes:**
- `required_status_checks.strict: true`
- `required_status_checks.contexts` includes `status-check`
- `required_pull_request_reviews` (for team projects)
- `enforce_admins.enabled: true`

**Check Renovate branch protection** (team projects only):
```bash
gh api repos/$OWNER/$REPO/branches/renovate%2F*/protection
```

**Expected:**
- Restrictions on who can push
- Allow deletions and force pushes for Renovate bot

### GitHub App and Secrets

**List repository secrets:**
```bash
gh api repos/$OWNER/$REPO/actions/secrets | jq '.secrets[].name'
```

**Expected secrets:**
- Personal projects: `APP_ID`, `APP_PRIVATE_KEY` (or with RENOVATE_ prefix)
- Team projects: Same, plus `GH_TOKEN_APPROVE_RENOVATE_PR`

**Check environment secrets** (team projects):
```bash
gh api repos/$OWNER/$REPO/environments
gh api repos/$OWNER/$REPO/environments/renovate/secrets | jq '.secrets[].name'
```

**Test GitHub App token generation:**
```bash
# This is what Renovate workflow does
gh api -X POST apps/$APP_ID/installations/$INSTALLATION_ID/access_tokens \
  --input <(echo '{"repositories":["'$REPO'"]}')
```

### Renovate Configuration

**Validate JSON5 syntax:**
```bash
npx -p renovate renovate-config-validator .github/renovate.json5
```

**Expected output:**
```
 INFO: Validating .github/renovate.json5
 INFO: Config validated successfully
```

**Check for common issues:**
```bash
# Ensure timezone is valid
jq -r '.timezone' .github/renovate.json5

# Ensure schedule syntax is correct
jq -r '.schedule[]' .github/renovate.json5

# Check automerge settings
jq -r '.packageRules[] | select(.automerge == true) | .description' .github/renovate.json5
```

### Renovate Workflow (Self-hosting only)

**Validate workflow syntax:**
```bash
actionlint .github/workflows/renovate.yml
```

**Check workflow is enabled:**
```bash
gh api repos/$OWNER/$REPO/actions/workflows | jq '.workflows[] | select(.name == "Renovate")'
```

**Trigger manual workflow run:**
```bash
gh workflow run renovate.yml
```

**Check recent workflow runs:**
```bash
gh run list --workflow=renovate.yml --limit=5
```

**View workflow logs:**
```bash
gh run view $(gh run list --workflow=renovate.yml --limit=1 --json databaseId --jq '.[0].databaseId')
```

### Dry Run Test

**Test Renovate without creating PRs:**
```bash
# If self-hosting
npx renovate --dry-run --token=$GITHUB_TOKEN $OWNER/$REPO

# Expected: No errors, lists detected dependencies
```

**Check Renovate discovers dependencies:**
```bash
npx renovate --dry-run --token=$GITHUB_TOKEN $OWNER/$REPO 2>&1 | grep "Detected"
```

## Troubleshooting

**Note:** Issues are ordered by frequency. Start with the most common problems first.

### Issue: Branch protection preventing PRs

**Diagnosis:**
```bash
# Check what's blocking the PR
gh pr checks $PR_NUMBER

# Check branch protection rules
gh api repos/$OWNER/$REPO/branches/$BRANCH/protection
```

**Solutions:**
- Ensure `status-check` job exists in CI workflow
- Add Renovate bot to bypass list (team projects)
- Verify required status checks match actual job names

### Issue: Auto-merge not working

**Diagnosis:**
```bash
# 1. Check repository setting
gh api repos/$OWNER/$REPO | jq '.allow_auto_merge'

# 2. Check if PRs have auto-merge enabled
gh pr list --label renovate --json number,autoMergeRequest
```

**Solutions:**
- Enable auto-merge in repository settings
- Ensure GitHub App token (not `GITHUB_TOKEN`) is used for enabling auto-merge
- Verify all required status checks are passing

### Issue: Renovate not detecting dependencies

**Diagnosis:**
```bash
# Run with debug logging
npx renovate --dry-run --log-level=debug --token=$GITHUB_TOKEN $OWNER/$REPO 2>&1 | grep -i "manager detected"
```

**Solutions:**
- Ensure package files are in standard locations
- Check if manager is enabled in config
- Verify file formats are valid (package.json, requirements.txt, etc.)

### Issue: GitHub App permissions insufficient

**Diagnosis:**
```bash
# Check app installation permissions
gh api apps/$APP_ID/installations | jq '.[] | select(.account.login == "'$OWNER'") | .permissions'
```

**Solutions:**
- Verify app has `contents: write` and `pull-requests: write`
- For GitHub Actions updates, ensure `workflows: write`
- Reinstall GitHub App with updated permissions

### Issue: Too many PRs created at once

**Diagnosis:**
```bash
# Check current PR limits
jq '{prConcurrentLimit, prHourlyLimit, prCreation}' .github/renovate.json5
```

**Solutions:**
- Lower `prConcurrentLimit` (default: 10, try 3-5)
- Set `prCreation: "not-pending"` to wait for CI
- Use grouping rules to combine related updates
- Adjust schedule to less frequent updates

### Issue: Secrets not accessible in workflow

**Diagnosis:**
```bash
# Check environment restrictions
gh api repos/$OWNER/$REPO/environments/renovate | jq '.deployment_branch_policy'

# Check which branch triggered the workflow
gh run view $RUN_ID --json headBranch
```

**Solutions:**
- Environment secrets: Ensure branch matches deployment_branch_policy
- Repository secrets: No branch restrictions apply
- Verify secret names match exactly (case-sensitive)

## Best Practices Verification

**Security checklist:**
- [ ] Secrets stored in GitHub (not in renovate.json5)
- [ ] Environment used for team projects (not repository secrets)
- [ ] Bot user has minimal required permissions
- [ ] Branch protection prevents unauthorized changes

**Performance checklist:**
- [ ] `prConcurrentLimit` set appropriately (3-10)
- [ ] Updates grouped to reduce PR noise
- [ ] Schedule avoids peak usage times
- [ ] Stability days configured based on risk tolerance

**Maintainability checklist:**
- [ ] Dependency dashboard enabled
- [ ] Commit messages follow project conventions
- [ ] Labels applied for easy filtering
- [ ] Auto-merge configured for low-risk updates
