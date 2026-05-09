# Workflow Rules

## Session Scoping

- One focused goal per session (investigate OR implement, not both)
- For multi-phase work: separate investigation, planning, and implementation into distinct sessions
- Use sub-agents (Task tool with Explore agent) for codebase investigation to preserve main context
- Track cross-session progress with TaskCreate when work spans multiple sessions

### Session Artifact Retention

`.tmp/sessions/` は GC スクリプトにより **7日超で自動削除** される。セッション中に作成した成果物を残す必要がある場合、セッション終了前に以下のいずれかに再配置すること:

- **設計判断**: `docs/decisions/` に ADR として記録
- **実装計画（未着手・途中）**: `docs/plans/` に移動
- **調査結果**: `docs/` 配下の適切な場所に移動

`.tmp/sessions/` に残したまま放置された成果物は、7日後に予告なく削除される。

## Task Management

- **Simple tasks** (1-2 steps): Execute directly without task tracking
- **Medium tasks** (3-5 steps): Use TodoWrite for lightweight progress tracking
- **Complex tasks** (6+ steps or multi-session): Use TaskCreate/TaskUpdate for full tracking
- Avoid creating tasks for trivial operations — the overhead should not exceed the work itself

## Task Intake Routing

タスク受付時に実行モードを判定してから着手する:

| 条件                                                                  | 実行モード                               |
| --------------------------------------------------------------------- | ---------------------------------------- |
| 1-2 ステップ、1-2 ファイル                                            | 直接実行                                 |
| 3-5 ステップ、明確な方針                                              | `/approach-check`                        |
| 3-5 ステップ + 単一の設計判断                                         | **Document Workflow (plan.md のみ)**     |
| 3-5 ステップ + 複数判断 OR 6+ ステップ + 単一判断 OR 複数サブシステム | **Document Workflow (spec + plan-N)**    |
| Scope Guard 検知                                                      | `/scope-guard` → spec + 1..N plan に分解 |

**Document Workflow 必須トリガー（いずれか1つで発動）**:

- ADR の planning phase に該当する作業
- アーキテクチャ・API設計・データモデルの変更
- 探索と実装が混在するタスク（「調べてから実装」）
- ユーザーが計画を要求した場合

**モード判定の責務**: しきい値判定は **人間/Claude が routing 表を参照して行う**。`document-workflow-guard` hook は spec.md ファイル存在で二層モード判定するのみ（モード推奨は行わない）。判定の揺れを最小化するため routing 表に従って機械的に振り分ける。

**禁止**: 上記トリガーに該当するタスクで `$DOCUMENT_WORKFLOW_DIR/plan.md` 承認前に実装へ着手すること（二層モード時は spec.md と plan-N.md の両方の承認が必要）

**Note**: ステップ数が少なくても設計判断を伴う場合は Document Workflow 必須。Scope Guard が検知した場合は `/scope-guard` の推奨戦略に従う。設計判断が複数ある場合は二層モード (spec + plan-N)、単一判断ならステップ数次第で plan.md のみで足りる。

## Document Workflow Protocol (MANDATORY)

セッション開始時に `DOCUMENT_WORKFLOW_DIR` 環境変数が設定される（例: `.tmp/sessions/abcd1234/`）。
ワークフロー成果物はすべてこのディレクトリ配下に作成する。未設定時はワークフローガードが無効になる。

### 共通フロー

````
1. 調査: 対象コードを深く読み `$DOCUMENT_WORKFLOW_DIR/research.md` を作成
2. 計画: モードに応じた成果物を作成（下記 plan.md-only モード / spec + plan-N モード参照）
3. 注釈反復: ユーザー注釈を反映し、都度「don't implement yet」を明示
   - コードベース探索ゲート: 質問前に、コードを読めば答えが得られる不明点は自力で解消し、事実と推奨を提示する。ユーザーに聞くのはコードだけでは判断できない点のみ
   - 依存質問の逐次化: 前の回答に依存する質問は同じラウンドに含めず、次ラウンドで聞く
   - 推奨理由の明示: 選択肢を提示する際は推奨とその理由を1行で明示する
4. 完成: 各成果物の `## Approval` で `Plan Status: complete` にする
5. 自動レビュー: `plan-review-automation` が成果物の内容を分析し、層に応じた常時必須レビュアー（下記の SSoT 区間参照）+ コンテンツベースで選定した追加レビュアー（最大3つ）を並列実行推奨。`Review Status` と `<!-- auto-review: verdict=...; hash=...; reviewers=... -->` を更新する
   - **5.1 Reviewer Outputs section の追記 (MANDATORY)**: reviewer 並列実行後、Claude は各 reviewer の verdict + 主指摘 1-2 文を spec/plan の auto-review marker 直前に `## Reviewer Outputs (Round N)` セクションとして追記する。N は当該文書の review round 数（1 から始まる）。フォーマット例:

     ```markdown
     ## Reviewer Outputs (Round 1)

     ### logic-validator
     - verdict: pass / needs-work / blocker
     - 主指摘: <1-2 文>

     ### scope-justification-reviewer
     - verdict: ...
     - 主指摘: ...

     <!-- auto-review: verdict=...; hash=...; ... -->
     ```

     これは `lessons-learned-extractor.ts` (P12 hook) の入力主経路となる。section が無いと lessons 抽出は skip される（早期 return）。
   - **5.2 入力 cap**: 各 reviewer の指摘記述は 1-2 文に絞る。長文 verbatim 引用は禁止（lessons-learned 抽出の noise になる）
6. インテント整合性トリアージ: 全レビュー指摘を元のオーダーの本義と突き合わせ、意図を歪める指摘を除外する（詳細は後述）
7. 承認: 人間が `Approval Status: approved` にする
8. 実装: `Plan Status: complete` + `Review Status: pass` + `Approval Status: approved` + hash 一致を満たした後に着手し、タスク完了ごとに対象成果物を更新
````

### plan.md-only モード（軽量 spec 内包）

**適用条件**: 3-5 ステップ + 単一の設計判断。

**成果物**: `$DOCUMENT_WORKFLOW_DIR/research.md` + `$DOCUMENT_WORKFLOW_DIR/plan.md`

`plan.md` には軽量 spec セクション（短文版）を内包する:

- Goal: 1 行
- Experience Delta: 1-2 行（Goal に同居も可）
- Alternative Approaches (Greenfield View): 各案 1-3 行
- Key Decisions: 箇条書き 1-3 行/件
- Risks: 必要時のみ
- Files / Tasks / ISO 25010 テスト計画
- Approval

ステップ数や設計判断が膨らんで二層モードへ昇格する場合は、軽量 spec セクションを抜き出して `spec.md` を作成し、Files/Tasks を `plan-1.md` / `plan-2.md` に切り出す。

### spec + plan-N モード（二層）

**適用条件**: 3-5 ステップ + 複数判断 OR 6+ ステップ + 単一判断 OR 複数サブシステム OR Scope Guard 検知。

**成果物**:

```
$DOCUMENT_WORKFLOW_DIR/
  research.md
  spec.md             # 設計層（1 つ）
  plan-1.md           # 実行層 1
  plan-2.md           # 実行層 2 (任意)
  ...
```

- **spec.md**: Goal / Experience Delta / Architecture / Alternative Approaches (Greenfield View) / Key Decisions / Risks / ISO 25010 次元選択 / Approval
  - テンプレート: `home/dot_claude/templates/spec.md` を参照
- **plan-N.md**: 冒頭 `<!-- spec-ref: spec.md -->` / Files (fenced code block + 1 行 1 パス) / Tasks (バイトサイズ TDD scaffold) / ISO 25010 具体テストケース / Approval (`parent-spec-hash` フィールド必須)
  - テンプレート: `home/dot_claude/templates/plan-execution.md` を参照
  - ファイル名は `plan-1.md` / `plan-2.md` ... の連番形式（`^plan-[0-9]+\.md$` 完全一致、欠番許容）
  - `parent-spec-hash` フィールドは `plan-review-automation` hook が auto-review marker 生成時に挿入する

**Files セクションの形式仕様**: plan-N.md の `## Files` は fenced code block (` ``` ` 区切り) + 1 行 1 パス（プロジェクトルート相対）。`#` 始まりの行と空行は無視。それ以外の非パス行（インデント・タブ混入・複数パス連結等）は形式違反として `document-workflow-guard` が conservative deny する。

**承認連鎖**:

1. spec.md を `Plan Status: complete` → `Review Status: pass` → `Approval Status: approved` の順で進める
2. spec 承認後、plan-N.md を独立に同手順で承認
3. 実装系書き込み時に `document-workflow-guard` は: (a) spec.md 三状態 + hash 一致、(b) 対象ファイルの所属 plan-N.md 三状態 + hash 一致、(c) plan-N.md の `parent-spec-hash` と現 spec.md hash 一致、を read-snapshot で検証

**state machine 遷移ルール**: spec.md 編集（hash 変動）後は plan-N.md の `parent-spec-hash` が不一致になり、自動的に実装ブロック（K7 連鎖検証）。`parent-spec-hash` フィールドが欠落している plan-N.md は不一致と同等扱いで conservative deny（bypass 防止）。

**進行中 plan.md → 二層モード昇格手順**:

1. 軽量 spec セクション（Goal / Greenfield / Decisions 等）を `spec.md` に抽出
2. Files / Tasks を `plan-1.md` （以降 plan-2.md ...）に切り出す
3. spec.md / plan-N.md 各々で承認再取得（`Plan Status: draft` から再開）

**spec.md 改訂後の plan-N.md 再同期手順**:

1. spec.md を編集して `plan-review-automation` を発火させる
2. plan-N.md の Approval セクションを更新（`Review Status: pending` および `Approval Status: pending` の両方に戻す。Approval を approved のままにすると K7 で実装ブロックされるが、状態整合性のため明示的に戻す）
3. `plan-review-automation` が plan-N.md の auto-review marker に新しい `parent-spec-hash` を埋める
4. 必要なら plan-N.md 本文を更新して再レビュー → 人間による再承認

### No Placeholders 禁則（plan.md / spec.md / plan-N.md 共通）

以下を成果物に残してはならない（実装フェーズ前に全て解消する）:

- "TBD" / "TODO" / "後で実装" / "fill in details"
- "適切にエラー処理" / "バリデーションを追加" / "エッジケース対応"
- "上記と同様" / "Task N と類似"（同じコードを繰り返し書く。タスクは独立に読まれる）
- 他タスクで未定義の型・関数・メソッドへの参照
- 評価語のみの根拠（"シンプル" / "安全" / "リスクが低い" のみで具体的根拠なし）

判定基準に曖昧語を使わない（「正しく」「適切に」「問題なく」→ 具体的な期待値・状態で記述）。境界値・異常値が関わる場合は具体的な値を明記する。

### 常時必須レビュアー（層別、並列実行）

**spec 層レビュアー（4 名）**:

<!-- ssot:spec-reviewers:start -->

- `logic-validator`
- `scope-justification-reviewer`
- `decision-quality-reviewer`
- `greenfield-perspective-reviewer`

<!-- ssot:spec-reviewers:end -->

**plan 層レビュアー（2 名 + コンテンツベース選定）**:

<!-- ssot:plan-reviewers:start -->

- `logic-validator`
- `scope-justification-reviewer`

<!-- ssot:plan-reviewers:end -->

plan-N.md は実行層であり、設計判断は spec.md で済んでいる前提のため、`decision-quality-reviewer` / `greenfield-perspective-reviewer` は spec 層のみに常駐させる。plan 層では追加で `test-quality-evaluator` / `code-simplicity-reviewer` 等をコンテンツベースで自動選定する。

**plan.md-only モード（単層）の常時必須レビュアー**は spec 層と同じ 4 名（軽量 spec を内包しているため設計レビュアーが必要）。

両配列に同名 slug (`logic-validator` / `scope-justification-reviewer`) が出現することは許容する。drift detection は各マーカー区間 × 各定数配列の独立 deepStrictEqual で実施（ADR-0005 / ADR-0006 規約）。

これらのリストは `home/dot_claude/hooks/implementations/plan-review-automation.ts` の `SPEC_REVIEWERS` / `PLAN_REVIEWERS` 定数と CI レベルで同期される（ADR-0006 参照）。

**CRITICAL: 承認は人間のみが行う。** ユーザーが明示的に「approve」「承認」と発言するか、`/execute-plan` を指示しない限り、Claudeは `Approval Status: approved` に変更したり、実装へ着手してはならない。

- `$DOCUMENT_WORKFLOW_DIR/research.md` / `spec.md` / `plan.md` / `plan-N.md` への編集は承認前でも許可される
- `Write/Edit/MultiEdit/NotebookEdit` で spec.md / plan.md / plan-N.md を更新すると `plan-review-automation` が自動実行される
- `Write/Edit/MultiEdit/NotebookEdit/Bash` の実装系書き込みは `document-workflow-guard` が制御する
- `document-workflow-guard` は enforce モードで動作し、二層モード時は spec.md と対象 plan-N.md の両方が承認 + hash 一致 + parent-spec-hash 一致でない場合に実装をブロックする
- spec.md 不在時は単層モード（plan.md ベース）に自動 fallback する

### テスト計画 (ISO 25010 準拠)

plan.md に `## テスト計画 (ISO 25010)` セクションを設け、変更内容に関連する品質特性を明示的に選択し、各特性に対するテスト/検証方法を記載する。

**記載ルール**:

- 変更の性質に応じて、ISO 25010 の 8 品質特性から該当するものを選択する
- 各特性について副特性レベルでテスト方法と判定基準を記載する
- 対象外とした特性は理由とともに記載する（網羅的に列挙する必要はなく、検討したが除外したものを記載）
- 最低 1 つの品質特性を含めること

**品質特性の選択ガイド**（参考。変更の実態に応じて判断すること）:

| 変更の種類            | 優先的に検討すべき品質特性           |
| --------------------- | ------------------------------------ |
| 新機能追加            | 機能適合性、使用性、信頼性           |
| バグ修正              | 機能適合性（正確性）、信頼性         |
| パフォーマンス改善    | 性能効率性                           |
| リファクタリング      | 保守性、機能適合性（リグレッション） |
| インフラ/デプロイ変更 | 移植性、互換性、信頼性               |
| セキュリティ対応      | セキュリティ、信頼性                 |
| API/データモデル変更  | 互換性、機能適合性、セキュリティ     |

**テスト観点の記述品質ルール**:

- 判定基準に曖昧語を使用しない（「正しく」「適切に」「問題なく」→ 具体的な期待値・状態で記述）
- 各テスト観点は「入力/操作 → 期待される結果」の形式で検証可能にする
- 境界値・異常値が関わる場合は具体的な値を明記する

**過去知見の参照**:

- テスト観点作成時にプロジェクトの既存テストパターンを参照する
- テストで見落としが発覚した場合はテスト観点としてプロジェクトの知識ベースに記録する

### Alternative Approaches (Greenfield View) — MANDATORY 設計層セクション

`## Alternative Approaches (Greenfield View)` セクションは設計層に必ず設ける。配置先はモードによって異なる:

- **plan.md-only モード（単層）**: plan.md 内（軽量 spec の一部として、各案 1-3 行の短文版）
- **spec + plan-N モード（二層）**: spec.md 内（各案を段落で展開）

これは Claude が「既存コードへの差分最小」を出発点にする傾向（incremental bias）を構造的に抑制するためのもの。下流の `greenfield-perspective-reviewer` がこのセクションを検証する。

**必須要素**:

```
## Alternative Approaches (Greenfield View)

- **差分最小案 (Incremental)**: 既存コードに最小限の手を入れた場合の方針
- **白紙設計案 (Greenfield)**: このオーダーをゼロから設計するならどう実現するか
- **採用案と理由**: どちらを採用するか、または両者のハイブリッドか。選択理由
```

**記述品質ルール**（greenfield-perspective-reviewer の formalism checklist と対応）:

- (a) 白紙案の記述には「ゼロから設計したらこの選択になった理由」を含める。単なる結果の描写ではなく、起源 (origin) を書く
- (b) 採用案理由は具体的根拠（既存テスト・外部契約・計測コスト）に基づく。「シンプル」「安全」「リスクが低い」等の評価語のみは不可
- (c) 「白紙案 = 差分最小案」とする結論は、オーダーの本義に照らして本当に同じ形になる場合にのみ許容する。バグ修正等で正当な場合も、両案を比較した形跡を残す（「白紙でも結局同じ shape に落ちる」と書く前に、なぜそう言えるかを 1 行で説明）

**適用範囲**: 全 Document Workflow に必須。バグ修正等で本来差分最小が妥当なケースも例外なし（思考の経由を強制するため）。

### Intent Alignment Triage (Step 6, MANDATORY)

自動レビュー（step 5）完了後、ユーザーに結果を提示する前に `/intent-alignment-triage` を実行する。

**目的**: レビュアーエージェントは各専門領域で最適化するため、「元のオーダーの本義を歪めてスコープを縮小する」指摘を混入させることがある。このフェーズで全指摘を元のオーダーと突き合わせ、意図を歪める指摘を除外する。

**フロー**:

1. 自動レビューの全指摘を収集
2. `/intent-alignment-triage` を実行し、各指摘を aligned / neutral / divergent に分類
3. divergent 指摘を除外した上で Review Status を再評価
4. トリアージ結果を `<!-- intent-triage: adopted=N; excluded=M; at=ISO8601 -->` マーカーとして plan.md に追記
5. Executive Summary にトリアージ結果を含めてユーザーに提示

**禁止**: トリアージを省略して自動レビュー結果をそのままユーザーに提示すること

### Executive Summary (MANDATORY on Review Request)

`$DOCUMENT_WORKFLOW_DIR/plan.md` を完成させてユーザーに承認レビューを依頼する時点（step 4 完了後、step 5-6 の自動レビュー・トリアージが完了した段階）で、**エグゼクティブサマリー** をユーザーへの応答の冒頭に必ず提示する。目的は、ユーザーが plan.md 全文や会話ログを辿らずに、承認可否を判断するための要点を一発で把握できるようにすること。

**提示タイミング**:

- plan.md の `Plan Status: complete` にした直後
- `plan-review-automation` が完了し、`Review Status` と `<!-- auto-review: verdict=...; reviewers=... -->` が plan.md に反映された後
- `/intent-alignment-triage` が完了し、divergent 指摘の除外が反映された後
- ユーザーに `Approval Status: approved` を依頼する応答の先頭

**必須フィールド**（欠落させず、該当なしは `N/A` と明記）:

```
## Executive Summary (Review Request)

- **Goal**: <plan.md の目的を 1 行で>
- **Proposed Approach**: <採用する方針の本質を 1-3 行で>
- **Experience Delta**: <この変更で体験がどう変わるか。変更前→変更後の具体的な違いを 1-2 行で>
- **Scope**: <変更予定ファイル/モジュールを最大5件>
- **Key Decisions**: <採用した設計判断と、却下した代替案を1-2行ずつ>
- **Risks / Unknowns**: <既知リスク・未検証の前提・影響範囲の広い箇所>
- **Review Status**: verdict=<pass/fail/needs-revision> / reviewers=<agent名カンマ区切り> / hash=<auto-review の hash>
- **Open Questions**: <ユーザー判断を仰ぎたい点（なければ N/A）>
- **Next Action**: `Approval Status: approved` にしてください / 追加修正を依頼してください
```

**原則**:

- **目的整合性**: Experience Delta が Goal の達成に直結しているか自己検証する。体験変化を言語化できない変更は目的を見失っている兆候
- **判断材料に絞る**: 実装詳細の羅列ではなく、承認判断に必要な情報（方針・リスク・未解決点）を優先
- **plan.md との一貫性**: サマリー内容は plan.md から投影する。plan.md にない主張は書かない
- **事実のみ**: 自動レビューを通さずに `verdict=pass` と書かない（`code-quality.md` の Communication Accuracy 準拠）
- **簡潔性**: 各フィールド1-3行まで。詳細は plan.md 本文に委ねる
- **更新時**: plan.md を改訂して再レビューを依頼する場合は、変更点を明示した新サマリーを再提示する

## Scope Guard

タスク受付時に以下の兆候が **複数** 該当する場合、スコープ過大の疑いありと判定する:

- **広範囲キーワード**: 「すべて」「全体」「一通り」「各コンポーネント」
- **複合動詞**: 「調査して実装」「設計して構築」（探索 + 実装の混在）
- **終了条件の曖昧さ**: 「良い感じに」「きれいに」「最適化」（定量基準なし）
- **複数モジュール列挙**: 3つ以上の独立コンポーネントへの言及
- **推定ステップ数**: 10ステップ以上の見積もり
- **段階的決定の必要性**: 「Xを調べてからYを決める」

**検知時の行動**:

1. ユーザーにスコープの大きさについて簡潔に伝える
2. `/scope-guard` を実行する（提案ではなく実行）
3. 推奨戦略を提示し、ユーザー承認を得てから着手する

**例外**: ユーザーが明示的に不要と指示した場合のみスキップ可能

## Task Completion Protocol

作業停止前の必須チェック：

- 元のタスクが完全に達成されたか
- テスト・ビルドが成功しているか
- 明示的に依頼されたコミットが完了しているか

**継続すべきケース**:

- Tests/build failing → Fix and retry
- Clear next steps → Execute them
- Explicit commit request → Complete it
- Ambiguous requirements → Ask clarification

**Critical**: Never unilaterally lower user expectations or disable steering.
