# GitHub App Setup Guide

This guide provides step-by-step instructions for creating and configuring a GitHub App for Renovate.

## Why Use a GitHub App?

**Advantages over Personal Access Tokens (PATs):**
- Scoped permissions (only what Renovate needs)
- Not tied to a personal account (better for teams)
- Automatic token generation via `actions/create-github-app-token`
- Triggers other workflows (unlike `GITHUB_TOKEN`)

## Step 1: Create GitHub App

### For Personal Account

1. Go to **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**
   - URL: https://github.com/settings/apps/new

2. Fill in basic information:
   - **GitHub App name**: `renovate-bot-<your-username>` (must be globally unique)
   - **Homepage URL**: `https://github.com/<your-username>`
   - **Webhook**: Uncheck "Active" (Renovate doesn't need webhooks)

3. Set permissions (Repository permissions):
   - **Contents**: `Read and write` (to create commits, enable auto-merge)
   - **Pull requests**: `Read and write` (to create PRs, enable auto-merge)
   - **Workflows**: `Read and write` (optional, only if using `github-actions` manager)
   - **Metadata**: `Read-only` (automatically set)

4. Where can this GitHub App be installed?
   - **Only on this account** (recommended for personal projects)

5. Click **Create GitHub App**

### For Organization

1. Go to **Organization Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**
   - URL: https://github.com/organizations/<org-name>/settings/apps/new

2. Follow same steps as personal account above

3. Where can this GitHub App be installed?
   - **Only on this account** (keeps app private to your organization)

## Step 2: Generate Private Key

After creating the app:

1. On the app's settings page, scroll to **Private keys** section

2. Click **Generate a private key**

3. Download the `.pem` file
   - Keep this file secure - it's like a password
   - You'll upload this to GitHub Secrets later

## Step 3: Install the App

1. On the app's settings page, click **Install App** in the left sidebar

2. Select your account/organization

3. Choose installation scope:
   - **All repositories** (easier, but broader access)
   - **Only select repositories** (more secure, choose specific repos)

4. Click **Install**

5. Note the Installation ID from the URL:
   - URL format: `https://github.com/settings/installations/<INSTALLATION_ID>`
   - You'll need this for some advanced configurations

## Step 4: Get App ID

1. On the app's settings page (General tab), find **App ID** near the top

2. Copy this number - you'll need it for GitHub Secrets

## Step 5: Store Secrets in GitHub

### Personal Project: Repository Secrets

```bash
# Set App ID
gh secret set RENOVATE_APP_ID --body "<your-app-id>"

# Set Private Key
gh secret set RENOVATE_APP_PRIVATE_KEY < /path/to/downloaded-private-key.pem
```

Or via GitHub UI:
1. Go to repository **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Create two secrets:
   - Name: `RENOVATE_APP_ID`, Value: your app ID (e.g., `123456`)
   - Name: `RENOVATE_APP_PRIVATE_KEY`, Value: paste entire content of `.pem` file

### Team Project: Environment Secrets

More secure - restricts secrets to specific branches:

```bash
# Create environment
gh api -X PUT repos/$OWNER/$REPO/environments/renovate \
  --input - <<EOF
{
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
EOF

# Add branch pattern
gh api -X POST repos/$OWNER/$REPO/environments/renovate/deployment-branch-policies \
  -f name="renovate/*" \
  -f type="branch"

# Set secrets in environment
gh secret set RENOVATE_APP_ID \
  --env renovate \
  --body "<your-app-id>"

gh secret set RENOVATE_APP_PRIVATE_KEY \
  --env renovate \
  < /path/to/downloaded-private-key.pem
```

Or via GitHub UI:
1. Go to repository **Settings** → **Environments**
2. Click **New environment**, name it `renovate`
3. Under **Deployment branches**, select **Selected branches**
4. Add pattern: `renovate/*`
5. Under **Environment secrets**, add both secrets as above

## Step 6: Configure Workflow to Use GitHub App Token

### Personal Project (Repository Secrets)

```yaml
jobs:
  renovate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Create GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.RENOVATE_APP_ID }}
          private-key: ${{ secrets.RENOVATE_APP_PRIVATE_KEY }}

      - name: Run Renovate
        uses: renovatebot/github-action@v44
        with:
          token: ${{ steps.app-token.outputs.token }}
```

### Team Project (Environment Secrets)

```yaml
jobs:
  renovate:
    runs-on: ubuntu-latest
    environment: renovate  # ← Restricts to renovate/* branches
    permissions:
      contents: read
    steps:
      - name: Create GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.RENOVATE_APP_ID }}
          private-key: ${{ secrets.RENOVATE_APP_PRIVATE_KEY }}

      - name: Run Renovate
        uses: renovatebot/github-action@v44
        with:
          token: ${{ steps.app-token.outputs.token }}
```

## Step 7: Configure Renovate to Use Bot Username

When using a GitHub App, Renovate needs to know the bot's username for branch restrictions:

1. Get the bot username:
   - Format: `<app-name>[bot]`
   - Example: `renovate-bot-berlysia[bot]`

2. Add to `renovate.json5`:

```json5
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",

  // Set the bot username (required for GitHub App)
  "username": "renovate-bot-<your-username>[bot]",

  // ... rest of config
}
```

**Finding the exact username:**

After the first Renovate run, check a created PR:
```bash
gh pr list --author "renovate" --json author --jq '.[0].author.login'
```

Or check from GitHub UI:
- Look at any Renovate PR
- Click on the author avatar
- The username appears in the URL: `https://github.com/apps/<app-name>`

## Verification

**Check app installation:**
```bash
# List installed apps
gh api user/installations | jq '.installations[] | {id, app_slug, account}'

# Or for organization
gh api orgs/$ORG/installations | jq '.installations[] | {id, app_slug, account}'
```

**Check app permissions:**
```bash
gh api apps/<app-slug> | jq '.permissions'
```

**Test token generation:**

Create a test workflow:
```yaml
name: Test App Token
on: workflow_dispatch

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Create token
        id: token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.RENOVATE_APP_ID }}
          private-key: ${{ secrets.RENOVATE_APP_PRIVATE_KEY }}

      - name: Test token
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
        run: |
          echo "Token created successfully"
          gh api user --jq '.login'
```

Run it manually:
```bash
gh workflow run test-app-token.yml
gh run watch
```

Expected output: Shows the app's username (e.g., `renovate-bot-berlysia[bot]`)

## Troubleshooting

### Issue: "Resource not accessible by integration"

**Cause:** App doesn't have required permissions

**Solution:**
1. Go to app settings → Permissions
2. Verify `contents: write` and `pull-requests: write` are enabled
3. Click **Save changes**
4. The organization/account admin must approve the permission change
5. Reinstall the app if needed

### Issue: "Bad credentials" when using token

**Cause:** Private key or App ID incorrect

**Solution:**
1. Verify App ID is a number (not the app name)
2. Regenerate private key and update secret
3. Ensure entire `.pem` file content is in secret (including headers)

### Issue: Workflow can't access environment secrets

**Cause:** Branch doesn't match deployment branch policy

**Solution:**
```bash
# Check environment branch restrictions
gh api repos/$OWNER/$REPO/environments/renovate | jq '.deployment_branch_policy'

# Ensure your workflow branch matches the pattern
# For scheduled/workflow_dispatch, they run on default branch
```

### Issue: App not appearing in installations

**Cause:** App wasn't installed yet

**Solution:**
1. Go to app settings → **Install App**
2. Choose your account/organization
3. Select repositories and install

## Security Best Practices

1. **Use environment secrets for team projects**
   - Restricts when secrets are accessible
   - Prevents accidental exposure in forks

2. **Minimal permissions**
   - Only grant permissions Renovate actually needs
   - Don't grant admin/organization permissions

3. **Rotate private keys periodically**
   - Generate new private key every 6-12 months
   - Update secrets immediately after rotation

4. **Monitor app activity**
   ```bash
   # Check recent API usage
   gh api apps/<app-slug> | jq '.updated_at'

   # Review app's recent activity in audit log
   # Settings → Security → Log → GitHub Apps
   ```

5. **Limit repository access**
   - Use "Only select repositories" when installing
   - Review and update repository list regularly

## Alternative: Using Hosted Renovate App

If you don't want to manage a GitHub App yourself:

1. Install the official [Renovate GitHub App](https://github.com/apps/renovate)
2. No need for secrets or workflows
3. Simply add `renovate.json` to your repository
4. The hosted app runs automatically

**Trade-offs:**
- ✅ No maintenance
- ✅ Always up-to-date
- ❌ Less control over scheduling
- ❌ Can't customize runner environment
- ❌ Rate limits shared with all Renovate users
