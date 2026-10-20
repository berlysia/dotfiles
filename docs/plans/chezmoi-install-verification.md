# install-chezmoi の取得を検証つきにする

`.github/actions/install-chezmoi/action.yml` は `sh -c "$(curl -fsLS https://get.chezmoi.io)"` で chezmoi を入れる。版を固定せず、取得したスクリプトの検証もしない。jactionlint の `unverified-download` がこれを検出しており、`.github/jactionlint.yaml` の `ignores` で理由つきで無視している。

## 直すこと

版を固定し、checksum を確かめる取得に替える。候補は 2 つ。

- mise で入れる（`ci-shellcheck.yml` が `github:koalaman/shellcheck` を入れているのと同じ形）。版は 1 か所に置き、Renovate が更新する。
- chezmoi の release から tarball と `checksums.txt` を取り、sha256 を照合してから展開する。

どちらにするかは、`install-dir` と `add-to-path` の入力を今のまま受けられるかで決める。

## 使っている job

`uses: ./.github/actions/install-chezmoi` を持つ workflow が対象。一覧は次で得る。

```
git grep -n 'uses: ./.github/actions/install-chezmoi' -- .github/workflows
```

## 無視を外す条件

直したあと、`.github/jactionlint.yaml` の `unverified-download` の行を消す。消して `jactionlint --config-file .github/jactionlint.yaml` が検出 0 件で通ることが完了の条件。

## 注意

この無視は `install-chezmoi/action.yml` のファイル全体に効く。ファイルを編集するときは、無視が隠している検出が増えていないかを `--no-ignores` 付きの実行で見直す。
