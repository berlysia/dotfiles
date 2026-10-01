# Research: shellcheck findings in the dotfiles repo

## Order

「shellcheckの警告がないようにしたい」。範囲はユーザーが「optional チェックを整理し、残りはコードで直してエディタ表示ゼロ」を選択済み。

## Lint entry points

- `scripts/lint-shell.sh`: CI (`.github/workflows/ci-shellcheck.yml`) とローカルの単一入口。`*.sh`、shebang 付きの拡張子なしファイル、`.sh.tmpl`（`chezmoi execute-template` でレンダリング）を `--severity=warning` で検査する。
- `scripts/hooks/pre-commit:120-140`: staged の `*.sh` / `executable_*` を独自に `--severity=warning` で検査する。
- `.shellcheckrc`: `shell=bash`（`local` を許すため。`#!/bin/sh` の shebang より優先される）、`disable=SC1090,SC2034`、`enable=all` と 3 つの明示的な enable。`enable=all` が「require-variable-braces は無効化」というコメントの意図を上書きしている。

## Measurements (shellcheck 0.9.0)

- `--severity=warning`: 0 件
- 全 severity: 5,246 件（81 ファイル）。うち 5,001 件は `enable=all` 由来の optional チェック
- `enable=all` を外した場合: 374 件。内訳と分類は plan.md の表を参照
- レンダリング済み `.sh.tmpl`: 2 件

## Findings that are not style

- `home/dot_shell_common/core/validator.sh:78,197`: `echo | while` のパイプライン内でカウンタを更新しており、bash ではループ後に常に 0（SC2030/2031）。呼び出し元は `test_suite.sh -v` の表示のみ
- `home/dot_shell_common/core/test_engine.sh:516,589`: `test_advanced_git_workflow` が 2 回定義されており、先の定義は到達不能（SC2317）
- `home/dot_shell_common/adapters/post_apply_adapter.sh:194,196`: `var_name` が eval の文字列に入る。子シェル側の分岐で注入が通ることをハーネスで確認済み
- `tests/agent-vm/run.sh`、`home/dot_claude/hooks/executable_hook-timer.sh` の SC2317: テスト用スタブと trap ハンドラで、間接的に呼ばれる意図された実装
- `home/dot_shell_common/` は zsh からも source される（`home/dot_zsh/dot_zshrc:39`、`init.sh:83`）
