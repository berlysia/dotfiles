# opencode の直接起動の gate が、シングルクォートの中のバッククォートを命令として読む

## 観察（2026-10-29、#494 の apply の後）

- `sed -i -e '135s/…`bin\/opencode`…/…/' file` が、PreToolUse の opencode-direct-gate に「Bash から opencode を起動できません」で拒否された。
- シングルクォートの中のバッククォートは bash ではただの文字で、opencode は起動しない。
- 拒否された命令は capture に委譲として記録されなかった（直近の opencode の pending は 14:08 UTC のものだけ）。

## 推測

- command-parsing の命令の取り出しが、クォートの中のバッククォートをコマンド置換として扱っている可能性がある。未確認。

## 次にすること

- `bash-parser` が `'…`x`…'` をどう解析するかを、opencode-direct-gate のテストで再現してから直す。
