# ほかのマシンで、tanteki を apm の管理から外す

tanteki は `.skills/tanteki/` に取り込んで自分で持つ形にしてある（`docs/decisions/0036-japanese-writing-skills-roles-and-entries.md`）。apm で入れたままのマシンでは、次の `chezmoi apply` の前に手で移す必要がある。

同期の警告に出る `recover:` の 1 行だけでは足りない。apm が追跡していない `node_modules` が残っていると、`apm uninstall` が止まるためである。

## 手順

削除を含むので、利用者が自分の端末で 1 段ずつ行う。コマンドの例の `~` は、そのマシンのホームの絶対パス（例: `/home/<ユーザー名>`）に置き換えて書く。変数、glob、末尾の `/` は使わない。

1. 消す対象を確かめる。対象は `~/.claude/skills/tanteki/node_modules` だけである。`~/.config/textlint/node_modules` は tanteki の依存の本体なので、取り違えて消さない。

   ```sh
   ls -ld /home/<ユーザー名>/.claude/skills/tanteki/node_modules
   ```

   出力の先頭の文字で次を選ぶ。
   - `l`（symlink）: 新しい形の配備が済んでいる。消さずに、手順 3 へ進む
   - `d`（実ディレクトリ）: apm が入れた古い依存である。手順 2 で消す
   - どちらでもない、または「No such file or directory」: 手順 3 へ進む。ほかの表示なら止めて、状態を確かめる

2. 手順 1 で `d` だったときだけ、実ディレクトリを消す。

   ```sh
   rm -r /home/<ユーザー名>/.claude/skills/tanteki/node_modules
   ```

3. apm の宣言から tanteki を外す。

   ```sh
   apm uninstall -g iwasa-kosui/tanteki/skills/tanteki
   ```

4. uninstall が `~/.apm/apm.yml` のコメント行を崩すので、chezmoi の版で上書きする。

   ```sh
   chezmoi apply --force /home/<ユーザー名>/.apm/apm.yml
   ```

5. 引数なしの `chezmoi apply` を流す。`.skills/tanteki/` が配備され、`node_modules` は `~/.config/textlint/node_modules` を指す symlink になる。

## このファイルを消す条件

使っているマシンのすべてで、上の手順を終えたとき。
