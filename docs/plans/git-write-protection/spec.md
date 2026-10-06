# Spec: .git まわりの書き込み保護を、本体の protected paths に揃えて設計し直す

## Goal

git がコマンドを実行する経路への無確認の書き込みと実行をなくす。対象は次のとおり。

- `.git` の中
- gitfile
- bare repo
- global の git config と、その配布元
- Bash の迂回路

そのうえで、`.git/worktree/<branch>` の中の作業は確認なしで続けられるようにする。

規則の場当たりの追加をやめ、判定の筋を 1 つにする。

主因はフックの allow が本体の保護を消していることなので（research U1、H11）、直すのは git 関連に限らない。本体の protected paths すべての迂回を止める（ユーザーの回答「判定を本体に委ねる」）。

Bash で扱う範囲は 2 つ。

- フック固有の承認の根拠（固定の正規表現、2a の静的規則、2b の LLM）が、`-C` 以外の大域オプションや `GIT_*` の環境変数を伴う git の呼び出しを自動承認すること
- dot のパスへの書き込み先

それ以外の Bash の allow の見直しは扱わない（Phase 1 で提供しない体験）。

## Experience Delta

### 変更前

- フック（PreToolUse の `auto-approve`、PermissionRequest の段の 2 つのフック）が allow を返すと、本体の protected paths の確認が飛ばされる。
  - そのため、`~/.config/git/config`、gitfile、`.git/commondir`、`.claude/`、`.vscode/` などが確認なしで書ける。
- `git -c core.fsmonitor=<cmd> status` が、確認なしで任意のコマンドを実行する。
- 穴を塞ぐたびに、deny を 1 行ずつ足してきた。

### 変更後

- `.` で始まるセグメントを含むパスには、どの段のフックも allow を返さない。判定は本体の settings の規則と protected paths に委ねる。
  - 本体が protected と見なさず、本体の allow 規則が覆うパスは、確認なしで通る。例: `~/.local/share/chezmoi/**` の中の `.tmp/` や `.github/`。
  - 本体の allow 規則が覆わないパスでは、確認が 1 回増える。2a の cwd に基づく承認を失うため（R3）。
  - protected のパスでは、Manual なら確認が出て、auto mode なら分類器に回る。
- 例外は 1 つだけ。実体を確かめた linked worktree の中身は、フックが従来どおり allow する。
  - worktree の中は、本体から見るとパス全体が `.git` の配下で、protected になる。
  - そこでフックが保護者を引き受け、本体の protected の一覧に当たるものだけを控える（K2）。
  - worktree の内側の `.github/` や `.gitignore` の編集は、これまでどおり確認なしで通る（外側の扱いは上の項目のとおり）。
- フック固有の根拠からは、`-C` 以外の大域オプションを伴う git の呼び出しは自動承認されない。2b の LLM は、git が head のコマンドと `GIT_*` を設定するコマンドを評価しない（K4）。
  - 本体の allow 規則が自分で通す形（例: `Bash(git commit *)` に当たるもの）は、これまでどおり通る。フックはそこには関与しない。
  - `git -C <dir>` は、これまでどおり 2a の正規表現で自動承認される。2a に当たらず 2b まで届いた `-C` の形は、原則 2 で LLM を通らず、確認が出る。
- 暗黙の bare repo は、git 自身が開かない。
- 2 つの照合器の差は、テストで検出される。

## Architecture

```
  Edit / Write / MultiEdit / NotebookEdit / Bash
                     │
  PreToolUse        auto-approve.ts            ┐
  PermissionRequest permission-auto-approve.ts │── assessAutoApprovalHold(tool, input, ctx)
                    permission-llm-evaluator.ts┘        (lib/auto-approval-hold.ts)
                     │                                    ├─ classifyWriteTarget  (lib/write-protection.ts)
                     │                                    └─ assessBashCommand    (lib/bash-write-hold.ts)
        hold   → フックは allow を返さない（PreToolUse: pass / 2a: uncertain / 2b: LLM を呼ばない）
        no hold→ 既存の判定のまま
  入口の外で行う変更（K4）:
        原則 1: フックの git の正規表現から -c を外す（auto-approve の固定の正規表現、2a）
        原則 2: 2b の LLM を呼ぶ直前で、git が head / GIT_* を設定するコマンドを評価しない
                     │
  本体: deny（床: repo の中で実行につながるファイル）
        ask（global の git config と配布元: auto mode でも人間に確認。PermissionRequest の段は K1 で控える）
        protected paths（組み込み） / allow 規則
  git : safe.bareRepository=explicit（global）
```

### lib/write-protection.ts（パスの分類）

- 次の関数を持つ。
  - `classifyWriteTarget(absPath, ctx)`
  - 純関数 `findHoldSegment(path, ctx)`
- 戻り値は `{ kind: "hold"; reason } | { kind: "worktree-content"; worktreeRoot } | { kind: "ordinary" }`。
- `ctx` に入れるもの:
  - `fs: PathFs & { readFile }`。`PathFs` は `lib/path-containment.ts` のものを拡張する。
  - `home`
  - `chezmoiSource`

  環境変数と実 fs への依存は、引数として注入する。

### lib/bash-write-hold.ts（Bash のパスの語の hold。K4 原則 3）

- `assessBashCommand(command, ctx)` は非同期で、hold の理由（または `null`）と、parse した `SimpleCommand` の配列を返す（2b が原則 2 の判定に使う）。
- 単純コマンドへの分割は、`lib/bash-parser.ts` の `parseBashCommand` で行う（tree-sitter）。
  - 返り値の `commands` は `SimpleCommand` の配列（`bash-parser.ts:31-45, 602`）。
    - フィールドは `name`、`args`、`assignments`、`redirections`、`path`、`range`、`text` の 7 つ。
    - `redirections` は `string[]`。リダイレクト先の語を、そのまま `findHoldSegment` に渡せる形かどうかは、plan で確かめる。
  - `extractCommandsStructured` は使わない。返り値は deny 向けの文字列の上位集合で、語に分かれていない（`bash-parser.ts:47-55`）。
- 次の場合は hold に倒す（fail-closed）。
  - `parsingMethod` が `"fallback"` のとき（長さの超過と parser の初期化の失敗を含む）。
  - 構文エラーがあるとき（`rootNode.hasError`）。
    - `parseBashCommand` は構文エラーを返さない。tree-sitter で parse できたときの `errors` は常に空（`bash-parser.ts:762-766`）。
    - そこで、木を返す `parseForCollect`（`bash-parser.ts:1117-1119`）で検出する。先例は `heredoc-data.ts:524-525`。
    - 判定の条件は、既存の `bash-parser.ts:1188`（`parsingMethod === "fallback" || tree.rootNode.hasError`）と揃える。
    - `parseForCollect` で得た木は、`finally` で `tree.delete()` する（`bash-parser.ts:1203`、`heredoc-data.ts:563` と同じ）。
    - 同じコマンドを 2 回 parse しない方法（木を共有する経路）は、plan で決める。parse の結果は memo されないので、2 回 parse すると予算も 2 回消費する。
  - 時間と走査の予算を超えたとき。
    - 返り値だけでは見えないので、一連の parse 全体の前に `parserGiveUpMark()` を 1 回だけ取り、すべての parse の後で `parserGiveUpReasonSince(mark)` を読む（`bash-parser.ts:164-178`）。
    - `parseForCollect` が `null` を返すのは、長さか時間の打ち切りのとき。打ち切りの判定を先に評価し、`null` を構文エラーとは扱わない。
  - 語の中に、変数展開やコマンド置換があってパスの語として確定できないとき（原則 3）。
- パスの語の判定は `findHoldSegment` を再利用する。

依存の向きは bash → path の一方向。

### lib/auto-approval-hold.ts（3 つのフックの単一の入口）

- `assessAutoApprovalHold(toolName, toolInput, ctx)` は非同期で、`{ hold: true; reason } | { hold: false }` を返す。
- 書き込み系の tool（Edit / Write / MultiEdit / NotebookEdit）では、次の手順で判定する。
  1. パスを `getFilePathFromToolInput`（`lib/command-parsing.ts:338`）で取り出す。この関数は Read / Grep も返すので、書き込み系の tool に絞る。
  2. 取り出したパスを、`ctx.cwd` を基準に絶対化する。
  3. 絶対化したパスを `classifyWriteTarget` に渡す。
- Bash では `assessBashCommand` に振り分ける。
- `buildHoldContext({ cwd, env })` が、次のものを束ねる。各フックはこれを呼ぶだけにする。
  - `cwd`
  - `home`
  - `chezmoiSource`（chezmoi のソースのルート）。
    - `<home>/.local/share/chezmoi/` に、同じディレクトリの `.chezmoiroot` の中身（前後の空白と改行を取り除いたもの。現在は `home`）を付けたもの。
    - ask 規則の実パスが `chezmoiSource` の配下に入ることを、K7 のテストで固定する。食い違うと、ask 規則と K2 2a(iii) が黙って外れるため。
    - 読めなければ `<home>/.local/share/chezmoi/home` を使う。K6 の ask 規則が直書きしているパスと同じ。
    - `lib/chezmoi-utils.ts` の `getChezmoiSourcePath` は、home 配下のパスに対応するソースのファイルを返す関数で、ルートは返さない。なので使わない。
  - 実 fs
- 各フックは、結果を自分の出力の形に写すだけにする。
- 2b（`permission-llm-evaluator.ts`）は、いまパスの判定を持っていないので、呼び出しを新しく足す。

### 判定の順序とログ

- 判定の順序:
  1. 既存の deny の判定を先に行う（`isDangerousWritePath` による 2a の deny、settings の deny）。
  2. hold は、deny されなかったものにだけ効く。
- decisions.jsonl の `decision` の語彙（allow / deny / ask / pass）は変えない。hold は `reason` で区別する。段ごとの写像は次のとおり。

| 段                                     | フックの出力                            | decisions.jsonl                                                                                             |
| -------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| PreToolUse（auto-approve）             | 判定を返さない（`context.success({})`） | `decision: "pass"`、`reason: "held: <理由>"`                                                                |
| PermissionRequest 2a                   | `uncertain`（既存の値。2b へ流れる）    | `decision: "pass"`、`reason: "held: <理由> (Layer 2a)"`                                                     |
| PermissionRequest 2b（原則 3 の hold） | 判定を返さない（LLM を呼ばない）        | `decision: "pass"`、`reason: "held: <理由> (Layer 2b)"`                                                     |
| PermissionRequest 2b（原則 2 の skip） | 判定を返さない（LLM を呼ばない）        | `decision: "pass"`、`reason: "skipped-llm: git-head (Layer 2b)"` または `"skipped-llm: git-env (Layer 2b)"` |

- 原則 2 の判定は、原則 3 と同じ `parseBashCommand` の結果（`SimpleCommand.name` と `assignments`）を使い、2b の中で parse を 2 回しない。
  - そのため `assessBashCommand` は、hold の理由に加えて、parse した `SimpleCommand` の配列を返す。
  - 2b はそれを受け取って原則 2 を判定する。
- 原則 2 の 2 つの理由が両方に当たる場合は、`git-env` を優先して記録する。
- 新しい理由（`held:`、`skipped-llm:`）は、hooks/README.md の理由の語彙の説明に足す。

- R8 の撤退（PreToolUse の hold を ask にする）を取る場合は、この表が変わる。そのときは spec を再レビューする。

### 既存のモジュールとの関係

- `lib/dangerous-write-paths.ts`（認証情報系。2a で deny する）は、意味が違うので統合しない。
- `implementations/file-access-guard.ts` は、書いてよい領域を physical のパスで判定する。今回の判定は、それに重ねる「自動承認を控える」判定で、責務が違う。どちらも変更しない。
- `PathFs`（`lib/path-containment.ts:4-8`）は変更しない。読み取りは交差型 `PathFs & { readFile }` で足す。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

deny を足して、見つかった穴を個別に塞ぐ。

- 足すもの: `commondir`、`worktrees/**`、`info/attributes`、`modules/**`、`~/.config/git/**`、`~/.gitconfig*`、chezmoi のソースの git 関連。
- `Bash(git -c *)` を消す。
- フックには手を入れない。

この案の限界は 4 つある。

- **gitfile を塞げない。** 書式で表現できない（research §2）。
- **git 以外の protected paths の迂回が残る。** `.claude/`、`.vscode/`、`.husky/` など（U1）。
- **PermissionRequest の段の自動承認が残る（H11）。** 実験で観測した `.git/pr-probe.txt` は、`.git` の直下の任意の名前だった。どの deny でも閉じない。
- **本体の一覧が増えるたびに、同じ追加が要る。**

### 白紙設計案 (Greenfield)

ゼロから設計するなら、「書いてよいか」の判断の主体は本体にし、フックは本体の保護を**広げない**。

- **本体は、すでにこの目的で守っている。** `.git`、`.config/git`、`.gitconfig` などを protected にしている。permission-modes.md「Protected paths」の冒頭にも「repository state … の偶発的な破壊を防ぐ」とある。
- **フックが控えても、損はほとんどない。** 本体は同じ settings の allow 規則で照合するので、本体が守らないパスは、フックが控えても確認なしで通る。
  - 控えることで失われるのは、フックだけが持っていた承認の根拠に限られる。たとえば、PermissionRequest の段の「cwd の配下なら allow」。
  - そこで、本体の一覧を写さずに、**過大に控えればよい**。
  - 本体の一覧は `bunfig.toml` を除き、すべて `.` で始まる名前（permission-modes.md）。
  - したがって「`.` で始まるセグメントを含むなら控える」とすれば、版が上がって一覧が増えても、自動で覆える。
- **自前の例外が要るのは 1 か所だけ。** ユーザーの規約で worktree を `.git` の中に置いている部分。
  - ここは名前ではなく、実体（gitfile の相互のポインタ）で確かめる。
  - gitignore 書式では「`.git` を閉じて worktree だけを開ける」構成が作れないため（research §2）。
  - worktree の中では、本体から見るとすべてが `.git` の配下で protected になり、本体はもう区別できない。
  - そこでこの内側に限り、フックが「`.git` の下でなければ本体がどう判定するか」を再現する。具体的には、本体の protected の一覧を写したものを当てる。
  - 一覧を写すことによるドリフトは、worktree の内側にだけ残る（R1）。
- **パスの名前で捕まえられない経路は、git 自身の防御に任せる。** 暗黙の bare repo は `safe.bareRepository=explicit` で止める（git-config(1) は、bare repo を使わないなら global に入れることを勧めている）。
- **規則の層は床に限る。**
  - deny: どのモードでも書かせない。
  - ask: 必ず人間に確認する。

### 採用案と理由

白紙設計案を採用する。差分最小案の deny の追加は、床として併用する。

- **U1 と H11 の実験結果**（research §1、§5）: 主因は deny の列挙漏れではなく、フックの allow が本体の保護を消していること。
- **gitfile は書式で書けない**（`ignore` 7.0.5 で確認。research §2）: `lstat` と中身の読み取りが要り、フックでしか実現できない。
- **既存の先行実装**: `isBorrowedEditRuleOnDangerousPath`（`auto-approve.ts:718-736`）は、すでに「特定のパスでは allow を出さず、次の段へ渡す」形をとっている。これを一般化する。
- **`safe.bareRepository=explicit` の影響**（scratchpad で確認）:
  - 次の場所での `git rev-parse` は、引き続き動く。
    - 通常の repo
    - その `.git` の中
    - サブモジュールの作業ツリー
    - `.git/modules/<n>`
  - 止まるのは暗黙の bare repo だけ。

## Key Decisions

### K1: フックは hold のときに allow を返さず、判定を本体に委ねる（deny はしない）

各段の振る舞い:

- **PreToolUse の `auto-approve`**
  - hold なら判定を返さない（`context.success({})`）。
  - deny の判定は残す。deny に当たれば、従来どおり deny を返す。
- **PermissionRequest の 2a**: hold なら `uncertain` を返す。
- **PermissionRequest の 2b**: hold なら LLM を呼ばずに、判定を返さない。
  - 2a が `uncertain` を返すと 2b が走る。そのため 2b でも独立に `assessAutoApprovalHold` を呼ぶ。

PermissionRequest の段でも控える理由:

- 本体の ask と protected の確認には、PermissionRequest フックが答えられる（permission-modes.md 732 行目「In modes that ask, a `PermissionRequest` hook can answer the prompt」）。
- 実際に 2a と 2b は `.git` への書き込みを承認していた（H11）。

deny にしない理由:

- `.claude/` の正当な編集などを毎回止めないため（ユーザーの回答）。
- 本体の確認は残るので、ガードは弱まらない。

PreToolUse の pass で本体が確認を出すという前提について:

- 対照実験（フックをすべて無効にした状態）では、本体は "sensitive file" で確認を求めた。
- PreToolUse が判定を返さず、PermissionRequest の段も控えるなら、本体からはフックが無い状態と同じに見える。
- この前提は、plan の受け入れ実験で、実際の設定で確かめる。

参照:

- `home/dot_claude/hooks/implementations/auto-approve.ts:186-224`（Edit 系の ask / allow / pass の分岐）
- `home/dot_claude/hooks/implementations/auto-approve.ts:718-736`（allow を控えて渡す既存の形）
- `home/dot_claude/hooks/implementations/permission-auto-approve.ts:549-571`（2a が cwd の配下を無条件に allow する箇所）
- `home/dot_claude/hooks/implementations/permission-llm-evaluator.ts:286-297`（LLM を飛ばして人間に回す既存の早期 return）

### K2: hold の判定は、worktree の外では「`.` で始まるセグメント」、内側では本体の一覧の写しを基準にする

worktree の内側は、この設計で唯一、フックが本体の保護を意図的に上書きする場所。

- 本体は、worktree の中のパスをすべて `.git` の配下として protected と見なす。フックが allow を返すと、その確認が消える（U1 と同じ仕組み）。
- 外側では本体に判定を委ねる。内側では、フックが本体の代わりに判定する。

`classifyWriteTarget` は次の順に判定する。

1. まず K3 の worktree 判定をする。
   - 成立したら、`<rest>`（worktree のルートからの相対）に 2b. の規則を当てる。当たれば `hold`、当たらなければ `worktree-content`。
   - 不成立なら、パス全体に 2a. の規則を当てる。
2. 規則は 2 つある。字句のパスと physical のパス（`resolvePhysicalPath`）のどちらかで当たれば hold にする。本体の deny の symlink の扱いと揃えるため。
   - **2a. worktree の外（本体が判定できる場所）**: 次のいずれかに当たれば hold。
     - (i) `.` で始まるセグメントがある。`.` と `..` は除く。`..` は `checkParentSegments` が別に拒否している。
     - (ii) 本体の protected の一覧のうち、`.` で始まらない名前（現時点では `bunfig.toml`）のセグメントがある。
     - (iii) chezmoi のソースの git 関連である。
       - `<chezmoiSource>/` の直下で、名前に `dot_gitconfig` を含むもの
       - `<chezmoiSource>/*dot_config/*git/` の配下
   - **2b. worktree の内側（本体が区別できない場所）**: 本体の protected の一覧の写しに当たれば hold。
     - 一覧の写し: permission-modes.md「Protected paths」の名前の一覧。2026-10-06 取得、Claude Code 2.1.291。
       - ディレクトリ: `.git` `.config/git` `.vscode` `.idea` `.husky` `.cargo` `.devcontainer` `.yarn` `.mvn` `.claude`
       - ファイル: `.gitconfig` `.gitmodules`、シェルの rc ファイル群、`.npmrc` 他、`bunfig.toml` 他、`.bazelrc` 他
     - 名前が `.git` のセグメントは、ファイルでもディレクトリでも当たる。gitfile とネストした repo が該当する。
     - 本体の `.claude` の例外は写さない。過大な判定は安全側に倒れる。
3. どれにも当たらなければ、worktree の外では `ordinary` にする。

範囲外の注記:

- 名前に `.git` を含むが `.` で始まらないセグメント（`foo.git/config` などの bare repo）は、2a. では捕まらない。
- これは git の側で止める。暗黙の bare repo（`-C` で指す場合を含む）は K8 だけが止める。

設計上の帰結:

- worktree の外では、過大に判定するコストは、本体の allow 規則が覆うパスに限って 0 になる。
  - 例: `~/.local/share/chezmoi/.tmp/sessions/x/spec.md` は `.local` と `.tmp` で hold になる。
  - それでも本体が `Edit(~/.local/share/chezmoi/**)` で通すので、確認は出ない。
- 本体の allow 規則が覆わないパスでは、確認が 1 回増える。PermissionRequest の 2a による cwd ベースの承認を失うため。
  - 例: `~/workspace` の外の repo の `.github/`。
  - 例: cwd 相対の `Edit(.tmp/sessions/*/*.md)` を、cwd が異なる subagent から使う場合。
- 残るドリフトは 2 つ（R1）。
  - 本体が `.` で始まらない名前を一覧に足した場合（worktree の外）。
  - 本体が一覧に何かを足した場合（worktree の内側）。

参照:

- `home/dot_claude/hooks/lib/path-containment.ts:4-8, 21, 56-111`（`PathFs`、`checkParentSegments`、`resolvePhysicalPath`）
- `home/dot_claude/hooks/lib/chezmoi-utils.ts`（chezmoi のソースの位置の取得。`ctx.chezmoiSource` に渡す）

### K3: worktree の例外は、実体と相互のポインタで確かめる

次の条件をすべて満たすときに `worktree-content` とする。

- パスが `<R>/.git/worktree/` の配下にある。
- `<W>` は、`<R>/.git/worktree/` からパスの対象までの祖先のうち、`<W>/.git` が通常のファイル（`lstat`）であるもの。
  - 最も浅いものを採る。
  - `/` を含むブランチ名でも、`<W>` が複数のセグメントになるだけで、判定は成立する。
  - `executable_git-worktree-create` L218-233 は `$worktrees_dir/$branch_name` に置く。
- `<W>/.git` の中身が `gitdir: <p>` である。
- `realpath(<p>)` が `realpath(<R>/.git)/worktrees/<id>` の形である。
- 逆向きのポインタ `realpath(<R>/.git)/worktrees/<id>/gitdir` の中身が、`realpath(<W>/.git)` を指している。
- 対象が `<W>` 自身でも `<W>/.git` でもない。

physical のパスが `realpath(<W>)` の外に出る場合（途中の symlink など）:

- 例外を適用しない。
- physical のパス全体に K2 の 2. を当てる。

確かめられない場合（不在、読めない、形が違う）は、例外を適用しない。その結果、パス全体の `.git` で hold になる。

`<W>` を浅い方から探す途中で、通常のファイルではない `.git`（symlink やディレクトリ）に当たったら、そこで探索を打ち切り、例外を適用しない。

参照:

- `home/dot_local/bin/executable_git-worktree-create`（L218-233）
- research §4.3（gitfile の形式）

### K4: Bash は、フック固有の承認の根拠を絞る（git の呼び出しの形の判定表は持たない）

前提（2026-10-06 の整理）: hold は「フックが allow を出さない」ことなので、効くのは、フックが自分の根拠で allow を出している入力だけ。本体の allow 規則が自分で通す入力（例: `Bash(git commit *)` に当たるもの）には効かない。

フック固有の allow の根拠は、次の 3 つ。

- PreToolUse: 固定の正規表現（`SAFE_BASH_PATTERNS_LAYER1`）と、`sed -i` の推論。
- PermissionRequest 2a: 静的な規則（git の正規表現、cwd の配下の操作）。
- PermissionRequest 2b: LLM。本体が確認に回したものを承認しうる。

K4 は、この 3 つを次の原則で絞る。`assessBashCommand` は、`parseBashCommand` が返すすべての単純コマンド（`SimpleCommand`）を見る。分割に失敗した場合は hold にする（Architecture）。

- **原則 1: フック固有の git の正規表現は、`git` の直後に `-C <dir>` 以外の大域オプションを受け付けない。**
  - `-c` を許す部分を外す（`permission-auto-approve.ts:122,124`）。既存のテスト（`permission-auto-approve.test.ts:99-110`）は、`-c` を含む形が allow されないことを期待する形に更新する。
  - `-C <dir>` は、ユーザーの方針で、これまでどおり通す。
- **原則 2: 2b の LLM は、head が git のコマンドと、名前が `GIT_` で始まる環境変数を設定するコマンドを評価しない（判定を返さず、本体の確認を人間に残す）。**
  - 理由: 日常の git の呼び出しは、本体の allow 規則とフックの静的な規則で通り、2b には届かない。2b に届く git の呼び出しは、それらに当たらなかった形で、設定の読み込み先や起動するプログラムを変える形はここに集まる（research H9）。
  - `GIT_` の環境変数の代入は、本体の allow 規則が読み飛ばさないので、本体は確認に回す（permissions.md 239 行目）。2b でそれを承認しないようにする。
- **原則 3: 書き込み先とパスの語に K2 の hold が当たるコマンドは hold にする。**
  - 対象は、git に限らずすべての単純コマンド。3 つの根拠のどれからも allow を出さない。
  - Edit 系と同じ判定を Bash にも当てる（`tee` や リダイレクトで dot のパスへ書く場合を含む）。
  - 読み取りだけのコマンドが過剰に hold されても、本体の Bash の allow 規則が覆う限り確認は出ない。この点は受け入れ実験で確かめる。

対象外にしたもの（ユーザーの判断）:

- サブコマンドのオプション（`--no-gpg-sign` など）。本体の allow 規則が通すのでフックでは止められず、使い方は会話での指示で足りている。
- 既存の広い git の Bash の allow 規則の見直し。別の作業にする。

plan で決めること:

- どの語をパスの語として扱うか（オプションに `=` で付いた値、`-C` の引数、リダイレクトの先を含める）。

Bash の検出は best-effort であり、境界ではない（R4）。

- **真の境界**は、次の 3 つ。
  - 本体の Bash の allow 規則（コマンドの形で照合する）
  - 本体の deny / ask
  - 本体のリダイレクトと `sed` / `tee` への Edit の照合
- **この判定の役割**は、フックの自動承認がその境界を広げないようにすることに限る。
- **過大に判定しても安全側に倒れる。** hold は deny ではないので、本体の allow 規則が覆うコマンドは引き続き通る。

あわせて行うこと:

- `permission-auto-approve.ts:122,124` の正規表現から、`-c` を許す部分を外す。
- `inferSedInPlaceAllow` が allow を返す場合も、Bash の段の hold を通るようにする。旧 K5 は、これに統合した。`sed -i … .git/config` は原則 3 で hold になる。

参照:

- `home/dot_claude/hooks/implementations/permission-auto-approve.ts:122-124`
- `home/dot_claude/hooks/implementations/auto-approve.ts:584-660`（Bash の allow 段と、sed の推論）
- `home/dot_claude/hooks/lib/bash-parser.ts:31-45, 602`（`SimpleCommand`、`BashParsingResult`、`parseBashCommand`）

### K6: settings の規則は床と確認に限る

`ask` キーはテンプレート（`.settings.permissions.json`）が所有する。

- マージスクリプトは `permissions` を丸ごと置き換える（`run_onchange_update-settings-json.sh.tmpl:69-71, 88-92, 141-142`）。
- フックは `ask` を読まない（`auto-approve.ts:367` の型は `allow` と `deny` だけ）。

**deny**（床。どのモードでも書かせない）は、実行につながる repo の中のファイルに絞って整理する。

| 規則                        | 備考                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `//**/.git/config`          | 既存                                                                                 |
| `//**/.git/config.worktree` | 既存                                                                                 |
| `//**/.git/commondir`       | 新規                                                                                 |
| `//**/.git/hooks/**`        | 既存                                                                                 |
| `//**/.git/info/attributes` | 新規                                                                                 |
| `//**/.git/worktrees/**`    | 既存の `worktrees/*/config.worktree` を包含する。単数形の `worktree/` には当たらない |
| `//**/.git/modules/**`      | 既存の `modules/**/config` と `modules/**/hooks/**` を包含する                       |
| `//**/.git/worktree/*/.git` | 既存                                                                                 |

**ask**（必ず人間に確認する）に置くもの:

- `Edit(~/.gitconfig*)`
- `Edit(~/.config/git/**)`
- `Edit(~/.local/share/chezmoi/home/*dot_gitconfig*)`
- `Edit(~/.local/share/chezmoi/home/*dot_config/*git/**)`

ask を選んだ理由:

- auto mode でも人間に確認が出る（permission-modes.md 288、732 行目）。
- deny ではなく ask にしたのは、dotfiles として正当に編集する場面があるため（ユーザーの回答）。
- この 4 本は、K2 で必ず hold になる。そのため PermissionRequest の段も承認しない（K1）。この包含関係は K7 のテストで固定する。

**allow** の変更:

- `Bash(git -c *)` を消す。
  - フック自身の `-c core.fsmonitor=` は、child_process から直接 git を起動している（research §6、読解）。
  - plan で、Bash ツールを経由する呼び出しが無いことを grep で確かめる。
- `Edit(//**/.git/worktree/**)` は残す。K3 で `worktree-content` になったパスに、フックが allow を出す根拠になる。

参照:

- `home/dot_claude/.settings.permissions.json:83, 161-166, 299-305`

### K7: 2 つの照合器の差と、フックの不変条件をテストで検出する

- `ignore@7.0.5` を root の devDependencies に入れる。
- テスト用の `coreMatch(rule, absPath, { home, cwd, settingsDir })` を書く。
  - アンカー（`//` `~/` `/` 相対）を解決し、相対パスにしてから `ignore().add(pattern).ignores(rel)` を呼ぶ。
- 本体の側で検証すること:
  - `settings-permissions-compat.test.ts` の型に `ask` を足す。
  - 次の代表パスについて、本体の側で deny / ask / allow のどれが効くか（deny > ask > allow）を検証する。
    - 新しい deny と ask のすべての規則に当たる代表パス
    - `.git/worktree/x/...` が `worktrees/**` に当たらないこと
    - deny の置き換えの前後で、守られる範囲が狭まらないこと（包含）
  - エミュレーションの妥当性を確かめるため、docs の明文の例を入れる。例: `Read(.env)` と `Read(**/.env)` が同じ。
- フックの側で検証すること（不変条件）:
  - hold になる入力について、3 つのフックのどれも allow を返さない。入力は、ask の 4 本の代表パス、`.git` の中、gitfile、worktree の中の `.claude/x`、dot のパスへのリダイレクトと `tee` を含む。
  - 原則 1: PreToolUse の固定の正規表現と 2a は、`-c` を含む git の呼び出しを allow しない（`-C` と `-c` を併用する形を含む。既存の `permission-auto-approve.test.ts:99-110` を更新）。`-C <dir>` だけの形は、これまでどおり allow する。
  - 原則 2: 2b は、git が head の単純コマンドを含むコマンドと、`GIT_*` を設定するコマンドで LLM を呼ばない。
    - head は、ラッパー（`env`、`command` など）を外した後の、各単純コマンドの名前で判定する。複合コマンドの後段の git も含む。
    - `GIT_*` の設定は、代入の前置、`export`、`env` の 3 つの経路を含む。
  - Goal の約束の確認: PreToolUse の固定の正規表現と 2a が、`-C` 以外の大域オプション（`--git-dir`、`--work-tree` など）を伴う形と、`GIT_*` の代入を前に付けた形を allow しないことを、テストで固定する。現状の正規表現は `git` の直後にサブコマンドか `-C` / `-c` を要求するので、変更後も通らない見込み。代入の前置を、フックの分割が外すかどうかは、plan の最初のタスクで確かめる。
    - 2a が `-C <dir>` を伴う `config` の書き込みの形を allow しないことも、テストで固定する。2a の正規表現は `config` を読み取りの形（`config\s+--get`）でしか許していない（`permission-auto-approve.ts:122`）。
  - worktree の中の通常のファイルは allow される。
- テストが通っても本体と食い違う可能性は残る（R5）。本体そのものでの確認は、plan の受け入れ実験（`claude -p`）で行う。

参照:

- `home/dot_claude/hooks/tests/unit/settings-permissions-compat.test.ts:10-21, 74-83, 112-216`

### K8: global の git config に `safe.bareRepository = explicit` を入れる

対象は `home/dot_gitconfig.tmpl`。

狙い:

- パスの名前では捕まえられない bare repo の経路を塞ぐ。手順は、`/tmp/x/g/{HEAD,objects,config}` を作り、`git -C /tmp/x/g log` を実行する（security の指摘）。
- `-C <dir>` で bare repo を指す呼び出しは、K4 では自動承認から外れない（ユーザーの方針で `-C` は通す）。この経路を塞ぐのは K8 だけ。
- `GIT_DIR` などの環境変数で gitdir を明示する呼び出しは、本体の allow 規則が代入を読み飛ばさず確認に回し、2b も評価しない（K4 原則 2）。

影響の確認（research には未記載。plan の受け入れ実験で再現の記録を残す）:

- scratchpad で `GIT_CONFIG_COUNT` 経由で一時的に設定し、`git rev-parse --git-dir` を実行した。
  - 動いた: 通常の repo、その `.git` の中、サブモジュールの作業ツリー、`.git/modules/<n>`。
  - 止まった: 暗黙の bare repo（`fatal: cannot use bare repository … (safe.bareRepository is 'explicit')`）。
- このファイル自体は ask の対象。実装のときに、人間が確認する。
- global の git の挙動を変えるので、承認のときにユーザーが明示的に決める事項にする（Open Questions）。

前提と限界:

- 効くのは、`chezmoi apply` で配備済みの環境だけ。
- bare repo の経路を塞ぐのは K8 だけなので、K8 が単一障害点になる。`-C` を通すユーザーの方針は、K8 に依存している。
- K8 を無効にする経路は、フックからは自動承認されない。
  - 環境変数で無効にする経路: 本体が確認に回し、2b も評価しない（原則 2）。
  - `-c` で無効にする経路: フックの正規表現から外す（原則 1）。
- `git config --global …` で K8 を書き換える経路は、本体に allow 規則が無いので確認に回る。2b も、git が head なので評価しない（原則 2）。
- 本体の allow 規則に `Bash(git -C *)` は無い（`.settings.permissions.json:61-83` を確認）。`-C` を自動承認しているのは、2a の正規表現だけ。
- K8 が承認されない場合は、`-C` を通す方針を見直す。

参照:

- `home/dot_gitconfig.tmpl`
- git-config(1) `safe.bareRepository`

## Risks

- **R1: 本体が protected の一覧に名前を足すと、フックの迂回がその分だけ戻る。**
  - 範囲:
    - worktree の外では、`.` で始まらない名前だけが該当する。
    - worktree の内側では、足された名前すべてが該当する。
  - 対処:
    - 写した一覧（worktree の内側用）と、`.` で始まらない名前（現時点では `bunfig.toml`）を定数にする。出典（URL、取得日 2026-10-06、版 2.1.291）と、ask を使う本体の最低の版をコードのコメントに書く。
    - `.` で始まる名前は、worktree の外では構造で自動的に覆う（K2）。
- **R2: worktree の例外の判定で、fs の読み取りに失敗する。**
  - 対処: 失敗したら例外を適用しない（K3）。その結果、確認が出るだけで、書き込みは自動では通らない。
- **R3: 確認が増える。**
  - 発生する場所:
    - 本体の allow 規則が覆わない dot のパス（worktree の外）
    - 本体の Bash の allow 規則が覆わず、dot のパスを引数に含むコマンド（原則 3）
    - ask の 4 本（`~/.gitconfig*` と chezmoi の git のソースの編集は、毎回確認になる）
    - `git -c` を使う作業のうち、本体の allow 規則に当たらないもの（フックの正規表現から `-c` を外すため）
    - git が head のコマンドのうち、本体の allow 規則にもフックの静的な規則にも当たらないもの（2b が評価しないため）
  - 対処:
    - いずれも意図した挙動。
    - 受け入れ実験で、worktree の中の通常の編集と、chezmoi のソースの通常の編集に確認が出ないことを確かめる。worktree の中の `.github/` や `.gitignore` も対象。
    - 確認が頻繁に出る場所が見つかったら、フックを緩めずに、本体の allow 規則（`//` か `~/` のアンカー）を足して覆う。
- **R4: Bash の検出は字句に基づくので、回避がありうる。**
  - 回避の例: 変数展開、`cd` で語を分割する、`sh -c`、フラグ付きの `xargs`。
  - 対処:
    - 境界は本体の Bash の allow 規則と、本体の deny / ask だと明記する（K4）。
    - フラグ付きの `xargs` を介した任意のコマンドの承認（permissions.md「Wrappers」による `Bash(xargs *)` の解釈）は、git に限らない既存の問題。範囲外として記録する。
- **R5: `ignore` によるエミュレーションが、本体と食い違う。**
  - 対処:
    - docs の明文の例をテストに入れる。
    - 代表パスは、受け入れ実験で本体そのものでも確かめる（K7）。
- **R6: auto mode では、protected のうち床（deny）と ask の外にあるパスが、人間ではなく分類器に回る。** 例: `.claude/`、`.vscode/`。
  - 対処:
    - 実行につながるファイルは、deny と ask で人間側に固定する（K6）。
    - それ以外を分類器に委ねることは、受け入れる。ユーザーの回答「判定を本体に委ねる」と、本体の設計どおり。
- **R7: `safe.bareRepository=explicit` で、bare repo を暗黙に使うツールが止まる。**
  - 対処:
    - 受け入れ実験で、日常の操作が通ることを確かめる。対象は repo、worktree、サブモジュール、`chezmoi`、mise。
    - 止まるものがあれば、そのツールに `--git-dir` を明示させる。git の設定を戻すことはしない。
    - 第三者のツールで明示させられない場合は、そのツールを使う場面に限って、人間が `GIT_DIR` を付けて実行する。global の設定は戻さない。
- **R8: 受け入れ実験で、K1 の前提が崩れる。** 前提とは「PreToolUse が判定を返さず、PermissionRequest の段も控えれば、本体が確認を出す」こと。
  - 受け入れ実験（`chezmoi apply` の後、`claude -p --permission-mode default` で実施）で確かめる項目:
    - PreToolUse が hold のとき、本体が確認を出す（`-p` では拒否になる）。
    - PermissionRequest の段で 2a が `uncertain`、2b が判定なしのとき、本体の確認がそのまま残る。
    - ask の 4 本の代表パスで、確認が出る。
    - 実体のある worktree の中の通常のファイル、`.github/`、`.gitignore` には、確認が出ない。
    - chezmoi のソースの通常のファイルには、確認が出ない。
    - 読み取りだけの Bash（dot のパスを含むもの）に、確認が出ない。
    - `~/.claude/settings.json` に `ask` が入っている。
    - `claude --version` が、出典のコメントに書いた ask の最低の版以上である。
    - `-c` を含む git の呼び出しが、フックから自動承認されない（`-C` だけの形は自動承認される）。
    - 2b に届いた git が head のコマンドで、LLM が呼ばれない（decisions.jsonl に `skipped-llm:` が残る）。
  - 対処: 崩れた場合は、実装を止めて spec に戻る。たとえば PreToolUse の hold を pass ではなく ask にすることを検討する。
- **R9: 単一の入口の強制は、不変条件のテストで列挙した入力に限られる。**
  - 将来、allow を返す新しい経路をフックに足したとき、テストは自動では追従しない。
  - 対処: 受け入れる。各フックの allow を返す箇所は少なく（auto-approve の Edit 系と Bash の allow 段、2a の静的規則、2b の LLM）、plan で「allow を返す箇所はすべて `assessAutoApprovalHold` を通る」ことをコードの読みでも確かめる。
  - K4 の原則 1（正規表現の編集）と原則 2（2b の skip）は、単一の入口の外にある例外。この 2 つは、それぞれの箇所のテストで押さえる。

## Phase 1 で意図的に提供しない体験

### chezmoi のソースの一般の配布路（`dot_zshrc`、`run_*` スクリプトなど）

- **代替経路確認**:
  - `run_*` は `chezmoi apply` で実行される。`chezmoi apply` は `home/dot_claude/.settings.permissions.json:147-148` で allow されている。
  - K2 では、`.` で始まらないソースの名前に当たらない。
- **非提供対象**: git 関連以外の chezmoi のソース。
- **将来の予定**: 別の spec で扱う（ユーザーの回答で範囲外とした。research §7.5）。

### 既存の Bash の allow の過大さ（`Bash(xargs *)`、`Bash(gh config *)`、`Bash(git worktree *)`）

- **代替経路確認**:
  - `Bash(xargs *)` は、フラグ付きの `xargs` を介した任意のコマンドを承認する（permissions.md「Wrappers」、`.settings.permissions.json:60`）。
  - `Bash(gh config *)` は、`gh config set editor` などを承認する（`.settings.permissions.json:99`）。
- **非提供対象**: git の書き込み保護の外にある、Bash の allow の見直し。
  - 例: `git rebase *` や `git fetch *` などの既存の allow 規則。サブコマンドのオプションによっては、config を使わずに外部のコマンドを起動できる。
  - これは本体がコマンドの形で承認する範囲の問題なので、フックの hold では閉じない。ユーザーの判断で、別の作業にする（2026-10-06）。
- **将来の予定**: ユーザーに報告し、別の作業として扱う。

## Open Questions

承認のときにユーザーが明示的に決めること:

- **K8: global の git config に `safe.bareRepository = explicit` を入れるか。**
  - `-C` を通す方針は K8 に依存する。K8 を入れない場合は、`-C` の扱いを見直す。
  - git 全体の挙動を変える。暗黙の bare repo を開かなくなる。
  - scratchpad で確かめた範囲では、通常の repo、`.git` の中、サブモジュールは動いた。
- K4 の判定表は、2026-10-06 の相談で不要になった。K4 はフック固有の承認の根拠を絞る形に改訂した（`-C` は通す、サブコマンドのオプションは対象外）。

## ISO 25010 次元選択

- **セキュリティ（完全性）**: git の実行経路への無確認の書き込みと実行を、なくすことが目的。
- **機能適合性（正確性）**: 次の 3 点。
  - hold、worktree-content、ordinary の判定。
  - 2 つの照合器の一致。
  - worktree の中の編集と、通常の編集が、従来どおり通ること。
- **使用性（運用性）**: 確認が増える場所が R3 の範囲に収まること。
- **対象外**:
  - 性能効率性: fs の読み取りが増えるのは、K3（パスに `.git/worktree/` を含むとき）と、既存の realpath だけ。
  - 移植性: macOS だけで使っている。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘:
  - K3 と K2 の適用順が書かれていない。worktree の中は `.git` を含むので、順を誤ると全部 protected になる。
  - 「ask は PermissionRequest の allow でも消えない」と「PreToolUse の pass で本体が確認する」は、実験していない。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘:
  - git 以外の protected paths まで扱う理由（U1 の構造の欠陥）を明記していない。
  - K5 は K4 と重複していて、根拠が弱い。
  - 新しい ask と deny の当たり方を、K7 で検証すると書いていない。

### decision-quality-reviewer

- verdict: needs-work
- 主指摘:
  - 本体の一覧の写しは版が上がると古くなり、白紙案の「列挙し直さない」と矛盾する。
  - K4 は deny の列挙を Bash の語彙の列挙に置き換えただけ。
  - auto mode の分類器に委ねる部分の残余リスクを書いていない。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘:
  - 一覧の写しはドリフトの温床になる。
  - 3 つのフックに共通の判定を強制する機構（単一の入口か、不変条件のテスト）が無い。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘:
  - fs（readFile を含む）と home / chezmoi source を注入する。
  - Bash の検出は別モジュールにする。
  - 3 つのフックが使う単一の入口を lib に置く。
  - `dangerous-write-paths` との関係を明記する。`file-access-guard` は implementations にある。

### security-vulnerability-analyzer

- verdict: needs-work（blocker 級 1 件）
- 主指摘:
  - **blocker 級**: 任意の bare repo や `--git-dir` / `GIT_DIR` を経由すると、K2 にも K4 にも当たらない。
  - ask の一覧と K2 の包含関係を、テストで固定する。
  - Bash の検出は best-effort だと明記する。
  - K3 の追加条件: 逆向きのポインタの確認、`/` を含むブランチ名、physical のパスが worktree の外に出る場合。

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘:
  - `ask` はテンプレートが所有し、フックは読まないことを明記する。
  - テストの型に `ask` を足す。
  - deny の置き換えは包含関係にある（狭める範囲は無い）ことをテストで示す。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘:
  - worktree の中では、本体が `.git` の祖先でパス全体を protected と見なす。そのため dot 規則の hold は「無料」にならず、`.github/` などで毎回確認が出る。
  - dot 規則が Bash（`tee .claude/x` など）に及ばない。
  - cwd の絶対化と K2(d) が自己矛盾している。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘:
  - K8 は範囲の内側にある。ただし global の挙動を変えるので、承認のときにユーザーへの明示の確認事項にする。
  - 再現の記録と、単一障害点であることを書く。

### decision-quality-reviewer

- verdict: pass
- 主指摘:
  - 支配軸に合っている。
  - 助言として次の 3 点:
    - K8 は配備済みであることが前提。
    - K1 の前提が崩れたときの撤退条件。
    - 確認が増えたときの緩和策。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘:
  - 単一の入口の強制は、テストで列挙した範囲に限られる。これは受け入れる理由を明記する。
  - Goal の「Bash」は git に限ると補う。
  - K8 で止まる第三者のツールの扱いを書く。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘:
  - `shell-lex` に語の切り出しは無い。`bash-parser`（tree-sitter、非同期）を使い、失敗したら hold に倒す。
  - cwd は入口で解決する。ctx の組み立ては 1 つの関数にまとめる。
  - 2b は新規の追加になる。
  - `PathFs` は交差型で拡張する。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘:
  - Round 1 の blocker は閉じた。
  - high: `init` / `clone` の `--separate-git-dir` で、名前が `.` で始まらない gitdir を作れる。
  - high: config を使わない実行の形が、既存の allow（`git rebase *` など）で通る。例: `rebase -x`、`--upload-pack`、`ext::`、`grep -O`、`bisect run`、`submodule foreach`。
  - medium: `export GIT_*` や、git 以外の head に付いた `GIT_*=` が漏れる。

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘:
  - decisions.jsonl の判定の語彙は変えないと明記する。
  - 既存のテスト（`permission-auto-approve.test.ts:107-109`）は `git -c commit.gpgsign=false commit` の allow を期待しており、K4 と矛盾する。
  - 2a と 2b が判定を返さないときの下流は、実測する。

<!-- auto-review: verdict=needs-work; hash=cb2cf2d252dac757d0a19a07788fc928cdef0b542910f5bfa3e5fb117512b970; design-hash=0fff1bc2c00f8b477392dc7c19bec913bfa7d0538daecc0083fae9957c5c484e; round=1; at=2026-10-06T05:14:58.634Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: needs-work
- 主指摘:
  - worktree の内側は「フックが本体の保護を上書きする唯一の例外」だと明記する。
  - 原則 3 で読み取りのコマンドが過剰に hold されないことを、受け入れ条件にする。
  - 2a と 2b がどちらも判定を返さない場合の下流を実測する。
  - K6 の `-c` の削除と、K4 の判定表との関係を書く。

### scope-justification-reviewer

- verdict: pass
- 主指摘:
  - Open Questions の節が無い。
  - plan で必ず確定する条件（gitdir を移す呼び出し、既存の allow で通る実行の形）を 1 行足す。

### decision-quality-reviewer

- verdict: pass
- 主指摘:
  - 判定表は承認の前に必ず出す。
  - 確認が増える頻度の許容値を、plan で具体値にする。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘:
  - 構造的な ambition gap は無い。
  - 判定表の先送りと、worktree の内側の写しのドリフトは、理由を付けて受け入れる。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘:
  - `extractCommandsStructured` の返り値は文字列の配列。`SimpleCommand` が要るなら `parseBashCommand` を使い、`fallback` は hold にする。
  - `getChezmoiSourcePath` は、ソースのルートを返さない。

### security-vulnerability-analyzer

- verdict: pass（条件付き）
- 主指摘:
  - 原則どおりの判定表なら、Round 2 の high は閉じる。
  - plan で次の 4 点を受け止める。
    - repo の構造を決める呼び出しを、原則 1 の分類に入れる。
    - オプションの書き方を正規化してから照合する。
    - パスの語を取り出せないときは hold にする。
    - ask 規則の判断を必須項目にする。

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘:
  - hold を decisions.jsonl にどう記録するか、段ごとの写像表を決める。
  - PermissionRequest の段の下流を実測する。
  - K3 で、祖先の `.git` が通常のファイルでない場合の扱いを書く。

<!-- auto-review: verdict=needs-work; hash=82b1276ed50acc019af642b250273c6f18e869a739d795d8259d3ca26748986c; design-hash=2e1e8135a53a7034ee3440d887e6f12228d72507339fe93a91a0c5ba0bb73cf1; round=2; at=2026-10-06T05:20:18.981Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: needs-work（1 を直せば pass 相当）
- 主指摘:
  - K4 の冒頭と参照欄に、`extractCommandsStructured` が残っている。
  - R3 に、Bash の読み取りで確認が増える場所が書かれていない。
  - K3 の探索の打ち切りが曖昧。

### architecture-boundary-analyzer

- verdict: needs-work（軽微）
- 主指摘:
  - `errors` は、tree-sitter の構文エラーを捕まえない（`hasError` は別の経路）。
  - 予算の超過は、mark と since の 2 段で検知する。
  - `SimpleCommand` は 7 つのフィールドを持つ。
  - `.chezmoiroot` は trim する。ask 規則のパスが chezmoiSource の配下に入ることを、テストで固定する。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘:
  - ask の最低の版はコメントだけで許容できる。
  - R8 に `claude --version` の確認を 1 行足すとよい。

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=ec4f200f9604a6076ab9c5a085d8e4a0ccc959c6a0acbf7f6467aeba14659e99; design-hash=9ea368b29c28ab031a3c046817db259c0c913adc7fe34b0687bc7c1160dc203c; round=3; at=2026-10-06T05:31:31.549Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 5)

### logic-validator

- verdict: pass
- 主指摘:
  - Round 4 の 4 点は解消した。
  - K3 の打ち切りの順序は、plan で明確にするとよい。

### architecture-boundary-analyzer

- verdict: needs-work（軽微）
- 主指摘:
  - `parseForCollect` の木は `finally` で delete する。
  - `null` は打ち切りなので、打ち切りの判定を先にする。
  - mark は一連の parse の前に 1 回だけ取る。
  - 判定の条件は `bash-parser.ts:1188` と揃える。

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=0ea4442df3f216fb892497e0a3a8551aa05e8de869160963d92e6d5dec24481d; design-hash=e15a62f0eb8891db9a4ceb058640f874e039f243b33d4ceefdc6d830d3e5dbdc; round=4; at=2026-10-06T05:35:39.588Z; reviewers=logic-validator+architecture-boundary-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 6)

### logic-validator

- verdict: pass
- 主指摘:
  - 追加した段落は、K4・R4・R8 と矛盾しない。
  - plan で吸収すること:
    - `null` は、理由によらず hold にする。
    - 二重 parse の予算と、打ち切り済みの入力の短絡を併記する。
    - K3 の打ち切りの順序。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘:
  - Round 5 の 5 点は解消した。
  - plan で吸収すること:
    - `fallback` と `null` の両方を、テストで hold の条件として押さえる。
    - hold の理由を出し分けるなら、`parserGiveUpReasonSince` から導く。

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=2d24aea4288aeb38e0f0a3e9d75b49171ad597763b0e7daeb6db2ea1eb1701a1; design-hash=e15a62f0eb8891db9a4ceb058640f874e039f243b33d4ceefdc6d830d3e5dbdc; round=5; at=2026-10-06T05:40:41.254Z; reviewers=logic-validator+architecture-boundary-analyzer -->

## Reviewer Outputs (Round 7)

延長の記録: Round 7 は、承認の後にユーザーが K4 を改訂した指示によって延長した（`--extend`）。

### logic-validator

- verdict: needs-work
- 主指摘:
  - Goal、Experience Delta、K6、K7、K8 が旧 K4 の約束のまま残っている。
  - 原則 2 は 2b にしか効かない。`-C` を通すなら、bare repo の経路は K8 だけが塞ぐ。

### scope-justification-reviewer

- verdict: pass
- 主指摘:
  - 改訂後の K4 は根拠も範囲も整合している。
  - Goal、Experience Delta、K8 の記述を追従させる。

### decision-quality-reviewer

- verdict: pass
- 主指摘:
  - 判定表をやめたことは、支配軸を強めている。
  - `-C` を通すことと K8 の関係を明記するとよい。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘:
  - 自然な設計。
  - Goal の文、K8 の条件、モジュール名を直す。

### architecture-boundary-analyzer

- verdict: needs-work（軽微）
- 主指摘:
  - 原則 2 は共有の入口ではなく、2b の LLM 呼び出しの直前に置く。
  - モジュール名と図を実態に合わせる。
  - 2b の skip をログの写像表に足す。

### security-vulnerability-analyzer

- verdict: needs-work（軽微、条件付き成立）
- 主指摘:
  - K8 が `-C` を含めて単一障害点であることを明記する。
  - 原則 2 の head と `GIT_*` の設定の経路（前置、`export`、`env`、ラッパー）をテストで固定する。
  - 抽出できない語は hold にする。

### data-contract-evolution-evaluator

- verdict: needs-work（条件付き pass）
- 主指摘:
  - 2b の skip の理由の語彙を定義する。
  - テストの更新は `-C` と `-c` を併用する 110 行目を含める。`-C` だけの形は allow を維持する。
  - README の既知の限界を直す。

<!-- auto-review: verdict=pass; hash=304c1af218bb13220e1e6f234cd07779c2f695d24533b760b9c6dd2b9aceba0c; design-hash=e15a62f0eb8891db9a4ceb058640f874e039f243b33d4ceefdc6d830d3e5dbdc; round=6; at=2026-10-06T05:42:51.226Z; reviewers=logic-validator+architecture-boundary-analyzer -->
<!-- intent-triage: adopted=23; excluded=0; at=2026-10-06T05:43:28.661Z -->

## Reviewer Outputs (Round 8)

延長の記録: Round 8 は、ユーザーの「ok」（Round 7 の修正の確認）によって延長した（`--extend`）。

### logic-validator

- verdict: needs-work（軽微）
- 主指摘:
  - PreToolUse の正規表現と 2a が、`-C` 以外の大域オプションと `GIT_*` の前置を通さないことの確認が無い。
  - 2b での parse の共有の受け渡しが曖昧。
  - Experience Delta の `-C` の記述と、Open Questions の K8 の条件。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘:
  - Round 7 の指摘はすべて解消した。
  - 集計の側が `skipped-llm:` を `held:` と別に数えることを、plan で確認する。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘:
  - Round 7 の指摘は解消した。
  - ラッパーが増えても漏れない形（外せないラッパーは hold）を、実装で確かめる。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘:
  - Round 7 の 3 点は解消した。
  - README の文言は plan のタスクでよい。

### scope-justification-reviewer

- verdict: pass (carried from Round 7)
- 主指摘: Round 7 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 7)
- 主指摘: Round 7 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 7)
- 主指摘: Round 7 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=e2ddfd32d0266890f964f1b781626bb34c99be313c27a26b9d204f1051d0c1ce; design-hash=893e68b77d5112bb61247382b459af5d77716184f4d72df0a264e1fccf4f670d; round=7; at=2026-10-06T06:58:11.208Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 9)

延長の記録: Round 9 は、ユーザーの「ok」（Round 8 の修正の確認）によって延長した（`--extend`）。

### logic-validator

- verdict: pass
- 主指摘:
  - Round 8 の 6 点は解消した。
  - 軽微な修正 2 点を反映済み。
    - 88 行目の戻り値の記述を、145 行目に合わせた。
    - 2a が `-C` を伴う `config` の書き込みを allow しないことを、K7 のテストに加えた。
  - plan で吸収すること: `null` の扱い、K3 の打ち切りの順序。

### architecture-boundary-analyzer

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=0765c70bcec3d1172701e0215ddfa996874268c253de235a8f9f9937eed35d2c; design-hash=5a9523a24d2c81a77c10761c59734e085a937786c7210217047e3fb7596722a8; round=8; at=2026-10-06T07:40:43.140Z; reviewers=logic-validator+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

<!-- auto-review: verdict=pass; hash=ef5ef9c56d89055a833b6f3aaaec3fb373ac04918b2b71021b1f2fafcc2131bd; design-hash=d1cb648c67354fdc5c41e087f31d538c6e126af54940be78480a8959611b2007; round=9; at=2026-10-06T10:00:10.222Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=12; excluded=0; at=2026-10-06T10:00:28.489Z -->
