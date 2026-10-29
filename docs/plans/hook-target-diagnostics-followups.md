# hook 参照検出の後続課題

hook が参照するスクリプトの欠落・乖離を検出する仕組み（ソース内のリンク切れの CI 検出は `hook-target-drift.test.ts` が担う）の、未着手の課題。

## SessionStart の出力経路の保証を保つ再検証

`session.ts` のユーザー向け通知は、hook 出力 JSON のトップレベル `systemMessage` で返す。`systemMessage` は UI に表示され、モデル入力には注入されない。この保証は Claude Code の binary 実測に依拠しており、リポジトリ内のどのテストもこの事実を保持しない。変換テーブルが将来変われば digest 本文がモデル入力に流入し始めるが、テストは全緑のままになる。

再検証トリガーは Claude Code のアップグレード。手順（バージョン間で byte offset は変わるため offset に依存しない形で書く）:

1. 起動中の実体を特定する（`~/.local/share/claude/versions/<version>`）。
2. `grep -abo 'hook_system_message' <binary>` で全出現の byte offset を列挙する（複数ヒットするため、これ単独では変換テーブルのエントリを一意に特定できない）。
3. 各 offset の周辺を切り出し、`grep -o 'hook_[a-z_]*:('` と `grep -o 'case"hook_[a-z_]*"'` で attachment type キーを列挙する。両者が複数キーを返す領域が変換テーブル本体。
4. その領域内で `hook_system_message` に対応する値が `()=>[]` のままであることを確認する。
5. type guard（`hook_` 接頭辞を `||` で列挙している箇所）と突き合わせ、新しい attachment type が増えていないことを確認する。

## digest の表示経路でサニタイズが再適用されない

## 層 3（SessionStart 自己診断）の未解決事項

「他リポジトリの settings が参照する実在しないスクリプトをセッション開始時に報告する」機構は未実装（`session.ts` は `auditGuardWiring` / `auditAnswerRecorderWiring` のみ）。着手時に決める必要がある点:

- 非ブロッキング hook エラーの stderr が Claude Code の UI に何行表示されるか（1 行目のみの可能性がある）。壊れた hook を一時登録した実測が必要
- 診断の反復抑止。`SessionStart` は `["startup", "resume", "clear", "compact", "fork"]` の 5 source で発火する（`cc-hooks-ts` の型定義）ため「セッション開始時に 1 回だけ」は成立しない
- サニタイズの順序と対象集合。bidi (`U+202A-202E`, `U+2066-2069`) と zero-width (`U+200B-200F`, `U+FEFF`) は C0/C1 除去では落ちない
- 時間予算がブロッキング `stat()` を中断できない問題（WSL2 の `/mnt/` 配下 DrvFs、autofs、CIFS）
- `lib/` への settings 読み込み共通化。`getSettingsFiles` が `auto-approve.ts` と `file-access-guard.ts` に別実装で並び、後者は local の settings を読まない

### 診断文言についての制約

hook の stderr は transcript に `type: "attachment"` / `attachment.type: "hook_non_blocking_error"` として永続化され、`stderr` に加えて `command` の生文字列・`exitCode`・`hookName` も記録される。したがって「stderr に出せば Claude のコンテキストへの経路が原理的に閉じる」は成立しない。

また診断は「存在しません」と断定してはならない。起点となった実例（`workspace/my-secretary` の `bash .claude/hooks/lint-on-stop.sh`、exit 127）は**スクリプトが実在しており**、cwd が `.tmp/sessions/<id>` だったため相対パスが解決できなかったものだった。「cwd 基準で解決できません」と書く必要がある。
