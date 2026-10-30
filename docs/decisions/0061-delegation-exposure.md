# ADR-0061: 外部へ送る委譲を Task 単位で判断する

## Status

accepted (2026-10-30)

## Context

ADR-0056 は、Codex と OpenCode の委譲先を区別し、`delegation route` が送り先を勧める方法を定めた。
OpenCode への委譲では、brief と、起動作業ツリーのうち agent が読める範囲を提供側へ渡す。
送った内容は、提供側が学習・保持する前提で扱う。

公開リポジトリでも、未 push の差分や未追跡ファイルが公開済みとは限らない。
作業ツリーの外にある記憶や会話の非公開情報も、Task の brief に入れば送られる。
そのため、各 Task の内容と読み取り範囲で判断する。

利用者は、無料モデルとして `opencode/deepseek-v4.1-flash-free` と `opencode/glm-5.3-flash-free` を指定した。
ADR-0056 に定めた送り先の表を変えずに、新しい外部送信の判断と委任 gate を記録する。

## Decision

### Task 単位の判断と委任 gate

- `plan-execution.md` の各 Task に `**外部送信**: 不可` を置く。`可` は、Task の本文と起動する作業ツリーの agent が読める範囲を提供側へ送る承認を表す。
- `--exposure external-ok` を渡してよいのは、人間の承認を経た plan-N の Task にある `**外部送信**:` の行の値が `可` の場合だけである。可否はこの行の値だけから読み、ほかの行や文で値を上書きしない。
- `可` の Task を含む plan-N は委任 gate を通さず、人間の承認を要する。値が無い、または表記が異なる場合は許可とみなさない。
- 送る範囲を公開済み・公開予定・非公開のどの段とするかは、Document Workflow の外と同じ表で判断する。
- `model-offloading.md` は、brief の不変条件と公開範囲の判断を定める。brief は承認済み Task の本文と作業ツリーの内容だけで組み、research、別の workflow 文書、記憶と学び、`.env` の値を含めない。この制約は規約であり、機構では検査しない。

### 入口の再照合

入口は `--version` の後に作業ツリーの検査と照合をやり直す。
最初の照合で hash を得た後から `--version` の起動まで、状態変化の可能性を排除できない。
二度目の照合から `offload.log` の追記と spawn までにも、状態変化の可能性を排除できない。
この限界を K8 の既知の限界として受け入れ、spec の文言は改めない。

gate は厳密な形の `不可` 行を本文から先に除き、残る本文を一系列で文字と数字だけに縮める。縮めた本文に `外部送信` が残るときは委任を許さず、人間の承認へ戻す。
この判定が守る範囲は、雛形どおりか、不注意な表記のゆれで `可` を示した plan-N を人間の承認へ回すことに限る。
意図して語を隠す記法は保証の外とする。

縮めた本文で語が連続しない書き方はすべて止めない。
たとえば語の途中に文字や数字を挟む書き方、言い換え、別の符号化、同形字の使用、別の行で宣言と食い違う記述が残る。
この限界は、意図して隠す書き方を保証の外とする判断と、許可の値は指定行だけから読む規約に沿う。

HTML コメントの中の語も gate の対象にする。
テンプレートの説明は HTML コメントに残し、判定語を含まない文にする。
spec K4 にあった説明文は、HTML コメントという置き場を保ち、判定語を使わない文に改める。
spec K12 の「HTML コメントの外の行」という条件と、spec の説明文、および説明コメントに判定語があっても委任するテストの期待は採らない。
コメント行を先に取り除く方式では、Markdown の表記や描画の違いによって判定語を見落とす書き方が残る。

### 保証の範囲と、保証しないこと

- OpenCode の権限では `skill` と `opencode_worktree_remove` を止めない。後者は外部送信ではないが、作業ツリーを消す可能性がある。
- OpenCode が事前に許可する場所へアクセスする可能性がある。その場所の扱いは未確認である。
- 作業ツリーの `AGENTS.md` と `CLAUDE.md` は読み取り範囲に入り、agent の判断に影響する。
- 起動前の検査後に、並行する別の作業が作業ツリーへ symlink を置いた場合、その symlink 経由の読み取りは検査の対象外になる。
- read deny は既知のパスを列挙する方式であり、列挙に無い秘密ファイルは読める。K4 の承認は agent が読める範囲全体に及ぶため、利用者はその範囲を確認して判断する。
- brief が最大の露出面である。入口が拒否するのは、秘密と高い確度で判断できる文字列に限られる。曖昧な値や利用者が本文へ書いた非公開情報は機構で止めない。
- 補助呼び出しが `-m` と異なる provider へ送る可能性は、実機確認で送り先を観測するまで未確認とする。応答が返ったかどうかだけでなく、送り先を確認する。
- Claude Code の hook が扱うのは Bash からの不注意な直接起動である。端末や Codex からの起動、意図的な難読化、hook の時間切れは保証しない。

R1(e) の主な露出面は、作業ツリー全体を読む research の委譲である。
作業ツリーの内容を外部モデルに渡す承認は、Task ごとに判断する。

### 記録と効果の確認

- 利用者が指定した無料モデルは `opencode/deepseek-v4.1-flash-free` と `opencode/glm-5.3-flash-free` である。
- 台帳の invocation にある `opencode:--agent=` は、起動に使った agent を表す。値は読み取り用の `worktree-read` か、書き込み用の `worktree-edit` である。
- #479 の commit にある “until delegations carry an exposure” は、「委譲が区分を route の入力として持つまで」と読む。
- external-ok にできる委譲の件数は未知である。route の区分表示と台帳から後で確認する。
- 効果は、台帳の harness `opencode` の行数、規則 0 の推奨が採用された件数、`offload.log` の `spawned` と拒否の件数で判断する。`offload.log` の形式版が異なる記録は集計から外す。
- `**外部送信**` の宣言に伴う承認の手間は意図した設計である。この gate は、宣言の無いまま external-ok を渡す起動を止めない。
- これらの計測で外部への委譲がほとんど使われず、Claude の枠も減らないと分かった場合は、入口と hook を残したまま route の外部候補を止めるか見直す。

## 却下した代替案

- ADR-0056 を直接書き換える案は採らない。送り先の選択と外部送信の承認は別の決定であり、新しい ADR に記録する。
- リポジトリの公開状態だけで送信可否を決める案は採らない。判断の単位は Task であり、公開リポジトリにも未 push の差分や非公開の情報がある。
- brief の文字列だけを検査して、作業ツリーの読み取り範囲を対象外にする案は採らない。送信される範囲は brief に限られない。
- `**外部送信**` の行が無い plan-N をすべて委任不可にする案は採らない。外部送信を含まない既存の plan-N まで委任で通らなくなるためである。
- HTML コメント内の行を判定から外す案は採らない。書式の違いによる見落としが残るためである。

## Consequences

- `可` の Task を含む plan-N は、人間の承認を経る。`不可` の行は委任 gate の対象から外れる。
- ルールと gate は、送信内容が提供側で学習・保持される前提を共有する。
- 送信可否をリポジトリ全体の公開状態で決めず、Task の本文と作業ツリーの読み取り範囲で判断する。
- 2026-10-30 に、plan-3 の実機確認を opencode v2.2.0 で行った。確認を通過した model は `zai-coding-plan/glm-5.3` と `sarashina/sarashina3.2-mini-thinking` である。記録（`verified.json`）には、この 2 つだけが入っている。
- 確認で見た送り先は、model ごとに自分の provider のホストだけだった（`api.z.ai:443`、`api.sarashina.ai:443`）。model の一覧を取る `models.opencode.ai:443` への接続は、送り先として受け入れている。
- 無料モデルの `opencode/deepseek-v4.1-flash-free` と `opencode/glm-5.3-flash-free` は、利用上限に達したため未確認である。記録に無い model への委譲は入口が拒否する。
- opencode の権限設定では防げなかったものは、入口の起動前の検査で拒否する。作業ツリーの外を指す symlink と、祖先の `opencode.jsonc` が当たる。書き込み用の agent は、権限を確かめる前に deny の対象の `.env` を開くので、秘密を含みうるファイルがある作業ツリーでの起動も入口が拒否する。

## References

- ADR-0028: plan-N の承認を委任する条件
- ADR-0055: 委譲の結果を台帳に記録し、枠と記録から送り先を勧める
- ADR-0056: Codex の委譲先を分ける
- `home/dot_claude/templates/plan-execution.md`
- `home/dot_claude/rules/model-offloading.md`
- `home/dot_claude/hooks/lib/workflow-gate.ts`
- `home/dot_local/share/delegation/constants.ts`
- `home/dot_local/share/delegation/capture.ts`
- `docs/plans/delegation-ledger-followups.md`
