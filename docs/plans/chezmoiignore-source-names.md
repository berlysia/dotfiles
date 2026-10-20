# `.chezmoiignore` の source 名で書いた行が効いていない

`home/.chezmoiignore` には、source 名（`dot_claude/...`、`dot_local/bin/executable_...`）で書いた行がある。chezmoi は ignore を target path（`.claude/...`、`.local/bin/...`）に照合するので、これらの行は何にも当たらない。

## 確かめたこと（2026-10-21）

- `only_private` を false にして描画すると、`dot_local/bin/executable_claude-zai` の行は有効になる（`chezmoi --override-data '{"only_private":false}' execute-template "$(cat home/.chezmoiignore)"` の 30 行目）
- 同じ条件で `chezmoi --override-data '{"only_private":false}' managed` は `.local/bin/claude-zai` を含み、`ignored` には出ない。「Z.ai は許可した端末だけ」という意図に反して、`only_private` の無い端末にも配られている

## 同じ形の行

`home/.chezmoiignore` の 2、11-15、17、20-23、30 行目（`!dot_claude/skills/**/*.md`、`dot_claude/hooks/scripts/...`、`dot_zsh/.zcompdump*`、`dot_claude/logs/insights...`、`dot_claude/dot_last-...`、`dot_local/bin/executable_claude-zai`）。claude-zai 以外は、今の source に当たるファイルが無いか、配られても害が無いかを 1 行ずつ確かめる。

## 直し方

- 各行を target 名に書き換える（`.local/bin/claude-zai` など）
- `.local/bin/claude-zai` を許可していない端末からは、`.chezmoiremove` ではなく手で消す（`.chezmoiremove` は全端末で消すため、許可した端末からも消えてしまう）
- `tests/lib/chezmoiremove-coverage.mjs` の `unconditionalLines` は ignore の行を target に照合する。書き換えると、消えた source の判定にもその行が効くようになる

## 消す条件

上の行がすべて target 名になり、`only_private` を false にした `managed` に `.local/bin/claude-zai` が出なくなったら消す。
