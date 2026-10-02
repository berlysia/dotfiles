# ADR-0025: 配置される文書は配置先で読めるものだけを参照し、運用中の基準は skill の付属文書に置く

## Status

accepted (2026-10-03)

## Context

このリポジトリの `home/dot_claude/` と `.skills/` にある文書は、`chezmoi apply` で `~/.claude/` に配置され、どのプロジェクトのセッションからも読まれる。一方、ADR（`docs/decisions/`）や配置元のパス（`home/dot_claude/…`、`.skills/…`）はこのリポジトリの中にしかない。ほかのプロジェクトで作業するモデルは、それらを開けない。

Document Workflow の文書を減らす作業の中で、この食い違いが見つかった。常時読み込まれる `rules/workflow.md` は予算テストの上限 13KB に達していた。参照 skill の `SKILL.md` は 29KB あり、その大半は hook・CLI・ADR-0015 と重複していた。当初の計画では、SKILL.md の「受容した限界」と「再評価トリガー」を ADR-0015 への参照に置き換えるつもりだった。ユーザーは「ADR への参照ではなく固有の文書が要る」と指摘し、続けて「ほかに同じことをしている箇所も同じ扱いにする」よう求めた。

配置元の文書を 5 つのパターンで走査したところ、11 ファイルが該当した。ADR 番号、`docs/decisions/<番号>`、配置元のパスへの参照である。設計の議論とレビュー（6 ラウンド）の記録は作業セッションの plan（`.tmp/sessions/831651be/`）にあった。`.tmp/sessions/` は 7 日で GC されるので、今後の変更を縛る決定はこの ADR に書き切る。実装はコミット `814ce71`。

## Decision

- **K1（配置される文書の範囲）**: 対象は、git 管理下にある次のファイルとする。テストの `hooks/tests/` と `node_modules/` は除く。`.settings.*.json.tmpl` などの設定ファイルは文書ではないので対象外とする。
  - `home/dot_claude/` 配下の `.md`
  - `home/dot_claude/templates/*.tmpl`
  - `.skills/` 配下の `.md`
- **K2（配置先で読めない参照の扱い）**: 対象の文書は、配置先で解決できるもの（`~/.claude/…` のパス、今いるプロジェクトの `docs/` など）だけを参照する。読めない参照は 3 種に分けて処置する。
  - 内容を得るための参照（参照先にしか基準や手順がない）: 内容を配置される文書へ移す。
  - 出典だけの参照（必要な内容は本文にある）: 参照を消す。ADR との対応はコミット本文と ADR 側に残す。
  - 配置元のパス: 配置先のパスに書き換える（例: `home/dot_claude/agents/x.md` → `~/.claude/agents/x.md`）。
- **K3（運用中に照合する基準の置き場）**: 運用中にモデルが照合する基準は、ADR ではなく skill の付属文書（`.skills/<name>/references/`）に置く。受容した限界や再評価トリガーがこれに当たる。ADR は決定の経緯と理由の記録として残す。付属文書は rsync でディレクトリごと配置されるので、どのプロジェクトからも読める。付属文書に分けるのは、本体とは別に読む場面がある節だけにする。今回はラウンド予算だけを `references/round-budget.md` に分けた。Round 3 を超えて延長するときにだけ読むからである。
- **K4（回帰テスト）**: `deployed-docs-repo-refs.test.ts` は、K1 の範囲で次の 5 つのパターンが現れないことを検査する。失敗時は、ファイル名・行番号・行の内容を出す。
  - `ADR-[0-9]{4}`
  - `docs/decisions/[0-9]{4}`
  - `home/dot_claude/`
  - `home/\.chezmoi`
  - `\.skills/`

  `git ls-files` には `--others` を付けて、まだコミットしていない新しい文書も含める。例外はファイル単位の許可リストに載せ、各エントリの横に理由をコメントで書く。現在の例外は、dotfiles の配置元を編集すること自体が目的の `update-auto-approve` と `insight-digest` の 2 つである。

- **K5（配置される文書を削るときの基準）**: 文を消すときは、その内容が残る場所を示す根拠を 1 つ付ける。付けられない文は、分量の目安に届かなくても残す。
  - DUP: 同じ内容が別の文書にある
  - ENFORCED: hook・CLI が同じ文面を出すか、機械的に強制する
  - RECORD: ADR に経緯がある。経緯にだけ使い、K3 の基準には使わない
  - MOVE: 付属文書へ移す
  - NOISE: 運用者の判断に影響しない
- **K6（`workflow.md` の予算）**: 予算は、実測サイズと 1KB の和を 1KB 単位で切り上げた値にする。今回は 11,260 bytes から 12KB とした。上限に達していたことが今回の作業のきっかけなので、余裕を実測に近く保つ。

### 却下した代替案

- **「受容した限界」などを ADR-0015 への参照に置き換える**: SKILL.md は全プロジェクトに配置されるので、ほかのプロジェクトからはこの参照をたどれない。
- **ADR 番号だけを検査するテスト**: K2 の原則より範囲が狭く、配置元のパスは再発する（Round 4 のレビューで指摘）。
- **行単位の許可リスト**: 例外の 2 つは、ファイル全体が配置元を扱う skill である。行単位にすると、編集のたびに許可リストを直す必要がある。
- **全面書き直し**: 3 つのテストが文書中の文字列を検査し、workflow.md が SKILL.md の節名を参照している。節単位の削除なら、各削除に K5 の根拠を付けて検証できる。

## Consequences

1. **素の `lib/foo.ts` は検出されない**: `hooks/README.md` では、配置先のディレクトリからの正当な相対パスとして使われている。見分けられないのでパターンから外し、手で点検する。テストのコメントにも書いた。
2. **許可リストのファイルは丸ごと検査されない**: 例外の 2 ファイルでは、ほかの種類の参照が混ざっても検出されない。
3. **`workflow.md` に追記できるのは約 1KB まで**: 予算テストは「サイズ ≤ 12,288 bytes」を検査し、現在のサイズは 11,260 bytes である。それを超える追記では、K5 の基準で同じ量を削るか、予算を上げる理由を書いて見直す。
4. **ADR から規則への対応は ADR 側でしかたどれない**: 配置される文書には ADR 番号を書かないので、規則の出典を知るには ADR を検索するか、コミット本文を読む。
5. **節名の参照は残る**: workflow.md は SKILL.md の節名（「ラウンド予算」「承認の記録」「脱出手順」）を参照している。節名を変えるときは参照元も直す。テストはこれを検査しない。

## References

- 経緯: `docs/decisions/0015-document-workflow-operator-ergonomics.md`（ラウンド予算）
- 現行の基準: `.skills/document-workflow-reference/references/round-budget.md`
- 実装:
  - `.skills/document-workflow-reference/SKILL.md`
  - `home/dot_claude/rules/workflow.md`
- テスト:
  - `home/dot_claude/hooks/tests/unit/deployed-docs-repo-refs.test.ts`
  - `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts`
- コミット: `814ce71`
