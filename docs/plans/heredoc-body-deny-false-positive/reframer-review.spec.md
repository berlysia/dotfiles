## Reframer Review (Round 6)

- agent: review-reframer
- recommendation: (b)
- rejected:
  - (a) 続行: 最新 round が blocker で、同一クラス（tree-sitter とシェルの読みのずれ）の実行経路が R1〜R6 で毎回新しく見つかっている。前 round の fuzz 0 件は次 round の穴を一度も予測していない。残る表面は sink 側の git / gh の意味論で、parser の fuzz では閉じたことを示せない。
  - (c) 既知の指摘付きで承認: R6 の blocker は反映・検証済み（plan-1 表 116/116、fuzz 2×1,200 で 0 件）だが、未知の「次のずれ」に対して確認 round なしで承認する根拠が無い。
  - (d) 撤回: 誤検知は実 hook で再現済みで、K1・K4・R1 の受容・コピー型の K2 は pass を得ている。
- hypothesis: 根は 2 つ。(1) K2 が AST の読みをシェルの読みの代用にする前提に立ち、修正のたびに綴りの許可リストへ移している。(2) R4 以降の blocker 3 件はすべて commit / PR 本文の経路（形 B → stdin sink）から出ており、cat / tee のコピー型は R3 以降 穴が無い。sink の安全性は git / gh の選択肢・設定・hook・環境変数（版依存）で決まり、現時点の体験差はほぼゼロ（stdin 形は決定ログ 5 件）。
- plan: F3b を cat / tee のコピー型に絞り、stdin sink を別 spec「commit / PR 本文の経路」（stdin 形への誘導・heredoc commit の allow・sink の deny 側緩和を一体で設計）に移す。K2 を「parser は構造と範囲にだけ使い、heredoc に隣接するトークン（隙間・演算子・区切り・終端・宛先）はすべて綴りで比べ、列挙に無いものは本文を残す」という不変条件に圧縮する。R7 を `round --full`。sink を残す判断なら (a) で R7 に security + logic-validator を再実行し、sink 側の新しい穴が 1 件でも出たら (b) に切り替える。
- note: stdin sink は Round 4 の後にユーザーが選んだ形（「形 B をやめ stdin 形を足す」）なので、外すかどうかはユーザーの判断に委ねる。
