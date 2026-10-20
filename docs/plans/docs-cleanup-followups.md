# docs 整理の持ち越し

docs の整理（ADR・README・docs/plans の棚卸し）で、範囲の外に回したもの。片付いた項目は消し、空になったらこのファイルを消す。

## ADR が指したままのファイル

整理で消した `docs/plans/` のファイル。ADR が名前で指しているので、ADR 側の参照を直すまでは名前を残す（ADR の参照を直したら、この節の該当行を消す）。

- `docs/plans/merge-commit-only-followups.md`: 確認が済んだため消した（Renovate の auto-merge が merge commit で入ることを、#337・#322・#321 で確認した）。決定は ADR-0031 にある。ADR-0029・ADR-0031 が名前で指している。

## 存在しない skill を許可する設定

`home/dot_claude/.settings.permissions.json` の `Skill(commit-conventions)` は、`.skills/` にも配備先にも無い skill を指している。設定なので文書の整理では触っていない。許可を消すか、skill を作り直すかを決める。片付いたことは `git ls-files .skills | grep commit-conventions` と設定の両方で確かめる。

## 文書に書かれたパスの存在検査を、テストにする

ADR の掃除の前に、文書に書いたリポジトリ相対パスが実在することをテストで確かめる。ADR 以外の文書は今この検査を満たしている。ADR は違反を例外一覧に載せて始め、ADR を直すたびに一覧から外す。規則:

- 対象の文書: 追跡中の `*README*.md`、root の `CONTEXT.md`、`docs/` 配下の `.md` から ADR と `docs/plans/` を除いたもの。ADR は例外一覧つきで対象にする
- 拾うもの: コードフェンスの外のバッククォート内のトークンのうち、`docs/`、`home/`、`.skills/`、`mods/`、`scripts/`、`tests/` で始まり、`* ? < > { } …` と空白を含まないもの。`#` と `:` 以降は落とす
- 照合: `git ls-files` の集合に、repo root 基準か、書かれた文書自身のディレクトリ基準で、ファイルとしてあるか、末尾 `/` または前方一致でディレクトリとしてあれば満たす
