# docs 整理の持ち越し

docs の整理（ADR・README・docs/plans の棚卸し）で、範囲の外に回したもの。片付いた項目は消し、空になったらこのファイルを消す。

## ADR が指したままのファイル

整理で消した `docs/plans/` のファイル。ADR が名前で指しているので、ADR 側の参照を直すまでは名前を残す（ADR の参照を直したら、この節の該当行を消す）。

- `docs/plans/merge-commit-only-followups.md`: 確認が済んだため消した（Renovate の auto-merge が merge commit で入ることを、#337・#322・#321 で確認した）。決定は ADR-0031 にある。ADR-0029・ADR-0031 が名前で指している。

## 存在しない skill を許可する設定

`home/dot_claude/.settings.permissions.json` の `Skill(commit-conventions)` は、`.skills/` にも配備先にも無い skill を指している。設定なので文書の整理では触っていない。許可を消すか、skill を作り直すかを決める。片付いたことは `git ls-files .skills | grep commit-conventions` と設定の両方で確かめる。

## ADR の番号の重複

`docs/decisions/` に 0018 と 0032 が 2 本ずつある。番号を振り直すと、コード、テスト、他の ADR の参照を全件付け替えることになるので、ADR の整理とは分けた。今はファイル名で区別できる。

## adr-session skill のテンプレート

`.skills/adr-session/references/` のテンプレートとスキーマは、日本語の見出しと frontmatter を前提にしていて、このリポジトリの ADR（英語の 7 つの見出し、frontmatter なし）と形が違う。skill は他のプロジェクトにも配られるので、ADR の整理では揃えなかった。揃えるなら、他のプロジェクトでの使われ方を確かめてからにする。
