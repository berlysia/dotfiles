# delegation-budget Mod の残件

`mods/delegation-budget` を足したときに残した課題。片付いた項目は消し、空になったらこのファイルを消す。

## 実際のセッションで確かめる

テストは偽の `$.session.usage()` と偽の時計で動いている。`chezmoi apply` の後の新しいセッションで、次を確かめる。

- 週次枠が 80% 以上のとき、モデルが Agent を 1 回呼ぶと、結果の後に `[delegation-budget]` で始まる段落がモデルの transcript に残る
- Workflow を 1 回呼んだときも同じ段落が残る
- 利用者の画面にはその段落が出ない
- `subagent_type: "codex:codex-rescue"` の Agent では段落が足されない

## Codex に worktree で実装させる

Codex のプラグインは、サンドボックスを workspace-write か read-only に固定している。
固定しているのは `codex-companion.mjs` の `sandbox: request.write ? "workspace-write" : "read-only"` である。workspace-write は書き込み先の中の `.git` を読み取り専用にする。そのため、`.git/worktree/` に置いた worktree へは、Codex がファイルを作れなかった。

次の順で試す。

1. Bash から `codex exec -C <worktree> --sandbox workspace-write` を直接呼び、worktree に一時ファイルを 1 つ作って消せるかを見る
2. 1 で書けなければ、2 つの案を比べる。1 つは `~/.codex/config.toml` の `writable_roots` に worktree を足す案である。もう 1 つは worktree の置き場所を `.git` の外へ移す案である。置き場所を移すと、次のものを直す必要がある
   - `git-worktree-create` と `git-worktree-cleanup`
   - `WorktreeCreate` と `WorktreeRemove` の hook
   - `developer-experience.md` の worktree の規約

1 が通った場合も、実装を任せる場面では `codex:codex-rescue` を使えない。`model-offloading.md` と Mod の文が `codex:codex-rescue` を指しているので、試した結果に合わせて直す。
