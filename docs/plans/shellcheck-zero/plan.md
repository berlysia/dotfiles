# Plan: shellcheck の指摘をエディタ表示レベルまでゼロにする

## Goal

shellcheck の指摘を、エディタが表示するレベル（全 severity、`.shellcheckrc` 適用）でゼロにする。ゼロになった状態を CI で維持する。

対象は `scripts/lint-shell.sh` の発見規則と同じ範囲（`*.sh`、shebang 付きの拡張子なしファイル、レンダリングした `.sh.tmpl`）。`dot_bashrc` / `dot_zshrc` のように shebang も `.sh` 拡張子もないファイルは、lint の対象外なので本 plan の対象外とする。

## 現状（2026-10-01 計測、shellcheck 0.9.0）

- `scripts/lint-shell.sh`（CI と同じ。`--severity=warning`）: 0 件
- 全 severity: 5,246 件。すべて info/style
  - 5,001 件は `.shellcheckrc` の `enable=all` が有効にした optional チェック: SC2250 require-variable-braces 3,770 / SC2292 require-double-brackets 601 / SC2312 check-extra-masked-returns 348 / SC2310 check-set-e-suppressed 108 / SC2249 add-default-case 45 / 他
  - `.shellcheckrc` には「require-variable-braces は既存コードとの互換性のため無効化」とコメントがあるが、`enable=all` が上書きしているため実際には有効になっている。設定とコメントが食い違っている
- `enable=all` だけを外し、明示的な 3 つの enable（avoid-nullary-conditions / check-unassigned-uppercase / quote-safe-variables）を残すと 374 件。29 ファイル（内訳は下表）
- `.sh.tmpl` をレンダリングした結果: 2 件（validate-json-templates-unix の SC2248、install-safe-chain の SC2086）

計測方法: `git ls-files` の `*.sh` と、shebang 付きの拡張子なしファイル（`lint-shell.sh` と同じ検出規則）の計 81 ファイルに対し `shellcheck -f gcc`。`enable=all` を外した値は、`git archive HEAD` を scratchpad に展開し、`.shellcheckrc` から `enable=all` の行だけを削除して計測した。

| コード      | 件数 | 主なファイル                                                 | 分類                           |
| ----------- | ---- | ------------------------------------------------------------ | ------------------------------ |
| SC2248      | 129  | dotfiles_doctor 55, reporter 41, validator 11                | 機械的（クォート付与）         |
| SC2317      | 111  | test_engine 66, tests/agent-vm/run.sh 31, hook-timer 15      | 原因別（下記 T3）              |
| SC2086      | 50   | test_engine 16, reporter 15, validator 10, init 5            | サイト別ルール（T4）           |
| SC2059      | 41   | reporter 31, dotfiles_doctor 9                               | 色変数の扱いに罠あり（T4）     |
| SC2030/2031 | 13   | validator.sh                                                 | **本物のバグ**（T2）           |
| SC1091      | 7    | init / interactive / functions / updates/\*                  | 追跡不能な source（T3）        |
| SC2016      | 9    | agent-vm, run-bootstrap, run.sh, test_engine                 | 意図的なシングルクォート（T3） |
| その他      | 14   | SC2012×4, SC2002×3, SC2001×3, SC2263, SC2181, SC2153, SC2005 | 個別（T4）                     |

## Key Decisions

1. **`enable=all` をやめ、明示的な 3 つの enable だけを残す**。却下した案: `enable=all` のまま 5,246 件をすべて直す。SC2250（`$x`→`${x}`）と SC2292（`[`→`[[`）だけで 4,371 件あり、diff の 8 割以上が挙動に関係しない書き換えになる。さらに `dot_shell_common/` は zsh からも source されるため（`init.sh:83` の `mise activate zsh`）、`[[` への一括置換は bash/zsh 両対応の確認コストを増やす。既存のコメント（require-variable-braces を無効化する意図）とも一致する。
2. **CI とローカルの severity 閾値を外す（全 severity で落とす）**。`lint-shell.sh` の `--severity=warning`（2 か所 + テンプレート 1 か所）と `scripts/hooks/pre-commit:133` の同フラグを削除する。却下した案: CI は warning のまま据え置く。その場合、ゼロにしても次の変更で info/style が再び増えたことを CI が検出できず、「警告がない」状態が維持されない。
3. **正しい指摘で、コードの意図が別にあるものは disable ディレクティブに理由を書いて抑制する**（SC2317 の間接呼び出し、SC1091 のリポジトリ外 source、SC2016 の意図的なリテラル、`set -- $line` の意図的な単語分割）。却下した案: コードを書き換えて指摘を消す。間接呼び出しのスタブや trap ハンドラは書き換えようがなく、書き換えると挙動が変わる。

## Alternative Approaches (Greenfield View)

- **差分最小案**: `.shellcheckrc` に `disable=` を足し、残る 374 件のコードをすべて抑制する。diff は 1 ファイルで済むが、validator.sh の本物のバグ（集計値が常に 0）と test_engine.sh の重複定義が見えなくなる。
- **白紙設計案**: ゼロから作るなら、shellcheck のデフォルトセット + 少数の optional を `.shellcheckrc` に明示し、CI は全 severity で落とし、例外は行単位のディレクティブで理由つきで書く。起源: optional チェックは shellcheck 自身が「スタイルの好みが分かれるので既定では無効」としているもの。すべてを強制するのではなく、チームの規約として選んだものだけを有効にするのが本来の使い方。
- **採用案**: 白紙設計案と同じ形。既存の `.shellcheckrc` が明示している 3 つの enable はその選択の記録とみなして残す。根拠: 本 plan の計測で、3 つの enable を残しても増分は SC2248 の 129 件（+ テンプレート 1 件）で、すべてクォートを付けるだけで直せる。

## Tasks

### T1: `.shellcheckrc` から `enable=all` を外す

- 編集: `.shellcheckrc` — `enable=all` の行と、その直前の「シェルスクリプトの拡張子を持たないファイルもチェック」というコメント（この行の実際の効果と一致しない）を削除する。拡張子なしファイルの検出は `scripts/lint-shell.sh:42-58` の shebang 検出が担っている。
- 参照: `scripts/lint-shell.sh:42-58`
- 確認: 81 ファイルに `shellcheck -f gcc` → 374 行（計測値と一致）

### T2: validator.sh のパイプライン内カウンタのバグを直す（メインループで実施）

- 編集: `home/dot_shell_common/core/validator.sh:78-99`（`validate_readiness_for_apply`）、`:197-206`（`analyze_test_patterns`）
- 症状: `echo "$results" | while read ...; do counter=$((counter+1)); done` は bash ではパイプラインの右辺がサブシェルで動くため、ループ後の `critical_failures` / `warnings` / `core_failures` などは常に 0 になる。そのため readiness は常に `READY`、patterns は常に空になる（zsh はパイプの最後の要素を現在のシェルで実行するので、zsh ではカウンタが FAIL の件数になる。シェルによって結果が違う）。
- 修正: パイプを here-document に置き換える。POSIX sh / bash / zsh で共通に動く。**終端の `EOF` は関数内でもインデントせず 0 桁目に置く**（このファイルはスペースでインデントしているため、`<<-` によるタブ除去は使えない）:
  ```sh
      while IFS='|' read -r category name result_status details; do
          ...
      done <<EOF
  $results
  EOF
  ```
- コミット: T2、T3 の重複定義削除、T3 の `post_apply_test_env_var` の修正は、lint 修正とは別のコミットにする（`fix(shell): ...`）。挙動が変わる差分を機械的な差分と分けてレビューできるようにするため。
- 影響範囲: 呼び出し元は `generate_validation_summary`（`validator.sh:244,252`）のみ。これは `test_suite.sh:237-240` で `VERBOSE=1` のときに表示されるだけで、`exit $exit_code`（`test_suite.sh:243`）は `generate_report` 由来。exit code は変わらず、verbose 出力の `Readiness:` / `Patterns:` 行だけが実際の値を表示するようになる。
- 参照: `home/dot_shell_common/test_suite.sh:225-243`

### T3: 意図された実装への抑制ディレクティブ（メインループで実施）

- `home/dot_shell_common/core/test_engine.sh:516-588`: `test_advanced_git_workflow` が `:516` と `:589` で 2 回定義されており、後の定義が前の定義を上書きする。SC2317 が指す 516-588 は実行されないコード。**516-588 の先の定義を削除する**（実行される定義は `:589` のまま。挙動は変わらない）。削除後、test_engine.sh に SC2317 が残れば、それは個別に原因を確認して T3 の他の項目と同じ扱いにする。なお `:511` の呼び出しは引数なしで `:589` の定義を空の `$adapter` で実行する。これは修正前からの挙動で、本 plan では変えない。
- `home/dot_shell_common/adapters/post_apply_adapter.sh:180-197`（`post_apply_test_env_var`）: `:196` の `eval echo \$$var_name`（SC2086）と、その兄弟の `:194` の `"$shell_name" -c "... eval echo \\\$$var_name"` を同時に直す。両方とも `var_name` が eval の文字列に入るため、名前に `"; cmd; "` を含めるとコマンドが実行される。修正: 関数の先頭で `case "$var_name" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) return 1 ;; esac` と検証する（空、先頭が英字・`_` 以外、英数字・`_` 以外を含む名前を拒否）。`:196` は `eval "printf '%s\n' \"\${$var_name}\""`。`:194` は名前を親で埋め込み、子シェル側では eval を使わない: `"$shell_name" -c "source '$config_path' && printf '%s\n' \"\${$var_name}\"" 2>/dev/null`（子シェルが受け取る文字列は `source '...' && printf '%s\n' "${HOME}"` になる）。`${!var}` は bashism なので使わない。正当な名前に対する挙動の変化: `echo` から `printf '%s\n'` になるため、値が `-n` / `-e` で始まる場合やバックスラッシュを含む場合に、値がそのまま出力されるようになる。これは意図した変更とする。
- `home/dot_shell_common/init.sh` と `home/dot_shell_common/windows.sh` は**メインループだけが編集する**（T3 の SC1091 / SC2263 と T4 の eval クォートが同じファイルに重なるため）。`eval "$($HOME/.local/bin/...)"` は `eval "$("$HOME"/.local/bin/...)"` にする。`init.sh:98` の `eval "$(opam env)"` は指摘対象外で、変更しない。これらメインループ担当のファイルに残る SC2248 / SC2086 などにも、T4 の規則をそのまま適用する。
- `tests/agent-vm/run.sh`: テストケース内で `session_exec` / `notice_orphan_env` / `run_tool` などをスタブとして再定義し、テスト対象のコードから間接的に呼ばせている（例: `:331-338`, `:679`）。ファイル先頭の既存ディレクティブ（`:2` の `disable=SC2154`）に SC2317 を追加し、理由をコメントで書く。`:679,687` の SC2153（`REPO`）は `:2` のコメントどおり `executable_agent-vm` が export する変数なので、同じディレクティブに SC2153 も追加する。
- `home/dot_claude/hooks/executable_hook-timer.sh:61`: `on_signal` は `:80-82` の `trap` からだけ呼ばれる。関数定義の直前に `# shellcheck disable=SC2317 # invoked via trap below` を置く。
- SC1091（7 件）: `init.sh:20`（`env.sh` は `env.sh.tmpl` のレンダリング結果で、lint 時には存在しない）、`init.sh:93`（`~/.cargo/env`）、`interactive.sh:19`（`/usr/share/doc/fzf/...`）、`functions.sh:138`（`/dev/stdin`）、`updates/{chezmoi,dotfiles,mise}.sh:14`（`$SHELL_COMMON/updates/_common.sh`。lint 時の解決パスと実行時のパスが違う）。各 source 行の直前に `# shellcheck source=/dev/null` を置く。`init.sh` 以外（interactive / functions / updates/\*）はワーカー a が T4 と同じファイルを編集するときにこの規則で適用する。
- SC2016（9 件）: 該当行を個別に読み、`$` がリモート側・子シェル側で展開されるべきリテラルであればその行に `# shellcheck disable=SC2016` を置く。ローカルで展開されるべきものであれば、ダブルクォートに直して T2 と同じく本物のバグとして報告する。
- SC2263（`init.sh:63`）: 行を読んで alias の扱いを確認し、本物のバグかどうかを分類してから対応する。
- 参照: `tests/agent-vm/run.sh:2`, `home/dot_claude/hooks/executable_hook-timer.sh:80-82`

### T4: 機械的な修正（sonnet にオフロード）

ルール（ワーカーに渡すもの。ここにないケースはワーカーが判断せず、メインループに戻す）:

- **POSIX 互換を保つ**: `dot_shell_common/` 配下は zsh からも source される。`[[ ]]` や `${!var}` などの bashism を新たに導入しない。
- **SC2248 / SC2086（数値比較・変数展開）**: `[ $x -gt 0 ]` → `[ "$x" -gt 0 ]`。`$(mise current $cmd)` → `"$cmd"`。`${adapter}_foo` → `"${adapter}_foo"`（adapter 名は `pre_apply` / `post_apply` で空白を含まない）。
- **SC2086 で単語分割が意図されているもの**: `reporter.sh:252,334` の `set -- $result_line` は分割が目的なので、クォートせずに直前に `# shellcheck disable=SC2086 # split result_line into fields` を置く。`result_line` は `add_test_result` が組み立てる内部データで、外部入力ではない。
- **SC2059（printf の書式に変数）**: 色変数は `RED='\033[0;31m'` のようにリテラルの `\033` を保持している（`reporter.sh:7-12`, `dotfiles_doctor.sh:17-22`）。`printf '%s' "$RED"` に直すと `\033` がそのまま出力されてしまう。ルール:
  - 色変数の定義を ANSI-C クォートに変えない（`$'...'` は POSIX sh で使えない）。
  - **`%b` で渡すのは、ファイル冒頭で定義された色・アイコンの定数だけ**。`$message` / `$details` / `$name` / `$install_hint` などの実行時の値は、今 `%s` で渡されているものはそのまま `%s` で渡す。実行時の値を `%b` にするとバックスラッシュが解釈され、出力が変わる。
  - 書式文字列のリテラル部分（`%%` を含む）はそのまま書式に残す。例: `printf "${GREEN}${BOLD}%d%%${NC} - Excellent!${NC}\n" "$score"` → `printf '%b%b%d%%%b - Excellent!%b\n' "$GREEN" "$BOLD" "$score" "$NC" "$NC"`（`reporter.sh:167` の末尾の余分な `${NC}` も、出力を変えないために残す）。
  - 書き換えで出力が変わるかどうか判断できない行は、書き換えずにメインループに戻す。
- **SC2012（ls をパイプ）**: 該当箇所を `find ... -mindepth 1 -maxdepth 1` に置き換え、元の出力（名前だけか、パス付きか、並び順）を保つ。保てない場合はメインループに戻す。
- **SC2002（cat の無駄）**: `cat f | cmd` → `cmd < f`。
- **SC2001（sed で置換）**: `${var//a/b}` は POSIX にないので、`dot_shell_common/` 配下では `# shellcheck disable=SC2001` を置く。`scripts/hooks/pre-commit` は bash なので `${var//a/b}` に置き換える（元の sed の正規表現がリテラル置換で表せる場合に限る）。
- **SC2181 / SC2005**: `test_suite.sh:194` は `if ! cmd; then` の形に、`pre_apply_adapter.sh:32` は `echo $(cmd)` → `cmd` に直す。
- **テンプレート 2 件**: `run_before_10-validate-json-templates-unix.sh.tmpl` と `run_onchange_after_install-safe-chain.sh.tmpl` の該当箇所をクォートする。

対象ファイル（`## Files` の編集対象から T2/T3 のメインループ担当分を除いたもの）を 2 つのワーカーに分ける: (a) `home/dot_shell_common/` 配下、(b) それ以外。

### T5: CI とフックの severity 閾値を外す

- 編集: `scripts/lint-shell.sh:76,84,138` の `--severity=warning` を削除。`scripts/hooks/pre-commit:133` も同様。
- 参照: `.github/workflows/ci-shellcheck.yml:41-42`（CI は `lint-shell.sh` をそのまま呼ぶため、ワークフロー自体の変更は不要）
- 既知の制約（本 plan では直さない）: `scripts/hooks/pre-commit:121-123` は staged の `*.sh` と `executable_*` だけを対象にし、`.sh.tmpl` のレンダリングも shebang 検出もしない。そのため、hook を通ったコミットが CI で落ちることはありうる。最終的な判定は CI（`lint-shell.sh`）が行う。hook を `lint-shell.sh` に委譲するには、`lint-shell.sh` に対象ファイルを指定するモードを足す必要があり、これは lint の発見規則の設計変更になるので別の作業にする。本 plan では両者のフラグ（severity）だけをそろえる。

### T6: 検証

下記のテスト計画をすべて実行する。

## Files

```
# 設定・CI
.shellcheckrc
scripts/lint-shell.sh
scripts/hooks/pre-commit

# 本物のバグ・抑制（メインループ）
home/dot_shell_common/core/validator.sh
home/dot_shell_common/core/test_engine.sh
tests/agent-vm/run.sh
home/dot_claude/hooks/executable_hook-timer.sh
home/dot_shell_common/init.sh
home/dot_shell_common/windows.sh
home/dot_shell_common/adapters/post_apply_adapter.sh

# 機械的修正（ワーカー a: dot_shell_common）
home/dot_shell_common/core/reporter.sh
home/dot_shell_common/dotfiles_doctor.sh
home/dot_shell_common/test_suite.sh
home/dot_shell_common/final_validation.sh
home/dot_shell_common/functions.sh
home/dot_shell_common/feature_parity_check.sh
home/dot_shell_common/interactive.sh
home/dot_shell_common/executable_doctor
home/dot_shell_common/updates/mise.sh
home/dot_shell_common/updates/dotfiles.sh
home/dot_shell_common/updates/chezmoi.sh
home/dot_shell_common/adapters/pre_apply_adapter.sh

# 機械的修正（ワーカー b: その他）
home/dot_local/bin/executable_agent-vm
tests/agent-vm/run-bootstrap.sh
scripts/test-codex-config-scripts.sh
scripts/install-skills.sh
scripts/smoke-provisioning-invariants.sh
scripts/setup-claude-skills.sh
scripts/hooks/pre-push
.github/scripts/validate-json-templates.sh
.github/scripts/check-trailing-commas.sh
home/.chezmoiscripts/run_before_10-validate-json-templates-unix.sh.tmpl
home/.chezmoiscripts/run_onchange_after_install-safe-chain.sh.tmpl
```

## テスト計画 (ISO 25010)

### 保守性（解析性）— 主目的

- **操作**: リポジトリルートで `git ls-files` 由来のファイル集合（`*.sh` と shebang 付きの拡張子なしファイル。着手時点で 81 件）に `shellcheck -f gcc`（severity 指定なし。リポジトリの `.shellcheckrc` が適用される） → **期待**: 出力 0 行
- **操作**: 上の集合と、`lint-shell.sh` の `find` が見つけるファイル集合（.sh.tmpl を除く）を `sort` して `comm -3` で比較 → **期待**: 差分 0 行（件数ではなく集合で照合する）
- **操作**: `grep -rn -- '--severity' scripts/` → **期待**: 0 件（T5 の削除漏れがない）
- **操作**: `home/dot_shell_common/` 配下の `#!/bin/sh` ファイル（着手時点で 25 件）に、修正前と修正後で `shellcheck --norc -s sh -e SC1090,SC2034,SC1091,SC3043 -f gcc` を実行し、`SC3xxx` の行を「ファイル名:コード」に正規化して（行番号を落として）`sort` し、`comm -13 修正前 修正後` を取る → **期待**: 出力 0 行（修正後に新しく現れた「ファイル:SC3xxx」の組がない。修正前は SC3030 ×2, SC3028 ×2, SC3054 ×1 の計 5 件）。`.shellcheckrc` の `shell=bash` は `local`（SC3043）を許すために shebang より優先されており、通常の lint では bashism を検出できない。そのため、POSIX 互換の規則が守られたかをこの比較で確認する
- **操作**: `.sh.tmpl` 全件を `chezmoi execute-template --source home` でレンダリングし、`shellcheck -s bash -f gcc` → **期待**: 0 行（OS 条件で空になるものは除く）
- **操作**: `./scripts/lint-shell.sh`（T5 で閾値を外した後） → **期待**: exit 0、`✓ All shell scripts passed shellcheck`。冒頭の `Found N .sh, M .sh.tmpl and K shebang-detected` の N+K が上記 81 ファイルの集合と一致することを照合する（`lint-shell.sh` は `find` で探すので、untracked なファイルがあれば差が出る）
- **操作**: 修正前のコードに未クォートの変数を 1 か所入れた一時コピーで `lint-shell.sh` 相当を実行 → **期待**: SC2086 または SC2248 で exit 1（閾値を外した効果の確認。一時コピーは scratchpad に作る）

### 機能適合性（正確性）— 挙動を変えないこと

- **操作**: 修正前（`git stash` した HEAD）と修正後で `./home/dot_shell_common/test_suite.sh --pre-apply -v` を実行し、出力を `od -c` 経由でバイト単位で比較し、exit code も比較 → **期待**: exit code が同じ。出力の差分は `Validation Summary` の `Readiness:` / `Patterns:` 行のみ（T2 のバグ修正による。修正後は FAIL の件数に応じた値になる）。この出力は `reporter.sh` の書式を通るので、SC2059 の書き換えの回帰も検出できる
- **操作**: 固定入力で `reporter.sh` を直接呼ぶ: `sh -c '. home/dot_shell_common/core/reporter.sh; <各 report_* / print_* 関数> "msg with % and \\n and \033[0m" "details"'` を、`reporter.sh` で SC2059 が出ていた各関数について修正前後で実行し、`od -c` で比較 → **期待**: バイト単位で一致。呼び出す関数名と引数の一覧は、着手時に `reporter.sh` の関数定義から作って scratchpad に保存し、修正前後で同じ一覧を使う
- **操作**: `post_apply_test_env_var` を修正前後で、`var_name` = `HOME`（存在する変数）、`NO_SUCH_VAR_X`（未定義）で呼ぶ → **期待**: 出力が一致する（前者は `$HOME` の値、後者は空行）。修正後は `var_name` = `'x"; echo INJECTED; "'` で呼ぶと exit 1 になり、`INJECTED` が出力されない
- **操作**: 修正前後で `bash home/dot_shell_common/dotfiles_doctor.sh` を実行 → **期待**: ANSI エスケープを含めて出力がバイト単位で一致する（SC2059 の `%b` 変換で色コードが壊れていないことの確認。`| od -c | grep '033'` でエスケープが出力されていることも確認する）
- **操作**: `bash tests/agent-vm/run.sh`、`bash tests/agent-vm/run-bootstrap.sh`、`bash tests/agent-vm/run-shell.sh` → **期待**: 修正前と同じ PASS 件数、FAIL 0
- **操作**: zsh で `zsh -c 'SHELL_COMMON=$PWD/home/dot_shell_common; . home/dot_shell_common/core/validator.sh; validate_readiness_for_apply "core|x|FAIL|d"'` → **期待**: `NOT_READY`。bash でも同じコマンドで `NOT_READY`（T2 の修正後に bash と zsh の結果が一致すること）
- **操作**: `./scripts/smoke-chezmoi-scripts.sh` → **期待**: exit 0（テンプレート 2 件の修正後もレンダリングと実行ができる）

### 対象外とした特性

- 性能効率・互換性（外部インターフェース）: クォートの付与と disable ディレクティブの追加で、外部から見える入出力・依存は変わらない。挙動が変わるのは T2 の verbose 表示と、T3 の `post_apply_test_env_var` が不正な変数名を拒否する点のみで、上の機能適合性で確認する。セキュリティ（eval 注入）は `post_apply_test_env_var` のテストケースで確認する。

## Risks / Unknowns

- SC2263（`init.sh:63`）と SC2016（9 件）は、行を読むまで本物のバグかどうか分からない。本物だった場合は T2 と同じく修正し、完了報告で個別に挙げる。
- T5 で閾値を外すと、今後 info/style の指摘でも CI が落ちる。shellcheck のバージョンが上がって新しい info チェックが増えた場合も CI が落ちる（CI は `apt-get install shellcheck` で、ubuntu-latest のバージョンに依存する）。**このリスクは受容する**。理由: 個人リポジトリで、CI が落ちるのは新しいチェックが既存コードに指摘を出したときであり、エディタの shellcheck が同じバージョンまで上がれば同じ指摘が出る状態なので、オーダー（警告がない状態）からみて知らせてほしい事象にあたる。バージョン固定は、ローカルのエディタ側のバージョンをそろえる手段がないので固定の効果が CI 側に限られ、本 plan では行わない。
- T2 で bash の `Readiness:` / `Patterns:` 表示が変わる（常に `READY` / `None` から実際の値へ）。exit code と CI の判定は変わらない。

## Implementation Notes（実装後に追記）

- **基準値の訂正**: 着手時の 374 件は、81 ファイルを 1 回の `xargs shellcheck` でまとめて渡して数えた値だった。この場合、兄弟ファイルも入力として扱われ、source 先が追跡される。エディタと `lint-shell.sh` は 1 ファイルずつ検査するので、実際には SC1091 が 7 件ではなく 21 件あった（`test_suite.sh` → `core/*.sh`、`init.sh` → `path.sh` など、リポジトリ内の source）。
- **方針の変更（logic-validator 検証済み、sound-with-conditions）**: 21 か所すべてに `source=/dev/null` を置く代わりに、`.shellcheckrc` に `external-sources=true` を追加した。既存の `# shellcheck source=...` 指定が意図どおり追跡されるようになった。`source=/dev/null` は、追跡できない source（レンダリング後の `env.sh`、`~/.cargo/env`、fzf、`/dev/stdin`）と、ワーカーがすでに適用していた interactive / updates/\* にだけ残っている。
- **SC2263**: source を追跡すると `init.sh:63` に再び現れた。原因は、`linux.sh:6` の `alias grep=...` が同じ `case` の中で source されること。ここでは素の grep が望ましいので、理由つきで disable した。
- **ワーカーの変更の差し戻し**: `scripts/setup-claude-skills.sh` の `ls` → `find -printf` は、GNU find でしか動かない（macOS で壊れる）ので、`ls` に戻して SC2012 を理由つきで disable した。
- **ワーカーの見落とし**: `run_before_10-validate-json-templates-unix.sh.tmpl:90` の SC2248。ワーカーは rc を置いていない `/tmp` でレンダリングして検査したので、検出されなかった。メインループで修正した。
- **guard**: `research.md` がないと、`document-workflow-guard` は承認済みでも deny する（`document-workflow-guard.ts:123,234`）。ところが `diagnoseGate` の表示には `research.md` の条件が出ないので、「全条件 ✓ なのに blocked」と表示された。`research.md` を追加して解消した。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: `%b` 変換の回帰テストが機械依存の doctor 出力だけで弱い。`post_apply_adapter.sh:194` の兄弟 eval が残り、両分岐の出力が揃わない。here-doc の終端は 0 桁目に置く必要がある。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 各変更はオーダーに根拠づけられている。eval 書き換えに個別のテストがない点のみ軽微。

### decision-quality-reviewer

- verdict: needs-work（advisory）
- 主指摘: CI の severity 撤廃に伴うバージョン変化リスクの受容根拠がない。挙動が変わる T2/T3 を lint 修正と同じ単位に混ぜている。（中間案の再提示はトリアージで除外）

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: バージョン差の受容と、計測対象外ファイルのスコープを明記するとよい。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: pre-commit が lint の呼び出しを独自に持ち、ドリフトしうる。`shell=bash` が `#!/bin/sh` の bashism を隠すので、POSIX 規則を検証する手段がない。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: `post_apply_adapter.sh:193-196` の eval は `var_name` 経由の注入が残る。`%b` を実行時データに適用するとエスケープが解釈される。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: 出力をパースする消費者はいない。`%b` は色定数だけに限り、`test_suite.sh -v` の出力もバイト単位で比較するとよい。

### Intent triage (Round 1)

- 採用 14 / 除外 1。除外: decision-quality の「中間案（SC2248 のみ・CI は warning 据え置き）を選択肢として再提示」。ユーザーが AskUserQuestion で範囲を選択済みのため。

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 の 3 点は解消。軽微: `:194` の置き換え後の行が未記載、`echo`→`printf` の挙動差を明記するとよい（反映済み）。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 解消。軽微: `post_apply_test_env_var` の修正も別コミットに含める、Risks の「エディタにも同じ指摘」はバージョン一致が前提（反映済み）。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 解消。軽微: SC3xxx 比較は件数でなく集合で、メインループ担当ファイルにも T4 規則を適用と明記（反映済み）。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 解消。軽微: 数字で始まる名前を拒否、`echo`→`printf` の挙動差を意図した変更として明記（反映済み）。

### Intent triage (Round 2)

- 採用 8 / 除外 0。すべて軽微で、本義を狭める指摘はなし。

### scope-justification-reviewer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=bdd50c8a0b8faeefc9c536f1c091bae0a52dad5f967fa90151b7329d53fa5147; design-hash=a75af37377a94a166d5b1def00178e58afa5181a9c9ee333ecfb85c2879a9bd8; round=1; at=2026-10-01T11:26:43.136Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=14; excluded=1; at=2026-10-01T11:26:56.841Z -->

<!-- auto-review: verdict=pass; hash=03bcca8bc73654d5a2b333dabbeb2064b346a810fbb93b54c0c5a4100aa393c8; design-hash=12ae954b80337247695c795311859cb4d99b53a1f29c33f049fa940827ffa011; round=2; at=2026-10-01T11:29:21.748Z; reviewers=logic-validator+decision-quality-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=8; excluded=0; at=2026-10-01T11:29:21.765Z -->
