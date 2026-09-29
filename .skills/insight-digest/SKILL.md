---
name: insight-digest
description: Distill ★ Insight blocks from session logs on demand (force), read the resulting digest, and decide which entries to promote into skills, ~/.claude/rules/, or CLAUDE.md. Also supports acknowledgement (ack). Use when you want to review accumulated insights now, or when a SessionStart notice points to a new digest.
context: inherit
---

# Insight Digest

`★ Insight ─` ブロックを `~/.claude/projects/**/*.jsonl` から蒸留した結果を読み解き、
スキル化 / `~/.claude/rules/` 追記 / CLAUDE.md 追記 / 廃棄 の採否を判断する知見系スキル。

蒸留は OS のスケジューラがバックグラウンドで実行する (macOS: LaunchAgent `com.berlysia.distill-insights`、Linux: systemd user timer `distill-insights.timer`)。
実行されるのは毎日 04:00 と、ログイン時・スリープ復帰時で、直近 12 時間に走っていれば skip する。
`chezmoi apply` では走らない。LLM 呼び出しを含み apply を遅くするため。
失敗や 3 日以上の停滞は SessionStart に復旧手順つきで表示される。すぐ実行したいときは `force` を使う。

`/insight-digest` を呼ぶと、引数に応じて 3 モードのいずれかで動作する。

## 引数

| 引数    | 動作                                                                                     |
| ------- | ---------------------------------------------------------------------------------------- |
| なし    | digest を Read で表示し、採否判断のフレームを併記する                                    |
| `force` | `bash ~/.claude/scripts/run-distill-insights.sh --force --llm` を実行し、digest を再生成 |
| `ack`   | digest を既読扱いにする (SessionStart 通知を止める)                                      |

## モード判別

最初の単語が以下のキーワードの場合のみ、対応するモードを使う:

- `force` → Step "Force Regenerate"
- `ack` → Step "Mark Read"

それ以外（引数なし、または別のテキスト）は表示モード。

## Mode A: 表示 (引数なし)

### Step 1: digest を読む

```
~/.claude/logs/insights/insight-digest.md
```

を Read で開く。存在しない場合は「digest が未生成。`/insight-digest force` で生成してください」と返答。

### Step 2: 採否判断ガイドを併記

digest 内の各 cluster に対し、以下のフレームでユーザーに整理して提示する:

| ラベル                     | 採否方針                                                     | 行き先                                                        |
| -------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `proposal_type: skill`     | 行為が反復されており、手順を Claude に外注できるならスキル化 | `.skills/<name>/SKILL.md` を新規作成、命名は `<verb>-<noun>`  |
| `proposal_type: claude_md` | プロジェクト固有の前提・規約・コマンド                       | `home/dot_claude/CLAUDE.md` または `home/<project>/CLAUDE.md` |
| `proposal_type: rule`      | 横断的な開発体験ルール (ワークフロー・品質・命名規約)        | `home/dot_claude/rules/*.md`                                  |
| `proposal_type: discard`   | 一回限りの気づきで再利用価値が低い                           | 採用しない                                                    |

判断補助:

1. **既存規約と重複していないか**: `~/.claude/rules/*.md` と `~/.claude/CLAUDE.md` を grep して重複チェック
2. **複数セッションで再現するか**: cluster の `count` と `distinct_sessions` を確認 (低ければ採用見送り)
3. **ユーザーの意図に沿うか**: insight が「自分が学んだこと」か「Claude が誤解していたこと」かを区別。後者は CLAUDE.md / rules への定着価値が高い

### Step 3: ユーザーへの提示

冒頭にサマリ (生成日時、新規件数、サニタイザヒット数) を 3 行で示し、上位 5-10 件のクラスタを
プロパティ表で出す。各クラスタについて「推奨採否 + 行き先 + 1 行理由」をつける。

## Mode B: Force Regenerate (`force`)

```bash
bash ~/.claude/scripts/run-distill-insights.sh --force --llm
```

を実行し、stdout/stderr をユーザーに簡潔に報告 (scanned / matched / appended / redact_hits)。
完了後、digest パスを表示し「次は `/insight-digest` で内容を確認できます」と案内。

`--llm` は Stage B (LLM 蒸留) を同時に走らせる。`--force` と併用するとゲート (7 日 / 新規 10 件) を
bypass し、`~/.claude/logs/insights/insight-llm-payload.last.json` に送信前 payload を残してから LLM を呼ぶ。

> **Stage A のみ**: LLM を呼ばずヒューリスティック集計だけ更新したい場合は `--llm` を外す。
>
> ```bash
> bash ~/.claude/scripts/run-distill-insights.sh --force
> ```

注意:

- 定期実行とロックを共有するため、`distill-insights.ts` を直接実行しない。
- 出力に `skipping` が出て exit 75 で終わった場合は、別の実行が進行中で何もしていない。少し待って再実行する。
- 失敗マーカー (`last-run-failed`) のうち `stage_b outcome=…` のものは `stage_b outcome=ok` で消え、Stage A のみの実行では消えない。それ以外の理由のマーカーは、次に正常終了した実行で消える。

## Mode C: Mark Read (`ack`)

ack ファイルを書き換えるシンプルな bun 1-liner:

```bash
bun -e 'import("/home/'"$USER"'/.claude/hooks/lib/insight-digest.ts").then(m => m.writeAckMs())'
```

または直接:

```bash
date +%s%3N > ~/.claude/.last-insight-digest-acked
```

実行後「digest を既読化しました。次の更新までは SessionStart 通知が出ません」と返答。

## 採否手順 (Mode A の延長)

ユーザーが特定のクラスタについて「これは skill 化したい」「これは rules に書きたい」と判断した場合:

1. 該当 insight の本文 (digest 内 preview から `~/.claude/logs/insights/insights.jsonl` の hash で逆引き)
2. 採用先のドラフトを作成 (skill なら SKILL.md 雛形、rule なら追記候補マークダウン)
3. ユーザー確認の上で chezmoi source state に反映 (`.skills/<name>/SKILL.md` または `home/dot_claude/rules/*.md`)
4. `chezmoi apply` で展開
5. 必要に応じて該当 insight を deny list (`~/.claude/insight-distill-deny.txt`) に `text:` パターンで登録し、
   将来の digest で再提案されないようにする

## 設計判断

- **context: inherit**: 会話履歴の文脈 (採否判断の前提・既存規約) を活かすため
- **3 モード以外を入れない**: scope-justification レビューで `topic <keyword>` モードは YAGNI 判定。
  必要になったら `~/.claude/logs/insights/insights.jsonl` を `jq` で grep すれば足りる
- **採否は Claude が決めない**: スキル化や rule 追記は人間の判断。Claude は推奨と理由を提示するに留める

## 関連ファイル

- `~/.claude/logs/insights/insight-digest.md` — 最新の digest
- `~/.claude/logs/insights/insights.jsonl` — 累積した insight レコード (重複排除済み)
- `~/.claude/logs/insights/state.json` — 件数集計
- `~/.claude/insight-distill-deny.txt` — 走査除外パターン
- `~/.claude/insight-distill-redact.txt` — 追加サニタイザパターン
- `~/.claude/scripts/distill-insights.ts` — 蒸留本体
- `~/.claude/scripts/run-distill-insights.sh` — スケジューラと force の共通入口
- `~/.claude/logs/insights/distill-run.log` — 実行ログ (2000 行で切り詰め)
- `~/.claude/logs/insights/last-run-failed` — 失敗マーカー
- `~/.claude/hooks/lib/insight-digest.ts` — sanitize / normalize / ack 関数
