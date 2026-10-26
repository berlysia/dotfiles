# apm.lock.yaml を repo で追跡する（見送り中）

外部スキルの lock（`~/.apm/apm.lock.yaml`）を git で追跡し、どのマシンでも同じ commit のスキルが入るようにしたい。2026-10-27 に 4 つの形を試したが、どれも採らずに見送った。再開するときは、ここに書いた事実から始める。

## 何が問題か

npm の `package-lock.json` は 1 つしかなく、npm がその場で読み書きし、人が commit する。apm の lock を chezmoi で扱うと、lock が 2 か所に分かれる。

- repo の中の lock は、chezmoi が `~/.apm` へ一方向にコピーする
- `~/.apm` の lock は、`apm install -g` や `apm update -g` が書き換える

apm が書き換えた内容は、人が手でコピーしない限り repo へ戻らない。戻す前に `chezmoi apply` すると、どちらかの lock の内容が消えるか、apply が止まる。

## 確かめた事実

いずれも 2026-10-27 に、apm 0.35.0 と chezmoi 2.73.3 で確かめた。

- 変更の無い `apm install -g` は lock を 1 バイトも書き換えない。lock があるディレクトリへ一から install しても、lock は変わらない。
- chezmoi は、自分が書いたファイルが後から書き換えられていると、上書きするか聞く。TTY が無いと exit 1 で止まる。このとき、ほかのファイルも run_after の script も実行されず、apply 全体が止まる。
- `modify_` の template で、今のファイルを無視して repo の内容を出すようにすると、書き換えられていても exit 0 で repo の内容に戻り、ほかのファイルの更新も続く。
- `run_before_` の script は、chezmoi がファイルを更新する前に実行される。`modify_` が戻す前の lock を読める。
- lock をファイル単位の symlink にしても、apm は一時ファイルを rename して書くので、symlink が普通のファイルに置き換わる。ディレクトリ単位の symlink の中なら、lock はその場で更新される。
- apm は user scope の置き場所を `Path.home() / ".apm"` に固定しており、変える設定は無い。スキルの配置先は `Path.home()` から決まる（upstream の `src/apm_cli/core/scope.py`）。
- chezmoi は、中身のある実ディレクトリを `symlink_` の項目に置き換えるとき、中身を消す。TTY が無くても exit 0 で進む。
- oxfmt は lock を書き換える（`.oxfmtignore` に入っていない）。
- lock には秘密もホームのパスも含まれない。gitleaks でも検出は無い。

## 試した形と、採らなかった理由

| 形                                             | 採らなかった理由                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 通常のファイルとして chezmoi で配布する        | apm が書き換えた後の apply が、TTY の無い環境で全体ごと止まる                                         |
| `modify_` で毎回 repo の内容に戻す             | ずれを知らせる警告 2 種と、apply の外での変更を見つける run_before が要る。仕組みが多すぎると判断した |
| lock をファイル単位の symlink にする           | apm が書き込むと、symlink が普通のファイルに置き換わる                                                |
| `~/.apm` を repo の `apm/` への symlink にする | 下の 4 つの危険が増える                                                                               |

`~/.apm` を symlink にした形で増える危険は、次の 4 つである。

- メインの作業ツリーで branch を切り替えると、apply しなくても `~/.apm` の中身が変わる。次の install はその branch の lock で入れ直す。
- symlink の先が無くなると lock が読めなくなる。すると `run_after_sync-skills` の除外が空になり、`rsync --delete` が apm のスキルを全部消す。
- `apm_modules/` の中にある、取得したパッケージの `CLAUDE.md` や `AGENTS.md` が repo の作業ツリーに入る。この repo で作業する Claude のセッションが、それを指示として読みうる。
- 移行のとき、chezmoi が今の `~/.apm`（`deployment-receipts/` などを含む）を消す。コピーに失敗すると戻せない。

## 未検討の候補

`~/.apm` は実ディレクトリのままにし、install script だけが lock を両方向にコピーする形は、まだレビューしていない。chezmoi は lock を管理しない。

1. `~/.apm` の lock が前回の install の後に変わっていれば（手で update した場合）、それを repo へコピーする。変わっていなければ、repo の lock を `~/.apm` へコピーする。
2. `apm install -g` を実行する。
3. `~/.apm` の lock が repo と違えば、repo へコピーする。差分は `git status` に出る。

## どの形でも要る変更

- install script の state の鍵（`~/.apm/.install-state`）に lock の sha256 を入れる。今の鍵は apm.yml の sha256 と apm のバージョンだけなので、repo の lock だけが変わったときに install が実行されない。
- `.oxfmtignore` に lock を追加する。
- install script の古いスキルを消す分岐は「lock が無いとき」に動く。lock を先に置く形では、この条件を `~/.claude/.external-skills-installed` があるかどうかに変える。
- `.github/workflows/ci-smoke-chezmoi.yml` の `paths:` に lock の置き場所を追加し、lock だけを変える PR でも smoke が実行されるようにする。
