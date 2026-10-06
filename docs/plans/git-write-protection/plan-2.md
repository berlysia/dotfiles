<!-- spec-ref: spec.md -->

# Plan 2: settings の規則、`safe.bareRepository`、本体の照合の再現テスト、受け入れ実験

spec の K6〜K8 と、R8 の受け入れ実験を実装する。

前提: plan-1 がすべて終わっていること。T3 のテストは plan-1 の `lib/auto-approval-hold.ts`（T4）を使い、T6 の受け入れ実験は plan-1 のフックの変更を前提にする。

spec との差分（承認のときにユーザーが確認する）: spec K7 は `ignore` を root の devDependencies に入れると書いているが、この plan は `home/dot_claude` に入れる（Round 1 の architecture の指摘。理由は T1）。

## Files

```
# 編集
home/dot_claude/.settings.permissions.json
home/dot_gitconfig.tmpl
home/dot_claude/package.json
bun.lock

# 新規作成
home/dot_claude/hooks/tests/support/core-match.ts
.tmp/sessions/01d4e776/acceptance.md

# テスト
home/dot_claude/hooks/tests/unit/settings-permissions-compat.test.ts
home/dot_claude/hooks/tests/unit/settings-permissions-deny.test.ts
home/dot_claude/hooks/tests/unit/core-match.test.ts
```

## Tasks

テストは repo のルートで `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>` で実行する。

### T1: `ignore@7.0.5` を `home/dot_claude` の devDependencies に入れる

`ignore` を使うテストは `home/dot_claude` の workspace の中にある。配備先（`~/.claude`）の `bun install` もこの workspace の `package.json` だけを見る。root に入れると、解決が bun の hoist に頼ることになり、knip が workspace の側で unlisted を出しうる。

**Files:**

- 編集: `home/dot_claude/package.json`、`bun.lock`
- 参照: `bunfig.toml`（`exact = true`、`minimumReleaseAge = 604800`）、`knip.json`（`home/dot_claude` の workspace の定義）

- [ ] **Step 1: 追加する**

```bash
bun add -d --cwd home/dot_claude ignore@7.0.5
```

期待:

- `home/dot_claude/package.json` に `"devDependencies": { "ignore": "7.0.5" }` が入る。
- `bun.lock` が更新される。
- `minimumReleaseAge` で拒否されない（7.0.5 の公開は 2025-05-31）。拒否された場合は止めて報告する。

- [ ] **Step 2: 入ったものを確かめる**

```bash
git diff --stat -- bun.lock home/dot_claude/package.json
jq -r '.devDependencies.ignore' home/dot_claude/package.json
```

期待: `bun.lock` と `home/dot_claude/package.json` の両方に差分があり、版は `7.0.5`。

コミットは T2 と一緒に行う（この時点では `ignore` を使うコードが無く、knip が unused と報告しうるため）。解決と knip の確認も T2 の Step 4 で行う。

### T2: 本体の照合を再現する `coreMatch`（K7）

**Files:**

- 新規: `home/dot_claude/hooks/tests/support/core-match.ts`
- テスト: `home/dot_claude/hooks/tests/unit/core-match.test.ts`
- 参照: research.md §2（`ignore` 7.0.5 の挙動）、spec.md K7
- 参照: permissions.md「`/path` の解決」（user settings の `/path` は `~/.claude/path`）

- [ ] **Step 1: 失敗するテストを書く**

docs の明文の例で、エミュレーションの妥当性を確かめる。

```ts
#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { coreDecision, coreMatch } from "../support/core-match.ts";

const env = {
  home: "/home/u",
  cwd: "/home/u/proj",
  settingsDir: "/home/u/.claude",
};

describe("coreMatch (emulation of Claude Code's gitignore-style rules)", () => {
  it("treats a bare name like **/name (docs example)", () => {
    strictEqual(coreMatch("Read(.env)", "/home/u/proj/a/.env", env), true);
    strictEqual(coreMatch("Read(**/.env)", "/home/u/proj/a/.env", env), true);
  });
  it("anchors // at the filesystem root and ~/ at home", () => {
    strictEqual(coreMatch("Edit(//tmp/**)", "/tmp/x/y", env), true);
    strictEqual(coreMatch("Read(~/.zshrc)", "/home/u/.zshrc", env), true);
  });
  it("anchors /path in user settings at ~/.claude (docs example)", () => {
    strictEqual(
      coreMatch("Read(/secrets/**)", "/home/u/.claude/secrets/a", env),
      true,
    );
    strictEqual(
      coreMatch("Read(/secrets/**)", "/home/u/proj/secrets/a", env),
      false,
    );
  });
  it("extends a matched directory to its contents", () => {
    strictEqual(
      coreMatch("Edit(//**/.git)", "/r/.git/worktree/x/src/a.ts", env),
      true,
    );
  });
  it("does not match outside the anchor", () => {
    strictEqual(coreMatch("Edit(~/workspace/**)", "/tmp/a", env), false);
  });
  it("anchors a slash-free ~/ pattern at home, not at any depth", () => {
    strictEqual(
      coreMatch("Edit(~/.gitconfig*)", "/home/u/.gitconfig", env),
      true,
    );
    strictEqual(
      coreMatch("Edit(~/.gitconfig*)", "/home/u/proj/.gitconfig", env),
      false,
    );
  });
});

describe("coreDecision (deny > ask > allow)", () => {
  it("prefers deny, then ask, then allow", () => {
    const rules = {
      deny: ["Edit(//**/.git/config)"],
      ask: ["Edit(~/.gitconfig*)"],
      allow: ["Edit(//**)"],
    };
    strictEqual(coreDecision("Edit", "/r/.git/config", rules, env), "deny");
    strictEqual(coreDecision("Edit", "/home/u/.gitconfig", rules, env), "ask");
    strictEqual(coreDecision("Edit", "/r/src/a.ts", rules, env), "allow");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

`<file>` = `home/dot_claude/hooks/tests/unit/core-match.test.ts`。期待: FAIL（`core-match.ts` が無い）。

- [ ] **Step 3: 最小実装を書く**

```ts
import ignore from "ignore";
import { join, relative } from "node:path";

export interface CoreEnv {
  home: string;
  cwd: string;
  // The directory a `/path` rule anchors at: ~/.claude for user settings.
  settingsDir: string;
}
export interface CoreRules {
  deny: string[];
  ask: string[];
  allow: string[];
}

// Splits "Edit(pattern)" into the tool and an absolute anchor plus a gitignore pattern.
// Anchored forms (//, ~/, /) get a leading "/" so that `ignore` matches them only at the
// anchor; a slash-free pattern would otherwise match at any depth. Relative patterns stay
// unanchored, as the docs describe for bare names.
function parseRule(
  rule: string,
  env: CoreEnv,
): { tool: string; anchor: string; pattern: string } | null {
  const m = /^(\w+)\((.*)\)$/.exec(rule);
  if (!m?.[1] || m[2] === undefined) return null;
  const body = m[2];
  if (body.startsWith("//"))
    return { tool: m[1], anchor: "/", pattern: `/${body.slice(2)}` };
  if (body.startsWith("~/"))
    return { tool: m[1], anchor: env.home, pattern: `/${body.slice(2)}` };
  if (body.startsWith("/"))
    return { tool: m[1], anchor: env.settingsDir, pattern: body };
  return {
    tool: m[1],
    anchor: env.cwd,
    pattern: body.startsWith("./") ? body.slice(2) : body,
  };
}

export function coreMatch(
  rule: string,
  absPath: string,
  env: CoreEnv,
): boolean {
  const parsed = parseRule(rule, env);
  if (!parsed) return false;
  const rel = relative(parsed.anchor, absPath);
  if (rel === "" || rel.startsWith("..")) return false;
  return ignore().add(parsed.pattern).ignores(rel);
}

export function coreDecision(
  tool: "Edit" | "Read",
  absPath: string,
  rules: CoreRules,
  env: CoreEnv,
): "deny" | "ask" | "allow" | "none" {
  const hits = (list: string[]) =>
    list.some((r) => r.startsWith(`${tool}(`) && coreMatch(r, absPath, env));
  if (hits(rules.deny)) return "deny";
  if (hits(rules.ask)) return "ask";
  if (hits(rules.allow)) return "allow";
  return "none";
}

export const userSettingsDir = (home: string) => join(home, ".claude");
```

- このエミュレーションは、書式の照合だけを再現する。symlink の二重照合と protected paths は再現しない（spec R5）。その 2 つは T6 の受け入れ実験で確かめる。
- 単一セグメントの相対パターン（`src/**`）が allow と deny で深さを変える本体の規則（permissions.md）は、この repo の規則が `//` と `~/` のアンカーを使うので、再現しない。コメントにその旨を書く。

- [ ] **Step 4: テストを実行して通過を確認し、knip を確かめる**

```bash
bun run test
bunx knip
```

期待: テストは PASS。knip は `ignore` も `core-match.ts` も unused / unlisted として報告しない。報告した場合は、`knip.json` の `home/dot_claude` の workspace の `entry` / `project` にテストが入っているかを確かめて報告する（設定は変えない）。

- [ ] **Step 5: コミット（T1 の依存の追加と一緒に）**

```bash
git add home/dot_claude/package.json bun.lock home/dot_claude/hooks/tests/support/core-match.ts home/dot_claude/hooks/tests/unit/core-match.test.ts
git commit -m "test(claude): emulate Claude Code's gitignore-style permission matching"
```

### T3: settings の規則を変える（K6）

**Files:**

- 編集: `home/dot_claude/.settings.permissions.json:83, 161, 299-305`
- テスト: `home/dot_claude/hooks/tests/unit/settings-permissions-compat.test.ts`、`home/dot_claude/hooks/tests/unit/settings-permissions-deny.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`settings-permissions-compat.test.ts` に、本体の側の判定（`coreDecision`）で実設定を評価する表を足す。設定の型に `ask` を足す（`:10-21`）。

```ts
import {
  assessAutoApprovalHold,
  buildHoldContext,
} from "../../lib/auto-approval-hold.ts";
import { coreDecision } from "../support/core-match.ts";

const coreEnv = {
  home: "/home/u",
  cwd: "/home/u/workspace/p",
  settingsDir: "/home/u/.claude",
};
const rules = {
  deny: userSettings.deny ?? [],
  ask: userSettings.ask ?? [],
  allow: userSettings.allow ?? [],
};
const chezmoi = "/home/u/.local/share/chezmoi";

describe("settings evaluated as Claude Code would (spec K6, K7)", () => {
  const table: Array<[string, "deny" | "ask" | "allow" | "none"]> = [
    // deny floor
    [`${chezmoi}/.git/config`, "deny"],
    [`${chezmoi}/.git/config.worktree`, "deny"],
    [`${chezmoi}/.git/commondir`, "deny"],
    [`${chezmoi}/.git/hooks/pre-commit`, "deny"],
    [`${chezmoi}/.git/info/attributes`, "deny"],
    [`${chezmoi}/.git/worktrees/x/commondir`, "deny"],
    [`${chezmoi}/.git/worktrees/x/config.worktree`, "deny"],
    [`${chezmoi}/.git/modules/sub/config`, "deny"],
    [`${chezmoi}/.git/modules/sub/hooks/post-checkout`, "deny"],
    [`${chezmoi}/.git/worktree/feat/.git`, "deny"],
    // A gitfile under a branch name with "/" is not in the deny floor; plan-1 holds it (K3, 2b).
    [`${chezmoi}/.git/worktree/feat/x/.git`, "allow"],
    // ask
    ["/home/u/.gitconfig", "ask"],
    ["/home/u/.gitconfig_gpg_ssh", "ask"],
    ["/home/u/.config/git/config", "ask"],
    ["/home/u/.config/git/attributes", "ask"],
    [`${chezmoi}/home/dot_gitconfig.tmpl`, "ask"],
    [`${chezmoi}/home/private_dot_config/git/config`, "ask"],
    // allow stays
    [`${chezmoi}/.git/worktree/feat/src/a.ts`, "allow"],
    [`${chezmoi}/home/dot_zshrc`, "allow"],
    ["/home/u/.config/mise/config.toml", "allow"],
  ];
  for (const [path, expected] of table) {
    it(`${path} → ${expected}`, () => {
      strictEqual(coreDecision("Edit", path, rules, coreEnv), expected);
    });
  }
  it("does not let .git/worktrees/** cover .git/worktree/", () => {
    strictEqual(
      rules.deny.some((r) => r === "Edit(//**/.git/worktrees/**)"),
      true,
    );
    strictEqual(
      coreDecision(
        "Edit",
        `${chezmoi}/.git/worktree/feat/src/a.ts`,
        rules,
        coreEnv,
      ),
      "allow",
    );
  });
  it("keeps every path the old deny rules covered (inclusion)", () => {
    const oldDeny = [
      "Edit(//**/.git/config)",
      "Edit(//**/.git/config.worktree)",
      "Edit(//**/.git/worktrees/*/config.worktree)",
      "Edit(//**/.git/hooks/**)",
      "Edit(//**/.git/modules/**/config)",
      "Edit(//**/.git/modules/**/hooks/**)",
      "Edit(//**/.git/worktree/*/.git)",
    ];
    for (const [path] of table) {
      const old = coreDecision(
        "Edit",
        path,
        { deny: oldDeny, ask: [], allow: [] },
        coreEnv,
      );
      if (old === "deny")
        strictEqual(coreDecision("Edit", path, rules, coreEnv), "deny", path);
    }
  });
  it("holds in the hooks every path the ask rules cover (ask ⊆ hold)", async () => {
    // home "/home/u" has no .chezmoiroot here, so buildHoldContext falls back to the ask-rule
    // path; this pins that chezmoiSource string. The ask paths themselves hold on their dot
    // segments (.gitconfig, .config, .local), so the chezmoi-source rule is tested in plan-1 T1
    // with a dot-free chezmoiSource, not here.
    const ctx = buildHoldContext({
      cwd: "/home/u/workspace/p",
      home: "/home/u",
    });
    strictEqual(ctx.chezmoiSource, `${chezmoi}/home`);
    for (const [path, expected] of table) {
      if (expected !== "ask") continue;
      strictEqual(
        (await assessAutoApprovalHold("Edit", { file_path: path }, ctx)).hold,
        true,
        path,
      );
    }
  });
  it("holds in the hooks the nested gitfile that the deny floor does not cover", async () => {
    // Any hold reason will do: this pins the outcome, not the worktree check (plan-1 T2 tests that).
    const ctx = buildHoldContext({
      cwd: "/home/u/workspace/p",
      home: "/home/u",
    });
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Edit",
          { file_path: `${chezmoi}/.git/worktree/feat/x/.git` },
          ctx,
        )
      ).hold,
      true,
    );
  });
  it("no longer allows Bash(git -c *)", () => {
    strictEqual(rules.allow.includes("Bash(git -c *)"), false);
  });
});
```

- 設定を読む型（`:10-21`）に `ask?: string[]` を足す。表は user settings（`.settings.permissions.json`）だけで評価する。project 側の `.claude/settings.json` には `.git` の規則が無いので、評価に足さない。
- 既存の `:74-83` は、deny が `.git`、`.git/worktree`、`.git/worktree/*` で終わらないことを正規表現で確かめるテストで、新しい deny でも成り立つ。変更しない。
- ask の対象外のもの:
  - `~/.gitattributes` と `~/.gitignore`。global の attributes / excludes の既定の場所は `~/.config/git/attributes` / `~/.config/git/ignore` で、ask の対象。ホーム直下のファイルが読まれるのは `core.attributesFile` / `core.excludesFile` で指定した場合だけで、その指定には global の config の編集（ask）が要る。
  - chezmoi のソースの `dot_gitattributes` / `dot_gitignore`。同じ理由で、配布しても読まれない。

`settings-permissions-deny.test.ts` の `requiredDeny` に、新しい deny を足す。

```ts
  "Edit(//**/.git/commondir)",
  "Edit(//**/.git/info/attributes)",
  "Edit(//**/.git/worktrees/**)",
  "Edit(//**/.git/modules/**)",
```

- [ ] **Step 2: テストを実行して失敗を確認**

`<file>` = 上の 2 つ。期待: deny と ask の行、`Bash(git -c *)` の行が FAIL。

- [ ] **Step 3: 実装する**

`.settings.permissions.json` を次のように変える。

- allow から `"Bash(git -c *)"`（`:83`）を消す。
- deny の `.git` の 7 行（`:299-305`）を、次の 8 行に置き換える。

```json
    "Edit(//**/.git/config)",
    "Edit(//**/.git/config.worktree)",
    "Edit(//**/.git/commondir)",
    "Edit(//**/.git/hooks/**)",
    "Edit(//**/.git/info/attributes)",
    "Edit(//**/.git/worktrees/**)",
    "Edit(//**/.git/modules/**)",
    "Edit(//**/.git/worktree/*/.git)",
```

- `deny` の後に `ask` を足す。

```json
  "ask": [
    "Edit(~/.gitconfig*)",
    "Edit(~/.config/git/**)",
    "Edit(~/.local/share/chezmoi/home/*dot_gitconfig*)",
    "Edit(~/.local/share/chezmoi/home/*dot_config/*git/**)"
  ]
```

- `Edit(//**/.git/worktree/**)`（`:161`）は残す。

- [ ] **Step 4: テストを実行して通過を確認**

期待: PASS。`bun run test` も PASS。

- [ ] **Step 5: Bash ツールを経由する `git -c` の呼び出しが無いことを確かめる（spec K6）**

```bash
git grep -n "git -c " -- home/dot_claude .skills docs ':!*.test.ts'
```

- コードの行（`.ts`、`.sh`、`.tmpl`、`executable_*`）は、child_process（`execFile`、`spawn`、`$` テンプレート）か、シェルスクリプトの中の直接の呼び出しであることを確かめる。
- Markdown の行は 1 行ずつ読み、次の 2 つに分ける。
  - 説明文（README、research、plan など）: 対応しない。
  - Claude の Bash ツールに `git -c` を打たせる手順（`.skills/**/SKILL.md`、`home/dot_claude/commands/*.md` など）: 見つかったら止めて報告する。`Bash(git -c *)` を消した後は、その手順で毎回確認が出るため。

- [ ] **Step 6: コミット**

```bash
git add home/dot_claude/.settings.permissions.json home/dot_claude/hooks/tests/unit/settings-permissions-compat.test.ts home/dot_claude/hooks/tests/unit/settings-permissions-deny.test.ts
git commit -m "fix(claude): deny git control files as a floor and ask before global git config edits"
```

### T4: `safe.bareRepository = explicit`（K8）

**Files:**

- 編集: `home/dot_gitconfig.tmpl`

- [ ] **Step 1: 追記する**

`home/dot_gitconfig.tmpl` と、その include の先（`dot_gitconfig_gpg_ssh.tmpl`、`dot_gitconfig-auto`、`~/.gitconfig_local`）に `[safe]` は無い（Round 1 のレビューで確認）。末尾の `[include]` の前に、新しいセクションとして足す。

```
[safe]
	bareRepository = explicit
```

このファイルは ask の対象なので、編集のときに確認が出る（plan-2 の T3 の後に行う場合）。

- [ ] **Step 2: テンプレートを確かめる**

```bash
chezmoi execute-template < home/dot_gitconfig.tmpl | git config --file - --get safe.bareRepository
```

期待: `explicit`。

- [ ] **Step 3: コミット**

```bash
git add home/dot_gitconfig.tmpl
git commit -m "feat(git): refuse implicit bare repositories"
```

### T5: 配備して、日常の操作が通ることを確かめる（R7）

- [ ] **Step 1: 配備する**

```bash
chezmoi apply
```

- [ ] **Step 2: settings と git の設定を確かめる**

```bash
jq '.permissions.ask' ~/.claude/settings.json
jq '.permissions.allow | index("Bash(git -c *)")' ~/.claude/settings.json
git config --global --get safe.bareRepository
claude --version
```

期待:

- `ask` が 4 行ある。
- `index` は `null`。
- `explicit`。
- 版は 2.1.291 以上（`write-protection.ts` の出典のコメントの版）。

- [ ] **Step 3: 日常の git の操作を確かめる**

repo、worktree、サブモジュール、`.git` の中で、`git status` と `git rev-parse --git-dir` を実行する。

```bash
git -C ~/.local/share/chezmoi status --short | head -1
git -C ~/.local/share/chezmoi/.git rev-parse --git-dir
git-worktree-create plan2-probe && git -C ~/.local/share/chezmoi/.git/worktree/plan2-probe status --short | head -1
git-worktree-cleanup
chezmoi status | head -3
mise ls | head -3
```

- 期待: どれも `fatal: cannot use bare repository` を出さない。`.git` の中での `rev-parse` も通る（spec を書く前に scratchpad で確かめた。`.git` という名前のディレクトリは暗黙の bare として扱われない）。
- 出した場合: 止めて報告する。そのツールに `--git-dir` を明示させられるか、ユーザーと決める（spec R7）。
- `git-worktree-cleanup` が worktree を残したときは、developer-experience.md の手順に従って、ユーザーに確かめてから消す。

### T6: 受け入れ実験（R8）

本体そのものでの確認。scratchpad の中で、`claude -p --permission-mode default --model haiku` を使う。`-p` では確認に答えられないので、確認が出たものは拒否になる。結果（書けたか、拒否の文言、decisions.jsonl の該当行）を表にして `.tmp/sessions/01d4e776/acceptance.md` に書く。

準備（scratchpad の絶対パスは、セッションの scratchpad のものをそのまま書く）:

```bash
S=/private/tmp/claude-153474740/-Users-daisuke-shiohara--local-share-chezmoi/01d4e776-c0d3-492b-82e4-2ef95cc31a92/scratchpad/acc
mkdir -p "$S" && git -C "$S" init -q repo && git -C "$S/repo" commit -q --allow-empty -m init
git -C "$S/repo" worktree add -q "$S/repo/.git/worktree/feat/x" -b feat/x
```

scratchpad の外に書こうとする行（4〜7、8）がある。

- 4〜7 は ask の確認になり、`-p` では拒否されるので、書かれない想定。存在しないファイル名を使う。
- 8 は確認なしで書ける想定で、確かめた直後に消す。
- どの行でも、書けてしまったファイルは直ちに消し、acceptance.md に記録して報告する。

- [ ] **Step 1: Edit 系の確認**

| #   | 対象                                                                                             | 期待                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | worktree の中の `src/a.ts`、`.github/ci.yml`、`.gitignore`                                       | 書ける（確認なし）                                                                                                             |
| 2   | worktree の中の `.claude/x.json`                                                                 | 拒否（確認が出た）                                                                                                             |
| 3   | repo の `.git/probe.txt`（字句では `//tmp/**` に当たらない `/private/tmp/...` のパスで書かせる） | 拒否。decisions.jsonl に `held: … (Layer 2a)` と `held: … (Layer 2b)` が残る（PermissionRequest の段で両方が承認を控えた証跡） |
| 4   | `~/.gitconfig-acc-probe`                                                                         | 拒否（ask `~/.gitconfig*`）                                                                                                    |
| 5   | `~/.config/git/acc-probe`                                                                        | 拒否（ask `~/.config/git/**`）                                                                                                 |
| 6   | `~/.local/share/chezmoi/home/dot_gitconfig-acc-probe`                                            | 拒否（ask `*dot_gitconfig*`）                                                                                                  |
| 7   | `~/.local/share/chezmoi/home/dot_config/git/acc-probe`                                           | 拒否（ask `*dot_config/*git/**`）                                                                                              |
| 8   | `~/.local/share/chezmoi/home/acc-probe.txt`                                                      | 書ける（確認なし。フックは `.local` で hold するが、本体が `Edit(~/.local/share/chezmoi/**)` で通す）。確かめたら消す          |

- [ ] **Step 2: Bash の確認**

| #   | コマンド                                                                | 期待                                                        |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| 9   | `git -C <repo> status`                                                  | 確認なし（2a の正規表現）                                   |
| 10  | `git -c color.ui=never status`                                          | 拒否（確認が出た）                                          |
| 11  | `tee .claude/x.json < /dev/null`（cwd は repo）                         | 拒否                                                        |
| 12  | `GIT_PAGER=cat git log -1`                                              | 拒否。decisions.jsonl に `skipped-llm: git-env (Layer 2b)`  |
| 13  | `git notes list`（本体の allow にも 2a の正規表現にも無いサブコマンド） | 拒否。decisions.jsonl に `skipped-llm: git-head (Layer 2b)` |
| 14  | `ls .github`（cwd は worktree）                                         | 確認なし（本体の `Bash(ls *)` が覆う）                      |

- [ ] **Step 3: 結果を記録し、崩れた前提があれば止める**

- acceptance.md の冒頭に、T5 で確かめた `claude --version` と `jq '.permissions.ask'` の結果を再掲する。
- K1 の前提（hold で本体が確認を出す）が崩れた場合は、実装を止めて spec に戻る（spec R8）。具体的には、2、3、11 で書けてしまった場合。
- ask の 4 本（4〜7）で書けてしまった場合は、ask が PermissionRequest の段で承認されたか、本体が ask を当てていない。decisions.jsonl の該当行と合わせて報告し、止める。
- 期待と違う結果は、すべて acceptance.md に書いてユーザーに報告する。
- 実験で作ったファイルが scratchpad の外に残っていないこと（8 を消したこと、4〜7 が無いこと）を確かめる。

## ISO 25010 具体テストケース

### セキュリティ（完全性）

- **入力**: 本体の側の判定で `${chezmoi}/.git/commondir` → **期待**: `deny`
- **入力**: 本体の側の判定で `/home/u/.config/git/config` → **期待**: `ask`
- **入力**: 実機で `git -c color.ui=never status`（`claude -p`） → **期待**: 拒否
- **入力**: 実機で worktree の中の `.claude/x.json` への Write → **期待**: 拒否

### 機能適合性（正確性）

- **入力**: 本体の側の判定で `${chezmoi}/.git/worktree/feat/src/a.ts` → **期待**: `allow`（`worktrees/**` の deny に当たらない）
- **入力**: 旧 deny が覆ったすべての代表パス → **期待**: 新しい規則でも `deny`
- **入力**: docs の例 `Read(/secrets/**)`（user settings） → **期待**: `~/.claude/secrets/a` に当たり、`~/proj/secrets/a` に当たらない

### 使用性（運用性）

- **入力**: 実機で worktree の中の `src/a.ts`、`.github/ci.yml`、`.gitignore` への Write → **期待**: 3 つとも確認なしで書ける
- **入力**: 実機で `git -C <repo> status`、`ls .github` → **期待**: 確認なし
- **判定基準**: 受け入れ実験の 14 項目のうち、確認なしを期待した項目（1 の 3 つ、8、9、14）がすべて確認なし

### 移植性・互換性

- **入力**: `safe.bareRepository=explicit` の配備後、repo / worktree / `.git` の中 / `chezmoi status` / `mise ls` → **期待**: どれも bare repo のエラーを出さない

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘:
  - `coreMatch` は、`~/` / `//` / `/` の規則に先頭の `/` を付けないと、全深さに当たってしまう。
  - ask の規則が chezmoiSource の配下に入ることのテストが、文字列の比較だけになっている。
  - T6 が R8 の項目を網羅していない。

### scope-justification-reviewer

- verdict: needs-work（軽微）
- 主指摘:
  - grep が `*.md` を除外している。
  - T6 の網羅が足りない（ask の 4 本、`git-head`、chezmoi のソースの Edit）。
  - `acceptance.md` が Files に無い。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘:
  - `ignore` は `home/dot_claude` の devDependencies に入れる。
  - knip で確認する。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘:
  - deny と ask は spec K6 と一致し、範囲は狭まっていない。
  - `~/.gitattributes` が ask の対象外である理由を書く。

### data-contract-evolution-evaluator

- verdict: needs-work（軽微）
- 主指摘:
  - フックは ask を読まない。ask のパスに対する受け入れ実験の期待が崩れた場合の扱いを書く。
  - compat テストの既存の正規表現（`:74-83`）は、新しい deny でも壊れないことを確かめる。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work（軽微）
- 主指摘:
  - 修正後の `parseRule` で T2 と T3 の表がすべて成り立つことを、`ignore` で確かめた。
  - 入れ子の worktree の gitfile が hold されることを、T3 で確かめていない。
  - T3 の断片に import が無い。

### scope-justification-reviewer

- verdict: pass
- 主指摘:
  - spec の K7 は `ignore` を root に入れると書いている。plan を優先することを、承認のときに確認する。
  - T1 のコミットを T2 の後に回す。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘:
  - `bun.lock` の変化を確かめる。
  - plan-1 の T4 の完了を前提に書く。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘:
  - T6 で止めた後に再開する条件は、実行時に判断すればよい。

### security-vulnerability-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=43c4327b33c3cc3c9283c8f7a324465fad6f67b591f80e8047de298f62a860ae; design-hash=7e41eb79b679123fcadd2cb37b18c1f2a66c430d75de8daa96aca85b21b5f984; round=1; parent-spec-hash=ef5ef9c56d89055a833b6f3aaaec3fb373ac04918b2b71021b1f2fafcc2131bd; at=2026-10-06T10:08:51.827Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘:
  - Round 2 の 2 点は解消した。
  - 軽微な 2 点（テストのコメントを、固定しているものに合わせる）は反映済み。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=25efca9464552127ea76abf703dd2c7f1b907e1757ef7ba3198623444d46049a; design-hash=16197167b6c87f064ef4508eb6b73d00caf5fb80746e4a5e4f403b5944fc1a88; round=2; parent-spec-hash=ef5ef9c56d89055a833b6f3aaaec3fb373ac04918b2b71021b1f2fafcc2131bd; at=2026-10-06T10:17:42.393Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+data-contract-evolution-evaluator -->

<!-- auto-review: verdict=pass; hash=ee0ddf7a48c147c28ea23424b33d2165abee71b05b9fbf3df686fbd65c89941b; design-hash=edab192ce2a67aee459f059c15cddc7c1efc48466add9ce376e085c071942192; round=3; parent-spec-hash=ef5ef9c56d89055a833b6f3aaaec3fb373ac04918b2b71021b1f2fafcc2131bd; at=2026-10-06T10:21:19.220Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=12; excluded=0; at=2026-10-06T10:29:19.293Z -->
