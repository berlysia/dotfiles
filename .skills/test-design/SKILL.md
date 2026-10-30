---
name: test-design
description: "Design test viewpoints and test cases from code changes using ISO 25010. Use when writing test plans for plan.md, reviewing PR test coverage, or when asked to 'テスト設計', 'テスト観点洗い出し', 'design test cases'. Do NOT use for writing test code or TDD workflows (use /bugfix)."
context: inherit
---

# Test Design

変更内容からテスト観点を洗い出し、検証可能なテストケースに展開する。

## スコープ

- 読み取り専用の分析スキル。ファイルの作成・変更・削除は行わない
- 対象はカレントリポジトリ内のファイルのみ

## このスキルがやらないこと

- テストコードの実装（開発者の責務）
- TDD ワークフロー（/bugfix の責務）
- 既存テストコードの品質レビュー

## 入力の取得

1. **引数あり** → そのまま使用（ファイルパス、変更概要、PR番号など）
2. **引数なし** → `git diff HEAD` で変更差分を取得
3. **Document Workflow 内** → `<wfDir>/plan.md` のテスト計画セクションがあれば参照（オプション）

## Phase 1: テスト観点の洗い出し

1. 変更内容を分析し、影響を受ける機能・データフロー・境界を特定する
2. `/document-workflow-reference` の「ISO 25010 特性選択ガイド」を参照し、変更の種類に応じた品質特性を選択する
3. 各品質特性について副特性レベルで具体的なテスト観点を列挙する

**観点の粒度**: 「この入力でこの結果が期待される」と言い換えられるレベルまで具体化する。「正しく動作する」のような抽象的な観点は禁止。

## Phase 2: テストケースの展開

各テスト観点について具体的なテストケースを設計し、以下の形式で出力する:

| 品質特性 | 副特性 | テスト/検証方法 | 判定基準 |
| -------- | ------ | --------------- | -------- |

次の記述品質ルールを適用する:

- **曖昧語禁止**: 判定基準に「正しく」「適切に」「問題なく」を使用しない。具体的な期待値・状態で記述する
- **検証可能な形式**: 各テストケースは「入力/操作 → 期待される結果」の形式にする
- **境界値の明記**: 境界値・異常値が関わる場合は具体的な値を明記する
- **通信失敗と終了**: 存在しないポートは OS や firewall 次第で待ち時間が変わるため、503 などを返す制御下のサーバーで再現する。Promise の完了と、abort 後のソケット・keep-alive 接続の解放、プロセス終了を別々の判定基準にする
- **再試行と非同期例外**: 429 は `Retry-After` に従う待機と同じ batch ID の重複除外を確認する。イベントハンドラ内の例外でも Promise が未解決にならないこと、応答途中の再試行で同じツールを二重実行しないことをケースに含める。外側の `try/catch` やリクエストの完了だけでは保証できない経路を確かめるため
- **経過時間の判定**: unit テストで `performance.now()` の差による経過時間の検査を書かない。実行環境で待ち時間が変わるため、この形は test-layout.test.ts が止める。期限を短く注入し、reason が timeout になることと、子プロセスも孫プロセスも残らないことだけを確かめる

## 検証手順の具体化

Phase 2 で該当するケースには、次の準備と観測方法を含める。ここでは検証を実行せず、開発者が実行できる手順として記述する。

### 期待値と実行環境

1. 比較対象の SHA を着手前に確定し、同じ入力を基準実装と変更後の実装に渡す。途中のコミットで動く `HEAD` を基準にすると、変更後どうしの比較になるため。展開結果の比較では、ハッシュで固定した同じ archive から期待値を導き、両辺から同時に消えてはいけない必須ファイルも別に確認する。
2. 守る条件だけを外した入力や実装で、失敗する assertion と失敗理由を指定する。別の条件や後段の上書きが失敗を隠さないようにし、否定の照合前には入力の読み込み成功を確認する。短い部分文字列で別のログにも一致する場合は、行や出力全体を比較する。手順の評価では本文の例と異なる題材を使い、評価者へ答えや仕込みの記録を渡さない。
3. 環境を引数で渡せない処理は子プロセスに分離し、`env -i` から必要な変数だけを渡す。HOME と XDG の config、data、state、cache を隔離先に指定し、PATH はスタブと必要な実コマンドだけにする。shim 経由でも対象コマンドが見つからないことを確認し、テンプレート展開後の埋め込み先と実行時の保存先を番兵ファイルで確かめてから操作する。一部だけの差し替えでは実環境へ書き込む経路が残るため。
4. preload の設定が子プロセスでも有効かを確認し、Worker では再実行時に親の引数が無くても動くケースを含める。stdin が処理を継続させる入口は、本物のパイプから入力して終了まで観測する。偽の stream や長寿命のテストプロセスでは、本番とイベントループの寿命が異なるため。

### 時刻と数値の境界

1. 言語間で同じ日時を判定する処理には、判定が割れる境界値を渡し、ロケールも変えて比較する。文字列の照合順序と数値への変換は別の規則なので、通常値での一致だけでは同値性を示せない。
2. 固定日時を使うケースでは比較する時計も固定し、実時計を使うケースと分ける。UTC とローカルで日付が異なる時刻を含め、タイムゾーンのずれは符号も確認する。WSL のプロセス時刻と journal を照合するときは、同じ時計から得た時刻で前後関係を判定する。ブートからの経過時間と実時刻は、スリープ後にずれることがあるため。
3. timer の発火時刻は判定式から求め、閾値の直前、等値、直後をケースにする。`now - sampledAt > T` をミリ秒単位で判定するなら、`sampledAt + T + 1ms` で状態が変わることを確認する。小数のミリ秒も偽時計から返し、整数を要求する API へ渡す値を確かめる。整数だけの偽時計では変換漏れを検出できないため。

### 削除と検査省略の検証

1. 性能調査で不要と判明した機能を削除する場合は、対応する union の値を外した状態で型検査を実行する手順を含める。残った参照を型エラーとして検出でき、不要になった fixture も削除対象として特定できるため。
2. 検査を省略する変更では、同じ入力に対してフラグと実行条件を変え、省略前後の判定を比較する。たとえば `judge(form, physical=false)` と `judge(form, physical=true)` は、同じ入力でも結果が異なりうる。この差を省略条件が扱えるか確かめる。

### 通知と子プロセスの終了

1. 通知の代役には起動時に印のファイルを書くプロセスを使い、呼び出し直後に親が終了する条件で印を確認する。後続の後始末が偶然与える待ち時間を除き、親と子が読み込む設定と hook を確認して、親子を二重に計数していないか照合する。
2. stdout を開いたまま残る子孫、stdout を閉じても生存する子孫、TERM を無視する子、親の強制終了で孤児になる子を別々に再現する。親の `exit`、パイプの `close`、プロセス群の消滅を各々観測し、待機の上限を判定基準に書く。パイプの閉鎖はプロセス群の終了を意味しないため。
3. 実際の hook から起動し、hook の終了後とセッションの終了後に遅延した印が作られるか確認する。単体スクリプトの `detached` の挙動だけでは、呼び出す製品が子孫を終了させるかは分からないため。

### 失敗の抽出と報告

- 並列検証の実行数と個別の完了をハーネスの UI で確認する場合は、各ジョブを個別に起動する。単一シェル内の `&` では、外側の処理しか表示されないことがある。
- ジョブの完了数は各ジョブが残す完了マーカーで数える。`pgrep` は子シェルや起動用プロセスも数えるため、完了数の根拠にはしない。

1. 基準 SHA と変更後を同じ条件で実行し、失敗の件数だけでなく内容と変更箇所との関係を比較する。`&&` で止まった後続の検査は個別実行し、成功、失敗、未実行を分けて記録する。同じ件数でも別の退行が含まれる可能性があるため。
2. ランナー固有の失敗見出しが stdout だけにあるケースと stderr だけにあるケースを作り、それぞれから本文を抽出できるか確認する。目印が無いケースでは抽出不能を明示し、末尾の出力を残す。多重実行の出力では末尾に終了コードしか残らないことがあるため、元の出力も保持する。
3. 初期化失敗、timeout、出力上限の各ケースで、失敗理由と打ち切りの種類が診断に残ることを確認する。空の抽出結果や `ENOENT` だけでは、どの段階で何が失敗したか追跡できないため。

## 出力

- テスト観点リスト（Phase 1 の結果）
- テストケーステーブル（Phase 2 の結果、plan.md のテスト計画セクションにそのまま貼り付け可能な形式）

## Testing Standards

- Follow t-wada's TDD style (strict Red-Green-Refactor)
- Grep existing tests for similar patterns before writing new ones
- Code started through an entrypoint (hooks, CLIs) has at least one test that launches it as a process, so the entrypoint wiring is exercised; unit tests of the exported functions pass even when the entrypoint never runs
- Tests must pass before commits
- Break the guarded condition and confirm the intended assertion fails; passing alone proves little.

### Time Budget

Always measure wall-clock time when writing or changing tests, and report the measured time. Each scope has three lines:

- **Ideal**: the direction to aim for. Not a pass/fail line
- **Target**: what a run keeps to in normal work
- **Cap**: must not be exceeded. A change must not push a scope over its cap; an excess that already exists is reported and fixed as its own task

| Scope                                                      | Ideal | Target | Cap   |
| ---------------------------------------------------------- | ----- | ------ | ----- |
| Unit tests (full run)                                      | ~5 s  | 10 s   | 1 min |
| Performance tests, or tests using heavy resources (DB, FS) | —     | 1 min  | 2 min |
| Tests run by the pre-commit hook                           | ~1 s  | 3 s    | 10 s  |
| Tests run by the pre-push hook                             | ~5 s  | 15 s   | 30 s  |

A suite's wall-clock time is set mostly by its slowest file, because runners such as `node --test` run files in parallel and the tests inside a file one after another. So unit tests also have per-item caps, which point at the test to fix:

- One unit test: 100 ms (1 s when it launches a process)
- One unit test file run alone: 3 s

How to measure and record:

- The local machine is the gate, since slow local tests block local work. Run the suite 3 times with no other heavy work running, and record the median and the maximum
- Also record the CI time when CI runs the suite, so the two can be compared. CI time does not replace the local measurement
- A test that cannot fit the unit caps belongs in the heavy tier, not in the unit suite
- When a scope exceeds its target or a cap, report it with the measured times and propose how to bring it back (run fewer tests at that stage, split long files so they run in parallel, call functions instead of launching processes, replace real waits with fake clocks or shorter injected timeouts, move to a heavier tier or CI). Do not raise the lines on your own

## 届く経路

既存の description がテスト計画や PR のテスト範囲を扱う場面を案内する。
