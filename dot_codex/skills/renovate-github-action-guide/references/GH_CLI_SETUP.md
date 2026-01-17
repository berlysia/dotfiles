# GitHub CLI Setup and Permissions

This guide covers GitHub CLI authentication and required permissions for Renovate setup commands.

## Prerequisites

### Install GitHub CLI

```bash
# Check if gh is installed
gh --version

# If not installed:
# macOS
brew install gh

# Ubuntu/Debian
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install gh

# Other platforms: https://cli.github.com/manual/installation
```

## Authentication

### Initial Authentication

**For personal repositories:**

```bash
# Authenticate with GitHub
gh auth login

# Follow prompts:
# 1. What account do you want to log into? GitHub.com
# 2. What is your preferred protocol? HTTPS or SSH
# 3. Authenticate with web browser or token? Browser (easier)
# 4. Browser opens - authorize GitHub CLI
```

**For organization repositories:**

Same as above, but ensure your account has appropriate organization access.

### Required Scopes

The authentication must include these scopes:

| Scope | Required For | Commands |
|-------|--------------|----------|
| **`repo`** (full control) | All repository operations | All `gh api repos/...` commands |
| **`admin:org`** (for org repos) | Organization settings | Organization repository configuration |
| **`workflow`** | Workflow management | Triggering workflows, reading workflow runs |

**Verify current authentication:**

```bash
# Check authentication status
gh auth status

# Expected output includes:
# ✓ Logged in to github.com as <username>
# ✓ Token: gho_****
# ✓ Token scopes: admin:org, repo, workflow
```

### Re-authenticate with Required Scopes

If your token lacks required scopes:

```bash
# Refresh authentication with all needed scopes
gh auth refresh -h github.com -s repo -s admin:org -s workflow

# Or re-authenticate from scratch
gh auth logout
gh auth login
```

## Permission Requirements by Command

### Repository Settings Commands

**Enable auto-merge:**
```bash
gh api -X PATCH repos/$OWNER/$REPO -f allow_auto_merge=true
```
- **Required:** Repository admin or owner
- **Scope:** `repo` (full control)
- **Organization:** Must have "Repository" → "Administration" permission

**Verify permission:**
```bash
# Check your permission level
gh api repos/$OWNER/$REPO | jq '.permissions'
# Expected: {"admin": true, "push": true, "pull": true}
```

### Branch Protection Commands

**Set branch protection:**
```bash
gh api -X PUT repos/$OWNER/$REPO/branches/$BRANCH/protection --input - <<EOF
{ ... }
EOF
```
- **Required:** Repository admin or owner
- **Scope:** `repo` (full control)
- **Organization:** "Repository" → "Administration" permission

**Verify permission:**
```bash
# Try reading branch protection (less privileged operation)
gh api repos/$OWNER/$REPO/branches/$BRANCH/protection
# If this fails with 403, you don't have admin access
```

### Secrets Management Commands

**Set repository secrets:**
```bash
gh secret set SECRET_NAME --body "value"
```
- **Required:** Repository admin or owner, OR "Secrets" write permission
- **Scope:** `repo` (full control)
- **Organization:** "Repository" → "Secrets" permission

**Verify permission:**
```bash
# List secrets (shows names only, not values)
gh api repos/$OWNER/$REPO/actions/secrets
# If this fails with 403, you don't have secrets access
```

### Environment Management Commands

**Create environment:**
```bash
gh api -X PUT repos/$OWNER/$REPO/environments/renovate --input - <<EOF
{ ... }
EOF
```
- **Required:** Repository admin or owner
- **Scope:** `repo` (full control)
- **Organization:** "Repository" → "Administration" permission

**Set environment secrets:**
```bash
gh secret set SECRET_NAME --env renovate --body "value"
```
- **Required:** Repository admin or owner, OR "Secrets" write permission
- **Scope:** `repo` (full control)

### Workflow Management Commands

**Trigger workflow:**
```bash
gh workflow run workflow.yml
```
- **Required:** Write access to repository
- **Scope:** `workflow`

**View workflow runs:**
```bash
gh run list --workflow=workflow.yml
```
- **Required:** Read access to repository
- **Scope:** `repo` (at least read)

## Organization-Specific Permissions

For organization repositories, additional permissions may be required:

### Organization Settings

**Check organization membership:**
```bash
gh api orgs/$ORG/memberships/$USERNAME
```

**Required organization roles:**
- **Member**: Can read and clone repositories
- **Admin**: Can configure repositories and settings
- **Owner**: Full organization control

### Repository Role Requirements

| Task | Required Role |
|------|---------------|
| Read repository settings | Write access |
| Modify repository settings | Admin access |
| Create/modify branch protection | Admin access |
| Manage secrets | Admin access OR "Secrets" permission |
| Manage environments | Admin access |
| Create GitHub Apps | Organization owner |

**Check your repository role:**
```bash
gh api repos/$OWNER/$REPO/collaborators/$USERNAME/permission | jq '.permission'
# Output: "admin", "write", "read", or "none"
```

## Permission Verification Script

Run this before starting Renovate setup:

```bash
#!/bin/bash
OWNER="your-username"
REPO="your-repo"

echo "Checking permissions for $OWNER/$REPO..."

# Check authentication
echo "1. Authentication status:"
gh auth status 2>&1 | grep -E "(Logged in|Token scopes)"

# Check repository access
echo -e "\n2. Repository access:"
PERMS=$(gh api repos/$OWNER/$REPO 2>/dev/null | jq -r '.permissions | "\(.admin) \(.push) \(.pull)"')
if [ "$PERMS" = "true true true" ]; then
  echo "✓ Admin access: Yes"
elif [ "$PERMS" = "null null null" ]; then
  echo "✗ No access to repository"
  exit 1
else
  echo "✗ Admin access: No (have: $PERMS)"
  exit 1
fi

# Check if auto-merge can be modified
echo -e "\n3. Auto-merge setting:"
if gh api repos/$OWNER/$REPO | jq -e '.allow_auto_merge' >/dev/null 2>&1; then
  echo "✓ Can read repository settings"
else
  echo "✗ Cannot read repository settings"
  exit 1
fi

# Check if secrets can be accessed
echo -e "\n4. Secrets access:"
if gh api repos/$OWNER/$REPO/actions/secrets >/dev/null 2>&1; then
  echo "✓ Can access secrets"
else
  echo "✗ Cannot access secrets"
  exit 1
fi

# Check if branch protection can be read
echo -e "\n5. Branch protection access:"
BRANCH=$(gh api repos/$OWNER/$REPO | jq -r '.default_branch')
if gh api repos/$OWNER/$REPO/branches/$BRANCH/protection >/dev/null 2>&1; then
  echo "✓ Can access branch protection for $BRANCH"
else
  echo "⚠ No branch protection set (or cannot access)"
fi

echo -e "\n✓ All permission checks passed!"
```

Save as `check-gh-permissions.sh` and run:
```bash
chmod +x check-gh-permissions.sh
./check-gh-permissions.sh
```

## Troubleshooting

### Error: "Resource not accessible by integration"

**When using gh CLI:**
- Means your token lacks required scopes
- Solution: `gh auth refresh -s repo -s admin:org -s workflow`

**When using GitHub App:**
- Means the app lacks required permissions
- Solution: Update app permissions in app settings

### Error: "Must have admin rights to Repository"

**Cause:** You don't have admin access to the repository

**Solutions:**
1. Ask repository owner to grant you admin access
2. Organization: Ask organization admin to add you to admin team
3. Use repository owner's account for setup

### Error: "API rate limit exceeded"

**Cause:** Too many API calls in short period

**Solutions:**
```bash
# Check rate limit status
gh api rate_limit

# For authenticated requests, limit is 5000/hour
# If using Actions, limits are higher

# Wait or use different authentication token
```

### Error: "Bad credentials"

**Cause:** Token expired or invalid

**Solution:**
```bash
# Re-authenticate
gh auth logout
gh auth login
```

## Security Best Practices

1. **Use least privilege**
   - Only authenticate with required scopes
   - Don't use organization owner account for routine tasks

2. **Rotate tokens regularly**
   ```bash
   # Refresh token (generates new one)
   gh auth refresh
   ```

3. **Use environment-specific authentication**
   ```bash
   # For automation, use GH_TOKEN environment variable
   export GH_TOKEN="ghp_..."
   gh api repos/$OWNER/$REPO
   ```

4. **Audit token usage**
   ```bash
   # Check where token is used
   gh auth status

   # For organization, review audit log
   # Settings → Security → Audit log
   ```

5. **Never commit tokens**
   - Tokens in `.git/config` are safe (not committed)
   - Never hardcode tokens in scripts
   - Use gh CLI or environment variables

## Alternative: Using Fine-Grained Personal Access Tokens

Instead of `gh auth login`, you can use fine-grained PATs:

**Create fine-grained PAT:**
1. Go to Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Click "Generate new token"
3. Set expiration, description
4. Select repository access (specific repositories)
5. Set permissions:
   - Repository permissions:
     - Administration: Read and write
     - Contents: Read and write
     - Secrets: Read and write
     - Workflows: Read and write

**Use PAT with gh CLI:**
```bash
# Set as environment variable
export GH_TOKEN="github_pat_..."

# Or authenticate with token
echo $GH_TOKEN | gh auth login --with-token

# Verify
gh auth status
```

**Advantages of fine-grained PATs:**
- More granular permissions than classic PATs
- Can be scoped to specific repositories
- Shorter expiration (max 1 year)
- Better audit trail

**Disadvantages:**
- More complex to set up
- Must manually renew when expired
- Not all API endpoints support fine-grained PATs yet
