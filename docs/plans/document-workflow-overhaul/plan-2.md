<!-- spec-ref: spec.md -->

# Plan 2: Bash 経路の対称化と tripwire (Execution layer)

spec の K1（`workflow-bash-sync` dispatcher と per-doc cache）/ K2（tripwire）/ K3（interpreter 書込の事前 deny、`ln` 追加）を実装する。plan-1（lib 層）の承認・実装後に着手する。

## Files

```
# 新規作成
home/dot_claude/hooks/implementations/workflow-bash-sync.ts
home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts
home/dot_claude/hooks/tests/unit/interpreter-write-classify.test.ts

# 編集
home/dot_claude/hooks/lib/workflow-review-core.ts
home/dot_claude/hooks/lib/workflow-paths.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts
home/dot_claude/hooks/tests/unit/test-helpers.ts
home/dot_claude/.settings.hooks.json.tmpl
home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts
```

**テスト scaffolding（architecture plan Round 1）**: 本 plan の新テストが使う helper は、使用前に `test-helpers.ts` へ実体を追加する。`createPostToolUseContextFor` の overrides に `agent_id` を受け、PostToolUse **input** の `agent_id` に載せる（`tool_response` スロットではない）。4 番目の `tool_response` 引数はデフォルト `{}` を与え省略可能にする。`draftPlanRepo`（plan.md を draft で置く repo fixture）と `createGitWorkflowRepo`（`git init` + research.md/plan.md の repo fixture）を新設する。`createWorkflowRepo` / `pendingWorkflowRepo` は plan-1 T4 で export 済みのものを import する。

## Tasks

### T1: per-doc cache 形状に移行する

**Files:**

- 編集: `home/dot_claude/hooks/lib/workflow-review-core.ts`（plan-1 T5 で cache 入出力を移設済み）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
- 参照: `plan-review-automation.ts:745-763`（`readCache`、現 `{planHash, recommendedAt}` 形状）
- 参照: `lib/workflow-paths.ts:136-154`（`resolveWorkflowPaths`、cache は wfDir に 1 ファイル）

- [ ] **Step 1: 失敗するテストを書く**

cache が `{ [docName]: { planHash, recommendedAt, summaryRemindedHash?, fullTextEmittedForRound? } }` を読み書きし、spec.md と plan-1.md が別エントリになること、旧形状（トップレベル `planHash`）を読んだら空として扱う（migration 不要、次回書込で新形状）ことを固定する。

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readDocCache, writeDocCache } from "../../lib/workflow-review-core.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("per-doc cache keeps spec and plan entries separate", () => {
  const wf = mkdtempSync(join(tmpdir(), "cache-"));
  writeDocCache(wf, "spec.md", { planHash: "aaa", recommendedAt: "t1" });
  writeDocCache(wf, "plan-1.md", { planHash: "bbb", recommendedAt: "t2" });
  assert.equal(readDocCache(wf, "spec.md")?.planHash, "aaa");
  assert.equal(readDocCache(wf, "plan-1.md")?.planHash, "bbb");
});

test("legacy top-level cache shape reads as empty", () => {
  const wf = mkdtempSync(join(tmpdir(), "cache-"));
  writeFileSync(
    join(wf, "plan-review.cache.json"),
    JSON.stringify({ planHash: "old", recommendedAt: "t" }),
  );
  assert.equal(readDocCache(wf, "spec.md"), null);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
期待: FAIL "readDocCache is not a function"

- [ ] **Step 3: 最小実装を書く**

`readDocCache(wfDir, docName)` / `writeDocCache(wfDir, docName, state)` を core に追加。ファイルは従来通り `resolveWorkflowPaths(wfDir).reviewCache` の 1 ファイルだが、中身を `{ [docName]: CacheState }` にする。トップレベルに `planHash` がある旧形状は「エントリ無し」として読む（`docName in parsed` が false）。`canSkip` は `readDocCache(wfDir, docName)` を使うよう変更。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-review-core.ts home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts
git commit -m "feat(hooks): key the review cache per document"
```

### T2: `workflow-bash-sync.ts` を作る（agent_id gate + hash 差分ディスパッチ）

**Files:**

- 新規: `home/dot_claude/hooks/implementations/workflow-bash-sync.ts`
- テスト: `home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts`
- 参照: `home/dot_claude/hooks/lib/workflow-review-core.ts`（`canSkip` / `buildRecommendation` / placeholder 走査 / `readDocCache`）
- 参照: `lib/workflow-resolve.ts:84-89`（`resolveWorkflowDir`、session_id + cwd）
- 参照: `command-logger.ts`（PostToolUse Bash hook の定義形の実例）
- 参照: `tests/unit/test-helpers.ts:303`（`createPostToolUseContextFor`）, `:60`（`TEST_SESSION_ID`）

- [ ] **Step 1: 失敗するテストを書く**

(a) `context.input.agent_id` があれば即 success（何も注入しない）。(b) 親ループで wfDir 内 plan.md の hash が cache と変わっていれば `buildRecommendation` 相当を additionalContext に載せる。(c) wfDir が unresolvable なら 1 行 notice のみ。

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import hook from "../../implementations/workflow-bash-sync.ts";
import {
  createPostToolUseContextFor,
  invokeRun,
  TEST_SESSION_ID,
} from "./test-helpers.ts";

test("early-returns for subagent-originated Bash (agent_id present)", async () => {
  const ctx = createPostToolUseContextFor(
    hook,
    "Bash",
    { command: "echo hi" },
    { agent_id: "sub-1" },
  );
  await invokeRun(hook, ctx);
  assert.equal(ctx.jsonCalls.length, 0);
  ctx.assertSuccess();
});

test("emits recommendation when a wfDir plan hash changed (main loop)", async () => {
  const repo = createWorkflowRepo(draftPlanRepo()); // plan.md present, hash not cached
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const ctx = createPostToolUseContextFor(hook, "Bash", {
    command:
      "python3 - <<'PY'\nopen('.tmp/sessions/test-ses/plan.md','a').write('x')\nPY",
  });
  await invokeRun(hook, ctx);
  const inj =
    ctx.jsonCalls.at(-1)?.output?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(inj, /plan-review-automation/);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts`
期待: FAIL "Cannot find module '../../implementations/workflow-bash-sync.ts'"

- [ ] **Step 3: 最小実装を書く**

`defineHook({trigger:{PostToolUse:true}, ...})`。手順: `if (context.input.agent_id) return context.success({})` → `resolveWorkflowDir`（unresolvable なら 1 行 notice で return）→ wfDir 内の spec.md / plan.md / plan-\*.md を列挙 → 各文書で `computeDocumentHash` を取り `canSkip(readDocCache(...), hash, marker)` が false のものについて `buildRecommendation` を集約して 1 つの additionalContext に load。K2 の tripwire は T4 で同 hook に足す。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/workflow-bash-sync.ts home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts
git commit -m "feat(hooks): detect Bash-path workflow-doc edits via content hash"
```

### T3: interpreter inline-script の書込を事前 deny する（K3）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:610-690`（Bash 分類器）
- テスト: `home/dot_claude/hooks/tests/unit/interpreter-write-classify.test.ts`
- 参照: `document-workflow-guard.ts:100-131`（対象不明 write-like を deny する既存前例）
- 参照: `lib/workflow-fs.ts:68-87`（`isStrictlyUnderProjectSubdir`、segment 境界比較の実装）

- [ ] **Step 1: 失敗するテストを書く**

gate 閉時、(a) `python3 -c "open('src/x.ts','w').write(...)"` は deny（書込指標 + scratch 外 path）、(b) `python3 -c "print(open('src/x.ts').read())"` は allow（読取のみ）、(c) `node -e "fs.writeFileSync('/tmp/probe','x')"` は allow（scratch 内）、(d) `python3 -c "open('/tmpx/e','w')"` は deny（`/tmpx` は `/tmp` の segment 外）。

```ts
test("denies interpreter write to a non-scratch path while gate closed", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const ctx = createPreToolUseContextFor(hook, "Bash", {
    command: `python3 -c "open('src/x.ts','w').write('h')"`,
  });
  await invokeRun(hook, ctx);
  ctx.assertDeny();
});
test("allows interpreter write confined to /tmp", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const ctx = createPreToolUseContextFor(hook, "Bash", {
    command: `node -e "require('fs').writeFileSync('/tmp/probe','x')"`,
  });
  await invokeRun(hook, ctx);
  ctx.assertSuccess();
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/interpreter-write-classify.test.ts`
期待: FAIL（現状 interpreter は write-like と判定されず allow）

- [ ] **Step 3: 最小実装を書く**

`analyzeSingleCommand` に interpreter 検出を追加: コマンド名が `python|python3|node|bun|deno` で引数に `-c`/`-e`/`-p`/`-`/`eval` か heredoc がある場合、スクリプト本文（heredoc body / `-c` 引数）を走査し、(a) 書込指標 regex 群にヒットし、かつ (b) 抽出した文字列リテラル path が「scratch root の segment 境界内」に全て収まるとは言えない場合、`isWriteLike=true` かつ `targets=[]` として既存の「対象不明 write-like は deny」経路（`:100-131`）に載せる。scratch 判定は `p === root || p.startsWith(root + "/")` で `..` 含有は即 unprovable。wfDir 配下は scratch から除外。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/interpreter-write-classify.test.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts 2>&1 | tail -20`
期待: PASS（新ケース + guard 既存ケース不変）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/tests/unit/interpreter-write-classify.test.ts
git commit -m "feat(hooks): conservatively deny interpreter inline-script writes outside scratch"
```

### T4: tripwire を `workflow-bash-sync` に足す（K2）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/workflow-bash-sync.ts`（T2 の hook に追加）
- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:657-677`（write-like 一覧に `ln`）, `:489-501`（`appendOffPlanLog` を `O_NOFOLLOW`）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts`
- 参照: `document-workflow-guard.ts:432-469`（`isImplementationPhase`）
- 参照: `lib/sanitize-display.ts:1-33`
- 参照: `lib/workflow-fs.ts:18-32`（`realpathInsideWorkflowDir`）

- [ ] **Step 1: 失敗するテストを書く**

(a) gate 閉 + repo 内に git diff がある状態で、baseline に無い変更 path を `off-plan-writes.log` に記録し additionalContext で告知。(b) baseline 欠落時は「再武装した」を告知。(c) `git` 不在で `.tripwire-disabled` を作り 1 回だけ notice。(d) baseline ファイルが symlink なら書込拒否。fixture の `git` は temp repo を `git init` して用意。

```ts
test("reports repo changes not in the baseline while gate closed", async () => {
  const repo = createGitWorkflowRepo(pendingWorkflowRepo()); // git init + research.md/plan.md
  envHelper.set("CLAUDE_TEST_CWD", repo);
  writeFileSync(join(repo, "src", "leaked.ts"), "x"); // gate-closed write
  const ctx = createPostToolUseContextFor(hook, "Bash", { command: "true" });
  await invokeRun(hook, ctx);
  const inj =
    ctx.jsonCalls.at(-1)?.output?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(inj, /src\/leaked\.ts/);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts`
期待: FAIL（tripwire 未実装）

- [ ] **Step 3: 最小実装を書く**

`workflow-bash-sync` に、gate 閉（`isImplementationPhase` 偽）かつ親ループのときのみ: `execFile("git", ["--no-optional-locks","-C",cwd,"-c","core.fsmonitor=","status","--porcelain=v1","-z","-uall"])`（200ms timeout、`git` 不在で `.tripwire-disabled` を理由付きで作成し 1 回 notice）→ `<wfDir>/.tripwire-baseline`（`O_NOFOLLOW|O_CREAT|O_WRONLY`、`lstat` で symlink 拒否）と比較 → baseline 欠落なら「再武装」notice + 保存 → wfDir 外の追加・変更 path を diff し `appendOffPlanLog(tool="Bash-tripwire")`（重複除去、200 行 cap）+ `sanitizeForDisplay` で最大 10 件 + N more を告知。guard の write-like 一覧に `ln` を追加、`appendOffPlanLog` を `O_NOFOLLOW` 書込に硬化。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts 2>&1 | tail -20`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/workflow-bash-sync.ts home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts
git commit -m "feat(hooks): tripwire gate-closed repo writes with a rolling git baseline"
```

### T5: 新 hook 2 本を settings に登録し drift テストを通す

**Files:**

- 編集: `home/dot_claude/.settings.hooks.json.tmpl`（PostToolUse に `workflow-bash-sync`（matcher `Bash`）と `reviewer-run-recorder`（matcher `Agent`、plan-3 T で実体を作るがここで配線だけ確保する場合は plan-3 側に回す）を追加。本 plan では `workflow-bash-sync` のみ登録し、`reviewer-run-recorder` は plan-3 で登録する）
- テスト: `home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts`（既存、tmpl 参照名と実ファイルの一致を検査）
- 参照: `home/dot_claude/.settings.hooks.json.tmpl:117`（PostToolUse Write|Edit グループ）, `:135-160`（PostToolUse Bash グループ、async 群）
- 参照: `tests/unit/hook-target-drift.test.ts:18`（`REF` regex）

- [ ] **Step 1: 失敗するテストを書く**

`hook-target-drift.test.ts` は既存で「tmpl が参照する hook 名 == 実ファイル集合」を検査する。新ファイル `workflow-bash-sync.ts` が実在するのに tmpl 未登録だと `onlyImpls` に出て FAIL する。まず登録前に走らせて FAIL を確認する（テスト追加は不要、既存が検知する）。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts`
期待: FAIL（`onlyImpls` に `workflow-bash-sync`）

- [ ] **Step 3: 最小実装を書く**

`.settings.hooks.json.tmpl` の PostToolUse `Bash` matcher グループ（`:150` 近辺）に `workflow-bash-sync.ts` を **同期実行**（`async` を付けない。additionalContext を運ぶため）で追加する。canonical path prefix（`{{ .chezmoi.homeDir }}/.claude/hooks/implementations/`）を守る。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/.settings.hooks.json.tmpl
git commit -m "ci(hooks): wire workflow-bash-sync into PostToolUse Bash"
```

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: 親ループが `python3 - <<'PY'` で wfDir 内 plan.md を書き換え → **期待**: `workflow-bash-sync` が hash 変化を検知し `plan-review-automation` 相当の推奨を additionalContext に出す
- **入力**: subagent（`agent_id` あり）の Bash → **期待**: `jsonCalls.length === 0`（即 success、注入なし）
- **入力**: gate 閉で `python3 -c "open('src/x.ts','w')..."` → **期待**: deny。`node -e "...writeFileSync('/tmp/probe')"` → **期待**: allow。`/tmpx/e` → **期待**: deny（segment 境界）

### 信頼性（回復性）

- **入力**: gate 閉で repo 内 `src/leaked.ts` を作成後に任意 Bash → **期待**: `off-plan-writes.log` に `tool=Bash-tripwire` で `src/leaked.ts` を記録、additionalContext に path
- **入力**: `.tripwire-baseline` 不在で Bash → **期待**: 「差分なし」ではなく「再武装した」を告知し baseline 作成
- **入力**: `git` 不在 → **期待**: `.tripwire-disabled` を理由付きで作成、1 回のみ notice、以後 skip

### 保守性（試験性）

- **入力**: `node --test hook-target-drift.test.ts` → **期待**: `onlyImpls` / `onlyRefs` 空、PASS

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work → 反映済み
- 主指摘: `canSkip` の 3 引数化は plan-1 T5 で行う前提（plan-1 側に明記済み）。tmpl の行番号は実装時に再確認（plan-2 T5 のコメント）

### scope-justification-reviewer

- verdict: needs-work → 反映済み
- 主指摘: plan-2 T1 が使う `workflow-review-core.test.ts` を top-level Files に追加（反映）

### architecture-strategist

- verdict: needs-work → 反映済み
- 主指摘: `agent_id` は PostToolUse **input** に載せる helper 拡張（`tool_response` スロットでない）、`draftPlanRepo` / `createGitWorkflowRepo` の authoring step、`tool_response` 4 番目引数のデフォルト化。Files 冒頭の scaffolding 注記に反映

### performance-oracle

- verdict: pass（plan-2 分）
- 主指摘: `agent_id` gate で親ループのみ処理（≈16s）。standalone hook は async 群に fold 不可のため正当

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

<!-- auto-review: verdict=pass; hash=ef89cfd4a69793214ee927ebb240f3ad7ea7d784d7fd0eefc3133c807fc54324; design-hash=e0c0ec549663fa187a87efe069bef853d96d6efb10c56fec7016402252ab639a; parent-spec-hash=ea7e535f7a83e4d2e5002cfdd698d69a3472a2f61275ae613634f156a54d68c6; at=2026-09-10T04:48:00Z; reviewers=logic-validator+scope-justification-reviewer+architecture-strategist+data-integrity-guardian+performance-oracle -->
<!-- intent-triage: adopted=8; excluded=0; at=2026-09-10T04:48:00Z -->
