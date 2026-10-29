# merge の後の後始末を 1 コマンドにする

merge の後に手でしている作業を、1 つの CLI にまとめる課題である。作業は次の 4 つである。worktree の削除、local branch の削除、本体の checkout の既定 branch の fast-forward、`chezmoi apply`。片付いたら、このファイルを消す。

## 状態

提案・未着手。2026-10-29 に、delivery-policy の merge 前の待ち時間の改修を先にしたので、後に回した。

## 利用者が決めたこと

- 置き場は、delivery-policy とは別の `~/.local/bin` の CLI にする。delivery-policy は保護されたパスに含まれ、分類器を通らずに動くためである。
- 「掃除はワークツリー削除と調和するようにしといてね」。worktree の除去は `git-worktree-cleanup` に任せ、merge 済みかの判定を自前で持たない。

## 分かっていること

- `git-worktree-cleanup <branch>` を対象つきで呼んだときの終了コード:
  - 0: 消した
  - 1: 対象が見つからない（すでに無いときも含む）
  - 2: 残した
- cleanup は最初に `fetch --prune` を実行する。branch は消さない。消さない理由は、どこにも書かれていない。
- cwd が対象の worktree の中にあると、cleanup はその worktree を「使用中」として残す。
- Claude Code の worktree の hook（ADR-0033 D4）は、branch を CAS で消す。コマンドは `git update-ref -d refs/heads/<br> <tip>` である。
- chezmoi の source かどうかは、dotfiles-sync-doctor:139 と同じ方法で判定できる。コマンドは `git -C "$(chezmoi source-path)" rev-parse --show-toplevel` である。
- テストを `tests/heavy/*.test.mjs` に作れば、`.github/` を触らずに CI で実行される。新しい CLI は、`tests/heavy/cli-help.test.mjs` の `ROWS` にも 1 行を足す。

## 再開の入口

方針の案（レビューはまだ）:

1. 引数は PR 番号にする。`gh pr view N --json state,headRefName,headRefOid` で 2 つを確かめる。MERGED であることと、local の tip が headRefOid と一致することである。一致すれば、branch を CAS で消す。この確かめ方は merge の方式によらない。
2. 順序は、cleanup、branch、ff、apply にする。
   - worktree がすでに無いときは、その段を済みとして続ける。
   - cleanup が 2 を返したら止める。
3. ff は、次の 3 つがそろったときだけ `merge --ff-only` で進める。stash はしない。
   - 本体の HEAD が既定 branch を指している
   - status が空
   - 先行が 0
4. apply は、`chezmoi status` が空なら省く。

Document Workflow の plan.md を通す。
