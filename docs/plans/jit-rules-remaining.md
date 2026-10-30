# 常時読み込む指示を減らす作業の残り（plan-2 から plan-4）

毎セッション読み込む指示（CLAUDE.md 2 本と rules 9 本）のうち、場面でしか使わない規則を skill へ移し、場面が来たときに読ませる作業の続きである。plan-1 で、移す先の skill と、読ませる hook（skill-guide-gate と skill-guide-after）を作った。仕組みと受け入れた限界は ADR-0061 にある。rules と CLAUDE.md の文は、まだ消していない。

設計の文書（spec.md、plan-1.md、research.md）は、作業した worktree の `.tmp/sessions/5fa3f827/` にある。この置き場は 7 日で GC される。それより後に続けるときは、ADR-0061 とこのファイルから組み立て直す。

## plan-2: rules と CLAUDE.md から移した文を消す

- 1 つの規則を 1 か所にだけ書く。skill へ移した文を rules と CLAUDE.md から消す
- 安全の床は消さない。床の一覧は ADR-0061 の K3 にある。消す前に、床の表を実物の文と照らし直す
- rule を指している skill の参照を書き直す。rule のパスを指す参照が残っていないことを grep のテストで確かめる
- workflow の文書に `paths:` を付け、document-workflow-operator skill を読ませる

## plan-3: resume-incomplete-work とターン終端規則を外す

- `resume-incomplete-work` の hook の登録と、workflow.md のターン終端規則の文を、同じ plan で同時に外す。2 つは、宣言だけしてターンを閉じる同じ振る舞いへの補正である
- ADR を書き、ADR-0015 §6 を覆す。削る根拠は NOISE である。調べた範囲では、hook の発火の 8 割前後が誤検出だった。調べた 30 日の間に正規表現が改訂されたこと、次のターンで動いたかは確かめていないことも、根拠の限界として ADR に書く
- hook の本体とテストは、観察して判断するまで残す

## plan-4: 計測と記録

- メインと subagent の起動時のトークンを測る。典型作業 2 本（commit と PR まで進む小さな修正、Document Workflow の plan を 1 本書く作業）で、総入力とキャッシュ書き込みを測る。skill の description の合計がどれだけ増えたかも測る。plan-1 の変更前の計測と比べる
- skill-guide-gate が出した deny を、`~/.claude/state/skill-guide/` の `decisions.jsonl` と押し出した先から数える。作業 1 本あたりで、メインと subagent に分けて数える。transcript の走査は、log に無い分にだけ使う
- 上限 2 回と、止める操作の一覧を決め直す（完了条件に入れる）
- ADR-0061 が実装と合っているかを確かめる
- 文字列で検出できる Never の項目を deny する hook を、残件としてこのディレクトリに書く
- 決定と却下した案を ADR か commit の本文へ移し、このファイルを消す

## このファイルを消す条件

plan-4 を終え、記録を移したら消す。
