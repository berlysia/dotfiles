# セッションより長く残るプロセスと、校正の規則の範囲

cpk-events のセッション（2026-10-29）から届いたフィードバックのうち、まだ手を付けていない項目。
受け口は dotfiles-feedback の private repo の 20261029T063524Z-6fec2318072b である。
片付いた項目は消し、空になったらこのファイルを消す。

## Codex plugin の app-server broker が残る

- 観察: openai-codex 1.0.6 の broker は detached で起動される。
  止めるのは SessionEnd の hook で、`input.cwd` から broker を探す。
  孤立した broker が 6 個あり、うち 5 個は chezmoi の worktree（削除済みのものを含む）に結び付いていた。
  `git-worktree-cleanup` が「使用中」で止まった原因である。
  利用者の承認を受けて、cpk-events のセッションが停止した。
- cpk-events のセッションの仮説（未検証）: 委譲で `--cwd <worktree>` を使ったとき、broker は止まらない。
  このときセッションの cwd はメインの作業ツリーである。
- やること:
  - 仮説を確かめる。
  - `git-worktree-cleanup` が、worktree に結び付いた broker を報告するか止めるようにする。
  - 上流には、broker の idle timeout か、セッションに結び付けた停止を求める。
- 利用者の案: Codex の app-server を 1 つに固定する。
  `delegation route` と `ai-usage` は、使用量をその app-server に問い合わせる。
  Codex 自身の app-server daemon 0.165.0 を使い回せるかは、まだ確かめていない。

## wsl2-ssh-agent が 2 つ動いていた

- 観察: 10/28 に起動した古いデーモンが、10/29 に新しいデーモンが socket を作り直した後も残っていた。
  原因は分からず、ログも無い。
  古い方は、利用者の承認を受けて停止した。
- やること: 新しく起動する前に `-stop` で古いものを止めるか、`-log` を付けて起動する。

## フィードバックや引き継ぎのメモまで校正にかかる

- 観察: CLAUDE.md は、人の読む日本語の文書すべてに japanese-check を求める。
  そのため、ツールの持ち主へのフィードバックや引き継ぎのメモでも、check と修正を何周もしている。
- 利用者の発言（cpk-events のセッションでの発言の引用）:「フィードバックは英語で良いよ、コストかかるし」「日本語のまま校正なしでも良いと思ってる。構成のルールを調整する必要があるが。」
- やること: 持ち主に宛てたメモを校正の対象から外すかを決める。
  メモとは、ツールや dotfiles の持ち主へのフィードバックと引き継ぎのメモである（例 `.tmp/docs/handoffs/`）。
  対象は、japanese-check の規則と japanese-document-gate の 2 つである。
  外すなら、規則の文言を書く。
  dotfiles-feedback の本文も同じ扱いにするかを、合わせて決める。
