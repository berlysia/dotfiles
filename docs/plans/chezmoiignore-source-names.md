# `.chezmoiignore` の source 名で書いた行が効いていない

`home/.chezmoiignore` には、source 名（`dot_claude/...`、`dot_zsh/...`）で書いた行がある。chezmoi は ignore を target path（`.claude/...`、`.zsh/...`）に照合するので、これらの行は何にも当たらない。

## 分かっていること（2026-10-21）

同じ形だった `dot_local/bin/executable_claude-zai` の行は、2026-02-17 に足されてから一度も効いておらず、`only_private` の無い端末にも `~/.local/bin/claude-zai` が配られていた（`chezmoi --override-data '{"only_private":false}' managed` に出て、`ignored` には出なかった）。これは ignore の行をやめ、ファイル全体を `{{ if dig "only_private" false . }}` で囲むテンプレートにして直した。描画結果が空の target は chezmoi が消すので、配られてしまった端末からも apply で消える。

## 残っている行

`home/.chezmoiignore` の 2、11-15、17、20-23 行目（`!dot_claude/skills/**/*.md`、`dot_claude/hooks/scripts/...`、`dot_zsh/.zcompdump*`、`dot_claude/logs/insights...`、`dot_claude/dot_last-...`）。

## 確かめ方と直し方

- 行ごとに、target 名に書き換えたときに何に当たるようになるかを確かめる。今の source に当たるファイルがあれば、書き換えるとそのファイルが配られなくなる（意図どおりかを決める）。当たるものが無ければ、行そのものを消してよいかを決める
- 端末によって配るかどうかを分けたいファイルは、ignore ではなく claude-zai と同じテンプレートの形にする。ignore は配らないだけで、配置先に既にあるファイルは消さない
- `tests/lib/chezmoiremove-coverage.mjs` の `unconditionalLines` は ignore の行を target に照合する。書き換えると、消えた source の判定にもその行が効くようになる

## 消す条件

上の行がすべて target 名になるか、消えたら、この文書を消す。
