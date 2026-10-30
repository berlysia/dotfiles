# ADR-0059 の古い記述を直す

ADR-0059 の Context と Status は、4 つの Mod を作る前提で書いてある。利用者は 2026-10-31 に pr-status / pr-watch と work-header を作らないと決め、apply の hook も今は作らないと決めた。次の記述を、今の姿に合わせて直す。

## 直す箇所

- Status: K3、K4、K5、K7 を追記したら accepted にする、という条件
- Context: 「4 つの Mod と hook」の列挙（pr-watch と hook が残っている）
- D2: `sanitize-label.ts` を sessions と pr-status の lib が import する、という記述
- 却下した代替案と既知の限界の、D2 を参照する行: D2 を直したら文が合っているかを確かめる

## 完了の条件

`git grep -n -E 'pr-watch|pr-status' docs/decisions/0059-cross-session-mods.md` の結果が、作らないと決めた経緯を書いた行だけになる。Status を accepted にするかは、直すときに利用者に確かめる。
