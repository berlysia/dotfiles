<!-- spec-ref: spec.md -->

# Plan 2: 3 つの hook の deny 側を `prepareDenyInput` に載せ替える

spec K3・K4・K5 の実装。plan-1（`lib/heredoc-data.ts`、`lib/deny-input.ts`）のコミットの上で行う。

## Files

```
# 編集
home/dot_claude/hooks/implementations/deny-node-modules.ts
home/dot_claude/hooks/implementations/auto-approve.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/hooks/lib/read-only-command.ts
home/dot_claude/hooks/README.md
docs/decisions/0020-boundary-deny-rephrase.md

# テスト
home/dot_claude/hooks/tests/unit/deny-node-modules.test.ts
home/dot_claude/hooks/tests/unit/auto-approve.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
home/dot_claude/hooks/tests/unit/read-only-command.test.ts
home/dot_claude/hooks/tests/unit/deny-input-adoption.test.ts

# 編集（worktree の外、main のルート、gitignore 下）
/Users/berlysia/.local/share/chezmoi/.tmp/docs/issue-boundary-deny-false-positives.md
```

## Tasks

テスト入力の削除語と `node_modules` は、plan-1 と同じく連結して作る。T1・T2 で編集するテストファイル（どちらも同名の定数を持たない。T3 のテストは使わないので足さない）の import の直後に `const R = "r" + "m -rf";` と `const P = "node" + "_modules";` を足す。

### T1: deny-node-modules

**Files:**

- 編集: `home/dot_claude/hooks/implementations/deny-node-modules.ts:6, 200-208`
- テスト: `home/dot_claude/hooks/tests/unit/deny-node-modules.test.ts`（`describe("deny-side superset (spec K3)")` の隣に `describe("data heredoc bodies (F3b)")` を足す）
- 参照: `home/dot_claude/hooks/tests/unit/deny-node-modules.test.ts:376-385`（`runBash`・`reasonOf`）

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe("data heredoc bodies (F3b)", () => {
  const silent = [
    `cat <<'EOF' > out.txt\n${R} ${P}/x\nEOF`,
    `tee out.txt <<'EOF'\n${R} ${P}/x\nEOF`,
    `cat > .tmp/msg.txt <<'EOF'\nfix: ${R} ${P}/x\nEOF`,
    `cat -<<'EOF' > out.txt\n${R} ${P}/x\nEOF`, // "-" folded into the operator
    `cat <<'EOF' > t.ts\nfind ${P} -delete\nEOF`,
    `cat <<'EOF' > out.txt\nsee ${P} for details\nEOF`, // was ask
  ];
  for (const cmd of silent) {
    it(`does not judge the body: ${JSON.stringify(cmd)}`, async () => {
      (await runBash(cmd)).assertSuccess({});
    });
  }
  const denied = [
    `cat <<'EOF' > ${P}/x\nhello\nEOF`, // the target is still judged
    `bash <<'EOF'\n${R} ${P}/x\nEOF`,
    `python3 - <<'EOF'\n# ${R} ${P}/x\nEOF`,
    `cat <<'EOF' | bash\n${R} ${P}/x\nEOF`,
    `cat > >(sh) <<'EOF'\n${R} ${P}/x\nEOF`,
    // $(…) bodies stay judged: bash 3.2 cuts $(…) by paren matching (spec K2 (d))
    `git commit -m "$(cat <<'EOF'\nfix: ${R} ${P}/x\nEOF\n)"`,
    // The commit / PR path is a separate spec; git and gh are not consumers.
    `git commit -F - <<'EOF'\nfix: ${R} ${P}/x\nEOF`,
    // An option folded into the << token keeps the body (spec K2 (a)).
    `cat -n<<'EOF' > out.txt\n${R} ${P}/x\nEOF`,
  ];
  for (const cmd of denied) {
    it(`still denies: ${JSON.stringify(cmd)}`, async () => {
      (await runBash(cmd)).assertDeny();
    });
  }
});
```

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/deny-node-modules.test.ts`
期待: `silent` の 6 件が FAIL（deny または ask が返る）、`denied` の 8 件は PASS（`cat -n<<` の行は本文が残るので従来どおり deny）

- [ ] **Step 2: 最小実装を書く**

`analyzeBashCommand` の先頭を次にする。`extractCommandsStructured` の import を外し、`prepareDenyInput` を import する。

```ts
// Deny-side reads go through prepareDenyInput: data-only heredoc bodies are
// emptied in both the whole text and the fragments (spec K1).
const { maskedText, individualCommands, parsingMethod } =
  await prepareDenyInput(command);
const commands = individualCommands;
// Judged once on the whole command; fragments only inherit the result.
const readOnlyExempt = isExemptReadOnlyCommand(maskedText, { parsingMethod });
```

- [ ] **Step 3: テストを実行して通過を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/deny-node-modules.test.ts` → 期待: 新旧すべて PASS（既存テストを変更しない）

- [ ] **Step 4: コミット** — `fix(hooks): stop deny-node-modules from judging data heredoc bodies`

### T2: auto-approve の deny 段

**Files:**

- 編集: `home/dot_claude/hooks/implementations/auto-approve.ts:8, 372-396`
- テスト: `home/dot_claude/hooks/tests/unit/auto-approve.test.ts`（`processBashTool` の既存 describe の隣）
- 参照: `home/dot_claude/hooks/tests/unit/auto-approve.test.ts:281-297`（`processBashTool` を直接呼ぶ書き方）

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe("data heredoc bodies on the deny stage (F3b)", () => {
  const typesOf = async (
    command: string,
    deny: string[] = [],
    allow: string[] = [],
  ) =>
    (await processBashTool({ command }, deny, allow, "/tmp")).commands.map(
      (c) => c.type,
    );

  it("does not run the home guard on a data body", async () => {
    const types = await typesOf(`cat <<'EOF' > t.ts\n${R} $HOME/x\nEOF`);
    ok(!types.includes("deny"), JSON.stringify(types));
  });
  it("does not ask for a force push written in a data body", async () => {
    const types = await typesOf(
      `cat > f.txt <<'EOF'\ngit push --force origin main\nEOF`,
    );
    ok(
      !types.includes("ask") && !types.includes("deny"),
      JSON.stringify(types),
    );
  });
  it("matches user deny rules on the emptied fragments", async () => {
    const data = await typesOf(`cat <<'EOF' > f.txt\nrm x\nEOF`, [
      "Bash(rm *)",
    ]);
    ok(!data.includes("deny"), JSON.stringify(data));
    const shell = await typesOf(`bash <<'EOF'\nrm x\nEOF`, ["Bash(rm *)"]);
    ok(shell.includes("deny"), JSON.stringify(shell));
  });
  it("still denies the home guard on a shell body", async () => {
    const types = await typesOf(`bash <<'EOF'\n${R} $HOME/x\nEOF`);
    ok(types.includes("deny"), JSON.stringify(types));
  });
  it("never allows a heredoc input (spec K4)", async () => {
    for (const command of [
      `cat <<'EOF' > out.txt\n${R} ${P}/x\nEOF`,
      `cat -<<'EOF' > out.txt\nmsg\nEOF`,
      `tee out.txt <<'EOF'\nx\nEOF`,
    ]) {
      // With allow rules that would match cat / tee, so a split of the
      // emptied text into allowable fragments would show up here.
      const types = await typesOf(command, [], ["Bash(cat *)", "Bash(tee *)"]);
      ok(!types.includes("allow"), `${command}: ${JSON.stringify(types)}`);
    }
  });
});
```

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/auto-approve.test.ts`
期待: 最初の 2 件と 3 件目の前半が FAIL、残りは PASS

- [ ] **Step 2: 最小実装を書く**

`processBashTool` の `checkHomeDestruction` の前で `prepareDenyInput(bashCommand)` を呼び（従来の `extractCommandsStructured` と同じ位置で呼ぶので、throw したときは同じく呼び出し元へ reject が伝わり、hook の catch が deny する。`maskDataHeredocBodies` は parse の失敗を握りつぶすので、throw しうるのは従来と同じ `extractCommandsStructured` の部分だけ。既存の「deny 段が throw したら reject」のテスト〔`auto-approve.test.ts:299-308`〕が覆うのは classify 段で、この呼び出しではない）、`checkHomeDestruction(maskedText, …)`、`individualCommands` / `parsingMethod`、`isExemptReadOnlyCommand(maskedText, …)` に置き換える。`scanSafeList(bashCommand)` は原文のまま残し（`denyTargets` に足す `scanSafeList` の単純コマンドも原文由来のまま。spec K3）、コメントに「allow の根拠は原文の分割だけ（F3a K1）。deny 側は prepareDenyInput の maskedText と断片を読む（F3b）」と書く。deny を返すときの `command` フィールド（理由に出る原文）は `bashCommand` のまま。`extractCommandsStructured` の import を外す

- [ ] **Step 3: テストを実行して通過を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/auto-approve.test.ts home/dot_claude/hooks/tests/unit/safe-command-list.test.ts home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts`
期待: 新旧すべて PASS。F3a の allow 側の既存テスト（spec R6）は変更しない

- [ ] **Step 4: コミット** — `fix(hooks): read emptied data heredoc bodies on the auto-approve deny stage`

### T3: document-workflow-guard

**Files:**

- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:6, 559-581`
- テスト: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`（`allows a heredoc Bash write to a handoff note before plan approval` の隣）
- 参照: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts:1282-1292`（Gate 閉時の heredoc 書き込みのテスト）

- [ ] **Step 1: 失敗するテストを書く**

```ts
it("does not read write targets in a data heredoc body before plan approval (F3b)", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const context = createPreToolUseContextFor(hook, "Bash", {
    command: `cat > ${join(repo, TEST_WORKFLOW_DIR, "NEXT-SESSION.md")} <<'EOF'\nthen run: echo x > src/a.ts\nEOF`,
  });
  await invokeRun(hook, context);
  context.assertSuccess({});
});

it("still denies the write target of a data heredoc before plan approval (F3b)", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const context = createPreToolUseContextFor(hook, "Bash", {
    command: `cat > src/a.ts <<'EOF'\nexport const x = 1;\nEOF`,
  });
  await invokeRun(hook, context);
  context.assertDeny();
});

it("still checks an interpreter heredoc body before plan approval (F3b)", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const context = createPreToolUseContextFor(hook, "Bash", {
    command: `python3 - <<'EOF'\nopen('src/a.ts', 'w').write('x')\nEOF`,
  });
  await invokeRun(hook, context);
  context.assertDeny();
});
```

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`
期待: 1 件目が FAIL（本文中の `src/a.ts` が書き込み先と判定されて deny）、2 件目（書き込み先そのものの deny）と 3 件目は PASS

- [ ] **Step 2: 最小実装を書く**

`analyzeBashWrite` の `extractCommandsStructured(command)` を `prepareDenyInput(command)` に替え、`individualCommands` を使う。import を差し替える

- [ ] **Step 3: テストを実行して通過を確認** — 新旧すべて PASS

- [ ] **Step 4: コミット** — `fix(hooks): stop document-workflow-guard from reading targets in data heredoc bodies`

### T4: 入口の適用漏れを検出するテストと `isExemptReadOnlyCommand` の JSDoc

**Files:**

- テスト: `home/dot_claude/hooks/tests/unit/deny-input-adoption.test.ts`（新規）
- 編集: `home/dot_claude/hooks/lib/read-only-command.ts:79-84`（`isExemptReadOnlyCommand` の JSDoc）
- テスト: `home/dot_claude/hooks/tests/unit/read-only-command.test.ts`
- 参照: `home/dot_claude/hooks/tests/unit/destructive-verbs-drift.test.ts`（ソースを読んで同期を検査する既存のテストの書き方）

- [ ] **Step 1: テストを書く**

```ts
#!/usr/bin/env node --test
import { ok } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const IMPL = join(import.meta.dirname, "../../implementations");
const DENY_HOOKS = [
  "deny-node-modules.ts",
  "auto-approve.ts",
  "document-workflow-guard.ts",
];
// Hooks that may read Bash fragments without prepareDenyInput, each with the
// reason. Empty today: only the three deny-side hooks split Bash commands.
const RAW_FRAGMENT_READERS: Record<string, string> = {};

describe("deny-side hooks read Bash through prepareDenyInput (spec K1)", () => {
  for (const file of DENY_HOOKS) {
    const source = readFileSync(join(IMPL, file), "utf8");
    it(`${file} imports prepareDenyInput`, () => {
      ok(
        /import \{[^}]*\bprepareDenyInput\b[^}]*\} from "\.\.\/lib\/deny-input\.ts"/.test(
          source,
        ),
      );
    });
  }
  // The identifier shows up in a static import, through the command-parsing.ts
  // re-export, and in a dynamic import() alike, so a fourth hook that starts
  // splitting Bash on its own fails here.
  for (const file of readdirSync(IMPL).filter((name) => name.endsWith(".ts"))) {
    if (file in RAW_FRAGMENT_READERS) continue;
    const source = readFileSync(join(IMPL, file), "utf8");
    it(`${file} does not reach extractCommandsStructured or heredoc-data`, () => {
      ok(
        !/\bextractCommandsStructured\b/.test(source),
        "extractCommandsStructured",
      );
      ok(!source.includes("heredoc-data"), "heredoc-data");
    });
  }
});
```

`read-only-command.test.ts` に、本文を空にした入力で除外が増えないことの表を足す:

```ts
it("does not exempt an emptied heredoc input (F3b)", () => {
  for (const text of [
    "cat <<'EOF' > out.txt\nEOF",
    "cat <<'EOF'\nEOF",
    "tee out.txt <<'EOF'\nEOF",
    "cat -<<'EOF' > out.txt\nEOF",
  ]) {
    strictEqual(
      isExemptReadOnlyCommand(text, { parsingMethod: "tree-sitter" }),
      false,
      text,
    );
  }
});
```

- [ ] **Step 2: JSDoc を更新する**

`isExemptReadOnlyCommand` の JSDoc の 1 文目の後に足す: 「deny 側の hook は `prepareDenyInput` の `maskedText`（データだけの heredoc の本文を空にした全文）を渡す。本文を空にしても heredoc を含む入力は除外されない」

- [ ] **Step 3: テストを実行して通過を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/deny-input-adoption.test.ts home/dot_claude/hooks/tests/unit/read-only-command.test.ts` → 期待: PASS。どちらも T1〜T3 の後に書く特性固定のテストで、Red は観測しない（adoption の検査は、以後 4 つ目の hook が断片の抽出を直接使い始めたときに落ちるためのもの）

- [ ] **Step 4: コミット** — `test(hooks): pin that deny-side hooks read Bash through prepareDenyInput`

### T5: 文書（README、ADR-0020 の追記、issue 記録）

**Files:**

- 編集: `home/dot_claude/hooks/README.md:94`（deny / ask の項）
- 編集: `docs/decisions/0020-boundary-deny-rephrase.md`（Consequences）
- 編集（worktree の外、main のルート）: `/Users/berlysia/.local/share/chezmoi/.tmp/docs/issue-boundary-deny-false-positives.md`
- 参照: spec K3・K5・R1

- [ ] **Step 1: README** — 94 行目の行頭「`lib/bash-parser.ts` の `extractCommandsStructured` の断片に当てる」を「`lib/deny-input.ts` の `prepareDenyInput`（内部で `extractCommandsStructured`）の断片に当てる」に直し、同じ行の「上位集合なので、heredoc の本文やサブシェルの全文の綴りで deny になる誤検知がある」を次の内容に置き換える（条件の詳細は ADR に置き、README には書かない）: deny 側の hook（deny-node-modules・auto-approve の deny 段・document-workflow-guard）は `prepareDenyInput` を通して読み、cat / tee がデータとして書くだけの heredoc の本文を空にしてから判定する。条件は `lib/heredoc-data.ts` と ADR-0020 の追記（F3b）にあり、判定できない形は本文を残す側に倒している。サブシェルなど複合文の全文の綴りによる誤検知は残る。ほかの hook と LLM evaluator は本文を含む全文を読む
- [ ] **Step 2: ADR-0020** — Consequences の旧文「誤検知は残る」（36 行目）を直す。括弧の中の heredoc ではない例（`git commit -m "find -delete" node_modules` など）は消さずに残し、heredoc の本文の部分だけを「cat / tee の本文は F3b で解消、commit / PR の本文は残る（別の spec）」に分ける。41 行目の「heredoc の本文が誤検知されることを…別の Issue として扱う」も、cat / tee の範囲は F3b で解消したことと追記への参照を書く形に直す。そのうえで「追記（F3b、2026-10-02）」を足す。追記は README を参照せず ADR の中で完結させる。内容: (1) 本文を空にする範囲を書き下す（消費者 cat / tee、parser は構造と範囲にだけ使い隣接するトークンは綴りで比べるという不変条件、区切りの綴り・出力先・祖先の条件の要約）と、本文の綴りに当たり続ける hook の一覧。commit / PR の本文を扱わない理由（`$(cat <<…)` 形は bash 3.2 の括弧対応による切り出しで本文の一部が実行され、stdin 形は git / gh の選択肢・設定・hook を通す経路があるので別の spec で扱う）。K2 (f) は、消費者とそれより前の文を、受け入れるノードの種類の閉じた許可リストと builtin 名の閉じた一覧で判定し、不活性なものだけを受け入れること。前提は builtin の一覧の版（bash 3.2.57・zsh 5.9）と、tree-sitter が構文の種類をノードの種類として報告することで、シェルの版を上げるときは一覧を取り直すこと。一覧に足すときは `reason` を書き、この追記にも足すこと。(2) 対象外として受容した類を 2 項目に分ける。Write ツール経由と同じ水準のもの（改行の後の文で実行、本文を保存してから実行）と、1 回の入力で書きと実行がそろうので一段弱いもの（先行する文と同時に実行する名前付きパイプ、外部コマンドや Write ツールで PATH 上に `cat` / `tee` という名前の実行ファイルを置き、その後の cat / tee の本文を実行させる形）。(3) この受容は LLM evaluator と適用しない hook が全文を読むことを前提にし、後段にも空にした入力を渡すときは再評価する。(4) R6 の「2 例目の綴りによる回避」を数えるとき、これらの経路の観測も含める。(5) F3b は R6 の再検討には当たらない（観測は誤検知で、分類規則を変えない）
- [ ] **Step 3: issue 記録** — F3 の節に「F3b で対応（branch `fix/heredoc-body-deny-false-positive`。PR を作った後に番号を追記する）」と、K3 の file-access-guard の follow-up（本文の `cat /etc/x` などで当たりうる構造、観測されたら `prepareDenyInput` の `maskedText` を渡す）と、本 session でユーザーが別 follow-up にした 3 件（heredoc commit の allow、リダイレクト付き複合文の丸ごとの断片、commit / PR 本文の経路の別 spec。最後のものには spec「提供しない体験」の将来の予定と、Round 5・6 の実測の要点 — `-e` と `GIT_EDITOR`、`-e<<` の演算子への取り込み、`.git/hooks/prepare-commit-msg` が `--no-verify` でも動くこと — を書く）を追記する。worktree の外への書き込みが hook に拒否されたら、言い換えずに止まり、追記する文面をユーザーに渡す
- [ ] **Step 4: コミット**（README と ADR のみ。issue 記録は gitignore 下） — `docs(hooks): describe how deny-side hooks read data heredoc bodies`

### T6: 全体の確認

- [ ] 実行: `bun run typecheck && bun run test && bun run lint:oxlint && bun run format:check`（リポジトリのルートで）
- [ ] 期待: すべて PASS。F3a の allow 側のテスト（`safe-command-list.test.ts`・`auto-approve.test.ts`・`permission-auto-approve.test.ts` の既存ケース）は差分なし（`git diff master -- <3 ファイル>` で追加の行だけ）
- [ ] 実 hook での再判定の手順: session の scratchpad に `probe.ts` を置き、worktree の `home/dot_claude/hooks/implementations/deny-node-modules.ts` と `auto-approve.ts` を import して、既存テストと同じ呼び方（deny-node-modules は `deny-node-modules.test.ts` の `runBash`、auto-approve は `processBashTool(input, deny, allow, cwd)`。deny / allow は `~/.claude/settings.json` の `permissions` をそのまま渡す）で入力ごとの判定（deny / ask / allow / 無判定）を出力する。`bun <probe.ts の絶対パス>` で実行する
- [ ] 入力は research §2 の表の全行。太字の誤検知のうち cat / tee の形の行が無判定に、`git commit -m "$(cat <<'EOF' …)"` の行とそれ以外が従来どおりであることを、「入力の 1 行目・変更前・変更後」の 3 列の表にして PR 本文に載せる。変更前の値は master の hook を同じ probe で読んだもの
- [ ] 同じ probe で `cat <<'EOF' > .tmp/msg.txt` ⏎ 本文（削除語と `node_modules`）⏎ `EOF` ⏎ `git commit -F .tmp/msg.txt` を deny-node-modules と auto-approve に通し、本文に由来する deny / ask が出ないことを確かめて PR 本文に載せる（spec「提供しない体験」の代替経路）

## ISO 25010 具体テストケース

### 機能適合性（機能正確性）

- **入力**: deny-node-modules に `cat <<'EOF' > out.txt` ⏎ `rm -rf node_modules/x` ⏎ `EOF` → **期待**: 何も返さない（変更前は deny）
- **入力**: deny-node-modules に `cat <<'EOF' > out.txt` ⏎ `see node_modules for details` ⏎ `EOF` → **期待**: 何も返さない（変更前は ask）
- **入力**: auto-approve の deny 段に `cat <<'EOF' > t.ts` ⏎ `rm -rf $HOME/x` ⏎ `EOF` → **期待**: deny が無い（変更前は home guard の deny）
- **入力**: Gate 閉時の document-workflow-guard に、本文に `> src/a.ts` を含む handoff note への `cat >` heredoc → **期待**: 何も返さない

### セキュリティ（完全性）

- **入力**: deny-node-modules に `cat <<'EOF' > node_modules/x` → **期待**: deny（書き込み先の判定は残る）
- **入力**: deny-node-modules に `bash <<'EOF'` / `python3 - <<'EOF'` / `cat <<'EOF' | bash` / `cat > >(sh) <<'EOF'`（本文に `rm -rf node_modules/x`） → **期待**: deny
- **入力**: auto-approve に heredoc を含む 3 入力と allow ルール `Bash(cat *)`・`Bash(tee *)` → **期待**: どれも allow を含まない（spec K4）
- **入力**: auto-approve に `bash <<'EOF'` ⏎ `rm x` ⏎ `EOF` と deny ルール `Bash(rm *)` → **期待**: deny
- **入力**: Gate 閉時の document-workflow-guard に `python3 - <<'EOF'` ⏎ `open('src/a.ts', 'w')…` → **期待**: deny

### 保守性（修正性）

- **入力**: 3 つの hook のソース → **期待**: `prepareDenyInput` を import する
- **入力**: `implementations/*.ts` の全ソース（`RAW_FRAGMENT_READERS` を除く） → **期待**: 識別子 `extractCommandsStructured` と `heredoc-data` を含まない（静的 import・`command-parsing.ts` 経由・動的 `import()` のどれでも落ちる）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: K4 のテストが allow ルールを渡しておらず allow を検出できない。T6 の「plan-1 と同じ probe」の参照先が無い。T5 の PR 番号が未確定。テスト定数 R・P の置き場所が空振りする。README が空にする範囲を広く読ませる。T4 は Red を観測しない順序（反映済み: allow ルール `Bash(cat *)`・`Bash(tee *)` を渡す、probe の手順と表の形を T6 に書く、PR 作成後に追記、各テストファイルに定数を足す、README に残す側に倒すことを書く、T4 は特性固定と明記）

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: T6 の参照先が無い、Files に worktree の外の issue 記録が無い、README の置換文が ADR と二重管理になる（反映済み: README は入口と ADR への参照だけにした）

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 の 7 点は反映済み（`processBashTool` の引数、置換対象の行番号、走査テストの前提を実コードで確認）。軽微: T3 のテストは R・P を使わないので定数を足すのは T1・T2 だけにする、`prepareDenyInput` の throw の記述を「従来と同じ位置・同じ伝播」に直す、README 94 行目の行頭の `extractCommandsStructured` も直す（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 1 の 3 件は解消。軽微: README に (f) の要約が残っていて ADR と二重管理になりうる（反映済み: 削った）。T4 のコミットに `lib/` の JSDoc 編集が入る点は型の選び方の問題で、このままとする

<!-- auto-review: verdict=needs-work; hash=182854d4269a54d072edda595768db7151e1a640feff577bd7098f8a89880b97; design-hash=9fbc788ac8f9000db7fa86a9ea6c73a51803bd3cee0d9a3a1e0bf8013f78a153; round=1; parent-spec-hash=6da0539b31f531a826332124d7c73cb6d4cec43e82b58e039287450f29b87c82; at=2026-10-02T07:17:07.809Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=9; excluded=0; at=2026-10-02T07:17:07.832Z -->

<!-- auto-review: verdict=pass; hash=2062ea5ff047e56d994e7a56cebd34ca969f6b875014a8ef2c296784fd10f365; design-hash=c1838f6aedfcdecda3a131fe256de4d5cf65b51d9a70a193016b404e2ed632c3; round=2; parent-spec-hash=6da0539b31f531a826332124d7c73cb6d4cec43e82b58e039287450f29b87c82; at=2026-10-02T07:19:16.980Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=5; excluded=0; at=2026-10-02T07:19:17.001Z -->
