# ADR-0032: plan に書くのは実行するまで分からない決定に限り、書き捨ての作業はすぐ実行する

## Status

accepted (2026-10-15)

ADR-0006 の plan-N.md の構成（Tasks をバイトサイズ TDD scaffold とする）を改訂する。ADR-0008 の P3 を廃止し、Deferred-2 (P11) を閉じる。ADR-0015 と ADR-0026 が定めた `workflow.md` の上限 12KB を 13KB に戻す。

## Context

利用者が 2 つの問題を挙げた（2026-10-15）。

- Document Workflow の plan が厳格すぎて、些末なコード片まで直させられる。plan で決めることと、実装時に決めればよいことの境界をはっきりさせたい。
- 小さい集計スクリプトにもレビュアーを付けがちである。書き捨てなら安く済ませてすぐ実行すればよい。LLM の呼び出しのように実行に費用がかかるなら、後の活用を考えてもよい。

発端は別のセッションの観察である。plan-1.md が 1,700 行を超え、5 ラウンドかかった。指摘の大半はコード片の誤りに見えた。実装した subagent は plan のコード片を書き換えて使っていた。

この見立ては集計で支持されなかった。直近 4 セッション・5 文書の non-pass 指摘 123 件を分類すると、振る舞いの契約の抜けが 41%、不変条件（セキュリティ・並行性・データ保全）の抜けが 25%、設計が 19%、plan 内のコード片の誤りが 11%、手続きが 4% だった（1 つの主指摘を文ごとに分けたので ±10% 程度の幅がある。重大度で重み付けしていない）。1,789 行の plan-1.md でも、コード片は 46 件中 8 件だった。コード片の指摘は、reviewer が plan のコードを実際に実行したときに出ていた。

## Decision

原則は「検証の重さを、実行のコストと、間違えたときに失うものに釣り合わせる」である。実行すれば分かることを、事前のレビューで探さない。

- **K1（plan に書くもの）**: 書くのは、振る舞いの契約（入出力、形式、終了コード、エラー、空や上限の扱い、テストが依存する環境の前提）、不変条件（手段そのものが決定なら手段まで）、テストケース（入力 → 期待）、タスクの分割・順序・Files・参照である。書かないのは、実装とテストのコード本体、fixture の定義、実行コマンドと期待出力の逐語、コミットの手順、内部の関数分割と命名である。コードが決定そのもののとき（公開する型、形式のスキーマ、セキュリティ上の正確な式）だけ、直前に理由を 1 行添えてコードで書く。`templates/plan-execution.md` の Tasks 節をこの形にした。
- **K2（レビューの観点）**: `plan-review-automation` がレビュアーを推奨する全文に、契約・不変条件・テストケースの抜けを見させ、plan 内のコードの細部を verdict の根拠にさせない旨の 1 行を足した。brief を書く直前にモデルへ届く出力なので、`workflow.md` ではなくここに置いた。
- **K3（オフロードの条件）**: `model-offloading.md` の条件を「bite-size TDD まで確定」から「契約・不変条件・テストケースが確定」に替えた。plan にコードが無いので、委譲した worker は小さな判断を自分で下す。brief に「plan に無い判断は報告に列挙する」と書かせる。
- **K4（書き捨ての作業）**: `workflow.md` の Task Intake Routing に、scratchpad で実行して捨てるスクリプトはすぐ実行し、Document Workflow・レビュアー・logic-validator を通さない、と足した。削除・push・課金・scratchpad 外への書き込みを伴うものは、規模によらず対象外とする。実行に費用がかかるものは 1〜3 件で試してから全件を流し、結果をファイルに残す。必須トリガーの「探索と実装が混在」は、リポジトリに残る実装を指すと添えた。
- **K4b（"proactively" の範囲）**: logic-validator を作業の重さに関係なく呼ばせていた文言（agent の description と、`developer-experience.md`・`debugging.md` の規則）に、書き捨てのスクリプトは対象外と添えた。起動後に何を見るかの記述は変えていない。
- **K5（コード片前提の規則）**: テンプレートの P3（fixture の定義）と、自己点検の fixture と「TDD Step 3 は compilable か」の 2 行を外し、「plan にコード本体を書いていないか」の 1 行に替えた。P1（参照行）と No Placeholders は残した。ADR-0008 Deferred-2 (P11、plan のコード片を typecheck する) は、前提のコード片が無くなったので閉じる。
- **K7（`workflow.md` の上限）**: 予算テストの上限を 12KB から 13KB に戻した。K4 の行を足すと 12KB を超えるためである。今回は利用者の判断で、既存の文を削らずに上げた。書き捨ての routing は作業の開始時に読まれる必要があり、参照 skill には置けない。次に上げるときは、その理由を ADR に書く。

### ADR-0026 との関係

ADR-0026 D1 は、ほかの場所で強制されていることを理由に規則の文を削るときの要件である。今回 P3・自己点検の 2 行・TDD scaffold を外したのは方針そのものを変えたためで、D1 には当たらない。一方、新しく足した規則の置き場は D1 (a) の「規則が当てはまる時点に届く出口」で選んだ。K2 は reviewer の推奨の出力に、K4 は routing に置いた。

## 却下した代替案

- **テンプレートを変えず、brief に「コード片の細部は指摘しない」と足す（差分最小案）**: plan の長さは変わらず、誤ったコード片が実装者に渡り続ける。
- **plan のコード片を抽出して typecheck する（P11）**: コード片を書く前提を強める方向で、今回の原則と逆である。
- **既存の文を参照 skill へ移して 12KB に収める**: 移す文ごとに D1 の出口を確かめる必要があり、この変更の範囲を超える。利用者は上限を戻すほうを選んだ。
- **K4 を `workflow.md` の外の rule に置く**: routing と規則が別の場所に分かれ、作業開始時の判断で読まれない。

## Consequences

- plan-N.md は契約とテストケースの列挙になり、コード片の誤りは実装後にテストで拾う。plan に無い小さな判断は worker の報告を通してメインループが採否を決める。
- `workflow.md` の常時読み込みが増える。上限は K7 のとおり、上げるたびに ADR で理由を残す。
- 根拠の標本は 1 リポジトリの 5 文書である。ラウンドの増加がどの分類の指摘に駆動されたかは測っていない。
- K4 と K4b は文書の変更で、振る舞いを機構で止めない。集計の依頼でレビュアーが起動しないか、削除を伴うスクリプトが通常の routing に乗るかは、セッションを観察して確かめる。観察する項目は `docs/plans/plan-layer-weight.md` にある。

## References

- 改訂の対象:
  - `docs/decisions/0006-document-workflow-two-layer.md`
  - `docs/decisions/0008-document-workflow-feedback.md`
  - `docs/decisions/0015-document-workflow-operator-ergonomics.md`
  - `docs/decisions/0026-rule-removal-requires-delivery-and-backstop.md`
- 先行する論点と、この後に観察すること: `docs/plans/plan-layer-weight.md`
- 上限の経緯: `docs/decisions/0018-workflow-gate-no-in-project-scratch-exemption.md`、`docs/decisions/0025-deployed-docs-self-contained.md`
