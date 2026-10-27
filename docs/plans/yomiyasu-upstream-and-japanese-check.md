# yomiyasu の追跡のやめ方と、japanese-check への取り込み

yomiyasu を上流 2.4.0 に追従した作業で、範囲の外として残した課題である。下の節がすべて片付いたら、このファイルを消す。

## yomiyasu の追跡をやめ、発想だけを取り込む

提案・未決。

- **内容**: 上流のコピーに手元の改変を重ねて追従するのをやめる案である。上流の変更からは発想だけを取り出し、役割スキルや japanese-check に自分の言葉で書く。利用者は「もうyomiyasuのトラッキングはやめてエッセンスと発想だけにするのが良いかもねえ」と述べた。
- **分かっていること**:
  - 2.0.2 から 2.4.0 への追従では、9 ファイル 23 か所が衝突した。どれも、手元が役割スキルへの参照に替えた節に、上流が規則を足したものだった。上流は 1 週間で 10 リリース進んだ。
  - 手で適用し直した手元の改変は、Markdown の 384 行である。`scripts/` は上流と同じものを使い、手元では改変していない。
  - yomiyasu だけにあって、役割スキルに無い規則がある。どれも yomiyasu の lint と check が出す指摘か、yomiyasu の SKILL.md の節と種類の資料に結び付いている。
    - lint の指摘を、直す合図でなく読み直す候補として扱う規則
    - 英語の短い術語を漢字 1 字にした名詞（版、印、頭）
    - 連用形名詞（「結果の確かめ」の形）
    - 照合の前に、残った info の指摘を読み直す手順
    - 目的語を書かない他動詞と、主題の掛かる範囲の 2 段落
    - 台詞・脚本の種類（script）
  - `ja-check` は `yomiyasu_check.py` を呼ぶ。`ja-notation` と `ja-doc-profile` は yomiyasu の `references/` を一覧の本体として読む。追跡をやめても、これらの読み先は残る。
  - `scripts/` を手元で書き換えても、それを検出する仕組み（ハッシュの照合など）は無い。
  - 追跡の仕組みは 2 つある。`skill-upstreams.yml` が週次で Issue を開き、`check-skill-upstreams.sh` が `Derived from` の行の commit を読む。
- **再開の入口**: 次に上流を取り込むとき、衝突がまた役割スキルへの参照の節に出たら、取り込む前にこの案を Document Workflow にかける。scripts と references を誰がどう直すかを決める。凍結する、japanese-check の TS に移す、などの案がある。ADR-0036 の「上流の取り込み」を変えるので、ADR を書く。

## japanese-check に「印」「頭」と連用形名詞を足す

提案・未決。

- **内容**: yomiyasu 2.4.0 と 2.3.0 の検出の型を、japanese-check の `words.json` に `review` の項目として足す。2.4.0 の型は、英語の短い術語に漢字 1 字を当てた名詞（版、印、頭）である。2.3.0 の型は連用形名詞で、他動詞の連用形を「の」で受ける形（「結果の確かめ」など 48 語）である。
- **分かっていること**:
  - `words.json` には「版（バージョン）」が、利用者が名指しした語（`fix`）として既にある。パターンと除外は上流の型と別のものである。yomiyasu を入口にすると、同じ「版」に指摘が 2 つ出る。
  - 上流は、livedoor ニュースコーパス 7,367 本で、この 2 つの型の指摘がどちらも 0 件だったと報告している（上流の CHANGELOG の 2.3.0 と 2.4.0）。`japanese-check-detection-followups.md` が求める測定（AI 以前の人の文で誤検知しないか）に相当するが、手元では測り直していない。
  - ADR-0050 の K6 により、`review` の項目は第三者の資料から足してよい。
- **再開の入口**: 語ごとに、japanese-check の照合（形態素の契約、ADR-0051）で上流と同じ除外を書けるかを確かめる。このリポジトリの ADR と SKILL.md に check をかけ、候補の数を数えてから足す。

## yomiyasu の照合を `python3 -I` で呼ぶ

提案・未決。

- **内容**: `ja-check` が `yomiyasu_check.py` を呼ぶときに、`python3 -I` を付ける。
- **分かっていること**: `yomiyasu_check.py` は、隣の `yomiyasu_lint.py` と `yomiyasu_diff.py` を読み込む。その前に、`importlib.import_module` で同じ名前のモジュールを探す。`PYTHONPATH` に同じ名前のファイルがあると、それを一度実行してから捨てる。今の呼び方では、`PYTHONPATH` を設定していなければ、そうしたファイルを読み込まない。
- **再開の入口**: `-I` を付けても、隣のファイルを読む処理（`spec_from_file_location`）で動くかを確かめてから、ja-check の呼び方を変える。

## ja-explain-first が rephrase-test.md の章を番号で指す

提案・未決。

- **内容**: `ja-explain-first` は、yomiyasu の `references/rephrase-test.md` を「3 章」と章の番号で指している。上流が章を足すと、指す先がずれる。
- **再開の入口**: 見出しの名前（「否定対比（AではなくB）」）で指すように直し、`check-skill-refs.sh` で見出しを照合するかを決める。
