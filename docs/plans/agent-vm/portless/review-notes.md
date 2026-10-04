> **WIP・未承認**: #207 の Document Workflow の途中成果物。レビューは途中で、承認を受けていない。実装の根拠にしない（引き継ぎ先でレビューと承認をやり直す）。

# Review notes: portless のポート割り当て（#207）— WIP、未承認

spec.md と plan-1.md の Round 1 のレビューの途中経過。トリアージ（`/intent-alignment-triage`）と承認はまだ行っていない。

- この cloud 環境には hook（`reviewer-run-recorder`、`document-workflow-guard`）が配備されていない。
- そのため、reviewer は general-purpose の Agent に定義ファイル（`home/dot_claude/agents/<name>.md`）を読ませて走らせた。
- `workflow-cli stamp` は、起動の証跡（`reviewer-runs.log`）が無いので通らない。引き継ぎ先で、正規の手順でレビューをやり直すこと。

## 結果（Round 1）

| reviewer                        | 対象          | verdict                                                 |
| ------------------------------- | ------------- | ------------------------------------------------------- |
| scope-justification-reviewer    | spec / plan-1 | pass / pass                                             |
| decision-quality-reviewer       | spec          | pass                                                    |
| greenfield-perspective-reviewer | spec          | needs-work（設計の変更は不要、Greenfield 節の書き直し） |
| logic-validator                 | spec / plan-1 | 未完了（作業の中止で停止した）                          |

## 反映が要る指摘（未反映）

1. **greenfield [blocking]**: Greenfield 節に `<machine>.orb.local` を使う案を足し、退ける理由を書く。
   - 案の中身: proxy を `0.0.0.0`（`PORTLESS_LAN=1`）に bind し、全 machine で同じポートを使う。
   - 退ける理由の材料:
     - `.orb.local` は `0.0.0.0` の bind でしか届かない（`docs/agent-vm.md` L50）。
     - `0.0.0.0` の bind は他の isolated machine から届く（ADR-0018 L84、#200）。
     - portless は `.localhost` の Host で振り分ける。`*.orb.local` との相性は未確認。
2. **greenfield [minor]**: 案 B を退ける理由 1・2 は強すぎる。
   - mac の proxy は、`<machine>.orb.local:<app port>` に転送することもできる。
   - 経路は host から `orb -m <m> portless list` で引けるので、K23 に反するとまでは言えない。
   - 退ける本当の理由は、「443 にしなければ URL にポートが残り、案 B の利点が消える」ことと、`0.0.0.0` の露出と、複雑さである。
3. **greenfield [minor]**: machine 名の hash からポートを決める案を 1 文で退ける。
   - 100 枠に 10 台を割り当てると、約 37% の確率で衝突する。
   - 結局、lock と記録が要る。
   - K3 の規則 1（自分のポートを保つ）で、hash と同じ安定性が得られる。
4. **greenfield [minor]**: 「同じ形になる」の根拠を書き換える。この形は「VM → host の通路なし」からではなく、「loopback bind と OrbStack の localhost 転送を選んだこと」から来る。
5. **scope [minor]**: Codex にも同じ指示を足す。`home/dot_codex/AGENTS.md` の `## Commands` に、K8 と同じ一文を入れる（plan-1 の T3 の Files と commit にも足す）。
6. **scope [minor]**: PR 本文に次の 2 点を書く。
   - smoke script と bootstrap を変えない理由（K10）。オーダーは、smoke script を変える見込みと書いていた。
   - mise が portless を拒否するおそれ（V27、R4）を、残るリスクとして書く。
7. **decision-quality [minor]**: mac で開くポートを見つける手間を減らす。
   - 起動時に `dev servers: http://<app>.localhost:<port>` の 1 行を出す、または `agent-vm list` の列に見出しを付ける。
   - 有力なのは起動時の 1 行で、まだ決めていない。
8. **decision-quality [minor]**: spec に、支配軸（エルゴノミクス、ADR-0018）と、境界は制約であることを明記する。R1（OrbStack が `::1` を転送するか）は、最大のエルゴノミクスのリスクとして扱う。

## 未解決の論点

- logic-validator の確認が残っている。主に確かめたい点は次のとおり。
  - plan-1 T1 の提案コードが bash 3.2 で動くか。
  - `${port:+...}` での改行の作り方。
  - `$(...)` の中の `set -e` の扱い。
  - 6 プロセス同時のテストが安定するか。
- mac の実機での確認（plan-1 の V24〜V27）。特に、OrbStack が mac の `[::1]:<port>` を転送するか（spec R1）。
- 作業ブランチ `claude/serene-brahmagupta-bsiku2` の `8a6c0af`（docs の 1 行の追記）は master に入っていない。plan では、docs の書き換えで吸収する予定である。
