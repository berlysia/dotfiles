# docs 整理の持ち越し

docs の整理（ADR・README・docs/plans の棚卸し）で、範囲の外に回したもの。片付いた項目は消し、空になったらこのファイルを消す。

## ADR が指したままのファイル

整理で消した `docs/plans/` のファイル。ADR が名前で指しているので、ADR 側の参照を直すまでは名前を残す（ADR の参照を直したら、この節の該当行を消す）。

- `docs/plans/merge-commit-only-followups.md`: 確認が済んだため消した（Renovate の auto-merge が merge commit で入ることを、#337・#322・#321 で確認した）。決定は ADR-0031 にある。ADR-0029・ADR-0031 が名前で指している。

## 存在しない skill を許可する設定

`home/dot_claude/.settings.permissions.json` の `Skill(commit-conventions)` は、`.skills/` にも配備先にも無い skill を指している。設定なので文書の整理では触っていない。許可を消すか、skill を作り直すかを決める。片付いたことは `git ls-files .skills | grep commit-conventions` と設定の両方で確かめる。
