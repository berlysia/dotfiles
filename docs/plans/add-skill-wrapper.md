# add-skillラッパースクリプト実装計画

## 概要

`.chezmoidata/claude_skills.yaml`を操作するCLIラッパー`add-skill`を実装します。元のnpx add-skillコマンドを上書きし、YAML設定の追加/削除/一覧/検索を提供します。

## 要件

**コマンド名**: `add-skill`(npx add-skillを上書き)

**実装機能**:
1. **add**: リポジトリとスキル名を指定してYAMLに追加
2. **remove**: スキル名を指定してYAMLから削除
3. **list**: 現在の設定を表示
4. **search**: リポジトリ内の利用可能なスキルを検索

**適用動作**: YAML更新後、手動で`chezmoi apply`実行(自動適用しない)

## アーキテクチャ設計

### ファイル配置

**作成ファイル**: `/home/berlysia/.local/share/chezmoi/dot_local/bin/executable_add-skill`
- chezmoi適用後: `~/.local/bin/add-skill`
- PATH経由でアクセス可能

### 技術スタック

- **Bash**: set -euo pipefail
- **dasel**: YAML ↔ JSON 変換(mise経由で実行)
- **jq**: JSON操作(配列追加/削除/重複除去)
- **npx add-skill**: search機能の委譲

### コマンドインターフェース

```bash
add-skill add <repo> <skill>     # スキル追加
add-skill remove <skill>         # スキル削除
add-skill list                   # 現在の設定表示
add-skill search <repo>          # リポジトリ内のスキル検索
add-skill help                   # ヘルプ表示
```

## データ操作パターン

### スキル追加のjqクエリ

```bash
jq --arg repo "$REPO" --arg skill "$SKILL" '
  def has_repo: .claude_skills.repositories | any(.repo == $repo);

  if has_repo then
    # 既存リポジトリに追加
    .claude_skills.repositories |= (
      map(if .repo == $repo
          then .skills += [$skill]
          else .
          end)
      | map(.skills |= (unique | sort))
    )
  else
    # 新規リポジトリ追加
    .claude_skills.repositories += [{"repo": $repo, "skills": [$skill]}]
  end
'
```

**重要ポイント**:
- `unique | sort`で重複排除とソート
- リポジトリ存在確認の条件分岐
- 既存リポジトリへの追加と新規リポジトリ作成を統合

### スキル削除のjqクエリ

```bash
jq --arg skill "$SKILL" '
  .claude_skills.repositories |= (
    map(.skills |= map(select(. != $skill)))
    | map(select(.skills | length > 0))
  )
'
```

**重要ポイント**:
- スキル配列から該当スキルをフィルタリング
- `select(.skills | length > 0)`で空のリポジトリエントリを自動削除

### 一覧表示のjqクエリ

```bash
jq -r '
  .claude_skills.repositories[]
  | "[\(.repo)]" + "\n  " + (.skills | join("\n  "))
'
```

## スクリプト構造

### 1. 初期化とユーティリティ

```bash
#!/usr/bin/env bash
set -euo pipefail

# 色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 定数
CHEZMOI_SOURCE_DIR="${CHEZMOI_SOURCE_DIR:-}"
YAML_FILE=""

# 依存関係チェック
check_dependencies() {
    local missing=()
    command -v mise &>/dev/null || missing+=("mise")
    command -v jq &>/dev/null || missing+=("jq")
    command -v chezmoi &>/dev/null || missing+=("chezmoi")

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo -e "${RED}❌ Missing dependencies: ${missing[*]}${NC}" >&2
        echo "   Install mise: https://mise.jdx.dev/" >&2
        echo "   Install jq: sudo apt-get install jq" >&2
        exit 1
    fi

    # daselの実行可能性確認
    if ! mise x -- dasel version &>/dev/null; then
        echo -e "${RED}❌ dasel not properly installed${NC}" >&2
        echo "   Install: mise install dasel -f" >&2
        exit 1
    fi
}

# YAML妥当性検証
validate_yaml() {
    local file=$1
    if [[ ! -f "$file" ]]; then
        echo -e "${RED}❌ File not found: $file${NC}" >&2
        exit 1
    fi

    if ! mise x -- dasel -i yaml -o json < "$file" &>/dev/null; then
        echo -e "${RED}❌ Invalid YAML syntax${NC}" >&2
        exit 1
    fi
}
```

### 2. アトミックYAML更新

```bash
# YAML更新(バックアップ、変換、差分表示、アトミック置換)
update_yaml() {
    local jq_filter=$1
    local temp_json=$(mktemp)
    local temp_yaml=$(mktemp)
    trap 'rm -f "$temp_json" "$temp_yaml" "${temp_json}.new"' RETURN

    # YAML → JSON
    if ! mise x -- dasel -i yaml -o json < "$YAML_FILE" > "$temp_json"; then
        echo -e "${RED}❌ YAML parse failed${NC}" >&2
        return 1
    fi

    # jq変換
    if ! jq "$jq_filter" "$temp_json" > "${temp_json}.new"; then
        echo -e "${RED}❌ jq transformation failed${NC}" >&2
        return 1
    fi

    # JSON → YAML
    if ! mise x -- dasel -i json -o yaml < "${temp_json}.new" > "$temp_yaml"; then
        echo -e "${RED}❌ JSON to YAML conversion failed${NC}" >&2
        return 1
    fi

    # 差分表示
    if diff -u "$YAML_FILE" "$temp_yaml"; then
        echo -e "${YELLOW}⚠️  No changes detected${NC}"
        return 0
    fi

    # アトミック置換
    mv "$temp_yaml" "$YAML_FILE"
    echo -e "${GREEN}✅ Updated successfully${NC}"
}
```

### 3. サブコマンド実装

```bash
cmd_add() {
    local repo=$1
    local skill=$2

    [[ -z "$repo" || -z "$skill" ]] && {
        echo -e "${RED}Usage: add-skill add <repo> <skill>${NC}" >&2
        exit 1
    }

    echo -e "${BLUE}📦 Adding skill: $skill from $repo${NC}"

    local jq_filter='
        --arg repo "'"$repo"'" --arg skill "'"$skill"'" '"'"'
        def has_repo: .claude_skills.repositories | any(.repo == $repo);

        if has_repo then
          .claude_skills.repositories |= (
            map(if .repo == $repo
                then .skills += [$skill]
                else .
                end)
            | map(.skills |= (unique | sort))
          )
        else
          .claude_skills.repositories += [{"repo": $repo, "skills": [$skill]}]
        end
        '"'"'
    '

    if update_yaml "$jq_filter"; then
        echo -e "${BLUE}💡 Next: chezmoi apply${NC}"
    fi
}

cmd_remove() {
    local skill=$1

    [[ -z "$skill" ]] && {
        echo -e "${RED}Usage: add-skill remove <skill>${NC}" >&2
        exit 1
    }

    echo -e "${BLUE}🗑️  Removing skill: $skill${NC}"

    local jq_filter='
        --arg skill "'"$skill"'" '"'"'
        .claude_skills.repositories |= (
          map(.skills |= map(select(. != $skill)))
          | map(select(.skills | length > 0))
        )
        '"'"'
    '

    if update_yaml "$jq_filter"; then
        echo -e "${BLUE}💡 Next: chezmoi apply${NC}"
    fi
}

cmd_list() {
    echo -e "${BLUE}📋 Current skills configuration:${NC}"
    echo ""

    mise x -- dasel -i yaml -o json < "$YAML_FILE" | jq -r '
        .claude_skills.repositories[]
        | "[\(.repo)]" + "\n  " + (.skills | join("\n  "))
    '
}

cmd_search() {
    local repo=${1:-}

    [[ -z "$repo" ]] && {
        echo -e "${RED}Usage: add-skill search <repo>${NC}" >&2
        exit 1
    }

    echo -e "${BLUE}🔍 Searching skills in $repo...${NC}"
    npx --yes add-skill "$repo" --list
}

cmd_help() {
    cat <<'EOF'
add-skill - Manage Claude Code skills in chezmoi

Usage:
  add-skill add <repo> <skill>     Add skill to configuration
  add-skill remove <skill>         Remove skill from configuration
  add-skill list                   Show current configuration
  add-skill search <repo>          Search available skills in repository
  add-skill help                   Show this help

Examples:
  add-skill add vercel-labs/agent-skills web-design-guidelines
  add-skill remove web-design-guidelines
  add-skill list
  add-skill search vercel-labs/agent-skills

After modifying configuration, run: chezmoi apply
EOF
}
```

### 4. メイン関数

```bash
main() {
    check_dependencies

    local subcommand=${1:-help}
    shift || true

    # YAML_FILE パス解決
    if [[ -z "$CHEZMOI_SOURCE_DIR" ]]; then
        CHEZMOI_SOURCE_DIR=$(chezmoi source-path 2>/dev/null || echo "$HOME/.local/share/chezmoi")
    fi
    YAML_FILE="$CHEZMOI_SOURCE_DIR/.chezmoidata/claude_skills.yaml"

    case "$subcommand" in
        add)
            validate_yaml "$YAML_FILE"
            cmd_add "$@"
            ;;
        remove)
            validate_yaml "$YAML_FILE"
            cmd_remove "$@"
            ;;
        list)
            validate_yaml "$YAML_FILE"
            cmd_list
            ;;
        search)
            cmd_search "$@"
            ;;
        help|--help|-h)
            cmd_help
            ;;
        *)
            echo -e "${RED}Unknown command: $subcommand${NC}" >&2
            cmd_help
            exit 1
            ;;
    esac
}

main "$@"
```

## エラーハンドリング戦略

### 依存関係チェック

| ツール | チェック方法 | エラー時の対応 |
|--------|-------------|---------------|
| mise | `command -v mise` | インストールURLを表示 |
| jq | `command -v jq` | apt-getコマンドを表示 |
| chezmoi | `command -v chezmoi` | エラーメッセージ |
| dasel | `mise x -- dasel version` | mise installコマンドを表示 |

### YAML妥当性検証

- 各操作前にdaselでパース可能か確認
- 構文エラー時は即座に終了

### アトミック更新保証

1. 一時ファイルで変換・変更(mktemp)
2. trap RETURNで一時ファイルを確実にクリーンアップ
3. 差分表示(diff -u)
4. 成功時のみmvでアトミック置換

### エッジケース対応

| ケース | 検出 | 対応 |
|--------|------|------|
| 同じスキルの重複追加 | diff結果 | "No changes"表示 |
| 存在しないスキル削除 | diff結果 | "No changes"表示 |
| 最後のスキル削除 | `select(length > 0)` | リポジトリごと削除 |
| 不正なYAML | daselパース | エラー終了 |

## ユーザーフィードバック設計

### 成功パターン

```
📦 Adding skill: web-design-guidelines from vercel-labs/agent-skills
--- .chezmoidata/claude_skills.yaml
+++ .chezmoidata/claude_skills.yaml
@@ -3,3 +3,4 @@
     skills:
       - vercel-react-best-practices
+      - web-design-guidelines
✅ Updated successfully
💡 Next: chezmoi apply
```

### 変更なしパターン

```
📦 Adding skill: web-design-guidelines from vercel-labs/agent-skills
⚠️  No changes detected
```

### エラーパターン

```
❌ Missing dependencies: dasel
   Install: mise install dasel -f
```

## 実装ステップ

### Step 1: スクリプト作成

**ファイル**: `/home/berlysia/.local/share/chezmoi/dot_local/bin/executable_add-skill`

上記のスクリプト構造に従って実装

### Step 2: 基本動作テスト

```bash
# 依存関係確認
add-skill help

# 現在の設定表示
add-skill list

# スキル検索
add-skill search vercel-labs/agent-skills
```

### Step 3: YAML操作テスト

```bash
# スキル追加
add-skill add vercel-labs/agent-skills test-skill

# 差分確認
git diff .chezmoidata/claude_skills.yaml

# 重複追加(変更なし)
add-skill add vercel-labs/agent-skills test-skill

# スキル削除
add-skill remove test-skill
```

### Step 4: エッジケーステスト

```bash
# 新規リポジトリ追加
add-skill add owner/new-repo new-skill

# 最後のスキル削除(リポジトリごと削除)
add-skill remove new-skill

# 存在しないスキル削除
add-skill remove nonexistent-skill
```

### Step 5: 統合テスト

```bash
# スキル追加
add-skill add vercel-labs/agent-skills web-design-guidelines

# chezmoi apply
chezmoi apply

# インストール確認
ls -la ~/.claude/skills/web-design-guidelines/
```

## 検証計画

### 正常系テスト

1. **スキル追加**:
   - 既存リポジトリに追加 → YAMLに反映
   - 新規リポジトリに追加 → 新規エントリ作成

2. **スキル削除**:
   - 既存スキル削除 → YAMLから削除
   - 最後のスキル削除 → リポジトリエントリごと削除

3. **一覧表示**:
   - フォーマット確認
   - 空のリストの場合の表示

4. **検索**:
   - npx add-skill --listへの委譲確認

### 異常系テスト

1. **依存関係なし**:
   - miseなし → エラーメッセージ
   - jqなし → エラーメッセージ
   - daselなし → エラーメッセージ

2. **不正なYAML**:
   - 構文エラー → パースエラー
   - ファイルなし → ファイルなしエラー

3. **引数不足**:
   - add引数なし → Usage表示
   - remove引数なし → Usage表示

### 統合テスト

1. **chezmoi連携**:
   - YAML更新後のchezmoi apply
   - スクリプト再実行(冪等性)

2. **既存スキルとの共存**:
   - 手作りスキルが影響を受けないこと

## クリティカルファイル

実装時に作成・参照するファイル:

- `/home/berlysia/.local/share/chezmoi/dot_local/bin/executable_add-skill` - 新規作成
- `/home/berlysia/.local/share/chezmoi/.chezmoidata/claude_skills.yaml` - 操作対象
- `/home/berlysia/.local/share/chezmoi/scripts/format-codex-config.sh` - dasel+jqパターン参考
- `/home/berlysia/.local/share/chezmoi/dot_local/bin/executable_git-worktree-cleanup` - エラーハンドリング参考

## 制限事項と将来拡張

### 現在の制限

1. **バリデーションなし**: リポジトリやスキル名の存在確認を行わない
2. **単一スキル操作**: 一度に複数スキルを追加/削除できない
3. **物理削除なし**: removeコマンドはYAMLから削除するのみ

### 将来的な拡張可能性

1. **一括操作**:
   ```bash
   add-skill add repo skill1 skill2 skill3
   ```

2. **物理削除オプション**:
   ```bash
   add-skill remove skill --purge  # ~/.claude/skills/も削除
   ```

3. **バリデーション**:
   ```bash
   add-skill validate  # リポジトリとスキル存在確認
   ```

4. **インポート/エクスポート**:
   ```bash
   add-skill export > backup.yaml
   add-skill import < backup.yaml
   ```

## まとめ

この実装により:

- `add-skill`コマンドでYAML設定を簡単に操作可能
- chezmoi管理と統合され、変更を確認してから適用
- 既存パターンに倣った一貫性のある実装
- エラーハンドリングとユーザーフィードバックが充実

既存のdotfiles管理パターンと整合性を保ちながら、使いやすいCLIツールを提供します。
