---
name: mod-development
description: このリポジトリの Claude Code Mod を開発、配備、診断するときに、実機で API・描画・記録を検証する。組み込み plugin-authoring を補う。一般的な plugin 構成の説明や通常の settings hooks 開発だけには使わない。
---

# Mod の実機検証

## 読み込みと連携を確かめる

1. 基本仕様は組み込み `plugin-authoring` を参照し、実行中の CLI と参照文書のバージョンを照合する。API はリリース間で変わるため、設計を左右する表示色・store 読み込み速度などを最小の probe で先に測る。
2. 表示がない場合は `/plugin`、`claude --debug` の rollout 関連行、hook の失敗、正常な非表示を分ける。組み込み Mod が動いてもユーザー Mod の rollout が有効とは限らず、共有設定の保存値だけでは実行状態を判定できない。
3. 開発用 symlink と配備先から同じ Mod を読み込んでいないか確認する。同名で重複が除かれるとは未確認なので片方だけで試す。merge と配置は別であり、apply 時の同期先と起動時の読込先を照合する。
4. Mod の sandbox には Node・DOM がない。既存 hook のロジックは直接 import せず `$.process.run` で CLI を呼ぶ。project dir と session ID は明示し、利用者指定の workflow dir は保持する。判定を複製せず CLI 出力を読む。未知の行は読み飛ばしても、実行失敗と正常な非表示は区別する。

## イベントの順序を検証する

- 送信時刻は `next(e)` の前に取得する。人の入力は `e.origin.kind`、親の完了は `e.agentId` で区別する。`prompt.submit` にはエンジン由来の入力、`turn.complete` にはサブエージェントの完了も届く。
- PreToolUse の時点では今回の委譲モデルは決定済みで、変更が効くのは次回の委譲からになる。非同期 Agent の `next(e)` は起動受付で完了し、子の終了を待たない。追加 context と画面表示をそれぞれ実機で確認する。
- 例外処理だけでなく待ち時間にも上限を設ける。`next(e)` 後に待ち続けると結果を返せない。`setTimeout` がない Mod では `$.clock.after` と `Promise.race` を組み合わせる。
- イベントが来ない時間の表示更新は timer、観測の欠落を区別する記録は heartbeat で検証する。`session.start` より先に measure が届いた実測があるため、必要な状態を同期的に初期化する。store のプロセス間共有と読み込み時間は実機で測る。

## 描画と記録を分けて検証する

- 控えめな常時表示は `PromptHint.tail` の文字列連結や `SessionMode.modes` への追加を試す。`$.ui.status` の色はエンジンが決める。`AbovePrompt`・`Pane` を複数の Mod で使う場合は `next(e)` の連鎖と置換を確認する。描画を自動合成する仕組みはない。
- `ui.render`、`session.append`、モデルへの context は別に検査する。transcript の見た目を変えてもモデルの文脈は変わらない。保存行の `uuid` と描画の `requestId` は実際に照合してから利用する。行ごとの状態は `StateFamily` で分けると全行の再描画を避けられる。
- ハーネスでは状態変更後に `ui.drawn()` を呼んで表示を確認する。CLI 出力を使うプレビューはパーサも検査できるが、実画面の折り返しと余白は別に確認する。`ui.notify` と OS 通知も別なので、Notification hook への連携を試す。
- `$` を渡す helper はトップレベルか Mod 内の import 先に置き、validate で静的解析できるようにする。型定義は import なしで自己完結させる。ハーネスの `$` に plugin 用 store・clock がない場合は、外へ出る副作用で記録結果を確認する。
