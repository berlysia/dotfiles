# worktree の置き場をリポジトリの外へ移す

提案・未決。出どころは dotfiles-feedback の 2 件である。

- 20261029T083851Z-eea90f8e8c20: 置き場を移す提案
- 20261029T084310Z-f9c78f34c7ac: 上の提案で確かめる hook の箇所の一覧

## `.git/` の下の worktree で Vite の開発サーバーが起動しない

- **観察**: `<repo>/.git/worktree/<branch>` に置いた worktree で、`pnpm run dev` が止まった。
  - エラーは `Failed to load url /.void/entry.ts` だった
- 対象は cpk-events の views/web（void + Vite 8.3.4）である。
- 同じ内容を `.git/` の外にコピーすると起動した。
- **送った人が挙げた原因**: worktree の絶対パスに `/.git/` が含まれ、`.git` を危ない場所として除外するツールに拒まれる。
  - Vite の配信の拒否リスト（`server.fs.deny`）の既定に `**/.git/**` がある。void（Cloudflare）のプラグインも config で同じパターンを足し直すので、プロジェクトの設定では外せない
  - Vite のファイル監視の除外にも `**/.git/**` があり、こちらは Vite に固定されている。拒否リストをプラグインで書き換えれば起動はしたが、ファイルを変えても反映されなかった
- 送った人の見方: worktree を `.git/` の下に置くと、検索・エディタ・ファイル監視が自動で除外する。同じ仕組みが、`.git` を安全のために拒むツールでは裏目に出る。プロジェクトにプラグインを入れて回避するのは避けたい。

## 直す方向の案

- 置き場を、リポジトリの外の兄弟ディレクトリに変える。例: `~/workspace/cpk-events.worktrees/<branch>`。
- メインの作業ツリーの外なので、gitignore を足さなくても、メインのツリーを走査するツールは拾わない。
- worktree のパスに `.git/` が入らないので、Vite などが動く。

## 変える範囲（送った人の見込み）

- `dot_local/bin/executable_git-worktree-create` と `executable_git-worktree-cleanup`
- `dot_claude/hooks/lib/claude-worktree*.ts`（WorktreeCreate と WorktreeRemove の置き場）と、そのテスト
- `rules/developer-experience.md` の Git Worktree Convention
- `rules/model-offloading.md` で Codex に渡す `-C` のパスの確かめ方（基準が `<repo>/.git/worktree/`）
- 既存の `.git/worktree/` の下の worktree の移し方

## `.git/worktree/` を前提にしている箇所

下はコードを読んだ結果で、どれも実際には動かしていない。

- `dot_claude/hooks/lib/write-protection.ts` の `WORKTREE_DIR = "/.git/worktree/"`:
  - ドットを含むパスへの書き込みを拒む規則の例外として、`.git/worktree/` の下だけを worktree の中身として通している
  - 兄弟ディレクトリではパスにドットが入らないので、この例外は要らなくなる見込み。消すか、新しい置き場に合わせて直すかを決める
  - 代わりに、Claude Code の作業ディレクトリの外になるので、本体の権限確認が出る見込み
- `dot_claude/hooks/lib/bash-write-hold.ts` の `WORKTREE_PATH`:
  - Bash の書き込み先が `.git/worktree/` の下なら、保留せずに通す処理。直すか消すかを、上と同じく決める
- `dot_claude/hooks/lib/workflow-files.ts` の `findRepoToplevel`:
  - plan の `## Files` の相対パスを、どの checkout を基準に解くかを決める
  - worktree かどうかは、`.git` ファイルの gitdir が `<root>/.git/worktrees/`（git の管理情報）を指すかで判定する。管理情報の場所は置き場を移しても変わらないので、読む限りでは兄弟ディレクトリでも worktree と判定される
  - 上へたどるループは `realRoot` に着く前提で書かれている。root の外にある target で実際に動かして確かめる
- workflow-cli dir と承認の表示:
  - wfDir はセッションを始めた場所の `.tmp/sessions/<id>`（`cli/workflow.ts` の `SESSIONS_SUBDIR`）で決まる。メインの作業ツリーで始めて兄弟の worktree で作業するなら、今と変わらない
  - worktree の中でセッションを始めたときの wfDir の位置と、gate の判定を確かめる
  - 承認の質問に出す作業ツリー名（`lib/workflow-approval.ts` の `describeApprovalWorkflow`）は、wfDir の親ディレクトリの名前を使う。worktree の中で始めると、表示がブランチ名からディレクトリ名に変わる見込み。表示だけの変化かを確かめる

## 未決

- Claude Code の作業ディレクトリの外になるので、権限の確認が増えないか。
- 上の箇所のほかに、`.git/worktree/` を前提にした hook や guard が無いか。
- 既存の worktree をどう移すか。移行期間に、両方の置き場を受け付けるかを決める。
- ADR の変更を伴う。Document Workflow（spec + plan-N）を通す。
