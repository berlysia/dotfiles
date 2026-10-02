# Research: Claude Code の Mod を chezmoi 管理に載せる

## 背景

この session で、Document Workflow の gate 状態をプロンプト上の帯に出す Mod `workflow-band` を作った。現在の置き場所は `~/.claude/dev-mods/1ec067a4-…/workflow-band/` で、この session 用の hot reload フォルダなので、いずれ片付けられる。これをリポジトリで管理し、`chezmoi apply` するだけでどの session でも読み込まれる状態にしたい。#2〜#4 の Mod も後から同じ経路に載せる前提で考える。

## Mod の構成（現物）

```
workflow-band/
  .claude-plugin/plugin.json      # name / version / description / "types": "./types/index.d.ts"
  hooks/hooks.json                # { "modules": ["./register.tsx"] }
  hooks/register.tsx              # 本体
  hooks/parse.ts                  # workflow-cli 出力の純関数パーサ
  hooks/register.test.ts          # claude plugin test 用（3 件 pass、2026-10-03 にユーザー端末で確認）
  types/index.d.ts                # $.state の契約
```

エンジンは Mod を読み込むたびに `<mod>/.claude-plugin/types/` と `<mod>/tsconfig.json` を書き出す（hot reload 後に実物を確認した）。これらは生成物なので、リポジトリで管理しない。

## Mod の読み込み経路（Claude Code 2.1.287、plugin-authoring の reference.md:68 より）

1. `claude --plugin-dir <folder>`: その session だけ
2. `CLAUDE_CODE_PLUGIN_DIRS`: 絶対パス（`~` も可）をパス区切り文字でつないで指定する。プロセスの環境変数か `~/.claude/settings.json` の `env` ブロックから読まれる（プロジェクトの settings からは読まれない）。各フォルダは `--plugin-dir` と同じように読み込まれ、対話 session では監視されて hot reload される
3. skills フォルダ（`~/.claude/skills/<name>`）に置いたプラグインの自動読み込み
4. marketplace からの install（`claude plugin install`）。CLI のキャッシュにコピーされる。ADR-0016:55 に「キャッシュ内の `hooks/hooks.json` は更新時に上書きされる」とある

## リポジトリの既存の仕組み

- **プラグイン宣言管理**: `home/.chezmoidata/claude_plugins.yaml` を `home/.chezmoiscripts/run_onchange_install-claude-plugins-8.sh.tmpl` が読み、`claude plugin marketplace add "{{ .repo }}"` と `claude plugin install` を実行する。スキーマは `marketplaces[]{name, repo}`（GitHub の owner/repo）と `plugins[]`（`id@marketplace`）。`run_onchange` なので、YAML が変わったときしか再実行されない。ローカルパスの marketplace は前例がない
- **手作りスキル**: リポジトリ直下の `.skills/` を `run_after_sync-skills.sh.tmpl` が `{{ .chezmoi.workingTree }}/.skills` から `~/.claude/skills/` と `~/.codex/skills/` へ `rsync -a --delete` で同期する。`home/` の外にあるソースを、スクリプトが workingTree 経由で配布する前例
- **settings.json の env**: `home/dot_claude/.settings.base.json.tmpl:14-16` に `env` ブロックがある（現在は `CLAUDE_CODE_NO_FLICKER` のみ）。`run_onchange_update-settings-json.sh.tmpl` が `chezmoi execute-template` で展開して jq でマージする。再実行の hash（同ファイル 16 行目）は `.skills/*` の glob も含んでいる
- **chezmoi のソース名**: `home/` 配下で `.` から始まる名前はソースとして扱われない。`.claude-plugin/` を `home/` 配下に置くなら `dot_claude-plugin/` と書く必要があり、そうするとリポジトリ内のフォルダが Mod の形にならず、`claude plugin test` / `validate` をリポジトリ上で直接実行できない
- **型チェック**: ルートの `tsconfig.json` は `include` を持たず、`node_modules` / examples / tests / `*.test.ts` 以外のリポジトリ全体を対象にする（`types: ["node"]`, `jsx: "react-jsx"`）。Mod の `.tsx` が入ると、`'claude-code'` モジュールが無い、`h` が JSX ファクトリでない、のエラーになる。Mod の型チェックはエンジンが書き出す型が必要で、CI では実行できない
- **lint**: `package.json:29` の `lint:oxlint` は `.skills/` などを `--ignore-pattern` で除外している
- **.gitignore**: エンジンの生成物（`.claude-plugin/types/`, `tsconfig.json`）を無視するエントリは無い
- **smoke テスト**: `tests/smoke/<script-name>/<scenario>/setup.sh` の規約で、`scripts/smoke-chezmoi-scripts.sh` が隔離した HOME でテンプレートを展開・実行する。`run_after_sync-skills` に 2 シナリオある。CI は `ci-smoke-chezmoi.yml`（`home/.chezmoiscripts/**` の変更で起動）

## 読み込み経路の比較

| 案 | ソースの場所 | 配布 | 読み込み | 問題点 |
|---|---|---|---|---|
| A | `.skills/<mod>/` | 既存の sync-skills | skills フォルダの自動読み込み | `~/.codex/skills/` にも複製される。スキルと Mod の区別がなくなる |
| B1 | `home/dot_claude/mods/<mod>/`（`dot_claude-plugin`） | chezmoi 本体 | `CLAUDE_CODE_PLUGIN_DIRS` | リポジトリ内が Mod の形にならず、`claude plugin test` をソースに対して実行できない |
| B2 | リポジトリ直下 `mods/<mod>/`（そのままの形） | 新しい `run_after` スクリプトで `~/.claude/mods/` へ rsync | `CLAUDE_CODE_PLUGIN_DIRS`（`mods/*` の glob から生成） | スクリプトが 1 本増える |
| B3 | リポジトリ直下 `mods/<mod>/` | 配布しない | `CLAUDE_CODE_PLUGIN_DIRS` がリポジトリを直接指す | `chezmoi apply` を経ずに編集途中のファイルが全 session に反映される。エンジンの生成物がリポジトリ内に書かれる |
| C | ローカル marketplace | `claude_plugins.yaml` | `claude plugin install` | 前例がなく、ローカルパスが通るか未確認。キャッシュへのコピーなので、ソースを変えても YAML を変えない限り再インストールされない |

## 未確認の点

- `CLAUDE_CODE_PLUGIN_DIRS` を settings の `env` から渡したとき、hot reload の確認ダイアログ無しで読み込まれるか（reference の記述上は `--plugin-dir` と同じ扱い）。実装後に新しい session で確かめる
- skills フォルダの自動読み込み（案 A）が、`SKILL.md` の無いフォルダでも効くか
