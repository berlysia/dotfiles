# Acceptance (plan-2 T6) — 2026-10-06

環境: Claude Code 2.1.291、`chezmoi apply` の後。`~/.claude/settings.json` の `permissions.ask` は 4 行、`Bash(git -c *)` は allow に無い、`git config --global --get safe.bareRepository` は `explicit`（T5 で確認）。

実行: `claude -p --permission-mode default --model haiku`。`-p` では確認に答えられないので、確認が出たものは拒否になる。scratchpad の `acc/repo`（`git init` の repo）と、その linked worktree `acc/repo/.git/worktree/feat/x`（ブランチ `feat/x`）を使った。

## Edit 系（cwd = acc/repo）

| #   | 対象                                                  | 結果                                                                                    | 期待                     | 判定                                                                                         |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| 1a  | worktree の `src/a.ts`                                | 書けた                                                                                  | 確認なし                 | OK                                                                                           |
| 1b  | worktree の `.github/ci.yml`                          | 書けた                                                                                  | 確認なし                 | OK                                                                                           |
| 1c  | worktree の `.gitignore`                              | 書けた                                                                                  | 確認なし                 | OK                                                                                           |
| 2   | worktree の `.claude/x.json`                          | 拒否（"… which is a sensitive file."）                                                  | 拒否                     | OK                                                                                           |
| 3   | repo の `.git/probe.txt`（`/private/tmp/...` の字句） | 拒否（sensitive file）                                                                  | 拒否、`held:` の 2a / 2b | OK（decisions.jsonl: PreToolUse `ask` → `held: dot segment .git (Layer 2a)` → `(Layer 2b)`） |
| 4   | `~/.gitconfig-acc-probe`                              | 拒否（file-access-guard: "File is outside repository root and not explicitly allowed"） | 拒否（ask）              | OK（止めたのは ask より前の既存のガード）                                                    |
| 5   | `~/.config/git/acc-probe`                             | 拒否（確認待ち）                                                                        | 拒否（ask）              | OK                                                                                           |
| 6   | chezmoi `home/dot_gitconfig-acc-probe`                | 拒否（確認待ち）                                                                        | 拒否（ask）              | OK                                                                                           |
| 7   | chezmoi `home/dot_config/git/acc-probe`               | 拒否（確認待ち）                                                                        | 拒否（ask）              | OK                                                                                           |
| 8   | chezmoi `home/acc-probe.txt`                          | 書けた                                                                                  | 確認なし                 | OK（確認後に削除済み）                                                                       |

4〜7 のファイルは存在しないことを確認した。8 は削除した（ゴミ箱）。

## Bash（9〜13 は cwd = acc/repo、14 は cwd = worktree）

| #   | コマンド                         | 結果                                     | 期待                          | 判定                                                      |
| --- | -------------------------------- | ---------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| 9   | `git -C <repo> status`           | 実行                                     | 確認なし                      | OK                                                        |
| 10  | `git -c color.ui=never status`   | 拒否（"This command requires approval"） | 拒否                          | OK                                                        |
| 11  | `tee .claude/x.json < /dev/null` | 拒否（sensitive file）                   | 拒否                          | OK                                                        |
| 12  | `GIT_PAGER=cat git log -1`       | 拒否                                     | 拒否、`skipped-llm: git-env`  | OK（decisions.jsonl: `skipped-llm: git-env (Layer 2b)`）  |
| 13  | `git notes list`                 | 拒否                                     | 拒否、`skipped-llm: git-head` | OK（decisions.jsonl: `skipped-llm: git-head (Layer 2b)`） |
| 14  | `ls .github`（worktree）         | 実行                                     | 確認なし                      | OK                                                        |

## K1 の前提

PreToolUse が hold（判定を返さない）、PermissionRequest の 2a / 2b も控えたとき、本体が確認を出す（行 2、3、11）。前提は成り立っている。

## T5（日常の操作）

repo の `git status`、`.git` の中の `git rev-parse --git-dir`（`.`）、worktree の中の `git status`、`chezmoi status`、`mise ls` は、どれも bare repo のエラーを出さなかった。確認用の worktree `plan2-probe` は `git-worktree-cleanup` が「コミットが無い」として残した（ユーザーに削除を確認する）。
