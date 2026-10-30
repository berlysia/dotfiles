# delivery-policy merge の重複起動と、merge 済みでの終了コード 30

同じ PR に `delivery-policy merge` を重ねて起動すると、同じ PR を二重に待つ。merge 済みの PR で終了コード 30 になる件は直した。残りの手順が片付いたら、このファイルを消す。

## 状態

起動の重なりの拒否は未実装。出どころ: dotfiles-feedback 20261030T024901Z-264827650619。

## 分かっていること

- 2026-10-30 に、PR #512 へ `delivery-policy merge 512` を background で 4 回起動し、4 つが同時に待った。結果は `0: merged #512` が 1 つ、`0: already merged at ...` が 2 つ、`30: PR state is MERGED` が 1 つだった。
- 重なった原因はエージェントの動きである。完了の通知が届く前に出力ファイルを読み、`waiting:` の行しか無いのを「結果の行が無い」と読んで、同じコマンドを起動し直した。
- round の先頭で `readHead` が MERGED を読むと 0 で終わる（`home/dot_claude/hooks/cli/delivery-policy.ts` の `alreadyMergedReason` の呼び出し）。
- 同じ round の読み直しで MERGED を読み、head が待っていた sha と同じなら、`alreadyMergedReason` で 0 になる。head が違えば 11 になる。
- 同じ PR への起動の重なりを、CLI は拒否しない。
- `developer-experience.md` の Delivery Policy は、30 を「人に戻す」と定めている。merge 済みで 30 が出ると、不要な手作業を利用者に頼むことになる。

## 未確認

- 30 になったのは、2 回の読みのあいだに別の起動が merge したためだと推測している。再現はしていない。

## 再開するときの手順

1. 同じ (repo, PR) への `merge` が動いているあいだに次の起動が来たら、待たずに専用の終了コードで終える。方法は lock か pid ファイルから選ぶ。
2. 規約の「結果の行が無ければ起動し直す」に、完了の通知が届いてから出力を読むという前提を書き足す。

待ちの記録の同時書き込みは `docs/plans/delivery-policy-waits-concurrency.md` が扱う。起動の重なりそのものは、そちらに含まれない。
