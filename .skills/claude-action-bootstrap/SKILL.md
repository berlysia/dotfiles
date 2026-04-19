---
name: claude-action-bootstrap
description: Policy-enforcing installer that deploys hardened Claude Code Action workflows (`@claude` manual mention + dependency-bot auto-fix) into a personal GitHub repository the user administers. Use when asked to introduce Claude Code Action, apply `@claude` mention support, or set up automated CI auto-fix for dependency bot PRs, using the security-hardened templates shipped with this skill.
---

# Claude Code Action Bootstrap

本 skill は、berlysia が管理する個人 repo に、このリポジトリで確立された **Claude Code Action 運用** を展開する policy-enforcing installer。以下 2 本の workflow を **プレースホルダー置換 + ハードコード部の改変禁止** を機械検証つきで配置する:

- `claude.yml`: `@claude` メンションによる手動起動
- `auto-fix-dependencies.yml`: 依存 bot PR の CI 失敗自動修正（強化版 — SHA pin / environment scope / allowed_bots / fine-grained tool 制約 / fork 除外）

## Threat Model（設計の前提）

- **対象**: berlysia 自身が admin を持つ個人 repo のみ。他者への配布 / 公開ツール化は想定しない
- **攻撃者モデル**: なし（自己適用）。prompt injection のリスクは「自分の repo に自分で誤設定を書き込む」程度に限定
- **担保**: `actionlint` + `zizmor` を **hard prerequisite** とし、展開後の workflow に構文違反 / GitHub Actions SAST 違反がないことを機械検証する。owner id ピン留め / bot type 二重判定 / drift hash 比較等の追加防御は採用しない

## Prerequisites

**すべて必須。いずれか欠けている場合は skill を中断し、インストール手順を提示する:**

| ツール         | 確認コマンド                                            | 用途                               |
| -------------- | ------------------------------------------------------- | ---------------------------------- |
| GitHub CLI     | `gh auth status`                                        | repo 操作 / secret 登録            |
| Admin 権限     | `gh api repos/$OWNER/$REPO \| jq '.permissions.admin'`  | environments 作成 / secret 登録    |
| Claude OAuth   | `gh secret list` で `CLAUDE_CODE_OAUTH_TOKEN` 登録予定  | action 認証                        |
| actionlint     | `actionlint -version`                                   | workflow YAML 検証                 |
| zizmor         | `zizmor --version`                                      | GitHub Actions SAST                |

**未インストール時の導入例**:

```bash
# actionlint / zizmor（mise を使用する場合）
mise use -g actionlint@latest zizmor@latest

# OAuth token（Claude Code から）
/install-github-app
```

## Quick Start

```bash
# 1. ターゲット repo のルートに移動
cd /path/to/target-repo

# 2. 現状確認（skill が自動で実行）
gh auth status
gh api repos/$(gh repo view --json owner,name -q '.owner.login + "/" + .name') | jq '{admin: .permissions.admin, auto_merge: .allow_auto_merge, fork: .fork}'
ls -la .github/workflows/claude*.yml .github/workflows/auto-fix-dependencies.yml 2>/dev/null
actionlint -version
zizmor --version
```

すべての前提が満たされていれば、skill は Step 1 から進める。欠けている項目があれば、該当する導入手順を提示して中断する。

## Workflow

```
Bootstrap Progress:
- [ ] Prerequisites: gh auth, admin, actionlint, zizmor 確認
- [ ] Step 1: ターゲット repo 検証 + 既存ファイル衝突確認
- [ ] Step 2: パラメータ収集（allowed senders / env / CI / bots）
- [ ] Step 3: claude.yml 展開（mandatory）
- [ ] Step 4: auto-fix-dependencies.yml 展開（optional）
- [ ] Step 5: Environments + Secrets 設定
- [ ] Step 6: actionlint + zizmor 検証
- [ ] Step 7: 動作確認
```

### Step 1: ターゲット repo 検証

**Admin 権限と auto-merge 設定を確認:**

```bash
OWNER_REPO=$(gh repo view --json owner,name -q '.owner.login + "/" + .name')

# admin 必須
gh api repos/$OWNER_REPO | jq -e '.permissions.admin == true' \
  || { echo "Error: admin 権限が必要"; exit 1; }

# auto-merge 推奨（auto-fix を使う場合は必須）
AUTOMERGE=$(gh api repos/$OWNER_REPO | jq -r '.allow_auto_merge')
[ "$AUTOMERGE" = "true" ] || echo "Warning: allow_auto_merge=false。auto-fix 導入時は Step 5 で有効化する"
```

**既存 workflow 衝突確認:**

```bash
for f in .github/workflows/claude.yml .github/workflows/auto-fix-dependencies.yml; do
  [ -f "$f" ] && echo "EXISTS: $f（Step 3/4 で diff 提示 + 上書き確認）"
done
```

**renovate skill 由来の汎用 `auto-fix-dependencies.yml` が既にある場合**:
過渡期の重複として容認。Step 4 の diff 提示で強化版に置き換えることを確認する。

### Step 2: パラメータ収集

skill は対話的に以下を収集する。デフォルト値を提示し、Enter で確定。

| パラメータ               | プレースホルダー          | デフォルト                                                             |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------- |
| Allowed senders          | `{{ALLOWED_SENDERS}}`     | `github.event.sender.login == 'berlysia'`                              |
| Manual env name          | `{{MANUAL_ENV_NAME}}`     | `claude-manual`                                                        |
| Autofix env name         | `{{AUTOFIX_ENV_NAME}}`    | `claude-autofix`                                                       |
| CI workflow names (YAML) | `{{CI_WORKFLOW_NAMES}}`   | `      - "CI Status Check"` （インデント 6 空白）                      |
| Allowed bots             | `{{ALLOWED_BOTS}}`        | `renovate[bot],dependabot[bot],app/renovate`                           |

**CI workflow 名の候補列挙:**

```bash
gh api repos/$OWNER_REPO/actions/workflows | jq -r '.workflows[] | select(.state=="active") | .name'
```

複数 CI を監視する場合は YAML list として連結:

```yaml
      - "CI Status Check"
      - "Another CI"
```

**Allowed senders に複数ユーザーを含める場合** (`||` 連結):

```yaml
github.event.sender.login == 'berlysia' || github.event.sender.login == 'another'
```

### Step 3: `claude.yml` 展開（mandatory）

1. `assets/workflows/claude.yml` を読み込み、Step 2 のパラメータで `{{ALLOWED_SENDERS}}` / `{{MANUAL_ENV_NAME}}` を置換
2. 既存 `.github/workflows/claude.yml` があれば diff 提示 → ユーザーに上書き確認
3. 書き込み

**ハードコード部（skill 実行時でも改変しない）**:

- `anthropics/claude-code-action@b47fd721da662d48c5680e154ad16a73ed74d2e0 # v1.0.93` — 供給チェーン攻撃対策。更新はターゲット repo の renovate に委ねる
- `persist-credentials: false`
- `fetch-depth: 1`

### Step 4: `auto-fix-dependencies.yml` 展開（optional）

導入可否をユーザーに確認してから進める。auto-merge が無効な repo では Step 5 で有効化する。

1. `assets/workflows/auto-fix-dependencies.yml` を読み込み、`{{CI_WORKFLOW_NAMES}}` / `{{AUTOFIX_ENV_NAME}}` / `{{ALLOWED_BOTS}}` を置換
2. 既存ファイルがあれば diff 提示 → 上書き確認
3. 書き込み

**ハードコード部（skill 実行時でも改変しない）**:

- `anthropics/claude-code-action@b47fd721da662d48c5680e154ad16a73ed74d2e0 # v1.0.93`
- `fetch-depth: 0`（自動修正のため commit push 権限が必要）
- `persist-credentials: false`
- `sameRepo && !isFork` の fork 除外ロジック — コード内に `SECURITY-CRITICAL: do not edit` コメント明示
- GitHub Script による bot 判定（`allowedBots.includes(author)` の `login` 文字列一致）
- `concurrency: auto-fix-${{ github.event.workflow_run.head_sha }}`（重複抑止）
- プロンプト内の tool constraints（Read/Glob/Grep 強制、single-line git commit、`git add` と `git commit` 分離）

### Step 5: Environments + Secrets 設定

**Environment を作成（deployment_branch_policy で保護）:**

```bash
for ENV_NAME in "${MANUAL_ENV:-claude-manual}" "${AUTOFIX_ENV:-claude-autofix}"; do
  gh api -X PUT repos/$OWNER_REPO/environments/$ENV_NAME \
    --input - <<'EOF'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
EOF
done
```

**OAuth トークンを各 env に登録:**

**IMPORTANT**: OAuth トークンを LLM プロンプトや conversation に貼り付けないこと。skill は以下のコマンド **例** を提示するに留め、実際の値はユーザー自身がターミナルで入力する。

```bash
# 対話的に値を入力（履歴に残さない）
gh secret set CLAUDE_CODE_OAUTH_TOKEN --env $MANUAL_ENV
gh secret set CLAUDE_CODE_OAUTH_TOKEN --env $AUTOFIX_ENV
```

**OAuth トークンの取得方法**: Claude Code CLI で `/install-github-app` を実行、または手動で https://claude.ai/settings から発行。

**auto-fix を導入する場合は `allow_auto_merge=true` を有効化:**

```bash
gh api -X PATCH repos/$OWNER_REPO -f allow_auto_merge=true
```

**確認:**

```bash
gh api repos/$OWNER_REPO/environments | jq '.environments[].name'
gh api repos/$OWNER_REPO/environments/$MANUAL_ENV/secrets | jq '.secrets[].name'
gh api repos/$OWNER_REPO/environments/$AUTOFIX_ENV/secrets | jq '.secrets[].name'
```

### Step 6: 展開後検証（`actionlint` + `zizmor`）

**actionlint は finding 0 件を必須要件とする。zizmor は下記の既知 finding を除いて 0 件を必須要件とする。**

```bash
# 1. actionlint で構文検証（0 件必須）
actionlint .github/workflows/claude.yml .github/workflows/auto-fix-dependencies.yml

# 2. zizmor で GitHub Actions SAST
zizmor .github/workflows/claude.yml .github/workflows/auto-fix-dependencies.yml
```

**既知で許容する zizmor finding**:

| Finding                      | 対象ファイル                          | 許容根拠                                                                                                                                      |
| ---------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `dangerous-triggers` (high)  | `auto-fix-dependencies.yml` L13 `on:` | `workflow_run` は CI 完了後の失敗時起動と secret アクセスの両立に必須。Asset は `sameRepo && !isFork` による fork 除外、`allowed_bots` による author allowlist、checkout `persist-credentials: false` による credentials 混入防止を**すべて内包**しており、この trade-off を前提に受け入れる |

**これら以外に high/critical finding が出た場合**:

```bash
# 変更を revert
git checkout -- .github/workflows/claude.yml .github/workflows/auto-fix-dependencies.yml
# または新規ファイルのみ作成した場合
rm .github/workflows/claude.yml .github/workflows/auto-fix-dependencies.yml
```

finding を診断してからユーザーに再実行を促す。

### Step 7: 動作確認

**`@claude` メンションの確認:**

1. テスト issue を作成: `gh issue create --title "test: @claude mention" --body "@claude hello, can you confirm you are listening?"`
2. Actions タブで `Claude Code` workflow が `claude-manual` environment で起動していることを確認
3. issue にコメントが返ってくるか観察

**auto-fix の確認**（auto-fix を導入した場合）:

1. 既存の依存 bot PR の CI を失敗させる（あるいは次の renovate PR を待つ）
2. CI 完了後、`Auto-fix Dependencies` workflow が `claude-autofix` environment で起動
3. commit が push されて CI が再実行され、auto-merge に引き継がれることを観察

## PM-specific prompt customization

**`auto-fix-dependencies.yml` のプロンプトは pnpm 前提で固定**。他 PM（yarn / bun / npm のみ等）の repo に適用する場合は、書き込み後に人間が `sed` 等で書き換える。

**yarn の場合（例）**:

```bash
sed -i 's/Bash(pnpm \*)/Bash(yarn *)/g; s/pnpm, npm/yarn, npm/g; s/update lockfile/update yarn.lock/g' \
  .github/workflows/auto-fix-dependencies.yml
```

**bun の場合**:

```bash
sed -i 's/Bash(pnpm \*)/Bash(bun *)/g; s/pnpm, npm/bun, npm/g; s/update lockfile/update bun.lock/g' \
  .github/workflows/auto-fix-dependencies.yml
```

書き換え後は **Step 6 の `actionlint` + `zizmor` を再実行** して構文・SAST を再確認する。

## Decision Notes

- **auto-merge 前提**: `auto-fix-dependencies.yml` のプロンプトは「merge するな、auto-merge に任せろ」と指示する。ターゲット repo で `allow_auto_merge=false` の場合、Step 5 で有効化する。無効のまま運用する場合はプロンプトの該当文言を人間が書き換える
- **fork 除外は固定 ON**: 個人 public repo でも fork PR は存在し得るため、`sameRepo && !isFork` の除外はハードコード。改変禁止コメント付き
- **SHA pin は renovate に委ねる**: asset 内の `anthropics/claude-code-action@<SHA>` は本 skill 側の renovate で更新される。ターゲット repo に renovate が入っていない場合は、本 skill を再適用する運用か、ターゲット repo 側にも renovate を導入する
- **脅威モデルは自己適用のみ**: 他者への配布・公開ツール化を想定しない。owner id ピン留め、bot `user.type` 二重判定、sender id workflow 埋込、drift hash 比較等は採用しない。将来 public / team 配布に拡張する場合は threat model を再評価する
- **`zizmor` を hard prerequisite に維持する理由**: 現時点の自己適用脅威モデル範囲外（script injection / pull_request_target の危険パターン等）も SAST で機械的に担保する前倒し投資
- **`workflow_run` の `dangerous-triggers` 許容**: `workflow_run` は「CI 失敗時に secret つきで auto-fix を起動する」設計に必須（fork PR 由来の workflow では secret が取れない / `pull_request` では CI 完了待ちができない）。この trigger の本質的リスク（PR head HEAD からの任意コード実行導線）は Asset 側で (1) `sameRepo && !isFork` による fork 除外、(2) `allowed_bots` による author allowlist、(3) checkout `persist-credentials: false` を**ハードコードとして内包**することで閉じる。この 3 防御ラインを前提に zizmor の `dangerous-triggers` finding は Step 6 で既知許容する

## Assets

- `assets/workflows/claude.yml`: `@claude` メンションテンプレ（プレースホルダー: `{{ALLOWED_SENDERS}}`, `{{MANUAL_ENV_NAME}}`）
- `assets/workflows/auto-fix-dependencies.yml`: 強化版 auto-fix テンプレ（プレースホルダー: `{{CI_WORKFLOW_NAMES}}`, `{{AUTOFIX_ENV_NAME}}`, `{{ALLOWED_BOTS}}`）

両 asset はハードコード部（SHA / fork 除外 / `persist-credentials` / `fetch-depth` / bot 判定ロジック）をコメントで明示している。`install time` に編集しない。
