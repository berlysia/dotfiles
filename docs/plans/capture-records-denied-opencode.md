# 拒否された opencode の起動が委譲として台帳に記録される

## 観察（2026-10-29）

- PR #493 の apply 後、新しい非対話セッション（`claude -p`、haiku）で `opencode run --help` を Bash で起動した。
- opencode-direct-gate が deny した。opencode は起動していない。
- それでも delegation の capture が `d-677cf537a55f (opencode/unknown/unknown) 完了` を出し、台帳に委譲として載った。メインループが `delegation lapse` で閉じた。
- 以前から見ていた「isBashCandidate が `opencode run --help` を拾う」と同じ現象と見られる（未検証: capture が PreToolUse で記録しているのか、PostToolUse の deny を見ていないのか）。

## やること

- capture の記録の起点を読み、deny されたツール呼び出しを委譲として数えないようにする。
- `--help` のように model を呼ばない形を候補から外すかも合わせて決める。
- 直すまでは、拒否された起動の行を見つけたら `delegation lapse` で閉じる。
