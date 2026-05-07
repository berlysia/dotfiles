# Followup: 常時必須レビュアーリストの Single Source of Truth 化

ADR-0004 で顕在化した「常時必須リストが 3 箇所に分散している」問題に対して、
SSoT (Single Source of Truth) 化を設計するセッション。設計判断を伴うため
Document Workflow 必須。

## 起動プロンプト（次セッション用、コピペ可）

```
ADR-0004 の Consequences で「常時必須リストが workflow.md / external-review.md /
plan-review-automation.ts の 3 箇所に分散している」と指摘した問題を解決したい。
次にレビュアーを追加するときに drift する懸念がある。

このセッションのゴール:
- 3 箇所の現状の責務（何をどう書いているか）を整理する
- SSoT の候補（hook / config file / doc）の trade-off を比較する
- どの方向で依存させるか（hook → doc 生成 / config → 両方読み込み /
  doc → hook がテストで parse）を決める
- Document Workflow を回して plan.md → 自動レビュー → 承認 → 実装

参照:
- @docs/decisions/0004-greenfield-perspective-reviewer.md (Consequences 節)
- @docs/plans/always-on-reviewers-ssot.md
- 現状の 3 箇所:
  - @home/dot_claude/rules/workflow.md
  - @home/dot_claude/rules/external-review.md
  - @home/dot_claude/hooks/implementations/plan-review-automation.ts

注意:
- これは設計判断を伴う変更なので Document Workflow 必須
- 既存 ADR-0001 / ADR-0003 / ADR-0004 の文言とも整合させる必要あり
- 過剰な抽象化を避ける（個人 dotfiles なので軽量な方法で十分）
```

## 背景

現状、常時必須レビュアー 4 名のリストは以下 3 箇所に分散:

1. `home/dot_claude/rules/workflow.md` — Step 5 の説明文に列挙
2. `home/dot_claude/rules/external-review.md` — 「Plan Mode Self-Review Procedure」の常時必須レビュアー責務マップ
3. `home/dot_claude/hooks/implementations/plan-review-automation.ts` — `alwaysOnLines` 配列と `allReviewerNames` 配列

ADR-0004 で 4 名に拡張する際、これら 3 箇所すべてを手動で更新した。次回（5
名以上にする場合 or 既存レビュアーを差し替える場合）も同じ手作業が要る。

## 判断軸

- **drift 抑制**: 1 箇所だけ更新すれば他が追随することを担保
- **可読性**: doc / code どちらが SSoT になっても、ユーザーが「どこを見ればいいか」が明確
- **テスト容易性**: SSoT が code か config か doc かで testability が変わる
- **個人 dotfiles の軽さ**: 過剰な generation pipeline を作らない

## SSoT の候補

### Option A: hook を SSoT にする

- hook 側に `ALWAYS_ON_REVIEWERS` 配列を export し、doc 生成スクリプトで
  workflow.md / external-review.md の該当箇所を生成する
- メリット: テスト可能性が高い、コードが正解
- デメリット: doc 生成スクリプトが必要。chezmoi apply 時の生成 step が増える

### Option B: config file (YAML/JSON) を SSoT にする

- `home/dot_claude/config/reviewers.yaml` のような config を作り、hook も
  doc 生成も両方読む
- メリット: 言語非依存、可読性が高い
- デメリット: 新ファイル追加、parsing コードが必要

### Option C: doc を SSoT にして、hook がテストで parse 検証

- workflow.md or external-review.md の特定セクションを SSoT とし、hook の
  テストがそのセクションを parse して `alwaysOnLines` と一致を検証
- メリット: 既存 doc を活用、新ファイル不要
- デメリット: doc parsing が脆弱、doc フォーマット変更で壊れる

### Option D: 重複を放置して checklist で運用カバー

- 「レビュアー追加時に 3 箇所を更新する」checklist を ADR or CONTRIBUTING
  に書く
- メリット: 実装ゼロ
- デメリット: drift リスクは残る。本問題を解決していない

## 想定される approach（推奨は B、ただしセッション内で再評価）

config file を SSoT とし、hook と doc 生成スクリプトの両方が読む構造が、
個人 dotfiles の軽さと drift 抑制のバランスが良い。doc 生成スクリプトは
chezmoi apply 時に走らせる既存の `run_onchange_*` スクリプトに足す形で
追加コストを抑える。

ただし「doc に説明文として書きたい責務マップ」は config に書きづらい
（自由形式の文章を含むため）。Option B でも doc 側に「自動生成セクション」と
「人間が書く説明文セクション」を分ける必要がある。これは Document Workflow
内で詳細設計する。

## 期待される成果物

- ADR-0005 (or ADR-0004 追記)
- 実装（config file or generation script）
- 3 箇所の手動同期からの解放
- テスト（drift が起きないことを担保）

## 参照

- ADR: `docs/decisions/0004-greenfield-perspective-reviewer.md` (Consequences 節)
- 現状 3 箇所:
  - `home/dot_claude/rules/workflow.md`
  - `home/dot_claude/rules/external-review.md`
  - `home/dot_claude/hooks/implementations/plan-review-automation.ts`
